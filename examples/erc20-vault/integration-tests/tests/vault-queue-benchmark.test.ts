import { createHash } from "node:crypto";

import {
  createCallTxOptions,
  createUnprovenCallTx,
  submitCallTxAsync,
} from "@midnight-ntwrk/midnight-js/contracts";
import { getNetworkId } from "@midnight-ntwrk/midnight-js/network-id";
import { encodeContractKeyLocation, hashVerifierKey } from "@midnight-ntwrk/midnight-js/types";
import {
  communicationCommitmentRandomness,
  ContractCallPrototype,
  ContractState,
  Intent,
  Transaction as LedgerTransaction,
} from "@midnight-ntwrk/midnight-js-protocol/ledger";
import { MidnightBech32m, UnshieldedAddress } from "@midnightntwrk/wallet-sdk-address-format";
import { type RequestIdHex, toSignBidirectionalEventIndex } from "@sig-net/midnight";
import {
  deriveWalletAddresses,
  ensureFeeReady,
  getMidnightNodeConfig,
  readAccountFunding,
  WalletRegistry,
} from "@sig-net/midnight-contract-deploy";
import {
  evmAddressBytes,
  PendingRequestKind,
  pureCircuits,
  readVaultLedger,
  VAULT_PRIVATE_STATE_ID,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import {
  resolveInitialiseConfig,
  vaultCompiledContract,
} from "@sig-net/midnight-examples-erc20-vault-deploy";
import {
  type ProofServerObservation,
  ProofServerPhase,
  submitTransferTransaction,
} from "@sig-net/midnight-examples-lib";
import { banner } from "@sig-net/midnight-examples-test-harness";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { JsonRpcProvider, type Transaction } from "ethers";
import { afterAll, describe, expect, it } from "vitest";

import { circuitIdFromKeyLocation } from "../src/benchmark/records.ts";
import { queueApproveRouter, sendApproveRouter } from "../src/flows/approve-router.ts";
import { broadcastEvm } from "../src/flows/broadcast-evm.ts";
import { initialise } from "../src/flows/initialise.ts";
import { pollSignatureResponse } from "../src/flows/poll-signature-response.ts";
import {
  assignedNonce,
  FLUSH_WIDTH,
  flushPending,
  flushUntilStamped,
  unstampedKeys,
} from "../src/flows/vault-queue.ts";
import type { VaultContext } from "../src/vault-context.ts";
import { createVaultSession, type VaultSession } from "../src/vault-session.ts";

const MINUTE = 60_000;
const env = injectE2eEnv();
const BEARER_SEED = env.BEARER_SEED ?? "";
const PARALLEL_WALLET_NIGHT = 700_000_000_000n;
const GAS_BUDGET_MULTIPLIER = BigInt(env.QUEUE_BENCH_GAS_MULTIPLIER ?? "2");
const parallelSeed = (i: number): string =>
  createHash("sha256")
    .update(`vault-queue-benchmark-wallet-${String(i)}`)
    .digest("hex");
const PARALLEL_SEEDS: readonly string[] = env.QUEUE_BENCH_SEEDS
  ? env.QUEUE_BENCH_SEEDS.split(",")
  : Array.from({ length: Number(env.QUEUE_BENCH_WALLETS ?? String(FLUSH_WIDTH)) }, (_, i) =>
      parallelSeed(i),
    );
const PARALLEL_WALLETS = PARALLEL_SEEDS.length;

interface ProveSample {
  readonly circuit: string;
  readonly ms: number;
  readonly proofBytes: number;
}

const proves: ProveSample[] = [];
const observer = (observation: ProofServerObservation): void => {
  if (observation.phase !== ProofServerPhase.Prove || observation.error !== undefined) return;
  proves.push({
    circuit: circuitIdFromKeyLocation(observation.keyLocation) ?? observation.keyLocation,
    ms: observation.ms,
    proofBytes: observation.proof?.byteLength ?? 0,
  });
};

const session = createVaultSession(env, observer);
const strangerSession = createVaultSession({
  ...env,
  USER_SEED: BEARER_SEED,
  VAULT_USER_SECRET_KEY: BEARER_SEED,
});

const lastProve = (circuit: string): ProveSample => {
  const sample = [...proves].reverse().find((candidate) => candidate.circuit === circuit);
  if (!sample) throw new Error(`no prove sample recorded for ${circuit}`);
  return sample;
};

const startTimer = (): (() => number) => {
  const startedAt = Date.now();
  return () => Date.now() - startedAt;
};

const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);

const withTimeout = async <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} did not settle within ${String(ms)}ms`));
    }, ms);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
};

interface QueuedApprove {
  readonly erc20: string;
  readonly bytes: Uint8Array;
  readonly key: Uint8Array;
}

const approveOf = (erc20: string): QueuedApprove => {
  const bytes = evmAddressBytes(erc20);
  return { erc20, bytes, key: pureCircuits.approveRouterBinder(bytes) };
};

const randomApprove = (): QueuedApprove =>
  approveOf(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString("hex")}`);

const submitApproveRouter = async (context: VaultContext, item: QueuedApprove): Promise<string> => {
  const submitted = await submitCallTxAsync(
    context.providers,
    createCallTxOptions(
      vaultCompiledContract,
      "approveRouter",
      context.vaultContractAddress,
      VAULT_PRIVATE_STATE_ID,
      undefined,
      [item.bytes],
    ),
  );
  return submitted.txId;
};

const submitSendApproveRouter = async (
  context: VaultContext,
  item: QueuedApprove,
): Promise<string> => {
  const submitted = await submitCallTxAsync(
    context.providers,
    createCallTxOptions(
      vaultCompiledContract,
      "sendApproveRouter",
      context.vaultContractAddress,
      VAULT_PRIVATE_STATE_ID,
      undefined,
      [item.key],
    ),
  );
  return submitted.txId;
};

const finalizedBlock = async (context: VaultContext, txId: string): Promise<number> => {
  const data = await context.providers.publicDataProvider.watchForTxData(txId);
  if (data.status !== "SucceedEntirely") {
    throw new Error(`tx ${txId} finalized with status ${data.status}`);
  }
  return data.blockHeight;
};

type BurstMode = "async" | "sequential";

interface BurstResult {
  readonly wallMs: number;
  readonly mode: BurstMode;
  readonly retried: number;
  readonly blocks: number;
  readonly maxPerBlock: number;
}

const summarize = (
  wallMs: number,
  mode: BurstMode,
  retried: number,
  heights: readonly number[],
): BurstResult => {
  const perBlock = new Map<number, number>();
  for (const height of heights) perBlock.set(height, (perBlock.get(height) ?? 0) + 1);
  return {
    wallMs,
    mode,
    retried,
    blocks: perBlock.size,
    maxPerBlock: Math.max(...perBlock.values()),
  };
};

const runBurst = async (
  label: string,
  items: readonly QueuedApprove[],
  submit: (item: QueuedApprove) => Promise<string>,
  context: VaultContext,
): Promise<BurstResult> => {
  const stop = startTimer();
  const pending: Promise<number>[] = [];
  let mode: BurstMode = "async";
  for (const [i, item] of items.entries()) {
    let txId: string;
    try {
      txId = await submit(item);
    } catch (error) {
      if (mode === "sequential") throw error;
      console.log(`${label} ${String(i)}: async submission failed: ${message(error)}`);
      console.log(`${label}: falling back to one finalized tx at a time`);
      mode = "sequential";
      await Promise.all(pending);
      txId = await submit(item);
    }
    console.log(`${label} ${String(i)} submitted in tx ${txId}`);
    const wait = finalizedBlock(context, txId);
    wait.catch(() => undefined);
    pending.push(wait);
    if (mode === "sequential") await wait;
  }
  const settled = await Promise.allSettled(pending);
  const heights: number[] = [];
  let retried = 0;
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "fulfilled") {
      heights.push(outcome.value);
      continue;
    }
    const item = items[i];
    if (!item) throw new Error(`no item at ${String(i)}`);
    console.log(`${label} ${String(i)}: ${message(outcome.reason)}; resubmitting alone`);
    retried += 1;
    heights.push(await finalizedBlock(context, await submit(item)));
  }
  const result = summarize(stop(), mode, retried, heights);
  console.log(
    `${label}: ${String(items.length)} txs in ${String(result.blocks)} block(s), max ${String(result.maxPerBlock)} per block, ${(result.wallMs / 1000).toFixed(1)}s (${result.mode}, ${String(result.retried)} resubmitted)`,
  );
  return result;
};

const signAndBroadcast = async (
  context: VaultContext,
  requestIds: readonly RequestIdHex[],
): Promise<{ readonly signMs: number; readonly broadcastMs: number }> => {
  const stopSign = startTimer();
  const signed: Transaction[] = [];
  for (const requestId of requestIds) {
    signed.push(
      await pollSignatureResponse(context, {
        requestId,
        intervalMs: 1000,
        timeoutMs: 10 * MINUTE,
        expectedSigner: context.evmVaultAddress,
      }),
    );
  }
  const signMs = stopSign();
  const stopBroadcast = startTimer();
  for (const transaction of signed) {
    expect((await broadcastEvm(context, { transaction })).status).toBe(1);
  }
  return { signMs, broadcastMs: stopBroadcast() };
};

const drain = async (context: VaultContext, items: readonly QueuedApprove[]): Promise<void> => {
  const requestIds: RequestIdHex[] = [];
  for (const item of items) requestIds.push(await sendApproveRouter(context, item.key, item.erc20));
  await signAndBroadcast(context, requestIds);
};

const drainQueue = async (context: VaultContext): Promise<number> => {
  while ((await unstampedKeys(context)).length > 0) await flushPending(context);
  const state = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const numbered = [...state.pendingVaultRequests]
    .filter(([key]) => state.stamps.member(key))
    .map(([key, entry]) => ({ key, entry, nonce: state.stamps.lookup(key).evmNonce }))
    .sort((a, b) => (a.nonce < b.nonce ? -1 : 1));
  const requestIds: RequestIdHex[] = [];
  for (const { key, entry } of numbered) {
    if (entry.kind !== PendingRequestKind.approveRouter) {
      throw new Error(`cannot drain a queued request of kind ${String(entry.kind)}`);
    }
    requestIds.push(
      await sendApproveRouter(context, key, `0x${Buffer.from(entry.addressA).toString("hex")}`),
    );
  }
  if (requestIds.length > 0) await signAndBroadcast(context, requestIds);
  if (numbered.length > 0) console.log(`drained ${String(numbered.length)} numbered request(s)`);
  return numbered.length;
};

const vaultChainNonce = async (context: VaultContext): Promise<bigint> =>
  BigInt(await new JsonRpcProvider(context.evmRpcUrl).getTransactionCount(context.evmVaultAddress));

const parallelSessions: VaultSession[] = [];

const fundParallelWallets = async (seeds: readonly string[]): Promise<number> => {
  const funderSeed = env.QUEUE_BENCH_FUNDER_SEED ?? env.ROOT_SEED;
  if (!funderSeed) throw new Error("ROOT_SEED or QUEUE_BENCH_FUNDER_SEED must name the funder");
  const config = getMidnightNodeConfig(env);
  const registry = new WalletRegistry(config);
  try {
    const unfunded: number[] = [];
    for (const [i, seed] of seeds.entries()) {
      const funding = await readAccountFunding(registry, seed, `bench wallet ${String(i)}`);
      if (funding.night === 0n && funding.dust === 0n) unfunded.push(i);
    }
    if (unfunded.length === 0) return 0;
    const funder = await registry.wallet(funderSeed, "bench funder");
    const funderState = await funder.facade.waitForSyncedState();
    const nightTokenType = Object.keys(funderState.unshielded.balances)[0];
    if (!nightTokenType) throw new Error("the funder holds no NIGHT");
    const outputs = unfunded.map((i) => ({
      type: nightTokenType,
      receiverAddress: MidnightBech32m.parse(
        deriveWalletAddresses(seeds[i] ?? "", config).unshielded,
      ).decode(UnshieldedAddress, config.networkId),
      amount: PARALLEL_WALLET_NIGHT,
    }));
    const txId = await submitTransferTransaction(
      funder.facade,
      funder.keys,
      [{ type: "unshielded", outputs }],
      config.networkId,
    );
    console.log(`funded ${String(unfunded.length)} bench wallet(s) in one transfer ${txId}`);
    await Promise.all(
      unfunded.map(async (i) => {
        const child = await registry.wallet(seeds[i] ?? "", `bench wallet ${String(i)}`);
        let state = await child.facade.waitForSyncedState();
        for (
          let attempt = 0;
          attempt < 40 && state.unshielded.availableCoins.length === 0;
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          state = await child.facade.waitForSyncedState();
        }
        await ensureFeeReady(child.facade, child.keys, state, config.networkId, undefined, 1n);
      }),
    );
    return unfunded.length;
  } finally {
    await registry.close();
  }
};

const parallelContexts = async (seeds: readonly string[]): Promise<VaultContext[]> => {
  const contexts: VaultContext[] = [];
  for (const seed of seeds) {
    if (seed === env.USER_SEED) {
      contexts.push(await session.vaultContext());
      continue;
    }
    if (seed === BEARER_SEED) {
      contexts.push(await strangerSession.vaultContext());
      continue;
    }
    const walletSession = createVaultSession(
      { ...env, USER_SEED: seed, VAULT_USER_SECRET_KEY: seed },
      observer,
    );
    parallelSessions.push(walletSession);
    contexts.push(await walletSession.vaultContext());
  }
  return contexts;
};

type ProvenCall = Awaited<ReturnType<VaultContext["providers"]["proofProvider"]["proveTx"]>>;
type Transcripts = Awaited<
  ReturnType<typeof createUnprovenCallTx>
>["public"]["partitionedTranscript"];
type Transcript = NonNullable<Transcripts[0]>;

const padGas = (transcript: Transcript | undefined): Transcript | undefined =>
  transcript && {
    ...transcript,
    gas: {
      readTime: transcript.gas.readTime * GAS_BUDGET_MULTIPLIER,
      computeTime: transcript.gas.computeTime * GAS_BUDGET_MULTIPLIER,
      bytesWritten: transcript.gas.bytesWritten * GAS_BUDGET_MULTIPLIER,
      bytesDeleted: transcript.gas.bytesDeleted * GAS_BUDGET_MULTIPLIER,
    },
  };

const provePadded = async (
  context: VaultContext,
  circuitId: "approveRouter",
  args: readonly [Uint8Array],
): Promise<ProvenCall> => {
  const options = createCallTxOptions(
    vaultCompiledContract,
    circuitId,
    context.vaultContractAddress,
    VAULT_PRIVATE_STATE_ID,
    undefined,
    args as never,
  );
  const call = await createUnprovenCallTx(context.providers, {
    ...options,
    privateStateId: VAULT_PRIVATE_STATE_ID,
  });
  const raw = await context.providers.publicDataProvider.queryContractState(
    context.vaultContractAddress,
  );
  if (!raw) throw new Error("vault contract state not found");
  const state = raw instanceof ContractState ? raw : ContractState.deserialize(raw.serialize());
  const operation = state.operation(circuitId);
  if (!operation?.verifierKey) throw new Error(`${circuitId} has no verifier key on chain`);
  const [guaranteed, fallible] = call.public.partitionedTranscript;
  const prototype = new ContractCallPrototype(
    context.vaultContractAddress,
    circuitId,
    operation,
    padGas(guaranteed),
    padGas(fallible),
    call.private.privateTranscriptOutputs,
    call.private.input,
    call.private.output,
    communicationCommitmentRandomness(),
    encodeContractKeyLocation({
      contractAddress: context.vaultContractAddress,
      circuitId,
      verifierKeyHash: hashVerifierKey(operation.verifierKey),
    }),
  );
  const intent = Intent.new(new Date(Date.now() + 60 * MINUTE)).addCall(prototype);
  const unproven = LedgerTransaction.fromPartsRandomized(
    getNetworkId(),
    undefined,
    undefined,
    intent,
  );
  return context.providers.proofProvider.proveTx(unproven);
};

const proveApproveRouter = (context: VaultContext, item: QueuedApprove): Promise<ProvenCall> =>
  provePadded(context, "approveRouter", [item.bytes]);

interface ParallelResult extends BurstResult {
  readonly proveMs: number;
  readonly balanceMs: number;
  readonly submitMs: number;
}

const runParallel = async (
  label: string,
  contexts: readonly VaultContext[],
  items: readonly QueuedApprove[],
  prove: (context: VaultContext, item: QueuedApprove) => Promise<ProvenCall>,
): Promise<ParallelResult> => {
  const stopTotal = startTimer();
  const stopProve = startTimer();
  const proven: ProvenCall[] = [];
  for (const [i, item] of items.entries()) {
    const context = contexts[i];
    if (!context) throw new Error(`no wallet for request ${String(i)}`);
    proven.push(await prove(context, item));
  }
  const proveMs = stopProve();
  const stopBalance = startTimer();
  const balanced = await Promise.all(
    proven.map((tx, i) => {
      const context = contexts[i];
      if (!context) throw new Error(`no wallet for request ${String(i)}`);
      return context.providers.walletProvider.balanceTx(tx);
    }),
  );
  const balanceMs = stopBalance();
  const stopSubmit = startTimer();
  const txIds = await Promise.all(
    balanced.map((tx, i) => {
      const context = contexts[i];
      if (!context) throw new Error(`no wallet for request ${String(i)}`);
      return context.providers.midnightProvider.submitTx(tx);
    }),
  );
  const submitMs = stopSubmit();
  const heights = await Promise.all(
    txIds.map((txId, i) => {
      const context = contexts[i];
      if (!context) throw new Error(`no wallet for request ${String(i)}`);
      return finalizedBlock(context, txId);
    }),
  );
  const result = { ...summarize(stopTotal(), "async", 0, heights), proveMs, balanceMs, submitMs };
  console.log(
    `${label}: ${String(items.length)} txs from ${String(items.length)} wallets in ${String(result.blocks)} block(s), max ${String(result.maxPerBlock)} per block; prove ${(proveMs / 1000).toFixed(1)}s, balance ${(balanceMs / 1000).toFixed(1)}s, submit ${(submitMs / 1000).toFixed(1)}s, finalized ${(result.wallMs / 1000).toFixed(1)}s`,
  );
  return result;
};

const report: Record<string, unknown> = {};

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault queue benchmark", () => {
  installFlowHooks();

  afterAll(async () => {
    const byCircuit = new Map<string, number[]>();
    for (const sample of proves) {
      byCircuit.set(sample.circuit, [...(byCircuit.get(sample.circuit) ?? []), sample.ms]);
    }
    const proveRows = [...byCircuit.entries()].map(([circuit, samples]) => {
      const mean = samples.reduce((sum, ms) => sum + ms, 0) / samples.length;
      return `  ${circuit.padEnd(20)} n=${String(samples.length).padStart(2)}  mean ${(mean / 1000).toFixed(2)}s  min ${(Math.min(...samples) / 1000).toFixed(2)}s  max ${(Math.max(...samples) / 1000).toFixed(2)}s`;
    });
    report.proveMs = Object.fromEntries(
      [...byCircuit.entries()].map(([circuit, samples]) => [circuit, samples]),
    );
    banner(["queue benchmark: prove wall clock per circuit", ...proveRows]);
    console.log(`BENCHMARK_QUEUE_JSON ${JSON.stringify(report)}`);
    await session.stop();
    await strangerSession.stop();
    for (const walletSession of parallelSessions) await walletSession.stop();
  });

  it(
    "flush costs the same with no live key as with one",
    async () => {
      const context = await session.vaultContext();
      await initialise(context, await resolveInitialiseConfig(env, context.vaultContractAddress));
      await drainQueue(context);
      const base = (
        await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress)
      ).vaultEvmNonce;

      const stopEmpty = startTimer();
      await flushPending(context);
      const emptyWallMs = stopEmpty();
      const emptyProve = lastProve("flush");

      const item = randomApprove();
      const stopQueue = startTimer();
      await queueApproveRouter(context, item.erc20);
      const queueWallMs = stopQueue();
      const queueProve = lastProve("approveRouter");

      const stopOne = startTimer();
      expect((await flushUntilStamped(context, item.key)).evmNonce).toBe(base);
      const oneWallMs = stopOne();
      const oneProve = lastProve("flush");

      const stopDrain = startTimer();
      await drain(context, [item]);
      const drainWallMs = stopDrain();
      const sendProve = lastProve("sendApproveRouter");

      report.single = {
        flushEmpty: {
          proveMs: emptyProve.ms,
          proofBytes: emptyProve.proofBytes,
          wallMs: emptyWallMs,
        },
        flushOne: { proveMs: oneProve.ms, proofBytes: oneProve.proofBytes, wallMs: oneWallMs },
        queue: { proveMs: queueProve.ms, proofBytes: queueProve.proofBytes, wallMs: queueWallMs },
        send: { proveMs: sendProve.ms, proofBytes: sendProve.proofBytes },
        sendSignBroadcastWallMs: drainWallMs,
      };
      banner([
        "queue benchmark: one request",
        `  flush, 0 live keys   prove ${(emptyProve.ms / 1000).toFixed(2)}s  finalized ${(emptyWallMs / 1000).toFixed(1)}s`,
        `  flush, 1 live key    prove ${(oneProve.ms / 1000).toFixed(2)}s  finalized ${(oneWallMs / 1000).toFixed(1)}s`,
        `  approveRouter        prove ${(queueProve.ms / 1000).toFixed(2)}s  finalized ${(queueWallMs / 1000).toFixed(1)}s`,
        `  sendApproveRouter    prove ${(sendProve.ms / 1000).toFixed(2)}s`,
        `  send + sign + broadcast ${(drainWallMs / 1000).toFixed(1)}s`,
      ]);
    },
    15 * MINUTE,
  );

  it(
    `a burst of ${String(FLUSH_WIDTH)} requests: every request lands, one flush numbers them all, every send lands`,
    async () => {
      const context = await session.vaultContext();
      await drainQueue(context);
      const ledgerBefore = await readVaultLedger(
        context.providers.publicDataProvider,
        context.vaultContractAddress,
      );
      const base = ledgerBefore.vaultEvmNonce;
      const chainBefore = await vaultChainNonce(context);
      const items = Array.from({ length: FLUSH_WIDTH }, () => randomApprove());
      const stopTotal = startTimer();

      const queue = await runBurst(
        "queue",
        items,
        (item) => submitApproveRouter(context, item),
        context,
      );

      const stopFlush = startTimer();
      for (const item of items) await flushUntilStamped(context, item.key);
      const flushWallMs = stopFlush();
      const flushProve = lastProve("flush");
      // The flush numbers keys in the ledger map's own order, which is not
      // the submission order, so the assertion is on the set of nonces, and
      // the sends below go out in ascending nonce order as a relayer's would.
      const nonces: bigint[] = [];
      for (const item of items) nonces.push(await assignedNonce(context, item.key));
      nonces.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      expect(nonces).toEqual(items.map((_, i) => base + BigInt(i)));

      const send = await runBurst(
        "send",
        items,
        (item) => submitSendApproveRouter(context, item),
        context,
      );

      const ledgerAfter = await readVaultLedger(
        context.providers.publicDataProvider,
        context.vaultContractAddress,
      );
      const requestIdByNonce = new Map<bigint, RequestIdHex>();
      for (const [requestId, event] of toSignBidirectionalEventIndex(
        ledgerAfter.signBidirectionalEventMap,
      )) {
        const nonce = event.txParams.nonce;
        if (nonce >= base && nonce < base + BigInt(FLUSH_WIDTH))
          requestIdByNonce.set(nonce, requestId);
      }
      expect(requestIdByNonce.size).toBe(FLUSH_WIDTH);
      const requestIds = nonces.map((nonce) => {
        const requestId = requestIdByNonce.get(nonce);
        if (!requestId) throw new Error(`no request carries nonce ${String(nonce)}`);
        return requestId;
      });

      const { signMs, broadcastMs } = await signAndBroadcast(context, requestIds);
      const totalMs = stopTotal();
      expect(await vaultChainNonce(context)).toBe(chainBefore + BigInt(FLUSH_WIDTH));

      report.burst = {
        requests: FLUSH_WIDTH,
        queue,
        flush: { proveMs: flushProve.ms, proofBytes: flushProve.proofBytes, wallMs: flushWallMs },
        send,
        signMs,
        broadcastMs,
        totalMs,
      };
      banner([
        `queue benchmark: burst of ${String(FLUSH_WIDTH)} requests`,
        `  queue   ${String(FLUSH_WIDTH)} txs  ${String(queue.blocks)} block(s), max ${String(queue.maxPerBlock)} per block  ${(queue.wallMs / 1000).toFixed(1)}s  (${queue.mode}, ${String(queue.retried)} resubmitted)`,
        `  flush   1 tx   prove ${(flushProve.ms / 1000).toFixed(2)}s  finalized ${(flushWallMs / 1000).toFixed(1)}s  nonces ${String(base)}..${String(base + BigInt(FLUSH_WIDTH - 1))}`,
        `  send    ${String(FLUSH_WIDTH)} txs  ${String(send.blocks)} block(s), max ${String(send.maxPerBlock)} per block  ${(send.wallMs / 1000).toFixed(1)}s  (${send.mode}, ${String(send.retried)} resubmitted)`,
        `  sign    ${String(FLUSH_WIDTH)} signatures collected ${(signMs / 1000).toFixed(1)}s after the last send`,
        `  mine    ${String(FLUSH_WIDTH)} broadcasts in nonce order ${(broadcastMs / 1000).toFixed(1)}s`,
        `  total   ${(totalMs / 1000).toFixed(1)}s, ${(totalMs / 1000 / FLUSH_WIDTH).toFixed(1)}s per request`,
      ]);
    },
    45 * MINUTE,
  );

  it(
    "two flushes of the same batch collide: exactly one wins and the loser's retry changes nothing",
    async () => {
      const context = await session.vaultContext();
      const stranger = await strangerSession.vaultContext();
      await drainQueue(context);
      const items = [randomApprove(), randomApprove()];
      for (const item of items) await queueApproveRouter(context, item.erc20);
      const keys = items.map((item) => item.key);
      const before = (
        await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress)
      ).vaultEvmNonce;

      const stop = startTimer();
      const outcomes = await Promise.allSettled([
        withTimeout(flushPending(context), 5 * MINUTE, "owner flush"),
        withTimeout(flushPending(stranger), 5 * MINUTE, "stranger flush"),
      ]);
      const raceMs = stop();
      const lines = outcomes.map((outcome, i) => {
        const who = i === 0 ? "owner" : "stranger";
        return outcome.status === "fulfilled"
          ? `  ${who} flush won`
          : `  ${who} flush lost: ${message(outcome.reason)}`;
      });
      const winners = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
      expect(winners).toBe(1);

      const afterRace = await readVaultLedger(
        context.providers.publicDataProvider,
        context.vaultContractAddress,
      );
      expect(afterRace.vaultEvmNonce).toBe(before + 2n);
      expect(await assignedNonce(context, keys[0] ?? new Uint8Array(32))).toBe(before);
      expect(await assignedNonce(context, keys[1] ?? new Uint8Array(32))).toBe(before + 1n);

      const loser = outcomes[0].status === "rejected" ? context : stranger;
      const stopRetry = startTimer();
      expect(await flushPending(loser)).toBe(0);
      const retryMs = stopRetry();
      const afterRetry = await readVaultLedger(
        context.providers.publicDataProvider,
        context.vaultContractAddress,
      );
      expect(afterRetry.vaultEvmNonce).toBe(before + 2n);

      await drain(context, items);

      report.collision = {
        outcomes: outcomes.map((outcome) =>
          outcome.status === "fulfilled" ? "won" : message(outcome.reason),
        ),
        raceMs,
        retryMs,
      };
      banner([
        "queue benchmark: colliding flushes",
        ...lines,
        `  race settled in ${(raceMs / 1000).toFixed(1)}s, loser's retry finalized in ${(retryMs / 1000).toFixed(1)}s and assigned nothing`,
      ]);
    },
    20 * MINUTE,
  );
  it(
    `${String(PARALLEL_WALLETS)} wallets pre-prove with a padded gas budget and submit together: their requests share a block, one flush numbers them all, every send lands`,
    async () => {
      const owner = await session.vaultContext();
      await initialise(owner, await resolveInitialiseConfig(env, owner.vaultContractAddress));
      await drainQueue(owner);
      const stopFund = startTimer();
      const funded = await fundParallelWallets(PARALLEL_SEEDS);
      const fundMs = stopFund();
      const stopContexts = startTimer();
      const contexts = await parallelContexts(PARALLEL_SEEDS);
      const contextsMs = stopContexts();
      const items = contexts.map((context) => approveOf(context.erc20Address));
      const ledgerBefore = await readVaultLedger(
        owner.providers.publicDataProvider,
        owner.vaultContractAddress,
      );
      const base = ledgerBefore.vaultEvmNonce;
      const chainBefore = await vaultChainNonce(owner);
      const stopTotal = startTimer();

      const queue = await runParallel("queue", contexts, items, proveApproveRouter);
      expect(queue.maxPerBlock).toBeGreaterThan(1);

      const stopFlush = startTimer();
      for (const item of items) await flushUntilStamped(owner, item.key);
      const flushWallMs = stopFlush();
      const flushProve = lastProve("flush");
      const ledgerFlushed = await readVaultLedger(
        owner.providers.publicDataProvider,
        owner.vaultContractAddress,
      );
      // As in the burst above: the flush numbers keys in ledger map order,
      // so the set of nonces is asserted and the signatures are collected in
      // ascending nonce order.
      const nonces = items
        .map((item) => ledgerFlushed.stamps.lookup(item.key).evmNonce)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      expect(nonces).toEqual(items.map((_, i) => base + BigInt(i)));

      const stopSend = startTimer();
      const sendHeights: number[] = [];
      for (const [i, item] of items.entries()) {
        const context = contexts[i];
        if (!context) throw new Error(`no wallet for request ${String(i)}`);
        sendHeights.push(
          await finalizedBlock(context, await submitSendApproveRouter(context, item)),
        );
      }
      const send = summarize(stopSend(), "sequential", 0, sendHeights);

      const ledgerAfter = await readVaultLedger(
        owner.providers.publicDataProvider,
        owner.vaultContractAddress,
      );
      const requestIdByNonce = new Map<bigint, RequestIdHex>();
      for (const [requestId, event] of toSignBidirectionalEventIndex(
        ledgerAfter.signBidirectionalEventMap,
      )) {
        const nonce = event.txParams.nonce;
        if (nonce >= base && nonce < base + BigInt(items.length))
          requestIdByNonce.set(nonce, requestId);
      }
      expect(requestIdByNonce.size).toBe(items.length);
      const requestIds = nonces.map((nonce) => {
        const requestId = requestIdByNonce.get(nonce);
        if (!requestId) throw new Error(`no request carries nonce ${String(nonce)}`);
        return requestId;
      });

      const { signMs, broadcastMs } = await signAndBroadcast(owner, requestIds);
      const totalMs = stopTotal();
      expect(await vaultChainNonce(owner)).toBe(chainBefore + BigInt(items.length));

      report.parallel = {
        wallets: PARALLEL_WALLETS,
        funded,
        fundMs,
        contextsMs,
        queue,
        flush: { proveMs: flushProve.ms, proofBytes: flushProve.proofBytes, wallMs: flushWallMs },
        send,
        signMs,
        broadcastMs,
        totalMs,
      };
      banner([
        `queue benchmark: ${String(PARALLEL_WALLETS)} wallets, pre-proven with gas budget x${String(GAS_BUDGET_MULTIPLIER)}, submitted together`,
        `  setup   funded ${String(funded)} wallet(s) in ${(fundMs / 1000).toFixed(1)}s, opened ${String(PARALLEL_WALLETS)} wallets in ${(contextsMs / 1000).toFixed(1)}s (not counted below)`,
        `  queue   ${String(items.length)} txs  ${String(queue.blocks)} block(s), max ${String(queue.maxPerBlock)} per block  prove ${(queue.proveMs / 1000).toFixed(1)}s  balance ${(queue.balanceMs / 1000).toFixed(1)}s  submit ${(queue.submitMs / 1000).toFixed(1)}s  finalized ${(queue.wallMs / 1000).toFixed(1)}s`,
        `  flush   1 tx   prove ${(flushProve.ms / 1000).toFixed(2)}s  finalized ${(flushWallMs / 1000).toFixed(1)}s  nonces ${String(base)}..${String(base + BigInt(items.length - 1))}`,
        `  send    ${String(items.length)} txs one at a time (cross-contract call, exact gas budget)  ${String(send.blocks)} block(s)  ${(send.wallMs / 1000).toFixed(1)}s`,
        `  sign    ${String(items.length)} signatures collected ${(signMs / 1000).toFixed(1)}s after the last send`,
        `  mine    ${String(items.length)} broadcasts in nonce order ${(broadcastMs / 1000).toFixed(1)}s`,
        `  total   ${(totalMs / 1000).toFixed(1)}s, ${(totalMs / 1000 / items.length).toFixed(1)}s per request`,
      ]);
    },
    60 * MINUTE,
  );
});

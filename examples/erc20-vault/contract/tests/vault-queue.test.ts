// Tests of the SDK's flush helpers, flushPending and flushUntil, over a fake chain.
// Every flush is built for real: the compiled flushQueue runs against the ledger state
// the chain serves, and the helpers assemble the transaction as they do live. The
// chain lands a flush by running its transcript against the state it holds at that
// moment, so a flush built on a state another flush has since changed fails its
// fallible section, as it does on a node. A flush can also land between a helper's
// ledger read and its build, which the build then runs on. Proving, balancing and fees
// are stand-ins.

import { readFileSync } from "node:fs";

import {
  type CircuitContext,
  ContractState,
  createCircuitContext,
  createConstructorContext,
  rawTokenType,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { CallTxFailedError } from "@midnight-ntwrk/midnight-js/contracts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js/network-id";
import {
  FailEntirely,
  FailFallible,
  type FinalizedTxData,
  SucceedEntirely,
  type TxStatus,
  type UnboundTransaction,
} from "@midnight-ntwrk/midnight-js/types";
import { CompiledContract } from "@midnight-ntwrk/midnight-js-protocol/compact-js";
import {
  ContractCall,
  ContractState as LedgerContractState,
  CostModel,
  type FinalizedTransaction,
  LedgerParameters,
  type PreProof,
  QueryContext,
  Transaction,
  type UnprovenTransaction,
  ZswapChainState,
} from "@midnight-ntwrk/midnight-js-protocol/ledger";
import {
  bytesToHex,
  hexToBytes,
  OutputKind,
  respondBidirectionalEventToCircuitInput,
} from "@sig-net/midnight";
import { attestRespondBidirectional, secp256k1PublicKeyOf } from "@sig-net/midnight/testing";
import * as SignetSigner from "@sig-net/midnight-contract/managed/contract/index.js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  Contract,
  createVaultPrivateState,
  type FlushItems,
  flushPending,
  flushSlots,
  flushUntil,
  ledger,
  pureCircuits,
  queuedRequestIndex,
  type VaultCompiledContract,
  type VaultLedgerState,
  type VaultPrivateState,
  type VaultProviders,
  witnesses,
} from "../src/index.ts";

// ---- Fixtures ----

const NETWORK_ID = "undeployed";
const CPK = "c0".repeat(32);
const SECRET_KEY = new Uint8Array(32).fill(7);
const MPC_RESPONSE_SECRET = new Uint8Array(32).fill(0x42);
const VAULT_ADDRESS = sampleContractAddress();
const ERC20 = new Uint8Array(20).fill(0xaa);
const AMOUNT = 1_000_000n;
const ATTESTED_HEIGHT = 150n;

// The vault token colour of ERC20, which a withdrawal surrenders.
const VAULT_TOKEN_COLOR = hexToBytes(
  rawTokenType(pureCircuits.vaultTokenDomainSeparator(ERC20), VAULT_ADDRESS),
);

// The helpers hash flushQueue's on-chain verifier key into the call's key location, so
// the served state must hold a key the ledger parses. The chain never checks a proof,
// so any well-formed key serves: this one ships with the Signet contract.
const STAND_IN_VERIFIER_KEY = new Uint8Array(
  readFileSync(
    new URL(import.meta.resolve("@sig-net/midnight-contract/managed/keys/respond.verifier")),
  ),
);

const VAULT_WITH_WITNESSES = CompiledContract.withWitnesses(
  CompiledContract.make<Contract<VaultPrivateState>>("erc20-vault", Contract),
  witnesses,
);
const VAULT_COMPILED_CONTRACT: VaultCompiledContract = CompiledContract.withCompiledFileAssets(
  VAULT_WITH_WITNESSES,
  new URL("../src/managed/erc20-vault", import.meta.url).pathname,
);

/** A deposit queued with `startDeposit`: its index and the EVM nonce it names. */
interface Deposit {
  inIndex: bigint;
  evmNonce: bigint;
}

/** `count` deposits with distinct nonces, so no two are twins, from index `from` on. */
const distinctDeposits = (from: bigint, count: number): Deposit[] =>
  Array.from({ length: count }, (_, i) => ({
    inIndex: from + BigInt(i),
    evmNonce: from + BigInt(i),
  }));

/** What the vault holds before any flush under test. */
interface VaultArrangement {
  /** Deposits sent whose executed attestations are queued, not yet flushed. */
  attested: Deposit[];
  /** Deposits sent and still open, with no attestation. */
  open: Deposit[];
  /** Deposits queued, not yet flushed. */
  queued: Deposit[];
  /** Input indexes of identical withdrawals queued, not yet flushed. */
  withdrawals: bigint[];
}

const EMPTY_VAULT: VaultArrangement = { attested: [], open: [], queued: [], withdrawals: [] };

// ---- Harness: the vault, built with the simulator ----

// The Signet contract the vault's send circuits call, served to the simulator at any
// address, round-tripped through bytes into this tree's ContractState class.
const SIGNET_ADDRESS = sampleContractAddress();
const signetStateProvider = async () => {
  const signet = await new SignetSigner.Contract({}).initialState(
    createConstructorContext(undefined, CPK),
  );
  const state = ContractState.deserialize(signet.currentContractState.serialize());
  return { getContractState: () => Promise.resolve(state) };
};

type VaultContext = CircuitContext<VaultPrivateState>;

const startDeposit = async (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  { inIndex, evmNonce }: Deposit,
): Promise<VaultContext> =>
  (
    await contract.circuits.startDeposit(
      ctx,
      inIndex,
      evmNonce,
      { gasLimit: 100_000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n },
      { erc20Address: ERC20, amount: AMOUNT },
    )
  ).context;

/** Queue, flush and send each deposit, returning the context and their request ids. */
const sendDeposits = async (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  deposits: Deposit[],
): Promise<{ ctx: VaultContext; requestIds: Uint8Array[] }> => {
  let next = ctx;
  const requestIds: Uint8Array[] = [];
  for (const deposit of deposits) {
    next = await startDeposit(contract, next, deposit);
    const outIndex = queuedRequestIndex(
      ledger(next.callContext.currentQueryContext.state),
      deposit.inIndex,
    );
    next = (await contract.circuits.flushQueue(next, flushSlots([deposit.inIndex], []))).context;
    next = (await contract.circuits.sendDeposit(next, outIndex)).context;
    for (const [requestId, index] of ledger(next.callContext.currentQueryContext.state)
      .evictionMap) {
      if (bytesToHex(index) === bytesToHex(outIndex)) requestIds.push(requestId);
    }
  }
  return { ctx: next, requestIds };
};

/**
 * Deploy, initialise, allow ERC20 and queue what `arrangement` names, in the simulator.
 * Returns the context, the attested deposits' request ids, and `serve`, which turns a
 * context into the contract state a chain serves.
 */
const arrangeVault = async (arrangement: VaultArrangement) => {
  const contract = new Contract<VaultPrivateState>(witnesses);
  const deployed = await contract.initialState(
    createConstructorContext(createVaultPrivateState(SECRET_KEY), CPK),
    pureCircuits.userCommitment(SECRET_KEY),
    { bytes: hexToBytes(SIGNET_ADDRESS) },
  );
  const onChain = ContractState.deserialize(deployed.currentContractState.serialize());
  const flushOperation = onChain.operation("flushQueue");
  if (!flushOperation) {
    throw new Error("the deployed vault has no flushQueue operation");
  }
  flushOperation.verifierKey = STAND_IN_VERIFIER_KEY;
  onChain.setOperation("flushQueue", flushOperation);
  const serve = (ctx: VaultContext): ContractState => {
    const served = ContractState.deserialize(onChain.serialize());
    served.data = ctx.callContext.currentQueryContext.state;
    return served;
  };

  let ctx = (
    await contract.circuits.initialise(
      createCircuitContext(
        "initialise",
        VAULT_ADDRESS,
        CPK,
        deployed.currentContractState,
        deployed.currentPrivateState,
        await signetStateProvider(),
        undefined,
        undefined,
        undefined,
        "00".repeat(32),
      ),
      new Uint8Array(20).fill(0xee),
      new Uint8Array(20).fill(0x11),
      new Uint8Array(20).fill(0xdd),
      new Uint8Array(20).fill(0xcc),
      11155111n,
      secp256k1PublicKeyOf(MPC_RESPONSE_SECRET),
      1n,
      100n,
    )
  ).context;
  ctx = (await contract.circuits.addAllowedToken(ctx, ERC20)).context;
  const attested = await sendDeposits(contract, ctx, arrangement.attested);
  ctx = attested.ctx;
  for (const requestId of attested.requestIds) {
    const attestation = respondBidirectionalEventToCircuitInput(
      attestRespondBidirectional(
        {
          requestId,
          blockHeight: ATTESTED_HEIGHT,
          outputKind: OutputKind.executed,
          serializedOutput: new Uint8Array([1]),
        },
        MPC_RESPONSE_SECRET,
      ),
    );
    ctx = (await contract.circuits.queueAttestation1(ctx, attestation, new Uint8Array([1])))
      .context;
  }
  ctx = (await sendDeposits(contract, ctx, arrangement.open)).ctx;
  for (const deposit of arrangement.queued) {
    ctx = await startDeposit(contract, ctx, deposit);
  }
  for (const inIndex of arrangement.withdrawals) {
    ctx = (
      await contract.circuits.startWithdraw(
        ctx,
        inIndex,
        { erc20Address: ERC20, amount: AMOUNT, destEvmAddress: new Uint8Array(20).fill(0x77) },
        {
          nonce: new Uint8Array(32).fill(Number(inIndex)),
          color: VAULT_TOKEN_COLOR,
          value: AMOUNT,
        },
      )
    ).context;
  }
  return { contract, ctx, attestedIds: attested.requestIds, serve };
};

// ---- Harness: the chain ----

/** What the chain does with a submitted flush. */
enum LandingKind {
  /** Runs the flush's transcript on the chain's state: it succeeds or fails as it reads. */
  Runs,
  /** Another flush lands first, then the submitted one runs on the state it left. */
  RunsAfterCompetitor,
  /** Lands with the given status and leaves the state as it was. */
  EndsWith,
  /** The prover throws before anything lands. */
  ProverThrows,
}

type Landing =
  | { kind: LandingKind.Runs }
  | { kind: LandingKind.RunsAfterCompetitor; competitor: ContractState }
  | { kind: LandingKind.EndsWith; status: TxStatus }
  | { kind: LandingKind.ProverThrows; error: Error };

/** The fake chain's provider set and what it records of the flushes submitted to it. */
interface FakeChain {
  providers: VaultProviders;
  /** The status each flush landed with, in submission order. */
  statuses: TxStatus[];
  /** The ledger the chain holds now. */
  ledgerNow: () => VaultLedgerState;
}

const unused = (): never => {
  throw new Error("the flush helpers must not call this provider member");
};

/**
 * The status a flush lands with on `state`, and the state it leaves: its guaranteed
 * transcript must apply or nothing lands, and a fallible transcript that fails on the
 * state leaves it as the guaranteed one left it.
 */
const runFlush = (
  state: ContractState,
  tx: UnprovenTransaction,
): { status: TxStatus; state: ContractState } => {
  const ledgerState = LedgerContractState.deserialize(state.serialize());
  const run = (transcript: ContractCall<PreProof>["fallibleTranscript"]): boolean => {
    if (!transcript) return true;
    try {
      ledgerState.data = new QueryContext(ledgerState.data, VAULT_ADDRESS).runTranscript(
        transcript,
        CostModel.initialCostModel(),
      ).state;
      return true;
    } catch {
      return false;
    }
  };
  const calls = [...(tx.intents?.values() ?? [])].flatMap((intent) =>
    intent.actions.filter((action) => action instanceof ContractCall),
  );
  if (!calls.every((call) => run(call.guaranteedTranscript))) {
    return { status: FailEntirely, state };
  }
  const fallibleApplied = calls.every((call) => run(call.fallibleTranscript));
  return {
    status: fallibleApplied ? SucceedEntirely : FailFallible,
    state: ContractState.deserialize(ledgerState.serialize()),
  };
};

/**
 * A chain serving `initial`, landing the n-th submitted flush as `landings[n]` says, and
 * every flush past the script as {@link LandingKind.Runs}. The n-th flush built reads
 * `landedBeforeBuild[n]` when one is given: the state another flush left after the
 * helper read the ledger.
 */
const fakeChain = (
  initial: ContractState,
  landings: Landing[] = [],
  landedBeforeBuild: ContractState[] = [],
): FakeChain => {
  let state = initial;
  const statuses: TxStatus[] = [];
  const landed = new Map<string, { tx: FinalizedTransaction; status: TxStatus }>();
  let pendingStatus: TxStatus = SucceedEntirely;
  let submitted = 0;
  let built = 0;

  const providers: VaultProviders = {
    publicDataProvider: {
      queryContractState: () => Promise.resolve(state),
      queryZSwapAndContractState: () => {
        state = landedBeforeBuild[built] ?? state;
        built += 1;
        return Promise.resolve([
          new ZswapChainState(),
          state,
          LedgerParameters.initialParameters(),
        ]);
      },
      queryBlock: () => Promise.resolve({ hash: "00".repeat(32), height: 1 }),
      watchForTxData: (txId): Promise<FinalizedTxData> => {
        const entry = landed.get(txId);
        if (!entry) throw new Error(`no flush landed as ${txId}`);
        return Promise.resolve({
          tx: entry.tx,
          status: entry.status,
          txId,
          identifiers: [txId],
          txHash: txId,
          blockHash: "00".repeat(32),
          blockHeight: 1,
          blockTimestamp: 0,
          blockAuthor: null,
          indexerId: 0,
          protocolVersion: 0,
          fees: { paidFees: "0", estimatedFees: "0" },
          segmentStatusMap: undefined,
          unshielded: { created: [], spent: [] },
        });
      },
      queryDeployContractState: unused,
      queryUnshieldedBalances: unused,
      watchForContractState: unused,
      watchForUnshieldedBalances: unused,
      watchForDeployTxData: unused,
      contractStateObservable: unused,
      unshieldedBalancesObservable: unused,
      queryContractEvents: unused,
      contractEventsObservable: unused,
    },
    privateStateProvider: {
      setContractAddress: () => undefined,
      get: () => Promise.resolve(createVaultPrivateState(SECRET_KEY)),
      set: unused,
      remove: unused,
      clear: unused,
      setSigningKey: unused,
      getSigningKey: unused,
      removeSigningKey: unused,
      clearSigningKeys: unused,
      exportPrivateStates: unused,
      importPrivateStates: unused,
      exportSigningKeys: unused,
      importSigningKeys: unused,
    },
    zkConfigProvider: {
      getZKIR: unused,
      getProverKey: unused,
      getVerifierKey: unused,
      getVerifierKeys: unused,
      get: unused,
      asKeyMaterialProvider: unused,
    },
    proofProvider: {
      proveTx: async (tx): Promise<UnboundTransaction> => {
        const landing = landings[submitted] ?? { kind: LandingKind.Runs };
        submitted += 1;
        if (landing.kind === LandingKind.ProverThrows) {
          throw landing.error;
        }
        if (landing.kind === LandingKind.EndsWith) {
          pendingStatus = landing.status;
        } else {
          if (landing.kind === LandingKind.RunsAfterCompetitor) state = landing.competitor;
          const ran = runFlush(state, tx);
          state = ran.state;
          pendingStatus = ran.status;
        }
        statuses.push(pendingStatus);
        return Transaction.fromParts(NETWORK_ID).prove(
          { check: unused, prove: unused, lookupKey: unused },
          CostModel.initialCostModel(),
        );
      },
    },
    walletProvider: {
      balanceTx: (tx) => Promise.resolve(tx.bind()),
      getCoinPublicKey: () => CPK,
      getEncryptionPublicKey: () => "11".repeat(32),
    },
    midnightProvider: {
      submitTx: (tx) => {
        const txId = `flush-${String(statuses.length)}`;
        landed.set(txId, { tx, status: pendingStatus });
        return Promise.resolve(txId);
      },
    },
  };
  return { providers, statuses, ledgerNow: () => ledger(state.data) };
};

/** The input indexes still queued, in ascending order. */
const queuedIndexes = (state: VaultLedgerState): bigint[] =>
  [...state.inputRequestBuffer].map(([inIndex]) => inIndex).sort((a, b) => (a < b ? -1 : 1));

beforeAll(() => {
  setNetworkId(NETWORK_ID);
});

// ---- Tests ----

/** One flushPending selection: the vault it flushes, the items named first, the outcome. */
interface SelectionCase {
  /** What the row shows. */
  name: string;
  /** The vault the chain serves. */
  vault: VaultArrangement;
  /** The input indexes flushPending is told to carry first. */
  firstIndexes: bigint[];
  /** The slots flushPending fills. */
  carried: number;
  /** The input indexes still queued after the flush lands. */
  stillQueued: bigint[];
  /** How many attestations are still queued after the flush lands. */
  attestationsQueued: bigint;
}

const SELECTION_CASES: SelectionCase[] = [
  {
    name: "carries every waiting request when they fit the width",
    vault: { ...EMPTY_VAULT, queued: distinctDeposits(1n, 3) },
    firstIndexes: [],
    carried: 3,
    stillQueued: [],
    attestationsQueued: 0n,
  },
  {
    name: "caps the flush at the width, leaving the rest queued",
    vault: { ...EMPTY_VAULT, queued: distinctDeposits(1n, 12) },
    firstIndexes: [3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n],
    carried: 10,
    stillQueued: [1n, 2n],
    attestationsQueued: 0n,
  },
  {
    name: "carries a queued attestation ahead of the requests not named first",
    vault: {
      ...EMPTY_VAULT,
      attested: distinctDeposits(101n, 1),
      queued: distinctDeposits(1n, 10),
    },
    firstIndexes: [2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n],
    carried: 10,
    stillQueued: [1n],
    attestationsQueued: 0n,
  },
  {
    name: "leaves out a request whose twin is open, and carries the rest",
    vault: {
      ...EMPTY_VAULT,
      open: [{ inIndex: 1n, evmNonce: 0n }],
      queued: [
        { inIndex: 2n, evmNonce: 0n },
        { inIndex: 3n, evmNonce: 1n },
      ],
    },
    firstIndexes: [],
    carried: 1,
    stillQueued: [2n],
    attestationsQueued: 0n,
  },
  {
    name: "leaves out the second of two twins queued together",
    vault: {
      ...EMPTY_VAULT,
      queued: [
        { inIndex: 1n, evmNonce: 0n },
        { inIndex: 2n, evmNonce: 0n },
      ],
    },
    firstIndexes: [2n],
    carried: 1,
    stillQueued: [1n],
    attestationsQueued: 0n,
  },
  {
    name: "carries every one of identical withdrawals: a vault-signed request has no twin",
    vault: { ...EMPTY_VAULT, withdrawals: [11n, 12n, 13n] },
    firstIndexes: [],
    carried: 3,
    stillQueued: [],
    attestationsQueued: 0n,
  },
  {
    name: "leaves a queued attestation behind when the items named first fill the width",
    vault: {
      ...EMPTY_VAULT,
      attested: distinctDeposits(101n, 1),
      queued: distinctDeposits(1n, 10),
    },
    firstIndexes: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n],
    carried: 10,
    stillQueued: [],
    attestationsQueued: 1n,
  },
  {
    name: "carries an item named first twice in one slot",
    vault: { ...EMPTY_VAULT, withdrawals: [11n] },
    firstIndexes: [11n, 11n],
    carried: 1,
    stillQueued: [],
    attestationsQueued: 0n,
  },
  {
    name: "passes over an item named first that nothing is queued under",
    vault: { ...EMPTY_VAULT, queued: distinctDeposits(1n, 1) },
    firstIndexes: [99n],
    carried: 1,
    stillQueued: [],
    attestationsQueued: 0n,
  },
];

describe("flushPending: which items a flush carries", () => {
  it.each(SELECTION_CASES)(
    "$name",
    async ({ vault, firstIndexes, carried, stillQueued, attestationsQueued }) => {
      const { ctx, serve } = await arrangeVault(vault);
      const chain = fakeChain(serve(ctx));

      const filled = await flushPending(chain.providers, VAULT_COMPILED_CONTRACT, VAULT_ADDRESS, {
        inIndexes: firstIndexes,
        requestIds: [],
      });

      expect(filled).toBe(carried);
      expect(chain.statuses).toEqual([SucceedEntirely]);
      const after = chain.ledgerNow();
      expect(queuedIndexes(after)).toEqual(stillQueued);
      expect(after.inputAttestationBuffer.size()).toBe(attestationsQueued);
    },
  );

  it("carries the items named first ahead of the rest, even the one the ledger lists last", async () => {
    const vault = { ...EMPTY_VAULT, queued: distinctDeposits(1n, 11) };
    const { ctx, serve } = await arrangeVault(vault);
    const leftOutUnnamed = fakeChain(serve(ctx));
    await flushPending(leftOutUnnamed.providers, VAULT_COMPILED_CONTRACT, VAULT_ADDRESS);
    const lastListed = queuedIndexes(leftOutUnnamed.ledgerNow());
    expect(lastListed).toHaveLength(1);

    const chain = fakeChain(serve(ctx));
    const filled = await flushPending(chain.providers, VAULT_COMPILED_CONTRACT, VAULT_ADDRESS, {
      inIndexes: lastListed,
      requestIds: [],
    });

    expect(filled).toBe(10);
    const stillQueued = queuedIndexes(chain.ledgerNow());
    expect(stillQueued).toHaveLength(1);
    expect(stillQueued).not.toEqual(lastListed);
  });
});

// A request a flusher waits for, queued beside one attested deposit.
const AWAITED: Deposit = { inIndex: 1n, evmNonce: 0n };
const AWAITED_VAULT: VaultArrangement = {
  ...EMPTY_VAULT,
  attested: [{ inIndex: 101n, evmNonce: 101n }],
  queued: [AWAITED],
};
const AWAITED_FIRST: FlushItems = { inIndexes: [AWAITED.inIndex], requestIds: [] };
const awaitedMoved = (state: VaultLedgerState): boolean =>
  !state.inputRequestBuffer.member(AWAITED.inIndex);

describe("flushPending: a flush that loses its race", () => {
  it("throws a CallTxFailedError with status FailFallible", async () => {
    const { contract, ctx, attestedIds, serve } = await arrangeVault(AWAITED_VAULT);
    const competitor = serve(
      (await contract.circuits.flushQueue(ctx, flushSlots([], attestedIds))).context,
    );
    const chain = fakeChain(serve(ctx), [{ kind: LandingKind.RunsAfterCompetitor, competitor }]);

    const flushed = flushPending(chain.providers, VAULT_COMPILED_CONTRACT, VAULT_ADDRESS);

    await expect(flushed).rejects.toThrow(CallTxFailedError);
    await expect(flushed).rejects.toMatchObject({ finalizedTxData: { status: FailFallible } });
    expect(chain.statuses).toEqual([FailFallible]);
  });
});

describe("flushPending: a flush that lands between the ledger read and the build", () => {
  it("fails the build on flushQueue's assert and submits nothing", async () => {
    const { contract, ctx, serve } = await arrangeVault(AWAITED_VAULT);
    const competitor = serve(
      (await contract.circuits.flushQueue(ctx, flushSlots([AWAITED.inIndex], []))).context,
    );
    const chain = fakeChain(serve(ctx), [], [competitor]);

    await expect(
      flushPending(chain.providers, VAULT_COMPILED_CONTRACT, VAULT_ADDRESS, AWAITED_FIRST),
    ).rejects.toThrow("failed assert: Request not queued");
    expect(chain.statuses).toEqual([]);
  });
});

describe("flushPending: nothing to move", () => {
  it.each([
    { name: "an empty vault", vault: EMPTY_VAULT, firstIndexes: [] },
    {
      name: "a vault whose requests are all open",
      vault: { ...EMPTY_VAULT, open: distinctDeposits(1n, 2) },
      firstIndexes: [],
    },
    {
      name: "a vault whose only queued request is the twin of an open one",
      vault: {
        ...EMPTY_VAULT,
        open: [{ inIndex: 1n, evmNonce: 0n }],
        queued: [{ inIndex: 2n, evmNonce: 0n }],
      },
      firstIndexes: [2n],
    },
    {
      name: "items named first that nothing is queued under",
      vault: EMPTY_VAULT,
      firstIndexes: [1n, 2n],
    },
  ])("submits no flush for $name, and returns 0", async ({ vault, firstIndexes }) => {
    const { ctx, serve } = await arrangeVault(vault);
    const chain = fakeChain(serve(ctx));

    const filled = await flushPending(chain.providers, VAULT_COMPILED_CONTRACT, VAULT_ADDRESS, {
      inIndexes: firstIndexes,
      requestIds: [],
    });

    expect(filled).toBe(0);
    expect(chain.statuses).toEqual([]);
  });
});

describe("flushUntil", () => {
  it("returns at once, submitting nothing, when the ledger already shows the awaited item", async () => {
    const { ctx, serve } = await arrangeVault(AWAITED_VAULT);
    const chain = fakeChain(serve(ctx));

    const state = await flushUntil(
      chain.providers,
      VAULT_COMPILED_CONTRACT,
      VAULT_ADDRESS,
      (ledgerState) => ledgerState.inputRequestBuffer.member(AWAITED.inIndex),
      AWAITED_FIRST,
    );

    expect(state.inputRequestBuffer.member(AWAITED.inIndex)).toBe(true);
    expect(chain.statuses).toEqual([]);
  });

  it("flushes once and returns the ledger showing the awaited item moved", async () => {
    const { ctx, serve } = await arrangeVault(AWAITED_VAULT);
    const chain = fakeChain(serve(ctx));

    const state = await flushUntil(
      chain.providers,
      VAULT_COMPILED_CONTRACT,
      VAULT_ADDRESS,
      awaitedMoved,
      AWAITED_FIRST,
    );

    expect(awaitedMoved(state)).toBe(true);
    expect(chain.statuses).toEqual([SucceedEntirely]);
  });

  it("retries a flush that lost its race (FailFallible), and the retry moves the awaited item", async () => {
    const { contract, ctx, attestedIds, serve } = await arrangeVault(AWAITED_VAULT);
    // Another flusher folds the attestation first: the awaited flush, which carries the
    // attestation too, then reads a height and a record that have changed.
    const competitor = serve(
      (await contract.circuits.flushQueue(ctx, flushSlots([], attestedIds))).context,
    );
    const chain = fakeChain(serve(ctx), [{ kind: LandingKind.RunsAfterCompetitor, competitor }]);

    const state = await flushUntil(
      chain.providers,
      VAULT_COMPILED_CONTRACT,
      VAULT_ADDRESS,
      awaitedMoved,
      AWAITED_FIRST,
    );

    expect(chain.statuses).toEqual([FailFallible, SucceedEntirely]);
    expect(awaitedMoved(state)).toBe(true);
    expect(state.globalLastSeen).toBe(ATTESTED_HEIGHT);
  });

  it("retries a flush whose build found an item another flush moved, and the retry moves the awaited item", async () => {
    const { contract, ctx, attestedIds, serve } = await arrangeVault(AWAITED_VAULT);
    // Another flusher folds the attestation after flushPending chose it with the awaited
    // request: the build's attestation slot then names a record that is gone.
    const competitor = serve(
      (await contract.circuits.flushQueue(ctx, flushSlots([], attestedIds))).context,
    );
    const chain = fakeChain(serve(ctx), [], [competitor]);

    const state = await flushUntil(
      chain.providers,
      VAULT_COMPILED_CONTRACT,
      VAULT_ADDRESS,
      awaitedMoved,
      AWAITED_FIRST,
    );

    expect(chain.statuses).toEqual([SucceedEntirely]);
    expect(awaitedMoved(state)).toBe(true);
    expect(state.globalLastSeen).toBe(ATTESTED_HEIGHT);
  });

  it("returns without another flush when the flush that won the race moved the awaited item", async () => {
    const { contract, ctx, serve } = await arrangeVault(AWAITED_VAULT);
    const competitor = serve(
      (await contract.circuits.flushQueue(ctx, flushSlots([AWAITED.inIndex], []))).context,
    );
    const chain = fakeChain(serve(ctx), [{ kind: LandingKind.RunsAfterCompetitor, competitor }]);

    const state = await flushUntil(
      chain.providers,
      VAULT_COMPILED_CONTRACT,
      VAULT_ADDRESS,
      awaitedMoved,
      AWAITED_FIRST,
    );

    expect(chain.statuses).toEqual([FailFallible]);
    expect(awaitedMoved(state)).toBe(true);
  });

  it.each([
    {
      name: "a flush that fails entirely",
      landing: { kind: LandingKind.EndsWith, status: FailEntirely } satisfies Landing,
      throws: CallTxFailedError,
      statuses: [FailEntirely],
    },
    {
      name: "a prover that throws",
      landing: {
        kind: LandingKind.ProverThrows,
        error: new Error("proof server unavailable"),
      } satisfies Landing,
      throws: /proof server unavailable/,
      statuses: [],
    },
  ])("throws, without retrying, on $name", async ({ landing, throws, statuses }) => {
    const { ctx, serve } = await arrangeVault(AWAITED_VAULT);
    const chain = fakeChain(serve(ctx), [landing]);

    await expect(
      flushUntil(
        chain.providers,
        VAULT_COMPILED_CONTRACT,
        VAULT_ADDRESS,
        awaitedMoved,
        AWAITED_FIRST,
      ),
    ).rejects.toThrow(throws);
    expect(chain.statuses).toEqual(statuses);
  });

  it("throws when nothing it could flush would move the awaited item", async () => {
    const { ctx, serve } = await arrangeVault({
      ...EMPTY_VAULT,
      open: [{ inIndex: 2n, evmNonce: AWAITED.evmNonce }],
      queued: [AWAITED],
    });
    const chain = fakeChain(serve(ctx));

    await expect(
      flushUntil(
        chain.providers,
        VAULT_COMPILED_CONTRACT,
        VAULT_ADDRESS,
        awaitedMoved,
        AWAITED_FIRST,
      ),
    ).rejects.toThrow(/nothing to flush/);
    expect(chain.statuses).toEqual([]);
  });

  it("returns the ledger a flush on its last attempt produced", async () => {
    const { ctx, serve } = await arrangeVault(AWAITED_VAULT);
    const chain = fakeChain(serve(ctx));

    const state = await flushUntil(
      chain.providers,
      VAULT_COMPILED_CONTRACT,
      VAULT_ADDRESS,
      awaitedMoved,
      AWAITED_FIRST,
      1,
    );

    expect(chain.statuses).toEqual([SucceedEntirely]);
    expect(awaitedMoved(state)).toBe(true);
  });

  it("gives up after its attempts when every flush loses its race", async () => {
    const { ctx, serve } = await arrangeVault(AWAITED_VAULT);
    const lost: Landing = { kind: LandingKind.EndsWith, status: FailFallible };
    const chain = fakeChain(serve(ctx), [lost, lost, lost]);

    await expect(
      flushUntil(
        chain.providers,
        VAULT_COMPILED_CONTRACT,
        VAULT_ADDRESS,
        awaitedMoved,
        AWAITED_FIRST,
        3,
      ),
    ).rejects.toThrow("still not flushed after 3 flush attempts");
    expect(chain.statuses).toEqual([FailFallible, FailFallible, FailFallible]);
  });
});

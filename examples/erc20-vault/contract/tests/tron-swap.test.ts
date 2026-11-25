import { readFileSync } from "node:fs";

import {
  type CircuitContext,
  createCircuitContext,
  createConstructorContext,
  rawTokenType,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { ContractOperation, ContractState } from "@midnightntwrk/onchain-runtime-v4";
import {
  asciiPadded,
  bytesToHex,
  calculateRequestId,
  decodeSignBidirectionalEventNotificationPayload,
  decodeSignBidirectionalNotification,
  decodeSignetLogEvents,
  evmAddressAbiWord,
  hexToBytes,
  isTronRequest,
  MPCDestination,
  MPCSignatureAlgorithm,
  numericAbiWord,
  OutputKind,
  pureCircuits as signetCircuits,
  readSignetRequestsLedgerFromState,
  requestIdHex,
  type RespondBidirectionalEvent,
  respondBidirectionalEventToCircuitInput,
  serializeRespondOutput,
  TxParamType,
} from "@sig-net/midnight";
import { attestRespondBidirectional, secp256k1PublicKeyOf } from "@sig-net/midnight/testing";
import * as SignetSigner from "@sig-net/midnight-signer/managed/contract/index.js";
import { describe, expect, it } from "vitest";

import {
  Action,
  Chain,
  Contract,
  createVaultPrivateState,
  flushSlots,
  ledger,
  pureCircuits,
  queuedRequestIndex,
  VAULT_TRON_APPROVE_REQUESTS_PATH,
  VAULT_TRON_SWAP_REQUESTS_PATH,
  type VaultPrivateState,
  witnesses,
} from "../src/index.ts";

const CPK = "c0".repeat(32);
const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

const first = <T>(items: Iterable<T>, what: string): T => {
  for (const item of items) {
    return item;
  }
  throw new Error(`expected at least one ${what}`);
};

const SECRET_KEY = bytes(32, 7);
const OTHER_SECRET_KEY = bytes(32, 8);
const DEPLOYER_COMMITMENT = pureCircuits.userCommitment(SECRET_KEY);

const MPC_RESPONSE_SECRET = bytes(32, 0x42);
const MPC_RESPONSE_KEY = secp256k1PublicKeyOf(MPC_RESPONSE_SECRET);
const MPC_KEY_VERSION = 1n;
const EVM_START_HEIGHT = 100n;
const TRON_START_HEIGHT = 5_000n;
const TRON_ATTESTED_HEIGHT = 5_001n;

const SIGNET_ADDRESS = sampleContractAddress();
const BLOCK_HASH = "0".repeat(64);
const VAULT_ADDRESS = sampleContractAddress();

const VAULT_EVM = bytes(20, 0xee);
const ROUTER = bytes(20, 0x11);
const SUNSWAP_ROUTER = bytes(20, 0x5a);
const STATA_UNDERLYING = bytes(20, 0xdd);
const STATA_TOKEN = bytes(20, 0xcc);
const TRC20 = bytes(20, 0x7a);
const TRC20_OUT = bytes(20, 0x7b);
const UNLISTED_TRC20 = bytes(20, 0x99);
const ZERO_ADDRESS = new Uint8Array(20);
const CHAIN_ID = 11155111n;
const NO_FEES = { withdraw: 0n, swap: 0n, supply: 0n, redeem: 0n };
const TRON_TOKEN_FEES = { withdraw: 71n, swap: 73n, supply: 79n, redeem: 83n };
const UINT64_MAX = 18446744073709551615n;
const INT64_MAX = 9223372036854775807n;
const UNLIMITED_ALLOWANCE = 2n ** 128n - 1n;
const MINT_NONCE = bytes(32, 0x2e);
const CHANGE_NONCE = bytes(32, 0x3f);
const FEE_RECIPIENT_CPK = bytes(32, 0xfe);
const ERC20_APPROVE_SELECTOR = new Uint8Array([0x09, 0x5e, 0xa7, 0xb3]);
const SUNSWAP_EXACT_OUTPUT_SINGLE_SELECTOR = new Uint8Array([0xdb, 0x3e, 0x21, 0x98]);
const DEFAULT_TRON_FEE_LIMITS = { approve: 100_000_000n, swap: 300_000_000n };

const SWAP_FEE = 500n;
const SWAP_AMOUNT_OUT = 1_000_000n;
const SWAP_AMOUNT_IN_MAX = 1_100_000n;
const SWAP_AMOUNT_IN_SPENT = 1_000_503n;

const TRON_TOKEN_COLOR = hexToBytes(
  rawTokenType(pureCircuits.vaultTronTokenDomainSeparator(TRC20), VAULT_ADDRESS),
);
const TRON_TOKEN_COLOR_OUT = hexToBytes(
  rawTokenType(pureCircuits.vaultTronTokenDomainSeparator(TRC20_OUT), VAULT_ADDRESS),
);
const TRON_TOKEN_MINT_KEY = bytesToHex(pureCircuits.vaultTronTokenDomainSeparator(TRC20));
const TRON_TOKEN_OUT_MINT_KEY = bytesToHex(pureCircuits.vaultTronTokenDomainSeparator(TRC20_OUT));

const TO_CALLER = {
  is_left: true,
  left: { bytes: hexToBytes(CPK) },
  right: { bytes: new Uint8Array(32) },
};

interface VaultTronTx {
  refBlockBytes: Uint8Array;
  refBlockHash: Uint8Array;
  timestamp: bigint;
  expiration: bigint;
}

const NOW_SECONDS = 1_700_000_000;
const EXPIRATION_SECONDS = 1_700_001_200n;
const START_MIN_REMAINING_SECONDS = pureCircuits.tronSwapStartMinRemainingSeconds();
const SEND_MIN_REMAINING_SECONDS = pureCircuits.tronSwapSendMinRemainingSeconds();
const CAP_MARGIN_SECONDS = pureCircuits.tronSwapCapMarginSeconds();
const MAX_EXPIRATION_SPAN_SECONDS = 86_400n;
const SEND_CLOSES_SECONDS = Number(EXPIRATION_SECONDS - SEND_MIN_REMAINING_SECONDS);

const VALID_TRON_TX: VaultTronTx = {
  refBlockBytes: Uint8Array.of(0x12, 0x34),
  refBlockHash: bytes(8, 0x56),
  timestamp: 1_700_000_000_000n,
  expiration: EXPIRATION_SECONDS * 1000n,
};

const SIGNED_TRON_TX = VALID_TRON_TX;

interface TronApproveCallArgs {
  inIndex: bigint;
  tronTx: VaultTronTx;
  tokenAddress: Uint8Array;
}

const VALID_TRON_APPROVE: TronApproveCallArgs = {
  inIndex: 1n,
  tronTx: VALID_TRON_TX,
  tokenAddress: TRC20,
};

const tronCoin = (value: bigint, color: Uint8Array = TRON_TOKEN_COLOR) => ({
  nonce: bytes(32, 0x0c),
  color,
  value,
});

interface TronSwapCallArgs {
  inIndex: bigint;
  tronTx: VaultTronTx;
  swap: {
    tokenAddressIn: Uint8Array;
    tokenAddressOut: Uint8Array;
    fee: bigint;
    amountOut: bigint;
    amountInMaximum: bigint;
  };
  coin: ReturnType<typeof tronCoin>;
}

const VALID_TRON_SWAP: TronSwapCallArgs = {
  inIndex: 2n,
  tronTx: { ...VALID_TRON_TX, timestamp: VALID_TRON_TX.timestamp + 1n },
  swap: {
    tokenAddressIn: TRC20,
    tokenAddressOut: TRC20_OUT,
    fee: SWAP_FEE,
    amountOut: SWAP_AMOUNT_OUT,
    amountInMaximum: SWAP_AMOUNT_IN_MAX,
  },
  coin: tronCoin(SWAP_AMOUNT_IN_MAX + TRON_TOKEN_FEES.swap),
};

const SIGNET_VERIFIER_KEYS: ReadonlyMap<string, Uint8Array> = new Map(
  Object.entries(SignetSigner.circuitSignatures)
    .filter(([, signature]) => signature.provable)
    .map(([circuitId]) => [
      circuitId,
      readFileSync(
        new URL(`../src/managed/SignetSigner/keys/${circuitId}.verifier`, import.meta.url),
      ),
    ]),
);

async function deployedSignetState(): Promise<ContractState> {
  const signet = new SignetSigner.Contract({});
  const { currentContractState } = await signet.initialState(
    createConstructorContext(undefined, CPK),
  );
  const state = ContractState.deserialize(currentContractState.serialize());
  for (const [circuitId, verifierKey] of SIGNET_VERIFIER_KEYS) {
    const operation = new ContractOperation();
    operation.verifierKey = verifierKey;
    state.setOperation(circuitId, operation);
  }
  return state;
}

const signetCrossContract = {
  stateProvider: { getContractState: deployedSignetState },
  moduleProvider: { resolve: () => () => Promise.resolve(SignetSigner) },
};

type VaultContext = CircuitContext<VaultPrivateState>;

const contextOf = (
  state: unknown,
  secretKey: Uint8Array,
  time: number = NOW_SECONDS,
): VaultContext =>
  createCircuitContext({
    time,
    circuitId: "startTronSwap",
    contractAddress: VAULT_ADDRESS,
    coinPublicKeyOrZswapState: CPK,
    contractState: state as never,
    privateState: createVaultPrivateState(secretKey),
    parentBlockHash: BLOCK_HASH,
    crossContract: signetCrossContract,
  });

const strangerOf = (ctx: VaultContext, time: number = NOW_SECONDS): VaultContext =>
  contextOf(ctx.callContext.currentQueryContext.state, OTHER_SECRET_KEY, time);

const atTime = (ctx: VaultContext, time: number): VaultContext =>
  contextOf(ctx.callContext.currentQueryContext.state, SECRET_KEY, time);

const deployContract = async () => {
  const contract = new Contract<VaultPrivateState>(witnesses);
  const { currentContractState } = await contract.initialState(
    createConstructorContext<VaultPrivateState>(createVaultPrivateState(SECRET_KEY), CPK),
    DEPLOYER_COMMITMENT,
    { bytes: hexToBytes(SIGNET_ADDRESS) },
  );
  return { contract, ctx: contextOf(currentContractState, SECRET_KEY) };
};

const ledgerOf = (ctx: VaultContext) => ledger(ctx.callContext.currentQueryContext.state);

const deployInitialisedWith = async (sunswapRouter: Uint8Array) => {
  const { contract, ctx } = await deployContract();
  let next = (
    await contract.circuits.initialise(
      ctx,
      VAULT_EVM,
      ROUTER,
      STATA_UNDERLYING,
      STATA_TOKEN,
      CHAIN_ID,
      MPC_RESPONSE_KEY,
      MPC_KEY_VERSION,
      EVM_START_HEIGHT,
      TRON_START_HEIGHT,
      ZERO_ADDRESS,
      sunswapRouter,
      NO_FEES,
      NO_FEES,
      { bytes: FEE_RECIPIENT_CPK },
      bytes(32, 0xef),
    )
  ).context;
  next = (await contract.circuits.addAllowedTronToken(next, TRC20, TRON_TOKEN_FEES)).context;
  next = (await contract.circuits.addAllowedTronToken(next, TRC20_OUT, NO_FEES)).context;
  return { contract, ctx: next };
};

const deployInitialised = () => deployInitialisedWith(SUNSWAP_ROUTER);

const flush = async (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  inIndexes: readonly bigint[],
  requestIds: readonly Uint8Array[],
): Promise<VaultContext> =>
  (await contract.circuits.flushQueue(ctx, flushSlots(inIndexes, requestIds))).context;

const queueTronApprove = (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  args: TronApproveCallArgs,
) => contract.circuits.startTronApproveRouter(ctx, args.inIndex, args.tronTx, args.tokenAddress);

const tronApprove = async (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  args: TronApproveCallArgs,
) => {
  const queued = (await queueTronApprove(contract, ctx, args)).context;
  const outIndex = queuedRequestIndex(ledgerOf(queued), args.inIndex);
  const flushed = await flush(contract, queued, [args.inIndex], []);
  const sent = (await contract.circuits.sendTronApprove(flushed, outIndex)).context;
  const requestId = first(ledgerOf(sent).bidirectionalTronApproveMap, "Tron approve request")[0];
  return { context: sent, outIndex, requestId };
};

const queueTronSwap = (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  args: TronSwapCallArgs,
) => contract.circuits.startTronSwap(ctx, args.inIndex, args.tronTx, args.swap, args.coin);

const tronSwap = async (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  args: TronSwapCallArgs,
) => {
  const queued = (await queueTronSwap(contract, ctx, args)).context;
  const outIndex = queuedRequestIndex(ledgerOf(queued), args.inIndex);
  const flushed = await flush(contract, queued, [args.inIndex], []);
  const sent = (await contract.circuits.sendTronSwap(flushed, outIndex)).context;
  const requestId = first(ledgerOf(sent).bidirectionalTronSwapMap, "Tron swap request")[0];
  return { context: sent, outIndex, requestId };
};

const respond = (
  secretKey: Uint8Array,
  requestId: Uint8Array,
  outputKind: OutputKind,
  serializedOutput: Uint8Array,
  blockHeight: bigint,
): RespondBidirectionalEvent =>
  respondBidirectionalEventToCircuitInput(
    attestRespondBidirectional({ requestId, blockHeight, outputKind, serializedOutput }, secretKey),
  );

const attest = async (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  attestation: RespondBidirectionalEvent,
): Promise<VaultContext> => {
  const queued = (await contract.circuits.queueAttestation(ctx, attestation)).context;
  return flush(contract, queued, [], [attestation.requestId]);
};

const zswapOutputs = (ctx: VaultContext) => {
  const state = ctx.callContext.currentZswapLocalState;
  if (!state) {
    throw new Error("expected zswap local state on the circuit context");
  }
  return state.outputs;
};

const coinsMinted = (before: VaultContext, settled: VaultContext) =>
  zswapOutputs(settled).slice(zswapOutputs(before).length);

const shieldedMintsSince = (before: VaultContext, settled: VaultContext): [string, bigint][] => {
  const earlier = before.callContext.currentQueryContext.effects.shieldedMints;
  return [...settled.callContext.currentQueryContext.effects.shieldedMints.entries()]
    .map(([token, amount]): [string, bigint] => [token, amount - (earlier.get(token) ?? 0n)])
    .filter(([, amount]) => amount !== 0n);
};

const OUTPUT_EMPTY = new Uint8Array(0);
const OUTPUT_TRUE = Uint8Array.of(1);
const OUTPUT_FALSE = Uint8Array.of(0);
const VAULT_OUTPUT_SCHEMA = new TextEncoder().encode('[{"name":"success","type":"bool"}]');
const SWAP_OUTPUT_SCHEMA = asciiPadded('[{"name":"amountIn","type":"uint256"}]', 38);
const swapOutput = (amountIn: bigint): Uint8Array =>
  serializeRespondOutput(pureCircuits.swapOutputSchema(), { amountIn });
const OUTPUT_SWAP = swapOutput(SWAP_AMOUNT_IN_SPENT);
const OUTPUT_SWAP_IGNORED = new Uint8Array(32);

describe("initialise", () => {
  it("stores the SunSwap router and the default Tron fee limits", async () => {
    const { ctx } = await deployInitialised();
    expect(ledgerOf(ctx).sunswapRouter).toEqual(SUNSWAP_ROUTER);
    expect(ledgerOf(ctx).vaultTronFeeLimits).toEqual(DEFAULT_TRON_FEE_LIMITS);
    expect(ledgerOf(ctx).vaultTronTimestamps.isEmpty()).toBe(true);
  });
});

const setTronFeeLimits = (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  approve: bigint,
  swap: bigint,
) => contract.circuits.setGasParams(ctx, 1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n, approve, swap);

describe("setGasParams: the Tron approve and swap fee limits", () => {
  it("stores both fee limits", async () => {
    const { contract, ctx } = await deployInitialised();
    const next = (await setTronFeeLimits(contract, ctx, 5n, INT64_MAX)).context;
    expect(ledgerOf(next).vaultTronFeeLimits).toEqual({ approve: 5n, swap: INT64_MAX });
  });

  it.each([
    {
      name: "a zero approve limit",
      approve: 0n,
      swap: 1n,
      throws: /Tron fee limit must be positive/,
    },
    { name: "a zero swap limit", approve: 1n, swap: 0n, throws: /Tron fee limit must be positive/ },
    {
      name: "an approve limit above int64",
      approve: INT64_MAX + 1n,
      swap: 1n,
      throws: /Tron fee limit exceeds int64/,
    },
    {
      name: "a swap limit above int64",
      approve: 1n,
      swap: INT64_MAX + 1n,
      throws: /Tron fee limit exceeds int64/,
    },
  ])("rejects $name", async ({ approve, swap, throws }) => {
    const { contract, ctx } = await deployInitialised();
    await expect(setTronFeeLimits(contract, ctx, approve, swap)).rejects.toThrow(throws);
  });

  it("a request keeps the fee limit it was started with, and the next one takes the new limit", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueTronSwap(contract, ctx, VALID_TRON_SWAP)).context;
    const reset = (await setTronFeeLimits(contract, queued, 5n, 6n)).context;
    const later = { ...VALID_TRON_SWAP, inIndex: 3n, tronTx: VALID_TRON_TX };
    const both = (await queueTronSwap(contract, reset, later)).context;
    expect(ledgerOf(both).tronSwapArgsMap.lookup(VALID_TRON_SWAP.inIndex).tx.feeLimit).toBe(
      DEFAULT_TRON_FEE_LIMITS.swap,
    );
    expect(ledgerOf(both).tronSwapArgsMap.lookup(later.inIndex).tx.feeLimit).toBe(6n);
  });
});

describe("Tron approve round-trip", () => {
  it("stores a vault-path Tron approve of the SunSwap router at the vault's fee limit", async () => {
    const { contract, ctx } = await deployInitialised();
    const {
      context: sent,
      outIndex,
      requestId,
    } = await tronApprove(contract, ctx, VALID_TRON_APPROVE);
    const state = sent.callContext.currentQueryContext.state;

    const rawLedger = readSignetRequestsLedgerFromState(state, VAULT_TRON_APPROVE_REQUESTS_PATH);
    expect(rawLedger.requestsIndex.size).toBe(1);
    const record = first(rawLedger.requestsIndex.values(), "raw Tron request");
    if (!isTronRequest(record)) {
      throw new Error("expected a Tron request record");
    }
    expect(requestIdHex(calculateRequestId(record))).toBe(requestIdHex(requestId));
    expect(record).toEqual(ledgerOf(sent).bidirectionalTronApproveMap.lookup(requestId));

    const notification = first(
      decodeSignetLogEvents(sent.events, SIGNET_ADDRESS),
      "signet notification event",
    );
    const post = decodeSignBidirectionalEventNotificationPayload(notification.payload);
    expect(requestIdHex(post.requestId)).toBe(requestIdHex(requestId));
    expect(decodeSignBidirectionalNotification(post.event)).toEqual({
      version: 1,
      callerAddress: bytesToHex(hexToBytes(VAULT_ADDRESS)),
      requestsPath: [...VAULT_TRON_APPROVE_REQUESTS_PATH],
    });

    expect(record.txParamType).toBe(TxParamType.tron);
    expect(record.path).toEqual(asciiPadded("vault", 32));
    expect(record.keyVersion).toBe(MPC_KEY_VERSION);
    expect(record.algo).toBe(MPCSignatureAlgorithm.ecdsa);
    expect(record.signatureDest).toBe(MPCDestination.unused);
    expect(record.executionDest).toEqual(signetCircuits.tronCaip2Id());
    expect(record.outputDeserializationSchema).toEqual(VAULT_OUTPUT_SCHEMA);
    expect(record.respondSerializationSchema).toEqual(new Uint8Array(0));
    expect(record.txParams).toEqual({
      ...SIGNED_TRON_TX,
      feeLimit: DEFAULT_TRON_FEE_LIMITS.approve,
      contractAddress: Uint8Array.of(0x41, ...TRC20),
      callValue: 0n,
      calldata: {
        is_some: true,
        value: {
          selector: ERC20_APPROVE_SELECTOR,
          noWords: 2n,
          words: [evmAddressAbiWord(SUNSWAP_ROUTER), numericAbiWord(UNLIMITED_ALLOWANCE)],
        },
      },
    });

    const { entry, lastSeen } = ledgerOf(sent).outputRequestBuffer.lookup(outIndex);
    expect(entry).toEqual({
      action: Action.tronApprove,
      chain: Chain.tron,
      useNextVaultAccountNonce: false,
      evmNonce: 0n,
      inIndex: VALID_TRON_APPROVE.inIndex,
      commitment: pureCircuits.ownershipCommitment(VALID_TRON_APPROVE.inIndex, SECRET_KEY),
      argsHash: expect.any(Uint8Array) as Uint8Array,
    });
    expect(lastSeen).toBe(TRON_START_HEIGHT);
    expect(ledgerOf(sent).tronApproveArgsMap.lookup(VALID_TRON_APPROVE.inIndex)).toEqual({
      request: { tokenAddress: TRC20, spender: SUNSWAP_ROUTER },
      tx: { ...SIGNED_TRON_TX, feeLimit: DEFAULT_TRON_FEE_LIMITS.approve },
    });
    expect(ledgerOf(sent).evictionMap.lookup(requestId)).toEqual(outIndex);
    expect(ledgerOf(sent).vaultTronTimestamps.member(VALID_TRON_TX.timestamp)).toBe(true);
    expect(ledgerOf(sent).vaultAccountNonce).toBe(0n);
  });

  it("sendTronApprove is permissionless and refuses a second send", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueTronApprove(contract, ctx, VALID_TRON_APPROVE)).context;
    const outIndex = queuedRequestIndex(ledgerOf(queued), VALID_TRON_APPROVE.inIndex);
    const flushed = await flush(contract, queued, [VALID_TRON_APPROVE.inIndex], []);
    const sent = (await contract.circuits.sendTronApprove(strangerOf(flushed), outIndex)).context;
    expect(ledgerOf(sent).bidirectionalTronApproveMap.size()).toBe(1n);
    await expect(contract.circuits.sendTronApprove(sent, outIndex)).rejects.toThrow(
      /Request already sent/,
    );
  });

  it("sendTronApprove refuses an index the flush has not moved", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueTronApprove(contract, ctx, VALID_TRON_APPROVE)).context;
    const outIndex = queuedRequestIndex(ledgerOf(queued), VALID_TRON_APPROVE.inIndex);
    await expect(contract.circuits.sendTronApprove(queued, outIndex)).rejects.toThrow(
      /Request not flushed/,
    );
  });

  it("sendTronApprove refuses a Tron swap's index, and sendTronSwap a Tron approve's", async () => {
    const { contract, ctx } = await deployInitialised();
    const approveQueued = (await queueTronApprove(contract, ctx, VALID_TRON_APPROVE)).context;
    const bothQueued = (await queueTronSwap(contract, approveQueued, VALID_TRON_SWAP)).context;
    const approveOut = queuedRequestIndex(ledgerOf(bothQueued), VALID_TRON_APPROVE.inIndex);
    const swapOut = queuedRequestIndex(ledgerOf(bothQueued), VALID_TRON_SWAP.inIndex);
    const flushed = await flush(
      contract,
      bothQueued,
      [VALID_TRON_APPROVE.inIndex, VALID_TRON_SWAP.inIndex],
      [],
    );
    await expect(contract.circuits.sendTronApprove(flushed, swapOut)).rejects.toThrow(
      /Wrong action/,
    );
    await expect(contract.circuits.sendTronSwap(flushed, approveOut)).rejects.toThrow(
      /Wrong action/,
    );
  });
});

interface TronApproveRejectionCase {
  name: string;
  args: TronApproveCallArgs;
  throws: RegExp;
}

const TRON_APPROVE_REJECTION_CASES: TronApproveRejectionCase[] = [
  {
    name: "the zero address",
    args: { ...VALID_TRON_APPROVE, tokenAddress: ZERO_ADDRESS },
    throws: /TRC-20 address cannot be zero/,
  },
  {
    name: "an expiration equal to the timestamp",
    args: {
      ...VALID_TRON_APPROVE,
      tronTx: { ...VALID_TRON_TX, timestamp: EXPIRATION_SECONDS * 1000n },
    },
    throws: /Tron expiration must follow its timestamp/,
  },
  {
    name: "an expiration above int64",
    args: {
      ...VALID_TRON_APPROVE,
      tronTx: { ...VALID_TRON_TX, expiration: INT64_MAX + 1n },
    },
    throws: /Tron expiration exceeds int64/,
  },
  {
    name: "an expiration within the margin of the block time",
    args: {
      ...VALID_TRON_APPROVE,
      tronTx: {
        ...VALID_TRON_TX,
        expiration: (BigInt(NOW_SECONDS) + START_MIN_REMAINING_SECONDS) * 1000n,
      },
    },
    throws: /Tron expiration too close to the block time/,
  },
  {
    name: "an expiration more than 24 hours less the margin ahead of the block time",
    args: {
      ...VALID_TRON_APPROVE,
      tronTx: {
        ...VALID_TRON_TX,
        expiration:
          (BigInt(NOW_SECONDS) + MAX_EXPIRATION_SPAN_SECONDS - CAP_MARGIN_SECONDS) * 1000n,
      },
    },
    throws: /Tron expiration too far past the block time/,
  },
];

describe("Tron approve validation", () => {
  it.each(TRON_APPROVE_REJECTION_CASES)("rejects $name", async ({ args, throws }) => {
    const { contract, ctx } = await deployInitialised();
    await expect(queueTronApprove(contract, ctx, args)).rejects.toThrow(throws);
  });

  it("is deployer-gated", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(queueTronApprove(contract, strangerOf(ctx), VALID_TRON_APPROVE)).rejects.toThrow(
      /Not the deployer/,
    );
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(queueTronApprove(contract, ctx, VALID_TRON_APPROVE)).rejects.toThrow(
      /Not initialised/,
    );
  });

  it("rejects while the SunSwap router is the zero address", async () => {
    const { contract, ctx } = await deployInitialisedWith(ZERO_ADDRESS);
    await expect(queueTronApprove(contract, ctx, VALID_TRON_APPROVE)).rejects.toThrow(
      /SunSwap router not set/,
    );
  });

  it("rejects an index the input buffer holds", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueTronApprove(contract, ctx, VALID_TRON_APPROVE)).context;
    await expect(
      queueTronApprove(contract, queued, {
        ...VALID_TRON_APPROVE,
        tronTx: { ...VALID_TRON_TX, timestamp: VALID_TRON_TX.timestamp + 5n },
      }),
    ).rejects.toThrow(/Index already in use/);
  });
});

describe("vault-signed Tron requests never share a timestamp", () => {
  it("a copied timestamp is refused at start, before the coin is taken, and a new timestamp goes through", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: afterFirst, requestId: firstId } = await tronSwap(
      contract,
      ctx,
      VALID_TRON_SWAP,
    );
    const copied = { ...VALID_TRON_SWAP, inIndex: 3n };

    await expect(queueTronSwap(contract, afterFirst, copied)).rejects.toThrow(/Timestamp in use/);
    expect(ledgerOf(afterFirst).tronSwapArgsMap.member(copied.inIndex)).toBe(false);
    expect(ledgerOf(afterFirst).inputRequestBuffer.member(copied.inIndex)).toBe(false);

    const retried = {
      ...copied,
      tronTx: { ...copied.tronTx, timestamp: copied.tronTx.timestamp + 1n },
    };
    const { context: afterRetry } = await tronSwap(contract, afterFirst, retried);
    const requestIds = [...ledgerOf(afterRetry).bidirectionalTronSwapMap].map(([id]) =>
      requestIdHex(id),
    );
    expect(requestIds).toHaveLength(2);
    expect(new Set(requestIds).size).toBe(2);
    expect(requestIds).toContain(requestIdHex(firstId));
  });

  it.each([
    { name: "queued", sent: false },
    { name: "sent", sent: true },
  ])("a second party cannot start a twin of a $name Tron swap", async ({ sent }) => {
    const { contract, ctx } = await deployInitialised();
    const open = sent
      ? (await tronSwap(contract, ctx, VALID_TRON_SWAP)).context
      : (await queueTronSwap(contract, ctx, VALID_TRON_SWAP)).context;
    const twin = { ...VALID_TRON_SWAP, inIndex: 3n };
    await expect(queueTronSwap(contract, strangerOf(open), twin)).rejects.toThrow(
      /Timestamp in use/,
    );
    expect(ledgerOf(open).tronSwapArgsMap.member(twin.inIndex)).toBe(false);
  });

  it("a queued request's timestamp is refused before any flush", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueTronSwap(contract, ctx, VALID_TRON_SWAP)).context;
    await expect(
      queueTronSwap(contract, queued, { ...VALID_TRON_SWAP, inIndex: 3n }),
    ).rejects.toThrow(/Timestamp in use/);
  });

  it("an approval and a swap share the one set of timestamps", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueTronApprove(contract, ctx, VALID_TRON_APPROVE)).context;
    await expect(
      queueTronSwap(contract, queued, { ...VALID_TRON_SWAP, tronTx: VALID_TRON_TX }),
    ).rejects.toThrow(/Timestamp in use/);
  });

  it("completeTronSwap frees the timestamp for a later request", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronSwap(contract, ctx, VALID_TRON_SWAP);
    const attested = await attest(
      contract,
      sent,
      respond(
        MPC_RESPONSE_SECRET,
        requestId,
        OutputKind.failed,
        OUTPUT_EMPTY,
        TRON_ATTESTED_HEIGHT,
      ),
    );
    const settled = (
      await contract.circuits.completeTronSwap(
        attested,
        requestId,
        OUTPUT_SWAP_IGNORED,
        MINT_NONCE,
        CHANGE_NONCE,
      )
    ).context;
    expect(ledgerOf(settled).vaultTronTimestamps.isEmpty()).toBe(true);
    const again = (await queueTronSwap(contract, settled, { ...VALID_TRON_SWAP, inIndex: 3n }))
      .context;
    expect(ledgerOf(again).vaultTronTimestamps.member(VALID_TRON_SWAP.tronTx.timestamp)).toBe(true);
  });
});

describe("completeTronApprove settle", () => {
  it.each([
    { name: "an executed approve returning true", kind: OutputKind.executed, signed: OUTPUT_TRUE },
    {
      name: "an executed approve returning false",
      kind: OutputKind.executed,
      signed: OUTPUT_FALSE,
    },
    { name: "a reverted approve (failed)", kind: OutputKind.failed, signed: OUTPUT_EMPTY },
    { name: "an expired approve (unviable)", kind: OutputKind.unviable, signed: OUTPUT_EMPTY },
  ])("$name only closes the request and frees its timestamp", async ({ kind, signed }) => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronApprove(contract, ctx, VALID_TRON_APPROVE);
    const attested = await attest(
      contract,
      sent,
      respond(MPC_RESPONSE_SECRET, requestId, kind, signed, TRON_ATTESTED_HEIGHT),
    );
    const presented = kind === OutputKind.executed ? signed : OUTPUT_FALSE;
    const next = (await contract.circuits.completeTronApprove(attested, requestId, presented))
      .context;
    expect(coinsMinted(attested, next)).toEqual([]);
    const state = ledgerOf(next);
    expect(state.bidirectionalTronApproveMap.isEmpty()).toBe(true);
    expect(state.tronApproveArgsMap.isEmpty()).toBe(true);
    expect(state.vaultTronTimestamps.isEmpty()).toBe(true);
    expect(state.outputRequestBuffer.isEmpty()).toBe(true);
    expect(state.outputAttestationBuffer.isEmpty()).toBe(true);
    expect(state.evictionMap.isEmpty()).toBe(true);
  });

  it("rejects an output other than the attested one", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronApprove(contract, ctx, VALID_TRON_APPROVE);
    const attested = await attest(
      contract,
      sent,
      respond(
        MPC_RESPONSE_SECRET,
        requestId,
        OutputKind.executed,
        OUTPUT_TRUE,
        TRON_ATTESTED_HEIGHT,
      ),
    );
    await expect(
      contract.circuits.completeTronApprove(attested, requestId, OUTPUT_FALSE),
    ).rejects.toThrow(/Output does not match the attestation/);
  });

  it("rejects a caller other than the deployer who started it", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronApprove(contract, ctx, VALID_TRON_APPROVE);
    const attested = await attest(
      contract,
      sent,
      respond(
        MPC_RESPONSE_SECRET,
        requestId,
        OutputKind.executed,
        OUTPUT_TRUE,
        TRON_ATTESTED_HEIGHT,
      ),
    );
    await expect(
      contract.circuits.completeTronApprove(strangerOf(attested), requestId, OUTPUT_TRUE),
    ).rejects.toThrow(/Not the requester/);
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.completeTronApprove(ctx, bytes(32, 0x5a), OUTPUT_TRUE),
    ).rejects.toThrow(/Not initialised/);
  });
});

describe("Tron swap round-trip", () => {
  it("stores a vault-path exactOutputSingle event on the SunSwap router at the vault's fee limit", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, outIndex, requestId } = await tronSwap(contract, ctx, VALID_TRON_SWAP);
    const state = sent.callContext.currentQueryContext.state;

    const rawLedger = readSignetRequestsLedgerFromState(state, VAULT_TRON_SWAP_REQUESTS_PATH);
    expect(rawLedger.requestsIndex.size).toBe(1);
    const record = first(rawLedger.requestsIndex.values(), "raw Tron request");
    if (!isTronRequest(record)) {
      throw new Error("expected a Tron request record");
    }
    expect(requestIdHex(calculateRequestId(record))).toBe(requestIdHex(requestId));
    expect(record).toEqual(ledgerOf(sent).bidirectionalTronSwapMap.lookup(requestId));

    const notification = first(
      decodeSignetLogEvents(sent.events, SIGNET_ADDRESS),
      "signet notification event",
    );
    const post = decodeSignBidirectionalEventNotificationPayload(notification.payload);
    expect(requestIdHex(post.requestId)).toBe(requestIdHex(requestId));
    expect(decodeSignBidirectionalNotification(post.event)).toEqual({
      version: 1,
      callerAddress: bytesToHex(hexToBytes(VAULT_ADDRESS)),
      requestsPath: [...VAULT_TRON_SWAP_REQUESTS_PATH],
    });

    expect(record.txParamType).toBe(TxParamType.tron);
    expect(record.path).toEqual(asciiPadded("vault", 32));
    expect(record.keyVersion).toBe(MPC_KEY_VERSION);
    expect(record.algo).toBe(MPCSignatureAlgorithm.ecdsa);
    expect(record.signatureDest).toBe(MPCDestination.unused);
    expect(record.executionDest).toEqual(signetCircuits.tronCaip2Id());
    expect(record.outputDeserializationSchema).toEqual(SWAP_OUTPUT_SCHEMA);
    expect(record.respondSerializationSchema).toEqual(new Uint8Array(0));
    expect(record.txParams).toEqual({
      ...SIGNED_TRON_TX,
      timestamp: VALID_TRON_SWAP.tronTx.timestamp,
      feeLimit: DEFAULT_TRON_FEE_LIMITS.swap,
      contractAddress: Uint8Array.of(0x41, ...SUNSWAP_ROUTER),
      callValue: 0n,
      calldata: {
        is_some: true,
        value: {
          selector: SUNSWAP_EXACT_OUTPUT_SINGLE_SELECTOR,
          noWords: 8n,
          words: [
            evmAddressAbiWord(TRC20),
            evmAddressAbiWord(TRC20_OUT),
            numericAbiWord(SWAP_FEE),
            evmAddressAbiWord(VAULT_EVM),
            numericAbiWord(INT64_MAX),
            numericAbiWord(SWAP_AMOUNT_OUT),
            numericAbiWord(SWAP_AMOUNT_IN_MAX),
            numericAbiWord(0n),
          ],
        },
      },
    });

    const { entry, lastSeen } = ledgerOf(sent).outputRequestBuffer.lookup(outIndex);
    expect(entry).toEqual({
      action: Action.tronSwap,
      chain: Chain.tron,
      useNextVaultAccountNonce: false,
      evmNonce: 0n,
      inIndex: VALID_TRON_SWAP.inIndex,
      commitment: pureCircuits.ownershipCommitment(VALID_TRON_SWAP.inIndex, SECRET_KEY),
      argsHash: expect.any(Uint8Array) as Uint8Array,
    });
    expect(lastSeen).toBe(TRON_START_HEIGHT);
    expect(ledgerOf(sent).tronSwapArgsMap.lookup(VALID_TRON_SWAP.inIndex)).toEqual({
      request: VALID_TRON_SWAP.swap,
      tx: {
        ...SIGNED_TRON_TX,
        timestamp: VALID_TRON_SWAP.tronTx.timestamp,
        feeLimit: DEFAULT_TRON_FEE_LIMITS.swap,
      },
      fee: TRON_TOKEN_FEES.swap,
    });
    expect(ledgerOf(sent).evictionMap.lookup(requestId)).toEqual(outIndex);
    expect(ledgerOf(sent).inputRequestBuffer.isEmpty()).toBe(true);
    expect(ledgerOf(sent).vaultAccountNonce).toBe(0n);
  });

  it("start burns the surrendered coin, principal plus fee, and mints the fee in the Tron token's colour", async () => {
    const { contract, ctx } = await deployInitialised();
    const started = (await queueTronSwap(contract, ctx, VALID_TRON_SWAP)).context;
    const outputs = coinsMinted(ctx, started);

    expect(outputs).toHaveLength(3);
    const burn = first(
      outputs.filter(
        (output) => output.recipient.is_left && output.recipient.left.bytes.every((b) => b === 0),
      ),
      "burn output",
    );
    expect(burn.coinInfo.color).toEqual(TRON_TOKEN_COLOR);
    expect(burn.coinInfo.value).toBe(SWAP_AMOUNT_IN_MAX + TRON_TOKEN_FEES.swap);
    const fee = first(
      outputs.filter(
        (output) =>
          output.recipient.is_left &&
          bytesToHex(output.recipient.left.bytes) === bytesToHex(FEE_RECIPIENT_CPK),
      ),
      "fee output",
    );
    expect(fee.coinInfo).toEqual({
      nonce: pureCircuits.feeMintNonce(VALID_TRON_SWAP.coin.nonce),
      color: TRON_TOKEN_COLOR,
      value: TRON_TOKEN_FEES.swap,
    });
  });

  it("sendTronSwap is permissionless and refuses a second send", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueTronSwap(contract, ctx, VALID_TRON_SWAP)).context;
    const outIndex = queuedRequestIndex(ledgerOf(queued), VALID_TRON_SWAP.inIndex);
    const flushed = await flush(contract, queued, [VALID_TRON_SWAP.inIndex], []);
    const sent = (await contract.circuits.sendTronSwap(strangerOf(flushed), outIndex)).context;
    expect(ledgerOf(sent).bidirectionalTronSwapMap.size()).toBe(1n);
    await expect(contract.circuits.sendTronSwap(sent, outIndex)).rejects.toThrow(
      /Request already sent/,
    );
  });

  it("sendTronSwap refuses an index the flush has not moved", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueTronSwap(contract, ctx, VALID_TRON_SWAP)).context;
    const outIndex = queuedRequestIndex(ledgerOf(queued), VALID_TRON_SWAP.inIndex);
    await expect(contract.circuits.sendTronSwap(queued, outIndex)).rejects.toThrow(
      /Request not flushed/,
    );
  });
});

interface TronSwapRejectionCase {
  name: string;
  args: TronSwapCallArgs;
  throws: RegExp;
}

const TRON_SWAP_REJECTION_CASES: TronSwapRejectionCase[] = [
  {
    name: "an input TRC-20 the vault does not allow",
    args: { ...VALID_TRON_SWAP, swap: { ...VALID_TRON_SWAP.swap, tokenAddressIn: UNLISTED_TRC20 } },
    throws: /TRC-20 not allowed/,
  },
  {
    name: "an output TRC-20 the vault does not allow",
    args: {
      ...VALID_TRON_SWAP,
      swap: { ...VALID_TRON_SWAP.swap, tokenAddressOut: UNLISTED_TRC20 },
    },
    throws: /TRC-20 not allowed/,
  },
  {
    name: "a zero output TRC-20 address",
    args: { ...VALID_TRON_SWAP, swap: { ...VALID_TRON_SWAP.swap, tokenAddressOut: ZERO_ADDRESS } },
    throws: /TRC-20 not allowed/,
  },
  {
    name: "a zero amountOut",
    args: { ...VALID_TRON_SWAP, swap: { ...VALID_TRON_SWAP.swap, amountOut: 0n } },
    throws: /amountOut must be positive/,
  },
  {
    name: "a zero amountInMaximum",
    args: {
      ...VALID_TRON_SWAP,
      swap: { ...VALID_TRON_SWAP.swap, amountInMaximum: 0n },
      coin: tronCoin(TRON_TOKEN_FEES.swap),
    },
    throws: /amountInMaximum must be positive/,
  },
  {
    name: "an amountOut above Uint<64> max (unmintable)",
    args: { ...VALID_TRON_SWAP, swap: { ...VALID_TRON_SWAP.swap, amountOut: UINT64_MAX + 1n } },
    throws: /amountOut exceeds Uint<64> max/,
  },
  {
    name: "an amountInMaximum above Uint<64> max (unrefundable)",
    args: {
      ...VALID_TRON_SWAP,
      swap: { ...VALID_TRON_SWAP.swap, amountInMaximum: UINT64_MAX + 1n },
      coin: tronCoin(UINT64_MAX + 1n),
    },
    throws: /amountInMaximum exceeds Uint<64> max/,
  },
  {
    name: "a coin of the output TRC-20's vault token",
    args: {
      ...VALID_TRON_SWAP,
      coin: tronCoin(SWAP_AMOUNT_IN_MAX + TRON_TOKEN_FEES.swap, TRON_TOKEN_COLOR_OUT),
    },
    throws: /Coin is not the vault token for tokenAddressIn/,
  },
  {
    name: "a coin worth amountInMaximum without the fee",
    args: { ...VALID_TRON_SWAP, coin: tronCoin(SWAP_AMOUNT_IN_MAX) },
    throws: /Coin value must equal amountInMaximum plus fee/,
  },
  {
    name: "an expiration equal to the timestamp",
    args: {
      ...VALID_TRON_SWAP,
      tronTx: { ...VALID_TRON_SWAP.tronTx, timestamp: EXPIRATION_SECONDS * 1000n },
    },
    throws: /Tron expiration must follow its timestamp/,
  },
  {
    name: "an expiration above int64",
    args: {
      ...VALID_TRON_SWAP,
      tronTx: { ...VALID_TRON_SWAP.tronTx, expiration: INT64_MAX + 1n },
    },
    throws: /Tron expiration exceeds int64/,
  },
  {
    name: "an expiration already past the block time",
    args: {
      ...VALID_TRON_SWAP,
      tronTx: {
        ...VALID_TRON_SWAP.tronTx,
        timestamp: 1_699_999_000_000n,
        expiration: (BigInt(NOW_SECONDS) - 1n) * 1000n,
      },
    },
    throws: /Tron expiration too close to the block time/,
  },
  {
    name: "an expiration within the margin of the block time",
    args: {
      ...VALID_TRON_SWAP,
      tronTx: {
        ...VALID_TRON_SWAP.tronTx,
        expiration: (BigInt(NOW_SECONDS) + START_MIN_REMAINING_SECONDS) * 1000n,
      },
    },
    throws: /Tron expiration too close to the block time/,
  },
  {
    name: "an expiration more than 24 hours less the margin ahead of the block time",
    args: {
      ...VALID_TRON_SWAP,
      tronTx: {
        ...VALID_TRON_SWAP.tronTx,
        expiration:
          (BigInt(NOW_SECONDS) + MAX_EXPIRATION_SPAN_SECONDS - CAP_MARGIN_SECONDS) * 1000n,
      },
    },
    throws: /Tron expiration too far past the block time/,
  },
];

describe("Tron swap validation", () => {
  it.each(TRON_SWAP_REJECTION_CASES)("rejects $name", async ({ args, throws }) => {
    const { contract, ctx } = await deployInitialised();
    await expect(queueTronSwap(contract, ctx, args)).rejects.toThrow(throws);
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(queueTronSwap(contract, ctx, VALID_TRON_SWAP)).rejects.toThrow(/Not initialised/);
  });

  it("rejects while the SunSwap router is the zero address", async () => {
    const { contract, ctx } = await deployInitialisedWith(ZERO_ADDRESS);
    await expect(queueTronSwap(contract, ctx, VALID_TRON_SWAP)).rejects.toThrow(
      /SunSwap router not set/,
    );
  });

  it("rejects an index the flush freed while its args stay in tronSwapArgsMap", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueTronSwap(contract, ctx, VALID_TRON_SWAP)).context;
    const flushed = await flush(contract, queued, [VALID_TRON_SWAP.inIndex], []);
    await expect(
      queueTronSwap(contract, flushed, {
        ...VALID_TRON_SWAP,
        tronTx: { ...VALID_TRON_SWAP.tronTx, timestamp: VALID_TRON_SWAP.tronTx.timestamp + 5n },
      }),
    ).rejects.toThrow(/Index already in use/);
  });
});

interface TronSwapVerdictCase {
  name: string;
  outputKind: OutputKind;
  signedOutput: Uint8Array;
  presentedOutput: Uint8Array;
  mints: [string, bigint][];
  coins: ReturnType<typeof coinsMinted>;
}

const TRON_SWAP_VERDICT_CASES: TronSwapVerdictCase[] = [
  {
    name: "an executed swap mints amountOut of the bought token and the unspent change",
    outputKind: OutputKind.executed,
    signedOutput: OUTPUT_SWAP,
    presentedOutput: OUTPUT_SWAP,
    mints: [
      [TRON_TOKEN_OUT_MINT_KEY, SWAP_AMOUNT_OUT],
      [TRON_TOKEN_MINT_KEY, SWAP_AMOUNT_IN_MAX - SWAP_AMOUNT_IN_SPENT],
    ],
    coins: [
      {
        coinInfo: { nonce: MINT_NONCE, color: TRON_TOKEN_COLOR_OUT, value: SWAP_AMOUNT_OUT },
        recipient: TO_CALLER,
      },
      {
        coinInfo: {
          nonce: CHANGE_NONCE,
          color: TRON_TOKEN_COLOR,
          value: SWAP_AMOUNT_IN_MAX - SWAP_AMOUNT_IN_SPENT,
        },
        recipient: TO_CALLER,
      },
    ],
  },
  {
    name: "an exact spend mints amountOut and a zero-value change coin",
    outputKind: OutputKind.executed,
    signedOutput: swapOutput(SWAP_AMOUNT_IN_MAX),
    presentedOutput: swapOutput(SWAP_AMOUNT_IN_MAX),
    mints: [[TRON_TOKEN_OUT_MINT_KEY, SWAP_AMOUNT_OUT]],
    coins: [
      {
        coinInfo: { nonce: MINT_NONCE, color: TRON_TOKEN_COLOR_OUT, value: SWAP_AMOUNT_OUT },
        recipient: TO_CALLER,
      },
      {
        coinInfo: { nonce: CHANGE_NONCE, color: TRON_TOKEN_COLOR, value: 0n },
        recipient: TO_CALLER,
      },
    ],
  },
  {
    name: "a reverted swap (failed) re-mints the surrendered amountInMaximum",
    outputKind: OutputKind.failed,
    signedOutput: OUTPUT_EMPTY,
    presentedOutput: OUTPUT_SWAP_IGNORED,
    mints: [[TRON_TOKEN_MINT_KEY, SWAP_AMOUNT_IN_MAX]],
    coins: [
      {
        coinInfo: { nonce: MINT_NONCE, color: TRON_TOKEN_COLOR, value: SWAP_AMOUNT_IN_MAX },
        recipient: TO_CALLER,
      },
    ],
  },
  {
    name: "an expired swap (unviable) re-mints the surrendered amountInMaximum",
    outputKind: OutputKind.unviable,
    signedOutput: OUTPUT_EMPTY,
    presentedOutput: OUTPUT_SWAP_IGNORED,
    mints: [[TRON_TOKEN_MINT_KEY, SWAP_AMOUNT_IN_MAX]],
    coins: [
      {
        coinInfo: { nonce: MINT_NONCE, color: TRON_TOKEN_COLOR, value: SWAP_AMOUNT_IN_MAX },
        recipient: TO_CALLER,
      },
    ],
  },
];

describe("completeTronSwap settle", () => {
  it.each(TRON_SWAP_VERDICT_CASES)(
    "$name and consumes the request",
    async ({ outputKind, signedOutput, presentedOutput, mints, coins }) => {
      const { contract, ctx } = await deployInitialised();
      const { context: sent, requestId } = await tronSwap(contract, ctx, VALID_TRON_SWAP);
      const attested = await attest(
        contract,
        sent,
        respond(MPC_RESPONSE_SECRET, requestId, outputKind, signedOutput, TRON_ATTESTED_HEIGHT),
      );

      const next = (
        await contract.circuits.completeTronSwap(
          attested,
          requestId,
          presentedOutput,
          MINT_NONCE,
          CHANGE_NONCE,
        )
      ).context;

      expect(new Map(shieldedMintsSince(attested, next))).toEqual(new Map(mints));
      expect(coinsMinted(attested, next)).toEqual(coins);
      const state = ledgerOf(next);
      expect(state.bidirectionalTronSwapMap.isEmpty()).toBe(true);
      expect(state.tronSwapArgsMap.isEmpty()).toBe(true);
      expect(state.vaultTronTimestamps.isEmpty()).toBe(true);
      expect(state.outputRequestBuffer.isEmpty()).toBe(true);
      expect(state.outputAttestationBuffer.isEmpty()).toBe(true);
      expect(state.evictionMap.isEmpty()).toBe(true);
      expect(state.tronLastSeen).toBe(TRON_ATTESTED_HEIGHT);
      expect(state.globalLastSeen).toBe(EVM_START_HEIGHT);
    },
  );

  it.each(TRON_SWAP_VERDICT_CASES)(
    "rejects a caller other than the swapper when $name",
    async ({ outputKind, signedOutput, presentedOutput }) => {
      const { contract, ctx } = await deployInitialised();
      const { context: sent, requestId } = await tronSwap(contract, ctx, VALID_TRON_SWAP);
      const attested = await attest(
        contract,
        sent,
        respond(MPC_RESPONSE_SECRET, requestId, outputKind, signedOutput, TRON_ATTESTED_HEIGHT),
      );
      await expect(
        contract.circuits.completeTronSwap(
          strangerOf(attested),
          requestId,
          presentedOutput,
          MINT_NONCE,
          CHANGE_NONCE,
        ),
      ).rejects.toThrow(/Not the requester/);
    },
  );

  it("rejects an amountIn other than the attested one", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronSwap(contract, ctx, VALID_TRON_SWAP);
    const attested = await attest(
      contract,
      sent,
      respond(
        MPC_RESPONSE_SECRET,
        requestId,
        OutputKind.executed,
        OUTPUT_SWAP,
        TRON_ATTESTED_HEIGHT,
      ),
    );
    await expect(
      contract.circuits.completeTronSwap(
        attested,
        requestId,
        swapOutput(1n),
        MINT_NONCE,
        CHANGE_NONCE,
      ),
    ).rejects.toThrow(/Output does not match the attestation/);
  });

  it("rejects a changeNonce equal to mintNonce on an executed swap", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronSwap(contract, ctx, VALID_TRON_SWAP);
    const attested = await attest(
      contract,
      sent,
      respond(
        MPC_RESPONSE_SECRET,
        requestId,
        OutputKind.executed,
        OUTPUT_SWAP,
        TRON_ATTESTED_HEIGHT,
      ),
    );
    await expect(
      contract.circuits.completeTronSwap(attested, requestId, OUTPUT_SWAP, MINT_NONCE, MINT_NONCE),
    ).rejects.toThrow(/changeNonce must differ from mintNonce/);
  });

  it("queueAttestation refuses an attestation at or below the swap's Tron lastSeen", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronSwap(contract, ctx, VALID_TRON_SWAP);
    await expect(
      contract.circuits.queueAttestation(
        sent,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SWAP,
          TRON_START_HEIGHT,
        ),
      ),
    ).rejects.toThrow(/Stale attestation/);
  });

  it("settles once: a second completeTronSwap for the same request rejects", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronSwap(contract, ctx, VALID_TRON_SWAP);
    const attested = await attest(
      contract,
      sent,
      respond(
        MPC_RESPONSE_SECRET,
        requestId,
        OutputKind.failed,
        OUTPUT_EMPTY,
        TRON_ATTESTED_HEIGHT,
      ),
    );
    const next = (
      await contract.circuits.completeTronSwap(
        attested,
        requestId,
        OUTPUT_SWAP_IGNORED,
        MINT_NONCE,
        CHANGE_NONCE,
      )
    ).context;
    await expect(
      contract.circuits.completeTronSwap(
        next,
        requestId,
        OUTPUT_SWAP_IGNORED,
        MINT_NONCE,
        CHANGE_NONCE,
      ),
    ).rejects.toThrow(/Request not sent/);
  });

  it("completeTronSwap rejects a Tron approve's request id, and completeTronApprove a Tron swap's", async () => {
    const { contract, ctx } = await deployInitialised();
    const approved = await tronApprove(contract, ctx, VALID_TRON_APPROVE);
    const swapped = await tronSwap(contract, approved.context, VALID_TRON_SWAP);
    const approveQueued = (
      await contract.circuits.queueAttestation(
        swapped.context,
        respond(
          MPC_RESPONSE_SECRET,
          approved.requestId,
          OutputKind.executed,
          OUTPUT_TRUE,
          TRON_ATTESTED_HEIGHT,
        ),
      )
    ).context;
    const bothQueued = (
      await contract.circuits.queueAttestation(
        approveQueued,
        respond(
          MPC_RESPONSE_SECRET,
          swapped.requestId,
          OutputKind.executed,
          OUTPUT_SWAP,
          TRON_ATTESTED_HEIGHT,
        ),
      )
    ).context;
    const attested = await flush(contract, bothQueued, [], [approved.requestId, swapped.requestId]);

    await expect(
      contract.circuits.completeTronSwap(
        attested,
        approved.requestId,
        OUTPUT_SWAP,
        MINT_NONCE,
        CHANGE_NONCE,
      ),
    ).rejects.toThrow(/Wrong action/);
    await expect(
      contract.circuits.completeTronApprove(attested, swapped.requestId, OUTPUT_TRUE),
    ).rejects.toThrow(/Wrong action/);
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.completeTronSwap(
        ctx,
        bytes(32, 0x5a),
        OUTPUT_SWAP_IGNORED,
        MINT_NONCE,
        CHANGE_NONCE,
      ),
    ).rejects.toThrow(/Not initialised/);
  });
});

describe("send checks the expiration against the block time", () => {
  it.each([
    { name: "at the margin before the expiration", time: SEND_CLOSES_SECONDS },
    { name: "after the expiration", time: Number(EXPIRATION_SECONDS) + 1 },
  ])("sendTronSwap refuses a request $name", async ({ time }) => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueTronSwap(contract, ctx, VALID_TRON_SWAP)).context;
    const outIndex = queuedRequestIndex(ledgerOf(queued), VALID_TRON_SWAP.inIndex);
    const flushed = atTime(await flush(contract, queued, [VALID_TRON_SWAP.inIndex], []), time);
    await expect(contract.circuits.sendTronSwap(flushed, outIndex)).rejects.toThrow(
      /Tron expiration too close to the block time/,
    );
  });

  it("sendTronSwap sends a request one second before the margin", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueTronSwap(contract, ctx, VALID_TRON_SWAP)).context;
    const outIndex = queuedRequestIndex(ledgerOf(queued), VALID_TRON_SWAP.inIndex);
    const flushed = atTime(
      await flush(contract, queued, [VALID_TRON_SWAP.inIndex], []),
      SEND_CLOSES_SECONDS - 1,
    );
    const sent = (await contract.circuits.sendTronSwap(flushed, outIndex)).context;
    expect(ledgerOf(sent).bidirectionalTronSwapMap.size()).toBe(1n);
  });

  it("sendTronSwap refuses an expiration the block time has not come within 24 hours of", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueTronSwap(contract, ctx, VALID_TRON_SWAP)).context;
    const outIndex = queuedRequestIndex(ledgerOf(queued), VALID_TRON_SWAP.inIndex);
    const flushed = atTime(
      await flush(contract, queued, [VALID_TRON_SWAP.inIndex], []),
      Number(EXPIRATION_SECONDS - MAX_EXPIRATION_SPAN_SECONDS),
    );
    await expect(contract.circuits.sendTronSwap(flushed, outIndex)).rejects.toThrow(
      /Tron expiration too far past the block time/,
    );
  });

  it("sendTronApprove refuses a request at the margin before its expiration", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueTronApprove(contract, ctx, VALID_TRON_APPROVE)).context;
    const outIndex = queuedRequestIndex(ledgerOf(queued), VALID_TRON_APPROVE.inIndex);
    const flushed = atTime(
      await flush(contract, queued, [VALID_TRON_APPROVE.inIndex], []),
      SEND_CLOSES_SECONDS,
    );
    await expect(contract.circuits.sendTronApprove(flushed, outIndex)).rejects.toThrow(
      /Tron expiration too close to the block time/,
    );
  });
});

const REFUND_COINS = [
  {
    coinInfo: { nonce: MINT_NONCE, color: TRON_TOKEN_COLOR, value: SWAP_AMOUNT_IN_MAX },
    recipient: TO_CALLER,
  },
];

describe("refundUnsentTronSwap", () => {
  it("re-mints amountInMaximum for a queued swap once send has closed, and keeps the fee", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = atTime(
      (await queueTronSwap(contract, ctx, VALID_TRON_SWAP)).context,
      SEND_CLOSES_SECONDS,
    );
    const refunded = (
      await contract.circuits.refundUnsentTronSwap(queued, VALID_TRON_SWAP.inIndex, MINT_NONCE)
    ).context;

    expect(shieldedMintsSince(queued, refunded)).toEqual([
      [TRON_TOKEN_MINT_KEY, SWAP_AMOUNT_IN_MAX],
    ]);
    expect(coinsMinted(queued, refunded)).toEqual(REFUND_COINS);
    const state = ledgerOf(refunded);
    expect(state.inputRequestBuffer.isEmpty()).toBe(true);
    expect(state.tronSwapArgsMap.isEmpty()).toBe(true);
    expect(state.vaultTronTimestamps.isEmpty()).toBe(true);
    await expect(flush(contract, refunded, [VALID_TRON_SWAP.inIndex], [])).rejects.toThrow(
      /Request not queued/,
    );
  });

  it("re-mints amountInMaximum for a flushed, unsent swap, which can then never be sent", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueTronSwap(contract, ctx, VALID_TRON_SWAP)).context;
    const outIndex = queuedRequestIndex(ledgerOf(queued), VALID_TRON_SWAP.inIndex);
    const flushed = atTime(
      await flush(contract, queued, [VALID_TRON_SWAP.inIndex], []),
      SEND_CLOSES_SECONDS,
    );
    const refunded = (
      await contract.circuits.refundUnsentTronSwap(flushed, VALID_TRON_SWAP.inIndex, MINT_NONCE)
    ).context;

    expect(coinsMinted(flushed, refunded)).toEqual(REFUND_COINS);
    const state = ledgerOf(refunded);
    expect(state.outputRequestBuffer.isEmpty()).toBe(true);
    expect(state.tronSwapArgsMap.isEmpty()).toBe(true);
    expect(state.vaultTronTimestamps.isEmpty()).toBe(true);
    await expect(
      contract.circuits.sendTronSwap(atTime(refunded, NOW_SECONDS), outIndex),
    ).rejects.toThrow(/Request not flushed/);
  });

  it("refuses a sent swap, whatever the block time", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent } = await tronSwap(contract, ctx, VALID_TRON_SWAP);
    await expect(
      contract.circuits.refundUnsentTronSwap(
        atTime(sent, Number(EXPIRATION_SECONDS) + 1),
        VALID_TRON_SWAP.inIndex,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Request already sent/);
  });

  it.each([
    { name: "a queued swap", flushed: false },
    { name: "a flushed swap", flushed: true },
  ])("refuses $name while it can still be sent", async ({ flushed }) => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueTronSwap(contract, ctx, VALID_TRON_SWAP)).context;
    const open = flushed ? await flush(contract, queued, [VALID_TRON_SWAP.inIndex], []) : queued;
    await expect(
      contract.circuits.refundUnsentTronSwap(
        atTime(open, SEND_CLOSES_SECONDS - 1),
        VALID_TRON_SWAP.inIndex,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Tron swap can still be sent/);
  });

  it.each([
    { name: "a queued swap", flushed: false },
    { name: "a flushed swap", flushed: true },
  ])("refuses a caller other than the swapper for $name", async ({ flushed }) => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueTronSwap(contract, ctx, VALID_TRON_SWAP)).context;
    const open = flushed ? await flush(contract, queued, [VALID_TRON_SWAP.inIndex], []) : queued;
    await expect(
      contract.circuits.refundUnsentTronSwap(
        strangerOf(open, SEND_CLOSES_SECONDS),
        VALID_TRON_SWAP.inIndex,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Not the requester/);
  });

  it("refunds once: a second refund finds no request", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = atTime(
      (await queueTronSwap(contract, ctx, VALID_TRON_SWAP)).context,
      SEND_CLOSES_SECONDS,
    );
    const refunded = (
      await contract.circuits.refundUnsentTronSwap(queued, VALID_TRON_SWAP.inIndex, MINT_NONCE)
    ).context;
    await expect(
      contract.circuits.refundUnsentTronSwap(refunded, VALID_TRON_SWAP.inIndex, MINT_NONCE),
    ).rejects.toThrow(/Tron swap not open/);
  });

  it("refuses an index no Tron swap holds", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueTronApprove(contract, ctx, VALID_TRON_APPROVE)).context;
    await expect(
      contract.circuits.refundUnsentTronSwap(
        atTime(queued, SEND_CLOSES_SECONDS),
        VALID_TRON_APPROVE.inIndex,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Tron swap not open/);
  });

  it("frees the timestamp for a later request", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = atTime(
      (await queueTronSwap(contract, ctx, VALID_TRON_SWAP)).context,
      SEND_CLOSES_SECONDS,
    );
    const refunded = (
      await contract.circuits.refundUnsentTronSwap(queued, VALID_TRON_SWAP.inIndex, MINT_NONCE)
    ).context;
    const again = (
      await queueTronSwap(contract, atTime(refunded, NOW_SECONDS), {
        ...VALID_TRON_SWAP,
        inIndex: 3n,
      })
    ).context;
    expect(ledgerOf(again).tronSwapArgsMap.member(3n)).toBe(true);
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.refundUnsentTronSwap(ctx, VALID_TRON_SWAP.inIndex, MINT_NONCE),
    ).rejects.toThrow(/Not initialised/);
  });
});

describe("startReplaceNonce", () => {
  it.each([
    { name: "a Tron approve", action: Action.tronApprove },
    { name: "a Tron swap", action: Action.tronSwap },
  ])("refuses $name: it holds no vault nonce", async ({ action }) => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronSwap(contract, ctx, VALID_TRON_SWAP);
    await expect(contract.circuits.startReplaceNonce(sent, 77n, requestId, action)).rejects.toThrow(
      /Tron request has no vault nonce/,
    );
  });
});

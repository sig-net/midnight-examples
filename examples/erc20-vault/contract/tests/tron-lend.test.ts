import { readFileSync } from "node:fs";

import {
  type CircuitContext,
  createCircuitContext,
  createConstructorContext,
  type EncodedShieldedCoinInfo,
  type EncodedZswapLocalState,
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
  flushedRequestIndex,
  flushSlots,
  ledger,
  pureCircuits,
  queuedRequestIndex,
  type TokenFees,
  type TronTxWindow,
  VAULT_TRON_APPROVE_REQUESTS_PATH,
  VAULT_TRON_REDEEM_REQUESTS_PATH,
  VAULT_TRON_SUPPLY_REQUESTS_PATH,
  type VaultPrivateState,
  type VaultTronFeeLimits,
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
const EVM_ATTESTED_HEIGHT = 101n;
const TRON_START_HEIGHT = 5_000n;
const TRON_ATTESTED_HEIGHT = 5_001n;

const SIGNET_ADDRESS = sampleContractAddress();
const BLOCK_HASH = "0".repeat(64);
const VAULT_ADDRESS = sampleContractAddress();
const VAULT_ADDRESS_BYTES = hexToBytes(VAULT_ADDRESS);

const VAULT_EVM = bytes(20, 0xee);
const ROUTER = bytes(20, 0x11);
const STATA_UNDERLYING = bytes(20, 0xdd);
const STATA_TOKEN = bytes(20, 0xcc);
const CHAIN_ID = 11155111n;
const NO_FEES: TokenFees = { withdraw: 0n, swap: 0n, supply: 0n, redeem: 0n };
const FEE_RECIPIENT_CPK = bytes(32, 0xfe);
const ZERO_ADDRESS = new Uint8Array(20);
const UNLISTED_TRC20 = bytes(20, 0x99);
const DEST_TRON = bytes(20, 0x77);

// The underlyings: Tron USDT (6 decimals, unshifted) and a 9-decimal token listed at 10^3,
// both 6-decimal coins. The share token is an 18-decimal ERC-4626 listed at 10^12.
const TRON_USDT = bytes(20, 0x75);
const NANO_UNDERLYING = bytes(20, 0x93);
const SHARE_TOKEN = bytes(20, 0x5a);
const UNSHIFTED = 1n;
const NANO_FACTOR = 10n ** 3n;
const SHARE_FACTOR = 10n ** 12n;
const USDT_FEES: TokenFees = { withdraw: 71n, swap: 73n, supply: 79n, redeem: 83n };
const NANO_FEES: TokenFees = { withdraw: 13n, swap: 17n, supply: 19n, redeem: 23n };
const SHARE_FEES: TokenFees = { withdraw: 3n, swap: 5n, supply: 7n, redeem: 11n };

const MIN_SUPPLY = 1_000_000n;
const UINT64_MAX = 18446744073709551615n;
const INT64_MAX = 9223372036854775807n;
const MINT_NONCE = bytes(32, 0x2e);

const DEFAULT_TRON_FEE_LIMITS: VaultTronFeeLimits = {
  withdraw: 100_000_000n,
  approve: 50_000_000n,
  supply: 150_000_000n,
  redeem: 150_000_000n,
};
// Every action's fee limit distinct, so a start reading another action's limit shows.
const DISTINCT_TRON_FEE_LIMITS: VaultTronFeeLimits = {
  withdraw: 42_000_000n,
  approve: 43_000_000n,
  supply: 44_000_000n,
  redeem: 45_000_000n,
};

// Every context runs in a block at NOW unless a test moves it (see `atBlockTime`).
const NOW = 1_800_000_000;
// The start leaves tronStartMinRemainingSeconds() for the flush and the send, the send
// tronSendMinRemainingSeconds(), and both stay tronCapMarginSeconds() inside the MPC's
// 24 h cap.
const START_MIN_REMAINING = 600;
const SEND_MIN_REMAINING = 60;
const CAP_MARGIN = 60;
const DAY = 86_400;

const ms = (seconds: number, millis = 0): bigint => BigInt(seconds) * 1000n + BigInt(millis);

const colourOf = (domainSeparator: Uint8Array): Uint8Array =>
  hexToBytes(rawTokenType(domainSeparator, VAULT_ADDRESS));
const USDT_COLOR = colourOf(pureCircuits.vaultTronTokenDomainSeparator(TRON_USDT));
const NANO_COLOR = colourOf(pureCircuits.tronCoinColour(NANO_UNDERLYING, NANO_FACTOR));
const SHARE_COLOR = colourOf(pureCircuits.tronCoinColour(SHARE_TOKEN, SHARE_FACTOR));
const SHARE_MINT_KEY = bytesToHex(pureCircuits.tronCoinColour(SHARE_TOKEN, SHARE_FACTOR));
const USDT_MINT_KEY = bytesToHex(pureCircuits.vaultTronTokenDomainSeparator(TRON_USDT));

const vaultCoin = (value: bigint, color: Uint8Array): EncodedShieldedCoinInfo => ({
  nonce: bytes(32, 0x0c),
  color,
  value,
});

/** An hour-long window opened five seconds before the block. */
const TRON_WINDOW: TronTxWindow = {
  refBlockBytes: Uint8Array.of(0x12, 0x34),
  refBlockHash: bytes(8, 0x56),
  timestamp: ms(NOW - 5),
  expiration: ms(NOW + 3600, 250),
};

/** The underlying a lend pair pairs with SHARE_TOKEN, as `deployPaired` lists it. */
interface LendPair {
  underlying: Uint8Array;
  factor: bigint;
  fees: TokenFees;
  colour: Uint8Array;
}

const USDT_PAIR: LendPair = {
  underlying: TRON_USDT,
  factor: UNSHIFTED,
  fees: USDT_FEES,
  colour: USDT_COLOR,
};
const NANO_PAIR: LendPair = {
  underlying: NANO_UNDERLYING,
  factor: NANO_FACTOR,
  fees: NANO_FEES,
  colour: NANO_COLOR,
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

const contextOf = (state: unknown, secretKey: Uint8Array, time: number): VaultContext =>
  createCircuitContext({
    circuitId: "startTronSupply",
    contractAddress: VAULT_ADDRESS,
    coinPublicKeyOrZswapState: CPK,
    contractState: state as never,
    privateState: createVaultPrivateState(secretKey),
    parentBlockHash: BLOCK_HASH,
    crossContract: signetCrossContract,
    time,
  });

/** The vault's state in a new transaction, run by `secretKey` in a block at `time`. */
const atBlockTime = (ctx: VaultContext, time: number, secretKey = SECRET_KEY): VaultContext =>
  contextOf(ctx.callContext.currentQueryContext.state, secretKey, time);

const stranger = (ctx: VaultContext): VaultContext => atBlockTime(ctx, NOW, OTHER_SECRET_KEY);

const ledgerOf = (ctx: VaultContext) => ledger(ctx.callContext.currentQueryContext.state);

const deployUninitialised = async () => {
  const contract = new Contract<VaultPrivateState>(witnesses);
  const { currentContractState } = await contract.initialState(
    createConstructorContext<VaultPrivateState>(createVaultPrivateState(SECRET_KEY), CPK),
    DEPLOYER_COMMITMENT,
    { bytes: hexToBytes(SIGNET_ADDRESS) },
  );
  return { contract, ctx: contextOf(currentContractState, SECRET_KEY, NOW) };
};

/** Deploy and initialise, listing both underlyings and the share token; no pair yet. */
const deployInitialised = async () => {
  const { contract, ctx } = await deployUninitialised();
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
      TRON_USDT,
      NO_FEES,
      NO_FEES,
      { bytes: FEE_RECIPIENT_CPK },
      bytes(32, 0xef),
    )
  ).context;
  next = (await contract.circuits.addAllowedTronToken(next, TRON_USDT, USDT_FEES, UNSHIFTED))
    .context;
  next = (
    await contract.circuits.addAllowedTronToken(next, NANO_UNDERLYING, NANO_FEES, NANO_FACTOR)
  ).context;
  next = (await contract.circuits.addAllowedTronToken(next, SHARE_TOKEN, SHARE_FEES, SHARE_FACTOR))
    .context;
  return { contract, ctx: next };
};

/** {@link deployInitialised}, then pair `pair`'s underlying with SHARE_TOKEN. */
const deployPaired = async (pair: LendPair = USDT_PAIR) => {
  const { contract, ctx } = await deployInitialised();
  const paired = (
    await contract.circuits.setTronLendPair(ctx, pair.underlying, SHARE_TOKEN, MIN_SUPPLY)
  ).context;
  return { contract, ctx: paired };
};

const flush = async (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  inIndexes: readonly bigint[],
  requestIds: readonly Uint8Array[],
): Promise<VaultContext> =>
  (await contract.circuits.flushQueue(ctx, flushSlots(inIndexes, requestIds))).context;

const respond = (
  requestId: Uint8Array,
  outputKind: OutputKind,
  serializedOutput: Uint8Array,
  blockHeight: bigint,
): RespondBidirectionalEvent =>
  respondBidirectionalEventToCircuitInput(
    attestRespondBidirectional(
      { requestId, blockHeight, outputKind, serializedOutput },
      MPC_RESPONSE_SECRET,
    ),
  );

const attest = async (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  attestation: RespondBidirectionalEvent,
): Promise<VaultContext> => {
  const queued = (await contract.circuits.queueAttestation(ctx, attestation)).context;
  return flush(contract, queued, [], [attestation.requestId]);
};

const coinsMinted = (before: VaultContext, settled: VaultContext) => {
  const beforeState = before.callContext.currentZswapLocalState;
  const settledState = settled.callContext.currentZswapLocalState;
  if (!beforeState || !settledState) {
    throw new Error("expected zswap local state on the circuit context");
  }
  return settledState.outputs.slice(beforeState.outputs.length);
};

const shieldedMintsSince = (before: VaultContext, settled: VaultContext): [string, bigint][] => {
  const earlier = before.callContext.currentQueryContext.effects.shieldedMints;
  return [...settled.callContext.currentQueryContext.effects.shieldedMints.entries()]
    .map(([token, amount]): [string, bigint] => [token, amount - (earlier.get(token) ?? 0n)])
    .filter(([, amount]) => amount !== 0n);
};

const zswapOutputs = (ctx: VaultContext): EncodedZswapLocalState["outputs"] => {
  const state = ctx.callContext.currentZswapLocalState;
  if (!state) throw new Error("expected zswap local state on the circuit context");
  return state.outputs;
};

/** The burn and the fee outputs a start leaves on the zswap state. */
const burnAndFee = (ctx: VaultContext) => {
  const outputs = zswapOutputs(ctx);
  const burn = first(
    outputs.filter((o) => o.recipient.is_left && o.recipient.left.bytes.every((b) => b === 0)),
    "burn output",
  );
  const fee = first(
    outputs.filter(
      (o) =>
        o.recipient.is_left && bytesToHex(o.recipient.left.bytes) === bytesToHex(FEE_RECIPIENT_CPK),
    ),
    "fee output",
  );
  return { burn: burn.coinInfo, fee: fee.coinInfo };
};

/** The request ids an event map holds `after` a send that it did not hold `before`. */
const newIds = (
  before: Iterable<[Uint8Array, unknown]>,
  after: Iterable<[Uint8Array, unknown]>,
): Uint8Array[] => {
  const known = new Set([...before].map(([id]) => bytesToHex(id)));
  return [...after].map(([id]) => id).filter((id) => !known.has(bytesToHex(id)));
};

const OUTPUT_EMPTY = new Uint8Array(0);
const OUTPUT_TRUE = Uint8Array.of(1);
const OUTPUT_FALSE = Uint8Array.of(0);
const OUTPUT_IGNORED_BOOL = new Uint8Array(1);
const OUTPUT_IGNORED = new Uint8Array(32);

const sharesOutput = (shares: bigint): Uint8Array =>
  serializeRespondOutput(pureCircuits.supplyOutputSchema(), { shares });
const assetsOutput = (assets: bigint): Uint8Array =>
  serializeRespondOutput(pureCircuits.redeemOutputSchema(), { assets });

/** A contract whose `unitsOfBase` witness returns the floor quotient plus `offset`. */
const offsetQuotient = (offset: bigint) =>
  new Contract<VaultPrivateState>({
    ...witnesses,
    unitsOfBase: ({ privateState }, base, factor): [VaultPrivateState, bigint] => [
      privateState,
      base / factor + offset,
    ],
  });

// ---- Tron approve ----

const APPROVE_INDEX = 20n;

const startTronApprove = (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  inIndex: bigint,
  tronTx: TronTxWindow,
) => contract.circuits.startTronApprove(ctx, inIndex, tronTx);

const flushedTronApprove = async (contract: Contract<VaultPrivateState>, ctx: VaultContext) => {
  const started = (await startTronApprove(contract, ctx, APPROVE_INDEX, TRON_WINDOW)).context;
  const outIndex = queuedRequestIndex(ledgerOf(started), APPROVE_INDEX);
  return { context: await flush(contract, started, [APPROVE_INDEX], []), outIndex };
};

const sentTronApprove = async (contract: Contract<VaultPrivateState>, ctx: VaultContext) => {
  const { context: flushed, outIndex } = await flushedTronApprove(contract, ctx);
  const sent = (await contract.circuits.sendTronApprove(flushed, outIndex)).context;
  const requestId = first(
    newIds(
      ledgerOf(flushed).bidirectionalTronApproveMap,
      ledgerOf(sent).bidirectionalTronApproveMap,
    ),
    "new Tron approve request",
  );
  return { context: sent, outIndex, requestId };
};

// ---- Tron supply ----

/** A Tron supply's `startTronSupply` arguments, in circuit order. */
interface TronSupplyCallArgs {
  inIndex: bigint;
  supply: { amount: bigint };
  tronTx: TronTxWindow;
  coin: EncodedShieldedCoinInfo;
}

const SUPPLY_AMOUNT = 100_000_000n;

/** Known-good supply of 100 USDT. NEVER mutate; spread with the delta inline. */
const VALID_TRON_SUPPLY: TronSupplyCallArgs = {
  inIndex: 21n,
  supply: { amount: SUPPLY_AMOUNT },
  tronTx: TRON_WINDOW,
  coin: vaultCoin(SUPPLY_AMOUNT + USDT_FEES.supply, USDT_COLOR),
};

/** VALID_TRON_SUPPLY of the NANO_PAIR underlying. */
const VALID_NANO_SUPPLY: TronSupplyCallArgs = {
  ...VALID_TRON_SUPPLY,
  coin: vaultCoin(SUPPLY_AMOUNT + NANO_FEES.supply, NANO_COLOR),
};

// The shares a mainnet-like vault returns for 100 USDT: 99_285_280 share coin units and a
// remainder of 840_766_226_500 share base units that stays in the vault's Tron account.
const SUPPLY_SHARES = 99_285_280_840_766_226_500n;
const SUPPLY_SHARE_UNITS = 99_285_280n;

const startTronSupply = (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  args: TronSupplyCallArgs,
) => contract.circuits.startTronSupply(ctx, args.inIndex, args.supply, args.tronTx, args.coin);

const flushedTronSupply = async (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  args: TronSupplyCallArgs,
) => {
  const started = (await startTronSupply(contract, ctx, args)).context;
  const outIndex = queuedRequestIndex(ledgerOf(started), args.inIndex);
  return { context: await flush(contract, started, [args.inIndex], []), outIndex };
};

const sentTronSupply = async (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  args: TronSupplyCallArgs,
) => {
  const { context: flushed, outIndex } = await flushedTronSupply(contract, ctx, args);
  const sent = (await contract.circuits.sendTronSupply(flushed, outIndex)).context;
  const requestId = first(
    newIds(ledgerOf(flushed).bidirectionalTronSupplyMap, ledgerOf(sent).bidirectionalTronSupplyMap),
    "new Tron supply request",
  );
  return { context: sent, outIndex, requestId };
};

// ---- Tron redeem ----

/** A Tron redeem's `startTronRedeem` arguments, in circuit order. */
interface TronRedeemCallArgs {
  inIndex: bigint;
  redeem: { shares: bigint };
  tronTx: TronTxWindow;
  coin: EncodedShieldedCoinInfo;
}

/** Known-good redeem of the shares VALID_TRON_SUPPLY mints. NEVER mutate. */
const VALID_TRON_REDEEM: TronRedeemCallArgs = {
  inIndex: 22n,
  redeem: { shares: SUPPLY_SHARE_UNITS },
  tronTx: TRON_WINDOW,
  coin: vaultCoin(SUPPLY_SHARE_UNITS + SHARE_FEES.redeem, SHARE_COLOR),
};

const startTronRedeem = (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  args: TronRedeemCallArgs,
) => contract.circuits.startTronRedeem(ctx, args.inIndex, args.redeem, args.tronTx, args.coin);

const flushedTronRedeem = async (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  args: TronRedeemCallArgs,
) => {
  const started = (await startTronRedeem(contract, ctx, args)).context;
  const outIndex = queuedRequestIndex(ledgerOf(started), args.inIndex);
  return { context: await flush(contract, started, [args.inIndex], []), outIndex };
};

const sentTronRedeem = async (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  args: TronRedeemCallArgs,
) => {
  const { context: flushed, outIndex } = await flushedTronRedeem(contract, ctx, args);
  const sent = (await contract.circuits.sendTronRedeem(flushed, outIndex)).context;
  const requestId = first(
    newIds(ledgerOf(flushed).bidirectionalTronRedeemMap, ledgerOf(sent).bidirectionalTronRedeemMap),
    "new Tron redeem request",
  );
  return { context: sent, outIndex, requestId };
};

// VALID windows expire at h = NOW + 3600 whole seconds: a send is admitted below block time
// h - 60 and refused from h - 60 on, where the refund opens.
const LAST_SEND_TIME = NOW + 3600 - SEND_MIN_REMAINING - 1;
const SEND_CLOSED_TIME = NOW + 3600 - SEND_MIN_REMAINING;

describe("setTronLendPair", () => {
  it("records the pair and the minimum supply", async () => {
    const { contract, ctx } = await deployInitialised();
    const paired = (
      await contract.circuits.setTronLendPair(ctx, TRON_USDT, SHARE_TOKEN, MIN_SUPPLY)
    ).context;
    const state = ledgerOf(paired);
    expect(state.tronLendUnderlying).toEqual(TRON_USDT);
    expect(state.tronLendShareToken).toEqual(SHARE_TOKEN);
    expect(state.tronLendMinSupply).toBe(MIN_SUPPLY);
  });

  it("is deployer-gated", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(
      contract.circuits.setTronLendPair(stranger(ctx), TRON_USDT, SHARE_TOKEN, MIN_SUPPLY),
    ).rejects.toThrow(/Not the deployer/);
  });

  it("is one-shot: a second pair is refused, keeping the first", async () => {
    const { contract, ctx } = await deployPaired();
    await expect(
      contract.circuits.setTronLendPair(ctx, NANO_UNDERLYING, SHARE_TOKEN, 1n),
    ).rejects.toThrow(/Tron lend pair already set/);
    expect(ledgerOf(ctx).tronLendUnderlying).toEqual(TRON_USDT);
    expect(ledgerOf(ctx).tronLendMinSupply).toBe(MIN_SUPPLY);
  });

  it.each([
    ["a zero underlying", ZERO_ADDRESS, SHARE_TOKEN, MIN_SUPPLY, /Underlying cannot be zero/],
    ["a zero share token", TRON_USDT, ZERO_ADDRESS, MIN_SUPPLY, /Share token cannot be zero/],
    [
      "an identical underlying and share token",
      SHARE_TOKEN,
      SHARE_TOKEN,
      MIN_SUPPLY,
      /Underlying and share token must differ/,
    ],
    ["an unlisted underlying", UNLISTED_TRC20, SHARE_TOKEN, MIN_SUPPLY, /TRC-20 not allowed/],
    ["an unlisted share token", TRON_USDT, UNLISTED_TRC20, MIN_SUPPLY, /TRC-20 not allowed/],
    ["a zero minimum supply", TRON_USDT, SHARE_TOKEN, 0n, /Minimum supply must be positive/],
  ] as const)("refuses %s", async (_name, underlying, shareToken, minSupply, error) => {
    const { contract, ctx } = await deployInitialised();
    await expect(
      contract.circuits.setTronLendPair(ctx, underlying, shareToken, minSupply),
    ).rejects.toThrow(error);
  });

  it("refuses before initialise", async () => {
    const { contract, ctx } = await deployUninitialised();
    await expect(
      contract.circuits.setTronLendPair(ctx, TRON_USDT, SHARE_TOKEN, MIN_SUPPLY),
    ).rejects.toThrow(/Not initialised/);
  });
});

describe("startTronApprove", () => {
  it("queues a Tron entry with the deployer's window and the approve fee limit", async () => {
    const { contract, ctx } = await deployPaired();
    const started = (await startTronApprove(contract, ctx, APPROVE_INDEX, TRON_WINDOW)).context;
    const state = ledgerOf(started);
    expect(state.inputRequestBuffer.lookup(APPROVE_INDEX)).toEqual({
      action: Action.tronApprove,
      chain: Chain.tron,
      useNextVaultAccountNonce: false,
      evmNonce: 0n,
      inIndex: APPROVE_INDEX,
      commitment: pureCircuits.ownershipCommitment(APPROVE_INDEX, SECRET_KEY),
      argsHash: expect.any(Uint8Array) as Uint8Array,
    });
    expect(state.tronApproveArgsMap.lookup(APPROVE_INDEX)).toEqual({
      tx: { ...TRON_WINDOW, feeLimit: DEFAULT_TRON_FEE_LIMITS.approve },
    });
  });

  it("snapshots the approve fee limit setGasParams last set", async () => {
    const { contract, ctx } = await deployPaired();
    const reconfigured = (
      await contract.circuits.setGasParams(
        ctx,
        1n,
        1n,
        1n,
        1n,
        1n,
        1n,
        1n,
        DISTINCT_TRON_FEE_LIMITS,
      )
    ).context;
    const started = (await startTronApprove(contract, reconfigured, APPROVE_INDEX, TRON_WINDOW))
      .context;
    expect(ledgerOf(started).tronApproveArgsMap.lookup(APPROVE_INDEX).tx.feeLimit).toBe(
      DISTINCT_TRON_FEE_LIMITS.approve,
    );
  });

  it("is deployer-gated", async () => {
    const { contract, ctx } = await deployPaired();
    await expect(
      startTronApprove(contract, stranger(ctx), APPROVE_INDEX, TRON_WINDOW),
    ).rejects.toThrow(/Not the deployer/);
  });

  it("refuses before the pair is set", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(startTronApprove(contract, ctx, APPROVE_INDEX, TRON_WINDOW)).rejects.toThrow(
      /Tron lend pair not set/,
    );
  });

  it("refuses before initialise", async () => {
    const { contract, ctx } = await deployUninitialised();
    await expect(startTronApprove(contract, ctx, APPROVE_INDEX, TRON_WINDOW)).rejects.toThrow(
      /Not initialised/,
    );
  });

  it("refuses an index another action's queued request holds", async () => {
    const { contract, ctx } = await deployPaired();
    const supply = (
      await startTronSupply(contract, ctx, { ...VALID_TRON_SUPPLY, inIndex: APPROVE_INDEX })
    ).context;
    await expect(startTronApprove(contract, supply, APPROVE_INDEX, TRON_WINDOW)).rejects.toThrow(
      /Index already in use/,
    );
  });

  it("refuses an index a flushed approval still holds", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: flushed } = await flushedTronApprove(contract, ctx);
    await expect(
      startTronApprove(contract, flushed, APPROVE_INDEX, {
        ...TRON_WINDOW,
        timestamp: ms(NOW - 6),
      }),
    ).rejects.toThrow(/Index already in use/);
  });

  it.each([
    ["the shortest window", ms(NOW + START_MIN_REMAINING + 1)],
    ["the longest window", ms(NOW + DAY - CAP_MARGIN - 1, 999)],
  ] as const)("admits %s at the start block", async (_name, expiration) => {
    const { contract, ctx } = await deployPaired();
    const started = (
      await startTronApprove(contract, ctx, APPROVE_INDEX, {
        ...TRON_WINDOW,
        timestamp: ms(NOW - DAY),
        expiration,
      })
    ).context;
    expect(ledgerOf(started).tronApproveArgsMap.size()).toBe(1n);
  });

  it.each([
    ["a window one second too short", ms(NOW + START_MIN_REMAINING, 999), /too close/],
    ["a window one second too long", ms(NOW + DAY - CAP_MARGIN), /too far/],
  ] as const)("refuses %s at the start block", async (_name, expiration, error) => {
    const { contract, ctx } = await deployPaired();
    await expect(
      startTronApprove(contract, ctx, APPROVE_INDEX, {
        ...TRON_WINDOW,
        timestamp: ms(NOW - DAY),
        expiration,
      }),
    ).rejects.toThrow(error);
  });

  it("refuses an expiration past int64", async () => {
    const { contract, ctx } = await deployPaired();
    await expect(
      startTronApprove(contract, ctx, APPROVE_INDEX, {
        ...TRON_WINDOW,
        expiration: INT64_MAX + 1n,
      }),
    ).rejects.toThrow(/Tron expiration exceeds int64/);
  });
});

// approve(address,uint256), its bool output schema, and the allowance every approval grants.
const APPROVE_SELECTOR = new Uint8Array([0x09, 0x5e, 0xa7, 0xb3]);
const VAULT_OUTPUT_SCHEMA = new TextEncoder().encode('[{"name":"success","type":"bool"}]');
const UNLIMITED_ALLOWANCE = (1n << 128n) - 1n;

describe("sendTronApprove", () => {
  it.each([
    ["Tron USDT", USDT_PAIR],
    ["a shifted underlying", NANO_PAIR],
  ] as const)(
    "approves the share token on the underlying (%s) and notifies the MPC with its map's path",
    async (_name, pair) => {
      const { contract, ctx } = await deployPaired(pair);
      const { context: flushed, outIndex } = await flushedTronApprove(contract, ctx);
      const sent = (await contract.circuits.sendTronApprove(flushed, outIndex)).context;
      const state = sent.callContext.currentQueryContext.state;

      const raw = readSignetRequestsLedgerFromState(state, VAULT_TRON_APPROVE_REQUESTS_PATH);
      expect(raw.requestsIndex.size).toBe(1);
      const [idHex, record] = first(raw.requestsIndex.entries(), "Tron approve record");
      if (!isTronRequest(record)) throw new Error("expected a Tron record");
      expect(idHex).toBe(requestIdHex(calculateRequestId(record)));
      expect(record.sender).toEqual({ bytes: VAULT_ADDRESS_BYTES });
      expect(record.path).toEqual(asciiPadded("vault", 32));
      expect(record.txParamType).toBe(TxParamType.tronTriggerSmartContract);
      expect(record.executionDest).toEqual(signetCircuits.tronCaip2Id());
      expect(record.outputDeserializationSchema).toEqual(VAULT_OUTPUT_SCHEMA);
      expect(record.txParams).toEqual({
        ...TRON_WINDOW,
        feeLimit: DEFAULT_TRON_FEE_LIMITS.approve,
        contractAddress: Uint8Array.of(0x41, ...pair.underlying),
        callValue: 0n,
        calldata: {
          is_some: true,
          value: {
            selector: APPROVE_SELECTOR,
            noWords: 2n,
            words: [evmAddressAbiWord(SHARE_TOKEN), numericAbiWord(UNLIMITED_ALLOWANCE)],
          },
        },
      });

      const notification = first(
        decodeSignetLogEvents(sent.events, SIGNET_ADDRESS),
        "notification",
      );
      const post = decodeSignBidirectionalEventNotificationPayload(notification.payload);
      expect(requestIdHex(post.requestId)).toBe(idHex);
      expect(decodeSignBidirectionalNotification(post.event)).toEqual({
        version: 1,
        callerAddress: bytesToHex(VAULT_ADDRESS_BYTES),
        requestsPath: [3, 9],
      });
    },
  );

  it("is permissionless and refuses a second send", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: flushed, outIndex } = await flushedTronApprove(contract, ctx);
    const sent = (await contract.circuits.sendTronApprove(stranger(flushed), outIndex)).context;
    expect(ledgerOf(sent).bidirectionalTronApproveMap.size()).toBe(1n);
    await expect(contract.circuits.sendTronApprove(sent, outIndex)).rejects.toThrow(
      /Request already sent/,
    );
  });

  it("refuses another action's flushed entry", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: flushed, outIndex } = await flushedTronSupply(
      contract,
      ctx,
      VALID_TRON_SUPPLY,
    );
    await expect(contract.circuits.sendTronApprove(flushed, outIndex)).rejects.toThrow(
      /Wrong action/,
    );
  });

  it("admits a send in the last block time the margin allows, and refuses the next", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: flushed, outIndex } = await flushedTronApprove(contract, ctx);
    await expect(
      contract.circuits.sendTronApprove(atBlockTime(flushed, SEND_CLOSED_TIME), outIndex),
    ).rejects.toThrow(/too close/);
    const sent = (
      await contract.circuits.sendTronApprove(atBlockTime(flushed, LAST_SEND_TIME), outIndex)
    ).context;
    expect(ledgerOf(sent).bidirectionalTronApproveMap.size()).toBe(1n);
  });
});

describe("completeTronApprove", () => {
  it.each([
    ["an executed approval returning true", OutputKind.executed, OUTPUT_TRUE, OUTPUT_TRUE],
    ["an executed approval returning false", OutputKind.executed, OUTPUT_FALSE, OUTPUT_FALSE],
    ["a failed approval", OutputKind.failed, OUTPUT_EMPTY, OUTPUT_IGNORED_BOOL],
    ["an unviable approval", OutputKind.unviable, OUTPUT_EMPTY, OUTPUT_IGNORED_BOOL],
  ] as const)(
    "closes %s without minting",
    async (_name, outputKind, signedOutput, presentedOutput) => {
      const { contract, ctx } = await deployPaired();
      const { context: sent, requestId } = await sentTronApprove(contract, ctx);
      const attested = await attest(
        contract,
        sent,
        respond(requestId, outputKind, signedOutput, TRON_ATTESTED_HEIGHT),
      );
      const settled = (
        await contract.circuits.completeTronApprove(attested, requestId, presentedOutput)
      ).context;
      expect(coinsMinted(attested, settled)).toEqual([]);
      const state = ledgerOf(settled);
      expect(state.bidirectionalTronApproveMap.isEmpty()).toBe(true);
      expect(state.tronApproveArgsMap.isEmpty()).toBe(true);
      expect(state.outputRequestBuffer.isEmpty()).toBe(true);
      expect(state.evictionMap.isEmpty()).toBe(true);
      expect(state.tronLastSeen).toBe(TRON_ATTESTED_HEIGHT);
    },
  );

  it("refuses an output that does not match the attestation", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: sent, requestId } = await sentTronApprove(contract, ctx);
    const attested = await attest(
      contract,
      sent,
      respond(requestId, OutputKind.executed, OUTPUT_TRUE, TRON_ATTESTED_HEIGHT),
    );
    await expect(
      contract.circuits.completeTronApprove(attested, requestId, OUTPUT_FALSE),
    ).rejects.toThrow(/Output does not match the attestation/);
  });

  it("refuses a caller other than the deployer who started it", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: sent, requestId } = await sentTronApprove(contract, ctx);
    const attested = await attest(
      contract,
      sent,
      respond(requestId, OutputKind.executed, OUTPUT_TRUE, TRON_ATTESTED_HEIGHT),
    );
    await expect(
      contract.circuits.completeTronApprove(stranger(attested), requestId, OUTPUT_TRUE),
    ).rejects.toThrow(/Not the requester/);
  });
});

describe("startTronSupply", () => {
  it("queues a Tron entry with the supplier's window and the supply fee limit", async () => {
    const { contract, ctx } = await deployPaired();
    const started = (await startTronSupply(contract, ctx, VALID_TRON_SUPPLY)).context;
    const state = ledgerOf(started);
    expect(state.inputRequestBuffer.lookup(VALID_TRON_SUPPLY.inIndex)).toEqual({
      action: Action.tronSupply,
      chain: Chain.tron,
      useNextVaultAccountNonce: false,
      evmNonce: 0n,
      inIndex: VALID_TRON_SUPPLY.inIndex,
      commitment: pureCircuits.ownershipCommitment(VALID_TRON_SUPPLY.inIndex, SECRET_KEY),
      argsHash: expect.any(Uint8Array) as Uint8Array,
    });
    expect(state.tronSupplyArgsMap.lookup(VALID_TRON_SUPPLY.inIndex)).toEqual({
      request: VALID_TRON_SUPPLY.supply,
      tx: { ...TRON_WINDOW, feeLimit: DEFAULT_TRON_FEE_LIMITS.supply },
      binding: pureCircuits.ownershipCommitment(VALID_TRON_SUPPLY.inIndex, SECRET_KEY),
    });
  });

  it.each([
    ["Tron USDT", USDT_PAIR, VALID_TRON_SUPPLY],
    ["a shifted underlying", NANO_PAIR, VALID_NANO_SUPPLY],
  ] as const)(
    "burns the %s coin, amount plus fee, and mints the fee in its colour",
    async (_name, pair, args) => {
      const { contract, ctx } = await deployPaired(pair);
      const started = (await startTronSupply(contract, ctx, args)).context;
      const { burn, fee } = burnAndFee(started);
      expect(burn.color).toEqual(pair.colour);
      expect(burn.value).toBe(SUPPLY_AMOUNT + pair.fees.supply);
      expect(fee).toEqual({
        nonce: pureCircuits.feeMintNonce(args.coin.nonce),
        color: pair.colour,
        value: pair.fees.supply,
      });
    },
  );

  it("snapshots the supply fee limit setGasParams last set", async () => {
    const { contract, ctx } = await deployPaired();
    const reconfigured = (
      await contract.circuits.setGasParams(
        ctx,
        1n,
        1n,
        1n,
        1n,
        1n,
        1n,
        1n,
        DISTINCT_TRON_FEE_LIMITS,
      )
    ).context;
    const started = (await startTronSupply(contract, reconfigured, VALID_TRON_SUPPLY)).context;
    expect(ledgerOf(started).tronSupplyArgsMap.lookup(VALID_TRON_SUPPLY.inIndex).tx.feeLimit).toBe(
      DISTINCT_TRON_FEE_LIMITS.supply,
    );
  });

  it("takes the supply fee setTronTokenFees last set on the underlying", async () => {
    const { contract, ctx } = await deployPaired();
    const repriced = (
      await contract.circuits.setTronTokenFees(ctx, TRON_USDT, { ...USDT_FEES, supply: 5n })
    ).context;
    const started = (
      await startTronSupply(contract, repriced, {
        ...VALID_TRON_SUPPLY,
        coin: vaultCoin(SUPPLY_AMOUNT + 5n, USDT_COLOR),
      })
    ).context;
    expect(burnAndFee(started).fee.value).toBe(5n);
  });

  it("accepts the minimum supply", async () => {
    const { contract, ctx } = await deployPaired();
    const started = (
      await startTronSupply(contract, ctx, {
        ...VALID_TRON_SUPPLY,
        supply: { amount: MIN_SUPPLY },
        coin: vaultCoin(MIN_SUPPLY + USDT_FEES.supply, USDT_COLOR),
      })
    ).context;
    expect(ledgerOf(started).tronSupplyArgsMap.size()).toBe(1n);
  });

  it.each([
    [
      "an amount one below the minimum supply",
      {
        supply: { amount: MIN_SUPPLY - 1n },
        coin: vaultCoin(MIN_SUPPLY - 1n + USDT_FEES.supply, USDT_COLOR),
      },
      /Amount below the minimum supply/,
    ],
    [
      "a zero amount",
      { supply: { amount: 0n }, coin: vaultCoin(USDT_FEES.supply, USDT_COLOR) },
      /Amount below the minimum supply/,
    ],
    [
      "an amount past Uint<64>",
      {
        supply: { amount: UINT64_MAX + 1n },
        coin: vaultCoin(UINT64_MAX + 1n + USDT_FEES.supply, USDT_COLOR),
      },
      /Amount exceeds Uint<64> max/,
    ],
    [
      "a share token coin",
      { coin: vaultCoin(SUPPLY_AMOUNT + USDT_FEES.supply, SHARE_COLOR) },
      /Coin is not the vault token for the underlying/,
    ],
    [
      "the underlying's ERC20 colour",
      {
        coin: vaultCoin(
          SUPPLY_AMOUNT + USDT_FEES.supply,
          colourOf(pureCircuits.vaultTokenDomainSeparator(TRON_USDT)),
        ),
      },
      /Coin is not the vault token for the underlying/,
    ],
    [
      "a coin without the fee",
      { coin: vaultCoin(SUPPLY_AMOUNT, USDT_COLOR) },
      /Coin value must equal the supply amount plus fee/,
    ],
    [
      "a coin above amount plus fee",
      { coin: vaultCoin(SUPPLY_AMOUNT + USDT_FEES.supply + 1n, USDT_COLOR) },
      /Coin value must equal the supply amount plus fee/,
    ],
    [
      "a window one second too short",
      { tronTx: { ...TRON_WINDOW, expiration: ms(NOW + START_MIN_REMAINING, 999) } },
      /too close/,
    ],
    [
      "a window one second too long",
      {
        tronTx: {
          ...TRON_WINDOW,
          timestamp: ms(NOW - DAY),
          expiration: ms(NOW + DAY - CAP_MARGIN),
        },
      },
      /too far/,
    ],
    [
      "a timestamp past int64",
      { tronTx: { ...TRON_WINDOW, timestamp: INT64_MAX + 1n, expiration: INT64_MAX + 2n } },
      /Tron timestamp exceeds int64/,
    ],
  ] as const)("refuses %s", async (_name, delta: Partial<TronSupplyCallArgs>, error) => {
    const { contract, ctx } = await deployPaired();
    await expect(
      startTronSupply(contract, ctx, { ...VALID_TRON_SUPPLY, ...delta }),
    ).rejects.toThrow(error);
  });

  it.each([
    ["its unshifted colour", colourOf(pureCircuits.vaultTronTokenDomainSeparator(NANO_UNDERLYING))],
    ["its colour at another factor", colourOf(pureCircuits.tronCoinColour(NANO_UNDERLYING, 10n))],
  ] as const)("refuses a shifted underlying's coin in %s", async (_name, colour) => {
    const { contract, ctx } = await deployPaired(NANO_PAIR);
    await expect(
      startTronSupply(contract, ctx, {
        ...VALID_NANO_SUPPLY,
        coin: vaultCoin(SUPPLY_AMOUNT + NANO_FEES.supply, colour),
      }),
    ).rejects.toThrow(/Coin is not the vault token for the underlying/);
  });

  it("refuses before the pair is set", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(startTronSupply(contract, ctx, VALID_TRON_SUPPLY)).rejects.toThrow(
      /Tron lend pair not set/,
    );
  });

  it("refuses an index a queued request holds", async () => {
    const { contract, ctx } = await deployPaired();
    const started = (await startTronSupply(contract, ctx, VALID_TRON_SUPPLY)).context;
    await expect(
      startTronSupply(contract, started, {
        ...VALID_TRON_SUPPLY,
        tronTx: { ...TRON_WINDOW, timestamp: ms(NOW - 6) },
      }),
    ).rejects.toThrow(/Index already in use/);
  });

  it("refuses an index a flushed Tron supply still holds", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: flushed } = await flushedTronSupply(contract, ctx, VALID_TRON_SUPPLY);
    expect(ledgerOf(flushed).inputRequestBuffer.member(VALID_TRON_SUPPLY.inIndex)).toBe(false);
    await expect(
      startTronSupply(contract, flushed, {
        ...VALID_TRON_SUPPLY,
        tronTx: { ...TRON_WINDOW, timestamp: ms(NOW - 6) },
      }),
    ).rejects.toThrow(/Index already in use/);
  });

  it("refuses an index another action's queued request holds", async () => {
    const { contract, ctx } = await deployPaired();
    const redeem = (
      await startTronRedeem(contract, ctx, {
        ...VALID_TRON_REDEEM,
        inIndex: VALID_TRON_SUPPLY.inIndex,
      })
    ).context;
    await expect(startTronSupply(contract, redeem, VALID_TRON_SUPPLY)).rejects.toThrow(
      /Index already in use/,
    );
  });
});

// deposit(uint256,address) and its shares output schema.
const DEPOSIT_SELECTOR = new Uint8Array([0x6e, 0x55, 0x3f, 0x65]);
const SUPPLY_OUTPUT_SCHEMA = new TextEncoder().encode('[{"name":"shares","type":"uint256"}]');

describe("sendTronSupply", () => {
  it.each([
    ["Tron USDT, unshifted", USDT_PAIR, VALID_TRON_SUPPLY, SUPPLY_AMOUNT],
    ["a 10^3-shifted underlying", NANO_PAIR, VALID_NANO_SUPPLY, SUPPLY_AMOUNT * NANO_FACTOR],
  ] as const)(
    "deposits the %s amount in base units to the vault on the share token",
    async (_name, pair, args, base) => {
      const { contract, ctx } = await deployPaired(pair);
      const { context: flushed, outIndex } = await flushedTronSupply(contract, ctx, args);
      const sent = (await contract.circuits.sendTronSupply(flushed, outIndex)).context;
      const state = sent.callContext.currentQueryContext.state;

      const raw = readSignetRequestsLedgerFromState(state, VAULT_TRON_SUPPLY_REQUESTS_PATH);
      expect(raw.requestsIndex.size).toBe(1);
      const [idHex, record] = first(raw.requestsIndex.entries(), "Tron supply record");
      if (!isTronRequest(record)) throw new Error("expected a Tron record");
      expect(idHex).toBe(requestIdHex(calculateRequestId(record)));
      expect(record.sender).toEqual({ bytes: VAULT_ADDRESS_BYTES });
      expect(record.path).toEqual(asciiPadded("vault", 32));
      expect(record.txParamType).toBe(TxParamType.tronTriggerSmartContract);
      expect(record.executionDest).toEqual(signetCircuits.tronCaip2Id());
      expect(record.outputDeserializationSchema).toEqual(SUPPLY_OUTPUT_SCHEMA);
      expect(record.txParams).toEqual({
        ...TRON_WINDOW,
        feeLimit: DEFAULT_TRON_FEE_LIMITS.supply,
        contractAddress: Uint8Array.of(0x41, ...SHARE_TOKEN),
        callValue: 0n,
        calldata: {
          is_some: true,
          value: {
            selector: DEPOSIT_SELECTOR,
            noWords: 3n,
            words: [
              numericAbiWord(base),
              evmAddressAbiWord(VAULT_EVM),
              pureCircuits.ownershipCommitment(args.inIndex, SECRET_KEY),
            ],
          },
        },
      });

      const notification = first(
        decodeSignetLogEvents(sent.events, SIGNET_ADDRESS),
        "notification",
      );
      const post = decodeSignBidirectionalEventNotificationPayload(notification.payload);
      expect(requestIdHex(post.requestId)).toBe(idHex);
      expect(decodeSignBidirectionalNotification(post.event)).toEqual({
        version: 1,
        callerAddress: bytesToHex(VAULT_ADDRESS_BYTES),
        requestsPath: [3, 11],
      });
      expect(ledger(state).outputRequestBuffer.lookup(outIndex).lastSeen).toBe(TRON_START_HEIGHT);
    },
  );

  it("is permissionless: a stranger's send records the same request", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: flushed, outIndex } = await flushedTronSupply(
      contract,
      ctx,
      VALID_TRON_SUPPLY,
    );
    const bySupplier = (await contract.circuits.sendTronSupply(flushed, outIndex)).context;
    const byStranger = (await contract.circuits.sendTronSupply(stranger(flushed), outIndex))
      .context;
    expect([...ledgerOf(byStranger).bidirectionalTronSupplyMap]).toEqual([
      ...ledgerOf(bySupplier).bidirectionalTronSupplyMap,
    ]);
  });

  it("refuses a second send of the same request", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: sent, outIndex } = await sentTronSupply(contract, ctx, VALID_TRON_SUPPLY);
    await expect(contract.circuits.sendTronSupply(sent, outIndex)).rejects.toThrow(
      /Request already sent/,
    );
  });

  it("refuses an index that is not flushed", async () => {
    const { contract, ctx } = await deployPaired();
    const started = (await startTronSupply(contract, ctx, VALID_TRON_SUPPLY)).context;
    const outIndex = queuedRequestIndex(ledgerOf(started), VALID_TRON_SUPPLY.inIndex);
    await expect(contract.circuits.sendTronSupply(started, outIndex)).rejects.toThrow(
      /Request not flushed/,
    );
  });

  it("refuses another action's flushed entry", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: flushed, outIndex } = await flushedTronRedeem(
      contract,
      ctx,
      VALID_TRON_REDEEM,
    );
    await expect(contract.circuits.sendTronSupply(flushed, outIndex)).rejects.toThrow(
      /Wrong action/,
    );
  });

  it("admits a send in the last block time the margin allows, and refuses the next", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: flushed, outIndex } = await flushedTronSupply(
      contract,
      ctx,
      VALID_TRON_SUPPLY,
    );
    await expect(
      contract.circuits.sendTronSupply(atBlockTime(flushed, SEND_CLOSED_TIME), outIndex),
    ).rejects.toThrow(/too close/);
    const sent = (
      await contract.circuits.sendTronSupply(atBlockTime(flushed, LAST_SEND_TIME), outIndex)
    ).context;
    expect(ledgerOf(sent).bidirectionalTronSupplyMap.size()).toBe(1n);
  });
});

// An executed supply mints floor(shares / 10^12) share coin units; the remainder stays in
// the vault's Tron account.
const SUPPLY_EXECUTED_CASES = [
  {
    name: "100 USDT's shares floor to whole share coin units",
    shares: SUPPLY_SHARES,
    minted: SUPPLY_SHARE_UNITS,
  },
  {
    name: "an exact multiple of the factor mints it whole",
    shares: SUPPLY_SHARE_UNITS * SHARE_FACTOR,
    minted: SUPPLY_SHARE_UNITS,
  },
  {
    name: "the largest remainder is floored away",
    shares: (SUPPLY_SHARE_UNITS + 1n) * SHARE_FACTOR - 1n,
    minted: SUPPLY_SHARE_UNITS,
  },
  {
    name: "the largest coin's shares mint the Uint<64> maximum",
    shares: UINT64_MAX * SHARE_FACTOR + SHARE_FACTOR - 1n,
    minted: UINT64_MAX,
  },
] as const;

// transfer(address,uint256), which a Tron withdraw of the share coins calls.
const TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

describe("completeTronSupply", () => {
  it.each(SUPPLY_EXECUTED_CASES)(
    "executed: $name, to the supplier, and consumes the request",
    async ({ shares, minted }) => {
      const { contract, ctx } = await deployPaired();
      const { context: sent, requestId } = await sentTronSupply(contract, ctx, VALID_TRON_SUPPLY);
      const attested = await attest(
        contract,
        sent,
        respond(requestId, OutputKind.executed, sharesOutput(shares), TRON_ATTESTED_HEIGHT),
      );
      const settled = (
        await contract.circuits.completeTronSupply(
          attested,
          requestId,
          sharesOutput(shares),
          MINT_NONCE,
        )
      ).context;

      expect(shieldedMintsSince(attested, settled)).toEqual([[SHARE_MINT_KEY, minted]]);
      expect(
        coinsMinted(attested, settled).map(({ coinInfo, recipient }) => [
          coinInfo,
          recipient.left.bytes,
        ]),
      ).toEqual([[{ nonce: MINT_NONCE, color: SHARE_COLOR, value: minted }, hexToBytes(CPK)]]);
      const state = ledgerOf(settled);
      expect(state.bidirectionalTronSupplyMap.isEmpty()).toBe(true);
      expect(state.tronSupplyArgsMap.isEmpty()).toBe(true);
      expect(state.outputRequestBuffer.isEmpty()).toBe(true);
      expect(state.outputAttestationBuffer.isEmpty()).toBe(true);
      expect(state.evictionMap.isEmpty()).toBe(true);
      expect(state.tronLastSeen).toBe(TRON_ATTESTED_HEIGHT);
    },
  );

  it.each([
    ["Tron USDT", USDT_PAIR, VALID_TRON_SUPPLY, OutputKind.failed],
    ["Tron USDT", USDT_PAIR, VALID_TRON_SUPPLY, OutputKind.unviable],
    ["a shifted underlying", NANO_PAIR, VALID_NANO_SUPPLY, OutputKind.failed],
  ] as const)(
    "re-mints the %s amount, never the fee, on verdict %s",
    async (_name, pair, args, outputKind) => {
      const { contract, ctx } = await deployPaired(pair);
      const { context: sent, requestId } = await sentTronSupply(contract, ctx, args);
      const attested = await attest(
        contract,
        sent,
        respond(requestId, outputKind, OUTPUT_EMPTY, TRON_ATTESTED_HEIGHT),
      );
      const settled = (
        await contract.circuits.completeTronSupply(attested, requestId, OUTPUT_IGNORED, MINT_NONCE)
      ).context;
      expect(
        coinsMinted(attested, settled).map(({ coinInfo, recipient }) => [
          coinInfo,
          recipient.left.bytes,
        ]),
      ).toEqual([
        [{ nonce: MINT_NONCE, color: pair.colour, value: SUPPLY_AMOUNT }, hexToBytes(CPK)],
      ]);
      expect(ledgerOf(settled).tronSupplyArgsMap.isEmpty()).toBe(true);
    },
  );

  it.each([
    ["one too many share units", 1n, /Quotient too large/],
    ["one too few share units", -1n, /Quotient too small/],
  ] as const)("refuses a witness naming %s", async (_name, offset, error) => {
    const { contract, ctx } = await deployPaired();
    const { context: sent, requestId } = await sentTronSupply(contract, ctx, VALID_TRON_SUPPLY);
    const attested = await attest(
      contract,
      sent,
      respond(requestId, OutputKind.executed, sharesOutput(SUPPLY_SHARES), TRON_ATTESTED_HEIGHT),
    );
    await expect(
      offsetQuotient(offset).circuits.completeTronSupply(
        attested,
        requestId,
        sharesOutput(SUPPLY_SHARES),
        MINT_NONCE,
      ),
    ).rejects.toThrow(error);
  });

  it.each([
    ["one share base unit more", SUPPLY_SHARES + 1n],
    ["another amount of the same share units", SUPPLY_SHARE_UNITS * SHARE_FACTOR],
  ] as const)("refuses a presented output of %s than attested", async (_name, presented) => {
    const { contract, ctx } = await deployPaired();
    const { context: sent, requestId } = await sentTronSupply(contract, ctx, VALID_TRON_SUPPLY);
    const attested = await attest(
      contract,
      sent,
      respond(requestId, OutputKind.executed, sharesOutput(SUPPLY_SHARES), TRON_ATTESTED_HEIGHT),
    );
    await expect(
      contract.circuits.completeTronSupply(
        attested,
        requestId,
        sharesOutput(presented),
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Output does not match the attestation/);
  });

  it.each([
    [
      "at 2^128 share base units",
      1n << 128n,
      /exceeds maximum value 340282366920938463463374607431768211455/,
    ],
    ["at the uint256 maximum", (1n << 256n) - 1n, /Value exceeds Uint<128>/],
    [
      "whose share units reach 2^64",
      (UINT64_MAX + 1n) * SHARE_FACTOR,
      /unitsOfBase return value .* expected value of type Uint<0\.\.18446744073709551616>/,
    ],
  ] as const)("cannot settle an executed supply %s", async (_name, shares, error) => {
    const { contract, ctx } = await deployPaired();
    const { context: sent, requestId } = await sentTronSupply(contract, ctx, VALID_TRON_SUPPLY);
    const attested = await attest(
      contract,
      sent,
      respond(requestId, OutputKind.executed, sharesOutput(shares), TRON_ATTESTED_HEIGHT),
    );
    await expect(
      contract.circuits.completeTronSupply(attested, requestId, sharesOutput(shares), MINT_NONCE),
    ).rejects.toThrow(error);
  });

  it("refuses the Uint<64> maximum for shares whose units reach 2^64", async () => {
    const { contract, ctx } = await deployPaired();
    const shares = (UINT64_MAX + 1n) * SHARE_FACTOR;
    const { context: sent, requestId } = await sentTronSupply(contract, ctx, VALID_TRON_SUPPLY);
    const attested = await attest(
      contract,
      sent,
      respond(requestId, OutputKind.executed, sharesOutput(shares), TRON_ATTESTED_HEIGHT),
    );
    await expect(
      offsetQuotient(-1n).circuits.completeTronSupply(
        attested,
        requestId,
        sharesOutput(shares),
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Quotient too small/);
  });

  // The minimum supply keeps a real supply above one share coin unit; below it the settle
  // still closes the request, with a zero coin, so nothing stays open.
  it("settles an executed supply under one share coin unit with a zero coin", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: sent, requestId } = await sentTronSupply(contract, ctx, VALID_TRON_SUPPLY);
    const attested = await attest(
      contract,
      sent,
      respond(
        requestId,
        OutputKind.executed,
        sharesOutput(SHARE_FACTOR - 1n),
        TRON_ATTESTED_HEIGHT,
      ),
    );
    const settled = (
      await contract.circuits.completeTronSupply(
        attested,
        requestId,
        sharesOutput(SHARE_FACTOR - 1n),
        MINT_NONCE,
      )
    ).context;
    expect(shieldedMintsSince(attested, settled)).toEqual([]);
    expect(coinsMinted(attested, settled).map(({ coinInfo }) => coinInfo)).toEqual([
      { nonce: MINT_NONCE, color: SHARE_COLOR, value: 0n },
    ]);
    expect(ledgerOf(settled).tronSupplyArgsMap.isEmpty()).toBe(true);
  });

  it("refuses a caller other than the supplier", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: sent, requestId } = await sentTronSupply(contract, ctx, VALID_TRON_SUPPLY);
    const attested = await attest(
      contract,
      sent,
      respond(requestId, OutputKind.failed, OUTPUT_EMPTY, TRON_ATTESTED_HEIGHT),
    );
    await expect(
      contract.circuits.completeTronSupply(
        stranger(attested),
        requestId,
        OUTPUT_IGNORED,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Not the requester/);
  });

  it("settles once", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: sent, requestId } = await sentTronSupply(contract, ctx, VALID_TRON_SUPPLY);
    const attested = await attest(
      contract,
      sent,
      respond(requestId, OutputKind.failed, OUTPUT_EMPTY, TRON_ATTESTED_HEIGHT),
    );
    const settled = (
      await contract.circuits.completeTronSupply(attested, requestId, OUTPUT_IGNORED, MINT_NONCE)
    ).context;
    await expect(
      contract.circuits.completeTronSupply(settled, requestId, OUTPUT_IGNORED, MINT_NONCE),
    ).rejects.toThrow(/Request not sent/);
  });

  // The share coins a supply mints are the share token's Tron coins: the same colour a Tron
  // deposit of the share token mints, so a Tron withdraw takes them as the share token.
  it("mints share coins a Tron withdraw of the share token takes, at units·10^12", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: sent, requestId } = await sentTronSupply(contract, ctx, VALID_TRON_SUPPLY);
    const attested = await attest(
      contract,
      sent,
      respond(requestId, OutputKind.executed, sharesOutput(SUPPLY_SHARES), TRON_ATTESTED_HEIGHT),
    );
    const supplied = (
      await contract.circuits.completeTronSupply(
        attested,
        requestId,
        sharesOutput(SUPPLY_SHARES),
        MINT_NONCE,
      )
    ).context;
    const coin = first(coinsMinted(attested, supplied), "share coin").coinInfo;
    const amount = SUPPLY_SHARE_UNITS - SHARE_FEES.withdraw;
    const withdrawn = (
      await contract.circuits.startTronWithdraw(
        supplied,
        30n,
        { tokenAddress: SHARE_TOKEN, amount, destTronAddress: DEST_TRON },
        TRON_WINDOW,
        coin,
      )
    ).context;
    const outIndex = queuedRequestIndex(ledgerOf(withdrawn), 30n);
    const flushed = await flush(contract, withdrawn, [30n], []);
    const withdrawSent = (await contract.circuits.sendTronWithdraw(flushed, outIndex)).context;
    const [, event] = first(ledgerOf(withdrawSent).bidirectionalTronWithdrawMap, "Tron withdraw");
    expect(event.txParams.contractAddress).toEqual(Uint8Array.of(0x41, ...SHARE_TOKEN));
    expect(event.txParams.calldata.value).toEqual({
      selector: TRANSFER_SELECTOR,
      noWords: 3n,
      words: [
        evmAddressAbiWord(DEST_TRON),
        numericAbiWord(amount * SHARE_FACTOR),
        pureCircuits.ownershipCommitment(30n, SECRET_KEY),
      ],
    });
  });
});

describe("refundUnsentTronSupply", () => {
  it.each(["queued", "flushed"] as const)(
    "re-mints the amount of a %s supply once sends are refused, keeping the fee",
    async (stage) => {
      const { contract, ctx } = await deployPaired();
      const unsent =
        stage === "queued"
          ? (await startTronSupply(contract, ctx, VALID_TRON_SUPPLY)).context
          : (await flushedTronSupply(contract, ctx, VALID_TRON_SUPPLY)).context;
      const closed = atBlockTime(unsent, SEND_CLOSED_TIME);
      const refunded = (
        await contract.circuits.refundUnsentTronSupply(
          closed,
          VALID_TRON_SUPPLY.inIndex,
          MINT_NONCE,
        )
      ).context;
      expect(shieldedMintsSince(closed, refunded)).toEqual([[USDT_MINT_KEY, SUPPLY_AMOUNT]]);
      expect(
        coinsMinted(closed, refunded).map(({ coinInfo, recipient }) => [
          coinInfo,
          recipient.left.bytes,
        ]),
      ).toEqual([
        [{ nonce: MINT_NONCE, color: USDT_COLOR, value: SUPPLY_AMOUNT }, hexToBytes(CPK)],
      ]);
      const state = ledgerOf(refunded);
      expect(state.inputRequestBuffer.isEmpty()).toBe(true);
      expect(state.outputRequestBuffer.isEmpty()).toBe(true);
      expect(state.tronSupplyArgsMap.isEmpty()).toBe(true);
      expect(state.bidirectionalTronSupplyMap.isEmpty()).toBe(true);
    },
  );

  it("re-mints a shifted underlying's amount in its colour", async () => {
    const { contract, ctx } = await deployPaired(NANO_PAIR);
    const { context: flushed } = await flushedTronSupply(contract, ctx, VALID_NANO_SUPPLY);
    const closed = atBlockTime(flushed, SEND_CLOSED_TIME);
    const refunded = (
      await contract.circuits.refundUnsentTronSupply(closed, VALID_NANO_SUPPLY.inIndex, MINT_NONCE)
    ).context;
    expect(coinsMinted(closed, refunded).map(({ coinInfo }) => coinInfo)).toEqual([
      { nonce: MINT_NONCE, color: NANO_COLOR, value: SUPPLY_AMOUNT },
    ]);
  });

  it.each(["queued", "flushed"] as const)(
    "refuses a %s supply in the last block time a send is admitted",
    async (stage) => {
      const { contract, ctx } = await deployPaired();
      const unsent =
        stage === "queued"
          ? (await startTronSupply(contract, ctx, VALID_TRON_SUPPLY)).context
          : (await flushedTronSupply(contract, ctx, VALID_TRON_SUPPLY)).context;
      await expect(
        contract.circuits.refundUnsentTronSupply(
          atBlockTime(unsent, LAST_SEND_TIME),
          VALID_TRON_SUPPLY.inIndex,
          MINT_NONCE,
        ),
      ).rejects.toThrow(/Tron request can still be sent/);
    },
  );

  it.each(["queued", "flushed"] as const)(
    "refuses a caller other than the supplier of a %s supply",
    async (stage) => {
      const { contract, ctx } = await deployPaired();
      const unsent =
        stage === "queued"
          ? (await startTronSupply(contract, ctx, VALID_TRON_SUPPLY)).context
          : (await flushedTronSupply(contract, ctx, VALID_TRON_SUPPLY)).context;
      await expect(
        contract.circuits.refundUnsentTronSupply(
          atBlockTime(unsent, SEND_CLOSED_TIME, OTHER_SECRET_KEY),
          VALID_TRON_SUPPLY.inIndex,
          MINT_NONCE,
        ),
      ).rejects.toThrow(/Not the requester/);
    },
  );

  it("refuses a supply sent in the last block time a send is admitted", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: flushed, outIndex } = await flushedTronSupply(
      contract,
      ctx,
      VALID_TRON_SUPPLY,
    );
    const sent = (
      await contract.circuits.sendTronSupply(atBlockTime(flushed, LAST_SEND_TIME), outIndex)
    ).context;
    await expect(
      contract.circuits.refundUnsentTronSupply(
        atBlockTime(sent, SEND_CLOSED_TIME),
        VALID_TRON_SUPPLY.inIndex,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Request already sent/);
  });

  it("refunds once", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: flushed } = await flushedTronSupply(contract, ctx, VALID_TRON_SUPPLY);
    const refunded = (
      await contract.circuits.refundUnsentTronSupply(
        atBlockTime(flushed, SEND_CLOSED_TIME),
        VALID_TRON_SUPPLY.inIndex,
        MINT_NONCE,
      )
    ).context;
    await expect(
      contract.circuits.refundUnsentTronSupply(
        atBlockTime(refunded, SEND_CLOSED_TIME),
        VALID_TRON_SUPPLY.inIndex,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Tron supply not open/);
  });
});

describe("startTronRedeem", () => {
  it("queues a Tron entry with the redeemer's window and the redeem fee limit", async () => {
    const { contract, ctx } = await deployPaired();
    const started = (await startTronRedeem(contract, ctx, VALID_TRON_REDEEM)).context;
    const state = ledgerOf(started);
    expect(state.inputRequestBuffer.lookup(VALID_TRON_REDEEM.inIndex)).toEqual({
      action: Action.tronRedeem,
      chain: Chain.tron,
      useNextVaultAccountNonce: false,
      evmNonce: 0n,
      inIndex: VALID_TRON_REDEEM.inIndex,
      commitment: pureCircuits.ownershipCommitment(VALID_TRON_REDEEM.inIndex, SECRET_KEY),
      argsHash: expect.any(Uint8Array) as Uint8Array,
    });
    expect(state.tronRedeemArgsMap.lookup(VALID_TRON_REDEEM.inIndex)).toEqual({
      request: VALID_TRON_REDEEM.redeem,
      tx: { ...TRON_WINDOW, feeLimit: DEFAULT_TRON_FEE_LIMITS.redeem },
      binding: pureCircuits.ownershipCommitment(VALID_TRON_REDEEM.inIndex, SECRET_KEY),
    });
  });

  it("burns the share coin, shares plus fee, and mints the fee in the share colour", async () => {
    const { contract, ctx } = await deployPaired();
    const started = (await startTronRedeem(contract, ctx, VALID_TRON_REDEEM)).context;
    const { burn, fee } = burnAndFee(started);
    expect(burn.color).toEqual(SHARE_COLOR);
    expect(burn.value).toBe(SUPPLY_SHARE_UNITS + SHARE_FEES.redeem);
    expect(fee).toEqual({
      nonce: pureCircuits.feeMintNonce(VALID_TRON_REDEEM.coin.nonce),
      color: SHARE_COLOR,
      value: SHARE_FEES.redeem,
    });
  });

  it("snapshots the redeem fee limit setGasParams last set", async () => {
    const { contract, ctx } = await deployPaired();
    const reconfigured = (
      await contract.circuits.setGasParams(
        ctx,
        1n,
        1n,
        1n,
        1n,
        1n,
        1n,
        1n,
        DISTINCT_TRON_FEE_LIMITS,
      )
    ).context;
    const started = (await startTronRedeem(contract, reconfigured, VALID_TRON_REDEEM)).context;
    expect(ledgerOf(started).tronRedeemArgsMap.lookup(VALID_TRON_REDEEM.inIndex).tx.feeLimit).toBe(
      DISTINCT_TRON_FEE_LIMITS.redeem,
    );
  });

  it.each([
    [
      "zero shares",
      { redeem: { shares: 0n }, coin: vaultCoin(SHARE_FEES.redeem, SHARE_COLOR) },
      /shares must be positive/,
    ],
    [
      "shares past Uint<64>",
      {
        redeem: { shares: UINT64_MAX + 1n },
        coin: vaultCoin(UINT64_MAX + 1n + SHARE_FEES.redeem, SHARE_COLOR),
      },
      /shares exceeds Uint<64> max/,
    ],
    [
      "an underlying coin",
      { coin: vaultCoin(SUPPLY_SHARE_UNITS + SHARE_FEES.redeem, USDT_COLOR) },
      /Coin is not the vault token for the share token/,
    ],
    [
      "a share coin in the share token's unshifted colour",
      {
        coin: vaultCoin(
          SUPPLY_SHARE_UNITS + SHARE_FEES.redeem,
          colourOf(pureCircuits.vaultTronTokenDomainSeparator(SHARE_TOKEN)),
        ),
      },
      /Coin is not the vault token for the share token/,
    ],
    [
      "a coin without the fee",
      { coin: vaultCoin(SUPPLY_SHARE_UNITS, SHARE_COLOR) },
      /Coin value must equal shares plus fee/,
    ],
    [
      "a window one second too short",
      { tronTx: { ...TRON_WINDOW, expiration: ms(NOW + START_MIN_REMAINING, 999) } },
      /too close/,
    ],
    [
      "a timestamp past int64",
      { tronTx: { ...TRON_WINDOW, timestamp: INT64_MAX + 1n, expiration: INT64_MAX + 2n } },
      /Tron timestamp exceeds int64/,
    ],
  ] as const)("refuses %s", async (_name, delta: Partial<TronRedeemCallArgs>, error) => {
    const { contract, ctx } = await deployPaired();
    await expect(
      startTronRedeem(contract, ctx, { ...VALID_TRON_REDEEM, ...delta }),
    ).rejects.toThrow(error);
  });

  it("refuses before the pair is set", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(startTronRedeem(contract, ctx, VALID_TRON_REDEEM)).rejects.toThrow(
      /Tron lend pair not set/,
    );
  });

  it("refuses an index a flushed Tron redeem still holds", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: flushed } = await flushedTronRedeem(contract, ctx, VALID_TRON_REDEEM);
    await expect(
      startTronRedeem(contract, flushed, {
        ...VALID_TRON_REDEEM,
        tronTx: { ...TRON_WINDOW, timestamp: ms(NOW - 6) },
      }),
    ).rejects.toThrow(/Index already in use/);
  });
});

// redeem(uint256,address,address) and its assets output schema.
const REDEEM_SELECTOR = new Uint8Array([0xba, 0x08, 0x76, 0x52]);
const REDEEM_OUTPUT_SCHEMA = new TextEncoder().encode('[{"name":"assets","type":"uint256"}]');

// Every start binds its Tron transaction to the requester's ownership commitment, so a copy
// of a public start (same amount and window, another requester or another index) names its
// own Tron transaction: it can neither hold the original at the flush nor share its request
// id, and the original settles or refunds as if the copy were not there.
describe("Tron lend copies", () => {
  const COPY_INDEX = 31n;
  const COPY_COIN_NONCE = bytes(32, 0x0d);

  it("gives a stranger's supply copy its own request, so the original still settles", async () => {
    const { contract, ctx } = await deployPaired();
    const original = (await startTronSupply(contract, ctx, VALID_TRON_SUPPLY)).context;
    const copied = (
      await startTronSupply(contract, stranger(original), {
        ...VALID_TRON_SUPPLY,
        inIndex: COPY_INDEX,
        coin: { ...VALID_TRON_SUPPLY.coin, nonce: COPY_COIN_NONCE },
      })
    ).context;
    const copyOut = queuedRequestIndex(ledgerOf(copied), COPY_INDEX);
    const originalOut = queuedRequestIndex(ledgerOf(copied), VALID_TRON_SUPPLY.inIndex);
    expect(bytesToHex(copyOut)).not.toBe(bytesToHex(originalOut));

    const copyFlushed = await flush(contract, copied, [COPY_INDEX], []);
    const copySent = (await contract.circuits.sendTronSupply(copyFlushed, copyOut)).context;
    const copyId = first(
      newIds(
        ledgerOf(copyFlushed).bidirectionalTronSupplyMap,
        ledgerOf(copySent).bidirectionalTronSupplyMap,
      ),
      "copy request",
    );
    const copyAttested = await attest(
      contract,
      copySent,
      respond(copyId, OutputKind.executed, sharesOutput(SUPPLY_SHARES), TRON_ATTESTED_HEIGHT),
    );
    const copySettled = (
      await contract.circuits.completeTronSupply(
        stranger(copyAttested),
        copyId,
        sharesOutput(SUPPLY_SHARES),
        MINT_NONCE,
      )
    ).context;

    const flushed = await flush(
      contract,
      atBlockTime(copySettled, NOW),
      [VALID_TRON_SUPPLY.inIndex],
      [],
    );
    const sent = (await contract.circuits.sendTronSupply(flushed, originalOut)).context;
    const requestId = first(
      newIds(
        ledgerOf(flushed).bidirectionalTronSupplyMap,
        ledgerOf(sent).bidirectionalTronSupplyMap,
      ),
      "original request",
    );
    expect(bytesToHex(requestId)).not.toBe(bytesToHex(copyId));
    const attested = await attest(
      contract,
      sent,
      respond(
        requestId,
        OutputKind.executed,
        sharesOutput(SUPPLY_SHARES),
        TRON_ATTESTED_HEIGHT + 1n,
      ),
    );
    const settled = (
      await contract.circuits.completeTronSupply(
        attested,
        requestId,
        sharesOutput(SUPPLY_SHARES),
        MINT_NONCE,
      )
    ).context;
    expect(shieldedMintsSince(attested, settled)).toEqual([[SHARE_MINT_KEY, SUPPLY_SHARE_UNITS]]);
  });

  it("refunds an unsent supply while a stranger's sent copy stays unsettled", async () => {
    const { contract, ctx } = await deployPaired();
    const original = (await startTronSupply(contract, ctx, VALID_TRON_SUPPLY)).context;
    const copied = (
      await startTronSupply(contract, stranger(original), {
        ...VALID_TRON_SUPPLY,
        inIndex: COPY_INDEX,
        coin: { ...VALID_TRON_SUPPLY.coin, nonce: COPY_COIN_NONCE },
      })
    ).context;
    const copyOut = queuedRequestIndex(ledgerOf(copied), COPY_INDEX);
    const copyFlushed = await flush(contract, copied, [COPY_INDEX], []);
    const held = (await contract.circuits.sendTronSupply(copyFlushed, copyOut)).context;

    const flushed = await flush(contract, held, [VALID_TRON_SUPPLY.inIndex], []);
    const closed = atBlockTime(flushed, SEND_CLOSED_TIME);
    const refunded = (
      await contract.circuits.refundUnsentTronSupply(closed, VALID_TRON_SUPPLY.inIndex, MINT_NONCE)
    ).context;
    expect(shieldedMintsSince(closed, refunded)).toEqual([[USDT_MINT_KEY, SUPPLY_AMOUNT]]);
  });

  it("gives a stranger's redeem copy its own request, so the original still settles", async () => {
    const { contract, ctx } = await deployPaired();
    const original = (await startTronRedeem(contract, ctx, VALID_TRON_REDEEM)).context;
    const copied = (
      await startTronRedeem(contract, stranger(original), {
        ...VALID_TRON_REDEEM,
        inIndex: COPY_INDEX,
        coin: { ...VALID_TRON_REDEEM.coin, nonce: COPY_COIN_NONCE },
      })
    ).context;
    const copyOut = queuedRequestIndex(ledgerOf(copied), COPY_INDEX);
    const originalOut = queuedRequestIndex(ledgerOf(copied), VALID_TRON_REDEEM.inIndex);
    expect(bytesToHex(copyOut)).not.toBe(bytesToHex(originalOut));

    const copyFlushed = await flush(contract, copied, [COPY_INDEX], []);
    const copySent = (await contract.circuits.sendTronRedeem(copyFlushed, copyOut)).context;
    const copyId = first(
      newIds(
        ledgerOf(copyFlushed).bidirectionalTronRedeemMap,
        ledgerOf(copySent).bidirectionalTronRedeemMap,
      ),
      "copy request",
    );
    const copyAttested = await attest(
      contract,
      copySent,
      respond(copyId, OutputKind.executed, assetsOutput(SUPPLY_AMOUNT), TRON_ATTESTED_HEIGHT),
    );
    const copySettled = (
      await contract.circuits.completeTronRedeem(
        stranger(copyAttested),
        copyId,
        assetsOutput(SUPPLY_AMOUNT),
        MINT_NONCE,
      )
    ).context;

    const flushed = await flush(
      contract,
      atBlockTime(copySettled, NOW),
      [VALID_TRON_REDEEM.inIndex],
      [],
    );
    const sent = (await contract.circuits.sendTronRedeem(flushed, originalOut)).context;
    const requestId = first(
      newIds(
        ledgerOf(flushed).bidirectionalTronRedeemMap,
        ledgerOf(sent).bidirectionalTronRedeemMap,
      ),
      "original request",
    );
    expect(bytesToHex(requestId)).not.toBe(bytesToHex(copyId));
    const attested = await attest(
      contract,
      sent,
      respond(
        requestId,
        OutputKind.executed,
        assetsOutput(SUPPLY_AMOUNT),
        TRON_ATTESTED_HEIGHT + 1n,
      ),
    );
    const settled = (
      await contract.circuits.completeTronRedeem(
        attested,
        requestId,
        assetsOutput(SUPPLY_AMOUNT),
        MINT_NONCE,
      )
    ).context;
    expect(shieldedMintsSince(attested, settled)).toEqual([[USDT_MINT_KEY, SUPPLY_AMOUNT]]);
  });

  it("refunds an unsent redeem while a stranger's sent copy stays unsettled", async () => {
    const { contract, ctx } = await deployPaired();
    const original = (await startTronRedeem(contract, ctx, VALID_TRON_REDEEM)).context;
    const copied = (
      await startTronRedeem(contract, stranger(original), {
        ...VALID_TRON_REDEEM,
        inIndex: COPY_INDEX,
        coin: { ...VALID_TRON_REDEEM.coin, nonce: COPY_COIN_NONCE },
      })
    ).context;
    const copyOut = queuedRequestIndex(ledgerOf(copied), COPY_INDEX);
    const copyFlushed = await flush(contract, copied, [COPY_INDEX], []);
    const held = (await contract.circuits.sendTronRedeem(copyFlushed, copyOut)).context;

    const flushed = await flush(contract, held, [VALID_TRON_REDEEM.inIndex], []);
    const closed = atBlockTime(flushed, SEND_CLOSED_TIME);
    const refunded = (
      await contract.circuits.refundUnsentTronRedeem(closed, VALID_TRON_REDEEM.inIndex, MINT_NONCE)
    ).context;
    expect(shieldedMintsSince(closed, refunded)).toEqual([[SHARE_MINT_KEY, SUPPLY_SHARE_UNITS]]);
  });

  it("gives one requester's repriced second supply its own Tron transaction", async () => {
    const { contract, ctx } = await deployPaired();
    const firstStarted = (await startTronSupply(contract, ctx, VALID_TRON_SUPPLY)).context;
    const repricedFee = USDT_FEES.supply + 1n;
    const repriced = (
      await contract.circuits.setTronTokenFees(firstStarted, TRON_USDT, {
        ...USDT_FEES,
        supply: repricedFee,
      })
    ).context;
    const secondStarted = (
      await startTronSupply(contract, repriced, {
        ...VALID_TRON_SUPPLY,
        inIndex: COPY_INDEX,
        coin: { ...vaultCoin(SUPPLY_AMOUNT + repricedFee, USDT_COLOR), nonce: COPY_COIN_NONCE },
      })
    ).context;
    const firstOut = queuedRequestIndex(ledgerOf(secondStarted), VALID_TRON_SUPPLY.inIndex);
    const secondOut = queuedRequestIndex(ledgerOf(secondStarted), COPY_INDEX);
    const flushed = await flush(
      contract,
      secondStarted,
      [VALID_TRON_SUPPLY.inIndex, COPY_INDEX],
      [],
    );
    const firstSent = (await contract.circuits.sendTronSupply(flushed, firstOut)).context;
    const bothSent = (await contract.circuits.sendTronSupply(firstSent, secondOut)).context;
    expect(
      newIds(
        ledgerOf(flushed).bidirectionalTronSupplyMap,
        ledgerOf(bothSent).bidirectionalTronSupplyMap,
      ),
    ).toHaveLength(2);
  });
});

describe("sendTronRedeem", () => {
  it("redeems the shares in base units from and to the vault, notifying the MPC", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: flushed, outIndex } = await flushedTronRedeem(
      contract,
      ctx,
      VALID_TRON_REDEEM,
    );
    const sent = (await contract.circuits.sendTronRedeem(flushed, outIndex)).context;
    const state = sent.callContext.currentQueryContext.state;

    const raw = readSignetRequestsLedgerFromState(state, VAULT_TRON_REDEEM_REQUESTS_PATH);
    expect(raw.requestsIndex.size).toBe(1);
    const [idHex, record] = first(raw.requestsIndex.entries(), "Tron redeem record");
    if (!isTronRequest(record)) throw new Error("expected a Tron record");
    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));
    expect(record.sender).toEqual({ bytes: VAULT_ADDRESS_BYTES });
    expect(record.path).toEqual(asciiPadded("vault", 32));
    expect(record.txParamType).toBe(TxParamType.tronTriggerSmartContract);
    expect(record.outputDeserializationSchema).toEqual(REDEEM_OUTPUT_SCHEMA);
    expect(record.txParams).toEqual({
      ...TRON_WINDOW,
      feeLimit: DEFAULT_TRON_FEE_LIMITS.redeem,
      contractAddress: Uint8Array.of(0x41, ...SHARE_TOKEN),
      callValue: 0n,
      calldata: {
        is_some: true,
        value: {
          selector: REDEEM_SELECTOR,
          noWords: 4n,
          words: [
            numericAbiWord(SUPPLY_SHARE_UNITS * SHARE_FACTOR),
            evmAddressAbiWord(VAULT_EVM),
            evmAddressAbiWord(VAULT_EVM),
            pureCircuits.ownershipCommitment(VALID_TRON_REDEEM.inIndex, SECRET_KEY),
          ],
        },
      },
    });

    const notification = first(decodeSignetLogEvents(sent.events, SIGNET_ADDRESS), "notification");
    const post = decodeSignBidirectionalEventNotificationPayload(notification.payload);
    expect(requestIdHex(post.requestId)).toBe(idHex);
    expect(decodeSignBidirectionalNotification(post.event)).toEqual({
      version: 1,
      callerAddress: bytesToHex(VAULT_ADDRESS_BYTES),
      requestsPath: [3, 13],
    });
  });

  it("is permissionless and refuses a second send", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: flushed, outIndex } = await flushedTronRedeem(
      contract,
      ctx,
      VALID_TRON_REDEEM,
    );
    const sent = (await contract.circuits.sendTronRedeem(stranger(flushed), outIndex)).context;
    expect(ledgerOf(sent).bidirectionalTronRedeemMap.size()).toBe(1n);
    await expect(contract.circuits.sendTronRedeem(sent, outIndex)).rejects.toThrow(
      /Request already sent/,
    );
  });

  it("refuses another action's flushed entry", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: flushed, outIndex } = await flushedTronSupply(
      contract,
      ctx,
      VALID_TRON_SUPPLY,
    );
    await expect(contract.circuits.sendTronRedeem(flushed, outIndex)).rejects.toThrow(
      /Wrong action/,
    );
  });

  it("refuses a send inside the send margin", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: flushed, outIndex } = await flushedTronRedeem(
      contract,
      ctx,
      VALID_TRON_REDEEM,
    );
    await expect(
      contract.circuits.sendTronRedeem(atBlockTime(flushed, SEND_CLOSED_TIME), outIndex),
    ).rejects.toThrow(/too close/);
  });
});

// An executed redeem mints floor(assets / underlying factor) underlying coin units.
const REDEEM_EXECUTED_CASES = [
  {
    name: "Tron USDT's assets mint unchanged",
    pair: USDT_PAIR,
    assets: 100_712_345n,
    minted: 100_712_345n,
  },
  {
    name: "a shifted underlying's assets floor to whole coin units",
    pair: NANO_PAIR,
    assets: 100_712_345_999n,
    minted: 100_712_345n,
  },
  {
    name: "a shifted underlying's exact multiple mints it whole",
    pair: NANO_PAIR,
    assets: 100_712_345_000n,
    minted: 100_712_345n,
  },
] as const;

describe("completeTronRedeem", () => {
  it.each(REDEEM_EXECUTED_CASES)(
    "executed: $name, to the redeemer, and consumes the request",
    async ({ pair, assets, minted }) => {
      const { contract, ctx } = await deployPaired(pair);
      const { context: sent, requestId } = await sentTronRedeem(contract, ctx, VALID_TRON_REDEEM);
      const attested = await attest(
        contract,
        sent,
        respond(requestId, OutputKind.executed, assetsOutput(assets), TRON_ATTESTED_HEIGHT),
      );
      const settled = (
        await contract.circuits.completeTronRedeem(
          attested,
          requestId,
          assetsOutput(assets),
          MINT_NONCE,
        )
      ).context;
      expect(
        coinsMinted(attested, settled).map(({ coinInfo, recipient }) => [
          coinInfo,
          recipient.left.bytes,
        ]),
      ).toEqual([[{ nonce: MINT_NONCE, color: pair.colour, value: minted }, hexToBytes(CPK)]]);
      const state = ledgerOf(settled);
      expect(state.bidirectionalTronRedeemMap.isEmpty()).toBe(true);
      expect(state.tronRedeemArgsMap.isEmpty()).toBe(true);
      expect(state.outputRequestBuffer.isEmpty()).toBe(true);
      expect(state.evictionMap.isEmpty()).toBe(true);
    },
  );

  it.each([OutputKind.failed, OutputKind.unviable])(
    "re-mints the shares, never the fee, on verdict %s",
    async (outputKind) => {
      const { contract, ctx } = await deployPaired();
      const { context: sent, requestId } = await sentTronRedeem(contract, ctx, VALID_TRON_REDEEM);
      const attested = await attest(
        contract,
        sent,
        respond(requestId, outputKind, OUTPUT_EMPTY, TRON_ATTESTED_HEIGHT),
      );
      const settled = (
        await contract.circuits.completeTronRedeem(attested, requestId, OUTPUT_IGNORED, MINT_NONCE)
      ).context;
      expect(shieldedMintsSince(attested, settled)).toEqual([[SHARE_MINT_KEY, SUPPLY_SHARE_UNITS]]);
      expect(coinsMinted(attested, settled).map(({ coinInfo }) => coinInfo)).toEqual([
        { nonce: MINT_NONCE, color: SHARE_COLOR, value: SUPPLY_SHARE_UNITS },
      ]);
    },
  );

  it.each([
    ["Tron USDT", USDT_PAIR, 100_712_345n, 1n, /Quotient too large/],
    ["Tron USDT", USDT_PAIR, 100_712_345n, -1n, /Quotient too small/],
    ["a shifted underlying", NANO_PAIR, 100_712_345_999n, 1n, /Quotient too large/],
    ["a shifted underlying", NANO_PAIR, 100_712_345_999n, -1n, /Quotient too small/],
  ] as const)(
    "refuses a %s witness off the floor quotient by %s",
    async (_name, pair, assets, offset, error) => {
      const { contract, ctx } = await deployPaired(pair);
      const { context: sent, requestId } = await sentTronRedeem(contract, ctx, VALID_TRON_REDEEM);
      const attested = await attest(
        contract,
        sent,
        respond(requestId, OutputKind.executed, assetsOutput(assets), TRON_ATTESTED_HEIGHT),
      );
      await expect(
        offsetQuotient(offset).circuits.completeTronRedeem(
          attested,
          requestId,
          assetsOutput(assets),
          MINT_NONCE,
        ),
      ).rejects.toThrow(error);
    },
  );

  it("refuses a presented output other than attested", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: sent, requestId } = await sentTronRedeem(contract, ctx, VALID_TRON_REDEEM);
    const attested = await attest(
      contract,
      sent,
      respond(requestId, OutputKind.executed, assetsOutput(100_712_345n), TRON_ATTESTED_HEIGHT),
    );
    await expect(
      contract.circuits.completeTronRedeem(
        attested,
        requestId,
        assetsOutput(100_712_346n),
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Output does not match the attestation/);
  });

  it.each([
    [
      "at 2^128 assets",
      USDT_PAIR,
      1n << 128n,
      /exceeds maximum value 340282366920938463463374607431768211455/,
    ],
    ["at the uint256 maximum", USDT_PAIR, (1n << 256n) - 1n, /Value exceeds Uint<128>/],
    [
      "whose underlying units reach 2^64",
      NANO_PAIR,
      (UINT64_MAX + 1n) * NANO_FACTOR,
      /unitsOfBase return value .* expected value of type Uint<0\.\.18446744073709551616>/,
    ],
  ] as const)("cannot settle an executed redeem %s", async (_name, pair, assets, error) => {
    const { contract, ctx } = await deployPaired(pair);
    const { context: sent, requestId } = await sentTronRedeem(contract, ctx, VALID_TRON_REDEEM);
    const attested = await attest(
      contract,
      sent,
      respond(requestId, OutputKind.executed, assetsOutput(assets), TRON_ATTESTED_HEIGHT),
    );
    await expect(
      contract.circuits.completeTronRedeem(attested, requestId, assetsOutput(assets), MINT_NONCE),
    ).rejects.toThrow(error);
  });

  it("refuses a caller other than the redeemer", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: sent, requestId } = await sentTronRedeem(contract, ctx, VALID_TRON_REDEEM);
    const attested = await attest(
      contract,
      sent,
      respond(requestId, OutputKind.failed, OUTPUT_EMPTY, TRON_ATTESTED_HEIGHT),
    );
    await expect(
      contract.circuits.completeTronRedeem(
        stranger(attested),
        requestId,
        OUTPUT_IGNORED,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Not the requester/);
  });

  // Supply 100 USDT, then redeem every share coin unit it minted: the redeem burns those
  // units and asks the share token for units·10^12 shares.
  it("redeems the share coins a supply minted", async () => {
    const { contract, ctx } = await deployPaired();
    const supply = await sentTronSupply(contract, ctx, VALID_TRON_SUPPLY);
    const supplyAttested = await attest(
      contract,
      supply.context,
      respond(
        supply.requestId,
        OutputKind.executed,
        sharesOutput(SUPPLY_SHARES),
        TRON_ATTESTED_HEIGHT,
      ),
    );
    const supplied = (
      await contract.circuits.completeTronSupply(
        supplyAttested,
        supply.requestId,
        sharesOutput(SUPPLY_SHARES),
        MINT_NONCE,
      )
    ).context;
    const coin = first(coinsMinted(supplyAttested, supplied), "share coin").coinInfo;
    const shares = SUPPLY_SHARE_UNITS - SHARE_FEES.redeem;
    const redeem = await sentTronRedeem(contract, supplied, {
      ...VALID_TRON_REDEEM,
      redeem: { shares },
      coin,
    });
    const [, event] = first(ledgerOf(redeem.context).bidirectionalTronRedeemMap, "Tron redeem");
    expect(event.txParams.calldata.value.words).toEqual([
      numericAbiWord(shares * SHARE_FACTOR),
      evmAddressAbiWord(VAULT_EVM),
      evmAddressAbiWord(VAULT_EVM),
      pureCircuits.ownershipCommitment(VALID_TRON_REDEEM.inIndex, SECRET_KEY),
    ]);
  });
});

describe("refundUnsentTronRedeem", () => {
  it.each(["queued", "flushed"] as const)(
    "re-mints the shares of a %s redeem once sends are refused, keeping the fee",
    async (stage) => {
      const { contract, ctx } = await deployPaired();
      const unsent =
        stage === "queued"
          ? (await startTronRedeem(contract, ctx, VALID_TRON_REDEEM)).context
          : (await flushedTronRedeem(contract, ctx, VALID_TRON_REDEEM)).context;
      const closed = atBlockTime(unsent, SEND_CLOSED_TIME);
      const refunded = (
        await contract.circuits.refundUnsentTronRedeem(
          closed,
          VALID_TRON_REDEEM.inIndex,
          MINT_NONCE,
        )
      ).context;
      expect(shieldedMintsSince(closed, refunded)).toEqual([[SHARE_MINT_KEY, SUPPLY_SHARE_UNITS]]);
      expect(
        coinsMinted(closed, refunded).map(({ coinInfo, recipient }) => [
          coinInfo,
          recipient.left.bytes,
        ]),
      ).toEqual([
        [{ nonce: MINT_NONCE, color: SHARE_COLOR, value: SUPPLY_SHARE_UNITS }, hexToBytes(CPK)],
      ]);
      const state = ledgerOf(refunded);
      expect(state.inputRequestBuffer.isEmpty()).toBe(true);
      expect(state.outputRequestBuffer.isEmpty()).toBe(true);
      expect(state.tronRedeemArgsMap.isEmpty()).toBe(true);
    },
  );

  it.each(["queued", "flushed"] as const)(
    "refuses a %s redeem in the last block time a send is admitted",
    async (stage) => {
      const { contract, ctx } = await deployPaired();
      const unsent =
        stage === "queued"
          ? (await startTronRedeem(contract, ctx, VALID_TRON_REDEEM)).context
          : (await flushedTronRedeem(contract, ctx, VALID_TRON_REDEEM)).context;
      await expect(
        contract.circuits.refundUnsentTronRedeem(
          atBlockTime(unsent, LAST_SEND_TIME),
          VALID_TRON_REDEEM.inIndex,
          MINT_NONCE,
        ),
      ).rejects.toThrow(/Tron request can still be sent/);
    },
  );

  it.each(["queued", "flushed"] as const)(
    "refuses a caller other than the redeemer of a %s redeem",
    async (stage) => {
      const { contract, ctx } = await deployPaired();
      const unsent =
        stage === "queued"
          ? (await startTronRedeem(contract, ctx, VALID_TRON_REDEEM)).context
          : (await flushedTronRedeem(contract, ctx, VALID_TRON_REDEEM)).context;
      await expect(
        contract.circuits.refundUnsentTronRedeem(
          atBlockTime(unsent, SEND_CLOSED_TIME, OTHER_SECRET_KEY),
          VALID_TRON_REDEEM.inIndex,
          MINT_NONCE,
        ),
      ).rejects.toThrow(/Not the requester/);
    },
  );

  it("refuses a redeem sent in the last block time a send is admitted", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: flushed, outIndex } = await flushedTronRedeem(
      contract,
      ctx,
      VALID_TRON_REDEEM,
    );
    const sent = (
      await contract.circuits.sendTronRedeem(atBlockTime(flushed, LAST_SEND_TIME), outIndex)
    ).context;
    await expect(
      contract.circuits.refundUnsentTronRedeem(
        atBlockTime(sent, SEND_CLOSED_TIME),
        VALID_TRON_REDEEM.inIndex,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Request already sent/);
  });

  it("refunds once", async () => {
    const { contract, ctx } = await deployPaired();
    const { context: flushed } = await flushedTronRedeem(contract, ctx, VALID_TRON_REDEEM);
    const refunded = (
      await contract.circuits.refundUnsentTronRedeem(
        atBlockTime(flushed, SEND_CLOSED_TIME),
        VALID_TRON_REDEEM.inIndex,
        MINT_NONCE,
      )
    ).context;
    await expect(
      contract.circuits.refundUnsentTronRedeem(
        atBlockTime(refunded, SEND_CLOSED_TIME),
        VALID_TRON_REDEEM.inIndex,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Tron redeem not open/);
  });
});

describe("Tron lend attestations", () => {
  it.each([
    ["at the Tron height the flush recorded", TRON_START_HEIGHT],
    ["at an EVM height", EVM_ATTESTED_HEIGHT],
  ] as const)("refuses a supply attestation %s as stale", async (_name, height) => {
    const { contract, ctx } = await deployPaired();
    const { context: sent, requestId } = await sentTronSupply(contract, ctx, VALID_TRON_SUPPLY);
    await expect(
      contract.circuits.queueAttestation(
        sent,
        respond(requestId, OutputKind.executed, sharesOutput(SUPPLY_SHARES), height),
      ),
    ).rejects.toThrow(/Stale attestation/);
  });

  it.each([
    "completeTronRedeem",
    "completeTronApprove",
    "completeTronWithdraw",
    "completeSupply",
  ] as const)("%s refuses a Tron supply's request id", async (circuit) => {
    const { contract, ctx } = await deployPaired();
    const { context: sent, requestId } = await sentTronSupply(contract, ctx, VALID_TRON_SUPPLY);
    const attested = await attest(
      contract,
      sent,
      respond(requestId, OutputKind.failed, OUTPUT_EMPTY, TRON_ATTESTED_HEIGHT),
    );
    const call =
      circuit === "completeTronRedeem"
        ? contract.circuits.completeTronRedeem(attested, requestId, OUTPUT_IGNORED, MINT_NONCE)
        : circuit === "completeTronApprove"
          ? contract.circuits.completeTronApprove(attested, requestId, OUTPUT_IGNORED_BOOL)
          : circuit === "completeTronWithdraw"
            ? contract.circuits.completeTronWithdraw(
                attested,
                requestId,
                OUTPUT_IGNORED_BOOL,
                MINT_NONCE,
              )
            : contract.circuits.completeSupply(attested, requestId, OUTPUT_IGNORED, MINT_NONCE);
    await expect(call).rejects.toThrow(/Wrong action/);
  });

  it.each(["completeTronSupply", "completeTronRedeem"] as const)(
    "%s refuses a Tron withdrawal's request id",
    async (circuit) => {
      const { contract, ctx } = await deployPaired();
      const started = (
        await contract.circuits.startTronWithdraw(
          ctx,
          30n,
          { tokenAddress: TRON_USDT, amount: SUPPLY_AMOUNT, destTronAddress: DEST_TRON },
          TRON_WINDOW,
          vaultCoin(SUPPLY_AMOUNT + USDT_FEES.withdraw, USDT_COLOR),
        )
      ).context;
      const outIndex = queuedRequestIndex(ledgerOf(started), 30n);
      const flushed = await flush(contract, started, [30n], []);
      const sent = (await contract.circuits.sendTronWithdraw(flushed, outIndex)).context;
      const requestId = first(ledgerOf(sent).bidirectionalTronWithdrawMap, "Tron withdraw")[0];
      const attested = await attest(
        contract,
        sent,
        respond(requestId, OutputKind.failed, OUTPUT_EMPTY, TRON_ATTESTED_HEIGHT),
      );
      const call =
        circuit === "completeTronSupply"
          ? contract.circuits.completeTronSupply(attested, requestId, OUTPUT_IGNORED, MINT_NONCE)
          : contract.circuits.completeTronRedeem(attested, requestId, OUTPUT_IGNORED, MINT_NONCE);
      await expect(call).rejects.toThrow(/Wrong action/);
    },
  );

  // An Ethereum supply and a Tron supply settle interleaved: each attestation raises only
  // its own chain's height.
  it("Tron and EVM heights advance independently when supplies on both settle interleaved", async () => {
    const { contract, ctx } = await deployPaired();
    const tron = await sentTronSupply(contract, ctx, VALID_TRON_SUPPLY);
    const stataUnderlyingColour = colourOf(
      pureCircuits.vaultTokenDomainSeparator(STATA_UNDERLYING),
    );
    const evmStarted = (
      await contract.circuits.startSupply(
        tron.context,
        50n,
        { amount: SUPPLY_AMOUNT },
        vaultCoin(SUPPLY_AMOUNT, stataUnderlyingColour),
      )
    ).context;
    const evmFlushed = await flush(contract, evmStarted, [50n], []);
    const evmOutIndex = flushedRequestIndex(ledgerOf(evmFlushed), Action.supply, 50n);
    expect(ledgerOf(evmFlushed).outputRequestBuffer.lookup(evmOutIndex).lastSeen).toBe(
      EVM_START_HEIGHT,
    );
    const evmSent = (await contract.circuits.sendSupply(evmFlushed, evmOutIndex)).context;
    const evmId = first(ledgerOf(evmSent).bidirectionalSupplyMap, "EVM supply")[0];

    const tronAttested = await attest(
      contract,
      evmSent,
      respond(
        tron.requestId,
        OutputKind.executed,
        sharesOutput(SUPPLY_SHARES),
        TRON_ATTESTED_HEIGHT,
      ),
    );
    expect(ledgerOf(tronAttested).tronLastSeen).toBe(TRON_ATTESTED_HEIGHT);
    expect(ledgerOf(tronAttested).globalLastSeen).toBe(EVM_START_HEIGHT);
    const evmAttested = await attest(
      contract,
      tronAttested,
      respond(evmId, OutputKind.executed, sharesOutput(360_679n), EVM_ATTESTED_HEIGHT),
    );
    expect(ledgerOf(evmAttested).globalLastSeen).toBe(EVM_ATTESTED_HEIGHT);
    expect(ledgerOf(evmAttested).tronLastSeen).toBe(TRON_ATTESTED_HEIGHT);
    const evmSettled = (
      await contract.circuits.completeSupply(evmAttested, evmId, sharesOutput(360_679n), MINT_NONCE)
    ).context;
    const settled = (
      await contract.circuits.completeTronSupply(
        evmSettled,
        tron.requestId,
        sharesOutput(SUPPLY_SHARES),
        MINT_NONCE,
      )
    ).context;
    expect(new Map(shieldedMintsSince(evmAttested, settled))).toEqual(
      new Map([
        [bytesToHex(pureCircuits.vaultTokenDomainSeparator(STATA_TOKEN)), 360_679n],
        [SHARE_MINT_KEY, SUPPLY_SHARE_UNITS],
      ]),
    );

    // A Tron supply flushed now records the folded Tron height, not the EVM one.
    const next = await flushedTronSupply(contract, settled, {
      ...VALID_TRON_SUPPLY,
      inIndex: 60n,
      tronTx: { ...TRON_WINDOW, timestamp: ms(NOW - 7) },
    });
    expect(ledgerOf(next.context).outputRequestBuffer.lookup(next.outIndex).lastSeen).toBe(
      TRON_ATTESTED_HEIGHT,
    );
  });
});

describe("startReplaceNonce and the Tron lend actions", () => {
  /** A sent Tron approve, supply and redeem: the arrange step of every row below. */
  const sentLendRequests = async () => {
    const { contract, ctx } = await deployPaired();
    const approve = await sentTronApprove(contract, ctx);
    const supply = await sentTronSupply(contract, approve.context, VALID_TRON_SUPPLY);
    const redeem = await sentTronRedeem(contract, supply.context, VALID_TRON_REDEEM);
    const ids = new Map([
      [Action.tronApprove, approve.requestId],
      [Action.tronSupply, supply.requestId],
      [Action.tronRedeem, redeem.requestId],
    ]);
    return { contract, ctx: redeem.context, ids };
  };

  it.each([Action.tronApprove, Action.tronSupply, Action.tronRedeem])(
    "refuses action %s: a Tron request has no vault nonce",
    async (action) => {
      const { contract, ctx, ids } = await sentLendRequests();
      const requestId = ids.get(action);
      if (requestId === undefined) throw new Error(`no request id for action ${String(action)}`);
      await expect(
        contract.circuits.startReplaceNonce(ctx, 70n, requestId, action),
      ).rejects.toThrow(/Tron request has no vault nonce/);
    },
  );
});

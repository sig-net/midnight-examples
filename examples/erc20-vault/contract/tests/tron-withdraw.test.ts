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
  requestIdBytes,
  requestIdHex,
  type RespondBidirectionalEvent,
  respondBidirectionalEventToCircuitInput,
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
  VAULT_TRON_WITHDRAW_REQUESTS_PATH,
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
const ERC20 = bytes(20, 0xaa);
const TRC20 = bytes(20, 0x7a);
const UNLISTED_TRC20 = bytes(20, 0x99);
const TRON_USDT = bytes(20, 0x75);
const DEST_TRON = bytes(20, 0x77);
// An 18-decimal TRC-20 listed at a 10^12 shift (6-decimal coins), and a 12-decimal one at
// 10^6.
const SHIFTED_TRC20 = bytes(20, 0x5a);
const MICRO_SHIFTED_TRC20 = bytes(20, 0x6b);
const CHAIN_ID = 11155111n;
const NO_FEES = { withdraw: 0n, swap: 0n, supply: 0n, redeem: 0n };
const TRON_TOKEN_FEES = { withdraw: 71n, swap: 73n, supply: 79n, redeem: 83n };
const SHIFTED_TOKEN_FEES = { withdraw: 3n, swap: 5n, supply: 7n, redeem: 11n };
const UNSHIFTED = 1n;
const SHIFT_12 = 10n ** 12n;
const SHIFT_6 = 10n ** 6n;
const FEE_RECIPIENT_CPK = bytes(32, 0xfe);
const AMOUNT = 1_000_000n;
const UINT64_MAX = 18446744073709551615n;
const INT64_MAX = 9223372036854775807n;
const MINT_NONCE = bytes(32, 0x2e);
const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);
const VAULT_OUTPUT_SCHEMA = new TextEncoder().encode('[{"name":"success","type":"bool"}]');
const DEFAULT_TRON_FEE_LIMIT = 100_000_000n;
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

const colourOf = (domainSeparator: Uint8Array) =>
  hexToBytes(rawTokenType(domainSeparator, VAULT_ADDRESS));
const TRON_TOKEN_COLOR = colourOf(pureCircuits.vaultTronTokenDomainSeparator(TRC20));
const TRC20_MINT_KEY = bytesToHex(pureCircuits.vaultTronTokenDomainSeparator(TRC20));
const TRON_USDT_COLOR = colourOf(pureCircuits.vaultTronTokenDomainSeparator(TRON_USDT));
const SHIFTED_COLOR = colourOf(pureCircuits.tronCoinColour(SHIFTED_TRC20, SHIFT_12));
const ERC20_COLOR = colourOf(pureCircuits.vaultTokenDomainSeparator(ERC20));

const vaultCoin = (
  value: bigint,
  color: Uint8Array = TRON_TOKEN_COLOR,
): EncodedShieldedCoinInfo => ({
  nonce: bytes(32, 0x0c),
  color,
  value,
});

/** A Tron withdrawal's `startTronWithdraw` arguments, in circuit order. */
interface TronWithdrawCallArgs {
  inIndex: bigint;
  withdraw: { tokenAddress: Uint8Array; amount: bigint; destTronAddress: Uint8Array };
  tronTx: {
    refBlockBytes: Uint8Array;
    refBlockHash: Uint8Array;
    timestamp: bigint;
    expiration: bigint;
  };
  coin: EncodedShieldedCoinInfo;
}

/**
 * Known-good Tron withdraw call args, the base every test varies from: an hour-long window
 * opened five seconds before the block. NEVER mutate; spread with the delta inline.
 */
const VALID_TRON_WITHDRAW: TronWithdrawCallArgs = {
  inIndex: 21n,
  withdraw: { tokenAddress: TRC20, amount: AMOUNT, destTronAddress: DEST_TRON },
  tronTx: {
    refBlockBytes: Uint8Array.of(0x12, 0x34),
    refBlockHash: bytes(8, 0x56),
    timestamp: ms(NOW - 5),
    expiration: ms(NOW + 3600, 250),
  },
  coin: vaultCoin(AMOUNT + TRON_TOKEN_FEES.withdraw),
};

// VALID_TRON_WITHDRAW expires at h = NOW + 3600 whole seconds: sendTronWithdraw admits it
// below block time h - 60 and refuses it from h - 60 on, where the refund opens.
const LAST_SEND_TIME = NOW + 3600 - SEND_MIN_REMAINING - 1;
const SEND_CLOSED_TIME = NOW + 3600 - SEND_MIN_REMAINING;

const VALID_USDT_WITHDRAW: TronWithdrawCallArgs = {
  ...VALID_TRON_WITHDRAW,
  inIndex: 22n,
  withdraw: { ...VALID_TRON_WITHDRAW.withdraw, tokenAddress: TRON_USDT },
  coin: vaultCoin(AMOUNT, TRON_USDT_COLOR),
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
    circuitId: "startTronWithdraw",
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

const deployInitialised = async () => {
  const contract = new Contract<VaultPrivateState>(witnesses);
  const { currentContractState } = await contract.initialState(
    createConstructorContext<VaultPrivateState>(createVaultPrivateState(SECRET_KEY), CPK),
    DEPLOYER_COMMITMENT,
    { bytes: hexToBytes(SIGNET_ADDRESS) },
  );
  let next = (
    await contract.circuits.initialise(
      contextOf(currentContractState, SECRET_KEY, NOW),
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
  next = (await contract.circuits.addAllowedToken(next, ERC20, NO_FEES)).context;
  next = (await contract.circuits.addAllowedTronToken(next, TRC20, TRON_TOKEN_FEES, UNSHIFTED))
    .context;
  next = (await contract.circuits.addAllowedTronToken(next, TRON_USDT, NO_FEES, UNSHIFTED)).context;
  return { contract, ctx: next };
};

const flush = async (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  inIndexes: readonly bigint[],
  requestIds: readonly Uint8Array[],
): Promise<VaultContext> =>
  (await contract.circuits.flushQueue(ctx, flushSlots(inIndexes, requestIds))).context;

const startTronWithdraw = (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  args: TronWithdrawCallArgs,
) => contract.circuits.startTronWithdraw(ctx, args.inIndex, args.withdraw, args.tronTx, args.coin);

/** Start and flush a Tron withdrawal: the arrange step of every send test. */
const flushedTronWithdraw = async (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  args: TronWithdrawCallArgs,
) => {
  const started = (await startTronWithdraw(contract, ctx, args)).context;
  const outIndex = queuedRequestIndex(ledgerOf(started), args.inIndex);
  const flushed = await flush(contract, started, [args.inIndex], []);
  return { context: flushed, outIndex };
};

/** Start, flush and send a Tron withdrawal, returning its request id. */
const sentTronWithdraw = async (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  args: TronWithdrawCallArgs,
) => {
  const { context: flushed, outIndex } = await flushedTronWithdraw(contract, ctx, args);
  const sent = (await contract.circuits.sendTronWithdraw(flushed, outIndex)).context;
  const requestId = [...ledgerOf(sent).bidirectionalTronWithdrawMap]
    .map(([id]) => id)
    .filter((id) => !ledgerOf(flushed).bidirectionalTronWithdrawMap.member(id));
  return { context: sent, outIndex, requestId: first(requestId, "new Tron withdraw request") };
};

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

const OUTPUT_EMPTY = new Uint8Array(0);
const OUTPUT_TRUE = Uint8Array.of(1);
const OUTPUT_FALSE = Uint8Array.of(0);
const OUTPUT_IGNORED = new Uint8Array(1);

describe("startTronWithdraw", () => {
  it("queues a Tron entry with the withdrawer's window and the vault's fee limit", async () => {
    const { contract, ctx } = await deployInitialised();
    const started = (await startTronWithdraw(contract, ctx, VALID_TRON_WITHDRAW)).context;
    const state = ledgerOf(started);

    expect(state.inputRequestBuffer.lookup(VALID_TRON_WITHDRAW.inIndex)).toEqual({
      action: Action.tronWithdraw,
      chain: Chain.tron,
      useNextVaultAccountNonce: false,
      evmNonce: 0n,
      inIndex: VALID_TRON_WITHDRAW.inIndex,
      commitment: pureCircuits.ownershipCommitment(VALID_TRON_WITHDRAW.inIndex, SECRET_KEY),
      argsHash: expect.any(Uint8Array) as Uint8Array,
    });
    expect(state.tronWithdrawArgsMap.lookup(VALID_TRON_WITHDRAW.inIndex)).toEqual({
      request: VALID_TRON_WITHDRAW.withdraw,
      tx: { ...VALID_TRON_WITHDRAW.tronTx, feeLimit: DEFAULT_TRON_FEE_LIMIT },
      fee: TRON_TOKEN_FEES.withdraw,
      binding: pureCircuits.ownershipCommitment(VALID_TRON_WITHDRAW.inIndex, SECRET_KEY),
    });
  });

  it("burns the coin, principal plus fee, and mints the fee in the TRC-20's colour", async () => {
    const { contract, ctx } = await deployInitialised();
    const started = (await startTronWithdraw(contract, ctx, VALID_TRON_WITHDRAW)).context;
    const outputs = zswapOutputs(started);

    const burn = first(
      outputs.filter((o) => o.recipient.is_left && o.recipient.left.bytes.every((b) => b === 0)),
      "burn output",
    );
    expect(burn.coinInfo.color).toEqual(TRON_TOKEN_COLOR);
    expect(burn.coinInfo.value).toBe(AMOUNT + TRON_TOKEN_FEES.withdraw);
    const fee = first(
      outputs.filter(
        (o) =>
          o.recipient.is_left &&
          bytesToHex(o.recipient.left.bytes) === bytesToHex(FEE_RECIPIENT_CPK),
      ),
      "fee output",
    );
    expect(fee.coinInfo).toEqual({
      nonce: pureCircuits.feeMintNonce(VALID_TRON_WITHDRAW.coin.nonce),
      color: TRON_TOKEN_COLOR,
      value: TRON_TOKEN_FEES.withdraw,
    });
  });

  it("snapshots the withdraw fee limit setGasParams last set", async () => {
    const { contract, ctx } = await deployInitialised();
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
    const started = (await startTronWithdraw(contract, reconfigured, VALID_TRON_WITHDRAW)).context;
    expect(
      ledgerOf(started).tronWithdrawArgsMap.lookup(VALID_TRON_WITHDRAW.inIndex).tx.feeLimit,
    ).toBe(DISTINCT_TRON_FEE_LIMITS.withdraw);
  });

  it("takes the withdraw fee setTronTokenFees last set", async () => {
    const { contract, ctx } = await deployInitialised();
    const repriced = (
      await contract.circuits.setTronTokenFees(ctx, TRC20, { ...TRON_TOKEN_FEES, withdraw: 5n })
    ).context;
    await expect(startTronWithdraw(contract, repriced, VALID_TRON_WITHDRAW)).rejects.toThrow(
      /Coin value must equal the withdraw amount plus fee/,
    );
    const started = (
      await startTronWithdraw(contract, repriced, {
        ...VALID_TRON_WITHDRAW,
        coin: vaultCoin(AMOUNT + 5n),
      })
    ).context;
    expect(ledgerOf(started).tronWithdrawArgsMap.lookup(VALID_TRON_WITHDRAW.inIndex).fee).toBe(5n);
  });

  it("accepts the largest refundable amount", async () => {
    const { contract, ctx } = await deployInitialised();
    const started = (
      await startTronWithdraw(contract, ctx, {
        ...VALID_USDT_WITHDRAW,
        withdraw: { ...VALID_USDT_WITHDRAW.withdraw, amount: UINT64_MAX },
        coin: vaultCoin(UINT64_MAX, TRON_USDT_COLOR),
      })
    ).context;
    expect(ledgerOf(started).tronWithdrawArgsMap.size()).toBe(1n);
  });

  it.each([
    [
      "a zero destination",
      { withdraw: { ...VALID_TRON_WITHDRAW.withdraw, destTronAddress: new Uint8Array(20) } },
      /Destination address cannot be zero/,
    ],
    [
      "a zero amount",
      {
        withdraw: { ...VALID_TRON_WITHDRAW.withdraw, amount: 0n },
        coin: vaultCoin(TRON_TOKEN_FEES.withdraw),
      },
      /Amount must be positive/,
    ],
    [
      "an amount past Uint<64>",
      {
        withdraw: { ...VALID_TRON_WITHDRAW.withdraw, amount: UINT64_MAX + 1n },
        coin: vaultCoin(UINT64_MAX + 1n + TRON_TOKEN_FEES.withdraw),
      },
      /Amount exceeds Uint<64> max/,
    ],
    [
      "an unlisted TRC-20",
      { withdraw: { ...VALID_TRON_WITHDRAW.withdraw, tokenAddress: UNLISTED_TRC20 } },
      /TRC-20 not allowed/,
    ],
    [
      "an ERC20 that is not a TRC-20",
      { withdraw: { ...VALID_TRON_WITHDRAW.withdraw, tokenAddress: ERC20 } },
      /TRC-20 not allowed/,
    ],
    [
      "the ERC20 colour of the same address",
      {
        coin: vaultCoin(
          AMOUNT + TRON_TOKEN_FEES.withdraw,
          colourOf(pureCircuits.vaultTokenDomainSeparator(TRC20)),
        ),
      },
      /Coin is not the vault token for this TRC-20/,
    ],
    [
      "another TRC-20's colour",
      { coin: vaultCoin(AMOUNT + TRON_TOKEN_FEES.withdraw, TRON_USDT_COLOR) },
      /Coin is not the vault token for this TRC-20/,
    ],
    ["a coin without the fee", { coin: vaultCoin(AMOUNT) }, /Coin value must equal/],
    [
      "a coin above amount plus fee",
      { coin: vaultCoin(AMOUNT + TRON_TOKEN_FEES.withdraw + 1n) },
      /Coin value must equal/,
    ],
    [
      "a timestamp past int64",
      {
        tronTx: {
          ...VALID_TRON_WITHDRAW.tronTx,
          timestamp: INT64_MAX + 1n,
          expiration: INT64_MAX + 2n,
        },
      },
      /Tron timestamp exceeds int64/,
    ],
    [
      "an expiration past int64",
      { tronTx: { ...VALID_TRON_WITHDRAW.tronTx, expiration: INT64_MAX + 1n } },
      /Tron expiration exceeds int64/,
    ],
    [
      "an expiration equal to the timestamp",
      { tronTx: { ...VALID_TRON_WITHDRAW.tronTx, timestamp: ms(NOW + 3600, 250) } },
      /Tron expiration must follow its timestamp/,
    ],
  ] as const)("refuses %s", async (_name, delta: Partial<TronWithdrawCallArgs>, error) => {
    const { contract, ctx } = await deployInitialised();
    await expect(
      startTronWithdraw(contract, ctx, { ...VALID_TRON_WITHDRAW, ...delta }),
    ).rejects.toThrow(error);
  });

  it("refuses an index a queued request holds", async () => {
    const { contract, ctx } = await deployInitialised();
    const started = (await startTronWithdraw(contract, ctx, VALID_TRON_WITHDRAW)).context;
    await expect(
      startTronWithdraw(contract, started, {
        ...VALID_TRON_WITHDRAW,
        tronTx: { ...VALID_TRON_WITHDRAW.tronTx, timestamp: ms(NOW - 6) },
      }),
    ).rejects.toThrow(/Index already in use/);
  });

  it("refuses an index a flushed Tron withdrawal still holds", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: flushed } = await flushedTronWithdraw(contract, ctx, VALID_TRON_WITHDRAW);
    expect(ledgerOf(flushed).inputRequestBuffer.member(VALID_TRON_WITHDRAW.inIndex)).toBe(false);
    await expect(
      startTronWithdraw(contract, flushed, {
        ...VALID_TRON_WITHDRAW,
        tronTx: { ...VALID_TRON_WITHDRAW.tronTx, timestamp: ms(NOW - 6) },
      }),
    ).rejects.toThrow(/Index already in use/);
  });

  it("refuses an index another action's queued request holds, leaving that request queued", async () => {
    const { contract, ctx } = await deployInitialised();
    const deposit = (
      await contract.circuits.startTronDeposit(
        ctx,
        VALID_TRON_WITHDRAW.inIndex,
        { ...VALID_TRON_WITHDRAW.tronTx, feeLimit: DEFAULT_TRON_FEE_LIMIT },
        { tokenAddress: TRC20, amount: AMOUNT },
      )
    ).context;
    await expect(startTronWithdraw(contract, deposit, VALID_TRON_WITHDRAW)).rejects.toThrow(
      /Index already in use/,
    );
    expect(ledgerOf(deposit).inputRequestBuffer.lookup(VALID_TRON_WITHDRAW.inIndex).action).toBe(
      Action.tronDeposit,
    );
  });

  it("refuses before initialise", async () => {
    const contract = new Contract<VaultPrivateState>(witnesses);
    const { currentContractState } = await contract.initialState(
      createConstructorContext<VaultPrivateState>(createVaultPrivateState(SECRET_KEY), CPK),
      DEPLOYER_COMMITMENT,
      { bytes: hexToBytes(SIGNET_ADDRESS) },
    );
    await expect(
      startTronWithdraw(
        contract,
        contextOf(currentContractState, SECRET_KEY, NOW),
        VALID_TRON_WITHDRAW,
      ),
    ).rejects.toThrow(/Not initialised/);
  });
});

describe("startTronWithdraw: the window at the start block", () => {
  // At block time NOW the start admits expirations whose whole seconds h satisfy
  // NOW < h - 600 and NOW >= h + 1 + 60 - 86_400.
  it.each([
    ["the shortest window, to the last millisecond", ms(NOW + START_MIN_REMAINING + 1, 999)],
    ["the shortest window, on its first millisecond", ms(NOW + START_MIN_REMAINING + 1)],
    ["the longest window", ms(NOW + DAY - CAP_MARGIN - 1, 999)],
  ] as const)("admits %s", async (_name, expiration) => {
    const { contract, ctx } = await deployInitialised();
    const started = (
      await startTronWithdraw(contract, ctx, {
        ...VALID_TRON_WITHDRAW,
        tronTx: { ...VALID_TRON_WITHDRAW.tronTx, expiration },
      })
    ).context;
    expect(ledgerOf(started).tronWithdrawArgsMap.size()).toBe(1n);
  });

  it.each([
    ["a window one second too short", ms(NOW + START_MIN_REMAINING, 999), /too close/],
    ["a window that closed before the block", ms(NOW - 1), /too close/],
    ["a window closing at the block", ms(NOW), /too close/],
    ["a window one second too long", ms(NOW + DAY - CAP_MARGIN), /too far/],
    ["a window past the 24 h cap", ms(NOW + DAY + 1), /too far/],
  ] as const)("refuses %s", async (_name, expiration, error) => {
    const { contract, ctx } = await deployInitialised();
    await expect(
      startTronWithdraw(contract, ctx, {
        ...VALID_TRON_WITHDRAW,
        tronTx: { ...VALID_TRON_WITHDRAW.tronTx, timestamp: ms(NOW - DAY), expiration },
      }),
    ).rejects.toThrow(error);
  });

  it("refuses a witness that misstates the expiration's seconds", async () => {
    const { ctx } = await deployInitialised();
    const lying = new Contract<VaultPrivateState>({
      ...witnesses,
      secondsOfMillis: ({ privateState }, millis): [VaultPrivateState, bigint] => [
        privateState,
        millis / 1000n + 1n,
      ],
    });
    await expect(startTronWithdraw(lying, ctx, VALID_TRON_WITHDRAW)).rejects.toThrow(
      /expirationSeconds is not the expiration in whole seconds/,
    );
  });
});

describe("startTronWithdraw: copies", () => {
  // Every start binds its transfer to the requester's ownership commitment, so a copy of a
  // public start (same token, amount, destination and window) names its own Tron transaction.
  const COPY = {
    ...VALID_TRON_WITHDRAW,
    inIndex: 31n,
    coin: { ...VALID_TRON_WITHDRAW.coin, nonce: bytes(32, 0x0d) },
  };

  it("lets a stranger's copy that failed and was refunded leave the original refundable", async () => {
    const { contract, ctx } = await deployInitialised();
    const original = (await startTronWithdraw(contract, ctx, VALID_TRON_WITHDRAW)).context;
    const copied = (await startTronWithdraw(contract, stranger(original), COPY)).context;
    const copyOut = queuedRequestIndex(ledgerOf(copied), COPY.inIndex);
    const originalOut = queuedRequestIndex(ledgerOf(copied), VALID_TRON_WITHDRAW.inIndex);
    expect(bytesToHex(copyOut)).not.toBe(bytesToHex(originalOut));

    const copyFlushed = await flush(contract, copied, [COPY.inIndex], []);
    const copySent = (await contract.circuits.sendTronWithdraw(copyFlushed, copyOut)).context;
    const copyId = first(
      [...ledgerOf(copySent).bidirectionalTronWithdrawMap].map(([id]) => id),
      "copy request",
    );
    const copyAttested = await attest(
      contract,
      copySent,
      respond(copyId, OutputKind.failed, OUTPUT_EMPTY, TRON_ATTESTED_HEIGHT),
    );
    const copySettled = (
      await contract.circuits.completeTronWithdraw(
        stranger(copyAttested),
        copyId,
        OUTPUT_IGNORED,
        MINT_NONCE,
      )
    ).context;

    const flushed = await flush(
      contract,
      atBlockTime(copySettled, NOW),
      [VALID_TRON_WITHDRAW.inIndex],
      [],
    );
    const sent = (await contract.circuits.sendTronWithdraw(flushed, originalOut)).context;
    const requestId = first(
      [...ledgerOf(sent).bidirectionalTronWithdrawMap].map(([id]) => id),
      "original request",
    );
    expect(bytesToHex(requestId)).not.toBe(bytesToHex(copyId));
    const attested = await attest(
      contract,
      sent,
      respond(requestId, OutputKind.failed, OUTPUT_EMPTY, TRON_ATTESTED_HEIGHT + 1n),
    );
    const before = atBlockTime(attested, NOW);
    const refunded = (
      await contract.circuits.completeTronWithdraw(before, requestId, OUTPUT_IGNORED, MINT_NONCE)
    ).context;
    expect(shieldedMintsSince(before, refunded)).toEqual([[TRC20_MINT_KEY, AMOUNT]]);
  });

  it("refunds an unsent withdrawal while a stranger's sent copy stays unsettled", async () => {
    const { contract, ctx } = await deployInitialised();
    const original = (await startTronWithdraw(contract, ctx, VALID_TRON_WITHDRAW)).context;
    const copied = (await startTronWithdraw(contract, stranger(original), COPY)).context;
    const copyOut = queuedRequestIndex(ledgerOf(copied), COPY.inIndex);
    const copyFlushed = await flush(contract, copied, [COPY.inIndex], []);
    const held = (await contract.circuits.sendTronWithdraw(copyFlushed, copyOut)).context;

    const flushed = await flush(contract, held, [VALID_TRON_WITHDRAW.inIndex], []);
    const closed = atBlockTime(flushed, SEND_CLOSED_TIME);
    const refunded = (
      await contract.circuits.refundUnsentTronWithdraw(
        closed,
        VALID_TRON_WITHDRAW.inIndex,
        MINT_NONCE,
      )
    ).context;
    expect(shieldedMintsSince(closed, refunded)).toEqual([[TRC20_MINT_KEY, AMOUNT]]);
  });

  it("gives a repriced copy its own Tron transaction, so both send", async () => {
    const { contract, ctx } = await deployInitialised();
    const original = (await startTronWithdraw(contract, ctx, VALID_TRON_WITHDRAW)).context;
    const repriced = (
      await contract.circuits.setTronTokenFees(original, TRC20, {
        ...TRON_TOKEN_FEES,
        withdraw: TRON_TOKEN_FEES.withdraw + 1n,
      })
    ).context;
    const copied = (
      await startTronWithdraw(contract, stranger(repriced), {
        ...COPY,
        coin: { ...vaultCoin(AMOUNT + TRON_TOKEN_FEES.withdraw + 1n), nonce: COPY.coin.nonce },
      })
    ).context;
    const flushed = await flush(contract, copied, [COPY.inIndex, VALID_TRON_WITHDRAW.inIndex], []);
    let sent = flushed;
    for (const inIndex of [COPY.inIndex, VALID_TRON_WITHDRAW.inIndex]) {
      const outIndex = queuedRequestIndex(ledgerOf(copied), inIndex);
      sent = (await contract.circuits.sendTronWithdraw(sent, outIndex)).context;
    }
    expect([...ledgerOf(sent).bidirectionalTronWithdrawMap]).toHaveLength(2);
  });

  it("settles many distinct withdrawals flushed together", async () => {
    const { contract, ctx } = await deployInitialised();
    const all = [0, 1, 2].map((i) => ({
      ...VALID_TRON_WITHDRAW,
      inIndex: 40n + BigInt(i),
      tronTx: { ...VALID_TRON_WITHDRAW.tronTx, timestamp: ms(NOW - 10 - i) },
    }));
    let next = ctx;
    for (const args of all) next = (await startTronWithdraw(contract, next, args)).context;
    const outIndexes = all.map((args) => queuedRequestIndex(ledgerOf(next), args.inIndex));
    next = await flush(
      contract,
      next,
      all.map(({ inIndex }) => inIndex),
      [],
    );
    for (const outIndex of outIndexes) {
      next = (await contract.circuits.sendTronWithdraw(next, outIndex)).context;
    }
    const ids = [...ledgerOf(next).bidirectionalTronWithdrawMap].map(([id]) => id);
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      next = await attest(
        contract,
        next,
        respond(id, OutputKind.executed, OUTPUT_TRUE, TRON_ATTESTED_HEIGHT),
      );
      next = (await contract.circuits.completeTronWithdraw(next, id, OUTPUT_TRUE, MINT_NONCE))
        .context;
    }
    expect(ledgerOf(next).bidirectionalTronWithdrawMap.isEmpty()).toBe(true);
    expect(ledgerOf(next).tronWithdrawArgsMap.isEmpty()).toBe(true);
  });
});

describe("sendTronWithdraw", () => {
  it("stores the vault-path Tron record and notifies the MPC with its map's path", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: flushed, outIndex } = await flushedTronWithdraw(
      contract,
      ctx,
      VALID_TRON_WITHDRAW,
    );
    const sent = (await contract.circuits.sendTronWithdraw(flushed, outIndex)).context;
    const state = sent.callContext.currentQueryContext.state;

    const raw = readSignetRequestsLedgerFromState(state, VAULT_TRON_WITHDRAW_REQUESTS_PATH);
    expect(raw.requestsIndex.size).toBe(1);
    const [idHex, record] = first(raw.requestsIndex.entries(), "Tron withdraw record");
    if (!isTronRequest(record)) throw new Error("expected a Tron record");
    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));

    expect(record.sender).toEqual({ bytes: VAULT_ADDRESS_BYTES });
    expect(record.path).toEqual(asciiPadded("vault", 32));
    expect(record.keyVersion).toBe(MPC_KEY_VERSION);
    expect(record.txParamType).toBe(TxParamType.tronTriggerSmartContract);
    expect(record.executionDest).toEqual(signetCircuits.tronCaip2Id());
    expect(record.outputDeserializationSchema).toEqual(VAULT_OUTPUT_SCHEMA);
    expect(record.txParams).toEqual({
      ...VALID_TRON_WITHDRAW.tronTx,
      feeLimit: DEFAULT_TRON_FEE_LIMIT,
      contractAddress: Uint8Array.of(0x41, ...TRC20),
      callValue: 0n,
      calldata: {
        is_some: true,
        value: {
          selector: ERC20_TRANSFER_SELECTOR,
          noWords: 3n,
          words: [
            evmAddressAbiWord(DEST_TRON),
            numericAbiWord(AMOUNT),
            pureCircuits.ownershipCommitment(VALID_TRON_WITHDRAW.inIndex, SECRET_KEY),
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
      requestsPath: [...VAULT_TRON_WITHDRAW_REQUESTS_PATH],
    });
    expect(ledger(state).evictionMap.lookup(requestIdBytes(idHex))).toEqual(outIndex);
    expect(ledger(state).outputRequestBuffer.lookup(outIndex).lastSeen).toBe(TRON_START_HEIGHT);
  });

  it("is permissionless: a stranger's send records the same request", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: flushed, outIndex } = await flushedTronWithdraw(
      contract,
      ctx,
      VALID_TRON_WITHDRAW,
    );
    const byWithdrawer = (await contract.circuits.sendTronWithdraw(flushed, outIndex)).context;
    const byStranger = (await contract.circuits.sendTronWithdraw(stranger(flushed), outIndex))
      .context;
    expect([...ledgerOf(byStranger).bidirectionalTronWithdrawMap]).toEqual([
      ...ledgerOf(byWithdrawer).bidirectionalTronWithdrawMap,
    ]);
  });

  it("refuses a second send of the same request", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, outIndex } = await sentTronWithdraw(contract, ctx, VALID_TRON_WITHDRAW);
    await expect(contract.circuits.sendTronWithdraw(sent, outIndex)).rejects.toThrow(
      /Request already sent/,
    );
  });

  it("refuses an index that is not flushed", async () => {
    const { contract, ctx } = await deployInitialised();
    const started = (await startTronWithdraw(contract, ctx, VALID_TRON_WITHDRAW)).context;
    const outIndex = queuedRequestIndex(ledgerOf(started), VALID_TRON_WITHDRAW.inIndex);
    await expect(contract.circuits.sendTronWithdraw(started, outIndex)).rejects.toThrow(
      /Request not flushed/,
    );
  });

  it("refuses another action's flushed entry", async () => {
    const { contract, ctx } = await deployInitialised();
    const started = (
      await contract.circuits.startWithdraw(
        ctx,
        50n,
        { erc20Address: ERC20, amount: AMOUNT, destEvmAddress: DEST_TRON },
        vaultCoin(AMOUNT, ERC20_COLOR),
      )
    ).context;
    const flushed = await flush(contract, started, [50n], []);
    const outIndex = flushedRequestIndex(ledgerOf(flushed), Action.withdraw, 50n);
    await expect(contract.circuits.sendTronWithdraw(flushed, outIndex)).rejects.toThrow(
      /Wrong action/,
    );
  });

  // The window must still clear the MPC's admission at the send block: block time below
  // h - 60, where h = NOW + 3600 is the expiration's whole seconds.
  it("admits a send in the last block time the margin allows", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: flushed, outIndex } = await flushedTronWithdraw(
      contract,
      ctx,
      VALID_TRON_WITHDRAW,
    );
    const late = atBlockTime(flushed, NOW + 3600 - SEND_MIN_REMAINING - 1);
    const sent = (await contract.circuits.sendTronWithdraw(late, outIndex)).context;
    expect(ledgerOf(sent).bidirectionalTronWithdrawMap.size()).toBe(1n);
  });

  it.each([
    ["inside the send margin", NOW + 3600 - SEND_MIN_REMAINING, /too close/],
    ["after the expiration", NOW + 3601, /too close/],
    ["over 24 h before the expiration", NOW + 3600 - DAY + CAP_MARGIN, /too far/],
  ] as const)("refuses a send %s", async (_name, blockTime, error) => {
    const { contract, ctx } = await deployInitialised();
    const { context: flushed, outIndex } = await flushedTronWithdraw(
      contract,
      ctx,
      VALID_TRON_WITHDRAW,
    );
    await expect(
      contract.circuits.sendTronWithdraw(atBlockTime(flushed, blockTime), outIndex),
    ).rejects.toThrow(error);
  });
});

// The verdicts, the token, and what the settle re-mints to the withdrawer: the burned
// amount, never the fee, whenever the transfer moved nothing.
const TRON_WITHDRAW_VERDICT_CASES = [
  {
    name: "an executed transfer returning true keeps the burn",
    args: VALID_TRON_WITHDRAW,
    outputKind: OutputKind.executed,
    signedOutput: OUTPUT_TRUE,
    refunds: false,
  },
  {
    name: "an executed transfer returning false refunds",
    args: VALID_TRON_WITHDRAW,
    outputKind: OutputKind.executed,
    signedOutput: OUTPUT_FALSE,
    refunds: true,
  },
  {
    name: "a failed transfer refunds",
    args: VALID_TRON_WITHDRAW,
    outputKind: OutputKind.failed,
    signedOutput: OUTPUT_EMPTY,
    refunds: true,
  },
  {
    name: "an unviable transfer refunds",
    args: VALID_TRON_WITHDRAW,
    outputKind: OutputKind.unviable,
    signedOutput: OUTPUT_EMPTY,
    refunds: true,
  },
  {
    name: "a USDT transfer returning false (its success) keeps the burn",
    args: VALID_USDT_WITHDRAW,
    outputKind: OutputKind.executed,
    signedOutput: OUTPUT_FALSE,
    refunds: false,
  },
  {
    name: "a USDT transfer returning true keeps the burn",
    args: VALID_USDT_WITHDRAW,
    outputKind: OutputKind.executed,
    signedOutput: OUTPUT_TRUE,
    refunds: false,
  },
  {
    name: "a failed USDT transfer refunds",
    args: VALID_USDT_WITHDRAW,
    outputKind: OutputKind.failed,
    signedOutput: OUTPUT_EMPTY,
    refunds: true,
  },
  {
    name: "an unviable USDT transfer refunds",
    args: VALID_USDT_WITHDRAW,
    outputKind: OutputKind.unviable,
    signedOutput: OUTPUT_EMPTY,
    refunds: true,
  },
] as const;

describe("completeTronWithdraw", () => {
  it.each(TRON_WITHDRAW_VERDICT_CASES)(
    "$name and consumes the request",
    async ({ args, outputKind, signedOutput, refunds }) => {
      const { contract, ctx } = await deployInitialised();
      const { context: sent, requestId } = await sentTronWithdraw(contract, ctx, args);
      const attested = await attest(
        contract,
        sent,
        respond(requestId, outputKind, signedOutput, TRON_ATTESTED_HEIGHT),
      );
      const presented = outputKind === OutputKind.executed ? signedOutput : OUTPUT_IGNORED;
      const settled = (
        await contract.circuits.completeTronWithdraw(attested, requestId, presented, MINT_NONCE)
      ).context;

      const mintKey = bytesToHex(
        pureCircuits.vaultTronTokenDomainSeparator(args.withdraw.tokenAddress),
      );
      expect(shieldedMintsSince(attested, settled)).toEqual(refunds ? [[mintKey, AMOUNT]] : []);
      expect(
        coinsMinted(attested, settled).map(({ coinInfo, recipient }) => [
          coinInfo.color,
          coinInfo.value,
          recipient.left.bytes,
        ]),
      ).toEqual(refunds ? [[args.coin.color, AMOUNT, hexToBytes(CPK)]] : []);
      const state = ledgerOf(settled);
      expect(state.bidirectionalTronWithdrawMap.isEmpty()).toBe(true);
      expect(state.tronWithdrawArgsMap.isEmpty()).toBe(true);
      expect(state.outputRequestBuffer.isEmpty()).toBe(true);
      expect(state.outputAttestationBuffer.isEmpty()).toBe(true);
      expect(state.evictionMap.isEmpty()).toBe(true);
      expect(state.tronLastSeen).toBe(TRON_ATTESTED_HEIGHT);
    },
  );

  it("refuses a caller other than the withdrawer", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await sentTronWithdraw(contract, ctx, VALID_TRON_WITHDRAW);
    const attested = await attest(
      contract,
      sent,
      respond(requestId, OutputKind.failed, OUTPUT_EMPTY, TRON_ATTESTED_HEIGHT),
    );
    await expect(
      contract.circuits.completeTronWithdraw(
        stranger(attested),
        requestId,
        OUTPUT_IGNORED,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Not the requester/);
  });

  it("settles once", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await sentTronWithdraw(contract, ctx, VALID_TRON_WITHDRAW);
    const attested = await attest(
      contract,
      sent,
      respond(requestId, OutputKind.failed, OUTPUT_EMPTY, TRON_ATTESTED_HEIGHT),
    );
    const settled = (
      await contract.circuits.completeTronWithdraw(attested, requestId, OUTPUT_IGNORED, MINT_NONCE)
    ).context;
    await expect(
      contract.circuits.completeTronWithdraw(settled, requestId, OUTPUT_IGNORED, MINT_NONCE),
    ).rejects.toThrow(/Request not sent/);
  });

  it.each([
    ["false for a transfer attested true", VALID_TRON_WITHDRAW, OUTPUT_TRUE, OUTPUT_FALSE],
    ["true for a USDT transfer attested false", VALID_USDT_WITHDRAW, OUTPUT_FALSE, OUTPUT_TRUE],
  ] as const)("refuses an output of %s", async (_name, args, signed, presented) => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await sentTronWithdraw(contract, ctx, args);
    const attested = await attest(
      contract,
      sent,
      respond(requestId, OutputKind.executed, signed, TRON_ATTESTED_HEIGHT),
    );
    await expect(
      contract.circuits.completeTronWithdraw(attested, requestId, presented, MINT_NONCE),
    ).rejects.toThrow(/Output does not match the attestation/);
  });

  it("refuses an attestation that is not settled yet", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await sentTronWithdraw(contract, ctx, VALID_TRON_WITHDRAW);
    await expect(
      contract.circuits.completeTronWithdraw(sent, requestId, OUTPUT_IGNORED, MINT_NONCE),
    ).rejects.toThrow(/Attestation not flushed/);
  });
});

/** How far an unsent Tron withdrawal got before its window closed to sends. */
enum UnsentStage {
  Queued = "queued",
  Flushed = "flushed",
}

/** Start VALID_TRON_WITHDRAW at NOW and, for {@link UnsentStage.Flushed}, flush it. */
const unsentTronWithdraw = async (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  stage: UnsentStage,
): Promise<VaultContext> =>
  stage === UnsentStage.Queued
    ? (await startTronWithdraw(contract, ctx, VALID_TRON_WITHDRAW)).context
    : (await flushedTronWithdraw(contract, ctx, VALID_TRON_WITHDRAW)).context;

describe("refundUnsentTronWithdraw", () => {
  it.each([UnsentStage.Queued, UnsentStage.Flushed])(
    "re-mints the amount of a %s withdrawal once sends are refused, keeping the fee",
    async (stage) => {
      const { contract, ctx } = await deployInitialised();
      const unsent = await unsentTronWithdraw(contract, ctx, stage);
      const closed = atBlockTime(unsent, SEND_CLOSED_TIME);
      const refunded = (
        await contract.circuits.refundUnsentTronWithdraw(
          closed,
          VALID_TRON_WITHDRAW.inIndex,
          MINT_NONCE,
        )
      ).context;

      expect(shieldedMintsSince(closed, refunded)).toEqual([[TRC20_MINT_KEY, AMOUNT]]);
      expect(
        coinsMinted(closed, refunded).map(({ coinInfo, recipient }) => [
          coinInfo.color,
          coinInfo.value,
          recipient.left.bytes,
        ]),
      ).toEqual([[TRON_TOKEN_COLOR, AMOUNT, hexToBytes(CPK)]]);
      const state = ledgerOf(refunded);
      expect(state.inputRequestBuffer.isEmpty()).toBe(true);
      expect(state.outputRequestBuffer.isEmpty()).toBe(true);
      expect(state.tronWithdrawArgsMap.isEmpty()).toBe(true);
      expect(state.bidirectionalTronWithdrawMap.isEmpty()).toBe(true);
      expect(state.evictionMap.isEmpty()).toBe(true);
    },
  );

  it.each([UnsentStage.Queued, UnsentStage.Flushed])(
    "refuses a %s withdrawal in the last block time a send is admitted",
    async (stage) => {
      const { contract, ctx } = await deployInitialised();
      const unsent = await unsentTronWithdraw(contract, ctx, stage);
      await expect(
        contract.circuits.refundUnsentTronWithdraw(
          atBlockTime(unsent, LAST_SEND_TIME),
          VALID_TRON_WITHDRAW.inIndex,
          MINT_NONCE,
        ),
      ).rejects.toThrow(/Tron request can still be sent/);
    },
  );

  it.each([UnsentStage.Queued, UnsentStage.Flushed])(
    "refuses a caller other than the withdrawer of a %s withdrawal",
    async (stage) => {
      const { contract, ctx } = await deployInitialised();
      const unsent = await unsentTronWithdraw(contract, ctx, stage);
      await expect(
        contract.circuits.refundUnsentTronWithdraw(
          atBlockTime(unsent, SEND_CLOSED_TIME, OTHER_SECRET_KEY),
          VALID_TRON_WITHDRAW.inIndex,
          MINT_NONCE,
        ),
      ).rejects.toThrow(/Not the requester/);
    },
  );

  it("refuses a withdrawal sent in the last block time a send is admitted", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: flushed, outIndex } = await flushedTronWithdraw(
      contract,
      ctx,
      VALID_TRON_WITHDRAW,
    );
    const sent = (
      await contract.circuits.sendTronWithdraw(atBlockTime(flushed, LAST_SEND_TIME), outIndex)
    ).context;
    await expect(
      contract.circuits.refundUnsentTronWithdraw(
        atBlockTime(sent, SEND_CLOSED_TIME),
        VALID_TRON_WITHDRAW.inIndex,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Request already sent/);
  });

  it("refunds once", async () => {
    const { contract, ctx } = await deployInitialised();
    const unsent = await unsentTronWithdraw(contract, ctx, UnsentStage.Flushed);
    const refunded = (
      await contract.circuits.refundUnsentTronWithdraw(
        atBlockTime(unsent, SEND_CLOSED_TIME),
        VALID_TRON_WITHDRAW.inIndex,
        MINT_NONCE,
      )
    ).context;
    await expect(
      contract.circuits.refundUnsentTronWithdraw(
        atBlockTime(refunded, SEND_CLOSED_TIME),
        VALID_TRON_WITHDRAW.inIndex,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Tron withdrawal not open/);
  });

  // The ledger, not the block time, keeps a refunded withdrawal from being sent: a send
  // that its own block time would still admit is refused.
  it("leaves nothing a send or a flush can reach", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: flushed, outIndex } = await flushedTronWithdraw(
      contract,
      ctx,
      VALID_TRON_WITHDRAW,
    );
    const refundedFlushed = (
      await contract.circuits.refundUnsentTronWithdraw(
        atBlockTime(flushed, SEND_CLOSED_TIME),
        VALID_TRON_WITHDRAW.inIndex,
        MINT_NONCE,
      )
    ).context;
    await expect(
      contract.circuits.sendTronWithdraw(atBlockTime(refundedFlushed, LAST_SEND_TIME), outIndex),
    ).rejects.toThrow(/Request not flushed/);

    const queued = await unsentTronWithdraw(contract, ctx, UnsentStage.Queued);
    const refundedQueued = (
      await contract.circuits.refundUnsentTronWithdraw(
        atBlockTime(queued, SEND_CLOSED_TIME),
        VALID_TRON_WITHDRAW.inIndex,
        MINT_NONCE,
      )
    ).context;
    await expect(
      flush(contract, refundedQueued, [VALID_TRON_WITHDRAW.inIndex], []),
    ).rejects.toThrow(/Request not queued/);
  });

  it("refunds a flushed withdrawal whose index another action's queued request now holds", async () => {
    const { contract, ctx } = await deployInitialised();
    const flushed = await unsentTronWithdraw(contract, ctx, UnsentStage.Flushed);
    const deposit = (
      await contract.circuits.startTronDeposit(
        flushed,
        VALID_TRON_WITHDRAW.inIndex,
        { ...VALID_TRON_WITHDRAW.tronTx, feeLimit: DEFAULT_TRON_FEE_LIMIT },
        { tokenAddress: TRC20, amount: AMOUNT },
      )
    ).context;
    const refunded = (
      await contract.circuits.refundUnsentTronWithdraw(
        atBlockTime(deposit, SEND_CLOSED_TIME),
        VALID_TRON_WITHDRAW.inIndex,
        MINT_NONCE,
      )
    ).context;
    const state = ledgerOf(refunded);
    expect(state.outputRequestBuffer.isEmpty()).toBe(true);
    expect(state.tronWithdrawArgsMap.isEmpty()).toBe(true);
    expect(state.inputRequestBuffer.lookup(VALID_TRON_WITHDRAW.inIndex).action).toBe(
      Action.tronDeposit,
    );
  });

  it("refuses before initialise", async () => {
    const contract = new Contract<VaultPrivateState>(witnesses);
    const { currentContractState } = await contract.initialState(
      createConstructorContext<VaultPrivateState>(createVaultPrivateState(SECRET_KEY), CPK),
      DEPLOYER_COMMITMENT,
      { bytes: hexToBytes(SIGNET_ADDRESS) },
    );
    await expect(
      contract.circuits.refundUnsentTronWithdraw(
        contextOf(currentContractState, SECRET_KEY, SEND_CLOSED_TIME),
        VALID_TRON_WITHDRAW.inIndex,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Not initialised/);
  });

  it("refuses an index that holds no Tron withdrawal", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(
      contract.circuits.refundUnsentTronWithdraw(
        atBlockTime(ctx, SEND_CLOSED_TIME),
        VALID_TRON_WITHDRAW.inIndex,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Tron withdrawal not open/);
  });

  it.each([
    ["understates", -1n],
    ["overstates", 1n],
  ] as const)("refuses a witness that %s the expiration's seconds", async (_name, offset) => {
    const { contract, ctx } = await deployInitialised();
    const unsent = await unsentTronWithdraw(contract, ctx, UnsentStage.Flushed);
    const lying = new Contract<VaultPrivateState>({
      ...witnesses,
      secondsOfMillis: ({ privateState }, millis): [VaultPrivateState, bigint] => [
        privateState,
        millis / 1000n + offset,
      ],
    });
    await expect(
      lying.circuits.refundUnsentTronWithdraw(
        atBlockTime(unsent, SEND_CLOSED_TIME),
        VALID_TRON_WITHDRAW.inIndex,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/expirationSeconds is not the expiration in whole seconds/);
  });
});

describe("Tron withdraw attestations", () => {
  it.each([
    ["at the Tron height the flush recorded", TRON_START_HEIGHT],
    ["at an EVM height", EVM_ATTESTED_HEIGHT],
  ] as const)("refuses one %s as stale", async (_name, height) => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await sentTronWithdraw(contract, ctx, VALID_TRON_WITHDRAW);
    await expect(
      contract.circuits.queueAttestation(
        sent,
        respond(requestId, OutputKind.executed, OUTPUT_TRUE, height),
      ),
    ).rejects.toThrow(/Stale attestation/);
  });

  it("refuses an attestation signed by another key", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await sentTronWithdraw(contract, ctx, VALID_TRON_WITHDRAW);
    const forged = respondBidirectionalEventToCircuitInput(
      attestRespondBidirectional(
        {
          requestId,
          blockHeight: TRON_ATTESTED_HEIGHT,
          outputKind: OutputKind.failed,
          serializedOutput: OUTPUT_EMPTY,
        },
        bytes(32, 0x43),
      ),
    );
    await expect(contract.circuits.queueAttestation(sent, forged)).rejects.toThrow(
      /Invalid attestation signature/,
    );
  });

  it("Tron and EVM heights advance independently when their settles interleave", async () => {
    const { contract, ctx } = await deployInitialised();
    const tron = await sentTronWithdraw(contract, ctx, VALID_TRON_WITHDRAW);
    const evmStarted = (
      await contract.circuits.startWithdraw(
        tron.context,
        50n,
        { erc20Address: ERC20, amount: AMOUNT, destEvmAddress: DEST_TRON },
        vaultCoin(AMOUNT, ERC20_COLOR),
      )
    ).context;
    const evmFlushed = await flush(contract, evmStarted, [50n], []);
    const evmOutIndex = flushedRequestIndex(ledgerOf(evmFlushed), Action.withdraw, 50n);
    expect(ledgerOf(evmFlushed).outputRequestBuffer.lookup(evmOutIndex).lastSeen).toBe(
      EVM_START_HEIGHT,
    );
    const evmSent = (await contract.circuits.sendWithdraw(evmFlushed, evmOutIndex)).context;
    const evmId = first(ledgerOf(evmSent).bidirectionalWithdrawMap, "EVM withdraw")[0];

    // The Tron attestation folds a Tron height far above every EVM height.
    const tronAttested = await attest(
      contract,
      evmSent,
      respond(tron.requestId, OutputKind.executed, OUTPUT_TRUE, TRON_ATTESTED_HEIGHT),
    );
    expect(ledgerOf(tronAttested).tronLastSeen).toBe(TRON_ATTESTED_HEIGHT);
    expect(ledgerOf(tronAttested).globalLastSeen).toBe(EVM_START_HEIGHT);
    const evmAttested = await attest(
      contract,
      tronAttested,
      respond(evmId, OutputKind.executed, OUTPUT_TRUE, EVM_ATTESTED_HEIGHT),
    );
    const evmSettled = (
      await contract.circuits.completeWithdraw(evmAttested, evmId, OUTPUT_TRUE, MINT_NONCE)
    ).context;
    const settled = (
      await contract.circuits.completeTronWithdraw(
        evmSettled,
        tron.requestId,
        OUTPUT_TRUE,
        MINT_NONCE,
      )
    ).context;
    expect(ledgerOf(settled).globalLastSeen).toBe(EVM_ATTESTED_HEIGHT);
    expect(ledgerOf(settled).tronLastSeen).toBe(TRON_ATTESTED_HEIGHT);

    // A Tron withdrawal flushed now records the folded Tron height, not the EVM one.
    const next = await flushedTronWithdraw(contract, settled, {
      ...VALID_TRON_WITHDRAW,
      inIndex: 60n,
      tronTx: { ...VALID_TRON_WITHDRAW.tronTx, timestamp: ms(NOW - 7) },
    });
    expect(ledgerOf(next.context).outputRequestBuffer.lookup(next.outIndex).lastSeen).toBe(
      TRON_ATTESTED_HEIGHT,
    );
  });

  it.each(["completeWithdraw", "completeTronDeposit"] as const)(
    "%s refuses a Tron withdrawal's request id",
    async (circuit) => {
      const { contract, ctx } = await deployInitialised();
      const { context: sent, requestId } = await sentTronWithdraw(
        contract,
        ctx,
        VALID_TRON_WITHDRAW,
      );
      const attested = await attest(
        contract,
        sent,
        respond(requestId, OutputKind.failed, OUTPUT_EMPTY, TRON_ATTESTED_HEIGHT),
      );
      const call =
        circuit === "completeWithdraw"
          ? contract.circuits.completeWithdraw(attested, requestId, OUTPUT_IGNORED, MINT_NONCE)
          : contract.circuits.completeTronDeposit(attested, requestId, OUTPUT_IGNORED, MINT_NONCE, {
              is_some: false,
              value: {
                is_left: true,
                left: { bytes: new Uint8Array(32) },
                right: { bytes: new Uint8Array(32) },
              },
            });
      await expect(call).rejects.toThrow(/Wrong action/);
    },
  );

  it("completeTronWithdraw refuses an EVM withdrawal's request id", async () => {
    const { contract, ctx } = await deployInitialised();
    const started = (
      await contract.circuits.startWithdraw(
        ctx,
        50n,
        { erc20Address: ERC20, amount: AMOUNT, destEvmAddress: DEST_TRON },
        vaultCoin(AMOUNT, ERC20_COLOR),
      )
    ).context;
    const flushed = await flush(contract, started, [50n], []);
    const sent = (
      await contract.circuits.sendWithdraw(
        flushed,
        flushedRequestIndex(ledgerOf(flushed), Action.withdraw, 50n),
      )
    ).context;
    const evmId = first(ledgerOf(sent).bidirectionalWithdrawMap, "EVM withdraw")[0];
    const attested = await attest(
      contract,
      sent,
      respond(evmId, OutputKind.failed, OUTPUT_EMPTY, EVM_ATTESTED_HEIGHT),
    );
    await expect(
      contract.circuits.completeTronWithdraw(attested, evmId, OUTPUT_IGNORED, MINT_NONCE),
    ).rejects.toThrow(/Wrong action/);
  });

  it("startReplaceNonce refuses a Tron withdrawal: Tron has no nonce", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await sentTronWithdraw(contract, ctx, VALID_TRON_WITHDRAW);
    await expect(
      contract.circuits.startReplaceNonce(sent, 70n, requestId, Action.tronWithdraw),
    ).rejects.toThrow(/Tron request has no vault nonce/);
  });
});

describe("setGasParams: the Tron fee limits", () => {
  it("accepts the int64 maximum for every action", async () => {
    const { contract, ctx } = await deployInitialised();
    const limits: VaultTronFeeLimits = {
      withdraw: INT64_MAX,
      approve: INT64_MAX,
      supply: INT64_MAX,
      redeem: INT64_MAX,
    };
    const next = (await contract.circuits.setGasParams(ctx, 1n, 1n, 1n, 1n, 1n, 1n, 1n, limits))
      .context;
    expect(ledgerOf(next).vaultTronFeeLimits).toEqual(limits);
  });
});

/** {@link deployInitialised}, then list the 10^12- and 10^6-shifted TRC-20s. */
const deployWithShiftedTokens = async () => {
  const { contract, ctx } = await deployInitialised();
  let next = (
    await contract.circuits.addAllowedTronToken(ctx, SHIFTED_TRC20, SHIFTED_TOKEN_FEES, SHIFT_12)
  ).context;
  next = (await contract.circuits.addAllowedTronToken(next, MICRO_SHIFTED_TRC20, NO_FEES, SHIFT_6))
    .context;
  return { contract, ctx: next };
};

/** VALID_TRON_WITHDRAW of the 10^12-shifted TRC-20, its coin in the shifted colour. */
const VALID_SHIFTED_WITHDRAW: TronWithdrawCallArgs = {
  ...VALID_TRON_WITHDRAW,
  inIndex: 23n,
  withdraw: { ...VALID_TRON_WITHDRAW.withdraw, tokenAddress: SHIFTED_TRC20 },
  coin: vaultCoin(AMOUNT + SHIFTED_TOKEN_FEES.withdraw, SHIFTED_COLOR),
};

// A shifted TRC-20's request amount and fee are in coin units: the transfer moves
// amount·factor base units, and every burn, fee and refund is in the token's listed colour.
describe("Tron withdraw of a shifted TRC-20", () => {
  it.each([
    {
      name: "an unshifted TRC-20 moves the amount",
      args: VALID_TRON_WITHDRAW,
      base: AMOUNT,
    },
    {
      name: "a 10^6-shifted TRC-20 moves amount·10^6",
      args: {
        ...VALID_TRON_WITHDRAW,
        withdraw: { ...VALID_TRON_WITHDRAW.withdraw, tokenAddress: MICRO_SHIFTED_TRC20 },
        coin: vaultCoin(
          AMOUNT,
          colourOf(pureCircuits.tronCoinColour(MICRO_SHIFTED_TRC20, SHIFT_6)),
        ),
      },
      base: AMOUNT * SHIFT_6,
    },
    {
      name: "a 10^12-shifted TRC-20 moves amount·10^12",
      args: VALID_SHIFTED_WITHDRAW,
      base: AMOUNT * SHIFT_12,
    },
  ])("$name", async ({ args, base }) => {
    const { contract, ctx } = await deployWithShiftedTokens();
    const { context: sent, requestId } = await sentTronWithdraw(contract, ctx, args);
    expect(ledgerOf(sent).bidirectionalTronWithdrawMap.lookup(requestId).txParams.calldata).toEqual(
      {
        is_some: true,
        value: {
          selector: ERC20_TRANSFER_SELECTOR,
          noWords: 3n,
          words: [
            evmAddressAbiWord(DEST_TRON),
            numericAbiWord(base),
            pureCircuits.ownershipCommitment(args.inIndex, SECRET_KEY),
          ],
        },
      },
    );
    expect(ledgerOf(sent).tronWithdrawArgsMap.lookup(args.inIndex).request.amount).toBe(AMOUNT);
  });

  it("moves the largest coin's amount at the 10^12 shift", async () => {
    const { contract, ctx } = await deployWithShiftedTokens();
    const { context: sent, requestId } = await sentTronWithdraw(contract, ctx, {
      ...VALID_SHIFTED_WITHDRAW,
      withdraw: {
        ...VALID_SHIFTED_WITHDRAW.withdraw,
        amount: UINT64_MAX - SHIFTED_TOKEN_FEES.withdraw,
      },
      coin: vaultCoin(UINT64_MAX, SHIFTED_COLOR),
    });
    expect(
      ledgerOf(sent).bidirectionalTronWithdrawMap.lookup(requestId).txParams.calldata.value.words,
    ).toEqual([
      evmAddressAbiWord(DEST_TRON),
      numericAbiWord((UINT64_MAX - SHIFTED_TOKEN_FEES.withdraw) * SHIFT_12),
      pureCircuits.ownershipCommitment(VALID_SHIFTED_WITHDRAW.inIndex, SECRET_KEY),
    ]);
  });

  it("burns the coin and mints the fee in the shifted colour, in coin units", async () => {
    const { contract, ctx } = await deployWithShiftedTokens();
    const started = (await startTronWithdraw(contract, ctx, VALID_SHIFTED_WITHDRAW)).context;
    expect(shieldedMintsSince(ctx, started)).toEqual([
      [
        bytesToHex(pureCircuits.tronCoinColour(SHIFTED_TRC20, SHIFT_12)),
        SHIFTED_TOKEN_FEES.withdraw,
      ],
    ]);
    const outputs = zswapOutputs(started);
    const burn = first(
      outputs.filter((o) => o.recipient.is_left && o.recipient.left.bytes.every((b) => b === 0)),
      "burn output",
    );
    expect(burn.coinInfo.color).toEqual(SHIFTED_COLOR);
    expect(burn.coinInfo.value).toBe(AMOUNT + SHIFTED_TOKEN_FEES.withdraw);
    const fee = first(
      outputs.filter(
        (o) =>
          o.recipient.is_left &&
          bytesToHex(o.recipient.left.bytes) === bytesToHex(FEE_RECIPIENT_CPK),
      ),
      "fee output",
    );
    expect(fee.coinInfo).toEqual({
      nonce: pureCircuits.feeMintNonce(VALID_SHIFTED_WITHDRAW.coin.nonce),
      color: SHIFTED_COLOR,
      value: SHIFTED_TOKEN_FEES.withdraw,
    });
  });

  it.each([
    ["its unshifted colour", colourOf(pureCircuits.vaultTronTokenDomainSeparator(SHIFTED_TRC20))],
    ["its colour at another factor", colourOf(pureCircuits.tronCoinColour(SHIFTED_TRC20, SHIFT_6))],
    [
      "another token's colour at the same factor",
      colourOf(pureCircuits.tronCoinColour(MICRO_SHIFTED_TRC20, SHIFT_12)),
    ],
  ] as const)("refuses a coin in %s", async (_name, colour) => {
    const { contract, ctx } = await deployWithShiftedTokens();
    await expect(
      startTronWithdraw(contract, ctx, {
        ...VALID_SHIFTED_WITHDRAW,
        coin: vaultCoin(AMOUNT + SHIFTED_TOKEN_FEES.withdraw, colour),
      }),
    ).rejects.toThrow(/Coin is not the vault token for this TRC-20/);
  });

  it.each([OutputKind.failed, OutputKind.unviable])(
    "re-mints the amount in the shifted colour on a %s transfer",
    async (outputKind) => {
      const { contract, ctx } = await deployWithShiftedTokens();
      const { context: sent, requestId } = await sentTronWithdraw(
        contract,
        ctx,
        VALID_SHIFTED_WITHDRAW,
      );
      const attested = await attest(
        contract,
        sent,
        respond(requestId, outputKind, OUTPUT_EMPTY, TRON_ATTESTED_HEIGHT),
      );
      const settled = (
        await contract.circuits.completeTronWithdraw(
          attested,
          requestId,
          OUTPUT_IGNORED,
          MINT_NONCE,
        )
      ).context;
      expect(coinsMinted(attested, settled).map(({ coinInfo }) => coinInfo)).toEqual([
        { nonce: MINT_NONCE, color: SHIFTED_COLOR, value: AMOUNT },
      ]);
    },
  );

  it("refunds an unsent withdrawal in the shifted colour", async () => {
    const { contract, ctx } = await deployWithShiftedTokens();
    const { context: flushed } = await flushedTronWithdraw(contract, ctx, VALID_SHIFTED_WITHDRAW);
    const closed = atBlockTime(flushed, SEND_CLOSED_TIME);
    const refunded = (
      await contract.circuits.refundUnsentTronWithdraw(
        closed,
        VALID_SHIFTED_WITHDRAW.inIndex,
        MINT_NONCE,
      )
    ).context;
    expect(coinsMinted(closed, refunded).map(({ coinInfo }) => coinInfo)).toEqual([
      { nonce: MINT_NONCE, color: SHIFTED_COLOR, value: AMOUNT },
    ]);
  });

  // Deposit AMOUNT coin units (AMOUNT·10^12 base units in), then withdraw that very coin:
  // AMOUNT - fee units leave as (AMOUNT - fee)·10^12 base units, and the fee stays a coin.
  it("round-trips a deposit to a withdrawal exactly, in coin units", async () => {
    const { contract, ctx } = await deployWithShiftedTokens();
    const depositStarted = (
      await contract.circuits.startTronDeposit(
        ctx,
        80n,
        { ...VALID_TRON_WITHDRAW.tronTx, feeLimit: DEFAULT_TRON_FEE_LIMIT },
        { tokenAddress: SHIFTED_TRC20, amount: AMOUNT },
      )
    ).context;
    const depositOut = queuedRequestIndex(ledgerOf(depositStarted), 80n);
    const depositFlushed = await flush(contract, depositStarted, [80n], []);
    const depositSent = (await contract.circuits.sendTronDeposit(depositFlushed, depositOut))
      .context;
    const depositId = first(ledgerOf(depositSent).bidirectionalTronDepositMap, "Tron deposit")[0];
    expect(
      ledgerOf(depositSent).bidirectionalTronDepositMap.lookup(depositId).txParams.calldata.value
        .words,
    ).toEqual([evmAddressAbiWord(VAULT_EVM), numericAbiWord(AMOUNT * SHIFT_12)]);
    const depositAttested = await attest(
      contract,
      depositSent,
      respond(depositId, OutputKind.executed, OUTPUT_TRUE, TRON_ATTESTED_HEIGHT),
    );
    const deposited = (
      await contract.circuits.completeTronDeposit(
        depositAttested,
        depositId,
        OUTPUT_TRUE,
        MINT_NONCE,
        {
          is_some: false,
          value: {
            is_left: true,
            left: { bytes: new Uint8Array(32) },
            right: { bytes: new Uint8Array(32) },
          },
        },
      )
    ).context;
    const coin = first(coinsMinted(depositAttested, deposited), "deposited coin").coinInfo;
    expect(coin).toEqual({ nonce: MINT_NONCE, color: SHIFTED_COLOR, value: AMOUNT });

    const withdrawAmount = AMOUNT - SHIFTED_TOKEN_FEES.withdraw;
    const withdrawn = await sentTronWithdraw(contract, deposited, {
      ...VALID_SHIFTED_WITHDRAW,
      withdraw: { ...VALID_SHIFTED_WITHDRAW.withdraw, amount: withdrawAmount },
      tronTx: { ...VALID_SHIFTED_WITHDRAW.tronTx, timestamp: ms(NOW - 9) },
      coin,
    });
    expect(
      ledgerOf(withdrawn.context).bidirectionalTronWithdrawMap.lookup(withdrawn.requestId).txParams
        .calldata.value.words,
    ).toEqual([
      evmAddressAbiWord(DEST_TRON),
      numericAbiWord(withdrawAmount * SHIFT_12),
      pureCircuits.ownershipCommitment(VALID_SHIFTED_WITHDRAW.inIndex, SECRET_KEY),
    ]);
    expect(shieldedMintsSince(deposited, withdrawn.context)).toEqual([
      [
        bytesToHex(pureCircuits.tronCoinColour(SHIFTED_TRC20, SHIFT_12)),
        SHIFTED_TOKEN_FEES.withdraw,
      ],
    ]);
    const withdrawAttested = await attest(
      contract,
      withdrawn.context,
      respond(withdrawn.requestId, OutputKind.executed, OUTPUT_TRUE, TRON_ATTESTED_HEIGHT + 1n),
    );
    const settled = (
      await contract.circuits.completeTronWithdraw(
        withdrawAttested,
        withdrawn.requestId,
        OUTPUT_TRUE,
        MINT_NONCE,
      )
    ).context;
    expect(coinsMinted(withdrawAttested, settled)).toEqual([]);
  });
});

import { readFileSync } from "node:fs";

import {
  type CircuitContext,
  CompactTypeBytes,
  CompactTypeVector,
  createCircuitContext,
  createConstructorContext,
  rawTokenType,
  sampleContractAddress,
  transientHash,
  upgradeFromTransient,
} from "@midnight-ntwrk/compact-runtime";
import { ContractOperation, ContractState } from "@midnightntwrk/onchain-runtime-v4";
import {
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
  VAULT_TRON_DEPOSIT_REQUESTS_PATH,
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
const EVM_ATTESTED_HEIGHT = 101n;

const SIGNET_ADDRESS = sampleContractAddress();
const BLOCK_HASH = "0".repeat(64);
const VAULT_ADDRESS = sampleContractAddress();

const VAULT_EVM = bytes(20, 0xee);
const ROUTER = bytes(20, 0x11);
const STATA_UNDERLYING = bytes(20, 0xdd);
const STATA_TOKEN = bytes(20, 0xcc);
const ERC20 = bytes(20, 0xaa);
const TRC20 = bytes(20, 0x7a);
const UNLISTED_TRC20 = bytes(20, 0x99);
const TRON_USDT = bytes(20, 0x75);
// An 18-decimal share token whose coins count 10^12 base units each (6-decimal coins), and
// a 12-decimal token whose coins count 10^6.
const SHIFTED_TRC20 = bytes(20, 0x5a);
const MICRO_SHIFTED_TRC20 = bytes(20, 0x6b);
const ZERO_ADDRESS = new Uint8Array(20);
const CHAIN_ID = 11155111n;
const NO_FEES = { withdraw: 0n, swap: 0n, supply: 0n, redeem: 0n };
const TRON_TOKEN_FEES = { withdraw: 71n, swap: 73n, supply: 79n, redeem: 83n };
const SHIFTED_TOKEN_FEES = { withdraw: 3n, swap: 5n, supply: 7n, redeem: 11n };
const UNSHIFTED = 1n;
const SHIFT_12 = 10n ** 12n;
const SHIFT_6 = 10n ** 6n;
const AMOUNT = 1_000_000n;
const UINT64_MAX = 18446744073709551615n;
const INT64_MAX = 9223372036854775807n;
const MINT_NONCE = bytes(32, 0x2e);
const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

const colourOf = (domainSeparator: Uint8Array): Uint8Array =>
  hexToBytes(rawTokenType(domainSeparator, VAULT_ADDRESS));
const TRON_TOKEN_COLOR = colourOf(pureCircuits.vaultTronTokenDomainSeparator(TRC20));

interface TronDepositCallArgs {
  inIndex: bigint;
  tronTx: {
    refBlockBytes: Uint8Array;
    refBlockHash: Uint8Array;
    timestamp: bigint;
    expiration: bigint;
    feeLimit: bigint;
  };
  deposit: { tokenAddress: Uint8Array; amount: bigint };
}

const VALID_TRON_DEPOSIT: TronDepositCallArgs = {
  inIndex: 1n,
  tronTx: {
    refBlockBytes: Uint8Array.of(0x12, 0x34),
    refBlockHash: bytes(8, 0x56),
    timestamp: 1_700_000_000_000n,
    expiration: 1_700_003_600_000n,
    feeLimit: 100_000_000n,
  },
  deposit: { tokenAddress: TRC20, amount: AMOUNT },
};

const VALID_EVM_DEPOSIT = {
  inIndex: 50n,
  evmNonce: 0n,
  gas: { gasLimit: 100_000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n },
  deposit: { erc20Address: ERC20, amount: AMOUNT },
};

const CALLER_RECIPIENT = {
  is_some: false,
  value: {
    is_left: true,
    left: { bytes: new Uint8Array(32) },
    right: { bytes: new Uint8Array(32) },
  },
};
const OTHER_WALLET_RECIPIENT = {
  is_some: true,
  value: { is_left: true, left: { bytes: bytes(32, 0x21) }, right: { bytes: new Uint8Array(32) } },
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

const contextOf = (state: unknown, secretKey: Uint8Array): VaultContext =>
  createCircuitContext({
    circuitId: "startTronDeposit",
    contractAddress: VAULT_ADDRESS,
    coinPublicKeyOrZswapState: CPK,
    contractState: state as never,
    privateState: createVaultPrivateState(secretKey),
    parentBlockHash: BLOCK_HASH,
    crossContract: signetCrossContract,
  });

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

const deployInitialised = async () => {
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
      TRON_USDT,
      NO_FEES,
      NO_FEES,
      { bytes: bytes(32, 0xfe) },
      bytes(32, 0xef),
    )
  ).context;
  next = (await contract.circuits.addAllowedToken(next, ERC20, NO_FEES)).context;
  next = (await contract.circuits.addAllowedTronToken(next, TRC20, TRON_TOKEN_FEES, UNSHIFTED))
    .context;
  next = (await contract.circuits.addAllowedTronToken(next, TRON_USDT, NO_FEES, UNSHIFTED)).context;
  next = (
    await contract.circuits.addAllowedTronToken(next, SHIFTED_TRC20, SHIFTED_TOKEN_FEES, SHIFT_12)
  ).context;
  next = (await contract.circuits.addAllowedTronToken(next, MICRO_SHIFTED_TRC20, NO_FEES, SHIFT_6))
    .context;
  return { contract, ctx: next };
};

const flush = async (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  inIndexes: readonly bigint[],
  requestIds: readonly Uint8Array[],
): Promise<VaultContext> =>
  (await contract.circuits.flushQueue(ctx, flushSlots(inIndexes, requestIds))).context;

const queueTronDeposit = (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  args: TronDepositCallArgs,
) => contract.circuits.startTronDeposit(ctx, args.inIndex, args.tronTx, args.deposit);

const tronDeposit = async (
  contract: Contract<VaultPrivateState>,
  ctx: VaultContext,
  args: TronDepositCallArgs,
) => {
  const queued = (await queueTronDeposit(contract, ctx, args)).context;
  const outIndex = queuedRequestIndex(ledgerOf(queued), args.inIndex);
  const flushed = await flush(contract, queued, [args.inIndex], []);
  const sent = (await contract.circuits.sendTronDeposit(flushed, outIndex)).context;
  const requestId = first(ledgerOf(sent).bidirectionalTronDepositMap, "Tron request")[0];
  return { context: sent, outIndex, requestId };
};

const evmDeposit = async (contract: Contract<VaultPrivateState>, ctx: VaultContext) => {
  const { inIndex, evmNonce, gas, deposit } = VALID_EVM_DEPOSIT;
  const queued = (await contract.circuits.startDeposit(ctx, inIndex, evmNonce, gas, deposit))
    .context;
  const outIndex = queuedRequestIndex(ledgerOf(queued), inIndex);
  const flushed = await flush(contract, queued, [inIndex], []);
  const sent = (await contract.circuits.sendDeposit(flushed, outIndex)).context;
  const requestId = first(ledgerOf(sent).bidirectionalDepositMap, "deposit request")[0];
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

const coinsMinted = (before: VaultContext, settled: VaultContext) => {
  const beforeState = before.callContext.currentZswapLocalState;
  const settledState = settled.callContext.currentZswapLocalState;
  if (!beforeState || !settledState) {
    throw new Error("expected zswap local state on the circuit context");
  }
  return settledState.outputs.slice(beforeState.outputs.length);
};

const OUTPUT_EMPTY = new Uint8Array(0);
const OUTPUT_TRUE = Uint8Array.of(1);
const OUTPUT_FALSE = Uint8Array.of(0);
const VAULT_OUTPUT_SCHEMA = new TextEncoder().encode('[{"name":"success","type":"bool"}]');

describe("initialise", () => {
  it("seals each chain's start height in its own cell", async () => {
    const { ctx } = await deployInitialised();
    expect(ledgerOf(ctx).globalLastSeen).toBe(EVM_START_HEIGHT);
    expect(ledgerOf(ctx).tronLastSeen).toBe(TRON_START_HEIGHT);
  });

  it("stores the Tron USDT address", async () => {
    const { ctx } = await deployInitialised();
    expect(ledgerOf(ctx).tronUsdtAddress).toEqual(TRON_USDT);
  });
});

describe("addAllowedTronToken", () => {
  it("allows the TRC-20 with its fees for Tron deposits only, not as an ERC20", async () => {
    const { ctx } = await deployInitialised();
    expect(ledgerOf(ctx).allowedTronTokens.lookup(TRC20)).toEqual({
      fees: TRON_TOKEN_FEES,
      factor: UNSHIFTED,
      colour: pureCircuits.vaultTronTokenDomainSeparator(TRC20),
    });
    expect(ledgerOf(ctx).allowedTokens.member(TRC20)).toBe(false);
  });

  it("stores a shifted TRC-20's factor and its shifted colour", async () => {
    const { ctx } = await deployInitialised();
    expect(ledgerOf(ctx).allowedTronTokens.lookup(SHIFTED_TRC20)).toEqual({
      fees: SHIFTED_TOKEN_FEES,
      factor: SHIFT_12,
      colour: pureCircuits.tronCoinColour(SHIFTED_TRC20, SHIFT_12),
    });
    expect(ledgerOf(ctx).allowedTronTokens.lookup(SHIFTED_TRC20).colour).not.toEqual(
      pureCircuits.vaultTronTokenDomainSeparator(SHIFTED_TRC20),
    );
  });

  it.each([
    ["the same factor", UNSHIFTED],
    ["another factor", SHIFT_12],
  ] as const)("refuses to relist a TRC-20 with %s, keeping its listing", async (_name, factor) => {
    const { contract, ctx } = await deployInitialised();
    await expect(
      contract.circuits.addAllowedTronToken(ctx, TRC20, NO_FEES, factor),
    ).rejects.toThrow(/TRC-20 already allowed/);
    expect(ledgerOf(ctx).allowedTronTokens.lookup(TRC20)).toEqual({
      fees: TRON_TOKEN_FEES,
      factor: UNSHIFTED,
      colour: pureCircuits.vaultTronTokenDomainSeparator(TRC20),
    });
  });

  it("refuses a zero factor", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(
      contract.circuits.addAllowedTronToken(ctx, UNLISTED_TRC20, TRON_TOKEN_FEES, 0n),
    ).rejects.toThrow(/Factor must be positive/);
  });

  it("a Tron deposit takes no fee: the full amount is minted on an executed transfer", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronDeposit(contract, ctx, VALID_TRON_DEPOSIT);
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
    const next = (
      await contract.circuits.completeTronDeposit(
        attested,
        requestId,
        OUTPUT_TRUE,
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;
    expect(coinsMinted(attested, next).map(({ coinInfo }) => coinInfo.value)).toEqual([AMOUNT]);
  });

  it("an ERC20 the vault allows is not a TRC-20 it allows", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(
      queueTronDeposit(contract, ctx, {
        ...VALID_TRON_DEPOSIT,
        deposit: { tokenAddress: ERC20, amount: AMOUNT },
      }),
    ).rejects.toThrow(/TRC-20 not allowed/);
  });

  it("a TRC-20 the vault allows is not an ERC20 startDeposit accepts", async () => {
    const { contract, ctx } = await deployInitialised();
    const { inIndex, evmNonce, gas } = VALID_EVM_DEPOSIT;
    await expect(
      contract.circuits.startDeposit(ctx, inIndex, evmNonce, gas, {
        erc20Address: TRC20,
        amount: AMOUNT,
      }),
    ).rejects.toThrow(/ERC20 not allowed/);
  });

  it("is deployer-gated", async () => {
    const { contract, ctx } = await deployInitialised();
    const stranger = contextOf(ctx.callContext.currentQueryContext.state, OTHER_SECRET_KEY);
    await expect(
      contract.circuits.addAllowedTronToken(stranger, UNLISTED_TRC20, TRON_TOKEN_FEES, UNSHIFTED),
    ).rejects.toThrow(/Not the deployer/);
  });

  it("rejects the zero address", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(
      contract.circuits.addAllowedTronToken(ctx, ZERO_ADDRESS, TRON_TOKEN_FEES, UNSHIFTED),
    ).rejects.toThrow(/TRC-20 address cannot be zero/);
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.addAllowedTronToken(ctx, TRC20, TRON_TOKEN_FEES, UNSHIFTED),
    ).rejects.toThrow(/Not initialised/);
  });
});

describe("setTronTokenFees", () => {
  const REPRICED_FEES = { withdraw: 101n, swap: 103n, supply: 107n, redeem: 109n };

  it.each([
    ["an unshifted", TRC20, UNSHIFTED],
    ["a shifted", SHIFTED_TRC20, SHIFT_12],
  ] as const)(
    "reprices %s TRC-20 and keeps its factor and colour",
    async (_name, token, factor) => {
      const { contract, ctx } = await deployInitialised();
      const repriced = (await contract.circuits.setTronTokenFees(ctx, token, REPRICED_FEES))
        .context;
      expect(ledgerOf(repriced).allowedTronTokens.lookup(token)).toEqual({
        fees: REPRICED_FEES,
        factor,
        colour: pureCircuits.tronCoinColour(token, factor),
      });
    },
  );

  it("refuses a TRC-20 the vault does not allow", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(
      contract.circuits.setTronTokenFees(ctx, UNLISTED_TRC20, REPRICED_FEES),
    ).rejects.toThrow(/TRC-20 not allowed/);
  });

  it("refuses an ERC20 the vault allows", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(contract.circuits.setTronTokenFees(ctx, ERC20, REPRICED_FEES)).rejects.toThrow(
      /TRC-20 not allowed/,
    );
  });

  it("is deployer-gated", async () => {
    const { contract, ctx } = await deployInitialised();
    const stranger = contextOf(ctx.callContext.currentQueryContext.state, OTHER_SECRET_KEY);
    await expect(
      contract.circuits.setTronTokenFees(stranger, TRC20, REPRICED_FEES),
    ).rejects.toThrow(/Not the deployer/);
  });

  it("refuses before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(contract.circuits.setTronTokenFees(ctx, TRC20, REPRICED_FEES)).rejects.toThrow(
      /Not initialised/,
    );
  });
});

describe("vaultTronTokenDomainSeparator", () => {
  it("differs from the ERC20 colour domain at the same 20-byte address", () => {
    expect(pureCircuits.vaultTronTokenDomainSeparator(TRC20)).not.toEqual(
      pureCircuits.vaultTokenDomainSeparator(TRC20),
    );
  });
});

/** `value` as `Bytes<32>`: little-endian, zero-padded, as Compact's `as Field as Bytes<32>`. */
const fieldBytes = (value: Uint8Array | bigint): Uint8Array => {
  const out = new Uint8Array(32);
  if (typeof value === "bigint") {
    for (let i = 0, rest = value; rest > 0n; i += 1, rest >>= 8n) out[i] = Number(rest & 0xffn);
  } else {
    out.set(value);
  }
  return out;
};

/** `pad(32, text)`: the ASCII bytes, zero-padded. */
const padded = (text: string): Uint8Array => fieldBytes(new TextEncoder().encode(text));

describe("tronCoinColour", () => {
  // The colour definitions, recomputed with the runtime's own transientHash: a change to a
  // tag, an input or their order renames coins already minted.
  it.each([
    {
      name: "an unshifted token keeps hash(vault:token:tron:, token)",
      factor: UNSHIFTED,
      inputs: [padded("vault:token:tron:"), fieldBytes(SHIFTED_TRC20)],
    },
    {
      name: "a shifted token is hash(vault:token:tron:shifted:, token, factor)",
      factor: SHIFT_12,
      inputs: [
        padded("vault:token:tron:shifted:"),
        fieldBytes(SHIFTED_TRC20),
        fieldBytes(SHIFT_12),
      ],
    },
  ])("$name", ({ factor, inputs }) => {
    const hashType = new CompactTypeVector(inputs.length, new CompactTypeBytes(32));
    expect(pureCircuits.tronCoinColour(SHIFTED_TRC20, factor)).toEqual(
      upgradeFromTransient(transientHash(hashType, inputs)),
    );
  });

  it("keeps an unshifted token's colour: vaultTronTokenDomainSeparator", () => {
    expect(pureCircuits.tronCoinColour(SHIFTED_TRC20, UNSHIFTED)).toEqual(
      pureCircuits.vaultTronTokenDomainSeparator(SHIFTED_TRC20),
    );
  });

  it.each([
    ["the same token unshifted", SHIFTED_TRC20, UNSHIFTED],
    ["the same token at another factor", SHIFTED_TRC20, SHIFT_6],
    ["another token at the same factor", MICRO_SHIFTED_TRC20, SHIFT_12],
  ] as const)("gives a shifted token a colour apart from %s", (_name, token, factor) => {
    expect(pureCircuits.tronCoinColour(SHIFTED_TRC20, SHIFT_12)).not.toEqual(
      pureCircuits.tronCoinColour(token, factor),
    );
  });

  it("gives a shifted token a colour apart from the ERC20 colour of its address", () => {
    expect(pureCircuits.tronCoinColour(SHIFTED_TRC20, SHIFT_12)).not.toEqual(
      pureCircuits.vaultTokenDomainSeparator(SHIFTED_TRC20),
    );
  });
});

describe("tronBaseOfUnits and tronUnitsOfBaseFloor", () => {
  it.each([
    { name: "an unshifted amount", units: AMOUNT, factor: UNSHIFTED, base: AMOUNT },
    { name: "a 10^12 shift", units: AMOUNT, factor: SHIFT_12, base: AMOUNT * SHIFT_12 },
    {
      name: "the Uint<64> maximum at the Uint<64> maximum factor",
      units: UINT64_MAX,
      factor: UINT64_MAX,
      base: UINT64_MAX * UINT64_MAX,
    },
  ])("scales $name to base units", ({ units, factor, base }) => {
    expect(pureCircuits.tronBaseOfUnits(units, factor)).toBe(base);
  });

  it.each([
    { name: "an exact multiple", base: 5n * SHIFT_12, q: 5n },
    { name: "the largest remainder", base: 6n * SHIFT_12 - 1n, q: 5n },
    { name: "a base below one unit", base: SHIFT_12 - 1n, q: 0n },
    { name: "the Uint<64> maximum quotient", base: UINT64_MAX * SHIFT_12 + 1n, q: UINT64_MAX },
  ])("accepts the floor quotient of $name", ({ base, q }) => {
    expect(pureCircuits.tronUnitsOfBaseFloor(base, SHIFT_12, q)).toBe(q);
  });

  it.each([
    {
      name: "one too large",
      base: 5n * SHIFT_12,
      factor: SHIFT_12,
      q: 6n,
      error: /Quotient too large/,
    },
    {
      name: "short by one whole factor",
      base: 5n * SHIFT_12,
      factor: SHIFT_12,
      q: 4n,
      error: /Quotient too small/,
    },
    {
      name: "one too small",
      base: 6n * SHIFT_12 - 1n,
      factor: SHIFT_12,
      q: 4n,
      error: /Quotient too small/,
    },
    {
      name: "unshifted one too large",
      base: AMOUNT,
      factor: UNSHIFTED,
      q: AMOUNT + 1n,
      error: /Quotient too large/,
    },
    {
      name: "unshifted one too small",
      base: AMOUNT,
      factor: UNSHIFTED,
      q: AMOUNT - 1n,
      error: /Quotient too small/,
    },
  ])("refuses a quotient $name", ({ base, factor, q, error }) => {
    expect(() => pureCircuits.tronUnitsOfBaseFloor(base, factor, q)).toThrow(error);
  });
});

describe("Tron deposit round-trip", () => {
  it("stores a contract-composed Tron event readable via ledger() and the RAW reader", async () => {
    const { contract, ctx } = await deployInitialised();
    const {
      context: sent,
      outIndex,
      requestId,
    } = await tronDeposit(contract, ctx, VALID_TRON_DEPOSIT);
    const state = sent.callContext.currentQueryContext.state;

    const rawLedger = readSignetRequestsLedgerFromState(state, VAULT_TRON_DEPOSIT_REQUESTS_PATH);
    expect(rawLedger.requestsIndex.size).toBe(1);
    const record = first(rawLedger.requestsIndex.values(), "raw Tron request");
    if (!isTronRequest(record)) {
      throw new Error("expected a Tron request record");
    }
    expect(requestIdHex(calculateRequestId(record))).toBe(requestIdHex(requestId));
    expect(record).toEqual(ledgerOf(sent).bidirectionalTronDepositMap.lookup(requestId));

    const notification = first(
      decodeSignetLogEvents(sent.events, SIGNET_ADDRESS),
      "signet notification event",
    );
    const post = decodeSignBidirectionalEventNotificationPayload(notification.payload);
    expect(requestIdHex(post.requestId)).toBe(requestIdHex(requestId));
    expect(decodeSignBidirectionalNotification(post.event)).toEqual({
      version: 1,
      callerAddress: bytesToHex(hexToBytes(VAULT_ADDRESS)),
      requestsPath: [...VAULT_TRON_DEPOSIT_REQUESTS_PATH],
    });

    expect(record.txParamType).toBe(TxParamType.tronTriggerSmartContract);
    expect(record.path).toEqual(DEPLOYER_COMMITMENT);
    expect(record.keyVersion).toBe(MPC_KEY_VERSION);
    expect(record.algo).toBe(MPCSignatureAlgorithm.ecdsa);
    expect(record.signatureDest).toBe(MPCDestination.unused);
    expect(record.executionDest).toEqual(signetCircuits.tronCaip2Id());
    expect(record.outputDeserializationSchema).toEqual(VAULT_OUTPUT_SCHEMA);
    expect(record.respondSerializationSchema).toEqual(new Uint8Array(0));
    expect(record.txParams).toEqual({
      ...VALID_TRON_DEPOSIT.tronTx,
      contractAddress: Uint8Array.of(0x41, ...TRC20),
      callValue: 0n,
      calldata: {
        is_some: true,
        value: {
          selector: ERC20_TRANSFER_SELECTOR,
          noWords: 2n,
          words: [evmAddressAbiWord(VAULT_EVM), numericAbiWord(AMOUNT)],
        },
      },
    });

    const { entry, lastSeen } = ledgerOf(sent).outputRequestBuffer.lookup(outIndex);
    expect(entry).toEqual({
      action: Action.tronDeposit,
      chain: Chain.tron,
      useNextVaultAccountNonce: false,
      evmNonce: 0n,
      inIndex: VALID_TRON_DEPOSIT.inIndex,
      commitment: pureCircuits.ownershipCommitment(VALID_TRON_DEPOSIT.inIndex, SECRET_KEY),
      argsHash: expect.any(Uint8Array) as Uint8Array,
    });
    expect(lastSeen).toBe(TRON_START_HEIGHT);
    expect(ledgerOf(sent).tronDepositArgsMap.lookup(VALID_TRON_DEPOSIT.inIndex)).toEqual({
      request: VALID_TRON_DEPOSIT.deposit,
      path: DEPLOYER_COMMITMENT,
      tx: VALID_TRON_DEPOSIT.tronTx,
    });
    expect(ledgerOf(sent).evictionMap.lookup(requestId)).toEqual(outIndex);
  });

  it("an identical repeat shares the request index and waits while the first is open", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: afterFirst, outIndex } = await tronDeposit(contract, ctx, VALID_TRON_DEPOSIT);
    const repeat = { ...VALID_TRON_DEPOSIT, inIndex: 2n };
    const queued = (await queueTronDeposit(contract, afterFirst, repeat)).context;
    expect(queuedRequestIndex(ledgerOf(queued), repeat.inIndex)).toEqual(outIndex);
    await expect(flush(contract, queued, [repeat.inIndex], [])).rejects.toThrow(
      /Identical request open/,
    );
  });

  it.each([
    { field: "refBlockBytes", delta: { refBlockBytes: Uint8Array.of(0x12, 0x35) } },
    { field: "refBlockHash", delta: { refBlockHash: bytes(8, 0x57) } },
    { field: "timestamp", delta: { timestamp: VALID_TRON_DEPOSIT.tronTx.timestamp + 1n } },
    { field: "expiration", delta: { expiration: VALID_TRON_DEPOSIT.tronTx.expiration + 1n } },
    { field: "feeLimit", delta: { feeLimit: VALID_TRON_DEPOSIT.tronTx.feeLimit + 1n } },
  ])("a deposit differing only in $field gets its own request index", async ({ delta }) => {
    const { contract, ctx } = await deployInitialised();
    const { context: afterFirst, outIndex } = await tronDeposit(contract, ctx, VALID_TRON_DEPOSIT);
    const other = {
      ...VALID_TRON_DEPOSIT,
      inIndex: 2n,
      tronTx: { ...VALID_TRON_DEPOSIT.tronTx, ...delta },
    };
    const queued = (await queueTronDeposit(contract, afterFirst, other)).context;
    expect(queuedRequestIndex(ledgerOf(queued), other.inIndex)).not.toEqual(outIndex);
  });

  it("sendTronDeposit is permissionless and refuses a second send", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueTronDeposit(contract, ctx, VALID_TRON_DEPOSIT)).context;
    const outIndex = queuedRequestIndex(ledgerOf(queued), VALID_TRON_DEPOSIT.inIndex);
    const flushed = await flush(contract, queued, [VALID_TRON_DEPOSIT.inIndex], []);
    const stranger = contextOf(flushed.callContext.currentQueryContext.state, OTHER_SECRET_KEY);
    const sent = (await contract.circuits.sendTronDeposit(stranger, outIndex)).context;
    expect(ledgerOf(sent).bidirectionalTronDepositMap.size()).toBe(1n);
    await expect(contract.circuits.sendTronDeposit(sent, outIndex)).rejects.toThrow(
      /Request already sent/,
    );
  });

  it("sendTronDeposit refuses an index the flush has not moved", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueTronDeposit(contract, ctx, VALID_TRON_DEPOSIT)).context;
    const outIndex = queuedRequestIndex(ledgerOf(queued), VALID_TRON_DEPOSIT.inIndex);
    await expect(contract.circuits.sendTronDeposit(queued, outIndex)).rejects.toThrow(
      /Request not flushed/,
    );
  });

  it("sendTronDeposit refuses an Ethereum deposit's index, and sendDeposit a Tron deposit's", async () => {
    const { contract, ctx } = await deployInitialised();
    const { inIndex, evmNonce, gas, deposit } = VALID_EVM_DEPOSIT;
    const evmQueued = (await contract.circuits.startDeposit(ctx, inIndex, evmNonce, gas, deposit))
      .context;
    const tronQueued = (await queueTronDeposit(contract, evmQueued, VALID_TRON_DEPOSIT)).context;
    const evmOut = queuedRequestIndex(ledgerOf(tronQueued), inIndex);
    const tronOut = queuedRequestIndex(ledgerOf(tronQueued), VALID_TRON_DEPOSIT.inIndex);
    const flushed = await flush(contract, tronQueued, [inIndex, VALID_TRON_DEPOSIT.inIndex], []);
    await expect(contract.circuits.sendTronDeposit(flushed, evmOut)).rejects.toThrow(
      /Wrong action/,
    );
    await expect(contract.circuits.sendDeposit(flushed, tronOut)).rejects.toThrow(/Wrong action/);
  });
});

interface TronDepositRejectionCase {
  name: string;
  args: TronDepositCallArgs;
  throws: RegExp;
}

const TRON_DEPOSIT_REJECTION_CASES: TronDepositRejectionCase[] = [
  {
    name: "a TRC-20 the vault does not allow",
    args: { ...VALID_TRON_DEPOSIT, deposit: { tokenAddress: UNLISTED_TRC20, amount: AMOUNT } },
    throws: /TRC-20 not allowed/,
  },
  {
    name: "a zero amount",
    args: { ...VALID_TRON_DEPOSIT, deposit: { tokenAddress: TRC20, amount: 0n } },
    throws: /Amount must be positive/,
  },
  {
    name: "an amount above Uint<64> max (unclaimable)",
    args: { ...VALID_TRON_DEPOSIT, deposit: { tokenAddress: TRC20, amount: UINT64_MAX + 1n } },
    throws: /Amount exceeds Uint<64> max/,
  },
  {
    name: "a zero fee limit",
    args: { ...VALID_TRON_DEPOSIT, tronTx: { ...VALID_TRON_DEPOSIT.tronTx, feeLimit: 0n } },
    throws: /Fee limit must be positive/,
  },
  {
    name: "a fee limit past int64",
    args: {
      ...VALID_TRON_DEPOSIT,
      tronTx: { ...VALID_TRON_DEPOSIT.tronTx, feeLimit: INT64_MAX + 1n },
    },
    throws: /Fee limit exceeds int64/,
  },
  {
    name: "an expiration equal to the timestamp",
    args: {
      ...VALID_TRON_DEPOSIT,
      tronTx: { ...VALID_TRON_DEPOSIT.tronTx, expiration: VALID_TRON_DEPOSIT.tronTx.timestamp },
    },
    throws: /Expiration must follow timestamp/,
  },
  {
    name: "an expiration past int64",
    args: {
      ...VALID_TRON_DEPOSIT,
      tronTx: { ...VALID_TRON_DEPOSIT.tronTx, expiration: INT64_MAX + 1n },
    },
    throws: /Expiration exceeds int64/,
  },
];

describe("Tron deposit validation", () => {
  it.each(TRON_DEPOSIT_REJECTION_CASES)("rejects $name", async ({ args, throws }) => {
    const { contract, ctx } = await deployInitialised();
    await expect(queueTronDeposit(contract, ctx, args)).rejects.toThrow(throws);
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(queueTronDeposit(contract, ctx, VALID_TRON_DEPOSIT)).rejects.toThrow(
      /Not initialised/,
    );
  });

  it("rejects an index another action's queued request holds", async () => {
    const { contract, ctx } = await deployInitialised();
    const { inIndex, evmNonce, gas, deposit } = VALID_EVM_DEPOSIT;
    const queued = (await contract.circuits.startDeposit(ctx, inIndex, evmNonce, gas, deposit))
      .context;
    await expect(
      queueTronDeposit(contract, queued, { ...VALID_TRON_DEPOSIT, inIndex }),
    ).rejects.toThrow(/Index already in use/);
  });

  it("rejects an index the flush freed while its args stay in tronDepositArgsMap", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueTronDeposit(contract, ctx, VALID_TRON_DEPOSIT)).context;
    const flushed = await flush(contract, queued, [VALID_TRON_DEPOSIT.inIndex], []);
    await expect(
      queueTronDeposit(contract, flushed, {
        ...VALID_TRON_DEPOSIT,
        deposit: { tokenAddress: TRC20, amount: AMOUNT + 1n },
      }),
    ).rejects.toThrow(/Index already in use/);
  });
});

describe("completeTronDeposit settle", () => {
  it.each([
    {
      name: "no recipient: mints to the caller",
      recipient: CALLER_RECIPIENT,
      mintedTo: {
        is_left: true,
        left: { bytes: hexToBytes(CPK) },
        right: { bytes: new Uint8Array(32) },
      },
    },
    {
      name: "an explicit wallet recipient: mints to it",
      recipient: OTHER_WALLET_RECIPIENT,
      mintedTo: OTHER_WALLET_RECIPIENT.value,
    },
  ])("executed, $name, and consumes the request", async ({ recipient, mintedTo }) => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronDeposit(contract, ctx, VALID_TRON_DEPOSIT);
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
    const next = (
      await contract.circuits.completeTronDeposit(
        attested,
        requestId,
        OUTPUT_TRUE,
        MINT_NONCE,
        recipient,
      )
    ).context;

    expect(coinsMinted(attested, next)).toEqual([
      {
        coinInfo: { nonce: MINT_NONCE, color: TRON_TOKEN_COLOR, value: AMOUNT },
        recipient: mintedTo,
      },
    ]);
    const state = ledgerOf(next);
    expect(state.bidirectionalTronDepositMap.isEmpty()).toBe(true);
    expect(state.tronDepositArgsMap.isEmpty()).toBe(true);
    expect(state.outputRequestBuffer.isEmpty()).toBe(true);
    expect(state.outputAttestationBuffer.isEmpty()).toBe(true);
    expect(state.evictionMap.isEmpty()).toBe(true);
  });

  it.each([OutputKind.failed, OutputKind.unviable])(
    "verdict %s closes the request without minting",
    async (outputKind) => {
      const { contract, ctx } = await deployInitialised();
      const { context: sent, requestId } = await tronDeposit(contract, ctx, VALID_TRON_DEPOSIT);
      const attested = await attest(
        contract,
        sent,
        respond(MPC_RESPONSE_SECRET, requestId, outputKind, OUTPUT_EMPTY, TRON_ATTESTED_HEIGHT),
      );
      const next = (
        await contract.circuits.completeTronDeposit(
          attested,
          requestId,
          OUTPUT_FALSE,
          MINT_NONCE,
          CALLER_RECIPIENT,
        )
      ).context;
      expect(next.callContext.currentQueryContext.effects.shieldedMints.size).toBe(0);
      expect(ledgerOf(next).bidirectionalTronDepositMap.isEmpty()).toBe(true);
      expect(ledgerOf(next).outputRequestBuffer.isEmpty()).toBe(true);
    },
  );

  it.each([
    { name: "a tampered output", attested: OUTPUT_TRUE, presented: OUTPUT_FALSE },
    { name: "an output over an empty attestation", attested: OUTPUT_EMPTY, presented: OUTPUT_TRUE },
  ])("rejects $name", async ({ attested: attestedOutput, presented }) => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronDeposit(contract, ctx, VALID_TRON_DEPOSIT);
    const attested = await attest(
      contract,
      sent,
      respond(
        MPC_RESPONSE_SECRET,
        requestId,
        OutputKind.executed,
        attestedOutput,
        TRON_ATTESTED_HEIGHT,
      ),
    );
    await expect(
      contract.circuits.completeTronDeposit(
        attested,
        requestId,
        presented,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Output does not match the attestation/);
  });

  it("rejects a caller other than the depositor, even one naming themselves recipient", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronDeposit(contract, ctx, VALID_TRON_DEPOSIT);
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
    const stranger = contextOf(attested.callContext.currentQueryContext.state, OTHER_SECRET_KEY);
    await expect(
      contract.circuits.completeTronDeposit(
        stranger,
        requestId,
        OUTPUT_TRUE,
        MINT_NONCE,
        OTHER_WALLET_RECIPIENT,
      ),
    ).rejects.toThrow(/Not the requester/);
  });

  it("claims once: a second claim for the same request rejects", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronDeposit(contract, ctx, VALID_TRON_DEPOSIT);
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
    const next = (
      await contract.circuits.completeTronDeposit(
        attested,
        requestId,
        OUTPUT_TRUE,
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;
    await expect(
      contract.circuits.completeTronDeposit(
        next,
        requestId,
        OUTPUT_TRUE,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Request not sent/);
  });

  it("completeDeposit rejects a Tron deposit's id, and completeTronDeposit an Ethereum deposit's", async () => {
    const { contract, ctx } = await deployInitialised();
    const tron = await tronDeposit(contract, ctx, VALID_TRON_DEPOSIT);
    const evm = await evmDeposit(contract, tron.context);
    let attested = await attest(
      contract,
      evm.context,
      respond(
        MPC_RESPONSE_SECRET,
        tron.requestId,
        OutputKind.executed,
        OUTPUT_TRUE,
        TRON_ATTESTED_HEIGHT,
      ),
    );
    attested = await attest(
      contract,
      attested,
      respond(
        MPC_RESPONSE_SECRET,
        evm.requestId,
        OutputKind.executed,
        Uint8Array.of(1),
        EVM_ATTESTED_HEIGHT,
      ),
    );
    await expect(
      contract.circuits.completeDeposit(
        attested,
        tron.requestId,
        Uint8Array.of(1),
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Wrong action/);
    await expect(
      contract.circuits.completeTronDeposit(
        attested,
        evm.requestId,
        OUTPUT_TRUE,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Wrong action/);
  });

  it("startReplaceNonce refuses a Tron deposit: it holds no vault nonce", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronDeposit(contract, ctx, VALID_TRON_DEPOSIT);
    await expect(
      contract.circuits.startReplaceNonce(sent, 77n, requestId, Action.tronDeposit),
    ).rejects.toThrow(/Deposit has no vault nonce/);
  });
});

describe("completeTronDeposit expected transfer result", () => {
  it.each([
    { name: "USDT returning false mints", token: TRON_USDT, output: OUTPUT_FALSE, mints: true },
    {
      name: "USDT returning true mints nothing",
      token: TRON_USDT,
      output: OUTPUT_TRUE,
      mints: false,
    },
    { name: "another TRC-20 returning true mints", token: TRC20, output: OUTPUT_TRUE, mints: true },
    {
      name: "another TRC-20 returning false mints nothing",
      token: TRC20,
      output: OUTPUT_FALSE,
      mints: false,
    },
  ])("$name and closes the request", async ({ token, output, mints }) => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronDeposit(contract, ctx, {
      ...VALID_TRON_DEPOSIT,
      deposit: { tokenAddress: token, amount: AMOUNT },
    });
    const attested = await attest(
      contract,
      sent,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, output, TRON_ATTESTED_HEIGHT),
    );
    const next = (
      await contract.circuits.completeTronDeposit(
        attested,
        requestId,
        output,
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;

    const color = hexToBytes(
      rawTokenType(pureCircuits.vaultTronTokenDomainSeparator(token), VAULT_ADDRESS),
    );
    expect(coinsMinted(attested, next).map(({ coinInfo }) => coinInfo)).toEqual(
      mints ? [{ nonce: MINT_NONCE, color, value: AMOUNT }] : [],
    );
    expect(ledgerOf(next).bidirectionalTronDepositMap.isEmpty()).toBe(true);
    expect(ledgerOf(next).outputRequestBuffer.isEmpty()).toBe(true);
  });

  it("with the zero address as Tron USDT, every TRC-20 must return true", async () => {
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
        NO_FEES,
        NO_FEES,
        { bytes: bytes(32, 0xfe) },
        bytes(32, 0xef),
      )
    ).context;
    next = (await contract.circuits.addAllowedTronToken(next, TRON_USDT, NO_FEES, UNSHIFTED))
      .context;
    const { context: sent, requestId } = await tronDeposit(contract, next, {
      ...VALID_TRON_DEPOSIT,
      deposit: { tokenAddress: TRON_USDT, amount: AMOUNT },
    });
    const attested = await attest(
      contract,
      sent,
      respond(
        MPC_RESPONSE_SECRET,
        requestId,
        OutputKind.executed,
        OUTPUT_FALSE,
        TRON_ATTESTED_HEIGHT,
      ),
    );
    const settled = (
      await contract.circuits.completeTronDeposit(
        attested,
        requestId,
        OUTPUT_FALSE,
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;
    expect(settled.callContext.currentQueryContext.effects.shieldedMints.size).toBe(0);
  });
});

describe("chain-aware queue: each chain's attestations raise only its own height", () => {
  it("a Tron attestation is recorded as Tron and raises tronLastSeen, never globalLastSeen", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronDeposit(contract, ctx, VALID_TRON_DEPOSIT);
    const queued = (
      await contract.circuits.queueAttestation(
        sent,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_TRUE,
          TRON_ATTESTED_HEIGHT,
        ),
      )
    ).context;
    expect(ledgerOf(queued).inputAttestationBuffer.lookup(requestId).chain).toBe(Chain.tron);
    const flushed = await flush(contract, queued, [], [requestId]);
    expect(ledgerOf(flushed).tronLastSeen).toBe(TRON_ATTESTED_HEIGHT);
    expect(ledgerOf(flushed).globalLastSeen).toBe(EVM_START_HEIGHT);
  });

  it("an Ethereum attestation is recorded as Ethereum and raises globalLastSeen, never tronLastSeen", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await evmDeposit(contract, ctx);
    const height = TRON_START_HEIGHT * 10n;
    const queued = (
      await contract.circuits.queueAttestation(
        sent,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, Uint8Array.of(1), height),
      )
    ).context;
    expect(ledgerOf(queued).inputAttestationBuffer.lookup(requestId).chain).toBe(Chain.ethereum);
    const flushed = await flush(contract, queued, [], [requestId]);
    expect(ledgerOf(flushed).globalLastSeen).toBe(height);
    expect(ledgerOf(flushed).tronLastSeen).toBe(TRON_START_HEIGHT);
  });

  it("a later request reads the raised Tron height, and a higher attestation raises it again", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronDeposit(contract, ctx, VALID_TRON_DEPOSIT);
    const raised = await attest(
      contract,
      sent,
      respond(
        MPC_RESPONSE_SECRET,
        requestId,
        OutputKind.executed,
        OUTPUT_TRUE,
        TRON_ATTESTED_HEIGHT + 100n,
      ),
    );
    const settled = (
      await contract.circuits.completeTronDeposit(
        raised,
        requestId,
        OUTPUT_TRUE,
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;
    const second = await tronDeposit(contract, settled, { ...VALID_TRON_DEPOSIT, inIndex: 2n });
    expect(ledgerOf(second.context).outputRequestBuffer.lookup(second.outIndex).lastSeen).toBe(
      TRON_ATTESTED_HEIGHT + 100n,
    );
    const attested = await attest(
      contract,
      second.context,
      respond(
        MPC_RESPONSE_SECRET,
        second.requestId,
        OutputKind.executed,
        OUTPUT_TRUE,
        TRON_ATTESTED_HEIGHT + 101n,
      ),
    );
    expect(ledgerOf(attested).tronLastSeen).toBe(TRON_ATTESTED_HEIGHT + 101n);
  });

  it("a Tron attestation below tronLastSeen leaves it unchanged", async () => {
    const { contract, ctx } = await deployInitialised();
    const higher = await tronDeposit(contract, ctx, VALID_TRON_DEPOSIT);
    const lower = await tronDeposit(contract, higher.context, {
      ...VALID_TRON_DEPOSIT,
      inIndex: 2n,
      deposit: { tokenAddress: TRC20, amount: AMOUNT + 1n },
    });
    const lowerId = [...ledgerOf(lower.context).evictionMap].find(
      ([, index]) => bytesToHex(index) === bytesToHex(lower.outIndex),
    )?.[0];
    if (lowerId === undefined) throw new Error("no send recorded the second Tron request");
    const raisedHeight = TRON_ATTESTED_HEIGHT + 100n;

    const raised = await attest(
      contract,
      lower.context,
      respond(
        MPC_RESPONSE_SECRET,
        higher.requestId,
        OutputKind.executed,
        OUTPUT_TRUE,
        raisedHeight,
      ),
    );
    const lowerFolded = await attest(
      contract,
      raised,
      respond(MPC_RESPONSE_SECRET, lowerId, OutputKind.executed, OUTPUT_TRUE, TRON_ATTESTED_HEIGHT),
    );

    expect(ledgerOf(raised).tronLastSeen).toBe(raisedHeight);
    expect(ledgerOf(lowerFolded).outputAttestationBuffer.lookup(lowerId).blockHeight).toBe(
      TRON_ATTESTED_HEIGHT,
    );
    expect(ledgerOf(lowerFolded).tronLastSeen).toBe(raisedHeight);
  });

  it("a Tron request takes tronLastSeen as its lastSeen, an Ethereum request globalLastSeen", async () => {
    const { contract, ctx } = await deployInitialised();
    const tron = await tronDeposit(contract, ctx, VALID_TRON_DEPOSIT);
    const evm = await evmDeposit(contract, tron.context);
    const state = ledgerOf(evm.context);
    expect(state.outputRequestBuffer.lookup(tron.outIndex).lastSeen).toBe(TRON_START_HEIGHT);
    expect(state.outputRequestBuffer.lookup(evm.outIndex).lastSeen).toBe(EVM_START_HEIGHT);
    expect(state.outputRequestBuffer.lookup(evm.outIndex).entry.chain).toBe(Chain.ethereum);
  });

  it("a Tron request flushed behind an Ethereum attestation does not see its height", async () => {
    const { contract, ctx } = await deployInitialised();
    const evm = await evmDeposit(contract, ctx);
    const queuedAttestation = (
      await contract.circuits.queueAttestation(
        evm.context,
        respond(
          MPC_RESPONSE_SECRET,
          evm.requestId,
          OutputKind.executed,
          Uint8Array.of(1),
          EVM_ATTESTED_HEIGHT,
        ),
      )
    ).context;
    const queued = (await queueTronDeposit(contract, queuedAttestation, VALID_TRON_DEPOSIT))
      .context;
    const outIndex = queuedRequestIndex(ledgerOf(queued), VALID_TRON_DEPOSIT.inIndex);
    const flushed = await flush(contract, queued, [VALID_TRON_DEPOSIT.inIndex], [evm.requestId]);
    expect(ledgerOf(flushed).globalLastSeen).toBe(EVM_ATTESTED_HEIGHT);
    expect(ledgerOf(flushed).outputRequestBuffer.lookup(outIndex).lastSeen).toBe(TRON_START_HEIGHT);
  });

  it("queueAttestation bounds a Tron request by the Tron height, not the EVM one", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronDeposit(contract, ctx, VALID_TRON_DEPOSIT);
    await expect(
      contract.circuits.queueAttestation(
        sent,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_TRUE,
          TRON_START_HEIGHT,
        ),
      ),
    ).rejects.toThrow(/Stale attestation/);
  });

  it("an Ethereum deposit round trip is unaffected by an open Tron deposit", async () => {
    const { contract, ctx } = await deployInitialised();
    const tron = await tronDeposit(contract, ctx, VALID_TRON_DEPOSIT);
    const evm = await evmDeposit(contract, tron.context);
    const attested = await attest(
      contract,
      evm.context,
      respond(
        MPC_RESPONSE_SECRET,
        evm.requestId,
        OutputKind.executed,
        Uint8Array.of(1),
        EVM_ATTESTED_HEIGHT,
      ),
    );
    const next = (
      await contract.circuits.completeDeposit(
        attested,
        evm.requestId,
        Uint8Array.of(1),
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;
    expect(next.callContext.currentQueryContext.effects.shieldedMints.size).toBe(1);
    expect(ledgerOf(next).bidirectionalTronDepositMap.member(tron.requestId)).toBe(true);
    expect(ledgerOf(next).tronLastSeen).toBe(TRON_START_HEIGHT);
  });
});

// A shifted TRC-20's request amount is in coin units: the transfer moves amount·factor base
// units, and the settle mints amount coin units in the token's listed colour.
describe("Tron deposit of a shifted TRC-20", () => {
  it.each([
    {
      name: "an unshifted TRC-20 moves the amount and keeps its colour",
      token: TRC20,
      base: AMOUNT,
      colour: colourOf(pureCircuits.vaultTronTokenDomainSeparator(TRC20)),
    },
    {
      name: "a 10^6-shifted TRC-20 moves amount·10^6",
      token: MICRO_SHIFTED_TRC20,
      base: AMOUNT * SHIFT_6,
      colour: colourOf(pureCircuits.tronCoinColour(MICRO_SHIFTED_TRC20, SHIFT_6)),
    },
    {
      name: "a 10^12-shifted TRC-20 moves amount·10^12",
      token: SHIFTED_TRC20,
      base: AMOUNT * SHIFT_12,
      colour: colourOf(pureCircuits.tronCoinColour(SHIFTED_TRC20, SHIFT_12)),
    },
  ])("$name and mints the amount in coin units", async ({ token, base, colour }) => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronDeposit(contract, ctx, {
      ...VALID_TRON_DEPOSIT,
      deposit: { tokenAddress: token, amount: AMOUNT },
    });
    expect(ledgerOf(sent).bidirectionalTronDepositMap.lookup(requestId).txParams.calldata).toEqual({
      is_some: true,
      value: {
        selector: ERC20_TRANSFER_SELECTOR,
        noWords: 2n,
        words: [evmAddressAbiWord(VAULT_EVM), numericAbiWord(base)],
      },
    });
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
    const settled = (
      await contract.circuits.completeTronDeposit(
        attested,
        requestId,
        OUTPUT_TRUE,
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;
    expect(coinsMinted(attested, settled).map(({ coinInfo }) => coinInfo)).toEqual([
      { nonce: MINT_NONCE, color: colour, value: AMOUNT },
    ]);
  });

  it("mints a shifted TRC-20 in neither its unshifted colour nor another factor's", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronDeposit(contract, ctx, {
      ...VALID_TRON_DEPOSIT,
      deposit: { tokenAddress: SHIFTED_TRC20, amount: AMOUNT },
    });
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
    const settled = (
      await contract.circuits.completeTronDeposit(
        attested,
        requestId,
        OUTPUT_TRUE,
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;
    const minted = first(coinsMinted(attested, settled), "minted coin").coinInfo.color;
    expect(minted).not.toEqual(colourOf(pureCircuits.vaultTronTokenDomainSeparator(SHIFTED_TRC20)));
    expect(minted).not.toEqual(colourOf(pureCircuits.tronCoinColour(SHIFTED_TRC20, SHIFT_6)));
  });

  it("moves the largest refundable amount at the 10^12 shift", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, requestId } = await tronDeposit(contract, ctx, {
      ...VALID_TRON_DEPOSIT,
      deposit: { tokenAddress: SHIFTED_TRC20, amount: UINT64_MAX },
    });
    expect(
      ledgerOf(sent).bidirectionalTronDepositMap.lookup(requestId).txParams.calldata.value.words,
    ).toEqual([evmAddressAbiWord(VAULT_EVM), numericAbiWord(UINT64_MAX * SHIFT_12)]);
  });
});

// Simulator-level unit tests: the contract runs entirely in-process via
// @midnight-ntwrk/compact-runtime. No ledger, no network, no proving.

import { describe, expect, it } from "vitest";

import {
  createCircuitContext,
  createConstructorContext,
  rawTokenType,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";

import {
  MPC_ERROR_SENTINEL,
  MPCDestination,
  MPCSignatureAlgorithm,
  TxParamType,
  asciiPadded,
  bigintToBytes32,
  bytesToBigint,
  calculateRequestId,
  evmAddressAbiWord,
  hexToBytes,
  pureCircuits as signetCircuits,
  readSignetRequestsLedgerFromState,
  requestIdBytes,
  requestIdHex,
  secp256k1PublicKeyOf,
  signAttestationDigest,
  signetFieldNode,
  toSignBidirectionalEventIndex,
  type RespondBidirectionalEvent,
  type SignBidirectionalEventLedgerMap,
} from "@sig-net/midnight";

// The ERC20 transfer(address,uint256) selector: the TS mirror of the literal
// `Bytes [0xa9, 0x05, 0x9c, 0xbb]` hardcoded in erc20-vault.compact.
const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

import {
  Contract,
  createVaultPrivateState,
  ledger,
  pureCircuits,
  VAULT_NONCE_FIELD,
  VAULT_REQUESTS_INDEX_FIELD,
  witnesses,
  type VaultPrivateState,
} from "../src/index.ts";
// The signet contract (callee) module, the same one the vault's generated code
// cross-contract-calls (via the compile-time src/managed/SignetSigner link
// into this npm package's managed output). The request circuits end in a call
// to its signBidirectionalEvent, so the simulator needs its state
// (see signetStateProvider) to execute that path.
import * as SignetSigner from "@sig-net/midnight-contract/managed/contract/index.js";

// ---- Fixtures ----

// Dummy coin public key (32-byte hex). Required by the API, unused here.
const CPK = "0".repeat(64);

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

// Identity secrets for the simulated deployer/caller (same key: the deployer
// deposits in these tests) and for a stranger.
const SECRET_KEY = bytes(32, 7);
const OTHER_SECRET_KEY = bytes(32, 8);

// Commitments computed via the COMPILED circuit
const DEPLOYER_COMMITMENT = pureCircuits.userCommitment(SECRET_KEY);
const OTHER_COMMITMENT = pureCircuits.userCommitment(OTHER_SECRET_KEY);

// The "MPC" of these tests: its response key (secp256k1, derived per client
// contract from the contract address + the fixed path "midnight response
// key") is pinned by the one-shot initialize circuit right after deploy,
// exactly as a real deployment pins the off-chain-derived key (the key
// depends on the contract's own address, so it cannot be a constructor arg).
const MPC_RESPONSE_SECRET = bytes(32, 0x42);
const MPC_RESPONSE_KEY = secp256k1PublicKeyOf(MPC_RESPONSE_SECRET);

// The signet contract (callee) the vault seals + cross-contract-calls. A valid
// sample contract address so the runtime's address checks pass.
const SIGNET_ADDRESS = sampleContractAddress();
const SIGNET_CONTRACT_REF = {
  bytes: hexToBytes(SIGNET_ADDRESS),
};
const BLOCK_HASH = "0".repeat(64);

/**
 * A ContractStateProvider serving the signet contract's initial state to the
 * simulator's cross-contract call, which is how the request circuits reach
 * signBidirectionalEvent in-process (no node/indexer). Returns the state for
 * any address: the vault only calls the single sealed signet contract.
 */
const signetStateProvider = async () => {
  const signet = new SignetSigner.Contract({});
  const { currentContractState } = await signet.initialState(
    createConstructorContext(undefined, CPK),
  );
  return { getContractState: async () => currentContractState };
};

const VAULT_EVM = bytes(20, 0xee);
const ERC20 = bytes(20, 0xaa);
const ZERO_ADDRESS = new Uint8Array(20);
const AMOUNT = 1_000_000n;
const UINT64_MAX = 18446744073709551615n;

// The chain config initialize() pins (matching Sepolia's CAIP-2 form).
const CHAIN_ID = 11155111n;
const CAIP2_ID = asciiPadded("eip155:11155111", 32);

// The simulated vault's own contract address, fixed so tests can compute the
// token colors withdraw checks against kernel.self(). Doubles as the sender
// field of every event the vault records (kernel.self() again).
const VAULT_ADDRESS = sampleContractAddress();
const VAULT_ADDRESS_BYTES = hexToBytes(VAULT_ADDRESS);

// The contract-fixed MPC routing of every vault event (mirrors of the
// in-circuit constants; the round-trip tests below are the lockstep check for
// these values, including the escaped JSON schema literal at its EXACT
// contract-declared 34-byte width, never zero-padded).
const EXPECTED_SCHEMA = asciiPadded('[{"name":"success","type":"bool"}]', 34);
const EXPECTED_ROUTING = {
  algo: MPCSignatureAlgorithm.ecdsa,
  dest: MPCDestination.unused,
  params: new Uint8Array(64),
  outputDeserializationSchema: EXPECTED_SCHEMA,
  respondSerializationSchema: EXPECTED_SCHEMA,
};

/**
 * The deposit circuit's flat arguments, in circuit order. The compact
 * compiler inlines the `DepositRequest` struct type anonymously into the
 * generated circuit signature; the `deposit` member matches it structurally.
 * There is no path argument any more: the derivation path IS the caller's
 * identity commitment, recomputed in-circuit from the secret-key witness.
 */
interface DepositCallArgs {
  evmNonce: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  keyVersion: bigint;
  deposit: { erc20Address: Uint8Array; amount: bigint };
}

/**
 * Known-good deposit call args, the base every test varies from.
 * Shared across tests: NEVER mutate; build a variation as an explicit spread
 * of this base with the delta inline (see {@link DEPOSIT_REJECTION_CASES}).
 */
const VALID_DEPOSIT: DepositCallArgs = {
  evmNonce: 0n,
  gasLimit: 100000n,
  maxFeePerGas: 30000000000n,
  maxPriorityFeePerGas: 2000000000n,
  keyVersion: 1n,
  deposit: { erc20Address: ERC20, amount: AMOUNT },
};

// ---- Harness ----

const deployContract = async (
  deployerCommitment: Uint8Array = DEPLOYER_COMMITMENT,
) => {
  const contract = new Contract<VaultPrivateState>(witnesses);
  const { currentContractState, currentPrivateState } =
    await contract.initialState(
      createConstructorContext<VaultPrivateState>(
        createVaultPrivateState(SECRET_KEY),
        CPK,
      ),
      deployerCommitment,
      SIGNET_CONTRACT_REF,
    );
  const ctx = createCircuitContext(
    "deposit",
    VAULT_ADDRESS,
    CPK,
    currentContractState,
    currentPrivateState,
    await signetStateProvider(),
    undefined,
    undefined,
    undefined,
    BLOCK_HASH,
  );
  return { contract, ctx };
};

/**
 * Re-enter a threaded contract state as a DIFFERENT caller: same public
 * state, but the private state (the callerSecretKey witness) is a stranger's
 * ({@link OTHER_SECRET_KEY}).
 */
const strangerContext = async (
  circuitId: string,
  ctx: Parameters<Contract<VaultPrivateState>["circuits"]["deposit"]>[0],
) =>
  createCircuitContext(
    circuitId,
    VAULT_ADDRESS,
    CPK,
    ctx.callContext.currentQueryContext.state,
    createVaultPrivateState(OTHER_SECRET_KEY),
    await signetStateProvider(),
    undefined,
    undefined,
    undefined,
    BLOCK_HASH,
  );

/**
 * Deploy + initialize(VAULT_EVM, CHAIN_ID, CAIP2_ID, MPC_RESPONSE_KEY) as
 * the deployer: the ready-to-use vault, with the MPC response key stored.
 */
const deployInitialized = async () => {
  const { contract, ctx } = await deployContract();
  const next = (
    await contract.circuits.initialize(ctx, VAULT_EVM, CHAIN_ID, CAIP2_ID, MPC_RESPONSE_KEY)
  ).context;
  return { contract, ctx: next };
};

/** Call deposit with its flat args spread in circuit order. */
const deposit = (
  contract: Contract<VaultPrivateState>,
  ctx: Parameters<Contract<VaultPrivateState>["circuits"]["deposit"]>[0],
  args: DepositCallArgs,
) =>
  contract.circuits.deposit(
    ctx,
    args.evmNonce,
    args.gasLimit,
    args.maxFeePerGas,
    args.maxPriorityFeePerGas,
    args.keyVersion,
    args.deposit,
  );

// ---- Tests ----

describe("erc20-vault ledger shape", () => {
  it("signBidirectionalEventMap parses into the shared signet-midnight types", async () => {
    const { ctx } = await deployContract();

    // The assignment is the real assertion: the generated ledger type must
    // stay structurally identical to the shared library's named types.
    const ledgerMap: SignBidirectionalEventLedgerMap = ledger(
      ctx.callContext.currentQueryContext.state,
    ).signBidirectionalEventMap;

    expect(ledgerMap.isEmpty()).toBe(true);
    expect(toSignBidirectionalEventIndex(ledgerMap).size).toBe(0);
  });

  it("MPC-style: finds the event map in RAW state by position, no ledger()", async () => {
    const { ctx } = await deployContract();

    const rawState = ctx.callContext.currentQueryContext.state;
    const node = signetFieldNode(rawState, VAULT_REQUESTS_INDEX_FIELD);
    expect(node.type()).toBe("map");

    const { nonce, requestsIndex } = readSignetRequestsLedgerFromState(
      rawState,
      VAULT_REQUESTS_INDEX_FIELD,
      VAULT_NONCE_FIELD,
    );
    const typedIndex = toSignBidirectionalEventIndex(
      ledger(ctx.callContext.currentQueryContext.state).signBidirectionalEventMap,
    );
    expect(requestsIndex).toEqual(typedIndex);
    expect(requestsIndex.size).toBe(0);
    expect(nonce).toBe(0n);
  });
});

describe("userCommitment", () => {
  it("check 32-byte commitments computed off-chain via the compiled circuit", () => {
    expect(DEPLOYER_COMMITMENT).toHaveLength(32);
    expect(DEPLOYER_COMMITMENT).not.toEqual(new Uint8Array(32));
    expect(DEPLOYER_COMMITMENT).not.toEqual(OTHER_COMMITMENT);
  });
});

describe("withdrawRefundCommitment", () => {
  it("is domain-separated from userCommitment and unique per secret AND per request id", () => {
    const requestIdA = bytes(32, 0x01);
    const requestIdB = bytes(32, 0x02);
    const commitment = pureCircuits.withdrawRefundCommitment(SECRET_KEY, requestIdA);
    expect(commitment).toHaveLength(32);
    // Never the deposit-identity commitment: THAT one is public on the ledger
    // as the deposit's derivation path, so equality would link withdraw to
    // deposit.
    expect(commitment).not.toEqual(pureCircuits.userCommitment(SECRET_KEY));
    // Bound to the request id: two withdrawals by the same secret differ.
    expect(commitment).not.toEqual(pureCircuits.withdrawRefundCommitment(SECRET_KEY, requestIdB));
    // And bound to the secret: another identity's commitment differs.
    expect(commitment).not.toEqual(pureCircuits.withdrawRefundCommitment(OTHER_SECRET_KEY, requestIdA));
  });
});

describe("evmAddressAbiValue", () => {
  it("TS mirror matches the compiled circuit's big-endian address value", () => {
    // The compiled circuit returns the BE numeric value as a Field bigint;
    // the TS mirror (the library's evmAddressAbiWord) returns its 32-byte LE
    // embed. Same number.
    expect(bytesToBigint(evmAddressAbiWord(VAULT_EVM))).toBe(
      pureCircuits.evmAddressAbiValue(VAULT_EVM),
    );
  });
});

describe("initialize", () => {
  it("is deployer-gated", async () => {
    // Deployed with a stranger's commitment; our caller key can't initialize.
    const { contract, ctx } = await deployContract(OTHER_COMMITMENT);
    await expect(
      contract.circuits.initialize(ctx, VAULT_EVM, CHAIN_ID, CAIP2_ID, MPC_RESPONSE_KEY),
    ).rejects.toThrow(/Not the deployer/);
  });

  it("is one-shot", async () => {
    const { contract, ctx } = await deployInitialized();
    await expect(
      contract.circuits.initialize(ctx, VAULT_EVM, CHAIN_ID, CAIP2_ID, MPC_RESPONSE_KEY),
    ).rejects.toThrow(/Already initialized/);
  });

  it("rejects a zero chain id", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.initialize(ctx, VAULT_EVM, 0n, CAIP2_ID, MPC_RESPONSE_KEY),
    ).rejects.toThrow(/Chain ID must be positive/);
  });

  it("stores the vault EVM address, the chain config and the MPC response key", async () => {
    const { ctx } = await deployInitialized();
    const state = ledger(ctx.callContext.currentQueryContext.state);
    expect(state.initialized).toBe(1n);
    expect(state.vaultEvmAddress).toEqual(VAULT_EVM);
    expect(state.evmChainId).toBe(CHAIN_ID);
    expect(state.caip2Id).toEqual(CAIP2_ID);
    expect(state.mpcResponseKey).toEqual(MPC_RESPONSE_KEY);
  });
});

describe("deposit round-trip", () => {
  it("stores a fully contract-composed event readable identically via ledger(), the shared parser, and the RAW reader", async () => {
    const { contract, ctx } = await deployInitialized();

    const { result, context: next } = await deposit(contract, ctx, VALID_DEPOSIT);
    const state = next.callContext.currentQueryContext.state;

    // Read 1: generated ledger().
    const typedIndex = toSignBidirectionalEventIndex(
      ledger(state).signBidirectionalEventMap,
    );
    // Read 2: MPC-style raw read, no compiled contract involved.
    const rawLedger = readSignetRequestsLedgerFromState(
      state,
      VAULT_REQUESTS_INDEX_FIELD,
      VAULT_NONCE_FIELD,
    );

    expect(typedIndex.size).toBe(1);
    expect(rawLedger.requestsIndex).toEqual(typedIndex);
    // The raw counter read matches the generated one.
    expect(rawLedger.nonce).toBe(ledger(state).signetRequestNonce);

    const [idHex, record] = [...typedIndex.entries()][0];

    // The cross-contract call's return value: the notification landed under
    // (requestId, 0) in the signet singleton's registry.
    expect(result).toEqual({ count: 0n, requestId: requestIdBytes(idHex) });

    // The contract-composed envelope: the deposit's token on the
    // initialize-pinned chain, no ETH value, the caller's nonce + gas args.
    const { calldata, ...envelope } = record.txParams;
    expect(envelope).toEqual({
      to: ERC20,
      chainId: CHAIN_ID,
      nonce: VALID_DEPOSIT.evmNonce,
      gasLimit: VALID_DEPOSIT.gasLimit,
      maxFeePerGas: VALID_DEPOSIT.maxFeePerGas,
      maxPriorityFeePerGas: VALID_DEPOSIT.maxPriorityFeePerGas,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
    });

    // The event commits to its own sender (kernel.self()) and carries the
    // caller's identity commitment as its 32-byte derivation path. The
    // contract-fixed routing matches the TS expectations: the LOCKSTEP CHECK
    // for the in-circuit constants (including the escaped JSON schema
    // literal at its exact 34-byte width).
    expect(record.sender).toEqual({ bytes: VAULT_ADDRESS_BYTES });
    expect(record.path).toEqual(DEPLOYER_COMMITMENT);
    expect(record.caip2Id).toEqual(CAIP2_ID);
    expect(record.keyVersion).toBe(VALID_DEPOSIT.keyVersion);
    expect(record.algo).toBe(EXPECTED_ROUTING.algo);
    expect(record.dest).toBe(EXPECTED_ROUTING.dest);
    expect(record.params).toEqual(EXPECTED_ROUTING.params);
    expect(record.txParamType).toBe(TxParamType.evmType2);
    expect(record.outputDeserializationSchema).toEqual(
      EXPECTED_ROUTING.outputDeserializationSchema,
    );
    expect(record.respondSerializationSchema).toEqual(
      EXPECTED_ROUTING.respondSerializationSchema,
    );
    expect(record.requestNonce).toBe(0n);

    // Contract-built calldata: transfer(vaultEvmAddress, amount) as words,
    // i.e. the raw selector, the BE-embedded address, the LE amount.
    expect(calldata.is_some).toBe(true);
    expect(calldata.value.selector).toEqual(ERC20_TRANSFER_SELECTOR);
    expect(calldata.value.noWords).toBe(2n);
    expect(calldata.value.words).toHaveLength(2);
    expect(calldata.value.words[0]).toEqual(evmAddressAbiWord(VAULT_EVM));
    expect(bytesToBigint(calldata.value.words[1])).toBe(AMOUNT);

    // The map key IS the persistent hash of the record, recomputed off-chain
    // with the library's TS twin of the request-id circuit. This assertion is
    // the lockstep check the twin's deviation note relies on: the id computed
    // in TS must equal the key the REAL compiled contract minted in-circuit.
    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));

    // Nonce bumped for the next request.
    expect(ledger(state).signetRequestNonce).toBe(1n);
  });
});

/** One row of the deposit rejection table: full inputs to expected error. */
interface DepositRejectionCase {
  /** Test name, completing the sentence "rejects <name>". */
  name: string;
  /** Complete call args passed to the circuit. */
  args: DepositCallArgs;
  /** Error the circuit must throw. */
  throws: RegExp;
}

const DEPOSIT_REJECTION_CASES: DepositRejectionCase[] = [
  {
    name: "a zero ERC20 address",
    args: { ...VALID_DEPOSIT, deposit: { erc20Address: ZERO_ADDRESS, amount: AMOUNT } },
    throws: /ERC20 address cannot be zero/,
  },
  {
    name: "a zero amount",
    args: { ...VALID_DEPOSIT, deposit: { erc20Address: ERC20, amount: 0n } },
    throws: /Amount must be positive/,
  },
  {
    name: "an amount above Uint<64> max (unclaimable)",
    args: { ...VALID_DEPOSIT, deposit: { erc20Address: ERC20, amount: UINT64_MAX + 1n } },
    throws: /Amount exceeds Uint<64> max/,
  },
  {
    name: "a zero gas limit",
    args: { ...VALID_DEPOSIT, gasLimit: 0n },
    throws: /Gas limit must be positive/,
  },
  {
    name: "the legacy key version 0",
    args: { ...VALID_DEPOSIT, keyVersion: 0n },
    throws: /keyVersion must be >= 1/,
  },
];

describe("deposit validation", () => {
  it.each(DEPOSIT_REJECTION_CASES)(
    "rejects $name",
    async ({ args, throws }) => {
      const { contract, ctx } = await deployInitialized();
      await expect(deposit(contract, ctx, args)).rejects.toThrow(throws);
    },
  );

  it("rejects before initialize", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      deposit(contract, ctx, VALID_DEPOSIT),
    ).rejects.toThrow(/Not initialized/);
  });

  it("identical deposits get DISTINCT ids: requestNonce differentiates them", async () => {
    // The dedup assert (!member) is a belt-and-braces invariant: it cannot
    // trip in the normal flow, as the nonce is part of the hashed record and
    // an identical resubmission is therefore a NEW request. Document that here.
    const { contract, ctx } = await deployInitialized();

    const afterFirst = (await deposit(contract, ctx, VALID_DEPOSIT)).context;
    const afterSecond = (await deposit(contract, afterFirst, VALID_DEPOSIT)).context;

    const index = toSignBidirectionalEventIndex(
      ledger(afterSecond.callContext.currentQueryContext.state)
        .signBidirectionalEventMap,
    );
    expect(index.size).toBe(2);
    const nonces = [...index.values()].map((r) => r.requestNonce).sort();
    expect(nonces).toEqual([0n, 1n]);
  });

  it("two identities depositing identical requests get DISTINCT ids: the path differentiates them", async () => {
    // The derivation path (the caller's commitment) is part of the hashed
    // record too, so the same deposit by two different identities can never
    // collide even at the same nonce.
    const { contract, ctx } = await deployInitialized();
    const afterFirst = (await deposit(contract, ctx, VALID_DEPOSIT)).context;
    const stranger = await strangerContext("deposit", afterFirst);
    const afterSecond = (await deposit(contract, stranger, VALID_DEPOSIT)).context;

    const index = toSignBidirectionalEventIndex(
      ledger(afterSecond.callContext.currentQueryContext.state)
        .signBidirectionalEventMap,
    );
    expect(index.size).toBe(2);
    const paths = [...index.values()].map((r) => r.path);
    expect(paths).toContainEqual(DEPLOYER_COMMITMENT);
    expect(paths).toContainEqual(OTHER_COMMITMENT);
  });
});

// ---- Withdraw fixtures ----

// Where the vault sends the ERC20 on withdraw.
const DEST_EVM = bytes(20, 0xdd);

// The vault token color for ERC20 at the simulated contract address,
// computed exactly as a wallet would: the compiled domain-separator circuit
// plus the runtime's rawTokenType (the off-chain twin of the in-circuit
// `tokenType(domainSep, kernel.self())`).
const VAULT_TOKEN_COLOR = hexToBytes(
  rawTokenType(pureCircuits.vaultTokenDomainSeparator(ERC20), VAULT_ADDRESS),
);

/** A surrendered vault coin: fixed nonce, vault-token color, given value. */
const vaultCoin = (value: bigint, color: Uint8Array = VAULT_TOKEN_COLOR) => ({
  nonce: bytes(32, 0x0c),
  color,
  value,
});

/**
 * The withdraw circuit's flat arguments, in circuit order. The compact
 * compiler inlines the `WithdrawRequest` struct type anonymously into the
 * generated circuit signature; the `withdraw` member matches it structurally.
 */
interface WithdrawCallArgs {
  evmNonce: bigint;
  keyVersion: bigint;
  withdraw: { erc20Address: Uint8Array; amount: bigint; destEvmAddress: Uint8Array };
  coin: ReturnType<typeof vaultCoin>;
}

/**
 * Known-good withdraw call args, the base every test varies from.
 * Shared across tests: NEVER mutate; build a variation as an explicit spread.
 */
const VALID_WITHDRAW: WithdrawCallArgs = {
  evmNonce: 0n,
  keyVersion: 1n,
  withdraw: { erc20Address: ERC20, amount: AMOUNT, destEvmAddress: DEST_EVM },
  coin: vaultCoin(AMOUNT),
};

/** Call withdraw with its flat args spread in circuit order. */
const withdraw = (
  contract: Contract<VaultPrivateState>,
  ctx: Parameters<Contract<VaultPrivateState>["circuits"]["withdraw"]>[0],
  args: WithdrawCallArgs,
) =>
  contract.circuits.withdraw(
    ctx,
    args.evmNonce,
    args.keyVersion,
    args.withdraw,
    args.coin,
  );

// ---- Withdraw tests ----

describe("withdraw round-trip", () => {
  it("burns the coin and stores a vault-path event with a contract-fixed envelope", async () => {
    const { contract, ctx } = await deployInitialized();

    const { result, context: next } = await withdraw(contract, ctx, VALID_WITHDRAW);
    const state = next.callContext.currentQueryContext.state;

    const index = toSignBidirectionalEventIndex(
      ledger(state).signBidirectionalEventMap,
    );
    expect(index.size).toBe(1);
    const [idHex, record] = [...index.entries()][0];

    // The cross-contract call's return value: the notification landed under
    // (requestId, 0) in the signet singleton's registry.
    expect(result).toEqual({ count: 0n, requestId: requestIdBytes(idHex) });

    // The derivation path is the contract-fixed 32-byte literal "vault": the
    // MPC signs with the VAULT's derived EVM account, not the caller's. The
    // sender is the vault contract itself (kernel.self()).
    expect(record.sender).toEqual({ bytes: VAULT_ADDRESS_BYTES });
    expect(record.path).toEqual(asciiPadded("vault", 32));

    // The envelope is contract-composed end to end: the withdraw's token on
    // the initialize-pinned chain, the caller's account nonce, and the
    // CONTRACT-FIXED gas envelope. The gas literals here are the lockstep
    // check for any off-chain code that rebuilds this record (the example's
    // withdraw flow ERC20_TRANSFER_* constants).
    const { calldata, ...envelope } = record.txParams;
    expect(envelope).toEqual({
      to: ERC20,
      chainId: CHAIN_ID,
      nonce: VALID_WITHDRAW.evmNonce,
      gasLimit: 100_000n,
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
    });

    // Contract-fixed routing, same constants as deposits.
    expect(record.caip2Id).toEqual(CAIP2_ID);
    expect(record.keyVersion).toBe(VALID_WITHDRAW.keyVersion);
    expect(record.algo).toBe(EXPECTED_ROUTING.algo);
    expect(record.dest).toBe(EXPECTED_ROUTING.dest);
    expect(record.params).toEqual(EXPECTED_ROUTING.params);
    expect(record.txParamType).toBe(TxParamType.evmType2);
    expect(record.outputDeserializationSchema).toEqual(
      EXPECTED_ROUTING.outputDeserializationSchema,
    );
    expect(record.respondSerializationSchema).toEqual(
      EXPECTED_ROUTING.respondSerializationSchema,
    );
    expect(record.requestNonce).toBe(0n);

    // Contract-built calldata: transfer(destEvmAddress, amount) as words,
    // i.e. the raw selector, the BE-embedded address, the LE amount.
    expect(calldata.is_some).toBe(true);
    expect(calldata.value.selector).toEqual(ERC20_TRANSFER_SELECTOR);
    expect(calldata.value.noWords).toBe(2n);
    expect(calldata.value.words[0]).toEqual(evmAddressAbiWord(DEST_EVM));
    expect(bytesToBigint(calldata.value.words[1])).toBe(AMOUNT);

    // TS-twin lockstep: the ledger map key is the id the library recomputes.
    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));

    // The withdrawer's refund commitment is pinned under the request id;
    // the compiled circuit recomputes it off-chain here (domain-separated
    // from userCommitment, bound to THIS request id); nonce bumped. The
    // surrendered coin leaves no other trace: it is burned, by design.
    expect(ledger(state).refundCommitment.member(requestIdBytes(idHex))).toBe(true);
    expect(ledger(state).refundCommitment.lookup(requestIdBytes(idHex))).toEqual(
      pureCircuits.withdrawRefundCommitment(SECRET_KEY, requestIdBytes(idHex)),
    );
    expect(ledger(state).signetRequestNonce).toBe(1n);
  });

  it("concurrent withdrawals across DIFFERENT ERC20 colors both land", async () => {
    // No shared escrow slot: each withdrawal only touches its own request-id
    // keyed entries, so coins of different colors surrendered back-to-back
    // must both record.
    const { contract, ctx } = await deployInitialized();
    const otherErc20 = bytes(20, 0xab);
    const otherColor = hexToBytes(
      rawTokenType(pureCircuits.vaultTokenDomainSeparator(otherErc20), VAULT_ADDRESS),
    );

    const afterFirst = (await withdraw(contract, ctx, VALID_WITHDRAW)).context;
    const afterSecond = (
      await withdraw(contract, afterFirst, {
        ...VALID_WITHDRAW,
        withdraw: { erc20Address: otherErc20, amount: AMOUNT, destEvmAddress: DEST_EVM },
        coin: vaultCoin(AMOUNT, otherColor),
      })
    ).context;

    const state = afterSecond.callContext.currentQueryContext.state;
    const index = toSignBidirectionalEventIndex(ledger(state).signBidirectionalEventMap);
    expect(index.size).toBe(2);
    expect(ledger(state).refundCommitment.size()).toBe(2n);
  });
});

/** One row of the withdraw rejection table: full inputs to expected error. */
interface WithdrawRejectionCase {
  /** Test name, completing the sentence "rejects <name>". */
  name: string;
  /** Complete call args passed to the circuit. */
  args: WithdrawCallArgs;
  /** Error the circuit must throw. */
  throws: RegExp;
}

const WITHDRAW_REJECTION_CASES: WithdrawRejectionCase[] = [
  {
    name: "a zero ERC20 address",
    args: {
      ...VALID_WITHDRAW,
      withdraw: { erc20Address: ZERO_ADDRESS, amount: AMOUNT, destEvmAddress: DEST_EVM },
    },
    throws: /ERC20 address cannot be zero/,
  },
  {
    name: "a zero amount",
    args: {
      ...VALID_WITHDRAW,
      withdraw: { erc20Address: ERC20, amount: 0n, destEvmAddress: DEST_EVM },
      coin: vaultCoin(0n),
    },
    throws: /Amount must be positive/,
  },
  {
    name: "an amount above Uint<64> max (unrefundable)",
    args: {
      ...VALID_WITHDRAW,
      withdraw: { erc20Address: ERC20, amount: UINT64_MAX + 1n, destEvmAddress: DEST_EVM },
      coin: vaultCoin(UINT64_MAX + 1n),
    },
    throws: /Amount exceeds Uint<64> max/,
  },
  {
    name: "the legacy key version 0",
    args: { ...VALID_WITHDRAW, keyVersion: 0n },
    throws: /keyVersion must be >= 1/,
  },
  {
    name: "a coin that is not the vault token for this ERC20",
    args: { ...VALID_WITHDRAW, coin: vaultCoin(AMOUNT, bytes(32, 0x99)) },
    throws: /Coin is not the vault token for this ERC20/,
  },
  {
    name: "a coin whose value differs from the withdraw amount",
    args: { ...VALID_WITHDRAW, coin: vaultCoin(AMOUNT - 1n) },
    throws: /Coin value must equal the withdraw amount/,
  },
];

describe("withdraw validation", () => {
  it.each(WITHDRAW_REJECTION_CASES)(
    "rejects $name",
    async ({ args, throws }) => {
      const { contract, ctx } = await deployInitialized();
      await expect(withdraw(contract, ctx, args)).rejects.toThrow(throws);
    },
  );

  it("rejects before initialize", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      withdraw(contract, ctx, VALID_WITHDRAW),
    ).rejects.toThrow(/Not initialized/);
  });
});

// ---- Response fixtures (shared by the completeWithdraw + claim settle suites) ----

// An MPC response secret OTHER than the one initialize pinned the key of.
const IMPOSTER_SECRET = bytes(32, 0x43);

// The caller-chosen mint nonce claim/completeWithdraw take. In production the
// client draws it fresh from a CSPRNG per call (that randomness is the
// unlinkability guarantee); the circuit only threads it through, so a fixed
// value is fine for these deterministic simulator tests.
const MINT_NONCE = bytes(32, 0x2e);

// A successful remote execution: first byte 1 (the LE encoding the circuit
// decodes as `as Field == 1`), rest zero; 32 meaningful bytes (one ABI word).
const OUTPUT_SUCCESS = new Uint8Array(128);
OUTPUT_SUCCESS[0] = 1;

// A failed remote execution: the MPC's 0xdeadbeef error sentinel.
const OUTPUT_FAILURE = new Uint8Array(128);
OUTPUT_FAILURE.set(MPC_ERROR_SENTINEL);

const OUTPUT_LEN = 32n;

/**
 * Sign a REAL RespondBidirectionalEvent for (requestId, serializedOutput)
 * with `secretKey`: the digest comes from the compiled circuit, exactly like
 * the MPC. Signature scalars land as LE bytes, the ledger form.
 */
const respond = (
  secretKey: Uint8Array,
  requestId: Uint8Array,
  serializedOutput: Uint8Array,
): RespondBidirectionalEvent => {
  const digest = signetCircuits.signetAttestationDigest(
    requestId,
    serializedOutput,
    OUTPUT_LEN,
  );
  const sig = signAttestationDigest(digest, secretKey);
  return {
    serializedOutput,
    outputLen: OUTPUT_LEN,
    r: bigintToBytes32(sig.r),
    s: bigintToBytes32(sig.s),
    recoveryId: BigInt(sig.recoveryId),
  };
};

// ---- Complete-withdraw fixtures ----

/**
 * Deploy + initialize + withdraw(VALID_WITHDRAW): the arrange step of
 * every complete-withdraw test. Returns the pending withdrawal's request id
 * (the single ledger map key) alongside the threaded context.
 */
const withdrawRequested = async () => {
  const { contract, ctx } = await deployInitialized();
  const next = (await withdraw(contract, ctx, VALID_WITHDRAW)).context;
  const index = toSignBidirectionalEventIndex(
    ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap,
  );
  const [idHex] = [...index.keys()];
  return { contract, ctx: next, requestId: requestIdBytes(idHex) };
};

// ---- Complete-withdraw tests ----

describe("completeWithdraw settle", () => {
  it("success response finalizes: request and refund marker both consumed", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();

    const next = (
      await contract.circuits.completeWithdraw(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS),
        MINT_NONCE,
      )
    ).context;

    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.signBidirectionalEventMap.isEmpty()).toBe(true);
    expect(state.refundCommitment.isEmpty()).toBe(true);
  });

  it("success settle is permissionless: a STRANGER finalizes (cleanup mints nothing)", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();

    const next = (
      await contract.circuits.completeWithdraw(
        await strangerContext("completeWithdraw", ctx),
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS),
        MINT_NONCE,
      )
    ).context;

    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.signBidirectionalEventMap.isEmpty()).toBe(true);
    expect(state.refundCommitment.isEmpty()).toBe(true);
  });

  it("failure response: the WITHDRAWER re-mints the surrendered value and consumes the withdrawal", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();

    // The refund branch runs mintShieldedToken in-circuit: the call
    // resolving proves the mint executed, and the ledger cleanup is the same
    // as the success branch (the mint itself is shielded, not ledger state).
    // The caller's private state holds SECRET_KEY, the secret behind the
    // pinned refund commitment, so the "Not the withdrawer" gate passes.
    const next = (
      await contract.circuits.completeWithdraw(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_FAILURE),
        MINT_NONCE,
      )
    ).context;

    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.signBidirectionalEventMap.isEmpty()).toBe(true);
    expect(state.refundCommitment.isEmpty()).toBe(true);
  });

  it("failure response: a caller other than the withdrawer cannot take the refund", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();

    // The refund mints to the CALLER's own key, so the circuit demands proof
    // of the secret behind the commitment pinned at withdraw time; a
    // stranger's callerSecretKey witness recomputes a different commitment.
    await expect(
      contract.circuits.completeWithdraw(
        await strangerContext("completeWithdraw", ctx),
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_FAILURE),
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Not the withdrawer/);
  });

  it("rejects a response signed by a key other than the stored MPC response key", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    await expect(
      contract.circuits.completeWithdraw(
        ctx,
        requestId,
        respond(IMPOSTER_SECRET, requestId, OUTPUT_SUCCESS),
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a tampered response (output differs from what was signed)", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    const response = respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS);
    const tamperedOutput = new Uint8Array(OUTPUT_FAILURE);
    await expect(
      contract.circuits.completeWithdraw(
        ctx,
        requestId,
        { ...response, serializedOutput: tamperedOutput },
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a genuine response presented under a different request id", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    // Signed for some OTHER id: the digest binds the request id, so the
    // signature cannot be replayed onto this pending withdrawal.
    const otherId = bytes(32, 0xab);
    await expect(
      contract.circuits.completeWithdraw(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, otherId, OUTPUT_SUCCESS),
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a genuinely signed id that has no pending withdrawal", async () => {
    const { contract, ctx } = await withdrawRequested();
    const unknownId = bytes(32, 0xab);
    await expect(
      contract.circuits.completeWithdraw(
        ctx,
        unknownId,
        respond(MPC_RESPONSE_SECRET, unknownId, OUTPUT_SUCCESS),
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Withdrawal not found/);
  });

  it("settles once: a second completeWithdraw for the same request rejects", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    const next = (
      await contract.circuits.completeWithdraw(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS),
        MINT_NONCE,
      )
    ).context;
    await expect(
      contract.circuits.completeWithdraw(
        next,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS),
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Withdrawal not found/);
  });

  it("rejects settling a DEPOSIT request (no refund marker) even with a genuine response", async () => {
    const { contract, ctx } = await deployInitialized();
    const next = (await deposit(contract, ctx, VALID_DEPOSIT)).context;
    const index = toSignBidirectionalEventIndex(
      ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap,
    );
    const [depositIdHex] = [...index.keys()];
    const depositId = requestIdBytes(depositIdHex);

    await expect(
      contract.circuits.completeWithdraw(
        next,
        depositId,
        respond(MPC_RESPONSE_SECRET, depositId, OUTPUT_SUCCESS),
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Withdrawal not found/);
  });
});

// ---- Claim-deposit fixtures ----

// The circuit's `Maybe<Either<ZswapCoinPublicKey, ContractAddress>>` recipient
// argument. Compact's Maybe/Either are plain structs: even a `none` (and the
// unused Either side of a `some`) carries a fully default-valued payload so
// the argument stays well-aligned.
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
  value: {
    is_left: true,
    left: { bytes: bytes(32, 0x21) },
    right: { bytes: new Uint8Array(32) },
  },
};
const CONTRACT_RECIPIENT = {
  is_some: true,
  value: {
    is_left: false,
    left: { bytes: new Uint8Array(32) },
    right: { bytes: hexToBytes(sampleContractAddress()) },
  },
};

/**
 * Deploy + initialize + deposit(VALID_DEPOSIT): the arrange step of
 * every claim test. Returns the pending deposit's request id (the single
 * ledger map key) alongside the threaded context.
 */
const depositRequested = async () => {
  const { contract, ctx } = await deployInitialized();
  const next = (await deposit(contract, ctx, VALID_DEPOSIT)).context;
  const index = toSignBidirectionalEventIndex(
    ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap,
  );
  const [idHex] = [...index.keys()];
  return { contract, ctx: next, requestId: requestIdBytes(idHex) };
};

// ---- Claim-deposit tests ----

describe("claim settle", () => {
  // The mint itself is shielded: the call resolving proves it executed, and
  // the publicly-observable effect asserted here is the request's consumption.
  it.each([
    { name: "no recipient: mints to the caller", recipient: CALLER_RECIPIENT },
    { name: "an explicit wallet recipient: mints to the given coin public key", recipient: OTHER_WALLET_RECIPIENT },
    { name: "an explicit contract recipient: mints to the given contract address", recipient: CONTRACT_RECIPIENT },
  ])("$name and consumes the request", async ({ recipient }) => {
    const { contract, ctx, requestId } = await depositRequested();

    const next = (
      await contract.circuits.claim(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS),
        MINT_NONCE,
        recipient,
      )
    ).context;

    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.signBidirectionalEventMap.isEmpty()).toBe(true);
  });

  it("rejects a response signed by a key other than the stored MPC response key", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    await expect(
      contract.circuits.claim(
        ctx,
        requestId,
        respond(IMPOSTER_SECRET, requestId, OUTPUT_SUCCESS),
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a genuinely signed FAILED sweep (MPC error sentinel)", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    await expect(
      contract.circuits.claim(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_FAILURE),
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/ERC20 transfer returned false/);
  });

  it("rejects a tampered response (output differs from what was signed)", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const response = respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS);
    // Keep the tampered output a "success" so the tamper is caught by the
    // signature check, not the earlier return-value check.
    const tamperedOutput = new Uint8Array(OUTPUT_SUCCESS);
    tamperedOutput[64] = 0xff;
    await expect(
      contract.circuits.claim(
        ctx,
        requestId,
        { ...response, serializedOutput: tamperedOutput },
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a genuinely signed id that has no pending request", async () => {
    const { contract, ctx } = await depositRequested();
    const unknownId = bytes(32, 0xab);
    await expect(
      contract.circuits.claim(
        ctx,
        unknownId,
        respond(MPC_RESPONSE_SECRET, unknownId, OUTPUT_SUCCESS),
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Request not found/);
  });

  it("claims once: a second claim for the same request rejects", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const next = (
      await contract.circuits.claim(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS),
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;
    await expect(
      contract.circuits.claim(
        next,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS),
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Request not found/);
  });

  it("rejects a caller other than the original depositor, even one naming themselves recipient", async () => {
    // The stored event's path is the DEPOSITOR's identity commitment; the
    // stranger's witness recomputes a different one.
    const { contract, ctx, requestId } = await depositRequested();
    await expect(
      contract.circuits.claim(
        await strangerContext("claim", ctx),
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS),
        MINT_NONCE,
        OTHER_WALLET_RECIPIENT,
      ),
    ).rejects.toThrow(/Not the depositor/);
  });
});

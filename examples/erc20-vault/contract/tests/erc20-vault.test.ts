// Simulator-level unit tests: the contract runs entirely in-process via
// @midnight-ntwrk/compact-runtime. No ledger, no network, no proving.

import {
  type CircuitContext,
  type CircuitResults,
  createCircuitContext,
  createConstructorContext,
  rawTokenType,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
// This tree's wasm ContractState class: see signetStateProvider for why the
// portal-linked signet module's state must round-trip through it.
import { ContractState, CostModel, QueryContext } from "@midnightntwrk/onchain-runtime-v4";
import {
  asciiPadded,
  assembleCalldata,
  bytesToHex,
  calculateRequestId,
  decodeSignBidirectionalEventNotificationPayload,
  decodeSignBidirectionalNotification,
  decodeSignetLogEvents,
  evmAddressAbiWord,
  hexToBytes,
  MPC_FAILURE_OUTPUT,
  MPCDestination,
  MPCSignatureAlgorithm,
  numericAbiWord,
  pureCircuits as signetCircuits,
  readSignetRequestsLedgerFromState,
  type RequestId,
  requestIdBytes,
  requestIdHex,
  type RespondBidirectionalEvent,
  respondBidirectionalEventToCircuitInput,
  serializeRespondOutput,
  type SignBidirectionalEventLedgerMap,
  SignetEventName,
  signetFieldNodeByPath,
  toSignBidirectionalEventIndex,
  TxParamType,
} from "@sig-net/midnight";
import {
  calculateSignetAttestationDigest,
  ecdsaSignatureToMpcSignature,
  secp256k1PublicKeyOf,
  signAttestationDigest,
} from "@sig-net/midnight/testing";
import { describe, expect, it } from "vitest";

// The ERC20 transfer(address,uint256) selector: the TS mirror of the literal
// `Bytes [0xa9, 0x05, 0x9c, 0xbb]` hardcoded in erc20-vault.compact.
const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

// The signet contract (callee) module, the same one the vault's generated code
// cross-contract-calls (via the compile-time src/managed/SignetSigner link
// into this npm package's managed output). The request circuits end in a call
// to its signBidirectional, so the simulator needs its state
// (see signetStateProvider) to execute that path.
import * as SignetSigner from "@sig-net/midnight-contract/managed/contract/index.js";

import {
  Contract,
  createVaultPrivateState,
  ledger,
  pureCircuits,
  VAULT_DEPOSIT_REQUESTS_PATH,
  VAULT_ISSUED_SLOTS_PATH,
  VAULT_REQUESTS_PATH,
  type VaultPrivateState,
  witnesses,
} from "../src/index.ts";

// ---- Fixtures ----

// Dummy coin public key (32-byte hex). Required by the API, unused here.
const CPK = "0".repeat(64);

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

// A `toHaveLength` assertion does not narrow the index read that follows it,
// so take the first element by iterating and fail naming what was missing.
const first = <T>(items: Iterable<T>, what: string): T => {
  for (const item of items) {
    return item;
  }
  throw new Error(`expected at least one ${what}`);
};

// The stdlib's shieldedBurnAddress() recipient: the all-zero coin public key.
// The burn-output assertions below are the lockstep check for this mirror.
const BURN_ADDRESS_BYTES = new Uint8Array(32);

/** The zswap local state a circuit run produced, failing when there is none. */
const zswapState = (context: CircuitContext<VaultPrivateState>) => {
  const state = context.callContext.currentZswapLocalState;
  if (!state) {
    throw new Error("expected zswap local state on the circuit context");
  }
  return state;
};

// Identity secrets for the simulated deployer/caller (same key: the deployer
// deposits in these tests) and for a stranger.
const SECRET_KEY = bytes(32, 7);
const OTHER_SECRET_KEY = bytes(32, 8);

// Commitments computed via the COMPILED circuit
const DEPLOYER_COMMITMENT = pureCircuits.userCommitment(SECRET_KEY);
const OTHER_COMMITMENT = pureCircuits.userCommitment(OTHER_SECRET_KEY);

// The "MPC" of these tests: its response key (secp256k1, derived per client
// contract from the contract address + the fixed path "midnight response
// key") is pinned by the one-shot initialise circuit right after deploy,
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
 *
 * The state is re-materialised through bytes: while `@sig-net/*` resolve to
 * the sibling checkout (portal wiring), the signet module runs on its OWN
 * copy of the wasm runtime, and the simulator's `instanceof ContractState`
 * checks demand THIS tree's class identity. Serialisation is
 * identity-neutral, so a byte round trip converts between the two. Harmless
 * (a no-op copy) under published single-tree installs.
 */
const signetStateProvider = async () => {
  const signet = new SignetSigner.Contract({});
  const { currentContractState } = await signet.initialState(
    createConstructorContext(undefined, CPK),
  );
  const state = ContractState.deserialize(currentContractState.serialize());
  return { getContractState: () => Promise.resolve(state) };
};

const VAULT_EVM = bytes(20, 0xee);
// The pinned Uniswap SwapRouter02 (initialise arg + swap `to`).
const ROUTER = bytes(20, 0x11);
const ERC20 = bytes(20, 0xaa);
// The pinned Aave USDC pair (initialise args): the underlying and its stataUSDC wrapper.
const STATA_UNDERLYING = bytes(20, 0xdd); // supply burns this colour, redeem mints it
const STATA_TOKEN = bytes(20, 0xcc); // supply/redeem `to`; supply mints this colour
const ZERO_ADDRESS = new Uint8Array(20);
const AMOUNT = 1_000_000n;
const UINT64_MAX = 18446744073709551615n;

// The chain config initialise() pins (matching Sepolia's CAIP-2 form).
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
 * The `startDeposit` circuit's flat arguments, in circuit order. The compact
 * compiler inlines the `DepositRequest` struct type anonymously into the
 * generated circuit signature, and this interface's `deposit` member matches
 * that anonymous type structurally.
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

const deployContract = async (deployerCommitment: Uint8Array = DEPLOYER_COMMITMENT) => {
  const contract = new Contract<VaultPrivateState>(witnesses);
  const { currentContractState, currentPrivateState } = await contract.initialState(
    createConstructorContext<VaultPrivateState>(createVaultPrivateState(SECRET_KEY), CPK),
    deployerCommitment,
    SIGNET_CONTRACT_REF,
  );
  const ctx = createCircuitContext(
    "startDeposit",
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
  ctx: Parameters<Contract<VaultPrivateState>["circuits"]["startDeposit"]>[0],
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
 * The EVM account nonce allocator slot 0 owns, pinned by initialise(). Kept
 * deliberately non-zero so every assigned-nonce assertion below would fail if
 * the contract used the bare slot index instead of evmNonceBase + index.
 */
const EVM_NONCE_BASE = 7n;

/**
 * Deploy + initialise(...) as the deployer: the ready-to-use vault, with the
 * MPC response key and the EVM nonce base stored.
 */
const deployInitialised = async () => {
  const { contract, ctx } = await deployContract();
  const next = (
    await contract.circuits.initialise(
      ctx,
      VAULT_EVM,
      ROUTER,
      STATA_UNDERLYING,
      STATA_TOKEN,
      CHAIN_ID,
      CAIP2_ID,
      MPC_RESPONSE_KEY,
      EVM_NONCE_BASE,
    )
  ).context;
  return { contract, ctx: next };
};

// ---- Two-phase harness ----
//
// Every vault-signed flow is now request* (park the parameters, allocate a
// slot) then assign* (prove the slot, build and record the signature request).
// These helpers drive both halves so the round-trip and settle suites read the
// same as they did against the one-shot start* circuits, and expose each half
// separately for the tests that assert on one of them.

/** The caller's secret, read back out of a threaded context's private state. */
const secretOf = (ctx: CircuitContext<VaultPrivateState>): Uint8Array => {
  const secretKey = ctx.callContext.currentPrivateState?.secretKey;
  if (!secretKey) {
    throw new Error("expected a caller secret key on the circuit context");
  }
  return secretKey;
};

/**
 * The allocator leaf (and settle-view commitment) a caller's request keys on:
 * the surrendered coin's nonce for the value flows, a caller-chosen salt for
 * the approves. Computed through the COMPILED circuit, never a TS re-mirror.
 */
const requestKeyOf = (ctx: CircuitContext<VaultPrivateState>, nonce: Uint8Array): Uint8Array =>
  pureCircuits.requestCommitment(secretOf(ctx), nonce);

/**
 * The Merkle path proving `key`'s slot, read off the allocator exactly as an
 * off-chain client would. `findPathForLeaf` is O(n) — fine for a unit test,
 * and a real client remembers the index from its own phase-1 receipt.
 */
const slotPathOf = (state: Parameters<typeof ledger>[0], key: Uint8Array) => {
  const path = ledger(state).slots.findPathForLeaf(key);
  if (!path) {
    throw new Error("the allocator holds no slot for this request key");
  }
  return path;
};

/** The slot index a path encodes: its goes_left bits, LSB first. */
const slotIndexOfPath = (path: { path: readonly { goes_left: boolean }[] }): bigint =>
  path.path.reduce((acc, entry, i) => acc + (entry.goes_left ? 0n : 1n << BigInt(i)), 0n);

/** Both halves of a two-phase flow, plus the key and slot they used. */
interface TwoPhaseRun {
  /** The phase-2 context, threaded on from phase 1 (what callers keep going with). */
  context: CircuitContext<VaultPrivateState>;
  /** The phase-1 run: the burn and the slot allocation are observable here. */
  request: CircuitResults<VaultPrivateState, []>;
  /** The phase-2 run: the recorded event and the MPC notification are here. */
  assign: CircuitResults<VaultPrivateState, []>;
  /** The request key phase 1 parked under and phase 2 consumed. */
  key: Uint8Array;
  /** The allocator index the path proved, i.e. evmNonce - evmNonceBase. */
  slotIndex: bigint;
}

const twoPhase = async (
  key: Uint8Array,
  request: () => Promise<CircuitResults<VaultPrivateState, []>>,
  assign: (
    ctx: CircuitContext<VaultPrivateState>,
    path: unknown,
  ) => Promise<CircuitResults<VaultPrivateState, []>>,
): Promise<TwoPhaseRun> => {
  const requestRun = await request();
  const path = slotPathOf(requestRun.context.callContext.currentQueryContext.state, key);
  const assignRun = await assign(requestRun.context, path);
  return {
    context: assignRun.context,
    request: requestRun,
    assign: assignRun,
    key,
    slotIndex: slotIndexOfPath(path),
  };
};

/** Call deposit with its flat args spread in circuit order. */
const deposit = (
  contract: Contract<VaultPrivateState>,
  ctx: Parameters<Contract<VaultPrivateState>["circuits"]["startDeposit"]>[0],
  args: DepositCallArgs,
) =>
  contract.circuits.startDeposit(
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

  it("MPC-style: finds the event map in RAW state by ledger-tree path, no ledger()", async () => {
    const { ctx } = await deployContract();

    const rawState = ctx.callContext.currentQueryContext.state;
    const node = signetFieldNodeByPath(rawState, VAULT_REQUESTS_PATH);
    expect(node.type()).toBe("map");

    const { nonce, requestsIndex } = readSignetRequestsLedgerFromState(
      rawState,
      VAULT_REQUESTS_PATH,
      VAULT_ISSUED_SLOTS_PATH,
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

describe("requestCommitment", () => {
  it("is domain-separated from userCommitment and unique per secret AND per nonce", () => {
    const nonceA = bytes(32, 0x01);
    const nonceB = bytes(32, 0x02);
    const commitment = pureCircuits.requestCommitment(SECRET_KEY, nonceA);
    expect(commitment).toHaveLength(32);
    // Never the deposit-identity commitment: THAT one is public on the ledger
    // as the deposit's derivation path, so equality would link withdraw to
    // deposit.
    expect(commitment).not.toEqual(pureCircuits.userCommitment(SECRET_KEY));
    // Bound to the nonce: two withdrawals by the same secret differ, which is
    // what keeps allocator leaves unique.
    expect(commitment).not.toEqual(pureCircuits.requestCommitment(SECRET_KEY, nonceB));
    // And bound to the secret: another identity's commitment differs.
    expect(commitment).not.toEqual(pureCircuits.requestCommitment(OTHER_SECRET_KEY, nonceA));
  });
});

describe("ABI words (shared library circuits)", () => {
  it("TS mirrors match the compiled circuits byte for byte", () => {
    // Words are ABI-ready (big-endian, broadcast form); the library's TS
    // mirrors and its compiled circuits must emit identical bytes. The vault
    // stores exactly these words (see the deposit/withdraw record tests).
    expect(evmAddressAbiWord(VAULT_EVM)).toEqual(signetCircuits.evmAddressAbiWord(VAULT_EVM));
    expect(numericAbiWord(AMOUNT)).toEqual(signetCircuits.numericAbiWord(AMOUNT));
    expect(signetCircuits.abiWordToUint128(numericAbiWord(AMOUNT))).toBe(AMOUNT);
  });
});

describe("initialise", () => {
  it("is deployer-gated", async () => {
    // Deployed with a stranger's commitment; our caller key can't initialise.
    const { contract, ctx } = await deployContract(OTHER_COMMITMENT);
    await expect(
      contract.circuits.initialise(
        ctx,
        VAULT_EVM,
        ROUTER,
        STATA_UNDERLYING,
        STATA_TOKEN,
        CHAIN_ID,
        CAIP2_ID,
        MPC_RESPONSE_KEY,
        EVM_NONCE_BASE,
      ),
    ).rejects.toThrow(/Not the deployer/);
  });

  it("is one-shot", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(
      contract.circuits.initialise(
        ctx,
        VAULT_EVM,
        ROUTER,
        STATA_UNDERLYING,
        STATA_TOKEN,
        CHAIN_ID,
        CAIP2_ID,
        MPC_RESPONSE_KEY,
        EVM_NONCE_BASE,
      ),
    ).rejects.toThrow(/Already initialised/);
  });

  it("rejects a zero chain id", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.initialise(
        ctx,
        VAULT_EVM,
        ROUTER,
        STATA_UNDERLYING,
        STATA_TOKEN,
        0n,
        CAIP2_ID,
        MPC_RESPONSE_KEY,
        EVM_NONCE_BASE,
      ),
    ).rejects.toThrow(/Chain ID must be positive/);
  });

  it("stores the vault EVM address, the chain config and the MPC response key", async () => {
    const { ctx } = await deployInitialised();
    const state = ledger(ctx.callContext.currentQueryContext.state);
    expect(state.initialised).toBe(1n);
    expect(state.vaultEvmAddress).toEqual(VAULT_EVM);
    expect(state.uniswapRouter).toEqual(ROUTER);
    expect(state.evmChainId).toBe(CHAIN_ID);
    expect(state.caip2Id).toEqual(CAIP2_ID);
    expect(state.mpcResponseKey).toEqual(MPC_RESPONSE_KEY);
    // Write-once, so phase 2 can read it without pinning anything that moves.
    expect(state.evmNonceBase).toBe(EVM_NONCE_BASE);
    // The allocator starts empty: no slot is owed to anyone yet.
    expect(state.pendingParams.isEmpty()).toBe(true);
  });
});

describe("deposit round-trip", () => {
  it("stores a fully contract-composed event readable identically via ledger(), the shared parser, and the RAW reader", async () => {
    const { contract, ctx } = await deployInitialised();

    const { context: next } = await deposit(contract, ctx, VALID_DEPOSIT);
    const state = next.callContext.currentQueryContext.state;

    // Read 1: generated ledger().
    const typedIndex = toSignBidirectionalEventIndex(ledger(state).depositEventMap);
    // Read 2: MPC-style raw read, no compiled contract involved.
    const rawLedger = readSignetRequestsLedgerFromState(
      state,
      VAULT_DEPOSIT_REQUESTS_PATH,
      VAULT_ISSUED_SLOTS_PATH,
    );

    expect(typedIndex.size).toBe(1);
    expect(rawLedger.requestsIndex).toEqual(typedIndex);
    // The raw counter read at the nonce path matches the generated one.
    expect(rawLedger.nonce).toBe(ledger(state).issuedSlots);

    const [idHex, record] = first(typedIndex.entries(), "indexed signBidirectional request");

    // The cross-contract call's observable effect: the signet contract
    // emitted the notification event, its payload declaring the stored
    // event's id and naming THIS vault and the depositEventMap (decoded
    // through the shared library's decoders, the same read the MPC's
    // discovery feed performs).
    const notificationEvents = decodeSignetLogEvents(next.events, SIGNET_ADDRESS);
    expect(notificationEvents).toHaveLength(1);
    const notificationEvent = first(notificationEvents, "signet notification event");
    expect(notificationEvent.name).toBe(SignetEventName.SignBidirectionalEvent);
    const notificationPost = decodeSignBidirectionalEventNotificationPayload(
      notificationEvent.payload,
    );
    // The declared id IS the stored map key: the MPC looks it up directly.
    expect(requestIdHex(notificationPost.requestId)).toBe(idHex);
    expect(decodeSignBidirectionalNotification(notificationPost.event)).toEqual({
      version: 1,
      callerAddress: bytesToHex(VAULT_ADDRESS_BYTES),
      requestsPath: [1, 3],
    });

    // The contract-composed envelope: the deposit's token on the
    // initialise-pinned chain, no ETH value, the caller's nonce + gas args.
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
    expect(record.respondSerializationSchema).toEqual(EXPECTED_ROUTING.respondSerializationSchema);
    expect(record.requestNonce).toBe(0n);

    // Contract-built calldata: transfer(vaultEvmAddress, amount) as ABI-ready
    // big-endian words, stored exactly as broadcast.
    expect(calldata.is_some).toBe(true);
    expect(calldata.value.selector).toEqual(ERC20_TRANSFER_SELECTOR);
    expect(calldata.value.noWords).toBe(2n);
    expect(calldata.value.words).toHaveLength(2);
    expect(calldata.value.words[0]).toEqual(evmAddressAbiWord(VAULT_EVM));
    expect(calldata.value.words[1]).toEqual(numericAbiWord(AMOUNT));

    // The map key IS the record's transientHash digest, recomputed off-chain
    // with the library's TS twin of the request-id circuit. This assertion is
    // the lockstep check the twin's deviation note relies on: the id computed
    // in TS must equal the key the REAL compiled contract minted in-circuit.
    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));

    // The depositor's settle view is pinned under the request id: the identity
    // commitment completeDeposit gates on plus the typed token + amount it
    // mints, so settling never decodes an ABI word.
    expect(ledger(state).depositSettleViews.member(requestIdBytes(idHex))).toBe(true);
    expect(ledger(state).depositSettleViews.lookup(requestIdBytes(idHex))).toEqual({
      commitment: DEPLOYER_COMMITMENT,
      erc20: ERC20,
      amount: AMOUNT,
    });

    // This caller's OWN deposit nonce slot bumped for their next request, while
    // the vault-path counter issuedSlots is left untouched: a deposit allocates
    // no slot, and it reads no shared cell at all, which is what lets two
    // different callers' deposits apply concurrently.
    expect(ledger(state).depositRequestNonces.lookup(DEPLOYER_COMMITMENT).read()).toBe(1n);
    expect(ledger(state).issuedSlots).toBe(0n);
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
  it.each(DEPOSIT_REJECTION_CASES)("rejects $name", async ({ args, throws }) => {
    const { contract, ctx } = await deployInitialised();
    await expect(deposit(contract, ctx, args)).rejects.toThrow(throws);
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(deposit(contract, ctx, VALID_DEPOSIT)).rejects.toThrow(/Not initialised/);
  });

  it("identical deposits get DISTINCT ids: requestNonce differentiates them", async () => {
    // The dedup assert (!member) is a belt-and-braces invariant: it cannot
    // trip in the normal flow, as the nonce is part of the hashed record and
    // an identical resubmission is therefore a NEW request. Document that here.
    const { contract, ctx } = await deployInitialised();

    const afterFirst = (await deposit(contract, ctx, VALID_DEPOSIT)).context;
    const afterSecond = (await deposit(contract, afterFirst, VALID_DEPOSIT)).context;

    const index = toSignBidirectionalEventIndex(
      ledger(afterSecond.callContext.currentQueryContext.state).depositEventMap,
    );
    expect(index.size).toBe(2);
    const nonces = [...index.values()].map((r) => r.requestNonce).sort();
    expect(nonces).toEqual([0n, 1n]);
  });

  it("the SAME caller depositing twice advances THEIR slot and issues no allocator slot", async () => {
    // The ledger-side facts the off-chain twin (`depositRequestNonce` in
    // src/vault-ledger.ts) reads to predict a request id. A twin reading the
    // vault-path counter issuedSlots instead agrees only on the first deposit,
    // when both cells read 0; this pins the divergence so that accident can
    // never silently return.
    const { contract, ctx } = await deployInitialised();

    const stateBefore = ledger(ctx.callContext.currentQueryContext.state);
    expect(stateBefore.depositRequestNonces.member(DEPLOYER_COMMITMENT)).toBe(false);
    expect(stateBefore.issuedSlots).toBe(0n);

    const afterFirst = (await deposit(contract, ctx, VALID_DEPOSIT)).context;
    const stateAfterFirst = ledger(afterFirst.callContext.currentQueryContext.state);
    expect(stateAfterFirst.depositRequestNonces.lookup(DEPLOYER_COMMITMENT).read()).toBe(1n);

    const afterSecond = (await deposit(contract, afterFirst, VALID_DEPOSIT)).context;
    const stateAfterSecond = ledger(afterSecond.callContext.currentQueryContext.state);

    // The caller's own counter is what advanced...
    expect(stateAfterSecond.depositRequestNonces.lookup(DEPLOYER_COMMITMENT).read()).toBe(2n);
    // ...and the vault-path issued-slot count never moved: a deposit is signed
    // by the caller's own EVM account, so it allocates nothing.
    expect(stateAfterSecond.issuedSlots).toBe(0n);

    // So the SECOND deposit hashed nonce 1, which the twin can only predict
    // from the per-caller slot.
    const index = toSignBidirectionalEventIndex(stateAfterSecond.depositEventMap);
    expect([...index.values()].map((record) => record.requestNonce).sort()).toEqual([0n, 1n]);
  });

  it("two identities depositing identical requests get DISTINCT ids: the path differentiates them", async () => {
    // The derivation path (the caller's commitment) is part of the hashed
    // record too, so the same deposit by two different identities can never
    // collide even at the same nonce.
    const { contract, ctx } = await deployInitialised();
    const afterFirst = (await deposit(contract, ctx, VALID_DEPOSIT)).context;
    const stranger = await strangerContext("startDeposit", afterFirst);
    const afterSecond = (await deposit(contract, stranger, VALID_DEPOSIT)).context;

    const index = toSignBidirectionalEventIndex(
      ledger(afterSecond.callContext.currentQueryContext.state).depositEventMap,
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

// The default surrendered-coin nonce. It is ALSO the request key's second
// preimage, so any test that surrenders two coins against one deploy must give
// them different nonces or phase 1 rejects the second as already pending.
const COIN_NONCE = bytes(32, 0x0c);

// The approves surrender no coin, so their request key is salted instead. Any
// value the caller has not already parked a request under will do.
const APPROVE_SALT = bytes(32, 0x5a);

/** A surrendered vault coin: given nonce, vault-token color, given value. */
const vaultCoin = (
  value: bigint,
  color: Uint8Array = VAULT_TOKEN_COLOR,
  nonce: Uint8Array = COIN_NONCE,
) => ({
  nonce,
  color,
  value,
});

/**
 * The `startWithdraw` circuit's flat arguments, in circuit order. The compact
 * compiler inlines the `WithdrawRequest` struct type anonymously into the
 * generated circuit signature, and this interface's `withdraw` member matches
 * that anonymous type structurally.
 */
interface WithdrawCallArgs {
  keyVersion: bigint;
  withdraw: { erc20Address: Uint8Array; amount: bigint; destEvmAddress: Uint8Array };
  coin: ReturnType<typeof vaultCoin>;
}

/**
 * Known-good withdraw call args, the base every test varies from.
 * Shared across tests: NEVER mutate; build a variation as an explicit spread.
 */
const VALID_WITHDRAW: WithdrawCallArgs = {
  keyVersion: 1n,
  withdraw: { erc20Address: ERC20, amount: AMOUNT, destEvmAddress: DEST_EVM },
  coin: vaultCoin(AMOUNT),
};

/** Drive both halves of a withdrawal: requestWithdraw then assignWithdraw. */
const withdraw = (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  args: WithdrawCallArgs,
): Promise<TwoPhaseRun> => {
  const key = requestKeyOf(ctx, args.coin.nonce);
  return twoPhase(
    key,
    () => contract.circuits.requestWithdraw(ctx, args.keyVersion, args.withdraw, args.coin),
    (next, path) =>
      contract.circuits.assignWithdraw(
        next,
        key,
        path as Parameters<Contract<VaultPrivateState>["circuits"]["assignWithdraw"]>[2],
      ),
  );
};

/** Phase 1 only, for the tests that assert on the parked request itself. */
const requestWithdrawOnly = (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  args: WithdrawCallArgs,
) => contract.circuits.requestWithdraw(ctx, args.keyVersion, args.withdraw, args.coin);

// ---- Withdraw tests ----

describe("withdraw round-trip", () => {
  it("burns the coin and stores a vault-path event with a contract-fixed envelope", async () => {
    const { contract, ctx } = await deployInitialised();

    const run = await withdraw(contract, ctx, VALID_WITHDRAW);
    const next = run.context;
    const state = next.callContext.currentQueryContext.state;

    // First request of this vault, so it owns allocator slot 0.
    expect(run.slotIndex).toBe(0n);

    const index = toSignBidirectionalEventIndex(ledger(state).signBidirectionalEventMap);
    expect(index.size).toBe(1);
    const [idHex, record] = first(index.entries(), "indexed signBidirectional request");

    // The cross-contract call's observable effect: the signet contract
    // emitted the notification event declaring the stored event's id and
    // naming this vault's signBidirectionalEventMap.
    const notificationEvent = first(
      decodeSignetLogEvents(next.events, SIGNET_ADDRESS),
      "signet notification event",
    );
    expect(notificationEvent.name).toBe(SignetEventName.SignBidirectionalEvent);
    const notificationPost = decodeSignBidirectionalEventNotificationPayload(
      notificationEvent.payload,
    );
    // The declared id IS the stored map key: the MPC looks it up directly.
    expect(requestIdHex(notificationPost.requestId)).toBe(idHex);
    expect(decodeSignBidirectionalNotification(notificationPost.event)).toEqual({
      version: 1,
      callerAddress: bytesToHex(VAULT_ADDRESS_BYTES),
      requestsPath: [0, 0],
    });

    // The derivation path is the contract-fixed 32-byte literal "vault": the
    // MPC signs with the VAULT's derived EVM account, not the caller's. The
    // sender is the vault contract itself (kernel.self()).
    expect(record.sender).toEqual({ bytes: VAULT_ADDRESS_BYTES });
    expect(record.path).toEqual(asciiPadded("vault", 32));

    // The envelope is contract-composed end to end: the withdraw's token on
    // the initialise-pinned chain, the caller's account nonce, and the gas
    // envelope the CONTRACT reads from its own ledger. The gas literals here
    // are the lockstep check for any off-chain code that rebuilds this record
    // (the example's withdraw flow, via `vaultGasEnvelope`).
    const { calldata, ...envelope } = record.txParams;
    expect(envelope).toEqual({
      to: ERC20,
      chainId: CHAIN_ID,
      // PROVEN, not read: evmNonceBase + the slot index the Merkle path bound.
      nonce: EVM_NONCE_BASE + run.slotIndex,
      gasLimit: 100_000n,
      // The initialise-time defaults, now ledger values a deployer can move
      // with setGasParams (see the "gas parameters" describes at the end of
      // this file). 150 gwei, the ceiling initialise sets.
      maxFeePerGas: 150_000_000_000n,
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
    expect(record.respondSerializationSchema).toEqual(EXPECTED_ROUTING.respondSerializationSchema);
    // A constant, not this request's slot index: every vault-signed flow hashes
    // 0 here, because txParams.nonce below already makes the id unique. The
    // UNIQUENESS test in the throughput block is what holds that claim up.
    expect(record.requestNonce).toBe(0n);

    // Contract-built calldata: transfer(destEvmAddress, amount) as ABI-ready
    // big-endian words, stored exactly as broadcast.
    expect(calldata.is_some).toBe(true);
    expect(calldata.value.selector).toEqual(ERC20_TRANSFER_SELECTOR);
    expect(calldata.value.noWords).toBe(2n);
    expect(calldata.value.words[0]).toEqual(evmAddressAbiWord(DEST_EVM));
    expect(calldata.value.words[1]).toEqual(numericAbiWord(AMOUNT));

    // TS-twin lockstep: the ledger map key is the id the library recomputes.
    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));

    // The withdrawer's settle view is pinned under the request id: the refund
    // commitment (recomputed off-chain here via the compiled circuit,
    // domain-separated from userCommitment and bound to THIS request id) plus
    // the typed token + amount settle circuits read back; nonce bumped.
    expect(ledger(state).withdrawSettleViews.member(requestIdBytes(idHex))).toBe(true);
    expect(ledger(state).withdrawSettleViews.lookup(requestIdBytes(idHex))).toEqual({
      // The commitment IS the phase-1 request key: phase 2 is permissionless
      // and cannot commit over the requester's secret and the request id.
      commitment: pureCircuits.requestCommitment(SECRET_KEY, VALID_WITHDRAW.coin.nonce),
      erc20: ERC20,
      amount: AMOUNT,
    });
    // The shared counter is no longer a request nonce, it is the count of slots
    // the allocator has issued: one, this request's. Nothing on this path READ
    // it, which is why the increment costs no contention.
    expect(ledger(state).issuedSlots).toBe(1n);
    // The slot was consumed: the parked parameters are replaced by a tombstone,
    // never removed, so the key can never be parked (and re-leafed) again.
    expect(ledger(state).pendingParams.size()).toBe(1n);
    // The allocator leaf STAYS: removing it would rebind an issued index.
    expect(ledger(state).slots.checkRoot(ledger(state).slots.root())).toBe(true);

    // The burn, observable in the zswap local state: the coin is received (a
    // contract-owned output) and spent as the call's input, and the burn
    // output pays its full value to the shielded burn address. The receive
    // output's coin info must equal the spent coin's exactly: that identity is
    // what lets the transaction builder pair the two into a same-transaction
    // transient instead of a contract coin-tree spend.
    // The burn happens in PHASE 1, so read that run's zswap local state.
    const zswap = zswapState(run.request.context);

    // check inputs, expect 1 input:
    // - coin for the amount being withdrawn
    expect(zswap.inputs).toHaveLength(1);
    const consumed = first(zswap.inputs, "consumed coin");
    expect(consumed.color).toEqual(VAULT_TOKEN_COLOR);
    expect(consumed.value).toBe(AMOUNT);

    // check outputs, expect 2 ouputs:
    // - received coin to the contract address
    // - burned coin to the burn address
    expect(zswap.outputs).toHaveLength(2);

    // received coin to the contract address
    const received = first(
      zswap.outputs.filter((output) => !output.recipient.is_left),
      "contract-owned receive output",
    );
    expect(received.recipient.right.bytes).toEqual(VAULT_ADDRESS_BYTES);
    expect(received.coinInfo).toEqual({
      nonce: consumed.nonce,
      color: consumed.color,
      value: consumed.value,
    });

    // burned coin to the burn address
    const burnOutput = first(
      zswap.outputs.filter((output) => output.recipient.is_left),
      "burn output",
    );
    expect(burnOutput.coinInfo.color).toEqual(VAULT_TOKEN_COLOR);
    expect(burnOutput.coinInfo.value).toBe(AMOUNT);
    expect(burnOutput.recipient.left.bytes).toEqual(BURN_ADDRESS_BYTES);
  });

  it("concurrent withdrawals across DIFFERENT ERC20 colors both land", async () => {
    // No shared escrow slot: each withdrawal only touches its own request-id
    // keyed entries, so coins of different colors surrendered back-to-back
    // must both record.
    const { contract, ctx } = await deployInitialised();
    const otherErc20 = bytes(20, 0xab);
    const otherColor = hexToBytes(
      rawTokenType(pureCircuits.vaultTokenDomainSeparator(otherErc20), VAULT_ADDRESS),
    );

    const afterFirst = (await withdraw(contract, ctx, VALID_WITHDRAW)).context;
    const afterSecond = (
      await withdraw(contract, afterFirst, {
        ...VALID_WITHDRAW,
        withdraw: { erc20Address: otherErc20, amount: AMOUNT, destEvmAddress: DEST_EVM },
        // A DIFFERENT coin nonce, so it keys a different request and a
        // different allocator slot. Reusing one would be a double spend.
        coin: vaultCoin(AMOUNT, otherColor, bytes(32, 0x0d)),
      })
    ).context;

    const state = afterSecond.callContext.currentQueryContext.state;
    const index = toSignBidirectionalEventIndex(ledger(state).signBidirectionalEventMap);
    expect(index.size).toBe(2);
    expect(ledger(state).withdrawSettleViews.size()).toBe(2n);
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
  it.each(WITHDRAW_REJECTION_CASES)("rejects $name", async ({ args, throws }) => {
    const { contract, ctx } = await deployInitialised();
    await expect(withdraw(contract, ctx, args)).rejects.toThrow(throws);
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(withdraw(contract, ctx, VALID_WITHDRAW)).rejects.toThrow(/Not initialised/);
  });

  it("rejects the legacy key version in PHASE 1, before the coin is burned", async () => {
    // Phase 1 burns the coin, and slot i's EVM nonce is only ever consumed by
    // slot i, so anything phase 2 would reject has to be caught here or the
    // caller loses the coin AND the account stalls behind the stranded nonce.
    const { contract, ctx } = await deployInitialised();
    await expect(
      requestWithdrawOnly(contract, ctx, { ...VALID_WITHDRAW, keyVersion: 0n }),
    ).rejects.toThrow(/keyVersion must be >= 1/);
  });
});

// ---- Response fixtures (shared by every settle and refund suite) ----

// An MPC response secret OTHER than the one initialise pinned the key of.
const IMPOSTER_SECRET = bytes(32, 0x43);

// The caller-chosen mint nonce every settle and refund circuit takes. In production the
// client draws it fresh from a CSPRNG per call (that randomness is the
// unlinkability guarantee); the circuit only threads it through, so a fixed
// value is fine for these deterministic simulator tests.
const MINT_NONCE = bytes(32, 0x2e);
// completeSwap mints two coins, each under its own caller-supplied random nonce.
const CHANGE_NONCE = bytes(32, 0x3f);

// The vault's respond schema, read from the COMPILED circuit (the contract's
// own declaration), so the fixtures below run through the same ABI-to-compact
// pipeline the real client uses: schema -> descriptor -> midnight-serde
// compactSerialize. Nothing here hand-packs bytes.
const VAULT_RESPONSE_SCHEMA = pureCircuits.vaultResponseSchema();

// A successful remote execution: the packed bool result at its exact
// unpadded width, one 0x01 byte (the circuits take it as Bytes<1>).
const OUTPUT_SUCCESS = serializeRespondOutput(VAULT_RESPONSE_SCHEMA, { success: true });

// An EXECUTED transfer that returned false: one 0x00 byte. Settles through
// completeWithdraw's refund branch.
const OUTPUT_FALSE = serializeRespondOutput(VAULT_RESPONSE_SCHEMA, { success: false });

// A NEVER-EXECUTED transfer/swap (reverted or replaced): the protocol's fixed
// 5-byte failure output. Settles through the per-kind refund circuits, whose
// output argument is Bytes<5>.
const OUTPUT_REVERTED = MPC_FAILURE_OUTPUT;

/**
 * Sign a REAL RespondBidirectionalEvent for (requestId, serializedOutput)
 * with `secretKey`: the digest comes from the library's sanctioned TS twin
 * (pinned byte-for-byte against the compiled oracles in signet-midnight's
 * own tests), exactly like the MPC. The wire event carries ONLY the
 * stored-form signature (big-endian SEC1, bigR as a full point), and it is
 * returned flipped to verifyRespondBidirectionalEvent's circuit-input form,
 * which is what a client hands to the settle circuits: the digest is
 * recomputed by whoever verifies, and the output travels as a separate
 * circuit argument.
 */
const respond = (
  secretKey: Uint8Array,
  requestId: Uint8Array,
  serializedOutput: Uint8Array,
): RespondBidirectionalEvent =>
  respondBidirectionalEventToCircuitInput({
    signature: ecdsaSignatureToMpcSignature(
      signAttestationDigest(
        calculateSignetAttestationDigest(requestId, serializedOutput),
        secretKey,
      ),
    ),
  });

// ---- Complete-withdraw fixtures ----

/**
 * Deploy + initialise + withdraw(VALID_WITHDRAW): the arrange step of
 * every complete-withdraw test. Returns the pending withdrawal's request id
 * (the single ledger map key) alongside the threaded context.
 */
const withdrawRequested = async () => {
  const { contract, ctx } = await deployInitialised();
  const next = (await withdraw(contract, ctx, VALID_WITHDRAW)).context;
  const index = toSignBidirectionalEventIndex(
    ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap,
  );
  const idHex = first(index.keys(), "signBidirectional request id");
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
        OUTPUT_SUCCESS,
        MINT_NONCE,
        COIN_NONCE,
      )
    ).context;

    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.signBidirectionalEventMap.isEmpty()).toBe(true);
    expect(state.withdrawSettleViews.isEmpty()).toBe(true);
  });

  it("success settle is permissionless: a STRANGER finalizes (cleanup mints nothing)", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();

    const next = (
      await contract.circuits.completeWithdraw(
        await strangerContext("completeWithdraw", ctx),
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS),
        OUTPUT_SUCCESS,
        MINT_NONCE,
        COIN_NONCE,
      )
    ).context;

    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.signBidirectionalEventMap.isEmpty()).toBe(true);
    expect(state.withdrawSettleViews.isEmpty()).toBe(true);
  });

  it("false-return response: the WITHDRAWER re-mints the surrendered value and consumes the withdrawal", async () => {
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
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_FALSE),
        OUTPUT_FALSE,
        MINT_NONCE,
        COIN_NONCE,
      )
    ).context;

    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.signBidirectionalEventMap.isEmpty()).toBe(true);
    expect(state.withdrawSettleViews.isEmpty()).toBe(true);
  });

  it("false-return response: a caller other than the withdrawer cannot take the refund", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();

    // The refund mints to the CALLER's own key, so the circuit demands proof
    // of the secret behind the commitment pinned at withdraw time; a
    // stranger's callerSecretKey witness recomputes a different commitment.
    await expect(
      contract.circuits.completeWithdraw(
        await strangerContext("completeWithdraw", ctx),
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_FALSE),
        OUTPUT_FALSE,
        MINT_NONCE,
        COIN_NONCE,
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
        OUTPUT_SUCCESS,
        MINT_NONCE,
        COIN_NONCE,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects presented output bytes that differ from what was signed", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    // Signed over the FALSE result, presented as a success byte: the digest
    // recomputed in-circuit is not the one the signature covers. This is the
    // attack the signature-only event must stop: settling a failed transfer
    // as a success.
    await expect(
      contract.circuits.completeWithdraw(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_FALSE),
        OUTPUT_SUCCESS,
        MINT_NONCE,
        COIN_NONCE,
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
        OUTPUT_SUCCESS,
        MINT_NONCE,
        COIN_NONCE,
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
        OUTPUT_SUCCESS,
        MINT_NONCE,
        COIN_NONCE,
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
        OUTPUT_SUCCESS,
        MINT_NONCE,
        COIN_NONCE,
      )
    ).context;
    await expect(
      contract.circuits.completeWithdraw(
        next,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS),
        OUTPUT_SUCCESS,
        MINT_NONCE,
        COIN_NONCE,
      ),
    ).rejects.toThrow(/Withdrawal not found/);
  });

  it("rejects settling a DEPOSIT request (no refund marker) even with a genuine response", async () => {
    const { contract, ctx } = await deployInitialised();
    const next = (await deposit(contract, ctx, VALID_DEPOSIT)).context;
    const index = toSignBidirectionalEventIndex(
      ledger(next.callContext.currentQueryContext.state).depositEventMap,
    );
    const depositIdHex = first(index.keys(), "signBidirectional request id");
    const depositId = requestIdBytes(depositIdHex);

    await expect(
      contract.circuits.completeWithdraw(
        next,
        depositId,
        respond(MPC_RESPONSE_SECRET, depositId, OUTPUT_SUCCESS),
        OUTPUT_SUCCESS,
        MINT_NONCE,
        COIN_NONCE,
      ),
    ).rejects.toThrow(/Withdrawal not found/);
  });
});

// ---- Refund-withdraw tests ----

describe("refundWithdraw settle", () => {
  it("failure output: the WITHDRAWER re-mints the surrendered value and consumes the withdrawal", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();

    // Same shielded-mint reasoning as completeWithdraw's refund branch: the
    // call resolving proves the mint executed, the observable effect is the
    // consumption of the request and its pending-withdrawal marker.
    const next = (
      await contract.circuits.refundWithdraw(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_REVERTED),
        OUTPUT_REVERTED,
        MINT_NONCE,
        COIN_NONCE,
      )
    ).context;

    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.signBidirectionalEventMap.isEmpty()).toBe(true);
    expect(state.withdrawSettleViews.isEmpty()).toBe(true);
  });

  it("a caller other than the withdrawer cannot take the refund", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    await expect(
      contract.circuits.refundWithdraw(
        await strangerContext("refundWithdraw", ctx),
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_REVERTED),
        OUTPUT_REVERTED,
        MINT_NONCE,
        COIN_NONCE,
      ),
    ).rejects.toThrow(/Not the withdrawer/);
  });

  it("rejects a genuinely attested 5-byte output that is not the failure output", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    // Digest and signature check out, but the bytes are not the sentinel:
    // no refund. Guards against width collisions as respond schemas grow.
    const notTheSentinel = bytes(5, 0x01);
    await expect(
      contract.circuits.refundWithdraw(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, notTheSentinel),
        notTheSentinel,
        MINT_NONCE,
        COIN_NONCE,
      ),
    ).rejects.toThrow(/Not the MPC failure output/);
  });

  it("rejects a failure output signed by a key other than the stored MPC response key", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    await expect(
      contract.circuits.refundWithdraw(
        ctx,
        requestId,
        respond(IMPOSTER_SECRET, requestId, OUTPUT_REVERTED),
        OUTPUT_REVERTED,
        MINT_NONCE,
        COIN_NONCE,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects presented output bytes that differ from what was signed", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    // Signed over some other 5-byte output, presented as the sentinel: the
    // recomputed digest no longer matches what the signature covers, so the
    // signature check rejects it before the sentinel gate.
    await expect(
      contract.circuits.refundWithdraw(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, bytes(5, 0x01)),
        OUTPUT_REVERTED,
        MINT_NONCE,
        COIN_NONCE,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects refunding a DEPOSIT request (no refund marker) even with a genuine failure output", async () => {
    const { contract, ctx } = await deployInitialised();
    const next = (await deposit(contract, ctx, VALID_DEPOSIT)).context;
    const index = toSignBidirectionalEventIndex(
      ledger(next.callContext.currentQueryContext.state).depositEventMap,
    );
    const depositIdHex = first(index.keys(), "signBidirectional request id");
    const depositId = requestIdBytes(depositIdHex);

    await expect(
      contract.circuits.refundWithdraw(
        next,
        depositId,
        respond(MPC_RESPONSE_SECRET, depositId, OUTPUT_REVERTED),
        OUTPUT_REVERTED,
        MINT_NONCE,
        COIN_NONCE,
      ),
      // Deposits never insert the pending-withdrawal marker, so a deposit id
      // cannot be refunded as a withdrawal.
    ).rejects.toThrow(/Withdrawal not found/);
  });

  it("refunds once: a second refund for the same request rejects", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    const next = (
      await contract.circuits.refundWithdraw(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_REVERTED),
        OUTPUT_REVERTED,
        MINT_NONCE,
        COIN_NONCE,
      )
    ).context;
    await expect(
      contract.circuits.refundWithdraw(
        next,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_REVERTED),
        OUTPUT_REVERTED,
        MINT_NONCE,
        COIN_NONCE,
      ),
      // The first refund consumed the pending-withdrawal marker.
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
 * Deploy + initialise + deposit(VALID_DEPOSIT): the arrange step of
 * every claim test. Returns the pending deposit's request id (the single
 * ledger map key) alongside the threaded context.
 */
const depositRequested = async () => {
  const { contract, ctx } = await deployInitialised();
  const next = (await deposit(contract, ctx, VALID_DEPOSIT)).context;
  const index = toSignBidirectionalEventIndex(
    ledger(next.callContext.currentQueryContext.state).depositEventMap,
  );
  const idHex = first(index.keys(), "signBidirectional request id");
  return { contract, ctx: next, requestId: requestIdBytes(idHex) };
};

// ---- Claim-deposit tests ----

describe("completeDeposit settle", () => {
  // The mint itself is shielded: the call resolving proves it executed, and
  // the publicly-observable effect asserted here is the request's consumption.
  it.each([
    { name: "no recipient: mints to the caller", recipient: CALLER_RECIPIENT },
    {
      name: "an explicit wallet recipient: mints to the given coin public key",
      recipient: OTHER_WALLET_RECIPIENT,
    },
    {
      name: "an explicit contract recipient: mints to the given contract address",
      recipient: CONTRACT_RECIPIENT,
    },
  ])("$name and consumes the request", async ({ recipient }) => {
    const { contract, ctx, requestId } = await depositRequested();

    const next = (
      await contract.circuits.completeDeposit(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS),
        OUTPUT_SUCCESS,
        MINT_NONCE,
        recipient,
      )
    ).context;

    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.depositEventMap.isEmpty()).toBe(true);
    expect(state.depositSettleViews.isEmpty()).toBe(true);
  });

  it("rejects a response signed by a key other than the stored MPC response key", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    await expect(
      contract.circuits.completeDeposit(
        ctx,
        requestId,
        respond(IMPOSTER_SECRET, requestId, OUTPUT_SUCCESS),
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a genuinely signed sweep that returned false", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    await expect(
      contract.circuits.completeDeposit(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_FALSE),
        OUTPUT_FALSE,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/ERC20 transfer returned false/);
  });

  it("rejects presented output bytes that differ from what was signed", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    // Signed over the FALSE result, presented as a success byte: the digest
    // recomputed in-circuit is not the one the signature covers. This is the
    // attack the signature-only event must stop: claiming a failed sweep as a
    // success. (The reverse presentation would trip the return-value assert
    // first.)
    await expect(
      contract.circuits.completeDeposit(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_FALSE),
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a genuinely signed id that has no pending deposit", async () => {
    const { contract, ctx } = await depositRequested();
    const unknownId = bytes(32, 0xab);
    await expect(
      contract.circuits.completeDeposit(
        ctx,
        unknownId,
        respond(MPC_RESPONSE_SECRET, unknownId, OUTPUT_SUCCESS),
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Deposit not found/);
  });

  it("claims once: a second claim for the same request rejects", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const next = (
      await contract.circuits.completeDeposit(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS),
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;
    await expect(
      contract.circuits.completeDeposit(
        next,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS),
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
      // The first claim consumed the deposit entry and its settle view.
    ).rejects.toThrow(/Deposit not found/);
  });

  it("rejects a caller other than the original depositor, even one naming themselves recipient", async () => {
    // The settle view pins the DEPOSITOR's identity commitment, and the
    // stranger's witness recomputes a different one.
    const { contract, ctx, requestId } = await depositRequested();
    await expect(
      contract.circuits.completeDeposit(
        await strangerContext("completeDeposit", ctx),
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS),
        OUTPUT_SUCCESS,
        MINT_NONCE,
        OTHER_WALLET_RECIPIENT,
      ),
    ).rejects.toThrow(/Not the depositor/);
  });
});

// ============================ Swap (Uniswap V3) =============================

const EXACT_OUTPUT_SINGLE_SELECTOR = new Uint8Array([0x50, 0x23, 0xb4, 0xdf]);
const APPROVE_SELECTOR = new Uint8Array([0x09, 0x5e, 0xa7, 0xb3]);
const MAX_APPROVE = pureCircuits.unlimitedAllowance();
// exactOutputSingle returns amountIn: the MPC decodes it as uint256, re-packs it as uint64.
const SWAP_OUTPUT_SCHEMA = asciiPadded('[{"name":"amountIn","type":"uint256"}]', 38);
const SWAP_RESPOND_SCHEMA = asciiPadded('[{"name":"amountIn","type":"uint64"}]', 37);

// A second ERC20 (tokenOut) with its own vault-token color.
const ERC20_OUT = bytes(20, 0xbb);
const VAULT_TOKEN_COLOR_OUT = hexToBytes(
  rawTokenType(pureCircuits.vaultTokenDomainSeparator(ERC20_OUT), VAULT_ADDRESS),
);
const FEE = 500n;
const SWAP_AMOUNT_OUT = 995_000n; // exact tokenOut received
const SWAP_AMOUNT_IN_MAX = AMOUNT; // spend cap = the surrendered coin
const SWAP_AMOUNT_IN_SPENT = 990_000n; // attested input actually spent (<= the cap)

interface SwapCallArgs {
  keyVersion: bigint;
  swap: {
    tokenIn: Uint8Array;
    tokenOut: Uint8Array;
    fee: bigint;
    amountOut: bigint;
    amountInMaximum: bigint;
  };
  coin: ReturnType<typeof vaultCoin>;
}

const VALID_SWAP: SwapCallArgs = {
  keyVersion: 1n,
  swap: {
    tokenIn: ERC20,
    tokenOut: ERC20_OUT,
    fee: FEE,
    amountOut: SWAP_AMOUNT_OUT,
    amountInMaximum: SWAP_AMOUNT_IN_MAX,
  },
  coin: vaultCoin(SWAP_AMOUNT_IN_MAX),
};

/** Drive both halves of a swap: requestSwap then assignSwap. */
const swap = (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  args: SwapCallArgs,
): Promise<TwoPhaseRun> => {
  const key = requestKeyOf(ctx, args.coin.nonce);
  return twoPhase(
    key,
    () => contract.circuits.requestSwap(ctx, args.keyVersion, args.swap, args.coin),
    (next, path) =>
      contract.circuits.assignSwap(
        next,
        key,
        path as Parameters<Contract<VaultPrivateState>["circuits"]["assignSwap"]>[2],
      ),
  );
};

// A successful swap's attested output: the amountIn spent as the MPC serializes it — a
// Midnight-native little-endian uint64 (8 bytes), the twin of serializeRespondOutput.
// completeSwap native-deserializes it.
const swapOutput = (amountIn: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  let v = amountIn;
  for (let i = 0; i < 8 && v > 0n; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
};
const OUTPUT_SWAP = swapOutput(SWAP_AMOUNT_IN_SPENT);

describe("approveRouter", () => {
  it("records an approve(router, ~unlimited) on signBidirectionalEventMap from the vault path, no coin", async () => {
    const { contract, ctx } = await deployInitialised();
    const run = await approveRouter(contract, ctx);
    const next = run.context;

    const index = toSignBidirectionalEventIndex(
      ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap,
    );
    expect(index.size).toBe(1);
    const [, record] = first(index.entries(), "indexed approveRouter request");

    // Vault path, approve ON the erc20, spender = pinned router, amount = MAX.
    expect(record.path).toEqual(asciiPadded("vault", 32));
    expect(record.txParams.to).toEqual(ERC20);
    const { calldata } = record.txParams;
    expect(calldata.is_some).toBe(true);
    expect(calldata.value.selector).toEqual(APPROVE_SELECTOR);
    expect(calldata.value.noWords).toBe(2n);
    expect(calldata.value.words[0]).toEqual(evmAddressAbiWord(ROUTER));
    expect(calldata.value.words[1]).toEqual(numericAbiWord(MAX_APPROVE));

    // The approves sign from the SAME vault EVM account as the value flows, so
    // they must draw their nonce from the same allocator. A second source of
    // nonces would hand one nonce to two transactions and strand the account.
    expect(record.txParams.nonce).toBe(EVM_NONCE_BASE + run.slotIndex);
  });

  it("is permissionless (a stranger may ready a token) and needs initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.requestApproveRouter(ctx, ERC20, 1n, APPROVE_SALT),
    ).rejects.toThrow(/Not initialised/);
    const ready = await deployInitialised();
    await expect(
      approveRouter(ready.contract, await strangerContext("requestApproveRouter", ready.ctx)),
    ).resolves.toBeDefined();
  });
});

describe("swap round-trip", () => {
  it("burns tokenIn and stores a vault-path exactOutputSingle event on the swap map", async () => {
    const { contract, ctx } = await deployInitialised();
    const run = await swap(contract, ctx, VALID_SWAP);
    const next = run.context;
    const state = ledger(next.callContext.currentQueryContext.state);

    const index = toSignBidirectionalEventIndex(state.swapEventMap);
    expect(index.size).toBe(1);
    // Field 0 stays empty: the swap went to the swap map, not the transfer map.
    expect(state.signBidirectionalEventMap.isEmpty()).toBe(true);
    const [idHex, record] = first(index.entries(), "indexed swap request");

    expect(record.sender).toEqual({ bytes: VAULT_ADDRESS_BYTES });
    expect(record.path).toEqual(asciiPadded("vault", 32));

    // Contract-fixed envelope: to = pinned router, vault-paid gas.
    const { calldata, ...envelope } = record.txParams;
    expect(envelope).toEqual({
      to: ROUTER,
      chainId: CHAIN_ID,
      nonce: EVM_NONCE_BASE + run.slotIndex,
      gasLimit: 700_000n,
      // The initialise-time defaults, now ledger values a deployer can move
      // with setGasParams (see the "gas parameters" describes at the end of
      // this file). 150 gwei, the ceiling initialise sets.
      maxFeePerGas: 150_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
    });
    expect(record.outputDeserializationSchema).toEqual(SWAP_OUTPUT_SCHEMA);
    expect(record.respondSerializationSchema).toEqual(SWAP_RESPOND_SCHEMA);

    // exactOutputSingle((tokenIn, tokenOut, fee, recipient=vault, amountOut, amountInMaximum, 0)).
    expect(calldata.is_some).toBe(true);
    expect(calldata.value.selector).toEqual(EXACT_OUTPUT_SINGLE_SELECTOR);
    expect(calldata.value.noWords).toBe(7n);
    expect(calldata.value.words[0]).toEqual(evmAddressAbiWord(ERC20));
    expect(calldata.value.words[1]).toEqual(evmAddressAbiWord(ERC20_OUT));
    expect(calldata.value.words[2]).toEqual(numericAbiWord(FEE));
    expect(calldata.value.words[3]).toEqual(evmAddressAbiWord(VAULT_EVM));
    expect(calldata.value.words[4]).toEqual(numericAbiWord(SWAP_AMOUNT_OUT));
    expect(calldata.value.words[5]).toEqual(numericAbiWord(SWAP_AMOUNT_IN_MAX));
    expect(calldata.value.words[6]).toEqual(numericAbiWord(0n));

    // Pending-swap marker pinned.
    expect(state.swapSettleViews.member(requestIdBytes(idHex))).toBe(true);

    // Same burn as withdraw (which asserts the receive/spend pairing in
    // detail): amountInMaximum of the tokenIn vault coin is received, spent,
    // and paid whole to the shielded burn address.
    const zswap = zswapState(run.request.context);

    // check inputs, expect 1 input:
    // - coin for the amount being withdrawn
    expect(zswap.inputs).toHaveLength(1);
    const consumed = first(zswap.inputs, "consumed coin");
    expect(consumed.color).toEqual(VAULT_TOKEN_COLOR);
    expect(consumed.value).toBe(SWAP_AMOUNT_IN_MAX);

    // check outputs, expect 2 ouputs:
    // - received coin to the contract address
    // - burned coin to the burn address
    expect(zswap.outputs).toHaveLength(2);

    // received coin to the contract address
    const received = first(
      zswap.outputs.filter((output) => !output.recipient.is_left),
      "contract-owned receive output",
    );
    expect(received.recipient.right.bytes).toEqual(VAULT_ADDRESS_BYTES);
    expect(received.coinInfo).toEqual({
      nonce: consumed.nonce,
      color: consumed.color,
      value: consumed.value,
    });

    // burned coin to the burn address
    const burnOutput = first(
      zswap.outputs.filter((output) => output.recipient.is_left),
      "burn output",
    );
    expect(burnOutput.coinInfo.color).toEqual(VAULT_TOKEN_COLOR);
    expect(burnOutput.coinInfo.value).toBe(SWAP_AMOUNT_IN_MAX);
    expect(burnOutput.recipient.left.bytes).toEqual(BURN_ADDRESS_BYTES);
  });

  it("rejects a coin that is not the tokenIn vault color or not amountInMaximum", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(
      swap(contract, ctx, { ...VALID_SWAP, coin: vaultCoin(AMOUNT, VAULT_TOKEN_COLOR_OUT) }),
    ).rejects.toThrow(/Coin is not the vault token for tokenIn/);
    await expect(
      swap(contract, ctx, { ...VALID_SWAP, coin: vaultCoin(SWAP_AMOUNT_IN_MAX + 1n) }),
    ).rejects.toThrow(/Coin value must equal amountInMaximum/);
  });
});

// ---- Swap settle fixtures ----

const swapRequested = async () => {
  const { contract, ctx } = await deployInitialised();
  const next = (await swap(contract, ctx, VALID_SWAP)).context;
  const index = toSignBidirectionalEventIndex(
    ledger(next.callContext.currentQueryContext.state).swapEventMap,
  );
  const idHex = first(index.keys(), "indexed swap request");
  return { contract, ctx: next, requestId: requestIdBytes(idHex) };
};

describe("completeSwap settle", () => {
  it("verifies the amountIn attestation, mints tokenOut + change, and cleans up (swapper-gated)", async () => {
    const { contract, ctx, requestId } = await swapRequested();
    const next = (
      await contract.circuits.completeSwap(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SWAP),
        OUTPUT_SWAP,
        MINT_NONCE,
        CHANGE_NONCE,
        COIN_NONCE,
      )
    ).context;
    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.swapEventMap.isEmpty()).toBe(true);
    expect(state.swapSettleViews.isEmpty()).toBe(true);
  });

  it("a caller other than the swapper cannot take the minted tokenOut", async () => {
    const { contract, ctx, requestId } = await swapRequested();
    await expect(
      contract.circuits.completeSwap(
        await strangerContext("completeSwap", ctx),
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SWAP),
        OUTPUT_SWAP,
        MINT_NONCE,
        CHANGE_NONCE,
        COIN_NONCE,
      ),
    ).rejects.toThrow(/Not the swapper/);
  });

  it("rejects a changeNonce equal to mintNonce (the two coins must not share a nonce)", async () => {
    const { contract, ctx, requestId } = await swapRequested();
    await expect(
      contract.circuits.completeSwap(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SWAP),
        OUTPUT_SWAP,
        MINT_NONCE,
        MINT_NONCE,
        COIN_NONCE,
      ),
    ).rejects.toThrow(/changeNonce must differ from mintNonce/);
  });

  it("rejects an attestation signed by the wrong key, and presented bytes that differ", async () => {
    const { contract, ctx, requestId } = await swapRequested();
    await expect(
      contract.circuits.completeSwap(
        ctx,
        requestId,
        respond(IMPOSTER_SECRET, requestId, OUTPUT_SWAP),
        OUTPUT_SWAP,
        MINT_NONCE,
        CHANGE_NONCE,
        COIN_NONCE,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
    await expect(
      contract.circuits.completeSwap(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SWAP),
        swapOutput(1n),
        MINT_NONCE,
        CHANGE_NONCE,
        COIN_NONCE,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });
});

describe("refundSwap settle", () => {
  it("on the MPC failure output, re-mints tokenIn to the swapper and cleans up", async () => {
    const { contract, ctx, requestId } = await swapRequested();
    const next = (
      await contract.circuits.refundSwap(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_REVERTED),
        OUTPUT_REVERTED,
        MINT_NONCE,
        COIN_NONCE,
      )
    ).context;
    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.swapEventMap.isEmpty()).toBe(true);
    expect(state.swapSettleViews.isEmpty()).toBe(true);
  });

  it("is swapper-gated", async () => {
    const { contract, ctx, requestId } = await swapRequested();
    await expect(
      contract.circuits.refundSwap(
        await strangerContext("refundSwap", ctx),
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_REVERTED),
        OUTPUT_REVERTED,
        MINT_NONCE,
        COIN_NONCE,
      ),
    ).rejects.toThrow(/Not the swapper/);
  });
});

// ---- Aave: supply/redeem fixtures ----

const DEPOSIT_SELECTOR = new Uint8Array([0x6e, 0x55, 0x3f, 0x65]);
const REDEEM_SELECTOR = new Uint8Array([0xba, 0x08, 0x76, 0x52]);
const SUPPLY_OUTPUT_SCHEMA = asciiPadded('[{"name":"shares","type":"uint256"}]', 36);
const SUPPLY_RESPOND_SCHEMA = asciiPadded('[{"name":"shares","type":"uint64"}]', 35);
const REDEEM_OUTPUT_SCHEMA = asciiPadded('[{"name":"assets","type":"uint256"}]', 36);
const REDEEM_RESPOND_SCHEMA = asciiPadded('[{"name":"assets","type":"uint64"}]', 35);

// Vault-token colours of the pinned pair, computed like a wallet (off-chain twin
// of the in-circuit tokenType(domainSep, kernel.self())).
const STATA_UNDERLYING_COLOR = hexToBytes(
  rawTokenType(pureCircuits.vaultTokenDomainSeparator(STATA_UNDERLYING), VAULT_ADDRESS),
);
const STATA_COLOR = hexToBytes(
  rawTokenType(pureCircuits.vaultTokenDomainSeparator(STATA_TOKEN), VAULT_ADDRESS),
);

const SUPPLY_AMOUNT = AMOUNT; // USDC surrendered
const SUPPLY_SHARES = 360_679n; // attested stataUSDC shares minted
const REDEEM_SHARES = AMOUNT; // stataUSDC surrendered
const REDEEM_ASSETS = 2_780_944n; // attested USDC assets minted (principal + interest)

/** Drive both halves of a supply: requestSupply then assignSupply. */
const supply = (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  amount: bigint,
  coin: ReturnType<typeof vaultCoin>,
): Promise<TwoPhaseRun> => {
  const key = requestKeyOf(ctx, coin.nonce);
  return twoPhase(
    key,
    () => contract.circuits.requestSupply(ctx, 1n, amount, coin),
    (next, path) =>
      contract.circuits.assignSupply(
        next,
        key,
        path as Parameters<Contract<VaultPrivateState>["circuits"]["assignSupply"]>[2],
      ),
  );
};

/** Drive both halves of a redeem: requestRedeem then assignRedeem. */
const redeem = (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  shares: bigint,
  coin: ReturnType<typeof vaultCoin>,
): Promise<TwoPhaseRun> => {
  const key = requestKeyOf(ctx, coin.nonce);
  return twoPhase(
    key,
    () => contract.circuits.requestRedeem(ctx, 1n, shares, coin),
    (next, path) =>
      contract.circuits.assignRedeem(
        next,
        key,
        path as Parameters<Contract<VaultPrivateState>["circuits"]["assignRedeem"]>[2],
      ),
  );
};

/** Drive both halves of an approve: request* then assign*. `salt` keys the slot. */
const approveRouter = (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  erc20Address: Uint8Array = ERC20,
  salt: Uint8Array = APPROVE_SALT,
): Promise<TwoPhaseRun> => {
  const key = requestKeyOf(ctx, salt);
  return twoPhase(
    key,
    () => contract.circuits.requestApproveRouter(ctx, erc20Address, 1n, salt),
    (next, path) =>
      contract.circuits.assignApproveRouter(
        next,
        key,
        path as Parameters<Contract<VaultPrivateState>["circuits"]["assignApproveRouter"]>[2],
      ),
  );
};

const approveStata = (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  salt: Uint8Array = APPROVE_SALT,
): Promise<TwoPhaseRun> => {
  const key = requestKeyOf(ctx, salt);
  return twoPhase(
    key,
    () => contract.circuits.requestApproveStata(ctx, 1n, salt),
    (next, path) =>
      contract.circuits.assignApproveStata(
        next,
        key,
        path as Parameters<Contract<VaultPrivateState>["circuits"]["assignApproveStata"]>[2],
      ),
  );
};

describe("approveStata", () => {
  it("records approve(stataToken, MAX) on signBidirectionalEventMap from the vault path, to = the underlying", async () => {
    const { contract, ctx } = await deployInitialised();
    const run = await approveStata(contract, ctx);
    const next = run.context;

    const index = toSignBidirectionalEventIndex(
      ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap,
    );
    expect(index.size).toBe(1);
    const [, record] = first(index.entries(), "indexed approveStata request");
    expect(record.path).toEqual(asciiPadded("vault", 32));
    // approve is called ON the underlying USDC, spender = the pinned wrapper.
    expect(record.txParams.to).toEqual(STATA_UNDERLYING);
    const { calldata } = record.txParams;
    expect(calldata.value.selector).toEqual(APPROVE_SELECTOR);
    expect(calldata.value.words[0]).toEqual(evmAddressAbiWord(STATA_TOKEN));
    expect(calldata.value.words[1]).toEqual(numericAbiWord(MAX_APPROVE));
    expect(record.txParams.nonce).toBe(EVM_NONCE_BASE + run.slotIndex);
  });
});

describe("supply round-trip", () => {
  it("burns the underlying and stores a vault-path deposit event on the supply map", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: next } = await supply(
      contract,
      ctx,
      SUPPLY_AMOUNT,
      vaultCoin(SUPPLY_AMOUNT, STATA_UNDERLYING_COLOR),
    );
    const state = ledger(next.callContext.currentQueryContext.state);

    const index = toSignBidirectionalEventIndex(state.supplyEventMap);
    expect(index.size).toBe(1);
    const [idHex, record] = first(index.entries(), "indexed supply request");
    expect(record.sender).toEqual({ bytes: VAULT_ADDRESS_BYTES });
    expect(record.path).toEqual(asciiPadded("vault", 32));
    expect(record.txParams.to).toEqual(STATA_TOKEN);
    expect(record.outputDeserializationSchema).toEqual(SUPPLY_OUTPUT_SCHEMA);
    expect(record.respondSerializationSchema).toEqual(SUPPLY_RESPOND_SCHEMA);

    // deposit(amount, receiver=vault).
    const { calldata } = record.txParams;
    expect(calldata.value.selector).toEqual(DEPOSIT_SELECTOR);
    expect(calldata.value.noWords).toBe(2n);
    expect(calldata.value.words[0]).toEqual(numericAbiWord(SUPPLY_AMOUNT));
    expect(calldata.value.words[1]).toEqual(evmAddressAbiWord(VAULT_EVM));

    expect(state.supplySettleViews.member(requestIdBytes(idHex))).toBe(true);

    // Same burn as withdraw (which asserts the receive/spend pairing in
    // detail): the underlying vault coin is received, spent, and paid whole to
    // the shielded burn address.
    const zswap = zswapState(next);

    expect(zswap.inputs).toHaveLength(1);
    const consumed = first(zswap.inputs, "consumed coin");
    expect(consumed.color).toEqual(STATA_UNDERLYING_COLOR);
    expect(consumed.value).toBe(SUPPLY_AMOUNT);

    expect(zswap.outputs).toHaveLength(2);

    // received coin to the contract address (the receive/spend transient)
    const received = first(
      zswap.outputs.filter((output) => !output.recipient.is_left),
      "contract-owned receive output",
    );
    expect(received.recipient.right.bytes).toEqual(VAULT_ADDRESS_BYTES);
    expect(received.coinInfo).toEqual({
      nonce: consumed.nonce,
      color: consumed.color,
      value: consumed.value,
    });

    // burned coin to the burn address
    const burnOutput = first(
      zswap.outputs.filter((output) => output.recipient.is_left),
      "burn output",
    );
    expect(burnOutput.coinInfo.color).toEqual(STATA_UNDERLYING_COLOR);
    expect(burnOutput.coinInfo.value).toBe(SUPPLY_AMOUNT);
    expect(burnOutput.recipient.left.bytes).toEqual(BURN_ADDRESS_BYTES);
  });

  it("rejects a coin that is not the underlying color or not the amount", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(
      supply(contract, ctx, SUPPLY_AMOUNT, vaultCoin(SUPPLY_AMOUNT, STATA_COLOR)),
    ).rejects.toThrow(/Coin is not the vault token for the underlying/);
    await expect(
      supply(contract, ctx, SUPPLY_AMOUNT, vaultCoin(SUPPLY_AMOUNT + 1n, STATA_UNDERLYING_COLOR)),
    ).rejects.toThrow(/Coin value must equal amount/);
  });

  it("rejects a zero amount and an amount past the Uint<64> refund cap", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(supply(contract, ctx, 0n, vaultCoin(0n, STATA_UNDERLYING_COLOR))).rejects.toThrow(
      /amount must be positive/,
    );
    const overCap = 1n << 64n;
    await expect(
      supply(contract, ctx, overCap, vaultCoin(overCap, STATA_UNDERLYING_COLOR)),
    ).rejects.toThrow(/amount exceeds Uint<64> max/);
  });
});

const supplyRequested = async () => {
  const { contract, ctx } = await deployInitialised();
  const next = (
    await supply(contract, ctx, SUPPLY_AMOUNT, vaultCoin(SUPPLY_AMOUNT, STATA_UNDERLYING_COLOR))
  ).context;
  const index = toSignBidirectionalEventIndex(
    ledger(next.callContext.currentQueryContext.state).supplyEventMap,
  );
  const idHex = first(index.keys(), "indexed supply request");
  return { contract, ctx: next, requestId: requestIdBytes(idHex) };
};

describe("completeSupply settle", () => {
  it("verifies the shares attestation, mints stataToken, and cleans up (supplier-gated)", async () => {
    const { contract, ctx, requestId } = await supplyRequested();
    const out = swapOutput(SUPPLY_SHARES);
    const next = (
      await contract.circuits.completeSupply(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, out),
        out,
        MINT_NONCE,
        COIN_NONCE,
      )
    ).context;
    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.supplyEventMap.isEmpty()).toBe(true);
    expect(state.supplySettleViews.isEmpty()).toBe(true);
  });

  it("a caller other than the supplier cannot take the minted shares", async () => {
    const { contract, ctx, requestId } = await supplyRequested();
    const out = swapOutput(SUPPLY_SHARES);
    await expect(
      contract.circuits.completeSupply(
        await strangerContext("completeSupply", ctx),
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, out),
        out,
        MINT_NONCE,
        COIN_NONCE,
      ),
    ).rejects.toThrow(/Not the supplier/);
  });
});

describe("redeem round-trip", () => {
  it("burns the stataToken and stores a vault-path redeem event on the redeem map", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: next } = await redeem(
      contract,
      ctx,
      REDEEM_SHARES,
      vaultCoin(REDEEM_SHARES, STATA_COLOR),
    );
    const state = ledger(next.callContext.currentQueryContext.state);

    const index = toSignBidirectionalEventIndex(state.redeemEventMap);
    expect(index.size).toBe(1);
    const [idHex, record] = first(index.entries(), "indexed redeem request");
    expect(record.txParams.to).toEqual(STATA_TOKEN);
    expect(record.outputDeserializationSchema).toEqual(REDEEM_OUTPUT_SCHEMA);
    expect(record.respondSerializationSchema).toEqual(REDEEM_RESPOND_SCHEMA);

    // redeem(shares, receiver=vault, owner=vault).
    const { calldata } = record.txParams;
    expect(calldata.value.selector).toEqual(REDEEM_SELECTOR);
    expect(calldata.value.noWords).toBe(3n);
    expect(calldata.value.words[0]).toEqual(numericAbiWord(REDEEM_SHARES));
    expect(calldata.value.words[1]).toEqual(evmAddressAbiWord(VAULT_EVM));
    expect(calldata.value.words[2]).toEqual(evmAddressAbiWord(VAULT_EVM));

    expect(state.redeemSettleViews.member(requestIdBytes(idHex))).toBe(true);

    // Same burn as supply: the wrapper vault coin is received, spent, and paid
    // whole to the shielded burn address.
    const zswap = zswapState(next);

    expect(zswap.inputs).toHaveLength(1);
    const consumed = first(zswap.inputs, "consumed coin");
    expect(consumed.color).toEqual(STATA_COLOR);
    expect(consumed.value).toBe(REDEEM_SHARES);

    expect(zswap.outputs).toHaveLength(2);

    // received coin to the contract address (the receive/spend transient)
    const received = first(
      zswap.outputs.filter((output) => !output.recipient.is_left),
      "contract-owned receive output",
    );
    expect(received.recipient.right.bytes).toEqual(VAULT_ADDRESS_BYTES);
    expect(received.coinInfo).toEqual({
      nonce: consumed.nonce,
      color: consumed.color,
      value: consumed.value,
    });

    // burned coin to the burn address
    const burnOutput = first(
      zswap.outputs.filter((output) => output.recipient.is_left),
      "burn output",
    );
    expect(burnOutput.coinInfo.color).toEqual(STATA_COLOR);
    expect(burnOutput.coinInfo.value).toBe(REDEEM_SHARES);
    expect(burnOutput.recipient.left.bytes).toEqual(BURN_ADDRESS_BYTES);
  });

  it("rejects a coin that is not the wrapper color or not the shares", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(
      redeem(contract, ctx, REDEEM_SHARES, vaultCoin(REDEEM_SHARES, STATA_UNDERLYING_COLOR)),
    ).rejects.toThrow(/Coin is not the vault token for the wrapper/);
    await expect(
      redeem(contract, ctx, REDEEM_SHARES, vaultCoin(REDEEM_SHARES + 1n, STATA_COLOR)),
    ).rejects.toThrow(/Coin value must equal shares/);
  });

  it("rejects zero shares and shares past the Uint<64> refund cap", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(redeem(contract, ctx, 0n, vaultCoin(0n, STATA_COLOR))).rejects.toThrow(
      /shares must be positive/,
    );
    const overCap = 1n << 64n;
    await expect(redeem(contract, ctx, overCap, vaultCoin(overCap, STATA_COLOR))).rejects.toThrow(
      /shares exceeds Uint<64> max/,
    );
  });
});

const redeemRequested = async () => {
  const { contract, ctx } = await deployInitialised();
  const next = (await redeem(contract, ctx, REDEEM_SHARES, vaultCoin(REDEEM_SHARES, STATA_COLOR)))
    .context;
  const index = toSignBidirectionalEventIndex(
    ledger(next.callContext.currentQueryContext.state).redeemEventMap,
  );
  const idHex = first(index.keys(), "indexed redeem request");
  return { contract, ctx: next, requestId: requestIdBytes(idHex) };
};

describe("completeRedeem settle", () => {
  it("a caller other than the redeemer cannot take the minted underlying", async () => {
    const { contract, ctx, requestId } = await redeemRequested();
    const out = swapOutput(REDEEM_ASSETS);
    await expect(
      contract.circuits.completeRedeem(
        await strangerContext("completeRedeem", ctx),
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, out),
        out,
        MINT_NONCE,
        COIN_NONCE,
      ),
    ).rejects.toThrow(/Not the redeemer/);
  });

  it("verifies the assets attestation, mints the underlying, and cleans up", async () => {
    const { contract, ctx, requestId } = await redeemRequested();
    const out = swapOutput(REDEEM_ASSETS);
    const next = (
      await contract.circuits.completeRedeem(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, out),
        out,
        MINT_NONCE,
        COIN_NONCE,
      )
    ).context;
    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.redeemEventMap.isEmpty()).toBe(true);
    expect(state.redeemSettleViews.isEmpty()).toBe(true);
  });
});

describe("refundSupply / refundRedeem settle", () => {
  it("supply: on the MPC failure output, re-mints the underlying to the supplier and cleans up", async () => {
    const { contract, ctx, requestId } = await supplyRequested();
    const next = (
      await contract.circuits.refundSupply(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_REVERTED),
        OUTPUT_REVERTED,
        MINT_NONCE,
        COIN_NONCE,
      )
    ).context;
    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.supplyEventMap.isEmpty()).toBe(true);
    expect(state.supplySettleViews.isEmpty()).toBe(true);
  });

  it("redeem: on the MPC failure output, re-mints the stataToken to the redeemer and cleans up", async () => {
    const { contract, ctx, requestId } = await redeemRequested();
    const next = (
      await contract.circuits.refundRedeem(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_REVERTED),
        OUTPUT_REVERTED,
        MINT_NONCE,
        COIN_NONCE,
      )
    ).context;
    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.redeemEventMap.isEmpty()).toBe(true);
    expect(state.redeemSettleViews.isEmpty()).toBe(true);
  });

  it("is supplier/redeemer-gated (a stranger cannot trigger the re-mint)", async () => {
    const { contract, ctx, requestId } = await supplyRequested();
    await expect(
      contract.circuits.refundSupply(
        await strangerContext("refundSupply", ctx),
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_REVERTED),
        OUTPUT_REVERTED,
        MINT_NONCE,
        COIN_NONCE,
      ),
    ).rejects.toThrow(/Not the supplier/);
  });
});

// ---- Cross-kind settle isolation ----

// Every settle circuit takes the same shaped arguments under one signature
// scheme, so a genuine attestation for ANY request id verifies in all of them.
// The per-kind map membership assert is the whole barrier, and this matrix
// exercises it: each kind's id against every OTHER kind's settle and refund
// circuit.

/** A request kind that pins a settle view under its own event map. */
enum SettleKind {
  Deposit = "deposit",
  Withdraw = "withdraw",
  Swap = "swap",
  Supply = "supply",
  Redeem = "redeem",
}

/** A started request: the threaded context plus the id its ledger map keyed it by. */
interface PendingRequest {
  contract: Contract<VaultPrivateState>;
  ctx: CircuitContext<VaultPrivateState>;
  requestId: RequestId;
}

/**
 * Deploy + initialise + approveRouter(ERC20). The recorded request lands on
 * signBidirectionalEventMap under the vault path, and no settle circuit
 * consumes it.
 */
const approveRouterRequested = async (): Promise<PendingRequest> => {
  const { contract, ctx } = await deployInitialised();
  const next = (await approveRouter(contract, ctx)).context;
  const index = toSignBidirectionalEventIndex(
    ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap,
  );
  const idHex = first(index.keys(), "indexed approveRouter request");
  return { contract, ctx: next, requestId: requestIdBytes(idHex) };
};

const OUTPUT_SUPPLY = swapOutput(SUPPLY_SHARES);
const OUTPUT_REDEEM = swapOutput(REDEEM_ASSETS);

/** One column of the matrix: a settle circuit, and the guard a foreign id must trip. */
interface CrossKindTarget {
  /** The kind whose requests this circuit settles. */
  kind: SettleKind;
  /** Circuit name, completing the title "... presented to <circuit>". */
  circuit: string;
  /** Calls the circuit with an attestation genuinely signed for the presented id. */
  settle: (pending: PendingRequest) => Promise<CircuitResults<VaultPrivateState, []>>;
  /** Error the circuit must throw on an id of another kind. */
  throws: RegExp;
}

const CROSS_KIND_TARGETS: CrossKindTarget[] = [
  {
    kind: SettleKind.Deposit,
    circuit: "completeDeposit",
    settle: ({ contract, ctx, requestId }) =>
      contract.circuits.completeDeposit(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS),
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    throws: /Deposit not found/,
  },
  {
    kind: SettleKind.Withdraw,
    circuit: "completeWithdraw",
    settle: ({ contract, ctx, requestId }) =>
      contract.circuits.completeWithdraw(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS),
        OUTPUT_SUCCESS,
        MINT_NONCE,
        COIN_NONCE,
      ),
    throws: /Withdrawal not found/,
  },
  {
    kind: SettleKind.Withdraw,
    circuit: "refundWithdraw",
    settle: ({ contract, ctx, requestId }) =>
      contract.circuits.refundWithdraw(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_REVERTED),
        OUTPUT_REVERTED,
        MINT_NONCE,
        COIN_NONCE,
      ),
    throws: /Withdrawal not found/,
  },
  {
    kind: SettleKind.Swap,
    circuit: "completeSwap",
    settle: ({ contract, ctx, requestId }) =>
      contract.circuits.completeSwap(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SWAP),
        OUTPUT_SWAP,
        MINT_NONCE,
        CHANGE_NONCE,
        COIN_NONCE,
      ),
    throws: /Swap not found/,
  },
  {
    kind: SettleKind.Swap,
    circuit: "refundSwap",
    settle: ({ contract, ctx, requestId }) =>
      contract.circuits.refundSwap(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_REVERTED),
        OUTPUT_REVERTED,
        MINT_NONCE,
        COIN_NONCE,
      ),
    throws: /Swap not found/,
  },
  {
    kind: SettleKind.Supply,
    circuit: "completeSupply",
    settle: ({ contract, ctx, requestId }) =>
      contract.circuits.completeSupply(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUPPLY),
        OUTPUT_SUPPLY,
        MINT_NONCE,
        COIN_NONCE,
      ),
    throws: /Supply not found/,
  },
  {
    kind: SettleKind.Supply,
    circuit: "refundSupply",
    settle: ({ contract, ctx, requestId }) =>
      contract.circuits.refundSupply(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_REVERTED),
        OUTPUT_REVERTED,
        MINT_NONCE,
        COIN_NONCE,
      ),
    throws: /Supply not found/,
  },
  {
    kind: SettleKind.Redeem,
    circuit: "completeRedeem",
    settle: ({ contract, ctx, requestId }) =>
      contract.circuits.completeRedeem(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_REDEEM),
        OUTPUT_REDEEM,
        MINT_NONCE,
        COIN_NONCE,
      ),
    throws: /Redeem not found/,
  },
  {
    kind: SettleKind.Redeem,
    circuit: "refundRedeem",
    settle: ({ contract, ctx, requestId }) =>
      contract.circuits.refundRedeem(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_REVERTED),
        OUTPUT_REVERTED,
        MINT_NONCE,
        COIN_NONCE,
      ),
    throws: /Redeem not found/,
  },
];

/** One row of the matrix: the kind of request whose id gets presented. */
interface CrossKindPresented {
  /** The started request's kind, naming the columns it is legitimately settled by. */
  kind: SettleKind;
  /** Arrange: deploy, initialise and start one request of this kind. */
  start: () => Promise<PendingRequest>;
}

const CROSS_KIND_PRESENTED: CrossKindPresented[] = [
  { kind: SettleKind.Deposit, start: depositRequested },
  { kind: SettleKind.Withdraw, start: withdrawRequested },
  { kind: SettleKind.Swap, start: swapRequested },
  { kind: SettleKind.Supply, start: supplyRequested },
  { kind: SettleKind.Redeem, start: redeemRequested },
];

describe("cross-kind settle isolation", () => {
  it.each(
    CROSS_KIND_PRESENTED.flatMap(({ kind, start }) =>
      CROSS_KIND_TARGETS.filter((target) => target.kind !== kind).map((target) => ({
        presented: kind,
        start,
        ...target,
      })),
    ),
  )("rejects a $presented request id presented to $circuit", async ({ start, settle, throws }) => {
    await expect(settle(await start())).rejects.toThrow(throws);
  });

  // The approves record on signBidirectionalEventMap and pin no settle view, so
  // no settle circuit accepts one either.
  it.each(CROSS_KIND_TARGETS)(
    "rejects an approveRouter request id presented to $circuit",
    async ({ settle, throws }) => {
      await expect(settle(await approveRouterRequested())).rejects.toThrow(throws);
    },
  );
});

// ===========================================================================
// Throughput: the vault-signed flows used to read and increment ONE shared
// counter for their request nonce — the cell now called issuedSlots — and take
// the EVM account nonce from the caller. That READ is pinned (popeq) and the
// cell moved on every request, so two requests proven against the same state
// could not both apply: the second failed on-chain reconciliation with a read
// mismatch. (The cell is still incremented today, once per issued slot, but
// nothing on this path READS it, which is the whole difference.)
// Measured against the shared-counter baseline this branch replaces, the pair
// below produced
//
//   REJECTED: mismatch between expected (<[-]: b8>) and actual (<[01]: b8>) read
//
// The two-phase allocator removes that read. Phase 1 touches only per-key map
// paths and appends to a HistoricMerkleTree (whose insert emits no popeq at
// all); phase 2 pins only per-key values plus a checkRoot whose TRUE is
// monotone against an append-only root history.
// ===========================================================================
interface VaultCall {
  contractAddress: string;
  publicTranscript: unknown;
  initialQueryContext: { block: unknown; state: unknown };
  finalQueryContext: { effects: unknown };
}
// The LAST vault call in the trace, not the first. The proof-data trace
// accumulates across every circuit run threaded through one context, so on a
// context that has already been through deployInitialised the first vault
// entry is `initialise` — replaying that instead of the call under test makes
// a contention assertion vacuous.
const vaultCallOf = (run: { context: CircuitContext<VaultPrivateState> }): VaultCall => {
  const trace = run.context.callProofDataTrace as unknown as VaultCall[];
  for (let i = trace.length - 1; i >= 0; i--) {
    const call = trace[i];
    if (call?.contractAddress === VAULT_ADDRESS) return call;
  }
  throw new Error("no vault call in the proof-data trace");
};
const gasOf = (run: { context: CircuitContext<VaultPrivateState> }): Record<string, unknown> => {
  const gas = (run.context.gasCosts as Record<string, Record<string, unknown> | undefined>)[
    VAULT_ADDRESS
  ];
  if (!gas) throw new Error("no vault gas cost on the run");
  return gas;
};

/**
 * A transcript's execution budget, scaled.
 *
 * The captured budget is the EXACT cost the transcript ran up against the
 * state it was built on. Replayed against a state another request has already
 * grown, the same program costs a little more (a bigger map is a deeper read),
 * and the simulator aborts with "ran out of gas budget" — a budget artefact,
 * not a conflict. A real transaction declares a budget with headroom for
 * precisely this reason, so the concurrency tests replay with headroom too.
 * The thing that CANNOT be worked around, and the thing these tests are
 * actually about, is a pinned-read mismatch.
 */
const withHeadroom = (gas: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, typeof v === "bigint" ? v * 8n : v]));

// Replay a captured vault transcript in verifying mode against `state`, using
// the SAME block context it was built under, so the only thing that can
// mismatch is a ledger cell that moved. Returns "applied" or the failure text.
const replay = (
  state: unknown,
  run: { context: CircuitContext<VaultPrivateState> },
  headroom = false,
): string => {
  const call = vaultCallOf(run);
  const qc = new QueryContext(state as never, VAULT_ADDRESS);
  (qc as unknown as { block: unknown }).block = call.initialQueryContext.block;
  const gas = gasOf(run);
  const transcript = {
    gas: headroom ? withHeadroom(gas) : gas,
    effects: call.finalQueryContext.effects,
    program: call.publicTranscript,
  };
  try {
    qc.runTranscript(transcript as never, CostModel.initialCostModel());
    return "applied";
  } catch (e) {
    return "REJECTED: " + String((e as { message?: string }).message ?? e).slice(0, 160);
  }
};

/** The state a threaded context currently sits on. */
const stateOf = (ctx: CircuitContext<VaultPrivateState>): unknown =>
  ctx.callContext.currentQueryContext.state;

/** The one request id a signBidirectional map holds, as bytes. */
const soleRequestId = (state: unknown, map: "signBidirectionalEventMap"): RequestId =>
  requestIdBytes(
    first(
      toSignBidirectionalEventIndex(ledger(state as Parameters<typeof ledger>[0])[map]).keys(),
      "recorded request id",
    ),
  );

describe("throughput: the two-phase allocator lets concurrent requests apply", () => {
  it("CONTROL: a deposit applies against the state it was built on (harness sanity)", async () => {
    const { contract, ctx } = await deployInitialised();
    // The state the call is proven against is the one on the context it is
    // given. (The trace entry's own initialQueryContext is NOT it: entries in
    // one accumulated trace share that field, so it still points at the
    // pre-initialise state.)
    const builtOn = stateOf(ctx);
    const run = await deposit(contract, ctx, VALID_DEPOSIT);
    expect(replay(builtOn, run)).toBe("applied");
  });

  it("two concurrent startDeposits from different callers both apply", async () => {
    const { contract, ctx } = await deployInitialised();
    const alice = await deposit(contract, ctx, VALID_DEPOSIT);
    const bobCtx = await strangerContext("startDeposit", ctx);
    const bob = await deposit(contract, bobCtx, VALID_DEPOSIT);
    // Bob was proven concurrently with Alice; he must still apply after her.
    expect(replay(stateOf(alice.context), bob, true)).toBe("applied");
  });

  // ---- CONTENTION: phase 1 ----

  it("CONTENTION: two concurrent requestWithdraws from different callers both apply", async () => {
    const { contract, ctx } = await deployInitialised();
    const alice = await requestWithdrawOnly(contract, ctx, VALID_WITHDRAW);
    const bobCtx = await strangerContext("requestWithdraw", ctx);
    const bob = await requestWithdrawOnly(contract, bobCtx, VALID_WITHDRAW);

    // Both were proven against the SAME post-initialise state. Alice applies,
    // and Bob's transcript must still reconcile against the state she left:
    // he read no cell she moved. This is the pair that failed with a read
    // mismatch against the shared-counter baseline (see the banner above).
    const afterAlice = stateOf(alice.context);
    expect(replay(afterAlice, bob, true)).toBe("applied");

    // ...and the allocator really did give them consecutive slots.
    const state = ledger(afterAlice as Parameters<typeof ledger>[0]);
    expect(state.pendingParams.size()).toBe(1n);
  });

  it("CONTENTION: the SAME caller's two coins both apply against one state", async () => {
    // Different coins, so different request keys, so different map paths: the
    // per-key pinned FALSE of one is not disturbed by the insert of the other.
    const { contract, ctx } = await deployInitialised();
    const one = await requestWithdrawOnly(contract, ctx, VALID_WITHDRAW);
    const two = await requestWithdrawOnly(contract, ctx, {
      ...VALID_WITHDRAW,
      coin: vaultCoin(AMOUNT, VAULT_TOKEN_COLOR, bytes(32, 0x0d)),
    });
    expect(replay(stateOf(one.context), two, true)).toBe("applied");
  });

  it("REGRESSION: two requests keying on the SAME coin nonce must NOT both apply", async () => {
    // The safety net behind unique allocator leaves: the duplicate key's
    // pinned FALSE is on the very path the first insert moved.
    const { contract, ctx } = await deployInitialised();
    const one = await requestWithdrawOnly(contract, ctx, VALID_WITHDRAW);
    const two = await requestWithdrawOnly(contract, ctx, VALID_WITHDRAW);
    expect(replay(stateOf(one.context), two)).toMatch(/^REJECTED/);
  });

  // ---- CONTENTION: phase 2 ----

  it("CONTENTION: two concurrent assigns for different requests both apply", async () => {
    const { contract, ctx } = await deployInitialised();

    // Park two requests first, so both slots exist before either assign runs.
    const parkedA = await requestWithdrawOnly(contract, ctx, VALID_WITHDRAW);
    const keyA = requestKeyOf(ctx, VALID_WITHDRAW.coin.nonce);
    const argsB = {
      ...VALID_WITHDRAW,
      coin: vaultCoin(AMOUNT, VAULT_TOKEN_COLOR, bytes(32, 0x0d)),
    };
    const parked = await requestWithdrawOnly(contract, parkedA.context, argsB);
    const keyB = requestKeyOf(ctx, argsB.coin.nonce);

    // Now prove BOTH assigns against that one state.
    const shared = parked.context;
    const pathA = slotPathOf(stateOf(shared) as Parameters<typeof ledger>[0], keyA);
    const pathB = slotPathOf(stateOf(shared) as Parameters<typeof ledger>[0], keyB);
    const assignA = await contract.circuits.assignWithdraw(shared, keyA, pathA);
    const assignB = await contract.circuits.assignWithdraw(shared, keyB, pathB);

    // A applies. B, proven against the same state, must still reconcile: its
    // checkRoot TRUE is monotone, and every other read it made is keyed on B.
    expect(replay(stateOf(assignA.context), assignB, true)).toBe("applied");
  });

  it("CONTENTION: a phase-2 proof survives a phase-1 insert that moves the slots root", async () => {
    // The monotonicity claim, tested directly. assign* pins checkRoot TRUE,
    // and checkRoot lowers to `member` against an APPEND-ONLY root history --
    // not `eq` against the current root. So a request* that lands in between,
    // moving the tree's current root, must not falsify it.
    const { contract, ctx } = await deployInitialised();
    const parked = await requestWithdrawOnly(contract, ctx, VALID_WITHDRAW);
    const key = requestKeyOf(ctx, VALID_WITHDRAW.coin.nonce);
    const path = slotPathOf(stateOf(parked.context) as Parameters<typeof ledger>[0], key);

    // Prove the assign against the state as it stands now...
    const assigned = await contract.circuits.assignWithdraw(parked.context, key, path);

    // ...then let somebody else's phase 1 insert a leaf and move the root.
    const interloperCtx = await strangerContext("requestWithdraw", parked.context);
    const interloper = await requestWithdrawOnly(contract, interloperCtx, VALID_WITHDRAW);
    const movedRoot = stateOf(interloper.context);
    expect(ledger(movedRoot as Parameters<typeof ledger>[0]).slots.root()).not.toEqual(
      ledger(stateOf(parked.context) as Parameters<typeof ledger>[0]).slots.root(),
    );

    // The already-proven assign still applies against the moved root.
    expect(replay(movedRoot, assigned, true)).toBe("applied");
  });

  // ---- CORRECTNESS ----

  it("CORRECTNESS: assigned EVM nonces are distinct, contiguous and evmNonceBase + slot", async () => {
    const { contract, ctx } = await deployInitialised();
    const nonces: bigint[] = [];

    // Five requests across THREE flows plus BOTH approves, all signing from
    // the one vault EVM account, so all five must draw from the one allocator.
    const runs: TwoPhaseRun[] = [];
    const step = async (
      run: (threaded: CircuitContext<VaultPrivateState>) => Promise<TwoPhaseRun>,
      threaded: CircuitContext<VaultPrivateState>,
    ): Promise<CircuitContext<VaultPrivateState>> => {
      const done = await run(threaded);
      runs.push(done);
      return done.context;
    };

    let threaded = ctx;
    threaded = await step((c) => approveStata(contract, c), threaded);
    threaded = await step((c) => approveRouter(contract, c, ERC20, bytes(32, 0x5b)), threaded);
    threaded = await step(
      (c) =>
        withdraw(contract, c, {
          ...VALID_WITHDRAW,
          coin: vaultCoin(AMOUNT, VAULT_TOKEN_COLOR, bytes(32, 0x11)),
        }),
      threaded,
    );
    threaded = await step(
      (c) =>
        withdraw(contract, c, {
          ...VALID_WITHDRAW,
          coin: vaultCoin(AMOUNT, VAULT_TOKEN_COLOR, bytes(32, 0x12)),
        }),
      threaded,
    );
    threaded = await step(
      (c) =>
        supply(
          contract,
          c,
          SUPPLY_AMOUNT,
          vaultCoin(SUPPLY_AMOUNT, STATA_UNDERLYING_COLOR, bytes(32, 0x13)),
        ),
      threaded,
    );

    // Slot indexes are 0..4 in request order.
    expect(runs.map((r) => r.slotIndex)).toEqual([0n, 1n, 2n, 3n, 4n]);

    const state = ledger(stateOf(threaded) as Parameters<typeof ledger>[0]);
    for (const [, record] of toSignBidirectionalEventIndex(state.signBidirectionalEventMap)) {
      nonces.push(record.txParams.nonce);
    }
    for (const [, record] of toSignBidirectionalEventIndex(state.supplyEventMap)) {
      nonces.push(record.txParams.nonce);
    }
    nonces.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    // Distinct, contiguous, and offset by the initialise-pinned base. A gap or
    // a repeat here is a stalled or double-spent EVM account nonce.
    expect(nonces).toEqual([0n, 1n, 2n, 3n, 4n].map((i) => EVM_NONCE_BASE + i));
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it("UNIQUENESS: identical vault-signed requests at different slots get different ids, and the EVM nonce is the only thing holding them apart", async () => {
    // What carries request-id uniqueness now that every vault-signed flow hashes
    // a CONSTANT 0 as its request nonce. calculateRequestId hashes the whole
    // SignBidirectionalEvent, txParams included, so the EVM nonce the allocator
    // issued is already inside every id; the vault signs from ONE EVM account,
    // and Ethereum spends an account's nonce exactly once.
    //
    // These two withdrawals agree on everything the id is built from -- same
    // caller, same amount, same recipient, same key version, same gas envelope.
    // They differ only in the coin surrendered, and the coin is not hashed into
    // the id at all: it only decides the request KEY, hence the slot.
    const { contract, ctx } = await deployInitialised();
    const one = await withdraw(contract, ctx, VALID_WITHDRAW);
    const two = await withdraw(contract, one.context, {
      ...VALID_WITHDRAW,
      coin: vaultCoin(AMOUNT, VAULT_TOKEN_COLOR, bytes(32, 0x31)),
    });

    expect([one.slotIndex, two.slotIndex]).toEqual([0n, 1n]);

    const index = toSignBidirectionalEventIndex(
      ledger(stateOf(two.context) as Parameters<typeof ledger>[0]).signBidirectionalEventMap,
    );

    // BOTH records landed, under two DIFFERENT ids: the map is keyed by request
    // id, so a size of 2 IS the ids differing, and neither request was lost to
    // the duplicate-id assert.
    expect(index.size).toBe(2);

    const records = [...index.values()];
    const recordA = first(records, "recorded request");
    const recordB = first(
      records.filter((candidate) => candidate !== recordA),
      "second recorded request",
    );

    // The request nonce cannot be what separates them: it is the same constant
    // in both. This is the assertion that would have hidden the bug when the
    // nonce still mirrored the slot index.
    expect([recordA.requestNonce, recordB.requestNonce]).toEqual([0n, 0n]);

    // The EVM nonce is what separates them, one per slot.
    expect(
      [recordA.txParams.nonce, recordB.txParams.nonce].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ).toEqual([EVM_NONCE_BASE, EVM_NONCE_BASE + 1n]);

    // ...and it is the ONLY difference. Normalise the EVM nonce away and the two
    // hashed events are identical, so nothing else in the payload is quietly
    // doing the separating.
    expect({ ...recordA, txParams: { ...recordA.txParams, nonce: 0n } }).toEqual({
      ...recordB,
      txParams: { ...recordB.txParams, nonce: 0n },
    });
  });

  // ---- BINDING ----

  it("BINDING: a phase-2 path whose leaf is not the key is rejected", async () => {
    const { contract, ctx } = await deployInitialised();
    const mine = await requestWithdrawOnly(contract, ctx, VALID_WITHDRAW);
    const argsB = {
      ...VALID_WITHDRAW,
      coin: vaultCoin(AMOUNT, VAULT_TOKEN_COLOR, bytes(32, 0x0d)),
    };
    const both = await requestWithdrawOnly(contract, mine.context, argsB);

    const keyA = requestKeyOf(ctx, VALID_WITHDRAW.coin.nonce);
    const keyB = requestKeyOf(ctx, argsB.coin.nonce);
    const pathB = slotPathOf(stateOf(both.context) as Parameters<typeof ledger>[0], keyB);

    // A real slot, a real root, but it proves B's position, not A's. Without
    // this bind a caller could claim any index and pick their own EVM nonce.
    await expect(contract.circuits.assignWithdraw(both.context, keyA, pathB)).rejects.toThrow(
      /Path leaf is not the request key/,
    );
  });

  it("BINDING: a path against a root the allocator never held is rejected", async () => {
    const { contract, ctx } = await deployInitialised();
    const parked = await requestWithdrawOnly(contract, ctx, VALID_WITHDRAW);
    const key = requestKeyOf(ctx, VALID_WITHDRAW.coin.nonce);
    const path = slotPathOf(stateOf(parked.context) as Parameters<typeof ledger>[0], key);

    // Flip one sibling: the recomputed root is not in the history map.
    const forged = {
      ...path,
      path: path.path.map((entry, i) =>
        i === 0 ? { ...entry, sibling: { field: entry.sibling.field + 1n } } : entry,
      ),
    };
    await expect(contract.circuits.assignWithdraw(parked.context, key, forged)).rejects.toThrow(
      /Unknown slots root/,
    );
  });

  it("BINDING: a phase-2 circuit refuses a key another flow parked", async () => {
    const { contract, ctx } = await deployInitialised();
    const parked = await requestWithdrawOnly(contract, ctx, VALID_WITHDRAW);
    const key = requestKeyOf(ctx, VALID_WITHDRAW.coin.nonce);
    const path = slotPathOf(stateOf(parked.context) as Parameters<typeof ledger>[0], key);
    await expect(contract.circuits.assignSwap(parked.context, key, path)).rejects.toThrow(
      /Wrong request kind for this key/,
    );
  });

  // ---- ANTI-REPLAY ----

  it("ANTI-REPLAY: a second phase 2 for the same request is rejected", async () => {
    const { contract, ctx } = await deployInitialised();
    const run = await withdraw(contract, ctx, VALID_WITHDRAW);
    const path = slotPathOf(stateOf(run.context) as Parameters<typeof ledger>[0], run.key);

    // The slot leaf is still in the tree (removing it would rebind an issued
    // index), and the root still checks out, so the guard that has to hold is
    // the tombstone phase 2 left on the pending entry.
    await expect(contract.circuits.assignWithdraw(run.context, run.key, path)).rejects.toThrow(
      /Wrong request kind for this key/,
    );
  });

  it("ANTI-REPLAY: an approve salt cannot be re-parked after its request settled", async () => {
    // The approves surrender no coin, so nothing outside the contract stops a
    // caller reusing a salt. Without the tombstone this would put a SECOND
    // leaf with the same value in the allocator, and the caller could then
    // present the path for either index -- one of which owns an EVM nonce the
    // MPC has already signed against.
    const { contract, ctx } = await deployInitialised();
    const settled = await approveRouter(contract, ctx);
    await expect(
      contract.circuits.requestApproveRouter(settled.context, ERC20, 1n, APPROVE_SALT),
    ).rejects.toThrow(/Request already pending/);
  });

  it("ANTI-REPLAY: a request id already recorded is rejected by the duplicate-id assert", async () => {
    // Same request, same slot, so the SAME request id: proven twice against
    // the state before either applied, the second must not record.
    const { contract, ctx } = await deployInitialised();
    const parked = await requestWithdrawOnly(contract, ctx, VALID_WITHDRAW);
    const key = requestKeyOf(ctx, VALID_WITHDRAW.coin.nonce);
    const path = slotPathOf(stateOf(parked.context) as Parameters<typeof ledger>[0], key);

    const firstAssign = await contract.circuits.assignWithdraw(parked.context, key, path);
    const secondAssign = await contract.circuits.assignWithdraw(parked.context, key, path);

    // Both proved. Only one can apply.
    expect(replay(stateOf(firstAssign.context), secondAssign, true)).toMatch(/^REJECTED/);

    // And the id the first one recorded is the one the map holds.
    const recorded = soleRequestId(stateOf(firstAssign.context), "signBidirectionalEventMap");
    expect(recorded).toHaveLength(32);
  });

  it("ANTI-REPLAY GUARD (must stay green): a caller's identical repeat gets a fresh id", async () => {
    const { contract, ctx } = await deployInitialised();
    const idsOf = (c: CircuitContext<VaultPrivateState>): string[] => [
      ...toSignBidirectionalEventIndex(
        ledger(c.callContext.currentQueryContext.state).depositEventMap,
      ).keys(),
    ];
    const afterFirst = (await deposit(contract, ctx, VALID_DEPOSIT)).context;
    const before = idsOf(afterFirst);
    const afterSecond = (await deposit(contract, afterFirst, VALID_DEPOSIT)).context;
    const fresh = idsOf(afterSecond).filter((k) => !before.includes(k));
    expect(fresh.length).toBe(1);
    expect(before).not.toContain(fresh[0]);
  });
});

// ===========================================================================
// Admin-updateable gas parameters
//
// Every VAULT-signed transaction (approve*, withdraw, swap, supply, redeem)
// used to carry a hardcoded 30 gwei maxFeePerGas. maxFeePerGas is a CEILING,
// not a price: under EIP-1559 you pay base fee + tip and are refunded the
// difference, so a high cap costs nothing while the market is calm. A 30 gwei
// cap instead means every vault transaction becomes unincludable the moment
// the base fee crosses 30 gwei, and because the vault signs against one
// sequential EVM nonce, the stalled transaction blocks every transaction
// queued behind it. These tests pin the fee envelope as ledger state a
// deployer can move, and pin which gas limit belongs to which kind.
//
// startDeposit is deliberately excluded: it is signed by the USER's own
// derived EVM account and already takes all three parameters as arguments.
// ===========================================================================

/** The initialise-time defaults, mirrored from erc20-vault.compact. */
const DEFAULT_MAX_FEE_PER_GAS = 150_000_000_000n; // 150 gwei
const DEFAULT_MAX_PRIORITY_FEE_PER_GAS = 1_000_000_000n; // 1 gwei
const DEFAULT_WITHDRAW_GAS_LIMIT = 100_000n;
const DEFAULT_APPROVE_GAS_LIMIT = 100_000n;
const DEFAULT_SWAP_GAS_LIMIT = 700_000n;
const DEFAULT_SUPPLY_GAS_LIMIT = 500_000n;
const DEFAULT_REDEEM_GAS_LIMIT = 500_000n;

// Deliberately distinct from each other AND from every default, so a circuit
// reading the wrong ledger cell cannot pass by coincidence.
const NEW_MAX_FEE_PER_GAS = 750_000_000_000n;
const NEW_MAX_PRIORITY_FEE_PER_GAS = 3_000_000_000n;
const NEW_WITHDRAW_GAS_LIMIT = 111_000n;
const NEW_APPROVE_GAS_LIMIT = 122_000n;
const NEW_SWAP_GAS_LIMIT = 733_000n;
const NEW_SUPPLY_GAS_LIMIT = 544_000n;
const NEW_REDEEM_GAS_LIMIT = 555_000n;

interface GasParamArgs {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  withdrawGasLimit: bigint;
  approveGasLimit: bigint;
  swapGasLimit: bigint;
  supplyGasLimit: bigint;
  redeemGasLimit: bigint;
}

const NEW_GAS_PARAMS: GasParamArgs = {
  maxFeePerGas: NEW_MAX_FEE_PER_GAS,
  maxPriorityFeePerGas: NEW_MAX_PRIORITY_FEE_PER_GAS,
  withdrawGasLimit: NEW_WITHDRAW_GAS_LIMIT,
  approveGasLimit: NEW_APPROVE_GAS_LIMIT,
  swapGasLimit: NEW_SWAP_GAS_LIMIT,
  supplyGasLimit: NEW_SUPPLY_GAS_LIMIT,
  redeemGasLimit: NEW_REDEEM_GAS_LIMIT,
};

/** Call setGasParams with its flat args spread in circuit order. */
const setGasParams = (
  contract: Contract<VaultPrivateState>,
  ctx: Parameters<Contract<VaultPrivateState>["circuits"]["setGasParams"]>[0],
  args: GasParamArgs,
) =>
  contract.circuits.setGasParams(
    ctx,
    args.maxFeePerGas,
    args.maxPriorityFeePerGas,
    args.withdrawGasLimit,
    args.approveGasLimit,
    args.swapGasLimit,
    args.supplyGasLimit,
    args.redeemGasLimit,
  );

/**
 * The fee/gas envelope the vault stamped on the ONE request recorded in `map`,
 * failing when the map does not hold exactly one.
 */
const envelopeOf = (
  map: Parameters<typeof toSignBidirectionalEventIndex>[0],
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gasLimit: bigint } => {
  const index = toSignBidirectionalEventIndex(map);
  expect(index.size).toBe(1);
  const { txParams } = first(index.values(), "recorded request");
  return {
    maxFeePerGas: txParams.maxFeePerGas,
    maxPriorityFeePerGas: txParams.maxPriorityFeePerGas,
    gasLimit: txParams.gasLimit,
  };
};

describe("gas parameters: initialise defaults", () => {
  it("stores a fee ceiling and a gas limit per kind", async () => {
    const { ctx } = await deployInitialised();
    const state = ledger(ctx.callContext.currentQueryContext.state);

    expect(state.vaultMaxFeePerGas).toBe(DEFAULT_MAX_FEE_PER_GAS);
    expect(state.vaultMaxPriorityFeePerGas).toBe(DEFAULT_MAX_PRIORITY_FEE_PER_GAS);
    expect(state.vaultGasLimits.withdraw).toBe(DEFAULT_WITHDRAW_GAS_LIMIT);
    expect(state.vaultGasLimits.approve).toBe(DEFAULT_APPROVE_GAS_LIMIT);
    expect(state.vaultGasLimits.swap).toBe(DEFAULT_SWAP_GAS_LIMIT);
    expect(state.vaultGasLimits.supply).toBe(DEFAULT_SUPPLY_GAS_LIMIT);
    expect(state.vaultGasLimits.redeem).toBe(DEFAULT_REDEEM_GAS_LIMIT);
  });

  it("the default cap clears the highest base fee of the last year", async () => {
    // L1 runs at single-digit gwei day to day and spikes a little past 100 during
    // major launches, so 150 clears the year without the vault stalling in
    // conditions an operator should not have to watch. Anything rarer than that
    // is what the setter is for.
    const { ctx } = await deployInitialised();
    const state = ledger(ctx.callContext.currentQueryContext.state);

    expect(state.vaultMaxFeePerGas).toBeGreaterThan(100_000_000_000n);
    // A cap is only ever paid in full during a genuine spike, so it also
    // bounds the worst case: cap * the largest gas limit (the swap).
    expect(state.vaultMaxFeePerGas * state.vaultGasLimits.swap).toBeLessThan(10n ** 18n);
  });

  it("the cap is at or above the tip, as EIP-1559 requires", async () => {
    const { ctx } = await deployInitialised();
    const state = ledger(ctx.callContext.currentQueryContext.state);

    expect(state.vaultMaxFeePerGas).toBeGreaterThanOrEqual(state.vaultMaxPriorityFeePerGas);
  });
});

describe("setGasParams", () => {
  it("is deployer-gated", async () => {
    const { contract, ctx } = await deployInitialised();
    const stranger = await strangerContext("setGasParams", ctx);

    await expect(setGasParams(contract, stranger, NEW_GAS_PARAMS)).rejects.toThrow(
      /Not the deployer/,
    );
  });

  it("leaves the stored values untouched when a non-deployer is rejected", async () => {
    const { contract, ctx } = await deployInitialised();
    const stranger = await strangerContext("setGasParams", ctx);

    await expect(setGasParams(contract, stranger, NEW_GAS_PARAMS)).rejects.toThrow();

    const state = ledger(ctx.callContext.currentQueryContext.state);
    expect(state.vaultMaxFeePerGas).toBe(DEFAULT_MAX_FEE_PER_GAS);
    expect(state.vaultGasLimits.swap).toBe(DEFAULT_SWAP_GAS_LIMIT);
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();

    await expect(setGasParams(contract, ctx, NEW_GAS_PARAMS)).rejects.toThrow(/Not initialised/);
  });

  it("the deployer updates every value", async () => {
    const { contract, ctx } = await deployInitialised();

    const next = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;
    const state = ledger(next.callContext.currentQueryContext.state);

    expect(state.vaultMaxFeePerGas).toBe(NEW_MAX_FEE_PER_GAS);
    expect(state.vaultMaxPriorityFeePerGas).toBe(NEW_MAX_PRIORITY_FEE_PER_GAS);
    expect(state.vaultGasLimits.withdraw).toBe(NEW_WITHDRAW_GAS_LIMIT);
    expect(state.vaultGasLimits.approve).toBe(NEW_APPROVE_GAS_LIMIT);
    expect(state.vaultGasLimits.swap).toBe(NEW_SWAP_GAS_LIMIT);
    expect(state.vaultGasLimits.supply).toBe(NEW_SUPPLY_GAS_LIMIT);
    expect(state.vaultGasLimits.redeem).toBe(NEW_REDEEM_GAS_LIMIT);
  });

  it("is repeatable: the fee envelope tracks the market, unlike one-shot initialise", async () => {
    const { contract, ctx } = await deployInitialised();

    const once = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;
    const twice = (
      await setGasParams(contract, once, { ...NEW_GAS_PARAMS, maxFeePerGas: 900_000_000_000n })
    ).context;

    expect(ledger(twice.callContext.currentQueryContext.state).vaultMaxFeePerGas).toBe(
      900_000_000_000n,
    );
  });

  it.each([
    ["a zero withdraw gas limit", { withdrawGasLimit: 0n }, /Gas limit must be positive/],
    ["a zero approve gas limit", { approveGasLimit: 0n }, /Gas limit must be positive/],
    ["a zero swap gas limit", { swapGasLimit: 0n }, /Gas limit must be positive/],
    ["a zero supply gas limit", { supplyGasLimit: 0n }, /Gas limit must be positive/],
    ["a zero redeem gas limit", { redeemGasLimit: 0n }, /Gas limit must be positive/],
    ["a zero fee cap", { maxFeePerGas: 0n }, /maxFeePerGas must be positive/],
    [
      "a tip above the cap",
      { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n },
      /maxPriorityFeePerGas cannot exceed maxFeePerGas/,
    ],
  ] as const)("rejects %s", async (_name, delta, throws) => {
    const { contract, ctx } = await deployInitialised();

    await expect(setGasParams(contract, ctx, { ...NEW_GAS_PARAMS, ...delta })).rejects.toThrow(
      throws,
    );
  });
});

describe("gas parameters reach the constructed transaction", () => {
  it("withdraw carries the updated fee envelope and the WITHDRAW gas limit", async () => {
    const { contract, ctx } = await deployInitialised();
    const configured = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;

    const next = (await withdraw(contract, configured, VALID_WITHDRAW)).context;

    expect(
      envelopeOf(ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap),
    ).toEqual({
      maxFeePerGas: NEW_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: NEW_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: NEW_WITHDRAW_GAS_LIMIT,
    });
  });

  it("approveRouter carries the APPROVE gas limit", async () => {
    const { contract, ctx } = await deployInitialised();
    const configured = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;

    const next = (await approveRouter(contract, configured)).context;

    expect(
      envelopeOf(ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap),
    ).toEqual({
      maxFeePerGas: NEW_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: NEW_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: NEW_APPROVE_GAS_LIMIT,
    });
  });

  it("approveStata carries the APPROVE gas limit", async () => {
    const { contract, ctx } = await deployInitialised();
    const configured = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;

    const next = (await approveStata(contract, configured)).context;

    expect(
      envelopeOf(ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap),
    ).toEqual({
      maxFeePerGas: NEW_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: NEW_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: NEW_APPROVE_GAS_LIMIT,
    });
  });

  it("swap carries the SWAP gas limit", async () => {
    const { contract, ctx } = await deployInitialised();
    const configured = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;

    const next = (await swap(contract, configured, VALID_SWAP)).context;

    expect(envelopeOf(ledger(next.callContext.currentQueryContext.state).swapEventMap)).toEqual({
      maxFeePerGas: NEW_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: NEW_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: NEW_SWAP_GAS_LIMIT,
    });
  });

  it("supply carries the SUPPLY gas limit", async () => {
    const { contract, ctx } = await deployInitialised();
    const configured = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;

    const next = (
      await supply(
        contract,
        configured,
        SUPPLY_AMOUNT,
        vaultCoin(SUPPLY_AMOUNT, STATA_UNDERLYING_COLOR),
      )
    ).context;

    expect(envelopeOf(ledger(next.callContext.currentQueryContext.state).supplyEventMap)).toEqual({
      maxFeePerGas: NEW_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: NEW_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: NEW_SUPPLY_GAS_LIMIT,
    });
  });

  it("redeem carries the REDEEM gas limit", async () => {
    const { contract, ctx } = await deployInitialised();
    const configured = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;

    const next = (
      await redeem(contract, configured, REDEEM_SHARES, vaultCoin(REDEEM_SHARES, STATA_COLOR))
    ).context;

    expect(envelopeOf(ledger(next.callContext.currentQueryContext.state).redeemEventMap)).toEqual({
      maxFeePerGas: NEW_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: NEW_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: NEW_REDEEM_GAS_LIMIT,
    });
  });

  it("the five kinds get FIVE different gas limits off one setGasParams call", async () => {
    // The whole point of per-kind limits: one call, five distinct values, each
    // landing on its own kind. A single shared cell would collapse these.
    const { contract, ctx } = await deployInitialised();
    const configured = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;

    const stateOf = (c: typeof configured) => ledger(c.callContext.currentQueryContext.state);

    const afterWithdraw = (await withdraw(contract, configured, VALID_WITHDRAW)).context;
    const afterSwap = (await swap(contract, configured, VALID_SWAP)).context;
    const afterApprove = (await approveRouter(contract, configured)).context;
    const afterSupply = (
      await supply(
        contract,
        configured,
        SUPPLY_AMOUNT,
        vaultCoin(SUPPLY_AMOUNT, STATA_UNDERLYING_COLOR),
      )
    ).context;
    const afterRedeem = (
      await redeem(contract, configured, REDEEM_SHARES, vaultCoin(REDEEM_SHARES, STATA_COLOR))
    ).context;

    expect({
      withdraw: envelopeOf(stateOf(afterWithdraw).signBidirectionalEventMap).gasLimit,
      approve: envelopeOf(stateOf(afterApprove).signBidirectionalEventMap).gasLimit,
      swap: envelopeOf(stateOf(afterSwap).swapEventMap).gasLimit,
      supply: envelopeOf(stateOf(afterSupply).supplyEventMap).gasLimit,
      redeem: envelopeOf(stateOf(afterRedeem).redeemEventMap).gasLimit,
    }).toEqual({
      withdraw: NEW_WITHDRAW_GAS_LIMIT,
      approve: NEW_APPROVE_GAS_LIMIT,
      swap: NEW_SWAP_GAS_LIMIT,
      supply: NEW_SUPPLY_GAS_LIMIT,
      redeem: NEW_REDEEM_GAS_LIMIT,
    });
  });

  it("startDeposit is UNAFFECTED: it still stamps the CALLER's own gas arguments", async () => {
    // A deposit's transaction is signed by the user's own derived EVM account
    // and pays out of it, so its envelope stays a caller argument. Configure
    // the vault's ledger values to something else entirely and check none of
    // them leak into the deposit.
    const { contract, ctx } = await deployInitialised();
    const configured = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;

    const next = (await deposit(contract, configured, VALID_DEPOSIT)).context;

    expect(envelopeOf(ledger(next.callContext.currentQueryContext.state).depositEventMap)).toEqual({
      maxFeePerGas: VALID_DEPOSIT.maxFeePerGas,
      maxPriorityFeePerGas: VALID_DEPOSIT.maxPriorityFeePerGas,
      gasLimit: VALID_DEPOSIT.gasLimit,
    });
  });
});

// ===========================================================================
// adminReplaceEvmNonce: break-glass replacement of a stuck vault transaction
//
// Raising the ceiling with setGasParams does not rescue a transaction the
// vault already signed under the old one: the old maxFeePerGas is inside the
// signed bytes. Because the vault signs from ONE EVM account with a single
// sequential nonce, that transaction blocks every later one forever. The
// Ethereum remedy is replacement — another transaction at the SAME nonce
// paying meaningfully more — and its minimal form is an empty self-transfer.
//
// These tests pin the three things that make the replacement valid: the nonce
// is the caller's, the transaction is empty (self, zero value, no calldata,
// 21000 gas), and the fees come from the ledger the admin just raised.
// ===========================================================================

/**
 * The EVM nonce these tests name as the stuck one: EVM_NONCE_BASE itself, so it
 * is the nonce allocator slot 0 owns. The circuit refuses a nonce the allocator
 * has not issued, so this is only replaceable after {@link stranded} has run a
 * real request through both phases.
 */
const STUCK_NONCE = EVM_NONCE_BASE;

/**
 * Arrange one genuinely stuck nonce: deploy, initialise, and run a real
 * withdraw through both allocator phases, so slot 0 — and with it
 * EVM_NONCE_BASE — has actually been issued.
 *
 * @returns The contract, the context after phase 2, and the issued nonce.
 */
const stranded = async (): Promise<{
  contract: Contract<VaultPrivateState>;
  ctx: CircuitContext<VaultPrivateState>;
  stuckNonce: bigint;
}> => {
  const { contract, ctx } = await deployInitialised();
  const run = await withdraw(contract, ctx, VALID_WITHDRAW);
  return { contract, ctx: run.context, stuckNonce: EVM_NONCE_BASE + run.slotIndex };
};

/** The exact gas an EVM value transfer carrying no calldata costs. */
const REPLACEMENT_GAS_LIMIT = 21_000n;

/**
 * The fee/gas envelope of the REPLACEMENT the admin circuit recorded, picked
 * out of the shared map by the 21000-gas limit only an empty self-transfer
 * carries. The stranded request it replaces sits in the same map at the SAME
 * EVM nonce — that is what a replacement is — so the nonce cannot tell the two
 * apart.
 */
const replacementEnvelopeOf = (
  map: Parameters<typeof toSignBidirectionalEventIndex>[0],
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gasLimit: bigint } => {
  const replacements = [...toSignBidirectionalEventIndex(map).values()].filter(
    (record) => record.txParams.gasLimit === REPLACEMENT_GAS_LIMIT,
  );
  expect(replacements).toHaveLength(1);
  const { txParams } = first(replacements, "recorded replacement request");
  return {
    maxFeePerGas: txParams.maxFeePerGas,
    maxPriorityFeePerGas: txParams.maxPriorityFeePerGas,
    gasLimit: txParams.gasLimit,
  };
};

describe("adminReplaceEvmNonce", () => {
  it("is deployer-gated, with initialise's own gate", async () => {
    const { contract, ctx } = await deployInitialised();
    const stranger = await strangerContext("adminReplaceEvmNonce", ctx);

    await expect(contract.circuits.adminReplaceEvmNonce(stranger, STUCK_NONCE, 1n)).rejects.toThrow(
      /Not the deployer/,
    );
  });

  it("records nothing when a non-deployer is rejected", async () => {
    const { contract, ctx } = await deployInitialised();
    const stranger = await strangerContext("adminReplaceEvmNonce", ctx);

    await expect(
      contract.circuits.adminReplaceEvmNonce(stranger, STUCK_NONCE, 1n),
    ).rejects.toThrow();

    expect(
      toSignBidirectionalEventIndex(
        ledger(ctx.callContext.currentQueryContext.state).signBidirectionalEventMap,
      ).size,
    ).toBe(0);
  });

  it("builds an empty 21000-gas self-transfer at the nonce the caller named", async () => {
    const { contract, ctx, stuckNonce } = await stranded();

    const next = (await contract.circuits.adminReplaceEvmNonce(ctx, stuckNonce, 1n)).context;

    const index = toSignBidirectionalEventIndex(
      ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap,
    );
    // The stranded withdraw's own record, plus the replacement.
    expect(index.size).toBe(2);
    const record = first(
      [...index.values()].filter(
        (candidate) => candidate.txParams.gasLimit === REPLACEMENT_GAS_LIMIT,
      ),
      "recorded replacement request",
    );
    const { txParams } = record;

    expect({
      path: record.path,
      nonce: txParams.nonce,
      to: txParams.to,
      value: txParams.value,
      gasLimit: txParams.gasLimit,
      calldataPresent: txParams.calldata.is_some,
      data: assembleCalldata(txParams.calldata),
      accessListEntryCount: txParams.accessListEntryCount,
    }).toEqual({
      // Signed with the VAULT account, the account whose nonce is stuck.
      path: asciiPadded("vault", 32),
      // The caller names the stuck nonce; replacing it is the entire point.
      nonce: STUCK_NONCE,
      // The vault sends to ITSELF, so the replacement moves no value anywhere.
      to: VAULT_EVM,
      value: 0n,
      // The exact cost of an EVM value transfer carrying no calldata.
      gasLimit: REPLACEMENT_GAS_LIMIT,
      // Empty calldata, reusing the shared map's 2-word capacity unused.
      calldataPresent: false,
      data: "0x",
      accessListEntryCount: 0n,
    });
  });

  it("takes its fee values from the ledger, defaulting to initialise's", async () => {
    const { contract, ctx, stuckNonce } = await stranded();

    const next = (await contract.circuits.adminReplaceEvmNonce(ctx, stuckNonce, 1n)).context;

    expect(
      replacementEnvelopeOf(
        ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap,
      ),
    ).toEqual({
      maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: REPLACEMENT_GAS_LIMIT,
    });
  });

  it("reflects a prior setGasParams, which is why the admin raises the fees FIRST", async () => {
    // A replacement only evicts the stuck transaction if it pays meaningfully
    // more than it (nodes typically demand about 10% more on both fee fields),
    // and this circuit reads its fees from the ledger. So the operator raises
    // them with setGasParams and only then calls this; if the raise did not
    // reach the transaction, the replacement would re-offer the very fees that
    // got the original stuck and the node would drop it.
    const { contract, ctx, stuckNonce } = await stranded();
    const configured = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;

    const next = (await contract.circuits.adminReplaceEvmNonce(configured, stuckNonce, 1n)).context;

    expect(
      replacementEnvelopeOf(
        ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap,
      ),
    ).toEqual({
      maxFeePerGas: NEW_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: NEW_MAX_PRIORITY_FEE_PER_GAS,
      // The gas limit is a property of the operation, never of the market, so
      // the per-kind limits setGasParams moved leave this one at 21000.
      gasLimit: REPLACEMENT_GAS_LIMIT,
    });
  });

  // ---- The issuance bound ----
  //
  // The circuit takes the nonce as an argument, so without a bound the admin
  // could burn a nonce the allocator has NOT handed out yet. The allocator
  // would hand that same nonce to a real request later, and the network would
  // reject its signed transaction as a reused nonce: the exact stall this
  // circuit exists to clear, caused by the tool meant to clear it. The bound
  // is issuedSlots, the count of slots issued.

  it("rejects a nonce the allocator has not issued yet", async () => {
    // Nothing has run either allocator phase, so NO nonce has been issued and
    // even slot 0's is out of bounds.
    const { contract, ctx } = await deployInitialised();

    await expect(contract.circuits.adminReplaceEvmNonce(ctx, EVM_NONCE_BASE, 1n)).rejects.toThrow(
      /Nonce not issued yet/,
    );
  });

  it("rejects the nonce one past the last issued one", async () => {
    // The off-by-one that matters: one slot issued means one nonce replaceable.
    const { contract, ctx, stuckNonce } = await stranded();

    await expect(contract.circuits.adminReplaceEvmNonce(ctx, stuckNonce + 1n, 1n)).rejects.toThrow(
      /Nonce not issued yet/,
    );
  });

  it("accepts every nonce below the issued count", async () => {
    // Three slots issued across two different flows, so nonces base..base+2
    // are all replaceable — not just the most recent one, because any of them
    // can be the stuck one.
    const { contract, ctx } = await deployInitialised();
    const first0 = await withdraw(contract, ctx, VALID_WITHDRAW);
    const second = await withdraw(contract, first0.context, {
      ...VALID_WITHDRAW,
      coin: vaultCoin(AMOUNT, VAULT_TOKEN_COLOR, bytes(32, 0x21)),
    });
    const third = await swap(contract, second.context, {
      ...VALID_SWAP,
      coin: vaultCoin(SWAP_AMOUNT_IN_MAX, VAULT_TOKEN_COLOR, bytes(32, 0x22)),
    });

    expect([first0.slotIndex, second.slotIndex, third.slotIndex]).toEqual([0n, 1n, 2n]);
    for (const index of [0n, 1n, 2n]) {
      await expect(
        contract.circuits.adminReplaceEvmNonce(third.context, EVM_NONCE_BASE + index, 1n),
      ).resolves.toBeDefined();
    }
  });

  it("the issued count tracks assign* calls, and only assign* calls", async () => {
    // What the bound is made of. Phase 1 alone issues nothing: the slot index
    // is not decided until phase 2 proves it, so parking must not advance the
    // count. A replacement issues nothing either — bumping it there would
    // raise the bound by one and let the NEXT admin call name an unissued
    // nonce.
    const { contract, ctx } = await deployInitialised();
    const issuedIn = (c: CircuitContext<VaultPrivateState>): bigint =>
      ledger(c.callContext.currentQueryContext.state).issuedSlots;

    expect(issuedIn(ctx)).toBe(0n);

    const parked = await requestWithdrawOnly(contract, ctx, VALID_WITHDRAW);
    expect(issuedIn(parked.context)).toBe(0n);

    const key = requestKeyOf(ctx, VALID_WITHDRAW.coin.nonce);
    const path = slotPathOf(parked.context.callContext.currentQueryContext.state, key);
    const assigned = await contract.circuits.assignWithdraw(parked.context, key, path);
    expect(issuedIn(assigned.context)).toBe(1n);

    const approved = await approveRouter(contract, assigned.context);
    expect(issuedIn(approved.context)).toBe(2n);

    const replaced = await contract.circuits.adminReplaceEvmNonce(
      approved.context,
      EVM_NONCE_BASE,
      1n,
    );
    expect(issuedIn(replaced.context)).toBe(2n);
  });

  it("bounds the count and nothing else: a repeat the moved count used to let through is now refused", async () => {
    // The counter is the issuance BOUND and is not this event's request nonce:
    // that is the constant 0 every vault-signed flow passes. The difference is
    // observable exactly here. Two replacements at the same nonce for the same
    // fees are the same request, but the count between them used to move, so
    // salting the id with it used to give the repeat a different id and record
    // it twice.
    const { contract, ctx, stuckNonce } = await stranded();
    const replaced = (await contract.circuits.adminReplaceEvmNonce(ctx, stuckNonce, 1n)).context;

    // A real request issues a slot in between, moving issuedSlots.
    const meanwhile = await withdraw(contract, replaced, {
      ...VALID_WITHDRAW,
      coin: vaultCoin(AMOUNT, VAULT_TOKEN_COLOR, bytes(32, 0x41)),
    });

    // Refusing this is right, not a lost capability: the MPC would sign the very
    // same transaction bytes, and a node drops an identically-priced replacement
    // of a transaction it already holds.
    await expect(
      contract.circuits.adminReplaceEvmNonce(meanwhile.context, stuckNonce, 1n),
    ).rejects.toThrow(/Request already exists/);

    // A genuine re-send raises the fees first -- which is what a node demands
    // before it will evict anyway -- and the envelope is hashed, so the re-send
    // lands under a fresh id.
    const raised = (await setGasParams(contract, meanwhile.context, NEW_GAS_PARAMS)).context;
    const resent = (await contract.circuits.adminReplaceEvmNonce(raised, stuckNonce, 1n)).context;

    // The stranded withdraw, the first replacement, the interleaved withdraw,
    // and the re-send.
    expect(
      toSignBidirectionalEventIndex(
        ledger(resent.callContext.currentQueryContext.state).signBidirectionalEventMap,
      ).size,
    ).toBe(4);
  });
});

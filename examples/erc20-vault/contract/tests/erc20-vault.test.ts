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
  MPCDestination,
  MPCSignatureAlgorithm,
  numericAbiWord,
  OutputKind,
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
import { attestRespondBidirectional, secp256k1PublicKeyOf } from "@sig-net/midnight/testing";
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
  assignedNonce,
  Contract,
  createVaultPrivateState,
  type DeployedVaultContract,
  FLUSH_WIDTH,
  flushPending,
  flushUntilStamped,
  ledger,
  padKeys,
  pureCircuits,
  seenRequestIds,
  stampOf,
  unstampedKeys,
  VAULT_DEPOSIT_REQUESTS_PATH,
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
const EVM_START_HEIGHT = 100n;
const MPC_KEY_VERSION = 1n;
const ATTESTED_HEIGHT = 101n;

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

// The EIP-155 chain id initialise() pins (Sepolia's).
const CHAIN_ID = 11155111n;

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
  signatureDest: MPCDestination.unused,
  params: new Uint8Array(64),
  executionDest: signetCircuits.ethereumCaip2Id(),
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
 * Deploy + initialise(VAULT_EVM, CHAIN_ID, MPC_RESPONSE_KEY) as
 * the deployer: the ready-to-use vault, with the MPC response key stored.
 */

// A deterministic queue key per surrendered coin, in place of the random key a
// client draws: the tests only need each request under its own key.
const keyForCoin = (coin: { nonce: Uint8Array }): Uint8Array => coin.nonce;

const flushOne = async (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  key: Uint8Array,
): Promise<CircuitContext<VaultPrivateState>> =>
  (await contract.circuits.flush(ctx, padKeys([key]), padKeys([]))).context;

const approveStata = async (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
): Promise<CircuitResults<VaultPrivateState, []>> => {
  const key = pureCircuits.approveStataBinder();
  const queued = (await contract.circuits.approveStata(ctx)).context;
  return contract.circuits.sendApproveStata(await flushOne(contract, queued, key), key);
};

const approveRouter = async (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  erc20: Uint8Array,
): Promise<CircuitResults<VaultPrivateState, []>> => {
  const key = pureCircuits.approveRouterBinder(erc20);
  const queued = (await contract.circuits.approveRouter(ctx, erc20)).context;
  return contract.circuits.sendApproveRouter(await flushOne(contract, queued, key), key);
};

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
      MPC_RESPONSE_KEY,
      MPC_KEY_VERSION,
      EVM_START_HEIGHT,
    )
  ).context;
  return { contract, ctx: next };
};

/** Call deposit with its flat args spread in circuit order. */
const queueDeposit = (
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
    args.deposit,
  );

const secretOf = (ctx: CircuitContext<VaultPrivateState>): Uint8Array => {
  const secretKey = ctx.callContext.currentPrivateState?.secretKey;
  if (!secretKey) {
    throw new Error("expected a caller secret key on the circuit context");
  }
  return secretKey;
};

const depositKey = (ctx: CircuitContext<VaultPrivateState>, evmNonce: bigint): Uint8Array =>
  pureCircuits.refundCommitment(secretOf(ctx), pureCircuits.depositBinder(evmNonce));

const deposit = async (
  contract: Contract<VaultPrivateState>,
  ctx: Parameters<Contract<VaultPrivateState>["circuits"]["startDeposit"]>[0],
  args: DepositCallArgs,
) => {
  const key = depositKey(ctx, args.evmNonce);
  const queued = (await queueDeposit(contract, ctx, args)).context;
  return contract.circuits.sendDeposit(await flushOne(contract, queued, key), key);
};

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

    const { requestsIndex } = readSignetRequestsLedgerFromState(rawState, VAULT_REQUESTS_PATH);
    const typedIndex = toSignBidirectionalEventIndex(
      ledger(ctx.callContext.currentQueryContext.state).signBidirectionalEventMap,
    );
    expect(requestsIndex).toEqual(typedIndex);
    expect(requestsIndex.size).toBe(0);
  });
});

describe("userCommitment", () => {
  it("check 32-byte commitments computed off-chain via the compiled circuit", () => {
    expect(DEPLOYER_COMMITMENT).toHaveLength(32);
    expect(DEPLOYER_COMMITMENT).not.toEqual(new Uint8Array(32));
    expect(DEPLOYER_COMMITMENT).not.toEqual(OTHER_COMMITMENT);
  });
});

describe("refundCommitment", () => {
  it("is domain-separated from userCommitment and unique per secret AND per request id", () => {
    const requestIdA = bytes(32, 0x01);
    const requestIdB = bytes(32, 0x02);
    const commitment = pureCircuits.refundCommitment(SECRET_KEY, requestIdA);
    expect(commitment).toHaveLength(32);
    // Never the deposit-identity commitment: THAT one is public on the ledger
    // as the deposit's derivation path, so equality would link withdraw to
    // deposit.
    expect(commitment).not.toEqual(pureCircuits.userCommitment(SECRET_KEY));
    // Bound to the request id: two withdrawals by the same secret differ.
    expect(commitment).not.toEqual(pureCircuits.refundCommitment(SECRET_KEY, requestIdB));
    // And bound to the secret: another identity's commitment differs.
    expect(commitment).not.toEqual(pureCircuits.refundCommitment(OTHER_SECRET_KEY, requestIdA));
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
        MPC_RESPONSE_KEY,
        MPC_KEY_VERSION,
        EVM_START_HEIGHT,
      ),
    ).rejects.toThrow(/Not the deployer/);
  });

  it("rejects key version 0", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.initialise(
        ctx,
        VAULT_EVM,
        ROUTER,
        STATA_UNDERLYING,
        STATA_TOKEN,
        CHAIN_ID,
        MPC_RESPONSE_KEY,
        0n,
        EVM_START_HEIGHT,
      ),
    ).rejects.toThrow(/keyVersion must be >= 1/);
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
        MPC_RESPONSE_KEY,
        MPC_KEY_VERSION,
        EVM_START_HEIGHT,
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
        MPC_RESPONSE_KEY,
        MPC_KEY_VERSION,
        EVM_START_HEIGHT,
      ),
    ).rejects.toThrow(/Chain ID must be positive/);
  });

  it("stores the vault EVM address, the chain id and the MPC response key", async () => {
    const { ctx } = await deployInitialised();
    const state = ledger(ctx.callContext.currentQueryContext.state);
    expect(state.initialised).toBe(1n);
    expect(state.vaultEvmAddress).toEqual(VAULT_EVM);
    expect(state.uniswapRouter).toEqual(ROUTER);
    expect(state.evmChainId).toBe(CHAIN_ID);
    expect(state.mpcResponseKey).toEqual(MPC_RESPONSE_KEY);
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
    const rawLedger = readSignetRequestsLedgerFromState(state, VAULT_DEPOSIT_REQUESTS_PATH);

    expect(typedIndex.size).toBe(1);
    expect(rawLedger.requestsIndex).toEqual(typedIndex);

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
    expect(record.executionDest).toEqual(EXPECTED_ROUTING.executionDest);
    expect(record.keyVersion).toBe(MPC_KEY_VERSION);
    expect(record.algo).toBe(EXPECTED_ROUTING.algo);
    expect(record.signatureDest).toBe(EXPECTED_ROUTING.signatureDest);
    expect(record.params).toEqual(EXPECTED_ROUTING.params);
    expect(record.txParamType).toBe(TxParamType.evmType2);
    expect(record.outputDeserializationSchema).toEqual(
      EXPECTED_ROUTING.outputDeserializationSchema,
    );
    expect(record.respondSerializationSchema).toEqual(EXPECTED_ROUTING.respondSerializationSchema);

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
      knownHeight: EVM_START_HEIGHT,
    });
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

  it("an identical repeat names the same transaction and is refused while the first is outstanding", async () => {
    const { contract, ctx } = await deployInitialised();

    const afterFirst = (await deposit(contract, ctx, VALID_DEPOSIT)).context;
    await expect(deposit(contract, afterFirst, VALID_DEPOSIT)).rejects.toThrow(
      /Request already exists/,
    );
  });

  it("the SAME caller depositing twice with different EVM nonces gets two ids", async () => {
    const { contract, ctx } = await deployInitialised();

    const afterFirst = (await deposit(contract, ctx, VALID_DEPOSIT)).context;
    const afterSecond = (
      await deposit(contract, afterFirst, {
        ...VALID_DEPOSIT,
        evmNonce: VALID_DEPOSIT.evmNonce + 1n,
      })
    ).context;
    const state = ledger(afterSecond.callContext.currentQueryContext.state);

    const index = toSignBidirectionalEventIndex(state.depositEventMap);
    expect(index.size).toBe(2);
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
 * The `startWithdraw` circuit's flat arguments, in circuit order. The compact
 * compiler inlines the `WithdrawRequest` struct type anonymously into the
 * generated circuit signature, and this interface's `withdraw` member matches
 * that anonymous type structurally.
 */
interface WithdrawCallArgs {
  evmNonce: bigint;
  withdraw: { erc20Address: Uint8Array; amount: bigint; destEvmAddress: Uint8Array };
  coin: ReturnType<typeof vaultCoin>;
}

/**
 * Known-good withdraw call args, the base every test varies from.
 * Shared across tests: NEVER mutate; build a variation as an explicit spread.
 */
const VALID_WITHDRAW: WithdrawCallArgs = {
  evmNonce: 0n,
  withdraw: { erc20Address: ERC20, amount: AMOUNT, destEvmAddress: DEST_EVM },
  coin: vaultCoin(AMOUNT),
};

/** Call withdraw with its flat args spread in circuit order. */
const withdraw = async (
  contract: Contract<VaultPrivateState>,
  ctx: Parameters<Contract<VaultPrivateState>["circuits"]["startWithdraw"]>[0],
  args: WithdrawCallArgs,
) => {
  const key = keyForCoin(args.coin);
  const queued = (await contract.circuits.startWithdraw(ctx, args.withdraw, args.coin, key))
    .context;
  return contract.circuits.sendWithdraw(await flushOne(contract, queued, key), key);
};

// ---- Withdraw tests ----

describe("withdraw round-trip", () => {
  it("burns the coin and stores a vault-path event with a contract-fixed envelope", async () => {
    const { contract, ctx } = await deployInitialised();

    const { context: next } = await withdraw(contract, ctx, VALID_WITHDRAW);
    const state = next.callContext.currentQueryContext.state;

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
    const { calldata, ...envelope } = record.txParams;
    expect(envelope).toEqual({
      to: ERC20,
      chainId: CHAIN_ID,
      nonce: VALID_WITHDRAW.evmNonce,
      gasLimit: 100_000n,
      maxFeePerGas: 150_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
    });

    // Contract-fixed routing, same constants as deposits.
    expect(record.executionDest).toEqual(EXPECTED_ROUTING.executionDest);
    expect(record.keyVersion).toBe(MPC_KEY_VERSION);
    expect(record.algo).toBe(EXPECTED_ROUTING.algo);
    expect(record.signatureDest).toBe(EXPECTED_ROUTING.signatureDest);
    expect(record.params).toEqual(EXPECTED_ROUTING.params);
    expect(record.txParamType).toBe(TxParamType.evmType2);
    expect(record.outputDeserializationSchema).toEqual(
      EXPECTED_ROUTING.outputDeserializationSchema,
    );
    expect(record.respondSerializationSchema).toEqual(EXPECTED_ROUTING.respondSerializationSchema);

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
      commitment: pureCircuits.refundCommitment(SECRET_KEY, VALID_WITHDRAW.coin.nonce),
      key: VALID_WITHDRAW.coin.nonce,
      erc20: ERC20,
      amount: AMOUNT,
      knownHeight: EVM_START_HEIGHT,
    });

    // The burn, observable in the zswap local state: the coin is received (a
    // contract-owned output) and spent as the call's input, and the burn
    // output pays its full value to the shielded burn address. The receive
    // output's coin info must equal the spent coin's exactly: that identity is
    // what lets the transaction builder pair the two into a same-transaction
    // transient instead of a contract coin-tree spend.
    const zswap = zswapState(next);

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
        coin: vaultCoin(AMOUNT, otherColor),
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

// A NEVER-EXECUTED transaction (reverted, or its nonce taken by another
// transaction): the protocol attests an EMPTY output under OutputKind.failed
// or OutputKind.unviable. Settles through the per-kind refund circuits, whose
// output argument is Bytes<0>.
const OUTPUT_FAILURE = new Uint8Array(0);

/**
 * Sign a REAL RespondBidirectionalEvent for (requestId, blockHeight,
 * outputKind, serializedOutput) with `secretKey`: the record comes from the
 * library's sanctioned minting helper (pinned byte-for-byte against the
 * compiled oracles in signet-midnight's own tests), exactly like the MPC.
 * The wire event carries the request id, block height, kind, output width,
 * digest and the stored-form signature (big-endian SEC1, bigR as a full
 * point), never the output, and it is returned flipped to
 * verifyRespondBidirectionalEventV1's circuit-input form, which is what a
 * client hands to the settle circuits: the digest is recomputed by whoever
 * verifies, and the output travels as a separate circuit argument.
 */
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
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
        MINT_NONCE,
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
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
        MINT_NONCE,
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
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_FALSE, ATTESTED_HEIGHT),
        OUTPUT_FALSE,
        MINT_NONCE,
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
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_FALSE, ATTESTED_HEIGHT),
        OUTPUT_FALSE,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Not the withdrawer/);
  });

  it("rejects a response signed by a key other than the stored MPC response key", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    await expect(
      contract.circuits.completeWithdraw(
        ctx,
        respond(IMPOSTER_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
        OUTPUT_SUCCESS,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects presented output bytes that differ from what was signed", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    // Signed over the FALSE result, presented as a success byte: the digest
    // recomputed in-circuit is not the one the signature covers. This is the
    // attack the output-free event must stop: settling a false return as a
    // success.
    await expect(
      contract.circuits.completeWithdraw(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_FALSE, ATTESTED_HEIGHT),
        OUTPUT_SUCCESS,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a genuine response for another request id: the id the event names is consumed", async () => {
    const { contract, ctx } = await withdrawRequested();
    // The digest binds the event's request id and the circuit consumes THAT
    // id, so a genuine attestation of some other id cannot settle this
    // pending withdrawal: it looks up the other id and finds nothing.
    const otherId = bytes(32, 0xab);
    await expect(
      contract.circuits.completeWithdraw(
        ctx,
        respond(MPC_RESPONSE_SECRET, otherId, OutputKind.executed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
        OUTPUT_SUCCESS,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Withdrawal not found/);
  });

  it("rejects a genuinely signed failure kind at the executed width", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    // The kind is inside the signed digest: a failure attestation, even one
    // the MPC signed over a 1-byte output, never settles as an execution.
    await expect(
      contract.circuits.completeWithdraw(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
        OUTPUT_SUCCESS,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Attestation is not an execution/);
  });

  it("rejects a genuinely signed id that has no pending withdrawal", async () => {
    const { contract, ctx } = await withdrawRequested();
    const unknownId = bytes(32, 0xab);
    await expect(
      contract.circuits.completeWithdraw(
        ctx,
        respond(
          MPC_RESPONSE_SECRET,
          unknownId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Withdrawal not found/);
  });

  it("settles once: a second completeWithdraw for the same request rejects", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    const next = (
      await contract.circuits.completeWithdraw(
        ctx,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
        MINT_NONCE,
      )
    ).context;
    await expect(
      contract.circuits.completeWithdraw(
        next,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
        MINT_NONCE,
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
        respond(
          MPC_RESPONSE_SECRET,
          depositId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Withdrawal not found/);
  });
});

// ---- Refund-withdraw tests ----

describe("refundWithdraw settle", () => {
  it.each([
    { name: "a reverted transfer (failed)", outputKind: OutputKind.failed },
    {
      name: "a transfer whose nonce another transaction took (unviable)",
      outputKind: OutputKind.unviable,
    },
  ])(
    "$name: the WITHDRAWER re-mints the surrendered value and consumes the withdrawal",
    async ({ outputKind }) => {
      const { contract, ctx, requestId } = await withdrawRequested();

      // Same shielded-mint reasoning as completeWithdraw's refund branch: the
      // call resolving proves the mint executed, the observable effect is the
      // consumption of the request and its pending-withdrawal marker.
      const next = (
        await contract.circuits.refundWithdraw(
          ctx,
          respond(MPC_RESPONSE_SECRET, requestId, outputKind, OUTPUT_FAILURE, ATTESTED_HEIGHT),
          OUTPUT_FAILURE,
          MINT_NONCE,
        )
      ).context;

      const state = ledger(next.callContext.currentQueryContext.state);
      expect(state.signBidirectionalEventMap.isEmpty()).toBe(true);
      expect(state.withdrawSettleViews.isEmpty()).toBe(true);
    },
  );

  it("a caller other than the withdrawer cannot take the refund", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    await expect(
      contract.circuits.refundWithdraw(
        await strangerContext("refundWithdraw", ctx),
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_FAILURE, ATTESTED_HEIGHT),
        OUTPUT_FAILURE,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Not the withdrawer/);
  });

  it("rejects a genuinely signed executed kind at the failure width", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    // Digest and signature check out over an empty output, but the signed
    // kind says the transaction executed: no refund.
    await expect(
      contract.circuits.refundWithdraw(
        ctx,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_FAILURE,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_FAILURE,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Attestation is not a failure/);
  });

  it("rejects a failure output signed by a key other than the stored MPC response key", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    await expect(
      contract.circuits.refundWithdraw(
        ctx,
        respond(IMPOSTER_SECRET, requestId, OutputKind.failed, OUTPUT_FAILURE, ATTESTED_HEIGHT),
        OUTPUT_FAILURE,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects presented output bytes that differ from what was signed", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    // Signed over a 1-byte output under the failure kind, presented as the
    // empty output: the recomputed digest is not the one the signature
    // covers, so the signature check rejects it before the kind gate.
    await expect(
      contract.circuits.refundWithdraw(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
        OUTPUT_FAILURE,
        MINT_NONCE,
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
        respond(MPC_RESPONSE_SECRET, depositId, OutputKind.failed, OUTPUT_FAILURE, ATTESTED_HEIGHT),
        OUTPUT_FAILURE,
        MINT_NONCE,
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
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_FAILURE, ATTESTED_HEIGHT),
        OUTPUT_FAILURE,
        MINT_NONCE,
      )
    ).context;
    await expect(
      contract.circuits.refundWithdraw(
        next,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_FAILURE, ATTESTED_HEIGHT),
        OUTPUT_FAILURE,
        MINT_NONCE,
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
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
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
        respond(IMPOSTER_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
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
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_FALSE, ATTESTED_HEIGHT),
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
    // attack the output-free event must stop: claiming a false return as a
    // success. (The reverse presentation would trip the return-value assert
    // first.)
    await expect(
      contract.circuits.completeDeposit(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_FALSE, ATTESTED_HEIGHT),
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a genuinely signed failure kind at the executed width", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    // The kind is inside the signed digest: a failure attestation over a
    // 1-byte success output never claims.
    await expect(
      contract.circuits.completeDeposit(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Attestation is not an execution/);
  });

  it("rejects a genuinely signed id that has no pending deposit", async () => {
    const { contract, ctx } = await depositRequested();
    const unknownId = bytes(32, 0xab);
    await expect(
      contract.circuits.completeDeposit(
        ctx,
        respond(
          MPC_RESPONSE_SECRET,
          unknownId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
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
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;
    await expect(
      contract.circuits.completeDeposit(
        next,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
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
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
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
  evmNonce: bigint;
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
  evmNonce: 0n,
  swap: {
    tokenIn: ERC20,
    tokenOut: ERC20_OUT,
    fee: FEE,
    amountOut: SWAP_AMOUNT_OUT,
    amountInMaximum: SWAP_AMOUNT_IN_MAX,
  },
  coin: vaultCoin(SWAP_AMOUNT_IN_MAX),
};

const swap = async (
  contract: Contract<VaultPrivateState>,
  ctx: Parameters<Contract<VaultPrivateState>["circuits"]["startSwap"]>[0],
  args: SwapCallArgs,
) => {
  const key = keyForCoin(args.coin);
  const queued = (await contract.circuits.startSwap(ctx, args.swap, args.coin, key)).context;
  return contract.circuits.sendSwap(await flushOne(contract, queued, key), key);
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
    const { context: next } = await approveRouter(contract, ctx, ERC20);

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
  });

  it("is permissionless (a stranger may ready a token) and needs initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(approveRouter(contract, ctx, ERC20)).rejects.toThrow(/Not initialised/);
    const ready = await deployInitialised();
    await expect(
      approveRouter(ready.contract, await strangerContext("approveRouter", ready.ctx), ERC20),
    ).resolves.toBeDefined();
  });
});

describe("swap round-trip", () => {
  it("burns tokenIn and stores a vault-path exactOutputSingle event on the swap map", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: next } = await swap(contract, ctx, VALID_SWAP);
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
      nonce: VALID_SWAP.evmNonce,
      gasLimit: 700_000n,
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
    const zswap = zswapState(next);

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
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SWAP, ATTESTED_HEIGHT),
        OUTPUT_SWAP,
        MINT_NONCE,
        CHANGE_NONCE,
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
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SWAP, ATTESTED_HEIGHT),
        OUTPUT_SWAP,
        MINT_NONCE,
        CHANGE_NONCE,
      ),
    ).rejects.toThrow(/Not the swapper/);
  });

  it("rejects a changeNonce equal to mintNonce (the two coins must not share a nonce)", async () => {
    const { contract, ctx, requestId } = await swapRequested();
    await expect(
      contract.circuits.completeSwap(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SWAP, ATTESTED_HEIGHT),
        OUTPUT_SWAP,
        MINT_NONCE,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/changeNonce must differ from mintNonce/);
  });

  it("rejects an attestation signed by the wrong key, and presented bytes that differ", async () => {
    const { contract, ctx, requestId } = await swapRequested();
    await expect(
      contract.circuits.completeSwap(
        ctx,
        respond(IMPOSTER_SECRET, requestId, OutputKind.executed, OUTPUT_SWAP, ATTESTED_HEIGHT),
        OUTPUT_SWAP,
        MINT_NONCE,
        CHANGE_NONCE,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
    await expect(
      contract.circuits.completeSwap(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SWAP, ATTESTED_HEIGHT),
        swapOutput(1n),
        MINT_NONCE,
        CHANGE_NONCE,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });
  it("rejects a failure attestation presented as an 8-byte zero output", async () => {
    const { contract, ctx, requestId } = await swapRequested();
    // The digest commits to the output's width: an empty output signed under
    // a failure kind never verifies over 8 zero bytes.
    await expect(
      contract.circuits.completeSwap(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_FAILURE, ATTESTED_HEIGHT),
        new Uint8Array(8),
        MINT_NONCE,
        CHANGE_NONCE,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });
});

describe("refundSwap settle", () => {
  it("on a failure attestation, re-mints tokenIn to the swapper and cleans up", async () => {
    const { contract, ctx, requestId } = await swapRequested();
    const next = (
      await contract.circuits.refundSwap(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_FAILURE, ATTESTED_HEIGHT),
        OUTPUT_FAILURE,
        MINT_NONCE,
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
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_FAILURE, ATTESTED_HEIGHT),
        OUTPUT_FAILURE,
        MINT_NONCE,
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

const supply = async (
  contract: Contract<VaultPrivateState>,
  ctx: Parameters<Contract<VaultPrivateState>["circuits"]["startSupply"]>[0],
  amount: bigint,
  coin: ReturnType<typeof vaultCoin>,
) => {
  const key = keyForCoin(coin);
  const queued = (await contract.circuits.startSupply(ctx, { amount }, coin, key)).context;
  return contract.circuits.sendSupply(await flushOne(contract, queued, key), key);
};

const redeem = async (
  contract: Contract<VaultPrivateState>,
  ctx: Parameters<Contract<VaultPrivateState>["circuits"]["startRedeem"]>[0],
  shares: bigint,
  coin: ReturnType<typeof vaultCoin>,
) => {
  const key = keyForCoin(coin);
  const queued = (await contract.circuits.startRedeem(ctx, { shares }, coin, key)).context;
  return contract.circuits.sendRedeem(await flushOne(contract, queued, key), key);
};

describe("approveStata", () => {
  it("records approve(stataToken, MAX) on signBidirectionalEventMap from the vault path, to = the underlying", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: next } = await approveStata(contract, ctx);

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
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, out, ATTESTED_HEIGHT),
        out,
        MINT_NONCE,
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
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, out, ATTESTED_HEIGHT),
        out,
        MINT_NONCE,
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
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, out, ATTESTED_HEIGHT),
        out,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Not the redeemer/);
  });

  it("verifies the assets attestation, mints the underlying, and cleans up", async () => {
    const { contract, ctx, requestId } = await redeemRequested();
    const out = swapOutput(REDEEM_ASSETS);
    const next = (
      await contract.circuits.completeRedeem(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, out, ATTESTED_HEIGHT),
        out,
        MINT_NONCE,
      )
    ).context;
    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.redeemEventMap.isEmpty()).toBe(true);
    expect(state.redeemSettleViews.isEmpty()).toBe(true);
  });
});

describe("refundSupply / refundRedeem settle", () => {
  it("supply: on a failure attestation, re-mints the underlying to the supplier and cleans up", async () => {
    const { contract, ctx, requestId } = await supplyRequested();
    const next = (
      await contract.circuits.refundSupply(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_FAILURE, ATTESTED_HEIGHT),
        OUTPUT_FAILURE,
        MINT_NONCE,
      )
    ).context;
    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.supplyEventMap.isEmpty()).toBe(true);
    expect(state.supplySettleViews.isEmpty()).toBe(true);
  });

  it("redeem: on a failure attestation, re-mints the stataToken to the redeemer and cleans up", async () => {
    const { contract, ctx, requestId } = await redeemRequested();
    const next = (
      await contract.circuits.refundRedeem(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_FAILURE, ATTESTED_HEIGHT),
        OUTPUT_FAILURE,
        MINT_NONCE,
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
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_FAILURE, ATTESTED_HEIGHT),
        OUTPUT_FAILURE,
        MINT_NONCE,
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
  const next = (await approveRouter(contract, ctx, ERC20)).context;
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
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
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
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
        MINT_NONCE,
      ),
    throws: /Withdrawal not found/,
  },
  {
    kind: SettleKind.Withdraw,
    circuit: "refundWithdraw",
    settle: ({ contract, ctx, requestId }) =>
      contract.circuits.refundWithdraw(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_FAILURE, ATTESTED_HEIGHT),
        OUTPUT_FAILURE,
        MINT_NONCE,
      ),
    throws: /Withdrawal not found/,
  },
  {
    kind: SettleKind.Swap,
    circuit: "completeSwap",
    settle: ({ contract, ctx, requestId }) =>
      contract.circuits.completeSwap(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SWAP, ATTESTED_HEIGHT),
        OUTPUT_SWAP,
        MINT_NONCE,
        CHANGE_NONCE,
      ),
    throws: /Swap not found/,
  },
  {
    kind: SettleKind.Swap,
    circuit: "refundSwap",
    settle: ({ contract, ctx, requestId }) =>
      contract.circuits.refundSwap(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_FAILURE, ATTESTED_HEIGHT),
        OUTPUT_FAILURE,
        MINT_NONCE,
      ),
    throws: /Swap not found/,
  },
  {
    kind: SettleKind.Supply,
    circuit: "completeSupply",
    settle: ({ contract, ctx, requestId }) =>
      contract.circuits.completeSupply(
        ctx,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUPPLY,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUPPLY,
        MINT_NONCE,
      ),
    throws: /Supply not found/,
  },
  {
    kind: SettleKind.Supply,
    circuit: "refundSupply",
    settle: ({ contract, ctx, requestId }) =>
      contract.circuits.refundSupply(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_FAILURE, ATTESTED_HEIGHT),
        OUTPUT_FAILURE,
        MINT_NONCE,
      ),
    throws: /Supply not found/,
  },
  {
    kind: SettleKind.Redeem,
    circuit: "completeRedeem",
    settle: ({ contract, ctx, requestId }) =>
      contract.circuits.completeRedeem(
        ctx,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_REDEEM,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_REDEEM,
        MINT_NONCE,
      ),
    throws: /Redeem not found/,
  },
  {
    kind: SettleKind.Redeem,
    circuit: "refundRedeem",
    settle: ({ contract, ctx, requestId }) =>
      contract.circuits.refundRedeem(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_FAILURE, ATTESTED_HEIGHT),
        OUTPUT_FAILURE,
        MINT_NONCE,
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

interface VaultCall {
  contractAddress: string;
  publicTranscript: unknown;
  initialQueryContext: { block: unknown; state: unknown };
  finalQueryContext: { effects: unknown };
}
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

const stateOf = (ctx: CircuitContext<VaultPrivateState>): unknown =>
  ctx.callContext.currentQueryContext.state;

const withHeadroom = (gas: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, typeof v === "bigint" ? v * 8n : v]));

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

describe("throughput: requests never pin shared state, only the flush does", () => {
  it("CONTROL: a queued deposit applies against the state it was built on", async () => {
    const { contract, ctx } = await deployInitialised();
    const builtOn = stateOf(ctx);
    const run = await queueDeposit(contract, ctx, VALID_DEPOSIT);
    expect(replay(builtOn, run)).toBe("applied");
  });

  it("two concurrent startDeposits from different callers both apply", async () => {
    const { contract, ctx } = await deployInitialised();
    const alice = await queueDeposit(contract, ctx, VALID_DEPOSIT);
    const stateAfterAlice = alice.context.callContext.currentQueryContext.state;
    const bobCtx = await strangerContext("startDeposit", ctx);
    const bob = await queueDeposit(contract, bobCtx, VALID_DEPOSIT);
    expect(replay(stateAfterAlice, bob, true)).toBe("applied");
  });

  it("two concurrent vault requests from different callers both apply", async () => {
    const { contract, ctx } = await deployInitialised();
    const alice = await contract.circuits.approveRouter(ctx, ERC20);
    const stateAfterAlice = stateOf(alice.context);
    const bobCtx = await strangerContext("approveRouter", ctx);
    const bob = await contract.circuits.approveRouter(bobCtx, ERC20_OUT);
    expect(replay(stateAfterAlice, bob, true)).toBe("applied");
  });

  it("a flush that skips a waiting request is refused", async () => {
    const { contract, ctx } = await deployInitialised();
    const first = { ...VALID_WITHDRAW.coin, nonce: bytes(32, 0x51) };
    const second = { ...VALID_WITHDRAW.coin, nonce: bytes(32, 0x52) };
    const request = VALID_WITHDRAW.withdraw;
    const one = (await contract.circuits.startWithdraw(ctx, request, first, keyForCoin(first)))
      .context;
    const two = (await contract.circuits.startWithdraw(one, request, second, keyForCoin(second)))
      .context;
    await expect(
      contract.circuits.flush(two, padKeys([keyForCoin(first)]), padKeys([])),
    ).rejects.toThrow(/Flush must stamp every waiting request/);
    const both = (
      await contract.circuits.flush(
        two,
        padKeys([keyForCoin(first), keyForCoin(second)]),
        padKeys([]),
      )
    ).context;
    expect(ledger(stateOf(both) as never).unflushed).toBe(0n);
  });

  const queueWithdraws = async (count: number, firstNonceByte: number) => {
    const { contract, ctx } = await deployInitialised();
    const request = VALID_WITHDRAW.withdraw;
    let current = ctx;
    const keys: Uint8Array[] = [];
    for (let i = 0; i < count; i += 1) {
      const coin = { ...VALID_WITHDRAW.coin, nonce: bytes(32, firstNonceByte + i) };
      keys.push(keyForCoin(coin));
      current = (await contract.circuits.startWithdraw(current, request, coin, keyForCoin(coin)))
        .context;
    }
    return { contract, current, keys, request };
  };

  it("a full batch may leave the twenty-first request waiting", async () => {
    const { contract, current, keys } = await queueWithdraws(21, 0x60);
    const flushed = (
      await contract.circuits.flush(current, padKeys(keys.slice(0, 20)), padKeys([]))
    ).context;
    expect(ledger(stateOf(flushed) as never).unflushed).toBe(1n);
  }, 60_000);

  it("a request landing first invalidates a partial flush, never a full batch", async () => {
    const partial = await queueWithdraws(3, 0x70);
    const partialFlush = await partial.contract.circuits.flush(
      partial.current,
      padKeys(partial.keys),
      padKeys([]),
    );
    const late = { ...VALID_WITHDRAW.coin, nonce: bytes(32, 0x7f) };
    const partialAfterLate = (
      await partial.contract.circuits.startWithdraw(
        partial.current,
        partial.request,
        late,
        keyForCoin(late),
      )
    ).context;
    expect(replay(stateOf(partialAfterLate), partialFlush, true)).toMatch(/^REJECTED/);

    const full = await queueWithdraws(21, 0x80);
    const fullFlush = await full.contract.circuits.flush(
      full.current,
      padKeys(full.keys.slice(0, 20)),
      padKeys([]),
    );
    const fullAfterLate = (
      await full.contract.circuits.startWithdraw(full.current, full.request, late, keyForCoin(late))
    ).context;
    expect(replay(stateOf(fullAfterLate), fullFlush, true)).toBe("applied");
  }, 60_000);

  it("two concurrent flushes conflict on the nonce counter, the second re-proves", async () => {
    const { contract, ctx } = await deployInitialised();
    const aliceKey = pureCircuits.approveRouterBinder(ERC20);
    const bobKey = pureCircuits.approveRouterBinder(ERC20_OUT);
    const queuedAlice = (await contract.circuits.approveRouter(ctx, ERC20)).context;
    const queuedBoth = (
      await contract.circuits.approveRouter(
        await strangerContext("approveRouter", queuedAlice),
        ERC20_OUT,
      )
    ).context;
    const aliceFlush = await contract.circuits.flush(
      queuedBoth,
      padKeys([aliceKey, bobKey]),
      padKeys([]),
    );
    const bobFlush = await contract.circuits.flush(
      queuedBoth,
      padKeys([bobKey, aliceKey]),
      padKeys([]),
    );
    expect(replay(stateOf(aliceFlush.context), bobFlush, true)).toMatch(
      /mismatch between expected .* read/,
    );
  });

  it("two concurrent sends of different keys both apply after one flush", async () => {
    const { contract, ctx } = await deployInitialised();
    const aliceKey = pureCircuits.approveRouterBinder(ERC20);
    const bobKey = pureCircuits.approveRouterBinder(ERC20_OUT);
    const queuedAlice = (await contract.circuits.approveRouter(ctx, ERC20)).context;
    const queuedBoth = (
      await contract.circuits.approveRouter(
        await strangerContext("approveRouter", queuedAlice),
        ERC20_OUT,
      )
    ).context;
    const flushed = (
      await contract.circuits.flush(queuedBoth, padKeys([aliceKey, bobKey]), padKeys([]))
    ).context;
    const aliceSend = await contract.circuits.sendApproveRouter(flushed, aliceKey);
    const bobSend = await contract.circuits.sendApproveRouter(flushed, bobKey);
    expect(replay(stateOf(aliceSend.context), bobSend, true)).toBe("applied");
  });

  it("ANTI-REPLAY GUARD: a caller's identical repeat is refused while the first is outstanding", async () => {
    const { contract, ctx } = await deployInitialised();
    const afterFirst = (await deposit(contract, ctx, VALID_DEPOSIT)).context;
    await expect(deposit(contract, afterFirst, VALID_DEPOSIT)).rejects.toThrow(
      /Request already exists/,
    );
  });
});

const DEFAULT_MAX_FEE_PER_GAS = 150_000_000_000n;
const DEFAULT_MAX_PRIORITY_FEE_PER_GAS = 1_000_000_000n;
const DEFAULT_WITHDRAW_GAS_LIMIT = 100_000n;
const DEFAULT_APPROVE_GAS_LIMIT = 100_000n;
const DEFAULT_SWAP_GAS_LIMIT = 700_000n;
const DEFAULT_SUPPLY_GAS_LIMIT = 500_000n;
const DEFAULT_REDEEM_GAS_LIMIT = 500_000n;

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

/** The one request in the map with no calldata: the admin's empty self-transfer. */
const replacementRecord = (map: Parameters<typeof toSignBidirectionalEventIndex>[0]) => {
  const replacements = [...toSignBidirectionalEventIndex(map).values()].filter(
    (record) => !record.txParams.calldata.is_some,
  );
  expect(replacements).toHaveLength(1);
  return first(replacements, "the admin replacement request");
};

const replacementEnvelope = (
  map: Parameters<typeof toSignBidirectionalEventIndex>[0],
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gasLimit: bigint } => {
  const { txParams } = replacementRecord(map);
  return {
    maxFeePerGas: txParams.maxFeePerGas,
    maxPriorityFeePerGas: txParams.maxPriorityFeePerGas,
    gasLimit: txParams.gasLimit,
  };
};

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
    const { ctx } = await deployInitialised();
    const state = ledger(ctx.callContext.currentQueryContext.state);

    expect(state.vaultMaxFeePerGas).toBeGreaterThan(100_000_000_000n);
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

    const next = (await approveRouter(contract, configured, ERC20)).context;

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
    const { contract, ctx } = await deployInitialised();
    const configured = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;

    const stateOf = (c: typeof configured) => ledger(c.callContext.currentQueryContext.state);

    const afterWithdraw = (await withdraw(contract, configured, VALID_WITHDRAW)).context;
    const afterSwap = (await swap(contract, configured, VALID_SWAP)).context;
    const afterApprove = (await approveRouter(contract, configured, ERC20)).context;
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

const STUCK_NONCE = 7n;

/** Queues, flushes AND sends `count` approves, so their nonces are issued and no longer held. */
const withSentNonces = async (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  count: number,
): Promise<CircuitContext<VaultPrivateState>> => {
  let next = await withIssuedNonces(contract, ctx, count);
  for (let i = 0; i < count; i++) {
    next = (
      await contract.circuits.sendApproveRouter(
        next,
        pureCircuits.approveRouterBinder(bytes(20, 0xb0 + i)),
      )
    ).context;
  }
  return next;
};

const withIssuedNonces = async (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  count: number,
): Promise<CircuitContext<VaultPrivateState>> => {
  let next = ctx;
  const keys: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const erc20 = bytes(20, 0xb0 + i);
    keys.push(pureCircuits.approveRouterBinder(erc20));
    next = (await contract.circuits.approveRouter(next, erc20)).context;
  }
  return (await contract.circuits.flush(next, padKeys(keys), padKeys([]))).context;
};

describe("adminReplaceEvmNonce", () => {
  it("refuses a nonce a flushed but unsent request still holds", async () => {
    const { contract, ctx } = await deployInitialised();
    const issued = await withIssuedNonces(contract, ctx, 8);
    await expect(contract.circuits.adminReplaceEvmNonce(issued, STUCK_NONCE)).rejects.toThrow(
      /Nonce held by an unsent request/,
    );
  });

  it("allows the replacement once that request is sent", async () => {
    const { contract, ctx } = await deployInitialised();
    const sent = await withSentNonces(contract, ctx, 8);
    expect(ledger(stateOf(sent) as never).nonceOwners.member(STUCK_NONCE)).toBe(false);
    const next = (await contract.circuits.adminReplaceEvmNonce(sent, STUCK_NONCE)).context;
    expect(
      toSignBidirectionalEventIndex(
        ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap,
      ).size,
    ).toBe(9);
  });

  it("rejects a nonce the contract has not issued yet", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(contract.circuits.adminReplaceEvmNonce(ctx, STUCK_NONCE)).rejects.toThrow(
      /Nonce not issued yet/,
    );
  });

  it("is deployer-gated, with initialise's own gate", async () => {
    const { contract, ctx } = await deployInitialised();
    const stranger = await strangerContext("adminReplaceEvmNonce", ctx);

    await expect(contract.circuits.adminReplaceEvmNonce(stranger, STUCK_NONCE)).rejects.toThrow(
      /Not the deployer/,
    );
  });

  it("records nothing when a non-deployer is rejected", async () => {
    const { contract, ctx } = await deployInitialised();
    const stranger = await strangerContext("adminReplaceEvmNonce", ctx);

    await expect(contract.circuits.adminReplaceEvmNonce(stranger, STUCK_NONCE)).rejects.toThrow();

    expect(
      toSignBidirectionalEventIndex(
        ledger(ctx.callContext.currentQueryContext.state).signBidirectionalEventMap,
      ).size,
    ).toBe(0);
  });

  it("builds an empty 21000-gas self-transfer at the nonce the caller named", async () => {
    const { contract, ctx } = await deployInitialised();
    const sent = await withSentNonces(contract, ctx, 8);
    const next = (await contract.circuits.adminReplaceEvmNonce(sent, STUCK_NONCE)).context;

    const record = replacementRecord(
      ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap,
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
      path: asciiPadded("vault", 32),
      nonce: STUCK_NONCE,
      to: VAULT_EVM,
      value: 0n,
      gasLimit: 21_000n,
      calldataPresent: false,
      data: "0x",
      accessListEntryCount: 0n,
    });
  });

  it("takes its fee values from the ledger, defaulting to initialise's", async () => {
    const { contract, ctx } = await deployInitialised();
    const sent = await withSentNonces(contract, ctx, 8);
    const next = (await contract.circuits.adminReplaceEvmNonce(sent, STUCK_NONCE)).context;

    expect(
      replacementEnvelope(
        ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap,
      ),
    ).toEqual({
      maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: 21_000n,
    });
  });

  it("reflects a prior setGasParams, which is why the admin raises the fees FIRST", async () => {
    const { contract, ctx } = await deployInitialised();
    const configured = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;
    const sent = await withSentNonces(contract, configured, 8);
    const next = (await contract.circuits.adminReplaceEvmNonce(sent, STUCK_NONCE)).context;

    expect(
      replacementEnvelope(
        ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap,
      ),
    ).toEqual({
      maxFeePerGas: NEW_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: NEW_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: 21_000n,
    });
  });
});

describe("queue helpers", () => {
  it("padKeys fills the flush width with zero keys and rejects a wider batch", () => {
    const padded = padKeys([new Uint8Array(32).fill(7)]);
    expect(padded).toHaveLength(FLUSH_WIDTH);
    expect(padded[0]).toEqual(new Uint8Array(32).fill(7));
    expect(padded[FLUSH_WIDTH - 1]).toEqual(new Uint8Array(32));
    expect(() => padKeys(Array<Uint8Array>(FLUSH_WIDTH + 1).fill(new Uint8Array(32)))).toThrow(
      /at most 20 keys/,
    );
  });

  it("an approve is queued under its public binder, whoever calls it", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await contract.circuits.approveRouter(ctx, ERC20)).context;
    const state = ledger(stateOf(queued) as never);
    expect(state.pendingVaultRequests.member(pureCircuits.approveRouterBinder(ERC20))).toBe(true);
    await expect(
      contract.circuits.approveRouter(await strangerContext("approveRouter", queued), ERC20),
    ).rejects.toThrow(/Request already queued/);
  });

  it("unstampedKeys lists queued keys until a flush stamps them, in ledger order", async () => {
    const { contract, ctx } = await deployInitialised();
    const aliceKey = pureCircuits.approveRouterBinder(ERC20);
    const queuedAlice = (await contract.circuits.approveRouter(ctx, ERC20)).context;
    const bobCtx = await strangerContext("approveRouter", queuedAlice);
    const bobKey = pureCircuits.approveRouterBinder(ERC20_OUT);
    const queuedBoth = (await contract.circuits.approveRouter(bobCtx, ERC20_OUT)).context;

    const before = ledger(stateOf(queuedBoth) as never);
    const pending = unstampedKeys(before);
    expect(pending).toHaveLength(2);
    expect(() => assignedNonce(before, aliceKey)).toThrow(/flush first/);

    const flushed = (await contract.circuits.flush(queuedBoth, padKeys(pending), padKeys([])))
      .context;
    const after = ledger(stateOf(flushed) as never);
    expect(unstampedKeys(after)).toHaveLength(0);
    expect(new Set([assignedNonce(after, aliceKey), assignedNonce(after, bobKey)])).toEqual(
      new Set([0n, 1n]),
    );
  });

  const stubVault = async (queued: CircuitContext<VaultPrivateState>, failFirst = false) => {
    const { contract } = await deployInitialised();
    let current = queued;
    let flushes = 0;
    const provider = {
      queryContractState: () => Promise.resolve({ data: stateOf(current) }),
    };
    const vault = {
      callTx: {
        flush: async (keys: Uint8Array[], seen: Uint8Array[]) => {
          flushes += 1;
          if (failFirst && flushes === 1) throw new Error("mismatch between expected read");
          current = (await contract.circuits.flush(current, keys, seen)).context;
          return { public: { txId: `flush-${String(flushes)}` } };
        },
      },
    };
    return {
      vault: vault as unknown as DeployedVaultContract,
      provider: provider as never,
      state: () => ledger(stateOf(current) as never),
      flushes: () => flushes,
    };
  };

  const queueMany = async (count: number) => {
    const { contract, ctx } = await deployInitialised();
    let current = ctx;
    const keys: Uint8Array[] = [];
    for (let i = 0; i < count; i += 1) {
      const coin = { ...VALID_WITHDRAW.coin, nonce: new Uint8Array(32).fill(i + 1) };
      keys.push(keyForCoin(coin));
      current = (
        await contract.circuits.startWithdraw(
          current,
          VALID_WITHDRAW.withdraw,
          coin,
          keyForCoin(coin),
        )
      ).context;
    }
    return { current, keys };
  };

  it("flushPending numbers the first 20 unnumbered keys and leaves the rest", async () => {
    const { current, keys } = await queueMany(21);
    const stub = await stubVault(current);
    expect(await flushPending(stub.vault, stub.provider, VAULT_ADDRESS)).toBe(20);
    expect(unstampedKeys(stub.state())).toHaveLength(1);
    expect(await flushPending(stub.vault, stub.provider, VAULT_ADDRESS)).toBe(1);
    expect(unstampedKeys(stub.state())).toHaveLength(0);
    const nonces = keys
      .map((key) => assignedNonce(stub.state(), key))
      .sort((a, b) => (a < b ? -1 : 1));
    expect(nonces).toEqual(keys.map((_, i) => BigInt(i)));
    expect(await flushPending(stub.vault, stub.provider, VAULT_ADDRESS)).toBe(0);
  }, 120_000);

  it("flushUntilStamped retries a lost flush and returns the key's stamp", async () => {
    const { current, keys } = await queueMany(2);
    const stub = await stubVault(current, true);
    const key = keys[1];
    if (!key) throw new Error("no key");
    const nonce = (await flushUntilStamped(stub.vault, stub.provider, VAULT_ADDRESS, key)).evmNonce;
    expect(stub.flushes()).toBe(2);
    expect(nonce).toBe(assignedNonce(stub.state(), key));
    expect(new Set(keys.map((k) => assignedNonce(stub.state(), k)))).toEqual(new Set([0n, 1n]));
    expect((await flushUntilStamped(stub.vault, stub.provider, VAULT_ADDRESS, key)).evmNonce).toBe(
      nonce,
    );
    expect(stub.flushes()).toBe(2);
  }, 60_000);

  it("flushPending folds the settled heights it finds into last seen", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const settledAt = 150n;
    const settled = (
      await contract.circuits.completeDeposit(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, settledAt),
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;
    const stub = await stubVault(settled);
    expect(seenRequestIds(stub.state())).toEqual([requestId]);
    expect(await flushPending(stub.vault, stub.provider, VAULT_ADDRESS)).toBe(0);
    expect(seenRequestIds(stub.state())).toHaveLength(0);
    expect(stub.state().lastSeenEvmHeight).toBe(settledAt);
  });

  it("flushUntilStamped gives up after its attempts when every flush is lost", async () => {
    const { current, keys } = await queueMany(1);
    const stub = await stubVault(current);
    const lost = () => Promise.reject(new Error("mismatch between expected read"));
    stub.vault.callTx.flush = lost;
    const key = keys[0];
    if (!key) throw new Error("no key");
    await expect(
      flushUntilStamped(stub.vault, stub.provider, VAULT_ADDRESS, key, 2),
    ).rejects.toThrow(/flush first/);
  }, 60_000);
});

describe("attested block heights", () => {
  it("initialise seals the start height as the last seen height", async () => {
    const { ctx } = await deployInitialised();
    expect(ledger(stateOf(ctx) as never).lastSeenEvmHeight).toBe(EVM_START_HEIGHT);
  });

  it("a flush stamps every queued key with the last seen height", async () => {
    const { contract, ctx } = await deployInitialised();
    const depositQueued = (await queueDeposit(contract, ctx, VALID_DEPOSIT)).context;
    const approveKey = pureCircuits.approveRouterBinder(ERC20);
    const bothQueued = (await contract.circuits.approveRouter(depositQueued, ERC20)).context;
    const flushed = (
      await contract.circuits.flush(
        bothQueued,
        padKeys([depositKey(ctx, VALID_DEPOSIT.evmNonce), approveKey]),
        padKeys([]),
      )
    ).context;
    const state = ledger(stateOf(flushed) as never);
    expect(stampOf(state, depositKey(ctx, VALID_DEPOSIT.evmNonce))).toEqual({
      evmNonce: 0n,
      knownHeight: EVM_START_HEIGHT,
    });
    expect(stampOf(state, approveKey)).toEqual({ evmNonce: 0n, knownHeight: EVM_START_HEIGHT });
    expect(state.vaultEvmNonce).toBe(1n);
  });

  it("completeDeposit refuses an attestation at or below the request's known height", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    await expect(
      contract.circuits.completeDeposit(
        ctx,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          EVM_START_HEIGHT,
        ),
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Stale attestation/);
  });

  it("refundWithdraw refuses a stale failure attestation", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    await expect(
      contract.circuits.refundWithdraw(
        ctx,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.failed,
          OUTPUT_FAILURE,
          EVM_START_HEIGHT,
        ),
        OUTPUT_FAILURE,
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Stale attestation/);
  });

  it("a settled height is folded into last seen by the next flush and stamps later requests", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const settledAt = 150n;
    const settled = (
      await contract.circuits.completeDeposit(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, settledAt),
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;
    const afterSettle = ledger(stateOf(settled) as never);
    expect(afterSettle.seenEvmHeights.lookup(requestId)).toBe(settledAt);
    expect(afterSettle.lastSeenEvmHeight).toBe(EVM_START_HEIGHT);

    const approveKey = pureCircuits.approveRouterBinder(ERC20);
    const queued = (await contract.circuits.approveRouter(settled, ERC20)).context;
    const flushed = (
      await contract.circuits.flush(queued, padKeys([approveKey]), padKeys([requestId]))
    ).context;
    const afterFlush = ledger(stateOf(flushed) as never);
    expect(afterFlush.lastSeenEvmHeight).toBe(settledAt);
    expect(afterFlush.seenEvmHeights.member(requestId)).toBe(false);
    expect(stampOf(afterFlush, approveKey).knownHeight).toBe(settledAt);
  });

  it("a re-issued deposit cannot reuse the attestation of its first execution", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const settledAt = 150n;
    const attestation = respond(
      MPC_RESPONSE_SECRET,
      requestId,
      OutputKind.executed,
      OUTPUT_SUCCESS,
      settledAt,
    );
    const settled = (
      await contract.circuits.completeDeposit(
        ctx,
        attestation,
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;
    const folded = (await contract.circuits.flush(settled, padKeys([]), padKeys([requestId])))
      .context;
    const reissued = (await deposit(contract, folded, VALID_DEPOSIT)).context;
    expect(
      ledger(stateOf(reissued) as never).depositSettleViews.lookup(requestId).knownHeight,
    ).toBe(settledAt);
    await expect(
      contract.circuits.completeDeposit(
        reissued,
        attestation,
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Stale attestation/);
  });

  it("sendDeposit is permissionless", async () => {
    const { contract, ctx } = await deployInitialised();
    const key = depositKey(ctx, VALID_DEPOSIT.evmNonce);
    const queued = (await queueDeposit(contract, ctx, VALID_DEPOSIT)).context;
    const flushed = await flushOne(contract, queued, key);
    const sent = (
      await contract.circuits.sendDeposit(await strangerContext("sendDeposit", flushed), key)
    ).context;
    const index = toSignBidirectionalEventIndex(ledger(stateOf(sent) as never).depositEventMap);
    expect(index.size).toBe(1);
    const record = first(index.values(), "deposit request");
    expect(record.path).toEqual(DEPLOYER_COMMITMENT);
    expect(record.txParams.nonce).toBe(VALID_DEPOSIT.evmNonce);
  });
});

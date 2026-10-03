// Simulator-level unit tests: the contract runs entirely in-process via
// @midnight-ntwrk/compact-runtime. No ledger, no network, no proving.

import {
  ChargedState,
  type CircuitContext,
  type CircuitResults,
  createCircuitContext,
  createConstructorContext,
  type EncodedRecipient,
  type EncodedZswapLocalState,
  rawTokenType,
  sampleContractAddress,
  StateMap,
  StateValue,
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
  Action,
  Contract,
  createVaultPrivateState,
  FLUSH_WIDTH,
  FlushChannel,
  flushedRequestIndex,
  type FlushSlot,
  flushSlots,
  ledger,
  pureCircuits,
  queuedRequestIndex,
  VAULT_APPROVE_REQUESTS_PATH,
  VAULT_DEPOSIT_REQUESTS_PATH,
  VAULT_REDEEM_REQUESTS_PATH,
  VAULT_REPLACE_NONCE_REQUESTS_PATH,
  VAULT_SUPPLY_REQUESTS_PATH,
  VAULT_SWAP_REQUESTS_PATH,
  VAULT_WITHDRAW_REQUESTS_PATH,
  type VaultLedgerState,
  type VaultPrivateState,
  witnesses,
} from "../src/index.ts";
import { compiledFieldIndex } from "./compiled-ledger.ts";

// ---- Fixtures ----

// The coin public key of every simulated caller, where ownPublicKey() mints. Non-zero,
// so a mint to the caller is told apart from one to the all-zero burn address.
const CPK = "c0".repeat(32);

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

// A `toHaveLength` assertion does not narrow the index read that follows it,
// so take the first element by iterating and fail naming what was missing.
const first = <T>(items: Iterable<T>, what: string): T => {
  for (const item of items) {
    return item;
  }
  throw new Error(`expected at least one ${what}`);
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
// The ERC20 a swap buys.
const ERC20_OUT = bytes(20, 0xbb);
// An ERC20 the vault never allows.
const UNLISTED_ERC20 = bytes(20, 0x99);
// The pinned Aave USDC pair (initialise args): the underlying and its stataUSDC wrapper.
const STATA_UNDERLYING = bytes(20, 0xdd); // supply burns this colour, redeem mints it
const STATA_TOKEN = bytes(20, 0xcc); // supply/redeem `to`; supply mints this colour
const ZERO_ADDRESS = new Uint8Array(20);
const AMOUNT = 1_000_000n;
const UINT64_MAX = 18446744073709551615n;

// The EIP-155 chain id initialise() pins (Sepolia's).
const CHAIN_ID = 11155111n;

// The simulated vault's own contract address, fixed so tests can compute the
// token colors minted against kernel.self(). Doubles as the sender field of
// every event the vault records (kernel.self() again).
const VAULT_ADDRESS = sampleContractAddress();
const VAULT_ADDRESS_BYTES = hexToBytes(VAULT_ADDRESS);

// The vault token colour for ERC20 at the simulated contract address, computed
// exactly as a wallet would: the compiled domain-separator circuit plus the
// runtime's rawTokenType (the off-chain twin of the in-circuit
// `tokenType(domainSep, kernel.self())`).
const VAULT_TOKEN_COLOR = hexToBytes(
  rawTokenType(pureCircuits.vaultTokenDomainSeparator(ERC20), VAULT_ADDRESS),
);

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
 * A deposit's `startDeposit` arguments: the input index, the caller's EVM nonce,
 * the gas envelope and the `DepositRequest`. The derivation path IS the caller's
 * identity commitment, recomputed in-circuit from the secret-key witness.
 */
interface DepositCallArgs {
  inIndex: bigint;
  evmNonce: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  deposit: { erc20Address: Uint8Array; amount: bigint };
}

/**
 * Known-good deposit call args, the base every test varies from.
 * Shared across tests: NEVER mutate. Build a variation as an explicit spread
 * of this base with the delta inline (see {@link DEPOSIT_REJECTION_CASES}).
 */
const VALID_DEPOSIT: DepositCallArgs = {
  inIndex: 1n,
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

const stateOf = (ctx: CircuitContext<VaultPrivateState>): unknown =>
  ctx.callContext.currentQueryContext.state;

const ledgerOf = (ctx: CircuitContext<VaultPrivateState>) => ledger(stateOf(ctx) as never);

/**
 * Deploy + initialise(VAULT_EVM, CHAIN_ID, MPC_RESPONSE_KEY) as
 * the deployer: the ready-to-use vault, with the MPC response key stored and
 * `evmStartHeight` as its last seen height. The deployer then allows ERC20 and
 * ERC20_OUT, the tokens the tests deposit and swap into.
 */
const deployInitialised = async (evmStartHeight: bigint = EVM_START_HEIGHT) => {
  const { contract, ctx } = await deployContract();
  const initialised = (
    await contract.circuits.initialise(
      ctx,
      VAULT_EVM,
      ROUTER,
      STATA_UNDERLYING,
      STATA_TOKEN,
      CHAIN_ID,
      MPC_RESPONSE_KEY,
      MPC_KEY_VERSION,
      evmStartHeight,
    )
  ).context;
  const erc20Allowed = (await contract.circuits.addAllowedToken(initialised, ERC20)).context;
  const next = (await contract.circuits.addAllowedToken(erc20Allowed, ERC20_OUT)).context;
  return { contract, ctx: next };
};

/** One flushQueue call carrying the given request indexes and attestation request ids. */
const flush = async (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  inIndexes: readonly bigint[],
  requestIds: readonly Uint8Array[],
): Promise<CircuitContext<VaultPrivateState>> =>
  (await contract.circuits.flushQueue(ctx, flushSlots(inIndexes, requestIds))).context;

/** Queue a deposit: startDeposit with its args in circuit order. */
const queueDeposit = (
  contract: Contract<VaultPrivateState>,
  ctx: Parameters<Contract<VaultPrivateState>["circuits"]["startDeposit"]>[0],
  args: DepositCallArgs,
) =>
  contract.circuits.startDeposit(
    ctx,
    args.inIndex,
    args.evmNonce,
    {
      gasLimit: args.gasLimit,
      maxFeePerGas: args.maxFeePerGas,
      maxPriorityFeePerGas: args.maxPriorityFeePerGas,
    },
    args.deposit,
  );

/** Queue, flush and send a deposit, returning the send's context and the request index. */
const deposit = async (
  contract: Contract<VaultPrivateState>,
  ctx: Parameters<Contract<VaultPrivateState>["circuits"]["startDeposit"]>[0],
  args: DepositCallArgs,
) => {
  const queued = (await queueDeposit(contract, ctx, args)).context;
  const outIndex = queuedRequestIndex(ledgerOf(queued), args.inIndex);
  const flushed = await flush(contract, queued, [args.inIndex], []);
  const sent = await contract.circuits.sendDeposit(flushed, outIndex);
  return { context: sent.context, outIndex };
};

// ---- Tests ----

describe("erc20-vault ledger shape", () => {
  it("bidirectionalDepositMap parses into the shared signet-midnight types", async () => {
    const { ctx } = await deployContract();

    // The assignment is the real assertion: the generated ledger type must
    // stay structurally identical to the shared library's named types.
    const ledgerMap: SignBidirectionalEventLedgerMap = ledger(
      ctx.callContext.currentQueryContext.state,
    ).bidirectionalDepositMap;

    expect(ledgerMap.isEmpty()).toBe(true);
    expect(toSignBidirectionalEventIndex(ledgerMap).size).toBe(0);
  });

  it("MPC-style: finds the event map in RAW state by ledger-tree path, no ledger()", async () => {
    const { ctx } = await deployContract();

    const rawState = ctx.callContext.currentQueryContext.state;
    const node = signetFieldNodeByPath(rawState, VAULT_DEPOSIT_REQUESTS_PATH);
    expect(node.type()).toBe("map");

    const { requestsIndex } = readSignetRequestsLedgerFromState(
      rawState,
      VAULT_DEPOSIT_REQUESTS_PATH,
    );
    const typedIndex = toSignBidirectionalEventIndex(
      ledger(ctx.callContext.currentQueryContext.state).bidirectionalDepositMap,
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

describe("ABI words (shared library circuits)", () => {
  it("TS mirrors match the compiled circuits byte for byte", () => {
    // Words are ABI-ready (big-endian, broadcast form): the library's TS
    // mirrors and its compiled circuits must emit identical bytes. The vault
    // stores exactly these words (see the deposit record tests).
    expect(evmAddressAbiWord(VAULT_EVM)).toEqual(signetCircuits.evmAddressAbiWord(VAULT_EVM));
    expect(numericAbiWord(AMOUNT)).toEqual(signetCircuits.numericAbiWord(AMOUNT));
    expect(signetCircuits.abiWordToUint128(numericAbiWord(AMOUNT))).toBe(AMOUNT);
  });
});

describe("initialise", () => {
  it("is deployer-gated", async () => {
    // Deployed with a stranger's commitment: our caller key can't initialise.
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

  it.each([
    {
      name: "a zero router",
      router: ZERO_ADDRESS,
      underlying: STATA_UNDERLYING,
      wrapper: STATA_TOKEN,
      throws: /Router cannot be zero/,
    },
    {
      name: "a zero stataUnderlying",
      router: ROUTER,
      underlying: ZERO_ADDRESS,
      wrapper: STATA_TOKEN,
      throws: /stataUnderlying cannot be zero/,
    },
    {
      name: "a zero stataToken",
      router: ROUTER,
      underlying: STATA_UNDERLYING,
      wrapper: ZERO_ADDRESS,
      throws: /stataToken cannot be zero/,
    },
  ])("rejects $name", async ({ router, underlying, wrapper, throws }) => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.initialise(
        ctx,
        VAULT_EVM,
        router,
        underlying,
        wrapper,
        CHAIN_ID,
        MPC_RESPONSE_KEY,
        MPC_KEY_VERSION,
        EVM_START_HEIGHT,
      ),
    ).rejects.toThrow(throws);
  });

  it("stores the vault EVM address, the chain id and the MPC response key", async () => {
    const { ctx } = await deployInitialised();
    const state = ledger(ctx.callContext.currentQueryContext.state);
    expect(state.initialised).toBe(true);
    expect(state.vaultEvmAddress).toEqual(VAULT_EVM);
    expect(state.uniswapRouter).toEqual(ROUTER);
    expect(state.evmChainId).toBe(CHAIN_ID);
    expect(state.mpcResponseKey).toEqual(MPC_RESPONSE_KEY);
  });

  it("allows stataUnderlying and nothing else", async () => {
    const { contract, ctx } = await deployContract();
    const initialised = (
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
    const state = ledgerOf(initialised);
    expect([...state.allowedTokens]).toEqual([STATA_UNDERLYING]);
  });
});

describe("addAllowedToken", () => {
  it("allows the ERC20, so a deposit of it is then accepted", async () => {
    const { contract, ctx } = await deployInitialised();
    const unlisted = {
      ...VALID_DEPOSIT,
      deposit: { erc20Address: UNLISTED_ERC20, amount: AMOUNT },
    };
    await expect(queueDeposit(contract, ctx, unlisted)).rejects.toThrow(/ERC20 not allowed/);

    const allowed = (await contract.circuits.addAllowedToken(ctx, UNLISTED_ERC20)).context;
    expect(ledgerOf(allowed).allowedTokens.member(UNLISTED_ERC20)).toBe(true);
    const queued = (await queueDeposit(contract, allowed, unlisted)).context;
    expect(ledgerOf(queued).depositArgsMap.member(unlisted.inIndex)).toBe(true);
  });

  it("leaves the set unchanged when the ERC20 is already allowed", async () => {
    const { contract, ctx } = await deployInitialised();
    const before = ledgerOf(ctx).allowedTokens.size();
    const readded = (await contract.circuits.addAllowedToken(ctx, ERC20)).context;
    expect(ledgerOf(readded).allowedTokens.size()).toBe(before);
    expect(ledgerOf(readded).allowedTokens.member(ERC20)).toBe(true);
  });

  it("is deployer-gated", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(
      contract.circuits.addAllowedToken(
        await strangerContext("addAllowedToken", ctx),
        UNLISTED_ERC20,
      ),
    ).rejects.toThrow(/Not the deployer/);
  });

  it("rejects the zero address", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(contract.circuits.addAllowedToken(ctx, ZERO_ADDRESS)).rejects.toThrow(
      /ERC20 address cannot be zero/,
    );
  });
});

describe("deposit round-trip", () => {
  it("stores a fully contract-composed event readable identically via ledger(), the shared parser, and the RAW reader", async () => {
    const { contract, ctx } = await deployInitialised();

    const { context: next, outIndex } = await deposit(contract, ctx, VALID_DEPOSIT);
    const state = next.callContext.currentQueryContext.state;

    // Read 1: generated ledger().
    const typedIndex = toSignBidirectionalEventIndex(ledger(state).bidirectionalDepositMap);
    // Read 2: MPC-style raw read, no compiled contract involved.
    const rawLedger = readSignetRequestsLedgerFromState(state, VAULT_DEPOSIT_REQUESTS_PATH);

    expect(typedIndex.size).toBe(1);
    expect(rawLedger.requestsIndex).toEqual(typedIndex);

    const [idHex, record] = first(typedIndex.entries(), "indexed signBidirectional request");

    // The cross-contract call's observable effect: the signet contract
    // emitted the notification event, its payload declaring the stored
    // event's id and naming THIS vault and the bidirectionalDepositMap (decoded
    // through the shared library's decoders, the same read the MPC's
    // discovery feed performs).
    const notificationEvents = decodeSignetLogEvents(next.events, SIGNET_ADDRESS);
    expect(notificationEvents).toHaveLength(1);
    const notificationEvent = first(notificationEvents, "signet notification event");
    expect(notificationEvent.name).toBe(SignetEventName.SignBidirectionalEvent);
    const notificationPost = decodeSignBidirectionalEventNotificationPayload(
      notificationEvent.payload,
    );
    // The declared id IS the stored map index: the MPC looks it up directly.
    expect(requestIdHex(notificationPost.requestId)).toBe(idHex);
    expect(decodeSignBidirectionalNotification(notificationPost.event)).toEqual({
      version: 1,
      callerAddress: bytesToHex(VAULT_ADDRESS_BYTES),
      requestsPath: [...VAULT_DEPOSIT_REQUESTS_PATH],
    });

    // The contract-composed envelope: the deposit's token on the
    // initialise-pinned chain, no ETH value, the caller's nonce and the gas
    // args of the send.
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

    // The map index IS the record's transientHash digest, recomputed off-chain
    // with the library's TS twin of the request-id circuit. This assertion is
    // the lockstep check the twin's deviation note relies on: the id computed
    // in TS must equal the index the REAL compiled contract minted in-circuit.
    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));

    // The flushed entry sits under its request index with the height the flush
    // recorded, its arguments sit in depositArgsMap under its input index, and
    // the send mapped the request id back to that index.
    const { entry, lastSeen } = ledger(state).outputRequestBuffer.lookup(outIndex);
    expect(entry).toEqual({
      action: Action.deposit,
      useNextVaultAccountNonce: false,
      evmNonce: VALID_DEPOSIT.evmNonce,
      inIndex: VALID_DEPOSIT.inIndex,
      commitment: pureCircuits.ownershipCommitment(VALID_DEPOSIT.inIndex, SECRET_KEY),
      argsHash: expect.any(Uint8Array) as Uint8Array,
    });
    expect(lastSeen).toBe(EVM_START_HEIGHT);
    expect(ledger(state).depositArgsMap.lookup(VALID_DEPOSIT.inIndex)).toEqual({
      request: VALID_DEPOSIT.deposit,
      path: DEPLOYER_COMMITMENT,
      gas: {
        gasLimit: VALID_DEPOSIT.gasLimit,
        maxFeePerGas: VALID_DEPOSIT.maxFeePerGas,
        maxPriorityFeePerGas: VALID_DEPOSIT.maxPriorityFeePerGas,
      },
    });
    expect(ledger(state).evictionMap.lookup(requestIdBytes(idHex))).toEqual(outIndex);
    expect(ledger(state).inputRequestBuffer.isEmpty()).toBe(true);
  });
});

/** One row of the deposit rejection table: full inputs to expected error. */
interface DepositRejectionCase {
  /** Test name, completing the sentence "rejects <name>". */
  name: string;
  /** Complete call args passed to the circuits. */
  args: DepositCallArgs;
  /** Error the circuits must throw. */
  throws: RegExp;
}

const DEPOSIT_REJECTION_CASES: DepositRejectionCase[] = [
  {
    name: "a zero ERC20 address",
    args: { ...VALID_DEPOSIT, deposit: { erc20Address: ZERO_ADDRESS, amount: AMOUNT } },
    throws: /ERC20 not allowed/,
  },
  {
    name: "an ERC20 the vault does not allow",
    args: { ...VALID_DEPOSIT, deposit: { erc20Address: UNLISTED_ERC20, amount: AMOUNT } },
    throws: /ERC20 not allowed/,
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
    await expect(queueDeposit(contract, ctx, VALID_DEPOSIT)).rejects.toThrow(/Not initialised/);
  });

  it("rejects an index the input buffer holds", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueDeposit(contract, ctx, VALID_DEPOSIT)).context;
    await expect(
      queueDeposit(contract, queued, { ...VALID_DEPOSIT, evmNonce: VALID_DEPOSIT.evmNonce + 1n }),
    ).rejects.toThrow(/Index already in use/);
  });

  it("rejects an index another action's queued request holds", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    await expect(
      queueDeposit(contract, queued, { ...VALID_DEPOSIT, inIndex: VALID_WITHDRAW.inIndex }),
    ).rejects.toThrow(/Index already in use/);
  });

  it("rejects an index the flush freed while its args stay in depositArgsMap", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueDeposit(contract, ctx, VALID_DEPOSIT)).context;
    const flushed = await flush(contract, queued, [VALID_DEPOSIT.inIndex], []);
    expect(ledgerOf(flushed).inputRequestBuffer.member(VALID_DEPOSIT.inIndex)).toBe(false);
    await expect(
      queueDeposit(contract, flushed, { ...VALID_DEPOSIT, evmNonce: VALID_DEPOSIT.evmNonce + 1n }),
    ).rejects.toThrow(/Index already in use/);
  });

  it("sendDeposit rejects a queued deposit's index before the flush moves it", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueDeposit(contract, ctx, VALID_DEPOSIT)).context;
    const outIndex = queuedRequestIndex(ledgerOf(queued), VALID_DEPOSIT.inIndex);
    await expect(contract.circuits.sendDeposit(queued, outIndex)).rejects.toThrow(
      /Request not flushed/,
    );
  });

  it("an identical repeat names the same transaction and cannot be flushed while the first is open", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: afterFirst, outIndex } = await deposit(contract, ctx, VALID_DEPOSIT);
    const repeat = { ...VALID_DEPOSIT, inIndex: 2n };

    const queued = (await queueDeposit(contract, afterFirst, repeat)).context;
    expect(queuedRequestIndex(ledgerOf(queued), repeat.inIndex)).toEqual(outIndex);

    await expect(flush(contract, queued, [repeat.inIndex], [])).rejects.toThrow(
      /Identical request open/,
    );
    await expect(contract.circuits.sendDeposit(queued, outIndex)).rejects.toThrow(
      /Request already sent/,
    );
  });

  it("the SAME caller depositing twice with different EVM nonces gets two ids", async () => {
    const { contract, ctx } = await deployInitialised();

    const afterFirst = (await deposit(contract, ctx, VALID_DEPOSIT)).context;
    const afterSecond = (
      await deposit(contract, afterFirst, {
        ...VALID_DEPOSIT,
        inIndex: 2n,
        evmNonce: VALID_DEPOSIT.evmNonce + 1n,
      })
    ).context;
    const state = ledger(afterSecond.callContext.currentQueryContext.state);

    const index = toSignBidirectionalEventIndex(state.bidirectionalDepositMap);
    expect(index.size).toBe(2);
  });
});

// An MPC response secret OTHER than the one initialise pinned the key of.
const IMPOSTER_SECRET = bytes(32, 0x43);

// The caller-chosen mint nonce every minting settle circuit takes. In production the
// client draws it fresh from a CSPRNG per call (that randomness is the
// unlinkability guarantee). The circuit only threads it through, so a fixed
// value is fine for these deterministic simulator tests.
const MINT_NONCE = bytes(32, 0x2e);
// The vault's respond schema, read from the COMPILED circuit (the contract's
// own declaration), so the fixtures below run through the same ABI-to-compact
// pipeline the real client uses: schema -> descriptor -> midnight-serde
// compactSerialize. Nothing here hand-packs bytes.
const VAULT_RESPONSE_SCHEMA = pureCircuits.vaultResponseSchema();

// A successful remote execution: the packed bool result at its exact
// unpadded width, one 0x01 byte (the circuits take it as Bytes<1>).
const OUTPUT_SUCCESS = serializeRespondOutput(VAULT_RESPONSE_SCHEMA, { success: true });

// An EXECUTED transfer that returned false: one 0x00 byte.
const OUTPUT_FALSE = serializeRespondOutput(VAULT_RESPONSE_SCHEMA, { success: false });

// A failed or unviable execution attests an empty output (queueAttestation0).
const OUTPUT_EMPTY = new Uint8Array(0);

// completeDeposit takes a 1-byte output on every verdict and ignores it on a failure.
const OUTPUT_IGNORED = new Uint8Array(1);

/**
 * Sign a REAL RespondBidirectionalEvent for (requestId, blockHeight,
 * outputKind, serializedOutput) with `secretKey`: the record comes from the
 * library's sanctioned minting helper (pinned byte-for-byte against the
 * compiled oracles in signet-midnight's own tests), exactly like the MPC.
 * The wire event carries the request id, block height, kind, output width,
 * digest and the stored-form signature (big-endian SEC1, bigR as a full
 * point), and it is returned flipped to
 * verifyRespondBidirectionalEventV1's circuit-input form, which is what a
 * client hands to the queue circuits: the digest is recomputed by whoever
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

/** Queue a 1-byte attestation and flush it: the arrange step before a settle. */
const attest = async (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  attestation: RespondBidirectionalEvent,
  serializedOutput: Uint8Array,
): Promise<CircuitContext<VaultPrivateState>> => {
  const queued = (await contract.circuits.queueAttestation1(ctx, attestation, serializedOutput))
    .context;
  return flush(contract, queued, [], [attestation.requestId]);
};

/** Queue an 8-byte attestation and flush it: the arrange step before a width-8 settle. */
const attest8 = async (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  attestation: RespondBidirectionalEvent,
  serializedOutput: Uint8Array,
): Promise<CircuitContext<VaultPrivateState>> => {
  const queued = (await contract.circuits.queueAttestation8(ctx, attestation, serializedOutput))
    .context;
  return flush(contract, queued, [], [attestation.requestId]);
};

// ---- Settle fixtures ----

/** The zswap local state a circuit run produced, failing when there is none. */
const zswapState = (context: CircuitContext<VaultPrivateState>) => {
  const state = context.callContext.currentZswapLocalState;
  if (!state) {
    throw new Error("expected zswap local state on the circuit context");
  }
  return state;
};

/**
 * The coins a settle minted: the zswap outputs `settled` holds beyond `before`'s, as a
 * threaded context accumulates the outputs of every circuit run before it.
 */
const coinsMinted = (
  before: CircuitContext<VaultPrivateState>,
  settled: CircuitContext<VaultPrivateState>,
): EncodedZswapLocalState["outputs"] =>
  zswapState(settled).outputs.slice(zswapState(before).outputs.length);

// Where every settle but a deposit naming a recipient mints: the caller's own coin
// public key, ownPublicKey().
const TO_CALLER: EncodedRecipient = {
  is_left: true,
  left: { bytes: hexToBytes(CPK) },
  right: { bytes: new Uint8Array(32) },
};

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
 * every claim test. Returns the sent deposit's request id (the single
 * ledger map index) and request index alongside the threaded context.
 */
const depositRequested = async () => {
  const { contract, ctx } = await deployInitialised();
  const { context: next, outIndex } = await deposit(contract, ctx, VALID_DEPOSIT);
  const index = toSignBidirectionalEventIndex(ledgerOf(next).bidirectionalDepositMap);
  const idHex = first(index.keys(), "signBidirectional request id");
  return { contract, ctx: next, requestId: requestIdBytes(idHex), outIndex };
};

// ---- Claim-deposit tests ----

describe("completeDeposit settle", () => {
  it.each([
    { name: "no recipient: mints to the caller", recipient: CALLER_RECIPIENT, mintedTo: TO_CALLER },
    {
      name: "an explicit wallet recipient: mints to the given coin public key",
      recipient: OTHER_WALLET_RECIPIENT,
      mintedTo: OTHER_WALLET_RECIPIENT.value,
    },
    {
      name: "an explicit contract recipient: mints to the given contract address",
      recipient: CONTRACT_RECIPIENT,
      mintedTo: CONTRACT_RECIPIENT.value,
    },
  ])("$name and consumes the request", async ({ recipient, mintedTo }) => {
    const { contract, ctx, requestId } = await depositRequested();
    const attested = await attest(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
      OUTPUT_SUCCESS,
    );

    const next = (
      await contract.circuits.completeDeposit(
        attested,
        requestId,
        OUTPUT_SUCCESS,
        MINT_NONCE,
        recipient,
      )
    ).context;

    expect(next.callContext.currentQueryContext.effects.shieldedMints.size).toBe(1);
    expect(coinsMinted(attested, next)).toEqual([
      {
        coinInfo: { nonce: MINT_NONCE, color: VAULT_TOKEN_COLOR, value: AMOUNT },
        recipient: mintedTo,
      },
    ]);
    const state = ledgerOf(next);
    expect(state.bidirectionalDepositMap.isEmpty()).toBe(true);
    expect(state.outputRequestBuffer.isEmpty()).toBe(true);
    expect(state.outputAttestationBuffer.isEmpty()).toBe(true);
    expect(state.evictionMap.isEmpty()).toBe(true);
    expect(state.depositArgsMap.isEmpty()).toBe(true);
  });

  it("queueAttestation1 rejects a response signed by a key other than the stored MPC response key", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    await expect(
      contract.circuits.queueAttestation1(
        ctx,
        respond(IMPOSTER_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
        OUTPUT_SUCCESS,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("closes a genuinely signed sweep that returned false without minting", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const attested = await attest(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_FALSE, ATTESTED_HEIGHT),
      OUTPUT_FALSE,
    );

    const next = (
      await contract.circuits.completeDeposit(
        attested,
        requestId,
        OUTPUT_FALSE,
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;

    expect(next.callContext.currentQueryContext.effects.shieldedMints.size).toBe(0);
    const state = ledgerOf(next);
    expect(state.bidirectionalDepositMap.isEmpty()).toBe(true);
    expect(state.outputRequestBuffer.isEmpty()).toBe(true);
    expect(state.outputAttestationBuffer.isEmpty()).toBe(true);
    expect(state.evictionMap.isEmpty()).toBe(true);
    expect(state.depositArgsMap.isEmpty()).toBe(true);
  });

  it("queueAttestation1 rejects presented output bytes that differ from what was signed", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    // Signed over the FALSE result, presented as a success byte: the digest
    // recomputed in-circuit is not the one the signature covers. This is the
    // attack the output-free event must stop: claiming a false return as a
    // success.
    await expect(
      contract.circuits.queueAttestation1(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_FALSE, ATTESTED_HEIGHT),
        OUTPUT_SUCCESS,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("completeDeposit rejects presented output bytes that differ from the flushed attestation", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    // Queued honestly over the FALSE result, then settled presenting a
    // success byte: the output no longer hashes to the digest the record
    // sits under.
    const attested = await attest(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_FALSE, ATTESTED_HEIGHT),
      OUTPUT_FALSE,
    );
    await expect(
      contract.circuits.completeDeposit(
        attested,
        requestId,
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Output does not match the attestation/);
  });

  it("closes a genuinely signed failed sweep without minting", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const queued = (
      await contract.circuits.queueAttestation0(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_EMPTY, ATTESTED_HEIGHT),
        OUTPUT_EMPTY,
      )
    ).context;
    const flushed = await flush(contract, queued, [], [requestId]);

    const next = (
      await contract.circuits.completeDeposit(
        flushed,
        requestId,
        OUTPUT_IGNORED,
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;

    expect(next.callContext.currentQueryContext.effects.shieldedMints.size).toBe(0);
    const state = ledgerOf(next);
    expect(state.bidirectionalDepositMap.isEmpty()).toBe(true);
    expect(state.outputRequestBuffer.isEmpty()).toBe(true);
    expect(state.outputAttestationBuffer.isEmpty()).toBe(true);
    expect(state.evictionMap.isEmpty()).toBe(true);
    expect(state.depositArgsMap.isEmpty()).toBe(true);
  });

  it("queueAttestation1 rejects a genuinely signed id this vault never sent", async () => {
    const { contract, ctx } = await depositRequested();
    const unknownId = bytes(32, 0xab);
    await expect(
      contract.circuits.queueAttestation1(
        ctx,
        respond(
          MPC_RESPONSE_SECRET,
          unknownId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
      ),
    ).rejects.toThrow(/Request not sent/);
  });

  it("claims once: a second claim for the same request rejects", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const attested = await attest(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
      OUTPUT_SUCCESS,
    );
    const next = (
      await contract.circuits.completeDeposit(
        attested,
        requestId,
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;
    await expect(
      contract.circuits.completeDeposit(
        next,
        requestId,
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
      // The first claim consumed the request's eviction entry and output entry.
    ).rejects.toThrow(/Request not sent/);
  });

  it("rejects a caller other than the original depositor, even one naming themselves recipient", async () => {
    // The output entry pins the DEPOSITOR's ownership commitment, and the
    // stranger's witness recomputes a different one.
    const { contract, ctx, requestId } = await depositRequested();
    const attested = await attest(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
      OUTPUT_SUCCESS,
    );
    await expect(
      contract.circuits.completeDeposit(
        await strangerContext("completeDeposit", attested),
        requestId,
        OUTPUT_SUCCESS,
        MINT_NONCE,
        OTHER_WALLET_RECIPIENT,
      ),
    ).rejects.toThrow(/Not the requester/);
  });
});

// ---- Withdraw fixtures ----

// Where the vault sends the ERC20 on withdraw.
const DEST_EVM = bytes(20, 0x77);

// The stdlib's shieldedBurnAddress() recipient: the all-zero coin public key.
// The burn-output assertions below are the lockstep check for this mirror.
const BURN_ADDRESS_BYTES = new Uint8Array(32);

/** A surrendered vault coin: fixed nonce, vault-token colour, given value. */
const vaultCoin = (value: bigint, color: Uint8Array = VAULT_TOKEN_COLOR) => ({
  nonce: bytes(32, 0x0c),
  color,
  value,
});

/**
 * A withdrawal's `startWithdraw` arguments: the input index, the
 * `WithdrawRequest` and the surrendered coin. The nonce and gas are the
 * vault's, so the caller passes neither.
 */
interface WithdrawCallArgs {
  inIndex: bigint;
  withdraw: { erc20Address: Uint8Array; amount: bigint; destEvmAddress: Uint8Array };
  coin: ReturnType<typeof vaultCoin>;
}

/**
 * Known-good withdraw call args, the base every test varies from.
 * Shared across tests: NEVER mutate. Build a variation as an explicit spread
 * of this base with the delta inline (see {@link WITHDRAW_REJECTION_CASES}).
 */
const VALID_WITHDRAW: WithdrawCallArgs = {
  inIndex: 11n,
  withdraw: { erc20Address: ERC20, amount: AMOUNT, destEvmAddress: DEST_EVM },
  coin: vaultCoin(AMOUNT),
};

// The vault's gas settings initialise() stores, which every withdrawal copies at start.
const DEFAULT_VAULT_GAS = {
  gasLimit: 100_000n,
  maxFeePerGas: 150_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
};

/** Queue a withdrawal: startWithdraw with its args in circuit order. */
const queueWithdraw = (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  args: WithdrawCallArgs,
) => contract.circuits.startWithdraw(ctx, args.inIndex, args.withdraw, args.coin);

/** Queue, flush and send a withdrawal, returning the send's context and the request index. */
const withdraw = async (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  args: WithdrawCallArgs,
) => {
  const queued = (await queueWithdraw(contract, ctx, args)).context;
  const flushed = await flush(contract, queued, [args.inIndex], []);
  const outIndex = flushedRequestIndex(ledgerOf(flushed), Action.withdraw, args.inIndex);
  const sent = await contract.circuits.sendWithdraw(flushed, outIndex);
  return { context: sent.context, outIndex };
};

// ---- Withdraw tests ----

describe("withdraw round-trip", () => {
  it("burns the coin and stores a vault-path event built from the flushed entry and its args", async () => {
    const { contract, ctx } = await deployInitialised();

    const { context: next, outIndex } = await withdraw(contract, ctx, VALID_WITHDRAW);
    const state = next.callContext.currentQueryContext.state;

    const typedIndex = toSignBidirectionalEventIndex(ledger(state).bidirectionalWithdrawMap);
    const rawLedger = readSignetRequestsLedgerFromState(state, VAULT_WITHDRAW_REQUESTS_PATH);
    expect(typedIndex.size).toBe(1);
    expect(rawLedger.requestsIndex).toEqual(typedIndex);
    const [idHex, record] = first(typedIndex.entries(), "indexed withdraw request");

    // The notification names THIS vault and the bidirectionalWithdrawMap.
    const notificationEvent = first(
      decodeSignetLogEvents(next.events, SIGNET_ADDRESS),
      "signet notification event",
    );
    expect(notificationEvent.name).toBe(SignetEventName.SignBidirectionalEvent);
    const notificationPost = decodeSignBidirectionalEventNotificationPayload(
      notificationEvent.payload,
    );
    expect(requestIdHex(notificationPost.requestId)).toBe(idHex);
    expect(decodeSignBidirectionalNotification(notificationPost.event)).toEqual({
      version: 1,
      callerAddress: bytesToHex(VAULT_ADDRESS_BYTES),
      requestsPath: [...VAULT_WITHDRAW_REQUESTS_PATH],
    });

    // The vault's own account signs: the derivation path is the contract-fixed
    // 32-byte literal "vault", the nonce is the first one the flush assigned,
    // and the gas is the vault's setting copied at start.
    expect(record.sender).toEqual({ bytes: VAULT_ADDRESS_BYTES });
    expect(record.path).toEqual(asciiPadded("vault", 32));
    const { calldata, ...envelope } = record.txParams;
    expect(envelope).toEqual({
      to: ERC20,
      chainId: CHAIN_ID,
      nonce: 0n,
      ...DEFAULT_VAULT_GAS,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
    });
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

    // Contract-built calldata: transfer(destEvmAddress, amount).
    expect(calldata.is_some).toBe(true);
    expect(calldata.value.selector).toEqual(ERC20_TRANSFER_SELECTOR);
    expect(calldata.value.noWords).toBe(2n);
    expect(calldata.value.words).toHaveLength(2);
    expect(calldata.value.words[0]).toEqual(evmAddressAbiWord(DEST_EVM));
    expect(calldata.value.words[1]).toEqual(numericAbiWord(AMOUNT));

    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));

    const { entry, lastSeen } = ledger(state).outputRequestBuffer.lookup(outIndex);
    expect(entry).toEqual({
      action: Action.withdraw,
      useNextVaultAccountNonce: true,
      evmNonce: 0n,
      inIndex: VALID_WITHDRAW.inIndex,
      commitment: pureCircuits.ownershipCommitment(VALID_WITHDRAW.inIndex, SECRET_KEY),
      argsHash: expect.any(Uint8Array) as Uint8Array,
    });
    expect(lastSeen).toBe(EVM_START_HEIGHT);
    expect(ledger(state).withdrawArgsMap.lookup(VALID_WITHDRAW.inIndex)).toEqual({
      request: VALID_WITHDRAW.withdraw,
      gas: DEFAULT_VAULT_GAS,
    });
    expect(ledger(state).evictionMap.lookup(requestIdBytes(idHex))).toEqual(outIndex);
    expect(ledger(state).inputRequestBuffer.isEmpty()).toBe(true);
    expect(ledger(state).vaultAccountNonce).toBe(1n);
  });

  it("start burns the surrendered coin: received by the vault, then paid in full to the burn address", async () => {
    const { contract, ctx } = await deployInitialised();

    const started = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    const zswap = zswapState(started);

    // The receive output's coin info must equal the spent coin's exactly: that
    // identity lets the transaction builder pair the two into a same-transaction
    // transient.
    expect(zswap.inputs).toHaveLength(1);
    const consumed = first(zswap.inputs, "consumed coin");
    expect(consumed.color).toEqual(VAULT_TOKEN_COLOR);
    expect(consumed.value).toBe(AMOUNT);

    expect(zswap.outputs).toHaveLength(2);
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
    const burnOutput = first(
      zswap.outputs.filter((output) => output.recipient.is_left),
      "burn output",
    );
    expect(burnOutput.coinInfo.color).toEqual(VAULT_TOKEN_COLOR);
    expect(burnOutput.coinInfo.value).toBe(AMOUNT);
    expect(burnOutput.recipient.left.bytes).toEqual(BURN_ADDRESS_BYTES);
  });

  it("withdrawals across DIFFERENT ERC20 colours both land, at consecutive vault nonces", async () => {
    const { contract, ctx } = await deployInitialised();
    const otherErc20 = bytes(20, 0xab);
    const otherColor = hexToBytes(
      rawTokenType(pureCircuits.vaultTokenDomainSeparator(otherErc20), VAULT_ADDRESS),
    );

    const afterFirst = (await withdraw(contract, ctx, VALID_WITHDRAW)).context;
    const afterSecond = (
      await withdraw(contract, afterFirst, {
        inIndex: VALID_WITHDRAW.inIndex + 1n,
        withdraw: { erc20Address: otherErc20, amount: AMOUNT, destEvmAddress: DEST_EVM },
        coin: vaultCoin(AMOUNT, otherColor),
      })
    ).context;

    const index = toSignBidirectionalEventIndex(ledgerOf(afterSecond).bidirectionalWithdrawMap);
    expect([...index.values()].map(({ txParams }) => [txParams.to, txParams.nonce]).sort()).toEqual(
      [
        [ERC20, 0n],
        [otherErc20, 1n],
      ],
    );
    expect(ledgerOf(afterSecond).withdrawArgsMap.size()).toBe(2n);
  });
});

describe("vault nonces", () => {
  it("initialise leaves the vault nonce at 0", async () => {
    const { ctx } = await deployInitialised();
    expect(ledgerOf(ctx).vaultAccountNonce).toBe(0n);
  });

  it("one flush assigns two identical withdrawals nonces 0 and 1 in slot order, and both move", async () => {
    const { contract, ctx } = await deployInitialised();
    const second = { ...VALID_WITHDRAW, inIndex: VALID_WITHDRAW.inIndex + 1n };
    const queuedFirst = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    const queuedBoth = (await queueWithdraw(contract, queuedFirst, second)).context;

    const flushed = await flush(contract, queuedBoth, [second.inIndex, VALID_WITHDRAW.inIndex], []);

    const state = ledgerOf(flushed);
    const nonceOf = (inIndex: bigint) =>
      state.outputRequestBuffer.lookup(flushedRequestIndex(state, Action.withdraw, inIndex)).entry
        .evmNonce;
    expect(nonceOf(second.inIndex)).toBe(0n);
    expect(nonceOf(VALID_WITHDRAW.inIndex)).toBe(1n);
    expect(state.inputRequestBuffer.isEmpty()).toBe(true);
    expect(state.outputRequestBuffer.size()).toBe(2n);
    expect(state.vaultAccountNonce).toBe(2n);
  });

  it("a deposit slot leaves the vault nonce unchanged and keeps the depositor's own nonce", async () => {
    const { contract, ctx } = await deployInitialised();
    const ownNonce = { ...VALID_DEPOSIT, evmNonce: 5n };
    const queued = (await queueDeposit(contract, ctx, ownNonce)).context;
    const outIndex = queuedRequestIndex(ledgerOf(queued), ownNonce.inIndex);

    const flushed = await flush(contract, queued, [ownNonce.inIndex], []);

    expect(ledgerOf(flushed).outputRequestBuffer.lookup(outIndex).entry.evmNonce).toBe(5n);
    expect(ledgerOf(flushed).vaultAccountNonce).toBe(0n);
  });

  it("a slot naming a missing index fails the flush, so the withdrawal ahead of it takes no nonce", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    const missingIndex = 999n;

    await expect(
      flush(contract, queued, [VALID_WITHDRAW.inIndex, missingIndex], []),
    ).rejects.toThrow(/Request not queued/);

    const flushed = await flush(contract, queued, [VALID_WITHDRAW.inIndex], []);
    const state = ledgerOf(flushed);
    const outIndex = flushedRequestIndex(state, Action.withdraw, VALID_WITHDRAW.inIndex);
    expect(state.outputRequestBuffer.lookup(outIndex).entry.evmNonce).toBe(0n);
    expect(state.vaultAccountNonce).toBe(1n);
  });

  it("queuedRequestIndex refuses a vault-signed request, whose key waits on its flush", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    expect(() => queuedRequestIndex(ledgerOf(queued), VALID_WITHDRAW.inIndex)).toThrow(
      /vault-signed/,
    );
  });
});

/** One row of the withdraw rejection table: full inputs to expected error. */
interface WithdrawRejectionCase {
  /** Test name, completing the sentence "rejects <name>". */
  name: string;
  /** Complete call args passed to startWithdraw. */
  args: WithdrawCallArgs;
  /** Error startWithdraw must throw. */
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
    name: "a zero destination address",
    args: {
      ...VALID_WITHDRAW,
      withdraw: { erc20Address: ERC20, amount: AMOUNT, destEvmAddress: ZERO_ADDRESS },
    },
    throws: /Destination address cannot be zero/,
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
    await expect(queueWithdraw(contract, ctx, args)).rejects.toThrow(throws);
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(queueWithdraw(contract, ctx, VALID_WITHDRAW)).rejects.toThrow(/Not initialised/);
  });

  it("rejects an index the input buffer holds", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    await expect(queueWithdraw(contract, queued, VALID_WITHDRAW)).rejects.toThrow(
      /Index already in use/,
    );
  });

  it("rejects an index another action's queued request holds", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueDeposit(contract, ctx, VALID_DEPOSIT)).context;
    await expect(
      queueWithdraw(contract, queued, { ...VALID_WITHDRAW, inIndex: VALID_DEPOSIT.inIndex }),
    ).rejects.toThrow(/Index already in use/);
  });

  it("rejects an index the flush freed while its args stay in withdrawArgsMap", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    const flushed = await flush(contract, queued, [VALID_WITHDRAW.inIndex], []);
    expect(ledgerOf(flushed).inputRequestBuffer.member(VALID_WITHDRAW.inIndex)).toBe(false);
    await expect(queueWithdraw(contract, flushed, VALID_WITHDRAW)).rejects.toThrow(
      /Index already in use/,
    );
  });
});

describe("sendWithdraw", () => {
  it("is permissionless: a stranger sends the withdrawer's request as queued", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    const flushed = await flush(contract, queued, [VALID_WITHDRAW.inIndex], []);
    const outIndex = flushedRequestIndex(
      ledgerOf(flushed),
      Action.withdraw,
      VALID_WITHDRAW.inIndex,
    );

    const sent = (
      await contract.circuits.sendWithdraw(await strangerContext("sendWithdraw", flushed), outIndex)
    ).context;
    const index = toSignBidirectionalEventIndex(ledgerOf(sent).bidirectionalWithdrawMap);
    expect(index.size).toBe(1);
    const record = first(index.values(), "withdraw request");
    expect(record.path).toEqual(asciiPadded("vault", 32));
    expect(record.txParams.nonce).toBe(0n);
  });

  it("rejects an index the flush has not moved", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    await expect(contract.circuits.sendWithdraw(queued, bytes(32, 0x5a))).rejects.toThrow(
      /Request not flushed/,
    );
  });

  it("rejects a second send of the same request", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, outIndex } = await withdraw(contract, ctx, VALID_WITHDRAW);
    await expect(contract.circuits.sendWithdraw(sent, outIndex)).rejects.toThrow(
      /Request already sent/,
    );
  });

  it("rejects a flushed deposit's index, and sendDeposit rejects a flushed withdrawal's", async () => {
    const { contract, ctx } = await deployInitialised();
    const queuedDeposit = (await queueDeposit(contract, ctx, VALID_DEPOSIT)).context;
    const depositIndex = queuedRequestIndex(ledgerOf(queuedDeposit), VALID_DEPOSIT.inIndex);
    const queuedBoth = (await queueWithdraw(contract, queuedDeposit, VALID_WITHDRAW)).context;
    const flushed = await flush(
      contract,
      queuedBoth,
      [VALID_DEPOSIT.inIndex, VALID_WITHDRAW.inIndex],
      [],
    );
    const withdrawIndex = flushedRequestIndex(
      ledgerOf(flushed),
      Action.withdraw,
      VALID_WITHDRAW.inIndex,
    );

    await expect(contract.circuits.sendWithdraw(flushed, depositIndex)).rejects.toThrow(
      /Wrong action/,
    );
    await expect(contract.circuits.sendDeposit(flushed, withdrawIndex)).rejects.toThrow(
      /Wrong action/,
    );
  });
});

/**
 * Deploy + initialise + withdraw(VALID_WITHDRAW): the arrange step of every
 * complete-withdraw test. Returns the sent withdrawal's request id (the single
 * withdraw map index) alongside the threaded context.
 */
const withdrawRequested = async () => {
  const { contract, ctx } = await deployInitialised();
  const { context: next } = await withdraw(contract, ctx, VALID_WITHDRAW);
  const index = toSignBidirectionalEventIndex(ledgerOf(next).bidirectionalWithdrawMap);
  const idHex = first(index.keys(), "withdraw request id");
  return { contract, ctx: next, requestId: requestIdBytes(idHex) };
};

/** Queue a 0-byte (failure) attestation and flush it: the arrange step before a settle. */
const attestFailure = async (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  attestation: RespondBidirectionalEvent,
): Promise<CircuitContext<VaultPrivateState>> => {
  const queued = (await contract.circuits.queueAttestation0(ctx, attestation, OUTPUT_EMPTY))
    .context;
  return flush(contract, queued, [], [attestation.requestId]);
};

/** The shielded mints a circuit run requested, as [token, amount] pairs. */
const shieldedMintsOf = (ctx: CircuitContext<VaultPrivateState>): [string, bigint][] => [
  ...ctx.callContext.currentQueryContext.effects.shieldedMints.entries(),
];

// The mint key completeWithdraw re-mints the surrendered ERC20's vault token under.
const VAULT_TOKEN_MINT_KEY = bytesToHex(pureCircuits.vaultTokenDomainSeparator(ERC20));

/** Arrange a flushed attestation of the given verdict for the requested withdrawal. */
interface WithdrawVerdictCase {
  /** Test name, completing the sentence "<name> and consumes the request". */
  name: string;
  /** The verdict the MPC attests. */
  outputKind: OutputKind;
  /** The output the MPC signs (empty under a failure kind). */
  signedOutput: Uint8Array;
  /** The output completeWithdraw is passed. */
  presentedOutput: Uint8Array;
  /** The mints completeWithdraw must request of the ledger: mint key to amount. */
  mints: [string, bigint][];
  /** The coins those mints create, each with its nonce, colour, value and recipient. */
  coins: EncodedZswapLocalState["outputs"];
}

const WITHDRAW_VERDICT_CASES: WithdrawVerdictCase[] = [
  {
    name: "a transfer that returned true keeps the burn: mints nothing",
    outputKind: OutputKind.executed,
    signedOutput: OUTPUT_SUCCESS,
    presentedOutput: OUTPUT_SUCCESS,
    mints: [],
    coins: [],
  },
  {
    name: "a transfer that returned false re-mints the surrendered amount",
    outputKind: OutputKind.executed,
    signedOutput: OUTPUT_FALSE,
    presentedOutput: OUTPUT_FALSE,
    mints: [[VAULT_TOKEN_MINT_KEY, AMOUNT]],
    coins: [
      {
        coinInfo: { nonce: MINT_NONCE, color: VAULT_TOKEN_COLOR, value: AMOUNT },
        recipient: TO_CALLER,
      },
    ],
  },
  {
    name: "a reverted transfer (failed) re-mints the surrendered amount",
    outputKind: OutputKind.failed,
    signedOutput: OUTPUT_EMPTY,
    presentedOutput: OUTPUT_IGNORED,
    mints: [[VAULT_TOKEN_MINT_KEY, AMOUNT]],
    coins: [
      {
        coinInfo: { nonce: MINT_NONCE, color: VAULT_TOKEN_COLOR, value: AMOUNT },
        recipient: TO_CALLER,
      },
    ],
  },
  {
    name: "a transfer whose nonce another transaction took (unviable) re-mints the surrendered amount",
    outputKind: OutputKind.unviable,
    signedOutput: OUTPUT_EMPTY,
    presentedOutput: OUTPUT_IGNORED,
    mints: [[VAULT_TOKEN_MINT_KEY, AMOUNT]],
    coins: [
      {
        coinInfo: { nonce: MINT_NONCE, color: VAULT_TOKEN_COLOR, value: AMOUNT },
        recipient: TO_CALLER,
      },
    ],
  },
];

describe("completeWithdraw settle", () => {
  it.each(WITHDRAW_VERDICT_CASES)(
    "$name and consumes the request",
    async ({ outputKind, signedOutput, presentedOutput, mints, coins }) => {
      const { contract, ctx, requestId } = await withdrawRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        signedOutput,
        ATTESTED_HEIGHT,
      );
      const attested =
        outputKind === OutputKind.executed
          ? await attest(contract, ctx, attestation, signedOutput)
          : await attestFailure(contract, ctx, attestation);

      const next = (
        await contract.circuits.completeWithdraw(attested, requestId, presentedOutput, MINT_NONCE)
      ).context;

      expect(shieldedMintsOf(next)).toEqual(mints);
      expect(coinsMinted(attested, next)).toEqual(coins);
      const state = ledgerOf(next);
      expect(state.bidirectionalWithdrawMap.isEmpty()).toBe(true);
      expect(state.withdrawArgsMap.isEmpty()).toBe(true);
      expect(state.outputRequestBuffer.isEmpty()).toBe(true);
      expect(state.outputAttestationBuffer.isEmpty()).toBe(true);
      expect(state.evictionMap.isEmpty()).toBe(true);
    },
  );

  it.each(WITHDRAW_VERDICT_CASES)(
    "rejects a caller other than the withdrawer when $name",
    async ({ outputKind, signedOutput, presentedOutput }) => {
      const { contract, ctx, requestId } = await withdrawRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        signedOutput,
        ATTESTED_HEIGHT,
      );
      const attested =
        outputKind === OutputKind.executed
          ? await attest(contract, ctx, attestation, signedOutput)
          : await attestFailure(contract, ctx, attestation);

      await expect(
        contract.circuits.completeWithdraw(
          await strangerContext("completeWithdraw", attested),
          requestId,
          presentedOutput,
          MINT_NONCE,
        ),
      ).rejects.toThrow(/Not the requester/);
    },
  );

  it("rejects a false output presented for a transfer attested as returning true", async () => {
    // Presenting the false byte would re-mint tokens that already left the vault.
    const { contract, ctx, requestId } = await withdrawRequested();
    const attested = await attest(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
      OUTPUT_SUCCESS,
    );
    await expect(
      contract.circuits.completeWithdraw(attested, requestId, OUTPUT_FALSE, MINT_NONCE),
    ).rejects.toThrow(/Output does not match the attestation/);
  });

  it.each([
    { name: "queueAttestation1", outputKind: OutputKind.executed, output: OUTPUT_SUCCESS },
    { name: "queueAttestation0", outputKind: OutputKind.failed, output: OUTPUT_EMPTY },
  ])(
    "$name refuses an attestation at or below the withdrawal's lastSeen",
    async ({ outputKind, output }) => {
      const { contract, ctx, requestId } = await withdrawRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        output,
        EVM_START_HEIGHT,
      );
      await expect(
        outputKind === OutputKind.executed
          ? contract.circuits.queueAttestation1(ctx, attestation, output)
          : contract.circuits.queueAttestation0(ctx, attestation, output),
      ).rejects.toThrow(/Stale attestation/);
    },
  );

  it("settles once: a second completeWithdraw for the same request rejects", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    const attested = await attestFailure(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_EMPTY, ATTESTED_HEIGHT),
    );
    const next = (
      await contract.circuits.completeWithdraw(attested, requestId, OUTPUT_IGNORED, MINT_NONCE)
    ).context;
    await expect(
      contract.circuits.completeWithdraw(next, requestId, OUTPUT_IGNORED, MINT_NONCE),
    ).rejects.toThrow(/Request not sent/);
  });
});

describe("cross-action settle isolation", () => {
  it("completeWithdraw rejects a deposit's request id, and completeDeposit a withdrawal's", async () => {
    const { contract, ctx, requestId: depositId } = await depositRequested();
    const { context: withdrawn } = await withdraw(contract, ctx, VALID_WITHDRAW);
    const withdrawId = requestIdBytes(
      first(
        toSignBidirectionalEventIndex(ledgerOf(withdrawn).bidirectionalWithdrawMap).keys(),
        "withdraw request id",
      ),
    );
    const depositQueued = (
      await contract.circuits.queueAttestation1(
        withdrawn,
        respond(
          MPC_RESPONSE_SECRET,
          depositId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
      )
    ).context;
    const bothQueued = (
      await contract.circuits.queueAttestation1(
        depositQueued,
        respond(
          MPC_RESPONSE_SECRET,
          withdrawId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
      )
    ).context;
    const attested = await flush(contract, bothQueued, [], [depositId, withdrawId]);

    await expect(
      contract.circuits.completeWithdraw(attested, depositId, OUTPUT_SUCCESS, MINT_NONCE),
    ).rejects.toThrow(/Wrong action/);
    await expect(
      contract.circuits.completeDeposit(
        attested,
        withdrawId,
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Wrong action/);
  });
});

// ---- Approve fixtures ----

// The ERC20 approve(address,uint256) selector: the TS mirror of the literal
// `Bytes [0x09, 0x5e, 0xa7, 0xb3]` hardcoded in erc20-vault.compact.
const APPROVE_SELECTOR = new Uint8Array([0x09, 0x5e, 0xa7, 0xb3]);

// The input index every approval fixture queues under. Each action's fixture has its
// own index (deposit 1, withdraw 11, approve 21, replace nonce 31, swap 41, supply 51,
// redeem 61), so any two can share a vault.
const APPROVE_INDEX = 21n;

// The vault's gas settings initialise() stores, which every approval copies at start.
const DEFAULT_APPROVE_GAS = { ...DEFAULT_VAULT_GAS, gasLimit: 100_000n };

/**
 * One of the two approvals: its start circuit called with every argument, the
 * ERC20 the approve is called on and the spender it grants.
 */
interface ApprovalCase {
  /** The start circuit the row calls. */
  name: string;
  /** The start call, queueing the approval under {@link APPROVE_INDEX}. */
  start: (
    contract: Contract<VaultPrivateState>,
    ctx: CircuitContext<VaultPrivateState>,
  ) => ReturnType<Contract<VaultPrivateState>["circuits"]["startApproveStata"]>;
  /** The ERC20 the approve transaction is sent to. */
  erc20Address: Uint8Array;
  /** The spender the approve grants. */
  spender: Uint8Array;
}

const ROUTER_APPROVAL: ApprovalCase = {
  name: "startApproveRouter",
  start: (contract, ctx) => contract.circuits.startApproveRouter(ctx, APPROVE_INDEX, ERC20),
  erc20Address: ERC20,
  spender: ROUTER,
};

const STATA_APPROVAL: ApprovalCase = {
  name: "startApproveStata",
  start: (contract, ctx) => contract.circuits.startApproveStata(ctx, APPROVE_INDEX),
  erc20Address: STATA_UNDERLYING,
  spender: STATA_TOKEN,
};

const APPROVALS: ApprovalCase[] = [ROUTER_APPROVAL, STATA_APPROVAL];

/** Start, flush and send an approval, returning the send's context and the request index. */
const approve = async (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  approval: ApprovalCase,
) => {
  const queued = (await approval.start(contract, ctx)).context;
  const flushed = await flush(contract, queued, [APPROVE_INDEX], []);
  const outIndex = flushedRequestIndex(ledgerOf(flushed), Action.approve, APPROVE_INDEX);
  const sent = await contract.circuits.sendApprove(flushed, outIndex);
  return { context: sent.context, outIndex };
};

// ---- Approve tests ----

describe("approve round-trip", () => {
  it.each(APPROVALS)(
    "$name records a vault-path approve(spender, unlimitedAllowance()) built from the flushed entry and its args",
    async (approval) => {
      const { erc20Address, spender } = approval;
      const { contract, ctx } = await deployInitialised();

      const { context: next, outIndex } = await approve(contract, ctx, approval);
      const state = next.callContext.currentQueryContext.state;

      const typedIndex = toSignBidirectionalEventIndex(ledger(state).bidirectionalApproveMap);
      const rawLedger = readSignetRequestsLedgerFromState(state, VAULT_APPROVE_REQUESTS_PATH);
      expect(typedIndex.size).toBe(1);
      expect(rawLedger.requestsIndex).toEqual(typedIndex);
      const [idHex, record] = first(typedIndex.entries(), "indexed approve request");

      // The notification names THIS vault and the bidirectionalApproveMap.
      const notificationEvent = first(
        decodeSignetLogEvents(next.events, SIGNET_ADDRESS),
        "signet notification event",
      );
      expect(notificationEvent.name).toBe(SignetEventName.SignBidirectionalEvent);
      const notificationPost = decodeSignBidirectionalEventNotificationPayload(
        notificationEvent.payload,
      );
      expect(requestIdHex(notificationPost.requestId)).toBe(idHex);
      expect(decodeSignBidirectionalNotification(notificationPost.event)).toEqual({
        version: 1,
        callerAddress: bytesToHex(VAULT_ADDRESS_BYTES),
        requestsPath: [...VAULT_APPROVE_REQUESTS_PATH],
      });

      expect(record.sender).toEqual({ bytes: VAULT_ADDRESS_BYTES });
      expect(record.path).toEqual(asciiPadded("vault", 32));
      const { calldata, ...envelope } = record.txParams;
      expect(envelope).toEqual({
        to: erc20Address,
        chainId: CHAIN_ID,
        nonce: 0n,
        ...DEFAULT_APPROVE_GAS,
        value: 0n,
        accessListEntryCount: 0n,
        accessList: [],
      });
      expect(record.executionDest).toEqual(EXPECTED_ROUTING.executionDest);
      expect(record.keyVersion).toBe(MPC_KEY_VERSION);
      expect(record.algo).toBe(EXPECTED_ROUTING.algo);
      expect(record.signatureDest).toBe(EXPECTED_ROUTING.signatureDest);
      expect(record.params).toEqual(EXPECTED_ROUTING.params);
      expect(record.txParamType).toBe(TxParamType.evmType2);
      expect(record.outputDeserializationSchema).toEqual(
        EXPECTED_ROUTING.outputDeserializationSchema,
      );
      expect(record.respondSerializationSchema).toEqual(
        EXPECTED_ROUTING.respondSerializationSchema,
      );

      // Contract-built calldata: approve(spender, unlimitedAllowance()).
      expect(calldata.is_some).toBe(true);
      expect(calldata.value.selector).toEqual(APPROVE_SELECTOR);
      expect(calldata.value.noWords).toBe(2n);
      expect(calldata.value.words).toHaveLength(2);
      expect(calldata.value.words[0]).toEqual(evmAddressAbiWord(spender));
      expect(calldata.value.words[1]).toEqual(numericAbiWord(pureCircuits.unlimitedAllowance()));

      expect(idHex).toBe(requestIdHex(calculateRequestId(record)));

      const { entry, lastSeen } = ledger(state).outputRequestBuffer.lookup(outIndex);
      expect(entry).toEqual({
        action: Action.approve,
        useNextVaultAccountNonce: true,
        evmNonce: 0n,
        inIndex: APPROVE_INDEX,
        commitment: pureCircuits.ownershipCommitment(APPROVE_INDEX, SECRET_KEY),
        argsHash: expect.any(Uint8Array) as Uint8Array,
      });
      expect(lastSeen).toBe(EVM_START_HEIGHT);
      expect(ledger(state).approveArgsMap.lookup(APPROVE_INDEX)).toEqual({
        request: { erc20Address, spender },
        gas: DEFAULT_APPROVE_GAS,
      });
      expect(ledger(state).evictionMap.lookup(requestIdBytes(idHex))).toEqual(outIndex);
      expect(ledger(state).inputRequestBuffer.isEmpty()).toBe(true);
      expect(ledger(state).vaultAccountNonce).toBe(1n);
    },
  );

  it("unlimitedAllowance is 2^128 - 1, the largest allowance the Uint<128> word carries", () => {
    expect(pureCircuits.unlimitedAllowance()).toBe(2n ** 128n - 1n);
  });

  it.each(APPROVALS)("$name surrenders nothing: no coin enters or leaves", async ({ start }) => {
    const { contract, ctx } = await deployInitialised();

    const started = (await start(contract, ctx)).context;

    expect(zswapState(started).inputs).toHaveLength(0);
    expect(zswapState(started).outputs).toHaveLength(0);
  });

  it("the router approval sends to the ERC20 it names", async () => {
    const { contract, ctx } = await deployInitialised();
    const otherErc20 = bytes(20, 0xab);

    const queued = (await contract.circuits.startApproveRouter(ctx, APPROVE_INDEX, otherErc20))
      .context;
    const flushed = await flush(contract, queued, [APPROVE_INDEX], []);
    const outIndex = flushedRequestIndex(ledgerOf(flushed), Action.approve, APPROVE_INDEX);
    const sent = (await contract.circuits.sendApprove(flushed, outIndex)).context;

    const record = first(
      toSignBidirectionalEventIndex(ledgerOf(sent).bidirectionalApproveMap).values(),
      "approve request",
    );
    expect(record.txParams.to).toEqual(otherErc20);
    expect(record.txParams.calldata.value.words[0]).toEqual(evmAddressAbiWord(ROUTER));
  });

  it("an approval and a withdrawal share the vault nonce: one flush assigns 0 and 1 in slot order", async () => {
    const { contract, ctx } = await deployInitialised();
    const queuedApproval = (await ROUTER_APPROVAL.start(contract, ctx)).context;
    const queuedBoth = (await queueWithdraw(contract, queuedApproval, VALID_WITHDRAW)).context;

    const flushed = await flush(contract, queuedBoth, [APPROVE_INDEX, VALID_WITHDRAW.inIndex], []);

    const state = ledgerOf(flushed);
    const approveIndex = flushedRequestIndex(state, Action.approve, APPROVE_INDEX);
    const withdrawIndex = flushedRequestIndex(state, Action.withdraw, VALID_WITHDRAW.inIndex);
    expect(state.outputRequestBuffer.lookup(approveIndex).entry.evmNonce).toBe(0n);
    expect(state.outputRequestBuffer.lookup(withdrawIndex).entry.evmNonce).toBe(1n);
    expect(state.vaultAccountNonce).toBe(2n);
  });
});

describe("approve validation", () => {
  it("startApproveRouter rejects a zero ERC20 address", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(
      contract.circuits.startApproveRouter(ctx, APPROVE_INDEX, ZERO_ADDRESS),
    ).rejects.toThrow(/ERC20 address cannot be zero/);
  });

  it.each(APPROVALS)("$name rejects a caller other than the deployer", async ({ name, start }) => {
    const { contract, ctx } = await deployInitialised();
    await expect(start(contract, await strangerContext(name, ctx))).rejects.toThrow(
      /Not the deployer/,
    );
  });

  it.each(APPROVALS)("$name rejects before initialise", async ({ start }) => {
    const { contract, ctx } = await deployContract();
    await expect(start(contract, ctx)).rejects.toThrow(/Not initialised/);
  });

  it.each(APPROVALS)("$name rejects an index the input buffer holds", async ({ start }) => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await start(contract, ctx)).context;
    await expect(start(contract, queued)).rejects.toThrow(/Index already in use/);
  });

  it.each(APPROVALS)(
    "$name rejects an index another action's queued request holds",
    async ({ start }) => {
      const { contract, ctx } = await deployInitialised();
      const queued = (
        await queueWithdraw(contract, ctx, { ...VALID_WITHDRAW, inIndex: APPROVE_INDEX })
      ).context;
      await expect(start(contract, queued)).rejects.toThrow(/Index already in use/);
    },
  );

  it.each(APPROVALS)(
    "$name rejects an index the flush freed while its args stay in approveArgsMap",
    async ({ start }) => {
      const { contract, ctx } = await deployInitialised();
      const queued = (await start(contract, ctx)).context;
      const flushed = await flush(contract, queued, [APPROVE_INDEX], []);
      expect(ledgerOf(flushed).inputRequestBuffer.member(APPROVE_INDEX)).toBe(false);
      await expect(start(contract, flushed)).rejects.toThrow(/Index already in use/);
    },
  );
});

describe("sendApprove", () => {
  it("is permissionless: a stranger sends the deployer's approval as queued", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await ROUTER_APPROVAL.start(contract, ctx)).context;
    const flushed = await flush(contract, queued, [APPROVE_INDEX], []);
    const outIndex = flushedRequestIndex(ledgerOf(flushed), Action.approve, APPROVE_INDEX);

    const sent = (
      await contract.circuits.sendApprove(await strangerContext("sendApprove", flushed), outIndex)
    ).context;
    const index = toSignBidirectionalEventIndex(ledgerOf(sent).bidirectionalApproveMap);
    expect(index.size).toBe(1);
    const record = first(index.values(), "approve request");
    expect(record.path).toEqual(asciiPadded("vault", 32));
    expect(record.txParams.nonce).toBe(0n);
  });

  it("rejects an index the flush has not moved", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await ROUTER_APPROVAL.start(contract, ctx)).context;
    await expect(contract.circuits.sendApprove(queued, bytes(32, 0x5a))).rejects.toThrow(
      /Request not flushed/,
    );
  });

  it("rejects a second send of the same request", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, outIndex } = await approve(contract, ctx, ROUTER_APPROVAL);
    await expect(contract.circuits.sendApprove(sent, outIndex)).rejects.toThrow(
      /Request already sent/,
    );
  });

  it("rejects a flushed withdrawal's index, and sendWithdraw rejects a flushed approval's", async () => {
    const { contract, ctx } = await deployInitialised();
    const queuedApproval = (await ROUTER_APPROVAL.start(contract, ctx)).context;
    const queuedBoth = (await queueWithdraw(contract, queuedApproval, VALID_WITHDRAW)).context;
    const flushed = await flush(contract, queuedBoth, [APPROVE_INDEX, VALID_WITHDRAW.inIndex], []);
    const approveIndex = flushedRequestIndex(ledgerOf(flushed), Action.approve, APPROVE_INDEX);
    const withdrawIndex = flushedRequestIndex(
      ledgerOf(flushed),
      Action.withdraw,
      VALID_WITHDRAW.inIndex,
    );

    await expect(contract.circuits.sendApprove(flushed, withdrawIndex)).rejects.toThrow(
      /Wrong action/,
    );
    await expect(contract.circuits.sendWithdraw(flushed, approveIndex)).rejects.toThrow(
      /Wrong action/,
    );
  });
});

/**
 * Deploy + initialise + approve(ROUTER_APPROVAL): the arrange step of every
 * complete-approve test. Returns the sent approval's request id (the single
 * approve map index) alongside the threaded context.
 */
const approveRequested = async () => {
  const { contract, ctx } = await deployInitialised();
  const { context: next } = await approve(contract, ctx, ROUTER_APPROVAL);
  const index = toSignBidirectionalEventIndex(ledgerOf(next).bidirectionalApproveMap);
  const idHex = first(index.keys(), "approve request id");
  return { contract, ctx: next, requestId: requestIdBytes(idHex) };
};

/** One verdict the MPC can attest for an approval, and the output completeApprove is passed. */
interface ApproveVerdictCase {
  /** Test name, completing the sentence "closes <name> without minting". */
  name: string;
  /** The verdict the MPC attests. */
  outputKind: OutputKind;
  /** The output the MPC signs (empty under a failure kind). */
  signedOutput: Uint8Array;
  /** The output completeApprove is passed. */
  presentedOutput: Uint8Array;
}

const APPROVE_VERDICT_CASES: ApproveVerdictCase[] = [
  {
    name: "an approve that returned true",
    outputKind: OutputKind.executed,
    signedOutput: OUTPUT_SUCCESS,
    presentedOutput: OUTPUT_SUCCESS,
  },
  {
    name: "an approve that returned false",
    outputKind: OutputKind.executed,
    signedOutput: OUTPUT_FALSE,
    presentedOutput: OUTPUT_FALSE,
  },
  {
    name: "a reverted approve (failed)",
    outputKind: OutputKind.failed,
    signedOutput: OUTPUT_EMPTY,
    presentedOutput: OUTPUT_IGNORED,
  },
  {
    name: "an approve whose nonce another transaction took (unviable)",
    outputKind: OutputKind.unviable,
    signedOutput: OUTPUT_EMPTY,
    presentedOutput: OUTPUT_IGNORED,
  },
];

describe("completeApprove settle", () => {
  it.each(APPROVE_VERDICT_CASES)(
    "closes $name without minting and consumes the request",
    async ({ outputKind, signedOutput, presentedOutput }) => {
      const { contract, ctx, requestId } = await approveRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        signedOutput,
        ATTESTED_HEIGHT,
      );
      const attested =
        outputKind === OutputKind.executed
          ? await attest(contract, ctx, attestation, signedOutput)
          : await attestFailure(contract, ctx, attestation);

      const next = (await contract.circuits.completeApprove(attested, requestId, presentedOutput))
        .context;

      expect(shieldedMintsOf(next)).toEqual([]);
      const state = ledgerOf(next);
      expect(state.bidirectionalApproveMap.isEmpty()).toBe(true);
      expect(state.approveArgsMap.isEmpty()).toBe(true);
      expect(state.outputRequestBuffer.isEmpty()).toBe(true);
      expect(state.outputAttestationBuffer.isEmpty()).toBe(true);
      expect(state.evictionMap.isEmpty()).toBe(true);
    },
  );

  it.each(APPROVE_VERDICT_CASES)(
    "rejects a caller other than the deployer who started it, for $name",
    async ({ outputKind, signedOutput, presentedOutput }) => {
      const { contract, ctx, requestId } = await approveRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        signedOutput,
        ATTESTED_HEIGHT,
      );
      const attested =
        outputKind === OutputKind.executed
          ? await attest(contract, ctx, attestation, signedOutput)
          : await attestFailure(contract, ctx, attestation);

      await expect(
        contract.circuits.completeApprove(
          await strangerContext("completeApprove", attested),
          requestId,
          presentedOutput,
        ),
      ).rejects.toThrow(/Not the requester/);
    },
  );

  it("rejects a false output presented for an approve attested as returning true", async () => {
    const { contract, ctx, requestId } = await approveRequested();
    const attested = await attest(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
      OUTPUT_SUCCESS,
    );
    await expect(
      contract.circuits.completeApprove(attested, requestId, OUTPUT_FALSE),
    ).rejects.toThrow(/Output does not match the attestation/);
  });

  it.each([
    { name: "queueAttestation1", outputKind: OutputKind.executed, output: OUTPUT_SUCCESS },
    { name: "queueAttestation0", outputKind: OutputKind.failed, output: OUTPUT_EMPTY },
  ])(
    "$name refuses an attestation at or below the approval's lastSeen",
    async ({ outputKind, output }) => {
      const { contract, ctx, requestId } = await approveRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        output,
        EVM_START_HEIGHT,
      );
      await expect(
        outputKind === OutputKind.executed
          ? contract.circuits.queueAttestation1(ctx, attestation, output)
          : contract.circuits.queueAttestation0(ctx, attestation, output),
      ).rejects.toThrow(/Stale attestation/);
    },
  );

  it("settles once: a second completeApprove for the same request rejects", async () => {
    const { contract, ctx, requestId } = await approveRequested();
    const attested = await attest(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
      OUTPUT_SUCCESS,
    );
    const next = (await contract.circuits.completeApprove(attested, requestId, OUTPUT_SUCCESS))
      .context;
    await expect(
      contract.circuits.completeApprove(next, requestId, OUTPUT_SUCCESS),
    ).rejects.toThrow(/Request not sent/);
  });

  it("completeApprove rejects a withdrawal's request id, and completeWithdraw an approval's", async () => {
    const { contract, ctx, requestId: approveId } = await approveRequested();
    const { context: withdrawn } = await withdraw(contract, ctx, VALID_WITHDRAW);
    const withdrawId = requestIdBytes(
      first(
        toSignBidirectionalEventIndex(ledgerOf(withdrawn).bidirectionalWithdrawMap).keys(),
        "withdraw request id",
      ),
    );
    const approveQueued = (
      await contract.circuits.queueAttestation1(
        withdrawn,
        respond(
          MPC_RESPONSE_SECRET,
          approveId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
      )
    ).context;
    const bothQueued = (
      await contract.circuits.queueAttestation1(
        approveQueued,
        respond(
          MPC_RESPONSE_SECRET,
          withdrawId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
      )
    ).context;
    const attested = await flush(contract, bothQueued, [], [approveId, withdrawId]);

    await expect(
      contract.circuits.completeApprove(attested, withdrawId, OUTPUT_SUCCESS),
    ).rejects.toThrow(/Wrong action/);
    await expect(
      contract.circuits.completeWithdraw(attested, approveId, OUTPUT_SUCCESS, MINT_NONCE),
    ).rejects.toThrow(/Wrong action/);
  });
});

// ---- Replace nonce fixtures ----

/**
 * A replacement's `startReplaceNonce` arguments: the input index, and the sent
 * request whose vault account nonce it replaces, named by request id and action.
 * The gas is the vault's fee settings at a fixed 21000 limit, so the caller passes
 * none.
 */
interface ReplaceNonceCallArgs {
  inIndex: bigint;
  requestId: Uint8Array;
  action: Action;
}

/**
 * Known-good replace-nonce call args less the request id, which only a sent
 * withdrawal provides: every test spreads this with `requestId` from its arrange
 * step, usually `withdrawRequested`. Shared across tests: NEVER mutate.
 */
const VALID_REPLACE_NONCE: Omit<ReplaceNonceCallArgs, "requestId"> = {
  inIndex: 31n,
  action: Action.withdraw,
};

// The gas every replacement copies at start: the vault's default fees at the
// intrinsic gas of a plain transfer.
const REPLACEMENT_GAS = { ...DEFAULT_VAULT_GAS, gasLimit: 21_000n };

/** Queue a replacement: startReplaceNonce with its args in circuit order. */
const queueReplaceNonce = (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  args: ReplaceNonceCallArgs,
) => contract.circuits.startReplaceNonce(ctx, args.inIndex, args.requestId, args.action);

/** Queue, flush and send a replacement, returning the send's context and the request index. */
const replaceNonce = async (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  args: ReplaceNonceCallArgs,
) => {
  const queued = (await queueReplaceNonce(contract, ctx, args)).context;
  const outIndex = queuedRequestIndex(ledgerOf(queued), args.inIndex);
  const flushed = await flush(contract, queued, [args.inIndex], []);
  const sent = await contract.circuits.sendReplaceNonce(flushed, outIndex);
  return { context: sent.context, outIndex };
};

// ---- Replace nonce tests ----

describe("replace nonce round-trip", () => {
  it("stores an empty 21000-gas self-transfer at the replaced withdrawal's nonce, signed by the vault's account", async () => {
    const { contract, ctx, requestId: withdrawId } = await withdrawRequested();

    const { context: next, outIndex } = await replaceNonce(contract, ctx, {
      ...VALID_REPLACE_NONCE,
      requestId: withdrawId,
    });
    const state = next.callContext.currentQueryContext.state;

    const typedIndex = toSignBidirectionalEventIndex(ledger(state).bidirectionalReplaceNonceMap);
    const rawLedger = readSignetRequestsLedgerFromState(state, VAULT_REPLACE_NONCE_REQUESTS_PATH);
    expect(typedIndex.size).toBe(1);
    expect(rawLedger.requestsIndex).toEqual(typedIndex);
    const [idHex, record] = first(typedIndex.entries(), "indexed replacement request");

    // The notification names THIS vault and the bidirectionalReplaceNonceMap. The
    // context's events also hold the replaced withdrawal's notification, sent first.
    const notificationEvents = decodeSignetLogEvents(next.events, SIGNET_ADDRESS);
    expect(notificationEvents).toHaveLength(2);
    const notificationEvent = notificationEvents.at(-1);
    if (notificationEvent === undefined) throw new Error("no replacement notification event");
    expect(notificationEvent.name).toBe(SignetEventName.SignBidirectionalEvent);
    const notificationPost = decodeSignBidirectionalEventNotificationPayload(
      notificationEvent.payload,
    );
    expect(requestIdHex(notificationPost.requestId)).toBe(idHex);
    expect(decodeSignBidirectionalNotification(notificationPost.event)).toEqual({
      version: 1,
      callerAddress: bytesToHex(VAULT_ADDRESS_BYTES),
      requestsPath: [...VAULT_REPLACE_NONCE_REQUESTS_PATH],
    });

    // The vault's own account signs a zero-value transfer to itself at the
    // withdrawal's nonce, with no calldata.
    expect(record.sender).toEqual({ bytes: VAULT_ADDRESS_BYTES });
    expect(record.path).toEqual(asciiPadded("vault", 32));
    const { calldata, ...envelope } = record.txParams;
    expect(envelope).toEqual({
      to: VAULT_EVM,
      chainId: CHAIN_ID,
      nonce: 0n,
      ...REPLACEMENT_GAS,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
    });
    expect(calldata.is_some).toBe(false);
    expect(assembleCalldata(calldata)).toBe("0x");
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

    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));

    const { entry, lastSeen } = ledger(state).outputRequestBuffer.lookup(outIndex);
    expect(entry).toEqual({
      action: Action.replaceNonce,
      useNextVaultAccountNonce: false,
      evmNonce: 0n,
      inIndex: VALID_REPLACE_NONCE.inIndex,
      commitment: pureCircuits.ownershipCommitment(VALID_REPLACE_NONCE.inIndex, SECRET_KEY),
      argsHash: expect.any(Uint8Array) as Uint8Array,
    });
    expect(lastSeen).toBe(EVM_START_HEIGHT);
    expect(ledger(state).replaceNonceArgsMap.lookup(VALID_REPLACE_NONCE.inIndex)).toEqual({
      gas: REPLACEMENT_GAS,
    });
    expect(ledger(state).evictionMap.lookup(requestIdBytes(idHex))).toEqual(outIndex);
    expect(ledger(state).inputRequestBuffer.isEmpty()).toBe(true);
  });

  it("replaces a sent withdrawal's nonce without advancing the vault nonce", async () => {
    const { contract, ctx, requestId: withdrawId } = await withdrawRequested();

    const replaced = (
      await replaceNonce(contract, ctx, { ...VALID_REPLACE_NONCE, requestId: withdrawId })
    ).context;

    const state = ledgerOf(replaced);
    const nonceOf = (map: Parameters<typeof toSignBidirectionalEventIndex>[0]) =>
      first(toSignBidirectionalEventIndex(map).values(), "recorded request").txParams.nonce;
    expect(nonceOf(state.bidirectionalWithdrawMap)).toBe(0n);
    expect(nonceOf(state.bidirectionalReplaceNonceMap)).toBe(0n);
    expect(state.vaultAccountNonce).toBe(1n);
  });

  it("a withdrawal flushed beside a replacement still takes the next vault nonce", async () => {
    const { contract, ctx, requestId: withdrawId } = await withdrawRequested();
    const queuedReplacement = (
      await queueReplaceNonce(contract, ctx, { ...VALID_REPLACE_NONCE, requestId: withdrawId })
    ).context;
    const replacementIndex = queuedRequestIndex(
      ledgerOf(queuedReplacement),
      VALID_REPLACE_NONCE.inIndex,
    );
    const second = { ...VALID_WITHDRAW, inIndex: VALID_WITHDRAW.inIndex + 1n };
    const queuedBoth = (await queueWithdraw(contract, queuedReplacement, second)).context;

    const flushed = await flush(
      contract,
      queuedBoth,
      [VALID_REPLACE_NONCE.inIndex, second.inIndex],
      [],
    );

    const state = ledgerOf(flushed);
    const withdrawIndex = flushedRequestIndex(state, Action.withdraw, second.inIndex);
    expect(state.outputRequestBuffer.lookup(replacementIndex).entry.evmNonce).toBe(0n);
    expect(state.outputRequestBuffer.lookup(withdrawIndex).entry.evmNonce).toBe(1n);
    expect(state.vaultAccountNonce).toBe(2n);
  });

  it("a second replacement of the same nonce cannot be flushed while the first is open", async () => {
    const { contract, ctx, requestId: withdrawId } = await withdrawRequested();
    const replacement = { ...VALID_REPLACE_NONCE, requestId: withdrawId };
    const { context: sent, outIndex } = await replaceNonce(contract, ctx, replacement);
    const repeat = { ...replacement, inIndex: VALID_REPLACE_NONCE.inIndex + 1n };
    const queuedRepeat = (await queueReplaceNonce(contract, sent, repeat)).context;
    expect(queuedRequestIndex(ledgerOf(queuedRepeat), repeat.inIndex)).toEqual(outIndex);

    await expect(flush(contract, queuedRepeat, [repeat.inIndex], [])).rejects.toThrow(
      /Identical request open/,
    );
  });
});

describe("replace nonce validation", () => {
  it("rejects a request id the named action's map does not hold: another action's request", async () => {
    const { contract, ctx, requestId: withdrawId } = await withdrawRequested();
    await expect(
      queueReplaceNonce(contract, ctx, {
        ...VALID_REPLACE_NONCE,
        requestId: withdrawId,
        action: Action.approve,
      }),
    ).rejects.toThrow(/Request not sent/);
  });

  it("rejects a request id nothing was sent under", async () => {
    const { contract, ctx } = await withdrawRequested();
    await expect(
      queueReplaceNonce(contract, ctx, { ...VALID_REPLACE_NONCE, requestId: bytes(32, 0x5a) }),
    ).rejects.toThrow(/Request not sent/);
  });

  it("rejects a queued withdrawal the flush has not moved, and one flushed but not sent", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    const flushed = await flush(contract, queued, [VALID_WITHDRAW.inIndex], []);
    const unsent = { ...VALID_REPLACE_NONCE, requestId: bytes(32, 0x5a) };
    await expect(queueReplaceNonce(contract, queued, unsent)).rejects.toThrow(/Request not sent/);
    await expect(queueReplaceNonce(contract, flushed, unsent)).rejects.toThrow(/Request not sent/);
  });

  it("rejects a settled withdrawal: its complete removed the event that held the nonce", async () => {
    const { contract, ctx, requestId: withdrawId } = await withdrawRequested();
    const attested = await attest(
      contract,
      ctx,
      respond(
        MPC_RESPONSE_SECRET,
        withdrawId,
        OutputKind.executed,
        OUTPUT_SUCCESS,
        ATTESTED_HEIGHT,
      ),
      OUTPUT_SUCCESS,
    );
    const settled = (
      await contract.circuits.completeWithdraw(attested, withdrawId, OUTPUT_SUCCESS, MINT_NONCE)
    ).context;
    await expect(
      queueReplaceNonce(contract, settled, { ...VALID_REPLACE_NONCE, requestId: withdrawId }),
    ).rejects.toThrow(/Request not sent/);
  });

  it("is deployer-gated: a stranger is refused and nothing is queued", async () => {
    const { contract, ctx, requestId: withdrawId } = await withdrawRequested();
    const stranger = await strangerContext("startReplaceNonce", ctx);

    await expect(
      queueReplaceNonce(contract, stranger, { ...VALID_REPLACE_NONCE, requestId: withdrawId }),
    ).rejects.toThrow(/Not the deployer/);
    expect(ledgerOf(ctx).inputRequestBuffer.isEmpty()).toBe(true);
    expect(ledgerOf(ctx).replaceNonceArgsMap.isEmpty()).toBe(true);
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      queueReplaceNonce(contract, ctx, { ...VALID_REPLACE_NONCE, requestId: bytes(32, 0x5a) }),
    ).rejects.toThrow(/Not initialised/);
  });

  it("rejects an index the input buffer holds", async () => {
    const { contract, ctx, requestId: withdrawId } = await withdrawRequested();
    const replacement = { ...VALID_REPLACE_NONCE, requestId: withdrawId };
    const queued = (await queueReplaceNonce(contract, ctx, replacement)).context;
    await expect(queueReplaceNonce(contract, queued, replacement)).rejects.toThrow(
      /Index already in use/,
    );
  });

  it("rejects an index another action's queued request holds", async () => {
    const { contract, ctx, requestId: withdrawId } = await withdrawRequested();
    const second = { ...VALID_WITHDRAW, inIndex: VALID_WITHDRAW.inIndex + 1n };
    const queued = (await queueWithdraw(contract, ctx, second)).context;
    await expect(
      queueReplaceNonce(contract, queued, {
        ...VALID_REPLACE_NONCE,
        requestId: withdrawId,
        inIndex: second.inIndex,
      }),
    ).rejects.toThrow(/Index already in use/);
  });

  it("rejects an index the flush freed while its args stay in replaceNonceArgsMap", async () => {
    const { contract, ctx, requestId: withdrawId } = await withdrawRequested();
    const replacement = { ...VALID_REPLACE_NONCE, requestId: withdrawId };
    const queued = (await queueReplaceNonce(contract, ctx, replacement)).context;
    const flushed = await flush(contract, queued, [VALID_REPLACE_NONCE.inIndex], []);
    expect(ledgerOf(flushed).inputRequestBuffer.member(VALID_REPLACE_NONCE.inIndex)).toBe(false);
    await expect(queueReplaceNonce(contract, flushed, replacement)).rejects.toThrow(
      /Index already in use/,
    );
  });
});

describe("sendReplaceNonce", () => {
  it("is permissionless: a stranger sends the deployer's replacement as queued", async () => {
    const { contract, ctx, requestId: withdrawId } = await withdrawRequested();
    const queued = (
      await queueReplaceNonce(contract, ctx, { ...VALID_REPLACE_NONCE, requestId: withdrawId })
    ).context;
    const outIndex = queuedRequestIndex(ledgerOf(queued), VALID_REPLACE_NONCE.inIndex);
    const flushed = await flush(contract, queued, [VALID_REPLACE_NONCE.inIndex], []);

    const sent = (
      await contract.circuits.sendReplaceNonce(
        await strangerContext("sendReplaceNonce", flushed),
        outIndex,
      )
    ).context;
    const index = toSignBidirectionalEventIndex(ledgerOf(sent).bidirectionalReplaceNonceMap);
    expect(index.size).toBe(1);
    const record = first(index.values(), "replacement request");
    expect(record.path).toEqual(asciiPadded("vault", 32));
    expect(record.txParams.nonce).toBe(0n);
  });

  it("rejects an index the flush has not moved", async () => {
    const { contract, ctx, requestId: withdrawId } = await withdrawRequested();
    const queued = (
      await queueReplaceNonce(contract, ctx, { ...VALID_REPLACE_NONCE, requestId: withdrawId })
    ).context;
    const outIndex = queuedRequestIndex(ledgerOf(queued), VALID_REPLACE_NONCE.inIndex);
    await expect(contract.circuits.sendReplaceNonce(queued, outIndex)).rejects.toThrow(
      /Request not flushed/,
    );
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(contract.circuits.sendReplaceNonce(ctx, bytes(32, 0x5a))).rejects.toThrow(
      /Not initialised/,
    );
  });

  it("rejects a second send of the same request", async () => {
    const { contract, ctx, requestId: withdrawId } = await withdrawRequested();
    const { context: sent, outIndex } = await replaceNonce(contract, ctx, {
      ...VALID_REPLACE_NONCE,
      requestId: withdrawId,
    });
    await expect(contract.circuits.sendReplaceNonce(sent, outIndex)).rejects.toThrow(
      /Request already sent/,
    );
  });

  it("rejects a flushed withdrawal's index, and sendWithdraw rejects a flushed replacement's", async () => {
    const { contract, ctx, requestId: withdrawId } = await withdrawRequested();
    const queuedReplacement = (
      await queueReplaceNonce(contract, ctx, { ...VALID_REPLACE_NONCE, requestId: withdrawId })
    ).context;
    const replacementIndex = queuedRequestIndex(
      ledgerOf(queuedReplacement),
      VALID_REPLACE_NONCE.inIndex,
    );
    const second = { ...VALID_WITHDRAW, inIndex: VALID_WITHDRAW.inIndex + 1n };
    const queuedBoth = (await queueWithdraw(contract, queuedReplacement, second)).context;
    const flushed = await flush(
      contract,
      queuedBoth,
      [VALID_REPLACE_NONCE.inIndex, second.inIndex],
      [],
    );
    const withdrawIndex = flushedRequestIndex(ledgerOf(flushed), Action.withdraw, second.inIndex);

    await expect(contract.circuits.sendReplaceNonce(flushed, withdrawIndex)).rejects.toThrow(
      /Wrong action/,
    );
    await expect(contract.circuits.sendWithdraw(flushed, replacementIndex)).rejects.toThrow(
      /Wrong action/,
    );
  });
});

/**
 * withdrawRequested, then replaceNonce of that withdrawal under VALID_REPLACE_NONCE:
 * the arrange step of every complete-replace-nonce test. Returns the sent
 * replacement's request id (the single replace-nonce map index) alongside the
 * threaded context.
 */
const replaceNonceRequested = async () => {
  const { contract, ctx, requestId: withdrawId } = await withdrawRequested();
  const { context: next } = await replaceNonce(contract, ctx, {
    ...VALID_REPLACE_NONCE,
    requestId: withdrawId,
  });
  const index = toSignBidirectionalEventIndex(ledgerOf(next).bidirectionalReplaceNonceMap);
  const idHex = first(index.keys(), "replacement request id");
  return { contract, ctx: next, requestId: requestIdBytes(idHex) };
};

/** Arrange a flushed attestation of the given verdict for the requested replacement. */
interface ReplaceNonceVerdictCase {
  /** Test name, completing the sentence "<name>: closes the request". */
  name: string;
  /** The verdict the MPC attests. */
  outputKind: OutputKind;
  /** The output the MPC signs (empty under a failure kind). */
  signedOutput: Uint8Array;
  /** The output completeReplaceNonce is passed. */
  presentedOutput: Uint8Array;
}

const REPLACE_NONCE_VERDICT_CASES: ReplaceNonceVerdictCase[] = [
  {
    name: "an executed self-transfer, attested with the synthesised success byte",
    outputKind: OutputKind.executed,
    signedOutput: OUTPUT_SUCCESS,
    presentedOutput: OUTPUT_SUCCESS,
  },
  {
    name: "a reverted self-transfer (failed)",
    outputKind: OutputKind.failed,
    signedOutput: OUTPUT_EMPTY,
    presentedOutput: OUTPUT_IGNORED,
  },
  {
    name: "a self-transfer whose nonce another transaction took (unviable)",
    outputKind: OutputKind.unviable,
    signedOutput: OUTPUT_EMPTY,
    presentedOutput: OUTPUT_IGNORED,
  },
];

describe("completeReplaceNonce settle", () => {
  it.each(REPLACE_NONCE_VERDICT_CASES)(
    "$name: closes the request and mints nothing",
    async ({ outputKind, signedOutput, presentedOutput }) => {
      const { contract, ctx, requestId } = await replaceNonceRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        signedOutput,
        ATTESTED_HEIGHT,
      );
      const attested =
        outputKind === OutputKind.executed
          ? await attest(contract, ctx, attestation, signedOutput)
          : await attestFailure(contract, ctx, attestation);

      const next = (
        await contract.circuits.completeReplaceNonce(attested, requestId, presentedOutput)
      ).context;

      expect(shieldedMintsOf(next)).toEqual([]);
      const state = ledgerOf(next);
      expect(state.bidirectionalReplaceNonceMap.isEmpty()).toBe(true);
      expect(state.replaceNonceArgsMap.isEmpty()).toBe(true);
      expect(state.outputAttestationBuffer.isEmpty()).toBe(true);
      expect(state.evictionMap.member(requestId)).toBe(false);
      // The replaced withdrawal stays open until its own attestation settles it.
      expect(state.outputRequestBuffer.size()).toBe(1n);
      expect(state.evictionMap.size()).toBe(1n);
    },
  );

  it.each(REPLACE_NONCE_VERDICT_CASES)(
    "rejects a caller other than the deployer who started it: $name",
    async ({ outputKind, signedOutput, presentedOutput }) => {
      const { contract, ctx, requestId } = await replaceNonceRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        signedOutput,
        ATTESTED_HEIGHT,
      );
      const attested =
        outputKind === OutputKind.executed
          ? await attest(contract, ctx, attestation, signedOutput)
          : await attestFailure(contract, ctx, attestation);

      await expect(
        contract.circuits.completeReplaceNonce(
          await strangerContext("completeReplaceNonce", attested),
          requestId,
          presentedOutput,
        ),
      ).rejects.toThrow(/Not the requester/);
    },
  );

  it("rejects an output other than the one the execution was attested with", async () => {
    const { contract, ctx, requestId } = await replaceNonceRequested();
    const attested = await attest(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
      OUTPUT_SUCCESS,
    );
    await expect(
      contract.circuits.completeReplaceNonce(attested, requestId, OUTPUT_FALSE),
    ).rejects.toThrow(/Output does not match the attestation/);
  });

  it.each([
    { name: "queueAttestation1", outputKind: OutputKind.executed, output: OUTPUT_SUCCESS },
    { name: "queueAttestation0", outputKind: OutputKind.unviable, output: OUTPUT_EMPTY },
  ])(
    "$name refuses an attestation at or below the replacement's lastSeen",
    async ({ outputKind, output }) => {
      const { contract, ctx, requestId } = await replaceNonceRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        output,
        EVM_START_HEIGHT,
      );
      await expect(
        outputKind === OutputKind.executed
          ? contract.circuits.queueAttestation1(ctx, attestation, output)
          : contract.circuits.queueAttestation0(ctx, attestation, output),
      ).rejects.toThrow(/Stale attestation/);
    },
  );

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.completeReplaceNonce(ctx, bytes(32, 0x5a), OUTPUT_IGNORED),
    ).rejects.toThrow(/Not initialised/);
  });

  it("settles once: a second completeReplaceNonce for the same request rejects", async () => {
    const { contract, ctx, requestId } = await replaceNonceRequested();
    const attested = await attest(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
      OUTPUT_SUCCESS,
    );
    const next = (await contract.circuits.completeReplaceNonce(attested, requestId, OUTPUT_SUCCESS))
      .context;
    await expect(
      contract.circuits.completeReplaceNonce(next, requestId, OUTPUT_SUCCESS),
    ).rejects.toThrow(/Request not sent/);
  });

  it("the replaced withdrawal settles through its unviable attestation and re-mints", async () => {
    const { contract, ctx, requestId: withdrawId } = await withdrawRequested();
    const replaced = (
      await replaceNonce(contract, ctx, { ...VALID_REPLACE_NONCE, requestId: withdrawId })
    ).context;
    const replacementId = requestIdBytes(
      first(
        toSignBidirectionalEventIndex(ledgerOf(replaced).bidirectionalReplaceNonceMap).keys(),
        "replacement request id",
      ),
    );
    const replacementMined = await attest(
      contract,
      replaced,
      respond(
        MPC_RESPONSE_SECRET,
        replacementId,
        OutputKind.executed,
        OUTPUT_SUCCESS,
        ATTESTED_HEIGHT,
      ),
      OUTPUT_SUCCESS,
    );
    const replacementClosed = (
      await contract.circuits.completeReplaceNonce(replacementMined, replacementId, OUTPUT_SUCCESS)
    ).context;
    // The MPC attests the replaced withdrawal unviable at the replacement's block.
    const withdrawUnviable = await attestFailure(
      contract,
      replacementClosed,
      respond(MPC_RESPONSE_SECRET, withdrawId, OutputKind.unviable, OUTPUT_EMPTY, ATTESTED_HEIGHT),
    );

    const settled = (
      await contract.circuits.completeWithdraw(
        withdrawUnviable,
        withdrawId,
        OUTPUT_IGNORED,
        MINT_NONCE,
      )
    ).context;

    expect(shieldedMintsOf(settled)).toEqual([[VAULT_TOKEN_MINT_KEY, AMOUNT]]);
    expect(coinsMinted(withdrawUnviable, settled)).toEqual([
      {
        coinInfo: { nonce: MINT_NONCE, color: VAULT_TOKEN_COLOR, value: AMOUNT },
        recipient: TO_CALLER,
      },
    ]);
    expect(ledgerOf(settled).outputRequestBuffer.isEmpty()).toBe(true);
  });

  it("completeReplaceNonce rejects a withdrawal's request id, and completeWithdraw a replacement's", async () => {
    const { contract, ctx, requestId: withdrawId } = await withdrawRequested();
    const replaced = (
      await replaceNonce(contract, ctx, { ...VALID_REPLACE_NONCE, requestId: withdrawId })
    ).context;
    const replacementId = requestIdBytes(
      first(
        toSignBidirectionalEventIndex(ledgerOf(replaced).bidirectionalReplaceNonceMap).keys(),
        "replacement request id",
      ),
    );
    const withdrawQueued = (
      await contract.circuits.queueAttestation1(
        replaced,
        respond(
          MPC_RESPONSE_SECRET,
          withdrawId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
      )
    ).context;
    const bothQueued = (
      await contract.circuits.queueAttestation1(
        withdrawQueued,
        respond(
          MPC_RESPONSE_SECRET,
          replacementId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
      )
    ).context;
    const attested = await flush(contract, bothQueued, [], [withdrawId, replacementId]);

    await expect(
      contract.circuits.completeReplaceNonce(attested, withdrawId, OUTPUT_SUCCESS),
    ).rejects.toThrow(/Wrong action/);
    await expect(
      contract.circuits.completeWithdraw(attested, replacementId, OUTPUT_SUCCESS, MINT_NONCE),
    ).rejects.toThrow(/Wrong action/);
  });
});

// ---- Swap fixtures ----

// The exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))
// selector: the TS mirror of the literal `Bytes [0x50, 0x23, 0xb4, 0xdf]` hardcoded
// in erc20-vault.compact.
const EXACT_OUTPUT_SINGLE_SELECTOR = new Uint8Array([0x50, 0x23, 0xb4, 0xdf]);

// The swap's schemas at their EXACT contract-declared widths: the round-trip test
// below is the lockstep check for these mirrors.
const EXPECTED_SWAP_OUTPUT_SCHEMA = asciiPadded('[{"name":"amountIn","type":"uint256"}]', 38);
const EXPECTED_SWAP_RESPOND_SCHEMA = asciiPadded('[{"name":"amountIn","type":"uint64"}]', 37);

// The vault token colour of ERC20_OUT, the ERC20 a swap buys.
const VAULT_TOKEN_COLOR_OUT = hexToBytes(
  rawTokenType(pureCircuits.vaultTokenDomainSeparator(ERC20_OUT), VAULT_ADDRESS),
);

const SWAP_FEE = 500n;
const SWAP_AMOUNT_OUT = 995_000n;
// The spend cap, which is the surrendered coin's value.
const SWAP_AMOUNT_IN_MAX = AMOUNT;
// The input the attested swap spent, below the cap.
const SWAP_AMOUNT_IN_SPENT = 990_000n;

/**
 * A swap's `startSwap` arguments: the input index, the `SwapRequest` and the
 * surrendered coin. The nonce and gas are the vault's, so the caller passes neither.
 */
interface SwapCallArgs {
  inIndex: bigint;
  swap: {
    erc20AddressIn: Uint8Array;
    erc20AddressOut: Uint8Array;
    fee: bigint;
    amountOut: bigint;
    amountInMaximum: bigint;
  };
  coin: ReturnType<typeof vaultCoin>;
}

/**
 * Known-good swap call args, the base every test varies from.
 * Shared across tests: NEVER mutate. Build a variation as an explicit spread
 * of this base with the delta inline (see {@link SWAP_REJECTION_CASES}).
 */
const VALID_SWAP: SwapCallArgs = {
  inIndex: 41n,
  swap: {
    erc20AddressIn: ERC20,
    erc20AddressOut: ERC20_OUT,
    fee: SWAP_FEE,
    amountOut: SWAP_AMOUNT_OUT,
    amountInMaximum: SWAP_AMOUNT_IN_MAX,
  },
  coin: vaultCoin(SWAP_AMOUNT_IN_MAX),
};

// The gas every swap copies at start: the vault's default fees at its swap gas limit.
const DEFAULT_SWAP_GAS = { ...DEFAULT_VAULT_GAS, gasLimit: 700_000n };

/** Queue a swap: startSwap with its args in circuit order. */
const queueSwap = (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  args: SwapCallArgs,
) => contract.circuits.startSwap(ctx, args.inIndex, args.swap, args.coin);

/** Queue, flush and send a swap, returning the send's context and the request index. */
const swap = async (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  args: SwapCallArgs,
) => {
  const queued = (await queueSwap(contract, ctx, args)).context;
  const flushed = await flush(contract, queued, [args.inIndex], []);
  const outIndex = flushedRequestIndex(ledgerOf(flushed), Action.swap, args.inIndex);
  const sent = await contract.circuits.sendSwap(flushed, outIndex);
  return { context: sent.context, outIndex };
};

// ---- Swap tests ----

describe("swap round-trip", () => {
  it("burns erc20AddressIn and stores a vault-path exactOutputSingle event built from the flushed entry and its args", async () => {
    const { contract, ctx } = await deployInitialised();

    const { context: next, outIndex } = await swap(contract, ctx, VALID_SWAP);
    const state = next.callContext.currentQueryContext.state;

    const typedIndex = toSignBidirectionalEventIndex(ledger(state).bidirectionalSwapMap);
    const rawLedger = readSignetRequestsLedgerFromState(state, VAULT_SWAP_REQUESTS_PATH);
    expect(typedIndex.size).toBe(1);
    expect(rawLedger.requestsIndex).toEqual(typedIndex);
    const [idHex, record] = first(typedIndex.entries(), "indexed swap request");

    // The notification names THIS vault and the bidirectionalSwapMap.
    const notificationEvent = first(
      decodeSignetLogEvents(next.events, SIGNET_ADDRESS),
      "signet notification event",
    );
    expect(notificationEvent.name).toBe(SignetEventName.SignBidirectionalEvent);
    const notificationPost = decodeSignBidirectionalEventNotificationPayload(
      notificationEvent.payload,
    );
    expect(requestIdHex(notificationPost.requestId)).toBe(idHex);
    expect(decodeSignBidirectionalNotification(notificationPost.event)).toEqual({
      version: 1,
      callerAddress: bytesToHex(VAULT_ADDRESS_BYTES),
      requestsPath: [...VAULT_SWAP_REQUESTS_PATH],
    });

    // The vault's own account signs a call to the pinned router, at the first nonce
    // the flush assigned and the swap gas copied at start.
    expect(record.sender).toEqual({ bytes: VAULT_ADDRESS_BYTES });
    expect(record.path).toEqual(asciiPadded("vault", 32));
    const { calldata, ...envelope } = record.txParams;
    expect(envelope).toEqual({
      to: ROUTER,
      chainId: CHAIN_ID,
      nonce: 0n,
      ...DEFAULT_SWAP_GAS,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
    });
    expect(record.executionDest).toEqual(EXPECTED_ROUTING.executionDest);
    expect(record.keyVersion).toBe(MPC_KEY_VERSION);
    expect(record.algo).toBe(EXPECTED_ROUTING.algo);
    expect(record.signatureDest).toBe(EXPECTED_ROUTING.signatureDest);
    expect(record.params).toEqual(EXPECTED_ROUTING.params);
    expect(record.txParamType).toBe(TxParamType.evmType2);
    expect(record.outputDeserializationSchema).toEqual(EXPECTED_SWAP_OUTPUT_SCHEMA);
    expect(record.respondSerializationSchema).toEqual(EXPECTED_SWAP_RESPOND_SCHEMA);

    // Contract-built calldata: exactOutputSingle((erc20AddressIn, erc20AddressOut, fee,
    // recipient = the vault's EVM account, amountOut, amountInMaximum, no price limit)).
    expect(calldata.is_some).toBe(true);
    expect(calldata.value.selector).toEqual(EXACT_OUTPUT_SINGLE_SELECTOR);
    expect(calldata.value.noWords).toBe(7n);
    expect(calldata.value.words).toEqual([
      evmAddressAbiWord(ERC20),
      evmAddressAbiWord(ERC20_OUT),
      numericAbiWord(SWAP_FEE),
      evmAddressAbiWord(VAULT_EVM),
      numericAbiWord(SWAP_AMOUNT_OUT),
      numericAbiWord(SWAP_AMOUNT_IN_MAX),
      numericAbiWord(0n),
    ]);

    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));

    const { entry, lastSeen } = ledger(state).outputRequestBuffer.lookup(outIndex);
    expect(entry).toEqual({
      action: Action.swap,
      useNextVaultAccountNonce: true,
      evmNonce: 0n,
      inIndex: VALID_SWAP.inIndex,
      commitment: pureCircuits.ownershipCommitment(VALID_SWAP.inIndex, SECRET_KEY),
      argsHash: expect.any(Uint8Array) as Uint8Array,
    });
    expect(lastSeen).toBe(EVM_START_HEIGHT);
    expect(ledger(state).swapArgsMap.lookup(VALID_SWAP.inIndex)).toEqual({
      request: VALID_SWAP.swap,
      gas: DEFAULT_SWAP_GAS,
    });
    expect(ledger(state).evictionMap.lookup(requestIdBytes(idHex))).toEqual(outIndex);
    expect(ledger(state).inputRequestBuffer.isEmpty()).toBe(true);
    expect(ledger(state).vaultAccountNonce).toBe(1n);
  });

  it("start burns the surrendered coin: received by the vault, then paid in full to the burn address", async () => {
    const { contract, ctx } = await deployInitialised();

    const started = (await queueSwap(contract, ctx, VALID_SWAP)).context;
    const zswap = zswapState(started);

    expect(zswap.inputs).toHaveLength(1);
    const consumed = first(zswap.inputs, "consumed coin");
    expect(consumed.color).toEqual(VAULT_TOKEN_COLOR);
    expect(consumed.value).toBe(SWAP_AMOUNT_IN_MAX);

    expect(zswap.outputs).toHaveLength(2);
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
    const burnOutput = first(
      zswap.outputs.filter((output) => output.recipient.is_left),
      "burn output",
    );
    expect(burnOutput.coinInfo.color).toEqual(VAULT_TOKEN_COLOR);
    expect(burnOutput.coinInfo.value).toBe(SWAP_AMOUNT_IN_MAX);
    expect(burnOutput.recipient.left.bytes).toEqual(BURN_ADDRESS_BYTES);
  });

  it("a swap and a withdrawal flushed together take consecutive vault nonces in slot order", async () => {
    const { contract, ctx } = await deployInitialised();
    const queuedSwap = (await queueSwap(contract, ctx, VALID_SWAP)).context;
    const queuedBoth = (await queueWithdraw(contract, queuedSwap, VALID_WITHDRAW)).context;

    const flushed = await flush(
      contract,
      queuedBoth,
      [VALID_WITHDRAW.inIndex, VALID_SWAP.inIndex],
      [],
    );

    const state = ledgerOf(flushed);
    const nonceOf = (action: Action, inIndex: bigint) =>
      state.outputRequestBuffer.lookup(flushedRequestIndex(state, action, inIndex)).entry.evmNonce;
    expect(nonceOf(Action.withdraw, VALID_WITHDRAW.inIndex)).toBe(0n);
    expect(nonceOf(Action.swap, VALID_SWAP.inIndex)).toBe(1n);
    expect(state.vaultAccountNonce).toBe(2n);
  });
});

/** One row of the swap rejection table: full inputs to expected error. */
interface SwapRejectionCase {
  /** Test name, completing the sentence "rejects <name>". */
  name: string;
  /** Complete call args passed to startSwap. */
  args: SwapCallArgs;
  /** Error startSwap must throw. */
  throws: RegExp;
}

const SWAP_REJECTION_CASES: SwapRejectionCase[] = [
  {
    name: "a zero input ERC20 address",
    args: { ...VALID_SWAP, swap: { ...VALID_SWAP.swap, erc20AddressIn: ZERO_ADDRESS } },
    throws: /erc20AddressIn cannot be zero/,
  },
  {
    name: "a zero output ERC20 address",
    args: { ...VALID_SWAP, swap: { ...VALID_SWAP.swap, erc20AddressOut: ZERO_ADDRESS } },
    throws: /erc20AddressOut not allowed/,
  },
  {
    name: "an output ERC20 the vault does not allow",
    args: { ...VALID_SWAP, swap: { ...VALID_SWAP.swap, erc20AddressOut: UNLISTED_ERC20 } },
    throws: /erc20AddressOut not allowed/,
  },
  {
    name: "a zero amountOut",
    args: { ...VALID_SWAP, swap: { ...VALID_SWAP.swap, amountOut: 0n } },
    throws: /amountOut must be positive/,
  },
  {
    name: "a zero amountInMaximum",
    args: {
      ...VALID_SWAP,
      swap: { ...VALID_SWAP.swap, amountInMaximum: 0n },
      coin: vaultCoin(0n),
    },
    throws: /amountInMaximum must be positive/,
  },
  {
    name: "an amountOut above Uint<64> max (unmintable)",
    args: { ...VALID_SWAP, swap: { ...VALID_SWAP.swap, amountOut: UINT64_MAX + 1n } },
    throws: /amountOut exceeds Uint<64> max/,
  },
  {
    name: "an amountInMaximum above Uint<64> max (unrefundable)",
    args: {
      ...VALID_SWAP,
      swap: { ...VALID_SWAP.swap, amountInMaximum: UINT64_MAX + 1n },
      coin: vaultCoin(UINT64_MAX + 1n),
    },
    throws: /amountInMaximum exceeds Uint<64> max/,
  },
  {
    name: "a coin of the output ERC20's vault token",
    args: { ...VALID_SWAP, coin: vaultCoin(SWAP_AMOUNT_IN_MAX, VAULT_TOKEN_COLOR_OUT) },
    throws: /Coin is not the vault token for erc20AddressIn/,
  },
  {
    name: "a coin whose value differs from amountInMaximum",
    args: { ...VALID_SWAP, coin: vaultCoin(SWAP_AMOUNT_IN_MAX + 1n) },
    throws: /Coin value must equal amountInMaximum/,
  },
];

describe("swap validation", () => {
  it.each(SWAP_REJECTION_CASES)("rejects $name", async ({ args, throws }) => {
    const { contract, ctx } = await deployInitialised();
    await expect(queueSwap(contract, ctx, args)).rejects.toThrow(throws);
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(queueSwap(contract, ctx, VALID_SWAP)).rejects.toThrow(/Not initialised/);
  });

  it("accepts an output ERC20 once addAllowedToken allows it", async () => {
    const { contract, ctx } = await deployInitialised();
    const unlisted = {
      ...VALID_SWAP,
      swap: { ...VALID_SWAP.swap, erc20AddressOut: UNLISTED_ERC20 },
    };
    await expect(queueSwap(contract, ctx, unlisted)).rejects.toThrow(/erc20AddressOut not allowed/);

    const allowed = (await contract.circuits.addAllowedToken(ctx, UNLISTED_ERC20)).context;
    const queued = (await queueSwap(contract, allowed, unlisted)).context;
    expect(ledgerOf(queued).swapArgsMap.member(unlisted.inIndex)).toBe(true);
  });

  it("rejects an index the input buffer holds", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueSwap(contract, ctx, VALID_SWAP)).context;
    await expect(queueSwap(contract, queued, VALID_SWAP)).rejects.toThrow(/Index already in use/);
  });

  it("rejects an index another action's queued request holds", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    await expect(
      queueSwap(contract, queued, { ...VALID_SWAP, inIndex: VALID_WITHDRAW.inIndex }),
    ).rejects.toThrow(/Index already in use/);
  });

  it("rejects an index the flush freed while its args stay in swapArgsMap", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueSwap(contract, ctx, VALID_SWAP)).context;
    const flushed = await flush(contract, queued, [VALID_SWAP.inIndex], []);
    expect(ledgerOf(flushed).inputRequestBuffer.member(VALID_SWAP.inIndex)).toBe(false);
    await expect(queueSwap(contract, flushed, VALID_SWAP)).rejects.toThrow(/Index already in use/);
  });
});

describe("sendSwap", () => {
  it("is permissionless: a stranger sends the swapper's request as queued", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueSwap(contract, ctx, VALID_SWAP)).context;
    const flushed = await flush(contract, queued, [VALID_SWAP.inIndex], []);
    const outIndex = flushedRequestIndex(ledgerOf(flushed), Action.swap, VALID_SWAP.inIndex);

    const sent = (
      await contract.circuits.sendSwap(await strangerContext("sendSwap", flushed), outIndex)
    ).context;
    const index = toSignBidirectionalEventIndex(ledgerOf(sent).bidirectionalSwapMap);
    expect(index.size).toBe(1);
    const record = first(index.values(), "swap request");
    expect(record.path).toEqual(asciiPadded("vault", 32));
    expect(record.txParams.nonce).toBe(0n);
  });

  it("rejects an index the flush has not moved", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueSwap(contract, ctx, VALID_SWAP)).context;
    await expect(contract.circuits.sendSwap(queued, bytes(32, 0x5a))).rejects.toThrow(
      /Request not flushed/,
    );
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(contract.circuits.sendSwap(ctx, bytes(32, 0x5a))).rejects.toThrow(
      /Not initialised/,
    );
  });

  it("rejects a second send of the same request", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, outIndex } = await swap(contract, ctx, VALID_SWAP);
    await expect(contract.circuits.sendSwap(sent, outIndex)).rejects.toThrow(
      /Request already sent/,
    );
  });

  it("rejects a flushed withdrawal's index, and sendWithdraw rejects a flushed swap's", async () => {
    const { contract, ctx } = await deployInitialised();
    const queuedSwap = (await queueSwap(contract, ctx, VALID_SWAP)).context;
    const queuedBoth = (await queueWithdraw(contract, queuedSwap, VALID_WITHDRAW)).context;
    const flushed = await flush(
      contract,
      queuedBoth,
      [VALID_SWAP.inIndex, VALID_WITHDRAW.inIndex],
      [],
    );
    const swapIndex = flushedRequestIndex(ledgerOf(flushed), Action.swap, VALID_SWAP.inIndex);
    const withdrawIndex = flushedRequestIndex(
      ledgerOf(flushed),
      Action.withdraw,
      VALID_WITHDRAW.inIndex,
    );

    await expect(contract.circuits.sendSwap(flushed, withdrawIndex)).rejects.toThrow(
      /Wrong action/,
    );
    await expect(contract.circuits.sendWithdraw(flushed, swapIndex)).rejects.toThrow(
      /Wrong action/,
    );
  });
});

/**
 * Deploy + initialise + swap(VALID_SWAP): the arrange step of every complete-swap
 * test. Returns the sent swap's request id (the single swap map index) alongside the
 * threaded context.
 */
const swapRequested = async () => {
  const { contract, ctx } = await deployInitialised();
  const { context: next } = await swap(contract, ctx, VALID_SWAP);
  const index = toSignBidirectionalEventIndex(ledgerOf(next).bidirectionalSwapMap);
  const idHex = first(index.keys(), "swap request id");
  return { contract, ctx: next, requestId: requestIdBytes(idHex) };
};

/**
 * An executed swap's attested output: the spent amountIn packed by the swap's
 * respond schema, read from the COMPILED circuit, as the MPC packs it.
 */
const swapOutput = (amountIn: bigint): Uint8Array =>
  serializeRespondOutput(pureCircuits.swapRespondSchema(), { amountIn });

const OUTPUT_SWAP = swapOutput(SWAP_AMOUNT_IN_SPENT);

// completeSwap takes an 8-byte output on every verdict and ignores it on a failure.
const OUTPUT_SWAP_IGNORED = new Uint8Array(8);

// The second caller-chosen nonce completeSwap takes, for the change coin.
const CHANGE_NONCE = bytes(32, 0x3f);

// The mint key of the bought ERC20's vault token. The sold ERC20's is VAULT_TOKEN_MINT_KEY.
const VAULT_TOKEN_OUT_MINT_KEY = bytesToHex(pureCircuits.vaultTokenDomainSeparator(ERC20_OUT));

/** Arrange a flushed attestation of the given verdict for the requested swap. */
interface SwapVerdictCase {
  /** Test name, completing the sentence "<name> and consumes the request". */
  name: string;
  /** The verdict the MPC attests. */
  outputKind: OutputKind;
  /** The output the MPC signs (empty under a failure kind). */
  signedOutput: Uint8Array;
  /** The output completeSwap is passed. */
  presentedOutput: Uint8Array;
  /** The mints completeSwap must request of the ledger: mint key to amount. */
  mints: [string, bigint][];
  /** The coins those mints create, each with its nonce, colour, value and recipient. */
  coins: EncodedZswapLocalState["outputs"];
}

const SWAP_VERDICT_CASES: SwapVerdictCase[] = [
  {
    name: "an executed swap mints amountOut of the bought token and the unspent change",
    outputKind: OutputKind.executed,
    signedOutput: OUTPUT_SWAP,
    presentedOutput: OUTPUT_SWAP,
    mints: [
      [VAULT_TOKEN_OUT_MINT_KEY, SWAP_AMOUNT_OUT],
      [VAULT_TOKEN_MINT_KEY, SWAP_AMOUNT_IN_MAX - SWAP_AMOUNT_IN_SPENT],
    ],
    coins: [
      {
        coinInfo: { nonce: MINT_NONCE, color: VAULT_TOKEN_COLOR_OUT, value: SWAP_AMOUNT_OUT },
        recipient: TO_CALLER,
      },
      {
        coinInfo: {
          nonce: CHANGE_NONCE,
          color: VAULT_TOKEN_COLOR,
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
    mints: [
      [VAULT_TOKEN_OUT_MINT_KEY, SWAP_AMOUNT_OUT],
      [VAULT_TOKEN_MINT_KEY, 0n],
    ],
    coins: [
      {
        coinInfo: { nonce: MINT_NONCE, color: VAULT_TOKEN_COLOR_OUT, value: SWAP_AMOUNT_OUT },
        recipient: TO_CALLER,
      },
      {
        coinInfo: { nonce: CHANGE_NONCE, color: VAULT_TOKEN_COLOR, value: 0n },
        recipient: TO_CALLER,
      },
    ],
  },
  {
    name: "a reverted swap (failed) re-mints the surrendered amountInMaximum",
    outputKind: OutputKind.failed,
    signedOutput: OUTPUT_EMPTY,
    presentedOutput: OUTPUT_SWAP_IGNORED,
    mints: [[VAULT_TOKEN_MINT_KEY, SWAP_AMOUNT_IN_MAX]],
    coins: [
      {
        coinInfo: { nonce: MINT_NONCE, color: VAULT_TOKEN_COLOR, value: SWAP_AMOUNT_IN_MAX },
        recipient: TO_CALLER,
      },
    ],
  },
  {
    name: "a swap whose nonce another transaction took (unviable) re-mints the surrendered amountInMaximum",
    outputKind: OutputKind.unviable,
    signedOutput: OUTPUT_EMPTY,
    presentedOutput: OUTPUT_SWAP_IGNORED,
    mints: [[VAULT_TOKEN_MINT_KEY, SWAP_AMOUNT_IN_MAX]],
    coins: [
      {
        coinInfo: { nonce: MINT_NONCE, color: VAULT_TOKEN_COLOR, value: SWAP_AMOUNT_IN_MAX },
        recipient: TO_CALLER,
      },
    ],
  },
];

describe("swapAmountIn", () => {
  it.each([
    { name: "zero", amountIn: 0n },
    { name: "one base unit", amountIn: 1n },
    { name: "a typical spend", amountIn: SWAP_AMOUNT_IN_SPENT },
    { name: "the Uint<64> maximum", amountIn: UINT64_MAX },
  ])("decodes $name as swapRespondSchema() packs it", ({ amountIn }) => {
    const output = serializeRespondOutput(pureCircuits.swapRespondSchema(), { amountIn });
    expect(pureCircuits.swapAmountIn(output)).toBe(amountIn);
  });
});

describe("completeSwap settle", () => {
  it.each(SWAP_VERDICT_CASES)(
    "$name and consumes the request",
    async ({ outputKind, signedOutput, presentedOutput, mints, coins }) => {
      const { contract, ctx, requestId } = await swapRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        signedOutput,
        ATTESTED_HEIGHT,
      );
      const attested =
        outputKind === OutputKind.executed
          ? await attest8(contract, ctx, attestation, signedOutput)
          : await attestFailure(contract, ctx, attestation);

      const next = (
        await contract.circuits.completeSwap(
          attested,
          requestId,
          presentedOutput,
          MINT_NONCE,
          CHANGE_NONCE,
        )
      ).context;

      // The effects map indexes the mints by token, not in the order the circuit minted them.
      expect(new Map(shieldedMintsOf(next))).toEqual(new Map(mints));
      expect(coinsMinted(attested, next)).toEqual(coins);
      const state = ledgerOf(next);
      expect(state.bidirectionalSwapMap.isEmpty()).toBe(true);
      expect(state.swapArgsMap.isEmpty()).toBe(true);
      expect(state.outputRequestBuffer.isEmpty()).toBe(true);
      expect(state.outputAttestationBuffer.isEmpty()).toBe(true);
      expect(state.evictionMap.isEmpty()).toBe(true);
    },
  );

  it.each(SWAP_VERDICT_CASES)(
    "rejects a caller other than the swapper when $name",
    async ({ outputKind, signedOutput, presentedOutput }) => {
      const { contract, ctx, requestId } = await swapRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        signedOutput,
        ATTESTED_HEIGHT,
      );
      const attested =
        outputKind === OutputKind.executed
          ? await attest8(contract, ctx, attestation, signedOutput)
          : await attestFailure(contract, ctx, attestation);

      await expect(
        contract.circuits.completeSwap(
          await strangerContext("completeSwap", attested),
          requestId,
          presentedOutput,
          MINT_NONCE,
          CHANGE_NONCE,
        ),
      ).rejects.toThrow(/Not the requester/);
    },
  );

  it("rejects an amountIn other than the attested one", async () => {
    // Presenting a smaller amountIn would mint more change than the swap left.
    const { contract, ctx, requestId } = await swapRequested();
    const attested = await attest8(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SWAP, ATTESTED_HEIGHT),
      OUTPUT_SWAP,
    );
    await expect(
      contract.circuits.completeSwap(attested, requestId, swapOutput(1n), MINT_NONCE, CHANGE_NONCE),
    ).rejects.toThrow(/Output does not match the attestation/);
  });

  it("rejects a changeNonce equal to mintNonce on an executed swap", async () => {
    const { contract, ctx, requestId } = await swapRequested();
    const attested = await attest8(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SWAP, ATTESTED_HEIGHT),
      OUTPUT_SWAP,
    );
    await expect(
      contract.circuits.completeSwap(attested, requestId, OUTPUT_SWAP, MINT_NONCE, MINT_NONCE),
    ).rejects.toThrow(/changeNonce must differ from mintNonce/);
  });

  it("a failed swap re-mints under mintNonce alone, whatever changeNonce is", async () => {
    const { contract, ctx, requestId } = await swapRequested();
    const attested = await attestFailure(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_EMPTY, ATTESTED_HEIGHT),
    );
    const next = (
      await contract.circuits.completeSwap(
        attested,
        requestId,
        OUTPUT_SWAP_IGNORED,
        MINT_NONCE,
        MINT_NONCE,
      )
    ).context;
    expect(shieldedMintsOf(next)).toEqual([[VAULT_TOKEN_MINT_KEY, SWAP_AMOUNT_IN_MAX]]);
    expect(coinsMinted(attested, next)).toEqual([
      {
        coinInfo: { nonce: MINT_NONCE, color: VAULT_TOKEN_COLOR, value: SWAP_AMOUNT_IN_MAX },
        recipient: TO_CALLER,
      },
    ]);
  });

  it.each([
    { name: "queueAttestation8", outputKind: OutputKind.executed, output: OUTPUT_SWAP },
    { name: "queueAttestation0", outputKind: OutputKind.failed, output: OUTPUT_EMPTY },
  ])(
    "$name refuses an attestation at or below the swap's lastSeen",
    async ({ outputKind, output }) => {
      const { contract, ctx, requestId } = await swapRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        output,
        EVM_START_HEIGHT,
      );
      await expect(
        outputKind === OutputKind.executed
          ? contract.circuits.queueAttestation8(ctx, attestation, output)
          : contract.circuits.queueAttestation0(ctx, attestation, output),
      ).rejects.toThrow(/Stale attestation/);
    },
  );

  it.each([
    {
      name: "an attestation signed by another key",
      secret: IMPOSTER_SECRET,
      presented: OUTPUT_SWAP,
    },
    {
      name: "an output other than the one the MPC signed",
      secret: MPC_RESPONSE_SECRET,
      presented: swapOutput(1n),
    },
  ])("queueAttestation8 refuses $name", async ({ secret, presented }) => {
    const { contract, ctx, requestId } = await swapRequested();
    const attestation = respond(
      secret,
      requestId,
      OutputKind.executed,
      OUTPUT_SWAP,
      ATTESTED_HEIGHT,
    );
    await expect(contract.circuits.queueAttestation8(ctx, attestation, presented)).rejects.toThrow(
      /Invalid attestation signature/,
    );
  });

  it("queueAttestation8 rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.queueAttestation8(
        ctx,
        respond(
          MPC_RESPONSE_SECRET,
          bytes(32, 0x5a),
          OutputKind.executed,
          OUTPUT_SWAP,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SWAP,
      ),
    ).rejects.toThrow(/Not initialised/);
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.completeSwap(
        ctx,
        bytes(32, 0x5a),
        OUTPUT_SWAP_IGNORED,
        MINT_NONCE,
        CHANGE_NONCE,
      ),
    ).rejects.toThrow(/Not initialised/);
  });

  it("settles once: a second completeSwap for the same request rejects", async () => {
    const { contract, ctx, requestId } = await swapRequested();
    const attested = await attestFailure(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_EMPTY, ATTESTED_HEIGHT),
    );
    const next = (
      await contract.circuits.completeSwap(
        attested,
        requestId,
        OUTPUT_SWAP_IGNORED,
        MINT_NONCE,
        CHANGE_NONCE,
      )
    ).context;
    await expect(
      contract.circuits.completeSwap(
        next,
        requestId,
        OUTPUT_SWAP_IGNORED,
        MINT_NONCE,
        CHANGE_NONCE,
      ),
    ).rejects.toThrow(/Request not sent/);
  });

  it("completeSwap rejects a withdrawal's request id, and completeWithdraw a swap's", async () => {
    const { contract, ctx, requestId: withdrawId } = await withdrawRequested();
    const swapped = (await swap(contract, ctx, VALID_SWAP)).context;
    const swapId = requestIdBytes(
      first(
        toSignBidirectionalEventIndex(ledgerOf(swapped).bidirectionalSwapMap).keys(),
        "swap request id",
      ),
    );
    const withdrawQueued = (
      await contract.circuits.queueAttestation1(
        swapped,
        respond(
          MPC_RESPONSE_SECRET,
          withdrawId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
      )
    ).context;
    const bothQueued = (
      await contract.circuits.queueAttestation8(
        withdrawQueued,
        respond(MPC_RESPONSE_SECRET, swapId, OutputKind.executed, OUTPUT_SWAP, ATTESTED_HEIGHT),
        OUTPUT_SWAP,
      )
    ).context;
    const attested = await flush(contract, bothQueued, [], [withdrawId, swapId]);

    await expect(
      contract.circuits.completeSwap(attested, withdrawId, OUTPUT_SWAP, MINT_NONCE, CHANGE_NONCE),
    ).rejects.toThrow(/Wrong action/);
    await expect(
      contract.circuits.completeWithdraw(attested, swapId, OUTPUT_SUCCESS, MINT_NONCE),
    ).rejects.toThrow(/Wrong action/);
  });
});

// ---- Supply fixtures ----

// The ERC-4626 deposit(uint256,address) selector: the TS mirror of the literal
// `Bytes [0x6e, 0x55, 0x3f, 0x65]` hardcoded in erc20-vault.compact.
const STATA_DEPOSIT_SELECTOR = new Uint8Array([0x6e, 0x55, 0x3f, 0x65]);

// The supply's schemas at their exact contract-declared widths: the round trip below
// is the lockstep check for the compiled supplyOutputSchema and supplyRespondSchema.
const SUPPLY_OUTPUT_SCHEMA = asciiPadded('[{"name":"shares","type":"uint256"}]', 36);
const SUPPLY_RESPOND_SCHEMA = asciiPadded('[{"name":"shares","type":"uint64"}]', 35);

// The vault token colours of the pinned Aave pair: a supply surrenders the
// underlying's, and its shares are minted in the wrapper's.
const STATA_UNDERLYING_COLOR = hexToBytes(
  rawTokenType(pureCircuits.vaultTokenDomainSeparator(STATA_UNDERLYING), VAULT_ADDRESS),
);
const STATA_TOKEN_COLOR = hexToBytes(
  rawTokenType(pureCircuits.vaultTokenDomainSeparator(STATA_TOKEN), VAULT_ADDRESS),
);

// The mint keys completeSupply mints the shares, or re-mints the underlying, under.
const STATA_TOKEN_MINT_KEY = bytesToHex(pureCircuits.vaultTokenDomainSeparator(STATA_TOKEN));
const STATA_UNDERLYING_MINT_KEY = bytesToHex(
  pureCircuits.vaultTokenDomainSeparator(STATA_UNDERLYING),
);

// The shares an executed supply is attested with, packed by the compiled respond
// schema to its 8-byte width, the way the MPC packs them.
const SUPPLY_SHARES = 360_679n;
const OUTPUT_SUPPLY = serializeRespondOutput(pureCircuits.supplyRespondSchema(), {
  shares: SUPPLY_SHARES,
});

// completeSupply takes an 8-byte output on every verdict and ignores it on a failure.
const OUTPUT_SUPPLY_IGNORED = new Uint8Array(8);

/**
 * A supply's `startSupply` arguments: the input index, the `SupplyRequest` and the
 * surrendered underlying coin. The nonce and gas are the vault's, and the contract
 * pins both token addresses, so the caller passes none of them.
 */
interface SupplyCallArgs {
  inIndex: bigint;
  supply: { amount: bigint };
  coin: ReturnType<typeof vaultCoin>;
}

/**
 * Known-good supply call args, the base every test varies from.
 * Shared across tests: NEVER mutate. Build a variation as an explicit spread
 * of this base with the delta inline (see {@link SUPPLY_REJECTION_CASES}).
 */
const VALID_SUPPLY: SupplyCallArgs = {
  inIndex: 51n,
  supply: { amount: AMOUNT },
  coin: vaultCoin(AMOUNT, STATA_UNDERLYING_COLOR),
};

// The gas every supply copies at start: the vault's default fees at its supply limit.
const DEFAULT_SUPPLY_GAS = { ...DEFAULT_VAULT_GAS, gasLimit: 500_000n };

/** Queue a supply: startSupply with its args in circuit order. */
const queueSupply = (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  args: SupplyCallArgs,
) => contract.circuits.startSupply(ctx, args.inIndex, args.supply, args.coin);

/** Queue, flush and send a supply, returning the send's context and the request index. */
const supply = async (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  args: SupplyCallArgs,
) => {
  const queued = (await queueSupply(contract, ctx, args)).context;
  const flushed = await flush(contract, queued, [args.inIndex], []);
  const outIndex = flushedRequestIndex(ledgerOf(flushed), Action.supply, args.inIndex);
  const sent = await contract.circuits.sendSupply(flushed, outIndex);
  return { context: sent.context, outIndex };
};

// ---- Supply tests ----

describe("supply round-trip", () => {
  it("stores a vault-path stataToken deposit built from the flushed entry and its args", async () => {
    const { contract, ctx } = await deployInitialised();

    const { context: next, outIndex } = await supply(contract, ctx, VALID_SUPPLY);
    const state = next.callContext.currentQueryContext.state;

    const typedIndex = toSignBidirectionalEventIndex(ledger(state).bidirectionalSupplyMap);
    const rawLedger = readSignetRequestsLedgerFromState(state, VAULT_SUPPLY_REQUESTS_PATH);
    expect(typedIndex.size).toBe(1);
    expect(rawLedger.requestsIndex).toEqual(typedIndex);
    const [idHex, record] = first(typedIndex.entries(), "indexed supply request");

    // The notification names THIS vault and the bidirectionalSupplyMap.
    const notificationEvent = first(
      decodeSignetLogEvents(next.events, SIGNET_ADDRESS),
      "signet notification event",
    );
    expect(notificationEvent.name).toBe(SignetEventName.SignBidirectionalEvent);
    const notificationPost = decodeSignBidirectionalEventNotificationPayload(
      notificationEvent.payload,
    );
    expect(requestIdHex(notificationPost.requestId)).toBe(idHex);
    expect(decodeSignBidirectionalNotification(notificationPost.event)).toEqual({
      version: 1,
      callerAddress: bytesToHex(VAULT_ADDRESS_BYTES),
      requestsPath: [...VAULT_SUPPLY_REQUESTS_PATH],
    });

    // The vault's own account signs a call to the pinned wrapper at the first
    // nonce the flush assigned, under the vault's supply gas copied at start.
    expect(record.sender).toEqual({ bytes: VAULT_ADDRESS_BYTES });
    expect(record.path).toEqual(asciiPadded("vault", 32));
    const { calldata, ...envelope } = record.txParams;
    expect(envelope).toEqual({
      to: STATA_TOKEN,
      chainId: CHAIN_ID,
      nonce: 0n,
      ...DEFAULT_SUPPLY_GAS,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
    });
    expect(record.executionDest).toEqual(EXPECTED_ROUTING.executionDest);
    expect(record.keyVersion).toBe(MPC_KEY_VERSION);
    expect(record.algo).toBe(EXPECTED_ROUTING.algo);
    expect(record.signatureDest).toBe(EXPECTED_ROUTING.signatureDest);
    expect(record.params).toEqual(EXPECTED_ROUTING.params);
    expect(record.txParamType).toBe(TxParamType.evmType2);
    expect(record.outputDeserializationSchema).toEqual(SUPPLY_OUTPUT_SCHEMA);
    expect(record.respondSerializationSchema).toEqual(SUPPLY_RESPOND_SCHEMA);

    // Contract-built calldata: deposit(amount, receiver = the vault's own account).
    expect(calldata.is_some).toBe(true);
    expect(calldata.value.selector).toEqual(STATA_DEPOSIT_SELECTOR);
    expect(calldata.value.noWords).toBe(2n);
    expect(calldata.value.words).toHaveLength(2);
    expect(calldata.value.words[0]).toEqual(numericAbiWord(AMOUNT));
    expect(calldata.value.words[1]).toEqual(evmAddressAbiWord(VAULT_EVM));

    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));

    const { entry, lastSeen } = ledger(state).outputRequestBuffer.lookup(outIndex);
    expect(entry).toEqual({
      action: Action.supply,
      useNextVaultAccountNonce: true,
      evmNonce: 0n,
      inIndex: VALID_SUPPLY.inIndex,
      commitment: pureCircuits.ownershipCommitment(VALID_SUPPLY.inIndex, SECRET_KEY),
      argsHash: expect.any(Uint8Array) as Uint8Array,
    });
    expect(lastSeen).toBe(EVM_START_HEIGHT);
    expect(ledger(state).supplyArgsMap.lookup(VALID_SUPPLY.inIndex)).toEqual({
      request: VALID_SUPPLY.supply,
      gas: DEFAULT_SUPPLY_GAS,
    });
    expect(ledger(state).evictionMap.lookup(requestIdBytes(idHex))).toEqual(outIndex);
    expect(ledger(state).inputRequestBuffer.isEmpty()).toBe(true);
    expect(ledger(state).vaultAccountNonce).toBe(1n);
  });

  it("start burns the surrendered underlying coin: received by the vault, then paid in full to the burn address", async () => {
    const { contract, ctx } = await deployInitialised();

    const started = (await queueSupply(contract, ctx, VALID_SUPPLY)).context;
    const zswap = zswapState(started);

    expect(zswap.inputs).toHaveLength(1);
    const consumed = first(zswap.inputs, "consumed coin");
    expect(consumed.color).toEqual(STATA_UNDERLYING_COLOR);
    expect(consumed.value).toBe(AMOUNT);

    expect(zswap.outputs).toHaveLength(2);
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
    const burnOutput = first(
      zswap.outputs.filter((output) => output.recipient.is_left),
      "burn output",
    );
    expect(burnOutput.coinInfo.color).toEqual(STATA_UNDERLYING_COLOR);
    expect(burnOutput.coinInfo.value).toBe(AMOUNT);
    expect(burnOutput.recipient.left.bytes).toEqual(BURN_ADDRESS_BYTES);
  });

  it("a supply flushed behind a withdrawal takes the next vault nonce", async () => {
    const { contract, ctx } = await deployInitialised();
    const queuedWithdraw = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    const queuedBoth = (await queueSupply(contract, queuedWithdraw, VALID_SUPPLY)).context;

    const flushed = await flush(
      contract,
      queuedBoth,
      [VALID_WITHDRAW.inIndex, VALID_SUPPLY.inIndex],
      [],
    );

    const state = ledgerOf(flushed);
    const withdrawIndex = flushedRequestIndex(state, Action.withdraw, VALID_WITHDRAW.inIndex);
    const supplyIndex = flushedRequestIndex(state, Action.supply, VALID_SUPPLY.inIndex);
    expect(state.outputRequestBuffer.lookup(withdrawIndex).entry.evmNonce).toBe(0n);
    expect(state.outputRequestBuffer.lookup(supplyIndex).entry.evmNonce).toBe(1n);
    expect(state.vaultAccountNonce).toBe(2n);
  });
});

/** One row of the supply rejection table: full inputs to expected error. */
interface SupplyRejectionCase {
  /** Test name, completing the sentence "rejects <name>". */
  name: string;
  /** Complete call args passed to startSupply. */
  args: SupplyCallArgs;
  /** Error startSupply must throw. */
  throws: RegExp;
}

const SUPPLY_REJECTION_CASES: SupplyRejectionCase[] = [
  {
    name: "a zero amount",
    args: {
      ...VALID_SUPPLY,
      supply: { amount: 0n },
      coin: vaultCoin(0n, STATA_UNDERLYING_COLOR),
    },
    throws: /Amount must be positive/,
  },
  {
    name: "an amount above Uint<64> max (unrefundable)",
    args: {
      ...VALID_SUPPLY,
      supply: { amount: UINT64_MAX + 1n },
      coin: vaultCoin(UINT64_MAX + 1n, STATA_UNDERLYING_COLOR),
    },
    throws: /Amount exceeds Uint<64> max/,
  },
  {
    name: "a coin of the wrapper's colour, not the underlying's",
    args: { ...VALID_SUPPLY, coin: vaultCoin(AMOUNT, STATA_TOKEN_COLOR) },
    throws: /Coin is not the vault token for the underlying/,
  },
  {
    name: "a coin whose value differs from the supply amount",
    args: { ...VALID_SUPPLY, coin: vaultCoin(AMOUNT - 1n, STATA_UNDERLYING_COLOR) },
    throws: /Coin value must equal the supply amount/,
  },
];

describe("supply validation", () => {
  it.each(SUPPLY_REJECTION_CASES)("rejects $name", async ({ args, throws }) => {
    const { contract, ctx } = await deployInitialised();
    await expect(queueSupply(contract, ctx, args)).rejects.toThrow(throws);
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(queueSupply(contract, ctx, VALID_SUPPLY)).rejects.toThrow(/Not initialised/);
  });

  it("rejects an index the input buffer holds", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueSupply(contract, ctx, VALID_SUPPLY)).context;
    await expect(queueSupply(contract, queued, VALID_SUPPLY)).rejects.toThrow(
      /Index already in use/,
    );
  });

  it("rejects an index another action's queued request holds", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    await expect(
      queueSupply(contract, queued, { ...VALID_SUPPLY, inIndex: VALID_WITHDRAW.inIndex }),
    ).rejects.toThrow(/Index already in use/);
  });

  it("rejects an index the flush freed while its args stay in supplyArgsMap", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueSupply(contract, ctx, VALID_SUPPLY)).context;
    const flushed = await flush(contract, queued, [VALID_SUPPLY.inIndex], []);
    expect(ledgerOf(flushed).inputRequestBuffer.member(VALID_SUPPLY.inIndex)).toBe(false);
    await expect(queueSupply(contract, flushed, VALID_SUPPLY)).rejects.toThrow(
      /Index already in use/,
    );
  });
});

describe("sendSupply", () => {
  it("is permissionless: a stranger sends the supplier's request as queued", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueSupply(contract, ctx, VALID_SUPPLY)).context;
    const flushed = await flush(contract, queued, [VALID_SUPPLY.inIndex], []);
    const outIndex = flushedRequestIndex(ledgerOf(flushed), Action.supply, VALID_SUPPLY.inIndex);

    const sent = (
      await contract.circuits.sendSupply(await strangerContext("sendSupply", flushed), outIndex)
    ).context;
    const index = toSignBidirectionalEventIndex(ledgerOf(sent).bidirectionalSupplyMap);
    expect(index.size).toBe(1);
    const record = first(index.values(), "supply request");
    expect(record.path).toEqual(asciiPadded("vault", 32));
    expect(record.txParams.nonce).toBe(0n);
  });

  it("rejects an index the flush has not moved", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueSupply(contract, ctx, VALID_SUPPLY)).context;
    await expect(contract.circuits.sendSupply(queued, bytes(32, 0x5a))).rejects.toThrow(
      /Request not flushed/,
    );
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(contract.circuits.sendSupply(ctx, bytes(32, 0x5a))).rejects.toThrow(
      /Not initialised/,
    );
  });

  it("rejects a second send of the same request", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, outIndex } = await supply(contract, ctx, VALID_SUPPLY);
    await expect(contract.circuits.sendSupply(sent, outIndex)).rejects.toThrow(
      /Request already sent/,
    );
  });

  it("rejects a flushed withdrawal's index, and sendWithdraw rejects a flushed supply's", async () => {
    const { contract, ctx } = await deployInitialised();
    const queuedWithdraw = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    const queuedBoth = (await queueSupply(contract, queuedWithdraw, VALID_SUPPLY)).context;
    const flushed = await flush(
      contract,
      queuedBoth,
      [VALID_WITHDRAW.inIndex, VALID_SUPPLY.inIndex],
      [],
    );
    const withdrawIndex = flushedRequestIndex(
      ledgerOf(flushed),
      Action.withdraw,
      VALID_WITHDRAW.inIndex,
    );
    const supplyIndex = flushedRequestIndex(ledgerOf(flushed), Action.supply, VALID_SUPPLY.inIndex);

    await expect(contract.circuits.sendSupply(flushed, withdrawIndex)).rejects.toThrow(
      /Wrong action/,
    );
    await expect(contract.circuits.sendWithdraw(flushed, supplyIndex)).rejects.toThrow(
      /Wrong action/,
    );
  });
});

/**
 * Deploy + initialise + supply(VALID_SUPPLY): the arrange step of every
 * complete-supply test. Returns the sent supply's request id (the single supply
 * map index) alongside the threaded context.
 */
const supplyRequested = async () => {
  const { contract, ctx } = await deployInitialised();
  const { context: next } = await supply(contract, ctx, VALID_SUPPLY);
  const index = toSignBidirectionalEventIndex(ledgerOf(next).bidirectionalSupplyMap);
  const idHex = first(index.keys(), "supply request id");
  return { contract, ctx: next, requestId: requestIdBytes(idHex) };
};

describe("queueAttestation8", () => {
  it("rejects an attestation not signed by the pinned MPC response key", async () => {
    const { contract, ctx, requestId } = await supplyRequested();
    await expect(
      contract.circuits.queueAttestation8(
        ctx,
        respond(IMPOSTER_SECRET, requestId, OutputKind.executed, OUTPUT_SUPPLY, ATTESTED_HEIGHT),
        OUTPUT_SUPPLY,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects an output other than the one the MPC signed", async () => {
    const { contract, ctx, requestId } = await supplyRequested();
    await expect(
      contract.circuits.queueAttestation8(
        ctx,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUPPLY,
          ATTESTED_HEIGHT,
        ),
        serializeRespondOutput(pureCircuits.supplyRespondSchema(), { shares: SUPPLY_SHARES + 1n }),
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.queueAttestation8(
        ctx,
        respond(
          MPC_RESPONSE_SECRET,
          bytes(32, 0x5a),
          OutputKind.executed,
          OUTPUT_SUPPLY,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUPPLY,
      ),
    ).rejects.toThrow(/Not initialised/);
  });

  it("records the verified attestation under its request id, and the flush moves it", async () => {
    const { contract, ctx, requestId } = await supplyRequested();
    const attestation = respond(
      MPC_RESPONSE_SECRET,
      requestId,
      OutputKind.executed,
      OUTPUT_SUPPLY,
      ATTESTED_HEIGHT,
    );

    const queued = (await contract.circuits.queueAttestation8(ctx, attestation, OUTPUT_SUPPLY))
      .context;
    expect(ledgerOf(queued).inputAttestationBuffer.lookup(requestId)).toEqual({
      blockHeight: ATTESTED_HEIGHT,
      outputKind: OutputKind.executed,
      digest: attestation.digest,
    });

    const flushed = await flush(contract, queued, [], [requestId]);
    expect(ledgerOf(flushed).inputAttestationBuffer.isEmpty()).toBe(true);
    expect(ledgerOf(flushed).outputAttestationBuffer.member(requestId)).toBe(true);
    expect(ledgerOf(flushed).globalLastSeen).toBe(ATTESTED_HEIGHT);
  });
});

/** Arrange a flushed attestation of the given verdict for the requested supply. */
interface SupplyVerdictCase {
  /** Test name, completing the sentence "<name> and consumes the request". */
  name: string;
  /** The verdict the MPC attests. */
  outputKind: OutputKind;
  /** The output the MPC signs (empty under a failure kind). */
  signedOutput: Uint8Array;
  /** The output completeSupply is passed. */
  presentedOutput: Uint8Array;
  /** The mints completeSupply must request of the ledger: mint key to amount. */
  mints: [string, bigint][];
  /** The coins those mints create, each with its nonce, colour, value and recipient. */
  coins: EncodedZswapLocalState["outputs"];
}

const SUPPLY_VERDICT_CASES: SupplyVerdictCase[] = [
  {
    name: "an executed deposit mints the attested shares as the wrapper's vault token",
    outputKind: OutputKind.executed,
    signedOutput: OUTPUT_SUPPLY,
    presentedOutput: OUTPUT_SUPPLY,
    mints: [[STATA_TOKEN_MINT_KEY, SUPPLY_SHARES]],
    coins: [
      {
        coinInfo: { nonce: MINT_NONCE, color: STATA_TOKEN_COLOR, value: SUPPLY_SHARES },
        recipient: TO_CALLER,
      },
    ],
  },
  {
    name: "a reverted deposit (failed) re-mints the surrendered underlying",
    outputKind: OutputKind.failed,
    signedOutput: OUTPUT_EMPTY,
    presentedOutput: OUTPUT_SUPPLY_IGNORED,
    mints: [[STATA_UNDERLYING_MINT_KEY, AMOUNT]],
    coins: [
      {
        coinInfo: { nonce: MINT_NONCE, color: STATA_UNDERLYING_COLOR, value: AMOUNT },
        recipient: TO_CALLER,
      },
    ],
  },
  {
    name: "a deposit whose nonce another transaction took (unviable) re-mints the surrendered underlying",
    outputKind: OutputKind.unviable,
    signedOutput: OUTPUT_EMPTY,
    presentedOutput: OUTPUT_SUPPLY_IGNORED,
    mints: [[STATA_UNDERLYING_MINT_KEY, AMOUNT]],
    coins: [
      {
        coinInfo: { nonce: MINT_NONCE, color: STATA_UNDERLYING_COLOR, value: AMOUNT },
        recipient: TO_CALLER,
      },
    ],
  },
];

describe("supplyShares", () => {
  it.each([
    { name: "zero", shares: 0n },
    { name: "one share", shares: 1n },
    { name: "a typical share count", shares: SUPPLY_SHARES },
    { name: "the Uint<64> maximum", shares: UINT64_MAX },
  ])("decodes $name as supplyRespondSchema() packs it", ({ shares }) => {
    const output = serializeRespondOutput(pureCircuits.supplyRespondSchema(), { shares });
    expect(pureCircuits.supplyShares(output)).toBe(shares);
  });
});

describe("completeSupply settle", () => {
  it.each(SUPPLY_VERDICT_CASES)(
    "$name and consumes the request",
    async ({ outputKind, signedOutput, presentedOutput, mints, coins }) => {
      const { contract, ctx, requestId } = await supplyRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        signedOutput,
        ATTESTED_HEIGHT,
      );
      const attested =
        outputKind === OutputKind.executed
          ? await attest8(contract, ctx, attestation, signedOutput)
          : await attestFailure(contract, ctx, attestation);

      const next = (
        await contract.circuits.completeSupply(attested, requestId, presentedOutput, MINT_NONCE)
      ).context;

      expect(shieldedMintsOf(next)).toEqual(mints);
      expect(coinsMinted(attested, next)).toEqual(coins);
      const state = ledgerOf(next);
      expect(state.bidirectionalSupplyMap.isEmpty()).toBe(true);
      expect(state.supplyArgsMap.isEmpty()).toBe(true);
      expect(state.outputRequestBuffer.isEmpty()).toBe(true);
      expect(state.outputAttestationBuffer.isEmpty()).toBe(true);
      expect(state.evictionMap.isEmpty()).toBe(true);
    },
  );

  it.each(SUPPLY_VERDICT_CASES)(
    "rejects a caller other than the supplier when $name",
    async ({ outputKind, signedOutput, presentedOutput }) => {
      const { contract, ctx, requestId } = await supplyRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        signedOutput,
        ATTESTED_HEIGHT,
      );
      const attested =
        outputKind === OutputKind.executed
          ? await attest8(contract, ctx, attestation, signedOutput)
          : await attestFailure(contract, ctx, attestation);

      await expect(
        contract.circuits.completeSupply(
          await strangerContext("completeSupply", attested),
          requestId,
          presentedOutput,
          MINT_NONCE,
        ),
      ).rejects.toThrow(/Not the requester/);
    },
  );

  it("rejects a share count other than the one the execution was attested with", async () => {
    // Presenting more shares would mint wrapper tokens the vault account never received.
    const { contract, ctx, requestId } = await supplyRequested();
    const attested = await attest8(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUPPLY, ATTESTED_HEIGHT),
      OUTPUT_SUPPLY,
    );
    await expect(
      contract.circuits.completeSupply(
        attested,
        requestId,
        serializeRespondOutput(pureCircuits.supplyRespondSchema(), { shares: SUPPLY_SHARES + 1n }),
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Output does not match the attestation/);
  });

  it.each([
    { name: "queueAttestation8", outputKind: OutputKind.executed, output: OUTPUT_SUPPLY },
    { name: "queueAttestation0", outputKind: OutputKind.failed, output: OUTPUT_EMPTY },
  ])(
    "$name refuses an attestation at or below the supply's lastSeen",
    async ({ outputKind, output }) => {
      const { contract, ctx, requestId } = await supplyRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        output,
        EVM_START_HEIGHT,
      );
      await expect(
        outputKind === OutputKind.executed
          ? contract.circuits.queueAttestation8(ctx, attestation, output)
          : contract.circuits.queueAttestation0(ctx, attestation, output),
      ).rejects.toThrow(/Stale attestation/);
    },
  );

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.completeSupply(ctx, bytes(32, 0x5a), OUTPUT_SUPPLY_IGNORED, MINT_NONCE),
    ).rejects.toThrow(/Not initialised/);
  });

  it("settles once: a second completeSupply for the same request rejects", async () => {
    const { contract, ctx, requestId } = await supplyRequested();
    const attested = await attest8(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUPPLY, ATTESTED_HEIGHT),
      OUTPUT_SUPPLY,
    );
    const next = (
      await contract.circuits.completeSupply(attested, requestId, OUTPUT_SUPPLY, MINT_NONCE)
    ).context;
    await expect(
      contract.circuits.completeSupply(next, requestId, OUTPUT_SUPPLY, MINT_NONCE),
    ).rejects.toThrow(/Request not sent/);
  });

  it("completeSupply rejects a withdrawal's request id, and completeWithdraw a supply's", async () => {
    const { contract, ctx, requestId: withdrawId } = await withdrawRequested();
    const supplied = (await supply(contract, ctx, VALID_SUPPLY)).context;
    const supplyId = requestIdBytes(
      first(
        toSignBidirectionalEventIndex(ledgerOf(supplied).bidirectionalSupplyMap).keys(),
        "supply request id",
      ),
    );
    const withdrawQueued = (
      await contract.circuits.queueAttestation0(
        supplied,
        respond(MPC_RESPONSE_SECRET, withdrawId, OutputKind.failed, OUTPUT_EMPTY, ATTESTED_HEIGHT),
        OUTPUT_EMPTY,
      )
    ).context;
    const bothQueued = (
      await contract.circuits.queueAttestation0(
        withdrawQueued,
        respond(MPC_RESPONSE_SECRET, supplyId, OutputKind.failed, OUTPUT_EMPTY, ATTESTED_HEIGHT),
        OUTPUT_EMPTY,
      )
    ).context;
    const attested = await flush(contract, bothQueued, [], [withdrawId, supplyId]);

    await expect(
      contract.circuits.completeSupply(attested, withdrawId, OUTPUT_SUPPLY_IGNORED, MINT_NONCE),
    ).rejects.toThrow(/Wrong action/);
    await expect(
      contract.circuits.completeWithdraw(attested, supplyId, OUTPUT_IGNORED, MINT_NONCE),
    ).rejects.toThrow(/Wrong action/);
  });
});

// ---- Redeem fixtures ----

// The ERC-4626 redeem(uint256,address,address) selector: the TS mirror of the literal
// `Bytes [0xba, 0x08, 0x76, 0x52]` hardcoded in erc20-vault.compact.
const STATA_REDEEM_SELECTOR = new Uint8Array([0xba, 0x08, 0x76, 0x52]);

// The redeem's schemas at their exact contract-declared widths: the round trip below
// is the lockstep check for the compiled redeemOutputSchema and redeemRespondSchema.
const REDEEM_OUTPUT_SCHEMA = asciiPadded('[{"name":"assets","type":"uint256"}]', 36);
const REDEEM_RESPOND_SCHEMA = asciiPadded('[{"name":"assets","type":"uint64"}]', 35);

// The shares a redeem surrenders, distinct from AMOUNT so the round trip shows the
// request's own field reaching the calldata.
const REDEEM_SHARES = 360_679n;

// The underlying assets an executed redeem is attested with (principal plus accrued
// interest), packed by the compiled respond schema to its 8-byte width, the way the
// MPC packs them.
const REDEEM_ASSETS = 2_780_944n;
const OUTPUT_REDEEM = serializeRespondOutput(pureCircuits.redeemRespondSchema(), {
  assets: REDEEM_ASSETS,
});

// completeRedeem takes an 8-byte output on every verdict and ignores it on a failure.
const OUTPUT_REDEEM_IGNORED = new Uint8Array(8);

/**
 * A redeem's `startRedeem` arguments: the input index, the `RedeemRequest` and the
 * surrendered wrapper coin. The nonce and gas are the vault's, and the contract
 * pins both token addresses, so the caller passes none of them.
 */
interface RedeemCallArgs {
  inIndex: bigint;
  redeem: { shares: bigint };
  coin: ReturnType<typeof vaultCoin>;
}

/**
 * Known-good redeem call args, the base every test varies from.
 * Shared across tests: NEVER mutate. Build a variation as an explicit spread
 * of this base with the delta inline (see {@link REDEEM_REJECTION_CASES}).
 */
const VALID_REDEEM: RedeemCallArgs = {
  inIndex: 61n,
  redeem: { shares: REDEEM_SHARES },
  coin: vaultCoin(REDEEM_SHARES, STATA_TOKEN_COLOR),
};

// The gas every redeem copies at start: the vault's default fees at its redeem limit.
const DEFAULT_REDEEM_GAS = { ...DEFAULT_VAULT_GAS, gasLimit: 500_000n };

/** Queue a redeem: startRedeem with its args in circuit order. */
const queueRedeem = (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  args: RedeemCallArgs,
) => contract.circuits.startRedeem(ctx, args.inIndex, args.redeem, args.coin);

/** Queue, flush and send a redeem, returning the send's context and the request index. */
const redeem = async (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  args: RedeemCallArgs,
) => {
  const queued = (await queueRedeem(contract, ctx, args)).context;
  const flushed = await flush(contract, queued, [args.inIndex], []);
  const outIndex = flushedRequestIndex(ledgerOf(flushed), Action.redeem, args.inIndex);
  const sent = await contract.circuits.sendRedeem(flushed, outIndex);
  return { context: sent.context, outIndex };
};

// ---- Redeem tests ----

describe("redeem round-trip", () => {
  it("stores a vault-path stataToken redeem built from the flushed entry and its args", async () => {
    const { contract, ctx } = await deployInitialised();

    const { context: next, outIndex } = await redeem(contract, ctx, VALID_REDEEM);
    const state = next.callContext.currentQueryContext.state;

    const typedIndex = toSignBidirectionalEventIndex(ledger(state).bidirectionalRedeemMap);
    const rawLedger = readSignetRequestsLedgerFromState(state, VAULT_REDEEM_REQUESTS_PATH);
    expect(typedIndex.size).toBe(1);
    expect(rawLedger.requestsIndex).toEqual(typedIndex);
    const [idHex, record] = first(typedIndex.entries(), "indexed redeem request");

    // The notification names THIS vault and the bidirectionalRedeemMap.
    const notificationEvent = first(
      decodeSignetLogEvents(next.events, SIGNET_ADDRESS),
      "signet notification event",
    );
    expect(notificationEvent.name).toBe(SignetEventName.SignBidirectionalEvent);
    const notificationPost = decodeSignBidirectionalEventNotificationPayload(
      notificationEvent.payload,
    );
    expect(requestIdHex(notificationPost.requestId)).toBe(idHex);
    expect(decodeSignBidirectionalNotification(notificationPost.event)).toEqual({
      version: 1,
      callerAddress: bytesToHex(VAULT_ADDRESS_BYTES),
      requestsPath: [...VAULT_REDEEM_REQUESTS_PATH],
    });

    // The vault's own account signs a call to the pinned wrapper at the first
    // nonce the flush assigned, under the vault's redeem gas copied at start.
    expect(record.sender).toEqual({ bytes: VAULT_ADDRESS_BYTES });
    expect(record.path).toEqual(asciiPadded("vault", 32));
    const { calldata, ...envelope } = record.txParams;
    expect(envelope).toEqual({
      to: STATA_TOKEN,
      chainId: CHAIN_ID,
      nonce: 0n,
      ...DEFAULT_REDEEM_GAS,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
    });
    expect(record.executionDest).toEqual(EXPECTED_ROUTING.executionDest);
    expect(record.keyVersion).toBe(MPC_KEY_VERSION);
    expect(record.algo).toBe(EXPECTED_ROUTING.algo);
    expect(record.signatureDest).toBe(EXPECTED_ROUTING.signatureDest);
    expect(record.params).toEqual(EXPECTED_ROUTING.params);
    expect(record.txParamType).toBe(TxParamType.evmType2);
    expect(record.outputDeserializationSchema).toEqual(REDEEM_OUTPUT_SCHEMA);
    expect(record.respondSerializationSchema).toEqual(REDEEM_RESPOND_SCHEMA);

    // Contract-built calldata: redeem(shares, receiver = owner = the vault's own account).
    expect(calldata.is_some).toBe(true);
    expect(calldata.value.selector).toEqual(STATA_REDEEM_SELECTOR);
    expect(calldata.value.noWords).toBe(3n);
    expect(calldata.value.words).toHaveLength(3);
    expect(calldata.value.words[0]).toEqual(numericAbiWord(REDEEM_SHARES));
    expect(calldata.value.words[1]).toEqual(evmAddressAbiWord(VAULT_EVM));
    expect(calldata.value.words[2]).toEqual(evmAddressAbiWord(VAULT_EVM));

    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));

    const { entry, lastSeen } = ledger(state).outputRequestBuffer.lookup(outIndex);
    expect(entry).toEqual({
      action: Action.redeem,
      useNextVaultAccountNonce: true,
      evmNonce: 0n,
      inIndex: VALID_REDEEM.inIndex,
      commitment: pureCircuits.ownershipCommitment(VALID_REDEEM.inIndex, SECRET_KEY),
      argsHash: expect.any(Uint8Array) as Uint8Array,
    });
    expect(lastSeen).toBe(EVM_START_HEIGHT);
    expect(ledger(state).redeemArgsMap.lookup(VALID_REDEEM.inIndex)).toEqual({
      request: VALID_REDEEM.redeem,
      gas: DEFAULT_REDEEM_GAS,
    });
    expect(ledger(state).evictionMap.lookup(requestIdBytes(idHex))).toEqual(outIndex);
    expect(ledger(state).inputRequestBuffer.isEmpty()).toBe(true);
    expect(ledger(state).vaultAccountNonce).toBe(1n);
  });

  it("start burns the surrendered wrapper coin: received by the vault, then paid in full to the burn address", async () => {
    const { contract, ctx } = await deployInitialised();

    const started = (await queueRedeem(contract, ctx, VALID_REDEEM)).context;
    const zswap = zswapState(started);

    expect(zswap.inputs).toHaveLength(1);
    const consumed = first(zswap.inputs, "consumed coin");
    expect(consumed.color).toEqual(STATA_TOKEN_COLOR);
    expect(consumed.value).toBe(REDEEM_SHARES);

    expect(zswap.outputs).toHaveLength(2);
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
    const burnOutput = first(
      zswap.outputs.filter((output) => output.recipient.is_left),
      "burn output",
    );
    expect(burnOutput.coinInfo.color).toEqual(STATA_TOKEN_COLOR);
    expect(burnOutput.coinInfo.value).toBe(REDEEM_SHARES);
    expect(burnOutput.recipient.left.bytes).toEqual(BURN_ADDRESS_BYTES);
  });

  it("a redeem flushed behind a supply takes the next vault nonce, and its send signs at it", async () => {
    const { contract, ctx } = await deployInitialised();
    const queuedSupply = (await queueSupply(contract, ctx, VALID_SUPPLY)).context;
    const queuedBoth = (await queueRedeem(contract, queuedSupply, VALID_REDEEM)).context;

    const flushed = await flush(
      contract,
      queuedBoth,
      [VALID_SUPPLY.inIndex, VALID_REDEEM.inIndex],
      [],
    );

    const state = ledgerOf(flushed);
    const supplyIndex = flushedRequestIndex(state, Action.supply, VALID_SUPPLY.inIndex);
    const redeemIndex = flushedRequestIndex(state, Action.redeem, VALID_REDEEM.inIndex);
    expect(state.outputRequestBuffer.lookup(supplyIndex).entry.evmNonce).toBe(0n);
    expect(state.outputRequestBuffer.lookup(redeemIndex).entry.evmNonce).toBe(1n);
    expect(state.vaultAccountNonce).toBe(2n);

    const sent = (await contract.circuits.sendRedeem(flushed, redeemIndex)).context;
    const record = first(
      toSignBidirectionalEventIndex(ledgerOf(sent).bidirectionalRedeemMap).values(),
      "redeem request",
    );
    expect(record.txParams.nonce).toBe(1n);
  });
});

/** One row of the redeem rejection table: full inputs to expected error. */
interface RedeemRejectionCase {
  /** Test name, completing the sentence "rejects <name>". */
  name: string;
  /** Complete call args passed to startRedeem. */
  args: RedeemCallArgs;
  /** Error startRedeem must throw. */
  throws: RegExp;
}

const REDEEM_REJECTION_CASES: RedeemRejectionCase[] = [
  {
    name: "zero shares",
    args: {
      ...VALID_REDEEM,
      redeem: { shares: 0n },
      coin: vaultCoin(0n, STATA_TOKEN_COLOR),
    },
    throws: /shares must be positive/,
  },
  {
    name: "shares above Uint<64> max (unrefundable)",
    args: {
      ...VALID_REDEEM,
      redeem: { shares: UINT64_MAX + 1n },
      coin: vaultCoin(UINT64_MAX + 1n, STATA_TOKEN_COLOR),
    },
    throws: /shares exceeds Uint<64> max/,
  },
  {
    name: "a coin of the underlying's colour, not the wrapper's",
    args: { ...VALID_REDEEM, coin: vaultCoin(REDEEM_SHARES, STATA_UNDERLYING_COLOR) },
    throws: /Coin is not the vault token for the wrapper/,
  },
  {
    name: "a coin whose value differs from the shares",
    args: { ...VALID_REDEEM, coin: vaultCoin(REDEEM_SHARES + 1n, STATA_TOKEN_COLOR) },
    throws: /Coin value must equal shares/,
  },
];

describe("redeem validation", () => {
  it.each(REDEEM_REJECTION_CASES)("rejects $name", async ({ args, throws }) => {
    const { contract, ctx } = await deployInitialised();
    await expect(queueRedeem(contract, ctx, args)).rejects.toThrow(throws);
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(queueRedeem(contract, ctx, VALID_REDEEM)).rejects.toThrow(/Not initialised/);
  });

  it("rejects an index the input buffer holds", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueRedeem(contract, ctx, VALID_REDEEM)).context;
    await expect(queueRedeem(contract, queued, VALID_REDEEM)).rejects.toThrow(
      /Index already in use/,
    );
  });

  it("rejects an index another action's queued request holds", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueSupply(contract, ctx, VALID_SUPPLY)).context;
    await expect(
      queueRedeem(contract, queued, { ...VALID_REDEEM, inIndex: VALID_SUPPLY.inIndex }),
    ).rejects.toThrow(/Index already in use/);
  });

  it("rejects an index the flush freed while its args stay in redeemArgsMap", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueRedeem(contract, ctx, VALID_REDEEM)).context;
    const flushed = await flush(contract, queued, [VALID_REDEEM.inIndex], []);
    expect(ledgerOf(flushed).inputRequestBuffer.member(VALID_REDEEM.inIndex)).toBe(false);
    await expect(queueRedeem(contract, flushed, VALID_REDEEM)).rejects.toThrow(
      /Index already in use/,
    );
  });
});

describe("sendRedeem", () => {
  it("is permissionless: a stranger sends the redeemer's request as queued", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueRedeem(contract, ctx, VALID_REDEEM)).context;
    const flushed = await flush(contract, queued, [VALID_REDEEM.inIndex], []);
    const outIndex = flushedRequestIndex(ledgerOf(flushed), Action.redeem, VALID_REDEEM.inIndex);

    const sent = (
      await contract.circuits.sendRedeem(await strangerContext("sendRedeem", flushed), outIndex)
    ).context;
    const index = toSignBidirectionalEventIndex(ledgerOf(sent).bidirectionalRedeemMap);
    expect(index.size).toBe(1);
    const record = first(index.values(), "redeem request");
    expect(record.path).toEqual(asciiPadded("vault", 32));
    expect(record.txParams.nonce).toBe(0n);
  });

  it("rejects an index the flush has not moved", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueRedeem(contract, ctx, VALID_REDEEM)).context;
    await expect(contract.circuits.sendRedeem(queued, bytes(32, 0x5a))).rejects.toThrow(
      /Request not flushed/,
    );
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(contract.circuits.sendRedeem(ctx, bytes(32, 0x5a))).rejects.toThrow(
      /Not initialised/,
    );
  });

  it("rejects a second send of the same request", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, outIndex } = await redeem(contract, ctx, VALID_REDEEM);
    await expect(contract.circuits.sendRedeem(sent, outIndex)).rejects.toThrow(
      /Request already sent/,
    );
  });

  it("rejects a flushed supply's index, and sendSupply rejects a flushed redeem's", async () => {
    const { contract, ctx } = await deployInitialised();
    const queuedSupply = (await queueSupply(contract, ctx, VALID_SUPPLY)).context;
    const queuedBoth = (await queueRedeem(contract, queuedSupply, VALID_REDEEM)).context;
    const flushed = await flush(
      contract,
      queuedBoth,
      [VALID_SUPPLY.inIndex, VALID_REDEEM.inIndex],
      [],
    );
    const supplyIndex = flushedRequestIndex(ledgerOf(flushed), Action.supply, VALID_SUPPLY.inIndex);
    const redeemIndex = flushedRequestIndex(ledgerOf(flushed), Action.redeem, VALID_REDEEM.inIndex);

    await expect(contract.circuits.sendRedeem(flushed, supplyIndex)).rejects.toThrow(
      /Wrong action/,
    );
    await expect(contract.circuits.sendSupply(flushed, redeemIndex)).rejects.toThrow(
      /Wrong action/,
    );
  });
});

/**
 * Deploy + initialise + redeem(VALID_REDEEM): the arrange step of every
 * complete-redeem test. Returns the sent redeem's request id (the single redeem
 * map index) alongside the threaded context.
 */
const redeemRequested = async () => {
  const { contract, ctx } = await deployInitialised();
  const { context: next } = await redeem(contract, ctx, VALID_REDEEM);
  const index = toSignBidirectionalEventIndex(ledgerOf(next).bidirectionalRedeemMap);
  const idHex = first(index.keys(), "redeem request id");
  return { contract, ctx: next, requestId: requestIdBytes(idHex) };
};

/** Arrange a flushed attestation of the given verdict for the requested redeem. */
interface RedeemVerdictCase {
  /** Test name, completing the sentence "<name> and consumes the request". */
  name: string;
  /** The verdict the MPC attests. */
  outputKind: OutputKind;
  /** The output the MPC signs (empty under a failure kind). */
  signedOutput: Uint8Array;
  /** The output completeRedeem is passed. */
  presentedOutput: Uint8Array;
  /** The mints completeRedeem must request of the ledger: mint key to amount. */
  mints: [string, bigint][];
  /** The coins those mints create, each with its nonce, colour, value and recipient. */
  coins: EncodedZswapLocalState["outputs"];
}

const REDEEM_VERDICT_CASES: RedeemVerdictCase[] = [
  {
    name: "an executed redeem mints the attested assets as the underlying's vault token",
    outputKind: OutputKind.executed,
    signedOutput: OUTPUT_REDEEM,
    presentedOutput: OUTPUT_REDEEM,
    mints: [[STATA_UNDERLYING_MINT_KEY, REDEEM_ASSETS]],
    coins: [
      {
        coinInfo: { nonce: MINT_NONCE, color: STATA_UNDERLYING_COLOR, value: REDEEM_ASSETS },
        recipient: TO_CALLER,
      },
    ],
  },
  {
    name: "a reverted redeem (failed) re-mints the surrendered shares",
    outputKind: OutputKind.failed,
    signedOutput: OUTPUT_EMPTY,
    presentedOutput: OUTPUT_REDEEM_IGNORED,
    mints: [[STATA_TOKEN_MINT_KEY, REDEEM_SHARES]],
    coins: [
      {
        coinInfo: { nonce: MINT_NONCE, color: STATA_TOKEN_COLOR, value: REDEEM_SHARES },
        recipient: TO_CALLER,
      },
    ],
  },
  {
    name: "a redeem whose nonce another transaction took (unviable) re-mints the surrendered shares",
    outputKind: OutputKind.unviable,
    signedOutput: OUTPUT_EMPTY,
    presentedOutput: OUTPUT_REDEEM_IGNORED,
    mints: [[STATA_TOKEN_MINT_KEY, REDEEM_SHARES]],
    coins: [
      {
        coinInfo: { nonce: MINT_NONCE, color: STATA_TOKEN_COLOR, value: REDEEM_SHARES },
        recipient: TO_CALLER,
      },
    ],
  },
];

describe("redeemAssets", () => {
  it.each([
    { name: "zero", assets: 0n },
    { name: "one base unit", assets: 1n },
    { name: "a typical asset amount", assets: REDEEM_ASSETS },
    { name: "the Uint<64> maximum", assets: UINT64_MAX },
  ])("decodes $name as redeemRespondSchema() packs it", ({ assets }) => {
    const output = serializeRespondOutput(pureCircuits.redeemRespondSchema(), { assets });
    expect(pureCircuits.redeemAssets(output)).toBe(assets);
  });
});

describe("completeRedeem settle", () => {
  it.each(REDEEM_VERDICT_CASES)(
    "$name and consumes the request",
    async ({ outputKind, signedOutput, presentedOutput, mints, coins }) => {
      const { contract, ctx, requestId } = await redeemRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        signedOutput,
        ATTESTED_HEIGHT,
      );
      const attested =
        outputKind === OutputKind.executed
          ? await attest8(contract, ctx, attestation, signedOutput)
          : await attestFailure(contract, ctx, attestation);

      const next = (
        await contract.circuits.completeRedeem(attested, requestId, presentedOutput, MINT_NONCE)
      ).context;

      expect(shieldedMintsOf(next)).toEqual(mints);
      expect(coinsMinted(attested, next)).toEqual(coins);
      const state = ledgerOf(next);
      expect(state.bidirectionalRedeemMap.isEmpty()).toBe(true);
      expect(state.redeemArgsMap.isEmpty()).toBe(true);
      expect(state.outputRequestBuffer.isEmpty()).toBe(true);
      expect(state.outputAttestationBuffer.isEmpty()).toBe(true);
      expect(state.evictionMap.isEmpty()).toBe(true);
    },
  );

  it.each(REDEEM_VERDICT_CASES)(
    "rejects a caller other than the redeemer when $name",
    async ({ outputKind, signedOutput, presentedOutput }) => {
      const { contract, ctx, requestId } = await redeemRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        signedOutput,
        ATTESTED_HEIGHT,
      );
      const attested =
        outputKind === OutputKind.executed
          ? await attest8(contract, ctx, attestation, signedOutput)
          : await attestFailure(contract, ctx, attestation);

      await expect(
        contract.circuits.completeRedeem(
          await strangerContext("completeRedeem", attested),
          requestId,
          presentedOutput,
          MINT_NONCE,
        ),
      ).rejects.toThrow(/Not the requester/);
    },
  );

  it("rejects an asset amount other than the one the execution was attested with", async () => {
    // Presenting more assets would mint underlying the vault account never received.
    const { contract, ctx, requestId } = await redeemRequested();
    const attested = await attest8(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_REDEEM, ATTESTED_HEIGHT),
      OUTPUT_REDEEM,
    );
    await expect(
      contract.circuits.completeRedeem(
        attested,
        requestId,
        serializeRespondOutput(pureCircuits.redeemRespondSchema(), { assets: REDEEM_ASSETS + 1n }),
        MINT_NONCE,
      ),
    ).rejects.toThrow(/Output does not match the attestation/);
  });

  it.each([
    { name: "queueAttestation8", outputKind: OutputKind.executed, output: OUTPUT_REDEEM },
    { name: "queueAttestation0", outputKind: OutputKind.failed, output: OUTPUT_EMPTY },
  ])(
    "$name refuses an attestation at or below the redeem's lastSeen",
    async ({ outputKind, output }) => {
      const { contract, ctx, requestId } = await redeemRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        output,
        EVM_START_HEIGHT,
      );
      await expect(
        outputKind === OutputKind.executed
          ? contract.circuits.queueAttestation8(ctx, attestation, output)
          : contract.circuits.queueAttestation0(ctx, attestation, output),
      ).rejects.toThrow(/Stale attestation/);
    },
  );

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.completeRedeem(ctx, bytes(32, 0x5a), OUTPUT_REDEEM_IGNORED, MINT_NONCE),
    ).rejects.toThrow(/Not initialised/);
  });

  it("settles once: a second completeRedeem for the same request rejects", async () => {
    const { contract, ctx, requestId } = await redeemRequested();
    const attested = await attest8(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_REDEEM, ATTESTED_HEIGHT),
      OUTPUT_REDEEM,
    );
    const next = (
      await contract.circuits.completeRedeem(attested, requestId, OUTPUT_REDEEM, MINT_NONCE)
    ).context;
    await expect(
      contract.circuits.completeRedeem(next, requestId, OUTPUT_REDEEM, MINT_NONCE),
    ).rejects.toThrow(/Request not sent/);
  });

  it("completeRedeem rejects a supply's request id, and completeSupply a redeem's", async () => {
    const { contract, ctx, requestId: supplyId } = await supplyRequested();
    const redeemed = (await redeem(contract, ctx, VALID_REDEEM)).context;
    const redeemId = requestIdBytes(
      first(
        toSignBidirectionalEventIndex(ledgerOf(redeemed).bidirectionalRedeemMap).keys(),
        "redeem request id",
      ),
    );
    const supplyQueued = (
      await contract.circuits.queueAttestation8(
        redeemed,
        respond(MPC_RESPONSE_SECRET, supplyId, OutputKind.executed, OUTPUT_SUPPLY, ATTESTED_HEIGHT),
        OUTPUT_SUPPLY,
      )
    ).context;
    const bothQueued = (
      await contract.circuits.queueAttestation8(
        supplyQueued,
        respond(MPC_RESPONSE_SECRET, redeemId, OutputKind.executed, OUTPUT_REDEEM, ATTESTED_HEIGHT),
        OUTPUT_REDEEM,
      )
    ).context;
    const attested = await flush(contract, bothQueued, [], [supplyId, redeemId]);

    await expect(
      contract.circuits.completeRedeem(attested, supplyId, OUTPUT_SUPPLY, MINT_NONCE),
    ).rejects.toThrow(/Wrong action/);
    await expect(
      contract.circuits.completeSupply(attested, redeemId, OUTPUT_REDEEM, MINT_NONCE),
    ).rejects.toThrow(/Wrong action/);
  });
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

// A read the replayed transcript expected differs from what the state holds: how the
// ledger rejects a transaction that lost a race.
const READ_CONFLICT = /^REJECTED: mismatch between expected /;
const APPLIED = /^applied$/;

/** The request id the send of the request under `outIndex` recorded in evictionMap. */
const sentRequestId = (
  ctx: CircuitContext<VaultPrivateState>,
  outIndex: Uint8Array,
): Uint8Array => {
  const outIndexHex = bytesToHex(outIndex);
  for (const [requestId, index] of ledgerOf(ctx).evictionMap) {
    if (bytesToHex(index) === outIndexHex) {
      return requestId;
    }
  }
  throw new Error(`no send recorded the request under ${outIndexHex}`);
};

/** One vault-signed action: how a test sends one, and the map its event lands in. */
interface ReplaceableRequestCase {
  /** The action whose sent request the row replaces. */
  action: Action;
  /** Deploy, initialise and send one request of the action, returning its request id. */
  requested: () => Promise<{
    contract: Contract<VaultPrivateState>;
    ctx: CircuitContext<VaultPrivateState>;
    requestId: Uint8Array;
  }>;
  /** The event map the sent request's nonce is read from. */
  map: (state: VaultLedgerState) => Parameters<typeof toSignBidirectionalEventIndex>[0];
}

const REPLACEABLE_REQUEST_CASES: ReplaceableRequestCase[] = [
  {
    action: Action.withdraw,
    requested: withdrawRequested,
    map: (state) => state.bidirectionalWithdrawMap,
  },
  {
    action: Action.approve,
    requested: approveRequested,
    map: (state) => state.bidirectionalApproveMap,
  },
  { action: Action.swap, requested: swapRequested, map: (state) => state.bidirectionalSwapMap },
  {
    action: Action.supply,
    requested: supplyRequested,
    map: (state) => state.bidirectionalSupplyMap,
  },
  {
    action: Action.redeem,
    requested: redeemRequested,
    map: (state) => state.bidirectionalRedeemMap,
  },
  {
    action: Action.replaceNonce,
    requested: replaceNonceRequested,
    map: (state) => state.bidirectionalReplaceNonceMap,
  },
];

describe("replace nonce: the requests it can replace", () => {
  it.each(REPLACEABLE_REQUEST_CASES)(
    "replaces the nonce a sent $action request holds, read from its own event",
    async ({ action, requested, map }) => {
      const { contract, ctx, requestId } = await requested();
      const sentNonce = first(
        toSignBidirectionalEventIndex(map(ledgerOf(ctx))).values(),
        "sent request",
      ).txParams.nonce;

      // replaceNonceRequested queues under the base index, so this replacement takes the next.
      const inIndex = VALID_REPLACE_NONCE.inIndex + 1n;
      const queued = (
        await queueReplaceNonce(contract, ctx, {
          ...VALID_REPLACE_NONCE,
          inIndex,
          requestId,
          action,
        })
      ).context;

      const entry = ledgerOf(queued).inputRequestBuffer.lookup(inIndex);
      expect(entry.action).toBe(Action.replaceNonce);
      expect(entry.useNextVaultAccountNonce).toBe(false);
      expect(entry.evmNonce).toBe(sentNonce);
    },
  );

  it("rejects a deposit: the caller's account signs it, so it holds no vault nonce", async () => {
    const { contract, ctx, requestId: depositId } = await depositRequested();
    await expect(
      queueReplaceNonce(contract, ctx, {
        ...VALID_REPLACE_NONCE,
        requestId: depositId,
        action: Action.deposit,
      }),
    ).rejects.toThrow(/Deposit has no vault nonce/);
  });
});

/** The request id of the sent withdrawal whose transaction carries `nonce`. */
const sentWithdrawId = (ctx: CircuitContext<VaultPrivateState>, nonce: bigint): Uint8Array => {
  for (const [idHex, record] of toSignBidirectionalEventIndex(
    ledgerOf(ctx).bidirectionalWithdrawMap,
  )) {
    if (record.txParams.nonce === nonce) return requestIdBytes(idHex);
  }
  throw new Error(`no sent withdrawal carries nonce ${String(nonce)}`);
};

// ---- Contention fixtures ----

// The busy vault's traffic, every item of it waiting for a flush: a deposit sent and
// attested at BUSY_HEIGHT, a deposit queued and a withdrawal queued. Their indexes and
// nonces are clear of every action fixture's.
const BUSY_ATTESTED_DEPOSIT: DepositCallArgs = { ...VALID_DEPOSIT, inIndex: 101n, evmNonce: 7n };
const BUSY_QUEUED_DEPOSIT: DepositCallArgs = { ...VALID_DEPOSIT, inIndex: 102n, evmNonce: 8n };
const BUSY_QUEUED_WITHDRAW: WithdrawCallArgs = { ...VALID_WITHDRAW, inIndex: 103n };
const BUSY_HEIGHT = 150n;

/**
 * Deploy + initialise, then queue the busy vault's traffic: the shared state every
 * contention test builds on. Returns the queued attestation's request id alongside
 * the context.
 */
const busyVault = async () => {
  const { contract, ctx } = await deployInitialised();
  const { context: sent, outIndex } = await deposit(contract, ctx, BUSY_ATTESTED_DEPOSIT);
  const attestedId = sentRequestId(sent, outIndex);
  const queuedAttestation = (
    await contract.circuits.queueAttestation1(
      sent,
      respond(MPC_RESPONSE_SECRET, attestedId, OutputKind.executed, OUTPUT_SUCCESS, BUSY_HEIGHT),
      OUTPUT_SUCCESS,
    )
  ).context;
  const queuedDeposit = (await queueDeposit(contract, queuedAttestation, BUSY_QUEUED_DEPOSIT))
    .context;
  const busy = (await queueWithdraw(contract, queuedDeposit, BUSY_QUEUED_WITHDRAW)).context;
  return { contract, ctx: busy, attestedId };
};

/**
 * The flush that moves all of the busy vault's traffic, so it raises globalLastSeen,
 * advances vaultAccountNonce and moves a caller-signed request.
 */
const busyFlushSlots = (attestedId: Uint8Array): FlushSlot[] =>
  flushSlots([BUSY_QUEUED_DEPOSIT.inIndex, BUSY_QUEUED_WITHDRAW.inIndex], [attestedId]);

/** A user circuit, run on the busy vault once the request it acts on is arranged. */
interface UserCircuitCase {
  /** The user circuit the row runs, and the request it acts on. */
  name: string;
  /**
   * Arrange the row's own request on `ctx`, every flush carrying only that request's
   * items, then run the user circuit. Returns the state the circuit was built on and
   * its run.
   */
  run: (
    contract: Contract<VaultPrivateState>,
    ctx: CircuitContext<VaultPrivateState>,
  ) => Promise<{
    shared: CircuitContext<VaultPrivateState>;
    user: CircuitResults<VaultPrivateState, []>;
  }>;
}

const USER_CIRCUIT_CASES: UserCircuitCase[] = [
  {
    name: "startDeposit",
    run: async (contract, ctx) => ({
      shared: ctx,
      user: await queueDeposit(contract, ctx, VALID_DEPOSIT),
    }),
  },
  {
    name: "startWithdraw",
    run: async (contract, ctx) => ({
      shared: ctx,
      user: await queueWithdraw(contract, ctx, VALID_WITHDRAW),
    }),
  },
  {
    name: "startApproveRouter",
    run: async (contract, ctx) => ({
      shared: ctx,
      user: await ROUTER_APPROVAL.start(contract, ctx),
    }),
  },
  {
    name: "startApproveStata",
    run: async (contract, ctx) => ({
      shared: ctx,
      user: await STATA_APPROVAL.start(contract, ctx),
    }),
  },
  {
    name: "startReplaceNonce",
    run: async (contract, ctx) => {
      const { context: shared, outIndex } = await withdraw(contract, ctx, VALID_WITHDRAW);
      const withdrawId = sentRequestId(shared, outIndex);
      return {
        shared,
        user: await queueReplaceNonce(contract, shared, {
          ...VALID_REPLACE_NONCE,
          requestId: withdrawId,
        }),
      };
    },
  },
  {
    name: "startSwap",
    run: async (contract, ctx) => ({
      shared: ctx,
      user: await queueSwap(contract, ctx, VALID_SWAP),
    }),
  },
  {
    name: "startSupply",
    run: async (contract, ctx) => ({
      shared: ctx,
      user: await queueSupply(contract, ctx, VALID_SUPPLY),
    }),
  },
  {
    name: "startRedeem",
    run: async (contract, ctx) => ({
      shared: ctx,
      user: await queueRedeem(contract, ctx, VALID_REDEEM),
    }),
  },
  {
    name: "sendDeposit",
    run: async (contract, ctx) => {
      const queued = (await queueDeposit(contract, ctx, VALID_DEPOSIT)).context;
      const outIndex = queuedRequestIndex(ledgerOf(queued), VALID_DEPOSIT.inIndex);
      const shared = await flush(contract, queued, [VALID_DEPOSIT.inIndex], []);
      return { shared, user: await contract.circuits.sendDeposit(shared, outIndex) };
    },
  },
  {
    name: "sendWithdraw",
    run: async (contract, ctx) => {
      const queued = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
      const shared = await flush(contract, queued, [VALID_WITHDRAW.inIndex], []);
      const outIndex = flushedRequestIndex(
        ledgerOf(shared),
        Action.withdraw,
        VALID_WITHDRAW.inIndex,
      );
      return { shared, user: await contract.circuits.sendWithdraw(shared, outIndex) };
    },
  },
  {
    name: "sendApprove",
    run: async (contract, ctx) => {
      const queued = (await ROUTER_APPROVAL.start(contract, ctx)).context;
      const shared = await flush(contract, queued, [APPROVE_INDEX], []);
      const outIndex = flushedRequestIndex(ledgerOf(shared), Action.approve, APPROVE_INDEX);
      return { shared, user: await contract.circuits.sendApprove(shared, outIndex) };
    },
  },
  {
    name: "sendReplaceNonce",
    run: async (contract, ctx) => {
      const { context: withdrawn, outIndex: withdrawIndex } = await withdraw(
        contract,
        ctx,
        VALID_WITHDRAW,
      );
      const queued = (
        await queueReplaceNonce(contract, withdrawn, {
          ...VALID_REPLACE_NONCE,
          requestId: sentRequestId(withdrawn, withdrawIndex),
        })
      ).context;
      const outIndex = queuedRequestIndex(ledgerOf(queued), VALID_REPLACE_NONCE.inIndex);
      const shared = await flush(contract, queued, [VALID_REPLACE_NONCE.inIndex], []);
      return { shared, user: await contract.circuits.sendReplaceNonce(shared, outIndex) };
    },
  },
  {
    name: "sendSwap",
    run: async (contract, ctx) => {
      const queued = (await queueSwap(contract, ctx, VALID_SWAP)).context;
      const shared = await flush(contract, queued, [VALID_SWAP.inIndex], []);
      const outIndex = flushedRequestIndex(ledgerOf(shared), Action.swap, VALID_SWAP.inIndex);
      return { shared, user: await contract.circuits.sendSwap(shared, outIndex) };
    },
  },
  {
    name: "sendSupply",
    run: async (contract, ctx) => {
      const queued = (await queueSupply(contract, ctx, VALID_SUPPLY)).context;
      const shared = await flush(contract, queued, [VALID_SUPPLY.inIndex], []);
      const outIndex = flushedRequestIndex(ledgerOf(shared), Action.supply, VALID_SUPPLY.inIndex);
      return { shared, user: await contract.circuits.sendSupply(shared, outIndex) };
    },
  },
  {
    name: "sendRedeem",
    run: async (contract, ctx) => {
      const queued = (await queueRedeem(contract, ctx, VALID_REDEEM)).context;
      const shared = await flush(contract, queued, [VALID_REDEEM.inIndex], []);
      const outIndex = flushedRequestIndex(ledgerOf(shared), Action.redeem, VALID_REDEEM.inIndex);
      return { shared, user: await contract.circuits.sendRedeem(shared, outIndex) };
    },
  },
  {
    name: "queueAttestation1 for a deposit",
    run: async (contract, ctx) => {
      const { context: shared, outIndex } = await deposit(contract, ctx, VALID_DEPOSIT);
      const requestId = sentRequestId(shared, outIndex);
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        OutputKind.executed,
        OUTPUT_SUCCESS,
        ATTESTED_HEIGHT,
      );
      return {
        shared,
        user: await contract.circuits.queueAttestation1(shared, attestation, OUTPUT_SUCCESS),
      };
    },
  },
  {
    name: "queueAttestation1 for a withdrawal",
    run: async (contract, ctx) => {
      const { context: shared, outIndex } = await withdraw(contract, ctx, VALID_WITHDRAW);
      const requestId = sentRequestId(shared, outIndex);
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        OutputKind.executed,
        OUTPUT_SUCCESS,
        ATTESTED_HEIGHT,
      );
      return {
        shared,
        user: await contract.circuits.queueAttestation1(shared, attestation, OUTPUT_SUCCESS),
      };
    },
  },
  {
    name: "queueAttestation1 for an approval",
    run: async (contract, ctx) => {
      const { context: shared, outIndex } = await approve(contract, ctx, ROUTER_APPROVAL);
      const requestId = sentRequestId(shared, outIndex);
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        OutputKind.executed,
        OUTPUT_SUCCESS,
        ATTESTED_HEIGHT,
      );
      return {
        shared,
        user: await contract.circuits.queueAttestation1(shared, attestation, OUTPUT_SUCCESS),
      };
    },
  },
  {
    name: "queueAttestation1 for a nonce replacement",
    run: async (contract, ctx) => {
      const { context: withdrawn, outIndex: withdrawIndex } = await withdraw(
        contract,
        ctx,
        VALID_WITHDRAW,
      );
      const { context: shared, outIndex } = await replaceNonce(contract, withdrawn, {
        ...VALID_REPLACE_NONCE,
        requestId: sentRequestId(withdrawn, withdrawIndex),
      });
      const requestId = sentRequestId(shared, outIndex);
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        OutputKind.executed,
        OUTPUT_SUCCESS,
        ATTESTED_HEIGHT,
      );
      return {
        shared,
        user: await contract.circuits.queueAttestation1(shared, attestation, OUTPUT_SUCCESS),
      };
    },
  },
  {
    name: "queueAttestation8 for a swap",
    run: async (contract, ctx) => {
      const { context: shared, outIndex } = await swap(contract, ctx, VALID_SWAP);
      const requestId = sentRequestId(shared, outIndex);
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        OutputKind.executed,
        OUTPUT_SWAP,
        ATTESTED_HEIGHT,
      );
      return {
        shared,
        user: await contract.circuits.queueAttestation8(shared, attestation, OUTPUT_SWAP),
      };
    },
  },
  {
    name: "queueAttestation8 for a supply",
    run: async (contract, ctx) => {
      const { context: shared, outIndex } = await supply(contract, ctx, VALID_SUPPLY);
      const requestId = sentRequestId(shared, outIndex);
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        OutputKind.executed,
        OUTPUT_SUPPLY,
        ATTESTED_HEIGHT,
      );
      return {
        shared,
        user: await contract.circuits.queueAttestation8(shared, attestation, OUTPUT_SUPPLY),
      };
    },
  },
  {
    name: "queueAttestation8 for a redeem",
    run: async (contract, ctx) => {
      const { context: shared, outIndex } = await redeem(contract, ctx, VALID_REDEEM);
      const requestId = sentRequestId(shared, outIndex);
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        OutputKind.executed,
        OUTPUT_REDEEM,
        ATTESTED_HEIGHT,
      );
      return {
        shared,
        user: await contract.circuits.queueAttestation8(shared, attestation, OUTPUT_REDEEM),
      };
    },
  },
  {
    name: "queueAttestation0 for a failed withdrawal",
    run: async (contract, ctx) => {
      const { context: shared, outIndex } = await withdraw(contract, ctx, VALID_WITHDRAW);
      const requestId = sentRequestId(shared, outIndex);
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        OutputKind.failed,
        OUTPUT_EMPTY,
        ATTESTED_HEIGHT,
      );
      return {
        shared,
        user: await contract.circuits.queueAttestation0(shared, attestation, OUTPUT_EMPTY),
      };
    },
  },
  {
    name: "completeDeposit, minting the deposit",
    run: async (contract, ctx) => {
      const { context: sent, outIndex } = await deposit(contract, ctx, VALID_DEPOSIT);
      const requestId = sentRequestId(sent, outIndex);
      const shared = await attest(
        contract,
        sent,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
      );
      return {
        shared,
        user: await contract.circuits.completeDeposit(
          shared,
          requestId,
          OUTPUT_SUCCESS,
          MINT_NONCE,
          CALLER_RECIPIENT,
        ),
      };
    },
  },
  {
    name: "completeWithdraw, re-minting a transfer that returned false",
    run: async (contract, ctx) => {
      const { context: sent, outIndex } = await withdraw(contract, ctx, VALID_WITHDRAW);
      const requestId = sentRequestId(sent, outIndex);
      const shared = await attest(
        contract,
        sent,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_FALSE, ATTESTED_HEIGHT),
        OUTPUT_FALSE,
      );
      return {
        shared,
        user: await contract.circuits.completeWithdraw(shared, requestId, OUTPUT_FALSE, MINT_NONCE),
      };
    },
  },
  {
    name: "completeApprove",
    run: async (contract, ctx) => {
      const { context: sent, outIndex } = await approve(contract, ctx, ROUTER_APPROVAL);
      const requestId = sentRequestId(sent, outIndex);
      const shared = await attest(
        contract,
        sent,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
      );
      return {
        shared,
        user: await contract.circuits.completeApprove(shared, requestId, OUTPUT_SUCCESS),
      };
    },
  },
  {
    name: "completeReplaceNonce",
    run: async (contract, ctx) => {
      const { context: withdrawn, outIndex: withdrawIndex } = await withdraw(
        contract,
        ctx,
        VALID_WITHDRAW,
      );
      const { context: sent, outIndex } = await replaceNonce(contract, withdrawn, {
        ...VALID_REPLACE_NONCE,
        requestId: sentRequestId(withdrawn, withdrawIndex),
      });
      const requestId = sentRequestId(sent, outIndex);
      const shared = await attest(
        contract,
        sent,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
      );
      return {
        shared,
        user: await contract.circuits.completeReplaceNonce(shared, requestId, OUTPUT_SUCCESS),
      };
    },
  },
  {
    name: "completeSwap, minting the bought token and the change",
    run: async (contract, ctx) => {
      const { context: sent, outIndex } = await swap(contract, ctx, VALID_SWAP);
      const requestId = sentRequestId(sent, outIndex);
      const shared = await attest8(
        contract,
        sent,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SWAP, ATTESTED_HEIGHT),
        OUTPUT_SWAP,
      );
      return {
        shared,
        user: await contract.circuits.completeSwap(
          shared,
          requestId,
          OUTPUT_SWAP,
          MINT_NONCE,
          CHANGE_NONCE,
        ),
      };
    },
  },
  {
    name: "completeSupply, minting the shares",
    run: async (contract, ctx) => {
      const { context: sent, outIndex } = await supply(contract, ctx, VALID_SUPPLY);
      const requestId = sentRequestId(sent, outIndex);
      const shared = await attest8(
        contract,
        sent,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUPPLY,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUPPLY,
      );
      return {
        shared,
        user: await contract.circuits.completeSupply(shared, requestId, OUTPUT_SUPPLY, MINT_NONCE),
      };
    },
  },
  {
    name: "completeRedeem, minting the assets",
    run: async (contract, ctx) => {
      const { context: sent, outIndex } = await redeem(contract, ctx, VALID_REDEEM);
      const requestId = sentRequestId(sent, outIndex);
      const shared = await attest8(
        contract,
        sent,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_REDEEM,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_REDEEM,
      );
      return {
        shared,
        user: await contract.circuits.completeRedeem(shared, requestId, OUTPUT_REDEEM, MINT_NONCE),
      };
    },
  },
];

/** Two flushes built on the busy vault: the first lands, then the second is replayed on top. */
interface FlushPairCase {
  /** What the pair shows. */
  name: string;
  /** The slots of the flush that lands first. */
  first: (attestedId: Uint8Array) => FlushSlot[];
  /** The slots of the flush replayed after it. */
  second: (attestedId: Uint8Array) => FlushSlot[];
  /** What the replay of the second flush returns. */
  outcome: RegExp;
}

const FLUSH_PAIR_CASES: FlushPairCase[] = [
  {
    name: "two flushes carrying the same caller-signed request conflict",
    first: () => flushSlots([BUSY_QUEUED_DEPOSIT.inIndex], []),
    second: () => flushSlots([BUSY_QUEUED_DEPOSIT.inIndex], []),
    outcome: READ_CONFLICT,
  },
  {
    name: "two flushes carrying the same vault-signed request conflict",
    first: () => flushSlots([BUSY_QUEUED_WITHDRAW.inIndex], []),
    second: () => flushSlots([BUSY_QUEUED_WITHDRAW.inIndex], []),
    outcome: READ_CONFLICT,
  },
  {
    name: "two flushes carrying the same attestation conflict",
    first: (attestedId) => flushSlots([], [attestedId]),
    second: (attestedId) => flushSlots([], [attestedId]),
    outcome: READ_CONFLICT,
  },
  {
    name: "a request-only flush conflicts after a height-raising flush",
    first: (attestedId) => flushSlots([], [attestedId]),
    second: () => flushSlots([BUSY_QUEUED_DEPOSIT.inIndex], []),
    outcome: READ_CONFLICT,
  },
  {
    name: "an attestation-only flush applies after a request-only flush",
    first: () => flushSlots([BUSY_QUEUED_DEPOSIT.inIndex, BUSY_QUEUED_WITHDRAW.inIndex], []),
    second: (attestedId) => flushSlots([], [attestedId]),
    outcome: APPLIED,
  },
];

/** A request of one action, queued on the busy vault beside its queued withdrawal. */
interface VaultNonceCase {
  /** What the row shows. */
  name: string;
  /** Start the row's request. */
  queue: (
    contract: Contract<VaultPrivateState>,
    ctx: CircuitContext<VaultPrivateState>,
  ) => Promise<CircuitResults<VaultPrivateState, []>>;
  /** The index the request is queued under. */
  inIndex: bigint;
  /** What the replay of the flush moving it returns, after a flush moved the withdrawal. */
  outcome: RegExp;
}

const VAULT_NONCE_CASES: VaultNonceCase[] = [
  {
    name: "a deposit's flush applies: a caller-signed request never reads the vault nonce",
    queue: (contract, ctx) => queueDeposit(contract, ctx, VALID_DEPOSIT),
    inIndex: VALID_DEPOSIT.inIndex,
    outcome: APPLIED,
  },
  {
    name: "a nonce replacement's flush applies: it carries the replaced request's nonce",
    queue: async (contract, ctx) => {
      const { context: withdrawn, outIndex } = await withdraw(contract, ctx, VALID_WITHDRAW);
      return queueReplaceNonce(contract, withdrawn, {
        ...VALID_REPLACE_NONCE,
        requestId: sentRequestId(withdrawn, outIndex),
      });
    },
    inIndex: VALID_REPLACE_NONCE.inIndex,
    outcome: APPLIED,
  },
  {
    name: "a withdrawal's flush conflicts on the vault nonce",
    queue: (contract, ctx) => queueWithdraw(contract, ctx, VALID_WITHDRAW),
    inIndex: VALID_WITHDRAW.inIndex,
    outcome: READ_CONFLICT,
  },
  {
    name: "an approval's flush conflicts on the vault nonce",
    queue: (contract, ctx) => ROUTER_APPROVAL.start(contract, ctx),
    inIndex: APPROVE_INDEX,
    outcome: READ_CONFLICT,
  },
  {
    name: "a swap's flush conflicts on the vault nonce",
    queue: (contract, ctx) => queueSwap(contract, ctx, VALID_SWAP),
    inIndex: VALID_SWAP.inIndex,
    outcome: READ_CONFLICT,
  },
  {
    name: "a supply's flush conflicts on the vault nonce",
    queue: (contract, ctx) => queueSupply(contract, ctx, VALID_SUPPLY),
    inIndex: VALID_SUPPLY.inIndex,
    outcome: READ_CONFLICT,
  },
  {
    name: "a redeem's flush conflicts on the vault nonce",
    queue: (contract, ctx) => queueRedeem(contract, ctx, VALID_REDEEM),
    inIndex: VALID_REDEEM.inIndex,
    outcome: READ_CONFLICT,
  },
];

/** Two starts of one action under different indexes, built on the same state. */
interface ConcurrentStartsCase {
  /** The start circuit and who calls it twice. */
  name: string;
  /** What both starts need sent first, when the fresh vault is not enough. */
  arrange?: (
    contract: Contract<VaultPrivateState>,
    ctx: CircuitContext<VaultPrivateState>,
  ) => Promise<CircuitContext<VaultPrivateState>>;
  /** The first start. */
  first: (
    contract: Contract<VaultPrivateState>,
    ctx: CircuitContext<VaultPrivateState>,
  ) => Promise<CircuitResults<VaultPrivateState, []>>;
  /** The second start, under another index. */
  second: (
    contract: Contract<VaultPrivateState>,
    ctx: CircuitContext<VaultPrivateState>,
  ) => Promise<CircuitResults<VaultPrivateState, []>>;
}

const CONCURRENT_STARTS_CASES: ConcurrentStartsCase[] = [
  {
    name: "startDeposit, by the depositor and a stranger",
    first: (contract, ctx) => queueDeposit(contract, ctx, VALID_DEPOSIT),
    second: async (contract, ctx) =>
      queueDeposit(contract, await strangerContext("startDeposit", ctx), {
        ...VALID_DEPOSIT,
        inIndex: VALID_DEPOSIT.inIndex + 1n,
      }),
  },
  {
    name: "startWithdraw, by the withdrawer and a stranger",
    first: (contract, ctx) => queueWithdraw(contract, ctx, VALID_WITHDRAW),
    second: async (contract, ctx) =>
      queueWithdraw(contract, await strangerContext("startWithdraw", ctx), {
        ...VALID_WITHDRAW,
        inIndex: VALID_WITHDRAW.inIndex + 1n,
      }),
  },
  {
    name: "startApproveRouter, twice by the deployer",
    first: (contract, ctx) => contract.circuits.startApproveRouter(ctx, APPROVE_INDEX, ERC20),
    second: (contract, ctx) =>
      contract.circuits.startApproveRouter(ctx, APPROVE_INDEX + 1n, ERC20_OUT),
  },
  {
    name: "startApproveStata, twice by the deployer",
    first: (contract, ctx) => contract.circuits.startApproveStata(ctx, APPROVE_INDEX),
    second: (contract, ctx) => contract.circuits.startApproveStata(ctx, APPROVE_INDEX + 1n),
  },
  {
    name: "startReplaceNonce, twice by the deployer for two sent withdrawals",
    arrange: async (contract, ctx) => {
      const { context: one } = await withdraw(contract, ctx, VALID_WITHDRAW);
      const { context: two } = await withdraw(contract, one, {
        ...VALID_WITHDRAW,
        inIndex: VALID_WITHDRAW.inIndex + 1n,
      });
      return two;
    },
    first: (contract, ctx) =>
      queueReplaceNonce(contract, ctx, {
        ...VALID_REPLACE_NONCE,
        requestId: sentWithdrawId(ctx, 0n),
      }),
    second: (contract, ctx) =>
      queueReplaceNonce(contract, ctx, {
        ...VALID_REPLACE_NONCE,
        inIndex: VALID_REPLACE_NONCE.inIndex + 1n,
        requestId: sentWithdrawId(ctx, 1n),
      }),
  },
  {
    name: "startSwap, by the swapper and a stranger",
    first: (contract, ctx) => queueSwap(contract, ctx, VALID_SWAP),
    second: async (contract, ctx) =>
      queueSwap(contract, await strangerContext("startSwap", ctx), {
        ...VALID_SWAP,
        inIndex: VALID_SWAP.inIndex + 1n,
      }),
  },
  {
    name: "startSupply, by the supplier and a stranger",
    first: (contract, ctx) => queueSupply(contract, ctx, VALID_SUPPLY),
    second: async (contract, ctx) =>
      queueSupply(contract, await strangerContext("startSupply", ctx), {
        ...VALID_SUPPLY,
        inIndex: VALID_SUPPLY.inIndex + 1n,
      }),
  },
  {
    name: "startRedeem, by the redeemer and a stranger",
    first: (contract, ctx) => queueRedeem(contract, ctx, VALID_REDEEM),
    second: async (contract, ctx) =>
      queueRedeem(contract, await strangerContext("startRedeem", ctx), {
        ...VALID_REDEEM,
        inIndex: VALID_REDEEM.inIndex + 1n,
      }),
  },
];

describe("contention: user circuits never conflict, only flushes do", () => {
  it("CONTROL: a queued deposit applies against the state it was built on", async () => {
    const { contract, ctx } = await deployInitialised();
    const builtOn = stateOf(ctx);
    const run = await queueDeposit(contract, ctx, VALID_DEPOSIT);
    expect(replay(builtOn, run)).toBe("applied");
  });

  it.each(USER_CIRCUIT_CASES)(
    "$name and a concurrent flush both apply, in either order",
    async ({ run }) => {
      const { contract, ctx, attestedId } = await busyVault();
      const { shared, user } = await run(contract, ctx);
      const concurrentFlush = await contract.circuits.flushQueue(
        shared,
        busyFlushSlots(attestedId),
      );
      expect(ledgerOf(concurrentFlush.context).globalLastSeen).toBe(BUSY_HEIGHT);
      expect(ledgerOf(concurrentFlush.context).vaultAccountNonce).toBe(
        ledgerOf(shared).vaultAccountNonce + 1n,
      );

      expect(replay(stateOf(concurrentFlush.context), user, true)).toBe("applied");
      expect(replay(stateOf(user.context), concurrentFlush, true)).toBe("applied");
    },
  );

  it.each(CONCURRENT_STARTS_CASES)(
    "$name: the two starts both apply, in either order",
    async ({ arrange, first: firstStart, second: secondStart }) => {
      const { contract, ctx: fresh } = await deployInitialised();
      const ctx = arrange ? await arrange(contract, fresh) : fresh;
      const firstRun = await firstStart(contract, ctx);
      const secondRun = await secondStart(contract, ctx);
      expect(replay(stateOf(firstRun.context), secondRun, true)).toBe("applied");
      expect(replay(stateOf(secondRun.context), firstRun, true)).toBe("applied");
    },
  );

  it.each(FLUSH_PAIR_CASES)(
    "$name",
    async ({ first: firstSlots, second: secondSlots, outcome }) => {
      const { contract, ctx, attestedId } = await busyVault();
      const firstFlush = await contract.circuits.flushQueue(ctx, firstSlots(attestedId));
      const secondFlush = await contract.circuits.flushQueue(ctx, secondSlots(attestedId));
      expect(replay(stateOf(ctx), secondFlush)).toBe("applied");
      expect(replay(stateOf(firstFlush.context), secondFlush, true)).toMatch(outcome);
    },
  );

  it.each(VAULT_NONCE_CASES)(
    "after a flush moved a withdrawal, $name",
    async ({ queue, inIndex, outcome }) => {
      const { contract, ctx } = await busyVault();
      const shared = (await queue(contract, ctx)).context;
      const nonceFlush = await contract.circuits.flushQueue(
        shared,
        flushSlots([BUSY_QUEUED_WITHDRAW.inIndex], []),
      );
      const actionFlush = await contract.circuits.flushQueue(shared, flushSlots([inIndex], []));
      expect(ledgerOf(nonceFlush.context).vaultAccountNonce).toBe(
        ledgerOf(shared).vaultAccountNonce + 1n,
      );
      expect(replay(stateOf(shared), actionFlush)).toBe("applied");
      expect(replay(stateOf(nonceFlush.context), actionFlush, true)).toMatch(outcome);
    },
  );
});

describe("flushQueue", () => {
  it.each([
    {
      name: "a request slot naming an index nothing is queued under",
      slots: flushSlots([999n], []),
      error: /Request not queued/,
    },
    {
      name: "an attestation slot naming a request id with no queued attestation",
      slots: flushSlots([], [bytes(32, 0x5a)]),
      error: /Attestation not queued/,
    },
  ])("$name fails the flush", async ({ slots, error }) => {
    const { contract, ctx } = await busyVault();
    await expect(contract.circuits.flushQueue(ctx, slots)).rejects.toThrow(error);
  });

  it("a request slot repeated in one flush fails it: the entry has moved by the second slot", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;

    await expect(
      flush(contract, queued, [VALID_WITHDRAW.inIndex, VALID_WITHDRAW.inIndex], []),
    ).rejects.toThrow(/Request not queued/);
  });

  it("an attestation slot repeated in one flush fails it: the record has moved by the second slot", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const queued = (
      await contract.circuits.queueAttestation1(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, BUSY_HEIGHT),
        OUTPUT_SUCCESS,
      )
    ).context;

    await expect(flush(contract, queued, [], [requestId, requestId])).rejects.toThrow(
      /Attestation not queued/,
    );
  });

  it("two twins in one flush fail it, and the first flushed alone moves while the second waits queued", async () => {
    const { contract, ctx } = await deployInitialised();
    const twin = { ...VALID_DEPOSIT, inIndex: VALID_DEPOSIT.inIndex + 1n };
    const queuedFirst = (await queueDeposit(contract, ctx, VALID_DEPOSIT)).context;
    const queuedBoth = (await queueDeposit(contract, queuedFirst, twin)).context;
    const outIndex = queuedRequestIndex(ledgerOf(queuedBoth), VALID_DEPOSIT.inIndex);
    expect(queuedRequestIndex(ledgerOf(queuedBoth), twin.inIndex)).toEqual(outIndex);

    await expect(
      flush(contract, queuedBoth, [VALID_DEPOSIT.inIndex, twin.inIndex], []),
    ).rejects.toThrow(/Identical request open/);
    const flushed = await flush(contract, queuedBoth, [VALID_DEPOSIT.inIndex], []);

    const state = ledgerOf(flushed);
    expect(state.outputRequestBuffer.size()).toBe(1n);
    expect(state.outputRequestBuffer.lookup(outIndex).entry.inIndex).toBe(VALID_DEPOSIT.inIndex);
    expect(state.inputRequestBuffer.member(VALID_DEPOSIT.inIndex)).toBe(false);
    expect(state.inputRequestBuffer.member(twin.inIndex)).toBe(true);
  });

  it("an identical repeat of an open request fails its whole batch, even when it comes last", async () => {
    const { contract, ctx } = await deployInitialised();
    const afterFirst = (await deposit(contract, ctx, VALID_DEPOSIT)).context;
    const repeat = { ...VALID_DEPOSIT, inIndex: 2n };
    const other = { ...VALID_DEPOSIT, inIndex: 3n, evmNonce: VALID_DEPOSIT.evmNonce + 1n };
    const queuedRepeat = (await queueDeposit(contract, afterFirst, repeat)).context;
    const queuedBoth = (await queueDeposit(contract, queuedRepeat, other)).context;

    await expect(flush(contract, queuedBoth, [other.inIndex, repeat.inIndex], [])).rejects.toThrow(
      /Identical request open/,
    );
  });

  it("an attestation below globalLastSeen leaves it unchanged", async () => {
    const { contract, ctx } = await deployInitialised();
    const second = { ...VALID_DEPOSIT, inIndex: 2n, evmNonce: VALID_DEPOSIT.evmNonce + 1n };
    const { context: sentFirst, outIndex: firstIndex } = await deposit(
      contract,
      ctx,
      VALID_DEPOSIT,
    );
    const { context: sentBoth, outIndex: secondIndex } = await deposit(contract, sentFirst, second);
    const firstId = sentRequestId(sentBoth, firstIndex);
    const secondId = sentRequestId(sentBoth, secondIndex);
    const lowerHeight = BUSY_HEIGHT - 30n;

    const raised = await attest(
      contract,
      sentBoth,
      respond(MPC_RESPONSE_SECRET, firstId, OutputKind.executed, OUTPUT_SUCCESS, BUSY_HEIGHT),
      OUTPUT_SUCCESS,
    );
    const lowerFolded = await attest(
      contract,
      raised,
      respond(MPC_RESPONSE_SECRET, secondId, OutputKind.executed, OUTPUT_SUCCESS, lowerHeight),
      OUTPUT_SUCCESS,
    );

    expect(ledgerOf(raised).globalLastSeen).toBe(BUSY_HEIGHT);
    expect(ledgerOf(lowerFolded).outputAttestationBuffer.lookup(secondId).blockHeight).toBe(
      lowerHeight,
    );
    expect(ledgerOf(lowerFolded).globalLastSeen).toBe(BUSY_HEIGHT);
  });

  it.each([
    {
      name: "11 requests",
      inIndexes: Array.from({ length: 11 }, (_, i) => BigInt(i)),
      requestIds: [],
    },
    {
      name: "11 attestations",
      inIndexes: [],
      requestIds: Array.from({ length: 11 }, (_, i) => bytes(32, i)),
    },
    {
      name: "6 requests and 5 attestations",
      inIndexes: Array.from({ length: 6 }, (_, i) => BigInt(i)),
      requestIds: Array.from({ length: 5 }, (_, i) => bytes(32, i)),
    },
  ])("flushSlots refuses $name, one item over the flush width", ({ inIndexes, requestIds }) => {
    expect(() => flushSlots(inIndexes, requestIds)).toThrow(
      "a flush takes at most 10 items; got 11",
    );
  });

  it("flushSlots fills the whole width with items when given exactly FLUSH_WIDTH", () => {
    const slots = flushSlots(
      Array.from({ length: 6 }, (_, i) => BigInt(i)),
      Array.from({ length: 4 }, (_, i) => bytes(32, i)),
    );
    expect(slots).toHaveLength(FLUSH_WIDTH);
    expect(slots.filter(({ channel }) => channel === FlushChannel.empty)).toHaveLength(0);
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
  it("sendWithdraw carries the updated fee envelope and the WITHDRAW gas limit", async () => {
    const { contract, ctx } = await deployInitialised();
    const configured = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;

    const next = (await withdraw(contract, configured, VALID_WITHDRAW)).context;

    expect(envelopeOf(ledgerOf(next).bidirectionalWithdrawMap)).toEqual({
      maxFeePerGas: NEW_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: NEW_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: NEW_WITHDRAW_GAS_LIMIT,
    });
  });

  it("a withdrawal keeps the gas it was queued with when setGasParams runs before its send", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    const flushed = await flush(contract, queued, [VALID_WITHDRAW.inIndex], []);
    const outIndex = flushedRequestIndex(
      ledgerOf(flushed),
      Action.withdraw,
      VALID_WITHDRAW.inIndex,
    );
    const reconfigured = (await setGasParams(contract, flushed, NEW_GAS_PARAMS)).context;

    const sent = (await contract.circuits.sendWithdraw(reconfigured, outIndex)).context;

    expect(envelopeOf(ledgerOf(sent).bidirectionalWithdrawMap)).toEqual({
      maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: DEFAULT_WITHDRAW_GAS_LIMIT,
    });
  });

  it.each(APPROVALS)(
    "$name carries the updated fee envelope and the APPROVE gas limit",
    async (approval) => {
      const { contract, ctx } = await deployInitialised();
      const configured = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;

      const next = (await approve(contract, configured, approval)).context;

      expect(envelopeOf(ledgerOf(next).bidirectionalApproveMap)).toEqual({
        maxFeePerGas: NEW_MAX_FEE_PER_GAS,
        maxPriorityFeePerGas: NEW_MAX_PRIORITY_FEE_PER_GAS,
        gasLimit: NEW_APPROVE_GAS_LIMIT,
      });
    },
  );

  it("an approval keeps the gas it was queued with when setGasParams runs before its send", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await ROUTER_APPROVAL.start(contract, ctx)).context;
    const flushed = await flush(contract, queued, [APPROVE_INDEX], []);
    const outIndex = flushedRequestIndex(ledgerOf(flushed), Action.approve, APPROVE_INDEX);
    const reconfigured = (await setGasParams(contract, flushed, NEW_GAS_PARAMS)).context;

    const sent = (await contract.circuits.sendApprove(reconfigured, outIndex)).context;

    expect(envelopeOf(ledgerOf(sent).bidirectionalApproveMap)).toEqual({
      maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: DEFAULT_APPROVE_GAS_LIMIT,
    });
  });

  it("sendReplaceNonce carries the updated fee envelope at the fixed 21000 gas limit", async () => {
    const { contract, ctx, requestId: withdrawId } = await withdrawRequested();
    const configured = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;

    const next = (
      await replaceNonce(contract, configured, { ...VALID_REPLACE_NONCE, requestId: withdrawId })
    ).context;

    expect(envelopeOf(ledgerOf(next).bidirectionalReplaceNonceMap)).toEqual({
      maxFeePerGas: NEW_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: NEW_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: 21_000n,
    });
  });

  it("a replacement keeps the fees it was queued with when setGasParams runs before its send", async () => {
    const { contract, ctx, requestId: withdrawId } = await withdrawRequested();
    const queued = (
      await queueReplaceNonce(contract, ctx, { ...VALID_REPLACE_NONCE, requestId: withdrawId })
    ).context;
    const outIndex = queuedRequestIndex(ledgerOf(queued), VALID_REPLACE_NONCE.inIndex);
    const flushed = await flush(contract, queued, [VALID_REPLACE_NONCE.inIndex], []);
    const reconfigured = (await setGasParams(contract, flushed, NEW_GAS_PARAMS)).context;

    const sent = (await contract.circuits.sendReplaceNonce(reconfigured, outIndex)).context;

    expect(envelopeOf(ledgerOf(sent).bidirectionalReplaceNonceMap)).toEqual({
      maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: 21_000n,
    });
  });

  it("sendSwap carries the updated fee envelope and the SWAP gas limit", async () => {
    const { contract, ctx } = await deployInitialised();
    const configured = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;

    const next = (await swap(contract, configured, VALID_SWAP)).context;

    expect(envelopeOf(ledgerOf(next).bidirectionalSwapMap)).toEqual({
      maxFeePerGas: NEW_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: NEW_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: NEW_SWAP_GAS_LIMIT,
    });
  });

  it("a swap keeps the gas it was queued with when setGasParams runs before its send", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueSwap(contract, ctx, VALID_SWAP)).context;
    const flushed = await flush(contract, queued, [VALID_SWAP.inIndex], []);
    const outIndex = flushedRequestIndex(ledgerOf(flushed), Action.swap, VALID_SWAP.inIndex);
    const reconfigured = (await setGasParams(contract, flushed, NEW_GAS_PARAMS)).context;

    const sent = (await contract.circuits.sendSwap(reconfigured, outIndex)).context;

    expect(envelopeOf(ledgerOf(sent).bidirectionalSwapMap)).toEqual({
      maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: DEFAULT_SWAP_GAS_LIMIT,
    });
  });

  it("sendSupply carries the updated fee envelope and the SUPPLY gas limit", async () => {
    const { contract, ctx } = await deployInitialised();
    const configured = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;

    const next = (await supply(contract, configured, VALID_SUPPLY)).context;

    expect(envelopeOf(ledgerOf(next).bidirectionalSupplyMap)).toEqual({
      maxFeePerGas: NEW_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: NEW_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: NEW_SUPPLY_GAS_LIMIT,
    });
  });

  it("a supply keeps the gas it was queued with when setGasParams runs before its send", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueSupply(contract, ctx, VALID_SUPPLY)).context;
    const flushed = await flush(contract, queued, [VALID_SUPPLY.inIndex], []);
    const outIndex = flushedRequestIndex(ledgerOf(flushed), Action.supply, VALID_SUPPLY.inIndex);
    const reconfigured = (await setGasParams(contract, flushed, NEW_GAS_PARAMS)).context;

    const sent = (await contract.circuits.sendSupply(reconfigured, outIndex)).context;

    expect(envelopeOf(ledgerOf(sent).bidirectionalSupplyMap)).toEqual({
      maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: DEFAULT_SUPPLY_GAS_LIMIT,
    });
  });

  it("sendRedeem carries the updated fee envelope and the REDEEM gas limit", async () => {
    const { contract, ctx } = await deployInitialised();
    const configured = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;

    const next = (await redeem(contract, configured, VALID_REDEEM)).context;

    expect(envelopeOf(ledgerOf(next).bidirectionalRedeemMap)).toEqual({
      maxFeePerGas: NEW_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: NEW_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: NEW_REDEEM_GAS_LIMIT,
    });
  });

  it("a redeem keeps the gas it was queued with when setGasParams runs before its send", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueRedeem(contract, ctx, VALID_REDEEM)).context;
    const flushed = await flush(contract, queued, [VALID_REDEEM.inIndex], []);
    const outIndex = flushedRequestIndex(ledgerOf(flushed), Action.redeem, VALID_REDEEM.inIndex);
    const reconfigured = (await setGasParams(contract, flushed, NEW_GAS_PARAMS)).context;

    const sent = (await contract.circuits.sendRedeem(reconfigured, outIndex)).context;

    expect(envelopeOf(ledgerOf(sent).bidirectionalRedeemMap)).toEqual({
      maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: DEFAULT_REDEEM_GAS_LIMIT,
    });
  });

  it("sendDeposit is UNAFFECTED: the deposit carries the CALLER's own gas arguments", async () => {
    const { contract, ctx } = await deployInitialised();
    const configured = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;

    const next = (await deposit(contract, configured, VALID_DEPOSIT)).context;

    expect(envelopeOf(ledgerOf(next).bidirectionalDepositMap)).toEqual({
      maxFeePerGas: VALID_DEPOSIT.maxFeePerGas,
      maxPriorityFeePerGas: VALID_DEPOSIT.maxPriorityFeePerGas,
      gasLimit: VALID_DEPOSIT.gasLimit,
    });
  });
});

describe("attested block heights", () => {
  it("initialise seals the start height as the last seen height", async () => {
    const { ctx } = await deployInitialised();
    expect(ledgerOf(ctx).globalLastSeen).toBe(EVM_START_HEIGHT);
  });

  it("queueAttestation1 refuses an attestation at or below the request's lastSeen", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    await expect(
      contract.circuits.queueAttestation1(
        ctx,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          EVM_START_HEIGHT,
        ),
        OUTPUT_SUCCESS,
      ),
    ).rejects.toThrow(/Stale attestation/);
  });

  it("flushing an attestation raises the last seen height to its block", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const settledAt = 150n;
    const attested = await attest(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, settledAt),
      OUTPUT_SUCCESS,
    );
    expect(ledgerOf(attested).globalLastSeen).toBe(settledAt);
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
    const attested = await attest(contract, ctx, attestation, OUTPUT_SUCCESS);
    const settled = (
      await contract.circuits.completeDeposit(
        attested,
        requestId,
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;

    const { context: reissued, outIndex } = await deposit(contract, settled, VALID_DEPOSIT);
    expect(ledgerOf(reissued).evictionMap.lookup(requestId)).toEqual(outIndex);
    expect(ledgerOf(reissued).outputRequestBuffer.lookup(outIndex).lastSeen).toBe(settledAt);
    await expect(
      contract.circuits.queueAttestation1(reissued, attestation, OUTPUT_SUCCESS),
    ).rejects.toThrow(/Stale attestation/);
  });

  it.each([
    { name: "attestation slot first", order: [FlushChannel.attestation, FlushChannel.request] },
    { name: "repeat slot first", order: [FlushChannel.request, FlushChannel.attestation] },
  ])(
    "a repeat queued while the first is open fails a flush beside its attestation ($name), and once settled cannot reuse it",
    async ({ order }) => {
      const { contract, ctx, requestId } = await depositRequested();
      const repeat = { ...VALID_DEPOSIT, inIndex: 2n };
      const settledAt = 150n;
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        OutputKind.executed,
        OUTPUT_SUCCESS,
        settledAt,
      );
      const queuedRepeat = (await queueDeposit(contract, ctx, repeat)).context;
      const queuedBoth = (
        await contract.circuits.queueAttestation1(queuedRepeat, attestation, OUTPUT_SUCCESS)
      ).context;
      // Whatever the slot order, the first request is still open, so the
      // repeat's slot fails the flush.
      const slotFor = (channel: FlushChannel) =>
        channel === FlushChannel.request
          ? { channel, inIndex: repeat.inIndex, requestId: new Uint8Array(32) }
          : { channel, inIndex: 0n, requestId };
      const slots = [...order.map(slotFor), ...flushSlots([], []).slice(order.length)];
      await expect(contract.circuits.flushQueue(queuedBoth, slots)).rejects.toThrow(
        /Identical request open/,
      );
      const oneFlush = await flush(contract, queuedBoth, [], [requestId]);
      expect(ledgerOf(oneFlush).inputRequestBuffer.member(repeat.inIndex)).toBe(true);
      expect(ledgerOf(oneFlush).globalLastSeen).toBe(settledAt);

      const settled = (
        await contract.circuits.completeDeposit(
          oneFlush,
          requestId,
          OUTPUT_SUCCESS,
          MINT_NONCE,
          CALLER_RECIPIENT,
        )
      ).context;
      const outIndex = queuedRequestIndex(ledgerOf(settled), repeat.inIndex);
      const flushed = await flush(contract, settled, [repeat.inIndex], []);
      expect(ledgerOf(flushed).outputRequestBuffer.lookup(outIndex).lastSeen).toBe(settledAt);
      const resent = (await contract.circuits.sendDeposit(flushed, outIndex)).context;
      await expect(
        contract.circuits.queueAttestation1(resent, attestation, OUTPUT_SUCCESS),
      ).rejects.toThrow(/Stale attestation/);
    },
  );

  it("sendDeposit is permissionless: a stranger sends the depositor's request as queued", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueDeposit(contract, ctx, VALID_DEPOSIT)).context;
    const outIndex = queuedRequestIndex(ledgerOf(queued), VALID_DEPOSIT.inIndex);
    const flushed = await flush(contract, queued, [VALID_DEPOSIT.inIndex], []);

    const sent = (
      await contract.circuits.sendDeposit(await strangerContext("sendDeposit", flushed), outIndex)
    ).context;
    const index = toSignBidirectionalEventIndex(ledgerOf(sent).bidirectionalDepositMap);
    expect(index.size).toBe(1);
    const record = first(index.values(), "deposit request");
    expect(record.path).toEqual(DEPLOYER_COMMITMENT);
    expect(record.txParams.nonce).toBe(VALID_DEPOSIT.evmNonce);
  });
});

describe("queueing and settling attestations", () => {
  it("queueAttestation0 rejects a failure signed by a key other than the stored MPC response key", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    await expect(
      contract.circuits.queueAttestation0(
        ctx,
        respond(IMPOSTER_SECRET, requestId, OutputKind.failed, OUTPUT_EMPTY, ATTESTED_HEIGHT),
        OUTPUT_EMPTY,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("refuses a second attestation for a request whose first is still queued", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const attestation = respond(
      MPC_RESPONSE_SECRET,
      requestId,
      OutputKind.executed,
      OUTPUT_SUCCESS,
      ATTESTED_HEIGHT,
    );
    const queued = (await contract.circuits.queueAttestation1(ctx, attestation, OUTPUT_SUCCESS))
      .context;
    await expect(
      contract.circuits.queueAttestation1(queued, attestation, OUTPUT_SUCCESS),
    ).rejects.toThrow(/Attestation already queued/);
  });

  it("refuses a second attestation for a request whose first is flushed", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const attestation = respond(
      MPC_RESPONSE_SECRET,
      requestId,
      OutputKind.executed,
      OUTPUT_SUCCESS,
      ATTESTED_HEIGHT,
    );
    const attested = await attest(contract, ctx, attestation, OUTPUT_SUCCESS);
    await expect(
      contract.circuits.queueAttestation1(attested, attestation, OUTPUT_SUCCESS),
    ).rejects.toThrow(/Attestation already flushed/);
  });

  it("completeDeposit refuses an attestation that is queued but not yet flushed", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const queued = (
      await contract.circuits.queueAttestation1(
        ctx,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
      )
    ).context;
    await expect(
      contract.circuits.completeDeposit(
        queued,
        requestId,
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Attestation not flushed/);
  });
});

// A request index or id no request holds: the circuits below refuse before reading it.
const UNKNOWN_KEY = bytes(32, 0x5a);

describe("before initialise", () => {
  it.each([
    {
      name: "addAllowedToken",
      call: (contract: Contract<VaultPrivateState>, ctx: CircuitContext<VaultPrivateState>) =>
        contract.circuits.addAllowedToken(ctx, ERC20),
    },
    {
      name: "flushQueue",
      call: (contract: Contract<VaultPrivateState>, ctx: CircuitContext<VaultPrivateState>) =>
        contract.circuits.flushQueue(ctx, flushSlots([], [])),
    },
    {
      name: "queueAttestation0",
      call: (contract: Contract<VaultPrivateState>, ctx: CircuitContext<VaultPrivateState>) =>
        contract.circuits.queueAttestation0(
          ctx,
          respond(
            MPC_RESPONSE_SECRET,
            UNKNOWN_KEY,
            OutputKind.failed,
            OUTPUT_EMPTY,
            ATTESTED_HEIGHT,
          ),
          OUTPUT_EMPTY,
        ),
    },
    {
      name: "queueAttestation1",
      call: (contract: Contract<VaultPrivateState>, ctx: CircuitContext<VaultPrivateState>) =>
        contract.circuits.queueAttestation1(
          ctx,
          respond(
            MPC_RESPONSE_SECRET,
            UNKNOWN_KEY,
            OutputKind.executed,
            OUTPUT_SUCCESS,
            ATTESTED_HEIGHT,
          ),
          OUTPUT_SUCCESS,
        ),
    },
    {
      name: "sendDeposit",
      call: (contract: Contract<VaultPrivateState>, ctx: CircuitContext<VaultPrivateState>) =>
        contract.circuits.sendDeposit(ctx, UNKNOWN_KEY),
    },
    {
      name: "completeDeposit",
      call: (contract: Contract<VaultPrivateState>, ctx: CircuitContext<VaultPrivateState>) =>
        contract.circuits.completeDeposit(
          ctx,
          UNKNOWN_KEY,
          OUTPUT_IGNORED,
          MINT_NONCE,
          CALLER_RECIPIENT,
        ),
    },
    {
      name: "sendWithdraw",
      call: (contract: Contract<VaultPrivateState>, ctx: CircuitContext<VaultPrivateState>) =>
        contract.circuits.sendWithdraw(ctx, UNKNOWN_KEY),
    },
    {
      name: "completeWithdraw",
      call: (contract: Contract<VaultPrivateState>, ctx: CircuitContext<VaultPrivateState>) =>
        contract.circuits.completeWithdraw(ctx, UNKNOWN_KEY, OUTPUT_IGNORED, MINT_NONCE),
    },
    {
      name: "sendApprove",
      call: (contract: Contract<VaultPrivateState>, ctx: CircuitContext<VaultPrivateState>) =>
        contract.circuits.sendApprove(ctx, UNKNOWN_KEY),
    },
    {
      name: "completeApprove",
      call: (contract: Contract<VaultPrivateState>, ctx: CircuitContext<VaultPrivateState>) =>
        contract.circuits.completeApprove(ctx, UNKNOWN_KEY, OUTPUT_IGNORED),
    },
  ])("$name refuses an uninitialised vault", async ({ call }) => {
    const { contract, ctx } = await deployContract();
    await expect(call(contract, ctx)).rejects.toThrow(/Not initialised/);
  });
});

// ---- Hand-built ledgers ----

// Some guards hold invariants no sequence of circuit calls breaks: a send records the
// event and the evictionMap entry while the output entry is open, and a complete removes
// all three together. These helpers build the broken ledger by hand, so each such guard
// is seen firing.

/** The value of the vault ledger field `name` in `ctx`'s state. */
const ledgerFieldOf = (ctx: CircuitContext<VaultPrivateState>, name: string): StateValue =>
  compiledFieldIndex(name).reduce((node, index) => {
    const child = node.asArray()?.at(index);
    if (!child) {
      throw new Error(`ledger field ${name} has no node at index ${String(index)}`);
    }
    return child;
  }, ctx.callContext.currentQueryContext.state.state);

/** `node` with the value at `path` below it replaced by `value`. */
const replacedAt = (node: StateValue, path: readonly number[], value: StateValue): StateValue => {
  const [index, ...rest] = path;
  if (index === undefined) {
    return value;
  }
  const children = node.asArray();
  if (!children) {
    throw new Error("a ledger path runs through a node that is not an array");
  }
  return children.reduce(
    (rebuilt, child, i) => rebuilt.arrayPush(i === index ? replacedAt(child, rest, value) : child),
    StateValue.newArray(),
  );
};

/**
 * Re-enter `ctx`'s state as its own caller, about to call `circuitId`, with the vault
 * ledger field `name` replaced by `value`.
 */
const withLedgerField = async (
  circuitId: string,
  ctx: CircuitContext<VaultPrivateState>,
  name: string,
  value: StateValue,
): Promise<CircuitContext<VaultPrivateState>> =>
  createCircuitContext(
    circuitId,
    VAULT_ADDRESS,
    CPK,
    new ChargedState(
      replacedAt(ctx.callContext.currentQueryContext.state.state, compiledFieldIndex(name), value),
    ),
    createVaultPrivateState(SECRET_KEY),
    await signetStateProvider(),
    undefined,
    undefined,
    undefined,
    BLOCK_HASH,
  );

const EMPTY_MAP = StateValue.newMap(new StateMap());

/** One complete circuit, arranged to reach its event check with a flushed failure. */
interface EventMissingCase {
  /** The complete circuit the row calls. */
  name: string;
  /** The action's event map, emptied by hand before the complete. */
  eventMap: string;
  /** Deploy, initialise and send one request of the action. */
  requested: () => Promise<{
    contract: Contract<VaultPrivateState>;
    ctx: CircuitContext<VaultPrivateState>;
    requestId: Uint8Array;
  }>;
  /** The complete call, passed every argument a failure verdict takes. */
  complete: (
    contract: Contract<VaultPrivateState>,
    ctx: CircuitContext<VaultPrivateState>,
    requestId: Uint8Array,
  ) => Promise<unknown>;
}

const EVENT_MISSING_CASES: EventMissingCase[] = [
  {
    name: "completeDeposit",
    eventMap: "bidirectionalDepositMap",
    requested: depositRequested,
    complete: (contract, ctx, requestId) =>
      contract.circuits.completeDeposit(
        ctx,
        requestId,
        OUTPUT_IGNORED,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
  },
  {
    name: "completeWithdraw",
    eventMap: "bidirectionalWithdrawMap",
    requested: withdrawRequested,
    complete: (contract, ctx, requestId) =>
      contract.circuits.completeWithdraw(ctx, requestId, OUTPUT_IGNORED, MINT_NONCE),
  },
  {
    name: "completeApprove",
    eventMap: "bidirectionalApproveMap",
    requested: approveRequested,
    complete: (contract, ctx, requestId) =>
      contract.circuits.completeApprove(ctx, requestId, OUTPUT_IGNORED),
  },
  {
    name: "completeReplaceNonce",
    eventMap: "bidirectionalReplaceNonceMap",
    requested: replaceNonceRequested,
    complete: (contract, ctx, requestId) =>
      contract.circuits.completeReplaceNonce(ctx, requestId, OUTPUT_IGNORED),
  },
  {
    name: "completeSwap",
    eventMap: "bidirectionalSwapMap",
    requested: swapRequested,
    complete: (contract, ctx, requestId) =>
      contract.circuits.completeSwap(ctx, requestId, OUTPUT_SWAP_IGNORED, MINT_NONCE, CHANGE_NONCE),
  },
  {
    name: "completeSupply",
    eventMap: "bidirectionalSupplyMap",
    requested: supplyRequested,
    complete: (contract, ctx, requestId) =>
      contract.circuits.completeSupply(ctx, requestId, OUTPUT_SUPPLY_IGNORED, MINT_NONCE),
  },
  {
    name: "completeRedeem",
    eventMap: "bidirectionalRedeemMap",
    requested: redeemRequested,
    complete: (contract, ctx, requestId) =>
      contract.circuits.completeRedeem(ctx, requestId, OUTPUT_REDEEM_IGNORED, MINT_NONCE),
  },
];

describe("invariant guards, on a ledger built by hand", () => {
  it("queueAttestation1 refuses a sent request whose output entry is gone", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const broken = await withLedgerField(
      "queueAttestation1",
      ctx,
      "outputRequestBuffer",
      EMPTY_MAP,
    );
    await expect(
      contract.circuits.queueAttestation1(
        broken,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
      ),
    ).rejects.toThrow(/Request not open/);
  });

  it("completeDeposit refuses an attested request whose output entry is gone", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const attested = await attest(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
      OUTPUT_SUCCESS,
    );
    const broken = await withLedgerField(
      "completeDeposit",
      attested,
      "outputRequestBuffer",
      EMPTY_MAP,
    );
    await expect(
      contract.circuits.completeDeposit(
        broken,
        requestId,
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Request not open/);
  });

  it("completeDeposit refuses a flushed attestation at or below its entry's lastSeen", async () => {
    // Queueing already refuses such an attestation, and nothing re-stamps an open
    // entry, so the entry comes from a vault that flushed the same deposit later.
    const { contract, ctx, requestId, outIndex } = await depositRequested();
    const attested = await attest(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
      OUTPUT_SUCCESS,
    );
    const later = await deployInitialised(ATTESTED_HEIGHT);
    const laterQueued = (await queueDeposit(later.contract, later.ctx, VALID_DEPOSIT)).context;
    const laterFlushed = await flush(later.contract, laterQueued, [VALID_DEPOSIT.inIndex], []);

    const restamped = await withLedgerField(
      "completeDeposit",
      attested,
      "outputRequestBuffer",
      ledgerFieldOf(laterFlushed, "outputRequestBuffer"),
    );
    expect(ledgerOf(restamped).outputRequestBuffer.lookup(outIndex).lastSeen).toBe(ATTESTED_HEIGHT);
    expect(ledgerOf(restamped).outputAttestationBuffer.lookup(requestId).blockHeight).toBe(
      ATTESTED_HEIGHT,
    );

    await expect(
      contract.circuits.completeDeposit(
        restamped,
        requestId,
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Stale attestation/);
  });

  it.each(EVENT_MISSING_CASES)(
    "$name refuses a settled request whose event is gone",
    async ({ name, eventMap, requested, complete }) => {
      const { contract, ctx, requestId } = await requested();
      const attested = await attestFailure(
        contract,
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_EMPTY, ATTESTED_HEIGHT),
      );
      const broken = await withLedgerField(name, attested, eventMap, EMPTY_MAP);
      await expect(complete(contract, broken, requestId)).rejects.toThrow(/Request event missing/);
    },
  );
});

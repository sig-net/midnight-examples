// Contract-deploy plumbing shared by every contract package's deploy script:
// the deploy config, the compiled-contract binding, and building the unproven
// deploy transaction. Everything contract-SPECIFIC — constructor args, witness
// implementations, initial private state — stays in the contract package's own
// deploy.ts and arrives here through the type parameters.

import { NodeContext } from "@effect/platform-node";
import {
  CompiledContract,
  type Contract,
  ContractExecutable,
} from "@midnight-ntwrk/compact-js/effect";
import { ZKFileConfiguration } from "@midnight-ntwrk/compact-js-node/effect";
import * as CoinPublicKey from "@midnight-ntwrk/platform-js/effect/CoinPublicKey";
import * as Configuration from "@midnight-ntwrk/platform-js/effect/Configuration";
import * as SigningKey from "@midnight-ntwrk/platform-js/effect/SigningKey";
import * as ledger from "@midnightntwrk/ledger-v9";
import type { FacadeState } from "@midnightntwrk/wallet-sdk-facade";
import { Effect, Layer, Option, type Types } from "effect";

import { envOrUndefined } from "./env.ts";
import {
  getFaucetUrl,
  getMidnightNodeConfig,
  type MidnightNodeConfig,
} from "./midnight-node-config.ts";
import { isLocalStandaloneNetwork, type NetworkId } from "./network-id.ts";

/** Everything needed to perform a contract deploy: which stack to target, and which wallet pays for it. */
export interface DeployConfig {
  /** The stack (node/indexer/proof-server endpoints + network id) to deploy to. */
  readonly midnightNodeConfig: MidnightNodeConfig;
  /** Seed (hex or mnemonic) of the wallet that funds & signs the deploy. */
  readonly deployerSeed: string;
}

/**
 * Pre-funded genesis wallet of the local standalone stack: the default
 * deployer for development, and the ONLY network where it holds funds.
 */
export const GENESIS_MINT_WALLET_SEED =
  "0000000000000000000000000000000000000000000000000000000000000001";

// True when `seed` is the genesis mint seed in hex form (0x-optional,
// case-insensitive). A mnemonic never matches. Used to reject the genesis
// seed on a deployed network, where it is unfunded.
function isGenesisSeed(seed: string): boolean {
  return seed.trim().replace(/^0x/i, "").toLowerCase() === GENESIS_MINT_WALLET_SEED;
}

/**
 * Resolve the deployer seed for `networkId`. On the local standalone chain
 * the genesis mint wallet is the default; on every deployed network the
 * genesis wallet is unfunded, so a `DEPLOYER_SEED` funded via that network's
 * faucet is required. The single consumer is {@link getDeployConfig}.
 *
 * @param env - The environment to read `DEPLOYER_SEED` from.
 * @param networkId - The network the deploy targets.
 * @returns The seed (hex or mnemonic) that funds & signs deploys.
 * @throws {Error} If a deployed network has no `DEPLOYER_SEED`, or it is set to the
 *   (unfunded-here) genesis mint seed.
 */
function resolveDeployerSeed(
  env: Record<string, string | undefined>,
  networkId: NetworkId,
): string {
  const provided = envOrUndefined(env, "DEPLOYER_SEED");
  if (isLocalStandaloneNetwork(networkId)) {
    return provided ?? GENESIS_MINT_WALLET_SEED;
  }
  const faucet = getFaucetUrl(env, networkId);
  const fundHint = faucet
    ? `fund a wallet via ${faucet}`
    : "fund a wallet via the network's faucet";
  if (!provided) {
    throw new Error(
      `DEPLOYER_SEED is required on "${networkId}": the genesis mint seed only holds funds on the local ` +
        `standalone chain. Set DEPLOYER_SEED (hex or mnemonic) to a funded wallet: ${fundHint}.`,
    );
  }
  if (isGenesisSeed(provided)) {
    throw new Error(
      `DEPLOYER_SEED is the local genesis mint seed, which holds no funds on "${networkId}". ` +
        `${fundHint} and set DEPLOYER_SEED to it.`,
    );
  }
  return provided;
}

/**
 * Read a {@link DeployConfig} from the environment. Node config comes from
 * {@link getMidnightNodeConfig}; the deployer seed from {@link resolveDeployerSeed}
 * (genesis mint wallet on the local chain, a required funded `DEPLOYER_SEED`
 * on every deployed network).
 *
 * @param env - The environment to read from; defaults to `process.env`.
 * @returns The resolved deploy configuration.
 * @throws {Error} If a deployed network lacks a valid funded `DEPLOYER_SEED` (see
 *   {@link resolveDeployerSeed}).
 */
export function getDeployConfig(
  env: Record<string, string | undefined> = process.env,
): DeployConfig {
  const midnightNodeConfig = getMidnightNodeConfig(env);
  return {
    midnightNodeConfig,
    deployerSeed: resolveDeployerSeed(env, midnightNodeConfig.networkId),
  };
}

/** An unproven contract-deploy transaction, ready to balance/sign/prove/submit via a wallet. */
export interface DeployTransaction {
  /** The contract address this deployment will create, known before submission. */
  readonly contractAddress: string;
  /** The serialized unproven transaction — see `submitUnprovenTransaction` in wallet.ts. */
  readonly serializedTransaction: Uint8Array;
}

/**
 * Bind a generated Compact contract to its witnesses and compiled assets.
 *
 * Thin typed wrapper over the compact-js `CompiledContract` combinators so
 * contract packages need no direct compact-js dependency. Chained data-first
 * on purpose: the witness/asset combinators rebuild the binding via object
 * spread, which drops the prototype carrying `.pipe`.
 *
 * @param tag - Identifier for the binding (not the on-chain address), e.g. the contract name.
 * @param ctor - The `Contract` class exported by the generated `managed/contract` module.
 * @param witnesses - The contract's real witness implementations (from the package's `witnesses.ts`).
 * @param managedDirPath - Absolute path to the compiler output dir (`contract/`, `zkir/`, `keys/`, `compiler/`).
 * @returns The fully-bound {@link CompiledContract.CompiledContract}, ready for {@link buildDeployTransaction}.
 */
export function makeCompiledContract<C extends Contract.Contract<PS>, PS>(
  tag: string,
  ctor: Types.Ctor<C>,
  witnesses: Contract.Contract.Witnesses<C>,
  managedDirPath: string,
): CompiledContract.CompiledContract<C, PS> {
  const base = CompiledContract.make<C, PS>(tag, ctor);
  const withWitnesses = CompiledContract.withWitnesses(base, witnesses);
  return CompiledContract.withCompiledFileAssets(withWitnesses, managedDirPath);
}

// How long the deploy intent stays valid before it must be re-built.
const DEPLOY_TTL_MS = 30 * 60 * 1000;

/**
 * Build an UNPROVEN contract-deploy transaction: run the Compact constructor
 * with `constructorArgs`, attach the verifier keys from the compiled assets,
 * and wrap the resulting contract state in a deploy intent. Touches no
 * network and no wallet — the only wallet-derived input is the deployer's
 * coin public key, which feeds the constructor's context.
 *
 * @param compiledContract - The bound contract, from {@link makeCompiledContract}.
 * @param networkId - The network the transaction targets.
 * @param coinPublicKeyHex - The deploying wallet's Zswap coin public key (hex).
 * @param initialPrivateState - The private state the constructor (and its witnesses, if any) runs against.
 * @param constructorArgs - The contract's constructor arguments, statically typed per contract.
 * @returns The deterministic contract address plus the serialized unproven transaction.
 * @throws {Error} If the constructor traps, or the verifier keys are missing from the
 * compiled assets (run `compile:zk` — the default `--skip-zk` output has none).
 */
export async function buildDeployTransaction<C extends Contract.Contract<PS>, PS>(
  compiledContract: CompiledContract.CompiledContract<C, PS>,
  networkId: NetworkId,
  coinPublicKeyHex: string,
  initialPrivateState: PS,
  ...constructorArgs: Contract.Contract.InitializeParameters<C>
): Promise<DeployTransaction> {
  // initialize() needs the deployer's coin public key (constructor context)
  // and the contract maintenance authority's signing key. A set
  // MAINTENANCE_SIGNING_KEY becomes that authority, so the contract can later
  // gain circuits via a maintenance update. Unset samples a throwaway
  // authority, leaving the contract unmaintainable.
  const keysLayer = Layer.succeed(Configuration.Keys, {
    coinPublicKey: CoinPublicKey.Hex(coinPublicKeyHex),
    getSigningKey: () => resolveMaintenanceSigningKey(),
  });

  // Run the contract constructor and attach verifier keys → initial ContractState.
  const deployResult = await Effect.runPromise(
    ContractExecutable.make(compiledContract)
      .initialize(initialPrivateState, ...constructorArgs)
      .pipe(
        Effect.provide(
          ZKFileConfiguration.layer(CompiledContract.getCompiledAssetsPath(compiledContract)),
        ),
        Effect.provide(NodeContext.layer),
        Effect.provide(keysLayer),
      ),
  );

  // `initialize` yields an onchain-runtime ContractState; bridge it to the
  // ledger's ContractState (separate package/type) via its serialized form.
  const contractState = ledger.ContractState.deserialize(
    deployResult.public.contractState.serialize(),
  );

  const deploy = new ledger.ContractDeploy(contractState);
  const intent = ledger.Intent.new(new Date(Date.now() + DEPLOY_TTL_MS)).addDeploy(deploy);
  const transaction = ledger.Transaction.fromPartsRandomized(
    networkId,
    undefined,
    undefined,
    intent,
  );

  return {
    contractAddress: deploy.address,
    serializedTransaction: transaction.serialize(),
  };
}

/** A circuit held back from the base deploy, added afterwards by a maintenance update. */
export interface DeferredCircuit {
  /** The provable circuit id (its name). */
  readonly circuitId: string;
  /** The circuit's verifier key bytes, carried to the maintenance-add. */
  readonly verifierKey: Uint8Array;
}

/** A base deploy plus the circuits split out for follow-up maintenance updates. */
export interface SplitDeployTransaction extends DeployTransaction {
  /** The deferred circuits, in deploy order, to add via {@link buildMaintenanceInsertTransaction}. */
  readonly deferred: readonly DeferredCircuit[];
}

const operationIdToString = (id: string | Uint8Array): string =>
  typeof id === "string" ? id : new TextDecoder().decode(id);

/**
 * Like {@link buildDeployTransaction}, but registers ONLY the circuits in
 * `baseCircuitIds` in the initial contract state, returning the REST so the caller
 * can add them with {@link buildMaintenanceInsertTransaction}. A contract whose full
 * verifier-key set overflows a block (the 17-circuit vault) deploys as a small base
 * plus per-circuit maintenance adds. Keep `baseCircuitIds` minimal (one small circuit
 * is enough) so the base tx is well under the block limit; every other circuit is
 * deferred. The constructor runs once over the full assets (every key must be present);
 * the split is purely which operations land in the deployed state. Requires
 * `MAINTENANCE_SIGNING_KEY` so the contract has an authority to sign the follow-up adds.
 *
 * @param compiledContract - The bound contract, from {@link makeCompiledContract}.
 * @param networkId - The network the transaction targets.
 * @param coinPublicKeyHex - The deploying wallet's Zswap coin public key (hex).
 * @param initialPrivateState - The private state the constructor runs against.
 * @param baseCircuitIds - Circuit ids to register in the base deploy; all others are deferred.
 * @param constructorArgs - The contract's constructor arguments.
 * @returns The base {@link DeployTransaction} plus the {@link DeferredCircuit}s to add next.
 * @throws {Error} If `MAINTENANCE_SIGNING_KEY` is unset (the deferred circuits could never be
 *   installed), a `baseCircuitIds` entry matches no compiled circuit, the constructor traps,
 *   or a verifier key is missing (run `compile:zk`).
 */
export async function buildDeployTransactionDeferring<C extends Contract.Contract<PS>, PS>(
  compiledContract: CompiledContract.CompiledContract<C, PS>,
  networkId: NetworkId,
  coinPublicKeyHex: string,
  initialPrivateState: PS,
  baseCircuitIds: readonly string[],
  ...constructorArgs: Contract.Contract.InitializeParameters<C>
): Promise<SplitDeployTransaction> {
  // Fail before anything is built, let alone submitted: without an authority key the
  // base deploy would land under an SDK-sampled throwaway authority and the deferred
  // circuits could never be installed, leaving a permanently unusable contract.
  if (Option.isNone(resolveMaintenanceSigningKey())) {
    throw new Error(
      "MAINTENANCE_SIGNING_KEY must be set for a split deploy: the deferred circuits are " +
        "installed by maintenance updates its authority signs.",
    );
  }
  const keysLayer = Layer.succeed(Configuration.Keys, {
    coinPublicKey: CoinPublicKey.Hex(coinPublicKeyHex),
    getSigningKey: () => resolveMaintenanceSigningKey(),
  });

  const deployResult = await Effect.runPromise(
    ContractExecutable.make(compiledContract)
      .initialize(initialPrivateState, ...constructorArgs)
      .pipe(
        Effect.provide(
          ZKFileConfiguration.layer(CompiledContract.getCompiledAssetsPath(compiledContract)),
        ),
        Effect.provide(NodeContext.layer),
        Effect.provide(keysLayer),
      ),
  );

  const fullState = ledger.ContractState.deserialize(deployResult.public.contractState.serialize());

  // Rebuild a base state carrying the same primary data and maintenance authority, but only the
  // BASE operations. Every other circuit's verifier key travels out for the caller to
  // maintenance-add, which is what keeps the deploy tx under the block limit.
  const keep = new Set(baseCircuitIds);
  const base = new ledger.ContractState();
  base.data = fullState.data;
  base.maintenanceAuthority = fullState.maintenanceAuthority;
  const deferred: DeferredCircuit[] = [];
  const kept = new Set<string>();
  for (const id of fullState.operations()) {
    const op = fullState.operation(id);
    if (!op) continue;
    const name = operationIdToString(id);
    if (keep.has(name)) {
      base.setOperation(id, op);
      kept.add(name);
    } else {
      deferred.push({ circuitId: name, verifierKey: op.verifierKey });
    }
  }
  // A baseCircuitIds entry that matched nothing (a typo, or a renamed circuit) would
  // otherwise silently defer everything and deploy a zero-operation base.
  const unmatched = baseCircuitIds.filter((id) => !kept.has(id));
  if (unmatched.length > 0) {
    throw new Error(
      `baseCircuitIds ${unmatched.map((id) => `"${id}"`).join(", ")} match no compiled circuit; ` +
        `compiled circuits: ${[...fullState.operations()].map(operationIdToString).join(", ")}`,
    );
  }

  const deploy = new ledger.ContractDeploy(base);
  const intent = ledger.Intent.new(new Date(Date.now() + DEPLOY_TTL_MS)).addDeploy(deploy);
  const transaction = ledger.Transaction.fromPartsRandomized(
    networkId,
    undefined,
    undefined,
    intent,
  );

  return {
    contractAddress: deploy.address,
    serializedTransaction: transaction.serialize(),
    deferred,
  };
}

/**
 * `MAINTENANCE_SIGNING_KEY` as normalized 64-digit hex, or undefined when unset. The single
 * definition of the env var's accepted format; {@link resolveMaintenanceSigningKey} and
 * {@link buildMaintenanceInsertTransaction} both parse through it.
 *
 * @returns The normalized key hex, or undefined when the env var is unset.
 * @throws {Error} If the env var is set but not 32 bytes of hex.
 */
function maintenanceSigningKeyHex(): string | undefined {
  const raw = envOrUndefined(process.env, "MAINTENANCE_SIGNING_KEY");
  if (!raw) return undefined;
  const hex = raw.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(
      "MAINTENANCE_SIGNING_KEY must be 32 bytes of hex (0x optional): a BIP-340 signing key.",
    );
  }
  return hex;
}

/**
 * Build an unproven maintenance-update transaction that inserts `verifierKey` under `circuitId`
 * on the deployed contract at `contractAddress`, signed by the `MAINTENANCE_SIGNING_KEY` authority.
 * Ledger-level operation-version `'v4'` (which accepts the v7 verifier keys the compiler emits),
 * the path proven to be accepted on-chain. Binds to the authority counter read from
 * `currentContractStateBytes`, so re-query the live state before each add.
 *
 * @param networkId - The network the transaction targets.
 * @param contractAddress - The deployed contract's address (hex).
 * @param circuitId - The circuit id to install `verifierKey` under.
 * @param verifierKey - The new circuit's verifier key bytes.
 * @param currentContractStateBytes - Serialized live contract state (from queryContractState).
 * @returns The serialized unproven maintenance transaction.
 * @throws {Error} If `MAINTENANCE_SIGNING_KEY` is unset or malformed.
 */
export function buildMaintenanceInsertTransaction(
  networkId: NetworkId,
  contractAddress: string,
  circuitId: string,
  verifierKey: Uint8Array,
  currentContractStateBytes: Uint8Array,
): { serializedTransaction: Uint8Array } {
  const hex = maintenanceSigningKeyHex();
  if (hex === undefined) {
    throw new Error(
      "MAINTENANCE_SIGNING_KEY must be set to sign a maintenance update for the contract's authority.",
    );
  }

  const contractState = ledger.ContractState.deserialize(currentContractStateBytes);
  const counter = contractState.maintenanceAuthority.counter;

  const versionedKey = new ledger.ContractOperationVersionedVerifierKey("v4", verifierKey);
  const insert = new ledger.VerifierKeyInsert(circuitId, versionedKey);
  let update = new ledger.MaintenanceUpdate(contractAddress, [insert], counter);
  const signingKey = ledger.signingKeyFromBip340(Uint8Array.from(Buffer.from(hex, "hex")));
  update = update.addSignature(0n, ledger.signData(signingKey, update.dataToSign));

  const intent = ledger.Intent.new(new Date(Date.now() + DEPLOY_TTL_MS)).addMaintenanceUpdate(
    update,
  );
  const transaction = ledger.Transaction.fromPartsRandomized(
    networkId,
    undefined,
    undefined,
    intent,
  );
  return { serializedTransaction: transaction.serialize() };
}

/**
 * Fail fast when the deployer wallet cannot pay for a transaction: fees are
 * paid in DUST, which only generates on NIGHT registered for dust generation.
 *
 * @param state - The synced facade state to inspect (see `withSyncedWalletFacade` in wallet.ts).
 * @throws {Error} If the deployer's spendable DUST balance is zero.
 */
export function assertDeployerFunded(state: FacadeState): void {
  const dust = state.dust.balance(new Date());
  if (dust > 0n) return;
  const night = Object.values(state.unshielded.balances).reduce((sum, value) => sum + value, 0n);
  throw new Error(
    `deployer wallet has no DUST to pay fees (NIGHT balance: ${String(night)}). ` +
      "Fund the wallet with NIGHT and register it for dust generation, then retry.",
  );
}

/**
 * The contract maintenance authority signing key, read from
 * `MAINTENANCE_SIGNING_KEY` (32-byte BIP-340 key as hex, `0x` optional).
 * Present makes the deployed contract's authority this key, so it can gain
 * circuits via a maintenance update later; the same secret must sign those
 * updates. Absent yields `Option.none()`, leaving the contract unmaintainable.
 *
 * @returns The maintenance authority key, or none when the env var is unset.
 * @throws {Error} If `MAINTENANCE_SIGNING_KEY` is set but not 32 bytes of hex.
 */
export function resolveMaintenanceSigningKey(): Option.Option<SigningKey.SigningKey> {
  const hex = maintenanceSigningKeyHex();
  if (hex === undefined) return Option.none();
  return Option.some(SigningKey.make(hex));
}

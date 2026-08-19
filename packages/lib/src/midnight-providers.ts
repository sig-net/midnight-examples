// Adapts the WalletFacade-based account to midnight-js's wallet interfaces,
// so midnight-js (`findDeployedContract` → `contract.callTx.<circuit>(...)`)
// can balance, prove and submit contract-call transactions through the same
// wallet this package builds. compact-js binds contracts and runs circuits
// locally but does NOT assemble + prove + submit a ledger call transaction —
// midnight-js is the orchestration layer for that. The contract-specific
// provider set (indexer / proof server / zk-config / private-state store)
// lives with each contract package, since it depends on that package's
// compiled assets.

import {
  createProofProvider,
  type MidnightProvider,
  type ProofProvider,
  type UnboundTransaction,
  type WalletProvider,
  type ZKConfigProvider,
  ZKConfigRegistry,
  zkConfigToProvingKeyMaterial,
} from "@midnight-ntwrk/midnight-js/types";
import { httpClientProvingProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import type { ProvingKeyMaterial, ProvingProvider } from "@midnightntwrk/ledger-v9";
import type { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";

import type { AccountKeys } from "./wallet.ts";

// Balancing recipes expire 30 min out (same TTL as submitUnprovenTransaction).
const BALANCE_TTL_MS = 30 * 60 * 1000;

/**
 * Adapt a started {@link WalletFacade} + {@link AccountKeys} to midnight-js's
 * `WalletProvider & MidnightProvider`. `balanceTx` balances the unbound
 * transaction with the account's shielded/dust keys, signs, then finalizes
 * (which proves); `submitTx` relays through the facade.
 *
 * The midnight-js ledger types come from `midnight-js-protocol`; the facade
 * uses `ledger-v9`. They are the same underlying classes, so the values pass
 * straight through — the casts only bridge the two packages' nominal type
 * identities.
 *
 * @param facade - A started (and synced) wallet facade.
 * @param keys - The key material of the same wallet, for balancing and signing.
 * @returns The provider pair midnight-js uses as balancer + submitter.
 */
export function createWalletAndMidnightProvider(
  facade: WalletFacade,
  keys: AccountKeys,
): WalletProvider & MidnightProvider {
  return {
    getCoinPublicKey: () => keys.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => keys.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: UnboundTransaction, ttl?: Date) {
      const recipe = await facade.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: keys.shieldedSecretKeys, dustSecretKey: keys.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + BALANCE_TTL_MS) },
      );
      const signed = await facade.signRecipe(recipe, keys.unshieldedKeystore.signDataAsync);
      return await facade.finalizeRecipe(signed);
    },
    submitTx: (tx) => facade.submitTransaction(tx),
  };
}

/** Phase of one proof-server round trip reported to a {@link ProofServerObserver}. */
export enum ProofServerPhase {
  Check = "check",
  Prove = "prove",
}

/**
 * One observed proof-server round trip (a /check or /prove call), as reported
 * to a {@link ProofServerObserver}. `keyLocation` attributes the round trip to
 * a circuit: `contract:<addr>/<circuitId>?vk=…` for contract circuits,
 * `midnight/...` for protocol builtins.
 */
export interface ProofServerObservation {
  /** Which endpoint the round trip hit. */
  readonly phase: ProofServerPhase;
  /** Canonical proving key location of the call being checked/proved. */
  readonly keyLocation: string;
  /** Wall-clock duration of the round trip. */
  readonly ms: number;
  /** The serialized proof preimage sent to the proof server. */
  readonly serializedPreimage: Uint8Array;
  /** The proof returned by /prove (successful {@link ProofServerPhase.Prove} observations only). */
  readonly proof?: Uint8Array;
  /** Error message when the round trip threw (the error is rethrown after observing). */
  readonly error?: string;
}

/**
 * Sink for {@link ProofServerObservation}s, called synchronously after each
 * /check and /prove round trip of a provider built with
 * {@link createCrossContractProofServerProvider}. Must not throw.
 */
export type ProofServerObserver = (observation: ProofServerObservation) => void;

/**
 * Build the {@link ProofProvider} for a contract's provider set: proving via
 * the proof server's /check + /prove endpoints, with proving/verifier keys
 * resolved across a *set* of compiled-contract sources — what a
 * **cross-contract call** needs: one transaction whose call tree spans several
 * deployed contracts, each carrying its own proof, so proving must find
 * artifacts for every contract in the tree (the root and each callee). A
 * single-contract provider set is just the one-element case.
 *
 * The `ZKConfigRegistry` joins each call's canonical key location
 * (`contract:<addr>/<circuitId>?vk=<sha-256 of the deployed verifier key>`) to
 * the source whose local verifier key matches — immune to redeploys and to
 * circuit-name collisions across contracts. Pass one `ZKConfigProvider` per
 * compiled contract the call can reach (the caller plus every callee).
 *
 * Exists instead of midnight-js's own `httpClientProofProvider` because that
 * one (5.0.0-beta.3) builds a circuit-level `ProvingProvider` with only
 * `check`/`prove` — the ledger-v9 1.0.0-rc.2 shape it was released against —
 * while the ledger-v9 1.0.0-rc.3 WASM this workspace resolves (the version
 * the wallet-sdk betas pin) validates that `lookupKey` is also present and
 * throws "expected proving provider property 'lookupKey' to be a function"
 * on every circuit-call proof. This wrapper reuses midnight-js's proving
 * provider and grafts on a `lookupKey` backed by the same key-material
 * resolution its `check`/`prove` use. Delete in favor of
 * `httpClientProofProvider` once midnight-js ships a beta aligned with
 * ledger-v9 1.0.0-rc.3.
 *
 * @param proofServerUrl - The proof server's HTTP endpoint.
 * @param zkConfigProviders - One provider per compiled contract in the call tree; must be non-empty.
 * @param observer - Called after every /check and /prove round trip (also on failure, before the error rethrows).
 * @returns The proof provider to place in a contract's midnight-js provider set.
 * @throws {Error} If `zkConfigProviders` is empty.
 */
export function createCrossContractProofServerProvider(
  proofServerUrl: string,
  zkConfigProviders: readonly ZKConfigProvider<string>[],
  observer?: ProofServerObserver,
): ProofProvider {
  if (zkConfigProviders.length === 0) {
    throw new Error(
      "createCrossContractProofServerProvider: at least one zkConfigProvider is required",
    );
  }

  const registry = new ZKConfigRegistry([...zkConfigProviders]);

  // Pass the REGISTRY (not a single provider) to the base: its /check and
  // /prove key resolution (`makeKeyMaterialResolver`) special-cases a
  // ZKConfigRegistry and resolves every contract in the call tree through it.
  // Passing one provider would leave /check unable to find a *callee* circuit's
  // key (its verifier-key join has only the caller), which fails a
  // cross-contract call at the check step. The `as` bridges the nominal type:
  // the base only ever calls `.resolveKeyLocation` on a registry argument.
  // The timeout raises midnight-js's 5-minute default: a cross-contract prove
  // takes minutes even unloaded, and on a busy host the default aborts proves
  // that would have completed ("'prove' returned an error: AbortError").
  const base = httpClientProvingProvider(
    proofServerUrl,
    registry as unknown as ZKConfigProvider<string>,
    { timeout: 15 * 60 * 1000 },
  );

  // Same resolution order as midnight-js's internal key-material resolver:
  // canonical contract key locations through the registry's verifier-key
  // join; otherwise try the location as a bare circuit name against each flat
  // provider in turn; protocol builtins ("midnight/...") resolve to undefined
  // and are supplied by the proof server itself.
  const lookupKey = async (keyLocation: string): Promise<ProvingKeyMaterial | undefined> => {
    const resolved = await registry.resolveKeyLocation(keyLocation);
    if (resolved !== undefined) {
      return zkConfigToProvingKeyMaterial(resolved);
    }
    for (const provider of zkConfigProviders) {
      try {
        return zkConfigToProvingKeyMaterial(await provider.get(keyLocation));
      } catch {
        // try the next provider
      }
    }
    return undefined;
  };

  const provingProvider: ProvingProvider = { ...base, lookupKey };
  if (observer === undefined) {
    return createProofProvider(provingProvider);
  }

  const observed: ProvingProvider = {
    async check(serializedPreimage, keyLocation) {
      const start = performance.now();
      try {
        const result = await provingProvider.check(serializedPreimage, keyLocation);
        observer({
          phase: ProofServerPhase.Check,
          keyLocation,
          serializedPreimage,
          ms: performance.now() - start,
        });
        return result;
      } catch (error) {
        observer({
          phase: ProofServerPhase.Check,
          keyLocation,
          serializedPreimage,
          ms: performance.now() - start,
          error: String(error),
        });
        throw error;
      }
    },
    async prove(serializedPreimage, keyLocation, overwriteBindingInput) {
      const start = performance.now();
      try {
        const proof = await provingProvider.prove(
          serializedPreimage,
          keyLocation,
          overwriteBindingInput,
        );
        observer({
          phase: ProofServerPhase.Prove,
          keyLocation,
          serializedPreimage,
          proof,
          ms: performance.now() - start,
        });
        return proof;
      } catch (error) {
        observer({
          phase: ProofServerPhase.Prove,
          keyLocation,
          serializedPreimage,
          ms: performance.now() - start,
          error: String(error),
        });
        throw error;
      }
    },
    lookupKey,
  };
  return createProofProvider(observed);
}

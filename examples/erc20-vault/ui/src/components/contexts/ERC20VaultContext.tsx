import { createContext, useCallback, useContext, useMemo, useState, type JSX, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { findDeployedContract, type FoundContract } from "@midnight-ntwrk/midnight-js/contracts";
import type { MidnightProviders } from "@midnight-ntwrk/midnight-js/types";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { FetchZkConfigProvider } from "@midnight-ntwrk/midnight-js-fetch-zk-config-provider";
import { createCrossContractProofServerProvider } from "@midnight-examples/lib/midnight-providers";
import { deriveEvmAddress, bytesToHex } from "@sig-net/midnight";
import { useMidnightChainConfig } from "./MidnightChainConfigContext";
import * as ERC20Vault from "@midnight-examples/erc20-vault-contract";
import {
    type MidnightNodeConfig,
    type NetworkId,
} from "@midnight-examples/chain-config";
import { useMidnightWallet } from "./MidnightWalletContext";
import type { Wallet } from "../../lib/midnight/wallet/Wallet";
import { describeError } from "../../lib/errorMessage";

// Base path under which the compiled ZK assets (the contract's `keys/` and
// `zkir/` from @midnight-examples/erc20-vault-contract's managed/ output) are
// served as static files. vite-plugin-static-copy (see vite.config.ts) serves
// the contract package's managed/ dir here in dev and copies it into dist/ at
// build, so the assets are never a stale committed copy.
// compact-js records this path; the matching FetchZkConfigProvider in the
// midnight-js provider set fetches from the same base when proving.
const ZK_ASSETS_PATH = `${import.meta.env.BASE_URL}managed/erc20-vault`;

// The signet callee contract's compiled assets, served from the same
// static-copy setup. The vault's request circuits cross-contract-call the
// signet contract, so proving spans both: the proof provider needs the
// callee's keys as well as the vault's.
const SIGNET_ZK_ASSETS_PATH = `${import.meta.env.BASE_URL}managed/SignetSigner`;

type ERC20VaultCircuit = keyof InstanceType<typeof ERC20Vault.Contract>["provableCircuits"] & string;

type ERC20VaultContract = ERC20Vault.Contract<ERC20Vault.VaultPrivateState>;

// The key used in the levelDb to store private state
type PrivateStateID = "erc20vault";
const PRIVATE_STATE_ID: PrivateStateID = "erc20vault";

type ERC20VaultProviders = MidnightProviders<
    // CircuitKeys: type expressing list of circuit names,
    ERC20VaultCircuit,
    // PrivateStateID: literal of the private state storage key. Just a string but use a union with single value to enforce type safety.
    PrivateStateID,
    // PrivateState: shape of the contract's private state object
    ERC20Vault.VaultPrivateState
>;

// Built once at module scope — depends only on module constants. The witnesses
// come from the contract package: callerSecretKey answers with the secret held
// in private state, which {@link generateIdentity} is what puts there.
const compiledContract = CompiledContract.make<ERC20VaultContract>(
    "erc20vault",
    ERC20Vault.Contract,
).pipe(
    CompiledContract.withWitnesses(ERC20Vault.witnesses),
    CompiledContract.withCompiledFileAssets(ZK_ASSETS_PATH),
);

function buildProviders(
    config: MidnightNodeConfig,
    wallet: Wallet,
): ERC20VaultProviders {
    // fetchFunc must be explicitly bound: the SDK's default (cross-fetch)
    // resolves to window.fetch unbound and every request then throws
    // "Illegal invocation" when called as a method of the provider.
    const boundFetch = window.fetch.bind(window);

    const erc20VaultZkConfigProvider = new FetchZkConfigProvider<ERC20VaultCircuit>(
        new URL(ZK_ASSETS_PATH, window.location.origin).toString(),
        { fetchFunc: boundFetch },
    );

    // The callee (signet contract) circuits, resolved for the cross-contract
    // proof provider so deposit's whole call tree proves.
    const signetZkConfigProvider = new FetchZkConfigProvider<string>(
        new URL(SIGNET_ZK_ASSETS_PATH, window.location.origin).toString(),
        { fetchFunc: boundFetch },
    );

    return {
        // Manages the Private State of a Contract, plus contract-maintenance signing keys.
        // Key Methods: get(id)→PS|null, set(id, PS), remove, clear,
        //              getSigningKey/setSigningKey (keyed by contract address),
        //              exportPrivateStates/importPrivateStates.
        // Storage is browser IndexedDB (via LevelDB API): clearing browser data
        // permanently destroys it. That now matters: the caller's identity
        // secret lives here, and losing it forfeits claiming deposits and
        // pulling withdrawal refunds. Mitigations: the secret regenerates from
        // the wallet's (assumed deterministic) signature of
        // IDENTITY_SIGNING_MESSAGE, and the provider exposes
        // exportPrivateStates/importPrivateStates for explicit backup.
        privateStateProvider: levelPrivateStateProvider({
            // Sublevel for private states, keyed by privateStateId.
            // Default 'private-states' (in db 'midnight-level-db').
            // Set to prevent collision with other dApps.
            privateStateStoreName: 'erc20vault-private-states',

            // Sublevel for contract-maintenance signing keys, keyed by contract
            // address; written on deployContract.
            // Default 'signing-keys'.
            // Set to prevent collision with other dApps.
            signingKeyStoreName: 'erc20vault-signing-keys',

            // Account identifier used to scope storage.
            // This ensures data isolation between different accounts/wallets using the same database.
            accountId: wallet.getCoinPublicKey(),

            // Returns the password (sync or async) used to encrypt BOTH stores.
            // Must pass validatePassword: ≥16 chars, ≥3 of {upper,lower,digit,special},
            // no 3+ repeated chars, no 4+ sequential runs — else
            // PasswordValidationError at runtime.
            // A constant in client source is obfuscation, not secrecy: it keeps
            // casual inspection of IndexedDB from reading the identity secret,
            // and nothing more. Anything running in this origin can derive it,
            // which is the same trust boundary the secret's signing wallet
            // already sits behind.
            privateStoragePasswordProvider: () => "&*(BHJqwe419" + wallet.getCoinPublicKey(),
        }),

        // Retrieves public data from the blockchain.
        // Key Methods: queryContractState(addr), watchForContractState, contractStateObservable(addr)
        publicDataProvider: indexerPublicDataProvider({
            queryURL: config.indexerUrl,
            subscriptionURL: config.indexerWsUrl,
        }),

        // Retrieves the ZK artifacts of a contract needed to create proofs.
        // Key Methods: getProverKey(id), getVerifierKey(id), getZKIR(id) — id is typed to PCK, i.e. just a string that is the name of the circuit
        // (The field name is the SDK's contract: its record holds exactly one.)
        zkConfigProvider: erc20VaultZkConfigProvider,

        // Creates proven, unbalanced transactions (proves the contract-call
        // transcript). This is NOT the wallet's proving config: the wallet's
        // proof server only proves its own balancing additions; the call
        // transcript is proven here first. Spans the vault AND the signet
        // contract so deposit's cross-contract call resolves keys for the
        // whole call tree.
        proofProvider: createCrossContractProofServerProvider(config.proofServerUrl, [
            erc20VaultZkConfigProvider,
            signetZkConfigProvider,
        ]),

        /**
         * Creates proven, balanced transactions.
         */
        walletProvider: wallet,

        /**
         * Submits proven, balanced transactions to the network.
         */
        midnightProvider: wallet,
    };
}

// Where the erc20vault contract is deployed on each network.
// An empty string means "not deployed there (yet)".
// TODO: optionally load this from the environment
const networkAddressIdx: Record<NetworkId, string> = {
    undeployed: "ad7b29265a84e8a4fa08c257213d0090375dcae695aed7e08532c0b3b57a728f",
    preview: "",
    preprod: "",
    mainnet: "",
    stagenet: "",
}

/**
 * The fixed message the Midnight wallet signs to derive the caller's identity
 * secret: `secretKey = SHA-256(signature)`. Shown to the user before the
 * signing prompt, so the prompt they then see matches what they agreed to.
 *
 * Recovering the SAME secret from the wallet alone stands on the wallet
 * signing DETERMINISTICALLY, which the connector promises nothing about. That
 * is why {@link ERC20VaultContextValue.regenerateIdentity} is destructive by
 * contract: with a randomised signer it derives a brand-new secret, and the
 * stored one (with any value still tied to it) is gone.
 */
export const IDENTITY_SIGNING_MESSAGE = "signet-wallet-erc20-vault-demo";

/**
 * The MPC root public key from `VITE_MPC_SECP256K1_PUBKEY`, or null when
 * unset (deposit addresses then cannot derive, and the UI says so).
 *
 * @param env - The build-time environment, normally `import.meta.env`.
 * @returns The key normalised to 0x-prefixed hex (the derivation's ethers
 *   plumbing requires the prefix), or null.
 * @throws If the variable is set but is not a 33-byte compressed or 65-byte
 *   uncompressed secp256k1 point in hex, so a typo fails at startup rather
 *   than deriving addresses from garbage.
 */
function readMpcSecp256k1Pubkey(env: ImportMetaEnv): string | null {
    const configured = env.VITE_MPC_SECP256K1_PUBKEY?.trim();
    if (configured === undefined || configured === "") {
        return null;
    }
    const hex = configured.startsWith("0x") ? configured.slice(2) : configured;
    if (!/^(0[23][0-9a-fA-F]{64}|04[0-9a-fA-F]{128})$/.test(hex)) {
        throw new Error(
            "Invalid VITE_MPC_SECP256K1_PUBKEY: expected a compressed (33-byte) or uncompressed (65-byte) secp256k1 public key in hex, 0x prefix optional.",
        );
    }
    return `0x${hex}`;
}

// Resolved once at module load, like the chain endpoints: a bad value should
// fail at startup, not on the first derivation.
const MPC_SECP256K1_PUBKEY: string | null = readMpcSecp256k1Pubkey(import.meta.env);

/**
 * The caller's vault identity, every form of it the UI needs: the secret
 * answering the contract's `callerSecretKey` witness, the commitment that is
 * its only on-ledger form (and the MPC derivation path of deposit requests),
 * and the EVM account the MPC derives from that path.
 */
export interface CallerIdentity {
    /** The 32-byte secret answering the vault's `callerSecretKey` witness. */
    readonly secretKey: Uint8Array;
    /** `userCommitment(secretKey)`, via the compiled circuit. */
    readonly commitment: Uint8Array;
    /** Canonical lowercase hex of the commitment (no 0x prefix). */
    readonly commitmentHex: string;
    /** The commitment read as the MPC's derivation path string. */
    readonly pathString: string;
    /**
     * The caller's derived EVM deposit account, or null when
     * `VITE_MPC_SECP256K1_PUBKEY` is unset.
     */
    readonly depositEvmAddress: string | null;
}

/** How far the caller's identity has got, for the deposit-address step. */
export enum CallerIdentityStatus {
    /** No Midnight wallet is connected, so there is nothing to derive from. */
    NoWallet = "no-wallet",
    /** The vault has no address on the selected network. */
    NotDeployed = "not-deployed",
    /** The stored identity is still being read. */
    Loading = "loading",
    /** Nothing stored for this wallet yet: offer to generate. */
    Absent = "absent",
    /** An identity is in hand (stored earlier, or generated just now). */
    Present = "present",
    /** Reading the stored identity failed. */
    Error = "error",
}

/**
 * Derive the caller's identity secret from the connected wallet: ask it to
 * sign {@link IDENTITY_SIGNING_MESSAGE} with its unshielded key and hash the
 * signature to 32 bytes.
 *
 * @param wallet - The connected Midnight wallet.
 * @returns The 32-byte secret.
 * @throws The connector's own `APIError` (`code: 'Rejected'`) when the user
 *   declines the signing prompt.
 */
async function secretKeyOfWalletSignature(wallet: Wallet): Promise<Uint8Array> {
    const signature = await wallet.signData(IDENTITY_SIGNING_MESSAGE, {
        encoding: "text",
        keyType: "unshielded",
    });
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(signature.signature),
    );
    return new Uint8Array(digest);
}

/**
 * Build every derived form of the identity from its secret. Derivation calls
 * the compiled `userCommitment` circuit and the SDK's epsilon derivation,
 * never a TS re-implementation.
 *
 * @param secretKey - The caller's 32-byte identity secret.
 * @param contractAddress - The vault's Midnight address, the derivation's
 *   requester.
 * @returns The identity, with `depositEvmAddress` null when the MPC root key
 *   is not configured.
 */
function buildCallerIdentity(secretKey: Uint8Array, contractAddress: string): CallerIdentity {
    const commitment = ERC20Vault.pureCircuits.userCommitment(secretKey);
    const pathString = ERC20Vault.pathStringOfBytes(commitment);
    return {
        secretKey,
        commitment,
        commitmentHex: bytesToHex(commitment),
        pathString,
        depositEvmAddress:
            MPC_SECP256K1_PUBKEY === null
                ? null
                : deriveEvmAddress(MPC_SECP256K1_PUBKEY, contractAddress, pathString),
    };
}

/** What the vault context provides: the contract, and the caller's identity. */
export interface ERC20VaultContextValue {
    /**
     * The found contract, or null until the wallet is connected, the network
     * has a deployment, AND an identity exists (the find binds the stored
     * private state, so it waits for one).
     */
    readonly contract: FoundContract<ERC20VaultContract> | null;
    /** Read the vault's public ledger state. */
    readonly readContractState: () => Promise<ERC20Vault.Ledger>;
    /** How far the caller's identity has got. */
    readonly identityStatus: CallerIdentityStatus;
    /** The identity, when {@link identityStatus} is `Present`. */
    readonly identity: CallerIdentity | null;
    /**
     * True when the identity in hand came from a wallet signature THIS
     * session (generated or regenerated here), false when it was merely
     * found in browser storage.
     */
    readonly identityFresh: boolean;
    /** Why {@link identityStatus} is `Error`, when it is. */
    readonly identityError: string | null;
    /**
     * Derive a fresh identity from the wallet's signature and persist it.
     *
     * @returns The generated identity.
     * @throws If an identity already exists (overwriting a stored secret is
     *   destructive and only {@link regenerateIdentity}, behind its explicit
     *   confirmation, may do it), if no wallet or deployment is in hand, or
     *   when the user declines the signing prompt.
     */
    readonly generateIdentity: () => Promise<CallerIdentity>;
    /** True while the generate signing prompt is outstanding. */
    readonly generating: boolean;
    /**
     * Re-sign {@link IDENTITY_SIGNING_MESSAGE} and OVERWRITE the stored
     * secret with the result. DESTRUCTIVE: unless the wallet signs
     * deterministically, the old secret is unrecoverable afterwards, and any
     * unclaimed deposit or pending refund tied to its commitment goes with
     * it. Callers must collect an explicit confirmation before invoking.
     *
     * @returns The regenerated identity.
     * @throws If no wallet or deployment is in hand, or when the user
     *   declines the signing prompt.
     */
    readonly regenerateIdentity: () => Promise<CallerIdentity>;
    /** True while the regenerate signing prompt is outstanding. */
    readonly regenerating: boolean;
}

const ERC20VaultContext = createContext<ERC20VaultContextValue | null>(null);

/** Props of {@link ERC20VaultContextProvider}. */
interface ERC20VaultContextProviderProps {
    readonly children: ReactNode;
}

/**
 * Owns the app's view of the deployed vault contract and the caller's
 * identity. Mounted once in App.tsx, inside the Midnight wallet provider it
 * reads and inside the app's QueryClientProvider whose cache it uses, and read
 * through {@link useERC20Vault}.
 *
 * @param props - The subtree that can read the vault.
 * @returns The provider wrapping that subtree.
 */
export function ERC20VaultContextProvider({ children }: ERC20VaultContextProviderProps): JSX.Element {
    const { config } = useMidnightChainConfig();
    const { wallet } = useMidnightWallet();
    const queryClient = useQueryClient();

    // Config.networkId is the SDK's bare string type, but its values always
    // come from the app's Network union.
    const contractAddress = networkAddressIdx[config.networkId as NetworkId] || null;

    const providers = useMemo<ERC20VaultProviders | null>(
        () => (wallet ? buildProviders(config, wallet) : null),
        [config, wallet],
    );

    // Everything below is keyed by wallet + network + deployment: switching
    // any of them is a different storage scope, so a different identity.
    const identityQueryKey = useMemo(
        () => [
            "erc20vault-identity",
            config.networkId,
            wallet?.id ?? null,
            contractAddress,
        ],
        [config.networkId, wallet, contractAddress],
    );

    // The stored identity, read from the (wallet-scoped, encrypted) private
    // state store. `null` data means nothing stored yet.
    const identityQuery = useQuery<CallerIdentity | null>({
        queryKey: identityQueryKey,
        enabled: providers !== null && contractAddress !== null,
        // The store is local, but two operations can still contend for it
        // (another tab, an unmounted tree's read still in flight, and the
        // Node-backed store vitest runs on takes an exclusive lock per open):
        // a couple of quick retries absorbs that, while a genuinely broken
        // store still surfaces.
        retry: 2,
        retryDelay: (attempt) => 250 * (attempt + 1),
        queryFn: async () => {
            if (!(providers && contractAddress)) {
                return null;
            }
            // Storage keys are scoped `${contractAddress}:${privateStateId}`,
            // so the address must be set before any read or write.
            providers.privateStateProvider.setContractAddress(contractAddress);
            const stored = await providers.privateStateProvider.get(PRIVATE_STATE_ID);
            return stored === null ? null : buildCallerIdentity(stored.secretKey, contractAddress);
        },
    });

    // Freshness is keyed by commitment rather than held as one flag: the
    // wallet or network switching swaps the identity out underneath, and a
    // bare boolean would carry one identity's provenance over to another.
    const [freshCommitmentsIdx, setFreshCommitmentsIdx] = useState<Readonly<Record<string, true>>>(
        {},
    );

    const identity = identityQuery.data ?? null;
    const identityFresh = identity !== null && freshCommitmentsIdx[identity.commitmentHex] === true;

    // Shared tail of both signing mutations: persist the secret, publish the
    // derived identity, and record that it is wallet-fresh this session.
    const persistIdentity = useCallback(
        async (secretKey: Uint8Array, contractAddr: string, vaultProviders: ERC20VaultProviders) => {
            await vaultProviders.privateStateProvider.set(
                PRIVATE_STATE_ID,
                ERC20Vault.createVaultPrivateState(secretKey),
            );
            return buildCallerIdentity(secretKey, contractAddr);
        },
        [],
    );

    const publishFreshIdentity = useCallback(
        (fresh: CallerIdentity) => {
            queryClient.setQueryData<CallerIdentity | null>(identityQueryKey, fresh);
            setFreshCommitmentsIdx((current) => ({ ...current, [fresh.commitmentHex]: true }));
        },
        [queryClient, identityQueryKey],
    );

    const generateMutation = useMutation<CallerIdentity>({
        mutationFn: async () => {
            if (!(providers && contractAddress && wallet)) {
                throw new Error(
                    "Cannot generate an identity: a connected Midnight wallet and a deployed network are required.",
                );
            }
            // Storage keys are scoped `${contractAddress}:${privateStateId}`,
            // so the address must be set before any read or write.
            providers.privateStateProvider.setContractAddress(contractAddress);
            const existing = await providers.privateStateProvider.get(PRIVATE_STATE_ID);
            if (existing !== null) {
                throw new Error(
                    "An identity secret is already stored for this wallet: refusing to overwrite it.",
                );
            }
            const secretKey = await secretKeyOfWalletSignature(wallet);
            return persistIdentity(secretKey, contractAddress, providers);
        },
        onSuccess: publishFreshIdentity,
    });

    // The destructive twin of generate: same signing and persistence, no
    // exists-guard. The explicit confirmation lives with the CALLER (the UI's
    // tick box): this mutation trusts it has been collected.
    const regenerateMutation = useMutation<CallerIdentity>({
        mutationFn: async () => {
            if (!(providers && contractAddress && wallet)) {
                throw new Error(
                    "Cannot regenerate an identity: a connected Midnight wallet and a deployed network are required.",
                );
            }
            const secretKey = await secretKeyOfWalletSignature(wallet);
            // Storage keys are scoped `${contractAddress}:${privateStateId}`,
            // so the address must be set before any read or write.
            providers.privateStateProvider.setContractAddress(contractAddress);
            return persistIdentity(secretKey, contractAddress, providers);
        },
        onSuccess: publishFreshIdentity,
    });

    // The found contract. Gated on the identity existing: the find binds the
    // private state stored at PRIVATE_STATE_ID (and errors when there is
    // none), and it deliberately does NOT pass initialPrivateState, which
    // would overwrite the stored secret on every find.
    const contractQuery = useQuery<FoundContract<ERC20VaultContract>>({
        queryKey: [
            "erc20vault-contract",
            config.networkId,
            wallet?.id ?? null,
            contractAddress,
        ],
        enabled: providers !== null && contractAddress !== null && identity !== null,
        queryFn: async () => {
            if (!(providers && contractAddress)) {
                throw new Error("erc20 vault not initialised: a wallet and a deployed network are required.");
            }
            return findDeployedContract(providers, {
                contractAddress,
                compiledContract,
                privateStateId: PRIVATE_STATE_ID,
            });
        },
    });

    const readContractState = useCallback(async () => {
        if (!(providers && contractAddress)) {
            throw new Error("erc20 vault not initialised: a wallet and a deployed network are required before reading state");
        }

        const state = await providers.publicDataProvider.queryContractState(contractAddress)
        if (!state) {
            throw new Error(`no contract state found at address '${contractAddress}'`);
        }

        return ERC20Vault.ledger(state.data);
    }, [providers, contractAddress]);

    const identityStatus: CallerIdentityStatus =
        wallet === null
            ? CallerIdentityStatus.NoWallet
            : contractAddress === null
                ? CallerIdentityStatus.NotDeployed
                : identityQuery.isPending
                    ? CallerIdentityStatus.Loading
                    : identityQuery.isError
                        ? CallerIdentityStatus.Error
                        : identity === null
                            ? CallerIdentityStatus.Absent
                            : CallerIdentityStatus.Present;

    const generateIdentity = generateMutation.mutateAsync;
    const regenerateIdentity = regenerateMutation.mutateAsync;

    const value = useMemo<ERC20VaultContextValue>(() => ({
        contract: contractQuery.data ?? null,
        readContractState,
        identityStatus,
        identity,
        identityFresh,
        identityError: identityQuery.error === null ? null : describeError(identityQuery.error),
        generateIdentity,
        generating: generateMutation.isPending,
        regenerateIdentity,
        regenerating: regenerateMutation.isPending,
    }), [
        contractQuery.data,
        readContractState,
        identityStatus,
        identity,
        identityFresh,
        identityQuery.error,
        generateIdentity,
        generateMutation.isPending,
        regenerateIdentity,
        regenerateMutation.isPending,
    ]);

    return (
        <ERC20VaultContext.Provider value={value}>
            {children}
        </ERC20VaultContext.Provider>
    );
}

/**
 * Read the vault: the found contract and the caller's identity.
 *
 * @returns The context value.
 * @throws If called outside an {@link ERC20VaultContextProvider}, since there
 *   is no sensible vault to fall back to.
 */
export function useERC20Vault(): ERC20VaultContextValue {
    const context = useContext(ERC20VaultContext);
    if (context === null) {
        throw new Error("useERC20Vault must be used within an ERC20VaultContextProvider");
    }
    return context;
}

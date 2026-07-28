import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { type WitnessContext } from "@midnight-ntwrk/compact-runtime";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { findDeployedContract, type FoundContract } from "@midnight-ntwrk/midnight-js/contracts";
import type { MidnightProviders } from "@midnight-ntwrk/midnight-js/types";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { FetchZkConfigProvider } from "@midnight-ntwrk/midnight-js-fetch-zk-config-provider";
import { createCrossContractProofServerProvider } from "@midnight-examples/lib/midnight-providers";
import { useMidnightChainConfig } from "./MidnightChainConfigContext";
import * as ERC20Vault from "@midnight-examples/erc20-vault-contract";
import {
    type MidnightNodeConfig,
    type NetworkId,
} from "@midnight-examples/chain-config";
import { useMidnightWallet } from "./MidnightWalletContext";
import { BrowserWallet } from "../../lib/midnight/MidnightBrowserWallet";

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

type ERC20VaultPrivateState = {};

type ERC20VaultContract = ERC20Vault.Contract<ERC20VaultPrivateState>;

type ERC20VaultWitnesses = ERC20Vault.Witnesses<ERC20VaultPrivateState>;

// The key used in the levelDb to store private state
type PrivateStateID = "erc20vault";
const PRIVATE_STATE_ID: PrivateStateID = "erc20vault";

type ERC20VaultProviders = MidnightProviders<
    // CircuitKeys: type expressing list of circuit names,
    ERC20VaultCircuit,
    // PrivateStateID: literal of the private state storage key. Just a string but use a union with single value to enforce type safety.
    PrivateStateID,
    // PrivateState: shape of the contract's private state object
    ERC20VaultPrivateState
>;

// The witness the circuits read.
// In real use this will hook into some wallet flow to get a private
// unique identifier from the executing user.
const witnesses: ERC20VaultWitnesses = {
    callerSecretKey: ({
        privateState,
    }: WitnessContext<ERC20Vault.Ledger, ERC20VaultPrivateState>): [ERC20VaultPrivateState, Uint8Array] => {
        return [privateState, new Uint8Array(32)];
    },
};

// Built once at module scope — depends only on module constants.
const compiledContract = CompiledContract.make<ERC20VaultContract>(
    "erc20vault",
    ERC20Vault.Contract,
).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(ZK_ASSETS_PATH),
);

function buildProviders(
    config: MidnightNodeConfig,
    wallet: BrowserWallet,
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
        // permanently destroys it — the package itself warns against production use
        // where loss matters. Fine here: our private state is empty and we never
        // deploy from the browser, so no signing keys land in it either.
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
            // A constant in client source is obfuscation, not secrecy — acceptable
            // here only because nothing sensitive is stored.
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
    undeployed: "529e85a2a2040228b44b3ae9113cf24ca454039820639f168864cf003e7e07a8",
    preview: "",
    preprod: "",
    mainnet: "",
    stagenet: "",
}

interface ERC20VaultContextValue {
    // null until found (i.e. while no wallet is selected, the contract is not
    // deployed on the selected network, or the find is still in flight).
    contract: FoundContract<ERC20VaultContract> | null,
    readContractState: () => Promise<ERC20Vault.Ledger>,
}

const ERC20VaultContext = createContext<ERC20VaultContextValue | null>(null);

export function ERC20VaultContextProvider({ children }: { children: ReactNode }) {
    const { config } = useMidnightChainConfig();
    const { browserWallet } = useMidnightWallet();

    // Config.networkId is the SDK's bare string type, but its values always
    // come from the app's Network union.
    const contractAddress = networkAddressIdx[config.networkId as NetworkId] || null;

    const providers = useMemo<ERC20VaultProviders | null>(
        () => (browserWallet ? buildProviders(config, browserWallet) : null),
        [config, browserWallet],
    );

    const [contract, setContract] = useState<FoundContract<ERC20VaultContract> | null>(null);
    useEffect(() => {
        setContract(null);
        if (!contractAddress || !providers) {
            return;
        }

        // `cancelled` stops a superseded run from publishing its result after
        // the wallet or network changed under it.
        let cancelled = false;
        (async () => {
            try {
                const found = await findDeployedContract(
                    providers,
                    {
                        contractAddress,
                        compiledContract,
                        privateStateId: PRIVATE_STATE_ID,
                        initialPrivateState: {},
                    },
                );
                if (!cancelled) {
                    setContract(found);
                }
            } catch (e) {
                console.error("error finding deployed contract", e);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [providers, contractAddress]);

    const readContractState = useCallback(async () => {
        if (!(providers && contractAddress)) {
            throw new Error("erc20 vault not initialised — a wallet and a deployed network are required before reading state");
        }

        const state = await providers.publicDataProvider.queryContractState(contractAddress)
        if (!state) {
            throw new Error(`no contract state found at address '${contractAddress}'`);
        }

        return ERC20Vault.ledger(state.data);
    }, [providers, contractAddress]);    

    const value = useMemo<ERC20VaultContextValue>(() => ({
        contract,
        readContractState,
    }), [contract, readContractState]);    

    return (
        <ERC20VaultContext.Provider value={value}>
            {children}
        </ERC20VaultContext.Provider>
    );
}
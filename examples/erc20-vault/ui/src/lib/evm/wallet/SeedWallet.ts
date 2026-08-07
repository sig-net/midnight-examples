// SeedWallet: a {@link Wallet} backed by a seed held in-app, over a viem
// local account. The account is BIP-44 derived from the seed bytes at
// `m/44'/60'/0'/0/0` (hdKeyToAccount's defaults), so the same seed always
// lands on the same address, reproducible in any BIP-44 tool.
//
// The seed is this chain's own: it shares the Midnight SeedWallet's hex
// contract (16-64 bytes), so one seed CAN drive both chains, but nothing
// couples them and each chain accepts its own.
//
// Same two-path lifecycle as BrowserWallet:
//   1. `const w = new SeedWallet(config, seed); await w.initialise();`
//   2. `const w = await SeedWallet.Initialise(config, seed);`
//
// The constructor only records its inputs (it is intentionally not async and
// does no work). The parse, the derivation and the client construction happen
// in `initialise()`. Touching any other member before that throws.
import type { EvmChainConfig } from "@midnight-examples/chain-config";
import { type Address, createWalletClient, http } from "viem";
import { HDKey, hdKeyToAccount } from "viem/accounts";

import { toViemChain } from "../chain.ts";
import { type EvmWalletClient, type Wallet, WalletError, WalletKind } from "./Wallet.ts";

/**
 * Base of every error this module raises, a {@link WalletError} so one
 * `instanceof` catches failures from either wallet kind.
 */
export class SeedWalletError extends WalletError {}

/** The seed input did not parse as a hex seed: see {@link SeedWallet}. */
export class SeedWalletParseError extends SeedWalletError {}

/** A member that needs a derived account was touched before {@link SeedWallet.initialise}. */
export class SeedWalletNotInitialisedError extends SeedWalletError {
  /**
   *
   */
  constructor() {
    super("SeedWallet is not initialised: call initialise() (or use SeedWallet.Initialise) first.");
  }
}

/**
 * Parse a hex seed (16-64 bytes, optional 0x prefix) into its bytes.
 *
 * Duplicated from the Midnight SeedWallet's module-private parser on purpose:
 * importing across the two chain folders would couple seeds that are
 * deliberately independent per chain.
 *
 * @param input - The seed as supplied by the user.
 * @returns The seed bytes.
 * @throws {SeedWalletParseError} when the input is not hex of a valid length.
 */
function parseHexSeed(input: string): Uint8Array {
  const compact = input.trim().replace(/^0x/i, "");
  if (compact === "") {
    throw new SeedWalletParseError("Nothing to parse: paste a hex seed first.");
  }
  if (!/^[0-9a-fA-F]+$/.test(compact) || compact.length % 2 !== 0) {
    throw new SeedWalletParseError("The seed must be hex (an even number of 0-9a-f digits).");
  }
  const byteCount = compact.length / 2;
  if (byteCount < 16 || byteCount > 64) {
    throw new SeedWalletParseError(`A hex seed must be 16-64 bytes; got ${String(byteCount)}.`);
  }
  const bytes = new Uint8Array(byteCount);
  for (let index = 0; index < byteCount; index++) {
    bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

// Everything that only exists once initialised.
interface Initialised {
  account: Address;
  client: EvmWalletClient;
}

/**
 * A {@link Wallet} over a viem local account derived from a hex seed:
 * construction records the inputs, {@link initialise} derives the account
 * and builds the client, and every other member requires it to have
 * completed.
 */
export class SeedWallet implements Wallet {
  readonly kind = WalletKind.Seed;
  readonly name = "Seed wallet";
  readonly iconUrl = undefined;

  /**
   * Build a SeedWallet in one call.
   *
   * @param config - The EVM chain the client signs for and submits to.
   * @param seed - The hex seed, 16-64 bytes, 0x optional.
   * @returns The initialised wallet.
   */
  static async Initialise(config: EvmChainConfig, seed: string): Promise<SeedWallet> {
    const wallet = new SeedWallet(config, seed);
    await wallet.initialise();
    return wallet;
  }

  private readonly config: EvmChainConfig;
  private readonly seed: string;
  private initialised?: Initialised;
  // In-flight initialise, so concurrent / StrictMode-double calls share one
  // derivation instead of racing two.
  private initialising?: Promise<void>;

  /**
   * @param config  the EVM chain the client signs for and submits to
   * @param seed    the wallet seed as hex (16-64 bytes, 0x optional)
   */
  constructor(config: EvmChainConfig, seed: string) {
    this.config = config;
    this.seed = seed;
  }

  /**
   * Parse the seed, derive the account and build the client. All local
   * work: nothing touches the network until the client is used. Idempotent:
   * a second call is a no-op once initialised, and concurrent calls share
   * the one in-flight derivation.
   *
   * The wallet runs in-app: its keys live in this page's memory for as long
   * as it is held, and nothing prompts before signing. Meant for development
   * against a local stack, where the funded seeds are hex constants.
   *
   * @returns Resolution once the account and client are in hand (the shared
   *   in-flight promise when an initialise is already running).
   * @throws {SeedWalletParseError} When the seed is not valid hex.
   * @throws {SeedWalletError} When the HD derivation fails.
   */
  async initialise(): Promise<void> {
    if (this.initialised) return;
    if (this.initialising) return this.initialising;

    this.initialising = this.performInitialise().finally(() => {
      this.initialising = undefined;
    });
    return this.initialising;
  }

  private performInitialise(): Promise<void> {
    const seedBytes = parseHexSeed(this.seed);
    let account;
    try {
      account = hdKeyToAccount(HDKey.fromMasterSeed(seedBytes));
    } catch (error) {
      throw new SeedWalletError(
        `Deriving the account failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const client = createWalletClient({
      account,
      chain: toViemChain(this.config),
      transport: http(this.config.rpcUrl),
    });
    this.initialised = { account: account.address, client };
    return Promise.resolve();
  }

  /**
   * Guard for members that require {@link initialise} to have completed.
   *
   * @returns The initialised state.
   * @throws {SeedWalletNotInitialisedError} Before {@link initialise}.
   */
  private requireInitialised(): Initialised {
    if (!this.initialised) {
      throw new SeedWalletNotInitialisedError();
    }
    return this.initialised;
  }

  /**
   * Forget the derived keys. Nothing is held open (the client connects per
   * request), so this only drops them from memory. A later
   * {@link initialise} would re-derive, but callers are expected to
   * construct a new wallet instead.
   *
   * @returns A resolved promise: the drop is synchronous, and the Promise
   *   shape is the {@link Wallet} contract.
   */
  disconnect(): Promise<void> {
    this.initialised = undefined;
    return Promise.resolve();
  }

  /**
   * The derived address, checksummed: stable per seed, so the same seed
   * scopes to the same storage and queries across installs.
   *
   * @returns The derived address.
   */
  get id(): string {
    return this.requireInitialised().account;
  }

  /**
   * The derived account.
   *
   * @returns The address, checksummed.
   */
  get account(): Address {
    return this.requireInitialised().account;
  }

  /**
   * A viem wallet client over the derived account: signing happens in-app
   * without a prompt, and submissions go over the app's RPC URL.
   *
   * @returns The account-bound client.
   */
  get client(): EvmWalletClient {
    return this.requireInitialised().client;
  }
}

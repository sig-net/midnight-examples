import {
  type AccountFunding,
  assertRootFunded,
  deriveWalletAddresses,
  formatDust,
  fundChildFromRoot,
  generateHexSeed,
  GENESIS_MINT_WALLET_SEED,
  getFaucetUrl,
  getMidnightNodeConfig,
  isLocalStandaloneNetwork,
  readAccountFunding,
  type WalletAddresses,
  type WalletRegistry,
  WalletUnfundedError,
} from "@sig-net/midnight-contract-deploy";

import { requireEnv } from "./e2e-env.ts";
import { appendRepoDotEnv } from "./env-file.ts";
import { banner, logSkip } from "./output.ts";
import { explainDustSpendRejection } from "./steps.ts";

/**
 * One wallet role: its display label, the env var holding its seed, and the
 * shares of root's NIGHT the automatic split gives it (see {@link fundingShare}).
 */
export interface RoleWallet {
  readonly label: string;
  readonly envVar: string;
  readonly shares: bigint;
}

/** The funding root. Does no test work: it holds NIGHT, pays the roles out and keeps one share for its own fees. */
const ROOT: RoleWallet = { label: "root", envVar: "ROOT_SEED", shares: 1n };

/**
 * The role wallets funded from root, in setup order: `deployer` deploys the
 * signet + example contracts, `user` drives the example's circuits (and seeds
 * the derived EVM account identity), `mpc responder` is the fakenet
 * responder's fee-paying wallet (docker-compose interpolates its seed), and
 * `bearer` is the second SPENDING wallet of the bearer-transfer flow (it
 * pays its own withdraw fees). Receive-only test wallets (the fixed
 * `…42`/`…43` seeds) never pay anything and need no role here. The deployer
 * weighs three shares: the vault's split deploy costs it one transaction per
 * circuit (seventeen) where every other role pays one or two.
 */
const CHILDREN: readonly RoleWallet[] = [
  { label: "deployer", envVar: "DEPLOYER_SEED", shares: 3n },
  { label: "user", envVar: "USER_SEED", shares: 1n },
  { label: "mpc responder", envVar: "MPC_RESPONDER_SEED", shares: 1n },
  { label: "bearer", envVar: "BEARER_SEED", shares: 1n },
];

/**
 * Format a wallet's three addresses as banner lines.
 *
 * @param label - The wallet's role name, e.g. `root`.
 * @param addresses - The wallet's unshielded, shielded and dust addresses.
 * @returns One banner line per address, under a heading line.
 */
function walletAddressLines(label: string, addresses: WalletAddresses): string[] {
  return [
    `${label} wallet addresses:`,
    `  NIGHT (unshielded): ${addresses.unshielded}`,
    `  shielded:           ${addresses.shielded}`,
    `  dust:               ${addresses.dust}`,
  ];
}

/**
 * Resolve every wallet seed: reuse the one in `.env` when present, otherwise
 * generate it (root on the local chain defaults to the genesis mint wallet),
 * populate the env accumulator, persist the newly-created seeds to `.env`
 * (append-only), and print each wallet's addresses. After this, ROOT_SEED,
 * DEPLOYER_SEED, USER_SEED, MPC_RESPONDER_SEED and BEARER_SEED are all set
 * in `env`.
 *
 * @param env - The suite's env accumulator (mutated with the resolved seeds).
 */
export function ensureWalletSeeds(env: NodeJS.ProcessEnv): void {
  const config = getMidnightNodeConfig(env);
  const generated: Record<string, string> = {};

  for (const role of [ROOT, ...CHILDREN]) {
    const existing = env[role.envVar]?.trim();
    let seed: string;
    if (existing) {
      seed = existing;
      logSkip(`resolve ${role.label} seed`, `${role.envVar} is set: reusing it`);
    } else {
      seed =
        role === ROOT && isLocalStandaloneNetwork(config.networkId)
          ? GENESIS_MINT_WALLET_SEED
          : generateHexSeed();
      env[role.envVar] = seed;
      generated[role.envVar] = seed;
      console.log(`generated ${role.label} seed -> ${role.envVar} (persisted to .env)`);
    }
    banner(walletAddressLines(role.label, deriveWalletAddresses(seed, config)));
  }

  if (Object.keys(generated).length > 0) {
    appendRepoDotEnv(
      generated,
      "test-harness setup: generated wallet seeds (root/deployer/user/mpc responder/bearer)",
    );
  }
}

/**
 * Log a wallet's measured balances and NIGHT address.
 *
 * @param label - The wallet's role name, e.g. `root`.
 * @param funding - The wallet's read NIGHT/DUST balances and addresses.
 */
function logFundingBalance(label: string, funding: AccountFunding): void {
  console.log(
    `${label}: NIGHT ${String(funding.night)} base units, ${formatDust(funding.dust)} DUST (${funding.addresses.unshielded})`,
  );
}

/**
 * One share of root's NIGHT: the balance divided across the shares of the
 * children that need funding plus root's own, so the split adapts to however
 * much the faucet delivered.
 *
 * @param rootNight - Root's current NIGHT balance, in base units.
 * @param unfunded - The children that still need funding.
 * @returns The NIGHT one share is worth, in base units.
 */
export function fundingShare(rootNight: bigint, unfunded: readonly RoleWallet[]): bigint {
  return rootNight / unfunded.reduce((sum, role) => sum + role.shares, ROOT.shares);
}

/**
 * The NIGHT to transfer to one child. `FUND_CHILD_NIGHT` (base units) pins it
 * for every child. Otherwise the child receives its shares of root's balance.
 *
 * @param env - The suite's env accumulator, read for `FUND_CHILD_NIGHT`.
 * @param share - The NIGHT one share is worth (see {@link fundingShare}).
 * @param child - The child to fund.
 * @returns The NIGHT amount to send the child, in base units.
 * @throws {Error} If `FUND_CHILD_NIGHT` is set to anything but a non-negative integer.
 */
export function perChildAmount(env: NodeJS.ProcessEnv, share: bigint, child: RoleWallet): bigint {
  const override = env.FUND_CHILD_NIGHT?.trim();
  if (override) {
    if (!/^\d+$/.test(override)) {
      throw new Error(
        `FUND_CHILD_NIGHT must be a non-negative integer in NIGHT base units; got "${override}".`,
      );
    }
    return BigInt(override);
  }
  return share * child.shares;
}

/**
 * Inspect child balances before opening the funding root. Transaction submission checks the actual fee requirement.
 *
 * @param env - The resolved wallet seeds and optional transfer amount.
 * @param wallets - The registry that keeps each wallet synchronised.
 * @throws {WalletUnfundedError} If a required transfer has an unfunded root.
 * @throws {Error} If a balance read or transfer fails.
 */
export async function ensureWalletsFunded(
  env: NodeJS.ProcessEnv,
  wallets: WalletRegistry,
): Promise<void> {
  const transfers: RoleWallet[] = [];
  for (const child of CHILDREN) {
    const funding: AccountFunding = await readAccountFunding(
      wallets,
      requireEnv(env, child.envVar),
      child.label,
    );
    logFundingBalance(child.label, funding);
    if (funding.night > 0n || funding.dust > 0n) {
      console.log(
        `${child.label}: NIGHT transfer skipped. The transaction fee check determines required DUST and registers existing NIGHT if needed.`,
      );
    } else {
      transfers.push(child);
    }
  }
  if (transfers.length === 0) {
    console.log("root: no NIGHT transfers required, funding check skipped");
    return;
  }

  let root: AccountFunding | undefined;
  let share = 0n;
  for (const child of transfers) {
    const funding: AccountFunding = await readAccountFunding(
      wallets,
      requireEnv(env, child.envVar),
      child.label,
    );
    if (funding.night > 0n || funding.dust > 0n) {
      logFundingBalance(child.label, funding);
      console.log(`${child.label}: balance changed, NIGHT transfer skipped`);
      continue;
    }
    if (root === undefined) {
      root = await preflightRoot(
        wallets,
        requireEnv(env, ROOT.envVar),
        getFaucetUrl(env, wallets.config.networkId),
      );
      share = fundingShare(root.night, transfers);
      const total: bigint = transfers.reduce(
        (sum: bigint, role: RoleWallet): bigint => sum + perChildAmount(env, share, role),
        0n,
      );
      if (total > root.night)
        throw new Error(
          `NIGHT transfers require ${String(total)} base units, root holds ${String(root.night)}`,
        );
      console.log(
        `root funding plan: transfers ${String(total)} NIGHT base units, reserve ${String(root.night - total)} NIGHT base units`,
      );
    }
    const amount: bigint = perChildAmount(env, share, child);
    console.log(`${child.label}: transferring ${String(amount)} NIGHT base units from root`);
    const funded: AccountFunding = await explainDustSpendRejection(`fund ${child.label}`, () =>
      fundChildFromRoot(
        wallets,
        requireEnv(env, ROOT.envVar),
        requireEnv(env, child.envVar),
        child.label,
        amount,
      ),
    );
    logFundingBalance(child.label, funded);
  }
}

/**
 * Root preflight, surfacing {@link WalletUnfundedError}'s stop message before rethrowing.
 *
 * @param wallets - The registry holding the root wallet.
 * @param rootSeed - Root's seed, hex or mnemonic.
 * @param faucetUrl - Faucet URL for the stop message, when one is known.
 * @returns Root's read NIGHT/DUST balances and addresses.
 * @throws {WalletUnfundedError} When root holds too little to fund the children.
 */
async function preflightRoot(
  wallets: WalletRegistry,
  rootSeed: string,
  faucetUrl: string | undefined,
): Promise<AccountFunding> {
  try {
    return await assertRootFunded(wallets, rootSeed, faucetUrl);
  } catch (error) {
    if (error instanceof WalletUnfundedError) {
      banner(["ROOT WALLET NEEDS FUNDING: stopping here", "", ...error.message.split("\n")]);
    }
    throw error;
  }
}

import {
  deriveAddresses,
  ensureFeeReady,
  type FacadeState,
  formatDust,
  type RegisteredWallet,
  transferNight,
  type WalletRegistry,
  walletRegistryKey,
} from "@sig-net/midnight-contract-deploy";
import { waitForFacadeState } from "@sig-net/midnight-examples-lib";

import { explainDustSpendRejection } from "./steps.ts";

/** A wallet to make fee-ready, transferring NIGHT only when it has neither NIGHT nor DUST. */
export interface WalletFundingRecipient {
  /** Seed accepted by the SDK's wallet registry. */
  readonly seed: string;
  /** Public label used in progress and error messages. */
  readonly label: string;
  /** NIGHT base units to send if the wallet is empty. */
  readonly amount: bigint;
}

async function confirmFeeReady(wallets: WalletRegistry, child: RegisteredWallet): Promise<void> {
  const state: FacadeState = await waitForFacadeState(
    child.facade,
    (snapshot) =>
      Object.values(snapshot.unshielded.balances).some((amount) => amount > 0n) ||
      snapshot.dust.balance(new Date()) > 0n,
    120_000,
  );
  const dust: bigint = await ensureFeeReady(
    child.facade,
    child.keys,
    state,
    wallets.config.networkId,
  );
  console.log(`${child.label}: funding ready, ${formatDust(dust)} DUST`);
}

/**
 * Serialise root transfers while overlapping bounded child registrations and DUST waits.
 * All started confirmations settle before return, including on failure. The caller owns
 * the registry lifecycle and must give this call exclusive use of its funding wallets.
 *
 * @param wallets - Registry shared by the root and recipients.
 * @param rootSeed - Fee-ready funding wallet's seed.
 * @param recipients - Funding plan, optionally produced lazily after inspecting balances.
 * @param concurrency - Maximum simultaneous child confirmations.
 * @returns Number of NIGHT transfers submitted.
 * @throws {Error} If the plan is invalid or any transfer or confirmation fails.
 */
export async function fundWalletsFromRoot(
  wallets: WalletRegistry,
  rootSeed: string,
  recipients: Iterable<WalletFundingRecipient> | AsyncIterable<WalletFundingRecipient>,
  concurrency = 4,
): Promise<number> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("funding concurrency must be a positive integer");
  }
  const seen = new Set<string>([walletRegistryKey(rootSeed)]);
  const pending = new Set<Promise<void>>();
  const failures: Error[] = [];
  let transferred = 0;
  try {
    for await (const recipient of recipients) {
      if (pending.size >= concurrency) await Promise.race(pending);
      if (failures.length > 0) break;
      const key: string = walletRegistryKey(recipient.seed);
      if (seen.has(key)) throw new Error(`duplicate funding wallet: ${recipient.label}`);
      seen.add(key);
      if (recipient.amount <= 0n)
        throw new Error(`NIGHT amount must be positive: ${recipient.label}`);
      const child: RegisteredWallet = await wallets.wallet(recipient.seed, recipient.label);
      const state: FacadeState = await waitForFacadeState(child.facade, () => true, 120_000);
      if (state.dust.balance(new Date()) > 0n) continue;
      if (!Object.values(state.unshielded.balances).some((amount) => amount > 0n)) {
        const root: RegisteredWallet = await wallets.wallet(rootSeed, "root");
        const rootState: FacadeState = await waitForFacadeState(
          root.facade,
          (snapshot) => snapshot.pending.all.length === 0,
          60_000,
        );
        if (failures.length > 0) break;
        console.log(
          `${recipient.label}: transferring ${String(recipient.amount)} NIGHT base units`,
        );
        await explainDustSpendRejection(`fund ${recipient.label}`, () =>
          transferNight(
            root.facade,
            root.keys,
            rootState,
            deriveAddresses(child.keys, wallets.config.networkId).unshielded,
            wallets.config.networkId,
            recipient.amount,
          ),
        );
        transferred += 1;
      }
      // Observe failures at creation and drain started work before callers close their registry.
      const confirmation: Promise<void> = explainDustSpendRejection(`fund ${recipient.label}`, () =>
        confirmFeeReady(wallets, child),
      )
        .catch((error: unknown) => {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          pending.delete(confirmation);
        });
      pending.add(confirmation);
    }
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)));
  } finally {
    await Promise.all(pending);
  }
  const failure: Error | undefined = failures[0];
  if (failures.length === 1 && failure !== undefined) throw failure;
  if (failures.length > 1) throw new AggregateError(failures, "wallet funding failed");
  return transferred;
}

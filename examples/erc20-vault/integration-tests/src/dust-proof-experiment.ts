import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { UnboundTransaction } from "@midnight-ntwrk/midnight-js/types";
import type { WalletFacade } from "@sig-net/midnight-contract-deploy";
import type { VaultProviders } from "@sig-net/midnight-examples-erc20-vault-contract";
import { waitForFacadeState } from "@sig-net/midnight-examples-lib";

const execFileAsync = promisify(execFile);
// Substrate storage key: twox128("Timestamp") + twox128("Now").
const TIMESTAMP_NOW_KEY = "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb";
type WalletState = Awaited<ReturnType<WalletFacade["waitForSyncedState"]>>;
type BalancedTransaction = Awaited<ReturnType<VaultProviders["walletProvider"]["balanceTx"]>>;

interface BalanceInput {
  readonly transaction: UnboundTransaction;
  readonly ttl: Date | undefined;
  readonly unboundHash: string;
}

/**
 * Instrument vault test submissions and attempt one fresh balance after an exact node-confirmed
 * InvalidDustSpendProof rejection. The original rejection always reaches the test runner.
 *
 * @param providers - Provider set to wrap before joining the contract.
 * @param facade - Wallet whose fee state is being observed.
 * @param nodeUrl - HTTP RPC endpoint of the local node.
 * @returns Provider set with diagnostic wallet and submission wrappers.
 */
export function withDustProofExperiment(
  providers: VaultProviders,
  facade: WalletFacade,
  nodeUrl: string,
): VaultProviders {
  const inputs = new Map<string, BalanceInput>();
  const report = (phase: string, details: object = {}): void => {
    console.log(
      JSON.stringify({ experiment: "dust-proof", phase, at: new Date().toISOString(), ...details }),
    );
  };
  const rpc = async <T>(method: string, params: string[]): Promise<T> => {
    const response = await fetch(nodeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(5000),
    });
    const payload = (await response.json()) as { result?: T };
    if (!response.ok || payload.result === undefined || payload.result === null) {
      throw new Error("node diagnostic RPC failed");
    }
    return payload.result;
  };
  const nodeRejection = async (hash: string, since: string): Promise<string | undefined> => {
    const { stdout, stderr } = await execFileAsync(
      "docker",
      ["logs", "--since", since, "--tail", "200", "midnight-node"],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
    );
    return `${stdout}\n${stderr}`
      .split("\n")
      .find((line) => line.includes(`Rejected transaction ${hash} `));
  };
  const snapshot = async (phase: string): Promise<void> => {
    let subscription: ReturnType<ReturnType<WalletFacade["state"]>["subscribe"]> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const state: WalletState = await new Promise<WalletState>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("wallet snapshot timeout"));
        }, 5000);
        subscription = facade.state().subscribe({ next: resolve, error: reject });
      });
      report(phase, {
        synced: state.isSynced,
        availableDust: state.dust.balance(new Date()).toString(),
        pendingDust: state.dust.pendingCoins.length,
        pendingNight: state.unshielded.pendingCoins.length,
        dustProgress: {
          applied: state.dust.progress.appliedIndex.toString(),
          highest: state.dust.progress.highestIndex.toString(),
          connected: state.dust.progress.isConnected,
        },
      });
      const blockHash = await rpc<string>("chain_getBlockHash", []);
      const [header, timestamp] = await Promise.all([
        rpc<{ number: string }>("chain_getHeader", [blockHash]),
        rpc<string>("state_getStorage", [TIMESTAMP_NOW_KEY, blockHash]),
      ]);
      report(`${phase}:node`, {
        blockHash,
        heightHex: header.number,
        blockTime: new Date(
          Number(Buffer.from(timestamp.slice(2), "hex").readBigUInt64LE()),
        ).toISOString(),
      });
    } catch {
      report(`${phase}:snapshot-unavailable`);
    } finally {
      subscription?.unsubscribe();
      clearTimeout(timer);
    }
  };
  const describe = (tx: BalancedTransaction): object => ({
    hash: tx.transactionHash(),
    identifiers: tx.identifiers(),
    intents: [...(tx.intents?.values() ?? [])].map((intent) => ({
      ttl: intent.ttl.toISOString(),
      dustTime: intent.dustActions?.ctime.toISOString(),
      calls: intent.actions.flatMap((action) =>
        "entryPoint" in action
          ? [
              {
                address: action.address,
                circuit:
                  typeof action.entryPoint === "string"
                    ? action.entryPoint
                    : new TextDecoder().decode(action.entryPoint),
              },
            ]
          : [],
      ),
    })),
  });
  return {
    ...providers,
    walletProvider: {
      ...providers.walletProvider,
      async balanceTx(transaction, ttl) {
        await snapshot("before-balance");
        const unboundHash = transaction.transactionHash();
        const tx = await providers.walletProvider.balanceTx(transaction, ttl);
        inputs.set(tx.transactionHash(), { transaction, ttl, unboundHash });
        report("balanced-and-proven", describe(tx));
        await snapshot("after-balance");
        return tx;
      },
    },
    midnightProvider: {
      async submitTx(tx) {
        const hash = tx.transactionHash();
        const input = inputs.get(hash);
        const since = new Date().toISOString();
        report("submit", describe(tx));
        try {
          const id = await providers.midnightProvider.submitTx(tx);
          report("accepted", { hash, id });
          return id;
        } catch (originalError) {
          report("rejected", { hash });
          try {
            await snapshot("after-rejection");
            const rejection = await nodeRejection(hash, since);
            if (
              input === undefined ||
              !rejection?.includes("Malformed(InvalidDustSpendProof)") ||
              input.transaction.transactionHash() !== input.unboundHash
            ) {
              report("recovery-skipped", {
                hash,
                reason: "missing or changed unbound input, or no matching node rejection",
              });
            } else {
              report("node-confirmed-rejection", { hash, rejection });
              report("resynchronisation-start", { hash });
              await waitForFacadeState(facade, (state) => state.isSynced, 60_000);
              await snapshot("resynchronised");
              const refreshed = await providers.walletProvider.balanceTx(
                input.transaction,
                input.ttl,
              );
              report("recovery-balanced-and-proven", describe(refreshed));
              report("recovery-submit", describe(refreshed));
              const recoveryHash = refreshed.transactionHash();
              try {
                const id = await providers.midnightProvider.submitTx(refreshed);
                report("recovery-accepted", { hash, recoveryHash, id });
              } catch (recoveryError) {
                report("recovery-rejected", { hash, recoveryHash });
                await snapshot("after-recovery-rejection");
                report("recovery-node-rejection", {
                  recoveryHash,
                  rejection: await nodeRejection(recoveryHash, since),
                });
                throw recoveryError;
              }
            }
          } catch (recoveryError) {
            report("recovery-or-diagnostics-failed", {
              hash,
              errorName: recoveryError instanceof Error ? recoveryError.name : "non-Error",
              rpcCode: /Custom error: \d+/.exec(String(recoveryError))?.[0],
            });
          }
          throw originalError;
        } finally {
          inputs.delete(hash);
        }
      },
    },
  };
}

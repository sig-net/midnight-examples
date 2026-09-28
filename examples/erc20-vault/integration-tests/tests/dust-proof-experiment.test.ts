import type { UnboundTransaction } from "@midnight-ntwrk/midnight-js/types";
import type { WalletFacade } from "@sig-net/midnight-contract-deploy";
import type { VaultProviders } from "@sig-net/midnight-examples-erc20-vault-contract";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withDustProofExperiment } from "../src/dust-proof-experiment.ts";

const { readLogs, synchronise } = vi.hoisted(() => ({
  readLogs: vi.fn(),
  synchronise: vi.fn(),
}));
vi.mock("node:util", () => ({ promisify: () => readLogs }));
vi.mock("@sig-net/midnight-examples-lib", () => ({ waitForFacadeState: synchronise }));

type BalancedTransaction = Awaited<ReturnType<VaultProviders["walletProvider"]["balanceTx"]>>;

const rejectedTransaction = {
  transactionHash: () => "rejected-hash",
  identifiers: () => ["rejected-id"],
  intents: new Map(),
} as BalancedTransaction;
const refreshedTransaction = {
  transactionHash: () => "refreshed-hash",
  identifiers: () => ["refreshed-id"],
  intents: new Map(),
} as BalancedTransaction;
const unbound = { intents: new Map(), transactionHash: () => "unbound-hash" } as UnboundTransaction;

const cases = [
  {
    name: "changed unbound transaction",
    stdout: "Rejected transaction rejected-hash Malformed(InvalidDustSpendProof)",
    stderr: "",
    recover: false,
    recoveryFails: false,
    mutate: true,
  },
  {
    name: "matching rejection on stdout",
    stdout: "Rejected transaction rejected-hash Malformed(InvalidDustSpendProof)",
    stderr: "",
    recover: true,
    recoveryFails: false,
  },
  {
    name: "matching rejection on stderr",
    stdout: "",
    stderr: "Rejected transaction rejected-hash Malformed(InvalidDustSpendProof)",
    recover: true,
    recoveryFails: false,
  },
  {
    name: "another transaction's dust rejection",
    stdout: "Rejected transaction other-hash Malformed(InvalidDustSpendProof)",
    stderr: "",
    recover: false,
    recoveryFails: false,
  },
  {
    name: "another rejection of this transaction",
    stdout: "Rejected transaction rejected-hash Malformed(Other)",
    stderr: "",
    recover: false,
    recoveryFails: false,
  },
  {
    name: "failed recovery",
    stdout: "Rejected transaction rejected-hash Malformed(InvalidDustSpendProof)",
    stderr: "",
    recover: true,
    recoveryFails: true,
  },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("DUST proof CI experiment", () => {
  it.each(cases)("preserves original rejection: $name", async (row) => {
    const { stdout, stderr, recover, recoveryFails } = row;
    if ("mutate" in row) {
      vi.spyOn(unbound, "transactionHash").mockReturnValueOnce("before").mockReturnValue("after");
    }
    const originalError = new Error("original RPC rejection");
    const balanceTx = vi
      .fn()
      .mockResolvedValueOnce(rejectedTransaction)
      .mockResolvedValueOnce(refreshedTransaction);
    const submitTx = vi.fn().mockRejectedValueOnce(originalError);
    if (recoveryFails) submitTx.mockRejectedValueOnce(new Error("recovery rejected"));
    else submitTx.mockResolvedValueOnce("recovery-id");
    const providers = {
      walletProvider: { balanceTx, getCoinPublicKey: vi.fn(), getEncryptionPublicKey: vi.fn() },
      midnightProvider: { submitTx },
    } as Partial<VaultProviders> as VaultProviders;
    const unsubscribe = vi.fn();
    const facade = {
      state: () =>
        ({
          subscribe: ({ next }: { next: (state: object) => void }) => {
            next({
              isSynced: true,
              dust: {
                balance: () => 100n,
                pendingCoins: [],
                progress: { appliedIndex: 4n, highestIndex: 4n, isConnected: true },
              },
              unshielded: { pendingCoins: [] },
            });
            return { unsubscribe } as Partial<
              ReturnType<ReturnType<WalletFacade["state"]>["subscribe"]>
            > as ReturnType<ReturnType<WalletFacade["state"]>["subscribe"]>;
          },
        }) as Partial<ReturnType<WalletFacade["state"]>> as ReturnType<WalletFacade["state"]>,
    } as Partial<WalletFacade> as WalletFacade;
    readLogs.mockResolvedValue({ stdout, stderr });
    synchronise.mockResolvedValue(undefined);
    const rpc = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      const body = init?.body;
      if (typeof body !== "string") throw new Error("expected JSON RPC body");
      const result = body.includes('"chain_getBlockHash"')
        ? "block-hash"
        : body.includes('"chain_getHeader"')
          ? { number: "0x4" }
          : "0x0000000000000000";
      return Promise.resolve(new Response(JSON.stringify({ result })));
    });
    vi.stubGlobal("fetch", rpc);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const wrapped = withDustProofExperiment(providers, facade, "http://localhost:9944");
    const ttl = new Date("2030-01-01");

    const tx = await wrapped.walletProvider.balanceTx(unbound, ttl);
    await expect(wrapped.midnightProvider.submitTx(tx)).rejects.toBe(originalError);

    expect(balanceTx).toHaveBeenCalledTimes(recover ? 2 : 1);
    expect(submitTx).toHaveBeenCalledTimes(recover ? 2 : 1);
    expect(synchronise).toHaveBeenCalledTimes(recover ? 1 : 0);
    expect(balanceTx).toHaveBeenLastCalledWith(unbound, ttl);
    expect(unsubscribe).toHaveBeenCalled();
    expect(log.mock.calls.flat().join("\n")).toContain('"blockTime":"1970-01-01T00:00:00.000Z"');
    expect(log.mock.calls.flat().join("\n")).not.toContain("snapshot-unavailable");
    expect(log.mock.calls.flat().join("\n")).toContain(
      recover
        ? recoveryFails
          ? "recovery-or-diagnostics-failed"
          : "recovery-accepted"
        : "recovery-skipped",
    );
  });
});

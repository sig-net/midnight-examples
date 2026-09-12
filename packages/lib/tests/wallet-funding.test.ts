vi.mock("@sig-net/midnight-contract-deploy", async (importOriginal) => {
  const actual = await importOriginal<typeof funding>();
  return { ...actual };
});

import * as funding from "@sig-net/midnight-contract-deploy";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureWalletsFunded } from "../src/wallet-funding.ts";

const ENV: NodeJS.ProcessEnv = {
  ROOT_SEED: "root",
  DEPLOYER_SEED: "deployer",
  USER_SEED: "user",
  MPC_RESPONDER_SEED: "mpc",
  BEARER_SEED: "bearer",
};
const FUNDED: funding.AccountFunding = {
  addresses: { unshielded: "night", shielded: "shielded", dust: "dust" },
  night: 100n,
  dust: 10n,
};

afterEach(() => vi.restoreAllMocks());

describe("child funding decisions", () => {
  it.each([
    { name: "DUST without NIGHT", night: 0n, dust: 10n },
    { name: "NIGHT awaiting DUST", night: 100n, dust: 0n },
    { name: "NIGHT and DUST", night: 100n, dust: 10n },
  ])("does not open an unfunded root for $name", async ({ night, dust }) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(funding, "readAccountFunding").mockResolvedValue({ ...FUNDED, night, dust });
    const root = vi
      .spyOn(funding, "assertRootFunded")
      .mockRejectedValue(new Error("unfunded root"));
    const transfer = vi.spyOn(funding, "fundChildFromRoot").mockResolvedValue(FUNDED);
    const wallets = new funding.WalletRegistry(
      funding.getMidnightNodeConfig({ NETWORK_ID: "stagenet" }),
    );
    await ensureWalletsFunded(ENV, wallets);
    expect(root).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });

  it("funds only empty wallets and preserves root's weighted reserve", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const read = vi
      .spyOn(funding, "readAccountFunding")
      .mockImplementation((_registry, seed) =>
        Promise.resolve(seed === "user" ? { ...FUNDED, night: 0n, dust: 0n } : FUNDED),
      );
    const root = vi
      .spyOn(funding, "assertRootFunded")
      .mockResolvedValue({ ...FUNDED, night: 600n });
    const transfer = vi.spyOn(funding, "fundChildFromRoot").mockResolvedValue(FUNDED);
    const wallets = new funding.WalletRegistry(
      funding.getMidnightNodeConfig({ NETWORK_ID: "stagenet" }),
    );
    await ensureWalletsFunded(ENV, wallets);
    expect(read).toHaveBeenCalledTimes(5);
    expect(root).toHaveBeenCalledOnce();
    expect(transfer).toHaveBeenCalledExactlyOnceWith(wallets, "root", "user", "user", 300n);
  });

  it("rechecks a child before opening root", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(funding, "readAccountFunding")
      .mockResolvedValueOnce({ ...FUNDED, night: 0n, dust: 0n })
      .mockResolvedValue(FUNDED);
    const root = vi
      .spyOn(funding, "assertRootFunded")
      .mockRejectedValue(new Error("must not open root"));
    const wallets = new funding.WalletRegistry(
      funding.getMidnightNodeConfig({ NETWORK_ID: "stagenet" }),
    );
    await ensureWalletsFunded(ENV, wallets);
    expect(root).not.toHaveBeenCalled();
  });
});

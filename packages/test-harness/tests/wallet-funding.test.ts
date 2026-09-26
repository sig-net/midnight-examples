vi.mock("@sig-net/midnight-contract-deploy", async (importOriginal) => {
  const actual = await importOriginal<typeof funding>();
  return { ...actual };
});

import * as funding from "@sig-net/midnight-contract-deploy";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureWalletsFunded } from "../src/wallets.ts";

const ROOT_SEED = "root";
const DEPLOYER_SEED = "deployer";
const USER_SEED = "user";
const MPC_RESPONDER_SEED = "mpc";
const BEARER_SEED = "bearer";
const ENV: NodeJS.ProcessEnv = {
  ROOT_SEED,
  DEPLOYER_SEED,
  USER_SEED,
  MPC_RESPONDER_SEED,
  BEARER_SEED,
};
const FUNDED: funding.AccountFunding = {
  addresses: { unshielded: "night", shielded: "shielded", dust: "dust" },
  night: 100n,
  dust: 10n,
};
const NETWORK_ID = funding.getMidnightNodeConfig({ NETWORK_ID: "stagenet" }).networkId;

const ROOT_KEYS = funding.deriveAccountKeys("01".repeat(32), NETWORK_ID);
const DEPLOYER_KEYS = funding.deriveAccountKeys("02".repeat(32), NETWORK_ID);
const USER_KEYS = funding.deriveAccountKeys("03".repeat(32), NETWORK_ID);
const MPC_RESPONDER_KEYS = funding.deriveAccountKeys("04".repeat(32), NETWORK_ID);
const BEARER_KEYS = funding.deriveAccountKeys("05".repeat(32), NETWORK_ID);

function fakeAddresses(night: string): funding.WalletAddresses {
  return { unshielded: night, shielded: `${night} shielded`, dust: `${night} dust` };
}

const KEYS_BY_SEED = new Map<string, funding.AccountKeys>([
  [ROOT_SEED, ROOT_KEYS],
  [DEPLOYER_SEED, DEPLOYER_KEYS],
  [USER_SEED, USER_KEYS],
  [MPC_RESPONDER_SEED, MPC_RESPONDER_KEYS],
  [BEARER_SEED, BEARER_KEYS],
]);

const ADDRESSES_BY_KEYS = new Map<funding.AccountKeys, funding.WalletAddresses>([
  [ROOT_KEYS, fakeAddresses("root night address")],
  [DEPLOYER_KEYS, fakeAddresses("deployer night address")],
  [USER_KEYS, fakeAddresses("user night address")],
  [MPC_RESPONDER_KEYS, fakeAddresses("mpc responder night address")],
  [BEARER_KEYS, fakeAddresses("bearer night address")],
]);

/** Mock the SDK's key-to-address derivation to the table above. */
function mockAddressDerivation(): void {
  vi.spyOn(funding, "deriveAddresses").mockImplementation((keys: funding.AccountKeys) => {
    const addresses = ADDRESSES_BY_KEYS.get(keys);
    if (addresses === undefined) throw new Error("no fake addresses for these keys");
    return addresses;
  });
}

/** A registry whose `wallet` returns offline fakes instead of opening facades. */
function fakeRegistry(): {
  registry: funding.WalletRegistry;
  facade: funding.WalletFacade;
  state: funding.FacadeState;
  setPending: (pending: funding.FacadeState["pending"]) => void;
} {
  const pendingBox: { current: funding.FacadeState["pending"] } = { current: { all: [] } };
  const dust: Partial<funding.FacadeState["dust"]> = { balance: (): bigint => 10n };
  const state = {
    dust: dust as funding.FacadeState["dust"],
    get pending(): funding.FacadeState["pending"] {
      return pendingBox.current;
    },
  } as Partial<funding.FacadeState> as funding.FacadeState;
  const facade = {
    waitForSyncedState: vi.fn((): Promise<funding.FacadeState> => Promise.resolve(state)),
  } as Partial<funding.WalletFacade> as funding.WalletFacade;
  const registry = new funding.WalletRegistry(
    funding.getMidnightNodeConfig({ NETWORK_ID: "stagenet" }),
  );
  vi.spyOn(registry, "wallet").mockImplementation((seed: string, label: string) => {
    const keys = KEYS_BY_SEED.get(seed);
    if (keys === undefined) throw new Error(`no fake wallet for seed ${seed}`);
    return Promise.resolve({ label, keys, facade });
  });
  return {
    registry,
    facade,
    state,
    setPending: (next: funding.FacadeState["pending"]): void => {
      pendingBox.current = next;
    },
  };
}

/**
 * Mock the balance reads so `seed` reads empty for its first `empties` calls
 * (the pre-transfer pass and the recheck) and funded afterwards (the
 * confirmation poll); every other seed always reads funded.
 */
function mockBalanceReads(empties: ReadonlyMap<string, number>): void {
  const calls = new Map<string, number>();
  vi.spyOn(funding, "readAccountFunding").mockImplementation(
    (_registry: funding.WalletRegistry, seed: string) => {
      const count = (calls.get(seed) ?? 0) + 1;
      calls.set(seed, count);
      const stillEmpty = count <= (empties.get(seed) ?? 0);
      return Promise.resolve(stillEmpty ? { ...FUNDED, night: 0n, dust: 0n } : FUNDED);
    },
  );
}

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
    const transfer = vi.spyOn(funding, "transferNight").mockResolvedValue("tx");
    const { registry: wallets } = fakeRegistry();
    await ensureWalletsFunded(ENV, wallets);
    expect(root).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });

  it("funds only empty wallets and preserves root's weighted reserve", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    mockAddressDerivation();
    const { registry: wallets, facade, state } = fakeRegistry();
    mockBalanceReads(new Map([[USER_SEED, 2]]));
    const root = vi
      .spyOn(funding, "assertRootFunded")
      .mockResolvedValue({ ...FUNDED, night: 600n });
    const transfer = vi.spyOn(funding, "transferNight").mockResolvedValue("user transfer");
    const feeReady = vi.spyOn(funding, "ensureFeeReady").mockResolvedValue(10n);
    await ensureWalletsFunded(ENV, wallets);
    expect(vi.mocked(funding.readAccountFunding)).toHaveBeenCalledTimes(6);
    expect(root).toHaveBeenCalledOnce();
    expect(transfer).toHaveBeenCalledExactlyOnceWith(
      facade,
      ROOT_KEYS,
      state,
      "user night address",
      NETWORK_ID,
      300n,
    );
    expect(feeReady).toHaveBeenCalledExactlyOnceWith(facade, USER_KEYS, state, NETWORK_ID);
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

  it("submits every transfer before awaiting any child's confirmation", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    mockAddressDerivation();
    const { registry: wallets, facade, state } = fakeRegistry();
    mockBalanceReads(
      new Map([
        [DEPLOYER_SEED, 2],
        [USER_SEED, 2],
      ]),
    );
    vi.spyOn(funding, "assertRootFunded").mockResolvedValue({ ...FUNDED, night: 600n });
    const transfer = vi.spyOn(funding, "transferNight").mockResolvedValue("transfer");
    let release: () => void = (): void => undefined;
    const confirmed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const feeReady = vi
      .spyOn(funding, "ensureFeeReady")
      .mockImplementation(() => confirmed.then((): bigint => 10n));
    const run = ensureWalletsFunded(ENV, wallets);
    await vi.waitFor(() => {
      expect(transfer).toHaveBeenCalledTimes(2);
      expect(feeReady).toHaveBeenCalledTimes(2);
    });
    expect(transfer).toHaveBeenNthCalledWith(
      1,
      facade,
      ROOT_KEYS,
      state,
      "deployer night address",
      NETWORK_ID,
      360n,
    );
    expect(transfer).toHaveBeenNthCalledWith(
      2,
      facade,
      ROOT_KEYS,
      state,
      "user night address",
      NETWORK_ID,
      120n,
    );
    release();
    await expect(run).resolves.toBeUndefined();
  });

  it("waits for root's pending transactions to settle before the next transfer", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    mockAddressDerivation();
    const onePending: funding.FacadeState["pending"] = {
      all: Array.from<funding.FacadeState["pending"]["all"][number]>({ length: 1 }),
    };
    const { registry: wallets, setPending } = fakeRegistry();
    mockBalanceReads(
      new Map([
        [DEPLOYER_SEED, 2],
        [USER_SEED, 2],
      ]),
    );
    vi.spyOn(funding, "assertRootFunded").mockResolvedValue({ ...FUNDED, night: 600n });
    vi.spyOn(funding, "ensureFeeReady").mockResolvedValue(10n);
    const transfer = vi.spyOn(funding, "transferNight").mockImplementation(() => {
      setPending(onePending);
      return Promise.resolve("transfer");
    });
    const run = ensureWalletsFunded(ENV, wallets);
    await vi.waitFor(() => {
      expect(transfer).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(transfer).toHaveBeenCalledTimes(1);
    setTimeout(() => {
      setPending({ all: [] });
    }, 10);
    await vi.waitFor(
      () => {
        expect(transfer).toHaveBeenCalledTimes(2);
      },
      { timeout: 5_000 },
    );
    await expect(run).resolves.toBeUndefined();
  });
});

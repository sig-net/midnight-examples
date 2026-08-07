import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/App";
import { THEME_STORAGE_KEY } from "../src/lib/theme";
import { clearMidnightWallets, injectMidnightWallet } from "./fakeWallets";

/**
 * The header controls, driven the way a user drives them: through the app, by
 * accessible name. Nothing here reaches for a context or a component directly.
 *
 * No wallet extension is injected under jsdom, which is the honest disconnected
 * case: `window.midnight` is absent and nothing answers the EIP-6963 request,
 * so the menus show what a visitor without a wallet installed actually sees.
 */

/** One wallet control, and the state it must report with no extension present. */
interface WalletCase {
  readonly chainName: string;
  readonly emptyMessage: string;
}

const WALLET_CASES: readonly WalletCase[] = [
  { chainName: "Midnight", emptyMessage: "No Midnight wallet extension found" },
  { chainName: "EVM", emptyMessage: "No EVM wallet extension found" },
];

describe("wallet controls", () => {
  it.each(WALLET_CASES)("shows the $chainName wallet as not connected", ({ chainName }) => {
    render(<App />);

    expect(
      screen.getByRole("button", { name: `${chainName} wallet: not connected` }),
    ).toBeInTheDocument();
  });

  it.each(WALLET_CASES)(
    "offers no $chainName wallet to connect when no extension is installed",
    async ({ chainName, emptyMessage }) => {
      const user = userEvent.setup();
      render(<App />);

      await user.click(screen.getByRole("button", { name: `${chainName} wallet: not connected` }));

      const menu = await screen.findByRole("menu");
      expect(within(menu).getByText(emptyMessage)).toBeInTheDocument();
      expect(within(menu).queryByText("Disconnect")).not.toBeInTheDocument();
    },
  );
});

afterEach(() => {
  clearMidnightWallets();
});

describe("wallet connection failures", () => {
  it("offers an injected wallet, and reports a refused connection on a toast", async () => {
    const user = userEvent.setup();
    injectMidnightWallet({
      name: "Test Wallet",
      failWith: new Error("User declined the connection request"),
    });
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Midnight wallet: not connected" }));
    await user.click(await screen.findByRole("menuitem", { name: /Connect Test Wallet/ }));

    // The failure surfaces as a toast rather than an unhandled rejection, and
    // it carries the connector's own words rather than a generic apology.
    expect(await screen.findByText("Could not connect the Midnight wallet")).toBeInTheDocument();
    expect(await screen.findByText("User declined the connection request")).toBeInTheDocument();

    // And the control still reads as disconnected, since it never connected.
    expect(
      screen.getByRole("button", { name: "Midnight wallet: not connected" }),
    ).toBeInTheDocument();
  });
});

describe("the seed wallet entry", () => {
  /** One chain's seed entry, and the toast title its failures carry. */
  interface SeedCase {
    readonly chainName: string;
    readonly toastTitle: string;
  }

  const SEED_CASES: readonly SeedCase[] = [
    { chainName: "Midnight", toastTitle: "Could not install the Midnight seed wallet" },
    { chainName: "EVM", toastTitle: "Could not install the EVM seed wallet" },
  ];

  it.each(SEED_CASES)(
    "offers a $chainName seed wallet with no extension installed, and reports a bad seed on a toast",
    async ({ chainName, toastTitle }) => {
      const user = userEvent.setup();
      render(<App />);

      await user.click(screen.getByRole("button", { name: `${chainName} wallet: not connected` }));
      await user.click(await screen.findByRole("menuitem", { name: "Use a seed wallet" }));

      const dialog = await screen.findByRole("dialog", { name: "Use a seed wallet" });
      await user.type(within(dialog).getByRole("textbox", { name: "Seed" }), "not-hex");
      await user.click(within(dialog).getByRole("button", { name: "Install seed wallet" }));

      // The parse rejection surfaces as a toast carrying the wallet's own
      // words, and the control still reads as disconnected.
      expect(await screen.findByText(toastTitle)).toBeInTheDocument();
      expect(await screen.findByText(/The seed must be hex/)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: `${chainName} wallet: not connected` }),
      ).toBeInTheDocument();
    },
  );

  it("installs an EVM seed wallet and shows its derived address", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "EVM wallet: not connected" }));
    await user.click(await screen.findByRole("menuitem", { name: "Use a seed wallet" }));

    const dialog = await screen.findByRole("dialog", { name: "Use a seed wallet" });
    await user.type(within(dialog).getByRole("textbox", { name: "Seed" }), `0x${"11".repeat(32)}`);
    await user.click(within(dialog).getByRole("button", { name: "Install seed wallet" }));

    // Deriving the account is all local work, so the wallet arrives without
    // any RPC behind it, and the menu names it with its derived address.
    await user.click(await screen.findByRole("button", { name: "EVM wallet: connected" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Seed wallet")).toBeInTheDocument();
    expect(within(menu).getByText(/^0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/)).toBeInTheDocument();
    expect(within(menu).getByText("Disconnect")).toBeInTheDocument();
  });
});

describe("the configuration panel", () => {
  it("shows every configurable value, grouped by surface", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Configuration" }));

    for (const textField of [
      "MPC public key",
      "Contract address",
      "Indexer URL",
      "Indexer WebSocket URL",
      "Node URL",
      "Proof server URL",
      "RPC URL",
      "Explorer URL",
    ]) {
      expect(await screen.findByRole("textbox", { name: textField })).toBeInTheDocument();
    }
    expect(screen.getByRole("combobox", { name: "Network" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Chain" })).toBeInTheDocument();

    // The local defaults, so the panel provably shows the STORED config.
    expect(screen.getByRole("textbox", { name: "Node URL" })).toHaveValue("http://127.0.0.1:9944");
    expect(screen.getByRole("textbox", { name: "RPC URL" })).toHaveValue("http://127.0.0.1:8545");
  });

  it("switching the Midnight network resets its endpoints to that network's defaults", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Configuration" }));
    await user.click(screen.getByRole("combobox", { name: "Network" }));
    await user.click(await screen.findByRole("option", { name: "preview" }));

    expect(screen.getByRole("textbox", { name: "Indexer URL" })).toHaveValue(
      "https://indexer.preview.midnight.network/api/v3/graphql",
    );

    // Back to the local stack, so the SDK-global network id this switch moves
    // does not leak into later tests.
    await user.click(screen.getByRole("combobox", { name: "Network" }));
    await user.click(await screen.findByRole("option", { name: "undeployed" }));
    expect(screen.getByRole("textbox", { name: "Indexer URL" })).toHaveValue(
      "http://127.0.0.1:8088/api/v3/graphql",
    );
  });

  it("switching the EVM chain brings that chain's default endpoints", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Configuration" }));
    await user.click(screen.getByRole("combobox", { name: "Chain" }));
    await user.click(await screen.findByRole("option", { name: "Sepolia (11155111)" }));

    expect(screen.getByRole("textbox", { name: "RPC URL" })).toHaveValue(
      "https://ethereum-sepolia-rpc.publicnode.com",
    );
    expect(screen.getByRole("textbox", { name: "Explorer URL" })).toHaveValue(
      "https://sepolia.etherscan.io",
    );
  });

  it("rejects an invalid URL on a toast and keeps the stored value", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Configuration" }));
    const nodeUrl = screen.getByRole("textbox", { name: "Node URL" });
    await user.clear(nodeUrl);
    await user.type(nodeUrl, "not-a-url");
    await user.tab();

    expect(await screen.findByText("Could not apply Node URL")).toBeInTheDocument();

    // Reopening drops the rejected draft and shows the value still stored.
    // Closed by clicking outside: an Escape can land on the info tooltip the
    // blur's focus move opened, leaving the panel itself up.
    await user.click(screen.getByRole("banner"));
    await user.click(screen.getByRole("button", { name: "Configuration" }));
    expect(await screen.findByRole("textbox", { name: "Node URL" })).toHaveValue(
      "http://127.0.0.1:9944",
    );
  });

  it("warns where the connected wallet's own configuration differs", async () => {
    const user = userEvent.setup();
    injectMidnightWallet({
      name: "Test Wallet",
      configuration: { indexerUri: "https://indexer.elsewhere.example/graphql" },
    });
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Midnight wallet: not connected" }));
    await user.click(await screen.findByRole("menuitem", { name: /Connect Test Wallet/ }));
    await screen.findByRole("button", { name: "Midnight wallet: connected" });

    await user.click(screen.getByRole("button", { name: "Configuration" }));

    // The differing endpoint warns, while one the wallet does not report
    // keeps its plain info icon.
    expect(
      await screen.findByRole("button", { name: "Indexer URL differs from the connected wallet" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "About Node URL" })).toBeInTheDocument();
  });

  it("keeps an EVM seed wallet connected across an RPC URL change", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "EVM wallet: not connected" }));
    await user.click(await screen.findByRole("menuitem", { name: "Use a seed wallet" }));
    const dialog = await screen.findByRole("dialog", { name: "Use a seed wallet" });
    await user.type(within(dialog).getByRole("textbox", { name: "Seed" }), `0x${"22".repeat(32)}`);
    await user.click(within(dialog).getByRole("button", { name: "Install seed wallet" }));
    await screen.findByRole("button", { name: "EVM wallet: connected" });

    // The seed wallet follows the app's config: the context rebuilds it for
    // the new RPC URL rather than leaving it on the old one, and the
    // connection reads as unbroken throughout.
    await user.click(screen.getByRole("button", { name: "Configuration" }));
    const rpcUrl = screen.getByRole("textbox", { name: "RPC URL" });
    await user.clear(rpcUrl);
    await user.type(rpcUrl, "http://127.0.0.1:9999{Enter}");
    await user.keyboard("{Escape}");

    expect(
      await screen.findByRole("button", { name: "EVM wallet: connected" }),
    ).toBeInTheDocument();
  });
});

describe("theme control", () => {
  it("follows the system by default, and says so", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Theme: system" }));

    expect(await screen.findByRole("menuitem", { name: "System" })).toBeInTheDocument();
  });

  it("applies dark, and remembers the choice", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Theme: system" }));
    await user.click(await screen.findByRole("menuitem", { name: "Dark" }));

    expect(document.documentElement).toHaveClass("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(screen.getByRole("button", { name: "Theme: dark" })).toBeInTheDocument();
  });

  it("starts from the stored choice rather than the system", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");

    render(<App />);

    expect(document.documentElement).toHaveClass("dark");
    expect(screen.getByRole("button", { name: "Theme: dark" })).toBeInTheDocument();
  });
});

describe("branding", () => {
  it("links home from the Signature Network mark", () => {
    render(<App />);

    const home = screen.getByRole("link", { name: /Signature Network/ });

    expect(home).toHaveAttribute("href", "/");
  });
});

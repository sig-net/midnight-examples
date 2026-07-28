import type { InitialAPI } from "@midnight-ntwrk/dapp-connector-api";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";
import { THEME_STORAGE_KEY } from "../src/lib/theme";

/**
 * The header controls, driven the way a user drives them: through the app, by
 * accessible name. Nothing here reaches for a context or a component directly.
 *
 * No wallet extension is injected under jsdom, which is the honest disconnected
 * case: `window.midnight` is absent and wagmi announces no connectors, so the
 * menus show what a visitor without a wallet installed actually sees.
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
  it.each(WALLET_CASES)(
    "shows the $chainName wallet as not connected",
    ({ chainName }) => {
      render(<App />);

      expect(
        screen.getByRole("button", { name: `${chainName} wallet: not connected` }),
      ).toBeInTheDocument();
    },
  );

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

/**
 * Inject a Midnight wallet under `window.midnight`, the way an extension does.
 *
 * Only `connect` and the self-description are real: `BrowserWallet.available`
 * reads exactly those, and a connect that rejects never reaches the rest of the
 * connector API.
 *
 * @param name - The wallet name the menu should offer.
 * @param connect - The connect call, whose rejection is what the test is after.
 */
function injectMidnightWallet(name: string, connect: InitialAPI["connect"]): void {
  const injected: InitialAPI = {
    rdns: "network.sig.test-wallet",
    name,
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
    apiVersion: "4.0.0",
    connect,
  };
  window.midnight = { "test-wallet-key": injected };
}

afterEach(() => {
  delete window.midnight;
});

describe("wallet connection failures", () => {
  it("offers an injected wallet, and reports a refused connection on a toast", async () => {
    const user = userEvent.setup();
    injectMidnightWallet(
      "Test Wallet",
      vi.fn().mockRejectedValue(new Error("User declined the connection request")),
    );
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

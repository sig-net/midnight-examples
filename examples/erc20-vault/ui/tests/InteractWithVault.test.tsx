import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/App";
import {
  clearMidnightWallets,
  FAKE_SHIELDED_TOKEN_TYPE,
  FAKE_UNSHIELDED_TOKEN_TYPE,
  injectMidnightWallet,
} from "./fakeWallets";

/**
 * The vault-interaction step's view: the tracked-ERC20 list, and one balance
 * panel per account the flow touches.
 *
 * No EVM chain answers under test, so the EVM balances are deliberately not
 * asserted on: what these cover is which panels exist, what each says while it
 * has nothing to read, and the two things that work without a chain, tracking a
 * token and reading the Midnight wallet.
 */

/** Every account the step reports on, in the order the view lists them. */
const BALANCE_PANELS = [
  "EVM browser wallet",
  "Your deposit address",
  "Vault address",
  "Midnight browser wallet",
] as const;

/** A token address to track: valid, and answering nothing under test. */
const SOME_ERC20 = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

afterEach(() => {
  clearMidnightWallets();
});

/** Put the interact step's details in the view area by selecting its card. */
async function openInteractView(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "Interact with the vault" }));
  return screen.getByRole("region", { name: "Interact with the vault details" });
}

describe("the vault interaction step", () => {
  it("gives every account its own balance panel", async () => {
    const user = userEvent.setup();
    render(<App />);

    const view = await openInteractView(user);

    for (const panel of BALANCE_PANELS) {
      expect(within(view).getByRole("region", { name: `${panel} balances` })).toBeInTheDocument();
    }
  });

  it("with nothing connected, each panel says what it is waiting for", async () => {
    const user = userEvent.setup();
    render(<App />);

    const view = await openInteractView(user);

    expect(
      within(view).getByText("Connect the EVM wallet to read its balances."),
    ).toBeInTheDocument();
    expect(
      within(view).getByText(/Derive your deposit address first/),
    ).toBeInTheDocument();
    expect(within(view).getByText("Connect the Midnight wallet to read the vault.")).toBeInTheDocument();
    expect(
      within(view).getByText("Connect the Midnight wallet to read its balances."),
    ).toBeInTheDocument();

    // Nothing to refresh while there is nothing to read.
    expect(
      within(view).getByRole("button", { name: "Refresh EVM browser wallet balances" }),
    ).toBeDisabled();
  });

  it("tracks an ERC20 by address, and drops it again", async () => {
    const user = userEvent.setup();
    render(<App />);

    const view = await openInteractView(user);
    const tracked = within(view).getByRole("region", { name: "Tracked ERC20 assets" });
    expect(within(tracked).getByText(/No assets tracked yet/)).toBeInTheDocument();

    await user.type(
      within(tracked).getByRole("textbox", { name: "Enter ERC20 tokens to track" }),
      SOME_ERC20,
    );
    await user.click(within(tracked).getByRole("button", { name: "Track" }));

    // The row appears on the address alone. Nothing answers name() or symbol()
    // here, which is exactly what a token implementing neither looks like.
    const row = await within(tracked).findByRole("button", {
      name: `Stop tracking ${SOME_ERC20}`,
    });
    expect(within(tracked).getAllByText("Unknown")).toHaveLength(2);
    expect(within(tracked).queryByText(/No assets tracked yet/)).not.toBeInTheDocument();

    await user.click(row);

    expect(
      within(tracked).queryByRole("button", { name: `Stop tracking ${SOME_ERC20}` }),
    ).not.toBeInTheDocument();
    expect(within(tracked).getByText(/No assets tracked yet/)).toBeInTheDocument();
  });

  it("refuses to track something that is not an address", async () => {
    const user = userEvent.setup();
    render(<App />);

    const view = await openInteractView(user);
    const tracked = within(view).getByRole("region", { name: "Tracked ERC20 assets" });

    await user.type(
      within(tracked).getByRole("textbox", { name: "Enter ERC20 tokens to track" }),
      "not-an-address",
    );
    await user.click(within(tracked).getByRole("button", { name: "Track" }));

    expect(within(tracked).getByText(/No assets tracked yet/)).toBeInTheDocument();
    expect(await screen.findByText("Not an ERC20 address")).toBeInTheDocument();
    // The rejected text stays put, so it can be corrected rather than retyped.
    expect(within(tracked).getByRole("textbox", { name: "Enter ERC20 tokens to track" })).toHaveValue(
      "not-an-address",
    );
  });

  it("reads the Midnight wallet's balances once it is connected", async () => {
    const user = userEvent.setup();
    injectMidnightWallet({ name: "Test Lace" });
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: /Connect Test Lace/ }),
    );
    const view = await openInteractView(user);
    const panel = within(view).getByRole("region", { name: "Midnight browser wallet balances" });

    // Every asset the connector reports: shielded, unshielded, and the dust
    // pair, in the wallet's own atomic units.
    expect(await within(panel).findByText(FAKE_SHIELDED_TOKEN_TYPE)).toBeInTheDocument();
    expect(within(panel).getByText("1500")).toBeInTheDocument();
    expect(within(panel).getByText(FAKE_UNSHIELDED_TOKEN_TYPE)).toBeInTheDocument();
    expect(within(panel).getByText("2500")).toBeInTheDocument();
    expect(within(panel).getByText("3500")).toBeInTheDocument();
    expect(within(panel).getByText("9000")).toBeInTheDocument();
  });
});

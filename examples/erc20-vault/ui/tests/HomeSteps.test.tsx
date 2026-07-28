import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/App";
import {
  announceEvmWallet,
  clearMidnightWallets,
  injectMidnightWallet,
  type StopAnnouncing,
} from "./fakeWallets";

/**
 * The overview's steps, and the three states the connect step moves through as
 * wallets come in: none connected, one connected, both connected.
 *
 * Driven through the app by accessible name, with the wallets faked at the
 * extension boundary, so the step's state is derived by the real hooks from the
 * real contexts rather than asserted against a stub.
 */

/** The chain the app runs against under test, per chain-config's defaults. */
const APP_CHAIN_ID = 31337;

const stopAnnouncing: StopAnnouncing[] = [];

afterEach(() => {
  clearMidnightWallets();
  for (const stop of stopAnnouncing.splice(0)) {
    stop();
  }
});

/** Announce an EVM wallet on the app's own chain, cleaned up after the test. */
function announceMatchingEvmWallet(name: string): void {
  stopAnnouncing.push(
    announceEvmWallet({
      name,
      chainId: APP_CHAIN_ID,
      address: "0x1111111111111111111111111111111111111111",
    }),
  );
}

/** The connect step's card, found by the accessible name StepCard gives it. */
function connectStep(): HTMLElement {
  return screen.getByRole("group", { name: /Step 1: Connect wallets/ });
}

describe("the step sequence", () => {
  it("lists all three steps, with the later two flagged as not built yet", () => {
    render(<App />);

    expect(screen.getByRole("group", { name: /Step 1: Connect wallets/ })).toBeInTheDocument();
    const balances = screen.getByRole("group", { name: /Step 2: Balance checks/ });
    const interact = screen.getByRole("group", { name: /Step 3: Interact with the vault/ });

    expect(within(balances).getByText("Coming soon")).toBeInTheDocument();
    expect(within(interact).getByText("Coming soon")).toBeInTheDocument();
  });

  it("no longer shows the app blurb or the chain endpoint tables", () => {
    render(<App />);

    expect(screen.queryByText(/A single-page app over the erc20-vault/)).not.toBeInTheDocument();
    expect(screen.queryByText("Proof server")).not.toBeInTheDocument();
    expect(screen.queryByText("Indexer (WS)")).not.toBeInTheDocument();
  });
});

describe("the connect step", () => {
  it("with nothing connected, asks for both wallets and marks the step incomplete", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { level: 1, name: "To start you'll need 2 connected wallets" }),
    ).toBeInTheDocument();
    expect(connectStep()).toHaveAccessibleName(/Step 1: Connect wallets \(current\)/);
    expect(within(connectStep()).getByText("0/2")).toBeInTheDocument();
  });

  it("says so when a chain has no wallet extension at all", () => {
    render(<App />);

    expect(within(connectStep()).getByText("No Midnight wallet found")).toBeInTheDocument();
    expect(within(connectStep()).getByText("No EVM wallet found")).toBeInTheDocument();
  });

  it("with one wallet connected, still asks for two", async () => {
    const user = userEvent.setup();
    injectMidnightWallet({ name: "Test Lace" });
    render(<App />);

    await user.click(await within(connectStep()).findByRole("button", { name: /Connect Test Lace/ }));

    // The connected row stops being a control and states the wallet instead.
    expect(await within(connectStep()).findByText("Test Lace")).toBeInTheDocument();
    expect(
      within(connectStep()).queryByRole("button", { name: /Connect Test Lace/ }),
    ).not.toBeInTheDocument();

    // One of two: the step is not done, and the prompt has not changed.
    expect(within(connectStep()).getByText("1/2")).toBeInTheDocument();
    expect(connectStep()).toHaveAccessibleName(/\(current\)/);
    expect(
      screen.getByRole("heading", { level: 1, name: "To start you'll need 2 connected wallets" }),
    ).toBeInTheDocument();
  });

  it("with both wallets connected, completes the step and says so", async () => {
    const user = userEvent.setup();
    injectMidnightWallet({ name: "Test Lace" });
    announceMatchingEvmWallet("Test MetaMask");
    render(<App />);

    await user.click(await within(connectStep()).findByRole("button", { name: /Connect Test Lace/ }));
    await user.click(
      await within(connectStep()).findByRole("button", { name: /Connect Test MetaMask/ }),
    );

    expect(
      await screen.findByRole("heading", { level: 1, name: "Wallet connections set" }),
    ).toBeInTheDocument();
    expect(connectStep()).toHaveAccessibleName(/Step 1: Connect wallets \(complete\)/);

    // The count badge goes away once there is nothing left to count down.
    expect(within(connectStep()).queryByText("2/2")).not.toBeInTheDocument();

    // Both header controls agree with the step.
    expect(
      screen.getByRole("button", { name: "Midnight wallet: connected" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "EVM wallet: connected" })).toBeInTheDocument();
  });
});

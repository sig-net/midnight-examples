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

/** The deposit-address step's card, by the same accessible-name scheme. */
function depositStep(): HTMLElement {
  return screen.getByRole("group", { name: /Step 2: Derive the deposit address/ });
}

describe("the step sequence", () => {
  it("lists all three steps, with the interact step flagged as not built yet", () => {
    render(<App />);

    expect(screen.getByRole("group", { name: /Step 1: Connect wallets/ })).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: /Step 2: Derive the deposit address/ }),
    ).toBeInTheDocument();
    const interact = screen.getByRole("group", { name: /Step 3: Interact with the vault/ });

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

    // Neither row dead-ends: with no extension each chain's in-app seed
    // wallet is still a way in, so it becomes the row's control.
    expect(
      within(connectStep()).getByRole("button", { name: /Use a seed wallet \(Midnight\)/ }),
    ).toBeInTheDocument();
    expect(
      within(connectStep()).getByRole("button", { name: /Use a seed wallet \(EVM\)/ }),
    ).toBeInTheDocument();
  });

  it("with one wallet connected, still asks for two", async () => {
    const user = userEvent.setup();
    injectMidnightWallet({ name: "Test Lace" });
    render(<App />);

    await user.click(
      await within(connectStep()).findByRole("button", { name: /Connect Test Lace/ }),
    );

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

    await user.click(
      await within(connectStep()).findByRole("button", { name: /Connect Test Lace/ }),
    );
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
    expect(screen.getByRole("button", { name: "Midnight wallet: connected" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "EVM wallet: connected" })).toBeInTheDocument();
  });
});

describe("the deposit address step", () => {
  /** Connect the fake Midnight wallet through the connect step's own button. */
  async function connectMidnight(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(
      await within(connectStep()).findByRole("button", { name: /Connect Test Lace/ }),
    );
  }

  /** Put the deposit step's details in the view area by selecting its card. */
  async function openDepositView(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    await user.click(screen.getByRole("button", { name: "Derive the deposit address" }));
    return screen.getByRole("region", { name: "Derive the deposit address details" });
  }

  it("waits as pending until the Midnight wallet is connected", () => {
    render(<App />);

    expect(depositStep()).toHaveAccessibleName(/\(pending\)/);
    expect(
      within(depositStep()).getByText("Connect the Midnight wallet first."),
    ).toBeInTheDocument();
    // With nothing connected, the view area belongs to the connect step.
    expect(screen.getByRole("region", { name: "Connect wallets details" })).toBeInTheDocument();
  });

  it("offers to generate a secret key once the wallet is in and its view is opened", async () => {
    const user = userEvent.setup();
    injectMidnightWallet({ name: "Test Lace" });
    render(<App />);

    await connectMidnight(user);
    const view = await openDepositView(user);

    expect(
      await within(view).findByRole("button", { name: "Generate secret key" }),
    ).toBeInTheDocument();
    expect(depositStep()).toHaveAccessibleName(/\(current\)/);
  });

  it("derives, stores and shows the deposit address on generate", async () => {
    const user = userEvent.setup();
    injectMidnightWallet({ name: "Test Lace" });
    render(<App />);

    await connectMidnight(user);
    const view = await openDepositView(user);
    await user.click(await within(view).findByRole("button", { name: "Generate secret key" }));

    // A real derived EVM address: the identity really went through the
    // commitment circuit and the epsilon derivation, not a placeholder.
    expect(await within(view).findByText(/^0x[0-9a-fA-F]{40}$/)).toBeInTheDocument();
    expect(
      within(view).getByText(/Generated from your wallet's signature this session/),
    ).toBeInTheDocument();
    expect(
      within(view).getByRole("button", { name: "Proceed to the vault interactions" }),
    ).toBeInTheDocument();
    // The card keeps a compact summary: status ring plus the shortened address.
    expect(depositStep()).toHaveAccessibleName(/\(complete\)/);
    expect(
      within(depositStep()).getByText(/^0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/),
    ).toBeInTheDocument();
  });

  it("proceed hands the view area to the interact step", async () => {
    const user = userEvent.setup();
    injectMidnightWallet({ name: "Test Lace" });
    render(<App />);

    await connectMidnight(user);
    const view = await openDepositView(user);
    await user.click(await within(view).findByRole("button", { name: "Generate secret key" }));
    await user.click(
      await within(view).findByRole("button", { name: "Proceed to the vault interactions" }),
    );

    expect(
      screen.getByRole("region", { name: "Interact with the vault details" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Vault address balances" })).toBeInTheDocument();
  });

  it("finds the stored key on a fresh mount: proceeding needs no regenerate, which stays tick-box gated", async () => {
    const user = userEvent.setup();
    injectMidnightWallet({ name: "Test Lace" });
    const firstMount = render(<App />);

    await connectMidnight(user);
    let view = await openDepositView(user);
    await user.click(await within(view).findByRole("button", { name: "Generate secret key" }));
    await within(view).findByText(/Generated from your wallet's signature this session/);
    firstMount.unmount();

    // A fresh app over the same browser storage: the identity is found, the
    // address derives, and that is already enough to move on.
    render(<App />);
    await connectMidnight(user);
    view = await openDepositView(user);
    expect(await within(view).findByText("Found in this browser.")).toBeInTheDocument();
    expect(within(view).getByText(/^0x[0-9a-fA-F]{40}$/)).toBeInTheDocument();
    expect(
      within(view).getByRole("button", { name: "Proceed to the vault interactions" }),
    ).toBeInTheDocument();
    expect(depositStep()).toHaveAccessibleName(/\(complete\)/);

    // Regenerate is offered but held behind the loss acknowledgement.
    const regenerate = within(view).getByRole("button", { name: "Regenerate secret key" });
    expect(regenerate).toBeDisabled();
    await user.click(
      within(view).getByRole("checkbox", {
        name: /I understand the current secret key will be lost/,
      }),
    );
    expect(regenerate).toBeEnabled();
  });

  it("regenerate replaces the key: with a non-deterministic signer the address changes", async () => {
    const user = userEvent.setup();
    // Every signature differs, so the regenerated secret cannot equal the
    // stored one: the loss the tick box warns about, made visible.
    injectMidnightWallet({
      name: "Test Lace",
      signDataSignature: (data, callIndex) => `sig:${callIndex}:${data}`,
    });
    const firstMount = render(<App />);

    await connectMidnight(user);
    let view = await openDepositView(user);
    await user.click(await within(view).findByRole("button", { name: "Generate secret key" }));
    const firstAddress = (await within(view).findByText(/^0x[0-9a-fA-F]{40}$/)).textContent;
    firstMount.unmount();

    render(<App />);
    await connectMidnight(user);
    view = await openDepositView(user);
    await within(view).findByText("Found in this browser.");
    await user.click(
      within(view).getByRole("checkbox", {
        name: /I understand the current secret key will be lost/,
      }),
    );
    await user.click(within(view).getByRole("button", { name: "Regenerate secret key" }));

    await within(view).findByText(/Generated from your wallet's signature this session/);
    const secondAddress = within(view).getByText(/^0x[0-9a-fA-F]{40}$/).textContent;
    expect(secondAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(secondAddress).not.toBe(firstAddress);
  });
});

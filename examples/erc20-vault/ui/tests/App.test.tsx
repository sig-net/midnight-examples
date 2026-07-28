import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "../src/App";
import { RoutePath } from "../src/routes";

/** A path the app is rendered at, and the `h1` that path must produce. */
interface RouteCase {
  readonly description: string;
  readonly path: string;
  readonly heading: string;
}

// The overview's heading is the flow's current prompt rather than a fixed
// title, so it names the state the app is in. Under jsdom no wallet extension
// is injected, which is the "nothing connected yet" case.
const ROUTE_CASES: readonly RouteCase[] = [
  {
    description: "the overview",
    path: RoutePath.Home,
    heading: "To start you'll need 2 connected wallets",
  },
  { description: "the not-found view", path: "/no-such-path", heading: "Page not found" },
];

describe("App", () => {
  it.each(ROUTE_CASES)("renders $description at $path", ({ path, heading }) => {
    window.history.pushState({}, "", path);

    render(<App />);

    expect(screen.getByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
  });

  it("navigates back to the overview from the not-found view", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/no-such-path");
    render(<App />);

    await user.click(screen.getByRole("link", { name: "Back to overview" }));

    expect(
      screen.getByRole("heading", { level: 1, name: "To start you'll need 2 connected wallets" }),
    ).toBeInTheDocument();
  });
});

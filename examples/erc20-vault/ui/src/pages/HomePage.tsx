import type { JSX } from "react";

/** One thing the vault UI is being built to do, as shown on the overview. */
interface Capability {
  readonly title: string;
  readonly detail: string;
}

const CAPABILITIES: readonly Capability[] = [
  {
    title: "Connect a wallet",
    detail: "Pair with a Midnight wallet and surface the connected shielded address.",
  },
  {
    title: "Read vault state",
    detail: "Query the deployed vault's ledger for balances, requests and settled claims.",
  },
  {
    title: "Deposit and withdraw",
    detail: "Drive the vault's circuits, then follow each MPC request through to settlement.",
  },
];

/**
 * The overview route: what this example is, and what the UI grows into.
 *
 * @returns The landing view rendered at the root path.
 */
export const HomePage = (): JSX.Element => (
  <section className="flex flex-col gap-8">
    <div className="flex flex-col gap-3">
      <h1 className="text-3xl font-semibold tracking-tight">ERC20 vault</h1>
      <p className="max-w-prose text-ink-muted">
        A single-page app over the erc20-vault Compact contract. The shell, routing and styling are
        in place: chain wiring is what goes in next.
      </p>
    </div>

    <ul className="grid gap-4 sm:grid-cols-3">
      {CAPABILITIES.map((capability) => (
        <li
          key={capability.title}
          className="rounded-lg border border-border-subtle bg-surface-raised p-4"
        >
          <h2 className="font-medium">{capability.title}</h2>
          <p className="mt-1 text-sm text-ink-muted">{capability.detail}</p>
        </li>
      ))}
    </ul>
  </section>
);

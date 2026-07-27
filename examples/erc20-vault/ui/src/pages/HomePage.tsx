import type { JSX } from "react";

import { useMidnightChainConfig } from "../components/contexts";

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

/** One endpoint row in the connection panel: its label and resolved value. */
interface EndpointRow {
  readonly label: string;
  readonly value: string;
}

/**
 * The overview route: what this example is, what the UI grows into, and the
 * chain endpoints it has resolved.
 *
 * @returns The landing view rendered at the root path.
 */
export const HomePage = (): JSX.Element => {
  const { config } = useMidnightChainConfig();

  const endpointRows: readonly EndpointRow[] = [
    { label: "Indexer", value: config.indexerUrl },
    { label: "Indexer (WS)", value: config.indexerWsUrl },
    { label: "Node", value: config.nodeUrl },
    { label: "Proof server", value: config.proofServerUrl },
  ];

  return (
    <section className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">ERC20 vault</h1>
        <p className="max-w-prose text-ink-muted">
          A single-page app over the erc20-vault Compact contract. The shell, routing and styling
          are in place: chain wiring is what goes in next.
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

      <div className="flex flex-col gap-3">
        <h2 className="font-medium">
          Connection <span className="text-ink-muted">({config.networkId})</span>
        </h2>
        <dl className="overflow-x-auto rounded-lg border border-border-subtle bg-surface-raised">
          {endpointRows.map((row) => (
            <div
              key={row.label}
              className="flex gap-4 border-b border-border-subtle px-4 py-2 text-sm last:border-b-0"
            >
              <dt className="w-28 shrink-0 text-ink-muted">{row.label}</dt>
              <dd className="font-mono">{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
};

import type { JSX } from "react";

import { ConnectWalletsStep } from "../components/ConnectWalletsStep";
import { ComingSoon, StepCard, type StepStatus } from "../components/StepCard";
import { useWalletConnections } from "../hooks/useWalletConnections";

/**
 * The overview route: the vault flow, as the sequence of steps a user works
 * through.
 *
 * There is no separate introduction above it. The steps say what the app does
 * better than a paragraph about them would, and the first one is immediately
 * actionable, which a paragraph never is.
 *
 * @returns The landing view rendered at the root path.
 */
export const HomePage = (): JSX.Element => {
  const { connections, connectedCount, requiredCount, allConnected } = useWalletConnections();

  // Steps two and three are signposts until they are built. They stay `pending`
  // rather than becoming `current` when the wallets are in, since nothing here
  // would let the user act on them yet.
  const connectStatus: StepStatus = allConnected ? "complete" : "current";

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">
        {allConnected
          ? "Wallet connections set"
          : `To start you'll need ${requiredCount} connected wallets`}
      </h1>

      <ol className="grid list-none gap-4 sm:grid-cols-3">
        <li>
          <StepCard
            stepNumber={1}
            title="Connect wallets"
            status={connectStatus}
            badge={allConnected ? undefined : `${connectedCount}/${requiredCount}`}
          >
            <ConnectWalletsStep connections={connections} />
          </StepCard>
        </li>

        <li>
          <StepCard stepNumber={2} title="Balance checks" status="pending">
            <ComingSoon>
              Read the vault's ledger and each wallet's balance on both chains.
            </ComingSoon>
          </StepCard>
        </li>

        <li>
          <StepCard stepNumber={3} title="Interact with the vault" status="pending">
            <ComingSoon>
              Deposit and withdraw, following each MPC request to settlement.
            </ComingSoon>
          </StepCard>
        </li>
      </ol>
    </section>
  );
};

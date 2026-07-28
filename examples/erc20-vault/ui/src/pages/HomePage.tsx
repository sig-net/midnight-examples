import { WalletIcon } from "lucide-react";
import { useState, type JSX } from "react";

import { ConnectWalletsStep } from "../components/ConnectWalletsStep";
import { DepositAddressSummary, DepositAddressView } from "../components/DepositAddressStep";
import { InteractWithVaultView } from "../components/InteractWithVaultStep";
import { ComingSoon, StepCard, type StepStatus } from "../components/StepCard";
import { Card, CardContent } from "../components/ui/card";
import { useDepositAddress } from "../hooks/useDepositAddress";
import { useWalletConnections } from "../hooks/useWalletConnections";

/** The vault flow's steps, in the order the cards present them. */
enum VaultStep {
  ConnectWallets = 1,
  DeriveDepositAddress = 2,
  InteractWithVault = 3,
}

/** The step titles, shared by each card and the view area's heading. */
const STEP_TITLES: Record<VaultStep, string> = {
  [VaultStep.ConnectWallets]: "Connect wallets",
  [VaultStep.DeriveDepositAddress]: "Derive the deposit address",
  [VaultStep.InteractWithVault]: "Interact with the vault",
};

/** Props of {@link ConnectWalletsView}. */
interface ConnectWalletsViewProps {
  /** True once both wallets are connected. */
  readonly allConnected: boolean;
}

/**
 * The connect step's view-area body. The card itself carries the working
 * controls (one row per chain), so the view states the goal rather than
 * repeating them.
 *
 * @param props - The connection progress.
 * @returns The view's body.
 */
const ConnectWalletsView = ({ allConnected }: ConnectWalletsViewProps): JSX.Element => (
  <div className="flex flex-col items-center gap-3 py-6 text-sm text-muted-foreground">
    <WalletIcon className="size-10" aria-hidden="true" />
    <p>
      {allConnected
        ? "Both wallets are connected: carry on to deriving your deposit address."
        : "Connect both wallets (in the first card) to begin."}
    </p>
  </div>
);

/**
 * The overview route: the vault flow as a row of equal-height step cards over
 * ONE view area, whose contents are the selected step's details.
 *
 * Selection follows the user's progress (the connect step until both wallets
 * are in, then the deposit-address step) until a card is chosen by hand, and
 * the deposit view's "proceed" hands the view area to the interact step.
 *
 * @returns The landing view rendered at the root path.
 */
export const HomePage = (): JSX.Element => {
  const { connections, connectedCount, requiredCount, allConnected } = useWalletConnections();
  const depositAddress = useDepositAddress();

  // null = no explicit choice yet: follow progress.
  const [chosenStep, setChosenStep] = useState<VaultStep | null>(null);
  const activeStep =
    chosenStep ?? (allConnected ? VaultStep.DeriveDepositAddress : VaultStep.ConnectWallets);

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
            stepNumber={VaultStep.ConnectWallets}
            title={STEP_TITLES[VaultStep.ConnectWallets]}
            status={connectStatus}
            badge={allConnected ? undefined : `${connectedCount}/${requiredCount}`}
            selected={activeStep === VaultStep.ConnectWallets}
            onSelect={() => {
              setChosenStep(VaultStep.ConnectWallets);
            }}
          >
            <ConnectWalletsStep connections={connections} />
          </StepCard>
        </li>

        <li>
          <StepCard
            stepNumber={VaultStep.DeriveDepositAddress}
            title={STEP_TITLES[VaultStep.DeriveDepositAddress]}
            status={depositAddress.stepStatus}
            selected={activeStep === VaultStep.DeriveDepositAddress}
            onSelect={() => {
              setChosenStep(VaultStep.DeriveDepositAddress);
            }}
          >
            <DepositAddressSummary
              status={depositAddress.status}
              identity={depositAddress.identity}
            />
          </StepCard>
        </li>

        <li>
          <StepCard
            stepNumber={VaultStep.InteractWithVault}
            title={STEP_TITLES[VaultStep.InteractWithVault]}
            status="pending"
            selected={activeStep === VaultStep.InteractWithVault}
            onSelect={() => {
              setChosenStep(VaultStep.InteractWithVault);
            }}
          >
            <ComingSoon>Deposit and withdraw.</ComingSoon>
          </StepCard>
        </li>
      </ol>

      {/* The ONE view area: the selected step's details, full width. A card
          stays a compact summary at all times, and this is where its whole
          story lives. */}
      <section aria-label={`${STEP_TITLES[activeStep]} details`}>
        <Card>
          <CardContent className="max-w-2xl">
            {activeStep === VaultStep.ConnectWallets && (
              <ConnectWalletsView allConnected={allConnected} />
            )}
            {activeStep === VaultStep.DeriveDepositAddress && (
              <DepositAddressView
                {...depositAddress}
                onProceed={() => {
                  setChosenStep(VaultStep.InteractWithVault);
                }}
              />
            )}
            {activeStep === VaultStep.InteractWithVault && <InteractWithVaultView />}
          </CardContent>
        </Card>
      </section>
    </section>
  );
};

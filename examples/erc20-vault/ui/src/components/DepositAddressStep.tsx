import {
  CheckCircle2Icon,
  CircleDashedIcon,
  CopyIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { useState, type JSX } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

import {
  CallerIdentityStatus,
  IDENTITY_SIGNING_MESSAGE,
  type CallerIdentity,
} from "./contexts";
import type { DepositAddress } from "../hooks/useDepositAddress";
import { shortenAddress } from "../lib/shortenAddress";

/** Props of {@link DepositAddressSummary}. */
export interface DepositAddressSummaryProps {
  /** How far the caller's identity has got. */
  readonly status: CallerIdentityStatus;
  /** The identity, when {@link DepositAddressSummaryProps.status} is `Present`. */
  readonly identity: CallerIdentity | null;
}

/**
 * The step's CARD body: one line saying where the identity stands, with the
 * full story (and every control) living in the view area's
 * {@link DepositAddressView}.
 *
 * @param props - The identity's progress.
 * @returns The one-line summary.
 */
export const DepositAddressSummary = ({
  status,
  identity,
}: DepositAddressSummaryProps): JSX.Element => {
  if (status === CallerIdentityStatus.Present && identity !== null) {
    return identity.depositEvmAddress === null ? (
      <p className="text-sm text-destructive">Key ready, address not derivable.</p>
    ) : (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Deposit address</span>
        <code className="font-mono text-xs">{shortenAddress(identity.depositEvmAddress)}</code>
      </div>
    );
  }

  const summaryOfStatus: Record<CallerIdentityStatus, string> = {
    [CallerIdentityStatus.NoWallet]: "Connect the Midnight wallet first.",
    [CallerIdentityStatus.NotDeployed]: "Not deployed on this network.",
    [CallerIdentityStatus.Loading]: "Reading the stored identity…",
    [CallerIdentityStatus.Error]: "Could not read the stored identity.",
    [CallerIdentityStatus.Absent]: "Generate your secret key below.",
    [CallerIdentityStatus.Present]: "Identity ready.",
  };
  return (
    <p
      className={`text-sm ${
        status === CallerIdentityStatus.Error ? "text-destructive" : "text-muted-foreground"
      }`}
    >
      {summaryOfStatus[status]}
    </p>
  );
};

/** Props of {@link RegenerateControl}. */
interface RegenerateControlProps {
  readonly regenerating: boolean;
  readonly onRegenerate: () => void;
}

/**
 * The destructive re-derivation control: a tick box acknowledging the loss of
 * the stored key, gating the regenerate button.
 *
 * Losing the key matters: any unclaimed deposit or pending refund is bound to
 * its commitment, and unless the wallet signs deterministically a new
 * signature derives a DIFFERENT key. The button stays disabled until the user
 * has said they understand exactly that.
 *
 * @param props - The in-flight flag and the action.
 * @returns The control.
 */
const RegenerateControl = ({ regenerating, onRegenerate }: RegenerateControlProps): JSX.Element => {
  const [lossUnderstood, setLossUnderstood] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-start gap-2 text-muted-foreground">
        <Checkbox
          checked={lossUnderstood}
          onCheckedChange={(state) => {
            setLossUnderstood(state === true);
          }}
          aria-label="I understand the current secret key will be lost"
          className="mt-0.5"
        />
        <span>
          I understand the current secret key will be lost, along with access to any unclaimed
          deposits or pending refunds tied to it.
        </span>
      </label>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={onRegenerate}
        disabled={!lossUnderstood || regenerating}
      >
        {regenerating ? (
          <>
            <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
            Waiting for the wallet…
          </>
        ) : (
          "Regenerate secret key"
        )}
      </Button>
    </div>
  );
};

/** Props of {@link DepositAddressRows}. */
interface DepositAddressRowsProps {
  readonly identity: CallerIdentity;
  readonly fresh: boolean;
  readonly regenerating: boolean;
  readonly onRegenerate: () => void;
  readonly onCopyAddress: () => void;
  readonly onProceed: () => void;
}

/**
 * The step's body once an identity is in hand: the derived address, where the
 * key came from, the way forward, and (for a key merely found in storage) the
 * confirmed-destructive regenerate control.
 *
 * @param props - The identity and the step's actions.
 * @returns The rows.
 */
const DepositAddressRows = ({
  identity,
  fresh,
  regenerating,
  onRegenerate,
  onCopyAddress,
  onProceed,
}: DepositAddressRowsProps): JSX.Element => (
  <>
    {identity.depositEvmAddress === null ? (
      <p className="text-destructive">
        The secret key is in hand, but VITE_MPC_SECP256K1_PUBKEY is not set, so the deposit
        address cannot be derived. Set it to the MPC network's root public key and reload.
      </p>
    ) : (
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground">Your EVM deposit address</span>
        <div className="flex items-center gap-1">
          <code className="min-w-0 break-all font-mono text-xs">{identity.depositEvmAddress}</code>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label="Copy deposit address"
            onClick={onCopyAddress}
          >
            <CopyIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
    )}

    {fresh ? (
      <span className="flex items-center gap-2">
        <CheckCircle2Icon className="size-4 shrink-0 text-emerald-500" aria-hidden="true" />
        Generated from your wallet's signature this session.
      </span>
    ) : (
      <span className="flex items-center gap-2 text-muted-foreground">
        <CheckCircle2Icon className="size-4 shrink-0" aria-hidden="true" />
        Found in this browser.
      </span>
    )}

    {identity.depositEvmAddress !== null && (
      <Button size="sm" className="self-start" onClick={onProceed}>
        Proceed to the vault interactions
      </Button>
    )}

    {!fresh && <RegenerateControl regenerating={regenerating} onRegenerate={onRegenerate} />}
  </>
);

/** Props of {@link DepositAddressView}: the step model plus navigation. */
export interface DepositAddressViewProps extends DepositAddress {
  /** Take the user on to the vault-interactions step. */
  readonly onProceed: () => void;
}

/**
 * The deposit-address step's VIEW-AREA body (its card shows only
 * {@link DepositAddressSummary}).
 *
 * Deposits move ERC20 value from an EVM account only the MPC network can sign
 * for, so the step's whole job is deriving that account's address for THIS
 * caller: obtain the identity secret (a wallet signature, hashed), commit to
 * it, and derive. A found key with a derived address is already enough to
 * proceed; regenerating is offered for a found key, but as a confirmed
 * destructive action, never a requirement.
 *
 * @param props - The step, as {@link useDepositAddress} builds it.
 * @returns The view's body.
 */
export const DepositAddressView = ({
  status,
  identity,
  fresh,
  error,
  generating,
  regenerating,
  generate,
  regenerate,
  copyAddress,
  onProceed,
}: DepositAddressViewProps): JSX.Element => (
  <div className="flex flex-col gap-3 text-sm">
    <p className="text-muted-foreground">
      Each deposit is an ERC20 transfer signed by the MPC network from your own derived EVM
      account: its address comes from the MPC root key, the vault contract's address, and
      your identity commitment.
    </p>

    {status === CallerIdentityStatus.NoWallet && (
      <span className="flex items-center gap-2 text-muted-foreground">
        <CircleDashedIcon className="size-4 shrink-0" aria-hidden="true" />
        Connect the Midnight wallet first.
      </span>
    )}

    {status === CallerIdentityStatus.NotDeployed && (
      <span className="flex items-center gap-2 text-muted-foreground">
        <CircleDashedIcon className="size-4 shrink-0" aria-hidden="true" />
        The vault is not deployed on this network.
      </span>
    )}

    {status === CallerIdentityStatus.Loading && (
      <span className="flex items-center gap-2 text-muted-foreground">
        <LoaderCircleIcon className="size-4 shrink-0 animate-spin" aria-hidden="true" />
        Reading the stored identity…
      </span>
    )}

    {status === CallerIdentityStatus.Error && <p className="text-destructive">{error}</p>}

    {status === CallerIdentityStatus.Absent && (
      <>
        <p className="text-muted-foreground">
          Deriving needs your secret key. Your wallet will be asked to sign
          {" “"}
          {IDENTITY_SIGNING_MESSAGE}
          {"” "}
          and the key is the hash of that signature.
        </p>
        <Button size="sm" className="self-start" onClick={generate} disabled={generating}>
          {generating ? (
            <>
              <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
              Waiting for the wallet…
            </>
          ) : (
            "Generate secret key"
          )}
        </Button>
      </>
    )}

    {status === CallerIdentityStatus.Present && identity !== null && (
      <DepositAddressRows
        identity={identity}
        fresh={fresh}
        regenerating={regenerating}
        onRegenerate={regenerate}
        onCopyAddress={copyAddress}
        onProceed={onProceed}
      />
    )}
  </div>
);

import { useCallback, useMemo } from "react";
import { toast } from "sonner";

import {
  CallerIdentityStatus,
  useERC20Vault,
  type CallerIdentity,
} from "../components/contexts";
import type { StepStatus } from "../components/StepCard";
import { describeError } from "../lib/errorMessage";

/**
 * The deposit-address step, in the shape its card renders: the identity's
 * progress, the actions the step offers, and how far along the card should
 * report itself.
 */
export interface DepositAddress {
  /** How far the caller's identity has got. */
  readonly status: CallerIdentityStatus;
  /** The identity, when {@link DepositAddress.status} is `Present`. */
  readonly identity: CallerIdentity | null;
  /** True when the identity came from a wallet signature this session. */
  readonly fresh: boolean;
  /** Why {@link DepositAddress.status} is `Error`, when it is. */
  readonly error: string | null;
  /** True while the generate signing prompt is outstanding. */
  readonly generating: boolean;
  /** True while the regenerate signing prompt is outstanding. */
  readonly regenerating: boolean;
  /** Derive and store a fresh secret, reporting a failure on a toast. */
  readonly generate: () => void;
  /**
   * OVERWRITE the stored secret with a newly signed one, reporting the
   * outcome on a toast. Destructive: the caller must have collected the
   * user's explicit confirmation first.
   */
  readonly regenerate: () => void;
  /** Put the derived deposit address on the clipboard. */
  readonly copyAddress: () => void;
  /** The step's card state: complete once an identity is in hand. */
  readonly stepStatus: StepStatus;
}

/**
 * The deposit-address step's logic over the vault context: toasts on the
 * outcomes, and the card-level status roll-up.
 *
 * @returns The step, ready to render.
 */
export function useDepositAddress(): DepositAddress {
  const {
    identityStatus,
    identity,
    identityFresh,
    identityError,
    generateIdentity,
    generating,
    regenerateIdentity,
    regenerating,
  } = useERC20Vault();

  const generate = useCallback((): void => {
    generateIdentity().catch((error: unknown) => {
      toast.error("Could not generate the secret key", {
        description: describeError(error),
      });
    });
  }, [generateIdentity]);

  const regenerate = useCallback((): void => {
    regenerateIdentity()
      .then(() => {
        toast.success("Secret key regenerated", {
          description: "The previous key is gone. The deposit address now shown is the one to fund.",
        });
      })
      .catch((error: unknown) => {
        toast.error("Could not regenerate the secret key", {
          description: describeError(error),
        });
      });
  }, [regenerateIdentity]);

  const copyAddress = useCallback((): void => {
    const address = identity?.depositEvmAddress;
    if (address === null || address === undefined) {
      return;
    }
    navigator.clipboard.writeText(address).then(
      () => toast.success("Deposit address copied"),
      (error: unknown) => {
        toast.error("Could not copy the deposit address", {
          description: describeError(error),
        });
      },
    );
  }, [identity]);

  // Complete the moment an identity is in hand: the body still distinguishes
  // wallet-fresh from merely found. Blocked states (no wallet, no deployment)
  // are pending; everything in between is the user's current step.
  const stepStatus: StepStatus =
    identityStatus === CallerIdentityStatus.Present
      ? "complete"
      : identityStatus === CallerIdentityStatus.NoWallet ||
          identityStatus === CallerIdentityStatus.NotDeployed
        ? "pending"
        : "current";

  return useMemo<DepositAddress>(
    () => ({
      status: identityStatus,
      identity,
      fresh: identityFresh,
      error: identityError,
      generating,
      regenerating,
      generate,
      regenerate,
      copyAddress,
      stepStatus,
    }),
    [
      identityStatus,
      identity,
      identityFresh,
      identityError,
      generating,
      regenerating,
      generate,
      regenerate,
      copyAddress,
      stepStatus,
    ],
  );
}

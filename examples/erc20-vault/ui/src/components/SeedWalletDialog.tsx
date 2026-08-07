import { useState, type JSX, type SubmitEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** Props of {@link SeedWalletDialog}. */
export interface SeedWalletDialogProps {
  /** Whether the dialog is shown; the opener owns this state. */
  readonly open: boolean;
  /** Called with the new open state (closing on escape / overlay / cancel). */
  readonly onOpenChange: (open: boolean) => void;
  /**
   * Install the pasted seed. The dialog closes on submit; a failed install is
   * the caller's to surface (the connection hooks put it on a toast).
   */
  readonly onInstall: (seed: string) => void;
}

/**
 * The seed entry for installing one chain's in-app wallet: one field, one
 * submit. Presentational; validation happens in the wallet the seed is handed
 * to, and a rejection comes back on a toast rather than inline, matching how
 * a refused extension connect is surfaced.
 *
 * The field clears whenever the dialog closes, so a seed never lingers in the
 * DOM of a closed dialog.
 *
 * @param props - The open state and the install to run on submit.
 * @returns The dialog.
 */
export const SeedWalletDialog = ({
  open,
  onOpenChange,
  onInstall,
}: SeedWalletDialogProps): JSX.Element => {
  const [seed, setSeed] = useState("");

  const close = (nextOpen: boolean): void => {
    if (!nextOpen) {
      setSeed("");
    }
    onOpenChange(nextOpen);
  };

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = seed.trim();
    if (trimmed === "") {
      return;
    }
    onInstall(trimmed);
    close(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>Use a seed wallet</DialogTitle>
            <DialogDescription>
              Runs a wallet in this page from a hex seed (16&ndash;64 bytes, 0x optional). The keys
              stay in memory for this tab only and signing never prompts: meant for development
              against a local stack.
            </DialogDescription>
          </DialogHeader>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Seed
            <Input
              value={seed}
              onChange={(event) => {
                setSeed(event.target.value);
              }}
              placeholder="0x…"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </label>
          <DialogFooter>
            <Button type="submit" disabled={seed.trim() === ""}>
              Install seed wallet
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

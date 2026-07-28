import { WalletIcon } from "lucide-react";
import type { JSX } from "react";

/** Props of {@link WalletMark}. */
export interface WalletMarkProps {
  /** The wallet's own icon, as a URL or data URL, or undefined for the fallback. */
  readonly iconUrl: string | undefined;
  /** Wash it out, for a wallet that is offered rather than connected. */
  readonly muted?: boolean;
}

/**
 * A wallet's own icon, falling back to a generic one when it published none.
 *
 * Rendered as an `img` source and NEVER as markup: both connector APIs hand out
 * an icon the EXTENSION controls, and the Midnight one documents the XSS risk in
 * as many words. An `img` cannot execute what it is pointed at.
 *
 * Decorative everywhere it appears, so its `alt` is empty by design: the wallet
 * name is always right beside it, either as text or as the button's own
 * accessible name, and a second announcement of it would only be noise.
 *
 * @param props - The icon to show, and whether to wash it out.
 * @returns The mark, sized to sit inside a button or a row.
 */
export const WalletMark = ({ iconUrl, muted = false }: WalletMarkProps): JSX.Element => {
  if (iconUrl === undefined) {
    return <WalletIcon className={muted ? "opacity-60" : undefined} aria-hidden="true" />;
  }
  return (
    <img
      src={iconUrl}
      alt=""
      aria-hidden="true"
      className={`size-4 shrink-0 rounded-sm ${muted ? "opacity-60 grayscale" : ""}`}
    />
  );
};

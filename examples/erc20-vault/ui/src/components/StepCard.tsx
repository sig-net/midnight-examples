import { CheckCircle2Icon, CircleDashedIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * How far along one step is.
 *
 * `pending` covers both "not your turn yet" and "not built yet": from the
 * user's side those look the same, and the step says which in its own body.
 */
export type StepStatus = "complete" | "current" | "pending";

/** Props of {@link StepCard}. */
export interface StepCardProps {
  /** Where this step sits in the sequence, shown when it is not yet complete. */
  readonly stepNumber: number;
  /** What the step is, as an imperative: "Connect wallets". */
  readonly title: string;
  /** How far along it is. */
  readonly status: StepStatus;
  /** A short flag beside the title, for a step that is not built yet. */
  readonly badge?: string;
  /** The step's own content. */
  readonly children: ReactNode;
}

/**
 * One step of the vault flow, as a card.
 *
 * The three cards read left to right as the sequence the user works through, so
 * every one of them carries its number and its state in the same place. A
 * complete step swaps its number for a green tick and takes a green border: at
 * a glance, the run of green is how far you have got.
 *
 * @param props - The step's position, title, state and content.
 * @returns The card.
 */
export const StepCard = ({
  stepNumber,
  title,
  status,
  badge,
  children,
}: StepCardProps): JSX.Element => {
  const complete = status === "complete";

  return (
    <Card
      // A labelled group, so the step is one findable thing to a screen reader
      // and to a test, rather than a div that happens to contain a heading.
      role="group"
      aria-label={`Step ${stepNumber}: ${title} (${status})`}
      // The outline is the progress bar. Card draws its edge with `ring`, not
      // `border`, so the green goes on the ring or it does not show at all.
      // Only a complete step goes green: a half-done one reads as not done,
      // which is what it is.
      className={`gap-3 ${complete ? "ring-2 ring-emerald-500/60" : ""} ${
        status === "pending" ? "opacity-70" : ""
      }`}
    >
      <CardHeader className="gap-0">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          {complete ? (
            <CheckCircle2Icon className="size-4 shrink-0 text-emerald-500" aria-hidden="true" />
          ) : (
            <span
              aria-hidden="true"
              className="flex size-4 shrink-0 items-center justify-center rounded-full border border-current text-[0.625rem] text-muted-foreground"
            >
              {stepNumber}
            </span>
          )}
          <span className="min-w-0 truncate">{title}</span>
          {badge === undefined ? null : (
            <Badge variant="secondary" className="ml-auto shrink-0 text-xs font-normal">
              {badge}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
};

/** Props of {@link ComingSoon}. */
export interface ComingSoonProps {
  /** What this step will do once it exists. */
  readonly children: ReactNode;
}

/**
 * The body of a step that is not built yet.
 *
 * Carries its own "Coming soon" line rather than taking a badge in the title:
 * a card in a three-column grid is narrow, and a badge beside the title either
 * truncates the title or gets clipped itself. Below it, what the step WILL do,
 * so the card signposts the flow rather than sitting empty.
 *
 * @param props - The description of the step to come.
 * @returns The muted body.
 */
export const ComingSoon = ({ children }: ComingSoonProps): JSX.Element => (
  <div className="flex flex-col gap-1 text-sm text-muted-foreground">
    <span className="flex items-center gap-2">
      <CircleDashedIcon className="size-4 shrink-0" aria-hidden="true" />
      Coming soon
    </span>
    <span>{children}</span>
  </div>
);

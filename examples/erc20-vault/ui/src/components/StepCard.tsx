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
  /**
   * True when this step's details fill the view area below the cards. Only
   * meaningful alongside {@link StepCardProps.onSelect}.
   */
  readonly selected?: boolean;
  /** Put this step's details in the view area. Makes the card selectable. */
  readonly onSelect?: () => void;
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
 * @param props.stepNumber - The step's place in the sequence, drawn as the
 *   marker until the step completes.
 * @param props.title - What the step is, shown beside the marker.
 * @param props.status - How far along it is: complete swaps the number for a
 *   green tick and takes the green ring.
 * @param props.badge - A short flag beside the title, when there is one.
 * @param props.selected - True while this step's details fill the view area,
 *   taking the ring in the theme's ring colour.
 * @param props.onSelect - Put this step's details in the view area, making the
 *   card selectable.
 * @param props.children - The step's own card body.
 * @returns The card.
 */
export const StepCard = ({
  stepNumber,
  title,
  status,
  badge,
  selected = false,
  onSelect,
  children,
}: StepCardProps): JSX.Element => {
  const complete = status === "complete";

  // The number-or-tick marker plus the title: the card's whole identity, and
  // (when the card is selectable) exactly what the select button wraps.
  const heading = (
    <>
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
    </>
  );

  return (
    <Card
      // A labelled group, so the step is one findable thing to a screen reader
      // and to a test, rather than a div that happens to contain a heading.
      role="group"
      aria-label={`Step ${String(stepNumber)}: ${title} (${status})`}
      // Card-level click is a convenience enlargement of the title button's
      // target for mouse users; keyboard and assistive access go through the
      // button itself. Clicks on inner controls bubble here too, which is
      // wanted: acting inside a step is reason enough to show its details.
      onClick={onSelect}
      // The outline is the progress bar, and selection borrows it: the
      // selected card takes the ring in the theme's ring colour, a complete
      // unselected one keeps the green, and Card draws its edge with `ring`,
      // not `border`, so anything else would not show at all.
      // h-full: the cards sit in one grid row, whose items stretch, so filling
      // the row is what makes every card the height of the tallest.
      className={`h-full gap-3 ${
        selected ? "ring-2 ring-ring/70" : complete ? "ring-2 ring-emerald-500/60" : ""
      } ${status === "pending" ? "opacity-70" : ""} ${onSelect ? "cursor-pointer" : ""}`}
    >
      <CardHeader className="gap-0">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          {onSelect === undefined ? (
            heading
          ) : (
            <button
              type="button"
              aria-pressed={selected}
              onClick={onSelect}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {heading}
            </button>
          )}
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
 * @param props.children - What the step will do once it exists.
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

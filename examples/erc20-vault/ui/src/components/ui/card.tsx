import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The card surface the other Card parts render inside.
 *
 * @param props - The underlying div element's props, passed through.
 * @param props.className - Extra classes merged after the card's own.
 * @param props.size - The spacing preset, tighter when "sm".
 * @returns The styled card container element.
 */
function Card({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm" }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl bg-card py-(--card-spacing) text-sm text-card-foreground ring-1 ring-foreground/10 [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The card's top row, a grid that seats the title, description and action.
 *
 * @param props - The underlying div element's props, passed through.
 * @param props.className - Extra classes merged after the header's own.
 * @returns The styled card header element.
 */
function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The card's heading text, sized down inside a small card.
 *
 * @param props - The underlying div element's props, passed through.
 * @param props.className - Extra classes merged after the title's own.
 * @returns The styled card title element.
 */
function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The muted supporting text under a card's title.
 *
 * @param props - The underlying div element's props, passed through.
 * @param props.className - Extra classes merged after the description's own.
 * @returns The styled card description element.
 */
function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

/**
 * The header's trailing slot, pinned to the card's top-right corner.
 *
 * @param props - The underlying div element's props, passed through.
 * @param props.className - Extra classes merged after the action slot's own.
 * @returns The styled card action element.
 */
function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
      {...props}
    />
  );
}

/**
 * The card's body, indented to the card's shared horizontal padding.
 *
 * @param props - The underlying div element's props, passed through.
 * @param props.className - Extra classes merged after the content's own.
 * @returns The styled card content element.
 */
function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-content" className={cn("px-(--card-spacing)", className)} {...props} />
  );
}

/**
 * The card's bottom strip, set off by a top border and a muted background.
 *
 * @param props - The underlying div element's props, passed through.
 * @param props.className - Extra classes merged after the footer's own.
 * @returns The styled card footer element.
 */
function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-xl border-t bg-muted/50 p-(--card-spacing)",
        className,
      )}
      {...props}
    />
  );
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };

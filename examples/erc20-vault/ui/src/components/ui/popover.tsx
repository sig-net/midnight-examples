import { Popover as PopoverPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The popover's stateful root, which the other Popover parts nest inside.
 *
 * @param props - The Radix popover root's own props, passed through.
 * @returns The popover root element.
 */
function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

/**
 * The control that opens the popover.
 *
 * @param props - The Radix popover trigger's own props, passed through.
 * @returns The popover trigger element.
 */
function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

/**
 * The popover panel itself, portalled beside its trigger.
 *
 * @param props - The Radix popover content's own props, passed through.
 * @param props.className - Extra classes merged after the panel's own.
 * @param props.align - The edge of the trigger to line up with, centred by default.
 * @param props.sideOffset - The gap in pixels between trigger and panel.
 * @returns The portalled popover panel element.
 */
function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 flex w-72 origin-(--radix-popover-content-transform-origin) flex-col gap-2.5 rounded-lg bg-popover p-2.5 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

/**
 * An element the popover positions against instead of its trigger.
 *
 * @param props - The Radix popover anchor's own props, passed through.
 * @returns The popover anchor element.
 */
function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

/**
 * The stacked title and description block at the top of a popover.
 *
 * @param props - The underlying div element's props, passed through.
 * @param props.className - Extra classes merged after the header's own.
 * @returns The styled popover header element.
 */
function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-0.5 text-sm", className)}
      {...props}
    />
  );
}

/**
 * The popover's heading text.
 *
 * @param props - The underlying element's props, passed through.
 * @param props.className - Extra classes merged after the title's own.
 * @returns The styled popover title element.
 */
function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <div data-slot="popover-title" className={cn("font-medium", className)} {...props} />;
}

/**
 * The muted supporting text under a popover's title.
 *
 * @param props - The underlying paragraph element's props, passed through.
 * @param props.className - Extra classes merged after the description's own.
 * @returns The styled popover description element.
 */
function PopoverDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
};

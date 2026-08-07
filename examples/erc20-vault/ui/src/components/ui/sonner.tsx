"use client";

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

// Edited away from the registry's version in one place, deliberately: it reads
// the theme from next-themes, and this app has its own ThemeContext. Two theme
// stores would disagree the moment the switcher is touched, and the toast would
// come up light on a dark page. Re-running `shadcn add sonner` overwrites this
// file and reinstates the next-themes import, so re-apply this edit if it does.
import { useTheme } from "../contexts/ThemeContext.tsx";

/**
 * The app's toast outlet, themed from the app's own ThemeContext.
 *
 * @param props - Sonner's Toaster props, passed through over the app's defaults.
 * @returns The configured toaster element.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { resolved } = useTheme();

  return (
    <Sonner
      theme={resolved}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };

import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { useTheme } from "./contexts";
import { THEME_PREFERENCES, type ThemePreference } from "../lib/theme";

/** How each preference is offered in the menu. */
const PREFERENCE_LABELS: Record<ThemePreference, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

/** Props of {@link PreferenceIcon}. */
interface PreferenceIconProps {
  readonly preference: ThemePreference;
}

/**
 * The glyph for one preference.
 *
 * @param props - The preference to draw.
 * @returns Its icon.
 */
const PreferenceIcon = ({ preference }: PreferenceIconProps): JSX.Element => {
  switch (preference) {
    case "light":
      return <SunIcon aria-hidden="true" />;
    case "dark":
      return <MoonIcon aria-hidden="true" />;
    case "system":
      return <MonitorIcon aria-hidden="true" />;
  }
};

/**
 * The header's light/dark control.
 *
 * Three choices rather than a two-way switch: `system` is what the app does
 * before anyone touches this, and a plain toggle would quietly take that away.
 * The trigger shows the theme currently ON THE PAGE, so under `system` it is a
 * sun or a moon and the menu is where the deferral is visible.
 *
 * @returns The theme icon and its menu.
 */
export const ThemeToggle = (): JSX.Element => {
  const { preference, resolved, setPreference } = useTheme();

  const label = `Theme: ${PREFERENCE_LABELS[preference].toLowerCase()}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} title={label}>
          {resolved === "dark" ? <MoonIcon aria-hidden="true" /> : <SunIcon aria-hidden="true" />}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {THEME_PREFERENCES.map((candidate) => (
          <DropdownMenuItem
            key={candidate}
            onSelect={() => {
              setPreference(candidate);
            }}
          >
            <PreferenceIcon preference={candidate} />
            {PREFERENCE_LABELS[candidate]}
            {candidate === preference ? (
              <CheckIcon className="ml-auto text-muted-foreground" aria-hidden="true" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

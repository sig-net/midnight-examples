// The theme choice, and the two places it is applied.
//
// Deliberately free of React: the inline script in index.html has to resolve
// the same choice before the first paint, long before any component mounts,
// and duplicating logic across a module boundary is how the two drift apart.
// What the script cannot share is the CODE (it is not a module, by design: a
// module would only run after first paint and flash the wrong theme), so it
// duplicates this file's storage key and its light/dark decision in a handful
// of lines. Both sides carry a comment pointing at the other. The duplicate
// goes away the day the first paint can be driven from a module.

/** Where the user's choice is persisted, and the key index.html reads. */
export const THEME_STORAGE_KEY = "erc20-vault-ui.theme";

/**
 * What the user picked. `system` is not a theme but a deferral: it follows the
 * operating system for as long as it is selected, which is the default and the
 * behaviour the app had before there was a switcher at all.
 */
export type ThemePreference = "light" | "dark" | "system";

/** What `system` resolves to, and the only two things the DOM ever sees. */
export type ResolvedTheme = "light" | "dark";

/** Every preference, in the order the switcher offers them. */
export const THEME_PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];

/** The media query whose truth `system` defers to. */
const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

/**
 * Narrow an unknown value, typically one read back out of storage, to a
 * preference.
 *
 * @param value - The value to test.
 * @returns Whether it is one this app understands.
 */
export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && THEME_PREFERENCES.includes(value as ThemePreference);
}

/**
 * The persisted choice, or `system` when there is none.
 *
 * Storage can throw rather than return null (Safari's private mode, a browser
 * configured to block site data), and a theme is never worth failing a render
 * over, so an unreadable store reads as the default.
 *
 * @returns The stored preference, or `system`.
 */
export function readStoredThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

/**
 * Persist the choice, so a reload comes back the same way.
 *
 * Silently does nothing when storage is unavailable: the theme still applies
 * for this page, it simply will not survive a reload.
 *
 * @param preference - The choice to remember.
 */
export function storeThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage blocked. The theme is applied in the DOM either way.
  }
}

/**
 * Whether the operating system currently asks for a dark interface.
 *
 * @returns True when the OS prefers dark.
 */
export function prefersDarkScheme(): boolean {
  return window.matchMedia(DARK_SCHEME_QUERY).matches;
}

/**
 * Subscribe to changes in the operating system's preference, so a `system`
 * choice keeps up with a theme switched while the app is open.
 *
 * @param onChange - Called with the new resolved theme whenever the OS flips.
 * @returns The unsubscribe function.
 */
export function watchSystemTheme(onChange: (theme: ResolvedTheme) => void): () => void {
  const query = window.matchMedia(DARK_SCHEME_QUERY);
  const listener = (event: MediaQueryListEvent): void => {
    onChange(event.matches ? "dark" : "light");
  };
  query.addEventListener("change", listener);
  return () => {
    query.removeEventListener("change", listener);
  };
}

/**
 * Resolve a preference to the theme actually rendered.
 *
 * @param preference - The user's choice.
 * @returns `light` or `dark`, with `system` read off the OS.
 */
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === "system") {
    return prefersDarkScheme() ? "dark" : "light";
  }
  return preference;
}

/**
 * Put the resolved theme into the DOM.
 *
 * shadcn/ui gates every dark token on a `dark` class, so this one class on
 * `<html>` is the whole mechanism. `color-scheme` goes with it, which is what
 * themes the scrollbars and any native control the app has not styled.
 *
 * @param theme - The theme to apply.
 */
export function applyResolvedTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

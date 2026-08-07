import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import {
  applyResolvedTheme,
  readStoredThemePreference,
  type ResolvedTheme,
  resolveTheme,
  storeThemePreference,
  type ThemePreference,
  watchSystemTheme,
} from "../../lib/theme.ts";

/** The theme the app is rendering, and the way to change it. */
export interface ThemeContextValue {
  /** What the user picked, which is what the switcher shows as selected. */
  readonly preference: ThemePreference;
  /** What that resolves to, and what is actually on the page right now. */
  readonly resolved: ResolvedTheme;
  /** Pick a theme, applying it and remembering it for the next visit. */
  readonly setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Props of {@link ThemeProvider}. */
interface ThemeProviderProps {
  readonly children: ReactNode;
}

/**
 * Owns the app's light/dark choice. Mounted once at the root and read through
 * {@link useTheme}.
 *
 * The inline script in `index.html` has already applied the right theme by the
 * time this mounts, which is the point of it: this provider takes over from
 * there rather than deciding it late. The initial state therefore reads the
 * same store the script read, and agrees with it.
 *
 * @param props - The subtree that can read and change the theme.
 * @param props.children - The subtree the provider wraps.
 * @returns The provider wrapping that subtree.
 */
export function ThemeProvider({ children }: ThemeProviderProps): JSX.Element {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredThemePreference);

  // The OS half of the resolution, read as an external store: the media
  // query is the source of truth, so subscribing through
  // useSyncExternalStore keeps `resolved` derived during render rather than
  // synchronised into state after it.
  const systemTheme = useSyncExternalStore(watchSystemTheme, () => resolveTheme("system"));
  const resolved: ResolvedTheme = preference === "system" ? systemTheme : preference;

  // Put the resolution into the DOM. Not a fetch: this is state that lives
  // outside React being kept in step, which is what an effect is for.
  useEffect(() => {
    applyResolvedTheme(resolved);
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference): void => {
    setPreferenceState(next);
    storeThemePreference(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Read the app's theme.
 *
 * @returns The current preference, what it resolves to, and the setter.
 * @throws {Error} If called outside a {@link ThemeProvider}, since a component
 *   guessing its own theme is exactly the drift this context exists to
 *   prevent.
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === null) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

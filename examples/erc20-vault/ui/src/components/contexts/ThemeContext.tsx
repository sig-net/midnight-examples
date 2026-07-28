import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from "react";

import {
  applyResolvedTheme,
  readStoredThemePreference,
  resolveTheme,
  storeThemePreference,
  watchSystemTheme,
  type ResolvedTheme,
  type ThemePreference,
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
 * @returns The provider wrapping that subtree.
 */
export function ThemeProvider({ children }: ThemeProviderProps): JSX.Element {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredThemePreference);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(preference));

  // Apply on every change of the choice. Not a fetch: this is the DOM being
  // synchronised with state that lives outside React, which is what an effect
  // is actually for.
  useEffect(() => {
    const theme = resolveTheme(preference);
    setResolved(theme);
    applyResolvedTheme(theme);
  }, [preference]);

  // Only `system` defers to the OS, so only `system` subscribes to it.
  useEffect(() => {
    if (preference !== "system") {
      return;
    }
    return watchSystemTheme((theme) => {
      setResolved(theme);
      applyResolvedTheme(theme);
    });
  }, [preference]);

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
 * @throws If called outside a {@link ThemeProvider}, since a component guessing
 *   its own theme is exactly the drift this context exists to prevent.
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === null) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

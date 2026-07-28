// Runs once per test file before any test: registers the jest-dom matchers
// (and their type augmentation) and unmounts anything a test rendered, so a
// stale tree never leaks into the next test's queries.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

// jsdom implements no CSS media queries at all, so `window.matchMedia` is
// simply absent and the theme's first read throws. Stubbed rather than guarded
// for in src/lib/theme.ts: every browser the app actually runs in has had this
// for a decade, and code that hedges about it would be dead everywhere but
// here. The stub answers "light", which is the theme these tests assert
// against; a test that wants dark overrides `matches` for itself.
beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  // The theme writes to <html>, which lives outside the tree Testing Library
  // unmounts, so a dark test would otherwise leave every later one dark.
  document.documentElement.classList.remove("dark");
});

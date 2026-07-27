// Runs once per test file before any test: registers the jest-dom matchers
// (and their type augmentation) and unmounts anything a test rendered, so a
// stale tree never leaks into the next test's queries.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

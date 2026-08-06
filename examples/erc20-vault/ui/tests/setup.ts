// Runs once per test file before any test: registers the jest-dom matchers
// (and their type augmentation) and unmounts anything a test rendered, so a
// stale tree never leaks into the next test's queries.
import "@testing-library/jest-dom/vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";

import { configure } from "@testing-library/dom";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

// The deposit-address flow does real work behind its renders: the
// private-state store derives an encryption key from a password (deliberately
// slow) before the first read or write. That sits right at Testing Library's
// default 1s findBy/waitFor limit and flakes; give every wait the room the
// crypto actually needs.
configure({ asyncUtilTimeout: 5000 });

// Node's own binary intrinsics, recovered from Buffer (a subclass of Node's
// Uint8Array over Node's ArrayBuffer) rather than named directly: in this
// file the bare names already resolve to jsdom's replacements, which is
// exactly what the assignments below exist to undo.
//
// Vitest evaluates the app's own (Vite-processed) modules against jsdom's
// realm, while external packages (compact-runtime, superjson, the level
// store) and Node's webcrypto live in Node's realm. Binary values then fail
// cross-realm brand checks: the compiled contract rejects a wallet-derived
// secret ("expected Bytes<32>") since the digest's `.buffer` is a Node
// ArrayBuffer while the generated check's `instanceof ArrayBuffer` names
// jsdom's. A real browser has one realm, so the seam exists only here: give
// the jsdom side Node's binary intrinsics, so values cross the boundary
// intact. TextEncoder and TextDecoder go with them: their output and input
// must be that same realm's Uint8Array.
//
// Assigned at module scope, NOT in beforeEach with vi.stubGlobal: modules
// that snapshot constructors at load time (superjson's typed-array registry,
// which the private-state store revives secrets through) import before any
// beforeEach runs, and a per-test stub would leave them holding jsdom's.
const nodeUint8Array = Object.getPrototypeOf(Buffer) as Uint8ArrayConstructor;
const nodeArrayBuffer = Buffer.alloc(0).buffer.constructor as ArrayBufferConstructor;
globalThis.Uint8Array = nodeUint8Array;
globalThis.ArrayBuffer = nodeArrayBuffer;
globalThis.TextEncoder = NodeTextEncoder as typeof globalThis.TextEncoder;
globalThis.TextDecoder = NodeTextDecoder as typeof globalThis.TextDecoder;

// jsdom implements neither the pointer-capture API, nor scrollIntoView, nor
// ResizeObserver, and radix's Select and Tooltip call all of them on open.
// No-ops at module scope, like the binary intrinsics above: every browser the
// app actually runs in has them.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

// jsdom implements no CSS media queries at all, so `window.matchMedia` is
// simply absent and the theme's first read throws. Stubbed rather than guarded
// for in src/lib/theme.ts: every browser the app actually runs in has had this
// for a decade, and code that hedges about it would be dead everywhere but
// here. The stub answers "light", which is the theme these tests assert
// against; a test that wants dark overrides `matches` for itself.
// Where the run started, restored after each test's private-state sandboxing.
const packageCwd = process.cwd();

beforeEach(() => {
  // A fresh working directory per test: the private-state store runs on
  // classic-level under vitest (see vite.config.ts), which writes a
  // ./midnight-level-db directory at the CURRENT directory and takes an
  // exclusive lock on it. A per-test directory keeps one test's identity
  // secret (and any store operation still in flight after its unmount) out
  // of the next test's store. chdir is process-wide, which is safe under
  // vitest's process-per-file default pool ('forks') but NOT under the
  // 'threads' pool: do not switch pools without revisiting this.
  process.chdir(mkdtempSync(join(tmpdir(), "erc20-vault-ui-test-")));

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
  // Leave the test's private-state sandbox directory behind (it lives in the
  // OS tmpdir): deleting it here could race a store operation still in
  // flight from the unmounted tree.
  process.chdir(packageCwd);
  // The theme writes to <html>, which lives outside the tree Testing Library
  // unmounts, so a dark test would otherwise leave every later one dark.
  document.documentElement.classList.remove("dark");
});

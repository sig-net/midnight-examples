// The browser stand-in for Node's `assert`, aliased in vite.config.ts.
//
// @subsquid/scale-codec (via midnight-js-utils) imports `assert` and calls
// only its default bare form. The npm `assert` polyfill would satisfy it, but
// drags in the browserify `util` shim, which reads `process.env.NODE_DEBUG`
// at module scope and crashes the page (`process is not defined`). The
// callers need one function, so this module IS that one function.
//
// Vitest is unaffected: it resolves the importers natively, so they get
// Node's real `assert` there, never this file.

/**
 * Throw when `value` is falsy, as Node's bare `assert(value, message)` does.
 *
 * @param value - The condition that must hold.
 * @param message - What to raise when it does not.
 * @throws If `value` is falsy: `message` itself when it is an Error, or an
 *   Error carrying it (or a generic text) otherwise.
 */
export default function assert(value: unknown, message?: string | Error): asserts value {
  if (!value) {
    if (message instanceof Error) {
      throw message;
    }
    throw new Error(message ?? "Assertion failed");
  }
}

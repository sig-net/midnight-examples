/**
 * The message to show a user for a value something rejected with.
 *
 * A rejection is typed `unknown` and genuinely can be anything, and the wallet
 * connectors exercise the range: the contexts raise `Error`s, and the
 * dapp-connector API raises plain `Error`s tagged with a `code` rather than a
 * class of its own. Both carry a usable `message`. Anything else reaching here
 * is a bug, and its `String` form is at least a thread to pull, where a bare
 * "[object Object]" is not.
 *
 * The caller supplies the context. This says only what went wrong, never what
 * the user was doing, so it reads correctly wherever it is called from.
 *
 * @param error - The value a promise rejected with, or a caught throw.
 * @returns A message fit to render.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

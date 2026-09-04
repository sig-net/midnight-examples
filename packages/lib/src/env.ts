// Environment reads: the one place "blank means unset" is decided, for this
// package and for every consumer resolving its own configuration from an env
// map (an example's deploy flows, the setup pipeline's steps).

/**
 * The trimmed value of `name`, or `undefined` when it is unset OR blank.
 *
 * Collapsing blank to `undefined` is what lets a caller write `?? fallback`
 * and mean it. Applying `??` to a raw `env.X?.trim()` would let an empty
 * string beat the fallback, which is never what an unset-looking variable
 * should do.
 *
 * @param env - The environment to read from.
 * @param name - The variable to read.
 * @returns The trimmed value, or `undefined` when unset or blank.
 */
export function envOrUndefined(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const trimmed = env[name]?.trim();
  return trimmed === "" ? undefined : trimmed;
}

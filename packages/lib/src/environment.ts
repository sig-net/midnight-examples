/**
 * Assert a prior setup step populated `name`, failing with a pointed message.
 *
 * @param env - The suite's env accumulator.
 * @param name - The env-var name a prior step (or the operator's `.env`) must have set.
 * @returns The non-empty value.
 * @throws {Error} If the variable is unset or empty.
 */
export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(
      `${name} is required. Run the setup step that generates it or supply it in .env.`,
    );
  }
  return value;
}

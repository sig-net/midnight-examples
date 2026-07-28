/**
 * An EVM address, short enough for a narrow spot but still recognisable.
 *
 * Both ends are kept: an address is compared by its ends in practice, and a
 * prefix alone matches far too many.
 *
 * @param address - The full checksummed address.
 * @returns The shortened form.
 */
export function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

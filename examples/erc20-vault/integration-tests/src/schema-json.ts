/**
 * Decode a schema field, removing any trailing NUL padding.
 *
 * @param bytes - UTF-8 schema bytes from a contract or request record.
 * @returns Schema text with trailing NUL padding removed.
 */
export function schemaJson(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\0+$/u, "");
}

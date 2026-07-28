import { describe, expect, it } from "vitest";

import { pathStringOfBytes } from "../src/mpc-path.ts";

/**
 * The path reading must match the fakenet responder's `getPath`, which decodes
 * with Node's `Buffer.prototype.toString("utf8")` and strips NUL bytes. The
 * table pins the reading's observable behaviours; the oracle test pins the
 * Buffer equivalence the implementation's comment claims.
 */

interface PathReadingCase {
  readonly name: string;
  readonly path: Uint8Array;
  readonly expected: string;
}

const CASES: readonly PathReadingCase[] = [
  {
    name: "plain ASCII passes through",
    path: new TextEncoder().encode("vault"),
    expected: "vault",
  },
  {
    name: "NUL padding is stripped, wherever it sits",
    path: new Uint8Array([0x00, 0x76, 0x00, 0x61, 0x75, 0x6c, 0x74, 0x00]),
    expected: "vault",
  },
  {
    name: "an invalid UTF-8 byte becomes U+FFFD",
    path: new Uint8Array([0xff, 0x76]),
    expected: "�v",
  },
  {
    name: "empty input reads as the empty string",
    path: new Uint8Array(0),
    expected: "",
  },
];

describe("pathStringOfBytes", () => {
  it.each(CASES)("$name", ({ path, expected }) => {
    expect(pathStringOfBytes(path)).toBe(expected);
  });

  it("matches the fakenet's Buffer reading on random 32-byte paths", () => {
    for (let i = 0; i < 5000; i += 1) {
      const path = new Uint8Array(32);
      for (let j = 0; j < path.length; j += 1) {
        path[j] = Math.floor(Math.random() * 256);
      }
      const viaBuffer = Buffer.from(path).toString("utf8").replace(/\0/g, "");
      expect(pathStringOfBytes(path)).toBe(viaBuffer);
    }
  });
});

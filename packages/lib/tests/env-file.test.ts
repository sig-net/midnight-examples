// The .env parser every entrypoint reads the operator's file through. The
// value rules are docker compose's, which reads the same file for the fakenet
// container: each case below was rendered through `docker compose config`
// with the same line and yields the same value.

import { describe, expect, it } from "vitest";

import { parseDotEnv } from "../src/env-file.ts";

interface Case {
  name: string;
  text: string;
  expected: Record<string, string>;
}

const CASES: Case[] = [
  { name: "a plain value", text: "KEY=abc\n", expected: { KEY: "abc" } },
  {
    name: "an unquoted value ending at a hash preceded by whitespace",
    text: "KEY=abc # note\n",
    expected: { KEY: "abc" },
  },
  {
    name: "a hash with no whitespace before it, kept as part of the value",
    text: "KEY=a#b\n",
    expected: { KEY: "a#b" },
  },
  {
    name: "a double-quoted value keeping its hash and dropping the trailing comment",
    text: 'KEY="a # b" # trailing\n',
    expected: { KEY: "a # b" },
  },
  {
    name: "a single-quoted value keeping its hash",
    text: "KEY='q # r'\n",
    expected: { KEY: "q # r" },
  },
  {
    name: "surrounding whitespace trimmed",
    text: "KEY=  spaced  \n",
    expected: { KEY: "spaced" },
  },
  { name: "whitespace around the equals sign", text: "  KEY = v\n", expected: { KEY: "v" } },
  { name: "an export prefix", text: "export KEY=v\n", expected: { KEY: "v" } },
  { name: "a comment line", text: "# KEY=v\n", expected: {} },
  { name: "an empty value, left out", text: "KEY=\n", expected: {} },
  {
    name: "a key repeated, last occurrence winning",
    text: "KEY=a\nKEY=b\n",
    expected: { KEY: "b" },
  },
  { name: "a line that is not an assignment", text: "not an assignment\n", expected: {} },
  {
    name: "a value ending in a long run of spaces and no hash",
    text: `KEY=abc${" ".repeat(10_000)}\n`,
    expected: { KEY: "abc" },
  },
  {
    name: "a value of many space-hash repeats, cut at the first",
    text: `KEY=a${" #".repeat(10_000)}\n`,
    expected: { KEY: "a" },
  },
];

describe("parseDotEnv", () => {
  it.each(CASES)("parses $name", ({ text, expected }) => {
    expect(parseDotEnv(text)).toEqual(expected);
  });
});

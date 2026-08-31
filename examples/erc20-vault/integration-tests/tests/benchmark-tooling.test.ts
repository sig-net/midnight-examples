// Offline unit tests of the benchmark tooling's pure pieces: the
// CircuitModel line parser, the key-location parser, the duration
// statistics, and the latest-run record selection. No stack, no env gate:
// these run in every `yarn test`.

import { describe, expect, it } from "vitest";

import {
  BenchmarkLeg,
  type BenchRecord,
  BenchRecordKind,
  circuitIdFromKeyLocation,
} from "../src/benchmark/records.ts";
import { durationStats, latestRunRecords } from "../src/benchmark/report.ts";
import { type CircuitModel, parseCircuitModel } from "../src/benchmark/static-metrics.ts";

// A real `zkir-v3 mock-compile -v` line (initialise circuit), with the SGR
// colour sequences the binary emits even when piped. \u001b is ESC.
const ANSI_MODEL_OUTPUT =
  "\u001b[2m2026-08-18T07:54:35.466499Z\u001b[0m \u001b[32m INFO\u001b[0m \u001b[2mzkir\u001b[0m\u001b[2m:\u001b[0m " +
  "full model \u001b[3mmodel\u001b[0m\u001b[2m=\u001b[0mModel { model: CircuitModel { k: 13, rows: 4272, " +
  "table_rows: 7939, nb_unusable_rows: 7, max_deg: 5, advice_columns: 9, fixed_columns: 56, " +
  "lookups: 7, permutations: 12, column_queries: 84, point_sets: 5, size: 6224 } }";

const INITIALIZE_MODEL: CircuitModel = {
  k: 13,
  rows: 4272,
  tableRows: 7939,
  nbUnusableRows: 7,
  maxDeg: 5,
  adviceColumns: 9,
  fixedColumns: 56,
  lookups: 7,
  permutations: 12,
  columnQueries: 84,
  pointSets: 5,
  size: 6224,
};

// The same line with the colour sequences removed, as a separate literal so
// this test does not share stripping logic with the code under test.
const PLAIN_MODEL_OUTPUT =
  "2026-08-18T07:54:35.466499Z  INFO zkir: full model model=Model { model: CircuitModel { " +
  "k: 13, rows: 4272, table_rows: 7939, nb_unusable_rows: 7, max_deg: 5, advice_columns: 9, " +
  "fixed_columns: 56, lookups: 7, permutations: 12, column_queries: 84, point_sets: 5, size: 6224 } }";

describe("parseCircuitModel", () => {
  it.each([
    { name: "ANSI-coloured output", output: ANSI_MODEL_OUTPUT },
    { name: "plain output", output: PLAIN_MODEL_OUTPUT },
  ])("parses the model line from $name", ({ output }) => {
    expect(parseCircuitModel(output, "initialise.bzkir")).toEqual(INITIALIZE_MODEL);
  });

  it.each([
    {
      name: "output without a CircuitModel line",
      output: "Mock compiling circuit (k=13, rows=4272)",
      error: /no CircuitModel line/,
    },
    {
      name: "model line missing a field",
      output: "CircuitModel { k: 13, rows: 4272 }",
      error: /missing 'table_rows'/,
    },
  ])("throws on $name", ({ output, error }) => {
    expect(() => parseCircuitModel(output, "broken.bzkir")).toThrow(error);
  });
});

describe("circuitIdFromKeyLocation", () => {
  it.each([
    {
      keyLocation: "contract:0200aabbcc/startDeposit?vk=1f2e3d",
      expected: "startDeposit",
    },
    {
      keyLocation: "contract:0200aabbcc/signBidirectional",
      expected: "signBidirectional",
    },
    { keyLocation: "midnight/zswap/spend", expected: undefined },
  ])("parses '$keyLocation' to $expected", ({ keyLocation, expected }) => {
    expect(circuitIdFromKeyLocation(keyLocation)).toBe(expected);
  });
});

describe("durationStats", () => {
  it.each([
    {
      name: "odd sample count",
      values: [30, 10, 20],
      expected: { n: 3, mean: 20, median: 20, min: 10, max: 30 },
    },
    {
      name: "even sample count",
      values: [40, 10, 20, 30],
      expected: { n: 4, mean: 25, median: 25, min: 10, max: 40 },
    },
    {
      name: "single sample",
      values: [7],
      expected: { n: 1, mean: 7, median: 7, min: 7, max: 7 },
    },
    { name: "no samples", values: [], expected: undefined },
  ])("computes stats over $name", ({ values, expected }) => {
    expect(durationStats(values)).toEqual(expected);
  });
});

describe("latestRunRecords", () => {
  // Two composed runs: run-b re-measured only the deposit leg, so leg
  // selection must return run-b's deposit record and run-a's claim record.
  const RECORDS: BenchRecord[] = [
    {
      kind: BenchRecordKind.Leg,
      runId: "run-a",
      at: "2026-08-18T08:00:00.000Z",
      ms: 100,
      leg: BenchmarkLeg.DepositRequest,
    },
    {
      kind: BenchRecordKind.Leg,
      runId: "run-a",
      at: "2026-08-18T08:01:00.000Z",
      ms: 200,
      leg: BenchmarkLeg.DepositClaim,
    },
    {
      kind: BenchRecordKind.Leg,
      runId: "run-b",
      at: "2026-08-18T09:00:00.000Z",
      ms: 150,
      leg: BenchmarkLeg.DepositRequest,
    },
  ];

  it.each([
    { leg: BenchmarkLeg.DepositRequest, expectedRunId: "run-b", expectedMs: [150] },
    { leg: BenchmarkLeg.DepositClaim, expectedRunId: "run-a", expectedMs: [200] },
  ])("selects the latest run containing leg $leg", ({ leg, expectedRunId, expectedMs }) => {
    const selected = latestRunRecords(RECORDS, (record) => record.leg === leg);
    expect(selected.map((record) => record.runId)).toEqual(selected.map(() => expectedRunId));
    expect(selected.map((record) => record.ms)).toEqual(expectedMs);
  });

  it("returns nothing when no record matches", () => {
    const selected = latestRunRecords(RECORDS, (record) => record.leg === undefined);
    expect(selected).toEqual([]);
  });
});

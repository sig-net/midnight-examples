// The benchmark record vocabulary: what one JSONL line in the proof-records
// file says. Proof-server observations (check/prove) and e2e leg wall-clock
// measurements share one record shape so the report generator reads a single
// stream.

/** Kind of one benchmark JSONL record. */
export enum BenchRecordKind {
  /** A proof-server /check round trip. */
  Check = "check",
  /** A proof-server /prove round trip. */
  Prove = "prove",
  /** One timed e2e leg of tests/benchmark.test.ts. */
  Leg = "leg",
}

/**
 * The timed legs of tests/benchmark.test.ts, dotted `<roundTrip>.<flow>` to
 * match the keys of that file's `timings` report.
 */
export enum BenchmarkLeg {
  DepositRequest = "deposit.deposit",
  DepositPollSignatureResponse = "deposit.pollSignatureResponse",
  DepositBroadcastEvm = "deposit.broadcastEvm",
  DepositPollRespondBidirectional = "deposit.pollRespondBidirectional",
  DepositClaim = "deposit.claim",
  WithdrawRequest = "withdraw.withdraw",
  WithdrawPollSignatureResponse = "withdraw.pollSignatureResponse",
  WithdrawBroadcastEvm = "withdraw.broadcastEvm",
  WithdrawPollRespondBidirectional = "withdraw.pollRespondBidirectional",
  WithdrawCompleteWithdraw = "withdraw.completeWithdraw",
}

/**
 * One benchmark observation; one JSONL line in the proof-records file.
 * Written by the {@link file://./recorder.ts Recorder}, read by the report
 * generator.
 */
export interface BenchRecord {
  readonly kind: BenchRecordKind;
  /** Identifier shared by all records of one benchmark run. */
  readonly runId: string;
  /** ISO timestamp when the observation completed. */
  readonly at: string;
  /** Wall-clock duration of the measured operation. */
  readonly ms: number;
  /** The e2e leg the observation is attributed to, when one was active. */
  readonly leg?: BenchmarkLeg;
  /** Canonical proving key location (check/prove records). */
  readonly keyLocation?: string;
  /** Bare circuit id parsed out of `keyLocation`, when it is a contract location. */
  readonly keyCircuit?: string;
  /**
   * 1-based occurrence of this (kind, keyLocation) within the run. `seq === 1`
   * on a prove marks the cold prove: the proof server loads that circuit's
   * prover key (up to hundreds of MB) on first use.
   */
  readonly seq?: number;
  /** Byte length of the serialized proof preimage sent to the proof server. */
  readonly preimageBytes?: number;
  /** Byte length of the proof returned by /prove. */
  readonly proofBytes?: number;
  /** Error message when the measured operation failed. */
  readonly error?: string;
}

/**
 * Parse the bare circuit id out of a canonical
 * `contract:<addr>/<circuitId>?vk=…` key location.
 *
 * @param keyLocation - The key location to parse.
 * @returns The circuit id, or undefined for non-contract locations (`midnight/...` builtins).
 */
export function circuitIdFromKeyLocation(keyLocation: string): string | undefined {
  const match = /^contract:[^/]+\/([^?]+)/.exec(keyLocation);
  return match?.[1];
}

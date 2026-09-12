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
 * The timed legs of tests/benchmark.test.ts, dotted `<sequence>.<step>`. The
 * step names the flow function the leg calls, or, where a settle flow routes
 * between several circuits, the circuit that call proves. The values are the
 * keys of that file's `timings` report.
 */
export enum BenchmarkLeg {
  Initialise = "initialise.initialise",
  ApproveRouter = "approve.approveRouter",
  ApprovePollSignatureResponse = "approve.pollSignatureResponse",
  ApproveBroadcastEvm = "approve.broadcastEvm",
  DepositStart = "deposit.startDeposit",
  DepositPollSignatureResponse = "deposit.pollSignatureResponse",
  DepositBroadcastEvm = "deposit.broadcastEvm",
  DepositPollRespondBidirectional = "deposit.pollRespondBidirectional",
  DepositComplete = "deposit.completeDeposit",
  WithdrawStart = "withdraw.startWithdraw",
  WithdrawPollSignatureResponse = "withdraw.pollSignatureResponse",
  WithdrawBroadcastEvm = "withdraw.broadcastEvm",
  WithdrawPollRespondBidirectional = "withdraw.pollRespondBidirectional",
  WithdrawComplete = "withdraw.completeWithdraw",
  SwapStart = "swap.startSwap",
  SwapPollSignatureResponse = "swap.pollSignatureResponse",
  SwapBroadcastEvm = "swap.broadcastEvm",
  SwapPollOutcome = "swap.pollSwapOutcome",
  SwapComplete = "swap.completeSwap",
  ApproveStata = "approveStata.approveStata",
  ApproveStataPollSignatureResponse = "approveStata.pollSignatureResponse",
  ApproveStataBroadcastEvm = "approveStata.broadcastEvm",
  SupplyStart = "supply.startSupply",
  SupplyPollSignatureResponse = "supply.pollSignatureResponse",
  SupplyBroadcastEvm = "supply.broadcastEvm",
  SupplyPollOutcome = "supply.pollSupplyOutcome",
  SupplyComplete = "supply.completeSupply",
  RedeemStart = "redeem.startRedeem",
  RedeemPollSignatureResponse = "redeem.pollSignatureResponse",
  RedeemBroadcastEvm = "redeem.broadcastEvm",
  RedeemPollOutcome = "redeem.pollRedeemOutcome",
  RedeemComplete = "redeem.completeRedeem",
  RefundStartWithdraw = "refund.startWithdraw",
  RefundPollSignatureResponse = "refund.pollSignatureResponse",
  RefundBroadcastEvm = "refund.broadcastEvm",
  RefundPollRespondBidirectional = "refund.pollRespondBidirectional",
  RefundWithdraw = "refund.refundWithdraw",
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
   * 1-based occurrence of this (kind, keyLocation) within the run, counting
   * successful observations only (an errored record reports the seq it would
   * have taken without consuming it). `seq === 1` on a prove marks the cold
   * prove: the proof server loads that circuit's prover key (up to hundreds
   * of MB) on first use.
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

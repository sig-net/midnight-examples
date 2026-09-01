// The benchmark recorder: appends BenchRecords to a JSONL file and hands out
// the ProofServerObserver that attributes proof-server round trips to the
// e2e leg currently being timed. One recorder per benchmark run; everything
// in a run is sequential, so one mutable leg context is safe.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  type ProofServerObservation,
  type ProofServerObserver,
  ProofServerPhase,
} from "@sig-net/midnight-examples-lib";

import {
  type BenchmarkLeg,
  type BenchRecord,
  BenchRecordKind,
  circuitIdFromKeyLocation,
} from "./records.ts";

/**
 * Appends {@link BenchRecord}s as JSONL (one line per observation, written
 * synchronously so records survive a crashed run). Construction touches no
 * files: the output directory is created on the first append, keeping the
 * recorder inert on the offline test path.
 */
export class Recorder {
  private leg: BenchmarkLeg | undefined;
  private outputDirReady = false;
  private readonly seqByKey = new Map<string, number>();

  /**
   * @param filePath - The JSONL file every record is appended to.
   * @param runId - Identifier stamped into every record of this run.
   */
  constructor(
    private readonly filePath: string,
    private readonly runId: string,
  ) {}

  /**
   * The observer to pass to `createVaultSession`: records every proof-server
   * /check and /prove round trip against the current leg.
   *
   * @param observation - The round trip the proof provider just completed.
   */
  readonly observer: ProofServerObserver = (observation: ProofServerObservation): void => {
    const kind =
      observation.phase === ProofServerPhase.Prove ? BenchRecordKind.Prove : BenchRecordKind.Check;
    const seqKey = `${kind}:${observation.keyLocation}`;
    const seq = (this.seqByKey.get(seqKey) ?? 0) + 1;
    // Only a successful observation consumes the seq: the report drops errored
    // records and reads `seq === 1` as the cold prove, so an errored first
    // attempt must leave seq 1 for the prove that actually pays the key load.
    if (observation.error === undefined) {
      this.seqByKey.set(seqKey, seq);
    }
    this.append({
      kind,
      ms: observation.ms,
      keyLocation: observation.keyLocation,
      keyCircuit: circuitIdFromKeyLocation(observation.keyLocation),
      seq,
      preimageBytes: observation.serializedPreimage.byteLength,
      proofBytes: observation.proof?.byteLength,
      error: observation.error,
    });
  };

  /**
   * Attribute subsequent check/prove observations to `leg`.
   *
   * @param leg - The e2e leg about to run.
   */
  setLeg(leg: BenchmarkLeg): void {
    this.leg = leg;
  }

  /** Stop attributing observations to a leg. */
  clearLeg(): void {
    this.leg = undefined;
  }

  /**
   * Record one timed e2e leg.
   *
   * @param leg - The leg that was timed.
   * @param ms - Its wall-clock duration.
   */
  recordLeg(leg: BenchmarkLeg, ms: number): void {
    this.append({ kind: BenchRecordKind.Leg, leg, ms });
  }

  private append(
    partial: Omit<BenchRecord, "runId" | "at" | "leg"> & { leg?: BenchmarkLeg },
  ): void {
    if (!this.outputDirReady) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.outputDirReady = true;
    }
    const record: BenchRecord = {
      leg: this.leg,
      ...partial,
      runId: this.runId,
      at: new Date().toISOString(),
    };
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`);
  }
}

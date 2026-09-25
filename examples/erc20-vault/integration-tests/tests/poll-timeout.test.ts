import {
  asciiPadded,
  parseRequestIdHex,
  requestIdBytes,
  type SignatureResponseVerdict,
  type SignBidirectionalEvent,
  type SignetRequestResponseReader,
} from "@sig-net/midnight";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pollRespondBidirectional } from "../src/flows/poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "../src/flows/poll-signature-response.ts";
import * as outcomes from "../src/flows/respond-output.ts";
import { ERC20_TRANSFER_RESULT_SCHEMA, VAULT_SCHEMA_BYTES } from "../src/mpc-routing.ts";
import { OutputSource } from "../src/output-source.ts";
import * as contextModule from "../src/vault-context.ts";

const REQUEST = parseRequestIdHex("ab".repeat(32));
const CONTEXT = {
  signetContractAddress: "cd".repeat(32),
  respondOutputSource: OutputSource.EVMNode,
} as contextModule.VaultContext;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("signature timeout diagnostics", () => {
  const REJECTED: SignatureResponseVerdict = {
    index: 0n,
    signer: "0x456",
    rejectedReason: "wrong signer",
    response: {
      requestId: requestIdBytes(REQUEST),
      signature: {
        bigR: { x: new Uint8Array(32), y: new Uint8Array(32) },
        s: new Uint8Array(32),
        recoveryId: 0n,
      },
    },
  };
  it.each([
    { name: "no posts", verdicts: [], expected: "0 posts observed, 0 rejected posts" },
    { name: "wrong signer", verdicts: [REJECTED], expected: "Expected 0x123, recovered 0x456" },
  ])("reports $name and releases its timer", async ({ verdicts, expected }) => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const query = vi
      .fn<SignetRequestResponseReader["getVerifiedSignatureRespondedEvent"]>()
      .mockResolvedValue({ verdicts });
    const reader = {
      getVerifiedSignatureRespondedEvent: query,
    } as Partial<SignetRequestResponseReader> as SignetRequestResponseReader;
    vi.spyOn(contextModule, "createResponseReader").mockReturnValue(reader);
    await Promise.all([
      expect(
        pollSignatureResponse(CONTEXT, {
          requestId: REQUEST,
          expectedSigner: "0x123",
          intervalMs: 100,
          timeoutMs: 1000,
        }),
      ).rejects.toThrow(expected),
      vi.advanceTimersByTimeAsync(1000),
    ]);
    expect(query).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(verdicts.length);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("attestation timeout diagnostics", () => {
  // The schemas the poll hands every tick come off the request record, the
  // vault's transfer schema in both directions.
  const REQUEST_RECORD = {
    outputDeserializationSchema: asciiPadded(ERC20_TRANSFER_RESULT_SCHEMA, VAULT_SCHEMA_BYTES),
    respondSerializationSchema: asciiPadded(ERC20_TRANSFER_RESULT_SCHEMA, VAULT_SCHEMA_BYTES),
  } as SignBidirectionalEvent;

  it("retains the last execution observation failure and passes the record's schemas", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reader = {
      getSignatureRequest: vi
        .fn<SignetRequestResponseReader["getSignatureRequest"]>()
        .mockResolvedValue(REQUEST_RECORD),
    } as Partial<SignetRequestResponseReader> as SignetRequestResponseReader;
    vi.spyOn(contextModule, "createResponseReader").mockReturnValue(reader);
    const fetchOutcome = vi
      .spyOn(outcomes, "fetchAttestedRespondOutcome")
      .mockImplementation((_context, _request, _source, _schemas, _path, progress) => {
        progress?.update("1 attestation post observed");
        progress?.failure("observation", "execution observation failed: RPC timeout");
        return Promise.resolve(undefined);
      });
    await Promise.all([
      expect(
        pollRespondBidirectional(CONTEXT, { requestId: REQUEST, intervalMs: 100, timeoutMs: 1000 }),
      ).rejects.toThrow("Last failure: execution observation failed: RPC timeout"),
      vi.advanceTimersByTimeAsync(1000),
    ]);
    expect(fetchOutcome).toHaveBeenCalledWith(
      CONTEXT,
      REQUEST,
      OutputSource.EVMNode,
      {
        outputDeserializationSchema: ERC20_TRANSFER_RESULT_SCHEMA,
        respondSerializationSchema: ERC20_TRANSFER_RESULT_SCHEMA,
      },
      undefined,
      expect.anything(),
      expect.any(outcomes.RespondPollMemo),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

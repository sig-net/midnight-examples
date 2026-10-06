// Offline unit tests of the attested-outcome resolution under both output
// sources: an in-process HTTP server stands in for the MPC's output cache, a
// stubbed observation for the EVM node's trace, a locally signed attestation
// for the MPC's post, and the vault's ledger read is stubbed to the matching
// response key. No stack, no env gate: these run in every `yarn test`.

import { createServer, type Server } from "node:http";

import {
  type EvmTraceOutput,
  EvmTraceOutputKind,
  MpcOutputCacheReader,
  OutputKind,
  parseRequestIdHex,
  requestIdBytes,
  type RespondBidirectionalEvent,
  type SignetRequestResponseReader,
} from "@sig-net/midnight";
import { attestRespondBidirectional, secp256k1PublicKeyOf } from "@sig-net/midnight/testing";
import type { VaultProviders } from "@sig-net/midnight-examples-erc20-vault-contract";
import * as vaultContract from "@sig-net/midnight-examples-erc20-vault-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_OUTPUT } from "../src/empty-output.ts";
import { fetchAttestedRespondOutcome, RespondPollMemo } from "../src/flows/respond-output.ts";
import {
  ERC20_TRANSFER_OUTPUT_SCHEMA,
  REPLACE_NONCE_OUTPUT_SCHEMA,
  SWAP_MPC_ROUTING,
} from "../src/mpc-routing.ts";
import type { ObservedExecution } from "../src/observed-execution.ts";
import * as observedModule from "../src/observed-execution.ts";
import { OutputSource } from "../src/output-source.ts";
import { PollProgress } from "../src/poll-progress.ts";
import { schemaJson } from "../src/schema-json.ts";
import * as contextModule from "../src/vault-context.ts";

const REQUEST_ID = parseRequestIdHex("ab".repeat(32));
const NETWORK_ID = "undeployed";
const SIGNET_CONTRACT_ADDRESS = "cd".repeat(32);
const EXPECTED_OBJECT_PATH = `/v1/test/${NETWORK_ID}/${SIGNET_CONTRACT_ADDRESS}/${REQUEST_ID}.bin`;
// The key the vault pinned at initialise, here held locally so the test can
// post attestations the way the MPC does.
const MPC_RESPONSE_SECRET = new Uint8Array(32).fill(7);
const MPC_RESPONSE_KEY = secp256k1PublicKeyOf(MPC_RESPONSE_SECRET);
// The output schemas the request records carry: the single bool of a transfer,
// the empty schema of a nonce replacement, the uint256 of a swap.
const OUTPUT_SCHEMA = ERC20_TRANSFER_OUTPUT_SCHEMA;
const SWAP_OUTPUT_SCHEMA = schemaJson(SWAP_MPC_ROUTING.outputDeserializationSchema);
// This suite plays the MPC, so the attested target-chain height is whatever
// it claims: the check is that the height is signed, not that it is real.
const BLOCK_HEIGHT = 77n;
const TRANSFER_TRUE = new Uint8Array([0x01]);
const TRANSFER_FALSE = new Uint8Array([0x00]);
// An attested swap amountIn of 1: the uint256 whole, little-endian. Its first
// byte is the bool schema's success byte, so it pins that an attested value
// never reads as a verdict.
const SWAP_AMOUNT_IN_ONE = Uint8Array.from([0x01, ...new Uint8Array(31)]);

/** An MPC post attesting `serializedOutput` under `outputKind` for {@link REQUEST_ID}. */
function attest(outputKind: OutputKind, serializedOutput: Uint8Array): RespondBidirectionalEvent {
  return attestRespondBidirectional(
    {
      requestId: requestIdBytes(REQUEST_ID),
      blockHeight: BLOCK_HEIGHT,
      outputKind,
      serializedOutput,
    },
    MPC_RESPONSE_SECRET,
  );
}

let server: Server | undefined;

afterEach(
  () =>
    new Promise<void>((resolve) => {
      if (server === undefined) {
        resolve();
        return;
      }
      server.close(() => {
        resolve();
      });
      server = undefined;
    }),
);

/** What the bucket stand-in answers every request with. */
interface BucketReply {
  readonly status: number;
  readonly body: Uint8Array;
}

/** Start a server answering every request with `reply`, recording each request path into `paths`. */
async function serveBucket(reply: BucketReply, paths: string[]): Promise<string> {
  const started = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.writeHead(reply.status, { "content-type": "application/octet-stream" });
    response.end(Buffer.from(reply.body));
  });
  server = started;
  await new Promise<void>((resolve) => started.listen(0, "127.0.0.1", resolve));
  const address = started.address();
  if (address === null || typeof address === "string") {
    throw new Error("the bucket server has no TCP address");
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

/** A context whose cache is the bucket stand-in at `baseUrl` (or none when omitted). */
function contextWithCache(baseUrl: string | undefined): contextModule.VaultContext {
  return {
    signetContractAddress: SIGNET_CONTRACT_ADDRESS,
    vaultContractAddress: "ef".repeat(32),
    // The ledger read and the execution observation are stubbed, so neither
    // the provider nor the EVM endpoint is consulted.
    providers: { publicDataProvider: {} } as VaultProviders,
    evmRpcUrl: "http://127.0.0.1:1",
    respondOutputSource: OutputSource.MPCCache,
    mpcOutputCache:
      baseUrl === undefined
        ? undefined
        : new MpcOutputCacheReader({
            cacheUrl: `${baseUrl}/v1/test`,
            networkId: NETWORK_ID,
            signetContractAddress: SIGNET_CONTRACT_ADDRESS,
          }),
  } as contextModule.VaultContext;
}

/** Stub the signet event read to `events` and the vault ledger read to the pinned key. */
function stubChainReads(events: readonly RespondBidirectionalEvent[]): void {
  const reader = {
    getRespondBidirectionalEvents: vi
      .fn<SignetRequestResponseReader["getRespondBidirectionalEvents"]>()
      .mockResolvedValue([...events]),
  } as Partial<SignetRequestResponseReader> as SignetRequestResponseReader;
  vi.spyOn(contextModule, "createResponseReader").mockReturnValue(reader);
  vi.spyOn(vaultContract, "readVaultLedger").mockResolvedValue({
    mpcResponseKey: MPC_RESPONSE_KEY,
  } as Awaited<ReturnType<typeof vaultContract.readVaultLedger>>);
}

describe("fetchAttestedRespondOutcome under OutputSource.MPCCache", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "a transfer that returned true",
      outputSchema: OUTPUT_SCHEMA,
      outputKind: OutputKind.executed,
      cached: TRANSFER_TRUE,
      succeeded: true,
    },
    {
      name: "a transfer that returned false",
      outputSchema: OUTPUT_SCHEMA,
      outputKind: OutputKind.executed,
      cached: TRANSFER_FALSE,
      succeeded: false,
    },
    {
      name: "a reverted transfer (failed, empty output)",
      outputSchema: OUTPUT_SCHEMA,
      outputKind: OutputKind.failed,
      cached: EMPTY_OUTPUT,
      succeeded: false,
    },
    {
      name: "a transfer whose nonce another transaction took (unviable, empty output)",
      outputSchema: OUTPUT_SCHEMA,
      outputKind: OutputKind.unviable,
      cached: EMPTY_OUTPUT,
      succeeded: false,
    },
    {
      name: "an executed nonce replacement (empty schema, empty output)",
      outputSchema: REPLACE_NONCE_OUTPUT_SCHEMA,
      outputKind: OutputKind.executed,
      cached: EMPTY_OUTPUT,
      succeeded: true,
    },
    {
      name: "an executed swap (uint256 output: a value, never a verdict)",
      outputSchema: SWAP_OUTPUT_SCHEMA,
      outputKind: OutputKind.executed,
      cached: SWAP_AMOUNT_IN_ONE,
      succeeded: false,
    },
  ])(
    "resolves $name from the cached bytes the attestation signs",
    async ({ outputSchema, outputKind, cached, succeeded }) => {
      const paths: string[] = [];
      const baseUrl = await serveBucket({ status: 200, body: cached }, paths);
      const event = attest(outputKind, cached);
      stubChainReads([event]);

      const outcome = await fetchAttestedRespondOutcome(
        contextWithCache(baseUrl),
        REQUEST_ID,
        OutputSource.MPCCache,
        outputSchema,
      );

      expect(outcome).toEqual({ event, serializedOutput: cached, succeeded });
      expect(paths).toEqual([EXPECTED_OBJECT_PATH]);
    },
  );

  it("rejects a post whose signature covers other bytes than the cache holds", async () => {
    const baseUrl = await serveBucket({ status: 200, body: TRANSFER_TRUE }, []);
    stubChainReads([attest(OutputKind.executed, TRANSFER_FALSE)]);
    const progress = new PollProgress("test", 1000);

    const outcome = await fetchAttestedRespondOutcome(
      contextWithCache(baseUrl),
      REQUEST_ID,
      OutputSource.MPCCache,
      OUTPUT_SCHEMA,
      undefined,
      progress,
    );

    expect(outcome).toBeUndefined();
    expect(progress.summary()).toContain(
      "no signature verifies against the vault response key and the mpc-cache output",
    );
  });

  it("rejects a post whose declared kind is not the one its signature covers", async () => {
    // A genuine executed attestation re-declared as a failure: the kind is
    // inside the signed digest, so the post fails to verify over the cached
    // bytes, and an empty cache would not rescue it either.
    const baseUrl = await serveBucket({ status: 200, body: TRANSFER_TRUE }, []);
    stubChainReads([
      { ...attest(OutputKind.executed, TRANSFER_TRUE), outputKind: OutputKind.failed },
    ]);
    const progress = new PollProgress("test", 1000);

    const outcome = await fetchAttestedRespondOutcome(
      contextWithCache(baseUrl),
      REQUEST_ID,
      OutputSource.MPCCache,
      OUTPUT_SCHEMA,
      undefined,
      progress,
    );

    expect(outcome).toBeUndefined();
    expect(progress.summary()).toContain(
      "no signature verifies against the vault response key and the mpc-cache output",
    );
  });

  it("yields nothing while the cache holds no object yet, naming the object URL", async () => {
    const baseUrl = await serveBucket({ status: 404, body: new Uint8Array() }, []);
    stubChainReads([attest(OutputKind.executed, TRANSFER_TRUE)]);
    const progress = new PollProgress("test", 1000);

    const outcome = await fetchAttestedRespondOutcome(
      contextWithCache(baseUrl),
      REQUEST_ID,
      OutputSource.MPCCache,
      OUTPUT_SCHEMA,
      undefined,
      progress,
    );

    expect(outcome).toBeUndefined();
    expect(progress.summary()).toContain(
      `MPC output cache holds no object yet at ${baseUrl}${EXPECTED_OBJECT_PATH}`,
    );
  });

  it("reads nothing from the cache before an attestation is posted", async () => {
    const paths: string[] = [];
    const baseUrl = await serveBucket({ status: 200, body: TRANSFER_TRUE }, paths);
    stubChainReads([]);

    const outcome = await fetchAttestedRespondOutcome(
      contextWithCache(baseUrl),
      REQUEST_ID,
      OutputSource.MPCCache,
      OUTPUT_SCHEMA,
    );

    expect(outcome).toBeUndefined();
    expect(paths).toEqual([]);
  });

  it("refuses a context configured without a cache", async () => {
    stubChainReads([attest(OutputKind.executed, TRANSFER_TRUE)]);

    await expect(
      fetchAttestedRespondOutcome(
        contextWithCache(undefined),
        REQUEST_ID,
        OutputSource.MPCCache,
        OUTPUT_SCHEMA,
      ),
    ).rejects.toThrow("mpc-cache needs MPC_OUTPUT_CACHE_URL set");
  });
});

// The ERC20 transfer's traced return data: one ABI word holding `true`, which
// the vault's schemas pack to TRANSFER_TRUE.
const TRANSFER_TRUE_TRACE: EvmTraceOutput = {
  kind: EvmTraceOutputKind.Output,
  returnData: `0x${"00".repeat(31)}01`,
};

// A plain transfer's trace: the top frame carries no output.
const PLAIN_TRANSFER_TRACE: EvmTraceOutput = { kind: EvmTraceOutputKind.NoReturnData };

/** An observation of {@link REQUEST_ID}'s execution, as the trace stand-in reports it. */
function observation(
  success: boolean,
  isContractCall: boolean,
  trace: EvmTraceOutput | null,
): ObservedExecution {
  return {
    requestId: REQUEST_ID,
    success,
    isContractCall,
    trace,
    txHash: `0x${"11".repeat(32)}`,
    blockNumber: BLOCK_HEIGHT,
  };
}

describe("fetchAttestedRespondOutcome under OutputSource.EVMNode", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("checks a failure post over the empty output without observing the execution", async () => {
    const observe = vi.spyOn(observedModule, "observeExecution");
    const event = attest(OutputKind.failed, EMPTY_OUTPUT);
    stubChainReads([event]);

    const outcome = await fetchAttestedRespondOutcome(
      contextWithCache(undefined),
      REQUEST_ID,
      OutputSource.EVMNode,
      OUTPUT_SCHEMA,
    );

    expect(outcome).toEqual({ event, serializedOutput: EMPTY_OUTPUT, succeeded: false });
    expect(observe).not.toHaveBeenCalled();
  });

  it("recomputes an executed post's output from the observed trace", async () => {
    vi.spyOn(observedModule, "observeExecution").mockResolvedValue(
      observation(true, true, TRANSFER_TRUE_TRACE),
    );
    const event = attest(OutputKind.executed, TRANSFER_TRUE);
    stubChainReads([event]);

    const outcome = await fetchAttestedRespondOutcome(
      contextWithCache(undefined),
      REQUEST_ID,
      OutputSource.EVMNode,
      OUTPUT_SCHEMA,
    );

    expect(outcome).toEqual({ event, serializedOutput: TRANSFER_TRUE, succeeded: true });
  });

  it("recomputes an executed nonce replacement's empty output from a plain transfer's trace", async () => {
    vi.spyOn(observedModule, "observeExecution").mockResolvedValue(
      observation(true, false, PLAIN_TRANSFER_TRACE),
    );
    const event = attest(OutputKind.executed, EMPTY_OUTPUT);
    stubChainReads([event]);

    const outcome = await fetchAttestedRespondOutcome(
      contextWithCache(undefined),
      REQUEST_ID,
      OutputSource.EVMNode,
      REPLACE_NONCE_OUTPUT_SCHEMA,
    );

    expect(outcome).toEqual({ event, serializedOutput: EMPTY_OUTPUT, succeeded: true });
  });

  it("yields no executed candidate when a plain transfer's trace meets the bool schema", async () => {
    // The MPC refuses to attest such a request's execution at all, so a post
    // declaring it executed can only be forged: the decode failure drops the
    // candidate and the post fails to verify.
    vi.spyOn(observedModule, "observeExecution").mockResolvedValue(
      observation(true, false, PLAIN_TRANSFER_TRACE),
    );
    stubChainReads([attest(OutputKind.executed, TRANSFER_TRUE)]);
    const progress = new PollProgress("test", 1000);

    const outcome = await fetchAttestedRespondOutcome(
      contextWithCache(undefined),
      REQUEST_ID,
      OutputSource.EVMNode,
      OUTPUT_SCHEMA,
      undefined,
      progress,
    );

    expect(outcome).toBeUndefined();
    expect(progress.summary()).toContain(
      "no signature verifies against the vault response key and the evm-node output",
    );
  });

  it("still verifies a failure post while the executed post's observation fails", async () => {
    const observe = vi
      .spyOn(observedModule, "observeExecution")
      .mockRejectedValue(new Error("trace timed out"));
    const failure = attest(OutputKind.failed, EMPTY_OUTPUT);
    stubChainReads([attest(OutputKind.executed, TRANSFER_TRUE), failure]);

    const outcome = await fetchAttestedRespondOutcome(
      contextWithCache(undefined),
      REQUEST_ID,
      OutputSource.EVMNode,
      OUTPUT_SCHEMA,
    );

    expect(outcome).toEqual({ event: failure, serializedOutput: EMPTY_OUTPUT, succeeded: false });
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("rejects an executed post when the observation reports a revert", async () => {
    vi.spyOn(observedModule, "observeExecution").mockResolvedValue(observation(false, true, null));
    stubChainReads([attest(OutputKind.executed, TRANSFER_TRUE)]);
    const progress = new PollProgress("test", 1000);

    const outcome = await fetchAttestedRespondOutcome(
      contextWithCache(undefined),
      REQUEST_ID,
      OutputSource.EVMNode,
      OUTPUT_SCHEMA,
      undefined,
      progress,
    );

    expect(outcome).toBeUndefined();
    expect(progress.summary()).toContain(
      "no signature verifies against the vault response key and the evm-node output",
    );
  });

  it("observes the execution and reads the response key once across a memoised poll", async () => {
    const observe = vi
      .spyOn(observedModule, "observeExecution")
      .mockResolvedValue(observation(true, true, TRANSFER_TRUE_TRACE));
    const event = attest(OutputKind.executed, TRANSFER_TRUE);
    stubChainReads([event]);
    const context = contextWithCache(undefined);
    const memo = new RespondPollMemo(contextModule.createResponseReader(context, undefined));

    for (let tick = 0; tick < 3; tick += 1) {
      expect(
        await fetchAttestedRespondOutcome(
          context,
          REQUEST_ID,
          OutputSource.EVMNode,
          OUTPUT_SCHEMA,
          undefined,
          undefined,
          memo,
        ),
      ).toEqual({ event, serializedOutput: TRANSFER_TRUE, succeeded: true });
    }

    expect(observe).toHaveBeenCalledTimes(1);
    expect(vaultContract.readVaultLedger).toHaveBeenCalledTimes(1);
  });
});

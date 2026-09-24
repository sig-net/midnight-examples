// Offline unit tests of the attested-outcome resolution under
// OutputSource.MPCCache: an in-process HTTP server stands in for the MPC's
// output cache, a locally signed attestation for the MPC's post, and the
// vault's ledger read is stubbed to the matching response key. No stack, no
// env gate: these run in every `yarn test`.

import { createServer, type Server } from "node:http";

import {
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
import { fetchAttestedRespondOutcome } from "../src/flows/respond-output.ts";
import { ERC20_TRANSFER_RESULT_SCHEMA } from "../src/mpc-routing.ts";
import { OutputSource } from "../src/output-source.ts";
import { PollProgress } from "../src/poll-progress.ts";
import * as contextModule from "../src/vault-context.ts";

const REQUEST_ID = parseRequestIdHex("ab".repeat(32));
const NETWORK_ID = "undeployed";
const SIGNET_CONTRACT_ADDRESS = "cd".repeat(32);
const EXPECTED_OBJECT_PATH = `/v1/test/${NETWORK_ID}/${SIGNET_CONTRACT_ADDRESS}/${REQUEST_ID}.bin`;
// The key the vault pinned at initialise, here held locally so the test can
// post attestations the way the MPC does.
const MPC_RESPONSE_SECRET = new Uint8Array(32).fill(7);
const MPC_RESPONSE_KEY = secp256k1PublicKeyOf(MPC_RESPONSE_SECRET);
// The vault's transfer schema in both directions, as its request records carry it.
const SCHEMAS = {
  outputDeserializationSchema: ERC20_TRANSFER_RESULT_SCHEMA,
  respondSerializationSchema: ERC20_TRANSFER_RESULT_SCHEMA,
};
// This suite plays the MPC, so the attested destination height is whatever
// it claims: the check is that the height is signed, not that it is real.
const BLOCK_HEIGHT = 77n;
const TRANSFER_TRUE = new Uint8Array([0x01]);
const TRANSFER_FALSE = new Uint8Array([0x00]);

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
    // The ledger read is stubbed, so the provider is never consulted.
    providers: { publicDataProvider: {} } as VaultProviders,
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
      outputKind: OutputKind.executed,
      cached: TRANSFER_TRUE,
      succeeded: true,
    },
    {
      name: "a transfer that returned false",
      outputKind: OutputKind.executed,
      cached: TRANSFER_FALSE,
      succeeded: false,
    },
    {
      name: "a reverted transfer (failed, empty output)",
      outputKind: OutputKind.failed,
      cached: EMPTY_OUTPUT,
      succeeded: false,
    },
    {
      name: "a transfer whose nonce another transaction took (unviable, empty output)",
      outputKind: OutputKind.unviable,
      cached: EMPTY_OUTPUT,
      succeeded: false,
    },
  ])(
    "resolves $name from the cached bytes the attestation signs",
    async ({ outputKind, cached, succeeded }) => {
      const paths: string[] = [];
      const baseUrl = await serveBucket({ status: 200, body: cached }, paths);
      const event = attest(outputKind, cached);
      stubChainReads([event]);

      const outcome = await fetchAttestedRespondOutcome(
        contextWithCache(baseUrl),
        REQUEST_ID,
        OutputSource.MPCCache,
        SCHEMAS,
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
      SCHEMAS,
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
      SCHEMAS,
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
      SCHEMAS,
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
      SCHEMAS,
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
        SCHEMAS,
      ),
    ).rejects.toThrow("mpc-cache needs MPC_OUTPUT_CACHE_URL set");
  });
});

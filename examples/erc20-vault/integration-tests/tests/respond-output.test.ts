// Offline unit tests of the attested-outcome resolution under
// OutputSource.MPCCache: an in-process HTTP server stands in for the MPC's
// output cache, a locally signed attestation for the MPC's post, and the
// vault's ledger read is stubbed to the matching response key. No stack, no
// env gate: these run in every `yarn test`.

import { createServer, type Server } from "node:http";

import {
  type AttestedOutput,
  encodeAttestedOutput,
  MPC_FAILURE_OUTPUT,
  MpcOutputCacheReader,
  parseRequestIdHex,
  requestIdBytes,
  type RespondBidirectionalEvent,
  type SignetRequestResponseReader,
} from "@sig-net/midnight";
import {
  calculateSignetAttestationDigest,
  ecdsaSignatureToMpcSignature,
  secp256k1PublicKeyOf,
  signAttestationDigest,
} from "@sig-net/midnight/testing";
import type { VaultProviders } from "@sig-net/midnight-examples-erc20-vault-contract";
import * as vaultContract from "@sig-net/midnight-examples-erc20-vault-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const BLOCK_HEIGHT = 77n;
const TRANSFER_TRUE: AttestedOutput = {
  blockHeight: BLOCK_HEIGHT,
  serializedOutput: new Uint8Array([0x01]),
};
const TRANSFER_FALSE: AttestedOutput = {
  blockHeight: BLOCK_HEIGHT,
  serializedOutput: new Uint8Array([0x00]),
};
const TRANSFER_FAILED: AttestedOutput = {
  blockHeight: BLOCK_HEIGHT,
  serializedOutput: MPC_FAILURE_OUTPUT,
};

/** An MPC post attesting `attested` for {@link REQUEST_ID} under the pinned key. */
function attest(attested: AttestedOutput): RespondBidirectionalEvent {
  return {
    signature: ecdsaSignatureToMpcSignature(
      signAttestationDigest(
        calculateSignetAttestationDigest(
          requestIdBytes(REQUEST_ID),
          attested.blockHeight,
          attested.serializedOutput,
        ),
        MPC_RESPONSE_SECRET,
      ),
    ),
  };
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
      cached: TRANSFER_TRUE,
      expected: { succeeded: true, matchedFailureOutput: false },
    },
    {
      name: "a transfer that returned false",
      cached: TRANSFER_FALSE,
      expected: { succeeded: false, matchedFailureOutput: false },
    },
    {
      name: "the MPC failure output",
      cached: TRANSFER_FAILED,
      expected: { succeeded: false, matchedFailureOutput: true },
    },
  ])("resolves $name from the cached bytes the attestation signs", async ({ cached, expected }) => {
    const paths: string[] = [];
    const baseUrl = await serveBucket({ status: 200, body: encodeAttestedOutput(cached) }, paths);
    const event = attest(cached);
    stubChainReads([event]);

    const outcome = await fetchAttestedRespondOutcome(
      contextWithCache(baseUrl),
      REQUEST_ID,
      OutputSource.MPCCache,
      SCHEMAS,
    );

    expect(outcome).toEqual({ event, ...cached, ...expected });
    expect(paths).toEqual([EXPECTED_OBJECT_PATH]);
  });

  it("rejects a post whose signature covers other bytes than the cache holds", async () => {
    const baseUrl = await serveBucket(
      { status: 200, body: encodeAttestedOutput(TRANSFER_TRUE) },
      [],
    );
    stubChainReads([attest(TRANSFER_FALSE)]);
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
    stubChainReads([attest(TRANSFER_TRUE)]);
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
    const baseUrl = await serveBucket(
      { status: 200, body: encodeAttestedOutput(TRANSFER_TRUE) },
      paths,
    );
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
    stubChainReads([attest(TRANSFER_TRUE)]);

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

// Offline unit tests of the debug_traceTransaction preflight, against an
// in-process HTTP server answering the probe with a canned reply. No stack,
// no env gate: these run in every `yarn test`.

import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { assertDebugTraceAvailable } from "../src/observed-execution.ts";

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

/** Start a server that answers every request with `status` and `body`, returning its URL. */
async function serveReply(status: number, body: string): Promise<string> {
  const started = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  });
  server = started;
  await new Promise<void>((resolve) => started.listen(0, "127.0.0.1", resolve));
  const address = started.address();
  if (address === null || typeof address === "string") {
    throw new Error("the probe server has no TCP address");
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

describe("assertDebugTraceAvailable", () => {
  /** A canned reply to the zero-hash probe. */
  interface ProbeReply {
    readonly name: string;
    readonly status: number;
    readonly body: string;
  }

  const SERVED: readonly ProbeReply[] = [
    {
      name: "a callTracer frame",
      status: 200,
      body: '{"jsonrpc":"2.0","id":1,"result":{"from":"0x00","to":"0x01","input":"0x","type":"CALL"}}',
    },
    {
      // anvil 1.5.1's verbatim answer to a trace of an unknown hash.
      name: "anvil's empty struct log for an unknown hash",
      status: 200,
      body: '{"jsonrpc":"2.0","id":1,"result":{"failed":false,"gas":0,"returnValue":"0x","structLogs":[]}}',
    },
    {
      name: "a transaction-not-found error",
      status: 200,
      body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"transaction not found"}}',
    },
  ];

  it.each(SERVED)("accepts $name", async ({ status, body }) => {
    const url = await serveReply(status, body);
    await expect(assertDebugTraceAvailable(url)).resolves.toBeUndefined();
  });

  /** A canned reply the preflight must refuse, and the refusal it must raise. */
  interface RefusedReply extends ProbeReply {
    readonly rejects: RegExp;
  }

  const REFUSED: readonly RefusedReply[] = [
    {
      name: "the method-not-found code",
      status: 200,
      body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}',
      rejects: /does not serve debug_traceTransaction/,
    },
    {
      name: "a hosted provider's tier gate",
      status: 200,
      body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"debug_traceTransaction is not available on the free tier"}}',
      rejects: /does not serve debug_traceTransaction/,
    },
    {
      name: "a non-JSON refusal",
      status: 403,
      body: "forbidden",
      rejects: /HTTP 403 and no JSON-RPC reply: forbidden/,
    },
  ];

  it.each(REFUSED)("refuses $name", async ({ status, body, rejects }) => {
    const url = await serveReply(status, body);
    await expect(assertDebugTraceAvailable(url)).rejects.toThrow(rejects);
  });

  it("names an endpoint that does not answer", async () => {
    const url = await serveReply(200, "{}");
    await new Promise<void>((resolve) => {
      server?.close(() => {
        resolve();
      });
    });
    server = undefined;
    await expect(assertDebugTraceAvailable(url)).rejects.toThrow(
      /is not answering a debug_traceTransaction probe/,
    );
  });
});

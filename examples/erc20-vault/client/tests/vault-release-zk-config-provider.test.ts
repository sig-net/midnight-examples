// The lazy prover-key path, driven end to end against a temporary managed
// directory, a temporary cache and a fake release: a real download would cost
// ~14 MB and a network. What is locked here is the order (disk, then cache,
// then release), that verified-against-the-manifest is not skippable, and that
// nothing unverifiable ever reaches the cache.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { VaultReleaseZkConfigProvider } from "../src/vault-release-zk-config-provider.ts";

const CIRCUIT_ID = "startDeposit";
const RELEASE_VERSION = "1.2.3";
const WORKSPACE_VERSION = "0.0.0";
const ASSET_URL =
  "https://github.com/sig-net/midnight-examples/releases/download/erc20-vault-v1.2.3/startDeposit.prover";

const PROVER_KEY_BYTES = new Uint8Array([0x70, 0x72, 0x6f, 0x76, 0x65, 0x72]);
const TAMPERED_BYTES = new Uint8Array([0x74, 0x61, 0x6d, 0x70, 0x65, 0x72]);
const VERIFIER_KEY_BYTES = new Uint8Array([0x76, 0x65, 0x72, 0x69, 0x66, 0x79]);
const ZKIR_BYTES = new Uint8Array([0x7a, 0x6b, 0x69, 0x72]);

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestEntry(bytes: Uint8Array): { type: string; size: number; hash: string } {
  return { type: "file", size: bytes.length, hash: sha256Hex(bytes) };
}

// A compactc manifest cut down to the one circuit these tests prove. `withdraw`
// is deliberately absent: it is a real vault circuit, so asking for it exercises
// the manifest gate with a well-typed circuit id.
function manifestJson(): string {
  return JSON.stringify({
    "manifest-version": "1",
    keys: {
      type: "directory",
      [`${CIRCUIT_ID}.prover`]: manifestEntry(PROVER_KEY_BYTES),
      [`${CIRCUIT_ID}.verifier`]: manifestEntry(VERIFIER_KEY_BYTES),
    },
    zkir: {
      type: "directory",
      [`${CIRCUIT_ID}.bzkir`]: manifestEntry(ZKIR_BYTES),
    },
  });
}

/** What the fake release serves when the asset URL is requested. */
type ReleaseAsset = { readonly bytes: Uint8Array } | { readonly status: number };

const temporaryDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface Harness {
  readonly provider: VaultReleaseZkConfigProvider;
  readonly fetchedUrls: readonly string[];
  /** Where a downloaded key lands, so a test can read it back or assert its absence. */
  readonly cacheFile: string;
}

interface HarnessOptions {
  readonly version: string;
  readonly onDisk?: Uint8Array;
  readonly inCache?: Uint8Array;
  readonly asset?: ReleaseAsset;
}

async function setUpProvider(options: HarnessOptions): Promise<Harness> {
  // The provider narrates its downloads and cache decisions, which would bury
  // the suite's own output. Restored in afterEach.
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const directory = await mkdtemp(join(tmpdir(), "vault-managed-"));
  const cacheDir = await mkdtemp(join(tmpdir(), "vault-key-cache-"));
  temporaryDirs.push(directory, cacheDir);

  await mkdir(join(directory, "compiler"));
  await writeFile(join(directory, "compiler", "contract-manifest.json"), manifestJson());
  await mkdir(join(directory, "keys"));
  await writeFile(join(directory, "keys", `${CIRCUIT_ID}.verifier`), VERIFIER_KEY_BYTES);
  await mkdir(join(directory, "zkir"));
  await writeFile(join(directory, "zkir", `${CIRCUIT_ID}.bzkir`), ZKIR_BYTES);
  if (options.onDisk !== undefined) {
    await writeFile(join(directory, "keys", `${CIRCUIT_ID}.prover`), options.onDisk);
  }

  const cacheFile = join(cacheDir, options.version, `${CIRCUIT_ID}.prover`);
  if (options.inCache !== undefined) {
    await mkdir(join(cacheDir, options.version), { recursive: true });
    await writeFile(cacheFile, options.inCache);
  }

  const fetchedUrls: string[] = [];
  const fetchFn: typeof fetch = (input) => {
    fetchedUrls.push(requestedUrl(input));
    const { asset } = options;
    if (asset === undefined) {
      throw new Error("the fake release was asked for an asset this case does not serve");
    }
    return Promise.resolve(
      "bytes" in asset
        ? new Response(asset.bytes, { status: 200 })
        : new Response("not found", { status: asset.status, statusText: "Not Found" }),
    );
  };

  return {
    provider: new VaultReleaseZkConfigProvider({
      directory,
      version: options.version,
      cacheDir,
      fetchFn,
    }),
    fetchedUrls,
    cacheFile,
  };
}

function requestedUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

async function readIfPresent(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return undefined;
  }
}

describe("VaultReleaseZkConfigProvider", () => {
  interface ResolveCase extends HarnessOptions {
    readonly name: string;
    readonly expectedFetches: readonly string[];
    readonly expectedCacheEntry: Uint8Array | undefined;
  }

  // The key is the same bytes in every row, whichever source served it.
  it.each<ResolveCase>([
    {
      name: "reads the key off disk without touching the release",
      version: RELEASE_VERSION,
      onDisk: PROVER_KEY_BYTES,
      expectedFetches: [],
      expectedCacheEntry: undefined,
    },
    {
      name: "reads the key off disk at the workspace version, which has no release",
      version: WORKSPACE_VERSION,
      onDisk: PROVER_KEY_BYTES,
      expectedFetches: [],
      expectedCacheEntry: undefined,
    },
    {
      name: "serves a cached download without downloading again",
      version: RELEASE_VERSION,
      inCache: PROVER_KEY_BYTES,
      expectedFetches: [],
      expectedCacheEntry: PROVER_KEY_BYTES,
    },
    {
      name: "downloads the release asset and caches it when disk and cache both miss",
      version: RELEASE_VERSION,
      asset: { bytes: PROVER_KEY_BYTES },
      expectedFetches: [ASSET_URL],
      expectedCacheEntry: PROVER_KEY_BYTES,
    },
  ])("$name", async (testCase) => {
    const { provider, fetchedUrls, cacheFile } = await setUpProvider(testCase);

    const proverKey = await provider.getProverKey(CIRCUIT_ID);

    expect(new Uint8Array(proverKey)).toEqual(PROVER_KEY_BYTES);
    expect(fetchedUrls).toEqual(testCase.expectedFetches);
    expect(await readIfPresent(cacheFile)).toEqual(testCase.expectedCacheEntry);
  });

  interface RejectCase extends HarnessOptions {
    readonly name: string;
    readonly circuitId: "startDeposit" | "startWithdraw";
    readonly expectedMessage: RegExp;
    readonly expectedFetches: readonly string[];
  }

  // Every row must also leave the cache empty: an unverified or absent key is
  // never worth keeping.
  it.each<RejectCase>([
    {
      name: "rejects a download whose bytes do not match the manifest",
      version: RELEASE_VERSION,
      circuitId: CIRCUIT_ID,
      asset: { bytes: TAMPERED_BYTES },
      expectedMessage: /failed integrity verification/,
      expectedFetches: [ASSET_URL],
    },
    {
      name: "rejects a missing release asset, naming the URL it asked for",
      version: RELEASE_VERSION,
      circuitId: CIRCUIT_ID,
      asset: { status: 404 },
      expectedMessage: new RegExp(ASSET_URL.replace(/[.]/g, "\\.")),
      expectedFetches: [ASSET_URL],
    },
    {
      name: "rejects at the workspace version with no key on disk, naming the compile script",
      version: WORKSPACE_VERSION,
      circuitId: CIRCUIT_ID,
      expectedMessage: /yarn compile:erc20-vault:zk/,
      expectedFetches: [],
    },
    {
      name: "rejects a circuit the manifest does not list, without asking the release",
      version: RELEASE_VERSION,
      circuitId: "startWithdraw",
      expectedMessage: /not in the vault's ZK artifact manifest/,
      expectedFetches: [],
    },
  ])("$name", async (testCase) => {
    const { provider, fetchedUrls, cacheFile } = await setUpProvider(testCase);

    await expect(provider.getProverKey(testCase.circuitId)).rejects.toThrow(
      testCase.expectedMessage,
    );

    expect(fetchedUrls).toEqual(testCase.expectedFetches);
    expect(await readIfPresent(cacheFile)).toBeUndefined();
  });

  it("discards a cache entry that no longer matches the manifest and downloads a fresh one", async () => {
    const { provider, fetchedUrls, cacheFile } = await setUpProvider({
      version: RELEASE_VERSION,
      inCache: TAMPERED_BYTES,
      asset: { bytes: PROVER_KEY_BYTES },
    });

    const proverKey = await provider.getProverKey(CIRCUIT_ID);

    expect(new Uint8Array(proverKey)).toEqual(PROVER_KEY_BYTES);
    expect(fetchedUrls).toEqual([ASSET_URL]);
    expect(await readIfPresent(cacheFile)).toEqual(PROVER_KEY_BYTES);
  });

  it("shares one download between concurrent calls for the same circuit", async () => {
    const { provider, fetchedUrls } = await setUpProvider({
      version: RELEASE_VERSION,
      asset: { bytes: PROVER_KEY_BYTES },
    });

    const [first, second] = await Promise.all([
      provider.getProverKey(CIRCUIT_ID),
      provider.getProverKey(CIRCUIT_ID),
    ]);

    expect(new Uint8Array(first)).toEqual(PROVER_KEY_BYTES);
    expect(new Uint8Array(second)).toEqual(PROVER_KEY_BYTES);
    expect(fetchedUrls).toEqual([ASSET_URL]);
  });

  it("reads the verifier key and the zkir from the directory, never from the release", async () => {
    const { provider, fetchedUrls } = await setUpProvider({ version: RELEASE_VERSION });

    const verifierKey = await provider.getVerifierKey(CIRCUIT_ID);
    const zkir = await provider.getZKIR(CIRCUIT_ID);

    expect(new Uint8Array(verifierKey)).toEqual(VERIFIER_KEY_BYTES);
    expect(new Uint8Array(zkir)).toEqual(ZKIR_BYTES);
    expect(fetchedUrls).toEqual([]);
  });
});

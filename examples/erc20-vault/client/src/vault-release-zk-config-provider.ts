// Prover keys are the one compiled artifact the published contract package does
// not carry: the vault's 14 circuits hold roughly 1.1 GB of them, so they are
// published as GitHub Release assets on the example's version tag and fetched
// here, one circuit at a time, the first time a proof needs one. Verifier keys,
// zkir and the compact integrity manifest all ship inside the package, so
// everything except proving stays offline, and every downloaded byte is checked
// against the manifest npm delivered with provenance.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  createProverKey,
  type ProverKey,
  type VerifierKey,
  ZKConfigProvider,
  type ZKIR,
} from "@midnight-ntwrk/midnight-js/types";
import {
  parseZkArtifactManifest,
  verifyZkArtifactIntegrity,
  ZK_MANIFEST_DIR,
  ZK_MANIFEST_FILE_NAME,
  type ZkArtifactManifest,
} from "@midnight-ntwrk/midnight-js/utils";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import type { VaultCircuitId } from "@sig-net/midnight-examples-erc20-vault-contract";

import { VAULT_CONTRACT_PACKAGE_VERSION, VAULT_MANAGED_PATH } from "./vault-contract-binding.ts";

const RELEASE_DOWNLOAD_BASE_URL = "https://github.com/sig-net/midnight-examples/releases/download";
const RELEASE_TAG_PREFIX = "erc20-vault-v";
/** The version every workspace member carries between releases, which has no release tag. */
const WORKSPACE_VERSION = "0.0.0";
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(-rc\.\d+)?$/;
const PROVER_KEY_DIR = "keys";
const PROVER_KEY_EXTENSION = ".prover";
// A prover key is upwards of 100 MB, so a download that says nothing reads as a
// stalled proof. Every line the provider writes carries this prefix, since it
// lands in the middle of whatever else the deploy or test run is printing.
const LOG_PREFIX = "[erc20-vault zk]";

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function defaultCacheDir(): string {
  const xdgCacheHome = process.env.XDG_CACHE_HOME;
  const base =
    xdgCacheHome === undefined || xdgCacheHome === "" ? join(homedir(), ".cache") : xdgCacheHome;
  return join(base, "sig-net-midnight-examples", "erc20-vault");
}

/** Constructor options for {@link VaultReleaseZkConfigProvider}. All of them have defaults. */
export interface VaultReleaseZkConfigProviderOptions {
  /** Compiler-output directory holding `keys/`, `zkir/` and `compiler/`. Defaults to the contract package's own. */
  readonly directory?: string;
  /** Version whose release tag carries the prover-key assets. Defaults to the contract package's version. */
  readonly version?: string;
  /** Directory downloaded keys are cached in, one subdirectory per version. Defaults under `$XDG_CACHE_HOME` or `~/.cache`. */
  readonly cacheDir?: string;
  /** Fetch implementation used for the download. Defaults to the global one. */
  readonly fetchFn?: typeof fetch;
}

/**
 * ZK config provider for the vault whose prover keys come from the GitHub
 * Release cut for the contract package's version, while verifier keys and zkir
 * are read from the package's compiler output on disk.
 *
 * `getProverKey` is disk-first: a workspace checkout that has run
 * `yarn compile:erc20-vault:zk` serves its freshly built keys and never reaches
 * the network. Only a genuinely absent key falls through to the cache, and then
 * to the release asset. Downloaded bytes are verified against the shipped
 * `compiler/contract-manifest.json` before they are used or cached, so a
 * substituted asset cannot be proved with.
 *
 * Use it for every deployed network. The local standalone stack keeps a plain
 * `NodeZkConfigProvider`, whose keys are always the ones just compiled.
 */
export class VaultReleaseZkConfigProvider extends ZKConfigProvider<VaultCircuitId> {
  private readonly directory: string;
  private readonly version: string;
  private readonly cacheDir: string;
  private readonly fetchFn: typeof fetch;
  private readonly localProvider: NodeZkConfigProvider<VaultCircuitId>;
  /** One download per circuit: concurrent proofs of the same circuit await the same promise. */
  private readonly inFlightDownloads = new Map<VaultCircuitId, Promise<ProverKey>>();
  private manifestPromise: Promise<ZkArtifactManifest> | undefined;

  /**
   * @param options - Overrides for the directory, version, cache location and fetch implementation.
   */
  constructor(options: VaultReleaseZkConfigProviderOptions = {}) {
    super();
    this.directory = options.directory ?? VAULT_MANAGED_PATH;
    this.version = options.version ?? VAULT_CONTRACT_PACKAGE_VERSION;
    this.cacheDir = options.cacheDir ?? defaultCacheDir();
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.localProvider = new NodeZkConfigProvider<VaultCircuitId>(this.directory);
  }

  /**
   * The circuit's prover key, from disk, from the download cache, or from the
   * release asset, in that order.
   *
   * @param circuitId - The circuit to prove.
   * @returns The verified prover key.
   * @throws {Error} If the manifest is missing, if the circuit has no prover key in it, if the version has no release, or if the download or its verification fails.
   */
  async getProverKey(circuitId: VaultCircuitId): Promise<ProverKey> {
    const fromDisk = await this.readLocalProverKey(circuitId);
    if (fromDisk !== undefined) {
      return fromDisk;
    }

    const inFlight = this.inFlightDownloads.get(circuitId);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const download = this.resolveProverKeyFromRelease(circuitId).finally(() => {
      this.inFlightDownloads.delete(circuitId);
    });
    this.inFlightDownloads.set(circuitId, download);
    return download;
  }

  /**
   * The circuit's verifier key, which the package always ships.
   *
   * @param circuitId - The circuit whose verifier key is wanted.
   * @returns The verifier key read from {@link VaultReleaseZkConfigProviderOptions.directory}.
   */
  async getVerifierKey(circuitId: VaultCircuitId): Promise<VerifierKey> {
    return this.localProvider.getVerifierKey(circuitId);
  }

  /**
   * The circuit's zkir, which the package always ships.
   *
   * @param circuitId - The circuit whose zkir is wanted.
   * @returns The zkir read from {@link VaultReleaseZkConfigProviderOptions.directory}.
   */
  async getZKIR(circuitId: VaultCircuitId): Promise<ZKIR> {
    return this.localProvider.getZKIR(circuitId);
  }

  private async readLocalProverKey(circuitId: VaultCircuitId): Promise<ProverKey | undefined> {
    try {
      return await this.localProvider.getProverKey(circuitId);
    } catch (error) {
      // An absent key is the normal npm-installed case. Anything else (a
      // permission problem, a digest mismatch on a key that IS there) is a real
      // failure that a silent download would paper over.
      if (isFileNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async resolveProverKeyFromRelease(circuitId: VaultCircuitId): Promise<ProverKey> {
    const manifest = await this.loadManifest();
    const relativePath = `${PROVER_KEY_DIR}/${circuitId}${PROVER_KEY_EXTENSION}`;

    // The cross-contract proof provider probes a bare circuit name against every
    // provider in the call tree, so this provider is asked for circuits the
    // vault does not have. The manifest answers that without a round trip, and
    // it is also what keeps a foreign name out of the download URL.
    const manifestEntry = manifest.files.get(relativePath);
    if (manifestEntry === undefined) {
      throw new Error(
        `${relativePath} is not in the vault's ZK artifact manifest, so ${circuitId} is not one of its circuits`,
      );
    }

    if (this.version === WORKSPACE_VERSION) {
      throw new Error(
        `no prover key for ${circuitId} on disk and no release to download it from: the contract package is at the workspace version ${WORKSPACE_VERSION}. Run \`yarn compile:erc20-vault:zk\` to generate the keys locally.`,
      );
    }
    if (!RELEASE_VERSION_PATTERN.test(this.version)) {
      throw new Error(
        `the contract package version ${this.version} is not an X.Y.Z or X.Y.Z-rc.N release version, so it names no release tag`,
      );
    }

    const cacheFile = join(this.cacheDir, this.version, `${circuitId}${PROVER_KEY_EXTENSION}`);
    const cached = await this.readCachedProverKey(cacheFile, manifest, relativePath);
    if (cached !== undefined) {
      console.info(
        `${LOG_PREFIX} ${circuitId}: serving the prover key from the cache at ${cacheFile} (${String(cached.length)} bytes)`,
      );
      return createProverKey(cached);
    }

    const downloaded = await this.downloadProverKey(circuitId, manifestEntry.size);
    verifyZkArtifactIntegrity({ manifest, relativePath, bytes: downloaded, mode: "require" });
    await this.cacheProverKey(cacheFile, downloaded);
    return createProverKey(downloaded);
  }

  private loadManifest(): Promise<ZkArtifactManifest> {
    if (this.manifestPromise === undefined) {
      const promise = this.readManifest();
      this.manifestPromise = promise;
      // A failed read must not stick: the next call retries rather than
      // replaying the same rejection forever.
      promise.catch(() => {
        if (this.manifestPromise === promise) {
          this.manifestPromise = undefined;
        }
      });
    }
    return this.manifestPromise;
  }

  private async readManifest(): Promise<ZkArtifactManifest> {
    const manifestPath = join(this.directory, ZK_MANIFEST_DIR, ZK_MANIFEST_FILE_NAME);
    let rawManifest: string;
    try {
      rawManifest = await readFile(manifestPath, "utf8");
    } catch (error) {
      if (isFileNotFoundError(error)) {
        throw new Error(
          `no ZK artifact manifest at ${manifestPath}: downloaded prover keys are verified against it, so proving cannot proceed without it`,
          { cause: error },
        );
      }
      throw error;
    }
    return parseZkArtifactManifest(rawManifest);
  }

  private async readCachedProverKey(
    cacheFile: string,
    manifest: ZkArtifactManifest,
    relativePath: string,
  ): Promise<Uint8Array | undefined> {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(cacheFile);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }

    try {
      verifyZkArtifactIntegrity({ manifest, relativePath, bytes, mode: "require" });
    } catch (error) {
      // A cache entry that no longer matches the manifest is worthless whatever
      // corrupted it, so drop it and let the download replace it.
      console.warn(
        `${LOG_PREFIX} discarding the cached prover key at ${cacheFile}, which no longer matches the manifest: ${String(error)}`,
      );
      await unlink(cacheFile).catch(() => undefined);
      return undefined;
    }
    return bytes;
  }

  private async downloadProverKey(
    circuitId: VaultCircuitId,
    expectedBytes: number,
  ): Promise<Uint8Array> {
    const tag = `${RELEASE_TAG_PREFIX}${this.version}`;
    const url = `${RELEASE_DOWNLOAD_BASE_URL}/${tag}/${circuitId}${PROVER_KEY_EXTENSION}`;
    console.info(
      `${LOG_PREFIX} ${circuitId}: downloading the prover key (${String(expectedBytes)} bytes) from ${url}`,
    );
    const startedAt = Date.now();
    const response = await this.fetchFn(url);
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(
          `no prover key asset for ${circuitId} on release ${tag}: ${url} returned 404. Every circuit's key is uploaded when the tag is published, so a missing one means the release is incomplete.`,
        );
      }
      throw new Error(
        `downloading the prover key for ${circuitId} from ${url} failed: ${String(response.status)} ${response.statusText}`,
      );
    }
    // Timed around the body read, not just the headers: the wait an operator
    // notices is the megabytes streaming, which arrayBuffer is what waits for.
    const bytes = new Uint8Array(await response.arrayBuffer());
    console.info(
      `${LOG_PREFIX} ${circuitId}: prover key downloaded, ${String(bytes.length)} bytes in ${String(Date.now() - startedAt)} ms`,
    );
    return bytes;
  }

  private async cacheProverKey(cacheFile: string, bytes: Uint8Array): Promise<void> {
    // Written to a unique name and renamed into place: a rename is atomic, so a
    // concurrent reader sees either no entry or a complete one, never a partial
    // key that would fail verification.
    const temporaryFile = `${cacheFile}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(cacheFile), { recursive: true });
      await writeFile(temporaryFile, bytes);
      await rename(temporaryFile, cacheFile);
    } catch (error) {
      // The key is already in hand, so a cache that cannot be written costs a
      // download next time and nothing else.
      console.warn(
        `caching the prover key at ${cacheFile} failed, it will be downloaded again: ${String(error)}`,
      );
      await rm(temporaryFile, { force: true }).catch(() => undefined);
    }
  }
}

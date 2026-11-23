import { createHash } from "node:crypto";

import {
  bytesToHex,
  evmAddressAbiWord,
  numericAbiWord,
  tronAddressFromBase58,
  tronAddressFromEvm,
} from "@sig-net/midnight";
import { logSkip, requireEnv } from "@sig-net/midnight-examples-test-harness";
import { keccak256 } from "ethers";

import { resolveTronFunder } from "./tron-context.ts";
import {
  callTronContract,
  deployTronContract,
  type TronFunder,
  waitForTronTransaction,
} from "./tron-http.ts";

/** */
export const TRON_SWAP_POOL_FEE = 500n;

const TRON_TX_TIMEOUT_MS = 60_000;
const POOL_LIQUIDITY = 10n ** 12n;
const SQRT_PRICE_ONE_X96 = 2n ** 96n;
const FULL_RANGE_TICK = 887_270n;
const ZERO_WORD = "00".repeat(32);

const NILE_RPC_URL = "https://nile.trongrid.io";

const NILE_SUNSWAP = {
  UniswapV3Factory: {
    address: "TUTGcsGDRScK1gsDPMELV2QZxeESWb1Gac",
    constructorWords: 0,
    sha256: "2ffc74b388285664ef9f42a79439e6901b1a7426486c06e7797c15fd1d9e5f32",
  },
  SwapRouter: {
    address: "TFkswj6rUfK3cQtFGzungCkNXxD2UCpEVD",
    constructorWords: 2,
    sha256: "b62db1d4e843793e8a043ed556e09f4e2616186d1b77742870d1468e427ccb6d",
  },
  NonfungiblePositionManager: {
    address: "TPQzqHbCzQfoVdAV6bLwGDos8Lk2UjXz2R",
    constructorWords: 3,
    sha256: "271f06553f37f57d80dd7eb4106ee46e9068f44c19da28a76212370f99a4263c",
  },
} as const;

type SunswapContract = keyof typeof NILE_SUNSWAP;

const NILE_USDT = "eca9bc828a3005b9a3b909f2cc5c2a54794de05f";
const NILE_POOL_INIT_CODE_HASH = "bdafe9a36668104a2d371dedf31aac9583722f1b2c2fe98dde229f50a1e81689";
const POOL_INIT_CODE_IN_FACTORY = { start: 4726 * 2, end: 39922 * 2 };

function replaceOnce(code: string, from: string, to: string, what: string): string {
  if (code.split(from).length !== 2) {
    throw new Error(`expected ${what} exactly once in the SunSwap bytecode`);
  }
  return code.replace(from, to);
}

async function creationCodesFor(usdt: Uint8Array): Promise<Record<SunswapContract, string>> {
  const usdtHex = bytesToHex(usdt);
  const factory = replaceOnce(
    await creationCode("UniswapV3Factory"),
    NILE_USDT,
    usdtHex,
    "Nile USDT",
  );
  const poolInitCodeHash = keccak256(
    `0x${factory.slice(POOL_INIT_CODE_IN_FACTORY.start, POOL_INIT_CODE_IN_FACTORY.end)}`,
  ).slice(2);
  const periphery = async (contract: SunswapContract): Promise<string> =>
    replaceOnce(
      replaceOnce(await creationCode(contract), NILE_USDT, usdtHex, "Nile USDT"),
      NILE_POOL_INIT_CODE_HASH,
      poolInitCodeHash,
      "the pool init code hash",
    );
  return {
    UniswapV3Factory: factory,
    SwapRouter: await periphery("SwapRouter"),
    NonfungiblePositionManager: await periphery("NonfungiblePositionManager"),
  };
}

async function creationCode(contract: SunswapContract): Promise<string> {
  const source = NILE_SUNSWAP[contract];
  const response = await fetch(`${NILE_RPC_URL}/wallet/getcontract`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: source.address, visible: true }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Nile refused the ${contract} bytecode read: HTTP ${String(response.status)}`);
  }
  const { bytecode } = (await response.json()) as { bytecode?: string };
  if (bytecode === undefined) {
    throw new Error(`Nile returned no bytecode for ${contract} at ${source.address}`);
  }
  const code = bytecode.slice(0, bytecode.length - source.constructorWords * 64);
  if (createHash("sha256").update(code).digest("hex") !== source.sha256) {
    throw new Error(`the ${contract} bytecode on Nile at ${source.address} changed`);
  }
  return code;
}

const word = (value: bigint): string => bytesToHex(numericAbiWord(value));
const addressWord = (address: Uint8Array): string => bytesToHex(evmAddressAbiWord(address));
const int24Word = (value: bigint): string =>
  (value < 0n ? 2n ** 256n + value : value).toString(16).padStart(64, "0");

async function landed(rpcUrl: string, txid: Uint8Array, what: string): Promise<void> {
  const info = await waitForTronTransaction(rpcUrl, txid, TRON_TX_TIMEOUT_MS);
  if (info.receiptResult !== "SUCCESS") {
    throw new Error(`${what} ran ${info.receiptResult}`);
  }
}

async function deploy(
  rpcUrl: string,
  funder: TronFunder,
  contract: SunswapContract,
  code: string,
): Promise<Uint8Array> {
  const { address, txid } = await deployTronContract(rpcUrl, funder, contract, [], code);
  await landed(rpcUrl, txid, `the ${contract} deploy`);
  return address.slice(1);
}

const tokenBytes = (address: string): Uint8Array =>
  (address.startsWith("T") ? tronAddressFromBase58(address) : tronAddressFromEvm(address)).slice(1);

/**
 * @param env - The suite's env accumulator
 * @throws {Error} If a deploy or a pool call is refused or does not land
 */
export async function ensureSunswapRouter(env: NodeJS.ProcessEnv): Promise<void> {
  if (!env.TRON_RPC_URL) {
    logSkip("deploy SunSwap V3", "TRON_RPC_URL is unset: no Tron chain in this run");
    return;
  }
  if (env.TRON_SUNSWAP_ROUTER) {
    logSkip("deploy SunSwap V3", `TRON_SUNSWAP_ROUTER is set (${env.TRON_SUNSWAP_ROUTER})`);
    return;
  }
  const rpcUrl = env.TRON_RPC_URL;
  const funder = await resolveTronFunder(env);
  const usdt = tokenBytes(requireEnv(env, "TRON_USDT_ADDRESS"));
  const [token0, token1] = [tokenBytes(requireEnv(env, "TRC20_ADDRESS")), usdt].sort(
    (left, right) => (bytesToHex(left) < bytesToHex(right) ? -1 : 1),
  );
  if (token0 === undefined || token1 === undefined) {
    throw new Error("expected two test TRC-20s");
  }

  const codes = await creationCodesFor(usdt);
  const factory = await deploy(rpcUrl, funder, "UniswapV3Factory", codes.UniswapV3Factory);
  const immutables = addressWord(factory) + ZERO_WORD;
  const router = await deploy(rpcUrl, funder, "SwapRouter", codes.SwapRouter + immutables);
  const positions = await deploy(
    rpcUrl,
    funder,
    "NonfungiblePositionManager",
    codes.NonfungiblePositionManager + immutables + ZERO_WORD,
  );

  const positionsAddress = tronAddressFromEvm(`0x${bytesToHex(positions)}`);
  const pair = addressWord(token0) + addressWord(token1) + word(TRON_SWAP_POOL_FEE);
  await landed(
    rpcUrl,
    await callTronContract(
      rpcUrl,
      funder,
      positionsAddress,
      "createAndInitializePoolIfNecessary(address,address,uint24,uint160)",
      pair + word(SQRT_PRICE_ONE_X96),
    ),
    "the SunSwap pool creation",
  );
  for (const token of [token0, token1]) {
    await landed(
      rpcUrl,
      await callTronContract(
        rpcUrl,
        funder,
        tronAddressFromEvm(`0x${bytesToHex(token)}`),
        "approve(address,uint256)",
        addressWord(positions) + word(POOL_LIQUIDITY),
      ),
      "the liquidity approval",
    );
  }
  await landed(
    rpcUrl,
    await callTronContract(
      rpcUrl,
      funder,
      positionsAddress,
      "mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))",
      pair +
        int24Word(-FULL_RANGE_TICK) +
        int24Word(FULL_RANGE_TICK) +
        word(POOL_LIQUIDITY) +
        word(POOL_LIQUIDITY) +
        word(0n) +
        word(0n) +
        addressWord(funder.address.slice(1)) +
        word(2n ** 64n - 1n),
    ),
    "the SunSwap liquidity mint",
  );

  env.TRON_SUNSWAP_ROUTER = `0x${bytesToHex(router)}`;
  console.log(`deployed SunSwap V3 with TRON_SUNSWAP_ROUTER=${env.TRON_SUNSWAP_ROUTER}`);
}

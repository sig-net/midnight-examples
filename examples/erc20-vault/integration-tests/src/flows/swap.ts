// `swap`: record an exactInputSingle SignBidirectionalEvent on the vault's SWAP ledger map
// (field 11), surrendering the tokenIn vault coin (burned), to be signed with the VAULT's
// account and broadcast. On success completeSwap mints the attested amountOut of tokenOut;
// on EVM failure refund re-mints tokenIn. Mirrors the withdraw flow, with a swap-schema
// (uint256 amountOut) attestation. Runs only where Uniswap is deployed (Sepolia / the
// pinned Sepolia fork); logSkip elsewhere.
import {
  evmAddressAbiWord,
  hexToBytes,
  numericAbiWord,
  requestIdBytes,
  requestIdHex,
  stripHexPrefix,
  asciiPadded,
  PATH_BYTES,
  SIGNET_DEFAULT_KEY_VERSION,
  TxParamType,
  calculateRequestId,
  verifyRespondBidirectionalSignature,
  deserializeEvmOutput,
  serializeRespondOutput,
  toSignBidirectionalEventIndex,
  MPC_FAILURE_OUTPUT,
  type SignBidirectionalEvent,
  type RequestIdHex,
} from "@sig-net/midnight";

import { getTransactionNonce, logSkip } from "@midnight-examples/test-harness";
import { VAULT_SWAP_REQUESTS_PATH } from "@midnight-examples/erc20-vault-contract";

import { evmAddressBytes } from "../evm-transfer.ts";
import {
  EXACT_INPUT_SINGLE_SELECTOR,
  SWAP_GAS_LIMIT,
  SWAP_MAX_FEE_PER_GAS,
  SWAP_MAX_PRIORITY_FEE_PER_GAS,
  SWAP_MPC_ROUTING,
  SWAP_RESULT_SCHEMA,
  UNISWAP_SWAP_ROUTER_02,
  quoteExactInputSingle,
  uniswapAvailable,
} from "../evm-swap.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";
import { fetchFakenetResponse } from "../fakenet-responses.ts";
import { readVaultLedger } from "../vault-ledger.ts";
import { vaultTokenType } from "../vault-token.ts";
import type { VaultSession } from "../vault-session.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";
import { ensureRouterApproved } from "./approve.ts";

const MINUTE = 60_000;
const VAULT_PATH = asciiPadded("vault", PATH_BYTES);

/** Options for {@link swap}. */
export interface SwapOptions {
  readonly tokenOut: string;
  readonly fee: bigint;
  readonly amountIn: bigint;
  readonly amountOutMin: bigint;
  readonly evmNonce: bigint;
}

/** Record the swap request (exactInputSingle) and return its id. tokenIn = context.erc20Address. */
export async function swap(context: VaultContext, options: SwapOptions): Promise<RequestIdHex> {
  const tokenIn = evmAddressBytes(context.erc20Address);
  const tokenOut = evmAddressBytes(options.tokenOut);
  const before = await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);
  if (!before.initialized) throw new Error("vault is not initialized, run the initialize flow first");

  // Surrender the tokenIn vault coin of exactly amountIn (burned by the circuit).
  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: hexToBytes(vaultTokenType(context.erc20Address, context.vaultContractAddress)),
    value: options.amountIn,
  };

  // The record the contract composes: vault path/sender, router `to`, contract-fixed gas,
  // exactInputSingle((tokenIn, tokenOut, fee, recipient=vault, amountIn, amountOutMin, 0)).
  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    requestNonce: before.signetRequestNonce,
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: VAULT_PATH,
    ...SWAP_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    caip2Id: before.caip2Id,
    txParams: {
      to: evmAddressBytes(UNISWAP_SWAP_ROUTER_02),
      chainId: before.evmChainId,
      nonce: options.evmNonce,
      gasLimit: SWAP_GAS_LIMIT,
      maxFeePerGas: SWAP_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: SWAP_MAX_PRIORITY_FEE_PER_GAS,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
      calldata: {
        is_some: true,
        value: {
          selector: EXACT_INPUT_SINGLE_SELECTOR,
          noWords: 7n,
          words: [
            evmAddressAbiWord(tokenIn),
            evmAddressAbiWord(tokenOut),
            numericAbiWord(options.fee),
            evmAddressAbiWord(evmAddressBytes(context.evmVaultAddress)),
            numericAbiWord(options.amountIn),
            numericAbiWord(options.amountOutMin),
            numericAbiWord(0n),
          ],
        },
      },
    },
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));

  const result = await context.vault.callTx.swap(
    options.evmNonce,
    SIGNET_DEFAULT_KEY_VERSION,
    { tokenIn, tokenOut, fee: options.fee, amountIn: options.amountIn, amountOutMin: options.amountOutMin },
    coin,
  );
  console.log(`swap finalized in tx ${result.public.txId}`);

  const after = await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);
  if (!toSignBidirectionalEventIndex(after.swapEventMap).has(expectedIdHex)) {
    throw new Error(`recomputed swap request id ${expectedIdHex} not found on the swap ledger map`);
  }
  console.log(`swap request id:   ${expectedIdHex}`);
  return expectedIdHex;
}

/** The resolved attested outcome of a swap (uint256 amountOut, or the failure output). */
interface SwapOutcome {
  readonly event: Awaited<ReturnType<SignetReader["getRespondBidirectionalEvents"]>>[number];
  readonly serializedOutput: Uint8Array;
  readonly amountOut: bigint;
  readonly matchedFailureOutput: boolean;
}
type SignetReader = ReturnType<typeof createResponseReader>;

/**
 * Resolve the MPC's attested swap outcome by SIGNATURE VERIFICATION (the swap-schema twin of
 * the transfer flow's fetchAttestedRespondOutcome): the success candidate is the fakenet's
 * cached traced output decoded/re-packed per the uint256 schema; the failure candidate is
 * the protocol's fixed 5-byte output. The signature-only event carries no digest, so a
 * candidate is selected only when a posted event's ECDSA signature verifies over it against
 * the vault-pinned response key. Returns undefined until a matching attestation posts.
 */
async function fetchSwapOutcome(context: VaultContext, requestId: RequestIdHex): Promise<SwapOutcome | undefined> {
  const reader = createResponseReader(context, VAULT_SWAP_REQUESTS_PATH);
  const events = await reader.getRespondBidirectionalEvents(requestId);
  if (events.length === 0) return undefined;

  const { mpcResponseKey } = await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);

  const cached = await fetchFakenetResponse(requestId, 3_000).catch(() => undefined);
  const candidates: { serializedOutput: Uint8Array; amountOut: bigint; isFailureOutput: boolean }[] = [];
  if (cached?.success && cached.output != null) {
    try {
      const decoded = deserializeEvmOutput(SWAP_RESULT_SCHEMA, cached.output);
      candidates.push({
        serializedOutput: serializeRespondOutput(SWAP_RESULT_SCHEMA, decoded),
        amountOut: BigInt((decoded as { amountOut: bigint }).amountOut),
        isFailureOutput: false,
      });
    } catch {
      /* only the failure candidate can match */
    }
  }
  candidates.push({ serializedOutput: MPC_FAILURE_OUTPUT, amountOut: 0n, isFailureOutput: true });

  for (const c of candidates) {
    const event = events.find((posted) =>
      verifyRespondBidirectionalSignature(requestIdBytes(requestId), c.serializedOutput, posted, mpcResponseKey),
    );
    if (event) {
      return { event, serializedOutput: c.serializedOutput, amountOut: c.amountOut, matchedFailureOutput: c.isFailureOutput };
    }
  }
  return undefined;
}

/** Poll until the swap outcome resolves, then settle via completeSwap / refund. */
export async function completeSwap(context: VaultContext, requestId: RequestIdHex): Promise<{ amountOut: bigint; refunded: boolean }> {
  const end = Date.now() + 6 * MINUTE;
  let outcome: SwapOutcome | undefined;
  while (Date.now() < end && (outcome = await fetchSwapOutcome(context, requestId)) === undefined) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!outcome) throw new Error(`timed out waiting for a swap attestation for ${requestId}`);

  const mintNonce = crypto.getRandomValues(new Uint8Array(32));
  if (outcome.matchedFailureOutput) {
    console.log("swap tx never executed: refunding tokenIn to this wallet");
    const r = await context.vault.callTx.refund(requestIdBytes(requestId), outcome.event, outcome.serializedOutput, mintNonce);
    console.log(`refund settled in tx ${r.public.txId}`);
    return { amountOut: 0n, refunded: true };
  }
  const r = await context.vault.callTx.completeSwap(requestIdBytes(requestId), outcome.event, outcome.serializedOutput, mintNonce);
  console.log(`completeSwap settled in tx ${r.public.txId} (minted ${outcome.amountOut} tokenOut)`);
  return { amountOut: outcome.amountOut, refunded: false };
}

/** Options for {@link runSwapRoundTrip}. */
export interface SwapRoundTripOptions {
  readonly tokenOut: string;
  readonly fee: bigint;
  readonly amountIn: bigint;
  readonly slippageBps?: bigint;
  // Override the quoted slippage floor. An impossibly high value forces the router to revert
  // ("Too little received"), driving the refund path — used by the swap-refund e2e.
  readonly amountOutMin?: bigint;
}

/**
 * Full swap round trip against the live stack: ensure the router is approved for tokenIn,
 * quote minOut, submit the swap (vault-signed), poll the MPC signature, broadcast the swap
 * tx, poll the attestation, and settle (completeSwap mints tokenOut). Gated on Uniswap
 * being deployed on the EVM chain; logSkip otherwise. Requires the caller to already HOLD
 * amountIn of the tokenIn vault coin (run a deposit first).
 */
export async function runSwapRoundTrip(
  session: VaultSession,
  opts: SwapRoundTripOptions,
): Promise<{ requestId: RequestIdHex; amountOut: bigint; refunded: boolean } | undefined> {
  const context = await session.vaultContext();
  if (!(await uniswapAvailable(context.evmRpcUrl))) {
    logSkip("swap", "Uniswap router not deployed on this EVM chain (needs Sepolia or a Sepolia fork)");
    return undefined;
  }

  await ensureRouterApproved(session);

  const { amountOut: quoted, amountOutMin: quotedMin } = await quoteExactInputSingle(
    context.evmRpcUrl, context.erc20Address, opts.tokenOut, opts.fee, opts.amountIn, opts.slippageBps ?? 100n,
  );
  const amountOutMin = opts.amountOutMin ?? quotedMin;
  console.log(`quote: ${opts.amountIn} ${context.erc20Address} -> ~${quoted} ${opts.tokenOut} (min ${amountOutMin})`);

  const evmNonce = await getTransactionNonce(context.evmRpcUrl, context.evmVaultAddress);
  const requestId = await swap(context, { tokenOut: opts.tokenOut, fee: opts.fee, amountIn: opts.amountIn, amountOutMin, evmNonce });

  // The swap tx is signed by the VAULT's account (it holds the pooled funds). tolerateRevert:
  // an on-chain revert (slippage / liquidity / an impossible amountOutMin) is a valid outcome
  // the MPC attests as a failure and completeSwap settles via refund — not a broadcast error.
  const signed = await pollSignatureResponse(context, { requestId, intervalMs: 1000, timeoutMs: 3 * MINUTE, expectedSigner: context.evmVaultAddress, requestsPath: VAULT_SWAP_REQUESTS_PATH });
  await broadcastEvm(context, { transaction: signed, tolerateRevert: true });
  const { amountOut, refunded } = await completeSwap(context, requestId);
  return { requestId, amountOut, refunded };
}

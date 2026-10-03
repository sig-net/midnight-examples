// What the EVM did with an MPC-signed transaction, as a client obtains it on
// its own: the output the MPC's attestation signs over travels off chain, so
// the client recovers the raw execution output independently and checks the
// signature against it. The
// mined transaction is rebuilt from chain data alone (the request record plus
// a posted signature, exactly as the broadcast did), then a contract call's
// top frame is read with `debug_traceTransaction`, the RPC method the MPC
// itself observes with. `EVM_RPC_URL` must serve that method on every
// network: anvil does, and hosted endpoints often gate it behind a paid tier,
// so the setup pipeline probes it before anything is deployed. An observation
// is UNTRUSTED until the attestation signature check: it only gates which
// candidate output is tried, never what is accepted.

import {
  type EvmTraceOutput,
  evmTraceOutputFromCallFrame,
  EvmTraceOutputKind,
  isEvmContractCall,
  type JsonValue,
  type RequestIdHex,
  signBidirectionalEventToSignedEvmTransaction,
  type SignetRequestResponseReader,
} from "@sig-net/midnight";
import { JsonRpcProvider, type TransactionReceipt, ZeroHash } from "ethers";

import { isAnvil } from "./evm-anvil.ts";
import { jsonRpcRequest, parseJsonRpcReply } from "./json-rpc.ts";

/** One observed remote-execution result. */
export interface ObservedExecution {
  /** The request id, hex, no 0x prefix. */
  readonly requestId: string;
  /** Whether the remote execution succeeded (the transaction mined with status 1). */
  readonly success: boolean;
  /**
   * Whether the mined transaction is a contract call, decided from its input
   * the MPC's way (`isEvmContractCall`).
   */
  readonly isContractCall: boolean;
  /**
   * The mined call's top-frame return data as `debug_traceTransaction`
   * reports it, `NotTraced` for a plain transfer (the MPC traces contract
   * calls only). null for a failed execution, which has no attested output.
   */
  readonly trace: EvmTraceOutput | null;
  /** The remote transaction's hash. */
  readonly txHash: string;
  readonly blockNumber: bigint;
}

const TRACE_METHOD = "debug_traceTransaction";
const CALL_TRACER = { tracer: "callTracer", tracerConfig: { onlyTopCall: true } } as const;

/** The standard JSON-RPC code for a method the node does not know. */
const METHOD_NOT_FOUND_CODE = -32601;

// Phrasings hosted providers refuse a tier-gated or disabled method with,
// beside the standard code.
const METHOD_UNAVAILABLE = /not (?:exist|available|supported|allowed)|unsupported/i;

/**
 * Check that `evmRpcUrl` serves `debug_traceTransaction`, the method every
 * attestation poll recovers execution outputs with ({@link observeExecution}).
 * Anvil passes without a probe: it traces the transactions it mines itself,
 * and a forking anvil proxies a hash it does not hold to its upstream, whose
 * answer says nothing about anvil. Any other node is probed with the zero
 * hash: one that serves the method answers with a result or a
 * transaction-not-found error, one that does not answers with the
 * method-not-found code or a tier-gate message.
 *
 * @param evmRpcUrl - The EVM JSON-RPC endpoint (`EVM_RPC_URL`).
 * @throws {Error} If the endpoint is unreachable, answers with something other
 *   than JSON-RPC, or refuses the method.
 */
export async function assertDebugTraceAvailable(evmRpcUrl: string): Promise<void> {
  let anvil: boolean;
  let answer: { status: number; text: string };
  try {
    anvil = await isAnvil(evmRpcUrl);
    if (anvil) {
      console.log(
        `EVM_RPC_URL (${evmRpcUrl}) is anvil, which serves ${TRACE_METHOD} for the transactions it mines`,
      );
      return;
    }
    answer = await jsonRpcRequest(evmRpcUrl, TRACE_METHOD, [ZeroHash, CALL_TRACER]);
  } catch (error) {
    throw new Error(`EVM_RPC_URL (${evmRpcUrl}) is not answering a ${TRACE_METHOD} probe`, {
      cause: error,
    });
  }
  const reply = parseJsonRpcReply(answer);
  if (reply === undefined) {
    throw new Error(
      `EVM_RPC_URL (${evmRpcUrl}) answered a ${TRACE_METHOD} probe with HTTP ${String(answer.status)} ` +
        `and no JSON-RPC reply: ${answer.text}`,
    );
  }
  const error = reply.error;
  if (
    error !== undefined &&
    (error.code === METHOD_NOT_FOUND_CODE || METHOD_UNAVAILABLE.test(error.message))
  ) {
    throw new Error(
      `EVM_RPC_URL (${evmRpcUrl}) does not serve ${TRACE_METHOD} ` +
        `(${String(error.code)}: ${error.message}). Every attestation poll recovers the ` +
        "execution output the MPC attests by tracing the mined transaction, so point " +
        "EVM_RPC_URL at a node that serves it: the local anvil does, and hosted providers " +
        "gate it behind a paid tier.",
    );
  }
  console.log(`EVM_RPC_URL (${evmRpcUrl}) serves ${TRACE_METHOD}`);
}

const RECEIPT_POLL_INTERVAL_MS = 1_000;

/**
 * The receipt of the request's mined transaction, found by rebuilding a
 * signed transaction from each posted signature and asking the chain for its
 * receipt. A post that rebuilds no transaction (malformed) or names one that
 * never mined is skipped: only the chain says which post's transaction ran.
 *
 * @param reader - The reader over the vault / signet pair the request lives in.
 * @param provider - The EVM chain the transaction was broadcast to.
 * @param requestId - The request whose transaction to find.
 * @returns The receipt, or undefined when no posted signature names a mined transaction.
 * @throws {Error} When the vault holds no request under `requestId`.
 */
async function minedTransactionReceipt(
  reader: SignetRequestResponseReader,
  provider: JsonRpcProvider,
  requestId: RequestIdHex,
): Promise<TransactionReceipt | undefined> {
  const request = await reader.getSignatureRequest(requestId);
  for (const response of await reader.getSignatureRespondedEvents(requestId)) {
    let hash: string | null;
    try {
      hash = signBidirectionalEventToSignedEvmTransaction(request, response).hash;
    } catch {
      continue;
    }
    if (hash === null) continue;
    const receipt = await provider.getTransactionReceipt(hash);
    if (receipt !== null) return receipt;
  }
  return undefined;
}

/**
 * The `debug_traceTransaction` callTracer top frame of a mined transaction.
 *
 * @param provider - The EVM chain the transaction mined on.
 * @param evmRpcUrl - The endpoint behind `provider`, for the error message.
 * @param txHash - The mined transaction.
 * @returns The RPC's `result`, unvalidated.
 * @throws {Error} When the RPC refuses the method.
 */
async function traceTopCallFrame(
  provider: JsonRpcProvider,
  evmRpcUrl: string,
  txHash: string,
): Promise<JsonValue> {
  try {
    return (await provider.send(TRACE_METHOD, [txHash, CALL_TRACER])) as JsonValue;
  } catch (error) {
    throw new Error(
      `${TRACE_METHOD} failed for ${txHash} on ${evmRpcUrl}: the endpoint must ` +
        `serve it to recover the execution output the MPC attests (${String(error)})`,
      { cause: error },
    );
  }
}

/**
 * Observe the execution of the request's transaction by tracing it on the
 * EVM chain: wait up to `timeoutMs` for a posted signature whose transaction
 * has a receipt, then report its status and, for a successful contract call,
 * the top frame's return data from `debug_traceTransaction`. UNTRUSTED: the
 * caller verifies the MPC's attestation signature over what this returns.
 *
 * @param reader - The reader over the vault / signet pair the request lives in.
 * @param evmRpcUrl - The EVM JSON-RPC endpoint, which must serve `debug_traceTransaction`.
 * @param requestId - The request whose execution to observe.
 * @param timeoutMs - How long to wait for a mined transaction before failing.
 * @returns The observed execution.
 * @throws {Error} When no posted signature names a mined transaction within `timeoutMs`,
 *   the vault holds no such request, the RPC refuses `debug_traceTransaction`, or the
 *   traced frame is one the MPC refuses (`evmTraceOutputFromCallFrame`).
 */
export async function observeExecution(
  reader: SignetRequestResponseReader,
  evmRpcUrl: string,
  requestId: RequestIdHex,
  timeoutMs: number,
): Promise<ObservedExecution> {
  const provider = new JsonRpcProvider(evmRpcUrl);
  try {
    const deadline = Date.now() + timeoutMs;
    let receipt = await minedTransactionReceipt(reader, provider, requestId);
    while (receipt === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_INTERVAL_MS));
      receipt = await minedTransactionReceipt(reader, provider, requestId);
    }
    if (receipt === undefined) {
      throw new Error(
        `no mined transaction for request ${requestId} within ${String(timeoutMs)}ms: none of its ` +
          `posted signatures names a transaction ${evmRpcUrl} holds a receipt for`,
      );
    }
    const transaction = await provider.getTransaction(receipt.hash);
    if (transaction === null) {
      throw new Error(`${evmRpcUrl} holds a receipt but no transaction for ${receipt.hash}`);
    }
    const isContractCall = isEvmContractCall(transaction.data);
    if (receipt.status !== 1) {
      return {
        requestId,
        success: false,
        isContractCall,
        trace: null,
        txHash: receipt.hash,
        blockNumber: BigInt(receipt.blockNumber),
      };
    }
    const trace: EvmTraceOutput = isContractCall
      ? evmTraceOutputFromCallFrame(await traceTopCallFrame(provider, evmRpcUrl, receipt.hash))
      : { kind: EvmTraceOutputKind.NotTraced };
    return {
      requestId,
      success: true,
      isContractCall,
      trace,
      txHash: receipt.hash,
      blockNumber: BigInt(receipt.blockNumber),
    };
  } finally {
    provider.destroy();
  }
}

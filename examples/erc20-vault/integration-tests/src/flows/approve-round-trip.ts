// The full approve journey as one arrange-stage helper: startApproveRouter or
// startApproveStata, MPC signature, broadcast the ERC20 approve, MPC attestation,
// completeApprove. `ensureVaultAllowances` runs it for every allowance the
// vault's circuits spend under, skipping the ones the EVM side already holds.
import { bytesToHex, OutputKind, requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import {
  pureCircuits,
  readVaultLedger,
  VAULT_APPROVE_REQUESTS_PATH,
  type VaultLedgerState,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { type ContractReadMethod, logSkip } from "@sig-net/midnight-examples-test-harness";
import { ethers } from "ethers";

import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import type { VaultContext } from "../vault-context.ts";
import type { VaultSession } from "../vault-session.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { settleApprove } from "./complete-approve.ts";
import { pollRespondBidirectional } from "./poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";
import { startApproveRouter, startApproveStata } from "./start-approve.ts";

/** The ERC20 an approval is sent to and the spender it grants, as 0x hex. */
export interface Allowance {
  readonly token: string;
  readonly spender: string;
}

/** Options for {@link runApproveRoundTrip}. */
export interface ApproveRoundTripOptions {
  /** The allowance to grant, named as the stage lines read it. */
  readonly name: string;
  /** Start, flush and send the approval, returning its request id. */
  readonly start: (context: VaultContext) => Promise<RequestIdHex>;
  /**
   * An existing request to resume, skipping the start, for recovering a run
   * that died mid-round-trip. Every later leg is idempotent.
   */
  readonly reuseRequestId?: RequestIdHex;
}

/**
 * Run the full approve round trip against the live stack: the start, poll the
 * MPC's signature, broadcast the ERC20 approve from the vault account, poll the
 * MPC's attestation, and {@link settleApprove}. This wallet's identity must be
 * the deployer's. Rerun-tolerant against kept addresses: an already-settled
 * request logs a skip.
 *
 * @param session - The flow file's shared session.
 * @param opts - The approval to run and an optional resume id.
 * @returns The request id the round trip created (or resumed).
 * @throws {Error} If any leg times out, the approve reverts on-chain, or the
 *   MPC does not attest it as executed.
 */
export async function runApproveRoundTrip(
  session: VaultSession,
  opts: ApproveRoundTripOptions,
): Promise<RequestIdHex> {
  const context = await session.vaultContext();

  let requestId: RequestIdHex;
  if (opts.reuseRequestId) {
    requestId = opts.reuseRequestId;
    logSkip(opts.name, `resuming approve round trip from existing request ${requestId}`);
  } else {
    requestId = await opts.start(context);
  }
  if (!/^[0-9a-f]{64}$/.test(requestId)) {
    throw new Error(`approve request id is not 64-char lowercase hex: "${requestId}"`);
  }

  // Approvals are signed by the VAULT's derived account.
  const signedTransaction = await pollSignatureResponse(context, {
    requestId,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
    expectedSigner: context.evmVaultAddress,
    requestsPath: VAULT_APPROVE_REQUESTS_PATH,
  });

  await broadcastEvm(context, { transaction: signedTransaction });

  const outcome = await pollRespondBidirectional(context, {
    requestId,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
    requestsPath: VAULT_APPROVE_REQUESTS_PATH,
  });
  if (outcome.event.outputKind !== OutputKind.executed) {
    throw new Error(
      `the MPC attested ${opts.name} ${requestId} as ${OutputKind[outcome.event.outputKind]}: ` +
        `the approve broadcast above mined, so the responder saw a different outcome`,
    );
  }

  const ledger = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!ledger.bidirectionalApproveMap.member(requestIdBytes(requestId))) {
    logSkip(
      "completeApprove",
      `${opts.name} ${requestId} already settled (not in the approve map)`,
    );
    return requestId;
  }
  await settleApprove(context, outcome);
  return requestId;
}

/**
 * Grant every allowance the vault's circuits spend under and the EVM side does
 * not hold yet: the Uniswap router on every allowed ERC20 (a swap sells any of
 * them) and the stataToken wrapper on its underlying (a supply deposits it).
 * Each missing allowance is one {@link runApproveRoundTrip}, run one after the
 * other since every approval takes the vault account's next EVM nonce.
 *
 * @param session - The deployer's session.
 * @returns The allowances this call granted, in run order.
 * @throws {Error} If the vault is not initialised, or a round trip fails.
 */
export async function ensureVaultAllowances(session: VaultSession): Promise<readonly Allowance[]> {
  const context = await session.vaultContext();
  const state = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!state.initialised) {
    throw new Error("the vault is not initialised: run the initialise flow first");
  }
  const unlimited = pureCircuits.unlimitedAllowance();
  const granted: Allowance[] = [];
  for (const { name, allowance, start } of vaultAllowances(state)) {
    const held = await erc20Allowance(context.evmRpcUrl, context.evmVaultAddress, allowance);
    if (held === unlimited) {
      logSkip(
        name,
        `${allowance.spender} already holds unlimitedAllowance() on ${allowance.token}`,
      );
      continue;
    }
    console.log(
      `${name}: ${allowance.spender} holds ${String(held)} on ${allowance.token}, approving`,
    );
    await runApproveRoundTrip(session, { name, start });
    granted.push(allowance);
  }
  return granted;
}

/** One allowance the vault spends under, with the start that grants it. */
interface VaultAllowance {
  readonly name: string;
  readonly allowance: Allowance;
  readonly start: (context: VaultContext) => Promise<RequestIdHex>;
}

/**
 * The allowances a vault in `state` spends under, from its pins and allowlist.
 *
 * @param state - The vault's ledger state.
 * @returns The stata approval, then one router approval per allowed ERC20.
 */
function vaultAllowances(state: VaultLedgerState): readonly VaultAllowance[] {
  const router = `0x${bytesToHex(state.uniswapRouter)}`;
  const stata: VaultAllowance = {
    name: "stata approval",
    allowance: {
      token: `0x${bytesToHex(state.stataUnderlying)}`,
      spender: `0x${bytesToHex(state.stataToken)}`,
    },
    start: (context) => startApproveStata(context),
  };
  const routerApprovals = Array.from(state.allowedTokens, (tokenBytes) => {
    const token = `0x${bytesToHex(tokenBytes)}`;
    return {
      name: `router approval on ${token}`,
      allowance: { token, spender: router },
      start: (context: VaultContext) => startApproveRouter(context, { erc20Address: token }),
    };
  });
  return [stata, ...routerApprovals];
}

/**
 * Read an ERC20 allowance on the EVM side.
 *
 * @param rpcUrl - The EVM JSON-RPC endpoint.
 * @param owner - The account that granted the allowance.
 * @param allowance - The ERC20 and the spender.
 * @returns What `spender` may still spend of `owner`'s balance.
 */
export const erc20Allowance = (
  rpcUrl: string,
  owner: string,
  allowance: Allowance,
): Promise<bigint> =>
  new ethers.Contract(
    allowance.token,
    ["function allowance(address,address) view returns (uint256)"],
    new ethers.JsonRpcProvider(rpcUrl),
  ).getFunction<ContractReadMethod<bigint>>("allowance")(owner, allowance.spender);

import { buildBaseEnv } from '@sig-net/midnight-examples-lib';
import { PendingRequestKind, readVaultLedger } from '@sig-net/midnight-examples-erc20-vault-contract';
import { bytesToHex } from '@sig-net/midnight';
import { createVaultSession } from '../src/vault-session.ts';
import { flushUntilStamped } from '../src/flows/vault-queue.ts';
import { sendApproveRouter } from '../src/flows/approve-router.ts';
import { sendApproveStata } from '../src/flows/approve-stata.ts';
import { pollSignatureResponse } from '../src/flows/poll-signature-response.ts';
import { broadcastEvm } from '../src/flows/broadcast-evm.ts';
const session = createVaultSession(buildBaseEnv());
try {
  const context = await session.vaultContext();
  const ledger = await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);
  const queued = [];
  for (const [key, request] of ledger.pendingVaultRequests) {
    if (request.kind !== PendingRequestKind.approveRouter && request.kind !== PendingRequestKind.approveStata) throw new Error('Unexpected queued request');
    const stamp = await flushUntilStamped(context, key);
    queued.push({key, request, nonce: stamp.evmNonce});
  }
  queued.sort((a,b) => a.nonce < b.nonce ? -1 : 1);
  for (const {key, request} of queued) {
    const requestId = request.kind === PendingRequestKind.approveRouter ? await sendApproveRouter(context, key, '0x' + bytesToHex(request.addressA)) : await sendApproveStata(context, key);
    const transaction = await pollSignatureResponse(context, {requestId, intervalMs: 1000, timeoutMs: 240000, expectedSigner: context.evmVaultAddress});
    await broadcastEvm(context, {transaction});
  }
  console.log('RECOVERY_COMPLETE');
} finally { await session.stop(); }

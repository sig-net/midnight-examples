import {
  bytesToHex,
  evmAddressAbiWord,
  hexToBytes,
  numericAbiWord,
  tronAddressFromEvm,
} from "@sig-net/midnight";
import { computeAddress, SigningKey } from "ethers";

async function tronPost(rpcUrl: string, path: string, body: object): Promise<unknown> {
  const response = await fetch(`${rpcUrl.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Tron ${path} answered HTTP ${String(response.status)}: ${text}`);
  }
  return JSON.parse(text) as unknown;
}

/** */
export interface TronHeadBlock {
  readonly number: bigint;
  readonly blockId: Uint8Array;
  readonly timestamp: bigint;
}

interface NowBlockAnswer {
  readonly blockID?: string;
  readonly block_header?: { readonly raw_data?: { readonly number?: number; timestamp?: number } };
}

/**
 * @param rpcUrl - The node's HTTP API base URL
 * @returns The head block's number
 * @throws {Error} If the node does not answer with a block
 */
export async function getTronHeadBlock(rpcUrl: string): Promise<TronHeadBlock> {
  const answer = (await tronPost(rpcUrl, "/wallet/getnowblock", {})) as NowBlockAnswer;
  const raw = answer.block_header?.raw_data;
  if (answer.blockID === undefined || raw?.number === undefined || raw.timestamp === undefined) {
    throw new Error("Tron getnowblock returned no block id, number or timestamp");
  }
  return {
    number: BigInt(raw.number),
    blockId: hexToBytes(answer.blockID),
    timestamp: BigInt(raw.timestamp),
  };
}

/** */
export interface TronReference {
  readonly refBlockBytes: Uint8Array;
  readonly refBlockHash: Uint8Array;
}

/**
 * @param block - The reference block
 * @returns The two reference fields
 */
export function tronReference(block: TronHeadBlock): TronReference {
  const number = new Uint8Array(8);
  new DataView(number.buffer).setBigUint64(0, block.number);
  return { refBlockBytes: number.slice(6, 8), refBlockHash: block.blockId.slice(8, 16) };
}

/** */
export interface TronTransactionInfo {
  readonly blockNumber: bigint;
  readonly receiptResult: string;
}

interface TransactionInfoAnswer {
  readonly blockNumber?: number;
  readonly receipt?: { readonly result?: string };
}

/**
 * @param rpcUrl - The node's HTTP API base URL
 * @param txid - The 32-byte transaction id
 * @returns The block and the execution result
 */
export async function getTronTransactionInfo(
  rpcUrl: string,
  txid: Uint8Array,
): Promise<TronTransactionInfo | undefined> {
  const answer = (await tronPost(rpcUrl, "/wallet/gettransactioninfobyid", {
    value: bytesToHex(txid),
  })) as TransactionInfoAnswer;
  if (answer.blockNumber === undefined) return undefined;
  return {
    blockNumber: BigInt(answer.blockNumber),
    receiptResult: answer.receipt?.result ?? "SUCCESS",
  };
}

interface BroadcastAnswer {
  readonly result?: boolean;
  readonly code?: string;
  readonly message?: string;
}

const DUPLICATE_TRANSACTION = "DUP_TRANSACTION_ERROR";

/**
 * @param rpcUrl - The node's HTTP API base URL
 * @param signedTransaction - The signed `Transaction` bytes
 * @returns Whether this call submitted it
 * @throws {Error} If the node refuses it
 */
export async function broadcastTronHex(
  rpcUrl: string,
  signedTransaction: Uint8Array,
): Promise<boolean> {
  const answer = (await tronPost(rpcUrl, "/wallet/broadcasthex", {
    transaction: bytesToHex(signedTransaction),
  })) as BroadcastAnswer;
  if (answer.result === true) return true;
  if (answer.code === DUPLICATE_TRANSACTION) return false;
  throw new Error(`Tron broadcasthex refused the transaction: ${JSON.stringify(answer)}`);
}

interface UnsignedTronTransaction {
  readonly txID: string;
  readonly raw_data: object;
  readonly raw_data_hex: string;
}

interface BuildAnswer {
  readonly txID?: string;
  readonly transaction?: UnsignedTronTransaction;
  readonly contract_address?: string;
}

async function signAndBroadcast(
  rpcUrl: string,
  transaction: UnsignedTronTransaction,
  privateKey: string,
): Promise<Uint8Array> {
  const signature = new SigningKey(privateKey).sign(`0x${transaction.txID}`);
  const signatureHex =
    signature.r.slice(2) + signature.s.slice(2) + (signature.v - 27).toString(16).padStart(2, "0");
  const answer = (await tronPost(rpcUrl, "/wallet/broadcasttransaction", {
    ...transaction,
    signature: [signatureHex],
  })) as BroadcastAnswer;
  if (answer.result !== true && answer.code !== DUPLICATE_TRANSACTION) {
    throw new Error(`Tron broadcasttransaction refused: ${JSON.stringify(answer)}`);
  }
  return hexToBytes(transaction.txID);
}

/** */
export interface TronFunder {
  readonly privateKey: string;
  readonly address: Uint8Array;
}

/**
 * @param privateKey - The 32-byte private key
 * @returns The funder
 */
export function tronFunder(privateKey: string): TronFunder {
  return { privateKey, address: tronAddressFromEvm(computeAddress(privateKey)) };
}

async function buildSignAndBroadcast(
  rpcUrl: string,
  funder: TronFunder,
  path: string,
  body: object,
): Promise<{ answer: BuildAnswer; txid: Uint8Array }> {
  const answer = (await tronPost(rpcUrl, path, body)) as BuildAnswer &
    Partial<UnsignedTronTransaction>;
  const { txID, raw_data, raw_data_hex } = answer.transaction ?? answer;
  if (txID === undefined || raw_data === undefined || raw_data_hex === undefined) {
    throw new Error(`Tron ${path} built no transaction: ${JSON.stringify(answer)}`);
  }
  return {
    answer,
    txid: await signAndBroadcast(rpcUrl, { txID, raw_data, raw_data_hex }, funder.privateKey),
  };
}

/**
 * @param rpcUrl - The node's HTTP API base URL
 * @param funder - The paying account
 * @param to - The 21-byte recipient
 * @param amount - The amount
 * @returns The transaction id
 * @throws {Error} If the node refuses the transfer
 */
export async function sendTrx(
  rpcUrl: string,
  funder: TronFunder,
  to: Uint8Array,
  amount: bigint,
): Promise<Uint8Array> {
  const { txid } = await buildSignAndBroadcast(rpcUrl, funder, "/wallet/createtransaction", {
    owner_address: bytesToHex(funder.address),
    to_address: bytesToHex(to),
    amount: Number(amount),
  });
  return txid;
}

const FUNDER_FEE_LIMIT = 1_000_000_000;

/**
 * @param rpcUrl - The node's HTTP API base URL
 * @param funder - The paying account
 * @param token - The 21-byte TRC-20 contract
 * @param to - The 21-byte recipient
 * @param amount - The amount
 * @returns The transaction id
 * @throws {Error} If the node refuses the call
 */
export async function sendTrc20(
  rpcUrl: string,
  funder: TronFunder,
  token: Uint8Array,
  to: Uint8Array,
  amount: bigint,
): Promise<Uint8Array> {
  const { txid } = await buildSignAndBroadcast(rpcUrl, funder, "/wallet/triggersmartcontract", {
    owner_address: bytesToHex(funder.address),
    contract_address: bytesToHex(token),
    function_selector: "transfer(address,uint256)",
    parameter: bytesToHex(evmAddressAbiWord(to.slice(1))) + bytesToHex(numericAbiWord(amount)),
    fee_limit: FUNDER_FEE_LIMIT,
    call_value: 0,
  });
  return txid;
}

/**
 * @param rpcUrl - The node's HTTP API base URL
 * @param funder - The deploying account
 * @param name - The contract name the node records
 * @param abi - The contract ABI the node records
 * @param bytecode - The creation bytecode with its encoded constructor arguments
 * @returns The 21-byte contract address and the deploy transaction's id
 * @throws {Error} If the node refuses the deploy or names no contract address
 */
export async function deployTronContract(
  rpcUrl: string,
  funder: TronFunder,
  name: string,
  abi: readonly object[],
  bytecode: string,
): Promise<{ address: Uint8Array; txid: Uint8Array }> {
  const { answer, txid } = await buildSignAndBroadcast(rpcUrl, funder, "/wallet/deploycontract", {
    owner_address: bytesToHex(funder.address),
    name,
    abi: JSON.stringify(abi),
    bytecode,
    fee_limit: FUNDER_FEE_LIMIT,
    call_value: 0,
    consume_user_resource_percent: 100,
    origin_energy_limit: 10_000_000,
  });
  if (answer.contract_address === undefined) {
    throw new Error(`Tron deploycontract named no contract address: ${JSON.stringify(answer)}`);
  }
  return { address: hexToBytes(answer.contract_address), txid };
}

interface ConstantCallAnswer {
  readonly constant_result?: readonly string[];
}

/**
 * @param rpcUrl - The node's HTTP API base URL
 * @param token - The 21-byte TRC-20 contract
 * @param owner - The 21-byte holder
 * @returns The balance
 * @throws {Error} If the node returns no result
 */
export async function getTrc20Balance(
  rpcUrl: string,
  token: Uint8Array,
  owner: Uint8Array,
): Promise<bigint> {
  const answer = (await tronPost(rpcUrl, "/wallet/triggerconstantcontract", {
    owner_address: bytesToHex(owner),
    contract_address: bytesToHex(token),
    function_selector: "balanceOf(address)",
    parameter: bytesToHex(evmAddressAbiWord(owner.slice(1))),
  })) as ConstantCallAnswer;
  const word = answer.constant_result?.[0];
  if (word === undefined) {
    throw new Error(`Tron balanceOf returned no result: ${JSON.stringify(answer)}`);
  }
  return BigInt(`0x${word}`);
}

interface AccountAnswer {
  readonly balance?: number;
}

/**
 * @param rpcUrl - The node's HTTP API base URL
 * @param address - The 21-byte account
 * @returns The balance
 */
export async function getTrxBalance(rpcUrl: string, address: Uint8Array): Promise<bigint> {
  const answer = (await tronPost(rpcUrl, "/wallet/getaccount", {
    address: bytesToHex(address),
  })) as AccountAnswer;
  return BigInt(answer.balance ?? 0);
}

/**
 * @param rpcUrl - The node's HTTP API base URL
 * @param txid - The 32-byte transaction id
 * @param timeoutMs - How long to wait
 * @returns Where and how it executed
 * @throws {Error} If it is in no block within `timeoutMs`
 */
export async function waitForTronTransaction(
  rpcUrl: string,
  txid: Uint8Array,
  timeoutMs: number,
): Promise<TronTransactionInfo> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await getTronTransactionInfo(rpcUrl, txid);
    if (info !== undefined) return info;
    if (Date.now() > deadline) {
      throw new Error(
        `Tron transaction ${bytesToHex(txid)} is in no block after ${String(timeoutMs)}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

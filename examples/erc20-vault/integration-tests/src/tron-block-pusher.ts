import { tronAddressFromEvm } from "@sig-net/midnight";

import { sleepUnlessAborted } from "./sleep-unless-aborted.ts";
import { sendTrx, type TronFunder } from "./tron-http.ts";

const PUSHER_SINK = tronAddressFromEvm("0x000000000000000000000000000000000000dEaD");

/** */
export interface TronBlockPusher {
  /** */
  stop(): Promise<void>;
}

/**
 * @param rpcUrl - The node's HTTP API base URL
 * @param funder - The account that pays for the transfers
 * @param intervalMs - The pause between transfers
 * @returns The running pusher
 */
export function startTronBlockPusher(
  rpcUrl: string,
  funder: TronFunder,
  intervalMs = 2_000,
): TronBlockPusher {
  const halt = new AbortController();
  const loop = (async (): Promise<void> => {
    while (!halt.signal.aborted) {
      try {
        await sendTrx(rpcUrl, funder, PUSHER_SINK, 1n);
      } catch (error) {
        console.warn(`Tron block pusher transfer failed, retrying: ${String(error)}`);
      }
      await sleepUnlessAborted(intervalMs, halt.signal);
    }
  })();
  return {
    async stop(): Promise<void> {
      halt.abort();
      await loop;
    },
  };
}

/**
 * @param rpcUrl - The node's HTTP API base URL
 * @param funder - The account that pays for the transfers
 * @param body - The work that waits on new blocks
 * @returns What `body` returns
 */
export async function withTronBlockPusher<T>(
  rpcUrl: string,
  funder: TronFunder,
  body: () => Promise<T>,
): Promise<T> {
  const pusher = startTronBlockPusher(rpcUrl, funder);
  try {
    return await body();
  } finally {
    await pusher.stop();
  }
}

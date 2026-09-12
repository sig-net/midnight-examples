// Which MPC a run faces, decided ONCE for every consumer: the setup steps
// that configure a fakenet responder and the flows that observe executions
// both read it from here, so the two can never disagree on the answer.

import { getMidnightNodeConfig, isLocalStandaloneNetwork } from "@sig-net/midnight-contract-deploy";

/** The MPC answering a run's signet singleton. */
export enum MpcKind {
  /** The fakenet responder, whose `MPC_ROOT_KEY` this run holds. */
  Fakenet = "fakenet",
  /** A real Signature Network MPC, named by its root public key only. */
  Real = "real",
}

/**
 * Which MPC a run faces. A held `MPC_ROOT_KEY` means a fakenet, on any
 * network (a fakenet can answer a deployed network's singleton too). No root
 * key on a deployed network means the real MPC that network's singleton is
 * answered by, named by `MPC_SECP256K1_PUBKEY`. The local standalone stack
 * has no real MPC, so no root key there is a misconfiguration: the setup's
 * MPC key step mints one when nothing names an MPC.
 *
 * @param env - The suite's env accumulator.
 * @returns The kind of MPC the run faces.
 * @throws {Error} If no root key is held on the local standalone stack.
 */
export function mpcKind(env: NodeJS.ProcessEnv): MpcKind {
  if (env.MPC_ROOT_KEY) return MpcKind.Fakenet;
  const { networkId } = getMidnightNodeConfig(env);
  if (isLocalStandaloneNetwork(networkId)) {
    throw new Error(
      `no MPC_ROOT_KEY on the local "${networkId}" stack, which no real MPC answers: the setup's ` +
        "MPC key step mints a fakenet root key there, so either that step did not run or " +
        "MPC_SECP256K1_PUBKEY names a real MPC on a stack that has none.",
    );
  }
  return MpcKind.Real;
}

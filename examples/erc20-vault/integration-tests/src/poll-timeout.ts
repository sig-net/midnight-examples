/**
 * Give-up horizon for every poll on an MPC response, the signature and the
 * attestation alike. Sized for a live MPC that attests only once the EVM
 * transaction is final: Sepolia finality takes two epochs, around 13 minutes,
 * before the responder's own latency. A test that awaits a poll budgets this
 * on top of its own proving time.
 */
export const POLL_TIMEOUT_MS = 20 * 60_000;

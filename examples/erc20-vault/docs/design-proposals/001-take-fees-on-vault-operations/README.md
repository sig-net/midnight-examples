# Take Fees On Vault Operations

This design proposal exists to address a medium severity audit finding.

## The audit finding

Audit finding SNA-01 ("Full Refunds on Failed Swaps Enable Repeatable EVM Gas Drain", severity Medium) describes a griefing attack against the vault's EVM account.

Every vault operation that touches the EVM (withdraw, approve, swap, supply, redeem) is an EVM transaction sent from the vault's address, so the vault pays the gas for it. When the EVM transaction fails, the matching `complete*` circuit re-mints the requester's surrendered input in full, so the requester ends the round trip holding exactly what they started with. The only party losing anything is the vault, which paid the gas for a transaction that failed on the EVM side.

That asymmetry is exploitable because nothing in `startSwap` (or the other `start*` circuits) requires the request to be economically meaningful. An attacker could build a request that is guaranteed to revert on the EVM, and after driving it through its lifecycle use the legitimate MPC attestation of the failure to claim back the assets they surrendered on start, leaving the vault at a loss of gas.

## Proposed Protection Against the Attack

The vault will charge a small, non-refundable fee on every vault operation that costs the vault EVM gas. The fee, configurable by the operator, should be set so that it is a trivial amount to a legitimate user but sized so that it is worth more than the gas the vault burns on that operation. It is taken at the `start*` step and is never returned, whichever way the operation settles: executed, failed or unviable. This change removes the economics of the attack. A reverting request now costs the attacker at least what it costs the vault, so the griefing loop runs at a loss for the attacker on every cycle. Honest users see a negligible charge on each operation, and the vault's EVM account is net funded rather than net drained by traffic.

The fee's denomination, its amount, where it accrues, how it is sized against gas prices, and how it is collected are design questions for the sections that follow.

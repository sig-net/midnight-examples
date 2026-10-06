"""Swap round trip as data for build_sequence.py (format and markup: see its top).

Step numbers follow examples/erc20-vault/docs/swap/swap.md (9 steps).
"""

TITLE = 'Swap round trip'

LANES = [
    dict(id='user',      title='User',                           icon='user', sub='Midnight wallet'),
    dict(id='vault',     title='ERC20 Vault Contract',           icon='contract'),
    dict(id='singleton', title='Sig Network\nSingleton Contract', icon='signet'),
    dict(id='mpc',       title='Sig Network\nDistributed MPC',   icon='mpc-cluster'),
    dict(id='dapp',      title='Vault dApp/Relayer',             icon='contract'),
    dict(id='evm',       title='EVM Blockchain',                 icon='chain'),
]

GROUPS = [
    dict(id='midnight', icon='midnight', lanes=['vault', 'singleton']),
]

BANDS = [
    dict(title='Request', phase='request', rows=[
        # precondition, not a step: the page names startApproveRouter in prose only
        dict(kind='note', phase='pre', lane='evm', rows=2, overlay=True,
             lines=['**Before the first swap of a token:**',
                    'the deployer runs `startApproveRouter(...)`,',
                    'and the **vault\'s own account** calls',
                    '`approve(uniswapRouter, unlimitedAllowance)`',
                    'on the **ERC20 Token** sold (**erc20AddressIn**)']),
        # four lines: nudged up into the band's head room, clear of step 2's note
        dict(kind='arrow', step='1', phase='request', frm='user', to='vault',
             label=['**User:**', 'Starts the swap and queues it', '`startSwap(...)`'],
             side=dict(lane='vault', dy=-6,
                       lines=['**Reads:** the user\'s secret',
                              '**Through:** the', '**callerSecretKey** witness',
                              '**Burns:** a shielded', '**erc20AddressIn** coin',
                              '**Checks:** out token', 'in **allowedTokens**'])),
        dict(kind='arrow', step='2', phase='request', frm='user', to='vault',
             label=['**User:**', 'Flushes the request', '`flushQueue(...)`'],
             side=dict(lane='vault', lines=['**Assigns:** the next', '**vaultAccountNonce**',
                                             'as the request\'s EVM nonce',
                                             '**Moves:** the request', 'into the output buffer'])),
        dict(kind='arrow', step='3', phase='request', frm='user', to='vault',
             label=['**User:**', 'Sends the request', '`sendSwap(...)`'],
             side=dict(lane='vault', lines=['**Records:**', '**bidirectionalSwapMap**',
                                             '**Signer:** the vault\'s', 'own account',
                                             '**Output:** one uint256,', '**amountIn**'])),
        dict(kind='arrow', step=None, phase='request', frm='vault', to='singleton',
             label=['**Vault:**', 'Notifies the MPC', '`signBidirectional(...)`']),
    ]),
    dict(title='Sign and execute', phase='signature', rows=[
        dict(kind='arrow', step='4', phase='signature', frm='mpc', to='vault',
             label=['**MPC:**', 'Reads the recorded request', 'from **bidirectionalSwapMap**']),
        dict(kind='arrow', step=None, phase='signature', frm='mpc', to='singleton',
             label=['**MPC:**', 'Signs and posts the signature', '`respond(...)`'],
             side=dict(lane='mpc', lines=['**Signs:** the requested', 'EVM transaction',
                                           '**With:** **derivedSigningKey**', 'of the vault\'s own account,',
                                           'path `pad(32, "vault")`'])),
        dict(kind='arrow', step=None, phase='signature', frm='dapp', to='singleton',
             label=['**dApp/relayer:**', 'Picks up the signature from', '**SignatureRespondedEvent**']),
        dict(kind='arrow', step='5', phase='broadcast', frm='dapp', to='evm',
             label=['**dApp/relayer:**', 'Broadcasts the', 'MPC-signed swap', 'and waits for', 'one confirmation']),
        dict(kind='note', phase='broadcast', lane='evm', rows=2,
             lines=['**Vault\'s own account** calls,', 'on the **Uniswap Router**,',
                    '`exactOutputSingle(`{erc20AddressIn,}',
                    '{  erc20AddressOut, fee, vaultEvmAddress,}',
                    '{  amountOut, amountInMaximum, 0)}',
                    'The router pulls the **erc20AddressIn** it spends',
                    'and sends exactly **amountOut** of',
                    '**erc20AddressOut** back']),
    ]),
    dict(title='Attest and settle', phase='settle', rows=[
        dict(kind='arrow', step='6', phase='attestation', frm='mpc', to='evm',
             label=['**MPC:**', 'Picks up the outcome', 'once it is in a final block']),
        dict(kind='arrow', step=None, phase='attestation', frm='mpc', to='singleton',
             label=['**MPC:**', 'Attests the outcome', '`respondBidirectional(...)`'],
             side=dict(lane='mpc', lines=['**Attests:** verdict,', 'block height, output',
                                           '**With:** the response key,', 'which the vault stores as',
                                           '**mpcResponseKey**'])),
        dict(kind='arrow', step=None, phase='attestation', frm='dapp', to='singleton',
             label=['**dApp/relayer:**', 'Picks up the attestation from', '**RespondBidirectionalEvent**']),
        dict(kind='fork', step='7', phase='settle', frm='user', to='vault',
             arms=[['**User:**', 'Queues executed (32 bytes)', '`queueAttestation32(...)`'],
                   ['**User:**', 'Queues failed', 'or unviable', '(0 bytes)', '`queueAttestation0(...)`']]),
        dict(kind='arrow', step='8', phase='settle', frm='user', to='vault',
             label=['**User:**', 'Flushes the attestation', '`flushQueue(...)`'],
             side=dict(lane='vault', lines=['**Moves:** the attestation into',
                                             'the output buffer'])),
        dict(kind='arrow', step='9', phase='settle', frm='user', to='vault',
             label=['**User:**', 'Completes the swap', '`completeSwap(...)`'],
             side=dict(lane='vault', dy=-4, lines=['**With:** the request id,', 'the 32-byte output, a mint',
                                             'nonce, a change nonce'])),
        dict(kind='arrow', step=None, phase='settle', frm='vault', to='user',
             label=['**Vault:**', 'Mints the bought', 'tokens and change,', 'or re-mints the', 'surrendered coin'],
             side=dict(lane='vault', dy=-6, lines=['**Change:** **amountInMaximum**',
                                             'minus the attested **amountIn**,',
                                             'narrowed in-circuit by', '`swapAmountIn(...)`'])),
    ]),
]

OUTCOME_TITLE = 'After step 9'
OUTCOME = [
    '**Executed:** the swapper holds exactly **amountOut** of the **erc20AddressOut** vault token, plus **amountInMaximum** minus **amountIn** of **erc20AddressIn** as change (a zero-value coin on an exact spend).',
    '**Executed, amountIn at or above 2^64:** `swapAmountIn(...)` (**checkedTruncationU128**, then Uint<64>) aborts, so **completeSwap** fails under a valid signature: nothing mints.',
    '~Not reachable in practice: startSwap caps amountInMaximum, the most the router can spend, below 2^64.~',
    '**Failed** (reverted) **or unviable** (another transaction took its nonce)**:** the router pulled nothing, so **completeSwap** re-mints the whole **amountInMaximum** of **erc20AddressIn**.',
    '**Never mined:** the MPC attests nothing, and the coin stays burned until the deployer replaces the nonce.',
    '**Nonce replaced:** the swap is attested unviable, and completing it re-mints the surrendered coin.',
]
FOOTNOTE = ('The keys (vault account, response key) derive from **MPC_ROOT_PUBLIC_KEY** and '
            '**MIDNIGHT_VAULT_CONTRACT_ADDRESS**; see the README table "Derived keys and accounts".')

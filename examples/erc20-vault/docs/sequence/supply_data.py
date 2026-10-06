"""Supply round trip as data for build_sequence.py (format and markup: see its top).

Step numbers follow examples/erc20-vault/docs/supply/supply.md (9 steps).
"""

TITLE = 'Supply round trip'

LANES = [
    dict(id='user',      title='User',                           icon='user', sub='Midnight wallet'),
    dict(id='vault',     title='ERC20 Vault Contract',           icon='contract'),
    dict(id='singleton', title='Sig Network Singleton Contract', icon='signet'),
    dict(id='mpc',       title='Sig Network\nDistributed MPC',   icon='mpc-cluster'),
    dict(id='dapp',      title='Vault dApp/Relayer',             icon='contract'),
    dict(id='evm',       title='EVM Blockchain',                 icon='chain'),
]

GROUPS = [
    dict(id='midnight', icon='midnight', lanes=['vault', 'singleton']),
]

BANDS = [
    dict(title='Request', phase='request', rows=[
        # precondition, not a step: the deployer approves the wrapper once
        dict(kind='note', phase='pre', lane='evm', rows=2, overlay=True,
             lines=['**Before the first supply:**',
                    'the deployer runs `startApproveStata(...)`,',
                    'and the **vault\'s own account** calls',
                    '`approve(stataToken, unlimitedAllowance)`',
                    'on the **ERC20 Token** (the underlying)']),
        dict(kind='arrow', step='1', phase='request', frm='user', to='vault',
             label=['**User:**', 'Starts the supply and queues it', '`startSupply(...)`'],
             side=dict(lane='vault', lines=['**Reads:** the user\'s secret',
                                             '**Through:** the **callerSecretKey** witness',
                                             '**Burns:** the shielded underlying coin'])),
        dict(kind='arrow', step='2', phase='request', frm='user', to='vault',
             label=['**User:**', 'Flushes the request', '`flushQueue(...)`'],
             side=dict(lane='vault', lines=['**Assigns:** the next **vaultAccountNonce**',
                                             'as the request\'s EVM nonce',
                                             '**Moves:** the request into the output buffer'])),
        dict(kind='arrow', step='3', phase='request', frm='user', to='vault',
             label=['**User:**', 'Sends the request', '`sendSupply(...)`'],
             side=dict(lane='vault', lines=['**Records:** **bidirectionalSupplyMap**',
                                             '**Signer:** the vault\'s own account',
                                             '**Output:** one uint256, **shares**'])),
        dict(kind='arrow', step=None, phase='request', frm='vault', to='singleton',
             label=['**Vault:**', 'Notifies the MPC', '`signBidirectional(...)`']),
    ]),
    dict(title='Sign and execute', phase='signature', rows=[
        dict(kind='arrow', step='4', phase='signature', frm='mpc', to='vault',
             label=['**MPC:**', 'Reads the recorded request', 'from **bidirectionalSupplyMap**']),
        dict(kind='arrow', step=None, phase='signature', frm='mpc', to='singleton',
             label=['**MPC:**', 'Signs and posts the signature', '`respond(...)`'],
             side=dict(lane='mpc', lines=['**Signs:** the requested EVM transaction',
                                           '**With:** **derivedSigningKey** of the vault\'s',
                                           'own account, path `pad(32, "vault")`'])),
        dict(kind='arrow', step=None, phase='signature', frm='dapp', to='singleton',
             label=['**dApp/relayer:**', 'Picks up the signature from', '**SignatureRespondedEvent**']),
        dict(kind='arrow', step='5', phase='broadcast', frm='dapp', to='evm',
             label=['**dApp/relayer:**', 'Broadcasts the MPC-signed supply', 'and waits for one confirmation']),
        dict(kind='note', phase='broadcast', lane='evm', rows=2,
             lines=['**Vault\'s own account** calls',
                    '`deposit(amount, vaultEvmAddress)`',
                    'as `deposit(uint256,address)`, 2 words,',
                    'on the **Aave stata token**: it pulls the',
                    '**ERC20 Token** with **transferFrom** and',
                    'mints the shares to the same account']),
    ]),
    dict(title='Attest and settle', phase='settle', rows=[
        dict(kind='arrow', step='6', phase='attestation', frm='mpc', to='evm',
             label=['**MPC:**', 'Picks up the outcome', 'once it is in a final block']),
        dict(kind='arrow', step=None, phase='attestation', frm='mpc', to='singleton',
             label=['**MPC:**', 'Attests the outcome', '`respondBidirectional(...)`'],
             side=dict(lane='mpc', lines=['**Attests:** verdict, block height, output',
                                           '**With:** the response key, which the',
                                           'vault stores as **mpcResponseKey**'])),
        dict(kind='arrow', step=None, phase='attestation', frm='dapp', to='singleton',
             label=['**dApp/relayer:**', 'Picks up the attestation from', '**RespondBidirectionalEvent**']),
        dict(kind='fork', step='7', phase='settle', frm='user', to='vault',
             arms=[['**User:**', 'Queues executed (32 bytes)', '`queueAttestation32(...)`'],
                   ['**User:**', 'Queues failed or unviable (0 bytes)', '`queueAttestation0(...)`']]),
        dict(kind='arrow', step='8', phase='settle', frm='user', to='vault',
             label=['**User:**', 'Flushes the attestation', '`flushQueue(...)`'],
             side=dict(lane='vault', lines=['**Moves:** the attestation into',
                                             'the output buffer'])),
        dict(kind='arrow', step='9', phase='settle', frm='user', to='vault',
             label=['**User:**', 'Completes the supply', '`completeSupply(...)`'],
             side=dict(lane='vault', lines=['**With:** the request id, the 32-byte',
                                             'output, a mint nonce'])),
        dict(kind='arrow', step=None, phase='settle', frm='vault', to='user',
             label=['**Vault:**', 'Mints the shares as vault tokens,', 'or re-mints the surrendered coin']),
    ]),
]

OUTCOME_TITLE = 'After step 9'
OUTCOME = [
    '**Executed:** the user holds shielded stataToken vault coins for the attested shares, and the shares sit in the vault\'s EVM account.',
    '**Executed, shares at or above 2^64:** **supplyShares** narrows the uint256 in-circuit (**checkedTruncationU128**, then Uint<64>), so **completeSupply** fails under a valid signature: nothing mints.',
    '**Failed** (reverted) **or unviable** (another transaction took its nonce)**:** the wrapper took nothing, so **completeSupply** re-mints the surrendered underlying vault coin.',
    '**Never mined:** the MPC attests nothing, and the coin stays burned until the deployer replaces the nonce.',
    '**Nonce replaced:** the supply is attested unviable, and completing it re-mints the surrendered coin.',
]
FOOTNOTE = ('The keys (vault account, response key) derive from **MPC_ROOT_PUBLIC_KEY** and '
            '**MIDNIGHT_VAULT_CONTRACT_ADDRESS**; see the README table "Derived keys and accounts".')

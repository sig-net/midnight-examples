"""Withdraw round trip as data for build_sequence.py (format and markup: see its top).

Step numbers follow examples/erc20-vault/docs/withdraw/withdraw.md (9 steps).
No Fund band: the user already holds vault tokens, and the ERC20 already sits in the
vault's own EVM account.
"""

TITLE = 'withdraw-sequence'

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
        dict(kind='arrow', step='1', phase='request', frm='user', to='vault',
             label=['**User:**', 'Starts the withdrawal', '`startWithdraw(...)`'],
             side=dict(lane='vault', lines=['**Reads:** the user\'s secret',
                                             '**Through:** the **callerSecretKey** witness',
                                             '**Burns:** the surrendered vault coin'])),
        dict(kind='arrow', step='2', phase='request', frm='user', to='vault',
             label=['**User:**', 'Flushes the request', '`flushQueue(...)`'],
             side=dict(lane='vault', lines=['**Assigns:** the next **vaultAccountNonce**',
                                             'as the request\'s EVM nonce'])),
        dict(kind='arrow', step='3', phase='request', frm='user', to='vault',
             label=['**User:**', 'Sends the request', '`sendWithdraw(...)`'],
             side=dict(lane='vault', lines=['**Records:** **bidirectionalWithdrawMap**',
                                             '**Signer:** the vault\'s own account',
                                             '**Output:** one bool, **success**'])),
        dict(kind='arrow', step=None, phase='request', frm='vault', to='singleton',
             label=['**Vault:**', 'Notifies the MPC', '`signBidirectional(...)`']),
    ]),
    dict(title='Sign and execute', phase='signature', rows=[
        dict(kind='arrow', step='4', phase='signature', frm='mpc', to='vault',
             label=['**MPC:**', 'Reads the recorded request', 'from **bidirectionalWithdrawMap**']),
        dict(kind='arrow', step=None, phase='signature', frm='mpc', to='singleton',
             label=['**MPC:**', 'Signs and posts the signature', '`respond(...)`'],
             side=dict(lane='mpc', lines=['**Signs:** the requested EVM transaction',
                                           '**With:** **derivedSigningKey** of the vault\'s',
                                           'own account, path `pad(32, "vault")`'])),
        dict(kind='arrow', step=None, phase='signature', frm='dapp', to='singleton',
             label=['**dApp/relayer:**', 'Picks up the signature from', '**SignatureRespondedEvent**']),
        dict(kind='arrow', step='5', phase='broadcast', frm='dapp', to='evm',
             label=['**dApp/relayer:**', 'Broadcasts the MPC-signed transfer', 'and waits for one confirmation']),
        dict(kind='note', phase='broadcast', lane='evm', rows=2,
             lines=['**Vault\'s own account** calls',
                    '`transfer(destEvmAddress, amount)`',
                    'on the **ERC20 Token**: the amount',
                    'moves out of the vault to the',
                    '**Destination account** the user named']),
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
             arms=[['**User:**', 'Queues an executed verdict', '`queueAttestation1(...)`'],
                   ['**User:**', 'Queues a failed or unviable verdict', '`queueAttestation0(...)`']]),
        dict(kind='arrow', step='8', phase='settle', frm='user', to='vault',
             label=['**User:**', 'Flushes the attestation', '`flushQueue(...)`']),
        dict(kind='arrow', step='9', phase='settle', frm='user', to='vault',
             label=['**User:**', 'Completes the withdrawal', '`completeWithdraw(...)`'],
             side=dict(lane='vault', lines=['**With:** the request id, the output,',
                                             'a random mint nonce'])),
        dict(kind='arrow', step=None, phase='settle', frm='vault', to='user',
             label=['**Vault:**', 'Mints nothing on a true transfer,', 'or re-mints the surrendered coin']),
    ]),
]

OUTCOME_TITLE = 'After step 9'
OUTCOME = [
    '**Executed, transfer returned true:** the ERC20 sits in the destination account. The burn stands: the request closes with no mint.',
    '**Executed, transfer returned false:** nothing moved, so **completeWithdraw** re-mints the surrendered vault tokens to the user.',
    '**Failed** (reverted) **or unviable** (another transaction took its nonce)**:** nothing moved, so **completeWithdraw** re-mints the surrendered vault tokens.',
    '**Never mined:** the MPC attests nothing, and the coin stays burned until the deployer replaces the nonce (**startReplaceNonce**).',
    '**Nonce replaced:** the withdrawal is attested unviable, and completing it re-mints the surrendered coin.',
]
FOOTNOTE = ('The keys (vault account, response key) derive from **MPC_ROOT_PUBLIC_KEY** and '
            '**MIDNIGHT_VAULT_CONTRACT_ADDRESS**; see the README table "Derived keys and accounts".')

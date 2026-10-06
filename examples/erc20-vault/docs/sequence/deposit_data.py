"""Deposit round trip as data for build_sequence.py (format and markup: see its top).

Step numbers follow examples/erc20-vault/docs/deposit/deposit.md (10 steps).
"""

TITLE = 'deposit-sequence'

LANES = [
    dict(id='user',      title='User',                           icon='user', sub='Midnight wallet, EVM wallet'),
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
    dict(title='Fund', phase='fund', rows=[
        dict(kind='arrow', step='1', phase='fund', frm='user', to='evm',
             label=['**User:**', 'Funds the deposit account from the EVM wallet',
                    'with the ERC20 being deposited, plus gas ETH']),
        dict(kind='note', phase='fund', lane='evm', rows=2,
             lines=['**User\'s deposit account**',
                    'An EVM address the MPC derives',
                    'from `VAULT_USER_SECRET_KEY`',
                    'via **userCommitment**. Only the MPC',
                    'can sign for it.']),
    ]),
    dict(title='Request', phase='request', rows=[
        dict(kind='arrow', step='2', phase='request', frm='user', to='vault',
             label=['**User:**', 'Starts the deposit', '`startDeposit(...)`'],
             side=dict(lane='vault', lines=['**Reads:** the user\'s secret',
                                             '**Through:** the **callerSecretKey** witness'])),
        dict(kind='arrow', step='3', phase='request', frm='user', to='vault',
             label=['**User:**', 'Flushes the request', '`flushQueue(...)`']),
        dict(kind='arrow', step='4', phase='request', frm='user', to='vault',
             label=['**User:**', 'Sends the request', '`sendDeposit(...)`'],
             side=dict(lane='vault', lines=['**Records:** **bidirectionalDepositMap**',
                                             '**Signer:** the user\'s deposit account',
                                             '**Output:** one bool, **success**'])),
        dict(kind='arrow', step=None, phase='request', frm='vault', to='singleton',
             label=['**Vault:**', 'Notifies the MPC', '`signBidirectional(...)`']),
    ]),
    dict(title='Sign and execute', phase='signature', rows=[
        dict(kind='arrow', step='5', phase='signature', frm='mpc', to='vault',
             label=['**MPC:**', 'Reads the recorded request', 'from **bidirectionalDepositMap**']),
        dict(kind='arrow', step=None, phase='signature', frm='mpc', to='singleton',
             label=['**MPC:**', 'Signs and posts the signature', '`respond(...)`'],
             side=dict(lane='mpc', lines=['**Signs:** the requested EVM transaction',
                                           '**With:** **derivedSigningKey** of the user\'s',
                                           'deposit account, path **userCommitment**'])),
        dict(kind='arrow', step=None, phase='signature', frm='dapp', to='singleton',
             label=['**dApp/relayer:**', 'Picks up the signature from', '**SignatureRespondedEvent**']),
        dict(kind='arrow', step='6', phase='broadcast', frm='dapp', to='evm',
             label=['**dApp/relayer:**', 'Broadcasts the MPC-signed sweep', 'and waits for one confirmation']),
        dict(kind='note', phase='broadcast', lane='evm', rows=2,
             lines=['**User\'s deposit account** calls',
                    '`transfer(vaultEvmAddress, amount)`',
                    'on the **ERC20 Token**: the amount',
                    'moves to the **vault\'s own account**,',
                    'derived with the path **"vault"**']),
    ]),
    dict(title='Attest and settle', phase='settle', rows=[
        dict(kind='arrow', step='7', phase='attestation', frm='mpc', to='evm',
             label=['**MPC:**', 'Picks up the outcome', 'once it is in a final block']),
        dict(kind='arrow', step=None, phase='attestation', frm='mpc', to='singleton',
             label=['**MPC:**', 'Attests the outcome', '`respondBidirectional(...)`'],
             side=dict(lane='mpc', lines=['**Attests:** verdict, block height, output',
                                           '**With:** the response key, which the',
                                           'vault stores as **mpcResponseKey**'])),
        dict(kind='arrow', step=None, phase='attestation', frm='dapp', to='singleton',
             label=['**dApp/relayer:**', 'Picks up the attestation from', '**RespondBidirectionalEvent**']),
        dict(kind='fork', step='8', phase='settle', frm='user', to='vault',
             arms=[['**User:**', 'Queues an executed verdict', '`queueAttestation1(...)`'],
                   ['**User:**', 'Queues a failed or unviable verdict', '`queueAttestation0(...)`']]),
        dict(kind='arrow', step='9', phase='settle', frm='user', to='vault',
             label=['**User:**', 'Flushes the attestation', '`flushQueue(...)`']),
        dict(kind='arrow', step='10', phase='settle', frm='user', to='vault',
             label=['**User:**', 'Completes the deposit', '`completeDeposit(...)`'],
             side=dict(lane='vault', lines=['**With:** the request id, the output,',
                                             'a mint nonce, an optional recipient'])),
        dict(kind='arrow', step=None, phase='settle', frm='vault', to='user',
             label=['**Vault:**', 'Mints the amount as vault tokens,', 'or only closes the request']),
    ]),
]

OUTCOME_TITLE = 'After step 10'
OUTCOME = [
    '**Executed, transfer returned true:** the user holds shielded vault tokens for the amount, and the ERC20 sits in the vault\'s EVM account.',
    '**Executed, transfer returned false:** the request only closes, and nothing mints. A deposit burns no coin, so nothing is re-minted.',
    '**Failed** (reverted) **or unviable** (another transaction took its nonce)**:** the request only closes, and nothing mints.',
    '**Never mined:** the MPC attests nothing, and the request stays open. The user surrendered no coin.',
    '**Nonce replaced:** the user\'s new deposit at the same nonce executes, so the first is attested unviable and closes.',
]
FOOTNOTE = ('The keys (deposit account, vault account, response key) derive from **MPC_ROOT_PUBLIC_KEY** and '
            '**MIDNIGHT_VAULT_CONTRACT_ADDRESS**; see the README table "Derived keys and accounts".')

# Base Sepolia Deployment — Escrow (packages/contracts)

Everything is staged: the deployment is **one command once the deployer wallet
is funded**. No deployment has been attempted yet (wallet has no funds — that
is the expected pre-funding state and the preflight confirms it fails cleanly).

## Deployer wallet (TESTNET ONLY)

| | |
|---|---|
| Address | `0x141CE1d2d078F3f3e7FF510874A8698414f22141` |
| Key location | `packages/contracts/.env` → `DEPLOYER_PRIVATE_KEY` |
| Git status | ignored — root `.gitignore` line `.env` (verified with `git check-ignore -v`) |
| Generated | ethers v6 `Wallet.createRandom()`, fresh key, never used anywhere else |

**Rules:** this key exists only in the git-ignored `.env` on this machine. It is
never printed in reports/logs/commits. It must NEVER hold mainnet assets; if it
is ever exposed or funded with real value, rotate to a fresh key.

Verify the key is wired up without exposing it:

```bash
cd packages/contracts
set -a; source .env; set +a   # loads DEPLOYER_PRIVATE_KEY etc. into env
npx hardhat run scripts/deploy/baseSepolia.ts --network baseSepolia
```

## Network facts

| | |
|---|---|
| Network | Base Sepolia testnet |
| Chain ID | `84532` |
| RPC | `https://sepolia.base.org` (override via `BASE_SEPOLIA_RPC_URL`) |
| Explorer | https://sepolia.basescan.org |
| USDC (real Circle) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals) |
| Contract | `Escrow.sol` — fee 50 bps (0.5%), 48h dispute window (`DISPUTE_WINDOW = 172800`) |
| Treasury | placeholder = the deployer address (set in `.env`; change if desired) |

## Funding instructions (owner gate)

The wallet needs **Base Sepolia ETH** for gas before anything can deploy:

- **Official Base faucet:** https://faucet.base.org — distributes Base Sepolia ETH.
- **Alchemy faucet:** https://www.alchemy.com/faucets/base-sepolia — Base Sepolia ETH (requires a free Alchemy account).

Suggested amount: **≥ 0.01 ETH** (deploy + demo interactions cost far less, but
faucets can be stingy — a buffer avoids a second faucet trip).

For the **USDC side** (needed to fund deals *after* deployment, not for the
deployment itself):

- **Circle testnet faucet:** https://faucet.circle.com — select Base Sepolia, mint testnet USDC to the deployer address.

## Preflight (dry run — no funds required, expected to fail cleanly)

```bash
cd packages/contracts
set -a; source .env; set +a
npx hardhat run scripts/deploy/baseSepolia.ts --network baseSepolia
```

Expected output pre-funding (the script checks gas balance before touching any
token state and exits with code 1):

```
Error: Insufficient funds — deployer 0x141CE1d2d078F3f3e7FF510874A8698414f22141
has 0.0 ETH; fund it first (Base Sepolia faucet — see DEPLOYMENT.md)
```

Do not loop-retry: a failed preflight pre-funding is the correct state.

## Actual deployment (run only once funded)

```bash
cd packages/contracts
set -a; source .env; set +a
npx hardhat run scripts/deploy/baseSepolia.ts --network baseSepolia
```

What it does:

1. Validates env, network (84532), the real USDC (code + 6 decimals), and gas balance.
2. Deploys `Escrow(deployer, treasury, 50)` against real USDC.
3. **Writes `deployment/manifest.baseSepolia.json` automatically** (network,
   chain id, escrow + treasury addresses, deploy tx hash, block number,
   timestamp, on-chain feeBps/treasury read back from the contract).

Commit the generated manifest as the deployment record. It contains public
on-chain facts only — never keys.

## Manifest (post-hoc regeneration)

If the manifest is ever lost or you need to regenerate it for an existing
deployment:

```bash
cd packages/contracts
set -a; source .env; set +a          # plus ESCROW_ADDRESS / ESCROW_DEPLOY_TX
npx hardhat run scripts/manifest.ts --network baseSepolia
```

If `ESCROW_DEPLOY_TX` is provided, the generator verifies on-chain that the tx
actually created the claimed Escrow address and refuses to write a mismatched
manifest.

## File layout (this slice)

```
packages/contracts/
├── .env                    # gitignored — holds DEPLOYER_PRIVATE_KEY (+ USDC/treasury/RPC)
├── .env.example            # committed template
├── DEPLOYMENT.md           # this file
├── scripts/
│   ├── deploy/baseSepolia.ts   # deployment entry (balance preflight + manifest write)
│   ├── manifest.ts             # CLI: regenerate manifest post-deploy
│   └── lib/manifest.ts         # shared manifest builder
└── deployment/             # created at deploy time; commit manifest.*.json then
```

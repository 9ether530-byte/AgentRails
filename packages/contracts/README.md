# @agentrails/contracts

Milestone-based USDC escrow for autonomous agent commerce on Base. Slice 1 of the
AgentRails MVP: the foundation the escrow service, pay-per-call layer, and ops
loop wrap around.

## Quickstart

```bash
cd packages/contracts
bash scripts/rebuild-node-modules.sh   # once, or after every reboot
npx hardhat compile
npx hardhat test
```

**Why not `npm install` here:** /home is a small (300MB) volume and this
package's dependency tree is ~450MB unpacked — a direct install dies with
`ENOSPC`. The rebuild script installs the tree on the root disk at
`/tmp/ar-contracts` (cache in `/tmp/npm-cache`) and symlinks it in as
`node_modules`. `/tmp` does not survive a reboot; the script is the one
command that brings the toolchain back.

Node 18+ required. Dependencies: `hardhat`, `ethers` v6, the Hardhat
ethers/chai-matchers/network-helpers plugins, and `@openzeppelin/contracts` v5.

## Layout

```
contracts/Escrow.sol            milestone escrow (the main contract)
contracts/MockUSDC.sol          6-decimal ERC20 mock for tests/local demos (never deploy)
contracts/mocks/ReentrantToken.sol  malicious ERC20 for reentrancy tests
scripts/deploy/local.ts         local deploy: MockUSDC + Escrow + demo deal
scripts/deploy/baseSepolia.ts   Base Sepolia deploy against real USDC (env-driven)
test/Escrow.ts                  full Hardhat unit suite
```

Note: we use the Hardhat plugin packages directly
(`@nomicfoundation/hardhat-ethers`, `hardhat-chai-matchers`,
`hardhat-network-helpers`) instead of the `hardhat-toolbox` meta-package, which
pulls heavy extras (coverage, gas reporter, ignition, typechain) this repo does
not use.

## Escrow design

Roles:

- **buyer** — creates the deal, funds it, may dispute within the window, and
  holds the refund rights described below.
- **seller** — submits a keccak256 proof hash per milestone and receives
  payouts.
- **verifier** — trusted off-chain oracle (v0): approves submissions and
  resolves disputes.
- **treasury** — receives the 50 bps fee on each released milestone.
- **admin** (owner, two-step transfer) — can only change the treasury address
  and the fee (hard-capped at `MAX_FEE_BPS` = 10%). Cannot move user funds.

Deal lifecycle:

```
createDeal(seller, verifier, token, milestoneAmounts[])   -> Created
deposit()                                                 -> Funded
per milestone:
  Pending   --submitMilestoneProof(seller)-->             Submitted
  Submitted --approveMilestone(verifier)-->               Approved  [48h window]
  Approved  --finalizeMilestone(anyone, after window)-->  Released
  Approved  --disputeMilestone(buyer, within window)-->   Disputed
  Disputed  --resolveDispute(verifier)-->                 Released | Refunded
  Pending   --refundPendingMilestones(buyer)-->           Refunded
cancelDeal(buyer): Created (no refund needed) or Funded with ALL milestones
still Pending (full refund) -> Cancelled
```

Fee accounting: on each released milestone the contract takes
`fee = amount * feeBps / 10_000` (rounded down) for the treasury and sends the
remainder to the seller. `fee + sellerAmount == amount` exactly, so a fully
settled deal leaves no dust. Refunds carry no fee.

### Dispute policy (v0)

- After the verifier approves, a 48-hour window opens. The buyer may dispute
  within it; the verifier then resolves by releasing to the seller or
  refunding the buyer in full.
- If the window elapses uncontested, **anyone** (a keeper) can call
  `finalizeMilestone` to complete the release — the release never depends on a
  single party staying responsive.
- Disputing after the window is impossible; the milestone can only finalize.

### Refund policy (v0) and why

- **Unfunded deal**: the buyer can cancel at any time; nothing has moved.
- **Funded deal with every milestone still Pending** (no proof submitted
  anywhere): the buyer can cancel and get a full refund. The seller has
  demonstrably not started.
- **Never-submitted milestones in a partially active deal**:
  `refundPendingMilestones` lets the buyer reclaim exactly the milestones the
  seller has not submitted work for, keeping released/in-flight milestones
  intact. This is deliberately unilateral: the seller's protection is to
  submit proofs promptly, and it keeps v0 free of timeout machinery. Once a
  milestone is Submitted/Approved/Disputed, it can only follow the
  verifier-mediated flow.
- **Dispute refund**: the verifier can refund a disputed milestone in full to
  the buyer (no fee taken on refunds).

## Trust model (honest version)

- **The verifier is a centralized oracle in v0.** It can approve any submitted
  proof and single-handedly decides disputed milestones; a malicious or
  compromised verifier can steer funds to either party, with no on-chain
  appeal. Treat verifier selection as the security of this contract.
- **Verifier liveness is required**: Approved milestones finalize without the
  verifier, but Disputed milestones are stuck until it resolves them, and
  Submitted milestones are stuck until it approves. There is no deadline
  escape in v0.
- **Buyer-favoring asymmetry**: the buyer can cancel pre-funding, cancel a
  fully-pending funded deal, and reclaim any never-submitted milestone at any
  time. Sellers carry counterparty risk; submit promptly.
- **Admin powers are minimal** (treasury address, capped fee) but real; the
  owner key should be held accordingly (two-step transfer is enforced).
- Unaudited v0 software holding real funds: **Base Sepolia testnet only**.
  Mainnet requires an independent audit and owner sign-off.
- Assumes a standard ERC20 (USDC is one): no fee-on-transfer or rebasing
  tokens, and no ERC777-style hooks.

## Deploy

Local (MockUSDC + Escrow + a funded demo deal):

```bash
npx hardhat run scripts/deploy/local.ts
```

Base Sepolia — wire the real USDC address via env vars only; it is never
hardcoded in the contract:

```bash
cp .env.example .env   # then fill in:
#   BASE_SEPOLIA_RPC_URL   default https://sepolia.base.org
#   DEPLOYER_PRIVATE_KEY   fresh testnet-only key (fund from a faucet)
#   USDC_TOKEN_ADDRESS     0x036CbD53842c5426634e7929541eC2318f3dCF7e
#   TREASURY_ADDRESS       fee recipient
export $(grep -v '^#' .env | xargs)
npx hardhat run scripts/deploy/baseSepolia.ts --network baseSepolia
```

The script sanity-checks that the token address is a deployed contract with 6
decimals and that the deployer holds gas, then deploys Escrow with the given
treasury and 50 bps fee.

## Test coverage

`test/Escrow.ts` covers: deployment params, deal creation/validation, deposit,
cancel paths, proof submission, approval, keeper auto-release after the 48h
window, the full dispute + resolution flow (both outcomes), pending-milestone
refunds, exact fee accounting (including fee-rounding on a 1-base-unit
milestone and zero dust after full settlement), unauthorized access on every
role-guarded function, two-step ownership, multi-deal isolation, and
reentrancy attempts on `deposit` and `finalizeMilestone` via a malicious
ERC20 hook.

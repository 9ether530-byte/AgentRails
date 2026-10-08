# AgentRails monorepo

Payment rails for autonomous AI agents on Base (Base Sepolia testnet first):

- **packages/contracts** — Hardhat project: milestone-based USDC escrow contract,
  6-decimal MockUSDC for tests/local demos, and deploy scripts for local +
  Base Sepolia.

## Status

Slice 1 of the MVP: escrow contract + full Hardhat test suite. See
[packages/contracts/README.md](packages/contracts/README.md) for design docs,
the trust model, and how to run/deploy.

## Structure

Packages are installed individually. `packages/contracts` is special: /home is
too small for its dependency tree, so `node_modules` is a symlink to a /tmp
install. Do not run plain `npm install` there — run:

```bash
bash packages/contracts/scripts/rebuild-node-modules.sh
```

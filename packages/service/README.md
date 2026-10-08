# @agentrails/service

Thin TypeScript service wrapping the AgentRails **Escrow** contract (slice 1)
plus an event indexer. Slice 2 of the MVP: the HTTP surface the pay-per-call
layer, subscription manager and ops loop will build on.

## What this is (and is not) — operator model, stated plainly

**v0 is single-operator mode.** One wallet (`OPERATOR_PRIVATE_KEY`) signs every
transaction the service sends and is the **buyer** on every deal: it creates the
deal and funds it from its own token balance. The seller and verifier are
plain addresses supplied per request — the service does not hold their keys.

Consequences, stated honestly:

- The full lifecycle (submit proof, approve, resolve disputes) can only run
  through this service when the deal's seller/verifier **is the operator
  address** (a "self-deal"). That is the intended v0 demo/ops pattern.
  Submitting/approving against a deal whose seller/verifier is someone else
  fails fast with HTTP 409 `ROLE_NOT_SIGNABLE` — no gas spent, the service
  simply cannot sign for a wallet it does not hold.
- The service therefore **has custody**: whoever can reach this API can spend
  the operator's gas and move its tokens through legitimate deal actions.
  There is no authentication in v0. Bind it to localhost, or put it behind
  whatever auth your deployment front door provides, before exposing it.
- The on-chain trust model is unchanged from the contracts package: the
  verifier is a centralized oracle, admin powers are minimal but real, and
  this software is unaudited — **Base Sepolia testnet only**.

## Layout

```
src/config.ts    env parsing (fail-fast)
src/abis.ts      loads the Escrow/MockUSDC artifacts from packages/contracts
src/errors.ts    revert-name -> HTTP status/code translation, JSON envelope
src/db.ts        SQLite schema + event queries (better-sqlite3)
src/indexer.ts   polling event indexer (idempotent, resumable)
src/state.ts     on-chain deal + milestone reads, serialized for JSON
src/tx.ts        staticCall pre-flight + send + wait, mapped errors
src/routes.ts    the endpoint handlers + input validation
src/app.ts       express app factory (healthz, router, error middleware)
src/server.ts    production entrypoint (env -> provider -> listen)
test/            integration suite (in-process hardhat network + supertest)
```

The service reads the contract **artifacts** from `packages/contracts`
(single source of truth for the ABI — no duplicated contract sources, no
code-generated typechain bindings).

## Quickstart

```bash
cd packages/contracts
bash scripts/rebuild-node-modules.sh   # once, or after every reboot (rebuilds BOTH packages)
npx hardhat compile                    # if artifacts/ are missing (gitignored)

cd ../service
npx tsc --noEmit        # compile check
npm test                # integration suite against the in-process hardhat network
```

**Why not `npm install` here:** /home is a 300MB volume; this package's tree
(the service deps plus the hardhat toolchain for tests) is ~350MB unpacked.
`scripts/rebuild-node-modules.sh` installs it on the root disk at
`/tmp/ar-service` (npm cache in `/tmp/npm-cache`) and symlinks it in as
`node_modules`, exactly like the contracts package. `/tmp` does not survive a
reboot — the script is the one command that brings the whole toolchain back.

## Running locally

1. Start a local chain and deploy (from `packages/contracts`):

   ```bash
   npx hardhat node &                                  # terminal 1
   npx hardhat run scripts/deploy/local.ts --network localhost   # prints the Escrow address
   ```

2. Configure and boot the service (from `packages/service`):

   ```bash
   cp .env.example .env    # fill ESCROW_ADDRESS with the address printed above
   export $(grep -v '^#' .env | xargs)
   npm run dev
   ```

   The `.env.example` operator key is hardhat node's well-known account #0 —
   it comes pre-funded with test ETH and you can mint it MockUSDC in the
   deploy script's chain. It is safe ONLY on a local test chain.

3. Exercise a deal (single-operator self-play):

   ```bash
   curl -s localhost:3001/healthz
   curl -s localhost:3001/deals -H 'content-type: application/json' -d '{
     "seller": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
     "verifier": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
     "token": "<MOCK_USDC_ADDRESS>",
     "milestoneAmounts": ["1500000", "2500000"] }'
   curl -s -XPOST localhost:3001/deals/1/deposit
   curl -s -XPOST localhost:3001/deals/1/milestones/0/submit \
        -H 'content-type: application/json' -d '{"proof":"did the work"}'
   # ... approve / (wait out the window on testnet) / finalize, then:
   curl -s localhost:3001/deals/1
   curl -s localhost:3001/deals/1/events
   ```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | liveness + chain/escrow/operator identity + indexer state |
| POST | `/deals` | create a deal (buyer = operator). Body: `{seller, verifier, token, milestoneAmounts[]}` |
| POST | `/deals/:id/deposit` | fund the deal; grants the escrow an exact-size token allowance first if needed |
| POST | `/deals/:id/milestones/:index/submit` | seller submits proof. Body: `{proofHash}` (32-byte hex) or `{proof}` (raw string, keccak-hashed by the service) |
| POST | `/deals/:id/milestones/:index/approve` | verifier approves, opening the 48h dispute window |
| POST | `/deals/:id/milestones/:index/dispute` | buyer disputes within the window |
| POST | `/deals/:id/milestones/:index/resolve` | verifier resolves. Body: `{releaseToSeller: boolean}` |
| POST | `/deals/:id/milestones/:index/finalize` | keeper-style release after the window elapses (no role required) |
| GET | `/deals/:id` | full on-chain state: deal + per-milestone status + `closed` |
| GET | `/deals/:id/events` | indexed event history for the deal |

**Create vs deposit are separate calls** on purpose: `POST /deals` moves no
money (the deal exists unfunded until `deposit`), so a caller can create first
and fund after a check of its own. Amounts are base-unit integers as strings
(USDC has 6 decimals: `"1500000"` = 1.50 USDC). Deal ids and all big numbers
in responses are JSON strings.

Not exposed in v0 (contract supports them; the single-operator API makes them
low-value for now): `cancelDeal`, `refundPendingMilestones`.

## Error envelope

Every error is `{"error": {"code": "...", "message": "...", "details": ...}}`:

- `400` — validation: `INVALID_ADDRESS`, `INVALID_MILESTONE_AMOUNTS`,
  `INVALID_PROOF_HASH`, `INVALID_JSON`, `INVALID_DEAL_ID`, ...
- `404` — `NOT_FOUND`, `DEAL_NOT_FOUND`, `MILESTONE_NOT_FOUND`
- `409` — chain-state and role conflicts, mapped from on-chain reverts:
  `WRONG_DEAL_STATE`, `MILESTONE_NOT_PENDING|SUBMITTED|APPROVED|DISPUTED`,
  `DISPUTE_WINDOW_ACTIVE|ELAPSED`, `ROLE_NOT_SIGNABLE`, `NOT_*` role reverts,
  `INSUFFICIENT_TOKEN_BALANCE|ALLOWANCE`, `OPERATOR_NO_GAS`, `CALL_REVERTED`
- `500` — `INTERNAL`, `TX_FAILED`

Every mutating endpoint runs a **static-call pre-flight** first: a revert
surfaces as a clean 4xx with the decoded contract error, without spending gas
on a doomed transaction.

## Event indexer

Polls the Escrow contract on an interval (`INDEXER_INTERVAL_MS`, default 2s)
and persists every event into SQLite at `DB_PATH` (default
`data/agentrails.db`, gitignored). Design notes:

- Idempotent and resumable: `UNIQUE(block_hash, log_index)` means re-scans
  insert nothing; the last scanned block is stored in the DB, so a restart
  continues where it left off.
- `tick()` is exposed for tests and for the future ops loop to force a scan.
- Known v0 limitation: **reorgs are not handled** — fine for a testnet MVP;
  finality-aware scanning comes with the ops loop slice.

## Environment variables

| Var | Required | Meaning |
|---|---|---|
| `OPERATOR_PRIVATE_KEY` | yes | the operator wallet (buyer) — see the honesty section above |
| `ESCROW_ADDRESS` | yes | deployed Escrow contract |
| `RPC_URL` | no | default `http://127.0.0.1:8545` (use a Base Sepolia RPC for testnet) |
| `PORT` | no | default `3001` (3000 is the team's public site) |
| `DB_PATH` | no | default `data/agentrails.db` |
| `INDEXER_INTERVAL_MS` | no | default `2000` |

`npm run dev` / `npm start` boot it. See `.env.example`.

## Trust model summary (service level)

- Single operator key holds buyer (and typically seller/verifier) powers —
  key compromise = full control of the service's deals and tokens.
- No API auth in v0; network placement is the access control.
- Funds flow through the unaudited v0 Escrow contract; testnet only until
  audited and owner-approved.

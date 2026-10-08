import type { RequestHandler, Router } from "express";
import { Router as expressRouter } from "express";
import { Contract, Interface, isAddress, getAddress, keccak256, toUtf8Bytes } from "ethers";
import type { Wallet } from "ethers";
import type Database from "better-sqlite3";
import { AppError, mapRevertError } from "./errors";
import { listDealEvents } from "./db";
import { readDeal } from "./state";
import { execTx } from "./tx";

export interface RouterDeps {
  escrow: Contract; // connected to the operator wallet
  operator: Wallet;
  escrowAddress: string;
  db: Database.Database;
}

// Minimal ERC20 surface needed for the deposit flow (approve + allowance on
// whatever token the deal names). Full ERC20 is deliberately not assumed.
const ERC20_ABI = new Interface([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const MAX_MILESTONES = 100;

// ---------------------------------------------------------------------------
// Validation helpers — all throw AppError(400/404) on bad input.
// ---------------------------------------------------------------------------

function requireJsonObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, "INVALID_BODY", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function parseAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new AppError(400, "INVALID_ADDRESS", `${field} must be a valid 20-byte hex address`);
  }
  const addr = getAddress(value);
  if (addr === "0x0000000000000000000000000000000000000000") {
    throw new AppError(400, "ZERO_ADDRESS", `${field} must not be the zero address`);
  }
  return addr;
}

function parseDealId(raw: string): bigint {
  if (!/^[1-9][0-9]{0,17}$/.test(raw)) {
    throw new AppError(400, "INVALID_DEAL_ID", "deal id must be a positive integer");
  }
  return BigInt(raw);
}

function parseMilestoneIndex(raw: string): number {
  if (!/^\d{1,9}$/.test(raw)) {
    throw new AppError(400, "INVALID_MILESTONE_INDEX", "milestone index must be a non-negative integer");
  }
  return Number.parseInt(raw, 10);
}

/**
 * Milestone amounts are base-unit integers (USDC uses 6 decimals: "1500000"
 * = 1.50 USDC). Accept decimal strings or safe integers; reject anything
 * else, zero included — the contract reverts ZeroAmount otherwise.
 */
function parseMilestoneAmounts(value: unknown): bigint[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError(
      400,
      "INVALID_MILESTONE_AMOUNTS",
      "milestoneAmounts must be a non-empty array of positive base-unit integers"
    );
  }
  if (value.length > MAX_MILESTONES) {
    throw new AppError(400, "TOO_MANY_MILESTONES", `at most ${MAX_MILESTONES} milestones per deal`);
  }
  return value.map((entry) => {
    let amount: bigint;
    if (typeof entry === "number") {
      if (!Number.isSafeInteger(entry) || entry <= 0) {
        throw new AppError(
          400,
          "INVALID_MILESTONE_AMOUNTS",
          "each milestone amount must be a positive integer (base units)"
        );
      }
      amount = BigInt(entry);
    } else if (typeof entry === "string" && /^\d+$/.test(entry) && entry.length <= 40) {
      amount = BigInt(entry);
      if (amount === 0n) {
        throw new AppError(400, "INVALID_MILESTONE_AMOUNTS", "milestone amounts must be positive");
      }
    } else {
      throw new AppError(
        400,
        "INVALID_MILESTONE_AMOUNTS",
        "each milestone amount must be a positive integer (base units), as number or decimal string"
      );
    }
    return amount;
  });
}

/**
 * Either a 32-byte proof hash ("proofHash") or a raw proof string ("proof")
 * that the service hashes with keccak256 — mirroring the contract's
 * keccak256-preimage convention.
 */
function parseProofHash(body: Record<string, unknown>): string {
  const { proofHash, proof } = body;
  if (proofHash !== undefined) {
    if (typeof proofHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(proofHash)) {
      throw new AppError(400, "INVALID_PROOF_HASH", "proofHash must be a 0x-prefixed 32-byte hex string");
    }
    return proofHash;
  }
  if (proof !== undefined) {
    if (typeof proof !== "string" || proof.length === 0 || proof.length > 4096) {
      throw new AppError(400, "INVALID_PROOF", "proof must be a non-empty string (max 4096 chars)");
    }
    return keccak256(toUtf8Bytes(proof));
  }
  throw new AppError(400, "PROOF_REQUIRED", "provide proofHash (32-byte hex) or proof (raw string)");
}

function requireDealId(rawDealId: string, deps: RouterDeps): Promise<Record<string, unknown>> {
  const dealId = parseDealId(rawDealId);
  return (async () => {
    try {
      return (await deps.escrow.getDeal(dealId)) as unknown as Record<string, unknown>;
    } catch (err) {
      throw mapRevertError(err); // DealNotFound -> 404
    }
  })();
}

function requireRole(
  operator: Wallet,
  deal: Record<string, unknown>,
  field: "buyer" | "seller" | "verifier",
  action: string
): void {
  const holder = String(deal[field]);
  if (holder !== operator.address) {
    throw new AppError(
      409,
      "ROLE_NOT_SIGNABLE",
      `single-operator mode: the service only holds the operator key, which is the buyer. ` +
        `To ${action}, the ${field} (${holder}) would have to sign — not possible here. ` +
        `Create self-deals (seller/verifier = operator address) for the full lifecycle.`
    );
  }
}

function asyncHandler(fn: (req: any, res: any) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function buildRouter(deps: RouterDeps): Router {
  const { escrow, operator, escrowAddress, db } = deps;

  const router = expressRouter();

  // -----------------------------------------------------------------------
  // POST /deals — create a deal. The operator (service wallet) becomes the
  // buyer on-chain; funding is a separate call (POST /deals/:id/deposit) so
  // callers control when money moves.
  // -----------------------------------------------------------------------
  router.post(
    "/deals",
    asyncHandler(async (req, res) => {
      const body = requireJsonObject(req.body);
      const seller = parseAddress(body.seller, "seller");
      const verifier = parseAddress(body.verifier, "verifier");
      const token = parseAddress(body.token, "token");
      const amounts = parseMilestoneAmounts(body.milestoneAmounts);

      const outcome = await execTx(escrow.createDeal, [seller, verifier, token, amounts.map(String)]);

      let dealId: string | undefined;
      for (const log of outcome.receipt.logs) {
        const parsed = escrow.interface.parseLog(log);
        if (parsed?.name === "DealCreated") {
          dealId = BigInt(parsed.args.dealId).toString();
          break;
        }
      }
      if (!dealId) throw new AppError(500, "INTERNAL", "DealCreated event missing from receipt");

      res.status(201).json({
        dealId,
        buyer: operator.address,
        seller,
        verifier,
        token,
        totalAmount: amounts.reduce((a, b) => a + b, 0n).toString(),
        milestoneAmounts: amounts.map((a) => a.toString()),
        txHash: outcome.txHash,
        blockNumber: outcome.blockNumber,
      });
    })
  );

  // -----------------------------------------------------------------------
  // POST /deals/:id/deposit — fund the deal. The operator pays in the full
  // amount; the service grants the Escrow an exact-size token allowance first
  // if the current one is insufficient (documented in the README).
  // -----------------------------------------------------------------------
  router.post(
    "/deals/:dealId/deposit",
    asyncHandler(async (req, res) => {
      const dealId = parseDealId(req.params.dealId);
      const deal = await requireDealId(req.params.dealId, deps);
      if (String(deal.state) !== "0") {
        throw new AppError(409, "WRONG_DEAL_STATE", `deal is already in state ${String(deal.state)} (0=Created, 1=Funded, 2=Cancelled)`);
      }
      const tokenAddress = String(deal.token);
      const total = BigInt(String(deal.totalAmount));

      const token = new Contract(tokenAddress, ERC20_ABI, operator);
      let approveTxHash: string | undefined;
      const allowance: bigint = await token.allowance(operator.address, escrowAddress);
      if (allowance < total) {
        const approve = await execTx(token.approve, [escrowAddress, total]);
        approveTxHash = approve.txHash;
      }
      const deposit = await execTx(escrow.deposit, [dealId]);

      res.status(200).json({
        dealId: dealId.toString(),
        depositTxHash: deposit.txHash,
        blockNumber: deposit.blockNumber,
        approveTxHash: approveTxHash ?? null,
        approvedNow: approveTxHash !== undefined,
      });
    })
  );

  // -----------------------------------------------------------------------
  // Milestone actions
  // -----------------------------------------------------------------------
  router.post(
    "/deals/:dealId/milestones/:index/submit",
    asyncHandler(async (req, res) => {
      const dealId = parseDealId(req.params.dealId);
      const index = parseMilestoneIndex(req.params.index);
      const body = requireJsonObject(req.body);
      const proofHash = parseProofHash(body);
      const deal = await requireDealId(req.params.dealId, deps);
      requireRole(operator, deal, "seller", "submit a proof");
      const outcome = await execTx(escrow.submitMilestoneProof, [dealId, index, proofHash]);
      res.status(200).json({
        dealId: dealId.toString(),
        milestoneIndex: index,
        action: "submit",
        proofHash,
        txHash: outcome.txHash,
        blockNumber: outcome.blockNumber,
      });
    })
  );

  router.post(
    "/deals/:dealId/milestones/:index/approve",
    asyncHandler(async (req, res) => {
      const dealId = parseDealId(req.params.dealId);
      const index = parseMilestoneIndex(req.params.index);
      const deal = await requireDealId(req.params.dealId, deps);
      requireRole(operator, deal, "verifier", "approve");
      const outcome = await execTx(escrow.approveMilestone, [dealId, index]);
      res.status(200).json({
        dealId: dealId.toString(),
        milestoneIndex: index,
        action: "approve",
        txHash: outcome.txHash,
        blockNumber: outcome.blockNumber,
      });
    })
  );

  router.post(
    "/deals/:dealId/milestones/:index/dispute",
    asyncHandler(async (req, res) => {
      const dealId = parseDealId(req.params.dealId);
      const index = parseMilestoneIndex(req.params.index);
      const deal = await requireDealId(req.params.dealId, deps);
      requireRole(operator, deal, "buyer", "dispute");
      const outcome = await execTx(escrow.disputeMilestone, [dealId, index]);
      res.status(200).json({
        dealId: dealId.toString(),
        milestoneIndex: index,
        action: "dispute",
        txHash: outcome.txHash,
        blockNumber: outcome.blockNumber,
      });
    })
  );

  router.post(
    "/deals/:dealId/milestones/:index/resolve",
    asyncHandler(async (req, res) => {
      const dealId = parseDealId(req.params.dealId);
      const index = parseMilestoneIndex(req.params.index);
      const body = requireJsonObject(req.body);
      if (typeof body.releaseToSeller !== "boolean") {
        throw new AppError(400, "INVALID_BODY", "releaseToSeller must be a boolean");
      }
      const deal = await requireDealId(req.params.dealId, deps);
      requireRole(operator, deal, "verifier", "resolve a dispute");
      const outcome = await execTx(escrow.resolveDispute, [dealId, index, body.releaseToSeller]);
      res.status(200).json({
        dealId: dealId.toString(),
        milestoneIndex: index,
        action: "resolve",
        releaseToSeller: body.releaseToSeller,
        txHash: outcome.txHash,
        blockNumber: outcome.blockNumber,
      });
    })
  );

  router.post(
    "/deals/:dealId/milestones/:index/finalize",
    asyncHandler(async (req, res) => {
      const dealId = parseDealId(req.params.dealId);
      const index = parseMilestoneIndex(req.params.index);
      // No role check: finalize is keeper-style, callable by anyone.
      const outcome = await execTx(escrow.finalizeMilestone, [dealId, index]);
      res.status(200).json({
        dealId: dealId.toString(),
        milestoneIndex: index,
        action: "finalize",
        txHash: outcome.txHash,
        blockNumber: outcome.blockNumber,
      });
    })
  );

  // -----------------------------------------------------------------------
  // GET /deals/:id — full on-chain state.
  // -----------------------------------------------------------------------
  router.get(
    "/deals/:dealId",
    asyncHandler(async (req, res) => {
      const dealId = parseDealId(req.params.dealId);
      res.status(200).json(await readDeal(escrow, dealId));
    })
  );

  // -----------------------------------------------------------------------
  // GET /deals/:id/events — indexed event history for the deal.
  // -----------------------------------------------------------------------
  router.get(
    "/deals/:dealId/events",
    asyncHandler(async (req, res) => {
      const dealId = parseDealId(req.params.dealId);
      await requireDealId(req.params.dealId, deps); // 404 on unknown deals
      const events = listDealEvents(db, dealId.toString());
      res.status(200).json({ dealId: dealId.toString(), count: events.length, events });
    })
  );

  return router;
}

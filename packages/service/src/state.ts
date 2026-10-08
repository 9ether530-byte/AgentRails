import type { Contract } from "ethers";
import { mapRevertError } from "./errors";

export const DISPUTE_WINDOW_SECONDS = 172_800; // keep in sync with Escrow.DISPUTE_WINDOW

const DEAL_STATES = ["Created", "Funded", "Cancelled"] as const;
const MILESTONE_STATES = [
  "Pending",
  "Submitted",
  "Approved",
  "Disputed",
  "Released",
  "Refunded",
] as const;

export interface SerializedMilestone {
  index: number;
  state: string;
  amount: string;
  proofHash: string;
  approvedAt: number | null;
  disputeWindowEndsAt: number | null;
}

export interface SerializedDeal {
  dealId: string;
  buyer: string;
  seller: string;
  verifier: string;
  token: string;
  state: string;
  totalAmount: string;
  releasedAmount: string;
  refundedAmount: string;
  milestoneCount: number;
  closed: boolean;
  milestones: SerializedMilestone[];
}

function asStateName(states: readonly string[], value: unknown): string {
  const idx = Number(value);
  return states[idx] ?? `Unknown(${idx})`;
}

/**
 * Full on-chain state for a deal: the Deal struct plus every milestone.
 * Throws AppError (404 DEAL_NOT_FOUND) for nonexistent deals.
 */
export async function readDeal(escrow: Contract, dealId: bigint): Promise<SerializedDeal> {
  let deal: Record<string, unknown>;
  try {
    deal = await escrow.getDeal(dealId);
  } catch (err) {
    throw mapRevertError(err);
  }

  const count = Number(deal.milestoneCount);
  const rawMilestones: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    try {
      rawMilestones.push(await escrow.getMilestone(dealId, i));
    } catch (err) {
      throw mapRevertError(err);
    }
  }

  let closed: unknown;
  try {
    closed = await escrow.isDealClosed(dealId);
  } catch (err) {
    throw mapRevertError(err);
  }

  const milestones: SerializedMilestone[] = rawMilestones.map((m, i) => {
    const approvedAt = Number(m.approvedAt ?? 0);
    return {
      index: i,
      state: asStateName(MILESTONE_STATES, m.state),
      amount: BigInt(m.amount).toString(),
      proofHash: String(m.proofHash),
      approvedAt: approvedAt > 0 ? approvedAt : null,
      disputeWindowEndsAt:
        approvedAt > 0 ? approvedAt + DISPUTE_WINDOW_SECONDS : null,
    };
  });

  return {
    dealId: dealId.toString(),
    buyer: String(deal.buyer),
    seller: String(deal.seller),
    verifier: String(deal.verifier),
    token: String(deal.token),
    state: asStateName(DEAL_STATES, deal.state),
    totalAmount: BigInt(deal.totalAmount).toString(),
    releasedAmount: BigInt(deal.releasedAmount).toString(),
    refundedAmount: BigInt(deal.refundedAmount).toString(),
    milestoneCount: count,
    closed: Boolean(closed),
    milestones,
  };
}

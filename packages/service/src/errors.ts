import { Interface } from "ethers";
import { loadEscrowArtifact } from "./abis";

/** Every HTTP error the service returns uses this envelope. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/**
 * On-chain custom errors we know how to translate into a 4xx. Status choice:
 * 404 for "does not exist", 409 for "chain state / role conflict", 400 for
 * "request was malformed in a way validation can be raced on".
 */
const REVERT_MAP: Record<string, { status: number; code: string; message: string }> = {
  DealNotFound: { status: 404, code: "DEAL_NOT_FOUND", message: "deal does not exist" },
  MilestoneNotFound: {
    status: 404,
    code: "MILESTONE_NOT_FOUND",
    message: "milestone does not exist for this deal",
  },
  NotBuyer: { status: 409, code: "NOT_BUYER", message: "only the deal buyer can do this" },
  NotSeller: { status: 409, code: "NOT_SELLER", message: "only the deal seller can do this" },
  NotVerifier: { status: 409, code: "NOT_VERIFIER", message: "only the deal verifier can do this" },
  WrongDealState: {
    status: 409,
    code: "WRONG_DEAL_STATE",
    message: "deal is not in the state this action requires",
  },
  DealNotCancellable: {
    status: 409,
    code: "DEAL_NOT_CANCELLABLE",
    message: "deal has milestones that are no longer pending",
  },
  MilestoneNotPending: {
    status: 409,
    code: "MILESTONE_NOT_PENDING",
    message: "milestone is not in Pending state",
  },
  MilestoneNotSubmitted: {
    status: 409,
    code: "MILESTONE_NOT_SUBMITTED",
    message: "milestone is not in Submitted state",
  },
  MilestoneNotApproved: {
    status: 409,
    code: "MILESTONE_NOT_APPROVED",
    message: "milestone is not in Approved state",
  },
  MilestoneNotDisputed: {
    status: 409,
    code: "MILESTONE_NOT_DISPUTED",
    message: "milestone is not in Disputed state",
  },
  ZeroProofHash: { status: 400, code: "ZERO_PROOF_HASH", message: "proof hash must not be zero" },
  ZeroAddress: { status: 400, code: "ZERO_ADDRESS", message: "zero address not allowed" },
  ZeroAmount: { status: 400, code: "ZERO_AMOUNT", message: "milestone amounts must be positive" },
  EmptyMilestones: {
    status: 400,
    code: "EMPTY_MILESTONES",
    message: "deal needs at least one milestone",
  },
  DisputeWindowActive: {
    status: 409,
    code: "DISPUTE_WINDOW_ACTIVE",
    message: "dispute window is still open; finalize becomes possible once it elapses",
  },
  DisputeWindowElapsed: {
    status: 409,
    code: "DISPUTE_WINDOW_ELAPSED",
    message: "dispute window has elapsed; the milestone can only be finalized",
  },
  NothingToRefund: {
    status: 409,
    code: "NOTHING_TO_REFUND",
    message: "no pending milestones to refund",
  },
  // OpenZeppelin ERC20 custom errors
  ERC20InsufficientBalance: {
    status: 409,
    code: "INSUFFICIENT_TOKEN_BALANCE",
    message: "token balance is too low for this transfer",
  },
  ERC20InsufficientAllowance: {
    status: 409,
    code: "INSUFFICIENT_TOKEN_ALLOWANCE",
    message: "token allowance is too low for this transfer",
  },
  ERC20InvalidApprover: {
    status: 409,
    code: "ERC20_INVALID_APPROVER",
    message: "token rejected the approver address",
  },
  ERC20InvalidReceiver: {
    status: 409,
    code: "ERC20_INVALID_RECEIVER",
    message: "token rejected the receiver address",
  },
  ERC20InvalidSender: {
    status: 409,
    code: "ERC20_INVALID_SENDER",
    message: "token rejected the sender address",
  },
};

// Only needed to decode ERC20 revert data; the Escrow interface comes from the
// real artifact so Escrow custom errors decode against the true ABI.
const ERC20_ERROR_IFACE = new Interface([
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InvalidSender(address sender)",
  "error ERC20InvalidReceiver(address receiver)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InvalidApprover(address approver)",
]);

function matchRevertName(name: unknown): AppError | null {
  if (typeof name !== "string") return null;
  const mapped = REVERT_MAP[name];
  if (mapped) return new AppError(mapped.status, mapped.code, mapped.message, { revert: name });
  return null;
}

/**
 * Translate an ethers error from a staticCall/send/wait into the HTTP error
 * envelope. Walks the shapes ethers v6 produces across versions: pre-decoded
 * custom errors (`.revert`), and raw revert hex in several info slots, decoded
 * against the Escrow + ERC20 interfaces.
 */
export function mapRevertError(err: unknown): AppError {
  if (isAppError(err)) return err;
  const e = err as Record<string, any> | null | undefined;

  // 1) ethers already decoded a custom error for us.
  const decoded = e?.revert ?? e?.info?.parsedError ?? e?.error?.revert;
  const direct = matchRevertName(decoded?.name);
  if (direct) return direct;

  // 2) raw revert data — find a hex payload and decode it ourselves.
  const hexCandidates = [
    e?.data,
    e?.info?.data,
    e?.error?.data,
    e?.error?.info?.data,
    e?.info?.errorPayload?.error?.data,
  ];
  for (const iface of [loadEscrowIface(), ERC20_ERROR_IFACE]) {
    for (const hex of hexCandidates) {
      if (typeof hex !== "string" || !hex.startsWith("0x")) continue;
      try {
        const parsed = iface.parseError(hex);
        const mapped = parsed && matchRevertName(parsed.name);
        if (mapped) return mapped;
      } catch {
        // not a revert payload this interface knows — keep looking
      }
    }
  }

  // 3) undecodable revert.
  if (e?.code === "CALL_EXCEPTION") {
    const short = e?.shortMessage ?? e?.message ?? "call exception";
    return new AppError(409, "CALL_REVERTED", `transaction would revert: ${short}`, {
      revertData: typeof e?.data === "string" ? e.data : undefined,
    });
  }
  if (e?.code === "INSUFFICIENT_FUNDS") {
    return new AppError(
      409,
      "OPERATOR_NO_GAS",
      "operator wallet has insufficient native token for gas"
    );
  }
  if (e?.code === "NONCE_EXPIRED" || e?.code === "REPLACEMENT_UNDERPRICED") {
    return new AppError(409, "TX_NONCE_CONFLICT", "transaction nonce conflict; retry");
  }

  const message = e?.shortMessage ?? e?.message ?? "unknown error";
  return new AppError(500, "TX_FAILED", `transaction failed: ${message}`);
}

let escrowIfaceCache: Interface | undefined;
function loadEscrowIface(): Interface {
  escrowIfaceCache ??= new Interface(loadEscrowArtifact().abi);
  return escrowIfaceCache;
}

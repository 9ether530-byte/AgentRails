// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title Escrow
 * @notice Milestone-based USDC escrow for autonomous agent commerce.
 *
 * Trust model (v0, honest version):
 *  - The verifier is a trusted off-chain oracle: it approves submissions and
 *    resolves disputes. It cannot move funds except through the rules below.
 *  - The buyer funds deals and may dispute within the window.
 *  - The seller submits proof hashes and receives payouts.
 *  - Anyone (e.g. a keeper bot) triggers auto-release after the dispute window.
 *  - The admin can only change treasury and fee (hard-capped); it can never
 *    move user funds. Ownership transfer is two-step.
 *
 * Follows checks-effects-interactions everywhere: all state is written before
 * any token call, so a malicious ERC20 hook cannot reenter mid-transition.
 *
 * Assumes a standard ERC20 (USDC): no fee-on-transfer, no rebasing, no ERC777
 * hooks. UNAUDITED v0 — Base Sepolia testnet only.
 */
contract Escrow is Ownable2Step {
    using SafeERC20 for IERC20;

    enum DealState {
        Created,
        Funded,
        Cancelled
    }

    enum MilestoneState {
        Pending,
        Submitted,
        Approved,
        Disputed,
        Released,
        Refunded
    }

    struct Deal {
        address buyer;
        address seller;
        address verifier;
        address token;
        DealState state;
        uint256 totalAmount;
        uint256 releasedAmount;
        uint256 refundedAmount;
        uint256 milestoneCount;
    }

    struct Milestone {
        MilestoneState state;
        uint256 amount;
        bytes32 proofHash;
        uint64 approvedAt;
    }

    uint256 public constant DISPUTE_WINDOW = 172_800; // 48h in seconds
    uint256 public constant MAX_FEE_BPS = 1_000; // 10%, hard cap
    uint256 public constant FEE_DENOMINATOR = 10_000;

    uint256 public dealCount;
    address public treasury;
    uint256 public feeBps;

    mapping(uint256 dealId => Deal) private _deals;
    mapping(uint256 dealId => Milestone[]) private _milestones;

    event DealCreated(
        uint256 indexed dealId,
        address indexed buyer,
        address indexed seller,
        address verifier,
        address token,
        uint256 totalAmount,
        uint256[] milestoneAmounts
    );
    event DealFunded(uint256 indexed dealId, address indexed buyer, uint256 totalAmount);
    event DealCancelled(uint256 indexed dealId, address indexed buyer, uint256 refundedAmount);
    event ProofSubmitted(uint256 indexed dealId, uint256 indexed milestoneIndex, bytes32 proofHash);
    event MilestoneApproved(uint256 indexed dealId, uint256 indexed milestoneIndex);
    event MilestoneReleased(
        uint256 indexed dealId,
        uint256 indexed milestoneIndex,
        address indexed seller,
        uint256 sellerAmount,
        uint256 fee
    );
    event MilestoneDisputed(uint256 indexed dealId, uint256 indexed milestoneIndex);
    event DisputeResolved(uint256 indexed dealId, uint256 indexed milestoneIndex, bool sellerFavored);
    event MilestonesRefunded(
        uint256 indexed dealId,
        address indexed buyer,
        uint256 refundedAmount,
        uint256 refundedCount
    );
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event FeeBpsUpdated(uint256 previousFeeBps, uint256 newFeeBps);

    error ZeroTreasury();
    error FeeTooHigh();
    error ZeroAddress();
    error EmptyMilestones();
    error ZeroAmount();
    error DealNotFound();
    error NotBuyer();
    error NotSeller();
    error NotVerifier();
    error WrongDealState();
    error DealNotCancellable();
    error MilestoneNotFound();
    error MilestoneNotPending();
    error MilestoneNotSubmitted();
    error MilestoneNotApproved();
    error MilestoneNotDisputed();
    error ZeroProofHash();
    error DisputeWindowActive();
    error DisputeWindowElapsed();
    error NothingToRefund();

    constructor(address initialOwner, address treasury_, uint256 feeBps_) Ownable(initialOwner) {
        if (treasury_ == address(0)) revert ZeroTreasury();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        treasury = treasury_;
        feeBps = feeBps_;
    }

    // ------------------------------------------------------------------
    // Deal lifecycle
    // ------------------------------------------------------------------

    /**
     * @notice Creates a deal. The caller becomes the buyer.
     */
    function createDeal(
        address seller,
        address verifier,
        address token,
        uint256[] calldata milestoneAmounts
    ) external returns (uint256 dealId) {
        if (seller == address(0) || verifier == address(0) || token == address(0)) revert ZeroAddress();
        uint256 count = milestoneAmounts.length;
        if (count == 0) revert EmptyMilestones();

        uint256 total;
        for (uint256 i = 0; i < count; ++i) {
            if (milestoneAmounts[i] == 0) revert ZeroAmount();
            total += milestoneAmounts[i];
        }

        dealId = ++dealCount;
        Deal storage deal = _deals[dealId];
        deal.buyer = msg.sender;
        deal.seller = seller;
        deal.verifier = verifier;
        deal.token = token;
        deal.state = DealState.Created;
        deal.totalAmount = total;
        deal.milestoneCount = count;

        Milestone[] storage milestones = _milestones[dealId];
        for (uint256 i = 0; i < count; ++i) {
            milestones.push(
                Milestone({
                    state: MilestoneState.Pending,
                    amount: milestoneAmounts[i],
                    proofHash: bytes32(0),
                    approvedAt: 0
                })
            );
        }

        emit DealCreated(dealId, msg.sender, seller, verifier, token, total, milestoneAmounts);
    }

    /**
     * @notice Buyer funds the deal by pulling the full amount into escrow.
     */
    function deposit(uint256 dealId) external {
        Deal storage deal = _requireDeal(dealId);
        if (msg.sender != deal.buyer) revert NotBuyer();
        if (deal.state != DealState.Created) revert WrongDealState();

        deal.state = DealState.Funded; // effects before interactions
        emit DealFunded(dealId, msg.sender, deal.totalAmount);

        IERC20(deal.token).safeTransferFrom(msg.sender, address(this), deal.totalAmount);
    }

    /**
     * @notice Buyer cancels a deal before any milestone work begins. A funded
     * deal is refunded in full; an unfunded one has nothing to refund.
     */
    function cancelDeal(uint256 dealId) external {
        Deal storage deal = _requireDeal(dealId);
        if (msg.sender != deal.buyer) revert NotBuyer();
        if (deal.state == DealState.Cancelled) revert WrongDealState();

        Milestone[] storage milestones = _milestones[dealId];
        for (uint256 i = 0; i < milestones.length; ++i) {
            if (milestones[i].state != MilestoneState.Pending) revert DealNotCancellable();
        }

        uint256 refund = deal.state == DealState.Funded ? deal.totalAmount : 0;
        deal.state = DealState.Cancelled;
        deal.refundedAmount = refund;
        emit DealCancelled(dealId, msg.sender, refund);

        if (refund > 0) {
            IERC20(deal.token).safeTransfer(msg.sender, refund);
        }
    }

    // ------------------------------------------------------------------
    // Milestones
    // ------------------------------------------------------------------

    /**
     * @notice Seller submits the keccak256 proof hash for a pending milestone.
     */
    function submitMilestoneProof(uint256 dealId, uint256 milestoneIndex, bytes32 proofHash) external {
        Deal storage deal = _requireDeal(dealId);
        if (msg.sender != deal.seller) revert NotSeller();
        if (deal.state != DealState.Funded) revert WrongDealState();

        Milestone storage milestone = _requireMilestone(dealId, milestoneIndex);
        if (milestone.state != MilestoneState.Pending) revert MilestoneNotPending();
        if (proofHash == bytes32(0)) revert ZeroProofHash();

        milestone.state = MilestoneState.Submitted;
        milestone.proofHash = proofHash;
        emit ProofSubmitted(dealId, milestoneIndex, proofHash);
    }

    /**
     * @notice Verifier approves a submitted milestone, starting the dispute window.
     */
    function approveMilestone(uint256 dealId, uint256 milestoneIndex) external {
        Deal storage deal = _requireDeal(dealId);
        if (msg.sender != deal.verifier) revert NotVerifier();
        if (deal.state != DealState.Funded) revert WrongDealState();

        Milestone storage milestone = _requireMilestone(dealId, milestoneIndex);
        if (milestone.state != MilestoneState.Submitted) revert MilestoneNotSubmitted();

        milestone.state = MilestoneState.Approved;
        milestone.approvedAt = uint64(block.timestamp);
        emit MilestoneApproved(dealId, milestoneIndex);
    }

    /**
     * @notice Keeper-triggered auto-release: anyone can release an approved
     * milestone once the dispute window has elapsed without a dispute.
     */
    function finalizeMilestone(uint256 dealId, uint256 milestoneIndex) external {
        Deal storage deal = _requireDeal(dealId);
        if (deal.state != DealState.Funded) revert WrongDealState();

        Milestone storage milestone = _requireMilestone(dealId, milestoneIndex);
        if (milestone.state != MilestoneState.Approved) revert MilestoneNotApproved();
        if (block.timestamp < uint256(milestone.approvedAt) + DISPUTE_WINDOW) revert DisputeWindowActive();

        (uint256 sellerAmount, uint256 fee) = _release(dealId, milestone);
        emit MilestoneReleased(dealId, milestoneIndex, deal.seller, sellerAmount, fee);
    }

    /**
     * @notice Buyer disputes an approved milestone within the window.
     */
    function disputeMilestone(uint256 dealId, uint256 milestoneIndex) external {
        Deal storage deal = _requireDeal(dealId);
        if (msg.sender != deal.buyer) revert NotBuyer();
        if (deal.state != DealState.Funded) revert WrongDealState();

        Milestone storage milestone = _requireMilestone(dealId, milestoneIndex);
        if (milestone.state != MilestoneState.Approved) revert MilestoneNotApproved();
        if (block.timestamp >= uint256(milestone.approvedAt) + DISPUTE_WINDOW) revert DisputeWindowElapsed();

        milestone.state = MilestoneState.Disputed;
        emit MilestoneDisputed(dealId, milestoneIndex);
    }

    /**
     * @notice Verifier resolves a disputed milestone. Seller-favored releases
     * with the normal fee; buyer-favored refunds in full with no fee.
     */
    function resolveDispute(uint256 dealId, uint256 milestoneIndex, bool sellerFavored) external {
        Deal storage deal = _requireDeal(dealId);
        if (msg.sender != deal.verifier) revert NotVerifier();

        Milestone storage milestone = _requireMilestone(dealId, milestoneIndex);
        if (milestone.state != MilestoneState.Disputed) revert MilestoneNotDisputed();

        if (sellerFavored) {
            (uint256 sellerAmount, uint256 fee) = _release(dealId, milestone);
            emit DisputeResolved(dealId, milestoneIndex, true);
            emit MilestoneReleased(dealId, milestoneIndex, deal.seller, sellerAmount, fee);
        } else {
            milestone.state = MilestoneState.Refunded;
            deal.refundedAmount += milestone.amount;
            emit DisputeResolved(dealId, milestoneIndex, false);
            IERC20(deal.token).safeTransfer(deal.buyer, milestone.amount);
        }
    }

    /**
     * @notice Buyer refunds every never-submitted milestone. Submitted,
     * approved, disputed, released and refunded milestones are left intact.
     */
    function refundPendingMilestones(uint256 dealId) external {
        Deal storage deal = _requireDeal(dealId);
        if (msg.sender != deal.buyer) revert NotBuyer();
        if (deal.state != DealState.Funded) revert WrongDealState();

        Milestone[] storage milestones = _milestones[dealId];
        uint256 refund;
        uint256 refundedCount;
        for (uint256 i = 0; i < milestones.length; ++i) {
            if (milestones[i].state == MilestoneState.Pending) {
                milestones[i].state = MilestoneState.Refunded;
                refund += milestones[i].amount;
                ++refundedCount;
            }
        }
        if (refundedCount == 0) revert NothingToRefund();

        deal.refundedAmount += refund;
        emit MilestonesRefunded(dealId, msg.sender, refund, refundedCount);
        IERC20(deal.token).safeTransfer(msg.sender, refund);
    }

    // ------------------------------------------------------------------
    // Admin (cannot move user funds)
    // ------------------------------------------------------------------

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        emit FeeBpsUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function getDeal(uint256 dealId) external view returns (Deal memory) {
        return _requireDeal(dealId);
    }

    function getMilestone(uint256 dealId, uint256 milestoneIndex) external view returns (Milestone memory) {
        _requireDeal(dealId);
        return _requireMilestone(dealId, milestoneIndex);
    }

    function getMilestoneCount(uint256 dealId) external view returns (uint256) {
        _requireDeal(dealId);
        return _milestones[dealId].length;
    }

    /**
     * @notice True once nothing further can happen with the deal: it was
     * cancelled, or funded and every milestone is Released/Refunded.
     */
    function isDealClosed(uint256 dealId) external view returns (bool) {
        Deal storage deal = _requireDeal(dealId);
        if (deal.state == DealState.Cancelled) return true;
        if (deal.state != DealState.Funded) return false;

        Milestone[] storage milestones = _milestones[dealId];
        for (uint256 i = 0; i < milestones.length; ++i) {
            MilestoneState s = milestones[i].state;
            if (s != MilestoneState.Released && s != MilestoneState.Refunded) return false;
        }
        return true;
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    /**
     * @dev Shared release path: marks the milestone Released, accrues the
     * deal's releasedAmount, then pays treasury + seller. Effects before
     * interactions, so a reentrant token hook observes final state.
     */
    function _release(uint256 dealId, Milestone storage milestone) private returns (uint256 sellerAmount, uint256 fee) {
        Deal storage deal = _deals[dealId];
        fee = (milestone.amount * feeBps) / FEE_DENOMINATOR;
        sellerAmount = milestone.amount - fee;

        milestone.state = MilestoneState.Released;
        deal.releasedAmount += milestone.amount;

        IERC20 token = IERC20(deal.token);
        if (fee > 0) token.safeTransfer(treasury, fee);
        token.safeTransfer(deal.seller, sellerAmount);
    }

    function _requireDeal(uint256 dealId) private view returns (Deal storage) {
        if (dealId == 0 || dealId > dealCount) revert DealNotFound();
        return _deals[dealId];
    }

    function _requireMilestone(uint256 dealId, uint256 milestoneIndex) private view returns (Milestone storage) {
        Milestone[] storage milestones = _milestones[dealId];
        if (milestoneIndex >= milestones.length) revert MilestoneNotFound();
        return milestones[milestoneIndex];
    }
}

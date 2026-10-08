import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const AMOUNTS = [1_000_000n, 2_000_000n, 3_000_000n]; // 1, 2, 3 USDC (6 decimals)
const TOTAL = AMOUNTS.reduce((a, b) => a + b, 0n);
const WINDOW = 172_800n; // 48h in seconds
const FEE_BPS = 50n;

const PROOF_1 = ethers.id("milestone-1-delivery-evidence");
const PROOF_2 = ethers.id("milestone-2-delivery-evidence");

// DealState: Created=0, Funded=1, Cancelled=2
// MilestoneState: Pending=0, Submitted=1, Approved=2, Disputed=3, Released=4, Refunded=5

describe("Escrow", function () {
  async function deployFixture() {
    const [owner, buyer, seller, verifier, treasury, keeper, other] = await ethers.getSigners();

    const token = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const escrow = await (await ethers.getContractFactory("Escrow")).deploy(
      owner.address,
      treasury.address,
      FEE_BPS
    );
    await token.mint(buyer.address, ethers.parseUnits("1000000", 6));

    return { owner, buyer, seller, verifier, treasury, keeper, other, token, escrow };
  }

  /** Creates deal #1 with AMOUNTS and funds it from the buyer. */
  async function createFundedDeal(
    f: Awaited<ReturnType<typeof deployFixture>>,
    amounts: bigint[] = AMOUNTS
  ) {
    const escrowAddress = await f.escrow.getAddress();
    await f.escrow
      .connect(f.buyer)
      .createDeal(f.seller.address, f.verifier.address, await f.token.getAddress(), [...amounts]);
    const dealId = await f.escrow.dealCount(); // id of the deal just created
    const total = amounts.reduce((a, b) => a + b, 0n);
    await f.token.connect(f.buyer).approve(escrowAddress, total);
    await f.escrow.connect(f.buyer).deposit(dealId);
    return dealId;
  }

  async function fundedFixture() {
    const f = await deployFixture();
    const dealId = await createFundedDeal(f);
    return { ...f, dealId };
  }

  const feeOf = (amount: bigint, bps: bigint = FEE_BPS) => (amount * bps) / 10_000n;

  describe("deployment", function () {
    it("sets owner, treasury, fee and dispute window", async function () {
      const { escrow, owner, treasury } = await loadFixture(deployFixture);
      expect(await escrow.owner()).to.equal(owner.address);
      expect(await escrow.treasury()).to.equal(treasury.address);
      expect(await escrow.feeBps()).to.equal(FEE_BPS);
      expect(await escrow.DISPUTE_WINDOW()).to.equal(WINDOW);
      expect(await escrow.MAX_FEE_BPS()).to.equal(1_000n);
      expect(await escrow.dealCount()).to.equal(0n);
    });

    it("reverts with a zero treasury", async function () {
      const { owner } = await loadFixture(deployFixture);
      const Escrow = await ethers.getContractFactory("Escrow");
      await expect(Escrow.deploy(owner.address, ethers.ZeroAddress, FEE_BPS)).to.be.revertedWithCustomError(
        Escrow,
        "ZeroTreasury"
      );
    });

    it("reverts when the fee exceeds MAX_FEE_BPS", async function () {
      const { owner, treasury } = await loadFixture(deployFixture);
      const Escrow = await ethers.getContractFactory("Escrow");
      await expect(Escrow.deploy(owner.address, treasury.address, 1_001n)).to.be.revertedWithCustomError(
        Escrow,
        "FeeTooHigh"
      );
    });

    it("accepts a fee exactly at MAX_FEE_BPS", async function () {
      const { owner, treasury } = await loadFixture(deployFixture);
      const Escrow = await ethers.getContractFactory("Escrow");
      const escrow = await Escrow.deploy(owner.address, treasury.address, 1_000n);
      expect(await escrow.feeBps()).to.equal(1_000n);
    });
  });

  describe("createDeal", function () {
    it("stores all deal parameters and increments ids", async function () {
      const { escrow, buyer, seller, verifier, token } = await loadFixture(deployFixture);
      await expect(
        escrow
          .connect(buyer)
          .createDeal(seller.address, verifier.address, await token.getAddress(), [...AMOUNTS])
      )
        .to.emit(escrow, "DealCreated")
        .withArgs(1n, buyer.address, seller.address, verifier.address, await token.getAddress(), TOTAL, [
          ...AMOUNTS,
        ]);

      const deal = await escrow.getDeal(1n);
      expect(deal.buyer).to.equal(buyer.address);
      expect(deal.seller).to.equal(seller.address);
      expect(deal.verifier).to.equal(verifier.address);
      expect(deal.token).to.equal(await token.getAddress());
      expect(Number(deal.state)).to.equal(0); // Created
      expect(deal.totalAmount).to.equal(TOTAL);
      expect(deal.milestoneCount).to.equal(3n);
      expect(await escrow.getMilestoneCount(1n)).to.equal(3n);
      expect(await escrow.dealCount()).to.equal(1n);

      // ids increment across deals
      await escrow
        .connect(buyer)
        .createDeal(seller.address, verifier.address, await token.getAddress(), [500n]);
      expect(await escrow.dealCount()).to.equal(2n);
    });

    it("creates all milestones in Pending state", async function () {
      const { escrow, buyer, seller, verifier, token } = await loadFixture(deployFixture);
      await escrow
        .connect(buyer)
        .createDeal(seller.address, verifier.address, await token.getAddress(), [...AMOUNTS]);
      for (let i = 0; i < 3; i++) {
        const m = await escrow.getMilestone(1n, i);
        expect(Number(m.state)).to.equal(0); // Pending
        expect(m.amount).to.equal(AMOUNTS[i]);
        expect(m.proofHash).to.equal(ethers.ZeroHash);
      }
    });

    it("reverts on zero seller, verifier or token", async function () {
      const { escrow, buyer, seller, verifier, token } = await loadFixture(deployFixture);
      await expect(
        escrow.connect(buyer).createDeal(ethers.ZeroAddress, verifier.address, await token.getAddress(), [...AMOUNTS])
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      await expect(
        escrow.connect(buyer).createDeal(seller.address, ethers.ZeroAddress, await token.getAddress(), [...AMOUNTS])
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      await expect(
        escrow.connect(buyer).createDeal(seller.address, verifier.address, ethers.ZeroAddress, [...AMOUNTS])
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });

    it("reverts on empty milestone list", async function () {
      const { escrow, buyer, seller, verifier, token } = await loadFixture(deployFixture);
      await expect(
        escrow.connect(buyer).createDeal(seller.address, verifier.address, await token.getAddress(), [])
      ).to.be.revertedWithCustomError(escrow, "EmptyMilestones");
    });

    it("reverts on a zero milestone amount", async function () {
      const { escrow, buyer, seller, verifier, token } = await loadFixture(deployFixture);
      await expect(
        escrow
          .connect(buyer)
          .createDeal(seller.address, verifier.address, await token.getAddress(), [1_000n, 0n])
      ).to.be.revertedWithCustomError(escrow, "ZeroAmount");
    });

    it("reverts on unknown deal reads", async function () {
      const { escrow } = await loadFixture(deployFixture);
      await expect(escrow.getDeal(99n)).to.be.revertedWithCustomError(escrow, "DealNotFound");
      await expect(escrow.getMilestone(99n, 0n)).to.be.revertedWithCustomError(escrow, "DealNotFound");
      await expect(escrow.getMilestoneCount(99n)).to.be.revertedWithCustomError(escrow, "DealNotFound");
    });
  });

  describe("deposit", function () {
    it("pulls the full amount from the buyer and funds the deal", async function () {
      const { escrow, token, buyer, seller, verifier } = await loadFixture(deployFixture);
      const escrowAddress = await escrow.getAddress();
      await escrow.connect(buyer).createDeal(seller.address, verifier.address, await token.getAddress(), [...AMOUNTS]);
      // the escrow pulls the full amount via transferFrom — approval is required first
      await token.connect(buyer).approve(escrowAddress, TOTAL);
      await expect(escrow.connect(buyer).deposit(1n))
        .to.emit(escrow, "DealFunded")
        .withArgs(1n, buyer.address, TOTAL);
      expect(await token.balanceOf(escrowAddress)).to.equal(TOTAL);
      const deal = await escrow.getDeal(1n);
      expect(Number(deal.state)).to.equal(1); // Funded
    });

    it("reverts when a non-buyer tries to fund", async function () {
      const { escrow, other, buyer, seller, verifier, token } = await loadFixture(deployFixture);
      await escrow.connect(buyer).createDeal(seller.address, verifier.address, await token.getAddress(), [...AMOUNTS]);
      await expect(escrow.connect(other).deposit(1n)).to.be.revertedWithCustomError(escrow, "NotBuyer");
    });

    it("reverts on double deposit", async function () {
      const f = await loadFixture(fundedFixture);
      await f.token.connect(f.buyer).approve(await f.escrow.getAddress(), TOTAL);
      await expect(f.escrow.connect(f.buyer).deposit(1n)).to.be.revertedWithCustomError(f.escrow, "WrongDealState");
    });

    it("reverts on an unknown deal id", async function () {
      const { escrow, buyer } = await loadFixture(deployFixture);
      await expect(escrow.connect(buyer).deposit(42n)).to.be.revertedWithCustomError(escrow, "DealNotFound");
    });

    it("reverts when depositing into a cancelled deal", async function () {
      const { escrow, token, buyer, seller, verifier } = await loadFixture(deployFixture);
      await escrow.connect(buyer).createDeal(seller.address, verifier.address, await token.getAddress(), [...AMOUNTS]);
      await escrow.connect(buyer).cancelDeal(1n);
      await expect(escrow.connect(buyer).deposit(1n)).to.be.revertedWithCustomError(escrow, "WrongDealState");
    });
  });

  describe("cancelDeal", function () {
    it("cancels an unfunded deal with nothing to refund", async function () {
      const { escrow, token, buyer, seller, verifier } = await loadFixture(deployFixture);
      await escrow.connect(buyer).createDeal(seller.address, verifier.address, await token.getAddress(), [...AMOUNTS]);
      await expect(escrow.connect(buyer).cancelDeal(1n))
        .to.emit(escrow, "DealCancelled")
        .withArgs(1n, buyer.address, 0n);
      const deal = await escrow.getDeal(1n);
      expect(Number(deal.state)).to.equal(2); // Cancelled
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);
    });

    it("cancels a fully-pending funded deal and refunds the buyer in full", async function () {
      const { escrow, token, buyer, seller, verifier } = await loadFixture(deployFixture);
      const escrowAddress = await escrow.getAddress();
      await escrow.connect(buyer).createDeal(seller.address, verifier.address, await token.getAddress(), [...AMOUNTS]);
      await token.connect(buyer).approve(escrowAddress, TOTAL);
      await escrow.connect(buyer).deposit(1n);

      const before = await token.balanceOf(buyer.address);
      await expect(escrow.connect(buyer).cancelDeal(1n))
        .to.emit(escrow, "DealCancelled")
        .withArgs(1n, buyer.address, TOTAL);
      expect(await token.balanceOf(buyer.address)).to.equal(before + TOTAL);
      expect(await token.balanceOf(escrowAddress)).to.equal(0n);
      const deal = await escrow.getDeal(1n);
      expect(Number(deal.state)).to.equal(2); // Cancelled
      expect(deal.refundedAmount).to.equal(TOTAL);
      expect(await escrow.isDealClosed(1n)).to.equal(true);
    });

    it("reverts once any milestone has been submitted", async function () {
      const f = await loadFixture(fundedFixture);
      await f.escrow.connect(f.seller).submitMilestoneProof(1n, 0n, PROOF_1);
      await expect(f.escrow.connect(f.buyer).cancelDeal(1n)).to.be.revertedWithCustomError(
        f.escrow,
        "DealNotCancellable"
      );
    });

    it("reverts for a non-buyer and on unknown deals", async function () {
      const f = await loadFixture(fundedFixture);
      await expect(f.escrow.connect(f.other).cancelDeal(1n)).to.be.revertedWithCustomError(f.escrow, "NotBuyer");
      await expect(f.escrow.connect(f.buyer).cancelDeal(7n)).to.be.revertedWithCustomError(f.escrow, "DealNotFound");
    });
  });

  describe("submitMilestoneProof", function () {
    it("records the proof hash and moves Pending -> Submitted", async function () {
      const f = await loadFixture(fundedFixture);
      await expect(f.escrow.connect(f.seller).submitMilestoneProof(1n, 0n, PROOF_1))
        .to.emit(f.escrow, "ProofSubmitted")
        .withArgs(1n, 0n, PROOF_1);
      const m = await f.escrow.getMilestone(1n, 0n);
      expect(Number(m.state)).to.equal(1); // Submitted
      expect(m.proofHash).to.equal(PROOF_1);
    });

    it("reverts for a non-seller", async function () {
      const f = await loadFixture(fundedFixture);
      await expect(
        f.escrow.connect(f.buyer).submitMilestoneProof(1n, 0n, PROOF_1)
      ).to.be.revertedWithCustomError(f.escrow, "NotSeller");
    });

    it("reverts while the deal is unfunded", async function () {
      const { escrow, buyer, seller, verifier, token } = await loadFixture(deployFixture);
      await escrow.connect(buyer).createDeal(seller.address, verifier.address, await token.getAddress(), [...AMOUNTS]);
      await expect(
        escrow.connect(seller).submitMilestoneProof(1n, 0n, PROOF_1)
      ).to.be.revertedWithCustomError(escrow, "WrongDealState");
    });

    it("reverts on double submission", async function () {
      const f = await loadFixture(fundedFixture);
      await f.escrow.connect(f.seller).submitMilestoneProof(1n, 0n, PROOF_1);
      await expect(
        f.escrow.connect(f.seller).submitMilestoneProof(1n, 0n, PROOF_2)
      ).to.be.revertedWithCustomError(f.escrow, "MilestoneNotPending");
    });

    it("reverts on a zero proof hash", async function () {
      const f = await loadFixture(fundedFixture);
      await expect(
        f.escrow.connect(f.seller).submitMilestoneProof(1n, 0n, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(f.escrow, "ZeroProofHash");
    });

    it("reverts on an out-of-bounds milestone index", async function () {
      const f = await loadFixture(fundedFixture);
      await expect(
        f.escrow.connect(f.seller).submitMilestoneProof(1n, 3n, PROOF_1)
      ).to.be.revertedWithCustomError(f.escrow, "MilestoneNotFound");
    });
  });

  describe("approveMilestone", function () {
    it("moves Submitted -> Approved and records the approval time", async function () {
      const f = await loadFixture(fundedFixture);
      await f.escrow.connect(f.seller).submitMilestoneProof(1n, 0n, PROOF_1);
      await expect(f.escrow.connect(f.verifier).approveMilestone(1n, 0n)).to.emit(f.escrow, "MilestoneApproved");
      const m = await f.escrow.getMilestone(1n, 0n);
      expect(Number(m.state)).to.equal(2); // Approved
      expect(Number(m.approvedAt)).to.be.closeTo(Number(await time.latest()), 5);
    });

    it("reverts for a non-verifier", async function () {
      const f = await loadFixture(fundedFixture);
      await f.escrow.connect(f.seller).submitMilestoneProof(1n, 0n, PROOF_1);
      await expect(
        f.escrow.connect(f.buyer).approveMilestone(1n, 0n)
      ).to.be.revertedWithCustomError(f.escrow, "NotVerifier");
      await expect(
        f.escrow.connect(f.verifier).approveMilestone(1n, 0n)
      ).to.not.be.reverted;
    });

    it("reverts when the milestone is not Submitted (Pending or already Approved)", async function () {
      const f = await loadFixture(fundedFixture);
      await expect(
        f.escrow.connect(f.verifier).approveMilestone(1n, 0n)
      ).to.be.revertedWithCustomError(f.escrow, "MilestoneNotSubmitted");
      await f.escrow.connect(f.seller).submitMilestoneProof(1n, 0n, PROOF_1);
      await f.escrow.connect(f.verifier).approveMilestone(1n, 0n);
      await expect(
        f.escrow.connect(f.verifier).approveMilestone(1n, 0n)
      ).to.be.revertedWithCustomError(f.escrow, "MilestoneNotSubmitted");
    });
  });

  describe("finalizeMilestone (keeper auto-release)", function () {
    it("reverts while the dispute window is still open", async function () {
      const f = await loadFixture(fundedFixture);
      await f.escrow.connect(f.seller).submitMilestoneProof(1n, 0n, PROOF_1);
      await f.escrow.connect(f.verifier).approveMilestone(1n, 0n);
      await expect(
        f.escrow.connect(f.keeper).finalizeMilestone(1n, 0n)
      ).to.be.revertedWithCustomError(f.escrow, "DisputeWindowActive");
    });

    it("releases to seller minus fee after the window, callable by anyone", async function () {
      const f = await loadFixture(fundedFixture);
      const escrowAddress = await f.escrow.getAddress();
      await f.escrow.connect(f.seller).submitMilestoneProof(1n, 0n, PROOF_1);
      await f.escrow.connect(f.verifier).approveMilestone(1n, 0n);
      await time.increase(WINDOW + 1n);

      const fee = feeOf(AMOUNTS[0]);
      const sellerBefore = await f.token.balanceOf(f.seller.address);
      const treasuryBefore = await f.token.balanceOf(f.treasury.address);

      // keeper is a random third party: release must not depend on any role
      await expect(f.escrow.connect(f.keeper).finalizeMilestone(1n, 0n))
        .to.emit(f.escrow, "MilestoneReleased")
        .withArgs(1n, 0n, f.seller.address, AMOUNTS[0] - fee, fee);

      expect(await f.token.balanceOf(f.seller.address)).to.equal(sellerBefore + AMOUNTS[0] - fee);
      expect(await f.token.balanceOf(f.treasury.address)).to.equal(treasuryBefore + fee);
      expect(await f.token.balanceOf(escrowAddress)).to.equal(TOTAL - AMOUNTS[0]);
      const deal = await f.escrow.getDeal(1n);
      expect(deal.releasedAmount).to.equal(AMOUNTS[0]);
      const m = await f.escrow.getMilestone(1n, 0n);
      expect(Number(m.state)).to.equal(4); // Released
    });

    it("reverts when called twice (milestone already Released)", async function () {
      const f = await loadFixture(fundedFixture);
      await f.escrow.connect(f.seller).submitMilestoneProof(1n, 0n, PROOF_1);
      await f.escrow.connect(f.verifier).approveMilestone(1n, 0n);
      await time.increase(WINDOW + 1n);
      await f.escrow.connect(f.keeper).finalizeMilestone(1n, 0n);
      await expect(
        f.escrow.connect(f.keeper).finalizeMilestone(1n, 0n)
      ).to.be.revertedWithCustomError(f.escrow, "MilestoneNotApproved");
    });

    it("reverts on a milestone that was never approved", async function () {
      const f = await loadFixture(fundedFixture);
      await time.increase(WINDOW + 1n);
      await expect(
        f.escrow.connect(f.keeper).finalizeMilestone(1n, 0n)
      ).to.be.revertedWithCustomError(f.escrow, "MilestoneNotApproved");
    });

    it("can be finalized long after the window elapses", async function () {
      const f = await loadFixture(fundedFixture);
      await f.escrow.connect(f.seller).submitMilestoneProof(1n, 0n, PROOF_1);
      await f.escrow.connect(f.verifier).approveMilestone(1n, 0n);
      await time.increase(WINDOW * 10n);
      await expect(f.escrow.connect(f.keeper).finalizeMilestone(1n, 0n)).to.not.be.reverted;
    });
  });

  describe("dispute flow", function () {
    async function approvedMilestoneFixture() {
      const f = await loadFixture(fundedFixture);
      await f.escrow.connect(f.seller).submitMilestoneProof(1n, 0n, PROOF_1);
      await f.escrow.connect(f.verifier).approveMilestone(1n, 0n);
      return f;
    }

    it("buyer can dispute within the window", async function () {
      const f = await loadFixture(approvedMilestoneFixture);
      await expect(f.escrow.connect(f.buyer).disputeMilestone(1n, 0n)).to.emit(f.escrow, "MilestoneDisputed");
      const m = await f.escrow.getMilestone(1n, 0n);
      expect(Number(m.state)).to.equal(3); // Disputed
    });

    it("reverts when a non-buyer disputes", async function () {
      const f = await loadFixture(approvedMilestoneFixture);
      await expect(
        f.escrow.connect(f.seller).disputeMilestone(1n, 0n)
      ).to.be.revertedWithCustomError(f.escrow, "NotBuyer");
    });

    it("reverts when disputing after the window elapsed", async function () {
      const f = await loadFixture(approvedMilestoneFixture);
      await time.increase(WINDOW + 1n);
      await expect(
        f.escrow.connect(f.buyer).disputeMilestone(1n, 0n)
      ).to.be.revertedWithCustomError(f.escrow, "DisputeWindowElapsed");
    });

    it("reverts when disputing a milestone that is not Approved", async function () {
      const f = await loadFixture(fundedFixture);
      await expect(
        f.escrow.connect(f.buyer).disputeMilestone(1n, 0n)
      ).to.be.revertedWithCustomError(f.escrow, "MilestoneNotApproved");
    });

    it("verifier resolves a dispute in the seller's favor with exact fee split", async function () {
      const f = await loadFixture(approvedMilestoneFixture);
      await f.escrow.connect(f.buyer).disputeMilestone(1n, 0n);

      const fee = feeOf(AMOUNTS[0]);
      const sellerBefore = await f.token.balanceOf(f.seller.address);
      const treasuryBefore = await f.token.balanceOf(f.treasury.address);

      await expect(f.escrow.connect(f.verifier).resolveDispute(1n, 0n, true))
        .to.emit(f.escrow, "DisputeResolved")
        .withArgs(1n, 0n, true);

      expect(await f.token.balanceOf(f.seller.address)).to.equal(sellerBefore + AMOUNTS[0] - fee);
      expect(await f.token.balanceOf(f.treasury.address)).to.equal(treasuryBefore + fee);
      const m = await f.escrow.getMilestone(1n, 0n);
      expect(Number(m.state)).to.equal(4); // Released
    });

    it("verifier resolves a dispute in the buyer's favor with a full refund (no fee)", async function () {
      const f = await loadFixture(approvedMilestoneFixture);
      await f.escrow.connect(f.buyer).disputeMilestone(1n, 0n);

      const buyerBefore = await f.token.balanceOf(f.buyer.address);
      const treasuryBefore = await f.token.balanceOf(f.treasury.address);

      await expect(f.escrow.connect(f.verifier).resolveDispute(1n, 0n, false))
        .to.emit(f.escrow, "DisputeResolved")
        .withArgs(1n, 0n, false);

      expect(await f.token.balanceOf(f.buyer.address)).to.equal(buyerBefore + AMOUNTS[0]);
      expect(await f.token.balanceOf(f.treasury.address)).to.equal(treasuryBefore); // no fee on refunds
      const m = await f.escrow.getMilestone(1n, 0n);
      expect(Number(m.state)).to.equal(5); // Refunded
      const deal = await f.escrow.getDeal(1n);
      expect(deal.refundedAmount).to.equal(AMOUNTS[0]);
    });

    it("reverts when a non-verifier resolves", async function () {
      const f = await loadFixture(approvedMilestoneFixture);
      await f.escrow.connect(f.buyer).disputeMilestone(1n, 0n);
      await expect(
        f.escrow.connect(f.buyer).resolveDispute(1n, 0n, true)
      ).to.be.revertedWithCustomError(f.escrow, "NotVerifier");
    });

    it("reverts when resolving a milestone that is not Disputed", async function () {
      const f = await loadFixture(approvedMilestoneFixture);
      await expect(
        f.escrow.connect(f.verifier).resolveDispute(1n, 0n, true)
      ).to.be.revertedWithCustomError(f.escrow, "MilestoneNotDisputed");
    });

    it("after a dispute the keeper cannot finalize; only the verifier resolves", async function () {
      const f = await loadFixture(approvedMilestoneFixture);
      await f.escrow.connect(f.buyer).disputeMilestone(1n, 0n);
      await time.increase(WINDOW + 1n);
      await expect(
        f.escrow.connect(f.keeper).finalizeMilestone(1n, 0n)
      ).to.be.revertedWithCustomError(f.escrow, "MilestoneNotApproved");
    });
  });

  describe("refundPendingMilestones", function () {
    it("refunds only never-submitted milestones, leaving the rest intact", async function () {
      const f = await loadFixture(fundedFixture);
      const escrowAddress = await f.escrow.getAddress();
      // m0: released; m1: submitted; m2: still pending
      await f.escrow.connect(f.seller).submitMilestoneProof(1n, 0n, PROOF_1);
      await f.escrow.connect(f.verifier).approveMilestone(1n, 0n);
      await time.increase(WINDOW + 1n);
      await f.escrow.connect(f.keeper).finalizeMilestone(1n, 0n);
      await f.escrow.connect(f.seller).submitMilestoneProof(1n, 1n, PROOF_2);

      const buyerBefore = await f.token.balanceOf(f.buyer.address);
      await expect(f.escrow.connect(f.buyer).refundPendingMilestones(1n))
        .to.emit(f.escrow, "MilestonesRefunded")
        .withArgs(1n, f.buyer.address, AMOUNTS[2], 1n);

      expect(await f.token.balanceOf(f.buyer.address)).to.equal(buyerBefore + AMOUNTS[2]);
      const deal = await f.escrow.getDeal(1n);
      expect(deal.refundedAmount).to.equal(AMOUNTS[2]);
      expect(Number((await f.escrow.getMilestone(1n, 0n)).state)).to.equal(4); // Released
      expect(Number((await f.escrow.getMilestone(1n, 1n)).state)).to.equal(1); // Submitted
      expect(Number((await f.escrow.getMilestone(1n, 2n)).state)).to.equal(5); // Refunded
      expect(await f.escrow.isDealClosed(1n)).to.equal(false);
    });

    it("refunded milestones can no longer receive submissions", async function () {
      const f = await loadFixture(fundedFixture);
      await f.escrow.connect(f.buyer).refundPendingMilestones(1n);
      await expect(
        f.escrow.connect(f.seller).submitMilestoneProof(1n, 0n, PROOF_1)
      ).to.be.revertedWithCustomError(f.escrow, "MilestoneNotPending");
    });

    it("marks the deal closed when every milestone is refunded", async function () {
      const f = await loadFixture(fundedFixture);
      await f.escrow.connect(f.buyer).refundPendingMilestones(1n);
      expect(await f.escrow.isDealClosed(1n)).to.equal(true);
      expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(0n);
    });

    it("reverts when there is nothing pending", async function () {
      const f = await loadFixture(fundedFixture);
      await f.escrow.connect(f.seller).submitMilestoneProof(1n, 0n, PROOF_1);
      // m1/m2 pending so first call works; after refunding them only m0 (Submitted) remains
      await f.escrow.connect(f.buyer).refundPendingMilestones(1n);
      await expect(
        f.escrow.connect(f.buyer).refundPendingMilestones(1n)
      ).to.be.revertedWithCustomError(f.escrow, "NothingToRefund");
    });

    it("reverts for a non-buyer", async function () {
      const f = await loadFixture(fundedFixture);
      await expect(
        f.escrow.connect(f.seller).refundPendingMilestones(1n)
      ).to.be.revertedWithCustomError(f.escrow, "NotBuyer");
    });
  });

  describe("fee accounting exactness", function () {
    it("a fully released deal leaves zero dust and sums exactly", async function () {
      const f = await loadFixture(deployFixture); // clean escrow: this deal must be the only one holding funds
      const amounts = [1_000_000n, 1n, 999_999n]; // includes a 1-base-unit milestone (fee rounds to 0)
      const dealId = await createFundedDeal(f, amounts);
      const total = amounts.reduce((a, b) => a + b, 0n);

      const escrowAddress = await f.escrow.getAddress();
      for (let i = 0; i < amounts.length; i++) {
        await f.escrow.connect(f.seller).submitMilestoneProof(dealId, BigInt(i), ethers.id(`proof-${i}`));
        await f.escrow.connect(f.verifier).approveMilestone(dealId, BigInt(i));
      }
      await time.increase(WINDOW + 1n);
      for (let i = 0; i < amounts.length; i++) {
        await f.escrow.connect(f.keeper).finalizeMilestone(dealId, BigInt(i));
      }

      const expectedFee = amounts.reduce((a, b) => a + feeOf(b), 0n);
      const expectedSeller = amounts.reduce((a, b) => a + (b - feeOf(b)), 0n);

      expect(await f.token.balanceOf(f.treasury.address)).to.equal(expectedFee);
      expect(await f.token.balanceOf(f.seller.address)).to.equal(expectedSeller);
      expect(await f.token.balanceOf(escrowAddress)).to.equal(0n);
      const deal = await f.escrow.getDeal(dealId);
      expect(deal.releasedAmount).to.equal(total);
      expect(await f.escrow.isDealClosed(dealId)).to.equal(true);
      // 1-base-unit milestone: fee rounds down to 0, seller receives the whole unit
      expect(feeOf(1n)).to.equal(0n);
    });

    it("applies the fee to every released milestone, not per deal", async function () {
      const f = await loadFixture(fundedFixture);
      await f.escrow.connect(f.seller).submitMilestoneProof(1n, 0n, PROOF_1);
      await f.escrow.connect(f.verifier).approveMilestone(1n, 0n);
      await time.increase(WINDOW + 1n);
      await f.escrow.connect(f.keeper).finalizeMilestone(1n, 0n);

      expect(await f.token.balanceOf(f.treasury.address)).to.equal(feeOf(AMOUNTS[0]));
      // second release accrues another fee
      await f.escrow.connect(f.seller).submitMilestoneProof(1n, 1n, PROOF_2);
      await f.escrow.connect(f.verifier).approveMilestone(1n, 1n);
      await time.increase(WINDOW + 1n);
      await f.escrow.connect(f.keeper).finalizeMilestone(1n, 1n);
      expect(await f.token.balanceOf(f.treasury.address)).to.equal(feeOf(AMOUNTS[0]) + feeOf(AMOUNTS[1]));
    });
  });

  describe("admin", function () {
    it("updates treasury and fee with events", async function () {
      const f = await loadFixture(deployFixture);
      await expect(f.escrow.connect(f.owner).setTreasury(f.keeper.address))
        .to.emit(f.escrow, "TreasuryUpdated")
        .withArgs(f.treasury.address, f.keeper.address);
      expect(await f.escrow.treasury()).to.equal(f.keeper.address);

      await expect(f.escrow.connect(f.owner).setFeeBps(100n))
        .to.emit(f.escrow, "FeeBpsUpdated")
        .withArgs(FEE_BPS, 100n);
      expect(await f.escrow.feeBps()).to.equal(100n);
    });

    it("reverts for non-owner, zero treasury, or excessive fee", async function () {
      const f = await loadFixture(deployFixture);
      await expect(f.escrow.connect(f.other).setTreasury(f.keeper.address)).to.be.revertedWithCustomError(
        f.escrow,
        "OwnableUnauthorizedAccount"
      );
      await expect(f.escrow.connect(f.other).setFeeBps(1n)).to.be.revertedWithCustomError(
        f.escrow,
        "OwnableUnauthorizedAccount"
      );
      await expect(
        f.escrow.connect(f.owner).setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(f.escrow, "ZeroAddress");
      await expect(f.escrow.connect(f.owner).setFeeBps(1_001n)).to.be.revertedWithCustomError(
        f.escrow,
        "FeeTooHigh"
      );
    });

    it("uses two-step ownership transfer", async function () {
      const f = await loadFixture(deployFixture);
      await f.escrow.connect(f.owner).transferOwnership(f.keeper.address);
      expect(await f.escrow.pendingOwner()).to.equal(f.keeper.address);
      // ownership has NOT transferred yet: the new owner cannot act
      await expect(
        f.escrow.connect(f.keeper).setFeeBps(1n)
      ).to.be.revertedWithCustomError(f.escrow, "OwnableUnauthorizedAccount");
      await expect(
        f.escrow.connect(f.other).acceptOwnership()
      ).to.be.revertedWithCustomError(f.escrow, "OwnableUnauthorizedAccount");
      await f.escrow.connect(f.keeper).acceptOwnership();
      expect(await f.escrow.owner()).to.equal(f.keeper.address);
    });
  });

  describe("multi-deal isolation", function () {
    it("separate deals track state and funds independently", async function () {
      const f = await loadFixture(deployFixture);
      // account #7 — outside the seven roles used by the fixtures, so it is
      // a genuinely independent second buyer
      const [, , , , , , , buyer2] = await ethers.getSigners();
      await f.token.mint(buyer2.address, ethers.parseUnits("1000", 6));

      const escrowAddress = await f.escrow.getAddress();
      await f.escrow.connect(f.buyer).createDeal(f.seller.address, f.verifier.address, await f.token.getAddress(), [...AMOUNTS]);
      await f.escrow.connect(buyer2).createDeal(f.seller.address, f.verifier.address, await f.token.getAddress(), [500n]);
      await f.token.connect(f.buyer).approve(escrowAddress, TOTAL);
      await f.token.connect(buyer2).approve(escrowAddress, 500n);
      await f.escrow.connect(f.buyer).deposit(1n);
      await f.escrow.connect(buyer2).deposit(2n);

      // submitting on deal 1 does not touch deal 2
      await f.escrow.connect(f.seller).submitMilestoneProof(1n, 0n, PROOF_1);
      expect(Number((await f.escrow.getMilestone(2n, 0n)).state)).to.equal(0); // Pending
      expect(await f.token.balanceOf(escrowAddress)).to.equal(TOTAL + 500n);

      // buyer 2 refunds deal 2 fully; deal 1 untouched
      await f.escrow.connect(buyer2).refundPendingMilestones(2n);
      expect(await f.token.balanceOf(escrowAddress)).to.equal(TOTAL);
      expect(await f.escrow.isDealClosed(2n)).to.equal(true);
      expect(await f.escrow.isDealClosed(1n)).to.equal(false);
    });
  });

  describe("reentrancy", function () {
    async function reentrantFixture() {
      const [owner, buyer, seller, verifier, treasury, keeper] = await ethers.getSigners();
      const token = await (await ethers.getContractFactory("ReentrantToken")).deploy();
      const escrow = await (await ethers.getContractFactory("Escrow")).deploy(
        owner.address,
        treasury.address,
        FEE_BPS
      );
      await token.mint(buyer.address, ethers.parseUnits("1000", 6));
      return { owner, buyer, seller, verifier, treasury, keeper, token, escrow };
    }

    it("blocks a reentrant deposit via a malicious ERC20 hook", async function () {
      const { escrow, token, buyer, seller, verifier } = await loadFixture(reentrantFixture);
      const escrowAddress = await escrow.getAddress();
      await escrow.connect(buyer).createDeal(seller.address, verifier.address, await token.getAddress(), [...AMOUNTS]);
      await token.connect(buyer).approve(escrowAddress, TOTAL);

      // arm the token to reenter deposit() during the transferFrom callback
      const data = escrow.interface.encodeFunctionData("deposit", [1n]);
      await token.armAttack(escrowAddress, data);
      await expect(escrow.connect(buyer).deposit(1n)).to.be.revertedWith(
        "ReentrantToken: reentrant call failed"
      );

      // whole transaction rolled back: deal is still Created, nothing moved
      const deal = await escrow.getDeal(1n);
      expect(Number(deal.state)).to.equal(0); // Created
      expect(await token.balanceOf(escrowAddress)).to.equal(0n);
    });

    it("blocks a reentrant finalize and leaves escrow state intact", async function () {
      const { escrow, token, buyer, seller, verifier, keeper } = await loadFixture(reentrantFixture);
      const escrowAddress = await escrow.getAddress();
      await escrow.connect(buyer).createDeal(seller.address, verifier.address, await token.getAddress(), [...AMOUNTS]);
      await token.connect(buyer).approve(escrowAddress, TOTAL);
      await escrow.connect(buyer).deposit(1n); // attack not armed yet
      await escrow.connect(seller).submitMilestoneProof(1n, 0n, PROOF_1);
      await escrow.connect(verifier).approveMilestone(1n, 0n);

      const data = escrow.interface.encodeFunctionData("finalizeMilestone", [1n, 0n]);
      await token.armAttack(escrowAddress, data);
      await time.increase(WINDOW + 1n);

      await expect(escrow.connect(keeper).finalizeMilestone(1n, 0n)).to.be.revertedWith(
        "ReentrantToken: reentrant call failed"
      );

      // rolled back: milestone still Approved, full amount still in escrow
      const m = await escrow.getMilestone(1n, 0n);
      expect(Number(m.state)).to.equal(2); // Approved
      expect(await token.balanceOf(escrowAddress)).to.equal(TOTAL);
      expect(await token.balanceOf(seller.address)).to.equal(0n);
    });
  });
});

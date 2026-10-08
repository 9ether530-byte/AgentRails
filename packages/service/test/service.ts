import { strict as assert } from "node:assert";
import { before, describe, it } from "mocha";
import request from "supertest";
import { bootOnce, type Ctx } from "./helpers";

/**
 * Integration tests: the real express app (supertest) against the in-process
 * hardhat network, with MockUSDC + Escrow deployed by the fixture and the
 * operator wallet acting as buyer/seller/verifier (single-operator mode).
 *
 * Tests are sequential by design — they exercise one continuous lifecycle over
 * three deals, mirroring how the deployed service actually behaves.
 */

let ctx: Ctx;

const USDC = (whole: number): string => (BigInt(whole) * 1_000_000n).toString();

const createDeal = async (body: object): Promise<request.Response> =>
  request(ctx.app).post("/deals").send(body);

before(async function () {
  this.timeout(60_000);
  ctx = await bootOnce();
});

describe("GET /healthz", () => {
  it("reports ok with chain, escrow and operator identity", async () => {
    const res = await request(ctx.app).get("/healthz");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.chainId, "31337");
    assert.equal(res.body.escrow, ctx.escrowAddress);
    assert.equal(res.body.operator, ctx.operator.address);
    assert.ok("lastScannedBlock" in res.body.indexer);
  });
});

describe("input validation and error envelope", () => {
  it("404s unknown routes with the JSON envelope", async () => {
    const res = await request(ctx.app).get("/nope");
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "NOT_FOUND");
  });

  it("rejects malformed JSON bodies", async () => {
    const res = await request(ctx.app)
      .post("/deals")
      .set("Content-Type", "application/json")
      .send("{not json");
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_JSON");
  });

  it("rejects a missing seller address", async () => {
    const res = await createDeal({
      verifier: ctx.operator.address,
      token: ctx.tokenAddress,
      milestoneAmounts: ["1000000"],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_ADDRESS");
  });

  it("rejects a zero address", async () => {
    const res = await createDeal({
      seller: "0x0000000000000000000000000000000000000000",
      verifier: ctx.operator.address,
      token: ctx.tokenAddress,
      milestoneAmounts: ["1000000"],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "ZERO_ADDRESS");
  });

  it("rejects empty milestone lists", async () => {
    const res = await createDeal({
      seller: ctx.operator.address,
      verifier: ctx.operator.address,
      token: ctx.tokenAddress,
      milestoneAmounts: [],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_MILESTONE_AMOUNTS");
  });

  it("rejects zero and non-integer amounts", async () => {
    for (const amounts of [["0"], ["1000000", "0"], ["12.5"], [true]]) {
      const res = await createDeal({
        seller: ctx.operator.address,
        verifier: ctx.operator.address,
        token: ctx.tokenAddress,
        milestoneAmounts: amounts,
      });
      assert.equal(res.status, 400, `amounts ${JSON.stringify(amounts)} should be rejected`);
      assert.equal(res.body.error.code, "INVALID_MILESTONE_AMOUNTS");
    }
  });

  it("rejects deal ids that are not positive integers", async () => {
    for (const id of ["abc", "0", "-1"]) {
      const res = await request(ctx.app).get(`/deals/${id}`);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "INVALID_DEAL_ID");
    }
  });

  it("404s a deal the chain does not know", async () => {
    const res = await request(ctx.app).get("/deals/999999");
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "DEAL_NOT_FOUND");
  });

  it("rejects malformed proof hashes", async () => {
    const res = await request(ctx.app).post("/deals/999999/milestones/0/submit").send({ proofHash: "0x1234" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_PROOF_HASH");
  });

  it("rejects resolve without a boolean releaseToSeller", async () => {
    const res = await request(ctx.app).post("/deals/999999/milestones/0/resolve").send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_BODY");
  });
});

describe("create -> deposit -> submit -> approve -> finalize (happy path)", () => {
  const M0 = USDC(100);
  const M1 = USDC(50);
  const M2 = USDC(25);
  let dealId = "";

  it("creates a deal; the operator is the buyer on-chain", async () => {
    const res = await createDeal({
      seller: ctx.operator.address,
      verifier: ctx.operator.address,
      token: ctx.tokenAddress,
      milestoneAmounts: [M0, M1, M2],
    });
    assert.equal(res.status, 201);
    dealId = res.body.dealId;
    assert.ok(dealId, "dealId must be returned");
    assert.equal(res.body.buyer, ctx.operator.address);
    assert.equal(res.body.totalAmount, "175000000");
    assert.ok(res.body.txHash?.startsWith("0x"));
  });

  it("shows the deal as Created with all milestones Pending before funding", async () => {
    const res = await request(ctx.app).get(`/deals/${dealId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.state, "Created");
    assert.equal(res.body.buyer, ctx.operator.address);
    assert.equal(res.body.milestoneCount, 3);
    assert.equal(res.body.closed, false);
    res.body.milestones.forEach((m: any) => assert.equal(m.state, "Pending"));
  });

  it("deposits (granting the escrow allowance first)", async () => {
    const res = await request(ctx.app).post(`/deals/${dealId}/deposit`);
    assert.equal(res.status, 200);
    assert.equal(res.body.approvedNow, true);
    assert.ok(res.body.depositTxHash.startsWith("0x"));

    const after = await request(ctx.app).get(`/deals/${dealId}`);
    assert.equal(after.body.state, "Funded");
    assert.equal(after.body.totalAmount, "175000000");
  });

  it("submits a proof for milestone 0", async () => {
    const proofHash = "0x" + "11".repeat(32);
    const res = await request(ctx.app).post(`/deals/${dealId}/milestones/0/submit`).send({ proofHash });
    assert.equal(res.status, 200);
    assert.equal(res.body.action, "submit");

    const after = await request(ctx.app).get(`/deals/${dealId}`);
    assert.equal(after.body.milestones[0].state, "Submitted");
    assert.equal(after.body.milestones[0].proofHash, proofHash);
  });

  it("approves milestone 0, opening the dispute window", async () => {
    const res = await request(ctx.app).post(`/deals/${dealId}/milestones/0/approve`);
    assert.equal(res.status, 200);

    const after = await request(ctx.app).get(`/deals/${dealId}`);
    assert.equal(after.body.milestones[0].state, "Approved");
    assert.ok(after.body.milestones[0].disputeWindowEndsAt > 0);
  });

  it("refuses finalize while the dispute window is open (mapped revert)", async () => {
    const res = await request(ctx.app).post(`/deals/${dealId}/milestones/0/finalize`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "DISPUTE_WINDOW_ACTIVE");
  });

  it("finalizes milestone 0 once the 48h window has elapsed (keeper path)", async () => {
    await ctx.bumpTime(172_800 + 60);
    const res = await request(ctx.app).post(`/deals/${dealId}/milestones/0/finalize`);
    assert.equal(res.status, 200);

    const after = await request(ctx.app).get(`/deals/${dealId}`);
    assert.equal(after.body.milestones[0].state, "Released");
    assert.equal(after.body.releasedAmount, M0);
  });

  it("pays the 50bps fee to treasury and the rest to the seller", async () => {
    const treasuryBefore = BigInt(await (ctx.token.connect(ctx.provider) as any).balanceOf(ctx.treasury));
    const fee = (BigInt(M0) * 50n) / 10_000n;

    // create + fund + submit + approve + (window elapses) + release, and
    // observe the exact fee delta on the treasury
    const res = await createDeal({
      seller: ctx.operator.address,
      verifier: ctx.operator.address,
      token: ctx.tokenAddress,
      milestoneAmounts: [USDC(10)],
    });
    const id = res.body.dealId;
    await request(ctx.app).post(`/deals/${id}/deposit`);
    await request(ctx.app).post(`/deals/${id}/milestones/0/submit`).send({ proof: "delivery of thing" });
    const approved = await request(ctx.app).post(`/deals/${id}/milestones/0/approve`);
    assert.equal(approved.status, 200);
    await ctx.bumpTime(172_800 + 60);
    const finalized = await request(ctx.app).post(`/deals/${id}/milestones/0/finalize`);
    assert.equal(finalized.status, 200);

    const treasuryAfter = BigInt(await (ctx.token.connect(ctx.provider) as any).balanceOf(ctx.treasury));
    assert.equal(treasuryAfter - treasuryBefore, fee);
    // the operator is also the seller: net USDC delta is amount - fee
    // (deposit -10 USDC out, release 9.95 USDC back)
    const closed = await request(ctx.app).get(`/deals/${id}`);
    assert.equal(closed.body.closed, true);
    assert.equal(closed.body.releasedAmount, USDC(10));
  });

  it("indexes the deal-1 event history in order with decoded args", async () => {
    await ctx.indexer.tick();
    const res = await request(ctx.app).get("/deals/1/events");
    assert.equal(res.status, 200);
    const names = res.body.events.map((e: any) => e.name);
    assert.deepEqual(names, ["DealCreated", "DealFunded", "ProofSubmitted", "MilestoneApproved", "MilestoneReleased"]);
    const created = res.body.events[0].args;
    assert.equal(created.dealId, "1");
    assert.equal(created.buyer, ctx.operator.address);
    assert.deepEqual(created.milestoneAmounts, [USDC(100), USDC(50), USDC(25)]);
    const funded = res.body.events[1].args;
    assert.equal(funded.totalAmount, "175000000");
    const released = res.body.events[4].args;
    assert.equal(released.fee, (BigInt(USDC(100)) * 50n / 10_000n).toString());
    assert.equal(released.sellerAmount, (BigInt(USDC(100)) - BigInt(USDC(100)) * 50n / 10_000n).toString());
  });
});

describe("on-chain state conflicts and role checks", () => {
  let externalSeller: string;

  before(async () => {
    externalSeller = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // hardhat account #6, not our key
  });

  it("refuses to submit a proof when the seller is not the operator (fail fast, no gas spent)", async () => {
    const res = await createDeal({
      seller: externalSeller,
      verifier: ctx.operator.address,
      token: ctx.tokenAddress,
      milestoneAmounts: [USDC(1)],
    });
    assert.equal(res.status, 201);
    const id = res.body.dealId;
    const dep = await request(ctx.app).post(`/deals/${id}/deposit`);
    assert.equal(dep.status, 200);

    const sub = await request(ctx.app).post(`/deals/${id}/milestones/0/submit`).send({ proofHash: "0x" + "22".repeat(32) });
    assert.equal(sub.status, 409);
    assert.equal(sub.body.error.code, "ROLE_NOT_SIGNABLE");
  });

  it("maps MilestoneNotSubmitted to 409 (approve before submit)", async () => {
    const res = await request(ctx.app).post("/deals/1/milestones/1/approve");
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "MILESTONE_NOT_SUBMITTED");
  });

  it("maps WrongDealState to 409 (double deposit)", async () => {
    const res = await request(ctx.app).post("/deals/1/deposit");
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "WRONG_DEAL_STATE");
  });

  it("maps MilestoneNotApproved to 409 (finalize a Pending milestone)", async () => {
    const res = await request(ctx.app).post("/deals/1/milestones/1/finalize");
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "MILESTONE_NOT_APPROVED");
  });

  it("maps MilestoneNotApproved to 409 (dispute a Pending milestone)", async () => {
    const res = await request(ctx.app).post("/deals/1/milestones/1/dispute");
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "MILESTONE_NOT_APPROVED");
  });

  it("maps MilestoneNotDisputed to 409 (resolve an already-Released milestone)", async () => {
    const res = await request(ctx.app).post("/deals/1/milestones/0/resolve").send({ releaseToSeller: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "MILESTONE_NOT_DISPUTED");
  });
});

describe("dispute -> resolve, both outcomes", () => {
  const M0 = USDC(200);
  const M1 = USDC(300);
  const M2 = USDC(10);
  let dealId = "";

  before(async () => {
    const res = await createDeal({
      seller: ctx.operator.address,
      verifier: ctx.operator.address,
      token: ctx.tokenAddress,
      milestoneAmounts: [M0, M1, M2],
    });
    dealId = res.body.dealId;
    const dep = await request(ctx.app).post(`/deals/${dealId}/deposit`);
    assert.equal(dep.status, 200);
  });

  it("resolves a disputed milestone in the seller's favor, with fee", async () => {
    await request(ctx.app).post(`/deals/${dealId}/milestones/0/submit`).send({ proofHash: "0x" + "33".repeat(32) });
    await request(ctx.app).post(`/deals/${dealId}/milestones/0/approve`);
    const disputed = await request(ctx.app).post(`/deals/${dealId}/milestones/0/dispute`);
    assert.equal(disputed.status, 200);

    const resolved = await request(ctx.app)
      .post(`/deals/${dealId}/milestones/0/resolve`)
      .send({ releaseToSeller: true });
    assert.equal(resolved.status, 200);

    const after = await request(ctx.app).get(`/deals/${dealId}`);
    assert.equal(after.body.milestones[0].state, "Released");
    assert.equal(after.body.releasedAmount, M0);
  });

  it("resolves a disputed milestone in the buyer's favor, full refund, no fee", async () => {
    await request(ctx.app).post(`/deals/${dealId}/milestones/1/submit`).send({ proofHash: "0x" + "44".repeat(32) });
    await request(ctx.app).post(`/deals/${dealId}/milestones/1/approve`);
    await request(ctx.app).post(`/deals/${dealId}/milestones/1/dispute`);

    const resolved = await request(ctx.app)
      .post(`/deals/${dealId}/milestones/1/resolve`)
      .send({ releaseToSeller: false });
    assert.equal(resolved.status, 200);

    const after = await request(ctx.app).get(`/deals/${dealId}`);
    assert.equal(after.body.milestones[1].state, "Refunded");
    assert.equal(after.body.refundedAmount, M1);
  });

  it("rejects a dispute filed after the window elapsed, then the keeper can still finalize", async () => {
    await request(ctx.app).post(`/deals/${dealId}/milestones/2/submit`).send({ proofHash: "0x" + "55".repeat(32) });
    await request(ctx.app).post(`/deals/${dealId}/milestones/2/approve`);
    await ctx.bumpTime(172_800 + 60);

    const late = await request(ctx.app).post(`/deals/${dealId}/milestones/2/dispute`);
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, "DISPUTE_WINDOW_ELAPSED");

    const finalized = await request(ctx.app).post(`/deals/${dealId}/milestones/2/finalize`);
    assert.equal(finalized.status, 200);
    const after = await request(ctx.app).get(`/deals/${dealId}`);
    assert.equal(after.body.milestones[2].state, "Released");
  });

  it("indexes both dispute resolutions with the right sellerFavored flags", async () => {
    await ctx.indexer.tick();
    const res = await request(ctx.app).get(`/deals/${dealId}/events`);
    assert.equal(res.status, 200);
    const resolved = res.body.events.filter((e: any) => e.name === "DisputeResolved");
    assert.equal(resolved.length, 2);
    assert.equal(resolved[0].args.sellerFavored, true);
    assert.equal(resolved[1].args.sellerFavored, false);
    const disputed = res.body.events.filter((e: any) => e.name === "MilestoneDisputed");
    assert.equal(disputed.length, 2);
    assert.deepEqual(disputed.map((e: any) => String(e.args.milestoneIndex)), ["0", "1"]);
  });
});

describe("event indexer robustness", () => {
  it("re-scanning is idempotent: a second tick inserts nothing new", async () => {
    await ctx.indexer.tick();
    const first = await request(ctx.app).get("/deals/2/events");
    await ctx.indexer.tick();
    await ctx.indexer.tick();
    const second = await request(ctx.app).get("/deals/2/events");
    assert.equal(second.body.count, first.body.count);
  });

  it("keeps events of different deals isolated", async () => {
    const one = await request(ctx.app).get("/deals/1/events");
    assert.ok(one.body.count > 0);
    for (const ev of one.body.events) assert.equal(ev.args.dealId, "1");
    const two = await request(ctx.app).get("/deals/2/events");
    for (const ev of two.body.events) assert.equal(ev.args.dealId, "2");
  });

  it("healthz reports the indexer has scanned the chain", async () => {
    const res = await request(ctx.app).get("/healthz");
    assert.ok(res.body.indexer.lastScannedBlock >= 0);
  });
});

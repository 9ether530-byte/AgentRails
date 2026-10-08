import { ethers } from "hardhat";

/**
 * Local deployment: MockUSDC + Escrow + a demo deal, all on the in-process
 * Hardhat network. Run with: npx hardhat run scripts/deploy/local.ts
 */
async function main() {
  const [deployer, treasury, seller, verifier] = await ethers.getSigners();

  console.log("Deployer:", deployer.address);

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  await usdc.waitForDeployment();
  const usdcAddress = await usdc.getAddress();
  console.log("MockUSDC:", usdcAddress);

  const escrow = await (await ethers.getContractFactory("Escrow")).deploy(
    deployer.address,
    treasury.address,
    50
  );
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  console.log("Escrow:", escrowAddress, "| treasury:", treasury.address, "| feeBps: 50");

  // Demo flow: mint tokens, create a 2-milestone deal, fund it.
  const amounts = [1_000_000n, 2_000_000n]; // 1 + 2 USDC
  await usdc.mint(deployer.address, 10_000_000n);
  await usdc.approve(escrowAddress, 3_000_000n);
  await escrow.createDeal(seller.address, verifier.address, usdcAddress, [...amounts]);
  await escrow.deposit(1n);

  const deal = await escrow.getDeal(1n);
  console.log("Demo deal #1 created and funded:", {
    buyer: deal.buyer,
    seller: deal.seller,
    state: Number(deal.state), // 1 = Funded
    totalAmount: deal.totalAmount.toString(),
  });
  console.log("Next: submit/approve/finalize milestone 0 to exercise the release flow.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

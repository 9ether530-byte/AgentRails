import { ethers, network } from "hardhat";

/**
 * Base Sepolia (chain 84532) deployment of Escrow against the REAL Circle USDC.
 *
 * Required env vars (see .env.example):
 *   DEPLOYER_PRIVATE_KEY  fresh testnet-only key, funded from a faucet
 *   USDC_TOKEN_ADDRESS    real USDC on Base Sepolia
 *                         (0x036CbD53842c5426634e7929541eC2318f3dCF7e)
 *   TREASURY_ADDRESS      fee recipient
 *
 * Run with: npx hardhat run scripts/deploy/baseSepolia.ts --network baseSepolia
 * The baseSepolia network only exists in hardhat.config.ts when
 * DEPLOYER_PRIVATE_KEY is exported.
 */
const FEE_BPS = 50;

async function main() {
  if (!process.env.DEPLOYER_PRIVATE_KEY) {
    throw new Error("DEPLOYER_PRIVATE_KEY is not set — export a funded testnet-only key (see .env.example)");
  }
  if (network.name !== "baseSepolia") {
    throw new Error(`Run with --network baseSepolia (current network: ${network.name})`);
  }

  const usdc = process.env.USDC_TOKEN_ADDRESS;
  if (!usdc || !ethers.isAddress(usdc)) {
    throw new Error("USDC_TOKEN_ADDRESS must be set to the real USDC address on Base Sepolia");
  }
  const treasury = process.env.TREASURY_ADDRESS;
  if (!treasury || !ethers.isAddress(treasury)) {
    throw new Error("TREASURY_ADDRESS must be set to the fee recipient address");
  }

  const [deployer] = await ethers.getSigners();

  // Sanity-check the token: must be a deployed contract with 6 decimals (USDC).
  const code = await ethers.provider.getCode(usdc);
  if (code === "0x") {
    throw new Error(`No contract deployed at USDC address ${usdc} on this network`);
  }
  const erc20 = new ethers.Contract(usdc, ["function decimals() view returns (uint8)"], ethers.provider);
  const decimals = await erc20.decimals();
  if (decimals !== 6n) {
    throw new Error(`Token at ${usdc} has ${decimals} decimals, expected 6 (USDC)`);
  }

  const gasBalance = await ethers.provider.getBalance(deployer.address);
  if (gasBalance === 0n) {
    throw new Error(`Deployer ${deployer.address} has no ETH for gas — fund it from a Base Sepolia faucet first`);
  }

  console.log("Deploying Escrow on Base Sepolia (chain 84532)...");
  console.log("  deployer:", deployer.address);
  console.log("  token:   ", usdc);
  console.log("  treasury:", treasury);
  console.log("  feeBps:  ", FEE_BPS);

  const escrow = await (await ethers.getContractFactory("Escrow")).deploy(
    deployer.address,
    treasury,
    FEE_BPS
  );
  await escrow.waitForDeployment();

  const escrowAddress = await escrow.getAddress();
  console.log("Escrow deployed:", escrowAddress);
  console.log("Record this address in the deployment manifest and verify the fee/dispute params on-chain.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

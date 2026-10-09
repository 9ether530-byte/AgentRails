import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Shared deployment-manifest builder.
 *
 * Used by:
 *  - scripts/deploy/baseSepolia.ts (writes the manifest automatically after deploy)
 *  - scripts/manifest.ts (CLI entry to (re)generate a manifest post-deploy)
 *
 * Output: deployment/manifest.<network>.json — commit it as the record of the
 * deployment. It contains only public on-chain facts, never keys.
 */
export async function buildManifest(escrowAddress: string, escrowDeployTx?: string): Promise<object> {
  if ((await ethers.provider.getCode(escrowAddress)) === "0x") {
    throw new Error(`No contract code at ${escrowAddress} — deployment did not go through?`);
  }
  const escrow = new ethers.Contract(
    escrowAddress,
    [
      "function treasury() view returns (address)",
      "function feeBps() view returns (uint256)",
      "function dealCount() view returns (uint256)",
    ],
    ethers.provider
  );
  const [treasury, feeBps, dealCount] = await Promise.all([
    escrow.treasury(),
    escrow.feeBps(),
    escrow.dealCount(),
  ]);
  const net = await ethers.provider.getNetwork();

  let blockNumber: number | null = null;
  if (escrowDeployTx) {
    const receipt = await ethers.provider.getTransactionReceipt(escrowDeployTx);
    if (!receipt) {
      throw new Error(`Deploy tx ${escrowDeployTx} not found on ${network.name}`);
    }
    if (receipt.contractAddress && receipt.contractAddress.toLowerCase() !== escrowAddress.toLowerCase()) {
      throw new Error(
        `Tx ${escrowDeployTx} created ${receipt.contractAddress}, not ${escrowAddress} — refusing to write a mismatched manifest`
      );
    }
    blockNumber = receipt.blockNumber;
  }

  const manifest = {
    network: network.name,
    chainId: Number(net.chainId),
    deployedAt: new Date().toISOString(),
    deployer: (await ethers.getSigners())[0].address,
    escrow: escrowAddress,
    escrowDeployTx: escrowDeployTx ?? null,
    blockNumber,
    treasury,
    feeBps: Number(feeBps),
    disputeWindowSeconds: 172800, // 48h — Escrow.DISPUTE_WINDOW
    dealCountAtManifest: Number(dealCount),
    usdcToken: process.env.USDC_TOKEN_ADDRESS ?? null,
    generator: "packages/contracts/scripts/lib/manifest.ts",
  };

  const dir = path.resolve(__dirname, "..", "..", "deployment");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `manifest.${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  console.log("Manifest written:", file);
  console.log("Commit this manifest as the record of the deployment.");
  return manifest;
}

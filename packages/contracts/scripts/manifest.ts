import { ethers } from "hardhat";
import { buildManifest } from "./lib/manifest";

/**
 * (Re)generate the deployment manifest for an already-deployed Escrow.
 *
 * Required env: ESCROW_ADDRESS — the deployed Escrow contract.
 * Optional env: ESCROW_DEPLOY_TX — creation tx hash; verified against the
 *               contract address before the manifest is written.
 *
 * Run with: npx hardhat run scripts/manifest.ts --network baseSepolia
 * (env loaded via `set -a; source .env; set +a` or equivalent)
 */
async function main() {
  const escrowAddress = process.env.ESCROW_ADDRESS;
  if (!escrowAddress || !ethers.isAddress(escrowAddress)) {
    throw new Error("Set ESCROW_ADDRESS (the deployed Escrow contract) to generate a manifest");
  }
  await buildManifest(escrowAddress, process.env.ESCROW_DEPLOY_TX || undefined);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

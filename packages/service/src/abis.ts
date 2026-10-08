import fs from "node:fs";
import path from "node:path";
import type { InterfaceAbi } from "ethers";

/**
 * The service wraps the contracts package's deployed artifacts. It re-uses the
 * ABI/bytecode JSON emitted by `hardhat compile` in packages/contracts instead
 * of duplicating the contract sources, so there is exactly one source of truth
 * for the contract interface.
 */

export interface Artifact {
  abi: InterfaceAbi;
  bytecode: string;
}

const ESCROW_ARTIFACT = path.join(
  "packages",
  "contracts",
  "artifacts",
  "contracts",
  "Escrow.sol",
  "Escrow.json"
);
const MOCK_USDC_ARTIFACT = path.join(
  "packages",
  "contracts",
  "artifacts",
  "contracts",
  "MockUSDC.sol",
  "MockUSDC.json"
);

function findRepoRoot(): string {
  let dir = __dirname;
  for (let depth = 0; depth < 10; depth++) {
    if (fs.existsSync(path.join(dir, ESCROW_ARTIFACT))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate the Escrow build artifacts (${ESCROW_ARTIFACT}). ` +
      "Run `npx hardhat compile` inside packages/contracts first."
  );
}

function loadArtifact(relPath: string): Artifact {
  const root = findRepoRoot();
  const artifactPath = path.join(root, relPath);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `Missing artifact ${relPath}. Run \`npx hardhat compile\` inside packages/contracts.`
    );
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8")) as Artifact;
}

let escrowArtifact: Artifact | undefined;
let mockUsdcArtifact: Artifact | undefined;

export function loadEscrowArtifact(): Artifact {
  escrowArtifact ??= loadArtifact(ESCROW_ARTIFACT);
  return escrowArtifact;
}

export function loadMockUsdcArtifact(): Artifact {
  mockUsdcArtifact ??= loadArtifact(MOCK_USDC_ARTIFACT);
  return mockUsdcArtifact;
}

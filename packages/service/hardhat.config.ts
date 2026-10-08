import type { HardhatUserConfig } from "hardhat/config";

// This package ships no Solidity of its own. Hardhat is used purely for its
// in-process network (integration tests boot the service against it) and its
// mocha runner. The Escrow/MockUSDC artifacts come from the contracts package
// (see src/abis.ts); run `npx hardhat compile` there if they are missing.
const config: HardhatUserConfig = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: false } } },
  networks: { hardhat: {} },
  mocha: { timeout: 120_000 },
};

export default config;

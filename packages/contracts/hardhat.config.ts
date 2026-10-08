import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-network-helpers";

// Base Sepolia (chain 84532) is configured but only usable when these env vars
// are exported. See .env.example and README.md.
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {},
    ...(process.env.DEPLOYER_PRIVATE_KEY
      ? {
          baseSepolia: {
            url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
            accounts: [process.env.DEPLOYER_PRIVATE_KEY],
            chainId: 84532,
          },
        }
      : {}),
  },
};

export default config;

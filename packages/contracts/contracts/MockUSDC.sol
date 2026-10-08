// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @notice 6-decimal ERC20 for tests and local demos ONLY. Anyone can mint.
 * Never deploy to a live network — the real Escrow deployments point at real
 * USDC via env var (see scripts/deploy/baseSepolia.ts).
 */
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "MUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

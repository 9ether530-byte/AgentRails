// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title ReentrantToken
 * @notice Malicious ERC20 used only by the reentrancy tests. Once armed with
 * `armAttack(target, data)`, every token transfer makes a reentrant call into
 * `target` with `data`; when that reentrant call fails, the whole outer
 * transaction is reverted with this token's own error string. This lets the
 * test suite prove that the Escrow follows checks-effects-interactions: the
 * reentrant call must observe already-updated state and fail.
 * Never deploy. Tests only.
 */
contract ReentrantToken is ERC20 {
    address private _attackTarget;
    bytes private _attackData;

    constructor() ERC20("Reentrant Token", "RTOK") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function armAttack(address target, bytes calldata data) external {
        _attackTarget = target;
        _attackData = data;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (_attackTarget != address(0)) {
            (bool ok, ) = _attackTarget.call(_attackData);
            if (!ok) {
                revert("ReentrantToken: reentrant call failed");
            }
        }
        super._update(from, to, value);
    }
}

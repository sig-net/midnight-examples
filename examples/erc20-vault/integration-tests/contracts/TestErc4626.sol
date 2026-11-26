// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// An OpenZeppelin 5 ERC-4626 shaped like JustLend V2's USDT vault (jUSDTv2): a decimals
// offset of 12 gives 18-decimal shares over a 6-decimal asset. A transfer of the asset
// straight to this contract raises the share price, which stands in for accrued yield.
contract TestErc4626 is ERC4626 {
    constructor(IERC20 asset_) ERC20("Test ERC-4626", "T4626") ERC4626(asset_) {}

    function _decimalsOffset() internal pure override returns (uint8) {
        return 12;
    }

    // OpenZeppelin's _withdraw, paying the asset out with a plain call: Tron USDT's transfer
    // returns false on success, which SafeERC20 refuses, so only a revert fails here.
    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal override {
        if (caller != owner) {
            _spendAllowance(owner, caller, shares);
        }
        _burn(owner, shares);
        (bool ok, ) = asset().call(abi.encodeCall(IERC20.transfer, (receiver, assets)));
        require(ok, "asset transfer reverted");
        emit Withdraw(caller, receiver, owner, assets, shares);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TekoArisan} from "../contracts/TekoArisan.sol";
import {MockIDRX} from "../contracts/MockIDRX.sol";

/**
 * @notice Deploy MockIDRX + TekoArisan, lalu mint saldo demo ke Treasury & approve.
 *   Butuh di .env: TREASURY_PRIVATE_KEY.
 *   forge script script/Deploy.s.sol:Deploy --rpc-url bscTestnet --broadcast
 */
contract Deploy is Script {
    function run() external returns (TekoArisan teko, MockIDRX idrx) {
        uint256 pk = vm.envUint("TREASURY_PRIVATE_KEY");
        address treasury = vm.addr(pk);

        vm.startBroadcast(pk);
        idrx = new MockIDRX();
        teko = new TekoArisan(address(idrx));
        // Faucet demo: mint Rp1.000.000.000 (2 desimal) ke Treasury & approve kontrak
        idrx.mint(treasury, 100_000_000_000);
        idrx.approve(address(teko), type(uint256).max);
        vm.stopBroadcast();

        console.log("MockIDRX   :", address(idrx));
        console.log("TekoArisan :", address(teko));
        console.log("Owner/Treasury:", treasury);
        console.log("\n.env:");
        console.log("CONTRACT_ADDRESS=%s", address(teko));
        console.log("IDRX_ADDRESS=%s", address(idrx));
    }
}

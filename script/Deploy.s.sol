// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TekoArisan} from "../contracts/TekoArisan.sol";
import {TekoReputation} from "../contracts/TekoReputation.sol";
import {MockIDRX} from "../contracts/MockIDRX.sol";

/**
 * @notice Deploy MockIDRX + TekoArisan + TekoReputation, wire reputasi ke
 *   arisan (addWriter + setReputation), lalu mint saldo demo ke Treasury & approve.
 *   Butuh di .env: TREASURY_PRIVATE_KEY, VRF_COORDINATOR, VRF_KEY_HASH,
 *   VRF_SUBSCRIPTION_ID (buat 3 yang terakhir: lihat docs.chain.link/vrf buat
 *   alamat/key hash resmi jaringan ini, dan vrf.chain.link buat bikin subscription).
 *   Kontrak ini HARUS ditambahkan sbg consumer ke subscription itu — baik SEBELUM
 *   deploy (kalau subId sudah ada) atau SESUDAH (panggil addConsumer di
 *   vrf.chain.link pakai address TekoArisan yang di-print script ini).
 *   forge script script/Deploy.s.sol:Deploy --rpc-url bscTestnet --broadcast
 */
contract Deploy is Script {
    function run() external returns (TekoArisan teko, TekoReputation reputation, MockIDRX idrx) {
        uint256 pk = vm.envUint("TREASURY_PRIVATE_KEY");
        address treasury = vm.addr(pk);
        address vrfCoordinator = vm.envAddress("VRF_COORDINATOR");
        bytes32 vrfKeyHash = vm.envBytes32("VRF_KEY_HASH");
        uint256 vrfSubscriptionId = vm.envUint("VRF_SUBSCRIPTION_ID");

        vm.startBroadcast(pk);
        idrx = new MockIDRX();
        teko = new TekoArisan(address(idrx), vrfCoordinator, vrfKeyHash, vrfSubscriptionId);
        reputation = new TekoReputation(treasury);
        reputation.addWriter(address(teko));
        teko.setReputation(address(reputation));

        // Faucet demo: mint Rp1.000.000.000 (2 desimal) ke Treasury & approve kontrak
        idrx.mint(treasury, 100_000_000_000);
        idrx.approve(address(teko), type(uint256).max);
        vm.stopBroadcast();

        console.log("MockIDRX      :", address(idrx));
        console.log("TekoArisan    :", address(teko));
        console.log("TekoReputation:", address(reputation));
        console.log("Owner/Treasury:", treasury);
        console.log("\n.env:");
        console.log("CONTRACT_ADDRESS=%s", address(teko));
        console.log("IDRX_ADDRESS=%s", address(idrx));
        console.log("REPUTATION_ADDRESS=%s", address(reputation));
        console.log(
            "\nJANGAN LUPA: tambahkan %s sbg consumer di subscription VRF %s lewat vrf.chain.link (kalau belum).",
            address(teko),
            vrfSubscriptionId
        );
    }
}

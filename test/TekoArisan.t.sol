// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TekoArisan} from "../contracts/TekoArisan.sol";
import {MockIDRX} from "../contracts/MockIDRX.sol";

contract TekoArisanTest is Test {
    TekoArisan teko;
    MockIDRX idrx;

    address owner = address(this);      // deployer = owner (penerima fee)
    address treasury = address(0x7EC0);
    uint96 constant CONTRIB = 20_000_000; // Rp200.000 (IDRX 2 desimal)
    uint8 constant SIZE = 3;
    address[] members;

    function setUp() public {
        idrx = new MockIDRX();
        teko = new TekoArisan(address(idrx));

        idrx.mint(treasury, 1_000_000_000_000);
        vm.prank(treasury);
        idrx.approve(address(teko), type(uint256).max);

        members.push(address(0xA1));
        members.push(address(0xB2));
        members.push(address(0xC3));
    }

    function _depositAll(uint256 id) internal {
        for (uint256 i; i < SIZE; i++) {
            vm.prank(treasury);
            teko.deposit(id, members[i]);
        }
    }

    function test_CreateGroup() public {
        uint256 id = teko.createGroup(SIZE, CONTRIB);
        assertEq(id, 1);
        (uint96 c, uint8 s,, uint8 paid, uint8 winners, bool locked) = teko.groups(id);
        assertEq(c, CONTRIB);
        assertEq(s, SIZE);
        assertEq(paid, 0);
        assertEq(winners, 0);
        assertFalse(locked);
    }

    /// @notice Siklus arisan penuh: 3 ronde, tiap orang menang tepat 1x, fee 1% tiap ronde.
    function test_FullArisanCycle() public {
        uint256 id = teko.createGroup(SIZE, CONTRIB);

        uint256 pot = uint256(CONTRIB) * SIZE; // 60 IDRX-unit besar (Rp600.000)
        uint256 fee = pot / 100;               // 1%
        uint256 prize = pot - fee;             // 99%
        uint256 ownerStart = idrx.balanceOf(owner);

        address[] memory winners = new address[](SIZE);
        for (uint8 r = 0; r < SIZE; r++) {
            _depositAll(id);
            address w = teko.drawRound(id);
            winners[r] = w;
            // pemenang ronde ini (yang belum pernah menang) terima 99%
            assertEq(idrx.balanceOf(w), prize, "pemenang terima 99%");
        }

        // owner terima 1% tiap ronde
        assertEq(idrx.balanceOf(owner) - ownerStart, fee * SIZE, "total fee owner");
        // kontrak kosong di akhir
        assertEq(idrx.balanceOf(address(teko)), 0, "kontrak kosong");
        // tidak ada pemenang berulang
        assertTrue(
            winners[0] != winners[1] && winners[1] != winners[2] && winners[0] != winners[2],
            "tidak boleh menang 2x"
        );
        // grup selesai
        assertTrue(teko.isFinished(id), "grup selesai");
    }

    function test_RevertWhen_DrawNotFunded() public {
        uint256 id = teko.createGroup(SIZE, CONTRIB);
        vm.prank(treasury);
        teko.deposit(id, members[0]);
        vm.expectRevert(TekoArisan.RoundNotFunded.selector);
        teko.drawRound(id);
    }

    function test_RevertWhen_DoublePaySameRound() public {
        uint256 id = teko.createGroup(SIZE, CONTRIB);
        vm.prank(treasury);
        teko.deposit(id, members[0]);
        vm.prank(treasury);
        vm.expectRevert(TekoArisan.AlreadyPaid.selector);
        teko.deposit(id, members[0]);
    }

    function test_RevertWhen_NonMemberInRound2() public {
        uint256 id = teko.createGroup(SIZE, CONTRIB);
        _depositAll(id);            // roster terkunci
        teko.drawRound(id);         // masuk ronde 2
        vm.prank(treasury);
        vm.expectRevert(TekoArisan.NotMember.selector);
        teko.deposit(id, address(0xDEAD));
    }

    function test_RevertWhen_NonOwnerCreates() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(TekoArisan.NotOwner.selector);
        teko.createGroup(SIZE, CONTRIB);
    }
}

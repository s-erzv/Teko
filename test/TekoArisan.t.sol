// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {TekoArisan} from "../contracts/TekoArisan.sol";
import {TekoReputation} from "../contracts/TekoReputation.sol";
import {MockIDRX} from "../contracts/MockIDRX.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";

contract TekoArisanTest is Test {
    TekoArisan teko;
    TekoReputation reputation;
    MockIDRX idrx;
    VRFCoordinatorV2_5Mock vrfCoordinator;
    uint256 vrfSubId;

    bytes32 constant KEY_HASH = keccak256("test-keyhash");
    uint8 constant PER_CYCLE = 0;
    uint8 constant UPFRONT = 1;

    address treasury_deployer = address(this);  // deployer = treasury (penerima fee)
    address treasury = address(0x7EC0);         // wallet lain yg diapprove buat deposit()
    uint96 constant CONTRIB = 20_000_000;  // Rp200.000 (IDRX 2 desimal)
    uint64 constant CYCLE = 1 days;
    uint96 constant PENALTY_PER_DAY = 1_000_000;   // Rp10.000/hari
    uint96 constant EXIT_PENALTY = 5_000_000;      // Rp50.000
    uint96 constant POST_PAYOUT_PENALTY = 10_000_000; // Rp100.000
    uint8 constant SIZE = 3;
    address[] members;

    function setUp() public {
        idrx = new MockIDRX();

        vm.deal(address(this), 100 ether);
        vrfCoordinator = new VRFCoordinatorV2_5Mock(0.1 ether, 1e9, 1e18);
        vrfSubId = vrfCoordinator.createSubscription();
        vrfCoordinator.fundSubscriptionWithNative{value: 10 ether}(vrfSubId);

        teko = new TekoArisan(address(idrx), address(vrfCoordinator), KEY_HASH, vrfSubId);
        vrfCoordinator.addConsumer(vrfSubId, address(teko));

        reputation = new TekoReputation(treasury_deployer);
        reputation.addWriter(address(teko));
        teko.setReputation(address(reputation));

        idrx.mint(treasury, 1_000_000_000_000);
        vm.prank(treasury);
        idrx.approve(address(teko), type(uint256).max);

        // treasury_deployer (address(this)) juga butuh IDRX + approval:
        // onlyTreasury functions yang menarik dana dipanggil sbg treasury_deployer,
        // sama seperti bot production di mana Treasury == deployer (1 wallet sama).
        idrx.mint(treasury_deployer, 1_000_000_000_000);
        idrx.approve(address(teko), type(uint256).max);

        members.push(address(0xA1));
        members.push(address(0xB2));
        members.push(address(0xC3));
    }

    function _createGroup(uint8 size, uint8 drawMode) internal returns (uint256 id) {
        id = teko.createGroup(size, CONTRIB, CYCLE, PENALTY_PER_DAY, EXIT_PENALTY, POST_PAYOUT_PENALTY, 0, drawMode);
    }

    function _deposit(uint256 id, address member) internal {
        vm.prank(treasury);
        teko.deposit(id, member);
    }

    function _depositAll(uint256 id) internal {
        for (uint256 i; i < members.length; i++) {
            _deposit(id, members[i]);
        }
    }

    /// @dev drawRound() cuma minta VRF kalau beneran perlu (ronde pertama, atau
    ///      tiap ronde di mode PerCycle) — helper ini nangkep dua-duanya:
    ///      kalau RoundDrawn udah nongol di receipt drawRound() itu sendiri
    ///      (Upfront ronde ke-2 dst, sinkron), pakai itu; kalau enggak,
    ///      simulasikan fulfillment VRF via mock coordinator.
    function _drawAndFulfill(uint256 id) internal returns (address winner) {
        vm.recordLogs();
        uint256 reqId = teko.drawRound(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("RoundDrawn(uint256,uint256,address,uint256,uint256)");
        winner = _findWinner(logs, sig);
        if (winner != address(0)) return winner; // sinkron (Upfront, bukan ronde pertama)

        vm.recordLogs();
        vrfCoordinator.fulfillRandomWords(reqId, address(teko));
        logs = vm.getRecordedLogs();
        winner = _findWinner(logs, sig);
    }

    function _findWinner(Vm.Log[] memory logs, bytes32 sig) private pure returns (address winner) {
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == sig) {
                winner = address(uint160(uint256(logs[i].topics[3])));
            }
        }
    }

    // ---------------------------------------------------------------------
    // Dasar: create / deposit / draw (mode PerCycle, perilaku lama)
    // ---------------------------------------------------------------------
    function test_CreateGroup() public {
        uint256 id = _createGroup(SIZE, PER_CYCLE);
        (uint96 c, uint8 s, , uint8 paid, uint8 winners, , , bool locked, , , , , , , , , ,) = teko.groups(id);
        assertEq(c, CONTRIB);
        assertEq(s, SIZE);
        assertEq(paid, 0);
        assertEq(winners, 0);
        assertFalse(locked);
    }

    function test_FullArisanCycle_PerCycle() public {
        uint256 id = _createGroup(SIZE, PER_CYCLE);

        uint256 pot = uint256(CONTRIB) * SIZE;
        uint256 fee = pot / 100;
        uint256 prize = pot - fee;
        uint256 treasuryStart = idrx.balanceOf(treasury_deployer);

        address[] memory winners = new address[](SIZE);
        for (uint8 r = 0; r < SIZE; r++) {
            _depositAll(id);
            address w = _drawAndFulfill(id);
            winners[r] = w;
            assertEq(idrx.balanceOf(w), prize, "pemenang terima 99%");
        }

        assertEq(idrx.balanceOf(treasury_deployer) - treasuryStart, fee * SIZE, "total fee treasury");
        assertEq(idrx.balanceOf(address(teko)), 0, "kontrak kosong");
        assertTrue(
            winners[0] != winners[1] && winners[1] != winners[2] && winners[0] != winners[2],
            "tidak boleh menang 2x"
        );
        assertTrue(teko.isFinished(id), "grup selesai");

        TekoReputation.Record memory rec = reputation.record(members[0]);
        assertEq(rec.onTime, SIZE);
    }

    /// @dev Mode Upfront: cuma ronde PERTAMA yang butuh VRF (buat nyusun
    ///      seluruh antrian sekali) — ronde ke-2 dst harus cair SINKRON dalam
    ///      transaksi drawRound() itu sendiri, TANPA VRF lagi.
    function test_FullArisanCycle_Upfront_OnlyFirstRoundNeedsVRF() public {
        uint256 id = _createGroup(SIZE, UPFRONT);

        _depositAll(id);
        uint256 reqId1 = teko.drawRound(id);
        assertTrue(reqId1 != 0, "ronde pertama harus minta VRF");
        vrfCoordinator.fulfillRandomWords(reqId1, address(teko));

        (, , , , , , , , bool activated1, , , , , , , , ,) = teko.groups(id);
        assertTrue(activated1, "grup aktif setelah VRF pertama");
        address[] memory q = teko.queue(id);
        assertEq(q.length, SIZE - 1, "sisa 2 di antrian setelah 1 menang");

        for (uint8 r = 1; r < SIZE; r++) {
            _depositAll(id);
            vm.recordLogs();
            uint256 reqId = teko.drawRound(id);
            assertEq(reqId, 0, "ronde ke-2 dst di Upfront gak minta VRF (requestId 0)");
            Vm.Log[] memory logs = vm.getRecordedLogs();
            address w = _findWinner(logs, keccak256("RoundDrawn(uint256,uint256,address,uint256,uint256)"));
            assertTrue(w != address(0), "RoundDrawn harus langsung muncul sinkron");
        }

        assertTrue(teko.isFinished(id), "grup selesai");
    }

    function test_RevertWhen_DrawNotFunded() public {
        uint256 id = _createGroup(SIZE, PER_CYCLE);
        _deposit(id, members[0]);
        vm.expectRevert(TekoArisan.RoundNotFunded.selector);
        teko.drawRound(id);
    }

    function test_RevertWhen_DrawAlreadyPending() public {
        uint256 id = _createGroup(SIZE, PER_CYCLE);
        _depositAll(id);
        teko.drawRound(id); // minta VRF, belum di-fulfill
        vm.expectRevert(TekoArisan.DrawAlreadyPending.selector);
        teko.drawRound(id);
    }

    function test_RevertWhen_DoublePaySameRound() public {
        uint256 id = _createGroup(SIZE, PER_CYCLE);
        _deposit(id, members[0]);
        vm.prank(treasury);
        vm.expectRevert(TekoArisan.AlreadyPaid.selector);
        teko.deposit(id, members[0]);
    }

    function test_RevertWhen_NonMemberInRound2() public {
        uint256 id = _createGroup(SIZE, PER_CYCLE);
        _depositAll(id);
        _drawAndFulfill(id);
        vm.prank(treasury);
        vm.expectRevert(TekoArisan.NotMember.selector);
        teko.deposit(id, address(0xDEAD));
    }

    function test_RevertWhen_NonTreasuryCreates() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(TekoArisan.NotTreasury.selector);
        teko.createGroup(SIZE, CONTRIB, CYCLE, 0, 0, 0, 0, PER_CYCLE);
    }

    function test_RevertWhen_InvalidDrawMode() public {
        vm.expectRevert(TekoArisan.InvalidParams.selector);
        teko.createGroup(SIZE, CONTRIB, CYCLE, 0, 0, 0, 0, 2);
    }

    // ---------------------------------------------------------------------
    // Penalti telat + bayar utang
    // ---------------------------------------------------------------------
    function test_PenalizeThenPayDebt() public {
        uint256 id = _createGroup(SIZE, PER_CYCLE);
        _depositAll(id);
        _drawAndFulfill(id);

        _deposit(id, members[0]); // buka ronde 2 + deadline; members[1]/[2] belum bayar

        (, , , , , , , , , , , uint64 deadline, , , , , ,) = teko.groups(id);
        vm.warp(deadline + 2 days);

        teko.penalize(id, members[1]);
        TekoArisan.Member memory m1 = teko.getMember(id, members[1]);
        assertEq(m1.balanceOwed, PENALTY_PER_DAY * 2, "denda 2 hari");
        assertTrue(m1.delinquent);

        vm.expectRevert(TekoArisan.NothingToCharge.selector);
        teko.penalize(id, members[1]);

        teko.payDebt(id, members[1], PENALTY_PER_DAY * 2);

        TekoArisan.Member memory after_ = teko.getMember(id, members[1]);
        assertEq(after_.balanceOwed, 0);
        assertFalse(after_.delinquent);

        (, , , , , , , , , , , , , , , , , uint96 reserve) = teko.groups(id);
        assertEq(reserve, PENALTY_PER_DAY * 2, "denda masuk reserve");
    }

    /// @dev Regresi bug live-testing: 2 panggilan penalize() dengan jarak WAKTU
    ///      beneran (bukan timestamp identik) tidak boleh dobel-charge selama
    ///      belum lewat 1 hari penuh sejak charge terakhir.
    function test_PenalizeSecondCallHoursLater_DoesNotDoubleCharge() public {
        uint256 id = _createGroup(SIZE, PER_CYCLE);
        _depositAll(id);
        _drawAndFulfill(id);
        _deposit(id, members[0]);

        (, , , , , , , , , , , uint64 deadline, , , , , ,) = teko.groups(id);
        vm.warp(deadline + 25);

        teko.penalize(id, members[1]);
        TekoArisan.Member memory afterFirst = teko.getMember(id, members[1]);
        assertEq(afterFirst.balanceOwed, PENALTY_PER_DAY, "charge pertama 1 hari");

        vm.warp(block.timestamp + 3 hours);
        vm.expectRevert(TekoArisan.NothingToCharge.selector);
        teko.penalize(id, members[1]);

        vm.warp(block.timestamp + 1 days);
        teko.penalize(id, members[1]);
        TekoArisan.Member memory afterThird = teko.getMember(id, members[1]);
        assertEq(afterThird.balanceOwed, PENALTY_PER_DAY * 2, "charge hari ke-2 setelah beneran lewat 1 hari penuh");
    }

    // ---------------------------------------------------------------------
    // Exit sebelum menang: refund dikurangi exitPenalty
    // ---------------------------------------------------------------------
    function test_ExitBeforePayout() public {
        uint256 id = _createGroup(SIZE, PER_CYCLE);
        _deposit(id, members[0]);

        uint256 balBefore = idrx.balanceOf(members[0]);
        uint256 refund = teko.exit(id, members[0]);

        assertEq(refund, CONTRIB - EXIT_PENALTY);
        assertEq(idrx.balanceOf(members[0]) - balBefore, refund);

        (, , , uint8 paidThisRound, , uint8 activeCount, uint8 remainingToWin, , , , , , , , , , , uint96 reserve) =
            teko.groups(id);
        assertEq(paidThisRound, 0);
        assertEq(activeCount, 0);
        assertEq(remainingToWin, 0);
        assertEq(reserve, EXIT_PENALTY);

        TekoArisan.Member memory m = teko.getMember(id, members[0]);
        assertTrue(m.exited);
    }

    // ---------------------------------------------------------------------
    // Exit setelah menang: kena utang postPayoutExitPenalty, bukan refund
    // ---------------------------------------------------------------------
    function test_ExitAfterPayout() public {
        uint256 id = _createGroup(2, PER_CYCLE);
        address[] memory two = new address[](2);
        two[0] = members[0];
        two[1] = members[1];
        for (uint256 i; i < 2; i++) _deposit(id, two[i]);
        address winner = _drawAndFulfill(id);

        uint256 refund = teko.exit(id, winner);
        assertEq(refund, 0, "sudah menang, tidak ada refund");

        TekoArisan.Member memory m = teko.getMember(id, winner);
        assertEq(m.balanceOwed, POST_PAYOUT_PENALTY);
        assertTrue(m.delinquent);
        assertTrue(m.exited);

        TekoReputation.Record memory rec = reputation.record(winner);
        assertEq(rec.defaulted, 1, "post-payout exit dilaporkan sbg default");
    }

    function test_RevertWhen_ExitWithOutstandingDebt() public {
        uint256 id = _createGroup(SIZE, PER_CYCLE);
        _depositAll(id);
        _drawAndFulfill(id);

        _deposit(id, members[0]);
        (, , , , , , , , , , , uint64 deadline, , , , , ,) = teko.groups(id);
        vm.warp(deadline + 1 days);
        teko.penalize(id, members[1]);

        vm.expectRevert(TekoArisan.OutstandingDebt.selector);
        teko.exit(id, members[1]);
    }

    // ---------------------------------------------------------------------
    // Replace member
    // ---------------------------------------------------------------------
    function test_ReplaceMember() public {
        uint256 id = _createGroup(SIZE, PER_CYCLE);
        _deposit(id, members[0]);

        address newMember = address(0xD4);
        teko.replaceMember(id, members[0], newMember);

        assertTrue(teko.isMember(id, newMember));
        TekoArisan.Member memory oldM = teko.getMember(id, members[0]);
        assertTrue(oldM.exited);

        assertTrue(teko.paidInRound(id, 1, newMember));
        assertFalse(teko.paidInRound(id, 1, members[0]));

        address[] memory r = teko.roster(id);
        assertEq(r[0], newMember);
    }

    function test_ReplaceMember_UpdatesQueueAfterActivation() public {
        uint256 id = _createGroup(2, UPFRONT);
        address[] memory two = new address[](2);
        two[0] = members[0];
        two[1] = members[1];
        for (uint256 i; i < 2; i++) _deposit(id, two[i]);
        _drawAndFulfill(id); // aktif, 1 orang tersisa di antrian

        address[] memory qBefore = teko.queue(id);
        assertEq(qBefore.length, 1);
        address remaining = qBefore[0];

        address newMember = address(0xD5);
        teko.replaceMember(id, remaining, newMember);

        address[] memory qAfter = teko.queue(id);
        assertEq(qAfter[0], newMember, "antrian ikut ke-update pas replace setelah aktivasi");
    }

    // ---------------------------------------------------------------------
    // Swap posisi gratis (saling setuju)
    // ---------------------------------------------------------------------
    function test_FreeSwap() public {
        uint256 id = _createGroup(SIZE, UPFRONT);
        _depositAll(id);
        _drawAndFulfill(id); // 1 udah menang, 2 sisa di antrian

        address[] memory q = teko.queue(id);
        assertEq(q.length, 2);
        address front = q[0];
        address back = q[1];

        teko.requestSwap(id, back, front);
        assertEq(teko.pendingSwap(id, front), back);

        teko.acceptSwap(id, front, back);

        address[] memory qAfter = teko.queue(id);
        assertEq(qAfter[0], back, "posisi ketuker");
        assertEq(qAfter[1], front);
    }

    function test_RevertWhen_SwapNotActivatedYet() public {
        uint256 id = _createGroup(SIZE, PER_CYCLE);
        _deposit(id, members[0]);
        vm.expectRevert(TekoArisan.NotActivated.selector);
        teko.requestSwap(id, members[0], members[1]);
    }

    // ---------------------------------------------------------------------
    // Priority-swap berbayar — gate posisi beda per mode
    // ---------------------------------------------------------------------
    function test_PrioritySwap_PerCycle_OnlyFrontTargetable() public {
        uint256 id = _createGroup(SIZE, PER_CYCLE);
        _depositAll(id);
        _drawAndFulfill(id);

        address[] memory q = teko.queue(id);
        address front = q[0];
        address back = q[1];

        // requester=front nyoba nawar target=back (posisi non-0) -> ditolak,
        // di PerCycle target WAJIB posisi terdepan (posisi lain bakal keburu
        // diacak ulang sebelum sempat kepake).
        vm.expectRevert(TekoArisan.PrioritySwapTargetNotFront.selector);
        teko.requestPrioritySwap(id, front, back, 1_000_000);
    }

    function test_PrioritySwap_PerCycle_AcceptSwapsPositionsAndCreditsReserve() public {
        uint256 id = _createGroup(SIZE, PER_CYCLE);
        _depositAll(id);
        _drawAndFulfill(id);

        address[] memory q = teko.queue(id);
        address front = q[0];
        address back = q[1];
        uint96 fee = 5_000_000;

        teko.requestPrioritySwap(id, back, front, fee); // back nawar buat gantiin front (target=front, valid krn front posisi 0)

        (, , , , , , , , , , , , , , , , , uint96 reserveBefore) = teko.groups(id);

        teko.acceptPrioritySwap(id, front, back);

        address[] memory qAfter = teko.queue(id);
        assertEq(qAfter[0], back, "penawar maju ke depan");

        (, , , , , , , , , , , , , , , , , uint96 reserveAfter) = teko.groups(id);
        assertEq(reserveAfter - reserveBefore, fee, "fee masuk reserve");
    }

    function test_PrioritySwap_Upfront_RequesterMustBeBehindTarget() public {
        uint256 id = _createGroup(3, UPFRONT);
        address[] memory three = new address[](3);
        three[0] = members[0];
        three[1] = members[1];
        three[2] = members[2];
        for (uint256 i; i < 3; i++) _deposit(id, three[i]);
        _drawAndFulfill(id); // 1 menang, 2 sisa di antrian (index 0 & 1)

        address[] memory q = teko.queue(id);
        address front = q[0];
        address back = q[1];

        // requester = front (posisi 0) nyoba nawar target = back (posisi 1) -> requester harus
        // di BELAKANG target buat "bayar biar maju", front udah paling depan -> invalid.
        vm.expectRevert(); // NotInQueue dipakai jg sbg sinyal posisi invalid di sini
        teko.requestPrioritySwap(id, front, back, 1_000_000);
    }

    function test_RejectPrioritySwap_RefundsFeeToTreasury() public {
        uint256 id = _createGroup(SIZE, PER_CYCLE);
        _depositAll(id);
        _drawAndFulfill(id);

        address[] memory q = teko.queue(id);
        address front = q[0];
        address back = q[1];
        uint96 fee = 3_000_000;

        uint256 treasuryBalBefore = idrx.balanceOf(treasury_deployer);
        teko.requestPrioritySwap(id, back, front, fee);
        teko.rejectPrioritySwap(id, front);

        assertEq(idrx.balanceOf(treasury_deployer), treasuryBalBefore, "fee balik ke treasury (net nol: keluar lalu balik)");
        TekoArisan.PriorityBid memory bid = teko.priorityBid(id, front);
        assertEq(bid.fee, 0, "tawaran udah kehapus");
    }

    // ---------------------------------------------------------------------
    // Governance: kick via voting 70%
    // ---------------------------------------------------------------------
    function test_GovernanceKick() public {
        uint256 id = _createGroup(SIZE, PER_CYCLE);
        _depositAll(id); // semua bayar ronde 1, roster terkunci

        uint256 pid = teko.propose(id, 1 /* Kick */, members[2], 1 days);

        teko.vote(id, pid, members[0], true);
        teko.vote(id, pid, members[1], true);

        teko.executeProposal(id, pid); // permissionless

        TekoArisan.Member memory kicked = teko.getMember(id, members[2]);
        assertTrue(kicked.exited);

        (, , , uint8 paidThisRound, , uint8 activeCount, uint8 remainingToWin, , , , , , , , , , ,) = teko.groups(id);
        assertEq(activeCount, 2, "anggota aktif tinggal 2");
        assertEq(remainingToWin, 2);
        assertEq(paidThisRound, 2, "setoran member yg di-kick dikembalikan & dilepas dari hitungan");

        address w = _drawAndFulfill(id);
        assertTrue(w == members[0] || w == members[1]);
    }

    function test_GovernanceSkip_MovesToBackOfQueue() public {
        uint256 id = _createGroup(SIZE, UPFRONT);
        _depositAll(id);
        _drawAndFulfill(id); // aktif, 2 sisa di antrian

        address[] memory qBefore = teko.queue(id);
        address front = qBefore[0];

        uint256 pid = teko.propose(id, 0 /* Skip */, front, 1 days);
        // pemilih eligible = anggota aktif selain subject = 2 (termasuk yg udah menang ronde 1)
        address voter1 = qBefore[1];
        teko.vote(id, pid, voter1, true);
        // butuh 1 suara lagi dari member yg udah menang ronde 1 (masih anggota aktif, blm exited)
        address[] memory allMembers = teko.roster(id);
        address winnerRound1;
        for (uint256 i; i < allMembers.length; i++) {
            if (allMembers[i] != qBefore[0] && allMembers[i] != qBefore[1]) winnerRound1 = allMembers[i];
        }
        teko.vote(id, pid, winnerRound1, true);
        teko.executeProposal(id, pid);

        address[] memory qAfter = teko.queue(id);
        assertEq(qAfter[qAfter.length - 1], front, "yg di-skip pindah ke paling belakang");
    }

    function test_RevertWhen_VoteBySubjectItself() public {
        uint256 id = _createGroup(SIZE, PER_CYCLE);
        _depositAll(id);
        uint256 pid = teko.propose(id, 1, members[2], 1 days);
        vm.expectRevert(TekoArisan.SubjectCannotVote.selector);
        teko.vote(id, pid, members[2], true);
    }

    // ---------------------------------------------------------------------
    // Force close
    // ---------------------------------------------------------------------
    function test_ForceClose() public {
        uint256 id = _createGroup(SIZE, PER_CYCLE);
        _depositAll(id);

        teko.forceClose(id);

        (, , , , , , , , , bool closed, , , , , , , ,) = teko.groups(id);
        assertTrue(closed);
        assertEq(idrx.balanceOf(members[0]), CONTRIB);
    }
}

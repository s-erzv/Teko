// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TekoArisan} from "../contracts/TekoArisan.sol";
import {TekoReputation} from "../contracts/TekoReputation.sol";
import {MockIDRX} from "../contracts/MockIDRX.sol";

contract TekoArisanTest is Test {
    TekoArisan teko;
    TekoReputation reputation;
    MockIDRX idrx;

    address owner = address(this);      // deployer = owner (penerima fee)
    address treasury = address(0x7EC0);
    uint96 constant CONTRIB = 20_000_000;  // Rp200.000 (IDRX 2 desimal)
    uint64 constant CYCLE = 1 days;
    uint96 constant PENALTY_PER_DAY = 1_000_000;   // Rp10.000/hari
    uint96 constant EXIT_PENALTY = 5_000_000;      // Rp50.000
    uint96 constant POST_PAYOUT_PENALTY = 10_000_000; // Rp100.000
    uint8 constant SIZE = 3;
    address[] members;

    function setUp() public {
        idrx = new MockIDRX();
        teko = new TekoArisan(address(idrx));
        reputation = new TekoReputation(owner);
        reputation.addWriter(address(teko));
        teko.setReputation(address(reputation));

        idrx.mint(treasury, 1_000_000_000_000);
        vm.prank(treasury);
        idrx.approve(address(teko), type(uint256).max);

        // owner (address(this)) juga butuh IDRX + approval: onlyOwner functions
        // yang menarik dana (payDebt, requestPriorityDraw) dipanggil sbg owner,
        // sama seperti bot production di mana Treasury == owner (1 wallet yang
        // sama). Dua alamat terpisah di sini cuma buat menegaskan deposit()
        // tetap permissionless (siapa pun yg approve boleh menyetor).
        idrx.mint(owner, 1_000_000_000_000);
        idrx.approve(address(teko), type(uint256).max);

        members.push(address(0xA1));
        members.push(address(0xB2));
        members.push(address(0xC3));
    }

    function _createGroup(uint8 size) internal returns (uint256 id) {
        id = teko.createGroup(size, CONTRIB, CYCLE, PENALTY_PER_DAY, EXIT_PENALTY, POST_PAYOUT_PENALTY, 0);
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

    // ---------------------------------------------------------------------
    // Dasar: create / deposit / draw (perilaku lama, harus tetap jalan)
    // ---------------------------------------------------------------------
    function test_CreateGroup() public {
        uint256 id = _createGroup(SIZE);
        (uint96 c, uint8 s, , uint8 paid, uint8 winners, , , bool locked, , , , , , , ,) = teko.groups(id);
        assertEq(c, CONTRIB);
        assertEq(s, SIZE);
        assertEq(paid, 0);
        assertEq(winners, 0);
        assertFalse(locked);
    }

    function test_FullArisanCycle() public {
        uint256 id = _createGroup(SIZE);

        uint256 pot = uint256(CONTRIB) * SIZE;
        uint256 fee = pot / 100;
        uint256 prize = pot - fee;
        uint256 ownerStart = idrx.balanceOf(owner);

        address[] memory winners = new address[](SIZE);
        for (uint8 r = 0; r < SIZE; r++) {
            _depositAll(id);
            address w = teko.drawRound(id);
            winners[r] = w;
            assertEq(idrx.balanceOf(w), prize, "pemenang terima 99%");
        }

        assertEq(idrx.balanceOf(owner) - ownerStart, fee * SIZE, "total fee owner");
        assertEq(idrx.balanceOf(address(teko)), 0, "kontrak kosong");
        assertTrue(
            winners[0] != winners[1] && winners[1] != winners[2] && winners[0] != winners[2],
            "tidak boleh menang 2x"
        );
        assertTrue(teko.isFinished(id), "grup selesai");

        // Reputasi: 3 anggota x 3 ronde tepat waktu = onTime 3 masing-masing.
        TekoReputation.Record memory rec = reputation.record(members[0]);
        assertEq(rec.onTime, SIZE);
    }

    function test_RevertWhen_DrawNotFunded() public {
        uint256 id = _createGroup(SIZE);
        _deposit(id, members[0]);
        vm.expectRevert(TekoArisan.RoundNotFunded.selector);
        teko.drawRound(id);
    }

    function test_RevertWhen_DoublePaySameRound() public {
        uint256 id = _createGroup(SIZE);
        _deposit(id, members[0]);
        vm.prank(treasury);
        vm.expectRevert(TekoArisan.AlreadyPaid.selector);
        teko.deposit(id, members[0]);
    }

    function test_RevertWhen_NonMemberInRound2() public {
        uint256 id = _createGroup(SIZE);
        _depositAll(id);
        teko.drawRound(id);
        vm.prank(treasury);
        vm.expectRevert(TekoArisan.NotMember.selector);
        teko.deposit(id, address(0xDEAD));
    }

    function test_RevertWhen_NonOwnerCreates() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(TekoArisan.NotOwner.selector);
        teko.createGroup(SIZE, CONTRIB, CYCLE, 0, 0, 0, 0);
    }

    // ---------------------------------------------------------------------
    // Penalti telat + bayar utang
    // ---------------------------------------------------------------------
    function test_PenalizeThenPayDebt() public {
        uint256 id = _createGroup(SIZE);
        // Ronde 1: semua daftar & bayar dulu (join+setor menyatu di round 1),
        // baru diundi -> masuk ronde 2, di situ baru mungkin ada yg "telat".
        _depositAll(id);
        teko.drawRound(id);

        _deposit(id, members[0]); // buka ronde 2 + deadline; members[1]/[2] belum bayar

        (, , , , , , , , , , uint64 deadline, , , , ,) = teko.groups(id);
        vm.warp(deadline + 2 days);

        teko.penalize(id, members[1]);
        TekoArisan.Member memory m1 = teko.getMember(id, members[1]);
        assertEq(m1.balanceOwed, PENALTY_PER_DAY * 2, "denda 2 hari");
        assertTrue(m1.delinquent);

        // Panggil lagi hari yang sama -> tidak ada tambahan tagihan.
        vm.expectRevert(TekoArisan.NothingToCharge.selector);
        teko.penalize(id, members[1]);

        teko.payDebt(id, members[1], PENALTY_PER_DAY * 2);

        TekoArisan.Member memory after_ = teko.getMember(id, members[1]);
        assertEq(after_.balanceOwed, 0);
        assertFalse(after_.delinquent);

        (, , , , , , , , , , , , , , , uint96 reserve) = teko.groups(id);
        assertEq(reserve, PENALTY_PER_DAY * 2, "denda masuk reserve");
    }

    // ---------------------------------------------------------------------
    // Exit sebelum menang: refund dikurangi exitPenalty
    // ---------------------------------------------------------------------
    function test_ExitBeforePayout() public {
        uint256 id = _createGroup(SIZE);
        _deposit(id, members[0]);

        uint256 balBefore = idrx.balanceOf(members[0]);
        uint256 refund = teko.exit(id, members[0]);

        assertEq(refund, CONTRIB - EXIT_PENALTY);
        assertEq(idrx.balanceOf(members[0]) - balBefore, refund);

        (, , , uint8 paidThisRound, , uint8 activeCount, uint8 remainingToWin, , , , , , , , , uint96 reserve) =
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
        uint256 id = _createGroup(2);
        address[] memory two = new address[](2);
        two[0] = members[0];
        two[1] = members[1];
        for (uint256 i; i < 2; i++) _deposit(id, two[i]);
        address winner = teko.drawRound(id);

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
        uint256 id = _createGroup(SIZE);
        _depositAll(id);
        teko.drawRound(id);

        _deposit(id, members[0]);
        (, , , , , , , , , , uint64 deadline, , , , ,) = teko.groups(id);
        vm.warp(deadline + 1 days);
        teko.penalize(id, members[1]);

        vm.expectRevert(TekoArisan.OutstandingDebt.selector);
        teko.exit(id, members[1]);
    }

    // ---------------------------------------------------------------------
    // Replace member
    // ---------------------------------------------------------------------
    function test_ReplaceMember() public {
        uint256 id = _createGroup(SIZE);
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

    // ---------------------------------------------------------------------
    // Priority-draw: beli tiket ekstra
    // ---------------------------------------------------------------------
    function test_RequestPriorityDraw() public {
        uint256 id = _createGroup(SIZE);
        _deposit(id, members[0]);

        uint96 fee = 2_000_000;
        uint32 w = teko.requestPriorityDraw(id, members[0], fee, 5);
        assertEq(w, 5);
        assertEq(teko.priorityWeight(id, members[0]), 5);

        (, , , , , , , , , , , , , , , uint96 reserve) = teko.groups(id);
        assertEq(reserve, fee);
    }

    // ---------------------------------------------------------------------
    // Governance: kick via voting 70%
    // ---------------------------------------------------------------------
    function test_GovernanceKick() public {
        uint256 id = _createGroup(SIZE);
        _depositAll(id); // semua bayar ronde 1, roster terkunci

        uint256 pid = teko.propose(id, 1 /* Kick */, members[2], 1 days);

        // vote dipanggil owner atas nama voter (identitas diverifikasi off-chain
        // oleh bot lewat Telegram) — sama seperti deposit()/drawRound().
        teko.vote(id, pid, members[0], true);
        teko.vote(id, pid, members[1], true);

        teko.executeProposal(id, pid); // permissionless

        TekoArisan.Member memory kicked = teko.getMember(id, members[2]);
        assertTrue(kicked.exited);

        (, , , uint8 paidThisRound, , uint8 activeCount, uint8 remainingToWin, , , , , , , , ,) = teko.groups(id);
        assertEq(activeCount, 2, "anggota aktif tinggal 2");
        assertEq(remainingToWin, 2);
        assertEq(paidThisRound, 2, "setoran member yg di-kick dikembalikan & dilepas dari hitungan");

        // Sekarang draw langsung bisa jalan dengan 2 anggota tersisa.
        address w = teko.drawRound(id);
        assertTrue(w == members[0] || w == members[1]);
    }

    function test_GovernanceSkip_ExcludesFromThisRoundDraw() public {
        uint256 id = _createGroup(SIZE);
        _depositAll(id);

        uint256 pid = teko.propose(id, 0 /* Skip */, members[0], 1 days);
        teko.vote(id, pid, members[1], true);
        teko.vote(id, pid, members[2], true);
        teko.executeProposal(id, pid);

        assertTrue(teko.skippedThisRound(id, members[0]));

        address w = teko.drawRound(id);
        assertTrue(w != members[0], "member yg di-skip tidak boleh menang ronde ini");
        assertFalse(teko.skippedThisRound(id, members[0]), "flag skip direset setelah draw");
    }

    function test_RevertWhen_VoteBySubjectItself() public {
        uint256 id = _createGroup(SIZE);
        _depositAll(id);
        uint256 pid = teko.propose(id, 1, members[2], 1 days);
        vm.expectRevert(TekoArisan.SubjectCannotVote.selector);
        teko.vote(id, pid, members[2], true);
    }

    // ---------------------------------------------------------------------
    // Force close
    // ---------------------------------------------------------------------
    function test_ForceClose() public {
        uint256 id = _createGroup(SIZE);
        _depositAll(id);

        teko.forceClose(id);

        (, , , , , , , , bool closed, , , , , , ,) = teko.groups(id);
        assertTrue(closed);
        // Pot ronde ini (3 x CONTRIB) dibagi rata ke 3 anggota yg belum menang.
        assertEq(idrx.balanceOf(members[0]), CONTRIB);
    }
}

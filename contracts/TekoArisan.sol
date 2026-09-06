// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

/**
 * @title TekoArisan
 * @notice Escrow arisan (ROSCA) multi-ronde on-chain untuk BNB Chain.
 *
 *         Alur otentik arisan:
 *           - N anggota, tiap ronde masing-masing setor `contribution`.
 *           - Tiap ronde 1 anggota di ANTRIAN terdepan terima seluruh pot (99%),
 *             Treasury/developer memotong 1% platform fee.
 *           - Pemenang TIDAK ikut diundi lagi sampai semua kebagian.
 *           - Setelah semua anggota aktif menang tepat 1x → grup selesai.
 *
 * @dev Mode undian (drawMode), dipilih sekali saat createGroup — sejajar
 *      dengan draw_mode di Circa (Stellar):
 *        - PerCycle (0): antrian sisa DIACAK ULANG tiap kali abis 1 orang
 *          menang. Cuma posisi TERDEPAN yang "nyata" — makanya priority-swap
 *          di mode ini cuma boleh menyasar posisi 0.
 *        - Upfront (1): urutan SELURUH antrian ditentukan SEKALI (pas grup
 *          teraktivasi — roster penuh & VRF pertama selesai), lalu gak
 *          diacak lagi sampai grup selesai. Karena posisi manapun "nyata"
 *          dan permanen, ronde SETELAH aktivasi gak perlu VRF lagi sama
 *          sekali — drawRound() langsung ambil antrian[0] & cair seketika.
 *
 * @dev Model dana: server (Treasury Wallet) jadi proxy fiat — memanggil `deposit()`
 *      atas nama tiap warga setelah mereka "bayar" Payment Link. Treasury harus sudah
 *      approve token ke kontrak ini.
 *
 * @dev Model otorisasi: sama seperti `deposit()`/`drawRound()`, setiap aksi
 *      "atas nama member" dieksekusi Treasury (`onlyTreasury`) atas perintah bot
 *      Telegram — otorisasi "ini beneran keinginan member itu" diverifikasi OFF-CHAIN
 *      lewat identitas Telegram, bukan lewat signature on-chain milik member sendiri.
 *
 * @dev Randomness: Chainlink VRF v2.5. `drawRound()` MEMINTA randomness kalau perlu
 *      (lihat drawMode di atas) — VRFCoordinator memanggil balik `fulfillRandomWords()`
 *      beberapa blok kemudian, dan di situlah antrian disusun/diacak & dana cair.
 *      `RoundDrawn` bisa datang dari transaksi drawRound() itu sendiri (Upfront,
 *      ronde ke-2 dst) ATAU dari transaksi Chainlink yang terpisah (ronde pertama,
 *      dan setiap ronde di mode PerCycle) — konsumen off-chain (bot) harus dengar
 *      event ini, jangan asumsikan selalu sinkron dengan drawRound().
 *
 * @dev Priority-swap di sini diadaptasi jadi SATU tawaran aktif per target (bukan
 *      lelang multi-penawar kaya Circa) — di teko, fee dibayar via Xendit lalu
 *      Treasury yang nyetorin ke kontrak (bukan escrow dari wallet member sendiri),
 *      jadi "refund penawar yang kalah" gak punya padanan off-chain yang bersih.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface ITekoReputation {
    function reportOnTime(address member) external;
    function reportLate(address member) external;
    function reportDefault(address member) external;
}

contract TekoArisan is VRFConsumerBaseV2Plus {
    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------
    error NotTreasury();
    error InvalidParams();
    error GroupNotFound();
    error GroupFinished();
    error GroupClosed();
    error NotMember();
    error AlreadyPaid();
    error RoundNotFunded();
    error TransferFailed();
    error DeadlineNotPassed();
    error NothingToCharge();
    error AlreadyExited();
    error OutstandingDebt();
    error NoOutstandingDebt();
    error CannotReplaceSelf();
    error AlreadyMember();
    error FeeTooLow();
    error ProposalNotFound();
    error VotingClosed();
    error AlreadyVoted();
    error AlreadyExecuted();
    error ThresholdNotMet();
    error NoVotesCast();
    error SubjectCannotVote();
    error NotEligibleVoter();
    error ElectorateTooSmall();
    error SubjectNotMember();
    error DrawAlreadyPending();
    error UnknownRequest();
    error NotActivated();
    error NotInQueue();
    error CannotSwapSelf();
    error NoPendingSwap();
    error SwapTargetMismatch();
    error PrioritySwapTargetNotFront();
    error PrioritySwapAlreadyPending();
    error NoPendingPrioritySwap();

    // ---------------------------------------------------------------------
    // Constants & immutables
    // ---------------------------------------------------------------------
    uint256 private constant PLATFORM_FEE_BPS = 100;   // 1%
    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant MAX_RESERVE_BPS = 1_000;   // cap 10%, sama seperti Circa
    uint256 private constant APPROVAL_BPS = 7_000;      // 70% dari pemilih yang eligible
    uint8 private constant DRAW_MODE_PER_CYCLE = 0;
    uint8 private constant DRAW_MODE_UPFRONT = 1;

    address public immutable treasury; // Treasury/developer: penerima fee & satu-satunya tx submitter
    IERC20 public immutable token;      // IDRX (atau token setoran lain)
    ITekoReputation public reputation;  // opsional, settable oleh treasury

    // ---------------------------------------------------------------------
    // Konfigurasi Chainlink VRF v2.5 — settable (treasury) buat rotasi
    // keyHash/subscription tanpa perlu redeploy kontrak.
    // ---------------------------------------------------------------------
    bytes32 public keyHash;
    uint256 public subscriptionId;
    uint32 public callbackGasLimit = 500_000;
    uint16 public requestConfirmations = 3;
    bool public nativePayment = true; // bayar fee VRF pakai BNB native, bukan LINK

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------
    struct Group {
        uint96 contribution;   // setoran per anggota per ronde (unit terkecil token)
        uint8  size;           // jumlah anggota target awal
        uint8  round;          // ronde berjalan (1-based); 0 = belum ada setoran
        uint8  paidThisRound;  // sudah bayar di ronde berjalan
        uint8  winnersCount;   // sudah menang berapa ronde total
        uint8  activeCount;    // anggota yang masih wajib setor (size - yang sudah exit)
        uint8  remainingToWin; // anggota aktif yang BELUM pernah menang
        bool   rosterLocked;   // roster terkunci setelah anggota penuh
        bool   activated;      // antrian awal sudah tersusun (VRF pertama sudah kelar)
        bool   closed;         // selesai (remainingToWin == 0) atau di-force-close
        uint8  drawMode;       // 0 = PerCycle, 1 = Upfront
        uint64 cycleLengthSecs;
        uint64 cycleDeadline;  // batas waktu setor ronde berjalan; dipakai penalize()
        uint96 penaltyPerDay;  // denda per hari telat
        uint96 exitPenalty;    // dipotong dari refund kalau keluar SEBELUM menang
        uint96 postPayoutExitPenalty; // dibebankan sbg utang kalau keluar SETELAH menang
        uint16 reserveBps;     // skim cadangan dari tiap payout (bps)
        uint96 reserveBalance; // cadangan: kumpulan denda/fee priority/sisa penalty
    }

    struct Member {
        bool   registered;
        bool   exited;
        bool   delinquent;
        bool   penalizedThisRound;
        uint96 balanceOwed;
        uint64 lastPenalizedAt;
    }

    struct Proposal {
        uint8   kind; // 0 = Skip (lewati ronde ini), 1 = Kick (keluarkan)
        address subject;
        uint64  deadline;
        uint32  yesVotes;
        uint32  noVotes;
        uint32  requiredYes;
        bool    executed;
    }

    struct PriorityBid {
        address requester;
        uint96  fee;
    }

    uint256 public groupCount;
    mapping(uint256 => Group) public groups;
    // Histori LENGKAP semua yang pernah gabung (append-only) — dipakai buat
    // menyusun antrian awal & menghitung pemilih governance. TIDAK mencerminkan
    // urutan menang; itu tugas `_queue`.
    mapping(uint256 => address[]) private _roster;
    // Antrian undian aktif — cuma terisi setelah `activated`. Indeks 0 = giliran
    // menang berikutnya. Diacak ulang tiap ronde di mode PerCycle; tetap di mode Upfront.
    mapping(uint256 => address[]) private _queue;
    mapping(uint256 => mapping(address => bool)) public isMember;
    mapping(uint256 => mapping(address => bool)) public hasWon;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public paidInRound;
    mapping(uint256 => mapping(address => Member)) public members;

    // Tuker posisi GRATIS, saling setuju (bukan lelang, bukan bayar).
    mapping(uint256 => mapping(address => address)) public pendingSwap; // groupId => target => requester
    // Tuker posisi BERBAYAR — satu tawaran aktif per target (lihat catatan
    // adaptasi di atas kontrak).
    mapping(uint256 => mapping(address => PriorityBid)) private _priorityBid; // groupId => target => bid

    mapping(uint256 => uint256) public nextProposalId;
    mapping(uint256 => mapping(uint256 => Proposal)) public proposals;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public hasVoted;

    // VRF: requestId -> groupId, dan groupId -> requestId yang lagi pending
    // (0 = tidak ada).
    mapping(uint256 => uint256) public requestIdToGroupId;
    mapping(uint256 => uint256) public pendingRequestId;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    event GroupCreated(uint256 indexed groupId, uint8 size, uint96 contribution, uint8 drawMode);
    event Deposited(uint256 indexed groupId, uint256 indexed round, address indexed member, uint8 paidThisRound);
    event DrawRequested(uint256 indexed groupId, uint256 indexed round, uint256 indexed requestId);
    event RoundDrawn(uint256 indexed groupId, uint256 indexed round, address indexed winner, uint256 prize, uint256 fee);
    event GroupCompleted(uint256 indexed groupId);
    event Penalized(uint256 indexed groupId, address indexed member, uint256 charge, uint256 balanceOwed);
    event DebtPaid(uint256 indexed groupId, address indexed member, uint256 amount);
    event Exited(uint256 indexed groupId, address indexed member, uint256 refund, uint256 debtCharged);
    event Replaced(uint256 indexed groupId, address indexed oldMember, address indexed newMember);
    event SwapRequested(uint256 indexed groupId, address indexed requester, address indexed target);
    event SwapAccepted(uint256 indexed groupId, address indexed requester, address indexed target);
    event PrioritySwapRequested(uint256 indexed groupId, address indexed requester, address indexed target, uint256 fee);
    event PrioritySwapAccepted(uint256 indexed groupId, address indexed requester, address indexed target, uint256 fee);
    event PrioritySwapRejected(uint256 indexed groupId, address indexed requester, address indexed target);
    event ForceClosed(uint256 indexed groupId, uint256 refundPerMember, uint256 eligibleCount);
    event ProposalCreated(uint256 indexed groupId, uint256 indexed proposalId, uint8 kind, address indexed subject);
    event Voted(uint256 indexed groupId, uint256 indexed proposalId, address indexed voter, bool approve);
    event ProposalExecuted(uint256 indexed groupId, uint256 indexed proposalId);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------
    modifier onlyTreasury() {
        if (msg.sender != treasury) revert NotTreasury();
        _;
    }

    /**
     * @param token_ token setoran (IDRX)
     * @param vrfCoordinator_ alamat VRFCoordinatorV2_5 di jaringan ini
     * @param keyHash_ key hash job VRF yang dipilih (menentukan gas lane)
     * @param subscriptionId_ ID subscription VRF yang sudah didanai & sudah
     *        (atau akan) menambahkan kontrak ini sbg consumer
     */
    constructor(address token_, address vrfCoordinator_, bytes32 keyHash_, uint256 subscriptionId_)
        VRFConsumerBaseV2Plus(vrfCoordinator_)
    {
        if (token_ == address(0)) revert InvalidParams();
        treasury = msg.sender;
        token = IERC20(token_);
        keyHash = keyHash_;
        subscriptionId = subscriptionId_;
    }

    function setReputation(address reputation_) external onlyTreasury {
        reputation = ITekoReputation(reputation_);
    }

    /// @notice Update konfigurasi VRF (rotasi key hash / ganti subscription / tuning gas).
    function setVrfConfig(
        bytes32 keyHash_,
        uint256 subscriptionId_,
        uint32 callbackGasLimit_,
        uint16 requestConfirmations_,
        bool nativePayment_
    ) external onlyTreasury {
        keyHash = keyHash_;
        subscriptionId = subscriptionId_;
        callbackGasLimit = callbackGasLimit_;
        requestConfirmations = requestConfirmations_;
        nativePayment = nativePayment_;
    }

    // ---------------------------------------------------------------------
    // 1) Buat grup arisan
    // ---------------------------------------------------------------------
    function createGroup(
        uint8 size,
        uint96 contribution,
        uint64 cycleLengthSecs,
        uint96 penaltyPerDay,
        uint96 exitPenalty,
        uint96 postPayoutExitPenalty,
        uint16 reserveBps,
        uint8 drawMode
    ) external onlyTreasury returns (uint256 groupId) {
        if (size < 2 || contribution == 0) revert InvalidParams();
        if (cycleLengthSecs == 0) revert InvalidParams();
        if (reserveBps > MAX_RESERVE_BPS) revert InvalidParams();
        if (drawMode > DRAW_MODE_UPFRONT) revert InvalidParams();
        unchecked { groupId = ++groupCount; } // mulai dari 1

        Group storage g = groups[groupId];
        g.size = size;
        g.contribution = contribution;
        g.cycleLengthSecs = cycleLengthSecs;
        g.penaltyPerDay = penaltyPerDay;
        g.exitPenalty = exitPenalty;
        g.postPayoutExitPenalty = postPayoutExitPenalty;
        g.reserveBps = reserveBps;
        g.drawMode = drawMode;

        emit GroupCreated(groupId, size, contribution, drawMode);
    }

    // ---------------------------------------------------------------------
    // 2) Setor dana (Treasury proxy atas nama warga)
    // ---------------------------------------------------------------------
    /**
     * @notice Setor 1 slot setoran atas nama `member` untuk ronde berjalan.
     *         Di ronde 1, pemanggilan ini sekaligus membentuk roster hingga penuh.
     * @dev Pemanggil (msg.sender, biasanya Treasury) harus sudah approve token ke
     *      kontrak ini — token ditarik dari SALDO PEMANGGIL, bukan dari `member`.
     */
    function deposit(uint256 groupId, address member) external {
        Group storage g = groups[groupId];
        if (g.size == 0) revert GroupNotFound();
        if (g.closed) revert GroupClosed();

        uint256 round = g.round;
        if (round == 0) { round = 1; g.round = 1; }

        if (paidInRound[groupId][round][member]) revert AlreadyPaid();

        if (!g.rosterLocked) {
            if (!isMember[groupId][member]) {
                isMember[groupId][member] = true;
                _roster[groupId].push(member);
                members[groupId][member].registered = true;
                unchecked { g.activeCount += 1; g.remainingToWin += 1; }
            }
        } else if (!isMember[groupId][member]) {
            revert NotMember();
        } else if (members[groupId][member].exited) {
            revert AlreadyExited();
        }

        paidInRound[groupId][round][member] = true;
        // Setoran tepat waktu membuka jendela penalti ronde ini kalau belum ada.
        if (g.cycleDeadline == 0) {
            g.cycleDeadline = uint64(block.timestamp) + g.cycleLengthSecs;
        }
        Member storage m = members[groupId][member];
        m.penalizedThisRound = false;

        uint8 paid;
        unchecked { paid = g.paidThisRound + 1; }
        g.paidThisRound = paid;
        if (paid == g.size && !g.rosterLocked) g.rosterLocked = true;

        if (!token.transferFrom(msg.sender, address(this), g.contribution)) revert TransferFailed();

        if (address(reputation) != address(0)) {
            if (block.timestamp <= g.cycleDeadline) {
                reputation.reportOnTime(member);
            } else if (!m.penalizedThisRound) {
                reputation.reportLate(member);
            }
        }

        emit Deposited(groupId, round, member, paid);
    }

    // ---------------------------------------------------------------------
    // 3) Undi ronde — VRF cuma dipakai kalau BENERAN perlu
    // ---------------------------------------------------------------------
    /**
     * @notice Setelah semua anggota AKTIF bayar ronde ini: cairkan ke antrian
     *         terdepan. Ronde PERTAMA suatu grup, dan SETIAP ronde di mode
     *         PerCycle, butuh minta randomness VRF dulu (lihat `DrawRequested`
     *         + `RoundDrawn` yang menyusul beberapa blok kemudian). Ronde
     *         KEDUA dst di mode Upfront TIDAK butuh VRF sama sekali — urutan
     *         sudah tetap sejak aktivasi, jadi cair SEKETIKA di transaksi ini
     *         (requestId yang dikembalikan = 0 sbg penanda "gak ada VRF").
     */
    function drawRound(uint256 groupId) external onlyTreasury returns (uint256 requestId) {
        Group storage g = groups[groupId];
        if (g.size == 0) revert GroupNotFound();
        if (g.closed) revert GroupClosed();
        if (pendingRequestId[groupId] != 0) revert DrawAlreadyPending();
        // Roster harus penuh dulu (semua `size` kursi awal pernah setor minimal
        // 1x) sebelum undian boleh jalan — activeCount masih naik selama roster
        // belum terkunci, jadi tanpa gate ini grup bisa keburu diundi dengan
        // anggota yang belum lengkap.
        if (!g.rosterLocked) revert RoundNotFunded();
        if (g.paidThisRound != g.activeCount || g.activeCount == 0) revert RoundNotFunded();

        if (g.activated && g.drawMode == DRAW_MODE_UPFRONT) {
            address winner = _popFront(_queue[groupId]);
            _finishRound(groupId, g, winner);
            return 0;
        }

        requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: 1,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: nativePayment}))
            })
        );

        requestIdToGroupId[requestId] = groupId;
        pendingRequestId[groupId] = requestId;

        emit DrawRequested(groupId, g.round, requestId);
    }

    /**
     * @dev Dipanggil VRFCoordinator begitu randomness siap. Kalau grup belum
     *      `activated`: ini undian PERTAMA — susun seluruh antrian dari
     *      roster (sekali seumur hidup grup), baru ambil terdepan & cair.
     *      Kalau sudah `activated` (berarti mode PerCycle, krn Upfront gak
     *      pernah minta VRF lagi setelah ini): acak ulang SISA antrian, baru
     *      ambil terdepan & cair.
     */
    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        uint256 groupId = requestIdToGroupId[requestId];
        if (groupId == 0) revert UnknownRequest();
        delete requestIdToGroupId[requestId];
        delete pendingRequestId[groupId];

        Group storage g = groups[groupId];
        address[] storage queue = _queue[groupId];

        if (!g.activated) {
            address[] storage roster = _roster[groupId];
            uint256 rlen = roster.length;
            for (uint256 i; i < rlen; ) {
                if (!members[groupId][roster[i]].exited) queue.push(roster[i]);
                unchecked { ++i; }
            }
            g.activated = true;
        }
        _shuffle(queue, randomWords[0]);

        if (queue.length == 0) revert GroupFinished();
        address winner = _popFront(queue);
        _finishRound(groupId, g, winner);
    }

    /// @dev Fisher-Yates, entropi dari 1 kata VRF diturunkan lagi per-langkah
    ///      lewat hashing — aman karena seed dasarnya sendiri sudah dari VRF
    ///      (turunan hash dari sesuatu yang unpredictable tetap unpredictable).
    function _shuffle(address[] storage arr, uint256 seed) private {
        uint256 n = arr.length;
        while (n > 1) {
            unchecked { n -= 1; }
            uint256 j = uint256(keccak256(abi.encode(seed, n))) % (n + 1);
            address tmp = arr[n];
            arr[n] = arr[j];
            arr[j] = tmp;
        }
    }

    /// @dev O(n) shift-remove dari depan — aman krn ukuran arisan dibatasi kecil (<=50).
    function _popFront(address[] storage arr) private returns (address front) {
        front = arr[0];
        uint256 len = arr.length;
        for (uint256 i; i < len - 1; ) {
            arr[i] = arr[i + 1];
            unchecked { ++i; }
        }
        arr.pop();
    }

    function _queueIndexOf(uint256 groupId, address who) private view returns (uint256 idx, bool found) {
        address[] storage q = _queue[groupId];
        uint256 len = q.length;
        for (uint256 i; i < len; ) {
            if (q[i] == who) return (i, true);
            unchecked { ++i; }
        }
        return (0, false);
    }

    function _removeFromQueue(uint256 groupId, address who) private {
        address[] storage q = _queue[groupId];
        uint256 len = q.length;
        for (uint256 i; i < len; ) {
            if (q[i] == who) {
                for (uint256 j = i; j < len - 1; ) {
                    q[j] = q[j + 1];
                    unchecked { ++j; }
                }
                q.pop();
                return;
            }
            unchecked { ++i; }
        }
    }

    function _finishRound(uint256 groupId, Group storage g, address winner) private {
        uint256 round = g.round;
        hasWon[groupId][winner] = true;
        unchecked { g.remainingToWin -= 1; }

        // Hitung pot & fee dari SETORAN RONDE INI (bukan target size tetap) —
        // activeCount sudah dikurangi anggota yang keluar sebelum ronde ini.
        uint256 pot = uint256(g.contribution) * g.activeCount;
        uint256 fee = (pot * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
        uint256 skim = (pot * g.reserveBps) / BPS_DENOMINATOR;
        uint256 prize = pot - fee - skim;
        g.reserveBalance += uint96(skim);

        uint8 winners;
        unchecked { winners = g.winnersCount + 1; }
        g.winnersCount = winners;
        g.paidThisRound = 0;
        g.cycleDeadline = 0;

        bool finished = g.remainingToWin == 0;
        if (!finished) {
            unchecked { g.round = uint8(round) + 1; }
        } else {
            g.closed = true;
        }

        emit RoundDrawn(groupId, round, winner, prize, fee);
        if (finished) {
            emit GroupCompleted(groupId);
            _refundReserve(groupId, g);
        }

        if (fee != 0 && !token.transfer(treasury, fee)) revert TransferFailed();
        if (!token.transfer(winner, prize)) revert TransferFailed();
    }

    /// @dev Sisa reserve dibagi rata ke anggota aktif yang masih ada saat grup
    ///      selesai — sama seperti Circa: cadangan cuma penyangga kekurangan
    ///      selama siklus berjalan, begitu selesai gak ada lagi yang perlu ditutupi.
    function _refundReserve(uint256 groupId, Group storage g) private {
        if (g.reserveBalance == 0 || g.activeCount == 0) return;
        uint256 perMember = uint256(g.reserveBalance) / g.activeCount;
        if (perMember == 0) return;

        address[] storage list = _roster[groupId];
        uint256 len = list.length;
        uint256 distributed;
        for (uint256 i; i < len; ) {
            address a = list[i];
            if (!members[groupId][a].exited) {
                if (!token.transfer(a, perMember)) revert TransferFailed();
                unchecked { distributed += perMember; }
            }
            unchecked { ++i; }
        }
        g.reserveBalance -= uint96(distributed);
    }

    // ---------------------------------------------------------------------
    // 5) Penalti telat — permissionless, sama seperti Circa's penalize()
    // ---------------------------------------------------------------------
    /**
     * @notice Denda `member` untuk tiap hari penuh keterlambatan sejak deadline
     *         ronde ini, `penaltyPerDay` per hari. Aman dipanggil berkali-kali
     *         untuk keterlambatan yang sama: charge dihitung dari
     *         max(lastPenalizedAt, cycleDeadline) sampai sekarang, jadi panggilan
     *         kedua di hari yang sama tidak menagih apa-apa lagi.
     */
    function penalize(uint256 groupId, address member) external {
        Group storage g = groups[groupId];
        if (g.size == 0) revert GroupNotFound();
        if (g.closed) revert GroupClosed();
        if (g.cycleDeadline == 0 || block.timestamp <= g.cycleDeadline) revert DeadlineNotPassed();

        Member storage m = members[groupId][member];
        if (!m.registered) revert NotMember();
        if (m.exited) revert AlreadyExited();
        uint256 round = g.round;
        if (paidInRound[groupId][round][member]) revert AlreadyPaid();

        // Dua rezim pembulatan berbeda tergantung ini charge PERTAMA sejak
        // deadline atau charge LANJUTAN dari charge sebelumnya:
        //   - Pertama kali (chargeFrom == cycleDeadline): pembulatan ke ATAS —
        //     telat walau 1 detik tetap ditagih minimal 1 hari.
        //   - Sudah pernah di-charge sebelumnya (chargeFrom == lastPenalizedAt):
        //     pembulatan ke BAWAH — cuma hitung hari PENUH yang beneran lewat
        //     sejak charge terakhir. Ini WAJIB floor, bukan ceiling: di
        //     blockchain asli tiap panggilan penalize() transaksi TERPISAH
        //     dengan timestamp masing-masing, jadi elapsed antar panggilan
        //     nyaris tidak pernah persis 0 detik — ceiling di kedua rezim
        //     bakal dobel-charge panggilan yang cuma beda beberapa detik.
        bool alreadyCharged = m.lastPenalizedAt > g.cycleDeadline;
        uint64 chargeFrom = alreadyCharged ? m.lastPenalizedAt : g.cycleDeadline;
        uint256 elapsed = block.timestamp - chargeFrom;
        uint256 daysLate = alreadyCharged
            ? elapsed / 86400
            : (elapsed == 0 ? 0 : (elapsed + 86399) / 86400);
        if (daysLate == 0) revert NothingToCharge();

        uint256 charge = uint256(g.penaltyPerDay) * daysLate;
        m.penalizedThisRound = true;
        m.balanceOwed += uint96(charge);
        m.delinquent = true;
        m.lastPenalizedAt = uint64(block.timestamp);

        if (address(reputation) != address(0)) reputation.reportLate(member);

        emit Penalized(groupId, member, charge, m.balanceOwed);
    }

    // ---------------------------------------------------------------------
    // 6) Bayar utang
    // ---------------------------------------------------------------------
    /**
     * @notice Lunasi utang `member` (denda telat / post-payout exit penalty).
     *         Dana ditarik dari SALDO PEMANGGIL (Treasury), sama seperti deposit() —
     *         member membayar via fiat off-chain, Treasury yang menyetorkannya on-chain.
     */
    function payDebt(uint256 groupId, address member, uint96 amount) external onlyTreasury {
        if (amount == 0) revert InvalidParams();
        Group storage g = groups[groupId];
        if (g.size == 0) revert GroupNotFound();
        Member storage m = members[groupId][member];
        if (!m.registered) revert NotMember();
        if (m.balanceOwed == 0) revert NoOutstandingDebt();

        uint96 payAmount = amount > m.balanceOwed ? m.balanceOwed : amount;
        if (!token.transferFrom(msg.sender, address(this), payAmount)) revert TransferFailed();

        m.balanceOwed -= payAmount;
        if (m.balanceOwed == 0) m.delinquent = false;
        g.reserveBalance += payAmount;

        emit DebtPaid(groupId, member, payAmount);
    }

    // ---------------------------------------------------------------------
    // 7) Keluar dari arisan
    // ---------------------------------------------------------------------
    /**
     * @notice Keluarkan `member` dari grup. SEBELUM menang: refund setoran ronde
     *         ini dikurangi exitPenalty (tidak boleh minus). SETELAH menang: kena
     *         utang sebesar postPayoutExitPenalty (dana sudah cair, tidak ada yang
     *         bisa dikurangi langsung). Tidak bisa keluar kalau masih punya utang
     *         berjalan — itu harus dilunasi dulu lewat payDebt().
     */
    function exit(uint256 groupId, address member) external onlyTreasury returns (uint256 refund) {
        Group storage g = groups[groupId];
        if (g.size == 0) revert GroupNotFound();
        Member storage m = members[groupId][member];
        if (!m.registered) revert NotMember();
        if (m.exited) revert AlreadyExited();
        if (m.balanceOwed > 0) revert OutstandingDebt();

        uint256 debtCharged;
        uint256 round = g.round;
        bool won = hasWon[groupId][member];

        if (!won) {
            bool paidThisRound = paidInRound[groupId][round][member];
            if (paidThisRound) {
                uint256 raw = g.exitPenalty >= g.contribution ? 0 : g.contribution - g.exitPenalty;
                refund = raw;
                if (g.contribution > refund) {
                    g.reserveBalance += uint96(g.contribution - refund);
                }
                unchecked { g.paidThisRound -= 1; }
                paidInRound[groupId][round][member] = false;
                if (refund > 0 && !token.transfer(member, refund)) revert TransferFailed();
            }
            unchecked { g.remainingToWin -= 1; }
            if (g.activated) _removeFromQueue(groupId, member);
        } else if (g.postPayoutExitPenalty > 0) {
            m.balanceOwed += g.postPayoutExitPenalty;
            m.delinquent = true;
            debtCharged = g.postPayoutExitPenalty;
            if (address(reputation) != address(0)) reputation.reportDefault(member);
        }

        m.exited = true;
        unchecked { g.activeCount -= 1; }

        emit Exited(groupId, member, refund, debtCharged);
    }

    // ---------------------------------------------------------------------
    // 8) Ganti anggota (replace) — tanpa post-payout exit penalty
    // ---------------------------------------------------------------------
    /**
     * @notice `newMember` mengambil alih slot `oldMember` persis: warisi status
     *         hasWon & sudah-bayar-ronde-ini, tapi mulai bersih (tanpa utang/
     *         riwayat sendiri — riwayat oldMember tetap melekat ke oldMember).
     *         Tidak kena postPayoutExitPenalty: total dana grup tetap utuh,
     *         justru itu bahaya yang ingin dicegah penalty tsb.
     */
    function replaceMember(uint256 groupId, address oldMember, address newMember) external onlyTreasury {
        if (oldMember == newMember) revert CannotReplaceSelf();
        Group storage g = groups[groupId];
        if (g.size == 0) revert GroupNotFound();
        Member storage om = members[groupId][oldMember];
        if (!om.registered) revert NotMember();
        if (om.exited) revert AlreadyExited();
        if (om.balanceOwed > 0) revert OutstandingDebt();
        if (isMember[groupId][newMember]) revert AlreadyMember();

        isMember[groupId][newMember] = true;
        address[] storage list = _roster[groupId];
        for (uint256 i; i < list.length; ) {
            if (list[i] == oldMember) { list[i] = newMember; break; }
            unchecked { ++i; }
        }
        if (g.activated) {
            (uint256 idx, bool found) = _queueIndexOf(groupId, oldMember);
            if (found) _queue[groupId][idx] = newMember;
        }

        hasWon[groupId][newMember] = hasWon[groupId][oldMember];
        uint256 round = g.round;
        if (paidInRound[groupId][round][oldMember]) {
            paidInRound[groupId][round][oldMember] = false;
            paidInRound[groupId][round][newMember] = true;
        }

        members[groupId][newMember].registered = true;
        om.exited = true;

        emit Replaced(groupId, oldMember, newMember);
    }

    // ---------------------------------------------------------------------
    // 9) Tuker posisi — gratis (saling setuju) & berbayar (priority-swap)
    // ---------------------------------------------------------------------
    /// @notice Ajukan tukeran posisi ANTRIAN dengan `target`, gratis. Butuh
    ///         `target` setuju lewat acceptSwap() — gak ada satu pihak yang
    ///         bisa maksa pihak lain pindah posisi.
    function requestSwap(uint256 groupId, address requester, address target) external onlyTreasury {
        if (requester == target) revert CannotSwapSelf();
        Group storage g = groups[groupId];
        if (g.size == 0) revert GroupNotFound();
        if (!g.activated) revert NotActivated();
        (, bool foundR) = _queueIndexOf(groupId, requester);
        (, bool foundT) = _queueIndexOf(groupId, target);
        if (!foundR || !foundT) revert NotInQueue();

        pendingSwap[groupId][target] = requester;
        emit SwapRequested(groupId, requester, target);
    }

    function acceptSwap(uint256 groupId, address target, address requester) external onlyTreasury {
        address stored = pendingSwap[groupId][target];
        if (stored == address(0)) revert NoPendingSwap();
        if (stored != requester) revert SwapTargetMismatch();
        delete pendingSwap[groupId][target];

        (uint256 idxR, bool foundR) = _queueIndexOf(groupId, requester);
        (uint256 idxT, bool foundT) = _queueIndexOf(groupId, target);
        if (!foundR || !foundT) revert NotInQueue();

        address[] storage q = _queue[groupId];
        (q[idxR], q[idxT]) = (q[idxT], q[idxR]);

        emit SwapAccepted(groupId, requester, target);
    }

    /**
     * @notice Tawar posisi `target` dengan `fee` (masuk reserve grup kalau
     *         diterima). Cuma satu tawaran aktif per target dalam satu waktu
     *         (bukan lelang) — lihat catatan adaptasi di kepala kontrak.
     *         Mode PerCycle: `target` WAJIB posisi terdepan (posisi lain
     *         cuma bakal diacak ulang sebelum sempat kepake). Mode Upfront:
     *         `requester` WAJIB di posisi lebih belakang dari `target`
     *         (bayar buat maju, bukan mundur).
     */
    function requestPrioritySwap(uint256 groupId, address requester, address target, uint96 fee)
        external
        onlyTreasury
    {
        if (requester == target) revert CannotSwapSelf();
        if (fee == 0) revert FeeTooLow();
        Group storage g = groups[groupId];
        if (g.size == 0) revert GroupNotFound();
        if (g.closed) revert GroupClosed();
        if (!g.activated) revert NotActivated();

        (uint256 idxR, bool foundR) = _queueIndexOf(groupId, requester);
        (uint256 idxT, bool foundT) = _queueIndexOf(groupId, target);
        if (!foundR || !foundT) revert NotInQueue();

        if (g.drawMode == DRAW_MODE_PER_CYCLE) {
            if (idxT != 0) revert PrioritySwapTargetNotFront();
        } else if (idxR <= idxT) {
            revert NotInQueue();
        }

        if (_priorityBid[groupId][target].fee != 0) revert PrioritySwapAlreadyPending();

        if (!token.transferFrom(msg.sender, address(this), fee)) revert TransferFailed();
        _priorityBid[groupId][target] = PriorityBid({requester: requester, fee: fee});

        emit PrioritySwapRequested(groupId, requester, target, fee);
    }

    function acceptPrioritySwap(uint256 groupId, address target, address requester) external onlyTreasury {
        PriorityBid memory bid = _priorityBid[groupId][target];
        if (bid.fee == 0) revert NoPendingPrioritySwap();
        if (bid.requester != requester) revert SwapTargetMismatch();
        delete _priorityBid[groupId][target];

        (uint256 idxR, bool foundR) = _queueIndexOf(groupId, requester);
        (uint256 idxT, bool foundT) = _queueIndexOf(groupId, target);
        if (!foundR || !foundT) revert NotInQueue();

        address[] storage q = _queue[groupId];
        (q[idxR], q[idxT]) = (q[idxT], q[idxR]);

        Group storage g = groups[groupId];
        g.reserveBalance += bid.fee;

        emit PrioritySwapAccepted(groupId, requester, target, bid.fee);
    }

    /// @notice `target` nolak tawaran — fee balik ke Treasury (yang nyetorinnya).
    function rejectPrioritySwap(uint256 groupId, address target) external onlyTreasury {
        PriorityBid memory bid = _priorityBid[groupId][target];
        if (bid.fee == 0) revert NoPendingPrioritySwap();
        delete _priorityBid[groupId][target];
        if (!token.transfer(treasury, bid.fee)) revert TransferFailed();
        emit PrioritySwapRejected(groupId, bid.requester, target);
    }

    // ---------------------------------------------------------------------
    // 10) Governance: skip / kick lewat voting 70%
    // ---------------------------------------------------------------------
    /**
     * @notice Ajukan proposal skip (lewati giliran menang ronde ini) atau kick
     *         (keluarkan permanen) untuk `subject`. `vote()` dipanggil bot per
     *         suara yang masuk dari Telegram (identitas member diverifikasi
     *         off-chain), tapi tally & threshold-nya tetap dihitung ON-CHAIN,
     *         jadi tetap bisa diaudit publik — bukan sekadar poll Telegram biasa.
     */
    function propose(uint256 groupId, uint8 kind, address subject, uint64 votingWindowSecs)
        external
        onlyTreasury
        returns (uint256 id)
    {
        if (kind > 1) revert InvalidParams();
        Group storage g = groups[groupId];
        if (g.size == 0) revert GroupNotFound();
        if (g.closed) revert GroupClosed();
        Member storage sm = members[groupId][subject];
        if (!sm.registered || sm.exited) revert SubjectNotMember();

        uint32 eligible = _eligibleVoters(groupId, subject);
        if (eligible < 2) revert ElectorateTooSmall();
        uint32 requiredYes = _requiredYes(eligible);

        id = nextProposalId[groupId]++;
        proposals[groupId][id] = Proposal({
            kind: kind,
            subject: subject,
            deadline: uint64(block.timestamp) + votingWindowSecs,
            yesVotes: 0,
            noVotes: 0,
            requiredYes: requiredYes,
            executed: false
        });

        emit ProposalCreated(groupId, id, kind, subject);
    }

    function vote(uint256 groupId, uint256 proposalId, address voter, bool approve) external onlyTreasury {
        Proposal storage p = proposals[groupId][proposalId];
        if (p.deadline == 0) revert ProposalNotFound();
        if (p.executed) revert AlreadyExecuted();
        if (block.timestamp > p.deadline) revert VotingClosed();
        if (voter == p.subject) revert SubjectCannotVote();

        Member storage vm = members[groupId][voter];
        if (!vm.registered || vm.exited) revert NotEligibleVoter();
        if (hasVoted[groupId][proposalId][voter]) revert AlreadyVoted();
        hasVoted[groupId][proposalId][voter] = true;

        if (approve) { p.yesVotes += 1; } else { p.noVotes += 1; }

        emit Voted(groupId, proposalId, voter, approve);
    }

    /// @notice Permissionless, seperti distribute()/penalize() — siapa pun boleh
    ///         mendorong proposal yang sudah mencapai kuorum.
    function executeProposal(uint256 groupId, uint256 proposalId) external {
        Proposal storage p = proposals[groupId][proposalId];
        if (p.deadline == 0) revert ProposalNotFound();
        if (p.executed) revert AlreadyExecuted();

        uint32 live = _requiredYes(_eligibleVoters(groupId, p.subject));
        uint32 bar = p.requiredYes > live ? p.requiredYes : live;
        if (bar < 2) bar = 2;

        if (p.yesVotes == 0) revert NoVotesCast();
        if (p.yesVotes < bar) revert ThresholdNotMet();

        p.executed = true;

        if (p.kind == 0) {
            _govSkip(groupId, p.subject);
        } else {
            _govKick(groupId, p.subject);
        }

        emit ProposalExecuted(groupId, proposalId);
    }

    /// @dev Skip: pindahkan `subject` ke PALING BELAKANG antrian (kalau sudah
    ///      activated) — bukan dikeluarkan, cuma ditunda. Sama seperti gov_skip
    ///      Circa: dampaknya terbatas, sekali paling banyak selisih posisi
    ///      selebar antrian tersisa. Kalau belum activated, no-op aman (belum
    ///      ada antrian buat diapa-apain).
    function _govSkip(uint256 groupId, address subject) private {
        Group storage g = groups[groupId];
        if (!g.activated) return;
        (uint256 idx, bool found) = _queueIndexOf(groupId, subject);
        if (!found) return;
        address[] storage q = _queue[groupId];
        uint256 len = q.length;
        for (uint256 i = idx; i < len - 1; ) {
            q[i] = q[i + 1];
            unchecked { ++i; }
        }
        q[len - 1] = subject;
    }

    function _govKick(uint256 groupId, address subject) private {
        Group storage g = groups[groupId];
        Member storage m = members[groupId][subject];
        bool owesMoney = m.balanceOwed > 0;
        uint256 round = g.round;
        bool won = hasWon[groupId][subject];

        if (!won) {
            bool paidThisRound = paidInRound[groupId][round][subject];
            if (paidThisRound) {
                unchecked { g.paidThisRound -= 1; }
                paidInRound[groupId][round][subject] = false;
                if (!token.transfer(subject, g.contribution)) revert TransferFailed();
            }
            unchecked { g.remainingToWin -= 1; }
            if (g.activated) _removeFromQueue(groupId, subject);
        }
        m.exited = true;
        unchecked { g.activeCount -= 1; }

        if (owesMoney && address(reputation) != address(0)) {
            reputation.reportDefault(subject);
        }
    }

    function _eligibleVoters(uint256 groupId, address subject) private view returns (uint32 count) {
        address[] storage list = _roster[groupId];
        uint256 len = list.length;
        for (uint256 i; i < len; ) {
            address a = list[i];
            if (a != subject && !members[groupId][a].exited) {
                unchecked { count += 1; }
            }
            unchecked { ++i; }
        }
    }

    /// @dev Pembulatan ke ATAS supaya syarat yang pecahan tidak pernah menguntungkan
    ///      pihak yang mau mengeluarkan seseorang.
    function _requiredYes(uint32 eligible) private pure returns (uint32) {
        return (eligible * uint32(APPROVAL_BPS) + 9_999) / 10_000;
    }

    // ---------------------------------------------------------------------
    // 11) Force-close darurat (treasury) — sisa dana dibagi pro-rata
    // ---------------------------------------------------------------------
    function forceClose(uint256 groupId) external onlyTreasury {
        Group storage g = groups[groupId];
        if (g.size == 0) revert GroupNotFound();
        if (g.closed) revert GroupClosed();

        address[] storage list = _roster[groupId];
        uint256 len = list.length;
        uint256 eligibleCount;
        for (uint256 i; i < len; ) {
            address a = list[i];
            if (!hasWon[groupId][a] && !members[groupId][a].exited) {
                unchecked { eligibleCount += 1; }
            }
            unchecked { ++i; }
        }

        uint256 potThisRound = uint256(g.paidThisRound) * g.contribution;
        uint256 totalDistributable = potThisRound + g.reserveBalance;
        uint256 refundPerMember = eligibleCount > 0 && totalDistributable > 0
            ? totalDistributable / eligibleCount
            : 0;

        if (refundPerMember > 0) {
            for (uint256 i; i < len; ) {
                address a = list[i];
                if (!hasWon[groupId][a] && !members[groupId][a].exited) {
                    if (!token.transfer(a, refundPerMember)) revert TransferFailed();
                }
                unchecked { ++i; }
            }
        }

        g.closed = true;
        g.paidThisRound = 0;
        g.reserveBalance = 0;

        emit ForceClosed(groupId, refundPerMember, eligibleCount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------
    function roster(uint256 groupId) external view returns (address[] memory) {
        return _roster[groupId];
    }

    function queue(uint256 groupId) external view returns (address[] memory) {
        return _queue[groupId];
    }

    function priorityBid(uint256 groupId, address target) external view returns (PriorityBid memory) {
        return _priorityBid[groupId][target];
    }

    function potOf(uint256 groupId) external view returns (uint256) {
        Group storage g = groups[groupId];
        return uint256(g.contribution) * g.activeCount;
    }

    function isFinished(uint256 groupId) external view returns (bool) {
        Group storage g = groups[groupId];
        return g.size != 0 && g.closed;
    }

    function getMember(uint256 groupId, address member) external view returns (Member memory) {
        return members[groupId][member];
    }

    function getProposal(uint256 groupId, uint256 proposalId) external view returns (Proposal memory) {
        return proposals[groupId][proposalId];
    }
}

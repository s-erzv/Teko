// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title TekoArisan
 * @notice Escrow arisan (ROSCA) multi-ronde on-chain untuk BNB Chain.
 *
 *         Alur otentik arisan:
 *           - N anggota, tiap ronde masing-masing setor `contribution`.
 *           - Tiap ronde 1 anggota diundi sebagai pemenang & terima seluruh pot
 *             (99%), owner/developer memotong 1% platform fee.
 *           - Pemenang TIDAK ikut diundi lagi sampai semua kebagian.
 *           - Setelah semua anggota aktif menang tepat 1x → grup selesai.
 *
 * @dev Model dana: server (Treasury Wallet) jadi proxy fiat — memanggil `deposit()`
 *      atas nama tiap warga setelah mereka "bayar" Payment Link. Treasury harus sudah
 *      approve token ke kontrak ini.
 *
 * @dev Model otorisasi: sama seperti `deposit()`/`drawRound()` yang sudah ada, setiap
 *      aksi "atas nama member" (penalize, exit, pay_debt, replace, priority-draw,
 *      governance vote) dieksekusi oleh Treasury (`onlyOwner`) atas perintah bot
 *      Telegram — otorisasi "ini beneran keinginan member itu" diverifikasi OFF-CHAIN
 *      lewat identitas Telegram (chat privat, admin check), bukan lewat signature
 *      on-chain milik member sendiri. Ini bukan lubang keamanan baru: `deposit()` dan
 *      `drawRound()` sudah lebih dulu memakai pola ini sejak awal — member custodial
 *      tidak pernah menandatangani transaksi sendiri.
 *
 * @dev Gas: custom errors, storage packing per-slot, immutable, unchecked
 *      pada operasi yang mustahil overflow.
 *
 * @dev Randomness: MVP pakai pseudo-random berbasis block, SAMA seperti draw_order()
 *      di kontrak Circa (Stellar) yang jadi acuan fitur — bukan kelemahan BNB, dua-
 *      duanya sama-sama ditandai "harden ke VRF sebelum mainnet". Untuk produksi
 *      WAJIB ganti `_random()` dengan Chainlink VRF.
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

contract TekoArisan {
    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------
    error NotOwner();
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

    // ---------------------------------------------------------------------
    // Constants & immutables
    // ---------------------------------------------------------------------
    uint256 private constant PLATFORM_FEE_BPS = 100;   // 1%
    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant MAX_RESERVE_BPS = 1_000;   // cap 10%, sama seperti Circa
    uint256 private constant APPROVAL_BPS = 7_000;      // 70% dari pemilih yang eligible

    address public immutable owner;   // Treasury/developer: penerima fee & satu-satunya tx submitter
    IERC20 public immutable token;    // IDRX (atau token setoran lain)
    ITekoReputation public reputation; // opsional, settable oleh owner

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
        bool   closed;         // selesai (remainingToWin == 0) atau di-force-close
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

    uint256 public groupCount;
    mapping(uint256 => Group) public groups;
    mapping(uint256 => address[]) private _roster;
    mapping(uint256 => mapping(address => bool)) public isMember;
    mapping(uint256 => mapping(address => bool)) public hasWon;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public paidInRound;
    mapping(uint256 => mapping(address => Member)) public members;
    // Tiket ekstra di undian berikutnya, dibeli lewat requestPriorityDraw().
    mapping(uint256 => mapping(address => uint32)) public priorityWeight;
    // Dilewati sbg kandidat pemenang RONDE INI SAJA (gov_skip) — tetap wajib
    // setor, cuma ditunda giliran menangnya. Direset tiap kali drawRound() jalan.
    mapping(uint256 => mapping(address => bool)) public skippedThisRound;

    mapping(uint256 => uint256) public nextProposalId;
    mapping(uint256 => mapping(uint256 => Proposal)) public proposals;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public hasVoted;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    event GroupCreated(uint256 indexed groupId, uint8 size, uint96 contribution);
    event Deposited(uint256 indexed groupId, uint256 indexed round, address indexed member, uint8 paidThisRound);
    event RoundDrawn(uint256 indexed groupId, uint256 indexed round, address indexed winner, uint256 prize, uint256 fee);
    event GroupCompleted(uint256 indexed groupId);
    event Penalized(uint256 indexed groupId, address indexed member, uint256 charge, uint256 balanceOwed);
    event DebtPaid(uint256 indexed groupId, address indexed member, uint256 amount);
    event Exited(uint256 indexed groupId, address indexed member, uint256 refund, uint256 debtCharged);
    event Replaced(uint256 indexed groupId, address indexed oldMember, address indexed newMember);
    event PriorityDrawRequested(uint256 indexed groupId, address indexed member, uint256 fee, uint32 newWeight);
    event ForceClosed(uint256 indexed groupId, uint256 refundPerMember, uint256 eligibleCount);
    event ProposalCreated(uint256 indexed groupId, uint256 indexed proposalId, uint8 kind, address indexed subject);
    event Voted(uint256 indexed groupId, uint256 indexed proposalId, address indexed voter, bool approve);
    event ProposalExecuted(uint256 indexed groupId, uint256 indexed proposalId);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address token_) {
        if (token_ == address(0)) revert InvalidParams();
        owner = msg.sender;
        token = IERC20(token_);
    }

    function setReputation(address reputation_) external onlyOwner {
        reputation = ITekoReputation(reputation_);
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
        uint16 reserveBps
    ) external onlyOwner returns (uint256 groupId) {
        if (size < 2 || contribution == 0) revert InvalidParams();
        if (cycleLengthSecs == 0) revert InvalidParams();
        if (reserveBps > MAX_RESERVE_BPS) revert InvalidParams();
        unchecked { groupId = ++groupCount; } // mulai dari 1

        Group storage g = groups[groupId];
        g.size = size;
        g.contribution = contribution;
        g.cycleLengthSecs = cycleLengthSecs;
        g.penaltyPerDay = penaltyPerDay;
        g.exitPenalty = exitPenalty;
        g.postPayoutExitPenalty = postPayoutExitPenalty;
        g.reserveBps = reserveBps;

        emit GroupCreated(groupId, size, contribution);
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
    // 3) + 4) Undi pemenang ronde & cairkan (1% fee owner, 99% pemenang)
    // ---------------------------------------------------------------------
    /**
     * @notice Setelah semua anggota AKTIF (belum keluar) bayar di ronde ini: undi
     *         pemenang (di antara yang belum pernah menang, dibobot oleh tiket
     *         priority-draw), potong 1% fee ke owner, kirim sisanya ke pemenang,
     *         lalu maju ke ronde berikutnya (atau tandai selesai).
     */
    function drawRound(uint256 groupId) external onlyOwner returns (address winner) {
        Group storage g = groups[groupId];
        if (g.size == 0) revert GroupNotFound();
        if (g.closed) revert GroupClosed();
        // Roster harus penuh dulu (semua `size` kursi awal pernah setor minimal
        // 1x) sebelum undian boleh jalan — activeCount masih naik selama roster
        // belum terkunci, jadi tanpa gate ini grup bisa keburu diundi dengan
        // anggota yang belum lengkap.
        if (!g.rosterLocked) revert RoundNotFunded();
        if (g.paidThisRound != g.activeCount || g.activeCount == 0) revert RoundNotFunded();

        uint256 round = g.round;

        address[] storage list = _roster[groupId];
        uint256 len = list.length;

        // Bangun kolam terbobot: tiap anggota yang belum menang, belum keluar,
        // dan tidak di-skip gov ronde ini, muncul (1 + priorityWeight) kali.
        uint256 poolSize;
        for (uint256 i; i < len; ) {
            address a = list[i];
            if (!hasWon[groupId][a] && !members[groupId][a].exited && !skippedThisRound[groupId][a]) {
                unchecked { poolSize += 1 + priorityWeight[groupId][a]; }
            }
            unchecked { ++i; }
        }
        if (poolSize == 0) revert GroupFinished();

        uint256 pick = _random(groupId, round) % poolSize;
        uint256 seen;
        for (uint256 i; i < len; ) {
            address a = list[i];
            if (!hasWon[groupId][a] && !members[groupId][a].exited && !skippedThisRound[groupId][a]) {
                uint256 weight = 1 + priorityWeight[groupId][a];
                if (pick < seen + weight) { winner = a; break; }
                unchecked { seen += weight; }
            }
            unchecked { ++i; }
        }

        hasWon[groupId][winner] = true;
        priorityWeight[groupId][winner] = 0;
        unchecked { g.remainingToWin -= 1; }

        // Skip cuma berlaku 1 ronde — reset semua flag begitu ronde ini selesai diundi.
        for (uint256 i; i < len; ) {
            address a = list[i];
            if (skippedThisRound[groupId][a]) skippedThisRound[groupId][a] = false;
            unchecked { ++i; }
        }

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

        if (fee != 0 && !token.transfer(owner, fee)) revert TransferFailed();
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

        uint64 chargeFrom = m.lastPenalizedAt > g.cycleDeadline ? m.lastPenalizedAt : g.cycleDeadline;
        uint256 elapsed = block.timestamp - chargeFrom;
        // Ceiling division: telat sedikit pun (>0 detik) tetap ditagih minimal 1 hari.
        uint256 daysLate = elapsed == 0 ? 0 : (elapsed + 86399) / 86400;
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
    function payDebt(uint256 groupId, address member, uint96 amount) external onlyOwner {
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
    function exit(uint256 groupId, address member) external onlyOwner returns (uint256 refund) {
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
    function replaceMember(uint256 groupId, address oldMember, address newMember) external onlyOwner {
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

        hasWon[groupId][newMember] = hasWon[groupId][oldMember];
        uint256 round = g.round;
        if (paidInRound[groupId][round][oldMember]) {
            paidInRound[groupId][round][oldMember] = false;
            paidInRound[groupId][round][newMember] = true;
        }
        priorityWeight[groupId][newMember] = priorityWeight[groupId][oldMember];
        priorityWeight[groupId][oldMember] = 0;

        members[groupId][newMember].registered = true;
        om.exited = true;

        emit Replaced(groupId, oldMember, newMember);
    }

    // ---------------------------------------------------------------------
    // 9) Priority-draw — beli tiket ekstra di undian berikutnya
    // ---------------------------------------------------------------------
    /**
     * @notice Adaptasi dari priority-swap (piauw) di Circa. Karena teko mengundi
     *         acak tiap ronde (bukan antrian tetap), "beli posisi lebih dulu"
     *         diterjemahkan jadi "beli peluang lebih besar": tiap unit fee = 1
     *         tiket tambahan di undian berikutnya. Fee masuk ke reserve grup
     *         (dibagi rata ke semua anggota aktif saat grup selesai), bukan ke
     *         anggota lain langsung.
     */
    function requestPriorityDraw(uint256 groupId, address member, uint96 fee, uint32 extraTickets)
        external
        onlyOwner
        returns (uint32 newWeight)
    {
        if (fee == 0 || extraTickets == 0) revert FeeTooLow();
        Group storage g = groups[groupId];
        if (g.size == 0) revert GroupNotFound();
        if (g.closed) revert GroupClosed();
        Member storage m = members[groupId][member];
        if (!m.registered) revert NotMember();
        if (m.exited) revert AlreadyExited();
        if (hasWon[groupId][member]) revert GroupFinished();

        if (!token.transferFrom(msg.sender, address(this), fee)) revert TransferFailed();
        g.reserveBalance += fee;

        newWeight = priorityWeight[groupId][member] + extraTickets;
        priorityWeight[groupId][member] = newWeight;

        emit PriorityDrawRequested(groupId, member, fee, newWeight);
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
        onlyOwner
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

    function vote(uint256 groupId, uint256 proposalId, address voter, bool approve) external onlyOwner {
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

    /// @dev Skip: anggota dilewati sbg kandidat pemenang RONDE INI SAJA (drawRound
    ///      mengecualikannya dari kolam undian) — tetap wajib setor seperti biasa,
    ///      cuma giliran menangnya ditunda. Flag ini otomatis reset begitu
    ///      drawRound() untuk ronde ini selesai dijalankan.
    function _govSkip(uint256 groupId, address subject) private {
        skippedThisRound[groupId][subject] = true;
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
    // 11) Force-close darurat (owner) — sisa dana dibagi pro-rata
    // ---------------------------------------------------------------------
    function forceClose(uint256 groupId) external onlyOwner {
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

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------
    /// @dev MVP pseudo-random — sama persis dengan draw_order() di Circa (Stellar).
    ///      GANTI dengan Chainlink VRF untuk produksi.
    function _random(uint256 groupId, uint256 round) private view returns (uint256) {
        return uint256(
            keccak256(
                abi.encodePacked(
                    block.prevrandao,
                    block.timestamp,
                    blockhash(block.number - 1),
                    groupId,
                    round,
                    address(this)
                )
            )
        );
    }
}

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
 *           - Setelah N ronde, semua anggota sudah menang tepat 1x → grup selesai.
 *
 * @dev Model dana: server (Treasury Wallet) jadi proxy fiat — memanggil `deposit()`
 *      atas nama tiap warga setelah mereka "bayar" Payment Link. Treasury harus sudah
 *      approve token ke kontrak ini.
 *
 * @dev Gas: custom errors, storage packing (1 slot untuk Group), immutable, unchecked
 *      pada operasi yang mustahil overflow.
 *
 * @dev Randomness: MVP pakai pseudo-random berbasis block. Untuk produksi WAJIB ganti
 *      `_random()` dengan Chainlink VRF.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract TekoArisan {
    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------
    error NotOwner();
    error InvalidParams();
    error GroupNotFound();
    error GroupFinished();
    error NotMember();
    error AlreadyPaid();
    error RoundNotFunded();
    error TransferFailed();

    // ---------------------------------------------------------------------
    // Constants & immutables
    // ---------------------------------------------------------------------
    uint256 private constant PLATFORM_FEE_BPS = 100;   // 1%
    uint256 private constant BPS_DENOMINATOR = 10_000;

    address public immutable owner;   // penerima platform fee (developer)
    IERC20 public immutable token;    // IDRX (atau token setoran lain)

    // ---------------------------------------------------------------------
    // Storage — Group dikemas ke dalam 1 slot
    // ---------------------------------------------------------------------
    struct Group {
        uint96 contribution;  // setoran per anggota per ronde (unit terkecil token)
        uint8  size;          // jumlah anggota target
        uint8  round;         // ronde berjalan (1-based); 0 = belum ada setoran
        uint8  paidThisRound; // sudah bayar di ronde berjalan
        uint8  winnersCount;  // sudah menang berapa ronde total
        bool   rosterLocked;  // roster terkunci setelah anggota penuh
    }

    uint256 public groupCount;
    mapping(uint256 => Group) public groups;
    mapping(uint256 => address[]) private _roster;
    mapping(uint256 => mapping(address => bool)) public isMember;
    mapping(uint256 => mapping(address => bool)) public hasWon;
    // groupId => round => member => sudah bayar ronde itu
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public paidInRound;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    event GroupCreated(uint256 indexed groupId, uint8 size, uint96 contribution);
    event Deposited(uint256 indexed groupId, uint256 indexed round, address indexed member, uint8 paidThisRound);
    event RoundDrawn(uint256 indexed groupId, uint256 indexed round, address indexed winner, uint256 prize, uint256 fee);
    event GroupCompleted(uint256 indexed groupId);

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

    // ---------------------------------------------------------------------
    // 1) Buat grup arisan
    // ---------------------------------------------------------------------
    function createGroup(uint8 size, uint96 contribution)
        external
        onlyOwner
        returns (uint256 groupId)
    {
        if (size < 2 || contribution == 0) revert InvalidParams();
        unchecked { groupId = ++groupCount; } // mulai dari 1

        Group storage g = groups[groupId];
        g.size = size;
        g.contribution = contribution;

        emit GroupCreated(groupId, size, contribution);
    }

    // ---------------------------------------------------------------------
    // 2) Setor dana (Treasury proxy atas nama warga)
    // ---------------------------------------------------------------------
    /**
     * @notice Setor 1 slot setoran atas nama `member` untuk ronde berjalan.
     *         Di ronde 1, pemanggilan ini sekaligus membentuk roster hingga penuh.
     * @dev msg.sender (Treasury) harus sudah approve token ke kontrak ini.
     */
    function deposit(uint256 groupId, address member) external {
        Group storage g = groups[groupId];
        uint8 size = g.size;
        if (size == 0) revert GroupNotFound();
        if (g.winnersCount == size) revert GroupFinished();

        // Ronde aktif; setoran pertama membuka ronde 1
        uint256 round = g.round;
        if (round == 0) { round = 1; g.round = 1; }

        if (paidInRound[groupId][round][member]) revert AlreadyPaid();

        if (!g.rosterLocked) {
            // Ronde 1 = pembentukan roster
            if (!isMember[groupId][member]) {
                isMember[groupId][member] = true;
                _roster[groupId].push(member);
            }
        } else if (!isMember[groupId][member]) {
            revert NotMember();
        }

        paidInRound[groupId][round][member] = true;

        uint8 paid;
        unchecked { paid = g.paidThisRound + 1; }
        g.paidThisRound = paid;
        if (paid == size && !g.rosterLocked) g.rosterLocked = true;

        if (!token.transferFrom(msg.sender, address(this), g.contribution)) revert TransferFailed();

        emit Deposited(groupId, round, member, paid);
    }

    // ---------------------------------------------------------------------
    // 3) + 4) Undi pemenang ronde & cairkan (1% fee owner, 99% pemenang)
    // ---------------------------------------------------------------------
    /**
     * @notice Setelah semua anggota bayar di ronde ini: undi pemenang (di antara yang
     *         belum pernah menang), potong 1% fee ke owner, kirim sisanya ke pemenang,
     *         lalu maju ke ronde berikutnya (atau tandai selesai).
     */
    function drawRound(uint256 groupId) external onlyOwner returns (address winner) {
        Group storage g = groups[groupId];
        uint8 size = g.size;
        if (size == 0) revert GroupNotFound();
        if (g.winnersCount == size) revert GroupFinished();
        if (g.paidThisRound != size) revert RoundNotFunded();

        uint256 round = g.round;

        // Pilih pemenang di antara anggota yang BELUM menang
        uint8 remaining;
        unchecked { remaining = size - g.winnersCount; }
        uint256 pick = _random(groupId, round) % remaining;

        address[] storage list = _roster[groupId];
        uint256 len = list.length;
        uint256 seen;
        for (uint256 i; i < len; ) {
            address m = list[i];
            if (!hasWon[groupId][m]) {
                if (seen == pick) { winner = m; break; }
                unchecked { ++seen; }
            }
            unchecked { ++i; }
        }

        hasWon[groupId][winner] = true;

        // Hitung pot & fee. contribution(uint96) * size(uint8) tak mungkin overflow uint256.
        uint256 pot;
        unchecked { pot = uint256(g.contribution) * size; }
        uint256 fee = (pot * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
        uint256 prize = pot - fee;

        // Efek state sebelum transfer (checks-effects-interactions)
        uint8 winners;
        unchecked { winners = g.winnersCount + 1; }
        g.winnersCount = winners;
        g.paidThisRound = 0;

        bool finished = winners == size;
        if (!finished) {
            unchecked { g.round = uint8(round) + 1; }
        }

        emit RoundDrawn(groupId, round, winner, prize, fee);
        if (finished) emit GroupCompleted(groupId);

        if (fee != 0 && !token.transfer(owner, fee)) revert TransferFailed();
        if (!token.transfer(winner, prize)) revert TransferFailed();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------
    function roster(uint256 groupId) external view returns (address[] memory) {
        return _roster[groupId];
    }

    function potOf(uint256 groupId) external view returns (uint256) {
        Group storage g = groups[groupId];
        unchecked { return uint256(g.contribution) * g.size; }
    }

    function isFinished(uint256 groupId) external view returns (bool) {
        Group storage g = groups[groupId];
        return g.size != 0 && g.winnersCount == g.size;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------
    /// @dev MVP pseudo-random. GANTI dengan Chainlink VRF untuk produksi.
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

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title TekoReputation
 * @notice Skor reputasi member, GLOBAL lintas semua grup arisan (beda dari Circa
 *         yang reputasinya per-pool — di sini riwayat seorang member menempel
 *         terus ke address-nya, dipakai lagi tiap dia ikut arisan baru).
 * @dev Hitungan mentah (on_time/late/defaulted) disimpan apa adanya, append-only;
 *      skor dihitung saat dibaca supaya rumus scoring bisa di-tuning belakangan
 *      tanpa menulis ulang / merusak riwayat siapa pun.
 */
contract TekoReputation {
    error NotAuthorized();
    error InvalidParams();

    struct Record {
        uint32 onTime;
        uint32 late;
        uint32 defaulted;
    }

    address public immutable admin;
    mapping(address => bool) public isWriter; // kontrak TekoArisan yang boleh lapor
    mapping(address => Record) private _records;

    event WriterAdded(address indexed writer);
    event WriterRemoved(address indexed writer);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAuthorized();
        _;
    }

    modifier onlyWriter() {
        if (!isWriter[msg.sender]) revert NotAuthorized();
        _;
    }

    constructor(address admin_) {
        if (admin_ == address(0)) revert InvalidParams();
        admin = admin_;
    }

    function addWriter(address writer) external onlyAdmin {
        isWriter[writer] = true;
        emit WriterAdded(writer);
    }

    function removeWriter(address writer) external onlyAdmin {
        isWriter[writer] = false;
        emit WriterRemoved(writer);
    }

    function reportOnTime(address member) external onlyWriter {
        _records[member].onTime += 1;
    }

    function reportLate(address member) external onlyWriter {
        _records[member].late += 1;
    }

    function reportDefault(address member) external onlyWriter {
        _records[member].defaulted += 1;
    }

    function record(address member) external view returns (Record memory) {
        return _records[member];
    }

    /// @notice score = 100 * onTime / (onTime + 2*late + 5*defaulted + 3)
    ///
    /// Member tanpa riwayat skor 0, bukan nilai netral tengah — reputasi harus
    /// dipupuk, bukan diberi cuma-cuma, jadi ganti address bersih tidak untung
    /// apa-apa. `+3` mencegah pembagian nol dan mencegah 1x bayar tepat waktu
    /// langsung dianggap sempurna. Skor mendekati tapi tidak pernah menyentuh
    /// 100 — memang disengaja, kepercayaan sempurna itu tidak ada.
    function score(address member) external view returns (uint32) {
        Record memory r = _records[member];
        uint256 numerator = 100 * uint256(r.onTime);
        uint256 denominator = uint256(r.onTime) + 2 * uint256(r.late) + 5 * uint256(r.defaulted) + 3;
        return uint32(numerator / denominator);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title MockIDRX
 * @notice Mock stablecoin Rupiah (IDRX) untuk demo di testnet. 2 desimal, 1 IDRX = Rp1.
 *         Punya `mint()` terbuka sebagai "faucet" demo — Treasury mint sesukanya untuk
 *         mensimulasikan fiat on-ramp. JANGAN pakai di mainnet.
 * @dev IDRX asli di EVM juga memakai 2 desimal. Rp200.000 => 200000 * 10^2 = 20_000_000.
 */
contract MockIDRX {
    string public constant name = "IDRX Mock";
    string public constant symbol = "IDRX";
    uint8 public constant decimals = 2;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @notice Faucet demo — cetak IDRX ke `to`.
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

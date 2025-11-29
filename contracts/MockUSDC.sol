// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Fake USDC", "fUSDC") {
        // Mint yourself 1,000,000 tokens immediately
        _mint(msg.sender, 1000000 * 10**18);
    }
    
    // Allow you to give friends free money for testing
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

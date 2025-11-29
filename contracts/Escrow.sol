// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// Minimal ERC20 Interface to interact with USDC
interface IERC20 {
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract GarageEscrow {
    address public owner;
    IERC20 public usdc;
    
    // Safety: Track fees separately to prevent draining user pots
    uint256 public accumulatedFees;

    // State Mapping
    struct Match {
        address player1;
        address player2;
        uint256 pot;
        bool isComplete;
    }
    mapping(uint256 => Match) public matches;

    // Events for the Frontend to listen to
    event Deposit(uint256 indexed matchId, address indexed player, uint256 amount);
    event Payout(uint256 indexed matchId, address indexed winner, uint256 amount);
    event EmergencyRefund(uint256 indexed matchId);
    event FeesWithdrawn(uint256 amount);

    constructor(address _usdc) {
        owner = msg.sender;
        usdc = IERC20(_usdc);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not Owner");
        _;
    }

    // 1. DEPOSIT: Players fund the match
    function deposit(uint256 _matchId, uint256 _amount) external {
        // Frontend must handle 'approve' first!
        require(usdc.transferFrom(msg.sender, address(this), _amount), "Transfer Failed");
        
        Match storage m = matches[_matchId];
        
        // Simple logic: First depositor is P1, second is P2
        if (m.player1 == address(0)) {
            m.player1 = msg.sender;
        } else if (m.player2 == address(0)) {
            m.player2 = msg.sender;
        }
        // Note: If a 3rd person deposits, they just add to the pot (spectator betting? future feature).
        
        m.pot += _amount;
        
        emit Deposit(_matchId, msg.sender, _amount);
    }

    // 2. PAYOUT: The Oracle (Owner) declares the winner
    function payout(uint256 _matchId, address _winner) external onlyOwner {
        Match storage m = matches[_matchId];
        require(!m.isComplete, "Match Complete");
        require(m.pot > 0, "Pot Empty");
        require(_winner == m.player1 || _winner == m.player2, "Invalid Winner");

        m.isComplete = true;

        // Business Logic: 10% Rake
        uint256 rake = (m.pot * 10) / 100;
        uint256 prize = m.pot - rake;
        
        // Accumulate fees safely
        accumulatedFees += rake;

        // Push Payout
        require(usdc.transfer(_winner, prize), "Payout Failed");
        
        emit Payout(_matchId, _winner, prize);
    }

    // 3. EMERGENCY: Admin Manual Override
    function emergencyWithdraw(uint256 _matchId) external onlyOwner {
        Match storage m = matches[_matchId];
        require(!m.isComplete, "Match Complete");
        
        uint256 split = m.pot / 2;
        m.isComplete = true;
        
        // Refund both players (if they exist)
        if (m.player1 != address(0)) usdc.transfer(m.player1, split);
        if (m.player2 != address(0)) usdc.transfer(m.player2, split);
        
        emit EmergencyRefund(_matchId);
    }
    
    // 4. WITHDRAW RAKE: Admin collects fees SAFELY
    function withdrawRake() external onlyOwner {
        require(accumulatedFees > 0, "No fees to withdraw");
        
        uint256 amount = accumulatedFees;
        accumulatedFees = 0; // Reset before transfer to prevent reentrancy (though unlikely with transfer)
        
        require(usdc.transfer(owner, amount), "Transfer Failed");
        
        emit FeesWithdrawn(amount);
    }
}

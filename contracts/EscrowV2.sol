// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract EscrowV2 is Ownable {
    IERC20 public usdc;

    // --- ROLES ---
    address public treasury;     // Receives fees (Cold Wallet)
    address public bot;          // Automated server (Hot Wallet)

    // --- CONFIG ---
    // Using Basis Points (100 = 1%). Default 10% = 1000.
    uint256 public rakeBps = 1000; 
    uint256 public constant MAX_RAKE_BPS = 2000; // Cap at 20%

    // --- STATE ---
    struct Match {
        address player1;
        address player2;
        uint256 pot;
        bool isComplete;
        bool isActive;
    }
    // bytes32 supports UUID hashing from database
    mapping(bytes32 => Match) public matches;

    // --- EVENTS ---
    event Deposit(bytes32 indexed matchId, address indexed player, uint256 amount);
    event Payout(bytes32 indexed matchId, address indexed winner, uint256 prize, uint256 fee);
    event Refund(bytes32 indexed matchId, address indexed player, uint256 amount);
    event TreasuryUpdated(address newTreasury);
    event BotUpdated(address newBot);
    event RakeUpdated(uint256 newRakeBps);
    
    constructor(
        address _usdc, 
        address _treasury, 
        address _bot
    ) Ownable(msg.sender) {
        usdc = IERC20(_usdc);
        treasury = _treasury;
        bot = _bot;
    }

    modifier onlyBot() {
        require(msg.sender == bot || msg.sender == owner(), "Not authorized");
        _;
    }

    // --- ADMIN ---
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "Invalid Address");
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    function setBot(address _bot) external onlyOwner {
        bot = _bot;
        emit BotUpdated(_bot);
    }

    function setRake(uint256 _bps) external onlyOwner {
        require(_bps <= MAX_RAKE_BPS, "Rake too high");
        rakeBps = _bps;
        emit RakeUpdated(_bps);
    }

    // --- CORE LOGIC ---

    function deposit(bytes32 matchId, uint256 amount) external {
        require(amount > 0, "Zero amount");
        require(usdc.transferFrom(msg.sender, address(this), amount), "Transfer failed");

        Match storage m = matches[matchId];
        
        // Auto-assign player slots
        if (m.player1 == address(0)) {
            m.player1 = msg.sender;
        } else if (m.player2 == address(0)) {
            m.player2 = msg.sender;
        }

        m.pot += amount;
        m.isActive = true;

        emit Deposit(matchId, msg.sender, amount);
    }

    function distributeWinnings(bytes32 matchId, address winner) external onlyBot {
        Match storage m = matches[matchId];
        require(m.isActive, "Match not active");
        require(m.pot > 0, "Pot empty");
        require(!m.isComplete, "Already paid");

        // Calculate Fees (Basis Points)
        uint256 fee = (m.pot * rakeBps) / 10000;
        uint256 prize = m.pot - fee;

        m.isComplete = true;
        m.isActive = false;
        
        // 1. Pay Winner
        require(usdc.transfer(winner, prize), "Prize transfer failed");
        
        // 2. Pay Treasury Directly (no accumulation = less attack surface)
        if (fee > 0) {
            require(usdc.transfer(treasury, fee), "Fee transfer failed");
        }

        emit Payout(matchId, winner, prize, fee);
    }

    function refundMatch(bytes32 matchId, address player) external onlyBot {
        Match storage m = matches[matchId];
        require(m.isActive, "Match not active");
        require(!m.isComplete, "Already complete");
        
        uint256 amount = m.pot;
        m.pot = 0;
        m.isActive = false;
        m.isComplete = true;

        require(usdc.transfer(player, amount), "Refund failed");

        emit Refund(matchId, player, amount);
    }

    // --- VIEW FUNCTIONS ---
    function getMatch(bytes32 matchId) external view returns (
        address player1,
        address player2,
        uint256 pot,
        bool isComplete,
        bool isActive
    ) {
        Match storage m = matches[matchId];
        return (m.player1, m.player2, m.pot, m.isComplete, m.isActive);
    }
}

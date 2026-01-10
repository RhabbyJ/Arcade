// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title EscrowV3
 * @notice Atomic 1v1 match escrow with per-player deposit tracking
 * @dev Features:
 * - createMatch() for gated deposits (only expected players can deposit)
 * - Per-player deposit tracking for correct refunds
 * - Winner tracking for on-chain reconciliation
 * - pot=0 on payout for unambiguous chain state
 */
contract EscrowV3 is Ownable {
    IERC20 public usdc;

    // --- ROLES ---
    address public treasury;     // Receives fees (Cold Wallet)
    address public bot;          // Automated server (Hot Wallet)

    // --- CONFIG ---
    uint256 public rakeBps = 1000; 
    uint256 public constant MAX_RAKE_BPS = 2000;

    // --- STATE ---
    struct Match {
        address player1;
        address player2;
        uint256 pot;
        bool isComplete;
        bool isActive;
        address winner;
    }

    mapping(bytes32 => Match) public matches;

    // Per-player deposit tracking (enables correct refunds)
    mapping(bytes32 => mapping(address => uint256)) public deposited;

    // Expected players for gated deposits
    mapping(bytes32 => address) public expectedPlayer1;
    mapping(bytes32 => address) public expectedPlayer2;

    // --- EVENTS ---
    event MatchCreated(bytes32 indexed matchId, address player1, address player2);
    event Deposit(bytes32 indexed matchId, address indexed player, uint256 amount);
    event Payout(bytes32 indexed matchId, address indexed winner, uint256 prize, uint256 fee);
    event Refund(bytes32 indexed matchId, address indexed player, uint256 amount);
    event TreasuryUpdated(address newTreasury);
    event BotUpdated(address newBot);
    event RakeUpdated(uint256 newRakeBps);

    constructor(address _usdc, address _treasury, address _bot) Ownable(msg.sender) {
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
        require(_bot != address(0), "Invalid Address");
        bot = _bot;
        emit BotUpdated(_bot);
    }

    function setRake(uint256 _bps) external onlyOwner {
        require(_bps <= MAX_RAKE_BPS, "Rake too high");
        rakeBps = _bps;
        emit RakeUpdated(_bps);
    }

    // --- MATCH CREATION (Gated Deposits) ---
    function createMatch(bytes32 matchId, address p1, address p2) external onlyBot {
        require(expectedPlayer1[matchId] == address(0), "Match already created");
        require(p1 != address(0) && p2 != address(0), "Invalid players");
        require(p1 != p2, "Players must be different");
        
        expectedPlayer1[matchId] = p1;
        expectedPlayer2[matchId] = p2;
        
        emit MatchCreated(matchId, p1, p2);
    }

    // --- CORE LOGIC ---
    function deposit(bytes32 matchId, uint256 amount) external {
        require(amount > 0, "Zero amount");
        require(usdc.transferFrom(msg.sender, address(this), amount), "Transfer failed");

        Match storage m = matches[matchId];
        require(!m.isComplete, "Match complete");

        // If match was created with expected players, enforce gating
        if (expectedPlayer1[matchId] != address(0)) {
            require(
                msg.sender == expectedPlayer1[matchId] || msg.sender == expectedPlayer2[matchId],
                "Not an expected player"
            );
        }

        // Auto-assign player slots
        if (m.player1 == address(0)) {
            m.player1 = msg.sender;
        } else if (m.player2 == address(0)) {
            require(msg.sender != m.player1, "Already joined");
            m.player2 = msg.sender;
        } else {
            require(msg.sender == m.player1 || msg.sender == m.player2, "Not a match player");
        }

        deposited[matchId][msg.sender] += amount;
        m.pot += amount;
        m.isActive = true;

        emit Deposit(matchId, msg.sender, amount);
    }

    function distributeWinnings(bytes32 matchId, address winner) external onlyBot {
        Match storage m = matches[matchId];
        require(m.isActive, "Match not active");
        require(m.pot > 0, "Pot empty");
        require(!m.isComplete, "Already paid");
        require(winner == m.player1 || winner == m.player2, "Winner not in match");

        uint256 totalPot = m.pot;
        uint256 fee = (totalPot * rakeBps) / 10000;
        uint256 prize = totalPot - fee;

        // Make on-chain state unambiguous
        m.pot = 0;
        m.isComplete = true;
        m.isActive = false;
        m.winner = winner;

        // Clear individual deposit records
        deposited[matchId][m.player1] = 0;
        deposited[matchId][m.player2] = 0;

        require(usdc.transfer(winner, prize), "Prize transfer failed");
        if (fee > 0) require(usdc.transfer(treasury, fee), "Fee transfer failed");

        emit Payout(matchId, winner, prize, fee);
    }

    function refundMatch(bytes32 matchId, address player) external onlyBot {
        Match storage m = matches[matchId];
        require(m.isActive, "Match not active");
        require(!m.isComplete, "Already complete");
        require(player == m.player1 || player == m.player2, "Not a match player");

        uint256 amount = deposited[matchId][player];
        require(amount > 0, "Nothing to refund");

        deposited[matchId][player] = 0;
        m.pot -= amount;

        // Only complete when pot fully drained
        if (m.pot == 0) {
            m.isActive = false;
            m.isComplete = true;
        }

        require(usdc.transfer(player, amount), "Refund failed");
        emit Refund(matchId, player, amount);
    }

    // --- VIEW FUNCTIONS ---
    function getMatch(bytes32 matchId) external view returns (
        address player1,
        address player2,
        uint256 pot,
        bool isComplete,
        bool isActive,
        address winner
    ) {
        Match storage m = matches[matchId];
        return (m.player1, m.player2, m.pot, m.isComplete, m.isActive, m.winner);
    }

    function getDeposited(bytes32 matchId, address player) external view returns (uint256) {
        return deposited[matchId][player];
    }
}

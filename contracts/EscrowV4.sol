// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title EscrowV4
 * @notice 1v1 match escrow with gated deposits + idempotent finalize + pull-withdraw payouts.
 * @dev Replaces EscrowV3 to eliminate race conditions and partial refund failures.
 */
contract EscrowV4 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    // --- ROLES ---
    address public treasury; // fee receiver (cold wallet)
    address public bot;      // automation (hot wallet)

    // --- CONFIG ---
    uint256 public rakeBps = 1000; // 10%
    uint256 public constant MAX_RAKE_BPS = 2000;

    enum Status {
        NONE,
        CREATED,
        CANCELLED,
        SETTLED
    }

    struct Match {
        address p1;
        address p2;
        uint256 stake;      // per-player stake
        bool p1Deposited;
        bool p2Deposited;
        Status status;
        address winner;     // set if SETTLED
    }

    mapping(bytes32 => Match) public matches;

    // Pull-payment balances
    mapping(address => uint256) public claimable;

    // --- EVENTS ---
    event MatchCreated(bytes32 indexed matchId, address indexed p1, address indexed p2, uint256 stake);
    event Deposited(bytes32 indexed matchId, address indexed player, uint256 amount);
    event Cancelled(bytes32 indexed matchId, string reason);
    event Settled(bytes32 indexed matchId, address indexed winner, uint256 winnerPayout, uint256 fee);
    event ClaimableIncreased(address indexed player, uint256 amount, bytes32 indexed matchId);
    event Withdrawn(address indexed player, uint256 amount);
    event FinalizationNoOp(bytes32 indexed matchId, string reason); // Debug event

    event TreasuryUpdated(address newTreasury);
    event BotUpdated(address newBot);
    event RakeUpdated(uint256 newRakeBps);

    constructor(address _usdc, address _treasury, address _bot) Ownable(msg.sender) {
        require(_usdc != address(0) && _treasury != address(0) && _bot != address(0), "Bad init");
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
        require(_treasury != address(0), "Invalid address");
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    function setBot(address _bot) external onlyOwner {
        require(_bot != address(0), "Invalid address");
        bot = _bot;
        emit BotUpdated(_bot);
    }

    function setRake(uint256 _bps) external onlyOwner {
        require(_bps <= MAX_RAKE_BPS, "Rake too high");
        rakeBps = _bps;
        emit RakeUpdated(_bps);
    }

    // --- MATCH LIFECYCLE ---

    /**
     * @notice Create a match with explicit players and fixed stake.
     * @dev Only bot/owner can create. Deposits are gated to p1/p2 and must equal stake.
     */
    function createMatch(bytes32 matchId, address p1, address p2, uint256 stake) external onlyBot {
        require(matches[matchId].status == Status.NONE, "Match exists");
        require(p1 != address(0) && p2 != address(0) && p1 != p2, "Bad players");
        require(stake > 0, "Bad stake");

        matches[matchId] = Match({
            p1: p1,
            p2: p2,
            stake: stake,
            p1Deposited: false,
            p2Deposited: false,
            status: Status.CREATED,
            winner: address(0)
        });

        emit MatchCreated(matchId, p1, p2, stake);
    }

    /**
     * @notice Deposit stake for a created match. Must be called by p1 or p2.
     * @dev Deposits are pull-from-user (requires approve).
     */
    function deposit(bytes32 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == Status.CREATED, "Not depositable");
        require(msg.sender == m.p1 || msg.sender == m.p2, "Not a player");

        // One deposit per player
        if (msg.sender == m.p1) require(!m.p1Deposited, "P1 already deposited");
        if (msg.sender == m.p2) require(!m.p2Deposited, "P2 already deposited");

        uint256 amount = m.stake;
        // Use SafeERC20
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        if (msg.sender == m.p1) m.p1Deposited = true;
        else m.p2Deposited = true;

        emit Deposited(matchId, msg.sender, amount);
    }

    /**
     * @notice Cancel the match and mark deposited players as claimable.
     * @dev Idempotent: calling cancel multiple times is safe (no-op after first finalize).
     */
    function cancelMatch(bytes32 matchId, string calldata reason) external onlyBot {
        Match storage m = matches[matchId];
        // Idempotency check
        if (m.status != Status.CREATED) {
            emit FinalizationNoOp(matchId, "Already Finalized");
            return;
        }

        m.status = Status.CANCELLED;

        if (m.p1Deposited) {
            claimable[m.p1] += m.stake;
            emit ClaimableIncreased(m.p1, m.stake, matchId);
        }
        if (m.p2Deposited) {
            claimable[m.p2] += m.stake;
            emit ClaimableIncreased(m.p2, m.stake, matchId);
        }

        emit Cancelled(matchId, reason);
    }

    /**
     * @notice Settle the match. If only one deposited, fall back to cancel behavior.
     * @dev Idempotent.
     */
    function settleMatch(bytes32 matchId, address winner) external onlyBot {
        Match storage m = matches[matchId];
        if (m.status != Status.CREATED) {
            emit FinalizationNoOp(matchId, "Already Finalized");
            return;
        }

        require(winner == m.p1 || winner == m.p2, "Winner not in match");

        bool both = m.p1Deposited && m.p2Deposited;

        if (!both) {
            // Fallback: Treat as cancel if not fully funded
            m.status = Status.CANCELLED;
            if (m.p1Deposited) {
                claimable[m.p1] += m.stake;
                emit ClaimableIncreased(m.p1, m.stake, matchId);
            }
            if (m.p2Deposited) {
                claimable[m.p2] += m.stake;
                emit ClaimableIncreased(m.p2, m.stake, matchId);
            }
            emit Cancelled(matchId, "SETTLE_FALLBACK_NOT_BOTH_DEPOSITED");
            return;
        }

        // Normal Settlement
        uint256 total = m.stake * 2;
        uint256 fee = (total * rakeBps) / 10000;
        uint256 payout = total - fee;

        m.status = Status.SETTLED;
        m.winner = winner;

        claimable[winner] += payout;
        emit ClaimableIncreased(winner, payout, matchId);

        if (fee > 0) {
            claimable[treasury] += fee;
            emit ClaimableIncreased(treasury, fee, matchId);
        }

        emit Settled(matchId, winner, payout, fee);
    }

    /**
     * @notice Withdraw accumulated claimable USDC.
     */
    function withdraw() external nonReentrant {
        uint256 amt = claimable[msg.sender];
        require(amt > 0, "Nothing to withdraw");
        claimable[msg.sender] = 0;

        usdc.safeTransfer(msg.sender, amt);
        emit Withdrawn(msg.sender, amt);
    }

    /**
     * @notice Bot helper to push funds to players (maintains "Instant Payout" UX).
     * @dev Restricted to onlyBot to prevent griefing.
     */
    function withdrawFor(address player) external onlyBot nonReentrant {
        uint256 amount = claimable[player];
        if (amount == 0) return;
        
        claimable[player] = 0;
        usdc.safeTransfer(player, amount);
        emit Withdrawn(player, amount);
    }

    // --- VIEW HELPERS ---
    function getMatch(bytes32 matchId) external view returns (
        address p1,
        address p2,
        uint256 stake,
        bool p1Deposited,
        bool p2Deposited,
        Status status,
        address winner
    ) {
        Match storage m = matches[matchId];
        return (m.p1, m.p2, m.stake, m.p1Deposited, m.p2Deposited, m.status, m.winner);
    }
    
    function getDeposited(bytes32 matchId, address player) external view returns (uint256) {
        Match storage m = matches[matchId];
        if (player == m.p1 && m.p1Deposited) return m.stake;
        if (player == m.p2 && m.p2Deposited) return m.stake;
        return 0;
    }
}

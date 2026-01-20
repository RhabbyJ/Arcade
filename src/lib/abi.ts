export const USDC_ABI = [
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function allowance(address owner, address spender) external view returns (uint256)",
    "function balanceOf(address account) external view returns (uint256)"
];

export const ESCROW_ABI = [
    // Core Functions (bytes32 for UUID support)
    "function createMatch(bytes32 matchId, address p1, address p2, uint256 stake) external",
    "function deposit(bytes32 matchId) external",
    "function cancelMatch(bytes32 matchId, string reason) external",
    "function settleMatch(bytes32 matchId, address winner) external",
    "function withdraw() external",
    "function withdrawFor(address player) external",

    // Admin Functions
    "function setTreasury(address _treasury) external",
    "function setBot(address _bot) external",
    "function setRake(uint256 _bps) external",

    // View Functions
    "function getMatch(bytes32 matchId) external view returns (address p1, address p2, uint256 stake, bool p1Deposited, bool p2Deposited, uint8 status, address winner)",
    "function getDeposited(bytes32 matchId, address player) external view returns (uint256)",
    "function claimable(address player) external view returns (uint256)",
    "function treasury() external view returns (address)",
    "function bot() external view returns (address)",
    "function rakeBps() external view returns (uint256)",
    "function MAX_RAKE_BPS() external view returns (uint256)",

    // Events
    "event MatchCreated(bytes32 indexed matchId, address indexed p1, address indexed p2, uint256 stake)",
    "event Deposited(bytes32 indexed matchId, address indexed player, uint256 amount)",
    "event MatchSettled(bytes32 indexed matchId, address winner, uint256 prize, uint256 fee)",
    "event MatchCancelled(bytes32 indexed matchId, string reason)",
    "event ClaimableIncreased(address indexed player, uint256 amount, bytes32 indexed matchId)",
    "event Withdrawn(address indexed player, uint256 amount)"
];

// Helper: Convert UUID string to bytes32 for contract calls
export function uuidToBytes32(uuid: string): string {
    // Remove dashes and prefix with 0x, pad to 32 bytes
    const hex = uuid.replace(/-/g, '');
    return '0x' + hex.padEnd(64, '0');
}

// Helper: Convert numeric ID (Date.now()) to bytes32
export function numericToBytes32(num: number | string): string {
    const hex = BigInt(num).toString(16);
    return '0x' + hex.padStart(64, '0');
}

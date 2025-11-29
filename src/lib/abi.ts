export const USDC_ABI = [
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function allowance(address owner, address spender) external view returns (uint256)",
    "function balanceOf(address account) external view returns (uint256)"
];

export const ESCROW_ABI = [
    "function deposit(uint256 _matchId, uint256 _amount) external",
    "function payout(uint256 _matchId, address _winner) external",
    "function emergencyWithdraw(uint256 _matchId) external",
    "event Deposit(uint256 indexed matchId, address indexed player, uint256 amount)"
];

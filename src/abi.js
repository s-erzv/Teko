// ABI minimal — hanya fungsi/event yang dipakai backend.
export const TEKO_ABI = [
  "function createGroup(uint8 size, uint96 contribution) returns (uint256 groupId)",
  "function deposit(uint256 groupId, address member)",
  "function drawRound(uint256 groupId) returns (address winner)",
  "function groupCount() view returns (uint256)",
  "function potOf(uint256 groupId) view returns (uint256)",
  "function isFinished(uint256 groupId) view returns (bool)",
  "function roster(uint256 groupId) view returns (address[])",
  "function groups(uint256) view returns (uint96 contribution, uint8 size, uint8 round, uint8 paidThisRound, uint8 winnersCount, bool rosterLocked)",
  "event GroupCreated(uint256 indexed groupId, uint8 size, uint96 contribution)",
  "event Deposited(uint256 indexed groupId, uint256 indexed round, address indexed member, uint8 paidThisRound)",
  "event RoundDrawn(uint256 indexed groupId, uint256 indexed round, address indexed winner, uint256 prize, uint256 fee)",
  "event GroupCompleted(uint256 indexed groupId)",
];

export const IDRX_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

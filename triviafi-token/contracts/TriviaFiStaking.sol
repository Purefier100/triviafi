// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// @title TriviaFiStaking
/// @notice Lock $TRIVIA to unlock in-game perks (fee discounts, streak
///         multipliers, whitelist priority). This is deliberately NOT a
///         yield/rewards contract — there is no token emission here, no
///         "stake to earn %". Perks are read by the backend from
///         `stakedBalance` and `tierOf`, off-chain, at request time.
///         Keeping rewards off this contract avoids most of the regulatory
///         and mercenary-capital problems that come with liquidity mining.
///
/// Security notes:
/// - Ownable2Step: ownership transfer requires the new owner to explicitly
///   accept, preventing an accidental transfer to an unreachable/wrong address.
/// - Pausable: owner can pause *new* stakes if a bug is found post-deploy.
///   Unstaking is deliberately NEVER pausable — users must always be able
///   to withdraw their own funds. A pause that blocks withdrawals is a
///   classic pattern used to justify "the contract can rug you"; this
///   contract can't, even paused.
contract TriviaFiStaking is ReentrancyGuard, Ownable2Step, Pausable {
    using SafeERC20 for IERC20;

    IERC20 public immutable triviaToken;

    struct Stake {
        uint256 amount;
        uint256 stakedAt;
        uint256 unlockAt; // 0 = no lock chosen / flexible tier
    }

    mapping(address => Stake) public stakes;

    /// @notice Tier thresholds, in token wei (18 decimals). Configurable by owner
    /// so you can tune these post-launch without redeploying.
    uint256 public bronzeThreshold;
    uint256 public silverThreshold;
    uint256 public goldThreshold;

    /// @notice Optional lock bonus: staking with a chosen lock duration bumps
    /// your effective tier by one level, encouraging longer holds without
    /// paying emissions for it.
    uint256 public constant LOCK_BONUS_DURATION = 30 days;

    event Staked(address indexed user, uint256 amount, uint256 unlockAt);
    event Unstaked(address indexed user, uint256 amount);
    event ThresholdsUpdated(uint256 bronze, uint256 silver, uint256 gold);

    enum Tier {
        None,
        Bronze,
        Silver,
        Gold
    }

    constructor(
        address _triviaToken,
        uint256 _bronzeThreshold,
        uint256 _silverThreshold,
        uint256 _goldThreshold,
        address initialOwner
    ) Ownable(initialOwner) Pausable() {
        require(_triviaToken != address(0), "token cannot be zero address");
        require(
            _bronzeThreshold < _silverThreshold && _silverThreshold < _goldThreshold,
            "thresholds must be strictly increasing"
        );
        triviaToken = IERC20(_triviaToken);
        bronzeThreshold = _bronzeThreshold;
        silverThreshold = _silverThreshold;
        goldThreshold = _goldThreshold;
    }

    /// @notice Stake tokens with no lock — withdrawable any time.
    /// Blocked while paused (e.g. if a bug is found) — existing stakes are unaffected.
    function stake(uint256 amount) external nonReentrant whenNotPaused {
        _stake(amount, 0);
    }

    /// @notice Stake tokens locked for LOCK_BONUS_DURATION — bumps effective tier by one
    /// level while locked (see `tierOf`). Cannot unstake before unlockAt.
    /// Blocked while paused (e.g. if a bug is found) — existing stakes are unaffected.
    function stakeWithLock(uint256 amount) external nonReentrant whenNotPaused {
        _stake(amount, block.timestamp + LOCK_BONUS_DURATION);
    }

    function _stake(uint256 amount, uint256 unlockAt) internal {
        require(amount > 0, "amount must be > 0");
        Stake storage s = stakes[msg.sender];

        // Adding to an existing stake keeps the longer/later unlock time.
        uint256 newUnlockAt = unlockAt > s.unlockAt ? unlockAt : s.unlockAt;

        s.amount += amount;
        s.stakedAt = block.timestamp;
        s.unlockAt = newUnlockAt;

        triviaToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount, newUnlockAt);
    }

    /// @notice Withdraw staked tokens. Reverts if still within the lock period.
    function unstake(uint256 amount) external nonReentrant {
        Stake storage s = stakes[msg.sender];
        require(amount > 0 && amount <= s.amount, "invalid amount");
        require(block.timestamp >= s.unlockAt, "TriviaFiStaking: still locked");

        s.amount -= amount;
        if (s.amount == 0) {
            s.stakedAt = 0;
            s.unlockAt = 0;
        }

        triviaToken.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    /// @notice Raw staked balance for a user — call this from the backend
    /// before applying fee discounts, etc.
    function stakedBalance(address user) external view returns (uint256) {
        return stakes[user].amount;
    }

    /// @notice Effective tier for a user, factoring in the lock bonus.
    /// A locked stake counts as if it were one tier higher than its raw
    /// amount would otherwise qualify for (capped at Gold).
    function tierOf(address user) public view returns (Tier) {
        Stake memory s = stakes[user];
        if (s.amount == 0) return Tier.None;

        Tier baseTier;
        if (s.amount >= goldThreshold) baseTier = Tier.Gold;
        else if (s.amount >= silverThreshold) baseTier = Tier.Silver;
        else if (s.amount >= bronzeThreshold) baseTier = Tier.Bronze;
        else baseTier = Tier.None;

        bool isLocked = s.unlockAt > block.timestamp;
        if (isLocked && baseTier != Tier.Gold && baseTier != Tier.None) {
            return Tier(uint256(baseTier) + 1);
        } else if (isLocked && baseTier == Tier.None && s.amount > 0) {
            // Any locked stake, even below bronze, gets Bronze status.
            return Tier.Bronze;
        }
        return baseTier;
    }

    /// @notice Convenience view returning everything the backend needs in one call.
    function getStakeInfo(address user)
        external
        view
        returns (uint256 amount, uint256 unlockAt, bool isLocked, Tier tier)
    {
        Stake memory s = stakes[user];
        return (s.amount, s.unlockAt, s.unlockAt > block.timestamp, tierOf(user));
    }

    /// @notice Owner can retune tier thresholds post-launch (e.g. if token price moves a lot).
    function setThresholds(
        uint256 _bronze,
        uint256 _silver,
        uint256 _gold
    ) external onlyOwner {
        require(_bronze < _silver && _silver < _gold, "thresholds must be strictly increasing");
        bronzeThreshold = _bronze;
        silverThreshold = _silver;
        goldThreshold = _gold;
        emit ThresholdsUpdated(_bronze, _silver, _gold);
    }

    /// @notice Emergency stop for NEW stakes only. Does not and cannot block
    /// unstaking — see contract-level notes above.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume accepting new stakes after a pause.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recover ERC-20 tokens sent to this contract BY MISTAKE.
    /// Explicitly cannot touch the staking token itself — that would let
    /// the owner drain user stakes, which defeats the whole point of a
    /// non-custodial staking design. Use this only for e.g. someone
    /// accidentally sending USDC directly to this contract's address.
    function recoverForeignToken(address tokenAddress, uint256 amount) external onlyOwner {
        require(tokenAddress != address(triviaToken), "cannot recover the staking token");
        IERC20(tokenAddress).safeTransfer(owner(), amount);
    }
}

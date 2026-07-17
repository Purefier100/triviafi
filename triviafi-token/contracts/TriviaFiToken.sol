// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";

/// @title TriviaFiToken ($TRIVIA)
/// @notice Standard ERC-20 with a hard supply cap and role-gated minting.
///         Minting is deliberately NOT controlled by the game server's
///         verifier/treasury wallet (the one that signs scores and moves
///         prize funds) — keep this key set completely separate. If that
///         hot wallet is ever compromised, you do not want the attacker
///         also able to mint tokens.
contract TriviaFiToken is ERC20, ERC20Burnable, ERC20Permit, AccessControlEnumerable {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Hard cap — mint calls will revert past this, no matter who holds MINTER_ROLE.
    uint256 public immutable cap;

    event CapSet(uint256 cap);

    /// @param name_ Token name, e.g. "TriviaFi"
    /// @param symbol_ Token symbol, e.g. "TRIVIA"
    /// @param cap_ Max total supply, in wei (18 decimals) — e.g. 100_000_000e18 for 100M tokens
    /// @param admin Multisig or DAO address that controls roles. NOT the game server key.
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 cap_,
        address admin
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        require(admin != address(0), "admin cannot be zero address");
        require(cap_ > 0, "cap must be > 0");
        cap = cap_;
        emit CapSet(cap_);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        // Admin can grant MINTER_ROLE to a separate distribution/staking contract later.
        // Deliberately NOT granting MINTER_ROLE to anyone in the constructor —
        // do that explicitly after deployment so it's a visible, auditable transaction.
    }

    /// @notice Mint new tokens up to the cap. Restricted to addresses holding MINTER_ROLE.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        require(to != address(0), "cannot mint to zero address");
        require(totalSupply() + amount <= cap, "TriviaFiToken: cap exceeded");
        _mint(to, amount);
    }

    /// @notice Overridden to prevent the LAST DEFAULT_ADMIN_ROLE holder from
    /// renouncing/revoking themselves, which would permanently brick all
    /// future role management (no one could grant MINTER_ROLE again, ever).
    /// If you genuinely want to burn admin control, transfer it to a known
    /// burn address explicitly rather than calling renounce.
    function revokeRole(bytes32 role, address account)
        public
        override(AccessControl, IAccessControl)
        onlyRole(getRoleAdmin(role))
    {
        if (role == DEFAULT_ADMIN_ROLE) {
            require(getRoleMemberCount(role) > 1, "cannot remove the last admin");
        }
        super.revokeRole(role, account);
    }
}

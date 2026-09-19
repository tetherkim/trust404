// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract CreditState {
    error Unauthorized();
    error InvalidAddress();

    address public immutable owner;
    mapping(address => uint256) public collateralOf;
    mapping(address => uint256) public debtOf;

    event AccountStateUpdated(address indexed user, uint256 collateral, uint256 debt);

    constructor(address owner_) {
        if (owner_ == address(0)) revert InvalidAddress();
        owner = owner_;
    }

    /// @notice Sets collateral and debt for a specific user account.
    /// @dev Adheres strictly to CEI: checks, then state effects, then event emission.
    function setAccountState(address user, uint256 collateral, uint256 debt) external {
        // Checks
        if (msg.sender != owner) revert Unauthorized();
        if (user == address(0)) revert InvalidAddress();

        // Effects
        collateralOf[user] = collateral;
        debtOf[user] = debt;

        // Interactions / Events
        emit AccountStateUpdated(user, collateral, debt);
    }
}

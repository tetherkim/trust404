// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CreditState} from "../CreditState.sol";

interface Vm {
    function prank(address) external;
    function expectRevert(bytes4) external;
}

contract CreditStateTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    CreditState creditState;
    address constant OWNER = address(0xABCD);
    address constant ALICE = address(0x1111);
    address constant BOB = address(0x2222);

    function setUp() public {
        creditState = new CreditState(OWNER);
    }

    function testInitialStateIsZero() public view {
        require(creditState.collateralOf(ALICE) == 0, "initial collateral not zero");
        require(creditState.debtOf(ALICE) == 0, "initial debt not zero");
    }

    function testOwnerCanSetAccountState() public {
        vm.prank(OWNER);
        creditState.setAccountState(ALICE, 100, 0);

        require(creditState.collateralOf(ALICE) == 100, "collateral mismatch");
        require(creditState.debtOf(ALICE) == 0, "debt mismatch");

        // Update state again
        vm.prank(OWNER);
        creditState.setAccountState(ALICE, 200, 50);
        require(creditState.collateralOf(ALICE) == 200, "updated collateral mismatch");
        require(creditState.debtOf(ALICE) == 50, "updated debt mismatch");
    }

    function testUnauthorizedReverts() public {
        vm.prank(BOB);
        vm.expectRevert(CreditState.Unauthorized.selector);
        creditState.setAccountState(ALICE, 100, 0);
    }

    function testZeroAddressReverts() public {
        vm.prank(OWNER);
        vm.expectRevert(CreditState.InvalidAddress.selector);
        creditState.setAccountState(address(0), 100, 0);

        vm.expectRevert(CreditState.InvalidAddress.selector);
        new CreditState(address(0));
    }
}

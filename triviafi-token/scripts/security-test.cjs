const hre = require("hardhat");

async function main() {
  const { ethers } = hre;
  const [admin, gameServerWallet, alice, attacker] = await ethers.getSigners();

  const results = [];
  const check = (name, cond) => {
    results.push({ name, pass: !!cond });
    console.log((cond ? "✅ PASS" : "❌ FAIL") + " — " + name);
  };
  const checkReverts = async (name, fn, expectedSubstr) => {
    try {
      await fn();
      results.push({ name, pass: false });
      console.log("❌ FAIL — " + name + " (did not revert)");
    } catch (e) {
      const msg = e.reason || e.shortMessage || e.message || "";
      const ok = !expectedSubstr || msg.includes(expectedSubstr);
      results.push({ name, pass: ok });
      console.log(
        (ok ? "✅ PASS" : "❌ FAIL") +
          " — " +
          name +
          " (reverted: " +
          msg.slice(0, 90) +
          ")",
      );
    }
  };

  console.log("\n=== DEPLOYMENT ===");

  const cap = ethers.parseUnits("100000000", 18);
  const Token = await ethers.getContractFactory("TriviaFiToken");
  const token = await Token.deploy("TriviaFi", "TRIVIA", cap, admin.address);
  await token.waitForDeployment();
  console.log("TriviaFiToken deployed at:", await token.getAddress());

  const bronze = ethers.parseUnits("100", 18);
  const silver = ethers.parseUnits("1000", 18);
  const gold = ethers.parseUnits("10000", 18);
  const Staking = await ethers.getContractFactory("TriviaFiStaking");
  const staking = await Staking.deploy(
    await token.getAddress(),
    bronze,
    silver,
    gold,
    admin.address,
  );
  await staking.waitForDeployment();
  console.log("TriviaFiStaking deployed at:", await staking.getAddress());

  console.log("\n=== SETUP: admin grants itself MINTER_ROLE (visible, auditable tx) ===");
  const MINTER_ROLE = await token.MINTER_ROLE();
  await (await token.grantRole(MINTER_ROLE, admin.address)).wait();
  check("Admin now holds MINTER_ROLE", await token.hasRole(MINTER_ROLE, admin.address));

  console.log("\n=== SECURITY TEST 1: minting is NOT the game server's job ===");
  await checkReverts("Game server wallet cannot mint (no MINTER_ROLE)", async () => {
    await token
      .connect(gameServerWallet)
      .mint(gameServerWallet.address, ethers.parseUnits("1000", 18));
  });

  console.log("\n=== SECURITY TEST 2: mint respects the hard cap ===");
  await checkReverts(
    "Minting past the cap reverts",
    async () => {
      await token.mint(admin.address, cap + 1n);
    },
    "cap exceeded",
  );

  console.log("\n=== SETUP: mint real supply for testing ===");
  const mintAmount = ethers.parseUnits("50000", 18);
  await (await token.mint(alice.address, mintAmount)).wait();
  const aliceBal = await token.balanceOf(alice.address);
  check("Alice received minted tokens", aliceBal === mintAmount);

  console.log("\n=== SECURITY TEST 3: cannot mint to zero address ===");
  await checkReverts(
    "Minting to the zero address reverts",
    async () => {
      await token.mint(ethers.ZeroAddress, ethers.parseUnits("1", 18));
    },
    "zero address",
  );

  console.log("\n=== SECURITY TEST 4: last admin cannot be revoked (anti-brick) ===");
  const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
  await checkReverts(
    "Revoking the only admin role holder reverts",
    async () => {
      await token.revokeRole(DEFAULT_ADMIN_ROLE, admin.address);
    },
    "cannot remove the last admin",
  );

  console.log("\n=== SECURITY TEST 5: staking requires approval first (no silent pulls) ===");
  const stakingAddr = await staking.getAddress();
  const tokenAsAlice = token.connect(alice);
  const stakingAsAlice = staking.connect(alice);
  await checkReverts("Staking without approve() reverts", async () => {
    await stakingAsAlice.stake(ethers.parseUnits("500", 18));
  });

  console.log("\n=== FUNCTIONAL: approve + stake works, tier calculated correctly ===");
  await (await tokenAsAlice.approve(stakingAddr, mintAmount)).wait();
  await (await stakingAsAlice.stake(ethers.parseUnits("500", 18))).wait();
  const info1 = await staking.getStakeInfo(alice.address);
  check("Alice's staked amount is 500", info1[0] === ethers.parseUnits("500", 18));
  check("Alice's tier is Bronze (1) for 500 tokens (bronze=100, silver=1000)", info1[3] === 1n);

  console.log("\n=== SECURITY TEST 6: locked stake blocks early withdrawal + lock bonus ===");
  await (await stakingAsAlice.stakeWithLock(ethers.parseUnits("100", 18))).wait();
  const infoLocked = await staking.getStakeInfo(alice.address);
  check(
    "Locked 600 total (still Bronze base) is bumped to Silver (2) by lock bonus",
    infoLocked[3] === 2n,
  );
  await checkReverts(
    "Unstaking ANY amount before unlockAt reverts, even previously-unlocked funds",
    async () => {
      await stakingAsAlice.unstake(ethers.parseUnits("1", 18));
    },
    "still locked",
  );

  console.log("\n=== SECURITY TEST 7: pause blocks new stakes but NEVER blocks unstake ===");
  await ethers.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine", []);

  await (await staking.pause()).wait();
  await checkReverts("New stake() reverts while paused", async () => {
    await stakingAsAlice.stake(ethers.parseUnits("1", 18));
  });
  await (await stakingAsAlice.unstake(ethers.parseUnits("100", 18))).wait();
  const info2 = await staking.getStakeInfo(alice.address);
  check(
    "Unstake succeeded WHILE PAUSED (funds never trapped)",
    info2[0] === ethers.parseUnits("500", 18),
  );
  await (await staking.unpause()).wait();

  console.log("\n=== SECURITY TEST 8: only owner can pause/set thresholds ===");
  const stakingAsAttacker = staking.connect(attacker);
  await checkReverts("Non-owner cannot pause()", async () => {
    await stakingAsAttacker.pause();
  });
  await checkReverts("Non-owner cannot setThresholds()", async () => {
    await stakingAsAttacker.setThresholds(1, 2, 3);
  });

  console.log("\n=== SECURITY TEST 9: recoverForeignToken cannot touch the staking token ===");
  await checkReverts(
    "Cannot recover the staking token itself (would drain user stakes)",
    async () => {
      await staking.recoverForeignToken(await token.getAddress(), ethers.parseUnits("1", 18));
    },
    "cannot recover the staking token",
  );

  console.log("\n=== SECURITY TEST 10: two-step ownership transfer on staking ===");
  await (await staking.transferOwnership(attacker.address)).wait();
  const ownerBeforeAccept = await staking.owner();
  check("Ownership does NOT change until new owner accepts", ownerBeforeAccept === admin.address);
  await (await staking.connect(attacker).acceptOwnership()).wait();
  const ownerAfterAccept = await staking.owner();
  check("Ownership transfers only after acceptOwnership()", ownerAfterAccept === attacker.address);

  console.log("\n=== SUMMARY ===");
  const passed = results.filter((r) => r.pass).length;
  console.log(`${passed}/${results.length} checks passed`);
  if (passed !== results.length) {
    console.log("FAILURES:");
    results.filter((r) => !r.pass).forEach((r) => console.log("  - " + r.name));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

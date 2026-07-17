const hre = require("hardhat");

async function main() {
  const { ethers } = hre;
  const [admin] = await ethers.getSigners();

  console.log("Network:", hre.network.name);
  console.log("Deploying with admin:", admin.address);

  const balance = await ethers.provider.getBalance(admin.address);
  console.log("Admin balance:", ethers.formatEther(balance));

  // ── Real numbers, decided 2024 ──────────────────────────────────────────
  // Total supply cap: 100,000,000 $TRIVIA — immutable once deployed.
  const cap = ethers.parseUnits("100000000", 18);

  // Tier thresholds — 100x gaps between tiers, each a small fraction of
  // total supply so there's real headroom for years of reward distribution.
  const bronze = ethers.parseUnits("1000", 18); // 0.001% of supply
  const silver = ethers.parseUnits("10000", 18); // 0.01% of supply
  const gold = ethers.parseUnits("100000", 18); // 0.1% of supply

  console.log("\n=== Deploying TriviaFiToken ===");
  console.log("Cap:", ethers.formatUnits(cap, 18), "TRIVIA");
  const Token = await ethers.getContractFactory("TriviaFiToken");
  const token = await Token.deploy("TriviaFi", "TRIVIA", cap, admin.address);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log("TriviaFiToken deployed at:", tokenAddress);

  console.log("\n=== Deploying TriviaFiStaking ===");
  console.log("Bronze:", ethers.formatUnits(bronze, 18));
  console.log("Silver:", ethers.formatUnits(silver, 18));
  console.log("Gold:  ", ethers.formatUnits(gold, 18));
  const Staking = await ethers.getContractFactory("TriviaFiStaking");
  const staking = await Staking.deploy(
    tokenAddress,
    bronze,
    silver,
    gold,
    admin.address,
  );
  await staking.waitForDeployment();
  const stakingAddress = await staking.getAddress();
  console.log("TriviaFiStaking deployed at:", stakingAddress);

  console.log("\n=== SAVE THESE ADDRESSES ===");
  console.log("TOKEN_ADDRESS  =", tokenAddress);
  console.log("STAKING_ADDRESS =", stakingAddress);

  console.log("\n=== NEXT STEPS (run as separate, visible transactions) ===");
  console.log("1. Grant MINTER_ROLE to whichever address will actually mint:");
  console.log(`   node scripts/grant-minter.cjs`);
  console.log("2. Mint your initial supply");
  console.log("3. Verify both contracts on the Arc Testnet block explorer");
  console.log(
    "4. Wire TOKEN_ADDRESS and STAKING_ADDRESS into backend/server.js",
  );
  console.log("   for the read-only tier-discount check");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

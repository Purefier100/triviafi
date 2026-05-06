require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("zkLTC balance:", ethers.formatEther(balance));

  if (balance === 0n) {
    console.error("❌ No zkLTC for gas! Get some from https://liteforge.hub.caldera.xyz");
    process.exit(1);
  }

  // zkLTC is native gas token — no separate token address needed for gas
  // But for game entry fees, we need a token contract
  // On LitVM testnet, zkLTC is NATIVE so we use address(0) or wrapped version
  // Check their docs for wrapped zkLTC ERC20 address
  const ZKLTC_ADDRESS = process.env.ZKLTC_TOKEN_ADDRESS || "0x0000000000000000000000000000000000000000";
  const VERIFIER = process.env.VERIFIER_ADDRESS;

  console.log("Verifier:", VERIFIER);
  console.log("zkLTC token:", ZKLTC_ADDRESS);

  const TriviaGame = await ethers.getContractFactory("contracts/ArcTriviaGameV2.sol:ArcTriviaGame");
  const game = await TriviaGame.deploy(VERIFIER, ZKLTC_ADDRESS);
  await game.waitForDeployment();

  const addr = await game.getAddress();
  console.log("✅ Contract deployed to:", addr);
  console.log("\nSave this to your .env as LITVM_CONTRACT_ADDRESS=", addr);
}

main().catch((e) => { console.error(e); process.exit(1); });

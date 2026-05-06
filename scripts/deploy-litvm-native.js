require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("zkLTC balance:", ethers.formatEther(balance));

  const VERIFIER = process.env.VERIFIER_ADDRESS;
  console.log("Verifier:", VERIFIER);

  const Game = await ethers.getContractFactory("LitVMTriviaGame");
  const game = await Game.deploy(VERIFIER);
  await game.waitForDeployment();

  const addr = await game.getAddress();
  console.log("✅ LitVMTriviaGame deployed to:", addr);
  console.log("Save as: LITVM_CONTRACT_ADDRESS=" + addr);
}

main().catch((e) => { console.error(e); process.exit(1); });

const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying from:", deployer.address);

  const ArcTriviaGame = await ethers.getContractFactory("ArcTriviaGame");

  const verifier = "0xAe699B48004F1507CbcB05EaCc0D7528c4F0d407";
  const usdc = "0x3600000000000000000000000000000000000000"; // ARC testnet USDC

  const game = await ArcTriviaGame.deploy(verifier, usdc);
  await game.waitForDeployment();

  const address = await game.getAddress();

  console.log("✅ Contract deployed to:", address);
  console.log("✅ Verifier:", verifier);
  console.log("✅ USDC:", usdc);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

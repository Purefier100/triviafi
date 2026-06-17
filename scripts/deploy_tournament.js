const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("Network:", network.name, "ChainId:", network.chainId.toString());
  console.log("Deploying with:", deployer.address);
  console.log(
    "Balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
  );

  const VERIFIER = process.env.VERIFIER_ADDRESS || deployer.address;
  console.log("Verifier:", VERIFIER);

  const Factory = await ethers.getContractFactory("TriviaFiTournament");
  const contract = await Factory.deploy(VERIFIER);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("\n✅ TriviaFiTournament deployed to:", address);
  console.log("Add to .env:");

  if (network.chainId === 5042002n) {
    console.log(`TOURNAMENT_CONTRACT_ARC=${address}`);
  } else if (network.chainId === 4441n) {
    console.log(`TOURNAMENT_CONTRACT_LITVM=${address}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

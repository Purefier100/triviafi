// Run this AFTER deploy.cjs, once you have TOKEN_ADDRESS.
// Usage: TOKEN_ADDRESS=0x... npx hardhat run scripts/grant-minter.cjs --network arcTestnet

const hre = require("hardhat");

async function main() {
  const { ethers } = hre;
  const [admin] = await ethers.getSigners();

  const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS;
  if (!TOKEN_ADDRESS) {
    console.error("Set TOKEN_ADDRESS env var first, e.g.:");
    console.error(
      "  TOKEN_ADDRESS=0x... npx hardhat run scripts/grant-minter.cjs --network arcTestnet",
    );
    process.exitCode = 1;
    return;
  }

  const token = await ethers.getContractAt("TriviaFiToken", TOKEN_ADDRESS);

  console.log("Granting MINTER_ROLE to admin:", admin.address);
  const MINTER_ROLE = await token.MINTER_ROLE();
  const grantTx = await token.grantRole(MINTER_ROLE, admin.address);
  await grantTx.wait();
  console.log("✅ MINTER_ROLE granted. TX:", grantTx.hash);

  // Adjust this initial mint amount to whatever makes sense for your
  // launch — this is just an example, not a recommendation.
  const initialMint = ethers.parseUnits("1000000", 18); // 1% of 100M cap
  console.log(
    `\nMinting ${ethers.formatUnits(initialMint, 18)} TRIVIA to admin...`,
  );
  const mintTx = await token.mint(admin.address, initialMint);
  await mintTx.wait();
  console.log("✅ Minted. TX:", mintTx.hash);

  const totalSupply = await token.totalSupply();
  console.log(
    "\nTotal supply now:",
    ethers.formatUnits(totalSupply, 18),
    "/ cap",
    ethers.formatUnits(await token.cap(), 18),
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

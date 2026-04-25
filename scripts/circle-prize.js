require("dotenv").config();
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");
const { ethers } = require("ethers");

const CONTRACT_ABI = [
  "function getGame(uint256) view returns (uint256,string,address,uint8,string,uint8,uint256,uint256,uint256,uint256,uint256,uint256,address[3],bool,uint8,uint256)",
];

async function main() {
  const gameId = process.argv[2];
  if (!gameId) { console.error("Usage: node scripts/circle-prize.js <gameId>"); process.exit(1); }

  const apiKey       = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const walletId     = process.env.CIRCLE_WALLET_ID;
  const contractAddr = process.env.CONTRACT_ADDRESS;

  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

  // Get token ID for USDC on Arc Testnet
  console.log("Finding USDC token ID on Arc Testnet...");
  const balances = await client.getWalletTokenBalance({ id: walletId });
  const tokens   = balances.data?.tokenBalances || [];
  console.log("Tokens found:", JSON.stringify(tokens, null, 2));

  const usdcToken = tokens.find(t =>
    t.token?.symbol?.toUpperCase() === "USDC" ||
    t.token?.name?.toUpperCase().includes("USDC")
  );

  if (!usdcToken) {
    console.error("❌ No USDC found in Circle wallet");
    process.exit(1);
  }

  const tokenId = usdcToken.token?.id;
  console.log("✅ USDC Token ID:", tokenId);
  console.log("✅ USDC Balance:", usdcToken.amount);

  // Read game from chain
  const provider = new ethers.JsonRpcProvider("https://rpc.testnet.arc.network");
  const contract = new ethers.Contract(contractAddr, CONTRACT_ABI, provider);

  console.log(`\nReading game #${gameId}...`);
  const g = await contract.getGame(gameId);
  const [, name,,,,,,, prizePool, playerCount,,, topPlayers,, status] = g;

  if (Number(status) !== 1) {
    console.error("❌ Game not ended. Status:", Number(status));
    process.exit(1);
  }

  const n    = Number(playerCount);
  const pool = parseFloat(ethers.formatUnits(prizePool, 6));
  const dist = pool * 0.95;
  const prizes = n === 1 ? [dist, 0, 0]
               : n === 2 ? [dist * 0.7, dist * 0.3, 0]
               : [dist * 0.6, dist * 0.25, dist * 0.15];

  console.log(`✅ Game: "${name}" | Players: ${n} | Pool: ${pool} USDC`);

  // Send prizes using tokenId
  for (let i = 0; i < 3; i++) {
    const winner = topPlayers[i];
    const prize  = prizes[i];
    if (!winner || winner === "0x0000000000000000000000000000000000000000" || prize <= 0) continue;

    const amountStr = prize.toFixed(2);
    console.log(`\n💸 Sending ${amountStr} USDC to #${i+1}: ${winner}`);

    try {
      const tx = await client.createTransaction({
        walletId,
        tokenId,                    // use tokenId instead of tokenAddress
        destinationAddress: winner,
        amounts: [amountStr],
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      });

      const txData = tx.data?.transaction;
      console.log(`✅ Sent! ID: ${txData?.id} | State: ${txData?.state}`);
    } catch(e) {
      console.error(`❌ Failed:`, e.message);
    }
  }

  console.log("\n🎉 Prizes distributed via Circle Wallets!");
  console.log("Check: https://testnet.arcscan.app/address/" + process.env.CIRCLE_WALLET_ADDRESS);
}

main().catch(e => {
  console.error("❌ Error:", e.message);
  process.exit(1);
});

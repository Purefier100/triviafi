require("dotenv").config();
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");
const fs = require("fs");

async function main() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

  if (!apiKey || !entitySecret) {
    console.error("❌ Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET in .env");
    process.exit(1);
  }

  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

  // Create wallet set
  console.log("Creating Wallet Set...");
  const walletSetRes = await client.createWalletSet({ name: "Arc Trivia Treasury" });
  const walletSetId = walletSetRes.data?.walletSet?.id;
  if (!walletSetId) throw new Error("Failed to create wallet set");
  console.log("✅ Wallet Set ID:", walletSetId);

  // Create wallet on Arc Testnet
  console.log("\nCreating Wallet on ARC-TESTNET...");
  const walletsRes = await client.createWallets({
    blockchains: ["ARC-TESTNET"],
    count: 1,
    walletSetId,
    accountType: "SCA"
  });

  const wallet = walletsRes.data?.wallets?.[0];
  if (!wallet) throw new Error("Failed to create wallet");

  console.log("✅ Wallet created!");
  console.log("   Wallet ID:  ", wallet.id);
  console.log("   Address:    ", wallet.address);
  console.log("   Blockchain: ", wallet.blockchain);

  // Save wallet info
  fs.mkdirSync("./output", { recursive: true });
  fs.writeFileSync("./output/wallet-info.json", JSON.stringify(wallet, null, 2));
  console.log("\n✅ Saved to output/wallet-info.json");

  // Append to .env
  fs.appendFileSync(".env", `\nCIRCLE_WALLET_ID=${wallet.id}\nCIRCLE_WALLET_ADDRESS=${wallet.address}\n`);
  console.log("✅ CIRCLE_WALLET_ID and CIRCLE_WALLET_ADDRESS added to .env");

  console.log("\n🚰 Fund this wallet with testnet USDC:");
  console.log("   https://faucet.circle.com");
  console.log("   Network: Arc Testnet");
  console.log("   Address:", wallet.address);
  console.log("\nNext step: node scripts/circle-prize.js");
}

main().catch(e => {
  console.error("❌ Error:", e.message);
  process.exit(1);
});

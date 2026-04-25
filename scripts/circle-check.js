require("dotenv").config();
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

async function main() {
  const client = initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET,
  });

  const walletId = process.env.CIRCLE_WALLET_ID;

  // Check balance
  console.log("💰 Checking Circle Wallet Balance...");
  const balances = await client.getWalletTokenBalance({ id: walletId });
  const tokens = balances.data?.tokenBalances || [];
  tokens.forEach(t => console.log(`   ${t.token?.symbol}: ${t.amount} (was 20, should be less now)`));

  // List recent transactions
  console.log("\n📋 Recent Transactions:");
  const txs = await client.listTransactions({ walletIds: [walletId] });
  const list = txs.data?.transactions || [];
  
  if (list.length === 0) {
    console.log("   No transactions found yet — may still be pending");
  } else {
    list.slice(0, 5).forEach(tx => {
      console.log(`   ID: ${tx.id}`);
      console.log(`   State: ${tx.state}`);
      console.log(`   Amount: ${tx.amounts?.[0]} USDC`);
      console.log(`   To: ${tx.destinationAddress}`);
      console.log(`   Hash: ${tx.txHash || "pending"}`);
      console.log(`   ---`);
    });
  }
}

main().catch(e => console.error("❌ Error:", e.message));

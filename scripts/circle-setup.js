require("dotenv").config();
const { registerEntitySecretCiphertext } = require("@circle-fin/developer-controlled-wallets");
const fs = require("fs");

async function main() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

  if (!apiKey) { console.error("❌ CIRCLE_API_KEY not found"); process.exit(1); }
  if (!entitySecret || entitySecret === "generated_secret_here") { 
    console.error("❌ CIRCLE_ENTITY_SECRET not set in .env"); 
    process.exit(1); 
  }

  console.log("✅ API Key:", apiKey.slice(0, 8) + "...");
  console.log("✅ Entity Secret:", entitySecret.slice(0, 8) + "...");
  console.log("\nRegistering Entity Secret with Circle...");

  fs.mkdirSync("./output", { recursive: true });

  const result = await registerEntitySecretCiphertext({
    apiKey,
    entitySecret,
    recoveryFileDownloadPath: "./output/"
  });

  console.log("✅ Entity Secret registered successfully!");
  console.log("✅ Recovery file saved to ./output/");
  console.log("\nRun next: node scripts/circle-wallet.js");
}

main().catch(e => {
  console.error("❌ Error:", e.message);
  process.exit(1);
});

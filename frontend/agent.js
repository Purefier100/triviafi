require("dotenv").config();

// =============================================================================
// Arc Trivia — AI Agent (CLEAN VERSION)
// Rules:
//   1. Always keep exactly 2 open games — no more, no less
//   2. Only create new games when BOTH existing agent games have ended/expired
//   3. Auto-end expired games every tick
//   4. loadGames() in frontend only shows latest 10 — past games archived
// =============================================================================

const { ethers } = require("ethers");

const RPC = "https://rpc.testnet.arc.network";
const CONTRACT =
  process.env.CONTRACT_ADDRESS || "0x52F6dE1118a3c22CBF04f7d811B08034DCF21E50";

const ABI = [
  "function gameCounter() view returns (uint256)",
  "function createGame(string,uint8,string,uint8,uint256,uint256,uint256,uint256) external returns (uint256)",
  "function triggerEnd(uint256) external",
  "function getGame(uint256) view returns (tuple(uint256 id,string name,address creator,uint8 categoryId,string categoryName,uint8 difficulty,uint256 entryFee,uint256 maxPlayers,uint256 prizePool,uint256 playerCount,uint256 registrationEnd,uint256 playDeadline,address[3] topPlayers,bool prizeClaimed,uint8 status,uint256 finishedCount))",
];

const USDC_ABI = ["function balanceOf(address) view returns (uint256)"];
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";

// ── Config ───────────────────────────────────────────────────────────────────
const MAX_AGENT_GAMES = 2; // exactly 2 agent games at a time
const CHECK_INTERVAL_MS = 120000; // check every 2 minutes
const ENTRY_FEE_USDC = "1";
const MAX_PLAYERS = 10;
const REG_WINDOW_SECS = 3600; // 1 hour registration
const PLAY_WINDOW_SECS = 1800; // 30 min play window

const ROOMS = [
  {
    name: "🤖 General Knowledge Blitz",
    catId: 9,
    catName: "General Knowledge",
    diff: 1,
  },
  {
    name: "🤖 Science & Nature Challenge",
    catId: 17,
    catName: "Science & Nature",
    diff: 2,
  },
  { name: "🤖 History Showdown", catId: 23, catName: "History", diff: 2 },
  {
    name: "🤖 Video Games Gauntlet",
    catId: 15,
    catName: "Video Games",
    diff: 1,
  },
  {
    name: "🤖 Geography Speed Round",
    catId: 22,
    catName: "Geography",
    diff: 1,
  },
  {
    name: "🤖 Computer Science Arena",
    catId: 18,
    catName: "Computers",
    diff: 2,
  },
  {
    name: "🤖 Mixed Trivia Open",
    catId: 9,
    catName: "General Knowledge",
    diff: 0,
  },
  { name: "🤖 Sports & Recreation Cup", catId: 21, catName: "Sports", diff: 1 },
];

let roomIndex = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(
    `[${new Date().toLocaleTimeString("en-US", { hour12: false })}] ${msg}`,
  );
}
function sep(t) {
  console.log(`\n${"─".repeat(55)}\n  ${t}\n${"─".repeat(55)}`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function fmtTime(secs) {
  if (secs <= 0) return "expired";
  const h = Math.floor(secs / 3600),
    m = Math.floor((secs % 3600) / 60),
    s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function safeGetGame(contract, id) {
  try {
    const g = await contract.getGame(id);
    return {
      id,
      name: g.name || g[1],
      status: Number(g.status ?? g[14]),
      playerCount: Number(g.playerCount ?? g[9]),
      finishedCount: Number(g.finishedCount ?? g[15]),
      registrationEnd: Number(g.registrationEnd ?? g[10]),
      playDeadline: Number(g.playDeadline ?? g[11]),
      creator: (g.creator || g[2]).toLowerCase(),
    };
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main tick
// ─────────────────────────────────────────────────────────────────────────────
async function tick(contract, usdc, agentAddress, provider) {
  sep("🤖 Agent Tick");
  const now = Math.floor(Date.now() / 1000);

  // Balances
  try {
    const uBal = await usdc.balanceOf(agentAddress);
    const eBal = await provider.getBalance(agentAddress);
    log(
      `💰 USDC: ${ethers.formatUnits(uBal, 6)} | ETH: ${parseFloat(
        ethers.formatEther(eBal),
      ).toFixed(4)}`,
    );
  } catch (_) {}

  const count = Number(await contract.gameCounter());
  log(`📊 Total games on contract: ${count}`);
  if (count === 0) {
    await createGames(contract, MAX_AGENT_GAMES);
    return;
  }

  // ── Scan last 50 games for agent games ──────────────────────────────────
  const scanFrom = Math.max(1, count - 50);
  log(`🔍 Scanning games #${scanFrom}–#${count}...`);

  const fetches = [];
  for (let i = count; i >= scanFrom; i--)
    fetches.push(safeGetGame(contract, i));
  const games = (await Promise.all(fetches)).filter(Boolean);

  // Separate: agent's open games vs endable games
  const agentOpen = [];
  const endableIds = [];

  for (const g of games) {
    const isAgent = g.creator === agentAddress.toLowerCase();
    const isOpen = g.status === 0;
    const isExpired = now > g.playDeadline;
    const allDone = g.finishedCount >= g.playerCount && g.playerCount > 0;

    if (isOpen) {
      // Auto-end if past deadline or all players done
      if (isExpired || allDone) {
        endableIds.push(g.id);
      } else if (isAgent) {
        agentOpen.push(g);
      }
    }
  }

  // Print state
  log(
    `📋 Agent open games: ${agentOpen.length} | Endable: ${endableIds.length}`,
  );
  for (const g of agentOpen) {
    const regLeft = Math.max(0, g.registrationEnd - now);
    const playLeft = Math.max(0, g.playDeadline - now);
    const phase =
      now < g.registrationEnd
        ? `Reg: ${fmtTime(regLeft)}`
        : `Play: ${fmtTime(playLeft)}`;
    log(`  ✅ #${g.id} "${g.name}" — ${g.playerCount} players | ${phase}`);
  }

  // ── Step 1: End any expired/finished games ──────────────────────────────
  for (const id of endableIds) {
    try {
      log(`🏁 Ending game #${id}...`);
      const tx = await contract.triggerEnd(id);
      await tx.wait();
      log(`✅ Game #${id} ended`);
    } catch (e) {
      log(`⚠️  Could not end #${id}: ${e.reason || e.message}`);
    }
    await sleep(2000);
  }

  // ── Step 2: Create new games ONLY if agent has < 2 active open games ────
  // KEY RULE: we only count agent games that are STILL within their time window
  const activeAgentGames = agentOpen.filter((g) => !endableIds.includes(g.id));
  log(`✅ Active agent games after cleanup: ${activeAgentGames.length}`);

  const needed = MAX_AGENT_GAMES - activeAgentGames.length;
  if (needed > 0) {
    log(`➕ Need ${needed} more game(s) — creating...`);
    await createGames(contract, needed);
  } else {
    log(
      `👌 Already have ${activeAgentGames.length} active game(s) — no action needed.`,
    );
    log(`   Next check in ${CHECK_INTERVAL_MS / 1000}s...`);
  }
}

async function createGames(contract, count) {
  const feeWei = ethers.parseUnits(ENTRY_FEE_USDC, 6);

  for (let i = 0; i < count; i++) {
    const room = ROOMS[roomIndex % ROOMS.length];
    roomIndex++;

    log(
      `🎮 Creating: "${room.name}" (${room.catName}, ${
        ["Any", "Easy", "Medium", "Hard"][room.diff]
      })`,
    );

    let retries = 5;

    while (retries > 0) {
      try {
        const tx = await contract.createGame(
          room.name,
          room.catId,
          room.catName,
          room.diff,
          feeWei,
          MAX_PLAYERS,
          REG_WINDOW_SECS,
          PLAY_WINDOW_SECS,
        );

        const receipt = await tx.wait();

        log(`✅ Created — tx: ${receipt.hash.slice(0, 20)}...`);
        break; // ✅ SUCCESS → exit retry loop
      } catch (e) {
        retries--;

        if (e.message && e.message.includes("txpool is full")) {
          log(`⏳ Network busy, retrying... (${5 - retries}/5)`);
          await sleep(5000); // wait 5s before retry
        } else {
          log(`❌ Create failed: ${e.reason || e.message}`);
          break; // ❌ real error → stop retry
        }
      }
    }

    if (i < count - 1) {
      await sleep(5000); // 🔥 increase delay (was 3000)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────
async function run() {
  if (!process.env.AGENT_KEY) {
    console.error("❌ Missing AGENT_KEY");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(process.env.AGENT_KEY, provider);
  const contract = new ethers.Contract(CONTRACT, ABI, wallet);
  const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, wallet);

  sep("🤖 Arc Trivia Agent — CLEAN MODE");
  log(`Wallet:   ${wallet.address}`);
  log(`Contract: ${CONTRACT}`);
  log(`Rule:     Max ${MAX_AGENT_GAMES} active agent games at a time`);
  log(`Rule:     Only create when existing games expire/end`);
  log(`Interval: ${CHECK_INTERVAL_MS / 1000}s`);

  await tick(contract, usdc, wallet.address, provider);

  setInterval(async () => {
    try {
      await tick(contract, usdc, wallet.address, provider);
    } catch (e) {
      log(`❌ Tick error: ${e.message}`);
    }
  }, CHECK_INTERVAL_MS);
}

run().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});

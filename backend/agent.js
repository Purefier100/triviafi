require("dotenv").config();
const { ethers } = require("ethers");

// ── Arc config ────────────────────────────────────────────────────────────
const ARC_CONTRACT  = process.env.CONTRACT_ADDRESS || "0x52F6dE1118a3c22CBF04f7d811B08034DCF21E50";
const ARC_RPCS      = ["https://rpc.testnet.arc.network", "https://arc-testnet.drpc.org"];
const ARC_ENTRY_FEE = "2";       // USDC (6 decimals)
const ARC_CHAIN_ID  = 5042002;

// ── LitVM config ──────────────────────────────────────────────────────────
const LITVM_CONTRACT  = process.env.LITVM_CONTRACT_ADDRESS || "0xf829c7adAAd30C9735c73F33e9576F1ABDC7F765";
const LITVM_RPC       = process.env.LITVM_RPC_URL          || "https://liteforge.rpc.caldera.xyz/http";
const LITVM_ENTRY_FEE = "0.01";  // zkLTC (18 decimals)

// ── Shared config ─────────────────────────────────────────────────────────
const CHECK_INTERVAL_MS  = 300000; // 5 min
const CYCLE_COOLDOWN_HRS = 5;
const REG_WINDOW_SECS    = 3600;   // 1hr registration
const PLAY_WINDOW_SECS   = 3600;  // 23hrs play (~24hr total)
const MAX_PLAYERS        = 10;

const ABI = [
  "function gameCounter() view returns (uint256)",
  "function createGame(string,uint8,string,uint8,uint256,uint256,uint256,uint256) external returns (uint256)",
  "function triggerEnd(uint256) external",
  "function getGame(uint256) view returns (tuple(uint256 id,string name,address creator,uint8 categoryId,string categoryName,uint8 difficulty,uint256 entryFee,uint256 maxPlayers,uint256 prizePool,uint256 playerCount,uint256 registrationEnd,uint256 playDeadline,address[3] topPlayers,bool prizeClaimed,uint8 status,uint256 finishedCount))",
];

const ROOMS = [
  { name: "🤖 General Knowledge Blitz",   catId: 9,  catName: "General Knowledge", diff: 1 },
  { name: "🤖 Science & Nature Challenge", catId: 17, catName: "Science & Nature",  diff: 2 },
  { name: "🤖 History Showdown",           catId: 23, catName: "History",            diff: 2 },
  { name: "🤖 Video Games Gauntlet",       catId: 15, catName: "Video Games",        diff: 1 },
  { name: "🤖 Geography Speed Round",      catId: 22, catName: "Geography",          diff: 1 },
  { name: "🤖 Computer Science Arena",     catId: 18, catName: "Computers",          diff: 2 },
  { name: "🤖 Mixed Trivia Open",          catId: 9,  catName: "General Knowledge",  diff: 0 },
  { name: "🤖 Sports & Recreation Cup",    catId: 21, catName: "Sports",             diff: 1 },
];

let arcRoomIndex   = 0;
let litvmRoomIndex = 0;
let arcLastCycle   = 0;
let litvmLastCycle = 0;

// ── Helpers ───────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toLocaleTimeString("en-US", { hour12: false })}] ${msg}`);
}
function sep(t) {
  console.log(`\n${"─".repeat(55)}\n  ${t}\n${"─".repeat(55)}`);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmtTime(secs) {
  if (secs <= 0) return "expired";
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function makeArcProvider() {
  for (const rpc of ARC_RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(rpc, { chainId: ARC_CHAIN_ID, name: "arc-testnet" });
      await p.getBlockNumber();
      return p;
    } catch { continue; }
  }
  return new ethers.JsonRpcProvider(ARC_RPCS[0], { chainId: ARC_CHAIN_ID, name: "arc-testnet" });
}

function makeLitvmProvider() {
  return new ethers.JsonRpcProvider(LITVM_RPC, { chainId: 4441, name: "litvm" });
}

async function safeGetGame(contract, id) {
  try {
    const g = await contract.getGame(id);
    return {
      id,
      name:          g.name          || g[1],
      status:        Number(g.status         ?? g[14]),
      playerCount:   Number(g.playerCount    ?? g[9]),
      finishedCount: Number(g.finishedCount  ?? g[15]),
      registrationEnd: Number(g.registrationEnd ?? g[10]),
      playDeadline:  Number(g.playDeadline   ?? g[11]),
      creator:       (g.creator || g[2]).toLowerCase(),
    };
  } catch { return null; }
}

// ── Scan chain ────────────────────────────────────────────────────────────
async function scanChain(contract, agentAddress, chainName) {
  const now   = Math.floor(Date.now() / 1000);
  const count = Number(await contract.gameCounter());
  log(`📊 [${chainName}] Total games: ${count}`);
  if (count === 0) return { agentOpen: [], endableIds: [], count };

  const scanFrom = Math.max(1, count - 100);
  const fetches  = [];
  for (let i = count; i >= scanFrom; i--) fetches.push(safeGetGame(contract, i));
  const games = (await Promise.all(fetches)).filter(Boolean);

  const agentOpen  = [];
  const endableIds = [];

  for (const g of games) {
    const isAgent   = g.creator === agentAddress.toLowerCase();
    const isOpen    = g.status === 0;
    const isExpired = now > g.playDeadline;
    const allDone   = g.finishedCount >= g.playerCount && g.playerCount > 0;

    if (isOpen) {
      if (isExpired || allDone) {
        endableIds.push(g.id);
      } else if (isAgent) {
        agentOpen.push(g);
      }
    }
  }

  log(`📋 [${chainName}] Agent open: ${agentOpen.length} | Endable: ${endableIds.length}`);
  for (const g of agentOpen) {
    const regLeft  = Math.max(0, g.registrationEnd - now);
    const playLeft = Math.max(0, g.playDeadline - now);
    const phase = now < g.registrationEnd ? `Reg: ${fmtTime(regLeft)}` : `Play: ${fmtTime(playLeft)}`;
    log(`  ✅ #${g.id} "${g.name}" — ${g.playerCount} players | ${phase}`);
  }

  return { agentOpen, endableIds, count };
}

// ── End expired games ─────────────────────────────────────────────────────
async function endGames(contract, endableIds, chainName) {
  for (const id of endableIds) {
    try {
      log(`🏁 [${chainName}] Ending game #${id}...`);
      const tx = await contract.triggerEnd(id);
      await tx.wait();
      log(`✅ [${chainName}] Game #${id} ended`);
    } catch (e) {
      log(`⚠️  [${chainName}] Could not end #${id}: ${e.reason || e.message}`);
    }
    await sleep(2000);
  }
}

// ── Create Arc game ───────────────────────────────────────────────────────
async function createArcGame(arcContract, arcProvider, agentAddress) {
  // Balance check
  const bal = await arcProvider.getBalance(agentAddress);
  if (bal === 0n) {
    log(`❌ [Arc] Agent wallet has 0 native ARC — fund ${agentAddress}`);
    return false;
  }

  const room   = ROOMS[arcRoomIndex % ROOMS.length];
  const feeWei = ethers.parseUnits(ARC_ENTRY_FEE, 6);
  log(`🎮 [Arc] Creating: "${room.name}"`);

  let retries = 3;
  while (retries > 0) {
    try {
      const tx = await arcContract.createGame(
        room.name, room.catId, room.catName, room.diff,
        feeWei, MAX_PLAYERS, REG_WINDOW_SECS, PLAY_WINDOW_SECS,
      );
      const receipt = await tx.wait();
      log(`✅ [Arc] Created — tx: ${receipt.hash.slice(0, 20)}...`);
      arcRoomIndex++;
      return true;
    } catch (e) {
      retries--;
      if (e.message?.includes("txpool is full")) {
        log(`⏳ [Arc] Network busy, retrying...`);
        await sleep(5000);
      } else {
        log(`❌ [Arc] Create failed: ${e.reason || e.message}`);
        return false;
      }
    }
  }
  return false;
}

// ── Create LitVM game ─────────────────────────────────────────────────────
async function createLitvmGame(litvmContract, litvmProvider, agentAddress) {
  const feeWei    = ethers.parseEther(LITVM_ENTRY_FEE);
  const gasBuffer = ethers.parseEther("0.005");
  const bal       = await litvmProvider.getBalance(agentAddress);

  if (bal < feeWei + gasBuffer) {
    log(`❌ [LitVM] Insufficient zkLTC: have ${ethers.formatEther(bal)}, need ~${LITVM_ENTRY_FEE} + gas`);
    return false;
  }

  const room = ROOMS[litvmRoomIndex % ROOMS.length];
  log(`🎮 [LitVM] Creating: "${room.name}"`);

  let retries = 3;
  while (retries > 0) {
    try {
      const tx = await litvmContract.createGame(
        room.name, room.catId, room.catName, room.diff,
        feeWei, MAX_PLAYERS, REG_WINDOW_SECS, PLAY_WINDOW_SECS,
        { value: feeWei }
      );
      const receipt = await tx.wait();
      log(`✅ [LitVM] Created — tx: ${receipt.hash.slice(0, 20)}...`);
      litvmRoomIndex++;
      return true;
    } catch (e) {
      retries--;
      if (e.message?.includes("txpool is full")) {
        log(`⏳ [LitVM] Network busy, retrying...`);
        await sleep(5000);
      } else {
        log(`❌ [LitVM] Create failed: ${e.reason || e.message}`);
        return false;
      }
    }
  }
  return false;
}

// ── Main tick ─────────────────────────────────────────────────────────────
async function tick(arcContract, litvmContract, arcProvider, litvmProvider, arcAddress, litvmAddress) {
  sep("🤖 Agent Tick — Multichain");
  const now = Math.floor(Date.now() / 1000);

  // Scan both chains
  const [arcState, litvmState] = await Promise.all([
    scanChain(arcContract,   arcAddress,   "Arc"  ).catch(e => { log(`❌ Arc scan failed: ${e.message}`);   return { agentOpen: [], endableIds: [], count: 0 }; }),
    scanChain(litvmContract, litvmAddress, "LitVM").catch(e => { log(`❌ LitVM scan failed: ${e.message}`); return { agentOpen: [], endableIds: [], count: 0 }; }),
  ]);

  // End expired games
  await endGames(arcContract,   arcState.endableIds,   "Arc");
  await endGames(litvmContract, litvmState.endableIds, "LitVM");

  // Arc cycle
  const arcActive      = arcState.agentOpen.filter(g => !arcState.endableIds.includes(g.id));
  const arcCooldownOk  = arcLastCycle === 0 || (now - arcLastCycle) / 3600 >= CYCLE_COOLDOWN_HRS;
  log(`⏱️  [Arc]   Hours since last cycle: ${arcLastCycle === 0 ? "never" : ((now - arcLastCycle)/3600).toFixed(1)}`);

  if (arcActive.length === 0 && arcCooldownOk) {
    const ok = await createArcGame(arcContract, arcProvider, arcAddress);
    if (ok) { arcLastCycle = now; log(`✅ [Arc] Cycle complete — next in ${CYCLE_COOLDOWN_HRS}hrs`); }
  } else if (arcActive.length > 0) {
    log(`⏳ [Arc] ${arcActive.length} active game(s) — waiting`);
  } else {
    log(`⏳ [Arc] Cooldown — ${(CYCLE_COOLDOWN_HRS - (now - arcLastCycle)/3600).toFixed(1)}hrs left`);
  }

  await sleep(3000);

  // LitVM cycle
  const litvmActive     = litvmState.agentOpen.filter(g => !litvmState.endableIds.includes(g.id));
  const litvmCooldownOk = litvmLastCycle === 0 || (now - litvmLastCycle) / 3600 >= CYCLE_COOLDOWN_HRS;
  log(`⏱️  [LitVM] Hours since last cycle: ${litvmLastCycle === 0 ? "never" : ((now - litvmLastCycle)/3600).toFixed(1)}`);

  if (litvmActive.length === 0 && litvmCooldownOk) {
    const ok = await createLitvmGame(litvmContract, litvmProvider, litvmAddress);
    if (ok) { litvmLastCycle = now; log(`✅ [LitVM] Cycle complete — next in ${CYCLE_COOLDOWN_HRS}hrs`); }
  } else if (litvmActive.length > 0) {
    log(`⏳ [LitVM] ${litvmActive.length} active game(s) — waiting`);
  } else {
    log(`⏳ [LitVM] Cooldown — ${(CYCLE_COOLDOWN_HRS - (now - litvmLastCycle)/3600).toFixed(1)}hrs left`);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────
async function run() {
  if (!process.env.AGENT_KEY)       { console.error("❌ Missing AGENT_KEY");       process.exit(1); }
  if (!process.env.LITVM_AGENT_KEY) { console.error("❌ Missing LITVM_AGENT_KEY"); process.exit(1); }

  const arcProvider   = await makeArcProvider();
  const litvmProvider = makeLitvmProvider();

  const arcWallet   = new ethers.Wallet(process.env.AGENT_KEY,       arcProvider);
  const litvmWallet = new ethers.Wallet(process.env.LITVM_AGENT_KEY, litvmProvider);

  const arcContract   = new ethers.Contract(ARC_CONTRACT,   ABI, arcWallet);
  const litvmContract = new ethers.Contract(LITVM_CONTRACT, ABI, litvmWallet);

  sep("🤖 TriviaFi Agent — Multichain Mode");
  log(`Arc   wallet: ${arcWallet.address}`);
  log(`LitVM wallet: ${litvmWallet.address}`);
  log(`Arc   contract: ${ARC_CONTRACT}`);
  log(`LitVM contract: ${LITVM_CONTRACT}`);
  log(`Game duration:  ~24hrs (1hr reg + 23hr play)`);
  log(`Check interval: ${CHECK_INTERVAL_MS / 1000}s`);

  // Show balances
  try { log(`Arc   balance: ${ethers.formatEther(await arcProvider.getBalance(arcWallet.address))} ARC`); } catch (_) {}
  try { log(`LitVM balance: ${ethers.formatEther(await litvmProvider.getBalance(litvmWallet.address))} zkLTC`); } catch (_) {}

  await tick(arcContract, litvmContract, arcProvider, litvmProvider, arcWallet.address, litvmWallet.address);

  setInterval(async () => {
    try {
      await tick(arcContract, litvmContract, arcProvider, litvmProvider, arcWallet.address, litvmWallet.address);
    } catch (e) {
      log(`❌ Tick error: ${e.message}`);
    }
  }, CHECK_INTERVAL_MS);
}

run().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
require("dotenv").config();
const crypto = require("crypto");

function encryptAnswer(text) {
  const secret = process.env.SESSION_SECRET || "fallback";
  const iv = crypto.randomBytes(16);
  const key = crypto.createHash("sha256").update(secret).digest();
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decryptAnswer(encrypted) {
  try {
    const secret = process.env.SESSION_SECRET || "fallback";
    const [ivHex, encryptedText] = encrypted.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const key = crypto.createHash("sha256").update(secret).digest();
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (_) {
    return null;
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("🚨 UNHANDLED PROMISE REJECTION (process kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("🚨 UNCAUGHT EXCEPTION (process kept alive):", err);
});

const session = require("express-session");
const pgSessionFactory = require("connect-pg-simple");
const passport = require("passport");
const express = require("express");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const cors = require("cors");
const { Pool } = require("pg");
const { ethers } = require("ethers");
const rateLimit = require("express-rate-limit");
const sanitizeHtml = require("sanitize-html");
const csrf = require("csurf");
const cookieParser = require("cookie-parser");
const csrfProtection = csrf({
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    key: "_csrf",
  },
});

const app = express();
app.set("trust proxy", 1);

// ── Verifier wallet ──────────────────────────────────────────────────────────
const verifierWallet = new ethers.Wallet(process.env.VERIFIER_PRIVATE_KEY);
console.log("Verifier:", verifierWallet.address);

// ── Treasury wallet — receives all tournament entry fees ────────────────────
// All entry fees go HERE. Prizes are sent FROM here via VERIFIER_PRIVATE_KEY.
// Set TREASURY_ADDRESS in your Render env vars.
const TREASURY_ADDRESS = (
  process.env.TREASURY_ADDRESS || "0xAe699B48004F1507CbcB05EaCc0D7528c4F0d407"
).toLowerCase();

// ── Tournament Score Contract ─────────────────────────────────────────────
const TOURNAMENT_CONTRACT_ARC = process.env.TOURNAMENT_CONTRACT_ARC || "";
const TOURNAMENT_CONTRACT_LITVM = process.env.TOURNAMENT_CONTRACT_LITVM || "";

const TOURNAMENT_ABI = [
  "function submitScore(uint256 tournamentId, uint256 roundNumber, uint256 score, uint256 nonce, bytes calldata signature) external",
  "function getScore(uint256 tournamentId, uint256 roundNumber, address player) view returns (uint256 score, uint256 timestamp, bool submitted)",
  "function hasSubmitted(uint256, uint256, address) view returns (bool)",
  "function getRoundSubmissionCount(uint256, uint256) view returns (uint256)",
  "event ScoreSubmitted(uint256 indexed tournamentId, uint256 indexed roundNumber, address indexed player, uint256 score, uint256 timestamp)",
];

console.log("Tournament contracts:");
console.log("  Arc:  ", TOURNAMENT_CONTRACT_ARC || "NOT SET");
console.log("  LitVM:", TOURNAMENT_CONTRACT_LITVM || "NOT SET");

// ✅ Security check: confirm verifier wallet matches treasury address
const verifierAddress = verifierWallet.address.toLowerCase();
if (verifierAddress !== TREASURY_ADDRESS) {
  console.warn(
    `⚠️  WARNING: VERIFIER wallet (${verifierWallet.address}) ` +
      `does not match TREASURY_ADDRESS (${TREASURY_ADDRESS}). ` +
      `Entry fees will go to TREASURY_ADDRESS but prizes will be sent FROM VERIFIER.`,
  );
} else {
  console.log(`✅ Treasury = Verifier: ${verifierWallet.address}`);
}

const CONTRACT_ABI = [
  "function getPlayerStatus(uint256,address) view returns (bool,bool,bool,uint256)",
  "function nonces(address) view returns (uint256)",
  "function submitScore(uint256,uint256,bytes)",
  "function games(uint256) view returns (uint8 status)",
];
const CONTRACT_ADDRESS =
  process.env.CONTRACT_ADDRESS || "0x52F6dE1118a3c22CBF04f7d811B08034DCF21E50";
const LITVM_CONTRACT_ADDRESS =
  process.env.LITVM_CONTRACT_ADDRESS ||
  "0xf829c7adAAd30C9735c73F33e9576F1ABDC7F765";
const LITVM_RPC_URL =
  process.env.LITVM_RPC_URL || "https://liteforge-testnet.rpc.caldera.xyz/http";

const LITVM_RPCS_LIST = [
  process.env.LITVM_RPC_URL || "https://liteforge.rpc.caldera.xyz/http",
  "https://liteforge.rpc.caldera.xyz/http",
].filter((v, i, a) => v && a.indexOf(v) === i); // dedupe

const LITVM_RPCS = [LITVM_RPC_URL];
const ARC_RPCS = [
  "https://rpc.testnet.arc.network",
  "https://rpc.drpc.testnet.arc.network",
  "https://rpc.quicknode.testnet.arc.network",
  "https://rpc.blockdaemon.testnet.arc.network",
];

function makeProvider(rpcIndex = 0) {
  return new ethers.JsonRpcProvider(ARC_RPCS[rpcIndex % ARC_RPCS.length], {
    chainId: 5042002,
    name: "arc-testnet",
  });
}

function calculateScore(serverAnswers, submittedAnswers) {
  let score = 0;

  for (let i = 0; i < serverAnswers.length; i++) {
    const real = serverAnswers[i];
    const user = submittedAnswers.find(
      (a) => Number(a.questionIndex) === Number(real.question_id),
    );

    if (!user) continue;

    if (user.selected === real.correct_answer) {
      score++;
    }
  }

  return score;
}

// Accepts "@handle", "handle", or an x.com/twitter.com URL → returns clean handle or null
function normalizeTwitter(input) {
  if (!input) return null;
  let s = String(input).trim();
  const m = s.match(/(?:twitter\.com|x\.com)\/(@?[A-Za-z0-9_]{1,15})/i);
  if (m) s = m[1];
  s = s.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(s)) return null;
  return s;
}

const arcProvider = makeProvider();
const arcContract = new ethers.Contract(
  CONTRACT_ADDRESS,
  CONTRACT_ABI,
  arcProvider,
);

// ── LitVM provider ────────────────────────────────────────────────────────────
function makeLitvmProvider(attempt = 0) {
  const rpc = LITVM_RPCS_LIST[attempt % LITVM_RPCS_LIST.length];
  console.log("LITVM RPC USED:", rpc);
  return new ethers.JsonRpcProvider(
    rpc,
    { chainId: 4441, name: "litvm" },
    { staticNetwork: true }, // stops ethers retrying network detection on every call
  );
}
const litvmProvider = makeLitvmProvider();
const litvmVerifierSigner = verifierWallet.connect(litvmProvider);
const litvmWriteContract = new ethers.Contract(
  LITVM_CONTRACT_ADDRESS,
  CONTRACT_ABI,
  litvmVerifierSigner,
);
const verifierSigner = verifierWallet.connect(arcProvider);
const writeContract = new ethers.Contract(
  CONTRACT_ADDRESS,
  CONTRACT_ABI,
  verifierSigner,
);

async function makeLitvmProviderFast() {
  console.log("LITVM_RPCS_LIST:", LITVM_RPCS_LIST);
  for (const rpc of LITVM_RPCS_LIST) {
    try {
      const p = new ethers.JsonRpcProvider(rpc, {
        chainId: 4441,
        name: "litvm",
      });
      await Promise.race([
        p.getBlockNumber(),
        new Promise((_, r) => setTimeout(() => r(new Error("t")), 3000)),
      ]);
      console.log(`✅ LitVM RPC: ${rpc}`);
      return p;
    } catch (e) {
      console.error(`❌ LitVM RPC failed: ${rpc}`);
      console.error(e);
    }
  }
  // All failed — return default anyway
  return new ethers.JsonRpcProvider(LITVM_RPCS_LIST[0], {
    chainId: 4441,
    name: "litvm",
  });
}

// ✅ UNIVERSAL RETRY — handles txpool full, timeouts, and stale connections
async function withRetry(fn, label = "rpc", retries = 6) {
  for (let i = 1; i <= retries; i++) {
    try {
      // Alternate between RPCs on each retry
      const provider = makeProvider(i - 1);
      const contract = new ethers.Contract(
        CONTRACT_ADDRESS,
        CONTRACT_ABI,
        provider,
      );
      const result = await Promise.race([
        fn(contract, provider),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("RPC timeout after 12s")), 12000),
        ),
      ]);
      return result;
    } catch (e) {
      const msg = e.message || "";
      const retryable =
        msg.includes("txpool is full") ||
        msg.includes("timeout") ||
        msg.includes("NETWORK_ERROR") ||
        msg.includes("network changed") ||
        msg.includes("unavailable") ||
        msg.includes("502") ||
        msg.includes("503") ||
        msg.includes("429");

      console.warn(
        `[${label}] attempt ${i}/${retries} (${
          ARC_RPCS[(i - 1) % ARC_RPCS.length]
        }): ${msg}`,
      );
      if (!retryable || i === retries) throw e;

      const delay = 1500 * i;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function withLitvmRetry(fn, label = "litvm", retries = 4) {
  for (let i = 1; i <= retries; i++) {
    try {
      const provider = makeLitvmProvider(i - 1);
      const contract = new ethers.Contract(
        LITVM_CONTRACT_ADDRESS,
        CONTRACT_ABI,
        provider,
      );
      const result = await Promise.race([
        fn(contract, provider),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("LitVM timeout")), 15000),
        ),
      ]);
      return result;
    } catch (e) {
      console.warn(`[${label}] attempt ${i}/${retries}: ${e.message}`);
      if (i === retries) throw e;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

console.log("Contract:", CONTRACT_ADDRESS);

// ── DB ────────────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function retry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e.message.includes("txpool is full")) {
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        throw e;
      }
    }
  }
  throw new Error("Blockchain busy");
}

async function initDB() {
  try {
    // =========================================================================
    // USERS
    // =========================================================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id              SERIAL PRIMARY KEY,
        google_id       TEXT UNIQUE,
        email           TEXT UNIQUE,
        display_name    TEXT,
        avatar          TEXT,
        username        TEXT UNIQUE,
        wallet          TEXT UNIQUE,
        nonce           INT DEFAULT 0,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── GAME REFUNDS — tracks refunds sent to players who joined but never played ──
    await pool.query(`
  CREATE TABLE IF NOT EXISTS game_refunds (
    id              SERIAL PRIMARY KEY,
    game_id         INT NOT NULL,
    chain_id        INT NOT NULL DEFAULT 5042002,
    wallet          TEXT NOT NULL,
    amount          NUMERIC(36,18) NOT NULL,
    token_symbol    TEXT NOT NULL DEFAULT 'USDC',
    tx_hash         TEXT,
    status          TEXT DEFAULT 'pending',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(game_id, chain_id, wallet)
  );
`);

    // ── TOURNAMENT APPLICATIONS (whitelist approval system) ───────────────────
    await pool.query(`
  CREATE TABLE IF NOT EXISTS tournament_applications (
    id            SERIAL PRIMARY KEY,
    tournament_id INT REFERENCES tournaments(id) ON DELETE CASCADE,
    wallet        TEXT NOT NULL,
    user_id       INT REFERENCES users(id) ON DELETE CASCADE,
    status        TEXT DEFAULT 'pending',
    applied_at    TIMESTAMPTZ DEFAULT NOW(),
    reviewed_at   TIMESTAMPTZ,
    UNIQUE(tournament_id, wallet)
  );
`);

    // ── WHITELIST TOURNAMENT TASKS (per-tournament, set by creator) ───────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_wl_tasks (
      id            SERIAL PRIMARY KEY,
      tournament_id INT REFERENCES tournaments(id) ON DELETE CASCADE,
      task_type     TEXT NOT NULL DEFAULT 'custom',
      label         TEXT NOT NULL,
      action_url    TEXT DEFAULT '',
      action_text   TEXT DEFAULT 'Complete',
      sort_order    INT DEFAULT 0,
    created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

    // ── WHITELIST TASK COMPLETIONS (per wallet per task) ─────────────────────
    await pool.query(`
  CREATE TABLE IF NOT EXISTS tournament_wl_completions (
    id            SERIAL PRIMARY KEY,
    tournament_id INT REFERENCES tournaments(id) ON DELETE CASCADE,
    task_id       INT REFERENCES tournament_wl_tasks(id) ON DELETE CASCADE,
    wallet        TEXT NOT NULL,
    completed_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tournament_id, task_id, wallet)
  );
`);

    await pool.query(`
  CREATE TABLE IF NOT EXISTS tournament_applications (
    id            SERIAL PRIMARY KEY,
    tournament_id INT REFERENCES tournaments(id) ON DELETE CASCADE,
    wallet        TEXT NOT NULL,
    user_id       INT REFERENCES users(id) ON DELETE CASCADE,
    status        TEXT DEFAULT 'pending',
    applied_at    TIMESTAMPTZ DEFAULT NOW(),
    reviewed_at   TIMESTAMPTZ,
    UNIQUE(tournament_id, wallet)
  );
`);

    await pool.query(`
  CREATE TABLE IF NOT EXISTS genlayer_round_questions (
    id              SERIAL PRIMARY KEY,
    tournament_id   INT NOT NULL,
    round_number    INT NOT NULL,
    wallet          TEXT NOT NULL,
    question_text   TEXT NOT NULL,
    options         TEXT NOT NULL,
    correct_answer  TEXT NOT NULL,
    fetched_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tournament_id, round_number, wallet)
  );
`);

    // ✅ ADD THIS — reviewed_by column was missing
    await pool
      .query(
        `ALTER TABLE tournament_applications ADD COLUMN IF NOT EXISTS reviewed_by TEXT`,
      )
      .catch(() => {});

    // ── TOURNAMENT REFUNDS ────────────────────────────────────────────────────
    await pool.query(`
  ALTER TABLE tournament_players
    ADD COLUMN IF NOT EXISTS refunded      BOOLEAN     DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS refunded_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS refund_tx     TEXT;
`);

    // =========================================================================
    // GAME SESSIONS — drop and recreate constraint safely
    // =========================================================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_sessions ( 
      id         SERIAL PRIMARY KEY,
      user_id    INT REFERENCES users(id) ON DELETE CASCADE,
      wallet     TEXT NOT NULL,
      game_id    INT NOT NULL,
      chain_id   INT DEFAULT 5042002,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      finished   BOOLEAN DEFAULT FALSE,
      score      INT DEFAULT 0,
      finished_at TIMESTAMPTZ
      );
    `);

    // ✅ Add chain_id column if missing (existing tables)
    await pool
      .query(
        `ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS chain_id INT DEFAULT 5042002`,
      )
      .catch(() => {});

    await pool
      .query(
        `
      ALTER TABLE game_sessions
      ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ
      `,
      )
      .catch(() => {});

    // ✅ Safely recreate the unique constraint with chain_id included
    await pool
      .query(
        `
      DO $$ BEGIN
     -- Drop old constraint without chain_id if it exists
     IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_sessions_user_id_game_id_key') THEN
      ALTER TABLE game_sessions DROP CONSTRAINT game_sessions_user_id_game_id_key;
      END IF;
      -- Drop new constraint if it exists (so we can recreate cleanly)
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gs_user_game_chain_unique') THEN
      ALTER TABLE game_sessions DROP CONSTRAINT gs_user_game_chain_unique;
      END IF;
      -- Add the correct constraint
      ALTER TABLE game_sessions ADD CONSTRAINT gs_user_game_chain_unique UNIQUE(user_id, game_id, chain_id);
      END $$;
    `,
      )
      .catch((e) => console.warn("Constraint migration:", e.message));

    await pool.query(`
        CREATE TABLE IF NOT EXISTS tournaments (
          id              SERIAL PRIMARY KEY,
          chain_id        INT NOT NULL DEFAULT 5042002,
          name            TEXT NOT NULL,
          creator         TEXT NOT NULL,
          entry_fee       NUMERIC(36,18) NOT NULL,
          token_symbol    TEXT NOT NULL DEFAULT 'USDC',
          max_players     INT NOT NULL DEFAULT 8,
          rounds          INT NOT NULL DEFAULT 3,
          current_round   INT DEFAULT 0,
          status          TEXT DEFAULT 'open',
          prize_pool      NUMERIC(36,18) DEFAULT 0,
          winner          TEXT,
          created_at      TIMESTAMPTZ DEFAULT NOW(),
          started_at      TIMESTAMPTZ,
          finished_at     TIMESTAMPTZ
        );
      `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS tournament_players (
          id              SERIAL PRIMARY KEY,
          tournament_id   INT REFERENCES tournaments(id) ON DELETE CASCADE,
          wallet          TEXT NOT NULL,
          user_id         INT REFERENCES users(id) ON DELETE CASCADE,
          total_score     INT DEFAULT 0,
          eliminated      BOOLEAN DEFAULT FALSE,
          joined_at       TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(tournament_id, wallet)
        );
      `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS tournament_rounds (
          id              SERIAL PRIMARY KEY,
          tournament_id   INT REFERENCES tournaments(id) ON DELETE CASCADE,
          round_number    INT NOT NULL,
          status          TEXT DEFAULT 'pending',
          started_at      TIMESTAMPTZ,
          finished_at     TIMESTAMPTZ,
          UNIQUE(tournament_id, round_number)
        );
      `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS tournament_scores (
          id              SERIAL PRIMARY KEY,
          tournament_id   INT REFERENCES tournaments(id) ON DELETE CASCADE,
          round_id        INT REFERENCES tournament_rounds(id) ON DELETE CASCADE,
          wallet          TEXT NOT NULL,
          score           INT DEFAULT 0,
          submitted_at    TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(tournament_id, round_id, wallet)
        );
      `);

    await pool
      .query(
        `ALTER TABLE tournament_scores ADD COLUMN IF NOT EXISTS time_taken INT DEFAULT 0`,
      )
      .catch(() => {});

    await pool.query(`
        CREATE TABLE IF NOT EXISTS tournament_join_attempts (
          wallet TEXT NOT NULL,
          attempted_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_join_attempts_wallet_time
        ON tournament_join_attempts (wallet, attempted_at);
      `);

    // =========================================================================
    // BETS
    // =========================================================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bets (
        id                  SERIAL PRIMARY KEY,
        user_id             INT REFERENCES users(id) ON DELETE CASCADE,
        game_id             INT NOT NULL,
        chain_id            INT DEFAULT 5042002,
        predicted_winner    TEXT NOT NULL,
        amount              NUMERIC(18,6) NOT NULL,
        settled             BOOLEAN DEFAULT FALSE,
        won                 BOOLEAN,
        created_at          TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // =========================================================================
    // GAMES (MULTICHAIN READY)
    // =========================================================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS games (
        id                  SERIAL PRIMARY KEY,
        chain_id            INT NOT NULL,
        contract_game_id    INT NOT NULL,
        creator             TEXT NOT NULL,
        name                TEXT NOT NULL,
        category            TEXT,
        difficulty          INT,
        entry_fee           NUMERIC(36,18),
        token_symbol        TEXT,
        max_players         INT,
        tx_hash             TEXT,
        status              INT DEFAULT 0,
        created_at          TIMESTAMPTZ DEFAULT NOW(),

        UNIQUE(chain_id, contract_game_id)
      );
    `);

    await pool
      .query(
        `ALTER TABLE games ADD COLUMN IF NOT EXISTS prize_pool NUMERIC(36,18) DEFAULT 0`,
      )
      .catch(() => {});

    // =========================================================================
    // // PLATFORM STATS
    // // =========================================================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_stats (
      id INT PRIMARY KEY DEFAULT 1,
      total_volume NUMERIC(36,18) DEFAULT 0,
      total_volume_litvm NUMERIC(36,18) DEFAULT 0
      );
    `);

    await pool
      .query(
        `ALTER TABLE platform_stats ADD COLUMN IF NOT EXISTS total_volume_litvm NUMERIC(36,18) DEFAULT 0`,
      )
      .catch(() => {});

    // TOURNAMENT CLAIMS TABLE
    await pool.query(`
  CREATE TABLE IF NOT EXISTS tournament_claims (
    id              SERIAL PRIMARY KEY,
    tournament_id   INT REFERENCES tournaments(id) ON DELETE CASCADE,
    wallet          TEXT NOT NULL,
    amount          NUMERIC(36,18),
    token_symbol    TEXT,
    status          TEXT DEFAULT 'pending',
    tx_hash         TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tournament_id, wallet)
  );
`);

    // ── WINNER CONTACTS — top-3 submit their X/Twitter so the host can reach them ──
    await pool.query(`
  CREATE TABLE IF NOT EXISTS tournament_winner_contacts (
    id            SERIAL PRIMARY KEY,
    tournament_id INT REFERENCES tournaments(id) ON DELETE CASCADE,
    wallet        TEXT NOT NULL,
    position      INT,
    twitter       TEXT,
    submitted_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tournament_id, wallet)
  );
`);

    await pool
      .query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS status INT DEFAULT 0`)
      .catch(() => {});

    // Tournament volume column
    await pool
      .query(
        `ALTER TABLE platform_stats ADD COLUMN IF NOT EXISTS tournament_volume NUMERIC(36,18) DEFAULT 0`,
      )
      .catch(() => {});

    // Tournament deadline
    await pool
      .query(
        `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ`,
      )
      .catch(() => {});

    // Tournament wins column
    await pool
      .query(
        `ALTER TABLE tournament_players ADD COLUMN IF NOT EXISTS prize_position INT DEFAULT -1`,
      )
      .catch(() => {});

    await pool
      .query(`ALTER TABLE game_refunds ADD COLUMN IF NOT EXISTS notes TEXT`)
      .catch(() => {});

    await pool
      .query(
        `ALTER TABLE games ADD COLUMN IF NOT EXISTS player_count INT DEFAULT 0`,
      )
      .catch(() => {});
    await pool
      .query(
        `ALTER TABLE games ADD COLUMN IF NOT EXISTS registration_end BIGINT DEFAULT 0`,
      )
      .catch(() => {});
    await pool
      .query(
        `ALTER TABLE games ADD COLUMN IF NOT EXISTS play_deadline BIGINT DEFAULT 0`,
      )
      .catch(() => {});
    await pool
      .query(
        `ALTER TABLE games ADD COLUMN IF NOT EXISTS finished_count INT DEFAULT 0`,
      )
      .catch(() => {});

    await pool
      .query(
        `ALTER TABLE games ADD COLUMN IF NOT EXISTS player_count INT DEFAULT 0`,
      )
      .catch(() => {});
    await pool
      .query(
        `ALTER TABLE games ADD COLUMN IF NOT EXISTS registration_end BIGINT DEFAULT 0`,
      )
      .catch(() => {});
    await pool
      .query(
        `ALTER TABLE games ADD COLUMN IF NOT EXISTS play_deadline BIGINT DEFAULT 0`,
      )
      .catch(() => {});
    await pool
      .query(
        `ALTER TABLE games ADD COLUMN IF NOT EXISTS finished_count INT DEFAULT 0`,
      )
      .catch(() => {});

    await pool.query(`
        CREATE TABLE IF NOT EXISTS submission_cooldowns (
          wallet      TEXT PRIMARY KEY,
          last_submit TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS genlayer_questions (
          id          SERIAL PRIMARY KEY,
          category    TEXT NOT NULL,
          difficulty  TEXT NOT NULL,
          data        JSONB NOT NULL,
          used        BOOLEAN DEFAULT FALSE,
          created_at  TIMESTAMPTZ DEFAULT NOW()
        );
      `);

    // =========================================================================
    // GAME QUESTIONS
    // =========================================================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_questions (
      id             SERIAL PRIMARY KEY,
      session_id     INT REFERENCES game_sessions(id) ON DELETE CASCADE,
      q_index        INT NOT NULL,
      correct_answer TEXT NOT NULL,
      question       TEXT,
      options        TEXT,
      UNIQUE(session_id, q_index)
    );
  `);

    await pool.query(`
    INSERT INTO platform_stats (id, total_volume)
    VALUES (1, 0)
    ON CONFLICT (id) DO NOTHING
  `);

    // ── PLATFORM TASKS (Twitter gate) ─────────────────────────────────────────
    await pool.query(`
  CREATE TABLE IF NOT EXISTS platform_tasks (
    id          SERIAL PRIMARY KEY,
    task_type   TEXT NOT NULL,
    label       TEXT NOT NULL,
    action_url  TEXT,
    action_text TEXT,
    is_active   BOOLEAN DEFAULT TRUE,
    target      TEXT DEFAULT 'all',
    created_at  TIMESTAMPTZ DEFAULT NOW()
  );
`);

    // ── USER TASK COMPLETIONS ──────────────────────────────────────────────────
    await pool.query(`
  CREATE TABLE IF NOT EXISTS user_task_completions (
    id          SERIAL PRIMARY KEY,
    user_id     INT REFERENCES users(id) ON DELETE CASCADE,
    task_id     INT REFERENCES platform_tasks(id) ON DELETE CASCADE,
    completed_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, task_id)
  );
`);

    // ── WHITELIST TOURNAMENTS ──────────────────────────────────────────────────
    await pool.query(`
  ALTER TABLE tournaments
    ADD COLUMN IF NOT EXISTS tournament_type TEXT DEFAULT 'paid',
    ADD COLUMN IF NOT EXISTS prize_1_text    TEXT DEFAULT '🥇 1st Place Prize',
    ADD COLUMN IF NOT EXISTS prize_2_text    TEXT DEFAULT '🥈 2nd Place Prize',
    ADD COLUMN IF NOT EXISTS prize_3_text    TEXT DEFAULT '🥉 3rd Place Prize',
    ADD COLUMN IF NOT EXISTS sponsor_name    TEXT,
    ADD COLUMN IF NOT EXISTS sponsor_logo    TEXT,
    ADD COLUMN IF NOT EXISTS discord_invite  TEXT;
`);

    // ✅ Add missing columns to existing table (safe to run multiple times)
    await pool
      .query(
        `ALTER TABLE game_questions ADD COLUMN IF NOT EXISTS question TEXT`,
      )
      .catch(() => {});
    await pool
      .query(
        `ALTER TABLE game_questions ADD COLUMN IF NOT EXISTS options  TEXT`,
      )
      .catch(() => {});
    await pool
      .query(
        `CREATE UNIQUE INDEX IF NOT EXISTS game_questions_session_qindex ON game_questions(session_id, q_index)`,
      )
      .catch(() => {});

    // Track tournament payment tx hashes for verification
    await pool
      .query(
        `ALTER TABLE tournament_players ADD COLUMN IF NOT EXISTS payment_tx TEXT`,
      )
      .catch(() => {});

    // Make google_id nullable
    await pool
      .query(
        `
      ALTER TABLE users
      ALTER COLUMN google_id DROP NOT NULL;
    `,
      )
      .catch(() => {});

    // Make email nullable
    await pool
      .query(
        `
      ALTER TABLE users
      ALTER COLUMN email DROP NOT NULL;
    `,
      )
      .catch(() => {});

    // Add nonce column safely
    await pool
      .query(
        `
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS nonce INT DEFAULT 0;
    `,
      )
      .catch(() => {});
    // ✅ Add missing columns to game_sessions (safe on existing tables)
    await pool
      .query(
        `ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS chain_id INT DEFAULT 5042002`,
      )
      .catch(() => {});

    console.log("✅ Database ready");
  } catch (e) {
    console.error("❌ DB INIT ERROR:", e);
  }
}
initDB().catch(console.error);

// ── Rate limiters ─────────────────────────────────────────────────────────────
app.use(
  rateLimit({
    windowMs: 60000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

const scoreLimiter = rateLimit({
  windowMs: 60000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many submissions",
  },
});

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "https://triviafi.xyz",
  "https://www.triviafi.xyz",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) cb(null, true);
      else cb(new Error("CORS blocked: " + origin));
    },
    credentials: true,
  }),
);

app.use(cookieParser());

app.use(express.json({ limit: "512kb" }));

// ── Session ───────────────────────────────────────────────────────────────────
const PgSession = pgSessionFactory(session);

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true,
      pruneSessionInterval: 60 * 15,
    }),
    secret: process.env.SESSION_SECRET || "fallback-dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  }),
);

app.use(passport.initialize());
app.use(passport.session());

// ── Passport: Google ──────────────────────────────────────────────────────────
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:
        process.env.GOOGLE_CALLBACK_URL ||
        `http://localhost:${process.env.PORT || 4000}/auth/google/callback`,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;
        const avatar = profile.photos?.[0]?.value || null;
        const displayName = profile.displayName;

        // 1. Try find by google_id (returning user)
        let existing = await pool.query(
          "SELECT * FROM users WHERE google_id=$1",
          [profile.id],
        );

        if (existing.rows.length > 0) {
          // Update name/avatar in case they changed
          const updated = await pool.query(
            `UPDATE users SET display_name=$1, avatar=$2, email=$3
           WHERE google_id=$4 RETURNING *`,
            [displayName, avatar, email, profile.id],
          );
          return done(null, updated.rows[0]);
        }

        // 2. Try find by email (wallet-only user upgrading to Google login)

        if (email) {
          existing = await pool.query("SELECT * FROM users WHERE email=$1", [
            email,
          ]);
          if (existing.rows.length > 0) {
            // ✅ Block: this Google account already has a google_id linked (already used)
            if (
              existing.rows[0].google_id &&
              existing.rows[0].google_id !== profile.id
            ) {
              return done(null, false, { message: "google_taken" });
            }
            // ✅ Block: this Google account is already linked to a DIFFERENT wallet
            const googleAlreadyUsed = await pool.query(
              "SELECT id, wallet FROM users WHERE google_id=$1 AND id!=$2",
              [profile.id, existing.rows[0].id],
            );
            if (googleAlreadyUsed.rows.length > 0) {
              return done(null, false, { message: "google_taken" });
            }
            // MERGE: link Google to existing wallet-only account
            const merged = await pool.query(
              `UPDATE users SET google_id=$1, display_name=$2, avatar=$3
              WHERE id=$4 RETURNING *`,
              [profile.id, displayName, avatar, existing.rows[0].id],
            );
            return done(null, merged.rows[0]);
          }
        }

        // 3. New user — create Google account
        const created = await pool.query(
          `INSERT INTO users (google_id, email, display_name, avatar)
         VALUES ($1,$2,$3,$4) RETURNING *`,
          [profile.id, email, displayName, avatar],
        );
        return done(null, created.rows[0]);
      } catch (e) {
        return done(e);
      }
    },
  ),
);

passport.serializeUser((u, done) => done(null, u.id));
passport.deserializeUser(async (id, done) => {
  try {
    const r = await pool.query("SELECT * FROM users WHERE id=$1", [id]);
    done(null, r.rows[0] || null);
  } catch (e) {
    done(e);
  }
});

// =============================================================================
// AUTH ROUTES
// =============================================================================

app.get("/csrf-token", csrfProtection, (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

app.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] }),
);

app.get("/games", async (req, res) => {
  try {
    const chainId = req.query.chainId ? parseInt(req.query.chainId) : null;
    const limit = Math.min(parseInt(req.query.limit || "100"), 100);
    let result;
    if (chainId) {
      result = await pool.query(
        `SELECT * FROM games WHERE chain_id=$1 ORDER BY contract_game_id DESC LIMIT $2`,
        [chainId, limit],
      );
    } else {
      result = await pool.query(
        `SELECT * FROM games ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
    }
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Add this right after:
app.get("/games/count", async (req, res) => {
  try {
    const chainId = req.query.chainId ? parseInt(req.query.chainId) : null;
    const result = chainId
      ? await pool.query(
          `SELECT COUNT(*) as count FROM games WHERE chain_id=$1`,
          [chainId],
        )
      : await pool.query(`SELECT COUNT(*) as count FROM games`);
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/games/save", csrfProtection, async (req, res) => {
  try {
    const {
      chainId,
      contractGameId,
      creator,
      name,
      category,
      difficulty,
      entryFee,
      tokenSymbol,
      maxPlayers,
      txHash,
      prizePool,
      status,
      playerCount,
      registrationEnd,
      playDeadline,
      finishedCount,
    } = req.body;

    const cleanName = sanitizeHtml(name, {
      allowedTags: [],
      allowedAttributes: {},
    });

    await pool.query(
      `INSERT INTO games (chain_id,contract_game_id,creator,name,category,
        difficulty,entry_fee,token_symbol,max_players,tx_hash,prize_pool,status,
        player_count,registration_end,play_deadline,finished_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,0),$13,$14,$15,$16)
      ON CONFLICT (chain_id,contract_game_id)
      DO UPDATE SET
        prize_pool      = EXCLUDED.prize_pool,
        status          = COALESCE(EXCLUDED.status, games.status),
        player_count    = COALESCE(EXCLUDED.player_count, games.player_count),
        registration_end = COALESCE(EXCLUDED.registration_end, games.registration_end),
        play_deadline   = COALESCE(EXCLUDED.play_deadline, games.play_deadline),
        finished_count  = COALESCE(EXCLUDED.finished_count, games.finished_count)`,
      [
        chainId,
        contractGameId,
        creator,
        cleanName,
        category,
        difficulty,
        entryFee,
        tokenSymbol,
        maxPlayers,
        txHash,
        prizePool || 0,
        req.body.status ?? null,
        playerCount ?? null,
        registrationEnd ?? null,
        playDeadline ?? null,
        finishedCount ?? null,
      ],
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/stats", async (req, res) => {
  try {
    const totalVolumeResult = await pool.query(
      `SELECT total_volume FROM platform_stats WHERE id = 1`,
    );
    res.json({
      totalVolume: totalVolumeResult.rows[0]?.total_volume || 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Unclaimed bet winnings for a wallet
app.get("/bets/unclaimed/:wallet", async (req, res) => {
  try {
    const { wallet } = req.params;
    const result = await pool.query(
      `
      SELECT b.id, b.game_id, b.amount, b.winnings, b.chain_id,
             g.name as game_name
      FROM bets b
      LEFT JOIN games g ON g.contract_game_id = b.game_id AND g.chain_id = b.chain_id
      WHERE LOWER(b.wallet) = LOWER($1)
        AND b.won = true
        AND b.claimed = false
        AND b.winnings > 0
    `,
      [wallet],
    );
    res.json(result.rows);
  } catch (e) {
    res.json([]);
  }
});

app.get("/history/:wallet", async (req, res) => {
  try {
    const wallet = req.params.wallet.toLowerCase();

    const result = await pool.query(
      `
      SELECT g.*
      FROM game_sessions gs
      JOIN games g
      ON g.contract_game_id = gs.game_id
      AND g.chain_id = gs.chain_id
      WHERE LOWER(gs.wallet)=LOWER($1)
      ORDER BY gs.started_at DESC
      `,
      [wallet],
    );

    res.json(result.rows);
  } catch (e) {
    res.status(500).json({
      error: e.message,
    });
  }
});

app.get(
  "/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: `${process.env.FRONTEND_URL}?auth=google_taken`,
    failureMessage: true,
  }),
  (req, res) => {
    if (!req.user.username)
      return res.redirect(`${process.env.FRONTEND_URL}?auth=setup`);
    res.redirect(`${process.env.FRONTEND_URL}?auth=success`);
  },
);

app.get("/auth/logout", (req, res) => {
  req.logout(() => res.json({ ok: true }));
});

app.get("/auth/me", (req, res) => {
  res.json({ user: req.user || null });
});

// ── Wallet login / register ───────────────────────────────────────────────────
// Called after MetaMask connect. Signs in the user by wallet.
// If a Google session already exists, links the wallet to that account.
app.post("/auth/wallet", csrfProtection, async (req, res) => {
  const { wallet, signature } = req.body;

  if (!wallet || !signature)
    return res.status(400).json({ error: "Missing wallet or signature" });
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet))
    return res.status(400).json({ error: "Invalid wallet" });

  try {
    // Verify signature
    const message = `Login to ${req.body.networkName || "TriviaFi"}`;
    const recovered = ethers.verifyMessage(message, signature);
    if (recovered.toLowerCase() !== wallet.toLowerCase())
      return res.status(403).json({ error: "Invalid signature" });

    const walletLower = wallet.toLowerCase();

    // ── Case 1: Google session exists → link wallet to Google account ────────
    if (req.user) {
      const currentUser = req.user;

      if (
        currentUser.wallet &&
        currentUser.wallet.toLowerCase() !== walletLower
      ) {
        return res.status(400).json({
          error: `Account already linked to wallet ${currentUser.wallet.slice(
            0,
            6,
          )}...`,
        });
      }

      if (!currentUser.wallet) {
        // Check wallet isn't taken by another account
        const taken = await pool.query(
          "SELECT id, google_id FROM users WHERE LOWER(wallet)=$1 AND id!=$2",
          [walletLower, currentUser.id],
        );
        if (taken.rows.length > 0) {
          // ✅ If that account has a Google linked, block with specific message
          if (taken.rows[0].google_id) {
            return res.status(400).json({ error: "wallet_google_taken" });
          }
          return res
            .status(400)
            .json({ error: "Wallet already linked to another account" });
        }

        await pool.query("UPDATE users SET wallet=$1 WHERE id=$2", [
          walletLower,
          currentUser.id,
        ]);
      }

      const updated = await pool.query("SELECT * FROM users WHERE id=$1", [
        currentUser.id,
      ]);
      return req.login(updated.rows[0], () =>
        res.json({ user: updated.rows[0] }),
      );
    }

    // ── Case 2: No Google session — find or create wallet-only user ──────────
    let userRow = await pool.query(
      "SELECT * FROM users WHERE LOWER(wallet)=$1",
      [walletLower],
    );

    if (userRow.rows.length === 0) {
      // ✅ Check if this wallet is already in a Google-linked account
      const googleLinked = await pool.query(
        "SELECT id FROM users WHERE LOWER(wallet)=$1 AND google_id IS NOT NULL",
        [walletLower],
      );
      if (googleLinked.rows.length > 0) {
        return res.status(400).json({ error: "wallet_google_taken" });
      }
      // Create new wallet-only user
      userRow = await pool.query(
        "INSERT INTO users (wallet) VALUES ($1) RETURNING *",
        [walletLower],
      );
    }

    req.login(userRow.rows[0], () => res.json({ user: userRow.rows[0] }));
  } catch (e) {
    console.error("Wallet auth error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// PROFILE ROUTES
// =============================================================================

app.post("/profile/setup", csrfProtection, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  const { username, wallet } = req.body;
  if (!username || username.length < 3 || username.length > 20)
    return res.status(400).json({ error: "Username 3-20 chars" });
  if (!/^[a-zA-Z0-9_]+$/.test(username))
    return res.status(400).json({ error: "Letters, numbers, underscore only" });
  if (wallet && !/^0x[a-fA-F0-9]{40}$/.test(wallet))
    return res.status(400).json({ error: "Invalid wallet" });
  try {
    const r = await pool.query(
      "UPDATE users SET username=$1, wallet=COALESCE($2, wallet) WHERE id=$3 RETURNING *",
      [username.toLowerCase(), wallet?.toLowerCase() || null, req.user.id],
    );
    req.login(r.rows[0], () => res.json({ user: r.rows[0] }));
  } catch (e) {
    if (e.code === "23505")
      return res.status(400).json({ error: "Username or wallet taken" });
    res.status(500).json({ error: e.message });
  }
});

// Link wallet to existing Google account (requires signature)
app.post("/profile/wallet", csrfProtection, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  const { wallet, signature } = req.body;

  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet))
    return res.status(400).json({ error: "Invalid wallet" });
  if (!signature) return res.status(400).json({ error: "Signature required" });

  try {
    const message = `Link wallet to ${
      req.body.networkName || "TriviaFi"
    } account`;
    const recovered = ethers.verifyMessage(message, signature);
    if (recovered.toLowerCase() !== wallet.toLowerCase())
      return res.status(403).json({ error: "Invalid signature" });

    const walletLower = wallet.toLowerCase();

    // Check wallet not taken by another user
    const taken = await pool.query(
      "SELECT id FROM users WHERE LOWER(wallet)=$1 AND id!=$2",
      [walletLower, req.user.id],
    );
    if (taken.rows.length > 0)
      return res
        .status(400)
        .json({ error: "Wallet already linked to another account" });

    const r = await pool.query(
      "UPDATE users SET wallet=$1 WHERE id=$2 RETURNING *",
      [walletLower, req.user.id],
    );
    req.login(r.rows[0], () => res.json({ user: r.rows[0] }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/profile/avatar", csrfProtection, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  const { avatar } = req.body;
  if (!avatar) return res.status(400).json({ error: "No avatar" });
  if (avatar.startsWith("data:")) {
    return res.status(400).json({
      error: "Use image URL only",
    });
  }
  let url;

  try {
    url = new URL(avatar);
  } catch {
    return res.status(400).json({
      error: "Invalid URL",
    });
  }

  const allowedDomains = [
    "i.imgur.com",
    "cdn.discordapp.com",
    "lh3.googleusercontent.com",
  ];

  if (url.protocol !== "https:") {
    return res.status(400).json({
      error: "Only HTTPS images allowed",
    });
  }

  if (!allowedDomains.includes(url.hostname)) {
    return res.status(400).json({
      error: "Invalid image host",
    });
  }
  if (avatar.length > 500) {
    return res.status(400).json({
      error: "Avatar URL too long",
    });
  }
  if (avatar.startsWith("data:image/") && avatar.length > 200000)
    return res.status(400).json({ error: "Image too large — use a URL" });
  try {
    const r = await pool.query(
      "UPDATE users SET avatar=$1 WHERE id=$2 RETURNING *",
      [avatar, req.user.id],
    );
    req.login(r.rows[0], () => res.json({ user: r.rows[0] }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/profile/by-wallet/:wallet", async (req, res) => {
  if (!/^0x[a-fA-F0-9]{40}$/.test(req.params.wallet))
    return res.status(400).json({ error: "Invalid wallet" });
  try {
    const r = await pool.query(
      "SELECT id, google_id, username, display_name, avatar FROM users WHERE LOWER(wallet)=LOWER($1)",
      [req.params.wallet],
    );
    res.json(r.rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/profile/resolve", async (req, res) => {
  const { wallets } = req.body;
  if (!Array.isArray(wallets) || wallets.length === 0) return res.json({});
  if (wallets.length > 50)
    return res.status(400).json({ error: "Too many wallets" });
  try {
    const r = await pool.query(
      "SELECT wallet, username, avatar FROM users WHERE LOWER(wallet)=ANY($1)",
      [wallets.map((w) => w.toLowerCase())],
    );
    const map = {};
    r.rows.forEach((row) => {
      map[row.wallet.toLowerCase()] = row;
    });
    res.json(map);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

if (process.env.NODE_ENV !== "production") {
  app.get("/debug/nonce/:wallet", async (req, res) => {
    const wallet = req.params.wallet;
    try {
      // Use withRetry which IS globally defined
      const onchainNonce = await withRetry(
        (c) => c.nonces(wallet),
        "debugNonce",
      );
      const dbRow = await pool.query(
        "SELECT nonce FROM users WHERE LOWER(wallet)=$1",
        [wallet.toLowerCase()],
      );
      res.json({
        onchain: onchainNonce.toString(),
        db: dbRow.rows[0]?.nonce || 0,
      });
    } catch (e) {
      res.json({ error: e.message });
    }
  });
}

if (process.env.NODE_ENV !== "production") {
  app.get("/debug/contract", async (req, res) => {
    try {
      const p = makeProvider();
      // Try different nonce function names
      const tests = {};

      const wallet = "0xB2821e9a602C4Fab6d30c9A85D8F24a1935B1ed6";

      // Test gameCounter (we know this works)
      try {
        const c1 = new ethers.Contract(
          CONTRACT_ADDRESS,
          ["function gameCounter() view returns (uint256)"],
          p,
        );
        tests.gameCounter = (await c1.gameCounter()).toString();
      } catch (e) {
        tests.gameCounter = "FAILED: " + e.message;
      }

      // Test getNonce
      try {
        const c2 = new ethers.Contract(
          CONTRACT_ADDRESS,
          ["function getNonce(address) view returns (uint256)"],
          p,
        );
        tests.getNonce = (await c2.getNonce(wallet)).toString();
      } catch (e) {
        tests.getNonce = "FAILED: " + e.message;
      }

      // Test nonces
      try {
        const c3 = new ethers.Contract(
          CONTRACT_ADDRESS,
          ["function nonces(address) view returns (uint256)"],
          p,
        );
        tests.nonces = (await c3.nonces(wallet)).toString();
      } catch (e) {
        tests.nonces = "FAILED: " + e.message;
      }

      // Test playerNonces
      try {
        const c4 = new ethers.Contract(
          CONTRACT_ADDRESS,
          ["function playerNonces(address) view returns (uint256)"],
          p,
        );
        tests.playerNonces = (await c4.playerNonces(wallet)).toString();
      } catch (e) {
        tests.playerNonces = "FAILED: " + e.message;
      }

      res.json(tests);
    } catch (e) {
      res.json({ error: e.message });
    }
  });
}

app.get("/profile/check/:username", async (req, res) => {
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(req.params.username))
    return res.json({ available: false });
  try {
    const r = await pool.query("SELECT id FROM users WHERE username=$1", [
      req.params.username.toLowerCase(),
    ]);
    res.json({ available: r.rows.length === 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// GAME ROUTES
// =============================================================================
app.get("/game/status/:gameId", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });

  const gameId = parseInt(req.params.gameId);
  const chainId = parseInt(req.query.chainId || "5042002");
  const isLitvm = chainId === 4441;

  try {
    const statusProvider = isLitvm ? makeLitvmProvider() : makeProvider();
    const statusContractAddr = isLitvm
      ? LITVM_CONTRACT_ADDRESS
      : CONTRACT_ADDRESS;
    const statusContract = new ethers.Contract(
      statusContractAddr,
      [
        "function getGame(uint256) view returns (tuple(uint256 id,string name,address creator,uint8 categoryId,string categoryName,uint8 difficulty,uint256 entryFee,uint256 maxPlayers,uint256 prizePool,uint256 playerCount,uint256 registrationEnd,uint256 playDeadline,address[3] topPlayers,bool prizeClaimed,uint8 status,uint256 finishedCount))",
      ],
      statusProvider,
    );

    const game = await Promise.race([
      statusContract.getGame(gameId),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 10000),
      ),
    ]);

    const status = Number(game.status);

    const r = await pool.query(
      "SELECT finished FROM game_sessions WHERE user_id=$1 AND game_id=$2",
      [req.user.id, gameId],
    );

    // Check if actually finished onchain
    let onchain = false;
    try {
      const retryFn = isLitvm ? withLitvmRetry : withRetry;
      const [, alreadyFinishedOnchain] = await retryFn(
        (c) =>
          c.getPlayerStatus(
            gameId,
            req.user.wallet || "0x0000000000000000000000000000000000000000",
          ),
        "checkOnchain",
      );
      onchain = alreadyFinishedOnchain;
    } catch (_) {}
    return res.json({
      status,
      played: r.rows.length > 0,
      finished: r.rows[0]?.finished || false,
      score: r.rows[0]?.score || 0,
      onchain,
    });
  } catch (e) {
    console.error("Game status error:", e.message);
    return res.status(500).json({ error: "Server error" });
  }
});

if (process.env.NODE_ENV !== "production") {
  app.get("/debug/rpc", async (req, res) => {
    const results = {};
    const rpcs = [
      "https://rpc.testnet.arc.network",
      "https://arc-testnet.drpc.org",
    ];
    for (const rpc of rpcs) {
      try {
        const p = new ethers.JsonRpcProvider(rpc, {
          chainId: 5042002,
          name: "arc-testnet",
        });
        const block = await Promise.race([
          p.getBlockNumber(),
          new Promise((_, r) =>
            setTimeout(() => r(new Error("timeout")), 5000),
          ),
        ]);
        const c = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, p);
        const nonce = await Promise.race([
          c.getNonce("0x52F6dE1118a3c22CBF04f7d811B08034DCF21E50"),
          new Promise((_, r) =>
            setTimeout(() => r(new Error("timeout")), 5000),
          ),
        ]);
        results[rpc] = { ok: true, block, nonce: nonce.toString() };
      } catch (e) {
        results[rpc] = { ok: false, error: e.message };
      }
    }
    res.json(results);
  });
}

// ✅ LOCAL QUESTION BANK — 200 questions across categories
// Used when OpenTDB is unavailable. Prevents "No questions available" errors.
const LOCAL_QUESTIONS = {
  9: [
    // General Knowledge
    {
      q: "What is the capital of Australia?",
      correct: "Canberra",
      wrong: ["Sydney", "Melbourne", "Perth"],
    },
    {
      q: "How many sides does a hexagon have?",
      correct: "6",
      wrong: ["5", "7", "8"],
    },
    {
      q: "Which planet is known as the Red Planet?",
      correct: "Mars",
      wrong: ["Jupiter", "Venus", "Saturn"],
    },
    {
      q: "What is the largest ocean on Earth?",
      correct: "Pacific Ocean",
      wrong: ["Atlantic Ocean", "Indian Ocean", "Arctic Ocean"],
    },
    {
      q: "Who painted the Mona Lisa?",
      correct: "Leonardo da Vinci",
      wrong: ["Michelangelo", "Raphael", "Donatello"],
    },
    {
      q: "What is the chemical symbol for gold?",
      correct: "Au",
      wrong: ["Go", "Gd", "Ag"],
    },
    {
      q: "How many bones are in the adult human body?",
      correct: "206",
      wrong: ["195", "213", "220"],
    },
    {
      q: "What year did World War II end?",
      correct: "1945",
      wrong: ["1943", "1944", "1946"],
    },
    {
      q: "What is the smallest country in the world?",
      correct: "Vatican City",
      wrong: ["Monaco", "San Marino", "Liechtenstein"],
    },
    {
      q: "Which element has the atomic number 1?",
      correct: "Hydrogen",
      wrong: ["Helium", "Oxygen", "Carbon"],
    },
    {
      q: "What is the fastest land animal?",
      correct: "Cheetah",
      wrong: ["Lion", "Leopard", "Gazelle"],
    },
    {
      q: "In what country was pizza invented?",
      correct: "Italy",
      wrong: ["Greece", "France", "Spain"],
    },
    {
      q: "What is the longest river in the world?",
      correct: "Nile",
      wrong: ["Amazon", "Mississippi", "Yangtze"],
    },
    {
      q: "How many continents are there?",
      correct: "7",
      wrong: ["5", "6", "8"],
    },
    {
      q: "What gas do plants absorb from the atmosphere?",
      correct: "Carbon Dioxide",
      wrong: ["Oxygen", "Nitrogen", "Hydrogen"],
    },
  ],
  17: [
    // Science
    {
      q: "What is the speed of light?",
      correct: "299,792,458 m/s",
      wrong: ["300,000,000 m/s", "199,792,458 m/s", "399,792,458 m/s"],
    },
    {
      q: "What is the powerhouse of the cell?",
      correct: "Mitochondria",
      wrong: ["Nucleus", "Ribosome", "Golgi Apparatus"],
    },
    {
      q: "What planet has the most moons?",
      correct: "Saturn",
      wrong: ["Jupiter", "Uranus", "Neptune"],
    },
    {
      q: "What is the hardest natural substance?",
      correct: "Diamond",
      wrong: ["Ruby", "Quartz", "Topaz"],
    },
    {
      q: "What force keeps planets in orbit?",
      correct: "Gravity",
      wrong: ["Magnetism", "Friction", "Centripetal force"],
    },
    {
      q: "How many chromosomes do humans have?",
      correct: "46",
      wrong: ["23", "48", "44"],
    },
    {
      q: "What is H2O commonly known as?",
      correct: "Water",
      wrong: ["Hydrogen Peroxide", "Oxygen", "Salt water"],
    },
    {
      q: "What is the center of an atom called?",
      correct: "Nucleus",
      wrong: ["Electron", "Proton", "Neutron"],
    },
    {
      q: "Which gas makes up most of Earth's atmosphere?",
      correct: "Nitrogen",
      wrong: ["Oxygen", "Carbon Dioxide", "Argon"],
    },
    {
      q: "What is the boiling point of water at sea level?",
      correct: "100°C",
      wrong: ["90°C", "110°C", "95°C"],
    },
    {
      q: "What type of energy does the sun produce?",
      correct: "Nuclear energy",
      wrong: ["Chemical energy", "Mechanical energy", "Electrical energy"],
    },
    {
      q: "What is DNA short for?",
      correct: "Deoxyribonucleic acid",
      wrong: [
        "Dioxyribonucleic acid",
        "Diribonucleic acid",
        "Deoxyribose acid",
      ],
    },
    {
      q: "What is the process by which plants make food?",
      correct: "Photosynthesis",
      wrong: ["Respiration", "Fermentation", "Digestion"],
    },
    {
      q: "How many planets are in our solar system?",
      correct: "8",
      wrong: ["7", "9", "10"],
    },
    {
      q: "What is the study of earthquakes called?",
      correct: "Seismology",
      wrong: ["Geology", "Volcanology", "Meteorology"],
    },
  ],
  23: [
    // History
    {
      q: "In what year did the Berlin Wall fall?",
      correct: "1989",
      wrong: ["1987", "1991", "1985"],
    },
    {
      q: "Who was the first President of the United States?",
      correct: "George Washington",
      wrong: ["John Adams", "Thomas Jefferson", "Benjamin Franklin"],
    },
    {
      q: "Which empire was the largest in history?",
      correct: "British Empire",
      wrong: ["Roman Empire", "Mongol Empire", "Ottoman Empire"],
    },
    {
      q: "In what year did World War I begin?",
      correct: "1914",
      wrong: ["1912", "1916", "1918"],
    },
    {
      q: "Who discovered America?",
      correct: "Christopher Columbus",
      wrong: ["Amerigo Vespucci", "Leif Erikson", "Vasco da Gama"],
    },
    {
      q: "What ancient wonder was located in Alexandria?",
      correct: "The Lighthouse of Alexandria",
      wrong: ["The Colossus", "The Hanging Gardens", "The Temple of Artemis"],
    },
    {
      q: "When was the Magna Carta signed?",
      correct: "1215",
      wrong: ["1066", "1314", "1415"],
    },
    {
      q: "Who was Napoleon Bonaparte?",
      correct: "French Emperor",
      wrong: ["British General", "Russian Tsar", "Spanish King"],
    },
    {
      q: "In what year did the Titanic sink?",
      correct: "1912",
      wrong: ["1910", "1914", "1916"],
    },
    {
      q: "Which country first landed on the moon?",
      correct: "United States",
      wrong: ["Soviet Union", "China", "United Kingdom"],
    },
    {
      q: "Who wrote the Declaration of Independence?",
      correct: "Thomas Jefferson",
      wrong: ["George Washington", "John Adams", "Benjamin Franklin"],
    },
    {
      q: "What was the name of Hitler's political party?",
      correct: "Nazi Party",
      wrong: ["Communist Party", "Fascist Party", "Conservative Party"],
    },
    {
      q: "When did the French Revolution begin?",
      correct: "1789",
      wrong: ["1776", "1799", "1804"],
    },
    {
      q: "Who was Cleopatra?",
      correct: "Queen of Egypt",
      wrong: ["Queen of Rome", "Queen of Greece", "Queen of Persia"],
    },
    {
      q: "What year did the Cold War end?",
      correct: "1991",
      wrong: ["1989", "1985", "1993"],
    },
  ],
  15: [
    // Video Games
    {
      q: "What company created Mario?",
      correct: "Nintendo",
      wrong: ["Sega", "Atari", "Sony"],
    },
    {
      q: "In what game do you 'catch them all'?",
      correct: "Pokémon",
      wrong: ["Digimon", "Yo-kai Watch", "Monster Hunter"],
    },
    {
      q: "What is the best-selling video game of all time?",
      correct: "Minecraft",
      wrong: ["Tetris", "GTA V", "Wii Sports"],
    },
    {
      q: "Who is the main character in The Legend of Zelda?",
      correct: "Link",
      wrong: ["Zelda", "Ganon", "Impa"],
    },
    {
      q: "What color is Sonic the Hedgehog?",
      correct: "Blue",
      wrong: ["Red", "Green", "Yellow"],
    },
    {
      q: "In Fortnite, how many players compete in a match?",
      correct: "100",
      wrong: ["50", "150", "200"],
    },
    {
      q: "What is the currency in Animal Crossing?",
      correct: "Bells",
      wrong: ["Coins", "Rupees", "Gold"],
    },
    {
      q: "Which game features the character Master Chief?",
      correct: "Halo",
      wrong: ["Call of Duty", "Gears of War", "Destiny"],
    },
    {
      q: "What year was the original PlayStation released?",
      correct: "1994",
      wrong: ["1993", "1995", "1996"],
    },
    {
      q: "Which company makes the Xbox?",
      correct: "Microsoft",
      wrong: ["Sony", "Nintendo", "Sega"],
    },
    {
      q: "What game popularized the battle royale genre?",
      correct: "PUBG",
      wrong: ["Fortnite", "Apex Legends", "H1Z1"],
    },
    {
      q: "What is the max level in most Pokémon games?",
      correct: "100",
      wrong: ["50", "99", "150"],
    },
    {
      q: "In Minecraft, what do you need to create a Nether portal?",
      correct: "Obsidian",
      wrong: ["Diamond", "Gold", "Lava"],
    },
    {
      q: "What genre is Dark Souls?",
      correct: "Action RPG",
      wrong: ["Turn-based RPG", "Strategy", "Platformer"],
    },
    {
      q: "Who is the villain in most Mario games?",
      correct: "Bowser",
      wrong: ["Wario", "Koopa", "Kamek"],
    },
  ],
  22: [
    // Geography
    {
      q: "What is the capital of Japan?",
      correct: "Tokyo",
      wrong: ["Osaka", "Kyoto", "Hiroshima"],
    },
    {
      q: "Which country has the most natural lakes?",
      correct: "Canada",
      wrong: ["Russia", "United States", "Brazil"],
    },
    {
      q: "What is the tallest mountain in the world?",
      correct: "Mount Everest",
      wrong: ["K2", "Mont Blanc", "Kilimanjaro"],
    },
    {
      q: "Which country is the largest by area?",
      correct: "Russia",
      wrong: ["Canada", "China", "United States"],
    },
    {
      q: "What is the capital of Brazil?",
      correct: "Brasília",
      wrong: ["São Paulo", "Rio de Janeiro", "Salvador"],
    },
    {
      q: "Which desert is the largest in the world?",
      correct: "Sahara",
      wrong: ["Gobi", "Arabian", "Antarctic"],
    },
    {
      q: "What river flows through Egypt?",
      correct: "Nile",
      wrong: ["Amazon", "Congo", "Tigris"],
    },
    {
      q: "Which country has the most population?",
      correct: "India",
      wrong: ["China", "United States", "Indonesia"],
    },
    {
      q: "What is the capital of France?",
      correct: "Paris",
      wrong: ["Lyon", "Marseille", "Bordeaux"],
    },
    {
      q: "Which ocean is the smallest?",
      correct: "Arctic Ocean",
      wrong: ["Indian Ocean", "Atlantic Ocean", "Southern Ocean"],
    },
    {
      q: "What country has the longest coastline?",
      correct: "Canada",
      wrong: ["Russia", "Australia", "Norway"],
    },
    {
      q: "What is the capital of Germany?",
      correct: "Berlin",
      wrong: ["Munich", "Hamburg", "Frankfurt"],
    },
    {
      q: "In which continent is the Amazon rainforest?",
      correct: "South America",
      wrong: ["Africa", "Asia", "Central America"],
    },
    {
      q: "What is the smallest continent?",
      correct: "Australia",
      wrong: ["Europe", "Antarctica", "South America"],
    },
    {
      q: "Which country owns Greenland?",
      correct: "Denmark",
      wrong: ["Norway", "Iceland", "Canada"],
    },
  ],
  18: [
    // Computers
    {
      q: "What does CPU stand for?",
      correct: "Central Processing Unit",
      wrong: [
        "Computer Processing Unit",
        "Central Program Unit",
        "Core Processing Unit",
      ],
    },
    {
      q: "Who founded Microsoft?",
      correct: "Bill Gates",
      wrong: ["Steve Jobs", "Mark Zuckerberg", "Elon Musk"],
    },
    {
      q: "What does HTML stand for?",
      correct: "HyperText Markup Language",
      wrong: [
        "HyperText Machine Language",
        "HighText Markup Language",
        "HyperText Model Language",
      ],
    },
    {
      q: "What programming language is known for web development?",
      correct: "JavaScript",
      wrong: ["Python", "Java", "C++"],
    },
    {
      q: "What is the most popular operating system?",
      correct: "Windows",
      wrong: ["macOS", "Linux", "Android"],
    },
    {
      q: "What does RAM stand for?",
      correct: "Random Access Memory",
      wrong: [
        "Read Access Memory",
        "Random Application Memory",
        "Read Application Memory",
      ],
    },
    {
      q: "Who invented the World Wide Web?",
      correct: "Tim Berners-Lee",
      wrong: ["Bill Gates", "Steve Jobs", "Vint Cerf"],
    },
    {
      q: "What is the binary representation of the number 5?",
      correct: "101",
      wrong: ["110", "100", "111"],
    },
    {
      q: "What does URL stand for?",
      correct: "Uniform Resource Locator",
      wrong: [
        "Universal Resource Locator",
        "Unified Resource Link",
        "Universal Reference Link",
      ],
    },
    {
      q: "What company created the Android operating system?",
      correct: "Google",
      wrong: ["Apple", "Samsung", "Microsoft"],
    },
    {
      q: "What is the shortcut to copy in most applications?",
      correct: "Ctrl+C",
      wrong: ["Ctrl+V", "Ctrl+X", "Ctrl+Z"],
    },
    {
      q: "Which programming language was created by Guido van Rossum?",
      correct: "Python",
      wrong: ["Ruby", "Perl", "Java"],
    },
    {
      q: "What does USB stand for?",
      correct: "Universal Serial Bus",
      wrong: [
        "Unified Serial Bus",
        "Universal System Bus",
        "Unified System Bus",
      ],
    },
    {
      q: "What is the file extension for a Python file?",
      correct: ".py",
      wrong: [".python", ".pt", ".pyc"],
    },
    {
      q: "What does SSD stand for?",
      correct: "Solid State Drive",
      wrong: [
        "Super Speed Drive",
        "Static Storage Device",
        "System Storage Drive",
      ],
    },
  ],
};

// Fallback: use general knowledge for unmapped categories
const DEFAULT_CAT = 9;

function getLocalQuestions(catId, diff, count = 10) {
  const bank = LOCAL_QUESTIONS[catId] || LOCAL_QUESTIONS[DEFAULT_CAT];
  // Shuffle and pick `count` questions
  const shuffled = [...bank].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

app.post("/game/start", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });

  const {
    gameId,
    wallet,
    categoryId,
    difficulty,
    chainId: reqChainId,
    correctAnswers,
  } = req.body;
  const chainId = parseInt(reqChainId || "5042002");
  const isLitvm = chainId === 4441;
  const retryFn = isLitvm ? withLitvmRetry : withRetry;
  if (!gameId || !wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet))
    return res.status(400).json({ error: "Invalid fields" });

  try {
    // Re-fetch fresh user from DB
    const freshUser = await pool.query("SELECT * FROM users WHERE id=$1", [
      req.user.id,
    ]);
    const dbUser = freshUser.rows[0];
    if (!dbUser) return res.status(401).json({ error: "User not found" });

    if (!dbUser.wallet) {
      await pool.query("UPDATE users SET wallet=$1 WHERE id=$2", [
        wallet.toLowerCase(),
        req.user.id,
      ]);
    } else if (dbUser.wallet.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(403).json({ error: "Wallet mismatch" });
    }

    // ── Anti-bot: check account age before starting game ─────────────────
    const botCheck = await pool.query(
      `SELECT created_at FROM users WHERE id=$1`,
      [req.user.id],
    );
    if (botCheck.rows.length > 0) {
      const age = Date.now() - new Date(botCheck.rows[0].created_at).getTime();
      if (age < 60 * 1000) {
        return res.status(429).json({ error: "Please wait before playing." });
      }
    }

    // Check joined onchain
    let joined = false;
    try {
      const [joinedOnchain] = await retryFn(
        (c) => c.getPlayerStatus(gameId, wallet),
        "getPlayerStatus",
      );
      joined = joinedOnchain;
    } catch (rpcErr) {
      console.warn(
        `[game/start] RPC unavailable, falling back to DB: ${rpcErr.message}`,
      );
      // If RPC is down, check if they have a pending/completed session in DB
      // This means they already started once — allow them to continue
      const existingSession = await pool.query(
        "SELECT id FROM game_sessions WHERE user_id=$1 AND game_id=$2 AND chain_id=$3",
        [req.user.id, gameId, chainId],
      );
      if (existingSession.rows.length > 0) {
        joined = true; // They already joined in a previous session
      }
    }
    if (!joined) return res.status(403).json({ error: "Not joined onchain" });

    // ✅ Check if already started — don't re-fetch questions
    const existingSession = await pool.query(
      "SELECT id, finished FROM game_sessions WHERE user_id=$1 AND game_id=$2",
      [req.user.id, gameId],
    );
    if (existingSession.rows.length > 0 && existingSession.rows[0].finished) {
      return res.status(400).json({ error: "Already finished this game" });
    }

    // ── Atomic: create session + store questions in one transaction ──
    const dbClient = await pool.connect();
    try {
      await dbClient.query("BEGIN");

      // Upsert session
      await dbClient.query(
        `INSERT INTO game_sessions (user_id, wallet, game_id, chain_id)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT ON CONSTRAINT gs_user_game_chain_unique DO NOTHING`,
        [req.user.id, wallet.toLowerCase(), gameId, chainId],
      );

      const sessionRow = await dbClient.query(
        "SELECT id, finished FROM game_sessions WHERE user_id=$1 AND game_id=$2 AND chain_id=$3",
        [req.user.id, gameId, chainId],
      );
      const sessionId = sessionRow.rows[0]?.id;

      if (!sessionId) {
        await dbClient.query("ROLLBACK");
        return res.status(500).json({ error: "Could not create game session" });
      }

      if (sessionRow.rows[0]?.finished) {
        await dbClient.query("ROLLBACK");
        return res.status(400).json({ error: "Already finished this game" });
      }

      // Check if questions already stored
      const existingQs = await dbClient.query(
        "SELECT COUNT(*) as cnt FROM game_questions WHERE session_id=$1",
        [sessionId],
      );

      if (parseInt(existingQs.rows[0].cnt) > 0) {
        await dbClient.query("COMMIT");
        return res.json({ ok: true, questions: [] });
      }

      // Store correctAnswers sent from client
      if (
        correctAnswers &&
        Array.isArray(correctAnswers) &&
        correctAnswers.length >= 5
      ) {
        for (const qa of correctAnswers) {
          await dbClient.query(
            `INSERT INTO game_questions (session_id, q_index, correct_answer, question, options)
         VALUES ($1,$2,$3,'client-fetched','[]')
         ON CONFLICT (session_id, q_index) DO NOTHING`,
            [sessionId, qa.index, qa.correct],
          );
        }
        await dbClient.query("COMMIT");
        return res.json({ ok: true, questions: [] });
      }

      await dbClient.query("COMMIT");
      return res.json({ ok: true, questions: [] });
    } catch (e) {
      await dbClient.query("ROLLBACK");
      throw e;
    } finally {
      dbClient.release();
    }
  } catch (e) {
    console.error("Game start error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// SUBMIT SCORE
// =============================================================================

app.post("/submit-score", scoreLimiter, async (req, res) => {
  const client = await pool.connect();

  if (!req.user) return res.status(401).json({ error: "Not logged in" });

  const { gameId, wallet, answers, chainId: reqChainId } = req.body;
  if (!Array.isArray(answers)) {
    return res.status(400).json({
      error: "Invalid answers format",
    });
  }
  if (answers.length === 0 || answers.length > 20) {
    return res.status(400).json({
      error: "Invalid number of answers",
    });
  }
  const chainId = parseInt(reqChainId || "5042002");
  const isLitvm = chainId === 4441;

  if (!gameId || !Array.isArray(answers))
    return res.status(400).json({ error: "Invalid input" });

  if (![5042002, 4441].includes(Number(chainId))) {
    return res.status(400).json({ error: "Invalid chain" });
  }

  const now = Date.now();

  const cooldownRow = await pool.query(
    `SELECT last_submit FROM submission_cooldowns WHERE wallet=LOWER($1)`,
    [wallet],
  );
  if (cooldownRow.rows.length > 0) {
    const elapsed =
      Date.now() - new Date(cooldownRow.rows[0].last_submit).getTime();
    if (elapsed < 10000) {
      return res.status(429).json({ error: "Slow down" });
    }
  }
  await pool.query(
    `INSERT INTO submission_cooldowns (wallet, last_submit)
   VALUES (LOWER($1), NOW())
   ON CONFLICT (wallet) DO UPDATE SET last_submit=NOW()`,
    [wallet],
  );

  const effectiveWallet = (req.user.wallet || wallet || "").toLowerCase();
  if (!effectiveWallet || !/^0x[a-fA-F0-9]{40}$/.test(effectiveWallet))
    return res
      .status(400)
      .json({ error: "No wallet linked. Connect wallet first." });

  if (
    wallet &&
    req.user.wallet &&
    wallet.toLowerCase() !== req.user.wallet.toLowerCase()
  )
    return res.status(403).json({ error: "Wallet mismatch" });

  // ✅ Fresh provider factory — avoids stale connections and NETWORK_ERROR
  function makeFreshContract(attempt = 1) {
    const rpc = ARC_RPCS[(attempt - 1) % ARC_RPCS.length];
    const p = new ethers.JsonRpcProvider(rpc, {
      chainId: 5042002,
      name: "arc-testnet",
    });
    return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, p);
  }
  function makeFreshLitvmContract() {
    const p = makeLitvmProvider();
    return new ethers.Contract(LITVM_CONTRACT_ADDRESS, CONTRACT_ABI, p);
  }

  const played = await client.query(
    `SELECT finished_at
    FROM game_sessions
    WHERE user_id=$1
    AND game_id=$2`,
    [req.user.id, gameId],
  );

  if (played.rows[0]?.finished_at) {
    const finishedAt = new Date(played.rows[0].finished_at).getTime();
    const now = Date.now();

    const diff = now - finishedAt;

    if (diff > 3600000) {
      return res.status(400).json({
        error: "Submission window expired",
      });
    }
  }

  async function litvmCall(fn, label) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const contract = makeFreshLitvmContract();
        const result = await Promise.race([
          fn(contract),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("LitVM timeout")), 12000),
          ),
        ]);
        return result;
      } catch (e) {
        console.warn(`[litvm-${label}] attempt ${attempt}/4: ${e.message}`);
        if (attempt === 4) throw e;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }

  const activeRpcCall = isLitvm ? litvmCall : rpcCall;

  async function rpcCall(fn, label) {
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        const contract = makeFreshContract(attempt);
        const result = await Promise.race([
          fn(contract),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("RPC timeout")), 12000),
          ),
        ]);
        return result;
      } catch (e) {
        const msg = e.message || "";
        const retryable =
          msg.includes("txpool is full") ||
          msg.includes("timeout") ||
          msg.includes("NETWORK_ERROR") ||
          msg.includes("network changed") ||
          msg.includes("unavailable") ||
          msg.includes("502") ||
          msg.includes("503") ||
          msg.includes("429");

        console.warn(`[${label}] attempt ${attempt}/6: ${msg}`);
        if (!retryable || attempt === 6) throw e;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }

  try {
    // ✅ Check joined onchain with retry
    let joined, alreadyFinished;
    try {
      [joined, alreadyFinished] = await activeRpcCall(
        (c) => c.getPlayerStatus(gameId, effectiveWallet),
        "getPlayerStatus",
      );
    } catch (e) {
      console.error("getPlayerStatus failed:", e.message);
      return res
        .status(503)
        .json({ error: "Blockchain unavailable. Try again." });
    }

    if (!joined)
      return res.status(403).json({ error: "Not in this game onchain" });
    if (alreadyFinished)
      return res.status(400).json({ error: "Score already submitted onchain" });

    // ✅ Check DB session

    await client.query("BEGIN");

    sessionCheck = await client.query(
      `
      SELECT id, finished, score
      FROM game_sessions
      WHERE user_id=$1
      AND game_id=$2
      AND chain_id=$3
      FOR UPDATE

      `,
      [req.user.id, gameId, chainId],
    );

    if (sessionCheck.rows.length === 0) {
      try {
        await client.query(
          "INSERT INTO game_sessions (user_id, wallet, game_id, chain_id) VALUES ($1,$2,$3,$4)",
          [req.user.id, effectiveWallet, gameId, chainId],
        );
        // Re-fetch after insert
        sessionCheck = await client.query(
          `
          SELECT id, finished, score
          FROM game_sessions
          WHERE user_id=$1
          AND game_id=$2
          AND chain_id=$3
          FOR UPDATE

          `,
          [req.user.id, gameId, chainId],
        );
      } catch (_) {}
    }

    if (sessionCheck.rows[0]?.finished) {
      // Allow retry for onchain submission if TX failed
      const cachedScore = sessionCheck.rows[0].score;
      if (cachedScore > 0) {
        // Get fresh nonce for retry
        let nonce;
        try {
          nonce = await activeRpcCall(
            (c) => c.nonces(effectiveWallet),
            "nonces-retry",
          );

          await client.query("UPDATE users SET nonce=$1 WHERE id=$2", [
            nonce.toString(),
            req.user.id,
          ]);
        } catch (e) {
          const nonceRow = await client.query(
            "SELECT nonce FROM users WHERE id=$1",
            [req.user.id],
          );
          nonce = BigInt(nonceRow.rows[0]?.nonce || 0);
        }
        const message = ethers.solidityPackedKeccak256(
          ["address", "uint256", "uint256", "uint256"],
          [effectiveWallet, gameId, cachedScore, nonce],
        );
        const signature = await verifierWallet.signMessage(
          ethers.getBytes(message),
        );
        console.log(
          `🔄 Retry signature: game=${gameId} score=${cachedScore} nonce=${nonce}`,
        );
        await client.query(
          `
          UPDATE game_sessions
          SET finished=true,
          score=$1,
          finished_at=NOW()
          WHERE user_id=$2
          AND game_id=$3
          AND chain_id=$4
          `,
          [cachedScore, req.user.id, gameId, chainId],
        );
        return res.json({
          score: cachedScore,
          signature,
          nonce: nonce.toString(),
          retry: true,
        });
      }
      return res.status(400).json({ error: "Score already submitted" });
    }

    // Always fetch fresh onchain nonce — stale nonce causes estimateGas revert
    let nonce;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        nonce = await activeRpcCall((c) => c.nonces(effectiveWallet), "nonces");
        await client.query("UPDATE users SET nonce=$1 WHERE id=$2", [
          nonce.toString(),
          req.user.id,
        ]);
        console.log(`✅ Onchain nonce: ${nonce} (attempt ${attempt})`);
        break;
      } catch (e) {
        console.warn(`nonce attempt ${attempt}/4 failed: ${e.message}`);
        if (attempt === 4) {
          return res
            .status(503)
            .json({ error: "Could not fetch nonce. Try again." });
        }
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }

    // Check game is still open before signing
    try {
      const gameStatus = await activeRpcCall(
        (c) => c.getPlayerStatus(gameId, effectiveWallet),
        "recheck",
      );
      if (gameStatus[1] === true) {
        return res
          .status(400)
          .json({ error: "Score already submitted onchain" });
      }
    } catch (_) {}
    const sessionId = sessionCheck.rows[0]?.id;
    if (!sessionId) {
      return res
        .status(400)
        .json({ error: "No game session found. Play the game first." });
    }

    const sessionData = await client.query(
      `SELECT started_at, finished
      FROM game_sessions
      WHERE id=$1`,
      [sessionId],
    );

    if (!sessionData.rows.length) {
      return res.status(400).json({
        error: "Session not found",
      });
    }

    if (sessionData.rows[0].finished) {
      return res.status(400).json({
        error: "Game already submitted",
      });
    }

    const startedAt = new Date(sessionData.rows[0].started_at).getTime();
    const totalSeconds = (Date.now() - startedAt) / 1000;

    // Minimum realistic time
    if (totalSeconds < 15) {
      return res.status(400).json({
        error: "Impossible completion speed detected",
      });
    }

    const sessionAge = (Date.now() - new Date(startedAt).getTime()) / 1000;

    const hardFloor = Math.max(15000, answers.length * 1500); // at least 15s total
    if (sessionAge * 1000 < hardFloor) {
      return res.status(400).json({
        error: "Impossible completion time detected",
      });
    }

    // ✅ Sanitize answers — reject suspicious inputs
    if (answers.length > 20) {
      return res.status(400).json({ error: "Too many answers" });
    }
    for (const ans of answers) {
      if (
        typeof ans.questionIndex !== "number" &&
        typeof ans.questionIndex !== "string"
      ) {
        return res.status(400).json({ error: "Invalid answer format" });
      }
      if (ans.selected !== null && typeof ans.selected !== "string") {
        return res.status(400).json({ error: "Invalid answer selection" });
      }
      if (ans.selected && ans.selected.length > 500) {
        return res.status(400).json({ error: "Answer too long" });
      }
    }

    // ✅ Duplicate question index check
    const seenIdx = new Set();
    for (const ans of answers) {
      const key = Number(ans.questionIndex);
      if (seenIdx.has(key)) {
        return res.status(400).json({ error: "Duplicate answer detected" });
      }
      seenIdx.add(key);
    }

    // In /submit-score, replace the scoring section:
    const storedQs = await client.query(
      "SELECT q_index, correct_answer FROM game_questions WHERE session_id=$1 ORDER BY q_index",
      [sessionId],
    );

    let score = 0;

    if (storedQs.rows.length === 0) {
      // ── Security: session exists but no questions were stored ──
      // This happens when the client crashed before /game/start completed.
      // Never sign a score of 0 — force the player to restart.
      console.warn(
        `[submit-score] No questions for session ${sessionId}, user ${req.user.id}, game ${gameId}. Resetting session.`,
      );
      // Reset the session so they can play again
      await client.query(
        `UPDATE game_sessions SET finished=false, score=0, finished_at=NULL
         WHERE id=$1`,
        [sessionId],
      );
      await client.query("ROLLBACK");
      client.release();
      return res.status(400).json({
        error: "Game session was interrupted — please refresh and play again.",
        resetSession: true,
      });
    } else {
      // ✅ Validate answer count
      if (answers.length < storedQs.rows.length * 0.5) {
        return res.status(400).json({
          error: "Too few answers submitted",
        });
      }

      // ✅ Score answers safely
      for (const stored of storedQs.rows) {
        const userAnswer = answers.find(
          (a) => Number(a.questionIndex) === Number(stored.q_index),
        );

        if (!userAnswer || !userAnswer.selected) {
          continue;
        }

        if (userAnswer.selected === stored.correct_answer) {
          score += 100;
        }
      }

      // Prevent impossible scores
      score = Math.min(score, storedQs.rows.length * 100);

      // Ensure at least one answer submitted
      if (answers.filter((a) => a.selected).length === 0) {
        return res.status(400).json({
          error: "No answers submitted",
        });
      }
    }

    const message = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "uint256"],
      [effectiveWallet, gameId, score, nonce],
    );

    const signature = await verifierWallet.signMessage(
      ethers.getBytes(message),
    );

    await client.query(
      `UPDATE game_sessions
      SET finished=true,
      score=$1,
      finished_at=NOW()
      WHERE user_id=$2
      AND game_id=$3
      AND chain_id=$4`,
      [score, req.user.id, gameId, chainId],
    );

    // ── Volume tracking — always update platform_stats ────────────────────────
    try {
      const gameRow = await client.query(
        `SELECT entry_fee FROM games
     WHERE contract_game_id = $1 AND chain_id = $2`,
        [gameId, chainId],
      );

      if (gameRow.rows.length > 0) {
        const entryFee = parseFloat(gameRow.rows[0].entry_fee || 0);
        if (entryFee > 0) {
          const volumeCol = isLitvm ? "total_volume_litvm" : "total_volume";
          await client.query(
            `UPDATE platform_stats
         SET ${volumeCol} = ${volumeCol} + $1
         WHERE id = 1`,
            [entryFee],
          );
        }
      } else {
        // Game not in DB yet — still increment from request data if available
        const fallbackFee = parseFloat(req.body.entryFee || 0);
        if (fallbackFee > 0) {
          const volumeCol = isLitvm ? "total_volume_litvm" : "total_volume";
          await client.query(
            `UPDATE platform_stats
         SET ${volumeCol} = ${volumeCol} + $1
         WHERE id = 1`,
            [fallbackFee],
          );
        }
      }
    } catch (volErr) {
      console.warn("Volume tracking failed (non-fatal):", volErr.message);
      // Non-fatal — don't roll back the score submission
    }

    // Increment DB nonce as fallback backup
    await client.query("UPDATE users SET nonce = nonce + 1 WHERE id=$1", [
      req.user.id,
    ]);

    console.log(
      `✅ Score: game=${gameId} score=${score} wallet=${effectiveWallet}`,
    );

    await client.query("COMMIT");
    res.json({ score, signature, nonce: nonce.toString() });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Submit error:", e.message);
    res.status(500).json({ error: "Server error: " + e.message });
  } finally {
    client.release();
  }
});

// =============================================================================
// BETS
// =============================================================================

app.post("/bets/place", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  const { gameId, predictedWinner, amount } = req.body;
  if (!gameId || !predictedWinner || !amount)
    return res.status(400).json({ error: "Missing fields" });
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000)
    return res.status(400).json({ error: "Invalid amount" });
  if (!/^0x[a-fA-F0-9]{40}$/.test(predictedWinner))
    return res.status(400).json({ error: "Invalid address" });
  try {
    const r = await pool.query(
      "INSERT INTO bets (user_id,game_id,predicted_winner,amount) VALUES($1,$2,$3,$4) RETURNING *",
      [req.user.id, gameId, predictedWinner.toLowerCase(), amount],
    );
    res.json({ bet: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/stats/global", async (req, res) => {
  try {
    // ── Player & session counts ───────────────────────────────────────────
    const countR = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users)                                    AS total_players,
        COUNT(*)                                                        AS total_games_played,
        COUNT(*) FILTER (WHERE gs.finished = true)                     AS total_finished
      FROM game_sessions gs
    `);

    // ── Volume: use BOTH sources, take the MAX of each ────────────────────
    // Source A: platform_stats cumulative counter (updated on each submission)
    const statsVolR = await pool.query(`
      SELECT
        COALESCE(total_volume,       0) AS arc_vol,
        COALESCE(total_volume_litvm, 0) AS litvm_vol
      FROM platform_stats
      WHERE id = 1
    `);

    // Source B: recalculate from game_sessions × games join (ground truth)
    const sessionVolR = await pool.query(`
      SELECT
        COALESCE(SUM(g.entry_fee) FILTER (
          WHERE g.chain_id = 5042002 AND gs.finished = true
        ), 0) AS arc_vol,
        COALESCE(SUM(g.entry_fee) FILTER (
          WHERE g.chain_id = 4441 AND gs.finished = true
        ), 0) AS litvm_vol
      FROM game_sessions gs
      JOIN games g
        ON g.contract_game_id = gs.game_id
       AND g.chain_id         = gs.chain_id
    `);

    // Take the higher of the two sources for each token (most accurate)
    const arcVol = Math.max(
      parseFloat(statsVolR.rows[0]?.arc_vol || 0),
      parseFloat(sessionVolR.rows[0]?.arc_vol || 0),
    );
    const litvmVol = Math.max(
      parseFloat(statsVolR.rows[0]?.litvm_vol || 0),
      parseFloat(sessionVolR.rows[0]?.litvm_vol || 0),
    );

    // ── Sync platform_stats if it drifted behind ──────────────────────────
    // Silently update so future calls are accurate
    if (
      arcVol > parseFloat(statsVolR.rows[0]?.arc_vol || 0) ||
      litvmVol > parseFloat(statsVolR.rows[0]?.litvm_vol || 0)
    ) {
      await pool
        .query(
          `
        UPDATE platform_stats
        SET total_volume       = GREATEST(total_volume,       $1),
            total_volume_litvm = GREATEST(total_volume_litvm, $2)
        WHERE id = 1
      `,
          [arcVol, litvmVol],
        )
        .catch(() => {});
    }

    // ── Top players leaderboard ───────────────────────────────────────────
    const topPlayers = await pool.query(`
      SELECT
        u.username,
        u.wallet,
        u.avatar,
        COUNT(gs.id)                                                 AS games_played,
        COUNT(gs.id)   FILTER (WHERE gs.finished = true)            AS games_finished,
        COALESCE(SUM(gs.score) FILTER (WHERE gs.finished = true),0) AS total_score,
        COALESCE(MAX(gs.score), 0)                                   AS best_score
      FROM users u
      LEFT JOIN game_sessions gs ON gs.user_id = u.id
      GROUP BY u.id, u.username, u.wallet, u.avatar
      HAVING COUNT(gs.id) > 0
      ORDER BY best_score DESC, games_played DESC
      LIMIT 10
    `);

    res.json({
      totalPlayers: parseInt(countR.rows[0].total_players) || 0,
      totalGamesPlayed: parseInt(countR.rows[0].total_games_played) || 0,
      totalFinished: parseInt(countR.rows[0].total_finished) || 0,
      arcVolume: arcVol.toFixed(2),
      litvmVolume: litvmVol.toFixed(4),
      topPlayers: topPlayers.rows,
    });
  } catch (e) {
    console.error("stats/global error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/bets/game/:gameId", async (req, res) => {
  const gameId = parseInt(req.params.gameId);
  if (isNaN(gameId)) return res.status(400).json({ error: "Invalid gameId" });
  try {
    const r = await pool.query(
      `SELECT b.predicted_winner, COUNT(*) as count, SUM(b.amount) as total,
              u.username, u.avatar
       FROM bets b JOIN users u ON b.user_id=u.id
       WHERE b.game_id=$1
       GROUP BY b.predicted_winner, u.username, u.avatar
       ORDER BY total DESC`,
      [gameId],
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/admin/sync-nonce", async (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: "Missing wallet" });
  try {
    const nonce = await withRetry((c) => c.nonces(wallet), "syncNonce");
    await pool.query("UPDATE users SET nonce=$1 WHERE LOWER(wallet)=$2", [
      nonce.toString(),
      wallet.toLowerCase(),
    ]);
    res.json({ ok: true, nonce: nonce.toString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// STREAK
// =============================================================================

app.post("/streak/reward", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  const { wallet, streak } = req.body;
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet))
    return res.status(400).json({ error: "Invalid wallet" });
  if (typeof streak !== "number")
    return res.status(400).json({ error: "Invalid streak" });
  if (streak < 3) return res.json({ ok: true });
  if (req.user.wallet?.toLowerCase() !== wallet.toLowerCase())
    return res.status(403).json({ error: "Wallet mismatch" });
  console.log(`🔥 Streak reward → ${wallet}, streak: ${streak}`);
  res.json({ ok: true });
});

// =============================================================================
// HEALTH
// =============================================================================

app.get("/health", (req, res) =>
  res.json({
    ok: true,
    verifier: verifierWallet.address,
    contract: CONTRACT_ADDRESS,
  }),
); // Self-ping to prevent Render sleep
if (process.env.NODE_ENV === "production") {
  setInterval(
    async () => {
      try {
        await fetch(`https://name-triviafi-backend.onrender.com/health`);
        console.log("🏓 Self-ping OK");
      } catch (_) {}

      // ── Auto-cancel AND refund expired open tournaments ───────────────
      try {
        // Find expired open tournaments with fewer players than max
        // ── Auto-cancel expired open tournaments ─────────────────────────────
        try {
          const expired = await pool.query(`
    SELECT t.*,
      (SELECT COUNT(*) FROM tournament_players WHERE tournament_id = t.id) AS player_count
    FROM tournaments t
    WHERE t.status = 'open'
      AND t.tournament_type = 'paid'
      AND t.deadline_at < NOW()
  `);

          for (const t of expired.rows) {
            console.log(
              `⏰ Auto-expiring tournament ${t.id}: ${t.name} (${t.player_count} players)`,
            );

            // Step 1: Mark cancelled FIRST — tournament is never deleted
            await pool.query(
              "UPDATE tournaments SET status='cancelled' WHERE id=$1",
              [t.id],
            );

            // Step 2: Get all players who need refunds
            const players = await pool.query(
              `SELECT * FROM tournament_players 
       WHERE tournament_id=$1 AND NOT refunded`,
              [t.id],
            );

            if (players.rows.length === 0) {
              console.log(
                `Tournament ${t.id} cancelled — no players to refund`,
              );
              continue;
            }

            const isLitvm = t.token_symbol === "zkLTC";
            const decimals = isLitvm ? 18 : 6;
            const refundAmount = parseFloat(t.entry_fee);

            if (refundAmount <= 0) {
              console.log(`Tournament ${t.id} — no entry fee to refund`);
              continue;
            }

            const amountWei = ethers.parseUnits(
              refundAmount.toFixed(decimals),
              decimals,
            );

            // Step 3: Queue ALL refunds first — even if tx fails they are recorded
            for (const p of players.rows) {
              await pool
                .query(
                  `INSERT INTO game_refunds
          (game_id, chain_id, wallet, amount, token_symbol, status, notes)
         VALUES ($1, $2, LOWER($3), $4, $5, 'queued', 'auto-expire refund')
         ON CONFLICT (game_id, chain_id, wallet) DO UPDATE
           SET status = CASE 
             WHEN game_refunds.status = 'paid' THEN 'paid'
             ELSE 'queued'
           END`,
                  [
                    t.id,
                    isLitvm ? 4441 : 5042002,
                    p.wallet,
                    refundAmount,
                    t.token_symbol,
                  ],
                )
                .catch((e) =>
                  console.error(
                    `Failed to queue refund for ${p.wallet}:`,
                    e.message,
                  ),
                );
            }

            // Step 4: Attempt to send refunds — failures stay as 'queued' for retry
            for (const p of players.rows) {
              try {
                let txHash;

                if (isLitvm) {
                  const fastProvider = await makeLitvmProviderFast();
                  const ws = verifierWallet.connect(fastProvider);
                  const feeData = await fastProvider.getFeeData();
                  let gasLimit = 21000n;
                  try {
                    const est = await fastProvider.estimateGas({
                      to: p.wallet,
                      value: amountWei,
                      from: verifierWallet.address,
                    });
                    gasLimit = (BigInt(est) * 150n) / 100n;
                  } catch (_) {
                    gasLimit = 100000n;
                  }
                  const tx = await ws.sendTransaction({
                    to: p.wallet,
                    value: amountWei,
                    gasLimit,
                    maxFeePerGas: feeData.maxFeePerGas,
                    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
                    chainId: 4441,
                  });
                  await tx.wait(1);
                  txHash = tx.hash;
                } else {
                  const ARC_USDC = "0x3600000000000000000000000000000000000000";
                  const ws = verifierWallet.connect(makeProvider());
                  const uc = new ethers.Contract(
                    ARC_USDC,
                    [
                      "function transfer(address,uint256) external returns (bool)",
                    ],
                    ws,
                  );
                  const tx = await uc.transfer(p.wallet, amountWei);
                  await tx.wait();
                  txHash = tx.hash;
                }

                // Mark refund paid in game_refunds
                await pool.query(
                  `UPDATE game_refunds SET status='paid', tx_hash=$1
           WHERE game_id=$2 AND chain_id=$3 AND LOWER(wallet)=LOWER($4)`,
                  [txHash, t.id, isLitvm ? 4441 : 5042002, p.wallet],
                );

                // Mark player refunded
                await pool.query(
                  `UPDATE tournament_players
           SET refunded=TRUE, refunded_at=NOW(), refund_tx=$1
           WHERE id=$2`,
                  [txHash, p.id],
                );

                console.log(
                  `✅ Auto-refunded: ${refundAmount} ${t.token_symbol} → ${p.wallet} | TX: ${txHash}`,
                );
              } catch (refundErr) {
                // Refund stays as 'queued' — the queued refund processor picks it up
                console.error(
                  `❌ Auto-refund failed for ${p.wallet} in tournament ${t.id}: ${refundErr.message}`,
                );
                console.error(`   Queued for retry — funds are safe`);
              }
            }
          }
        } catch (e) {
          console.error("Auto-expire error:", e.message);
        }
      } catch (e) {
        console.error("Auto-expire error:", e.message);
      }

      // ── Process queued refunds ────────────────────────────────────────────
      try {
        const queued = await pool.query(
          `SELECT * FROM game_refunds WHERE status='queued' LIMIT 10`,
        );

        for (const refund of queued.rows) {
          try {
            const isLitvm = refund.token_symbol === "zkLTC";
            const decimals = isLitvm ? 18 : 6;

            const amountWei = ethers.parseUnits(
              parseFloat(refund.amount).toFixed(decimals),
              decimals,
            );

            let txHash;

            if (isLitvm) {
              const fastProvider = await makeLitvmProviderFast();
              const ws = verifierWallet.connect(fastProvider);

              const feeData = await fastProvider.getFeeData();
              let gasLimit = 21000n;
              try {
                const est = await fastProvider.estimateGas({
                  to: p.wallet,
                  value: amountWei,
                  from: verifierWallet.address,
                });
                gasLimit = (BigInt(est) * 150n) / 100n;
              } catch (_) {
                gasLimit = 100000n;
              }
              const tx = await ws.sendTransaction({
                to: p.wallet,
                value: amountWei,
                gasLimit,
                maxFeePerGas: feeData.maxFeePerGas,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
                chainId: 4441,
              });

              await tx.wait();
              txHash = tx.hash;
            } else {
              const ARC_USDC = "0x3600000000000000000000000000000000000000";

              const ws = verifierWallet.connect(makeProvider());

              const uc = new ethers.Contract(
                ARC_USDC,
                ["function transfer(address,uint256) external returns (bool)"],
                ws,
              );

              const tx = await uc.transfer(refund.wallet, amountWei);

              await tx.wait();
              txHash = tx.hash;
            }

            await pool.query(
              `UPDATE game_refunds
               SET status='paid', tx_hash=$1
               WHERE id=$2`,
              [txHash, refund.id],
            );

            console.log(
              `✅ Queued refund processed: ${refund.wallet} | TX: ${txHash}`,
            );
          } catch (retryErr) {
            console.warn(
              `⏳ Queued refund retry failed for ${refund.wallet}: ${retryErr.message}`,
            );
          }
        }
      } catch (e) {
        console.error("Queued refund processor error:", e.message);
      }
    },
    8 * 60 * 1000,
  );
}

// ── ONE-TIME VOLUME RECONCILIATION ────────────────────────────────────────
// Call GET /admin/reconcile-volume?key=YOUR_ADMIN_SECRET once to fix history
app.get("/admin/reconcile-volume", async (req, res) => {
  if (req.query.key !== process.env.ADMIN_SECRET && !isAdmin(req)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    // Calculate true totals from game_sessions × games
    const r = await pool.query(`
      SELECT
        COALESCE(SUM(g.entry_fee) FILTER (
          WHERE g.chain_id = 5042002 AND gs.finished = true
        ), 0) AS arc_total,
        COALESCE(SUM(g.entry_fee) FILTER (
          WHERE g.chain_id = 4441 AND gs.finished = true
        ), 0) AS litvm_total
      FROM game_sessions gs
      JOIN games g
        ON g.contract_game_id = gs.game_id
       AND g.chain_id = gs.chain_id
    `);

    const arcTotal = parseFloat(r.rows[0].arc_total || 0);
    const litvmTotal = parseFloat(r.rows[0].litvm_total || 0);

    // Update platform_stats to the GREATER of current or recalculated
    await pool.query(
      `
      UPDATE platform_stats
      SET total_volume       = GREATEST(total_volume,       $1),
          total_volume_litvm = GREATEST(total_volume_litvm, $2)
      WHERE id = 1
    `,
      [arcTotal, litvmTotal],
    );

    const updated = await pool.query(
      "SELECT total_volume, total_volume_litvm FROM platform_stats WHERE id=1",
    );

    res.json({
      ok: true,
      recalculated: { arcTotal, litvmTotal },
      stored: updated.rows[0],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN: Manual refund to a wallet ─────────────────────────────────────
app.post("/admin/manual-refund", async (req, res) => {
  // Only callable with your admin secret key — never exposed to frontend
  if (req.headers["x-admin-key"] !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { wallet, amount, tokenSymbol, reason } = req.body;

  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet))
    return res.status(400).json({ error: "Invalid wallet" });
  if (!amount || parseFloat(amount) <= 0)
    return res.status(400).json({ error: "Invalid amount" });
  if (!["USDC", "zkLTC"].includes(tokenSymbol))
    return res.status(400).json({ error: "Invalid token" });

  console.log(
    `🔧 ADMIN MANUAL REFUND:\n` +
      `  Wallet: ${wallet}\n` +
      `  Amount: ${amount} ${tokenSymbol}\n` +
      `  Reason: ${reason || "manual refund"}\n` +
      `  Time: ${new Date().toISOString()}`,
  );

  try {
    const isLitvm = tokenSymbol === "zkLTC";
    const decimals = isLitvm ? 18 : 6;
    const amountWei = ethers.parseUnits(
      parseFloat(amount).toFixed(decimals),
      decimals,
    );

    let txHash;

    if (isLitvm) {
      const fastProvider = await makeLitvmProviderFast();
      const ws = verifierWallet.connect(fastProvider);
      const feeData = await fastProvider.getFeeData();
      let gasLimit = 21000n;
      try {
        const est = await fastProvider.estimateGas({
          to: wallet,
          value: amountWei,
          from: verifierWallet.address,
        });
        gasLimit = (BigInt(est) * 150n) / 100n;
      } catch (_) {
        gasLimit = 100000n; // safe fallback for LitVM
      }
      const tx = await ws.sendTransaction({
        to: wallet,
        value: amountWei,
        gasLimit,
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        chainId: 4441,
      });
      await tx.wait();
      txHash = tx.hash;
    } else {
      // Arc USDC
      const ARC_USDC = "0x3600000000000000000000000000000000000000";
      const ws = verifierWallet.connect(makeProvider());
      const uc = new ethers.Contract(
        ARC_USDC,
        ["function transfer(address,uint256) external returns (bool)"],
        ws,
      );
      const tx = await uc.transfer(wallet, amountWei);
      await tx.wait();
      txHash = tx.hash;
    }

    // Log it to game_refunds for record keeping
    await pool
      .query(
        `INSERT INTO game_refunds
       (game_id, chain_id, wallet, amount, token_symbol, tx_hash, status, notes)
       VALUES (0, $1, LOWER($2), $3, $4, $5, 'paid', $6)`,
        [
          isLitvm ? 4441 : 5042002,
          wallet,
          parseFloat(amount),
          tokenSymbol,
          txHash,
          reason || "manual admin refund",
        ],
      )
      .catch(() => {});

    console.log(
      `✅ Manual refund sent: ${amount} ${tokenSymbol} → ${wallet} | TX: ${txHash}`,
    );

    res.json({
      ok: true,
      txHash,
      amount,
      tokenSymbol,
      wallet,
    });
  } catch (e) {
    console.error("Manual refund failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GAME REFUND — for players who joined but never played ─────────────────
app.post("/games/:gameId/refund", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  const { wallet, chainId: reqChainId } = req.body;
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet))
    return res.status(400).json({ error: "Invalid wallet" });

  const gameId = parseInt(req.params.gameId);
  const chainId = parseInt(reqChainId || "5042002");
  const isLitvm = chainId === 4441;
  const walletLow = wallet.toLowerCase();

  if (req.user.wallet && req.user.wallet.toLowerCase() !== walletLow)
    return res.status(403).json({ error: "Wallet mismatch" });

  try {
    // ── 1. Already refunded? ──────────────────────────────────────────
    const existingRefund = await pool.query(
      `SELECT * FROM game_refunds
       WHERE game_id=$1 AND chain_id=$2 AND LOWER(wallet)=LOWER($3)`,
      [gameId, chainId, wallet],
    );
    if (
      existingRefund.rows.length > 0 &&
      existingRefund.rows[0].status === "paid"
    ) {
      return res.status(400).json({ error: "Already refunded" });
    }

    // ── 2. Verify joined — RPC first, DB fallback ─────────────────────
    let joined = false,
      alreadyFinishedOnchain = false;
    let rpcAvailable = true;

    try {
      const retryFn = isLitvm ? withLitvmRetry : withRetry;
      [joined, alreadyFinishedOnchain] = await retryFn(
        (c) => c.getPlayerStatus(gameId, wallet),
        "refund-playerStatus",
      );
    } catch (rpcErr) {
      rpcAvailable = false;
      console.warn(`[refund] RPC down, using DB fallback: ${rpcErr.message}`);

      // DB fallback — if they have a session they definitely joined
      const sessionFallback = await pool.query(
        `SELECT finished, score FROM game_sessions
         WHERE user_id=$1 AND game_id=$2 AND chain_id=$3`,
        [req.user.id, gameId, chainId],
      );

      if (sessionFallback.rows.length > 0) {
        joined = true;
        alreadyFinishedOnchain = sessionFallback.rows[0].finished || false;
      } else {
        // No session in DB either — can't verify, queue for manual review
        return res.status(503).json({
          error:
            "LitVM network is temporarily down. Please try again in a few minutes.",
        });
      }
    }

    if (!joined)
      return res
        .status(400)
        .json({ error: "You did not join this game onchain" });

    // ── 3. Game must be finished or past deadline ─────────────────────
    if (rpcAvailable) {
      try {
        const provider = isLitvm
          ? await makeLitvmProviderFast()
          : makeProvider();
        const contractAddr = isLitvm
          ? LITVM_CONTRACT_ADDRESS
          : CONTRACT_ADDRESS;
        const statusContract = new ethers.Contract(
          contractAddr,
          [
            "function getGame(uint256) view returns (tuple(uint256 id,string name,address creator,uint8 categoryId,string categoryName,uint8 difficulty,uint256 entryFee,uint256 maxPlayers,uint256 prizePool,uint256 playerCount,uint256 registrationEnd,uint256 playDeadline,address[3] topPlayers,bool prizeClaimed,uint8 status,uint256 finishedCount))",
          ],
          provider,
        );
        const gameData = await Promise.race([
          statusContract.getGame(gameId),
          new Promise((_, r) =>
            setTimeout(() => r(new Error("timeout")), 8000),
          ),
        ]);
        const gameStatus = Number(gameData.status);
        if (gameStatus === 0) {
          const playDeadline = Number(gameData.playDeadline);
          const now = Math.floor(Date.now() / 1000);
          if (playDeadline > now) {
            return res.status(400).json({
              error:
                "Game is still active. Wait for it to end before requesting a refund.",
            });
          }
        }
      } catch (_) {
        // RPC failed for status check — continue anyway, DB check below covers it
      }
    }

    // ── 4. Player never played ────────────────────────────────────────
    const sessionCheck = await pool.query(
      `SELECT id, finished, score FROM game_sessions
       WHERE user_id=$1 AND game_id=$2 AND chain_id=$3`,
      [req.user.id, gameId, chainId],
    );

    const played =
      sessionCheck.rows.length > 0 && sessionCheck.rows[0].finished;
    if (played) {
      return res.status(400).json({
        error:
          "You played this game — refunds are only for players who registered but never played.",
      });
    }

    if (alreadyFinishedOnchain) {
      return res.status(400).json({
        error:
          "Your score was submitted onchain — you are not eligible for a refund.",
      });
    }

    // ── 5. Get entry fee ──────────────────────────────────────────────
    let entryFee, tokenSymbol;
    const gameRow = await pool.query(
      `SELECT entry_fee, token_symbol FROM games
       WHERE contract_game_id=$1 AND chain_id=$2`,
      [gameId, chainId],
    );

    if (gameRow.rows.length > 0) {
      entryFee = parseFloat(gameRow.rows[0].entry_fee || 0);
      tokenSymbol =
        gameRow.rows[0].token_symbol || (isLitvm ? "zkLTC" : "USDC");
    } else {
      // Fetch from chain if not in DB
      try {
        const fallbackProvider = isLitvm
          ? await makeLitvmProviderFast()
          : makeProvider();
        const fallbackContract = new ethers.Contract(
          isLitvm ? LITVM_CONTRACT_ADDRESS : CONTRACT_ADDRESS,
          [
            "function getGame(uint256) view returns (tuple(uint256 id,string name,address creator,uint8 categoryId,string categoryName,uint8 difficulty,uint256 entryFee,uint256 maxPlayers,uint256 prizePool,uint256 playerCount,uint256 registrationEnd,uint256 playDeadline,address[3] topPlayers,bool prizeClaimed,uint8 status,uint256 finishedCount))",
          ],
          fallbackProvider,
        );
        const onchainGame = await Promise.race([
          fallbackContract.getGame(gameId),
          new Promise((_, r) =>
            setTimeout(() => r(new Error("timeout")), 8000),
          ),
        ]);
        const decimals = isLitvm ? 18 : 6;
        entryFee = parseFloat(
          ethers.formatUnits(onchainGame.entryFee, decimals),
        );
        tokenSymbol = isLitvm ? "zkLTC" : "USDC";
      } catch (fetchErr) {
        console.error("Onchain game fetch failed:", fetchErr.message);
        return res.status(503).json({
          error: "Could not retrieve game data. Please try again.",
        });
      }
    }

    if (!entryFee || entryFee <= 0)
      return res.status(400).json({ error: "No entry fee to refund." });

    const decimals = isLitvm ? 18 : 6;
    const amountWei = ethers.parseUnits(entryFee.toFixed(decimals), decimals);

    // ── 6. Insert pending refund ──────────────────────────────────────
    await pool.query(
      `INSERT INTO game_refunds (game_id, chain_id, wallet, amount, token_symbol, status)
       VALUES ($1,$2,LOWER($3),$4,$5,'pending')
       ON CONFLICT (game_id, chain_id, wallet) DO UPDATE SET status='pending'`,
      [gameId, chainId, wallet, entryFee, tokenSymbol],
    );

    // ── 7. Send refund ────────────────────────────────────────────────
    try {
      let txHash;
      if (isLitvm) {
        console.log(
          "REFUND DEBUG 1: Starting LitVM refund, RPCs:",
          LITVM_RPCS_LIST,
        );
        let txHash = null;
        let lastErr = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            // Wait before each attempt to avoid 429
            if (attempt > 0)
              await new Promise((r) => setTimeout(r, 3000 * attempt));
            const fastProvider = makeLitvmProvider(0); // only one real RPC
            console.log(
              `REFUND DEBUG 2: Attempt ${attempt + 1} using RPC: ${LITVM_RPCS_LIST[attempt % LITVM_RPCS_LIST.length]}`,
            );
            const ws = verifierWallet.connect(fastProvider);
            const feeData = await fastProvider.getFeeData();
            console.log("REFUND FEE DATA:", feeData);
            let gasLimit = 21000n;
            try {
              const est = await fastProvider.estimateGas({
                to: wallet,
                value: amountWei,
                from: verifierWallet.address,
              });
              gasLimit = (BigInt(est) * 150n) / 100n;
            } catch (_) {
              gasLimit = 100000n;
            }
            const tx = await ws.sendTransaction({
              to: wallet,
              value: amountWei,
              gasLimit,
              maxFeePerGas: feeData.maxFeePerGas,
              maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
              chainId: 4441,
            });
            console.log("REFUND DEBUG 5: TX SENT", tx.hash);
            await tx.wait(1);
            txHash = tx.hash;
            console.log("REFUND DEBUG 6: TX CONFIRMED", tx.hash);
            break; // success — stop retrying
          } catch (e) {
            lastErr = e;
            console.warn(`Refund attempt ${attempt + 1} failed: ${e.message}`);
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
        if (!txHash) throw lastErr;
      } else {
        const ARC_USDC = "0x3600000000000000000000000000000000000000";
        const ws = verifierWallet.connect(makeProvider());
        const uc = new ethers.Contract(
          ARC_USDC,
          ["function transfer(address,uint256) external returns (bool)"],
          ws,
        );
        const tx = await uc.transfer(wallet, amountWei);
        await tx.wait();
        txHash = tx.hash;
      }

      await pool.query(
        `UPDATE game_refunds SET status='paid', tx_hash=$1
         WHERE game_id=$2 AND chain_id=$3 AND LOWER(wallet)=LOWER($4)`,
        [txHash, gameId, chainId, wallet],
      );

      console.log(
        `✅ Game refund: game=${gameId} chain=${chainId} wallet=${wallet} amount=${entryFee} ${tokenSymbol} tx=${txHash}`,
      );
      return res.json({
        ok: true,
        refunded: true,
        amount: entryFee,
        tokenSymbol,
        txHash,
      });
    } catch (payErr) {
      console.error("Game refund tx failed:", payErr);
      console.error("Message:", payErr?.message);
      console.error("Code:", payErr?.code);
      console.error("Reason:", payErr?.reason);
      console.error("Stack:", payErr?.stack);
      await pool
        .query(
          `UPDATE game_refunds SET status='queued'
         WHERE game_id=$1 AND chain_id=$2 AND LOWER(wallet)=LOWER($3)`,
          [gameId, chainId, wallet],
        )
        .catch(() => {});

      let userMsg =
        "Refund queued — will be processed automatically within 10 minutes.";
      if (payErr.message?.includes("insufficient funds")) {
        userMsg =
          "Treasury low on funds. Refund queued — contact support with game ID: " +
          gameId;
      }

      console.error(
        `REFUND QUEUED: game=${gameId} chain=${chainId} wallet=${wallet} amount=${entryFee} ${tokenSymbol}`,
      );
      return res.status(500).json({ error: userMsg, queued: true, gameId });
    }
  } catch (e) {
    console.error("Game refund error:", e.message, e.stack?.slice(0, 300));
    res.status(500).json({ error: "Server error: " + e.message });
  }
});

// ── CHECK refund status for a wallet + game ───────────────────────────────
app.get("/games/:gameId/refund-status", async (req, res) => {
  const { wallet, chainId } = req.query;
  if (!wallet) return res.json({ status: null });
  try {
    const r = await pool.query(
      `SELECT status, amount, tx_hash, token_symbol
       FROM game_refunds
       WHERE game_id=$1 AND chain_id=$2 AND LOWER(wallet)=LOWER($3)`,
      [req.params.gameId, parseInt(chainId || "5042002"), wallet],
    );
    res.json(r.rows[0] || { status: null });
  } catch (_) {
    res.json({ status: null });
  }
});

// ════════════════════════════════════════════════════════════════════
// TOURNAMENT ROUTES — ORDER IS CRITICAL. Literals before :id params.
// ════════════════════════════════════════════════════════════════════

// 1. LIST all tournaments
// 1. LIST all tournaments
app.get("/tournaments", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*,
        (SELECT COUNT(*)
         FROM tournament_players tp
         WHERE tp.tournament_id = t.id
        ) AS player_count,
        (SELECT u.username FROM users u
         WHERE LOWER(u.wallet) = LOWER(t.winner) LIMIT 1
        ) AS winner_username,
        COALESCE(
          (SELECT json_agg(w ORDER BY w.prize_position)
           FROM (
             SELECT tp.wallet, tp.prize_position, u2.username
             FROM tournament_players tp
             LEFT JOIN users u2 ON LOWER(u2.wallet) = LOWER(tp.wallet)
             WHERE tp.tournament_id = t.id
               AND tp.prize_position IS NOT NULL
               AND tp.prize_position BETWEEN 0 AND 2
           ) w
          ),
          '[]'::json
        ) AS winners
      FROM tournaments t
      WHERE (t.status != 'cancelled' OR t.created_at > NOW() - INTERVAL '7 days')
      ORDER BY
        CASE t.status WHEN 'active' THEN 0 WHEN 'open' THEN 1 ELSE 2 END,
        t.created_at DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (e) {
    console.error("GET /tournaments error:", e.message, e.stack?.slice(0, 300));
    res.status(500).json({ error: e.message });
  }
});
// 2. LEADERBOARD — MUST be before /:id
app.get("/tournaments/leaderboard", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        tp.wallet,
        MAX(u.username) AS username,
        MAX(u.avatar)   AS avatar,
        COUNT(DISTINCT tp.tournament_id) AS tournaments_played,
        COUNT(DISTINCT CASE WHEN LOWER(t.winner) = LOWER(tp.wallet) THEN t.id END) AS wins,
        COALESCE(SUM(tc.amount) FILTER (WHERE tc.status='paid' AND tc.token_symbol='USDC'),  0) AS usdc_earned,
        COALESCE(SUM(tc.amount) FILTER (WHERE tc.status='paid' AND tc.token_symbol='zkLTC'), 0) AS litvm_earned
      FROM tournament_players tp
      LEFT JOIN users u       ON LOWER(u.wallet)   = LOWER(tp.wallet)
      LEFT JOIN tournaments t ON t.id = tp.tournament_id
      LEFT JOIN tournament_claims tc ON LOWER(tc.wallet) = LOWER(tp.wallet)
      GROUP BY tp.wallet
      HAVING COUNT(DISTINCT tp.tournament_id) > 0
      ORDER BY wins DESC, usdc_earned DESC
      LIMIT 20
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN: Force refund all players in an expired tournament ─────────────
app.post("/admin/refund-expired-tournament", async (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: "Forbidden" });

  const { tournamentId } = req.body;
  if (!tournamentId)
    return res.status(400).json({ error: "Missing tournamentId" });

  try {
    const t = await pool.query("SELECT * FROM tournaments WHERE id=$1", [
      tournamentId,
    ]);
    if (!t.rows.length) return res.status(404).json({ error: "Not found" });
    const tournament = t.rows[0];

    if (tournament.tournament_type === "whitelist")
      return res
        .status(400)
        .json({ error: "Whitelist tournaments have no entry fee" });

    const refundAmount = parseFloat(tournament.entry_fee);
    if (refundAmount <= 0)
      return res.status(400).json({ error: "No entry fee to refund" });

    // Mark tournament cancelled
    await pool.query("UPDATE tournaments SET status='cancelled' WHERE id=$1", [
      tournamentId,
    ]);

    // Get all unrefunded players
    const players = await pool.query(
      "SELECT * FROM tournament_players WHERE tournament_id=$1 AND NOT refunded",
      [tournamentId],
    );

    const isLitvm = tournament.token_symbol === "zkLTC";
    const decimals = isLitvm ? 18 : 6;
    const amountWei = ethers.parseUnits(
      refundAmount.toFixed(decimals),
      decimals,
    );
    const results = [];

    for (const p of players.rows) {
      try {
        let txHash;
        if (isLitvm) {
          const fastProvider = await makeLitvmProviderFast();
          const ws = verifierWallet.connect(fastProvider);
          const feeData = await fastProvider.getFeeData();
          let gasLimit = 21000n;
          try {
            const est = await fastProvider.estimateGas({
              to: wallet,
              value: amountWei,
              from: verifierWallet.address,
            });
            gasLimit = (BigInt(est) * 150n) / 100n;
          } catch (_) {
            gasLimit = 100000n;
          }
          const tx = await ws.sendTransaction({
            to: wallet,
            value: amountWei,
            gasLimit,
            maxFeePerGas: feeData.maxFeePerGas,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
            chainId: 4441,
          });
          await tx.wait();
          txHash = tx.hash;
        } else {
          const ARC_USDC = "0x3600000000000000000000000000000000000000";
          const ws = verifierWallet.connect(makeProvider());
          const uc = new ethers.Contract(
            ARC_USDC,
            ["function transfer(address,uint256) external returns (bool)"],
            ws,
          );
          const tx = await uc.transfer(p.wallet, amountWei);
          await tx.wait();
          txHash = tx.hash;
        }
        await pool.query(
          "UPDATE tournament_players SET refunded=TRUE, refunded_at=NOW(), refund_tx=$1 WHERE id=$2",
          [txHash, p.id],
        );
        results.push({ wallet: p.wallet, txHash, status: "ok" });
        console.log(
          `✅ Refunded ${refundAmount} ${tournament.token_symbol} → ${p.wallet} | TX: ${txHash}`,
        );
      } catch (e) {
        results.push({ wallet: p.wallet, error: e.message, status: "failed" });
        console.error(`❌ Refund failed for ${p.wallet}: ${e.message}`);
      }
    }

    res.json({ ok: true, refunded: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3. STATS — MUST be before /:id
app.get("/tournaments/stats", async (req, res) => {
  try {
    // Volume = sum of actually PAID claims (what winners received)
    const claimsR = await pool.query(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE token_symbol = 'USDC'),  0) AS usdc_volume,
        COALESCE(SUM(amount) FILTER (WHERE token_symbol = 'zkLTC'), 0) AS litvm_volume
      FROM tournament_claims
      WHERE status = 'paid'
    `);

    const countsR = await pool.query(`
      SELECT
        COUNT(*)                                       AS total_tournaments,
        COUNT(*) FILTER (WHERE status = 'active')     AS live_count,
        COUNT(*) FILTER (WHERE status = 'finished')   AS finished_count
      FROM tournaments
      WHERE tournament_type = 'paid'
    `);

    res.json({
      total_tournaments: countsR.rows[0].total_tournaments,
      live_count: countsR.rows[0].live_count,
      finished_count: countsR.rows[0].finished_count,
      usdc_volume: parseFloat(claimsR.rows[0].usdc_volume || 0).toFixed(2),
      litvm_volume: parseFloat(claimsR.rows[0].litvm_volume || 0).toFixed(4),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 4. CREATE paid tournament — before /:id
app.post("/tournaments/create", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  const { name, chainId, entryFee, tokenSymbol, maxPlayers, rounds } = req.body;
  if (!name || !entryFee || !maxPlayers || !rounds)
    return res.status(400).json({ error: "Missing fields" });
  if (parseInt(maxPlayers) < 4 || parseInt(maxPlayers) > 64)
    return res.status(400).json({ error: "Max players: 4–64" });
  if (parseInt(rounds) < 2 || parseInt(rounds) > 5)
    return res.status(400).json({ error: "Rounds: 2–5" });

  const cleanName = sanitizeHtml(name, {
    allowedTags: [],
    allowedAttributes: {},
  });
  const creatorId = (req.user.wallet || req.user.email || "").toLowerCase();

  // ── Anti-bot: require wallet to exist in users table with history ─────
  const userCheck = await pool.query(
    `SELECT id, wallet, created_at FROM users WHERE LOWER(wallet)=$1 OR LOWER(email)=$1`,
    [creatorId],
  );
  if (!userCheck.rows.length) {
    return res.status(403).json({ error: "Account not found" });
  }
  const accountAge =
    Date.now() - new Date(userCheck.rows[0].created_at).getTime();
  const minAgeMs = 5 * 60 * 1000; // 5 minutes minimum account age
  if (accountAge < minAgeMs) {
    return res.status(429).json({
      error:
        "Account too new. Please wait a few minutes before creating a tournament.",
    });
  }

  if (!isAdmin(req)) {
    const recent = await pool.query(
      `SELECT id, created_at FROM tournaments
       WHERE LOWER(creator)=$1
         AND tournament_type='paid'
         AND created_at > NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC LIMIT 1`,
      [creatorId],
    );
    if (recent.rows.length > 0) {
      const created = new Date(recent.rows[0].created_at);
      const nextAllowed = new Date(created.getTime() + 24 * 60 * 60 * 1000);
      const minutesLeft = Math.ceil((nextAllowed - Date.now()) / (1000 * 60));
      const hoursLeft = Math.ceil(minutesLeft / 60);
      const timeMsg =
        hoursLeft > 1 ? `${hoursLeft} hours` : `${minutesLeft} minutes`;
      return res.status(429).json({
        error: `You already created a paid tournament today. You can create another in ${timeMsg}.`,
        hoursLeft,
        nextAllowedAt: nextAllowed.toISOString(),
      });
    }
  }

  try {
    const result = await pool.query(
      `INSERT INTO tournaments
         (name, creator, chain_id, entry_fee, token_symbol, max_players, rounds,
          deadline_at, tournament_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + INTERVAL '24 hours', 'paid')
       RETURNING *`,
      [
        cleanName,
        creatorId,
        parseInt(chainId || 5042002),
        parseFloat(entryFee),
        tokenSymbol || "USDC",
        parseInt(maxPlayers),
        parseInt(rounds),
      ],
    );
    res.json({ tournament: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 5. CREATE whitelist tournament — before /:id
app.post("/tournaments/create-whitelist", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  const {
    name,
    maxPlayers,
    rounds,
    prize1,
    prize2,
    prize3,
    sponsorName,
    discordInvite,
  } = req.body;
  if (!name || !maxPlayers || !rounds)
    return res.status(400).json({ error: "Missing fields" });
  if (parseInt(maxPlayers) < 4 || parseInt(maxPlayers) > 200)
    return res.status(400).json({ error: "Max players: 4–200" });

  const cleanName = sanitizeHtml(name, {
    allowedTags: [],
    allowedAttributes: {},
  });
  const cleanSponsor = sanitizeHtml(sponsorName || "", {
    allowedTags: [],
    allowedAttributes: {},
  });
  const cleanDiscord = sanitizeHtml(discordInvite || "", {
    allowedTags: [],
    allowedAttributes: {},
  });
  const creatorId = (req.user.wallet || req.user.email || "").toLowerCase();

  // ── Anti-bot check ────────────────────────────────────────────────────
  const wlUserCheck = await pool.query(
    `SELECT id, created_at FROM users WHERE LOWER(wallet)=$1 OR LOWER(email)=$1`,
    [creatorId],
  );
  if (!wlUserCheck.rows.length) {
    return res.status(403).json({ error: "Account not found" });
  }
  const wlAccountAge =
    Date.now() - new Date(wlUserCheck.rows[0].created_at).getTime();
  if (wlAccountAge < 5 * 60 * 1000) {
    return res.status(429).json({
      error: "Account too new. Please wait before creating a tournament.",
    });
  }

  const recent = await pool.query(
    `SELECT id FROM tournaments
     WHERE LOWER(creator)=$1
       AND tournament_type='whitelist'
       AND created_at > NOW() - INTERVAL '24 hours'`,
    [creatorId],
  );
  if (recent.rows.length >= 3)
    return res
      .status(429)
      .json({ error: "Max 3 whitelist tournaments per 24 hours" });

  try {
    const result = await pool.query(
      `INSERT INTO tournaments
         (name, creator, chain_id, entry_fee, token_symbol, max_players, rounds,
          deadline_at, tournament_type, prize_1_text, prize_2_text, prize_3_text,
          sponsor_name, discord_invite)
       VALUES ($1,$2,5042002,0,'POINTS',$3,$4, NOW()+INTERVAL '7 days',
               'whitelist',$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        cleanName,
        creatorId,
        parseInt(maxPlayers),
        parseInt(rounds),
        sanitizeHtml(prize1 || "🥇 Whitelist Spot", {
          allowedTags: [],
          allowedAttributes: {},
        }),
        sanitizeHtml(prize2 || "🥈 OG Role", {
          allowedTags: [],
          allowedAttributes: {},
        }),
        sanitizeHtml(prize3 || "🥉 Early Access", {
          allowedTags: [],
          allowedAttributes: {},
        }),
        cleanSponsor,
        cleanDiscord,
      ],
    );
    res.json({ tournament: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 6. CLAIM STATUS — before /:id
app.get("/tournaments/:id/claim-status", async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.json({ status: null });
  try {
    const r = await pool.query(
      `SELECT status, amount, tx_hash, token_symbol
       FROM tournament_claims
       WHERE tournament_id=$1 AND LOWER(wallet)=LOWER($2)`,
      [req.params.id, wallet],
    );
    res.json(r.rows[0] || { status: null });
  } catch (e) {
    res.json({ status: null });
  }
});

// ── WINNER CONTACT: top-3 winner submits their X handle ───────────────────
app.post("/tournaments/:id/winner-contact", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  const { wallet, twitter } = req.body;
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet))
    return res.status(400).json({ error: "Invalid wallet" });
  if (req.user.wallet && req.user.wallet.toLowerCase() !== wallet.toLowerCase())
    return res.status(403).json({ error: "Wallet mismatch" });

  const handle = normalizeTwitter(twitter);
  if (!handle)
    return res.status(400).json({ error: "Enter a valid X/Twitter handle" });

  try {
    const t = await pool.query("SELECT * FROM tournaments WHERE id=$1", [
      req.params.id,
    ]);
    if (!t.rows.length) return res.status(404).json({ error: "Not found" });
    if (t.rows[0].status !== "finished")
      return res.status(400).json({ error: "Tournament not finished yet" });

    // ✅ Server-side verification: only genuine top-3 winners who PLAYED
    const ranked = await pool.query(
      `SELECT tp.wallet FROM tournament_players tp
       WHERE tp.tournament_id=$1
         AND EXISTS (
           SELECT 1 FROM tournament_scores ts
           WHERE ts.tournament_id=$1 AND LOWER(ts.wallet)=LOWER(tp.wallet)
         )
       ORDER BY tp.total_score DESC, tp.joined_at ASC
       LIMIT 3`,
      [req.params.id],
    );
    const pos = ranked.rows.findIndex(
      (r) => r.wallet.toLowerCase() === wallet.toLowerCase(),
    );
    if (pos < 0)
      return res
        .status(403)
        .json({ error: "Only top-3 winners can submit contact info" });

    await pool.query(
      `INSERT INTO tournament_winner_contacts (tournament_id, wallet, position, twitter)
       VALUES ($1, LOWER($2), $3, $4)
       ON CONFLICT (tournament_id, wallet)
       DO UPDATE SET twitter=EXCLUDED.twitter, position=EXCLUDED.position, submitted_at=NOW()`,
      [req.params.id, wallet, pos, handle],
    );
    res.json({ ok: true, twitter: handle, position: pos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WINNER CONTACT: get own submission status ─────────────────────────────
app.get("/tournaments/:id/winner-contact", async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.json({ twitter: null });
  try {
    const r = await pool.query(
      `SELECT twitter, position FROM tournament_winner_contacts
       WHERE tournament_id=$1 AND LOWER(wallet)=LOWER($2)`,
      [req.params.id, wallet],
    );
    res.json(r.rows[0] || { twitter: null });
  } catch (_) {
    res.json({ twitter: null });
  }
});

// ── WINNER CONTACTS: creator views all submitted handles ──────────────────
app.get("/tournaments/:id/winner-contacts", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  try {
    const t = await pool.query("SELECT * FROM tournaments WHERE id=$1", [
      req.params.id,
    ]);
    if (!t.rows.length) return res.status(404).json({ error: "Not found" });
    const creatorId = (req.user.wallet || req.user.email || "").toLowerCase();
    if (t.rows[0].creator.toLowerCase() !== creatorId && !isAdmin(req))
      return res
        .status(403)
        .json({ error: "Only the creator can view winner contacts" });

    const c = await pool.query(
      `SELECT wc.wallet, wc.position, wc.twitter, wc.submitted_at, u.username
       FROM tournament_winner_contacts wc
       LEFT JOIN users u ON LOWER(u.wallet)=LOWER(wc.wallet)
       WHERE wc.tournament_id=$1
       ORDER BY wc.position ASC`,
      [req.params.id],
    );
    res.json(c.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 7. ROUND STATUS — before /:id
app.get("/tournaments/:id/round-status", async (req, res) => {
  if (!req.user) return res.json({ played: false });
  const { wallet } = req.query;
  try {
    const t = await pool.query("SELECT * FROM tournaments WHERE id=$1", [
      req.params.id,
    ]);
    if (!t.rows.length) return res.json({ played: false });
    const tournament = t.rows[0];
    const round = await pool.query(
      "SELECT * FROM tournament_rounds WHERE tournament_id=$1 AND round_number=$2",
      [req.params.id, tournament.current_round],
    );
    if (!round.rows.length) return res.json({ played: false });
    const score = await pool.query(
      `SELECT score FROM tournament_scores
       WHERE tournament_id=$1 AND round_id=$2 AND LOWER(wallet)=LOWER($3)`,
      [req.params.id, round.rows[0].id, wallet || req.user.wallet || ""],
    );
    res.json({
      played: score.rows.length > 0,
      score: score.rows[0]?.score || 0,
      currentRound: tournament.current_round,
      totalRounds: tournament.rounds,
    });
  } catch (e) {
    res.json({ played: false });
  }
});

// 8. JOIN whitelist — before /:id
app.post("/tournaments/:id/join-whitelist", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  const { wallet } = req.body;
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet))
    return res.status(400).json({ error: "Invalid wallet" });
  try {
    const t = await pool.query("SELECT * FROM tournaments WHERE id=$1", [
      req.params.id,
    ]);
    if (!t.rows.length) return res.status(404).json({ error: "Not found" });
    const tournament = t.rows[0];
    if (tournament.tournament_type !== "whitelist")
      return res.status(400).json({ error: "Use /join for paid tournaments" });
    if (tournament.status !== "open")
      return res.status(400).json({ error: "Tournament not open" });
    const count = await pool.query(
      "SELECT COUNT(*) FROM tournament_players WHERE tournament_id=$1",
      [req.params.id],
    );
    if (parseInt(count.rows[0].count) >= tournament.max_players)
      return res.status(400).json({ error: "Tournament full" });

    await pool.query(
      `INSERT INTO tournament_players (tournament_id, wallet, user_id)
       VALUES ($1,$2,$3) ON CONFLICT (tournament_id, wallet) DO NOTHING`,
      [req.params.id, wallet.toLowerCase(), req.user.id],
    );
    const newCount = parseInt(count.rows[0].count) + 1;
    if (newCount >= tournament.max_players) {
      await pool.query(
        "UPDATE tournaments SET status='active', started_at=NOW(), current_round=1 WHERE id=$1",
        [req.params.id],
      );
      await pool.query(
        `INSERT INTO tournament_rounds (tournament_id, round_number, status, started_at)
         VALUES ($1,1,'active',NOW()) ON CONFLICT DO NOTHING`,
        [req.params.id],
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 9. DELETE tournament — before /:id submit/join/claim
app.delete("/tournaments/:id", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  try {
    const t = await pool.query("SELECT * FROM tournaments WHERE id=$1", [
      req.params.id,
    ]);
    if (!t.rows.length) return res.status(404).json({ error: "Not found" });
    const tournament = t.rows[0];
    // ✅ Admin-only deletion — creators cannot delete (prevents abuse)
    if (!isAdmin(req))
      return res
        .status(403)
        .json({ error: "Only an admin can delete tournaments" });
    if (tournament.status === "active")
      return res
        .status(400)
        .json({ error: "Cannot delete an active tournament" });
    await pool.query("DELETE FROM tournaments WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 10. GET single tournament — /:id LAST
app.get("/tournaments/:id", async (req, res) => {
  try {
    const t = await pool.query("SELECT * FROM tournaments WHERE id=$1", [
      req.params.id,
    ]);
    if (!t.rows.length) return res.status(404).json({ error: "Not found" });
    const players = await pool.query(
      `SELECT tp.*, u.username, u.avatar,
              COALESCE(SUM(ts.time_taken), 0) AS total_time
       FROM tournament_players tp
       LEFT JOIN users u ON u.id = tp.user_id
       LEFT JOIN tournament_scores ts
         ON ts.tournament_id = tp.tournament_id
        AND LOWER(ts.wallet) = LOWER(tp.wallet)
       WHERE tp.tournament_id=$1
       GROUP BY tp.id, u.username, u.avatar
       ORDER BY tp.total_score DESC, total_time ASC`,
      [req.params.id],
    );
    const rounds = await pool.query(
      "SELECT * FROM tournament_rounds WHERE tournament_id=$1 ORDER BY round_number",
      [req.params.id],
    );
    res.json({
      tournament: t.rows[0],
      players: players.rows,
      rounds: rounds.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ORPHANED PAYMENT RECOVERY — called when payment succeeds but session expired ──
app.post("/tournaments/:id/recover-payment", async (req, res) => {
  const { wallet, txHash, amount, tokenSymbol } = req.body;
  if (!wallet || !txHash)
    return res.status(400).json({ error: "Missing fields" });

  // Log for manual admin review
  console.error(
    `🚨 ORPHANED PAYMENT REPORT:\n` +
      `  Tournament: ${req.params.id}\n` +
      `  Wallet: ${wallet}\n` +
      `  TX Hash: ${txHash}\n` +
      `  Amount: ${amount} ${tokenSymbol}\n` +
      `  Time: ${new Date().toISOString()}\n` +
      `  Action required: Manually verify tx and register player or refund.`,
  );

  // Store for admin review
  try {
    await pool.query(
      `INSERT INTO game_refunds
       (game_id, chain_id, wallet, amount, token_symbol, tx_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'orphaned_payment')
       ON CONFLICT DO NOTHING`,
      [
        parseInt(req.params.id),
        tokenSymbol === "zkLTC" ? 4441 : 5042002,
        wallet.toLowerCase(),
        parseFloat(amount) || 0,
        tokenSymbol || "USDC",
        txHash,
      ],
    );
  } catch (_) {}

  res.json({ ok: true, message: "Payment recorded for admin review" });
});

// 11. JOIN paid tournament
app.post("/tournaments/:id/join", csrfProtection, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  const { wallet, txHash } = req.body;
  // ── Anti-bot: verify wallet is a real registered user ─────────────────
  const joinerCheck = await pool.query(
    `SELECT id, created_at FROM users WHERE LOWER(wallet)=LOWER($1)`,
    [wallet],
  );
  if (!joinerCheck.rows.length) {
    return res.status(403).json({
      error: "Wallet not registered. Please connect your wallet first.",
    });
  }
  // Block brand-new wallets from joining paid tournaments (bot detection)
  const joinerAge =
    Date.now() - new Date(joinerCheck.rows[0].created_at).getTime();
  if (joinerAge < 2 * 60 * 1000) {
    // 2 minutes
    return res
      .status(429)
      .json({ error: "Please wait a moment before joining." });
  }
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet))
    return res.status(400).json({ error: "Invalid wallet" });

  try {
    const t = await pool.query("SELECT * FROM tournaments WHERE id=$1", [
      req.params.id,
    ]);
    if (!t.rows.length) return res.status(404).json({ error: "Not found" });
    const tournament = t.rows[0];

    if (tournament.status !== "open")
      return res.status(400).json({ error: "Tournament not open" });

    // ── Idempotency: already registered? ─────────────────────────────────
    const existingPlayer = await pool.query(
      "SELECT id FROM tournament_players WHERE tournament_id=$1 AND LOWER(wallet)=LOWER($2)",
      [req.params.id, wallet],
    );
    if (existingPlayer.rows.length > 0) {
      // Already registered — return success (idempotent)
      return res.json({ ok: true, alreadyRegistered: true });
    }

    const count = await pool.query(
      "SELECT COUNT(*) FROM tournament_players WHERE tournament_id=$1",
      [req.params.id],
    );
    if (parseInt(count.rows[0].count) >= tournament.max_players)
      return res.status(400).json({ error: "Tournament full" });

    // ── Anti-bot: verify wallet is a real registered user ─────────────────
    const joinerCheck = await pool.query(
      `SELECT id, created_at FROM users WHERE LOWER(wallet)=LOWER($1)`,
      [wallet],
    );
    if (!joinerCheck.rows.length) {
      return res.status(403).json({
        error: "Wallet not registered. Please connect your wallet first.",
      });
    }
    const joinerAge =
      Date.now() - new Date(joinerCheck.rows[0].created_at).getTime();
    if (joinerAge < 2 * 60 * 1000) {
      return res
        .status(429)
        .json({ error: "Please wait a moment before joining." });
    }

    // ── Rate limit: max 5 join attempts per minute per wallet ────────────
    const recentJoins = await pool.query(
      `SELECT COUNT(*) FROM tournament_join_attempts
       WHERE wallet=LOWER($1) AND attempted_at > NOW() - INTERVAL '1 minute'`,
      [wallet],
    );
    if (parseInt(recentJoins.rows[0].count) >= 5) {
      return res
        .status(429)
        .json({ error: "Too many attempts. Please wait before trying again." });
    }
    await pool.query(
      `INSERT INTO tournament_join_attempts (wallet) VALUES (LOWER($1))`,
      [wallet],
    );

    // ── Verify payment tx onchain (if txHash provided) ────────────────────
    if (txHash && /^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      try {
        const isLitvmT = tournament.token_symbol === "zkLTC";
        const verifyProvider = isLitvmT ? makeLitvmProvider() : makeProvider();
        const receipt = await Promise.race([
          verifyProvider.getTransactionReceipt(txHash),
          new Promise((_, r) =>
            setTimeout(() => r(new Error("timeout")), 8000),
          ),
        ]);

        if (!receipt || receipt.status !== 1) {
          console.error(
            `JOIN rejected: tx ${txHash} not confirmed. ` +
              `tournament=${req.params.id} wallet=${wallet}`,
          );
          return res.status(400).json({
            error:
              "Payment transaction not confirmed onchain. Please wait and try again.",
          });
        }

        // Log verified payment
        console.log(
          `✅ Payment verified: tournament=${req.params.id} ` +
            `wallet=${wallet} tx=${txHash} amount=${tournament.entry_fee} ` +
            `${tournament.token_symbol}`,
        );
      } catch (verifyErr) {
        // If verification times out, log but continue — don't block registration
        console.warn(
          `TX verification timeout for ${txHash}: ${verifyErr.message}. ` +
            `Proceeding with registration.`,
        );
      }
    }

    await pool.query(
      `INSERT INTO tournament_players (tournament_id, wallet, user_id)
       VALUES ($1,$2,$3) ON CONFLICT (tournament_id, wallet) DO NOTHING`,
      [req.params.id, wallet.toLowerCase(), req.user.id],
    );
    await pool.query(
      "UPDATE tournaments SET prize_pool = prize_pool + $1 WHERE id=$2",
      [tournament.entry_fee, req.params.id],
    );

    const isLitvmT = tournament.token_symbol === "zkLTC";
    await pool
      .query(
        `UPDATE platform_stats SET ${isLitvmT ? "total_volume_litvm" : "total_volume"} = ${isLitvmT ? "total_volume_litvm" : "total_volume"} + $1 WHERE id=1`,
        [tournament.entry_fee],
      )
      .catch(() => {});

    const newCount = parseInt(count.rows[0].count) + 1;
    if (newCount >= tournament.max_players) {
      await pool.query(
        "UPDATE tournaments SET status='active', started_at=NOW(), current_round=1 WHERE id=$1",
        [req.params.id],
      );
      await pool.query(
        `INSERT INTO tournament_rounds (tournament_id, round_number, status, started_at)
         VALUES ($1,1,'active',NOW()) ON CONFLICT (tournament_id,round_number) DO NOTHING`,
        [req.params.id],
      );
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("Tournament join error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// 12. SUBMIT round score
app.post(
  "/tournaments/:id/submit",
  scoreLimiter,
  csrfProtection,
  async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not logged in" });
    const { wallet, answers, timeTaken } = req.body;
    if (!wallet || !Array.isArray(answers))
      return res.status(400).json({ error: "Invalid input" });
    try {
      const t = await pool.query("SELECT * FROM tournaments WHERE id=$1", [
        req.params.id,
      ]);
      if (!t.rows.length) return res.status(404).json({ error: "Not found" });
      const tournament = t.rows[0];
      if (tournament.status !== "active")
        return res.status(400).json({ error: "Not active" });

      const roundRes = await pool.query(
        "SELECT * FROM tournament_rounds WHERE tournament_id=$1 AND round_number=$2",
        [req.params.id, tournament.current_round],
      );
      if (!roundRes.rows.length)
        return res.status(400).json({ error: "No active round" });
      const round = roundRes.rows[0];

      const playerRes = await pool.query(
        "SELECT * FROM tournament_players WHERE tournament_id=$1 AND LOWER(wallet)=LOWER($2)",
        [req.params.id, wallet],
      );
      if (!playerRes.rows.length)
        return res.status(403).json({ error: "Not in tournament" });
      if (playerRes.rows[0].eliminated)
        return res.status(400).json({ error: "Eliminated" });

      const existing = await pool.query(
        "SELECT id FROM tournament_scores WHERE tournament_id=$1 AND round_id=$2 AND LOWER(wallet)=LOWER($3)",
        [req.params.id, round.id, wallet],
      );
      if (existing.rows.length)
        return res.status(400).json({ error: "Already submitted this round" });

      const score = Math.min(
        answers.filter((a) => a.correct === true).length * 100,
        1000,
      );
      const cleanTime = Math.max(0, Math.min(600, parseInt(timeTaken) || 0));

      await pool.query(
        "INSERT INTO tournament_scores (tournament_id, round_id, wallet, score, time_taken) VALUES ($1,$2,LOWER($3),$4,$5)",
        [req.params.id, round.id, wallet, score, cleanTime],
      );
      await pool.query(
        "UPDATE tournament_players SET total_score = total_score + $1 WHERE tournament_id=$2 AND LOWER(wallet)=LOWER($3)",
        [score, req.params.id, wallet],
      );

      // ── Sign the tournament score so client can submit onchain ──────────
      const tournamentId = parseInt(req.params.id);
      const roundNumber = parseInt(tournament.current_round);
      const nonce = BigInt(Date.now()); // unique per submission
      const message = ethers.solidityPackedKeccak256(
        ["address", "uint256", "uint256", "uint256", "uint256"],
        [wallet, tournamentId, roundNumber, score, nonce],
      );
      const scoreSignature = await verifierWallet.signMessage(
        ethers.getBytes(message),
      );
      const isLitvmTourney = tournament.token_symbol === "zkLTC";
      const tourneyContractAddr = isLitvmTourney
        ? TOURNAMENT_CONTRACT_LITVM
        : TOURNAMENT_CONTRACT_ARC;
      const tourneyChainId = isLitvmTourney ? 4441 : 5042002;

      // Check if all active players submitted
      const activePlayers = await pool.query(
        "SELECT COUNT(*) FROM tournament_players WHERE tournament_id=$1 AND NOT eliminated",
        [req.params.id],
      );
      const submissions = await pool.query(
        "SELECT COUNT(*) FROM tournament_scores WHERE tournament_id=$1 AND round_id=$2",
        [req.params.id, round.id],
      );

      if (
        parseInt(submissions.rows[0].count) >=
        parseInt(activePlayers.rows[0].count)
      ) {
        await pool.query(
          "UPDATE tournament_rounds SET status='finished', finished_at=NOW() WHERE id=$1",
          [round.id],
        );
        // Rank: highest score wins; on a tie, fastest cumulative time wins;
        // join order is the final fallback. Rewards skill over registration timing.
        const ranked = await pool.query(
          `SELECT tp.wallet, tp.total_score,
                COALESCE(SUM(ts.time_taken), 0) AS total_time
         FROM tournament_players tp
         LEFT JOIN tournament_scores ts
           ON ts.tournament_id = tp.tournament_id
          AND LOWER(ts.wallet) = LOWER(tp.wallet)
         WHERE tp.tournament_id=$1 AND NOT tp.eliminated
         GROUP BY tp.wallet, tp.total_score, tp.joined_at
         ORDER BY tp.total_score DESC, total_time ASC, tp.joined_at ASC`,
          [req.params.id],
        );
        const activeCount = ranked.rows.length;

        // ── FINAL: 2 or fewer remain — this round decides 1st & 2nd ──────────
        if (activeCount <= 2) {
          const winner = ranked.rows[0]?.wallet;
          const runnerUp = ranked.rows[1]?.wallet;
          await pool.query(
            "UPDATE tournaments SET status='finished', finished_at=NOW(), winner=$1 WHERE id=$2",
            [winner, req.params.id],
          );
          if (winner)
            await pool.query(
              "UPDATE tournament_players SET prize_position=0 WHERE tournament_id=$1 AND LOWER(wallet)=LOWER($2)",
              [req.params.id, winner],
            );
          if (runnerUp)
            await pool.query(
              "UPDATE tournament_players SET prize_position=1 WHERE tournament_id=$1 AND LOWER(wallet)=LOWER($2)",
              [req.params.id, runnerUp],
            );
          // 3rd place was assigned when the field dropped from 3→2 (below)
          return res.json({
            ok: true,
            score,
            scoreSignature,
            nonce: nonce.toString(),
            tournamentId,
            roundNumber,
            roundFinished: true,
            tournamentFinished: true,
            winner,
          });
        }

        // ── Otherwise eliminate exactly ONE — the lowest active scorer ───────
        const loser = ranked.rows[ranked.rows.length - 1].wallet;
        await pool.query(
          "UPDATE tournament_players SET eliminated=TRUE WHERE tournament_id=$1 AND LOWER(wallet)=LOWER($2)",
          [req.params.id, loser],
        );

        // If exactly 3 were active, the eliminated player takes 3rd place
        if (activeCount === 3) {
          await pool.query(
            "UPDATE tournament_players SET prize_position=2 WHERE tournament_id=$1 AND LOWER(wallet)=LOWER($2)",
            [req.params.id, loser],
          );
        }

        const nextRound = tournament.current_round + 1;
        await pool.query(
          "UPDATE tournaments SET current_round=$1 WHERE id=$2",
          [nextRound, req.params.id],
        );
        await pool.query(
          `INSERT INTO tournament_rounds (tournament_id, round_number, status, started_at)
         VALUES ($1,$2,'active',NOW())
         ON CONFLICT (tournament_id,round_number) DO NOTHING`,
          [req.params.id, nextRound],
        );

        return res.json({
          ok: true,
          score,
          scoreSignature,
          nonce: nonce.toString(),
          tournamentId,
          roundNumber,
          roundFinished: true,
          tournamentFinished: false,
          nextRound,
          eliminated: [loser],
        });
      }
      res.json({
        ok: true,
        score,
        scoreSignature,
        nonce: nonce.toString(),
        tournamentId,
        roundNumber,
        roundFinished: false,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

app.post("/games/sync", async (req, res) => {
  try {
    const {
      chainId,
      contractGameId,
      creator,
      name,
      category,
      difficulty,
      entryFee,
      tokenSymbol,
      maxPlayers,
      prizePool,
      status,
      playerCount,
      registrationEnd,
      playDeadline,
      finishedCount,
    } = req.body;
    if (!chainId || !contractGameId) return res.json({ ok: false });
    const cleanName = sanitizeHtml(String(name || ""), {
      allowedTags: [],
      allowedAttributes: {},
    });
    await pool.query(
      `INSERT INTO games (chain_id,contract_game_id,creator,name,category,difficulty,entry_fee,token_symbol,max_players,tx_hash,prize_pool,status,player_count,registration_end,play_deadline,finished_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'',$10,COALESCE($11,0),$12,$13,$14,$15)
       ON CONFLICT (chain_id,contract_game_id) DO UPDATE SET
         prize_pool=EXCLUDED.prize_pool, status=COALESCE(EXCLUDED.status,games.status),
         player_count=EXCLUDED.player_count, registration_end=EXCLUDED.registration_end,
         play_deadline=EXCLUDED.play_deadline, finished_count=EXCLUDED.finished_count,
         name=EXCLUDED.name, creator=EXCLUDED.creator`,
      [
        chainId,
        contractGameId,
        creator || "",
        cleanName,
        category || "",
        difficulty || 0,
        entryFee || 0,
        tokenSymbol || "zkLTC",
        maxPlayers || 0,
        prizePool || 0,
        status ?? null,
        playerCount ?? 0,
        registrationEnd ?? 0,
        playDeadline ?? 0,
        finishedCount ?? 0,
      ],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/admin/debug-refund", async (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: "Forbidden" });

  const { wallet, chainId } = req.body;
  const results = {};

  // 1. Check treasury balance
  try {
    const provider = chainId === 4441 ? makeLitvmProvider() : makeProvider();
    const balance = await provider.getBalance(
      process.env.TREASURY_ADDRESS || verifierWallet.address,
    );
    results.treasuryBalance = ethers.formatUnits(
      balance,
      chainId === 4441 ? 18 : 18,
    );
    results.treasuryAddress =
      process.env.TREASURY_ADDRESS || verifierWallet.address;
  } catch (e) {
    results.treasuryBalanceError = e.message;
  }

  // 2. Check RPC connectivity
  try {
    const provider = chainId === 4441 ? makeLitvmProvider() : makeProvider();
    const block = await provider.getBlockNumber();
    results.blockNumber = block;
    results.rpcOk = true;
  } catch (e) {
    results.rpcError = e.message;
    results.rpcOk = false;
  }

  // 3. Check pending refunds for this wallet
  try {
    const pending = await pool.query(
      `SELECT * FROM game_refunds WHERE wallet=$1 ORDER BY created_at DESC LIMIT 10`,
      [wallet],
    );
    results.pendingRefunds = pending.rows;
  } catch (e) {
    results.pendingRefundsError = e.message;
  }

  // 4. Check verifier wallet address
  results.verifierAddress = verifierWallet.address;

  // 5. Try a test getBalance call
  try {
    const provider = chainId === 4441 ? makeLitvmProvider() : makeProvider();
    const walletBal = await provider.getBalance(wallet);
    results.walletBalance = ethers.formatUnits(walletBal, 18);
  } catch (e) {
    results.walletBalanceError = e.message;
  }

  res.json(results);
});

app.get("/games/count", async (req, res) => {
  try {
    const chainId = req.query.chainId ? parseInt(req.query.chainId) : null;
    const result = chainId
      ? await pool.query(
          `SELECT COUNT(*) as count FROM games WHERE chain_id=$1`,
          [chainId],
        )
      : await pool.query(`SELECT COUNT(*) as count FROM games`);
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── FAST: serve game display data from DB (no RPC needed) ────────────────
app.get("/games/display/:chainId/:gameId", async (req, res) => {
  try {
    const { chainId, gameId } = req.params;
    const game = await pool.query(
      `SELECT g.*,
        (SELECT COUNT(*) FROM game_sessions 
         WHERE game_id=$1 AND chain_id=$2 AND finished=true) AS finished_count,
        (SELECT COUNT(*) FROM game_sessions 
         WHERE game_id=$1 AND chain_id=$2) AS session_count
       FROM games g
       WHERE g.contract_game_id=$1 AND g.chain_id=$2`,
      [gameId, chainId],
    );
    if (!game.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(game.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 13. CLAIM prize
app.post("/tournaments/:id/claim", csrfProtection, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  const { wallet } = req.body;
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet))
    return res.status(400).json({ error: "Invalid wallet" });
  try {
    const t = await pool.query("SELECT * FROM tournaments WHERE id=$1", [
      req.params.id,
    ]);
    if (!t.rows.length) return res.status(404).json({ error: "Not found" });
    const tournament = t.rows[0];
    if (tournament.status !== "finished")
      return res.status(400).json({ error: "Tournament not finished yet" });

    // ✅ SECURITY: verify player actually submitted scores in at least one round
    const playedCheck = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM tournament_scores
       WHERE tournament_id=$1 AND LOWER(wallet)=LOWER($2)`,
      [req.params.id, wallet],
    );
    if (parseInt(playedCheck.rows[0].cnt) === 0) {
      return res.status(400).json({
        error: "no_play",
        message:
          "You registered but did not play any rounds. You can request a refund instead.",
      });
    }

    // ✅ Only top-3 by score are prize winners
    const rankings = await pool.query(
      `SELECT tp.wallet, tp.total_score
       FROM tournament_players tp
       WHERE tp.tournament_id=$1
         AND EXISTS (
           SELECT 1 FROM tournament_scores ts
           WHERE ts.tournament_id=$1 AND LOWER(ts.wallet)=LOWER(tp.wallet)
         )
       ORDER BY tp.total_score DESC, tp.joined_at ASC
       LIMIT 3`,
      [req.params.id],
    );

    const myPos = rankings.rows.findIndex(
      (p) => p.wallet.toLowerCase() === wallet.toLowerCase(),
    );
    if (myPos < 0 || myPos > 2)
      return res.status(400).json({ error: "You are not a top-3 winner" });

    const existing = await pool.query(
      "SELECT * FROM tournament_claims WHERE tournament_id=$1 AND LOWER(wallet)=LOWER($2)",
      [req.params.id, wallet],
    );
    if (existing.rows.length && existing.rows[0].status === "paid")
      return res.status(400).json({ error: "Prize already claimed" });

    const splits = [0.6, 0.25, 0.15];
    const prizeAmount = parseFloat(tournament.prize_pool) * splits[myPos];
    const isLitvm = tournament.token_symbol === "zkLTC";
    const decimals = isLitvm ? 18 : 6;
    const amountWei = ethers.parseUnits(
      prizeAmount.toFixed(decimals),
      decimals,
    );

    await pool.query(
      `INSERT INTO tournament_claims (tournament_id,wallet,amount,token_symbol,status)
       VALUES ($1,$2,$3,$4,'pending')
       ON CONFLICT (tournament_id,wallet) DO UPDATE SET status='pending'`,
      [
        req.params.id,
        wallet.toLowerCase(),
        prizeAmount,
        tournament.token_symbol,
      ],
    );

    try {
      let txHash;
      if (isLitvm) {
        const fastProvider = await makeLitvmProviderFast();
        const ws = verifierWallet.connect(fastProvider);
        const feeData = await fastProvider.getFeeData();
        let gasLimit = 21000n;
        try {
          const est = await fastProvider.estimateGas({
            to: wallet,
            value: amountWei,
            from: verifierWallet.address,
          });
          gasLimit = (BigInt(est) * 150n) / 100n;
        } catch (_) {
          gasLimit = 100000n;
        }
        const tx = await ws.sendTransaction({
          to: wallet,
          value: amountWei,
          gasLimit,
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
          chainId: 4441,
        });
        await tx.wait();
        txHash = tx.hash;
      } else {
        const ARC_USDC = "0x3600000000000000000000000000000000000000";
        const ws = verifierWallet.connect(makeProvider());
        const uc = new ethers.Contract(
          ARC_USDC,
          ["function transfer(address,uint256) external returns (bool)"],
          ws,
        );
        const tx = await uc.transfer(wallet, amountWei);
        await tx.wait();
        txHash = tx.hash;
      }
      await pool.query(
        `UPDATE tournament_claims SET status='paid', tx_hash=$1
         WHERE tournament_id=$2 AND LOWER(wallet)=LOWER($3)`,
        [txHash, req.params.id, wallet],
      );
      await pool.query(
        `UPDATE tournament_players SET prize_position=$1
         WHERE tournament_id=$2 AND LOWER(wallet)=LOWER($3)`,
        [myPos, req.params.id, wallet],
      );
      await pool
        .query(
          `UPDATE platform_stats SET tournament_volume=tournament_volume+$1 WHERE id=1`,
          [prizeAmount],
        )
        .catch(() => {});
      return res.json({
        ok: true,
        paid: true,
        amount: prizeAmount,
        txHash,
        position: myPos,
      });
    } catch (payErr) {
      console.error("Auto-payout failed:", payErr.message);
      return res.json({
        ok: true,
        paid: false,
        pending: true,
        amount: prizeAmount,
        message: "Payout queued — funds arrive within 24h",
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── REFUND for registered-but-never-played tournament players ─────────────
app.post("/tournaments/:id/refund", csrfProtection, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  const { wallet } = req.body;
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet))
    return res.status(400).json({ error: "Invalid wallet" });
  try {
    const t = await pool.query("SELECT * FROM tournaments WHERE id=$1", [
      req.params.id,
    ]);
    if (!t.rows.length) return res.status(404).json({ error: "Not found" });
    const tournament = t.rows[0];

    // Must be finished or cancelled — not open/active
    if (tournament.status === "active")
      return res.status(400).json({ error: "Tournament is still active" });
    if (tournament.tournament_type === "whitelist")
      return res
        .status(400)
        .json({ error: "Whitelist tournaments have no entry fee" });

    // Check player is registered
    const playerRow = await pool.query(
      `SELECT * FROM tournament_players
       WHERE tournament_id=$1 AND LOWER(wallet)=LOWER($2)`,
      [req.params.id, wallet],
    );
    if (!playerRow.rows.length)
      return res
        .status(404)
        .json({ error: "You are not registered in this tournament" });

    const player = playerRow.rows[0];
    if (player.refunded)
      return res.status(400).json({ error: "Already refunded" });

    // ✅ Only refund if player never played any round
    const scoresCheck = await pool.query(
      `SELECT COUNT(*) AS cnt FROM tournament_scores
       WHERE tournament_id=$1 AND LOWER(wallet)=LOWER($2)`,
      [req.params.id, wallet],
    );
    if (parseInt(scoresCheck.rows[0].cnt) > 0) {
      return res.status(400).json({
        error: "You played at least one round — refunds are only for no-shows",
      });
    }

    // Calculate refund = entry fee
    const refundAmount = parseFloat(tournament.entry_fee);
    if (refundAmount <= 0)
      return res.status(400).json({ error: "No entry fee to refund" });

    const isLitvm = tournament.token_symbol === "zkLTC";
    const decimals = isLitvm ? 18 : 6;
    const amountWei = ethers.parseUnits(
      refundAmount.toFixed(decimals),
      decimals,
    );

    try {
      let txHash;
      if (isLitvm) {
        const fastProvider = await makeLitvmProviderFast();
        const ws = verifierWallet.connect(fastProvider);
        const feeData = await fastProvider.getFeeData();
        let gasLimit = 21000n;
        try {
          const est = await fastProvider.estimateGas({
            to: wallet,
            value: amountWei,
            from: verifierWallet.address,
          });
          gasLimit = (BigInt(est) * 150n) / 100n;
        } catch (_) {
          gasLimit = 100000n;
        }
        const tx = await ws.sendTransaction({
          to: wallet,
          value: amountWei,
          gasLimit,
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
          chainId: 4441,
        });
        await tx.wait();
        txHash = tx.hash;
      } else {
        const ARC_USDC = "0x3600000000000000000000000000000000000000";
        const ws = verifierWallet.connect(makeProvider());
        const uc = new ethers.Contract(
          ARC_USDC,
          ["function transfer(address,uint256) external returns (bool)"],
          ws,
        );
        const tx = await uc.transfer(wallet, amountWei);
        await tx.wait();
        txHash = tx.hash;
      }
      // Mark as refunded
      await pool.query(
        `UPDATE tournament_players
         SET refunded=TRUE, refunded_at=NOW(), refund_tx=$1
         WHERE tournament_id=$2 AND LOWER(wallet)=LOWER($3)`,
        [txHash, req.params.id, wallet],
      );
      return res.json({
        ok: true,
        refunded: true,
        amount: refundAmount,
        txHash,
      });
    } catch (payErr) {
      console.error("Refund failed:", payErr.message);
      return res.status(500).json({
        error:
          "Refund transaction failed. Contact support with tournament ID: " +
          req.params.id,
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WL TASKS: get tasks for a tournament ─────────────────────────────────
app.get("/tournaments/:id/wl-tasks", async (req, res) => {
  try {
    const tasks = await pool.query(
      "SELECT * FROM tournament_wl_tasks WHERE tournament_id=$1 ORDER BY sort_order,id",
      [req.params.id],
    );
    // If wallet provided, also return which tasks they completed
    const { wallet } = req.query;
    let completedIds = [];
    if (wallet && /^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      const done = await pool.query(
        `SELECT task_id FROM tournament_wl_completions
         WHERE tournament_id=$1 AND LOWER(wallet)=LOWER($2)`,
        [req.params.id, wallet],
      );
      completedIds = done.rows.map((r) => r.task_id);
    }
    res.json({ tasks: tasks.rows, completedIds });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WL TASKS: creator adds a task ────────────────────────────────────────
app.post("/tournaments/:id/wl-tasks", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  try {
    const t = await pool.query("SELECT * FROM tournaments WHERE id=$1", [
      req.params.id,
    ]);
    if (!t.rows.length) return res.status(404).json({ error: "Not found" });
    const creatorId = (req.user.wallet || req.user.email || "").toLowerCase();
    if (t.rows[0].creator.toLowerCase() !== creatorId)
      return res.status(403).json({ error: "Only creator can add tasks" });

    const { task_type, label, action_url, action_text } = req.body;
    if (!label) return res.status(400).json({ error: "Label required" });

    const cleanLabel = sanitizeHtml(label, {
      allowedTags: [],
      allowedAttributes: {},
    });
    const cleanUrl = sanitizeHtml(action_url || "", {
      allowedTags: [],
      allowedAttributes: {},
    });
    const cleanText = sanitizeHtml(action_text || "Complete", {
      allowedTags: [],
      allowedAttributes: {},
    });

    const r = await pool.query(
      `INSERT INTO tournament_wl_tasks (tournament_id,task_type,label,action_url,action_text)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, task_type || "custom", cleanLabel, cleanUrl, cleanText],
    );
    res.json({ task: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WL TASKS: creator deletes a task ─────────────────────────────────────
app.delete("/tournaments/:id/wl-tasks/:taskId", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  try {
    const t = await pool.query("SELECT * FROM tournaments WHERE id=$1", [
      req.params.id,
    ]);
    if (!t.rows.length) return res.status(404).json({ error: "Not found" });
    const creatorId = (req.user.wallet || req.user.email || "").toLowerCase();
    if (t.rows[0].creator.toLowerCase() !== creatorId)
      return res.status(403).json({ error: "Only creator can delete tasks" });
    await pool.query(
      "DELETE FROM tournament_wl_tasks WHERE id=$1 AND tournament_id=$2",
      [req.params.taskId, req.params.id],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WL COMPLETIONS: mark a task done for applicant ───────────────────────
app.post("/tournaments/:id/wl-task-done", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  const { wallet, taskId } = req.body;
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet))
    return res.status(400).json({ error: "Invalid wallet" });
  try {
    await pool.query(
      `INSERT INTO tournament_wl_completions (tournament_id,task_id,wallet)
       VALUES ($1,$2,LOWER($3)) ON CONFLICT DO NOTHING`,
      [req.params.id, taskId, wallet],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── APPLICATIONS: user applies to whitelist tournament ───────────────────
app.post("/tournaments/:id/apply", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  const { wallet } = req.body;
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet))
    return res.status(400).json({ error: "Invalid wallet" });
  try {
    const t = await pool.query("SELECT * FROM tournaments WHERE id=$1", [
      req.params.id,
    ]);
    if (!t.rows.length) return res.status(404).json({ error: "Not found" });
    const tournament = t.rows[0];
    if (tournament.tournament_type !== "whitelist")
      return res.status(400).json({ error: "Not a whitelist tournament" });
    if (tournament.status !== "open")
      return res.status(400).json({ error: "Tournament not open" });

    // ✅ Check all required tasks are completed
    const tasks = await pool.query(
      "SELECT id FROM tournament_wl_tasks WHERE tournament_id=$1",
      [req.params.id],
    );
    if (tasks.rows.length > 0) {
      const done = await pool.query(
        `SELECT task_id FROM tournament_wl_completions
         WHERE tournament_id=$1 AND LOWER(wallet)=LOWER($2)`,
        [req.params.id, wallet],
      );
      const doneIds = new Set(done.rows.map((r) => r.task_id));
      const missing = tasks.rows.filter((t) => !doneIds.has(t.id));
      if (missing.length > 0) {
        return res.status(400).json({
          error: "Complete all tasks before applying",
          missingCount: missing.length,
        });
      }
    }

    // Check not already applied
    const existing = await pool.query(
      "SELECT * FROM tournament_applications WHERE tournament_id=$1 AND LOWER(wallet)=LOWER($2)",
      [req.params.id, wallet],
    );
    if (existing.rows.length > 0) {
      const app = existing.rows[0];
      if (app.status === "approved")
        return res.status(400).json({ error: "Already approved and joined" });
      if (app.status === "pending")
        return res
          .status(400)
          .json({ error: "Application already pending review" });
      if (app.status === "rejected")
        return res.status(400).json({ error: "Your application was rejected" });
    }

    // Check capacity
    const playerCount = await pool.query(
      "SELECT COUNT(*) FROM tournament_players WHERE tournament_id=$1",
      [req.params.id],
    );
    if (parseInt(playerCount.rows[0].count) >= tournament.max_players)
      return res.status(400).json({ error: "Tournament is full" });

    await pool.query(
      `INSERT INTO tournament_applications (tournament_id,wallet,user_id,status)
       VALUES ($1,LOWER($2),$3,'pending')
       ON CONFLICT (tournament_id,wallet) DO UPDATE SET status='pending',applied_at=NOW()`,
      [req.params.id, wallet, req.user.id],
    );
    res.json({ ok: true, status: "pending" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── APPLICATIONS: get application status for a wallet ────────────────────
app.get("/tournaments/:id/my-application", async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.json({ status: null });
  try {
    const r = await pool.query(
      `SELECT status FROM tournament_applications
       WHERE tournament_id=$1 AND LOWER(wallet)=LOWER($2)`,
      [req.params.id, wallet],
    );
    res.json({ status: r.rows[0]?.status || null });
  } catch (e) {
    res.json({ status: null });
  }
});

app.get("/games/active-count", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM games 
       WHERE status = 0 
       AND play_deadline > $1`,
      [Math.floor(Date.now() / 1000)],
    );
    const count = parseInt(result.rows[0].count) || 0;
    res.json({ count, active: count });
  } catch (e) {
    res.json({ count: 0 });
  }
});

// ── APPLICATIONS: creator gets all applications ───────────────────────────
app.get("/tournaments/:id/applications", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  try {
    const t = await pool.query("SELECT * FROM tournaments WHERE id=$1", [
      req.params.id,
    ]);
    if (!t.rows.length) return res.status(404).json({ error: "Not found" });
    const creatorId = (req.user.wallet || req.user.email || "").toLowerCase();
    if (t.rows[0].creator.toLowerCase() !== creatorId && !isAdmin(req))
      return res
        .status(403)
        .json({ error: "Only creator can view applications" });

    const apps = await pool.query(
      `SELECT a.*, u.username, u.avatar,
        (SELECT COUNT(*) FROM tournament_wl_completions c
         WHERE c.tournament_id=a.tournament_id AND LOWER(c.wallet)=LOWER(a.wallet)
        ) AS tasks_done,
        (SELECT COUNT(*) FROM tournament_wl_tasks tk WHERE tk.tournament_id=a.tournament_id
        ) AS tasks_total
       FROM tournament_applications a
       LEFT JOIN users u ON u.id=a.user_id
       WHERE a.tournament_id=$1
       ORDER BY a.applied_at DESC`,
      [req.params.id],
    );
    res.json(apps.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── APPLICATIONS: creator approves or rejects ─────────────────────────────
app.post("/tournaments/:id/applications/:appId/review", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  const { decision } = req.body; // 'approved' or 'rejected'
  if (!["approved", "rejected"].includes(decision))
    return res.status(400).json({ error: "Invalid decision" });
  try {
    const t = await pool.query("SELECT * FROM tournaments WHERE id=$1", [
      req.params.id,
    ]);
    if (!t.rows.length) return res.status(404).json({ error: "Not found" });
    const tournament = t.rows[0];
    const creatorId = (req.user.wallet || req.user.email || "").toLowerCase();
    if (tournament.creator.toLowerCase() !== creatorId && !isAdmin(req))
      return res
        .status(403)
        .json({ error: "Only creator can review applications" });

    const app = await pool.query(
      "SELECT * FROM tournament_applications WHERE id=$1 AND tournament_id=$2",
      [req.params.appId, req.params.id],
    );
    if (!app.rows.length)
      return res.status(404).json({ error: "Application not found" });
    if (app.rows[0].status !== "pending")
      return res.status(400).json({ error: "Application already reviewed" });

    // Check capacity before approving
    if (decision === "approved") {
      const playerCount = await pool.query(
        "SELECT COUNT(*) FROM tournament_players WHERE tournament_id=$1",
        [req.params.id],
      );
      if (parseInt(playerCount.rows[0].count) >= tournament.max_players)
        return res
          .status(400)
          .json({ error: "Tournament is full — cannot approve more players" });
    }

    await pool.query(
      `UPDATE tournament_applications
       SET status=$1, reviewed_at=NOW(), reviewed_by=$2
       WHERE id=$3`,
      [decision, creatorId, req.params.appId],
    );

    // If approved → add to tournament_players
    if (decision === "approved") {
      const appRow = app.rows[0];
      await pool.query(
        `INSERT INTO tournament_players (tournament_id,wallet,user_id)
         VALUES ($1,$2,$3) ON CONFLICT (tournament_id,wallet) DO NOTHING`,
        [req.params.id, appRow.wallet, appRow.user_id],
      );

      // Auto-start if full
      const newCount = await pool.query(
        "SELECT COUNT(*) FROM tournament_players WHERE tournament_id=$1",
        [req.params.id],
      );
      if (parseInt(newCount.rows[0].count) >= tournament.max_players) {
        await pool.query(
          "UPDATE tournaments SET status='active', started_at=NOW(), current_round=1, rounds=GREATEST(2, max_players - 1) WHERE id=$1",
          [req.params.id],
        );
        await pool.query(
          `INSERT INTO tournament_rounds (tournament_id,round_number,status,started_at)
           VALUES ($1,1,'active',NOW()) ON CONFLICT DO NOTHING`,
          [req.params.id],
        );
      }
    }

    res.json({ ok: true, decision });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN GUARD ───────────────────────────────────────────────────────────
const ADMIN_WALLET = (process.env.ADMIN_WALLET || "").toLowerCase();
function isAdmin(req) {
  const w = (req.user?.wallet || "").toLowerCase();
  return w && w === ADMIN_WALLET;
}

// ── WHO IS ADMIN (so frontend doesn't need hardcoded wallet) ──────────────
app.get("/admin/me", (req, res) => {
  if (!req.user) return res.json({ isAdmin: false });
  res.json({ isAdmin: isAdmin(req) });
});

// ── GET ACTIVE TASKS ──────────────────────────────────────────────────────
app.get("/tasks", async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT * FROM platform_tasks WHERE is_active=TRUE ORDER BY id",
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN: CREATE TASK ────────────────────────────────────────────────────
app.post("/admin/tasks", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
  const { task_type, label, action_url, action_text, target } = req.body;
  if (!label || !task_type)
    return res.status(400).json({ error: "Missing fields" });
  try {
    const r = await pool.query(
      `INSERT INTO platform_tasks (task_type,label,action_url,action_text,target)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [
        task_type,
        label,
        action_url || "",
        action_text || "Complete Task",
        target || "all",
      ],
    );
    res.json({ task: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN: DELETE TASK ────────────────────────────────────────────────────
app.delete("/admin/tasks/:id", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
  try {
    await pool.query("UPDATE platform_tasks SET is_active=FALSE WHERE id=$1", [
      req.params.id,
    ]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/config/treasury", (req, res) => {
  res.json({
    address: TREASURY_ADDRESS,
    // Confirm it matches the verifier (they should be the same wallet)
    verified: verifierWallet.address.toLowerCase() === TREASURY_ADDRESS,
  });
});

// ── MARK TASK DONE ────────────────────────────────────────────────────────
app.post("/tasks/:id/complete", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  try {
    await pool.query(
      `INSERT INTO user_task_completions (user_id,task_id)
       VALUES ($1,$2) ON CONFLICT (user_id,task_id) DO NOTHING`,
      [req.user.id, req.params.id],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CHECK USER TASKS DONE ─────────────────────────────────────────────────
app.get("/tasks/status", async (req, res) => {
  if (!req.user) return res.json({ allDone: true, tasks: [], completed: [] });
  try {
    const tasks = await pool.query(
      "SELECT * FROM platform_tasks WHERE is_active=TRUE ORDER BY id",
    );
    const done = await pool.query(
      "SELECT task_id FROM user_task_completions WHERE user_id=$1",
      [req.user.id],
    );
    const completedIds = new Set(done.rows.map((r) => r.task_id));
    const allDone = tasks.rows.every((t) => completedIds.has(t.id));
    res.json({
      allDone,
      tasks: tasks.rows,
      completed: [...completedIds],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GenLayer AI Question Generation (Bradbury Testnet) ────────────────────
let genLayerClient = null;

async function initGenLayer() {
  try {
    const { createClient, createAccount } = await import("genlayer-js");
    const { testnetBradbury } = await import("genlayer-js/chains");

    genLayerClient = createClient({
      chain: testnetBradbury,
      account: createAccount(process.env.GENLAYER_PRIVATE_KEY),
    });

    console.log("✅ GenLayer client initialized on Bradbury Testnet");
  } catch (err) {
    console.error("❌ GenLayer init failed:", err.message);
    genLayerClient = null;
  }
}

async function generateGenLayerQuestion(category, difficulty) {
  if (!genLayerClient) return null;
  try {
    const { TransactionStatus } = await import("genlayer-js/types");

    const txHash = await genLayerClient.writeContract({
      address: process.env.GENLAYER_CONTRACT,
      functionName: "get_question",
      args: [category, difficulty],
      value: BigInt(0),
    });

    console.log("GenLayer TX:", txHash);

    const receipt = await genLayerClient.waitForTransactionReceipt({
      hash: txHash,
      status: TransactionStatus.ACCEPTED,
      interval: 5000,
      retries: 24,
    });

    console.log("GenLayer receipt status:", receipt.status);

    const result = await genLayerClient.readContract({
      address: process.env.GENLAYER_CONTRACT,
      functionName: "get_result",
      args: [],
    });

    return typeof result === "string" ? JSON.parse(result) : result;
  } catch (err) {
    console.error("GenLayer question error:", err.message);
    return null;
  }
}

async function preGenerateGenLayerQuestions() {
  if (!genLayerClient) {
    console.log("⚠️ GenLayer client not ready, skipping generation");
    return;
  }
  try {
    const countRes = await pool.query(
      "SELECT COUNT(*) FROM genlayer_questions WHERE used = FALSE",
    );
    const unused = parseInt(countRes.rows[0].count);
    console.log(`🤖 GenLayer pool check: ${unused} available`);

    if (unused >= 100) {
      console.log("✅ GenLayer pool full (100), skipping generation");
      return;
    }

    const totalRes = await pool.query(
      "SELECT COUNT(*) FROM genlayer_questions",
    );
    const total = parseInt(totalRes.rows[0].count);
    if (total > 0 && unused === 0) {
      console.log("🔄 GenLayer pool empty — resetting all questions to unused");
      await pool.query("UPDATE genlayer_questions SET used = FALSE");
      return;
    }

    const categories = [
      "crypto",
      "blockchain",
      "web3",
      "defi",
      "nft",
      "bitcoin",
      "ethereum",
      "solidity",
      "smart contracts",
      "layer2",
    ];
    const difficulties = ["easy", "medium", "hard"];

    const toGenerate = unused < 20 ? 10 : 3;
    console.log(
      `🤖 GenLayer: Generating ${toGenerate} questions sequentially...`,
    );

    let generated = 0;
    for (let i = 0; i < toGenerate; i++) {
      try {
        const cat = categories[Math.floor(Math.random() * categories.length)];
        const diff =
          difficulties[Math.floor(Math.random() * difficulties.length)];

        console.log(`🔄 GenLayer Q${i + 1}/${toGenerate}: ${cat}/${diff}...`);
        const question = await generateGenLayerQuestion(cat, diff);

        if (question) {
          await pool.query(
            "INSERT INTO genlayer_questions (category, difficulty, data) VALUES ($1, $2, $3)",
            [cat, diff, JSON.stringify(question)],
          );
          generated++;
          console.log(`✅ GenLayer saved Q${generated}: ${cat}/${diff}`);
        } else {
          console.log(`⚠️ GenLayer Q${i + 1} returned null — skipping`);
        }

        // Wait between each to let nonce settle on Bradbury
        await new Promise((r) => setTimeout(r, 12000));
      } catch (qErr) {
        console.error(`❌ GenLayer Q${i + 1} failed:`, qErr.message);
        // Wait longer on error before next attempt
        await new Promise((r) => setTimeout(r, 20000));
      }
    }

    console.log(`🎉 GenLayer done: ${generated}/${toGenerate} questions added`);
  } catch (err) {
    console.error("GenLayer pre-gen error:", err.message);
  }
}

const GENLAYER_ENABLED = process.env.GENLAYER_ENABLED === "true";
let _genlayerConsecutiveFailures = 0;
const GENLAYER_MAX_CONSECUTIVE_FAILURES = 3;
let _genlayerCircuitOpen = false;

async function safePreGenerateGenLayerQuestions() {
  if (!GENLAYER_ENABLED || _genlayerCircuitOpen) return;
  try {
    await Promise.race([
      preGenerateGenLayerQuestions(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("GenLayer cycle timeout")),
          15 * 60 * 1000,
        ),
      ),
    ]);
    _genlayerConsecutiveFailures = 0;
  } catch (e) {
    _genlayerConsecutiveFailures++;
    console.error(
      `❌ GenLayer cycle failed (${_genlayerConsecutiveFailures}/${GENLAYER_MAX_CONSECUTIVE_FAILURES}):`,
      e.message,
    );
    if (_genlayerConsecutiveFailures >= GENLAYER_MAX_CONSECUTIVE_FAILURES) {
      _genlayerCircuitOpen = true;
      console.error(
        "⛔ GenLayer circuit breaker OPENED — disabled until /admin/genlayer/reset",
      );
    }
  }
}

if (GENLAYER_ENABLED) {
  initGenLayer()
    .then(() => {
      setTimeout(safePreGenerateGenLayerQuestions, 30000);
      setInterval(safePreGenerateGenLayerQuestions, 10 * 60 * 1000);
    })
    .catch((e) => {
      console.error("❌ GenLayer init failed, disabled:", e.message);
      _genlayerCircuitOpen = true;
    });
} else {
  console.log("⏭️  GenLayer disabled (set GENLAYER_ENABLED=true to enable)");
}

app.post("/admin/genlayer/reset", async (req, res) => {
  const keyOk = req.headers["x-admin-key"] === process.env.ADMIN_SECRET;
  if (!keyOk && !isAdmin(req))
    return res.status(403).json({ error: "Forbidden" });
  _genlayerCircuitOpen = false;
  _genlayerConsecutiveFailures = 0;
  res.json({ ok: true });
});

app.get("/admin/genlayer/status", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
  res.json({
    enabled: GENLAYER_ENABLED,
    circuitOpen: _genlayerCircuitOpen,
    consecutiveFailures: _genlayerConsecutiveFailures,
  });
});

// ── Block all raw access paths ────────────────────────────────────────────
app.get("/genlayer/question", (req, res) =>
  res.status(403).json({ error: "Forbidden" }),
);
app.get("/genlayer/questions", (req, res) =>
  res.status(403).json({ error: "Forbidden" }),
);
app.get("/genlayer/questions/*", (req, res) =>
  res.status(403).json({ error: "Forbidden" }),
);

// Stats only — counts, never question content
app.get("/genlayer/stats", async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE used=FALSE) as available,
        COUNT(*) FILTER (WHERE used=TRUE)  as used,
        COUNT(*)                           as total
      FROM genlayer_questions
    `);
    res.json({ ok: true, stats: stats.rows[0], network: "bradbury" });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Assign question to active player — answer encrypted, never sent to client
app.post("/genlayer/assign", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });

  const { tournamentId, roundNumber } = req.body;
  if (!tournamentId || !roundNumber) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    // Must be active non-eliminated player in exactly this round
    const playerCheck = await pool.query(
      `SELECT tp.wallet FROM tournament_players tp
       JOIN tournaments t ON t.id = tp.tournament_id
       WHERE tp.tournament_id=$1
         AND LOWER(tp.wallet)=LOWER($2)
         AND tp.eliminated=FALSE
         AND t.status='active'
         AND t.current_round=$3`,
      [tournamentId, req.user.wallet || "", parseInt(roundNumber)],
    );

    if (!playerCheck.rows.length) {
      return res.status(403).json({ error: "Not authorized" });
    }

    // Already assigned — return same question (handles page refresh)
    const existing = await pool.query(
      `SELECT id, question_text, options FROM genlayer_round_questions
       WHERE tournament_id=$1 AND round_number=$2 AND LOWER(wallet)=LOWER($3)`,
      [tournamentId, roundNumber, req.user.wallet],
    );

    if (existing.rows.length > 0) {
      return res.json({
        ok: true,
        question: {
          id: existing.rows[0].id,
          question: existing.rows[0].question_text,
          options: JSON.parse(existing.rows[0].options),
          category: "web3",
          // NO correct answer
        },
      });
    }

    // Instant pull from pre-generated pool
    let cached = await pool.query(
      "SELECT id, data FROM genlayer_questions WHERE used=FALSE ORDER BY RANDOM() LIMIT 1",
    );

    // Auto-reset pool if empty
    if (cached.rows.length === 0) {
      console.log("🔄 GenLayer pool empty — resetting");
      await pool.query("UPDATE genlayer_questions SET used=FALSE");
      cached = await pool.query(
        "SELECT id, data FROM genlayer_questions WHERE used=FALSE ORDER BY RANDOM() LIMIT 1",
      );
    }

    if (!cached.rows.length) {
      preGenerateGenLayerQuestions().catch(() => {});
      return res.json({ ok: false, error: "No questions available" });
    }

    const row = cached.rows[0];
    const q = row.data;

    // Mark as used immediately
    await pool.query("UPDATE genlayer_questions SET used=TRUE WHERE id=$1", [
      row.id,
    ]);

    // Extract correct answer BEFORE encrypting — never sent to client
    const correctAnswer = q.options[q.correct];
    const encryptedAnswer = encryptAnswer(correctAnswer);

    // Shuffle options so client cannot guess by position
    const shuffledOptions = [...q.options].sort(() => Math.random() - 0.5);

    // Wipe raw data so it can never be read from the pool table
    await pool.query(
      "UPDATE genlayer_questions SET data='{\"wiped\":true}' WHERE id=$1",
      [row.id],
    );

    // Store encrypted answer server-side only
    await pool.query(
      `INSERT INTO genlayer_round_questions
         (tournament_id, round_number, wallet, question_text, options, correct_answer)
       VALUES ($1,$2,LOWER($3),$4,$5,$6)
       ON CONFLICT (tournament_id, round_number, wallet) DO NOTHING`,
      [
        tournamentId,
        roundNumber,
        req.user.wallet,
        q.question,
        JSON.stringify(shuffledOptions),
        encryptedAnswer,
      ],
    );

    // Send ONLY question text + shuffled options — correct answer never leaves server
    return res.json({
      ok: true,
      question: {
        id: row.id,
        question: q.question,
        options: shuffledOptions,
        category: q.category || "web3",
      },
    });
  } catch (err) {
    console.error("GenLayer assign error:", err.message);
    res.json({ ok: false, error: "Server error" });
  }
});

// Verify answer — returns only true/false, never the correct answer
app.post("/genlayer/verify", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  const { tournamentId, roundNumber, selected } = req.body;
  if (!tournamentId || !roundNumber || selected === undefined) {
    return res.status(400).json({ error: "Missing fields" });
  }
  try {
    const r = await pool.query(
      `SELECT correct_answer FROM genlayer_round_questions
       WHERE tournament_id=$1 AND round_number=$2 AND LOWER(wallet)=LOWER($3)`,
      [tournamentId, roundNumber, req.user.wallet],
    );
    if (!r.rows.length) return res.json({ correct: false });
    const decrypted = decryptAnswer(r.rows[0].correct_answer);
    if (!decrypted) return res.json({ correct: false });
    // ONLY true or false — correct answer never in response
    res.json({ correct: decrypted === selected });
  } catch (e) {
    res.json({ correct: false });
  }
});

// Admin generate — admin only, no question data exposed
app.post("/admin/genlayer/generate", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
  preGenerateGenLayerQuestions().catch(() => {});
  res.json({ ok: true, message: "Generation started" });
});

// Clean up old join attempt records every hour
setInterval(
  async () => {
    try {
      await pool.query(
        `DELETE FROM tournament_join_attempts WHERE attempted_at < NOW() - INTERVAL '1 hour'`,
      );
    } catch (_) {}
  },
  60 * 60 * 1000,
);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n🚀 Backend running on port ${PORT}`);
  console.log(`   Verifier:  ${verifierWallet.address}`);
  console.log(`   Contract:  ${CONTRACT_ADDRESS}`);
});

// 404 handler — placed BEFORE the error handler, AFTER all your routes
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// CSRF/general error handler — must be BEFORE app.listen
app.use((err, req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  if (err.code === "EBADCSRFTOKEN") {
    return res.status(403).json({ error: "Invalid or missing CSRF token" });
  }
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: err.message });
});
// ============================================================

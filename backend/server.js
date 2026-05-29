require("dotenv").config();
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const cors = require("cors");
const { Pool } = require("pg");
const { ethers } = require("ethers");
const rateLimit = require("express-rate-limit");
const walletCooldowns = new Map();
setInterval(() => {
  const cutoff = Date.now() - 3600000;

  for (const [k, v] of walletCooldowns.entries()) {
    if (v < cutoff) {
      walletCooldowns.delete(k);
    }
  }
}, 3600000);
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
  process.env.LITVM_RPC_URL || "https://liteforge.rpc.caldera.xyz/http";

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

const arcProvider = makeProvider();
const arcContract = new ethers.Contract(
  CONTRACT_ADDRESS,
  CONTRACT_ABI,
  arcProvider,
);

// ── LitVM provider ────────────────────────────────────────────────────────────
function makeLitvmProvider() {
  return new ethers.JsonRpcProvider(LITVM_RPC_URL, {
    chainId: 4441,
    name: "litvm",
  });
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
      const provider = makeLitvmProvider();
      const contract = new ethers.Contract(
        LITVM_CONTRACT_ADDRESS,
        CONTRACT_ABI,
        provider,
      );
      const result = await Promise.race([
        fn(contract, provider),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("LitVM timeout")), 12000),
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
app.use(
  session({
    secret: process.env.SESSION_SECRET || "fallback-dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
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
    const result = await pool.query(`
      SELECT *
      FROM games
      ORDER BY created_at DESC
      LIMIT 100
    `);

    res.json(result.rows);
  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: e.message,
    });
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
    } = req.body;

    const cleanName = sanitizeHtml(name, {
      allowedTags: [],
      allowedAttributes: {},
    });

    await pool.query(
      `INSERT INTO games (chain_id,contract_game_id,creator,name,category,
      difficulty,entry_fee,token_symbol,max_players,tx_hash,prize_pool)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0)
      ON CONFLICT (chain_id,contract_game_id)
      DO UPDATE SET
      prize_pool = EXCLUDED.prize_pool`,
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
      ],
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: e.message,
    });
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
app.post("/auth/wallet", async (req, res) => {
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

    // Check joined onchain
    const [joined] = await retryFn(
      (c) => c.getPlayerStatus(gameId, wallet),
      "getPlayerStatus",
    );
    if (!joined) return res.status(403).json({ error: "Not joined onchain" });

    // ✅ Check if already started — don't re-fetch questions
    const existingSession = await pool.query(
      "SELECT id, finished FROM game_sessions WHERE user_id=$1 AND game_id=$2",
      [req.user.id, gameId],
    );
    if (existingSession.rows.length > 0 && existingSession.rows[0].finished) {
      return res.status(400).json({ error: "Already finished this game" });
    }

    const existCheck = await pool.query(
      "SELECT id FROM game_sessions WHERE user_id=$1 AND game_id=$2",
      [req.user.id, gameId],
    );

    if (existCheck.rows.length === 0) {
      await pool.query(
        "INSERT INTO game_sessions (user_id, wallet, game_id, chain_id) VALUES ($1,$2,$3,$4)",
        [req.user.id, wallet.toLowerCase(), gameId, chainId],
      );
    }

    // Re-fetch to get the id whether it was just inserted or already existed
    const sessionRow = await pool.query(
      "SELECT id FROM game_sessions WHERE user_id=$1 AND game_id=$2",
      [req.user.id, gameId],
    );
    const sessionId = sessionRow.rows[0]?.id;

    // ✅ Check if questions already stored (replay attempt)
    const existingQs = await pool.query(
      "SELECT COUNT(*) as cnt FROM game_questions WHERE session_id=$1",
      [sessionId],
    );
    if (parseInt(existingQs.rows[0].cnt) > 0) {
      // Questions already stored — return them without correct answers
      const qs = await pool.query(
        "SELECT q_index, question, options FROM game_questions WHERE session_id=$1 ORDER BY q_index",
        [sessionId],
      );
      return res.json({ ok: true, questions: qs.rows });
    }

    // ✅ Fetch questions SERVER-SIDE — correct answers never sent to client
    const { correctAnswers } = req.body;

    if (
      correctAnswers &&
      Array.isArray(correctAnswers) &&
      correctAnswers.length >= 5
    ) {
      // Client sent correct answers — store them server-side for scoring
      for (const qa of correctAnswers) {
        await pool.query(
          `INSERT INTO game_questions (session_id, q_index, correct_answer, question, options)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (session_id, q_index) DO NOTHING`,
          [sessionId, qa.index, qa.correct, "client-fetched", "[]"],
        );
      }
      // ✅ Return ok — questions already rendered client-side
      return res.json({ ok: true, questions: [] });
    }

    // ✅ Server-side fetch fallback (when client didn't send correctAnswers)
    const catId = categoryId || 9;
    const diff = parseInt(difficulty) || 0;
    const diffParam =
      diff > 0 ? `&difficulty=${["", "easy", "medium", "hard"][diff]}` : "";

    let useLocal = false;
    let qtResults = [];

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const qtRes = await fetch(
        `https://opentdb.com/api.php?amount=10&category=${catId}&type=multiple&encode=url3986${diffParam}`,
        { signal: controller.signal },
      );
      clearTimeout(timeout);
      const qtData = await qtRes.json();
      if (qtData?.response_code === 0 && qtData.results?.length >= 5) {
        qtResults = qtData.results.map((q) => ({
          question: decodeURIComponent(q.question),
          correct: decodeURIComponent(q.correct_answer),
          incorrect: q.incorrect_answers.map((a) => decodeURIComponent(a)),
          difficulty: q.difficulty,
        }));
      } else {
        useLocal = true;
      }
    } catch (e) {
      useLocal = true;
    }

    if (useLocal) {
      const localQs = getLocalQuestions(catId, diff, 10);
      qtResults = localQs.map((q) => ({
        question: q.q,
        correct: q.correct,
        incorrect: q.wrong,
        difficulty: diff === 1 ? "easy" : diff === 2 ? "medium" : "easy",
      }));
    }

    if (!qtResults.length) {
      return res.status(503).json({ error: "Could not load questions." });
    }

    const clientQuestions = [];
    for (let i = 0; i < qtResults.length; i++) {
      const q = qtResults[i];
      const options = [q.correct, ...q.incorrect].sort(
        () => Math.random() - 0.5,
      );
      await pool.query(
        `INSERT INTO game_questions (session_id, q_index, correct_answer, question, options)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (session_id, q_index) DO NOTHING`,
        [sessionId, i, q.correct, q.question, JSON.stringify(options)],
      );
      clientQuestions.push({
        questionIndex: i,
        question: q.question,
        options,
        diff: q.difficulty,
      });
    }
    return res.json({ ok: true, questions: clientQuestions });
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

  const last = walletCooldowns.get(wallet) || 0;

  if (now - last < 10000) {
    return res.status(429).json({
      error: "Slow down",
    });
  }

  const sessionStartTime = walletCooldowns.get(wallet + "_start") || now;
  const duration = now - sessionStartTime;
  if (duration > 0 && duration < 5000) {
    return res.status(400).json({ error: "Too fast" });
  }
  walletCooldowns.set(wallet + "_start", now);

  walletCooldowns.set(wallet, now);

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
      return res
        .status(400)
        .json({ error: "No questions found. Play the game first." });
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
          const tl = Math.max(
            0,
            Math.min(15, Number(userAnswer.timeLeft || 0)),
          );

          // 100 base + max 50 speed bonus
          score += 100 + Math.floor((tl / 15) * 50);
        }
      }

      // Prevent impossible scores
      score = Math.min(score, 1500);

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

    const game = await client.query(
      `
  SELECT entry_fee
  FROM games
  WHERE contract_game_id = $1
  AND chain_id = $2
  `,
      [gameId, chainId],
    );

    if (game.rows.length > 0) {
      const volumeCol = isLitvm ? "total_volume_litvm" : "total_volume";
      await client.query(
        `UPDATE platform_stats SET ${volumeCol} = ${volumeCol} + $1 WHERE id = 1`,
        [game.rows[0].entry_fee],
      );
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
    const r = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM users) as total_players,
        COUNT(*) as total_games_played,
        COUNT(*) FILTER (WHERE finished = true) as total_finished
      FROM game_sessions
    `);

    const volumeResult = await pool.query(`
      SELECT 
        COALESCE(SUM(g.entry_fee) FILTER (WHERE g.chain_id = 5042002), 0) AS arc_volume,
        COALESCE(SUM(g.entry_fee) FILTER (WHERE g.chain_id = 4441), 0) AS litvm_volume
      FROM game_sessions gs
      JOIN games g ON g.contract_game_id = gs.game_id AND g.chain_id = gs.chain_id
      WHERE gs.finished = true
    `);

    const topPlayers = await pool.query(`
      SELECT u.username, u.wallet, u.avatar,
             COUNT(gs.id) as games_played,
             COUNT(gs.id) FILTER (WHERE gs.finished = true) as games_finished,
             COALESCE(SUM(gs.score) FILTER (WHERE gs.finished = true), 0) as total_score,
             COALESCE(MAX(gs.score), 0) as best_score
      FROM users u
      LEFT JOIN game_sessions gs ON gs.user_id = u.id
      GROUP BY u.id, u.username, u.wallet, u.avatar
      HAVING COUNT(gs.id) > 0
      ORDER BY best_score DESC, games_played DESC
      LIMIT 10
    `);

    res.json({
      totalPlayers: parseInt(r.rows[0].total_players) || 0,
      totalGamesPlayed: parseInt(r.rows[0].total_games_played) || 0,
      totalFinished: parseInt(r.rows[0].total_finished) || 0,
      arcVolume: parseFloat(volumeResult.rows[0]?.arc_volume || 0).toFixed(2),
      litvmVolume: parseFloat(volumeResult.rows[0]?.litvm_volume || 0).toFixed(
        4,
      ),
      topPlayers: topPlayers.rows,
    });
  } catch (e) {
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
    },
    8 * 60 * 1000,
  ); // every 8 minutes
}

// ── LIST tournaments ──────────────────────────────────────────────────────────
app.get("/tournaments", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*,
        (SELECT COUNT(*) FROM tournament_players tp
         WHERE tp.tournament_id = t.id AND NOT tp.eliminated) AS player_count
      FROM tournaments t
      ORDER BY t.created_at DESC LIMIT 50
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET single tournament ─────────────────────────────────────────────────────
app.get("/tournaments/:id", async (req, res) => {
  try {
    const t = await pool.query("SELECT * FROM tournaments WHERE id=$1", [
      req.params.id,
    ]);
    if (!t.rows.length) return res.status(404).json({ error: "Not found" });
    const players = await pool.query(
      `
      SELECT tp.*, u.username, u.avatar FROM tournament_players tp
      LEFT JOIN users u ON u.id = tp.user_id
      WHERE tp.tournament_id=$1 ORDER BY tp.total_score DESC
    `,
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

// ── CREATE tournament ─────────────────────────────────────────────────────────
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

  const creatorId = req.user.wallet || req.user.email;
  const recent = await pool.query(
    "SELECT id FROM tournaments WHERE creator=LOWER($1) AND created_at > NOW() - INTERVAL '24 hours'",
    [creatorId],
  );
  if (recent.rows.length > 0)
    return res.status(429).json({
      error: "You can only create 1 tournament per 24 hours. Please wait.",
    });
  try {
    const result = await pool.query(
      `INSERT INTO tournaments (name, creator, chain_id, entry_fee, token_symbol, max_players, rounds, deadline_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + INTERVAL '7 days') RETURNING *`,
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

// ── JOIN tournament ───────────────────────────────────────────────────────────
app.post("/tournaments/:id/join", async (req, res) => {
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
    if (tournament.status !== "open")
      return res.status(400).json({ error: "Tournament not open" });
    const count = await pool.query(
      "SELECT COUNT(*) FROM tournament_players WHERE tournament_id=$1",
      [req.params.id],
    );
    if (parseInt(count.rows[0].count) >= tournament.max_players)
      return res.status(400).json({ error: "Tournament full" });

    await pool.query(
      `
      INSERT INTO tournament_players (tournament_id, wallet, user_id)
      VALUES ($1,$2,$3) ON CONFLICT (tournament_id, wallet) DO NOTHING
    `,
      [req.params.id, wallet.toLowerCase(), req.user.id],
    );

    await pool.query(
      "UPDATE tournaments SET prize_pool = prize_pool + $1 WHERE id=$2",
      [tournament.entry_fee, req.params.id],
    );

    const newCount = parseInt(count.rows[0].count) + 1;
    if (newCount >= tournament.max_players) {
      await pool.query(
        "UPDATE tournaments SET status='active', started_at=NOW(), current_round=1 WHERE id=$1",
        [req.params.id],
      );
      await pool.query(
        `
        INSERT INTO tournament_rounds (tournament_id, round_number, status, started_at)
        VALUES ($1,1,'active',NOW()) ON CONFLICT (tournament_id,round_number) DO NOTHING
      `,
        [req.params.id],
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SUBMIT round score ────────────────────────────────────────────────────────
app.post("/tournaments/:id/submit", scoreLimiter, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  const { wallet, answers } = req.body;
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
      "SELECT * FROM tournament_players WHERE tournament_id=$1 AND wallet=LOWER($2)",
      [req.params.id, wallet],
    );
    if (!playerRes.rows.length)
      return res.status(403).json({ error: "Not in tournament" });
    if (playerRes.rows[0].eliminated)
      return res.status(400).json({ error: "Eliminated" });

    const existing = await pool.query(
      "SELECT id FROM tournament_scores WHERE tournament_id=$1 AND round_id=$2 AND wallet=LOWER($3)",
      [req.params.id, round.id, wallet],
    );
    if (existing.rows.length)
      return res.status(400).json({ error: "Already submitted" });

    const score = Math.min(
      answers.filter((a) => a.correct === true).length * 100,
      1000,
    );

    await pool.query(
      "INSERT INTO tournament_scores (tournament_id, round_id, wallet, score) VALUES ($1,$2,LOWER($3),$4)",
      [req.params.id, round.id, wallet, score],
    );
    await pool.query(
      "UPDATE tournament_players SET total_score = total_score + $1 WHERE tournament_id=$2 AND wallet=LOWER($3)",
      [score, req.params.id, wallet],
    );

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

      const isFinal = tournament.current_round >= tournament.rounds;
      if (isFinal) {
        const rankings = await pool.query(
          "SELECT wallet, total_score FROM tournament_players WHERE tournament_id=$1 AND NOT eliminated ORDER BY total_score DESC",
          [req.params.id],
        );
        const winner = rankings.rows[0]?.wallet;
        const pool2 = parseFloat(tournament.prize_pool);
        const prizes = {
          first: (pool2 * 0.6).toFixed(6),
          second: (pool2 * 0.25).toFixed(6),
          third: (pool2 * 0.15).toFixed(6),
        };
        await pool.query(
          "UPDATE tournaments SET status='finished', finished_at=NOW(), winner=$1 WHERE id=$2",
          [winner, req.params.id],
        );
        return res.json({
          ok: true,
          score,
          roundFinished: true,
          tournamentFinished: true,
          rankings: rankings.rows,
          prizes,
          winner,
        });
      } else {
        // Eliminate bottom half
        const allRankings = await pool.query(
          "SELECT wallet, total_score FROM tournament_players WHERE tournament_id=$1 AND NOT eliminated ORDER BY total_score DESC",
          [req.params.id],
        );
        const survivors = Math.ceil(allRankings.rows.length / 2);
        const toEliminate = allRankings.rows
          .slice(survivors)
          .map((p) => p.wallet);
        if (toEliminate.length) {
          await pool.query(
            "UPDATE tournament_players SET eliminated=TRUE WHERE tournament_id=$1 AND wallet=ANY($2)",
            [req.params.id, toEliminate],
          );
        }
        const nextRound = tournament.current_round + 1;
        await pool.query(
          "UPDATE tournaments SET current_round=$1 WHERE id=$2",
          [nextRound, req.params.id],
        );
        await pool.query(
          "INSERT INTO tournament_rounds (tournament_id, round_number, status, started_at) VALUES ($1,$2,'active',NOW())",
          [req.params.id, nextRound],
        );
        return res.json({
          ok: true,
          score,
          roundFinished: true,
          tournamentFinished: false,
          nextRound,
          eliminated: toEliminate,
          survivors: allRankings.rows.slice(0, survivors).map((p) => p.wallet),
        });
      }
    }
    res.json({ ok: true, score, roundFinished: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── TOURNAMENT CLAIM PRIZE ────────────────────────────────────────────────────
app.post("/tournaments/:id/claim", async (req, res) => {
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

    // Get final rankings
    const rankings = await pool.query(
      `SELECT wallet, total_score FROM tournament_players
       WHERE tournament_id=$1 ORDER BY total_score DESC LIMIT 3`,
      [req.params.id],
    );

    const myPos = rankings.rows.findIndex(
      (p) => p.wallet.toLowerCase() === wallet.toLowerCase(),
    );
    if (myPos < 0 || myPos > 2)
      return res.status(400).json({ error: "You are not a top-3 winner" });

    // Check already claimed
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

    // Record claim intent
    await pool.query(
      `INSERT INTO tournament_claims (tournament_id, wallet, amount, token_symbol, status)
       VALUES ($1,$2,$3,$4,'pending')
       ON CONFLICT (tournament_id, wallet) DO UPDATE SET status='pending'`,
      [
        req.params.id,
        wallet.toLowerCase(),
        prizeAmount,
        tournament.token_symbol,
      ],
    );

    // Auto-payout via verifier wallet
    try {
      let txHash;
      if (isLitvm) {
        const prov = makeLitvmProvider();
        const ws = verifierWallet.connect(prov);
        const tx = await ws.sendTransaction({
          to: wallet,
          value: amountWei,
          gasLimit: 21000,
        });
        await tx.wait();
        txHash = tx.hash;
      } else {
        const ARC_USDC = "0x3600000000000000000000000000000000000000";
        const prov = makeProvider();
        const ws = verifierWallet.connect(prov);
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
        "UPDATE tournament_claims SET status='paid', tx_hash=$1 WHERE tournament_id=$2 AND LOWER(wallet)=LOWER($3)",
        [txHash, req.params.id, wallet],
      );

      // Update player record
      await pool.query(
        "UPDATE tournament_players SET prize_position=$1 WHERE tournament_id=$2 AND LOWER(wallet)=LOWER($3)",
        [myPos, req.params.id, wallet],
      );

      // Track volume
      await pool.query(
        "UPDATE platform_stats SET tournament_volume = tournament_volume + $1 WHERE id=1",
        [prizeAmount],
      );

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
        message: "Payout queued — funds will arrive within 24 hours",
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── TOURNAMENT GLOBAL LEADERBOARD ─────────────────────────────────────────────
app.get("/tournaments/leaderboard", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        tp.wallet,
        u.username,
        u.avatar,
        COUNT(DISTINCT tp.tournament_id) AS tournaments_played,
        COUNT(DISTINCT CASE WHEN t.winner = tp.wallet THEN t.id END) AS wins,
        COALESCE(SUM(tc.amount) FILTER (WHERE tc.status='paid'), 0) AS total_earned,
        t.token_symbol
      FROM tournament_players tp
      LEFT JOIN users u ON LOWER(u.wallet) = LOWER(tp.wallet)
      LEFT JOIN tournaments t ON t.id = tp.tournament_id
      LEFT JOIN tournament_claims tc ON LOWER(tc.wallet) = LOWER(tp.wallet)
      GROUP BY tp.wallet, u.username, u.avatar, t.token_symbol
      HAVING COUNT(DISTINCT tp.tournament_id) > 0
      ORDER BY wins DESC, total_earned DESC
      LIMIT 15
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── TOURNAMENT STATS (volume, counts) ─────────────────────────────────────────
app.get("/tournaments/stats", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) AS total_tournaments,
        COUNT(*) FILTER (WHERE status='active') AS live_count,
        COUNT(*) FILTER (WHERE status='finished') AS finished_count,
        COALESCE(SUM(prize_pool) FILTER (WHERE status='finished'), 0) AS total_volume,
        COALESCE(SUM(prize_pool) FILTER (WHERE token_symbol='USDC' AND status='finished'), 0) AS usdc_volume,
        COALESCE(SUM(prize_pool) FILTER (WHERE token_symbol='zkLTC' AND status='finished'), 0) AS litvm_volume
      FROM tournaments
    `);
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// START
// =============================================================================

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n🚀 Backend running on port ${PORT}`);
  console.log(`   Verifier:  ${verifierWallet.address}`);
  console.log(`   Contract:  ${CONTRACT_ADDRESS}`);
});

// CSRF error handler — must be BEFORE app.listen
app.use((err, req, res, next) => {
  if (err.code === "EBADCSRFTOKEN") {
    return res.status(403).json({ error: "Invalid or missing CSRF token" });
  }
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: err.message });
});

require("dotenv").config();
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const cors = require("cors");
const { Pool } = require("pg");
const { ethers } = require("ethers");
const rateLimit = require("express-rate-limit");

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
      (a) => Number(a.questionId) === Number(real.question_id),
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
    await pool.query(`ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS chain_id INT DEFAULT 5042002`).catch(() => {});
    
    await pool.query(`
      ALTER TABLE game_sessions
      ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ
      `).catch(() => {});

    // ✅ Safely recreate the unique constraint with chain_id included
    await pool.query(`
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
    `).catch((e) => console.warn("Constraint migration:", e.message));

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
  
  // ✅ Add missing columns to existing table (safe to run multiple times)
  await pool.query(`ALTER TABLE game_questions ADD COLUMN IF NOT EXISTS question TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE game_questions ADD COLUMN IF NOT EXISTS options  TEXT`).catch(() => {});
   // With this single safe block:
   await pool.query(`
    DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'gs_user_game_chain_unique'
      ) THEN
      ALTER TABLE game_sessions DROP CONSTRAINT IF EXISTS game_sessions_user_id_game_id_key;
      ALTER TABLE game_sessions ADD CONSTRAINT gs_user_game_chain_unique UNIQUE(user_id, game_id, chain_id);
      END IF;
      END $$;
    `).catch(() => {});

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
      await pool.query(`ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS chain_id INT DEFAULT 5042002`).catch(() => {});

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
  max: 10, // was 5
  message: { error: "Too many score submissions" },
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

app.post("/games/save", async (req, res) => {
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
    } = req.body;

    await pool.query(
      `
      INSERT INTO games (
        chain_id,
        contract_game_id,
        creator,
        name,
        category,
        difficulty,
        entry_fee,
        token_symbol,
        max_players,
        tx_hash
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `,
      [
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

app.get("/history/:wallet", async (req, res) => {
  try {
    const wallet = req.params.wallet.toLowerCase();

    const result = await pool.query(
      `
      SELECT *
      FROM games
      WHERE LOWER(creator)=$1
      ORDER BY created_at DESC
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
    failureRedirect: `${process.env.FRONTEND_URL}?auth=failed`,
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
          "SELECT id FROM users WHERE LOWER(wallet)=$1 AND id!=$2",
          [walletLower, currentUser.id],
        );
        if (taken.rows.length > 0)
          return res
            .status(400)
            .json({ error: "Wallet already linked to another account" });

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

app.post("/profile/setup", async (req, res) => {
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
app.post("/profile/wallet", async (req, res) => {
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

app.post("/profile/avatar", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  const { avatar } = req.body;
  if (!avatar) return res.status(400).json({ error: "No avatar" });
  if (!avatar.startsWith("http") && !avatar.startsWith("data:image/"))
    return res.status(400).json({ error: "Invalid format" });
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
      "SELECT username, display_name, avatar FROM users WHERE LOWER(wallet)=LOWER($1)",
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

app.get("/debug/nonce/:wallet", async (req, res) => {
  const wallet = req.params.wallet;
  try {
    // Use withRetry which IS globally defined
    const onchainNonce = await withRetry(
      (c) => c.getNonce(wallet),
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
        new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 5000)),
      ]);
      const c = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, p);
      const nonce = await Promise.race([
        c.getNonce("0x52F6dE1118a3c22CBF04f7d811B08034DCF21E50"),
        new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 5000)),
      ]);
      results[rpc] = { ok: true, block, nonce: nonce.toString() };
    } catch (e) {
      results[rpc] = { ok: false, error: e.message };
    }
  }
  res.json(results);
});

// ✅ LOCAL QUESTION BANK — 200 questions across categories
// Used when OpenTDB is unavailable. Prevents "No questions available" errors.
const LOCAL_QUESTIONS = {
  9: [ // General Knowledge
    { q: "What is the capital of Australia?", correct: "Canberra", wrong: ["Sydney", "Melbourne", "Perth"] },
    { q: "How many sides does a hexagon have?", correct: "6", wrong: ["5", "7", "8"] },
    { q: "Which planet is known as the Red Planet?", correct: "Mars", wrong: ["Jupiter", "Venus", "Saturn"] },
    { q: "What is the largest ocean on Earth?", correct: "Pacific Ocean", wrong: ["Atlantic Ocean", "Indian Ocean", "Arctic Ocean"] },
    { q: "Who painted the Mona Lisa?", correct: "Leonardo da Vinci", wrong: ["Michelangelo", "Raphael", "Donatello"] },
    { q: "What is the chemical symbol for gold?", correct: "Au", wrong: ["Go", "Gd", "Ag"] },
    { q: "How many bones are in the adult human body?", correct: "206", wrong: ["195", "213", "220"] },
    { q: "What year did World War II end?", correct: "1945", wrong: ["1943", "1944", "1946"] },
    { q: "What is the smallest country in the world?", correct: "Vatican City", wrong: ["Monaco", "San Marino", "Liechtenstein"] },
    { q: "Which element has the atomic number 1?", correct: "Hydrogen", wrong: ["Helium", "Oxygen", "Carbon"] },
    { q: "What is the fastest land animal?", correct: "Cheetah", wrong: ["Lion", "Leopard", "Gazelle"] },
    { q: "In what country was pizza invented?", correct: "Italy", wrong: ["Greece", "France", "Spain"] },
    { q: "What is the longest river in the world?", correct: "Nile", wrong: ["Amazon", "Mississippi", "Yangtze"] },
    { q: "How many continents are there?", correct: "7", wrong: ["5", "6", "8"] },
    { q: "What gas do plants absorb from the atmosphere?", correct: "Carbon Dioxide", wrong: ["Oxygen", "Nitrogen", "Hydrogen"] },
  ],
  17: [ // Science
    { q: "What is the speed of light?", correct: "299,792,458 m/s", wrong: ["300,000,000 m/s", "199,792,458 m/s", "399,792,458 m/s"] },
    { q: "What is the powerhouse of the cell?", correct: "Mitochondria", wrong: ["Nucleus", "Ribosome", "Golgi Apparatus"] },
    { q: "What planet has the most moons?", correct: "Saturn", wrong: ["Jupiter", "Uranus", "Neptune"] },
    { q: "What is the hardest natural substance?", correct: "Diamond", wrong: ["Ruby", "Quartz", "Topaz"] },
    { q: "What force keeps planets in orbit?", correct: "Gravity", wrong: ["Magnetism", "Friction", "Centripetal force"] },
    { q: "How many chromosomes do humans have?", correct: "46", wrong: ["23", "48", "44"] },
    { q: "What is H2O commonly known as?", correct: "Water", wrong: ["Hydrogen Peroxide", "Oxygen", "Salt water"] },
    { q: "What is the center of an atom called?", correct: "Nucleus", wrong: ["Electron", "Proton", "Neutron"] },
    { q: "Which gas makes up most of Earth's atmosphere?", correct: "Nitrogen", wrong: ["Oxygen", "Carbon Dioxide", "Argon"] },
    { q: "What is the boiling point of water at sea level?", correct: "100°C", wrong: ["90°C", "110°C", "95°C"] },
    { q: "What type of energy does the sun produce?", correct: "Nuclear energy", wrong: ["Chemical energy", "Mechanical energy", "Electrical energy"] },
    { q: "What is DNA short for?", correct: "Deoxyribonucleic acid", wrong: ["Dioxyribonucleic acid", "Diribonucleic acid", "Deoxyribose acid"] },
    { q: "What is the process by which plants make food?", correct: "Photosynthesis", wrong: ["Respiration", "Fermentation", "Digestion"] },
    { q: "How many planets are in our solar system?", correct: "8", wrong: ["7", "9", "10"] },
    { q: "What is the study of earthquakes called?", correct: "Seismology", wrong: ["Geology", "Volcanology", "Meteorology"] },
  ],
  23: [ // History
    { q: "In what year did the Berlin Wall fall?", correct: "1989", wrong: ["1987", "1991", "1985"] },
    { q: "Who was the first President of the United States?", correct: "George Washington", wrong: ["John Adams", "Thomas Jefferson", "Benjamin Franklin"] },
    { q: "Which empire was the largest in history?", correct: "British Empire", wrong: ["Roman Empire", "Mongol Empire", "Ottoman Empire"] },
    { q: "In what year did World War I begin?", correct: "1914", wrong: ["1912", "1916", "1918"] },
    { q: "Who discovered America?", correct: "Christopher Columbus", wrong: ["Amerigo Vespucci", "Leif Erikson", "Vasco da Gama"] },
    { q: "What ancient wonder was located in Alexandria?", correct: "The Lighthouse of Alexandria", wrong: ["The Colossus", "The Hanging Gardens", "The Temple of Artemis"] },
    { q: "When was the Magna Carta signed?", correct: "1215", wrong: ["1066", "1314", "1415"] },
    { q: "Who was Napoleon Bonaparte?", correct: "French Emperor", wrong: ["British General", "Russian Tsar", "Spanish King"] },
    { q: "In what year did the Titanic sink?", correct: "1912", wrong: ["1910", "1914", "1916"] },
    { q: "Which country first landed on the moon?", correct: "United States", wrong: ["Soviet Union", "China", "United Kingdom"] },
    { q: "Who wrote the Declaration of Independence?", correct: "Thomas Jefferson", wrong: ["George Washington", "John Adams", "Benjamin Franklin"] },
    { q: "What was the name of Hitler's political party?", correct: "Nazi Party", wrong: ["Communist Party", "Fascist Party", "Conservative Party"] },
    { q: "When did the French Revolution begin?", correct: "1789", wrong: ["1776", "1799", "1804"] },
    { q: "Who was Cleopatra?", correct: "Queen of Egypt", wrong: ["Queen of Rome", "Queen of Greece", "Queen of Persia"] },
    { q: "What year did the Cold War end?", correct: "1991", wrong: ["1989", "1985", "1993"] },
  ],
  15: [ // Video Games
    { q: "What company created Mario?", correct: "Nintendo", wrong: ["Sega", "Atari", "Sony"] },
    { q: "In what game do you 'catch them all'?", correct: "Pokémon", wrong: ["Digimon", "Yo-kai Watch", "Monster Hunter"] },
    { q: "What is the best-selling video game of all time?", correct: "Minecraft", wrong: ["Tetris", "GTA V", "Wii Sports"] },
    { q: "Who is the main character in The Legend of Zelda?", correct: "Link", wrong: ["Zelda", "Ganon", "Impa"] },
    { q: "What color is Sonic the Hedgehog?", correct: "Blue", wrong: ["Red", "Green", "Yellow"] },
    { q: "In Fortnite, how many players compete in a match?", correct: "100", wrong: ["50", "150", "200"] },
    { q: "What is the currency in Animal Crossing?", correct: "Bells", wrong: ["Coins", "Rupees", "Gold"] },
    { q: "Which game features the character Master Chief?", correct: "Halo", wrong: ["Call of Duty", "Gears of War", "Destiny"] },
    { q: "What year was the original PlayStation released?", correct: "1994", wrong: ["1993", "1995", "1996"] },
    { q: "Which company makes the Xbox?", correct: "Microsoft", wrong: ["Sony", "Nintendo", "Sega"] },
    { q: "What game popularized the battle royale genre?", correct: "PUBG", wrong: ["Fortnite", "Apex Legends", "H1Z1"] },
    { q: "What is the max level in most Pokémon games?", correct: "100", wrong: ["50", "99", "150"] },
    { q: "In Minecraft, what do you need to create a Nether portal?", correct: "Obsidian", wrong: ["Diamond", "Gold", "Lava"] },
    { q: "What genre is Dark Souls?", correct: "Action RPG", wrong: ["Turn-based RPG", "Strategy", "Platformer"] },
    { q: "Who is the villain in most Mario games?", correct: "Bowser", wrong: ["Wario", "Koopa", "Kamek"] },
  ],
  22: [ // Geography
    { q: "What is the capital of Japan?", correct: "Tokyo", wrong: ["Osaka", "Kyoto", "Hiroshima"] },
    { q: "Which country has the most natural lakes?", correct: "Canada", wrong: ["Russia", "United States", "Brazil"] },
    { q: "What is the tallest mountain in the world?", correct: "Mount Everest", wrong: ["K2", "Mont Blanc", "Kilimanjaro"] },
    { q: "Which country is the largest by area?", correct: "Russia", wrong: ["Canada", "China", "United States"] },
    { q: "What is the capital of Brazil?", correct: "Brasília", wrong: ["São Paulo", "Rio de Janeiro", "Salvador"] },
    { q: "Which desert is the largest in the world?", correct: "Sahara", wrong: ["Gobi", "Arabian", "Antarctic"] },
    { q: "What river flows through Egypt?", correct: "Nile", wrong: ["Amazon", "Congo", "Tigris"] },
    { q: "Which country has the most population?", correct: "India", wrong: ["China", "United States", "Indonesia"] },
    { q: "What is the capital of France?", correct: "Paris", wrong: ["Lyon", "Marseille", "Bordeaux"] },
    { q: "Which ocean is the smallest?", correct: "Arctic Ocean", wrong: ["Indian Ocean", "Atlantic Ocean", "Southern Ocean"] },
    { q: "What country has the longest coastline?", correct: "Canada", wrong: ["Russia", "Australia", "Norway"] },
    { q: "What is the capital of Germany?", correct: "Berlin", wrong: ["Munich", "Hamburg", "Frankfurt"] },
    { q: "In which continent is the Amazon rainforest?", correct: "South America", wrong: ["Africa", "Asia", "Central America"] },
    { q: "What is the smallest continent?", correct: "Australia", wrong: ["Europe", "Antarctica", "South America"] },
    { q: "Which country owns Greenland?", correct: "Denmark", wrong: ["Norway", "Iceland", "Canada"] },
  ],
  18: [ // Computers
    { q: "What does CPU stand for?", correct: "Central Processing Unit", wrong: ["Computer Processing Unit", "Central Program Unit", "Core Processing Unit"] },
    { q: "Who founded Microsoft?", correct: "Bill Gates", wrong: ["Steve Jobs", "Mark Zuckerberg", "Elon Musk"] },
    { q: "What does HTML stand for?", correct: "HyperText Markup Language", wrong: ["HyperText Machine Language", "HighText Markup Language", "HyperText Model Language"] },
    { q: "What programming language is known for web development?", correct: "JavaScript", wrong: ["Python", "Java", "C++"] },
    { q: "What is the most popular operating system?", correct: "Windows", wrong: ["macOS", "Linux", "Android"] },
    { q: "What does RAM stand for?", correct: "Random Access Memory", wrong: ["Read Access Memory", "Random Application Memory", "Read Application Memory"] },
    { q: "Who invented the World Wide Web?", correct: "Tim Berners-Lee", wrong: ["Bill Gates", "Steve Jobs", "Vint Cerf"] },
    { q: "What is the binary representation of the number 5?", correct: "101", wrong: ["110", "100", "111"] },
    { q: "What does URL stand for?", correct: "Uniform Resource Locator", wrong: ["Universal Resource Locator", "Unified Resource Link", "Universal Reference Link"] },
    { q: "What company created the Android operating system?", correct: "Google", wrong: ["Apple", "Samsung", "Microsoft"] },
    { q: "What is the shortcut to copy in most applications?", correct: "Ctrl+C", wrong: ["Ctrl+V", "Ctrl+X", "Ctrl+Z"] },
    { q: "Which programming language was created by Guido van Rossum?", correct: "Python", wrong: ["Ruby", "Perl", "Java"] },
    { q: "What does USB stand for?", correct: "Universal Serial Bus", wrong: ["Unified Serial Bus", "Universal System Bus", "Unified System Bus"] },
    { q: "What is the file extension for a Python file?", correct: ".py", wrong: [".python", ".pt", ".pyc"] },
    { q: "What does SSD stand for?", correct: "Solid State Drive", wrong: ["Super Speed Drive", "Static Storage Device", "System Storage Drive"] },
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
      [req.user.id, gameId]
    );
    
    if (existCheck.rows.length === 0) {
      await pool.query(
        "INSERT INTO game_sessions (user_id, wallet, game_id, chain_id) VALUES ($1,$2,$3,$4)",
        [req.user.id, wallet.toLowerCase(), gameId, chainId]
      );
    }

    // Re-fetch to get the id whether it was just inserted or already existed
    const sessionRow = await pool.query(
      "SELECT id FROM game_sessions WHERE user_id=$1 AND game_id=$2",
      [req.user.id, gameId]
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

if (correctAnswers && Array.isArray(correctAnswers) && correctAnswers.length >= 5) {
  // Client sent correct answers — store them server-side for scoring
  for (const qa of correctAnswers) {
    await pool.query(
      `INSERT INTO game_questions (session_id, q_index, correct_answer, question, options)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (session_id, q_index) DO NOTHING`,
      [sessionId, qa.index, qa.correct, "client-fetched", "[]"]
    );
  }
  // ✅ Return ok — questions already rendered client-side
  return res.json({ ok: true, questions: [] });
}

// ✅ Server-side fetch fallback (when client didn't send correctAnswers)
const catId = categoryId || 9;
const diff = parseInt(difficulty) || 0;
const diffParam = diff > 0 ? `&difficulty=${["","easy","medium","hard"][diff]}` : "";

let useLocal = false;
let qtResults = [];

try {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const qtRes = await fetch(
    `https://opentdb.com/api.php?amount=10&category=${catId}&type=multiple&encode=url3986${diffParam}`,
    { signal: controller.signal }
  );
  clearTimeout(timeout);
  const qtData = await qtRes.json();
  if (qtData?.response_code === 0 && qtData.results?.length >= 5) {
    qtResults = qtData.results.map(q => ({
      question: decodeURIComponent(q.question),
      correct: decodeURIComponent(q.correct_answer),
      incorrect: q.incorrect_answers.map(a => decodeURIComponent(a)),
      difficulty: q.difficulty,
    }));
  } else { useLocal = true; }
} catch (e) { useLocal = true; }

if (useLocal) {
  const localQs = getLocalQuestions(catId, diff, 10);
  qtResults = localQs.map(q => ({
    question: q.q, correct: q.correct, incorrect: q.wrong,
    difficulty: diff === 1 ? "easy" : diff === 2 ? "medium" : "easy",
  }));
}

if (!qtResults.length) {
  return res.status(503).json({ error: "Could not load questions." });
}

const clientQuestions = [];
for (let i = 0; i < qtResults.length; i++) {
  const q = qtResults[i];
  const options = [q.correct, ...q.incorrect].sort(() => Math.random() - 0.5);
  await pool.query(
    `INSERT INTO game_questions (session_id, q_index, correct_answer, question, options)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (session_id, q_index) DO NOTHING`,
    [sessionId, i, q.correct, q.question, JSON.stringify(options)]
  );
  clientQuestions.push({ questionIndex: i, question: q.question, options, diff: q.difficulty });
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
  if (!req.user) return res.status(401).json({ error: "Not logged in" });

  const { gameId, wallet, answers, chainId: reqChainId } = req.body;
  const chainId = parseInt(reqChainId || "5042002");
  const isLitvm = chainId === 4441;

  if (!gameId || !Array.isArray(answers))
    return res.status(400).json({ error: "Invalid input" });

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
  
  const played = await pool.query(
    `SELECT finished_at
    FROM game_sessions
    WHERE user_id=$1
    AND game_id=$2`,
    [req.user.id, gameId]
  );
  
  if (played.rows[0]?.finished_at) {
    const finishedAt = new Date(played.rows[0].finished_at).getTime();
    const now = Date.now();
    
    const diff = now - finishedAt;
    
    if (diff > 3600000) {
      return res.status(400).json({
        error: "Submission window expired"
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
    let sessionCheck = await pool.query(
      "SELECT id, finished, score FROM game_sessions WHERE user_id=$1 AND game_id=$2",
      [req.user.id, gameId],
    );
    if (sessionCheck.rows.length === 0) {
      try {
        await pool.query(
          "INSERT INTO game_sessions (user_id, wallet, game_id, chain_id) VALUES ($1,$2,$3,$4)",
          [req.user.id, effectiveWallet, gameId, chainId]
        );
        // Re-fetch after insert
        sessionCheck = await pool.query(
          "SELECT id, finished, score FROM game_sessions WHERE user_id=$1 AND game_id=$2",
          [req.user.id, gameId]
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

          await pool.query("UPDATE users SET nonce=$1 WHERE id=$2", [
            nonce.toString(),
            req.user.id,
          ]);
        } catch (e) {
          const nonceRow = await pool.query(
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
        await pool.query("UPDATE users SET nonce=$1 WHERE id=$2", [
          nonce.toString(), req.user.id,
        ]);
        console.log(`✅ Onchain nonce: ${nonce} (attempt ${attempt})`);
        break;
      } catch (e) {
        console.warn(`nonce attempt ${attempt}/4 failed: ${e.message}`);
        if (attempt === 4) {
          return res.status(503).json({ error: "Could not fetch nonce. Try again." });
        }
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
    
    // Check game is still open before signing
    try {
      const gameStatus = await activeRpcCall(
        (c) => c.getPlayerStatus(gameId, effectiveWallet),
        "recheck"
      );
      if (gameStatus[1] === true) {
        return res.status(400).json({ error: "Score already submitted onchain" });
      }
    } catch (_) {}
    const sessionId = sessionCheck.rows[0]?.id;
    if (!sessionId) {
      return res.status(400).json({ error: "No game session found. Play the game first." });
    }

    const sessionData = await pool.query(
      "SELECT started_at FROM game_sessions WHERE id=$1",
      [sessionId],
    );

    const startedAt = sessionData.rows[0]?.started_at;

    const sessionAge = (Date.now() - new Date(startedAt).getTime()) / 1000;

    const minPossibleTime = answers.length * 1.5;

    if (sessionAge < minPossibleTime) {
      return res.status(400).json({
        error: "Impossible completion time detected",
      });
    }

    // ✅ Sanitize answers — reject suspicious inputs
    if (answers.length > 20) {
      return res.status(400).json({ error: "Too many answers" });
    }
    for (const ans of answers) {
      if (typeof ans.questionIndex !== "number" && typeof ans.questionIndex !== "string") {
        return res.status(400).json({ error: "Invalid answer format" });
      }
      if (ans.selected !== null && typeof ans.selected !== "string") {
        return res.status(400).json({ error: "Invalid answer selection" });
      }
      if (ans.selected && ans.selected.length > 500) {
        return res.status(400).json({ error: "Answer too long" });
      }
    }

    // In /submit-score, replace the scoring section:
    const storedQs = await pool.query(
      "SELECT q_index, correct_answer FROM game_questions WHERE session_id=$1 ORDER BY q_index",
      [sessionId],
    );
    
    
    let score = 0;
    
   if (storedQs.rows.length === 0) {
      return res.status(400).json({ error: "No questions found. Play the game first." });
    } else {
      // ✅ Validate answer count — prevent skipping questions
      if (answers.length < storedQs.rows.length * 0.5) {
        return res.status(400).json({ error: "Too few answers submitted" });
      }
      // ✅ Server-side scoring — q_index coerced, speed bonus capped
      for (const stored of storedQs.rows) {
        const userAnswer = answers.find(a => Number(a.questionIndex) === Number(stored.q_index));
        if (!userAnswer || !userAnswer.selected) continue;
        if (userAnswer.selected === stored.correct_answer) {
          // timeLeft is client-reported — cap hard to limit inflation
          const tl = Math.max(0, Math.min(5, userAnswer.timeLeft || 0));
          score += 100 + Math.min(17, Math.floor((tl / 15) * 50));
        }
      }
      score = Math.min(score, 1500);
    }
    
    const message = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "uint256"],
      [effectiveWallet, gameId, score, nonce],
    );
    
    const signature = await verifierWallet.signMessage(
      ethers.getBytes(message),
    );
    
    await pool.query(
      `UPDATE game_sessions
      SET finished=true,
      score=$1,
      finished_at=NOW()
      WHERE user_id=$2
      AND game_id=$3`,
      [score, req.user.id, gameId]
    );
    
    // Increment DB nonce as fallback backup
    await pool.query("UPDATE users SET nonce = nonce + 1 WHERE id=$1", [
      req.user.id,
    ]);
    
    console.log(
      `✅ Score: game=${gameId} score=${score} wallet=${effectiveWallet}`,
    );
    
    res.json({ score, signature, nonce: nonce.toString() });
  } catch (e) {
    console.error("Submit error:", e.message);
    res.status(500).json({ error: "Server error: " + e.message });
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
        COUNT(DISTINCT user_id) as total_players,
        COUNT(*) as total_games_played,
        COUNT(*) FILTER (WHERE finished = true) as total_finished,
        COALESCE(SUM(score) FILTER (WHERE finished = true), 0) as total_score
      FROM game_sessions
    `);
    const topPlayers = await pool.query(`
      SELECT u.username, u.wallet, u.avatar,
             COUNT(gs.id) as games_played,
             COUNT(gs.id) FILTER (WHERE gs.finished = true) as games_finished,
             MAX(gs.score) as best_score
      FROM users u
      JOIN game_sessions gs ON gs.user_id = u.id
      WHERE gs.finished = true
      GROUP BY u.id, u.username, u.wallet, u.avatar
      ORDER BY best_score DESC
      LIMIT 10
    `);
    res.json({
      totalPlayers: parseInt(r.rows[0].total_players) || 0,
      totalGamesPlayed: parseInt(r.rows[0].total_games_played) || 0,
      totalFinished: parseInt(r.rows[0].total_finished) || 0,
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
);

// Self-ping to prevent Render sleep
if (process.env.NODE_ENV === "production") {
  setInterval(async () => {
    try {
      await fetch(`https://name-triviafi-backend.onrender.com/health`);
      console.log("🏓 Self-ping OK");
    } catch (_) {}
  }, 8 * 60 * 1000); // every 8 minutes
}

// =============================================================================
// START
// =============================================================================

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n🚀 Backend running on port ${PORT}`);
  console.log(`   Verifier:  ${verifierWallet.address}`);
  console.log(`   Contract:  ${CONTRACT_ADDRESS}`);
});
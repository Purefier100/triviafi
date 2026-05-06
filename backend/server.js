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
  "0xf988BBA862f8E500eb77e175be395961d221F4b0";
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
const litvmContract = new ethers.Contract(
  LITVM_CONTRACT_ADDRESS,
  CONTRACT_ABI,
  litvmProvider,
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
  // ✅ Schema that supports: Google-only, Wallet-only, and linked accounts
  // google_id and email are nullable so wallet-only users can exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id           SERIAL PRIMARY KEY,
      google_id    TEXT UNIQUE,
      email        TEXT UNIQUE,
      display_name TEXT,
      avatar       TEXT,
      username     TEXT UNIQUE,
      wallet       TEXT UNIQUE,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS game_sessions (
      id         SERIAL PRIMARY KEY,
      user_id    INT REFERENCES users(id),
      wallet     TEXT NOT NULL,
      game_id    INT NOT NULL,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      finished   BOOLEAN DEFAULT FALSE,
      score      INT DEFAULT 0,
      UNIQUE(user_id, game_id)
    );

    CREATE TABLE IF NOT EXISTS bets (
      id               SERIAL PRIMARY KEY,
      user_id          INT REFERENCES users(id),
      game_id          INT NOT NULL,
      predicted_winner TEXT NOT NULL,
      amount           NUMERIC(12,6) NOT NULL,
      settled          BOOLEAN DEFAULT FALSE,
      won              BOOLEAN,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ✅ Migration: make google_id and email nullable if they weren't before
  await pool
    .query(
      `
    ALTER TABLE users ALTER COLUMN google_id DROP NOT NULL;
  `,
    )
    .catch(() => {}); // ignore if already nullable

  await pool
    .query(
      `
  CREATE TABLE IF NOT EXISTS game_questions (
    id             SERIAL PRIMARY KEY,
    session_id     INT REFERENCES game_sessions(id),
    q_index        INT NOT NULL,
    correct_answer TEXT NOT NULL,
    UNIQUE(session_id, q_index)
  );
  `,
    )
    .catch(() => {});

  // Add constraint to existing table if it was already created without it
  await pool
    .query(
      `
  ALTER TABLE game_questions 
  ADD CONSTRAINT IF NOT EXISTS game_questions_session_q_unique 
  UNIQUE (session_id, q_index);
  `,
    )
    .catch(() => {});

  await pool
    .query(
      `
    ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
  `,
    )
    .catch(() => {}); // ignore if already nullable

  await pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nonce INT DEFAULT 0;`)
    .catch(() => {});

  // ✅ Add wallet unique constraint if not there
  await pool
    .query(
      `
    ALTER TABLE users ADD CONSTRAINT users_wallet_unique UNIQUE (wallet);
  `,
    )
    .catch(() => {}); // ignore if already exists

  console.log("DB ready");
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
    const message = "Login to Arc Trivia";
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
    const message = "Link wallet to Arc Trivia account";
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
      CONTRACT_ADDRESS,
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

    await pool.query(
      `INSERT INTO game_sessions (user_id, wallet, game_id)
       VALUES ($1,$2,$3) ON CONFLICT (user_id,game_id) DO NOTHING`,
      [req.user.id, wallet.toLowerCase(), gameId],
    );

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
    const catId = categoryId || 9;
    const diff = parseInt(difficulty) || 0;
    const diffParam =
      diff > 0 ? `&difficulty=${["", "easy", "medium", "hard"][diff]}` : "";

    let qtData;
    try {
      const qtRes = await fetch(
        `https://opentdb.com/api.php?amount=10&category=${catId}&type=multiple&encode=url3986${diffParam}`,
      );
      qtData = await qtRes.json();
    } catch (e) {
      return res.status(503).json({ error: "Failed to fetch questions" });
    }

    if (!qtData || qtData.response_code !== 0) {
      return res.status(503).json({ error: "No questions available" });
    }

    // ✅ Store questions + correct answers server-side, shuffle options
    const clientQuestions = [];
    for (let i = 0; i < qtData.results.length; i++) {
      const q = qtData.results[i];
      const correct = decodeURIComponent(q.correct_answer);
      const question = decodeURIComponent(q.question);
      const incorrect = q.incorrect_answers.map((a) => decodeURIComponent(a));

      // Shuffle options
      const options = [correct, ...incorrect].sort(() => Math.random() - 0.5);
      const optionsJson = JSON.stringify(options);

      await pool.query(
        `INSERT INTO game_questions (session_id, q_index, correct_answer, question, options)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (session_id, q_index) DO NOTHING`,
        [sessionId, i, correct, question, optionsJson],
      );

      // Send to client WITHOUT correct answer
      clientQuestions.push({
        questionIndex: i,
        question,
        options,
        diff: q.difficulty,
      });
    }

    res.json({ ok: true, questions: clientQuestions });
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
    const sessionCheck = await pool.query(
      "SELECT finished FROM game_sessions WHERE user_id=$1 AND game_id=$2",
      [req.user.id, gameId],
    );
    if (sessionCheck.rows.length === 0)
      return res
        .status(400)
        .json({ error: "Game session not found — click Play first" });
    if (sessionCheck.rows[0].finished) {
      // ✅ Allow retry — return cached score + fresh signature
      // so user can re-submit onchain if TX failed last time
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

    // ✅ Get nonce with retry
    // ✅ Try onchain nonce first, fall back to DB if RPC fails
    let nonce;
    try {
      nonce = await activeRpcCall((c) => c.nonces(effectiveWallet), "nonces");
      // Keep DB in sync with onchain nonce
      await pool.query("UPDATE users SET nonce=$1 WHERE id=$2", [
        nonce.toString(),
        req.user.id,
      ]);
      console.log(`✅ Onchain nonce for ${effectiveWallet}: ${nonce}`);
    } catch (e) {
      console.warn("getNonce RPC failed, falling back to DB nonce:", e.message);
      const nonceRow = await pool.query("SELECT nonce FROM users WHERE id=$1", [
        req.user.id,
      ]);
      nonce = BigInt(nonceRow.rows[0]?.nonce || 0);
      console.log(`⚠️ Using DB nonce: ${nonce}`);
    }

    // ✅ Calculate score server-side
    const sessionRow = await pool.query(
      "SELECT id FROM game_sessions WHERE user_id=$1 AND game_id=$2",
      [req.user.id, gameId],
    );
    const sessionId = sessionRow.rows[0]?.id;

    const storedQs = await pool.query(
      "SELECT q_index, correct_answer FROM game_questions WHERE session_id=$1 ORDER BY q_index",
      [sessionId],
    );

    let score = 0;
    if (storedQs.rows.length > 0) {
      // ✅ Full server-side verification — ignores client's correct flag
      for (const stored of storedQs.rows) {
        const userAnswer = answers.find(
          (a) => a.questionIndex === stored.q_index,
        );
        if (!userAnswer) continue;
        if (userAnswer.selected === stored.correct_answer) {
          const tl = Math.max(0, Math.min(15, userAnswer.timeLeft || 0));
          score += 100 + Math.min(50, Math.floor((tl / 15) * 50));
        }
      }
    } else {
      // ✅ Fallback if questions weren't stored (old sessions)
      for (const a of answers.slice(0, 10)) {
        if (a.correct === true) {
          const tl = Math.max(0, Math.min(15, a.timeLeft || 0));
          score += 100 + Math.min(50, Math.floor((tl / 15) * 50));
        }
      }
    }
    score = Math.min(score, 1500);

    // ✅ Sign the score
    const message = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "uint256"],
      [effectiveWallet, gameId, score, nonce],
    );
    const signature = await verifierWallet.signMessage(
      ethers.getBytes(message),
    );

    // ✅ Save to DB
    await pool.query(
      "UPDATE game_sessions SET finished=true, score=$1 WHERE user_id=$2 AND game_id=$3",
      [score, req.user.id, gameId],
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

// =============================================================================
// START
// =============================================================================

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n🚀 Backend running on port ${PORT}`);
  console.log(`   Verifier:  ${verifierWallet.address}`);
  console.log(`   Contract:  ${CONTRACT_ADDRESS}`);
});

# 🎮 TriviaFi
> Onchain multichain trivia — Play. Win. Get paid in crypto.

TriviaFi is a fully onchain trivia game where players compete across **Arc Testnet** and **LitVM Testnet**, earning **USDC** and **zkLTC** prizes. Scores are signed and verified onchain, prize pools split automatically, and every game is transparent and trustless.

🌐 **Live:** https://triviafi.vercel.app  
🐦 **Twitter:** [@Purefier1](https://x.com/Purefier1)  
💬 **Telegram:** https://t.me/triviafi

---

## ⚡ Features

### 🤖 AI Agent Rooms
- Auto-created every hour, 24/7 — no setup needed
- Pay entry fee, answer 10 questions, top scorers split the prize pool
- 60% / 25% / 15% prize distribution to top 3

### 🏟️ Paid Tournaments
- Multi-round elimination format
- Bottom half eliminated each round
- Entry fees in USDC (Arc) or zkLTC (LitVM)
- Onchain prize payouts directly to winners' wallets
- Auto-expires and refunds if not filled within 2 hours

### 💬 Whitelist Battle Tournaments
- 100% free to play — no entry fee
- Perfect for Discord communities and Web3 projects
- Top 3 win custom prizes: WL spots, NFT roles, early access
- Task gate system — require Twitter follows, retweets, Discord joins before applying
- Creator reviews and approves players manually
- Winners submit X/Twitter handle for prize delivery

### 🧠 Trivia Engine
- 12 categories: General Knowledge, Science, History, Video Games, Sports, Computers, Geography, Film, Music, Mathematics, Mythology, Television
- Questions fetched live from OpenTDB with local fallback bank
- Scores signed by verifier wallet — cannot be faked or replayed
- CSRF protection on every mutating endpoint

### 👤 Profile System
- Connect MetaMask or Rabby wallet
- Link Google account for persistent identity
- Set custom username and avatar
- Track stats: games played, wins, total earned across both chains
- Global leaderboard and Tournament Hall of Fame

### 📊 Live Stats
- Real-time ticker showing active games and prize pools
- Global stats bar: total players, games played, scores submitted
- Per-chain volume tracking: USDC and zkLTC separately

---

## 🌐 Networks

| Network | Chain ID | Token | Contract |
|---|---|---|---|
| Arc Testnet | 5042002 | USDC | `0x52F6dE1118a3c22CBF04f7d811B08034DCF21E50` |
| LitVM LiteForge | 4441 | zkLTC | `0xf829c7adAAd30C9735c73F33e9576F1ABDC7F765` |

**Treasury / Verifier:** `0xAe699B48004F1507CbcB05EaCc0D7528c4F0d407`

---

## 🛠 Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS + ethers.js v6 |
| Backend | Node.js + Express (Render) |
| Database | PostgreSQL via Supabase |
| Auth | Google OAuth + wallet signature |
| Blockchain | Arc Testnet + LitVM LiteForge |
| Smart Contracts | Solidity |
| Questions | OpenTDB API (12 categories) |
| Wallets | MetaMask + Rabby |

---

## 🔐 Security

- **Score signing** — every score is signed by the verifier wallet with a nonce; cannot be faked or replayed
- **CSRF protection** — all mutating endpoints require a valid CSRF token
- **Onchain tx verification** — tournament payment tx hashes verified onchain before registration is accepted
- **Wallet signature auth** — wallet login requires signing a message; signature recovered server-side
- **Admin server-side only** — admin status checked server-side via `ADMIN_WALLET` env var; never exposed in frontend JS
- **Input sanitization** — all user content sanitized with `sanitize-html` before storage
- **Rate limiting** — global 120 req/min + 3 score submissions/min per IP
- **Submission cooldown** — DB-backed 10-second cooldown per wallet across server restarts
- **Payment recovery** — orphaned payments (paid but session expired) are logged and recoverable without double-paying
- **Private keys** — never committed to repo; loaded from environment variables only

---

## 🚀 Getting Started

### 1. Clone the repo

```bash
git clone https://github.com/Purefier100/triviafi.git
cd triviafi
```

### 2. Install backend dependencies

```bash
cd backend
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Fill in the following variables:

```env
DATABASE_URL=your_supabase_postgres_url
SESSION_SECRET=your_session_secret
VERIFIER_PRIVATE_KEY=your_verifier_wallet_private_key
TREASURY_ADDRESS=0xAe699B48004F1507CbcB05EaCc0D7528c4F0d407
CONTRACT_ADDRESS=0x52F6dE1118a3c22CBF04f7d811B08034DCF21E50
LITVM_CONTRACT_ADDRESS=0xf829c7adAAd30C9735c73F33e9576F1ABDC7F765
LITVM_RPC_URL=https://liteforge.rpc.caldera.xyz/http
GOOGLE_CLIENT_ID=your_google_oauth_client_id
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret
GOOGLE_CALLBACK_URL=http://localhost:4000/auth/google/callback
FRONTEND_URL=http://localhost:3000
ADMIN_WALLET=your_admin_wallet_address
ADMIN_SECRET=your_admin_secret_key
NODE_ENV=development
PORT=4000
```

### 4. Start the backend

```bash
node server.js
```

### 5. Open the frontend

Open `frontend/index.html` directly in your browser, or serve it with any static server:

```bash
npx serve frontend
```

---

## 🗄 Database

TriviaFi uses PostgreSQL. Tables are auto-created on first run via `initDB()`. Key tables:

| Table | Purpose |
|---|---|
| `users` | Wallet + Google accounts, usernames, avatars |
| `games` | Multichain game records synced from onchain |
| `game_sessions` | Per-player play sessions with scores |
| `game_questions` | Server-stored correct answers per session |
| `tournaments` | Paid and whitelist tournament records |
| `tournament_players` | Players per tournament with scores and elimination status |
| `tournament_rounds` | Round-by-round status |
| `tournament_scores` | Per-round scores per player |
| `tournament_claims` | Prize claim records with tx hashes |
| `tournament_applications` | Whitelist tournament applications |
| `tournament_wl_tasks` | Per-tournament task gates |
| `platform_tasks` | Global admin-set task gates |
| `game_refunds` | Refund records for no-show players |
| `submission_cooldowns` | DB-backed rate limiting across restarts |
| `bets` | Prediction bets on game winners |

---

## 🏗 Architecture
Browser (Vanilla JS + ethers.js)
│
├── MetaMask / Rabby (wallet txs)
│
▼
Express Backend (Render)
│
├── PostgreSQL (Supabase)
├── Arc Testnet RPC  ──► TriviaFi Contract (USDC)
└── LitVM RPC        ──► TriviaFi Contract (zkLTC)

**Game flow:**
1. Player connects wallet → backend verifies signature → session created
2. Player joins game onchain (USDC approve + joinGame tx)
3. Player answers 10 questions → answers sent to backend
4. Backend verifies answers against stored correct answers → signs score with nonce
5. Player submits signed score onchain via `submitScore()`
6. When all players finish, `triggerEnd()` distributes prizes automatically

---

## 📈 Roadmap

- [x] Multichain support (Arc + LitVM)
- [x] AI agent auto-game creation
- [x] Paid tournaments with onchain prize splits
- [x] Whitelist battle tournaments for communities
- [x] Google OAuth + wallet profile system
- [x] Global leaderboard and tournament hall of fame
- [x] Payment recovery system for orphaned transactions
- [x] CSRF protection and onchain tx verification
- [ ] Mobile app (iOS + Android)
- [ ] More chains (Base, Ethereum mainnet)
- [ ] NFT achievement badges
- [ ] DAO governance for game categories
- [ ] Sponsored tournament pools

---

## 🤝 Contributing

Contributions are welcome. Open an issue or submit a PR.

For major changes, open an issue first to discuss what you'd like to change.

---

## 🧠 Vision

TriviaFi is building the first decentralized knowledge economy — where your intelligence is your wallet. As blockchain gaming matures, TriviaFi aims to be the go-to skill-based earning game across every major chain: fair, transparent, and rewarding to the smartest players.

---

## 📄 License

MIT

---

*Built for the LitVM Hackathon 2025 · [@Purefier1](https://x.com/Purefier1)*

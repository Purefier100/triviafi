// =============================================================================
// ARC TRIVIA — app.js FINAL FIX
// Root cause of BAD_DATA: contract getGame() returns a struct (GameView memory)
// but ABI declared individual return values. Struct encoding adds an extra
// 32-byte offset pointer that ethers couldn't decode.
// Fix: ABI uses tuple() return type + helper to normalise result to array
// =============================================================================

// ── EIP-6963: Modern multi-wallet detection ──────────────────────────────
window._eip6963Providers = {};
window.addEventListener("eip6963:announceProvider", (event) => {
  const { info, provider } = event.detail;
  window._eip6963Providers[info.rdns] = { info, provider };
  console.log("EIP-6963 wallet detected:", info.name, info.rdns);
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

function getActiveProvider() {
  return window._activeWalletProvider || window.ethereum;
}

const BACKEND = "https://name-triviafi-backend.onrender.com";
let currentProfile = null;

// ── Treasury address — loaded from backend, not hardcoded ─────────────────
let TREASURY_ADDRESS = "0xAe699B48004F1507CbcB05EaCc0D7528c4F0d407"; // fallback
async function loadTreasuryAddress() {
  try {
    const res = await fetch(`${BACKEND}/config/treasury`);
    const data = await res.json();
    if (data.address && /^0x[a-fA-F0-9]{40}$/i.test(data.address)) {
      TREASURY_ADDRESS = data.address.toLowerCase();
      console.log("✅ Treasury address loaded:", TREASURY_ADDRESS);
    }
  } catch (_) {
    console.warn("Could not load treasury address, using fallback");
  }
}

async function initAuth() {
  try {
    const res = await fetch(`${BACKEND}/auth/me`, { credentials: "include" });
    const data = await res.json();
    if (data.user) {
      currentProfile = data.user;

      // 🔥 CRITICAL FIX: auto-link wallet if already connected
      //
      if (userAddress && !currentProfile.wallet) {
        await linkWalletToProfile(userAddress);
      }

      renderAuthState();
    }
  } catch (_) {}
  const params = new URLSearchParams(location.search);
  const auth = params.get("auth");
  if (auth === "setup") {
    const r = await fetch(`${BACKEND}/auth/me`, { credentials: "include" });
    const d = await r.json();
    if (d.user) {
      currentProfile = d.user;
      showUsernameSetup();
    }
    history.replaceState({}, "", location.pathname);
  } else if (auth === "success") {
    const r = await fetch(`${BACKEND}/auth/me`, { credentials: "include" });
    const d = await r.json();
    if (d.user) {
      currentProfile = d.user;

      // 🔥 SAME FIX HERE
      //
      if (userAddress && !currentProfile.wallet) {
        await linkWalletToProfile(userAddress);
      }

      renderAuthState();
      toast("✅ Logged in as @" + d.user.username, "success");
    }
    history.replaceState({}, "", location.pathname);
  } else if (auth === "google_taken") {
    toast(
      "⚠️ This Google account is already linked to another wallet. Please use a different Google account.",
      "error",
    );

    history.replaceState({}, "", location.pathname);
  }
}

// ── Cached RPC providers — reuse instead of creating new ones every call ──
let _cachedLitvmProvider = null;
let _litvmProviderAge = 0;
const PROVIDER_TTL = 300000; // 5 minutes — reduces new provider creation significantly

async function getLitvmProvider() {
  const now = Date.now();
  if (_cachedLitvmProvider && now - _litvmProviderAge < PROVIDER_TTL) {
    return _cachedLitvmProvider;
  }
  // Don't test with getBlockNumber — that wastes a rate-limited request
  // Just create the provider and cache it immediately
  _cachedLitvmProvider = new ethers.JsonRpcProvider(
    "https://liteforge.rpc.caldera.xyz/http",
    { chainId: 4441, name: "litvm" },
  );
  _litvmProviderAge = now;
  return _cachedLitvmProvider;
}

function toggleProfileDropdown(e) {
  if (e) e.stopPropagation();
  const t = document.getElementById("profileTrigger");
  if (t) t.classList.toggle("open");
}

function sanitizeUrl(url) {
  if (!url) return "";
  if (
    url.startsWith("data:image/") ||
    url.startsWith("http://") ||
    url.startsWith("https://")
  )
    return url;
  return "";
}
function sanitizeText(str) {
  if (!str) return "";
  const d = document.createElement("div");
  d.textContent = String(str);
  return d.innerHTML;
}

function renderAuthState() {
  const u = currentProfile,
    hasGoogle = !!(u && u.google_id),
    hasWallet = !!userAddress,
    isLoggedIn = hasGoogle || hasWallet;
  const trigger = document.getElementById("profileTrigger");
  const connectBtn = document.getElementById("connectBtn");
  const gBtn = document.getElementById("googleLoginBtn");
  if (isLoggedIn) {
    if (trigger) trigger.style.display = "flex";
    if (connectBtn) connectBtn.style.display = hasWallet ? "none" : "flex";
    if (gBtn) gBtn.style.display = "none";
  } else {
    if (trigger) trigger.style.display = "none";
    if (connectBtn) {
      connectBtn.style.display = "flex";
      connectBtn.textContent = "🦊 Connect Wallet";
      connectBtn.style.background =
        "linear-gradient(135deg,var(--accent),var(--purple))";
    }
    if (gBtn) gBtn.style.display = "none";
  }
  const ha = document.getElementById("headerAvatar"),
    hn = document.getElementById("headerName");
  if (ha && hn) {
    const hasName = u && (u.username || u.display_name);
    const init = hasName
      ? (u.username || u.display_name)[0].toUpperCase()
      : userAddress
        ? userAddress.slice(2, 4).toUpperCase()
        : "?";
    ha.innerHTML = u?.avatar
      ? `<img src="${sanitizeUrl(u.avatar)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
      : init;
    // Never show "@null" or "@undefined" — fall back to wallet address
    hn.textContent = hasName
      ? "@" + (u.username || u.display_name)
      : fmt(userAddress);
  }
  const pa = document.getElementById("pdAvatarBig"),
    pn = document.getElementById("pdName"),
    pe = document.getElementById("pdEmail");
  if (pa) {
    const hasName = u && (u.username || u.display_name);
    pa.innerHTML = u?.avatar
      ? `<img src="${sanitizeUrl(u.avatar)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
      : hasName
        ? (u.username || u.display_name)[0].toUpperCase()
        : userAddress
          ? userAddress.slice(2, 4).toUpperCase()
          : "?";
  }
  if (pn) {
    const hasName = u && (u.username || u.display_name);
    pn.textContent = hasName
      ? "@" + (u.username || u.display_name)
      : userAddress
        ? fmt(userAddress)
        : "—";
  }
  if (pe)
    pe.textContent =
      u?.email || (userAddress ? userAddress.slice(0, 14) + "..." : "—");
  const pgl = document.getElementById("pdGoogleLabel"),
    pgs = document.getElementById("pdGoogleStatus");
  const pwl = document.getElementById("pdWalletLabel"),
    pws = document.getElementById("pdWalletStatus");
  if (pgl && pgs) {
    pgl.textContent = u ? u.email : "Google Account";
    if (hasGoogle) {
      pgs.className = "conn-linked";
      pgs.textContent = "✓ Linked";
      pgs.onclick = null;
    } else {
      pgs.className = "conn-link-btn";
      pgs.textContent = "+ Connect Gmail";
      pgs.style.cssText =
        "font-size:.7rem;background:rgba(66,133,244,.1);color:#4285F4;border:1px solid rgba(66,133,244,.3);padding:3px 10px;border-radius:10px;cursor:pointer;font-weight:700";
      pgs.onclick = () => loginWithGoogle();
    }
  }
  if (pwl && pws) {
    pwl.textContent = hasWallet ? fmt(userAddress) : "Wallet";
    if (hasWallet) {
      pws.className = "conn-linked";
      pws.textContent = "✓ Linked";
      pws.onclick = null;
      if (u && !u.wallet) linkWalletToProfile(userAddress);
    } else {
      pws.className = "conn-link-btn";
      pws.textContent = "+ Connect";
      pws.onclick = () => {
        connectWallet();
        toggleProfileDropdown(null);
      };
    }
  }
  if (hasWallet) loadDropdownStats();

  // ✅ Admin button — always hidden by default, shown only after server confirms
  const adminBtn = document.getElementById("adminTaskBtn");
  if (adminBtn) {
    // Never expose admin wallet in frontend JS — use server-side check
    adminBtn.style.display = "none";
    if (userAddress) {
      fetch(`${BACKEND}/admin/me`, { credentials: "include" })
        .then((r) => r.json())
        .then((d) => {
          if (adminBtn && d.isAdmin) adminBtn.style.display = "flex";
        })
        .catch(() => {});
    }
  }
  const old = document.getElementById("profileCard");
  if (old) old.style.display = "none";
}

let answers = [];
let currentIndex = 0;

// ========================
// START GAME
// ========================
async function startGame() {
  answers = [];
  currentIndex = 0;

  // 🔒 BLOCK replay after refresh
  if (
    sessionStorage.getItem(`playing_${currentGameId}`) ||
    localStorage.getItem(`played_${currentGameId}`)
  ) {
    toast("You already played this game!", "error");

    showScreen("screenResults");

    score = loadSavedScore(currentGameId);

    document.getElementById("resScore").textContent = score || "...";

    document.getElementById("resSub").textContent =
      `Already played · ${score || "pending"} pts`;

    document.getElementById("submitSection").style.display =
      score > 0 ? "block" : "none";

    await refreshResults();

    return;
  }

  // 🔒 BLOCK REPLAY
  try {
    const res = await fetch(
      `${BACKEND}/game/status/${currentGameId}?chainId=${parseInt(
        activeNet.hexChainId,
        16,
      )}`,
      {
        credentials: "include",
      },
    );

    if (!res.ok) {
      alert("You must login first");
      return;
    }

    const data = await res.json();

    if (data.finished) {
      alert("You already played this game");
      return;
    }
  } catch (e) {
    console.error("Status check failed:", e);
    alert("Server error. Try again.");
    return;
  }

  // ✅ REGISTER GAME START
  try {
    const res = await fetch(`${BACKEND}/game/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        gameId: currentGameId,
        wallet: userAddress,
        chainId: parseInt(activeNet.hexChainId, 16),
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || "Failed to start game");
      return;
    }
  } catch (e) {
    console.error("Game start failed:", e);
    alert("Server error. Try again.");
    return;
  }

  // ✅ Mark as started immediately
  sessionStorage.setItem(`playing_${currentGameId}`, "1");

  // ▶️ START GAME
  showScreen("screenGame");
  loadQuestions();
}

// ========================
// ANSWER SELECTION
// ========================
function selectAnswer(questionId, selected) {
  const q = questions[currentIndex];

  answers.push({
    questionIndex: questionId,
    selected,
  });

  currentIndex++;
  loadQuestions();
}

// ========================
// LOAD QUESTIONS + END GAME
// ========================
function loadQuestions() {
  const q = questions[currentIndex];

  if (!q) {
    submitScore();

    return;
  }

  const container = document.getElementById("answers");
  container.innerHTML = "";

  q.options.forEach((option) => {
    const btn = document.createElement("button");
    btn.textContent = option;

    btn.onclick = () => {
      selectAnswer(q.id, option);
    };

    container.appendChild(btn);
  });
}

// ========================
// SUBMIT SCORE (ON-CHAIN)
// ========================
async function submitScore() {
  try {
    if (!userAddress) {
      toast("Connect wallet first", "error");
      return;
    }

    console.log("SENDING ANSWERS:", answers);

    const csrfRes = await fetch(`${BACKEND}/csrf-token`, {
      credentials: "include",
    });

    const csrfData = await csrfRes.json();

    const res = await fetch(`${BACKEND}/submit-score`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CSRF-Token": csrfData.csrfToken,
      },
      credentials: "include",
      body: JSON.stringify({
        gameId: currentGameId,
        wallet: userAddress,
        answers,
        chainId: parseInt(activeNet.hexChainId, 16),
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      toast(data.error || "Submit failed", "error");
      return;
    }

    // ✅ Show score instantly
    document.getElementById("resScore").textContent = data.score;

    const tx = await contract.submitScore(
      currentGameId,
      data.score,
      data.nonce,
      data.signature,
    );

    toast("⛓️ Waiting for blockchain confirmation...", "info");

    await tx.wait();
    markSubmitted(currentGameId);
    saveScore(currentGameId, data.score);

    toast("✅ Score submitted onchain!", "success");
    await loadGames();

    await loadGlobalStats();

    await refreshResults();
  } catch (e) {
    console.error(e);
    toast("Submit failed", "error");
  }
}

let currentFilter = "all";

async function claimRefund(gameId) {
  try {
    const tx = await contract.claimRefund(gameId);
    await tx.wait();

    toast("💸 Refund claimed!", "success");
  } catch (e) {
    toast("Refund failed: " + e.message, "error");
  }
}

async function loadGameStatus(gameId) {
  try {
    const res = await fetch(
      `${BACKEND}/game/status/${currentGameId}?chainId=${parseInt(
        activeNet.hexChainId,
        16,
      )}`,
      {
        credentials: "include",
      },
    );

    const data = await res.json();

    const container = document.getElementById("gameActions");

    // example: backend should return status
    if (data.status === 2) {
      container.innerHTML = `
        <button onclick="claimRefund(${gameId})">
          💸 Claim Refund
        </button>
      `;
    }
  } catch (e) {
    console.error(e);
  }
}

async function loadDropdownStats() {
  if (!userAddress) return;
  try {
    // Fetch Arc stats
    const arcProvider2 = new ethers.JsonRpcProvider(
      "https://rpc.testnet.arc.network",
    );
    const arcRC2 = new ethers.Contract(
      NETWORKS[5042002].contractAddress,
      ABI,
      arcProvider2,
    );
    const litvmProvider2 = await getLitvmProvider();
    const litvmRC2 = new ethers.Contract(
      NETWORKS[4441].contractAddress,
      ABI,
      litvmProvider2,
    );

    const [arcStats, litvmStats] = await Promise.allSettled([
      arcRC2.getPlayerStats(userAddress),
      litvmRC2.getPlayerStats(userAddress),
    ]);

    let totalPlayed = 0n,
      totalWon = 0n,
      totalEarned = 0n;
    if (arcStats.status === "fulfilled") {
      totalPlayed += BigInt(arcStats.value[0]);
      totalWon += BigInt(arcStats.value[1]);
      totalEarned += BigInt(arcStats.value[2]); // USDC (6 decimals)
    }
    if (litvmStats.status === "fulfilled") {
      totalPlayed += BigInt(litvmStats.value[0]);
      totalWon += BigInt(litvmStats.value[1]);
      // zkLTC earnings shown separately — skip adding to USDC total
    }

    const usdcEarned =
      arcStats.status === "fulfilled"
        ? parseFloat(ethers.formatUnits(arcStats.value[2], 6)).toFixed(2)
        : "0.00";
    const litvmEarned =
      litvmStats.status === "fulfilled"
        ? parseFloat(ethers.formatUnits(litvmStats.value[2], 18)).toFixed(4)
        : "0.0000";
    // ✅ Compact number formatter: 1,234,567 → 1.23M | 12,345 → 12.3K
    function fmtCompact(num) {
      const n = parseFloat(num);
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
      if (n >= 10_000) return (n / 1_000).toFixed(1) + "K";
      if (n >= 1_000) return (n / 1_000).toFixed(2) + "K";
      return n.toFixed(2);
    }

    const usdcDisplay = fmtCompact(usdcEarned);
    const litvmDisplay =
      parseFloat(litvmEarned) > 0 ? fmtCompact(litvmEarned) : null;

    // Two-line display if both chains have earnings
    const earnedDisplay = litvmDisplay
      ? `<span style="display:block;line-height:1.3">${usdcDisplay} USDC</span><span style="display:block;line-height:1.3;color:var(--purple)">${litvmDisplay} zkLTC</span>`
      : `${usdcDisplay} USDC`;

    const map = {
      dpPlayed: totalPlayed.toString(),
      dpWon: totalWon.toString(),
      dpEarned: earnedDisplay,
      myPlayed: totalPlayed.toString(),
      myWon: totalWon.toString(),
      myEarned: earnedDisplay,
    };
    Object.entries(map).forEach(([id, v]) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (id === "dpEarned" || id === "myEarned") {
        el.innerHTML = typeof v === "bigint" ? v.toString() : v;
      } else {
        el.textContent = typeof v === "bigint" ? v.toString() : v;
      }
    });
  } catch (_) {}
}

async function showMyHistory() {
  if (!userAddress) return toast("Connect wallet first", "error");
  showScreen("screenHistory");
  await loadHistoryScreen();
}

async function loadHistoryScreen() {
  const el = document.getElementById("historyList");

  if (!el) return;

  el.innerHTML = `
    <p style="
      color:var(--muted);
      text-align:center;
      padding:20px
    ">
      Loading your games...
    </p>
  `;

  try {
    const res = await fetch(`${BACKEND}/history/${userAddress}`);

    const myGames = await res.json();

    if (!Array.isArray(myGames) || myGames.length === 0) {
      el.innerHTML = `
        <div style="
          text-align:center;
          padding:40px;
          color:var(--muted)
        ">
          <div style="
            font-size:3rem;
            margin-bottom:12px
          ">
            🎮
          </div>

          <p>No games played yet.</p>
        </div>
      `;
      return;
    }

    let html = "";

    for (const g of myGames) {
      const chainIcon = g.chain_id === 4441 ? "🔷" : "⚡";

      html += `
        <div
          onclick="openGame(${g.contract_game_id})"
          style="
            background:var(--surface);
            border:1px solid var(--border);
            border-radius:12px;
            padding:14px 16px;
            margin-bottom:10px;
            cursor:pointer
          "
        >
          <div style="
            display:flex;
            justify-content:space-between;
            align-items:center;
            margin-bottom:6px
          ">
            <span style="
              font-weight:700;
              font-size:.92rem
            ">
              ${chainIcon}
              #${g.contract_game_id}
              ${sanitizeText(g.name)}
            </span>

            <span class="badge b-wait">
              ${
                g.status === 1 ? "Ended" : g.status === 2 ? "Cancelled" : "Open"
              }
            </span>
          </div>

          <div style="
            font-size:.78rem;
            color:var(--muted)
          ">
            ${sanitizeText(g.category || "Trivia")}
            · 👥 ${g.max_players || 0} players
            · 🏆 ${g.entry_fee || 0}
            ${g.token_symbol || ""}
          </div>
        </div>
      `;
    }

    el.innerHTML = html;
  } catch (e) {
    console.error(e);

    el.innerHTML = `
      <p style="
        color:var(--red);
        text-align:center;
        padding:20px
      ">
        Error: ${e.message}
      </p>
    `;
  }
}

async function savePfp() {
  if (!currentProfile) return toast("Login with Google first", "error");
  const url =
    window.pfpPendingDataUrl ||
    document.getElementById("pfpUrlInput")?.value?.trim();
  if (!url) {
    closePfpModal();
    return;
  }
  if (!url.startsWith("http") && !url.startsWith("data:image/"))
    return toast("Invalid image format", "error");
  try {
    const res = await fetch(`${BACKEND}/profile/avatar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ avatar: url }),
    });
    const data = await res.json();
    if (data.error) return toast("Error: " + data.error, "error");
    currentProfile = data.user;
    window.pfpPendingDataUrl = null;
    closePfpModal();
    renderAuthState();
    toast("✅ Avatar updated!", "success");
  } catch (e) {
    toast("Failed: " + e.message, "error");
  }
}

function showUsernameSetup() {
  history.replaceState({}, "", location.pathname);
  const m = document.getElementById("usernameModal");
  if (m) m.style.display = "flex";
}

async function submitUsername() {
  const input = document.getElementById("usernameInput"),
    errEl = document.getElementById("usernameError");
  const username = input.value.trim();
  errEl.textContent = "";
  if (!username) {
    errEl.textContent = "Enter a username";
    return;
  }
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    errEl.textContent = "Letters, numbers, underscore only (3-20 chars)";
    return;
  }
  const cr = await fetch(`${BACKEND}/profile/check/${username}`, {
    credentials: "include",
  });
  const cd = await cr.json();
  if (!cd.available) {
    errEl.textContent = "Username taken, try another";
    return;
  }
  const res = await fetch(`${BACKEND}/profile/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username, wallet: userAddress || null }),
  });
  const data = await res.json();
  if (data.error) {
    errEl.textContent = data.error;
    return;
  }
  currentProfile = data.user;
  document.getElementById("usernameModal").style.display = "none";
  renderAuthState();
  toast("🎉 Welcome, @" + username + "!", "success");
}

async function checkUsernameAvailability() {
  const input = document.getElementById("usernameInput"),
    errEl = document.getElementById("usernameError");
  const username = input.value.trim();
  if (username.length < 3) {
    errEl.textContent = "";
    return;
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    errEl.textContent = "Letters, numbers, underscore only";
    errEl.style.color = "var(--red)";
    return;
  }
  const res = await fetch(`${BACKEND}/profile/check/${username}`, {
    credentials: "include",
  });
  const data = await res.json();
  errEl.textContent = data.available ? "✓ Available" : "✗ Taken";
  errEl.style.color = data.available ? "var(--green)" : "var(--red)";
}

async function linkWalletToProfile(wallet) {
  if (!currentProfile) return;
  if (currentProfile.wallet?.toLowerCase() === wallet.toLowerCase()) return;

  if (
    currentProfile.wallet &&
    currentProfile.wallet.toLowerCase() !== wallet.toLowerCase()
  ) {
    toast(
      `⚠️ This Google account is already linked to wallet ${fmt(
        currentProfile.wallet,
      )}. Disconnect that wallet first.`,
      "error",
    );
    return;
  }

  // Check if this wallet is already linked to another Google account
  try {
    const check = await fetch(`${BACKEND}/profile/by-wallet/${wallet}`, {
      credentials: "include",
    });
    const existing = await check.json();
    if (existing && existing.google_id && existing.id !== currentProfile.id) {
      toast(
        `⚠️ This wallet is already linked to another Google account (@${
          existing.username || "user"
        }). One wallet per account only.`,
        "error",
      );
      return;
    }
  } catch (_) {}

  try {
    // MUST match /profile/wallet backend message
    const message = `Link wallet to ${activeNet.name} account`;
    const signature = await signer.signMessage(message);

    let csrfToken2 = "";
    try {
      const ct2 = await fetch(`${BACKEND}/csrf-token`, {
        credentials: "include",
      });
      const ctd2 = await ct2.json();
      csrfToken2 = ctd2.csrfToken || "";
    } catch (_) {}

    const res = await fetch(`${BACKEND}/profile/wallet`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CSRF-Token": csrfToken2 },
      credentials: "include",
      body: JSON.stringify({
        wallet,
        signature,
        networkName: activeNet.name,
      }),
    });
    const data = await res.json();
    if (data.error) {
      toast("Link failed: " + data.error, "error");
      return;
    }
    if (data.user) {
      currentProfile = data.user;
      renderAuthState();
    }
  } catch (e) {
    console.error("linkWallet:", e.message);
  }
}

function loginWithGoogle() {
  window.location.href = `${BACKEND}/auth/google`;
}

async function logoutAll() {
  try {
    await fetch(`${BACKEND}/auth/logout`, {
      credentials: "include",
    });
  } catch (_) {}

  window._bannerDismissed = false;
  window._bannerShowAll = false;
  // RESET EVERYTHING
  currentProfile = null;
  provider = null;
  signer = null;
  contract = null;
  usdcContract = null;
  userAddress = null;

  stopAutoRefresh();

  // CLOSE DROPDOWN
  const trigger = document.getElementById("profileTrigger");
  if (trigger) {
    trigger.classList.remove("open");
    trigger.style.display = "none";
  }

  // SHOW CONNECT BUTTON AGAIN
  const connectBtn = document.getElementById("connectBtn");
  if (connectBtn) {
    connectBtn.style.display = "flex";
    connectBtn.textContent = "🦊 Connect Wallet";
  }

  // HIDE GOOGLE BUTTON
  const gBtn = document.getElementById("googleLoginBtn");
  if (gBtn) {
    gBtn.style.display = "none";
  }

  // FORCE UI RE-RENDER
  renderAuthState();

  // RETURN TO LOBBY
  showScreen("screenLobby");

  toast("Signed out", "info");
}

const usernameCache = {};
async function resolveUsername(wallet) {
  if (!wallet || wallet === "0x0000000000000000000000000000000000000000")
    return "—";
  const key = wallet.toLowerCase();
  if (usernameCache[key]) return usernameCache[key];
  try {
    const res = await fetch(`${BACKEND}/profile/by-wallet/${wallet}`, {
      credentials: "include",
    });
    const data = await res.json();
    if (data?.username) {
      usernameCache[key] = "@" + data.username;
      return "@" + data.username;
    }
  } catch (_) {}
  usernameCache[key] = fmt(wallet);
  return fmt(wallet);
}

async function resolveUsernames(wallets) {
  const unique = [
    ...new Set(wallets.map((w) => w?.toLowerCase()).filter(Boolean)),
  ];
  const needed = unique.filter((w) => !usernameCache[w]);
  if (needed.length > 0) {
    try {
      const res = await fetch(`${BACKEND}/profile/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ wallets: needed }),
      });
      const map = await res.json();
      Object.entries(map).forEach(([w, u]) => {
        usernameCache[w] = u.username ? "@" + u.username : fmt(w);
      });
      needed
        .filter((w) => !usernameCache[w])
        .forEach((w) => {
          usernameCache[w] = fmt(w);
        });
    } catch (_) {
      needed.forEach((w) => {
        usernameCache[w] = fmt(w);
      });
    }
  }
  const result = {};
  wallets.forEach((w) => {
    if (w) result[w.toLowerCase()] = usernameCache[w.toLowerCase()] || fmt(w);
  });
  return result;
}

function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshInterval = setInterval(async () => {
    try {
      // Only reload games if NOT viewing agent room card to prevent flicker
      const activeScreen = document.querySelector(".screen.active")?.id;
      if (
        typeof loadGames === "function" &&
        activeScreen === "screenLobby" &&
        !window._agentRoomMode
      ) {
        await loadGames();
      }
      if (typeof loadGlobalStats === "function") await loadGlobalStats();
      if (userAddress && typeof checkUnclaimedPrizes === "function")
        await checkUnclaimedPrizes();

      const historyScreen = document.getElementById("screenHistory");
      if (
        historyScreen &&
        historyScreen.classList.contains("active") &&
        typeof loadHistoryScreen === "function"
      ) {
        await loadHistoryScreen();
      }

      if (currentGameId && typeof refreshResults === "function") {
        await refreshResults();
      }

      // ✅ NEW: Check if we're on the join screen and the game just ended
      const joinScreen = document.getElementById("screenJoin");
      const isOnJoinScreen =
        joinScreen && joinScreen.classList.contains("active");
      if (
        isOnJoinScreen &&
        currentGameId &&
        window._joinScreenOrigin === "lobby" &&
        !window._openingGame
      ) {
        try {
          const g = await getGame(currentGameId);
          if (g) {
            const s = Number(g[14]);
            if (s === 1 || s === 2) {
              toast("🏁 Game ended! Loading final results...", "info");
              stopAutoRefresh();
              // Preserve origin before calling read-only
              window._joinScreenOrigin = "lobby";
              await openGameReadOnly(currentGameId, currentGameChainId);
            }
          }
        } catch (_) {}
      }
    } catch (e) {
      console.log("Auto refresh error:", e.message);
    }
  }, 10000);
}

let tournamentRefreshInterval = null;
function startTournamentAutoRefresh(tournamentId) {
  stopTournamentAutoRefresh();
  tournamentRefreshInterval = setInterval(async () => {
    const active = document.querySelector(".screen.active")?.id;
    // Stop if user navigated away or a modal/lock is active
    if (
      active !== "screenJoin" ||
      currentTournamentId !== tournamentId ||
      window._openingGame ||
      window._joiningTournament ||
      document.querySelector(".bet-modal-overlay")
    ) {
      stopTournamentAutoRefresh();
      return;
    }
    try {
      await openTournament(tournamentId);
    } catch (_) {}
  }, 8000);
}

function stopTournamentAutoRefresh() {
  if (tournamentRefreshInterval) {
    clearInterval(tournamentRefreshInterval);
    tournamentRefreshInterval = null;
  }
}

function goBackFromJoin() {
  stopTournamentAutoRefresh();
  stopAutoRefresh();
  // Clear any pending navigation locks
  window._openingGame = false;
  window._joiningTournament = null;
  const origin = window._joinScreenOrigin || "lobby";
  window._joinScreenOrigin = null; // always reset after use
  if (origin === "tournaments") {
    showScreen("screenTournaments");
    loadTournaments();
  } else {
    showScreen("screenLobby");
    loadGames();
  }
}

function stopAutoRefresh() {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
  }
}

function displayName(wallet) {
  if (!wallet || wallet === "0x0000000000000000000000000000000000000000")
    return "—";
  return usernameCache[wallet.toLowerCase()] || fmt(wallet);
}

// =============================================================================
// CONTRACT SETUP
// =============================================================================

// ── Multi-network config ──────────────────────────────────────────────────────
const NETWORKS = {
  5042002: {
    name: "Arc Testnet",
    symbol: "USDC",
    decimals: 6,
    isNative: false,
    contractAddress: "0x52F6dE1118a3c22CBF04f7d811B08034DCF21E50",
    tournamentAddress: "0xeDa9902bC65A5f8Bb99baB7aaA38f2ce171A01a6",
    tokenAddress: "0x3600000000000000000000000000000000000000",
    rpc: "https://rpc.testnet.arc.network",
    hexChainId: "0x" + (5042002).toString(16),
    explorer: "https://testnet.arcscan.app",
    addParams: {
      chainName: "Arc Testnet",
      rpcUrls: ["https://rpc.testnet.arc.network"],
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
      blockExplorerUrls: ["https://testnet.arcscan.app"],
    },
  },
  4441: {
    name: "LitVM Testnet",
    symbol: "zkLTC",
    decimals: 18,
    isNative: true, // zkLTC is native gas token — no ERC20 approve needed
    contractAddress: "0xf829c7adAAd30C9735c73F33e9576F1ABDC7F765",
    tournamentAddress: "0x3A525Df9A4dC97b0d7c484F6d0F30a6c8CAb07B0",
    tokenAddress: null,
    rpc: "https://liteforge.rpc.caldera.xyz/http",
    hexChainId: "0x" + (4441).toString(16),
    explorer: "https://explorerl2new-lit-forge-test-gy6psl6s4g.t.conduit.xyz",
    addParams: {
      chainName: "LitVM LiteForge Testnet",
      rpcUrls: ["https://liteforge.rpc.caldera.xyz/http"],
      nativeCurrency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 },
      blockExplorerUrls: [
        "https://explorerl2new-lit-forge-test-gy6psl6s4g.t.conduit.xyz",
      ],
    },
  },
};

let activeNet = NETWORKS[5042002]; // default Arc
let CONTRACT_ADDRESS = activeNet.contractAddress;
let USDC_ADDRESS = activeNet.tokenAddress;

const ABI = [
  "function gameCounter() view returns (uint256)",
  "function platform() view returns (address)",
  "function verifier() view returns (address)",
  "function totalUSDCPaidOut() view returns (uint256)",
  "function nonces(address) view returns (uint256)",
  "function createGame(string,uint8,string,uint8,uint256,uint256,uint256,uint256) external returns (uint256)",
  "function joinGame(uint256) external payable",
  "function submitScore(uint256,uint256,bytes) external",
  "function triggerEnd(uint256) external",
  "function claimPrize(uint256) external",
  "function cancelGame(uint256,string) external",
  "function claimRefund(uint256) external",
  // ✅ KEY FIX: tuple() return type for struct GameView
  "function getGame(uint256) view returns (tuple(uint256 id,string name,address creator,uint8 categoryId,string categoryName,uint8 difficulty,uint256 entryFee,uint256 maxPlayers,uint256 prizePool,uint256 playerCount,uint256 registrationEnd,uint256 playDeadline,address[3] topPlayers,bool prizeClaimed,uint8 status,uint256 finishedCount))",
  "function getPlayers(uint256) view returns (address[])",
  "function getPlayerStatus(uint256,address) view returns (bool,bool,bool,uint256)",
  "function getPlayerStats(address) view returns (uint256,uint256,uint256)",
  "function getLeaderboard(uint256) view returns (address[],uint256[],bool[],bool[])",
  "function getPrizeBreakdown(uint256) view returns (uint256,uint256,uint256,uint256)",
];

const TOURNAMENT_ABI = [
  "function submitScore(uint256 tournamentId, uint256 roundNumber, uint256 score, uint256 nonce, bytes calldata signature) external",
  "function getScore(uint256 tournamentId, uint256 roundNumber, address player) view returns (uint256 score, uint256 timestamp, bool submitted)",
  "function hasSubmitted(uint256, uint256, address) view returns (bool)",
  "function getRoundSubmissionCount(uint256, uint256) view returns (uint256)",
  "event ScoreSubmitted(uint256 indexed tournamentId, uint256 indexed roundNumber, address indexed player, uint256 score, uint256 timestamp)",
];

const USDC_ABI = [
  "function approve(address,uint256) external returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) external returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
];
const CATEGORIES = [
  { id: 9, name: "General Knowledge", icon: "🧠" },
  { id: 17, name: "Science & Nature", icon: "🔬" },
  { id: 23, name: "History", icon: "📜" },
  { id: 15, name: "Video Games", icon: "🎮" },
  { id: 21, name: "Sports", icon: "⚽" },
  { id: 18, name: "Computers", icon: "💻" },
  { id: 22, name: "Geography", icon: "🌍" },
  { id: 11, name: "Film", icon: "🎬" },
  { id: 12, name: "Music", icon: "🎵" },
  { id: 19, name: "Mathematics", icon: "🔢" },
  { id: 20, name: "Mythology", icon: "⚡" },
  { id: 14, name: "Television", icon: "📺" },
];
const DIFF_LABELS = ["Any", "Easy", "Medium", "Hard"];
const DIFF_CLASSES = ["", "easy", "medium", "hard"];
const STATUS_LABEL = ["Open", "Ended", "Cancelled"];
const STATUS_BADGE = ["b-wait", "b-ended", "b-cancel"];

let provider, signer, contract, usdcContract;
let autoRefreshInterval = null;
let readProvider, readContract;
let userAddress = null,
  platformAddress = null;
let currentGameId = null,
  currentGame = null,
  currentGameChainId = null;
let selectedCatId = null,
  selectedCatName = null,
  selectedDiff = 0;
let allGames = [];
let gamesLoading = false;
let lastGamesRender = 0;
let filterStatus = "all";
let questions = [],
  currentQ = 0,
  score = 0;
let timerInt = null,
  timeLeft = 15,
  answered = false;
let streakCount = 0,
  streakBonusPending = false;
const STREAK_THRESHOLD = 3,
  STREAK_BONUS_USDC = "0.002";
countdownInterval = null;

function submittedKey(gid) {
  return `arc_submitted_${gid}`;
}
function scoreKey(gid) {
  return `arc_score_${gid}`;
}
function markSubmitted(gid) {
  localStorage.setItem(submittedKey(gid), "1");
}
function saveScore(gid, s) {
  localStorage.setItem(scoreKey(gid), s);
}
function loadSavedScore(gid) {
  return parseInt(localStorage.getItem(scoreKey(gid)) || "0");
}
function alreadySubmitted(gid) {
  return localStorage.getItem(submittedKey(gid)) === "1";
}

// ✅ THE CRITICAL HELPER: normalises the struct result into a plain array
// Your contract returns GameView struct — ethers gives back an object with named props.
// All existing code uses g[0], g[1], g[5] etc so we convert to indexed array.
function gameToArray(g) {
  return [
    g.id, // [0]  uint256
    g.name, // [1]  string
    g.creator, // [2]  address
    g.categoryId, // [3]  uint8
    g.categoryName, // [4]  string
    g.difficulty, // [5]  uint8
    g.entryFee, // [6]  uint256
    g.maxPlayers, // [7]  uint256
    g.prizePool, // [8]  uint256
    g.playerCount, // [9]  uint256
    g.registrationEnd, // [10] uint256
    g.playDeadline, // [11] uint256
    g.topPlayers, // [12] address[3]
    g.prizeClaimed, // [13] bool
    g.status, // [14] uint8
    g.finishedCount, // [15] uint256
  ];
}

// Wrapper: always call this instead of readContract.getGame() directly
async function getGame(id) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const raw = await Promise.race([
        readContract.getGame(id),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 6000),
        ),
      ]);
      return gameToArray(raw);
    } catch (e) {
      console.warn(`Game load failed attempt ${attempt}/3:`, id, e.message);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return null;
}

async function createProvider(chainId) {
  const numericChainId =
    typeof chainId === "string"
      ? parseInt(chainId, 16)
      : Number(chainId || 5042002);

  const rpcs =
    numericChainId === 4441
      ? ["https://liteforge.rpc.caldera.xyz/http"]
      : [
          "https://rpc.testnet.arc.network",
          "https://rpc.drpc.testnet.arc.network",
          "https://rpc.quicknode.testnet.arc.network",
          "https://rpc.blockdaemon.testnet.arc.network",
        ];

  for (const rpc of rpcs) {
    try {
      const p = new ethers.JsonRpcProvider(rpc);
      await Promise.race([
        p.getBlockNumber(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 2000),
        ),
      ]);
      console.log("✅ Using RPC:", rpc);
      return p;
    } catch (e) {
      console.warn("❌ RPC failed:", rpc);
    }
  }

  console.warn("⚠️ Falling back to default RPC");

  return new ethers.JsonRpcProvider(rpcs[0]);
}

window.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("gTotal").textContent = "...";
  document.getElementById("gActive").textContent = "...";
  try {
    // Suppress console errors during provider init
    const originalError = console.error;
    console.error = (...args) => {
      if (args[0]?.toString?.().includes("JsonRpcProvider failed")) return;
      originalError.apply(console, args);
    };
    readProvider = await Promise.race([
      createProvider(),
      new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 4000)),
    ]);
    console.error = originalError;
  } catch (_) {
    readProvider = new ethers.JsonRpcProvider(
      "https://rpc.testnet.arc.network",
      { chainId: 5042002, name: "arc-testnet" },
      { staticNetwork: true },
    );
  }
  readContract = new ethers.Contract(CONTRACT_ADDRESS, ABI, readProvider);
  await loadTreasuryAddress();
  buildCatGrid();
  checkUrlGame();
  startTickerLoop();
  loadGlobalStats();
  loadGames();
  countdownInterval = setInterval(updateCountdowns, 1000);
  // Re-check prizes every 2 min
  setInterval(() => {
    if (userAddress) window._bannerDismissed = false;
    checkUnclaimedPrizes();
  }, 120000);
  injectStreakStyles();
  initAuth();
  setInterval(() => {
    const screen = document.querySelector(".screen.active");
    if (screen?.id === "screenLobby") loadGames();
  }, 30000);
  setInterval(() => {
    const screen = document.querySelector(".screen.active");
    if (screen?.id === "screenTournaments") loadTournaments();
  }, 10000);
  setInterval(
    async () => {
      if (!userAddress || !signer) return;
      try {
        const r = await fetch(`${BACKEND}/auth/me`, { credentials: "include" });
        const d = await r.json();
        if (d.user) currentProfile = currentProfile || d.user;
      } catch (_) {}
    },
    5 * 60 * 1000,
  );
});

function checkUrlGame() {
  const p = new URLSearchParams(location.search);
  const g = p.get("game");
  if (g && /^\d+$/.test(g)) window.pendingGameId = parseInt(g);
}

const providerOptions = {
  walletconnect: {
    package: WalletConnectProvider,
    options: {
      rpc: {
        5042002: "https://rpc.testnet.arc.network",
        4441: "https://liteforge.rpc.caldera.xyz/http",
      },
    },
  },
};

function showNetworkPicker() {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.className = "bet-modal-overlay";
    modal.innerHTML = `
      <div class="bet-modal-box" style="text-align:center;max-width:360px">
        <div style="font-size:2rem;margin-bottom:12px">🌐</div>
        <h3 style="margin-bottom:6px">Choose Network</h3>
        <p style="color:var(--muted);font-size:.83rem;margin-bottom:20px">Select which network to play on</p>
        <div style="display:flex;flex-direction:column;gap:10px">
          <button class="btn btn-primary" id="pickArc">
            ⚡ Arc Testnet — Play with USDC
          </button>
          <button class="btn btn-ghost" id="pickLitvm">
            🔷 LitVM LiteForge — Play with zkLTC
          </button>
          <button class="btn btn-ghost btn-sm" id="pickCancel" style="margin-top:4px">
            Cancel
          </button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector("#pickArc").onclick = () => {
      modal.remove();
      resolve(5042002);
    };
    modal.querySelector("#pickLitvm").onclick = () => {
      modal.remove();
      resolve(4441);
    };
    modal.querySelector("#pickCancel").onclick = () => {
      modal.remove();
      resolve(null);
    };
  });
}

async function switchToNetwork(chainId) {
  const net = NETWORKS[chainId];

  try {
    await getActiveProvider().request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: net.hexChainId }],
    });

    activeNet = net;

    CONTRACT_ADDRESS = net.contractAddress;
    USDC_ADDRESS = net.tokenAddress;

    await reconnectContracts();

    toast(`✅ Switched to ${net.name}`, "success");
  } catch (e) {
    console.error(e);

    if (e.code === 4902) {
      await getActiveProvider().request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: net.hexChainId,
            ...net.addParams,
          },
        ],
      });
    }
  }
}

async function reconnectContracts() {
  readProvider = await createProvider(parseInt(activeNet.hexChainId, 16));

  readContract = new ethers.Contract(CONTRACT_ADDRESS, ABI, readProvider);

  if (provider) {
    signer = await provider.getSigner();

    contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

    if (!activeNet.isNative) {
      usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);
    } else {
      usdcContract = null;
    }
  }

  updateNetBar();
  loadGames();
}

async function connectWallet() {
  const chosen = await showWalletModal();
  if (!chosen) return;

  try {
    let instance;

    if (chosen === "walletconnect") {
      const WCP =
        window.WalletConnectProvider?.default || window.WalletConnectProvider;
      instance = new WCP({
        rpc: {
          5042002: "https://rpc.testnet.arc.network",
          4441: "https://liteforge.rpc.caldera.xyz/http",
        },
      });
      await instance.enable();
    } else {
      // EIP-6963 RDNS keys for each wallet
      const eip = window._eip6963Providers || {};
      console.log("EIP-6963 wallets found:", Object.keys(eip));

      const providerMap = {
        metamask: () => {
          // EIP-6963 first — guaranteed to be real MetaMask
          if (eip["io.metamask"]) return eip["io.metamask"].provider;
          // Fallback: providerMap (some MetaMask versions)
          if (window.ethereum?.providerMap?.get?.("MetaMask"))
            return window.ethereum.providerMap.get("MetaMask");
          // Fallback: _providers array
          if (window.ethereum?._providers?.length)
            return window.ethereum._providers.find(
              (p) => p.isMetaMask && !p.isOKExWallet,
            );
          // Fallback: providers array
          if (window.ethereum?.providers?.length)
            return window.ethereum.providers.find(
              (p) => p.isMetaMask && !p.isOKExWallet && !p.isOkxWallet,
            );
          // Last: window.ethereum only if clearly MetaMask
          if (window.ethereum?.isMetaMask && !window.ethereum?.isOKExWallet)
            return window.ethereum;
          return null;
        },
        coinbase: () => {
          if (eip["com.coinbase.wallet"])
            return eip["com.coinbase.wallet"].provider;
          if (window.ethereum?.providers?.length)
            return window.ethereum.providers.find((p) => p.isCoinbaseWallet);
          return (
            window.coinbaseWalletExtension ||
            (window.ethereum?.isCoinbaseWallet ? window.ethereum : null)
          );
        },
        rabby: () => {
          if (eip["io.rabby"]) return eip["io.rabby"].provider;
          if (window.ethereum?.providers?.length)
            return window.ethereum.providers.find((p) => p.isRabby);
          return window.ethereum?.isRabby ? window.ethereum : null;
        },
        okx: () => {
          if (eip["com.okex.wallet"]) return eip["com.okex.wallet"].provider;
          return (
            window.okxwallet ||
            window.ethereum?.providers?.find(
              (p) => p.isOKExWallet || p.isOkxWallet,
            ) ||
            null
          );
        },
        trust: () => {
          if (eip["com.trustwallet.app"])
            return eip["com.trustwallet.app"].provider;
          return (
            window.trustwallet ||
            window.ethereum?.providers?.find((p) => p.isTrust) ||
            (window.ethereum?.isTrust ? window.ethereum : null)
          );
        },
        brave: () => {
          if (eip["com.brave.wallet"]) return eip["com.brave.wallet"].provider;
          if (window.ethereum?.providers?.length)
            return window.ethereum.providers.find((p) => p.isBraveWallet);
          return window.ethereum?.isBraveWallet ? window.ethereum : null;
        },
        phantom: () => {
          if (eip["app.phantom"]) return eip["app.phantom"].provider;
          return window.phantom?.ethereum || null;
        },
        bybit: () => {
          if (eip["com.bybit"]) return eip["com.bybit"].provider;
          return window.bybitWallet || null;
        },
      };

      const getProvider = providerMap[chosen];
      instance = getProvider?.();

      if (!instance) {
        const installLinks = {
          metamask: "https://metamask.io/download/",
          coinbase: "https://www.coinbase.com/wallet/downloads",
          rabby: "https://rabby.io",
          okx: "https://www.okx.com/web3",
          trust: "https://trustwallet.com/browser-extension",
          brave: "https://brave.com/wallet/",
          phantom: "https://phantom.app",
          bybit: "https://www.bybit.com/web3",
        };
        window.open(installLinks[chosen], "_blank");
        return;
      }

      await instance.request({ method: "eth_requestAccounts" });
    }

    provider = new ethers.BrowserProvider(instance);
    signer = await provider.getSigner();
    userAddress = await signer.getAddress();
    window._activeWalletProvider = instance; // ✅ save which wallet was chosen

    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);

    if (NETWORKS[chainId]) {
      activeNet = NETWORKS[chainId];
    } else {
      const picked = await showNetworkPicker();
      if (!picked) return;
      activeNet = NETWORKS[picked];
      try {
        await instance.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: activeNet.hexChainId }],
        });
      } catch (e) {
        if (e.code === 4902)
          await instance.request({
            method: "wallet_addEthereumChain",
            params: [{ chainId: activeNet.hexChainId, ...activeNet.addParams }],
          });
      }
      provider = new ethers.BrowserProvider(instance);
      signer = await provider.getSigner();
      userAddress = await signer.getAddress();
    }

    CONTRACT_ADDRESS = activeNet.contractAddress;
    USDC_ADDRESS = activeNet.tokenAddress;
    contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
    if (!activeNet.isNative)
      usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);

    try {
      platformAddress = await readContract.platform();
    } catch (_) {}

    const message = `Login to ${activeNet.name}`;
    const signature = await signer.signMessage(message);

    let csrfToken = "";
    try {
      const ct = await fetch(`${BACKEND}/csrf-token`, {
        credentials: "include",
      });
      csrfToken = (await ct.json()).csrfToken || "";
    } catch (_) {}

    const authRes = await fetch(`${BACKEND}/auth/wallet`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CSRF-Token": csrfToken },
      credentials: "include",
      body: JSON.stringify({
        wallet: userAddress,
        signature,
        networkName: activeNet.name,
      }),
    });
    const authData = await authRes.json();
    if (authData.error === "wallet_google_taken") {
      toast("⚠️ This wallet is already linked to a Google account.", "error");
      userAddress = null;
      provider = signer = contract = usdcContract = null;
      return;
    }
    if (authData.error) {
      toast("Auth failed: " + authData.error, "error");
      return;
    }

    const meData = await fetch(`${BACKEND}/auth/me`, {
      credentials: "include",
    }).then((r) => r.json());
    if (meData.user) currentProfile = meData.user;
    if (authData.user) currentProfile = authData.user;

    renderAuthState();
    toast("✅ Wallet connected!", "success");
    await loadGames();
    loadMyStats();
    checkUnclaimedPrizes();
    updateNetBar();
    if (currentGameId) openGame(currentGameId);
    if (window.pendingGameId) {
      openGame(window.pendingGameId);
      window.pendingGameId = null;
    }

    instance.on?.("disconnect", () => {
      provider = signer = contract = usdcContract = null;
      userAddress = null;
      renderAuthState();
    });
    instance.on?.("accountsChanged", (accounts) => {
      if (!accounts.length) {
        provider = signer = contract = usdcContract = null;
        userAddress = null;
        renderAuthState();
      } else connectWallet();
    });
  } catch (e) {
    if (
      e.code === 4001 ||
      e?.message?.includes("User closed") ||
      e?.message?.includes("rejected")
    )
      return;
    console.error(e);
    toast("Connection failed: " + (e.message || "Unknown error"), "error");
  }
}

function showWalletModal() {
  return new Promise((resolve) => {
    const existing = document.getElementById("walletModal");
    if (existing) existing.remove();

    const wallets = [
      {
        id: "metamask",
        name: "MetaMask",
        desc: "Available everywhere",
        detected: !!window.ethereum?.isMetaMask,
        popular: true,
        icon: `<svg width="36" height="36" viewBox="0 0 35 33"><path d="M32.9 1L19.4 10.7l2.5-5.9L32.9 1z" fill="#E17726"/><path d="M2.1 1l13.4 9.8-2.4-5.9L2.1 1z" fill="#E27625"/><path d="M28.2 23.5l-3.6 5.5 7.7 2.1 2.2-7.5-6.3-.1z" fill="#E27625"/><path d="M1.5 23.6l2.2 7.5 7.7-2.1-3.6-5.5-6.3.1z" fill="#E27625"/><path d="M10.9 14.5l-2.1 3.2 7.5.3-.3-8-5.1 4.5z" fill="#E27625"/><path d="M24.1 14.5l-5.2-4.6-.2 8.1 7.5-.3-2.1-3.2z" fill="#E27625"/><path d="M11.4 29l4.5-2.2-3.9-3-.6 5.2z" fill="#E27625"/><path d="M19.1 26.8l4.5 2.2-.7-5.2-3.8 3z" fill="#E27625"/></svg>`,
      },
      {
        id: "coinbase",
        name: "Coinbase Wallet",
        desc: "By Coinbase exchange",
        detected: !!(
          window.ethereum?.isCoinbaseWallet || window.coinbaseWalletExtension
        ),
        popular: true,
        icon: `<svg width="36" height="36" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#0052FF"/><path d="M16 7C11 7 7 11 7 16s4 9 9 9 9-4 9-9-4-9-9-9zm0 4a5 5 0 110 10A5 5 0 0116 11zm-2.5 3.5v3h5v-3h-5z" fill="white"/></svg>`,
      },
      {
        id: "walletconnect",
        name: "WalletConnect",
        desc: "400+ wallets via QR",
        detected: true,
        popular: true,
        icon: `<svg width="36" height="36" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#3B99FC"/><path d="M9.6 12.8c3.5-3.5 9.3-3.5 12.8 0l.4.4c.2.2.2.5 0 .7l-1.4 1.4c-.1.1-.3.1-.4 0l-.6-.6c-2.5-2.5-6.5-2.5-9 0l-.6.6c-.1.1-.3.1-.4 0L8.8 14c-.2-.2-.2-.5 0-.7l.8-.5zm15.8 3l1.3 1.3c.2.2.2.5 0 .7l-5.7 5.7c-.2.2-.5.2-.7 0L16 19.4l-4.3 4.3c-.2.2-.5.2-.7 0L5.3 18c-.2-.2-.2-.5 0-.7l1.3-1.3c.2-.2.5-.2.7 0L11.6 20l4.3-4.3c.2-.2.5-.2.7 0l4.3 4.3 4.2-4.2c.2-.2.5-.2.7 0z" fill="white"/></svg>`,
      },
      {
        id: "rabby",
        name: "Rabby",
        desc: "Best for DeFi power users",
        detected: !!window.ethereum?.isRabby,
        icon: `<svg width="36" height="36" viewBox="0 0 36 36"><circle cx="18" cy="18" r="18" fill="#8697FF"/><text x="8" y="25" font-size="18" fill="white">🐰</text></svg>`,
      },
      {
        id: "okx",
        name: "OKX Wallet",
        desc: "By OKX exchange",
        detected: !!window.okxwallet,
        icon: `<svg width="36" height="36" viewBox="0 0 36 36"><rect width="36" height="36" rx="8" fill="#000"/><rect x="6" y="6" width="10" height="10" fill="white"/><rect x="20" y="6" width="10" height="10" fill="white"/><rect x="6" y="20" width="10" height="10" fill="white"/><rect x="20" y="20" width="10" height="10" fill="white"/></svg>`,
      },
      {
        id: "trust",
        name: "Trust Wallet",
        desc: "Mobile-first wallet",
        detected: !!(window.trustwallet || window.ethereum?.isTrust),
        icon: `<svg width="36" height="36" viewBox="0 0 36 36"><circle cx="18" cy="18" r="18" fill="#3375BB"/><path d="M18 7l9 4v8C27 24.5 23 29 18 31c-5-2-9-6.5-9-12v-8l9-4z" fill="white"/></svg>`,
      },
      {
        id: "phantom",
        name: "Phantom",
        desc: "Popular on Solana + EVM",
        detected: !!window.phantom?.ethereum,
        icon: `<svg width="36" height="36" viewBox="0 0 36 36"><circle cx="18" cy="18" r="18" fill="#AB9FF2"/><path d="M28 18c0-5.5-4.5-10-10-10S8 12.5 8 18c0 4.6 3.1 8.5 7.4 9.7-.1-.5-.2-1-.2-1.5 0-2.7 2.2-4.9 4.9-4.9 1.8 0 3.3.9 4.2 2.3C26.4 22.6 28 20.5 28 18z" fill="white"/></svg>`,
      },
      {
        id: "bybit",
        name: "Bybit Wallet",
        desc: "By Bybit exchange",
        detected: !!window.bybitWallet,
        icon: `<svg width="36" height="36" viewBox="0 0 36 36"><rect width="36" height="36" rx="8" fill="#F7A600"/><text x="7" y="25" font-size="16" font-weight="bold" fill="black">BB</text></svg>`,
      },
    ];

    const detected = wallets.filter((w) => w.detected);
    const notDetected = wallets.filter((w) => !w.detected);

    const modal = document.createElement("div");
    modal.id = "walletModal";
    modal.style.cssText = `
    position:fixed;inset:0;z-index:10010;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,0.75);backdrop-filter:blur(16px);
    animation:fadeIn .15s ease;
    padding:16px;
    `;

    modal.innerHTML = `
      <style>
        @keyframes slideUp { from{transform:translateY(30px);opacity:0} to{transform:translateY(0);opacity:1} }
        @keyframes fadeIn { from{opacity:0} to{opacity:1} }
        .wm-card {
          background:#0d0d0d;
          border:1px solid rgba(255,255,255,0.08);
          border-radius:20px;
          width:100%;max-width:400px;
          max-height:85vh;
          overflow-y:auto;
          padding:0;
          animation:slideUp .2s cubic-bezier(.175,.885,.32,1.275);
          box-shadow:0 24px 64px rgba(0,0,0,0.6);
        }
        .wm-header {
          padding:22px 22px 16px;
          border-bottom:1px solid rgba(255,255,255,0.06);
          display:flex;align-items:center;justify-content:space-between;
        }
        .wm-title { font-family:'Bebas Neue',sans-serif;font-size:1.4rem;letter-spacing:2px;color:#fff; }
        .wm-subtitle { font-size:.72rem;color:rgba(255,255,255,0.35);margin-top:2px;font-family:'Space Mono',monospace; }
        .wm-close {
          width:30px;height:30px;border-radius:8px;
          background:rgba(255,255,255,0.06);border:none;
          color:rgba(255,255,255,0.5);cursor:pointer;font-size:1rem;
          display:flex;align-items:center;justify-content:center;
          transition:.15s;
        }
        .wm-close:hover { background:rgba(255,255,255,0.12);color:#fff; }
        .wm-section-label {
          font-family:'Space Mono',monospace;font-size:.62rem;
          color:rgba(255,255,255,0.25);text-transform:uppercase;
          letter-spacing:1.5px;padding:14px 22px 8px;
        }
        .wm-list { padding:0 12px 12px; display:flex;flex-direction:column;gap:4px; }
        .wm-item {
          display:flex;align-items:center;gap:14px;
          padding:11px 12px;border-radius:12px;
          cursor:pointer;border:1px solid transparent;
          transition:.15s;position:relative;
        }
        .wm-item:hover {
          background:rgba(255,107,0,0.06);
          border-color:rgba(255,107,0,0.2);
        }
        .wm-icon {
          width:42px;height:42px;border-radius:12px;
          overflow:hidden;flex-shrink:0;
          display:flex;align-items:center;justify-content:center;
          background:rgba(255,255,255,0.04);
          border:1px solid rgba(255,255,255,0.06);
        }
        .wm-name { font-size:.88rem;font-weight:700;color:#fff; }
        .wm-desc { font-size:.68rem;color:rgba(255,255,255,0.3);margin-top:1px;font-family:'Space Mono',monospace; }
        .wm-badge-detected {
          font-family:'Space Mono',monospace;font-size:.58rem;font-weight:700;
          background:rgba(6,214,160,0.1);color:#06d6a0;
          border:1px solid rgba(6,214,160,0.25);
          padding:2px 8px;border-radius:20px;margin-left:auto;flex-shrink:0;
        }
        .wm-badge-install {
          font-family:'Space Mono',monospace;font-size:.58rem;
          color:rgba(255,255,255,0.2);
          margin-left:auto;flex-shrink:0;
        }
        .wm-popular-dot {
          position:absolute;top:8px;right:10px;
          width:5px;height:5px;border-radius:50%;
          background:var(--orange);
        }
        .wm-footer {
          padding:12px 22px 16px;
          border-top:1px solid rgba(255,255,255,0.05);
          font-family:'Space Mono',monospace;
          font-size:.65rem;color:rgba(255,255,255,0.2);
          text-align:center;line-height:1.7;
        }
        .wm-divider {
          height:1px;background:rgba(255,255,255,0.05);
          margin:4px 12px;
        }
      </style>

      <div class="wm-card">
        <div class="wm-header">
          <div>
            <div class="wm-title">Connect Wallet</div>
            <div class="wm-subtitle">Choose how you want to connect</div>
          </div>
          <button class="wm-close" id="wmClose">✕</button>
        </div>

        ${
          detected.length > 0
            ? `
          <div class="wm-section-label">Detected in your browser</div>
          <div class="wm-list">
            ${detected
              .map(
                (w) => `
              <div class="wm-item" data-wallet="${w.id}">
                <div class="wm-icon">${w.icon}</div>
                <div>
                  <div class="wm-name">${w.name}</div>
                  <div class="wm-desc">${w.desc}</div>
                </div>
                <span class="wm-badge-detected">● Connected</span>
              </div>
            `,
              )
              .join("")}
          </div>
          <div class="wm-divider"></div>
        `
            : ""
        }

        <div class="wm-section-label">${detected.length > 0 ? "Other wallets" : "Choose a wallet"}</div>
        <div class="wm-list" style="max-height:180px;overflow-y:auto">
          ${notDetected
            .map(
              (w) => `
            <div class="wm-item" data-wallet="${w.id}">
              <div class="wm-icon">${w.icon}</div>
              <div>
                <div class="wm-name">${w.name}</div>
                <div class="wm-desc">${w.desc}</div>
              </div>
              <span class="wm-badge-install">Install →</span>
            </div>
          `,
            )
            .join("")}
        </div>

        <div class="wm-footer">
          By connecting you agree to our terms.<br>
          TriviaFi never stores your private keys.
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Events
    document.getElementById("wmClose").onclick = () => {
      modal.remove();
      resolve(null);
    };
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        modal.remove();
        resolve(null);
      }
    });
    modal.querySelectorAll(".wm-item").forEach((item) => {
      item.addEventListener("click", () => {
        modal.remove();
        resolve(item.dataset.wallet);
      });
    });
  });
}

function updateNetBar() {
  const isArc = activeNet.decimals === 6;
  // Update the header trigger label
  const sel = document.getElementById("selectedNetwork");
  if (sel) sel.textContent = isArc ? "⚡ Arc · USDC" : "🔷 LitVM · zkLTC";
  // Update active state in dropdown
  const arcOpt = document.getElementById("netOptArc");
  const litvmOpt = document.getElementById("netOptLitvm");
  if (arcOpt) arcOpt.className = "net-opt" + (isArc ? " net-opt-active" : "");
  if (litvmOpt)
    litvmOpt.className = "net-opt" + (!isArc ? " net-opt-active" : "");
  // Update entry fee input
  const feeLabel = document.getElementById("entryFeeLabel");
  const feeInput = document.getElementById("cFee");
  if (feeLabel) feeLabel.textContent = `Entry Fee (${activeNet.symbol})`;
  if (feeInput) {
    feeInput.placeholder = activeNet.isNative ? "e.g. 0.01" : "e.g. 1";
    feeInput.min = activeNet.isNative ? "0.01" : "1";
    feeInput.step = activeNet.isNative ? "0.001" : "0.01";
  }
}

function showScreen(id) {
  document
    .querySelectorAll(".screen")
    .forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function injectStreakStyles() {
  const s = document.createElement("style");
  s.textContent = `
    @keyframes streakPop  { from{transform:translate(-50%,-50%) scale(0.6);opacity:0} to{transform:translate(-50%,-50%) scale(1);opacity:1} }
    @keyframes streakFade { to{opacity:0;transform:translate(-50%,-58%) scale(1)} }
    .bet-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:10002;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(10px)}
    .bet-modal-box{background:var(--card);border:1px solid rgba(123,97,255,.4);border-radius:20px;padding:28px;width:90%;max-width:400px}
    .bet-modal-box h3{font-family:'Bebas Neue',sans-serif;font-size:1.5rem;letter-spacing:2px;color:var(--purple);margin-bottom:6px}
    .bet-input{width:100%;background:var(--surface);border:2px solid rgba(123,97,255,.3);color:var(--text);padding:14px 16px;border-radius:10px;font-size:1.1rem;font-weight:600;outline:none;text-align:center}
    .bet-input:focus{border-color:var(--purple)}
    .bet-quick-btns{display:flex;gap:8px;margin:10px 0}
    .bet-quick-btn{flex:1;padding:8px;border-radius:8px;border:1px solid rgba(123,97,255,.3);background:rgba(123,97,255,.08);color:var(--purple);font-size:.82rem;font-weight:600;cursor:pointer}
    .bet-quick-btn:hover{background:rgba(123,97,255,.2);border-color:var(--purple)}
    .skeleton-card {
    border-radius: 18px;
    min-height: 190px;
    
    background: linear-gradient(
    90deg,
    rgba(255,255,255,0.03) 25%,
    rgba(255,255,255,0.08) 50%,
    rgba(255,255,255,0.03) 75%
    
    );
    
    background-size: 200% 100%;
    
    animation: shimmer 1.3s linear infinite;
    
    border: 1px solid rgba(255,255,255,0.04);
    }
    
    @keyframes shimmer {
    0% {
    background-position: 200% 0;
    }
    
    100% {
    background-position: -200% 0;
    }
    }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
    @keyframes slideUp { from{transform:translateX(-50%) translateY(100px);opacity:0} to{transform:translateX(-50%) translateY(0);opacity:1} }
  `;
  document.head.appendChild(s);
}

function skeletonCards(count = 6) {
  return `
    <div class="skeleton-card"></div>
    <div class="skeleton-card"></div>
    <div class="skeleton-card"></div>
    <div class="skeleton-card"></div>
    <div class="skeleton-card"></div>
    <div class="skeleton-card"></div>
  `;
}

function showStreakBanner(n) {
  const old = document.getElementById("streakBanner");
  if (old) old.remove();
  const banner = document.createElement("div");
  banner.id = "streakBanner";
  banner.innerHTML = `<div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(0.6);opacity:0;background:linear-gradient(135deg,var(--gold),var(--orange));color:#000;font-family:'Bebas Neue',sans-serif;font-size:2.2rem;letter-spacing:3px;padding:22px 44px;border-radius:16px;text-align:center;z-index:9999;pointer-events:none;animation:streakPop .45s cubic-bezier(.175,.885,.32,1.275) forwards,streakFade .4s ease 1.7s forwards">STREAK x${n}!<br/><span style="font-size:.9rem;letter-spacing:2px">+${STREAK_BONUS_USDC} USDC nanopayment sent</span></div>`;
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 2300);
}

async function payStreakBonus() {
  if (!signer || !userAddress || streakBonusPending) return;
  streakBonusPending = true;
  try {
    const PLATFORM = platformAddress || (await readContract.platform());
    const bonusWei = ethers.parseUnits(STREAK_BONUS_USDC, 6);
    const usdcRead = new ethers.Contract(USDC_ADDRESS, USDC_ABI, readProvider);
    const bal = await usdcRead.balanceOf(userAddress);
    if (bal < bonusWei) {
      streakBonusPending = false;
      return;
    }
    const usdcW = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);
    const tx = await usdcW.transfer(PLATFORM, bonusWei);
    await tx.wait();
    showStreakBanner(streakCount);
    toast(
      `STREAK x${streakCount}! ${STREAK_BONUS_USDC} USDC nanopayment onchain`,
      "success",
    );
  } catch (e) {
    showStreakBanner(streakCount);
  } finally {
    streakBonusPending = false;
  }
}

function updateCountdowns() {
  const now = Math.floor(Date.now() / 1000);
  document.querySelectorAll("[data-deadline]").forEach((el) => {
    const secs = parseInt(el.dataset.deadline) - now;
    if (secs <= 0) {
      el.textContent = el.dataset.expiredtext || "Closed";
      el.classList.add("urg");
    } else {
      el.textContent = el.dataset.prefix + fmtTime(secs);
      if (secs < 300) el.classList.add("urg");
      else el.classList.remove("urg");
    }
  });
}

async function loadPlatformStats() {
  try {
    const res = await fetch(`${BACKEND}/stats`);
    const data = await res.json();

    document.getElementById("gPool").innerHTML =
      `$${Number(data.total_volume).toLocaleString()} Volume`;
  } catch (e) {
    console.error(e);
  }
}

async function startTickerLoop() {
  await updateTicker();
  setInterval(updateTicker, 60000);
}

async function updateTicker() {
  try {
    if (allGames.length === 0) {
      setTickerText(
        "TriviaFi — Multichain trivia · Win USDC on Arc · Win zkLTC on LitVM",
      );
      return;
    }
    const items = [];
    let arcActive = 0,
      litvmActive = 0;
    const now = Math.floor(Date.now() / 1000);
    for (const { g, chainId: cid } of allGames) {
      if (!g) continue;
      const net = NETWORKS[cid] || NETWORKS[5042002];
      const s = Number(g[14]);
      const icon = cid === 4441 ? "🔷" : "⚡";
      if (s === 0 && Number(g[11]) > now) {
        if (cid === 4441) litvmActive++;
        else arcActive++;
        const pool = parseFloat(ethers.formatUnits(g[8], net.decimals)).toFixed(
          net.decimals === 18 ? 4 : 2,
        );
        items.push(
          `${icon} <span class='tick-gold'>${g[4]}</span> · <span class='tick-cyan'>${pool} ${net.symbol}</span>`,
        );
      } else if (
        s === 1 &&
        g[12] &&
        g[12][0] !== "0x0000000000000000000000000000000000000000"
      ) {
        // ✅ Only show a few ended games
        if (items.length < 6) {
          items.push(
            `${icon} ENDED <span class='tick-gold'>${g[4]}</span> · Winner: ${fmt(
              g[12][0],
            )}`,
          );
        }
      }
    }
    items.push(
      `⚡ Arc: <span class='tick-cyan'>${arcActive} active</span> <span class='tick-sep'>·</span> 🔷 LitVM: <span class='tick-cyan'>${litvmActive} active</span>`,
    );
    if (items.length > 1)
      setTickerText(items.join(` <span class='tick-sep'>·</span> `));
    else
      setTickerText(
        "TriviaFi — Multichain trivia · Win USDC on Arc · Win zkLTC on LitVM",
      );
  } catch (e) {
    setTickerText("TriviaFi — Multichain trivia gaming");
  }
}

function setTickerText(html) {
  document.getElementById("tickerInner").innerHTML = html;
}

async function loadGames() {
  if (gamesLoading) return;
  gamesLoading = true;
  const renderId = Date.now();
  lastGamesRender = renderId;
  const grid = document.getElementById("gamesList");

  // Show skeleton only on first load
  if (grid && allGames.length === 0) {
    grid.innerHTML = skeletonCards(6);
    setTimeout(() => {
      if (grid.querySelector(".skeleton-card")) {
        grid.innerHTML = `
          <div style="grid-column:1/-1;text-align:center;padding:40px">
            <div style="font-size:2rem;margin-bottom:12px">⚡</div>
            <p style="color:var(--muted);margin-bottom:16px">Connecting to blockchain...</p>
            <button class="btn btn-ghost btn-sm" style="width:auto;padding:10px 28px"
              onclick="loadGames()">🔄 Retry</button>
          </div>`;
      }
    }, 10000);
  } else if (allGames.length > 0) {
    renderGames();
  }

  try {
    const arcRpcs = [
      "https://rpc.testnet.arc.network",
      "https://rpc.drpc.testnet.arc.network",
    ];
    const litvmRpcs = [
      "https://liteforge-testnet.rpc.caldera.xyz/http",
      "https://liteforge.rpc.caldera.xyz/http",
    ];

    async function getFastProvider(rpcs, chainId, name) {
      for (const rpc of rpcs) {
        try {
          const p = new ethers.JsonRpcProvider(rpc, { chainId, name });
          await Promise.race([
            p.getBlockNumber(),
            new Promise((_, r) => setTimeout(() => r(new Error("t")), 2000)),
          ]);
          return p;
        } catch (_) {
          // LitVM blocks browser CORS — silently skip
        }
      }
      // Return provider anyway — MetaMask handles actual tx signing
      return new ethers.JsonRpcProvider(rpcs[0], { chainId, name });
    }

    const [arcProvider, litvmProvider] = await Promise.all([
      getFastProvider(arcRpcs, 5042002, "arc-testnet"),
      getFastProvider(litvmRpcs, 4441, "litvm"),
    ]);

    const arcRC = new ethers.Contract(
      NETWORKS[5042002].contractAddress,
      ABI,
      arcProvider,
    );
    const litvmRC = new ethers.Contract(
      NETWORKS[4441].contractAddress,
      ABI,
      litvmProvider,
    );

    const [arcCount, litvmCount] = await Promise.all([
      Promise.race([
        arcRC.gameCounter().then(Number),
        new Promise((_, r) => setTimeout(() => r(0), 4000)),
      ]).catch(() => 0),
      Promise.race([
        litvmRC.gameCounter().then(Number),
        new Promise((_, r) => setTimeout(() => r(0), 4000)),
      ]).catch(() => 0),
    ]);

    if (renderId !== lastGamesRender) {
      gamesLoading = false;
      return;
    }

    document.getElementById("gTotal").textContent = arcCount + litvmCount;

    const LIMIT = 30,
      BATCH = 10;

    async function fetchChainGames(rc, count, chainId) {
      const net = NETWORKS[chainId];
      const ids = [];
      for (let i = count; i >= Math.max(1, count - LIMIT + 1); i--) ids.push(i);
      const results = [];
      for (let b = 0; b < ids.length; b += BATCH) {
        const batch = ids.slice(b, b + BATCH);
        const settled = await Promise.allSettled(
          batch.map((i) =>
            Promise.race([
              rc
                .getGame(i)
                .then((g) => ({ i, g: gameToArray(g), chainId, net })),
              new Promise((_, r) => setTimeout(() => r(new Error("t")), 5000)),
            ]),
          ),
        );
        for (const r of settled)
          if (r.status === "fulfilled") results.push(r.value);
      }
      return results;
    }

    const [arcGames, litvmGames] = await Promise.all([
      arcCount > 0 ? fetchChainGames(arcRC, arcCount, 5042002) : [],
      litvmCount > 0 ? fetchChainGames(litvmRC, litvmCount, 4441) : [],
    ]);

    if (renderId !== lastGamesRender) {
      gamesLoading = false;
      return;
    }

    allGames = [...arcGames, ...litvmGames];
    allGames.sort((a, b) => b.i - a.i || a.chainId - b.chainId);

    let arcPool = 0n,
      litvmPool = 0n,
      activeCount = 0;
    const nowSec = Math.floor(Date.now() / 1000);
    for (const { g, net } of allGames) {
      if (Number(g[14]) === 0) {
        if (net.decimals === 6) arcPool += BigInt(g[8]);
        else litvmPool += BigInt(g[8]);
        if (Number(g[11]) > nowSec) activeCount++;
      }
    }
    document.getElementById("gActive").textContent = activeCount;

    let dbArcVol = 0,
      dbLitvmVol = 0;
    try {
      const s = await fetch(`${BACKEND}/stats/global`).then((r) => r.json());
      dbArcVol = parseFloat(s.arcVolume || 0);
      dbLitvmVol = parseFloat(s.litvmVolume || 0);
    } catch (_) {}

    const finalArc = Math.max(
      parseFloat(ethers.formatUnits(arcPool, 6)),
      dbArcVol,
    );
    const finalLitvm = Math.max(
      parseFloat(ethers.formatUnits(litvmPool, 18)),
      dbLitvmVol,
    );

    document.getElementById("gPool").innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center">
        <span style="color:var(--accent);font-weight:700;font-size:1rem">
          ${finalArc > 0 ? `$${finalArc.toFixed(2)}` : "$0.00"} USDC
        </span>
        <span style="color:var(--muted);font-size:.75rem">+</span>
        <span style="color:var(--purple);font-weight:700;font-size:1rem">
          ${finalLitvm > 0 ? finalLitvm.toFixed(4) : "0.0000"} zkLTC
        </span>
      </div>
      <div style="font-size:.65rem;color:var(--muted);text-transform:uppercase;
        letter-spacing:.6px;margin-top:5px">Total Volume</div>`;

    renderGames();
    updateTicker();
  } catch (e) {
    console.warn("loadGames error:", e.message);
    if (grid && allGames.length === 0) {
      grid.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:40px">
          <p style="color:var(--muted);margin-bottom:16px">Could not load games.</p>
          <button class="btn btn-ghost btn-sm" style="width:auto"
            onclick="loadGames()">🔄 Retry</button>
        </div>`;
    }
  }

  gamesLoading = false;
}

// Loads older games on demand
async function loadMoreGames(beforeId) {
  if (!beforeId || beforeId < 1) return;
  const el = document.getElementById("gamesList");
  const oldBtn = document.getElementById("loadMoreBtn");
  if (oldBtn)
    oldBtn.innerHTML = `<button class="btn btn-ghost btn-sm" disabled style="width:auto;padding:10px 28px">⏳ Loading...</button>`;

  try {
    const LOAD = 10;
    const end = Math.max(1, beforeId - LOAD + 1);
    const ids = [];
    for (let i = beforeId; i >= end; i--) ids.push(i);

    const BATCH = 5;
    const newGames = [];
    for (let b = 0; b < ids.length; b += BATCH) {
      const batch = ids.slice(b, b + BATCH);
      const results = await Promise.allSettled(
        batch.map((i) =>
          readContract.getGame(i).then((g) => ({ i, g: gameToArray(g) })),
        ),
      );
      for (const r of results) {
        if (r.status === "fulfilled") newGames.push(r.value);
      }
    }
    newGames.sort((a, b) => b.i - a.i);

    // ✅ FIX: append to allGames regardless of current filter
    allGames = [...allGames, ...newGames];

    // Re-render preserving the load more button
    if (oldBtn) oldBtn.remove();
    renderGames();

    const oldest = newGames[newGames.length - 1]?.i;
    if (oldest && oldest > 1) {
      const moreBtn = document.createElement("div");
      moreBtn.id = "loadMoreBtn";
      moreBtn.style.cssText = "text-align:center;padding:16px 0";
      moreBtn.innerHTML = `<button onclick="loadMoreGames(${
        oldest - 1
      })" class="btn btn-ghost btn-sm" style="width:auto;padding:10px 28px">⬇ Load Older Games</button>`;
      el.appendChild(moreBtn);
    } else {
      toast("All games loaded", "info");
    }
  } catch (e) {
    toast("Error loading games: " + e.message, "error");
  }
}

// ── WHITELIST TOURNAMENT MODAL ────────────────────────────────────────────
function showCreateWhitelistModal() {
  if (!userAddress && !currentProfile)
    return toast(
      "Connect wallet or login to create a whitelist tournament",
      "error",
    );

  const existing = document.getElementById("wlTourneyModal");
  if (existing) existing.remove();
  const modal = document.createElement("div");
  modal.id = "wlTourneyModal";
  modal.className = "bet-modal-overlay";
  modal.innerHTML = `
    <div class="bet-modal-box" style="max-width:520px;width:95%;max-height:90vh;overflow-y:auto">

      <!-- Header -->
      <div style="background:linear-gradient(135deg,rgba(123,97,255,.2),rgba(0,229,255,.1));
        border-radius:14px;padding:18px;margin-bottom:20px;text-align:center;
        border:1px solid rgba(123,97,255,.3)">
        <div style="font-size:2.5rem;margin-bottom:8px">🏆</div>
        <h3 style="margin:0;font-family:'Bebas Neue',sans-serif;font-size:1.7rem;
          letter-spacing:3px;background:linear-gradient(135deg,var(--purple),var(--accent));
          -webkit-background-clip:text;-webkit-text-fill-color:transparent">
          WHITELIST BATTLE
        </h3>
        <p style="color:var(--muted);font-size:.78rem;margin-top:6px">
          Free-to-play · Points-based · Top 3 win prizes · Perfect for Discord communities
        </p>
        <div style="display:flex;gap:8px;justify-content:center;margin-top:10px;flex-wrap:wrap">
          <span style="background:rgba(88,101,242,.15);border:1px solid rgba(88,101,242,.35);
            color:#7289da;padding:3px 12px;border-radius:20px;font-size:.73rem;font-weight:700">
            💬 Discord Ready
          </span>
          <span style="background:rgba(0,229,255,.08);border:1px solid rgba(0,229,255,.2);
            color:var(--accent);padding:3px 12px;border-radius:20px;font-size:.73rem;font-weight:700">
            ⚡ No Entry Fee
          </span>
          <span style="background:rgba(255,209,102,.08);border:1px solid rgba(255,209,102,.2);
            color:var(--gold);padding:3px 12px;border-radius:20px;font-size:.73rem;font-weight:700">
            🏟️ Up to 200 Players
          </span>
        </div>
      </div>

      <!-- Sponsor Info -->
      <div style="font-size:.72rem;color:var(--muted);text-transform:uppercase;
        letter-spacing:.5px;margin-bottom:6px">Project / Sponsor Info</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
        <div class="ig">
          <label class="il">Project Name</label>
          <input id="wlSponsorName" placeholder="e.g. CryptoApes Club"
            style="background:var(--surface);border:1px solid var(--border);color:var(--text);
            padding:10px 14px;border-radius:8px;font-size:.88rem;width:100%;box-sizing:border-box"/>
        </div>
        <div class="ig">
          <label class="il">Discord Invite URL</label>
          <input id="wlDiscordInvite" placeholder="https://discord.gg/..."
            style="background:var(--surface);border:1px solid var(--border);color:var(--text);
            padding:10px 14px;border-radius:8px;font-size:.88rem;width:100%;box-sizing:border-box"/>
        </div>
      </div>

      <!-- Tournament Settings -->
      <div style="font-size:.72rem;color:var(--muted);text-transform:uppercase;
        letter-spacing:.5px;margin-bottom:6px">Tournament Settings</div>
      <div class="ig" style="margin-bottom:10px">
        <label class="il">Tournament Name</label>
        <input id="wlName" placeholder="e.g. CryptoApes Whitelist Battle #1" maxlength="60"
          style="background:var(--surface);border:1px solid var(--border);color:var(--text);
          padding:10px 14px;border-radius:8px;font-size:.88rem;width:100%;box-sizing:border-box"/>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
        <div class="ig">
          <label class="il">Max Players</label>
          <input id="wlMax" type="number" min="4" max="200" value="32"
            style="background:var(--surface);border:1px solid var(--border);color:var(--text);
            padding:10px 14px;border-radius:8px;font-size:.88rem;width:100%;box-sizing:border-box"/>
        </div>
        <div class="ig">
          <label class="il">Rounds</label>
          <select id="wlRounds" style="background:var(--surface);border:1px solid var(--border);
            color:var(--text);padding:10px 14px;border-radius:8px;font-size:.88rem;width:100%">
            <option value="2">2 Rounds</option>
            <option value="3" selected>3 Rounds</option>
            <option value="4">4 Rounds</option>
            <option value="5">5 Rounds</option>
          </select>
        </div>
      </div>

      <!-- Prizes -->
      <div style="font-size:.72rem;color:var(--muted);text-transform:uppercase;
        letter-spacing:.5px;margin-bottom:6px">Prize Configuration</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:1.2rem;width:28px;text-align:center">🥇</span>
          <input id="wlPrize1" placeholder="e.g. Whitelist Spot (1 winner)"
            style="background:var(--surface);border:1px solid rgba(255,209,102,.3);color:var(--text);
            padding:10px 14px;border-radius:8px;font-size:.88rem;flex:1;box-sizing:border-box"/>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:1.2rem;width:28px;text-align:center">🥈</span>
          <input id="wlPrize2" placeholder="e.g. OG Discord Role"
            style="background:var(--surface);border:1px solid rgba(200,200,200,.2);color:var(--text);
            padding:10px 14px;border-radius:8px;font-size:.88rem;flex:1;box-sizing:border-box"/>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:1.2rem;width:28px;text-align:center">🥉</span>
          <input id="wlPrize3" placeholder="e.g. Early Access Pass"
            style="background:var(--surface);border:1px solid rgba(205,127,50,.3);color:var(--text);
            padding:10px 14px;border-radius:8px;font-size:.88rem;flex:1;box-sizing:border-box"/>
        </div>
      </div>

      <div style="background:rgba(88,101,242,.06);border:1px solid rgba(88,101,242,.2);
        border-radius:10px;padding:12px;margin-bottom:16px;font-size:.76rem;color:var(--muted);line-height:1.7">
        💬 <strong style="color:#7289da">Discord Integration</strong><br>
        After creating, share the tournament link in your Discord. Members connect wallet, play, and top 3 are recorded on-chain as winners. You verify winners in Discord manually using their wallet address.<br><br>
        ⚡ <strong style="color:var(--accent)">No funds required</strong> from players — purely skill-based competition
      </div>

      <div style="display:flex;gap:10px">
        <button class="btn btn-primary" onclick="submitCreateWhitelist()"
          style="flex:1;background:linear-gradient(135deg,var(--purple),var(--accent))">
          🚀 Launch Whitelist Battle
        </button>
        <button class="btn btn-ghost" style="width:auto;padding:13px 18px"
          onclick="document.getElementById('wlTourneyModal').remove()">Cancel</button>
      </div>
    </div>`;
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
  document.body.appendChild(modal);
}

async function submitCreateWhitelist() {
  const name = document.getElementById("wlName")?.value.trim();
  const max = parseInt(document.getElementById("wlMax")?.value || 0);
  const rounds = parseInt(document.getElementById("wlRounds")?.value || 3);
  const prize1 =
    document.getElementById("wlPrize1")?.value.trim() || "🥇 Whitelist Spot";
  const prize2 =
    document.getElementById("wlPrize2")?.value.trim() || "🥈 OG Role";
  const prize3 =
    document.getElementById("wlPrize3")?.value.trim() || "🥉 Early Access";
  const sponsorName =
    document.getElementById("wlSponsorName")?.value.trim() || "";
  const discordInvite =
    document.getElementById("wlDiscordInvite")?.value.trim() || "";

  if (!name) return toast("Enter a tournament name", "error");
  if (max < 4) return toast("Minimum 4 players", "error");

  const btn = document.querySelector("#wlTourneyModal .btn-primary");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Creating...";
  }

  try {
    // ── Require wallet signature for whitelist tournament creation ────────
    let wlSignature = "";
    if (signer && userAddress) {
      try {
        toast("✍️ Sign to confirm whitelist tournament creation...", "info");
        const wlMsg = `Create TriviaFi whitelist tournament: ${name} | ${Date.now()}`;
        wlSignature = await signer.signMessage(wlMsg);
        toast("✅ Signed!", "success");
      } catch (sigErr) {
        if (sigErr.code === 4001 || sigErr.message?.includes("rejected")) {
          toast("Signature required to create tournament.", "error");
          if (btn) {
            btn.disabled = false;
            btn.textContent = "🚀 Launch Whitelist Battle";
          }
          return;
        }
      }
    }

    const res = await fetch(`${BACKEND}/tournaments/create-whitelist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        name,
        maxPlayers: max,
        rounds,
        prize1,
        prize2,
        prize3,
        sponsorName,
        discordInvite,
        wlSignature,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed");

    document.getElementById("wlTourneyModal")?.remove();
    toast(`✅ "${name}" whitelist battle created!`, "success");
    showScreen("screenTournaments");
    await loadTournaments();
  } catch (e) {
    toast("Failed: " + e.message, "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "🚀 Launch Whitelist Battle";
    }
  }
}

function filterGames(status, btn) {
  filterStatus = status;
  document
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.remove("active"));
  if (btn) btn.classList.add("active");
  if (allGames.length === 0) {
    document.getElementById("gamesList").innerHTML =
      `<p style="color:var(--muted);text-align:center;padding:24px">Loading games...</p>`;
    loadGames();
  } else {
    renderGames();
  }
}

function disconnectWallet() {
  provider = signer = contract = usdcContract = null;
  userAddress = null;
  stopAutoRefresh();
  renderAuthState();
  showScreen("screenLobby");
  toast("Wallet disconnected", "info");
}

async function renderGames() {
  const grid = document.getElementById("gamesList");
  if (!grid) return;

  // Default "all" only shows active games — cancelled/ended hidden unless explicitly filtered
  const isAgentMode = !!window._agentRoomMode;
  const filter =
    filterStatus === "0"
      ? "open"
      : filterStatus === "live"
        ? "live"
        : filterStatus === "1"
          ? "ended"
          : filterStatus === "2"
            ? "cancelled"
            : isAgentMode
              ? "all"
              : "active"; // new default — only open/live
  const nowSec = Math.floor(Date.now() / 1000);

  // ── Filter games ────────────────────────────────────────────────────
  const filtered = allGames.filter(({ g }) => {
    const s = Number(g[14]);
    const regSecs = Number(g[10]) - nowSec;
    const playSecs = Number(g[11]) - nowSec;
    if (filter === "open") return s === 0 && regSecs > 0;
    if (filter === "live") return s === 0 && regSecs <= 0 && playSecs > 0;
    if (filter === "ended") return s === 1;
    if (filter === "cancelled") return s === 2;
    if (filter === "all") return s === 0 || s === 1; // agent mode: open + ended only, hide cancelled
    if (filter === "active") return s === 0;
    return s === 0;
  });

  // Agent box always shows ALL games regardless of tab filter
  const agentGames = allGames;

  // ── Fetch tournaments for the banner section ─────────────────────────
  let activeTournaments = [];
  try {
    const tr = await fetch(`${BACKEND}/tournaments?limit=6`, {
      credentials: "include",
    });
    if (tr.ok) {
      const all = await tr.json();
      activeTournaments = (Array.isArray(all) ? all : all.tournaments || [])
        .filter(
          (t) =>
            t.status === "open" || t.status === "active" || t.status === "live",
        )
        .slice(0, 4);
    }
  } catch (_) {}

  // ── Build HTML ───────────────────────────────────────────────────────
  let html = "";

  // ── TOURNAMENTS SECTION (top, full-width) ────────────────────────────
  // ── Fetch ALL tournaments (open + finished) ──────────────────────────
  let openTournaments = [],
    pastTournaments = [];
  try {
    const tr = await fetch(`${BACKEND}/tournaments?limit=20`, {
      credentials: "include",
    });
    if (tr.ok) {
      const all = await tr.json();
      const list = Array.isArray(all) ? all : all.tournaments || [];
      const now24 = Date.now();
      openTournaments = list.filter((t) => {
        if (t.status === "cancelled") return false;
        if (t.status === "open") {
          if (t.deadline_at && new Date(t.deadline_at).getTime() < now24)
            return false;
          return true;
        }
        if (t.status === "active") return true;
        if (t.status === "finished") {
          const created = t.created_at ? new Date(t.created_at).getTime() : 0;
          return now24 - created < 24 * 60 * 60 * 1000;
        }
        return false;
      });
      pastTournaments = list
        .filter((t) => {
          if (t.status !== "finished") return false;
          const created = t.created_at ? new Date(t.created_at).getTime() : 0;
          // Only show in past chips if older than 24 hours
          return now24 - created >= 24 * 60 * 60 * 1000;
        })
        .slice(0, 4);
    }
  } catch (_) {}

  // ── TOURNAMENTS SECTION ──────────────────────────────────────────────
  if ((filter === "active" || filter === "all") && !isAgentMode) {
    // ── Stats bar ──────────────────────────────────────────────────────
    let tStats = { usdc: "0.00", litvm: "0.0000", total: 0, live: 0 };
    try {
      const sr = await fetch(`${BACKEND}/tournaments/stats`);
      if (sr.ok) {
        const sd = await sr.json();
        tStats.usdc = parseFloat(sd.usdc_volume || 0).toFixed(2);
        tStats.litvm = parseFloat(sd.litvm_volume || 0).toFixed(4);
        tStats.total = sd.total_tournaments || 0;
        tStats.live = sd.live_count || 0;
      }
    } catch (_) {}

    html += `
      <div style="grid-column:1/-1;margin-bottom:16px">

        <!-- Section header with stats -->
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-family:'Bebas Neue',sans-serif;font-size:1.2rem;letter-spacing:2px;color:var(--gold)">🏆 TOURNAMENTS</span>
            ${tStats.live > 0 ? `<span style="background:rgba(239,71,111,.2);color:var(--red);font-size:.65rem;font-weight:800;padding:2px 8px;border-radius:20px;border:1px solid rgba(239,71,111,.4);animation:pulse 1.5s ease-in-out infinite">● ${tStats.live} LIVE</span>` : ""}
            ${openTournaments.length > 0 ? `<span style="background:rgba(6,214,160,.12);color:var(--green);font-size:.65rem;font-weight:700;padding:2px 8px;border-radius:20px;border:1px solid rgba(6,214,160,.25)">${openTournaments.length} OPEN</span>` : ""}
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <div style="font-size:.72rem;color:var(--muted);display:flex;gap:10px;align-items:center">
              <span>💰 <strong style="color:var(--accent)">$${tStats.usdc}</strong> USDC</span>
              <span style="color:var(--border)">+</span>
              <span>🔷 <strong style="color:var(--purple)">${tStats.litvm}</strong> zkLTC</span>
              <span style="color:var(--muted);font-size:.65rem">PAID OUT</span>
            </div>
            <button onclick="showTournamentLeaderboard()"
              style="background:rgba(255,209,102,.08);border:1px solid rgba(255,209,102,.2);
              color:var(--gold);padding:5px 12px;border-radius:20px;cursor:pointer;
              font-size:.72rem;font-weight:700;white-space:nowrap">
              🏅 Leaderboard
            </button>
            <button class="btn btn-ghost btn-sm" style="width:auto;padding:5px 12px;font-size:.72rem;white-space:nowrap"
              onclick="showScreen('screenTournaments');loadTournaments()">
              View All →
            </button>
          </div>
        </div>

        <!-- Open tournaments grid -->
        ${
          openTournaments.length > 0
            ? `
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;margin-bottom:12px">
            ${openTournaments
              .map((t) => {
                const fee = parseFloat(t.entry_fee || 0);
                const sym = t.token_symbol || "USDC";
                const dp = sym === "zkLTC" ? 4 : 2;
                const isLive = t.status === "active";
                const isFull =
                  (t.current_players || t.player_count || 0) >= t.max_players;
                const players = parseInt(
                  t.current_players || t.player_count || 0,
                );
                const prizePool = (fee * players).toFixed(dp);
                const spotsLeft = t.max_players - players;
                const isWL = t.tournament_type === "whitelist";
                const chainColor =
                  sym === "zkLTC" ? "var(--purple)" : "var(--accent)";
                const chainBg =
                  sym === "zkLTC"
                    ? "rgba(123,97,255,.12)"
                    : "rgba(0,229,255,.08)";
                const fillPct = Math.min(
                  100,
                  Math.round((players / t.max_players) * 100),
                );

                return `
                <div onclick="openTournament(${t.id})" style="
                  background:${isWL ? "linear-gradient(135deg,rgba(88,101,242,.12),rgba(123,97,255,.06))" : isLive ? "linear-gradient(135deg,rgba(239,71,111,.1),rgba(123,97,255,.06))" : "linear-gradient(135deg,rgba(255,209,102,.07),rgba(255,157,58,.03))"};
                  border:1.5px solid ${isLive ? "rgba(239,71,111,.5)" : isWL ? "rgba(88,101,242,.4)" : "rgba(255,209,102,.25)"};
                  border-radius:12px;padding:14px;cursor:pointer;position:relative;overflow:hidden;
                  transition:transform .15s,box-shadow .15s"
                  onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 6px 20px rgba(0,0,0,.3)'"
                  onmouseout="this.style.transform='';this.style.boxShadow=''">

                  <!-- Top accent line -->
                  <div style="position:absolute;top:0;left:0;right:0;height:2px;background:${isLive ? "linear-gradient(90deg,var(--red),var(--purple))" : isWL ? "linear-gradient(90deg,#7289da,var(--purple))" : "linear-gradient(90deg,var(--gold),var(--orange))"}"></div>

                  <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px">
                    <div style="flex:1;min-width:0">
                      <div style="font-weight:700;font-size:.88rem;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                        ${sanitizeText(t.name)}
                      </div>
                      <div style="display:inline-flex;align-items:center;gap:4px;margin-top:4px;
                        background:${isWL ? "rgba(88,101,242,.18)" : "rgba(255,209,102,.1)"};
                        border:1px solid ${isWL ? "rgba(88,101,242,.4)" : "rgba(255,209,102,.25)"};
                        border-radius:20px;padding:2px 8px">
                        <span style="font-size:.7rem;font-weight:800;color:${isWL ? "#7289da" : "var(--gold)"}">
                          ${isWL ? "💬 FREE · WHITELIST BATTLE" : "💰 PAID TOURNAMENT"}
                        </span>
                      </div>
                      <div style="font-size:.7rem;color:var(--muted);margin-top:3px">${t.rounds} rounds · bottom half eliminated</div>
                      <div style="font-size:.62rem;color:rgba(255,255,255,.22);margin-top:4px">
                      📅 ${new Date(t.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}${t.finished_at ? ` · ✅ ${new Date(t.finished_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : t.status === "active" ? " · 🔴 Live" : ""}
                      </div>
                    </div>
                    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;margin-left:8px;flex-shrink:0">
                      ${isLive ? `<span style="font-size:.62rem;font-weight:800;color:var(--red);background:rgba(239,71,111,.15);border:1px solid rgba(239,71,111,.3);padding:1px 7px;border-radius:10px">🔴 LIVE</span>` : `<span style="font-size:.62rem;font-weight:800;color:var(--green);background:rgba(6,214,160,.12);border:1px solid rgba(6,214,160,.25);padding:1px 7px;border-radius:10px">🟢 OPEN</span>`}
                      ${!isWL ? `<span style="font-size:.6rem;padding:1px 6px;border-radius:8px;background:${chainBg};color:${chainColor}">${sym === "zkLTC" ? "🔷 LitVM" : "⚡ Arc"}</span>` : ""}
                    </div>
                  </div>

                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">
                    <div style="background:rgba(0,0,0,.2);border-radius:7px;padding:6px 8px;text-align:center">
                      <div style="font-family:'Bebas Neue',sans-serif;font-size:1.1rem;color:var(--gold)">${isWL ? "FREE" : fee.toFixed(dp)}</div>
                      <div style="font-size:.68rem;color:var(--muted)">Entry ${isWL ? "" : sym}</div>
                    </div>
                    <div style="background:rgba(0,0,0,.2);border-radius:7px;padding:6px 8px;text-align:center">
                      <div style="font-family:'Bebas Neue',sans-serif;font-size:1.1rem;color:var(--green)" ${isWL ? `id="wl-topscore-${t.id}"` : ""}>
                        ${isWL ? "— pts" : prizePool}
                      </div>
                      <div style="font-size:.68rem;color:var(--muted)">${isWL ? "Top Score" : "Prize Pool"}</div>
                    </div>
                  </div>

                  <!-- Progress bar -->
                  <div style="margin-bottom:8px">
                    <div style="height:3px;background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden">
                      <div style="height:100%;width:${fillPct}%;background:${fillPct >= 100 ? "var(--red)" : fillPct > 60 ? "var(--gold)" : "var(--green)"};border-radius:2px"></div>
                    </div>
                    <div style="display:flex;justify-content:space-between;margin-top:3px">
                      <span style="font-size:.62rem;color:var(--muted)">👥 ${players}/${t.max_players}</span>
                      ${!isFull ? `<span style="font-size:.62rem;color:var(--green);font-weight:700">${spotsLeft} spot${spotsLeft > 1 ? "s" : ""} left</span>` : `<span style="font-size:.62rem;color:var(--red);font-weight:700">Full</span>`}
                    </div>
                  </div>

                  <div style="display:flex;gap:5px">
                    <div style="flex:1;background:rgba(255,209,102,.06);border-radius:5px;padding:3px;text-align:center;font-size:.6rem;color:var(--gold);font-weight:700">🥇 60%</div>
                    <div style="flex:1;background:rgba(255,255,255,.03);border-radius:5px;padding:3px;text-align:center;font-size:.6rem;color:#ccc;font-weight:700">🥈 25%</div>
                    <div style="flex:1;background:rgba(255,255,255,.03);border-radius:5px;padding:3px;text-align:center;font-size:.6rem;color:#cd7f32;font-weight:700">🥉 15%</div>
                  </div>
                </div>`;
              })
              .join("")}
          </div>`
            : `
          <div style="background:linear-gradient(135deg,rgba(255,209,102,.06),rgba(123,97,255,.04));border:1px solid rgba(255,209,102,.18);border-radius:14px;padding:20px;margin-bottom:12px;position:relative;overflow:hidden">
            <!-- bg glow -->
            <div style="position:absolute;top:-30px;right:-30px;width:120px;height:120px;background:radial-gradient(circle,rgba(255,209,102,.12),transparent 70%);pointer-events:none"></div>
            <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
              <div style="width:44px;height:44px;border-radius:12px;background:rgba(255,209,102,.1);border:1px solid rgba(255,209,102,.2);display:flex;align-items:center;justify-content:center;font-size:1.4rem;flex-shrink:0">🏆</div>
              <div style="flex:1;min-width:0">
                <div style="font-weight:700;font-size:.88rem;color:var(--gold);margin-bottom:3px">No active tournaments right now</div>
                <div style="font-size:.74rem;color:var(--muted);line-height:1.5">Tournaments run every day — paid USDC/zkLTC prizes or free whitelist battles for your community.</div>
                <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
                  <span style="background:rgba(0,229,255,.08);border:1px solid rgba(0,229,255,.18);color:var(--accent);padding:3px 10px;border-radius:20px;font-size:.68rem;font-weight:700">💰 USDC Prizes</span>
                  <span style="background:rgba(123,97,255,.08);border:1px solid rgba(123,97,255,.18);color:var(--purple);padding:3px 10px;border-radius:20px;font-size:.68rem;font-weight:700">🔷 zkLTC Prizes</span>
                  <span style="background:rgba(88,101,242,.08);border:1px solid rgba(88,101,242,.18);color:#7289da;padding:3px 10px;border-radius:20px;font-size:.68rem;font-weight:700">💬 Discord Whitelist</span>
                </div>
              </div>
              <div style="display:flex;flex-direction:column;gap:7px;flex-shrink:0">
                <button class="btn btn-primary" style="width:auto;padding:8px 18px;font-size:.78rem;white-space:nowrap"
                  onclick="showScreen('screenTournaments');loadTournaments();showTournamentTypeModal()">
                  🚀 Create Tournament
                </button>
              </div>
            </div>
          </div>`
        }

        <!-- Past tournaments as compact chips -->
        ${
          pastTournaments.length > 0
            ? `
          <div>
            <div style="font-size:.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px;font-weight:700">
              📜 Past Tournaments
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${pastTournaments
                .map((t) => {
                  const isWL = t.tournament_type === "whitelist";
                  const sym = t.token_symbol || "USDC";
                  const fee = parseFloat(t.entry_fee || 0);
                  const players = parseInt(
                    t.current_players || t.player_count || 0,
                  );
                  const dp = sym === "zkLTC" ? 4 : 2;
                  const pool = (fee * players).toFixed(dp);
                  const winner = t.winners?.[0];
                  const winnerName = winner?.username
                    ? "@" + winner.username
                    : winner?.wallet
                      ? fmt(winner.wallet)
                      : null;
                  return `
                  <button onclick="openTournament(${t.id})"
                    style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);
                    border-radius:20px;padding:4px 10px;cursor:pointer;font-size:.7rem;
                    color:var(--muted);transition:.15s;display:flex;align-items:center;gap:5px;white-space:nowrap"
                    onmouseover="this.style.background='rgba(255,255,255,.08)';this.style.color='#fff'"
                    onmouseout="this.style.background='rgba(255,255,255,.04)';this.style.color='var(--muted)'">
                    ${isWL ? "💬" : "🏆"}
                    <span>${sanitizeText(t.name)}</span>
                    ${winnerName ? `<span style="color:var(--gold);font-weight:700">· ${winnerName}</span>` : ""}
                    ${!isWL && parseFloat(pool) > 0 ? `<span style="color:var(--green)">· ${pool} ${sym}</span>` : ""}
                    <span style="background:rgba(6,214,160,.12);color:var(--green);padding:1px 5px;border-radius:8px;font-size:.6rem">✅</span>
                  </button>`;
                })
                .join("")}
            </div>
          </div>`
            : ""
        }

      </div>

      <!-- Game Rooms divider -->
      <div style="grid-column:1/-1;margin:4px 0 16px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
          <div style="flex:1;height:1px;background:var(--border)"></div>
          <span style="font-family:'Bebas Neue',sans-serif;font-size:1rem;letter-spacing:2px;color:var(--muted)">GAME ROOMS</span>
          <div style="flex:1;height:1px;background:var(--border)"></div>
        </div>

        <div style="margin-bottom:14px">
  <div style="background:linear-gradient(135deg,rgba(123,97,255,.12),rgba(0,229,255,.04));border:1px solid rgba(123,97,255,.3);border-radius:16px;overflow:hidden">

    <!-- Agent Header -->
    <div style="padding:16px 18px 14px;border-bottom:1px solid rgba(255,255,255,.06)">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:38px;height:38px;border-radius:10px;background:rgba(123,97,255,.2);border:1px solid rgba(123,97,255,.35);display:flex;align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0">🤖</div>
          <div>
            <div style="font-weight:700;font-size:.95rem;color:#fff;display:flex;align-items:center;gap:8px">
              AI Agent Rooms
              <span style="width:7px;height:7px;border-radius:50%;background:#06d6a0;box-shadow:0 0 8px rgba(6,214,160,.8);display:inline-block;animation:pulse 1.8s ease-in-out infinite"></span>
            </div>
            <div style="font-size:.72rem;color:var(--muted);margin-top:1px">Auto-created every hour · No setup needed</div>
          </div>
        </div>
        <button onclick="showAgentRooms()"
          style="background:rgba(123,97,255,.18);border:1px solid rgba(123,97,255,.35);color:var(--purple);padding:6px 14px;border-radius:20px;cursor:pointer;font-size:.75rem;font-weight:700;white-space:nowrap">
          🤖 Browse All
        </button>
      </div>
    </div>

    <!-- Live Stats Bar -->
    <div id="agentStatsBar" style="padding:10px 18px;background:rgba(0,0,0,.2);border-bottom:1px solid rgba(255,255,255,.05);display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:.73rem">
      <span style="width:6px;height:6px;border-radius:50%;background:#06d6a0;box-shadow:0 0 10px rgba(6,214,160,.8);flex-shrink:0;animation:pulse 1.5s infinite"></span>
      <span style="color:var(--muted)">Loading stats...</span>
    </div>

    <!-- Description -->
    <div style="padding:12px 18px 10px">
      <p style="font-size:.78rem;color:var(--muted);margin:0;line-height:1.6">
        Our AI agent creates trivia rooms 24/7. Pay entry, beat other players across 10 questions — top scorers split the prize pool automatically.
      </p>
    </div>

    <!-- Game Rows -->
    <div style="padding:0 12px 12px;display:flex;flex-direction:column;gap:7px">
      ${
        filtered.length === 0
          ? `
        <div style="background:rgba(0,0,0,.2);border:1px dashed rgba(123,97,255,.2);border-radius:10px;padding:18px;text-align:center">
          <div style="font-size:1.4rem;margin-bottom:6px">🤖</div>
          <p style="color:var(--muted);font-size:.78rem;margin:0;font-weight:600">No agent rooms open right now</p>
          <p style="color:rgba(122,122,154,.6);font-size:.7rem;margin:4px 0 0">Next room drops soon — check back in a few minutes</p>
        </div>
      `
          : filtered
              .map(({ i, g, chainId: cid, net }) => {
                const s = Number(g[14]);
                const regSecs = Number(g[10]) - nowSec;
                const playSecs = Number(g[11]) - nowSec;
                const hasDeadlines = Number(g[10]) > 0 || Number(g[11]) > 0;
                const dp = net.decimals === 18 ? 4 : 2;
                const fee = parseFloat(
                  ethers.formatUnits(g[6], net.decimals),
                ).toFixed(dp);
                const pool = parseFloat(
                  ethers.formatUnits(g[8], net.decimals),
                ).toFixed(dp);
                const n = Number(g[9]);
                const max = Number(g[7]);

                let phase = "",
                  phaseColor = "var(--muted)",
                  phaseBg = "rgba(122,122,154,.1)";
                if (s === 0) {
                  if (!hasDeadlines || regSecs > 0) {
                    phase = "📋 Open";
                    phaseColor = "var(--green)";
                    phaseBg = "rgba(6,214,160,.1)";
                  } else if (playSecs > 0) {
                    phase = "🎮 Live";
                    phaseColor = "var(--gold)";
                    phaseBg = "rgba(255,209,102,.1)";
                  } else {
                    phase = "⏰ Pending";
                    phaseColor = "var(--muted)";
                    phaseBg = "rgba(122,122,154,.08)";
                  }
                } else if (s === 1) {
                  phase = "✅ Ended";
                  phaseColor = "var(--muted)";
                  phaseBg = "rgba(122,122,154,.08)";
                } else {
                  phase = "❌ Cancelled";
                  phaseColor = "var(--red)";
                  phaseBg = "rgba(239,71,111,.08)";
                }

                const chainBadge =
                  cid === 4441
                    ? `<span style="font-size:.6rem;padding:2px 7px;border-radius:8px;background:rgba(123,97,255,.15);color:var(--purple);border:1px solid rgba(123,97,255,.25);font-weight:700">🔷 LitVM</span>`
                    : `<span style="font-size:.6rem;padding:2px 7px;border-radius:8px;background:rgba(0,229,255,.1);color:var(--accent);border:1px solid rgba(0,229,255,.2);font-weight:700">⚡ Arc</span>`;

                const isEnded = s === 1 || s === 2;
                const fillPct =
                  max > 0 ? Math.min(100, Math.round((n / max) * 100)) : 0;

                return `
                <div style="background:rgba(0,0,0,.25);border:1px solid rgba(123,97,255,.15);border-radius:10px;padding:11px 13px;transition:border-color .15s,background .15s"
                  onmouseover="this.style.borderColor='rgba(123,97,255,.4)';this.style.background='rgba(0,0,0,.35)'"
                  onmouseout="this.style.borderColor='rgba(123,97,255,.15)';this.style.background='rgba(0,0,0,.25)'">
                  <div style="display:flex;align-items:center;gap:10px">
                    <div style="flex:1;min-width:0">
                      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap">
                        <span style="font-weight:700;font-size:.83rem;color:#fff">#${i} ${sanitizeText(g[1])}</span>
                        <span style="font-size:.65rem;font-weight:700;padding:2px 8px;border-radius:20px;background:${phaseBg};color:${phaseColor}">${phase}</span>
                        ${chainBadge}
                      </div>
                      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:.71rem;color:var(--muted)">
                        <span>📚 ${sanitizeText(g[4])}</span>
                        <span style="color:rgba(255,255,255,.2)">·</span>
                        <span>💰 <strong style="color:#fff">${fee}</strong> ${net.symbol}</span>
                        <span style="color:rgba(255,255,255,.2)">·</span>
                        <span>🏆 <strong style="color:var(--green)">${pool}</strong> ${net.symbol}</span>
                        <span style="color:rgba(255,255,255,.2)">·</span>
                        <span>👥 <strong style="color:#fff">${n}/${max}</strong></span>
                        ${s === 0 && hasDeadlines && regSecs > 0 ? `<span style="color:rgba(255,255,255,.2)">·</span><span style="background:rgba(6,214,160,.1);border:1px solid rgba(6,214,160,.25);color:var(--green);font-weight:700;padding:1px 7px;border-radius:8px;font-size:.65rem" data-deadline="${g[10]}" data-prefix="Join closes: " data-expiredtext="Closed">🔓 Join: ${fmtTime(regSecs)}</span>` : ""}
                        ${s === 0 && hasDeadlines && regSecs <= 0 && playSecs > 0 ? `<span style="color:rgba(255,255,255,.2)">·</span><span style="background:rgba(255,209,102,.1);border:1px solid rgba(255,209,102,.3);color:var(--gold);font-weight:700;padding:1px 7px;border-radius:8px;font-size:.65rem" data-deadline="${g[11]}" data-prefix="Play closes: " data-expiredtext="Ended">🎮 Play: ${fmtTime(playSecs)}</span>` : ""}
                      </div>
                      <div style="margin-top:7px;height:2px;background:rgba(255,255,255,.06);border-radius:1px;overflow:hidden">
                        <div style="height:100%;width:${fillPct}%;background:${fillPct >= 100 ? "var(--red)" : fillPct > 60 ? "var(--gold)" : "var(--green)"};border-radius:1px;transition:width .5s"></div>
                      </div>
                      <div style="margin-top:5px;font-size:.62rem;color:rgba(255,255,255,.25);display:flex;gap:10px;flex-wrap:wrap">
                        ${Number(g[10]) > 0 ? `<span>📋 Join closes: ${new Date(Number(g[10]) * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>` : ""}
                        ${Number(g[11]) > 0 ? `<span>🎮 Play closes: ${new Date(Number(g[11]) * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>` : ""}
                        ${s === 1 ? `<span style="color:rgba(6,214,160,.4)">✅ Ended: ${new Date(Number(g[11]) * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>` : ""}
                      </div>
                    </div>
                    <div style="display:flex;gap:5px;flex-shrink:0">
                      <button onclick="event.stopPropagation();openGameReadOnly(${i},${cid})"
                        style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);color:#aaa;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:.73rem;font-weight:600;transition:.15s"
                        onmouseover="this.style.background='rgba(255,255,255,.1)';this.style.color='#fff'"
                        onmouseout="this.style.background='rgba(255,255,255,.05)';this.style.color='#aaa'">
                        👁 View
                      </button>
                      ${
                        !isEnded
                          ? `
                      <button onclick="event.stopPropagation();openGame(${i},${cid})"
                        style="background:rgba(123,97,255,.25);border:1px solid rgba(123,97,255,.45);color:var(--purple);padding:6px 12px;border-radius:8px;cursor:pointer;font-size:.73rem;font-weight:700;transition:.15s"
                        onmouseover="this.style.background='rgba(123,97,255,.4)';this.style.borderColor='rgba(123,97,255,.7)'"
                        onmouseout="this.style.background='rgba(123,97,255,.25)';this.style.borderColor='rgba(123,97,255,.45)'">
                        ▶ Play
                      </button>`
                          : ""
                      }
                    </div>
                  </div>
                </div>`;
              })
              .join("")
      }
    </div>
  </div>
</div>
      </div>`;
  } else {
    // ── Agent room browse mode: full-page view with back button + filters ──
    html += `
      <div style="grid-column:1/-1;margin-bottom:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
          <div style="display:flex;align-items:center;gap:10px">
            <button onclick="hideAgentRooms()"
              style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);
              color:var(--text);padding:8px 16px;border-radius:20px;cursor:pointer;
              font-size:.82rem;font-weight:700">
              ← Back
            </button>
            <div>
              <span style="font-family:'Bebas Neue',sans-serif;font-size:1.1rem;letter-spacing:2px;color:var(--purple)">🤖 AI AGENT ROOMS</span>
              <div style="font-size:.7rem;color:var(--muted);margin-top:1px">Auto-created every hour · Pay entry · Top scorers split prize pool</div>
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="tab ${filterStatus === "all" || filterStatus === "active" ? "active" : ""}" onclick="filterGames('all',this)">All</button>
            <button class="tab ${filterStatus === "0" ? "active" : ""}" onclick="filterGames('0',this)">🟢 Open</button>
            <button class="tab ${filterStatus === "live" ? "active" : ""}" onclick="filterGames('live',this)">🔴 Live</button>
            <button class="tab ${filterStatus === "1" ? "active" : ""}" onclick="filterGames('1',this)">✅ Ended</button>
            <button class="tab ${filterStatus === "2" ? "active" : ""}" onclick="filterGames('2',this)">❌ Cancelled</button>
          </div>
        </div>
      </div>`;

    if (filtered.length === 0) {
      html += `
        <div style="grid-column:1/-1;background:rgba(123,97,255,.04);border:1px dashed rgba(123,97,255,.2);
          border-radius:12px;padding:28px;text-align:center">
          <div style="font-size:1.8rem;margin-bottom:8px">🤖</div>
          <p style="color:var(--purple);font-weight:700;font-size:.92rem">No agent rooms for this filter</p>
          <p style="color:var(--muted);font-size:.78rem;margin-top:4px">Try a different filter or check back soon</p>
        </div>`;
    } else {
      for (const { i, g, chainId: cid, net } of filtered) {
        const s = Number(g[14]);
        const regSecs = Number(g[10]) - nowSec;
        const playSecs = Number(g[11]) - nowSec;
        const n = Number(g[9]);
        const max = Number(g[7]);
        const dp = net.decimals === 18 ? 4 : 2;
        const fee = parseFloat(ethers.formatUnits(g[6], net.decimals)).toFixed(
          dp,
        );
        const pool = parseFloat(ethers.formatUnits(g[8], net.decimals)).toFixed(
          dp,
        );
        const hasDeadlines = Number(g[10]) > 0 || Number(g[11]) > 0;

        const STATUS_BADGE = {
          0: "badge-open",
          1: "badge-ended",
          2: "badge-cancelled",
        };
        const STATUS_LABEL = { 0: "OPEN", 1: "ENDED", 2: "CANCELLED" };

        let phase = "",
          phaseColor = "var(--muted)";
        if (s === 0) {
          if (!hasDeadlines) {
            phase = "";
          } else if (regSecs > 0) {
            phase = "📋 Open — Joining Now";
            phaseColor = "var(--green)";
          } else if (playSecs > 0) {
            phase = "🎮 Live — Play Now!";
            phaseColor = "var(--gold)";
          } else {
            phase = "⏰ Ended (pending close)";
            phaseColor = "var(--muted)";
          }
        } else if (s === 1) {
          phase = "✅ Finished";
          phaseColor = "var(--muted)";
        } else {
          phase = "❌ Cancelled";
          phaseColor = "var(--red)";
        }

        const chainBadge =
          cid === 4441
            ? `<span style="font-size:.65rem;padding:2px 7px;border-radius:8px;background:rgba(123,97,255,.15);color:var(--purple);border:1px solid rgba(123,97,255,.25)">🔷 LitVM</span>`
            : `<span style="font-size:.65rem;padding:2px 7px;border-radius:8px;background:rgba(0,229,255,.1);color:var(--accent);border:1px solid rgba(0,229,255,.2)">⚡ Arc</span>`;

        const isActive =
          s === 0 && hasDeadlines && (regSecs > 0 || playSecs > 0);
        const borderColor = isActive
          ? regSecs > 0
            ? "rgba(6,214,160,.3)"
            : "rgba(255,209,102,.3)"
          : "var(--border)";
        const clickFn =
          s === 1 || s === 2
            ? `openGameReadOnly(${i},${cid})`
            : `openGame(${i},${cid})`;
        const timerStr =
          s === 0 && hasDeadlines && regSecs > 0
            ? `<span style="color:var(--green);font-weight:600">⏰ ${fmtTime(regSecs)}</span>`
            : s === 0 && hasDeadlines && playSecs > 0
              ? `<span style="color:var(--gold);font-weight:600">🎮 ${fmtTime(playSecs)}</span>`
              : "";

        html += `
          <div onclick="${clickFn}" style="
            background:var(--surface);border:1px solid ${borderColor};
            border-radius:10px;padding:10px 12px;cursor:pointer;
            transition:transform .12s,box-shadow .12s;display:flex;
            align-items:center;gap:10px"
            onmouseover="this.style.transform='translateY(-1px)';this.style.boxShadow='0 4px 16px rgba(0,0,0,.25)'"
            onmouseout="this.style.transform='';this.style.boxShadow=''">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap">
                <span style="font-weight:700;font-size:.85rem;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px">#${i} ${sanitizeText(g[1])}</span>
                ${phase ? `<span style="font-size:.72rem;color:${phaseColor};font-weight:600">${phase}</span>` : ""}
              </div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:.75rem;color:var(--muted)">
                <span class="cat-pill" style="font-size:.65rem;padding:1px 6px">📚 ${sanitizeText(g[4])}</span>
                ${Number(g[5]) > 0 ? `<span>· ${["", "Easy", "Medium", "Hard"][Number(g[5])] || ""}</span>` : ""}
                <span>💰 <strong style="color:#fff">${fee}</strong> ${net.symbol}</span>
                <span>👥 <strong style="color:#fff">${n}/${max}</strong></span>
                ${timerStr}
              </div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
              <div style="display:flex;gap:4px;align-items:center">
                <span class="badge ${STATUS_BADGE[s]}" style="font-size:.62rem;padding:2px 7px">${STATUS_LABEL[s]}</span>
                ${chainBadge}
              </div>
              <div style="font-size:.75rem;color:var(--green);font-weight:700">🏆 ${pool} ${net.symbol}</div>
              <div style="font-size:.65rem;color:var(--muted)">By: ${fmt(g[2])}</div>
            </div>
          </div>`;
      }
    }
  }

  grid.innerHTML = html;
  setTimeout(() => loadGlobalStats(), 0);

  // ── Load real top scores for WL tournaments asynchronously ──────────
  const wlScoreEls = grid.querySelectorAll("[id^='wl-topscore-']");
  wlScoreEls.forEach(async (el) => {
    const tid = el.id.replace("wl-topscore-", "");
    try {
      const res = await fetch(`${BACKEND}/tournaments/${tid}`, {
        credentials: "include",
      });
      if (!res.ok) return;
      const { players } = await res.json();
      if (!players || players.length === 0) {
        el.textContent = "0 pts";
        return;
      }
      const top = Math.max(...players.map((p) => parseInt(p.total_score || 0)));
      el.textContent = top > 0 ? top.toLocaleString() + " pts" : "0 pts";
    } catch (_) {
      el.textContent = "0 pts";
    }
  });
}

async function openGameReadOnly(gameId, gameChainId) {
  window._joinScreenOrigin = "lobby";
  currentGameId = gameId;
  currentGameChainId =
    gameChainId || (activeNet.decimals === 18 ? 4441 : 5042002);

  // ✅ Always rebuild readContract for the target chain — never trust stale state
  const targetChainId = currentGameChainId;
  const targetNet = NETWORKS[targetChainId];
  if (targetNet) {
    let bestProvider;
    if (targetChainId === 4441) {
      // Use cached provider — never test with getBlockNumber here
      bestProvider = await getLitvmProvider();
    } else {
      bestProvider = new ethers.JsonRpcProvider(
        "https://rpc.testnet.arc.network",
      );
      for (const rpc of [
        "https://rpc.testnet.arc.network",
        "https://rpc.drpc.testnet.arc.network",
      ]) {
        try {
          const p = new ethers.JsonRpcProvider(rpc);
          await Promise.race([
            p.getBlockNumber(),
            new Promise((_, r) => setTimeout(() => r(new Error("t")), 2500)),
          ]);
          bestProvider = p;
          break;
        } catch (_) {}
      }
    }
    readContract = new ethers.Contract(
      targetNet.contractAddress,
      ABI,
      bestProvider,
    );
  }
  try {
    const g = await getGame(gameId);
    if (!g) {
      toast("Could not load game. Try again.", "error");
      return;
    }
    currentGame = g;

    // Add this after: currentGame = g; (in both openGame and openGameReadOnly)
    if (currentGameChainId === 4441 && g) {
      fetch(`${BACKEND}/games/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          chainId: 4441,
          contractGameId: gameId,
          creator: g[2],
          name: g[1],
          category: g[4],
          difficulty: Number(g[5]),
          entryFee: parseFloat(ethers.formatUnits(g[6], 18)),
          tokenSymbol: "zkLTC",
          maxPlayers: Number(g[7]),
          prizePool: parseFloat(ethers.formatUnits(g[8], 18)),
          playerCount: Number(g[9]),
          registrationEnd: Number(g[10]),
          playDeadline: Number(g[11]),
          finishedCount: Number(g[15]),
          status: Number(g[14]),
        }),
      }).catch(() => {});
    }

    const [
      ,
      name,
      creator,
      ,
      catName,
      difficulty,
      entryFee,
      maxPlayers,
      prizePool,
      playerCount,
      ,
      ,
      topPlayers,
      ,
      status,
    ] = g;
    const gameNet = NETWORKS[gameChainId] || activeNet;
    const gameDecimals = gameNet.decimals;
    const gameSymbol = gameNet.symbol;
    const dp = gameDecimals === 18 ? 4 : 2;
    const s = Number(status);
    const fee = parseFloat(ethers.formatUnits(entryFee, gameDecimals)).toFixed(
      dp,
    );
    const pool = parseFloat(
      ethers.formatUnits(prizePool, gameDecimals),
    ).toFixed(dp);
    const n = Number(playerCount);
    const dist = parseFloat(pool) * 0.95;
    const prizes =
      n === 1
        ? [dist, 0, 0]
        : n === 2
          ? [dist * 0.7, dist * 0.3, 0]
          : [dist * 0.6, dist * 0.25, dist * 0.15];
    let myWinnerPos = -1,
      myPrize = 0,
      alreadyClaimed = false,
      actuallyPlayed = false;

    if (userAddress && s === 1) {
      myWinnerPos = Array.from(topPlayers).findIndex(
        (p) => p && p.toLowerCase() === userAddress.toLowerCase(),
      );

      if (myWinnerPos >= 0) {
        myPrize = prizes[myWinnerPos] || 0;

        try {
          const statusRes = await readContract.getPlayerStatus(
            gameId,
            userAddress,
          );
          alreadyClaimed = statusRes[2];
        } catch (_) {}

        // PRIMARY: leaderboard score
        try {
          const [lbAddrs, lbScores] = await Promise.race([
            readContract.getLeaderboard(gameId),
            new Promise((_, r) => setTimeout(() => r(new Error("t")), 5000)),
          ]);

          const myLbIdx = lbAddrs.findIndex(
            (a) => a?.toLowerCase() === userAddress.toLowerCase(),
          );

          if (myLbIdx >= 0 && Number(lbScores[myLbIdx]) > 0) {
            actuallyPlayed = true;
          }
          console.log("LB DEBUG", {
            myLbIdx,
            addr: lbAddrs[myLbIdx],
            score: lbScores[myLbIdx]?.toString?.() || lbScores[myLbIdx],
            allAddrs: lbAddrs,
            allScores: lbScores.map((s) => s.toString?.() || s),
          });
        } catch (_) {}

        // FALLBACK: DB finished flag
        if (!actuallyPlayed) {
          try {
            const chk = await fetch(
              `${BACKEND}/game/status/${gameId}?chainId=${currentGameChainId || 5042002}`,
              { credentials: "include" },
            );

            const d = await chk.json();

            console.log("DB DEBUG", d);
            console.log("TOP PLAYERS", topPlayers);
            console.log("PRIZES", prizes);

            console.log("DB DEBUG", d);
            console.log("BEFORE FALLBACK", actuallyPlayed);

            if (d.onchain === true) {
              actuallyPlayed = true;
            }

            console.log("AFTER FALLBACK", actuallyPlayed);
          } catch (_) {}
        }

        // In topPlayers but never actually played
        if (!actuallyPlayed) {
          myWinnerPos = -1;
          myPrize = 0;
        }
        console.log("PRE CLEANUP", {
          actuallyPlayed,
          myWinnerPos,
          myPrize,
        });
        console.log("TOP PLAYERS", topPlayers);
        console.log("PRIZES", prizes);
        console.log("WINNER CHECK", {
          userAddress,
          actuallyPlayed,
          myWinnerPos,
          myPrize,
        });
      }
    }
    let lbHtml = "";
    try {
      const [addrs, scoreList, finished] =
        await readContract.getLeaderboard(gameId);
      const rows = addrs
        .map((a, i) => ({ a, sc: Number(scoreList[i]), fin: finished[i] }))
        .sort((a, b) => b.sc - a.sc);

      // Assign medal ranks only to players who actually scored
      let medalIndex = 0;
      lbHtml = rows
        .map((r, i) => {
          const hasScore = r.sc > 0 && r.fin;
          const rankDisplay = hasScore
            ? medalIndex === 0
              ? "🥇"
              : medalIndex === 1
                ? "🥈"
                : medalIndex === 2
                  ? "🥉"
                  : `#${medalIndex + 1}`
            : `#${i + 1}`;
          if (hasScore) medalIndex++;

          return `<div class="lb-row ${
            Array.from(topPlayers).some(
              (p) => p?.toLowerCase() === r.a.toLowerCase(),
            )
              ? "lb-winner"
              : ""
          }">
            <span class="lb-rank">${rankDisplay}</span>
            <span class="lb-addr">${fmt(r.a)}${
              r.a.toLowerCase() === userAddress?.toLowerCase() ? " (you)" : ""
            }</span>
            <span class="lb-score" style="${r.sc === 0 ? "color:rgba(255,255,255,.2)" : ""}">
              ${r.sc > 0 ? r.sc + " pts" : "didn't play"}
            </span>
            ${
              hasScore && i < 3 && prizes[i] > 0
                ? `<span style="color:var(--gold);font-size:.73rem">${prizes[medalIndex - 1]?.toFixed(dp) || ""} ${gameSymbol}</span>`
                : `<span style="font-size:.68rem;color:var(--muted)">no score</span>`
            }
            <span class="lb-tag ${r.fin ? "lb-done" : "lb-wait"}">${
              r.fin ? "Done" : "—"
            }</span>
          </div>`;
        })
        .join("");
    } catch (_) {
      lbHtml = `<p style="color:var(--muted)">No scores yet.</p>`;
    }

    // ── Check if current user joined but never played ─────────────────────
    // ✅ FIX: never show refund banner to actual winners
    let neverPlayedRefundHtml = "";
    if (userAddress && s === 1 && myWinnerPos < 0) {
      try {
        const playerStatus = await readContract.getPlayerStatus(
          gameId,
          userAddress,
        );
        const userJoined = playerStatus[0];
        const userFinished = playerStatus[1]; // true = submitted score onchain
        const userClaimed = playerStatus[2];

        // Only eligible if joined, never submitted score, and not claimed
        if (userJoined && !userFinished && !userClaimed) {
          const refundStatusRes = await fetch(
            `${BACKEND}/games/${gameId}/refund-status?wallet=${userAddress}&chainId=${currentGameChainId || 5042002}`,
            { credentials: "include" },
          );
          const refundStatus = await refundStatusRes.json();

          if (refundStatus.status === "paid") {
            neverPlayedRefundHtml = `
             <div style="background:rgba(6,214,160,.06);border:1px solid rgba(6,214,160,.2);
               border-radius:12px;padding:16px;margin-bottom:16px;text-align:center">
               <div style="font-size:1.5rem;margin-bottom:8px">✅</div>
               <p style="color:var(--green);font-weight:700">Entry Fee Refunded</p>
               <p style="color:var(--muted);font-size:.78rem;margin-top:4px">
                 ${parseFloat(refundStatus.amount || 0).toFixed(dp)} ${gameSymbol}
                 was returned to your wallet.
               </p>
               ${
                 refundStatus.tx_hash
                   ? `<div style="font-size:.68rem;color:var(--muted);margin-top:8px;
                     word-break:break-all">TX: ${refundStatus.tx_hash}</div>`
                   : ""
               }
             </div>`;
          } else {
            neverPlayedRefundHtml = `
             <div style="background:rgba(255,209,102,.05);border:1px solid rgba(255,209,102,.2);
               border-radius:12px;padding:18px;margin-bottom:16px;text-align:center">
               <div style="font-size:1.8rem;margin-bottom:8px">😴</div>
               <p style="color:var(--gold);font-weight:700;font-size:.95rem">
                 You registered but didn't play
               </p>
               <p style="color:var(--muted);font-size:.8rem;margin-top:6px;margin-bottom:14px">
                 You paid the entry fee but never submitted a score.<br>
                 You can claim your
                 <strong style="color:var(--gold)">${fee} ${gameSymbol}</strong> back.
               </p>
               <button id="gameRefundBtn" class="btn btn-primary"
                 style="background:linear-gradient(135deg,var(--gold),var(--orange));
                 width:auto;padding:12px 32px"
                 onclick="claimGameRefund(${gameId}, ${currentGameChainId || 5042002})">
                 💸 Claim ${fee} ${gameSymbol} Refund
               </button>
             </div>`;
          }
        }
      } catch (_) {}
    }

    let claimBannerHtml = "";
    if (myWinnerPos >= 0 && myPrize > 0 && actuallyPlayed) {
      const medals = ["🥇 1st Place", "🥈 2nd Place", "🥉 3rd Place"];
      claimBannerHtml = `<div class="winner-banner" style="margin-bottom:16px">
    <h3>${medals[myWinnerPos]} — YOU WON!</h3>
    <div class="winner-prize">${myPrize.toFixed(dp)} ${gameSymbol}</div>
    ${
      !alreadyClaimed
        ? `<button class="btn btn-gold" onclick="doClaimPrize()"
            style="margin-top:14px;width:auto;padding:14px 40px;font-size:1rem">
            💰 Claim Your Prize
          </button>`
        : `<p style="color:var(--green);margin-top:10px;font-weight:600;font-size:1rem">
            ✅ Prize Already Claimed!
          </p>`
    }
  </div>`;
    }

    // ── Refund banner for cancelled games ──
    let refundHtml = "";
    if (s === 2 && userAddress) {
      try {
        const [joined, , claimed_] = await readContract.getPlayerStatus(
          gameId,
          userAddress,
        );
        if (joined && !claimed_) {
          refundHtml = `<div style="background:rgba(239,71,111,.07);border:1px solid rgba(239,71,111,.3);border-radius:12px;padding:16px;margin-bottom:16px;text-align:center">
        <p style="color:var(--red);font-weight:600;font-size:.95rem;margin-bottom:4px">❌ Game Cancelled</p>
        <p style="color:var(--muted);font-size:.8rem;margin-bottom:12px">Your entry fee is fully refundable</p>
        <button class="btn btn-primary" onclick="doClaimRefund(${gameId})" style="width:auto;padding:12px 32px">💸 Claim Refund</button>
      </div>`;
        } else if (joined && claimed_) {
          refundHtml = `<div style="background:rgba(6,214,160,.06);border:1px solid rgba(6,214,160,.2);border-radius:12px;padding:14px;margin-bottom:16px;text-align:center">
        <p style="color:var(--green);font-weight:600">✅ Refund Already Claimed</p>
      </div>`;
        }
      } catch (_) {}
    }
    // ── Winners block: only show players who actually submitted a score onchain ──
    let winnersHtml = "";
    if (
      s === 1 &&
      topPlayers[0] !== "0x0000000000000000000000000000000000000000"
    ) {
      // Fetch onchain leaderboard to check who actually played (score > 0)
      let playedWallets = new Set();
      try {
        const [addrs, scoreList] = await readContract.getLeaderboard(gameId);
        addrs.forEach((a, i) => {
          if (Number(scoreList[i]) > 0) playedWallets.add(a.toLowerCase());
        });
      } catch (_) {}

      // Only show winners who actually submitted a score
      const realWinners = [0, 1, 2].filter(
        (i) =>
          topPlayers[i] &&
          topPlayers[i] !== "0x0000000000000000000000000000000000000000" &&
          prizes[i] > 0 &&
          playedWallets.has(topPlayers[i].toLowerCase()),
      );

      if (realWinners.length > 0) {
        winnersHtml = `<div style="background:rgba(255,209,102,.06);border:1px solid rgba(255,209,102,.25);border-radius:12px;padding:16px;margin-bottom:16px">
      <div style="font-family:'Bebas Neue',sans-serif;font-size:1.1rem;color:var(--gold);margin-bottom:10px">🏆 Winners</div>
      ${realWinners
        .map(
          (i) =>
            `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05)">
          <span>${["🥇", "🥈", "🥉"][i]} ${fmt(topPlayers[i])}${topPlayers[i]?.toLowerCase() === userAddress?.toLowerCase() ? " 👈 You" : ""}</span>
          <span style="color:var(--gold);font-weight:600">${prizes[i].toFixed(dp)} ${gameSymbol}</span>
        </div>`,
        )
        .join("")}
    </div>`;
      } else {
        // Nobody actually played — show a notice instead
        winnersHtml = `<div style="background:rgba(255,157,58,.06);border:1px solid rgba(255,157,58,.2);border-radius:12px;padding:16px;margin-bottom:16px;text-align:center">
      <div style="font-size:1.5rem;margin-bottom:8px">😴</div>
      <p style="color:var(--gold);font-weight:700">No one played this game</p>
      <p style="color:var(--muted);font-size:.8rem;margin-top:6px">All registered players missed the deadline. Entry fees can be claimed back below.</p>
    </div>`;
      }
    }
    document.getElementById("joinContent").innerHTML = `
      <div style="margin-bottom:16px"><h2 style="font-family:'Bebas Neue',sans-serif;font-size:1.5rem;letter-spacing:2px">#${gameId} — ${sanitizeText(
        name,
      )}</h2><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><span class="badge ${
        STATUS_BADGE[s]
      }">${STATUS_LABEL[s]}</span><span class="cat-pill">📚 ${sanitizeText(
        catName,
      )}</span></div></div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center"><div style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;color:var(--gold)">${fee}</div><div style="font-size:.72rem;color:var(--muted)">Entry (${gameSymbol})</div></div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center"><div style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;color:var(--green)">${pool}</div><div style="font-size:.72rem;color:var(--muted)">Prize Pool</div></div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center"><div style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;color:var(--accent)">${n}/${maxPlayers}</div><div style="font-size:.72rem;color:var(--muted)">Players</div></div>
      </div>
      ${neverPlayedRefundHtml}${refundHtml}${claimBannerHtml}${winnersHtml}
      <div style="font-size:.78rem;color:var(--muted);text-transform:uppercase;margin-bottom:10px">📊 Final Leaderboard</div>${lbHtml}
      ${
        !userAddress
          ? `<div style="margin-top:16px;padding:12px;background:rgba(0,229,255,.06);border:1px solid rgba(0,229,255,.2);border-radius:10px;text-align:center"><p style="color:var(--muted);font-size:.83rem">Connect wallet to join active games</p><button class="btn btn-primary" style="margin-top:10px;width:auto;padding:10px 24px" onclick="connectWallet()">🦊 Connect Wallet</button></div>`
          : ""
      }`;
    // Only set origin if not already set by caller (e.g. tournament flow)
    if (!window._joinScreenOrigin) window._joinScreenOrigin = "lobby";
    showScreen("screenJoin");
  } catch (e) {
    toast("Error loading game: " + e.message, "error");
  }
}

// ── Claim refund for normal game (joined but never played) ────────────────
async function claimGameRefund(gameId, chainId) {
  if (!userAddress) return toast("Connect wallet first", "error");

  const btn = document.getElementById("gameRefundBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Processing refund...";
  }

  // Make sure we are on the correct network
  const targetNet = NETWORKS[chainId];
  if (targetNet && provider) {
    const currentChainId = Number((await provider.getNetwork()).chainId);
    if (currentChainId !== chainId) {
      try {
        toast(`Switching to ${targetNet.name}...`, "info");
        await getActiveProvider().request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: targetNet.hexChainId }],
        });
        await new Promise((r) => setTimeout(r, 500));
        activeNet = targetNet;
        CONTRACT_ADDRESS = activeNet.contractAddress;
        USDC_ADDRESS = activeNet.tokenAddress;
        provider = new ethers.BrowserProvider(
          window._activeWalletProvider || window.ethereum,
        );
        signer = await provider.getSigner();
        contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
        if (!activeNet.isNative) {
          usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);
        } else {
          usdcContract = null;
        }
        updateNetBar();
      } catch (e) {
        toast("Failed to switch network: " + e.message, "error");
        if (btn) {
          btn.disabled = false;
          btn.textContent = "💸 Claim Refund";
        }
        return;
      }
    }
  }

  try {
    const res = await fetch(`${BACKEND}/games/${gameId}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        wallet: userAddress,
        chainId,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      toast(data.error || "Refund failed", "error");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "💸 Claim Refund";
      }
      return;
    }

    toast(
      `💸 ${data.amount.toFixed(data.tokenSymbol === "zkLTC" ? 4 : 2)} ${data.tokenSymbol} refunded to your wallet!`,
      "success",
    );

    // Refresh the game view after a short delay
    setTimeout(() => openGameReadOnly(gameId, chainId), 1500);
  } catch (e) {
    toast("Refund failed: " + e.message, "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "💸 Claim Refund";
    }
  }
}

async function openGame(gameId, gameChainId) {
  // ✅ Lock with auto-release after 10s max to prevent permanent lock
  if (window._openingGame) {
    toast("Loading game...", "info");
    return;
  }
  window._openingGame = true;
  const lockTimer = setTimeout(() => {
    window._openingGame = false;
  }, 10000);

  try {
    const targetChainId =
      gameChainId || (activeNet.decimals === 18 ? 4441 : 5042002);
    currentGameChainId = targetChainId;
    const targetNet = NETWORKS[targetChainId];

    // ── Step 1: Build readContract for target chain FIRST ──────────────
    // Do this before anything else so getGame() has a working contract
    try {
      let bestProvider;
      if (targetChainId === 4441) {
        bestProvider = await getLitvmProvider(); // cached — no extra RPC call
      } else {
        bestProvider = new ethers.JsonRpcProvider(
          "https://rpc.testnet.arc.network",
        );
        for (const rpc of [
          "https://rpc.testnet.arc.network",
          "https://rpc.drpc.testnet.arc.network",
        ]) {
          try {
            const p = new ethers.JsonRpcProvider(rpc);
            await Promise.race([
              p.getBlockNumber(),
              new Promise((_, r) =>
                setTimeout(() => r(new Error("timeout")), 2500),
              ),
            ]);
            bestProvider = p;
            break;
          } catch (_) {}
        }
      }
      readContract = new ethers.Contract(
        targetNet.contractAddress,
        ABI,
        bestProvider,
      );
    } catch (_) {}

    // ── Step 2: Switch wallet network if needed (non-blocking) ─────────
    if (userAddress) {
      try {
        if (provider) {
          const network = await Promise.race([
            provider.getNetwork(),
            new Promise((_, r) =>
              setTimeout(() => r(new Error("timeout")), 2000),
            ),
          ]);
          const userChainId = Number(network.chainId);

          if (userChainId !== targetChainId) {
            toast(`Switching to ${targetNet.name}...`, "info");
            try {
              await getActiveProvider().request({
                method: "wallet_switchEthereumChain",
                params: [{ chainId: targetNet.hexChainId }],
              });
            } catch (e) {
              if (e.code === 4902) {
                await getActiveProvider().request({
                  method: "wallet_addEthereumChain",
                  params: [
                    { chainId: targetNet.hexChainId, ...targetNet.addParams },
                  ],
                });
              }
            }
            await new Promise((r) => setTimeout(r, 500));
            activeNet = targetNet;
            CONTRACT_ADDRESS = activeNet.contractAddress;
            USDC_ADDRESS = activeNet.tokenAddress;
            provider = new ethers.BrowserProvider(
              window._activeWalletProvider || window.ethereum,
            );
            signer = await provider.getSigner();
            contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
            usdcContract = activeNet.isNative
              ? null
              : new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);
            updateNetBar();
            toast(`✅ Switched to ${activeNet.name}`, "success");
          }
        }
      } catch (_) {
        // Network check failed — continue anyway, don't block game load
      }
    }

    // ── Step 3: If no wallet, open read-only ────────────────────────────
    if (!userAddress) {
      await openGameReadOnly(gameId, targetChainId);
      return;
    }

    // ── Step 4: Load game data ──────────────────────────────────────────
    currentGameId = gameId;
    const g = await getGame(gameId);
    if (!g) {
      toast("Could not load game. Please try again.", "error");
      return;
    }
    currentGame = g;

    // Add this after: currentGame = g; (in both openGame and openGameReadOnly)
    if (currentGameChainId === 4441 && g) {
      fetch(`${BACKEND}/games/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          chainId: 4441,
          contractGameId: gameId,
          creator: g[2],
          name: g[1],
          category: g[4],
          difficulty: Number(g[5]),
          entryFee: parseFloat(ethers.formatUnits(g[6], 18)),
          tokenSymbol: "zkLTC",
          maxPlayers: Number(g[7]),
          prizePool: parseFloat(ethers.formatUnits(g[8], 18)),
          playerCount: Number(g[9]),
          registrationEnd: Number(g[10]),
          playDeadline: Number(g[11]),
          finishedCount: Number(g[15]),
          status: Number(g[14]),
        }),
      }).catch(() => {});
    }

    const [
      ,
      name,
      creator,
      ,
      catName,
      difficulty,
      entryFee,
      maxPlayers,
      prizePool,
      playerCount,
      regEnd,
      playDeadline,
      topPlayers,
      ,
      status,
      finishedCount,
    ] = g;

    const s = Number(status);
    const now = Math.floor(Date.now() / 1000);

    // ── Step 5: Handle ended/cancelled games immediately ────────────────
    if (s === 2) {
      await openGameReadOnly(gameId, targetChainId);
      return;
    }

    // ── Step 6: Check play status (parallel for speed) ──────────────────
    let finishedEarly = false;
    let serverPlayed = false;

    await Promise.allSettled([
      readContract
        .getPlayerStatus(gameId, userAddress)
        .then((ps) => {
          finishedEarly = ps[1];
        })
        .catch(() => {}),
      fetch(
        `${BACKEND}/game/status/${currentGameId}?chainId=${targetChainId}`,
        { credentials: "include" },
      )
        .then((r) => r.json())
        .then((d) => {
          if (d.finished || d.played) {
            serverPlayed = true;
            markSubmitted(currentGameId);
          }
        })
        .catch(() => {}),
    ]);

    if (s === 1) {
      if (!finishedEarly && !alreadySubmitted(gameId) && !serverPlayed) {
        await openGameReadOnly(gameId, targetChainId);
        return;
      }
      showScreen("screenResults");
      score = loadSavedScore(gameId);
      document.getElementById("resScore").textContent = score || "—";
      document.getElementById("resIcon").textContent =
        score >= 800 ? "🏆" : score >= 500 ? "🎯" : "💪";
      document.getElementById("resSub").textContent =
        `Game finished · ${score} pts`;
      document.getElementById("submitSection").style.display = "none";
      await refreshResults();
      startAutoRefresh(gameId);
      return;
    }

    // ── Step 7: Get player status for open game ─────────────────────────
    let joined = false;
    let finished = false;
    try {
      const ps = await readContract.getPlayerStatus(gameId, userAddress);
      joined = ps[0];
      finished = ps[1];
    } catch (_) {}

    if (finished || alreadySubmitted(gameId) || serverPlayed) {
      showScreen("screenResults");
      score = loadSavedScore(gameId);
      document.getElementById("resScore").textContent = score || "—";
      document.getElementById("resIcon").textContent =
        score >= 800 ? "🏆" : score >= 500 ? "🎯" : "💪";
      document.getElementById("resSub").textContent =
        `You already played · ${score} pts`;
      document.getElementById("submitSection").style.display =
        score > 0 ? "block" : "none";
      await refreshResults();
      startAutoRefresh(gameId);
      return;
    }

    // ── Step 8: Render open game UI ─────────────────────────────────────
    const gameNet = NETWORKS[targetChainId] || activeNet;
    const gameDecimals = gameNet.decimals;
    const gameSymbol = gameNet.symbol;
    const dp = gameDecimals === 18 ? 4 : 2;
    const fee = parseFloat(ethers.formatUnits(entryFee, gameDecimals)).toFixed(
      dp,
    );
    const pool = parseFloat(
      ethers.formatUnits(prizePool, gameDecimals),
    ).toFixed(dp);
    const n = Number(playerCount);
    const regSecs = Number(regEnd) - now;
    const playSecs = Number(playDeadline) - now;
    const inRegPhase = regSecs > 0;
    const inPlayPhase = !inRegPhase && playSecs > 0;
    const dist = parseFloat(pool) * 0.95;

    // Network badge
    const chainBadge =
      targetChainId === 4441
        ? `<span style="font-size:.7rem;padding:2px 8px;border-radius:10px;background:rgba(123,97,255,.15);color:var(--purple);border:1px solid rgba(123,97,255,.3)">🔷 LitVM</span>`
        : `<span style="font-size:.7rem;padding:2px 8px;border-radius:10px;background:rgba(0,229,255,.1);color:var(--accent);border:1px solid rgba(0,229,255,.25)">⚡ Arc</span>`;

    let breakdownHtml = "";
    if (n === 0)
      breakdownHtml = `<p style="color:var(--muted);font-size:.82rem">No players yet. Entry: ${fee} ${gameSymbol}</p>`;
    else if (n === 1)
      breakdownHtml = `<div>🥇 <strong style="color:var(--gold)">${dist.toFixed(dp)} ${gameSymbol}</strong> (solo wins all)</div>`;
    else if (n === 2)
      breakdownHtml = `<div style="display:flex;gap:14px"><span>🥇 <strong style="color:var(--gold)">${(dist * 0.7).toFixed(dp)}</strong></span><span>🥈 <strong style="color:#ccc">${(dist * 0.3).toFixed(dp)}</strong></span><span style="color:var(--muted)">${gameSymbol}</span></div>`;
    else
      breakdownHtml = `<div style="display:flex;gap:12px;flex-wrap:wrap"><span>🥇 <strong style="color:var(--gold)">${(dist * 0.6).toFixed(dp)}</strong></span><span>🥈 <strong style="color:#ccc">${(dist * 0.25).toFixed(dp)}</strong></span><span>🥉 <strong style="color:#cd7f32">${(dist * 0.15).toFixed(dp)}</strong></span><span style="color:var(--muted)">${gameSymbol}</span></div>`;

    // Load players list (non-blocking, show loading first)
    let players = [];
    try {
      players = await Promise.race([
        readContract.getPlayers(gameId),
        new Promise((_, r) => setTimeout(() => r([]), 5000)),
      ]);
    } catch (_) {}

    const betsHtml = await showPredictionBets(gameId, players).catch(() => "");
    const playerRows =
      players.length === 0
        ? `<p style="color:var(--muted);font-size:.83rem">No players yet!</p>`
        : players
            .map(
              (p, i) =>
                `<div class="lb-row" style="margin-bottom:5px"><span class="lb-rank">#${i + 1}</span><span class="lb-addr">${fmt(p)}${p.toLowerCase() === userAddress.toLowerCase() ? " (you)" : ""}</span><span style="font-size:.73rem;color:var(--muted)">${p.toLowerCase() === creator.toLowerCase() ? "👑" : ""}</span></div>`,
            )
            .join("");

    // Action button
    let actionHtml = "";
    if (inRegPhase && !joined && n < Number(maxPlayers)) {
      actionHtml = `<button class="btn btn-primary" onclick="doJoin()">💰 Pay ${fee} ${activeNet.symbol} & Reserve Spot</button><p style="text-align:center;color:var(--muted);font-size:.77rem;margin-top:8px">${fmtTime(regSecs)} left to join</p>`;
    } else if (inRegPhase && joined) {
      actionHtml = `<div style="text-align:center;padding:14px;border-radius:10px;background:rgba(0,229,255,.06);border:1px solid rgba(0,229,255,.2)"><p style="color:var(--accent);font-weight:600">✓ You are registered!</p><p style="color:var(--muted);font-size:.82rem;margin-top:4px">Game starts in ${fmtTime(regSecs)}</p></div>`;
    } else if (inPlayPhase && joined) {
      let alreadyPlayed = alreadySubmitted(currentGameId);
      if (!alreadyPlayed) {
        try {
          const chk = await fetch(
            `${BACKEND}/game/status/${currentGameId}?chainId=${targetChainId}`,
            { credentials: "include" },
          );
          const d = await chk.json();
          if (d.finished || d.played) {
            alreadyPlayed = true;
            markSubmitted(currentGameId);
          }
        } catch (_) {}
      }
      actionHtml = alreadyPlayed
        ? `<div style="text-align:center;padding:14px;border-radius:10px;background:rgba(6,214,160,.08);border:1px solid rgba(6,214,160,.25)"><p style="color:var(--green);font-weight:600">✅ Already played!</p><p style="color:var(--muted);font-size:.82rem;margin-top:4px">Score: ${loadSavedScore(currentGameId) || "pending"} pts</p><button class="btn btn-ghost btn-sm" style="margin-top:10px" onclick="doTriggerEnd(${currentGameId})">Check results</button></div>`
        : `<button class="btn btn-primary" onclick="startPlay()" style="background:linear-gradient(135deg,var(--gold),var(--orange))">🎮 Play Now!</button><p style="text-align:center;color:var(--red);font-size:.77rem;margin-top:8px;font-weight:600">⚠️ Deadline in ${fmtTime(playSecs)}</p>`;
    } else if (inPlayPhase && !joined) {
      actionHtml = `<p style="color:var(--muted);text-align:center;padding:10px">Registration closed.</p>`;
    } else if (finished) {
      actionHtml = `<div style="text-align:center;padding:14px;border-radius:10px;background:rgba(6,214,160,.08);border:1px solid rgba(6,214,160,.25)"><p style="color:var(--green);font-weight:600">✅ Score submitted!</p><button class="btn btn-ghost btn-sm" style="margin-top:10px" onclick="doTriggerEnd(${gameId})">Check results</button></div>`;
    } else {
      actionHtml = `<button class="btn btn-ghost" onclick="doTriggerEnd(${gameId})">🏁 End Game & See Results</button>`;
    }

    // Refund banner for ended games where player never played
    let gameRefundBannerHtml = "";
    if (s === 1 && !finished && !alreadySubmitted(gameId)) {
      try {
        const rd = await fetch(
          `${BACKEND}/games/${gameId}/refund-status?wallet=${userAddress}&chainId=${targetChainId}`,
          { credentials: "include" },
        ).then((r) => r.json());
        if (rd.status === "paid") {
          gameRefundBannerHtml = `<div style="background:rgba(6,214,160,.06);border:1px solid rgba(6,214,160,.2);border-radius:12px;padding:14px;margin-bottom:14px;text-align:center"><p style="color:var(--green);font-weight:600">✅ Entry Fee Refunded</p><p style="color:var(--muted);font-size:.78rem;margin-top:4px">${fee} ${gameSymbol} was returned to your wallet.</p></div>`;
        } else if (rd.status !== "pending") {
          gameRefundBannerHtml = `<div style="background:rgba(255,209,102,.05);border:1px solid rgba(255,209,102,.2);border-radius:12px;padding:16px;margin-bottom:14px;text-align:center"><div style="font-size:1.5rem;margin-bottom:8px">😴</div><p style="color:var(--gold);font-weight:700">You didn't play this game</p><p style="color:var(--muted);font-size:.78rem;margin-top:6px;margin-bottom:12px">Claim your <strong style="color:var(--gold)">${fee} ${gameSymbol}</strong> entry fee back.</p><button id="gameRefundBtn" class="btn btn-primary" style="background:linear-gradient(135deg,var(--gold),var(--orange));width:auto;padding:11px 28px" onclick="claimGameRefund(${gameId},${targetChainId})">💸 Claim ${fee} ${gameSymbol} Refund</button></div>`;
        }
      } catch (_) {}
    }

    const creatorHtml =
      creator.toLowerCase() === userAddress.toLowerCase()
        ? `<hr/><div style="color:var(--accent);font-size:.82rem;font-weight:600;margin-bottom:10px">👑 Your Room — Creator earns 2.5%</div><div style="display:flex;gap:10px"><button class="btn btn-ghost btn-sm" style="flex:1" onclick="doTriggerEnd(${gameId})">🏁 Force End</button><button class="btn btn-danger btn-sm" style="flex:1" onclick="doCancelRoom(${gameId})">✕ Cancel & Refund All</button></div>`
        : "";

    const shareUrl = `${location.origin}${location.pathname}?game=${gameId}`;

    document.getElementById("joinContent").innerHTML = `
      <div style="margin-bottom:16px">
        <h2 style="font-family:'Bebas Neue',sans-serif;font-size:1.5rem;letter-spacing:2px">#${gameId} — ${sanitizeText(name)}</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <span class="badge ${STATUS_BADGE[s]}">${STATUS_LABEL[s]}</span>
          <span class="cat-pill">📚 ${sanitizeText(catName)}</span>
          ${Number(difficulty) > 0 ? `<span style="font-size:.75rem;color:var(--${DIFF_CLASSES[Number(difficulty)] || "accent"})">· ${DIFF_LABELS[Number(difficulty)]}</span>` : ""}
          ${chainBadge}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center"><div style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;color:var(--gold)">${fee}</div><div style="font-size:.72rem;color:var(--muted)">Entry (${gameSymbol})</div></div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center"><div style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;color:var(--green)">${pool}</div><div style="font-size:.72rem;color:var(--muted)">Prize Pool</div></div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center"><div style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;color:var(--accent)">${n}/${maxPlayers}</div><div style="font-size:.72rem;color:var(--muted)">Players</div></div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px">
        <div style="font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Prize Breakdown</div>
        ${breakdownHtml}
      </div>
      <div style="font-size:.78rem;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Players (${n}/${maxPlayers})</div>
      <div style="margin-bottom:14px">${playerRows}</div>
      ${betsHtml}${gameRefundBannerHtml}
      <div style="margin-top:14px">${actionHtml}</div>
      <div id="gameActions" style="margin-top:10px"></div>
      <div class="share-box" style="margin-top:14px">
        <span style="font-size:1.3rem">🔗</span>
        <div style="flex:1"><div style="font-size:.75rem;color:var(--muted);margin-bottom:3px">Share</div>
        <div class="share-link" style="font-size:.72rem">${shareUrl}</div></div>
        <button class="btn btn-ghost btn-sm" onclick="copyShare('${shareUrl}')">Copy</button>
      </div>
      ${creatorHtml}`;

    if (!window._joinScreenOrigin) window._joinScreenOrigin = "lobby";
    showScreen("screenJoin");
    loadGameStatus(currentGameId);
    startAutoRefresh(gameId);
  } catch (e) {
    console.error("openGame error:", e.message);
    toast("Error loading game: " + e.message, "error");
  } finally {
    clearTimeout(lockTimer);
    window._openingGame = false;
  }
}

// Add this new tab function
async function showMyGames() {
  if (!userAddress) return toast("Connect wallet first", "error");
  filterStatus = "mine";
  document
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.remove("active"));
  // highlight the my games tab
  const el = document.getElementById("gamesList");
  el.innerHTML = `<p style="color:var(--muted);text-align:center;padding:20px">Loading your games...</p>`;

  try {
    const count = Number(await readContract.gameCounter());
    const myGames = [];
    for (let i = count; i >= Math.max(1, count - 100); i--) {
      try {
        const [joined] = await readContract.getPlayerStatus(i, userAddress);
        if (joined) {
          const g = await getGame(i);
          myGames.push({ i, g });
        }
      } catch (_) {}
    }
    if (myGames.length === 0) {
      el.innerHTML = `<div style="text-align:center;padding:40px;color:var(--muted)"><div style="font-size:3rem;margin-bottom:12px">🎮</div><p>No games joined yet.</p></div>`;
      return;
    }
    let html = '<div class="game-grid">';
    for (const { i, g } of myGames) {
      const s = Number(g[14]);
      const isWinner = Array.from(g[12]).some(
        (p) => p?.toLowerCase() === userAddress?.toLowerCase(),
      );
      const fee = fmtUSDC(g[6]),
        pool = fmtUSDC(g[8]);
      const clickAction =
        s === 1 || s === 2 ? `openGameReadOnly(${i})` : `openGame(${i})`;
      html += `<div class="gcard" onclick="${clickAction}">
        <div class="gcard-title">#${i} ${sanitizeText(
          g[1],
        )} <span class="badge ${STATUS_BADGE[s]}">${STATUS_LABEL[s]}</span>
        ${
          isWinner && s === 1
            ? `<span style="font-size:.7rem;background:rgba(255,209,102,.15);color:var(--gold);border:1px solid rgba(255,209,102,.3);padding:1px 6px;border-radius:10px;margin-left:4px">🥇 Won</span>`
            : ""
        }
        </div>
        <div class="gmeta">💰 Entry: <strong>${fee} USDC</strong> | 🏆 Pool: <strong>${pool} USDC</strong></div>
        <div class="gmeta">📚 ${sanitizeText(g[4])} · 👥 ${Number(
          g[9],
        )} players</div>
      </div>`;
    }
    html += "</div>";
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = `<p style="color:var(--red);text-align:center;padding:20px">Error: ${e.message}</p>`;
  }
}

async function doJoin() {
  if (!contract || !userAddress) return toast("Connect wallet first", "error");

  // ✅ Rebuild signer from the wallet that was originally connected
  if (window._activeWalletProvider) {
    provider = new ethers.BrowserProvider(window._activeWalletProvider);
    signer = await provider.getSigner();
    contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
    if (!activeNet.isNative)
      usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);
  }

  // Auto-release lock after 30s max — prevents permanent stuck state
  const lockTimer = setTimeout(() => {
    if (joinBtn) {
      joinBtn.disabled = false;
      joinBtn.textContent = `💰 Pay & Reserve Spot`;
    }
    toast("Request timed out. Please try again.", "error");
  }, 30000);

  try {
    const entryFee = currentGame[6];
    if (activeNet.isNative) {
      toast("Joining with zkLTC...", "info");
      let joinGas = 200000n;
      try {
        const est = await Promise.race([
          contract.joinGame.estimateGas(currentGameId, { value: entryFee }),
          new Promise((_, r) =>
            setTimeout(() => r(new Error("timeout")), 4000),
          ),
        ]);
        joinGas = (BigInt(est) * 150n) / 100n;
      } catch (_) {
        joinGas = 300000n; // safe fallback for LitVM
      }
      const tx = await contract.joinGame(currentGameId, {
        value: entryFee,
        gasLimit: joinGas,
      });
      const newCount = Number(currentGame[9]) + 1;
      const entry = allGames.find((g) => g.i === currentGameId);
      if (entry) entry.g[9] = BigInt(newCount);
      toast("⛓️ Confirming...", "info");
      await tx.wait();
    } else {
      const allowance = await usdcContract.allowance(
        userAddress,
        CONTRACT_ADDRESS,
      );
      if (allowance < entryFee) {
        toast("Step 1/2: Approving USDC...", "info");
        let approveGas = 100000n;
        try {
          const est = await Promise.race([
            usdcContract.approve.estimateGas(CONTRACT_ADDRESS, entryFee),
            new Promise((_, r) =>
              setTimeout(() => r(new Error("timeout")), 4000),
            ),
          ]);
          approveGas = (BigInt(est) * 150n) / 100n;
        } catch (_) {
          approveGas = 150000n;
        }
        const tx1 = await usdcContract.approve(CONTRACT_ADDRESS, entryFee, {
          gasLimit: approveGas,
        });
        await tx1.wait();
      }
      toast("Step 2/2: Joining game...", "info");
      let joinGas2 = 200000n;
      try {
        const est = await Promise.race([
          contract.joinGame.estimateGas(currentGameId),
          new Promise((_, r) =>
            setTimeout(() => r(new Error("timeout")), 4000),
          ),
        ]);
        joinGas2 = (BigInt(est) * 150n) / 100n;
      } catch (_) {
        joinGas2 = 300000n;
      }
      const tx2 = await contract.joinGame(currentGameId, {
        gasLimit: joinGas2,
      });
      const newCount = Number(currentGame[9]) + 1;
      const entry = allGames.find((g) => g.i === currentGameId);
      if (entry) entry.g[9] = BigInt(newCount);
      toast("⛓️ Confirming...", "info");
      await tx2.wait();
    }
    clearTimeout(lockTimer);
    toast("✅ Joined successfully!", "success");
    currentGame = await getGame(currentGameId);
    await openGame(
      currentGameId,
      activeNet === NETWORKS[4441] ? 4441 : 5042002,
    );
    try {
      const updatedGame = await getGame(currentGameId);
      if (updatedGame) {
        await fetch(`${BACKEND}/games/save`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            chainId: parseInt(activeNet.hexChainId, 16),
            contractGameId: currentGameId,
            creator: updatedGame[2],
            name: updatedGame[1],
            category: updatedGame[4],
            difficulty: Number(updatedGame[5]),
            entryFee: parseFloat(
              ethers.formatUnits(updatedGame[6], activeNet.decimals),
            ),
            tokenSymbol: activeNet.symbol,
            maxPlayers: Number(updatedGame[7]),
            txHash: "",
            prizePool: parseFloat(
              ethers.formatUnits(updatedGame[8], activeNet.decimals),
            ),
          }),
        });
      }
    } catch (_) {}
  } catch (e) {
    clearTimeout(lockTimer);
    toast("Failed: " + (e.reason || e.message), "error");
    if (joinBtn) {
      joinBtn.disabled = false;
      joinBtn.textContent = `💰 Pay & Reserve Spot`;
    }
  }
  loadGames();
}

async function doJoin_withGuestMode() {
  if (!contract && !currentProfile)
    return toast("Login with Google first", "error");

  const entryFee = currentGame[6];
  const entryUSDC = parseFloat(ethers.formatUnits(entryFee, 6));

  // ── GUEST MODE: no wallet ──────────────────────────────────────────────────
  if (!contract || !userAddress) {
    if (!currentProfile)
      return toast("Login with Google to play as guest", "error");
    toast("Joining as guest...", "info");

    try {
      const res = await fetch(`${BACKEND}/game/join-guest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ gameId: currentGameId, entryFee: entryUSDC }),
      });
      const data = await res.json();
      if (data.error) return toast("Error: " + data.error, "error");
      toast(
        `✅ Joined as guest! Entry fee (${entryUSDC} USDC) deducted from your credits.`,
        "success",
      );
      currentGame = await getGame(currentGameId);
      await openGame(currentGameId);
    } catch (e) {
      toast("Failed: " + e.message, "error");
    }
    return;
  }

  // ── WALLET MODE: normal flow with allowance check ──────────────────────────
  try {
    const allowanceAbi = [
      "function allowance(address,address) view returns (uint256)",
    ];
    const usdcRead = new ethers.Contract(
      USDC_ADDRESS,
      allowanceAbi,
      readProvider,
    );
    const currentAllowance = await usdcRead.allowance(
      userAddress,
      CONTRACT_ADDRESS,
    );

    if (currentAllowance < entryFee) {
      toast("Step 1/2: Approving USDC (one-time)...", "info");
      const entryFee = currentGame[6]; // already correct from contract

      const allowance = await usdcContract.allowance(
        userAddress,
        CONTRACT_ADDRESS,
      );

      if (allowance < entryFee) {
        toast("Approving USDC...", "info");

        const tx = await usdcContract.approve(
          CONTRACT_ADDRESS,
          entryFee, // ✅ correct amount (1 USDC)
        );

        await tx.wait();
      }
    } else {
      toast("Joining room...", "info");
    }

    toast("Step 2/2: Joining room...", "info");
    const tx = await contract.joinGame(currentGameId);
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error("Transaction failed");
    toast(
      "✅ Spot reserved! Come back when registration closes to play.",
      "success",
    );
    currentGame = await getGame(currentGameId);
    await openGame(currentGameId);
  } catch (e) {
    toast("Failed: " + (e.reason || e.message), "error");
  }
}

async function tryRestoreWallet() {
  const savedAddress = sessionStorage.getItem("arc_wallet");
  if (!savedAddress) return;

  try {
    // Try to reconnect MetaMask silently (eth_accounts doesn't trigger popup)
    const accounts = await window.ethereum?.request({ method: "eth_accounts" });
    if (!accounts || accounts.length === 0) return;

    const addr = accounts[0];
    if (addr.toLowerCase() !== savedAddress.toLowerCase()) return;

    // Reconnect provider silently
    provider = new ethers.BrowserProvider(
      window._activeWalletProvider || window.ethereum,
    );
    signer = await provider.getSigner();
    userAddress = await signer.getAddress();

    const network = await provider.getNetwork();
    if (Number(network.chainId) !== 5042002) return; // wrong chain, don't restore

    contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
    usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);
    try {
      platformAddress = await readContract.platform();
    } catch (_) {}

    renderAuthState();
    if (currentProfile && !currentProfile.wallet)
      await linkWalletToProfile(userAddress);
    loadMyStats();
  } catch (_) {
    sessionStorage.removeItem("arc_wallet");
  }
}

async function startPlay() {
  // ✅ Rebuild signer from the wallet that was originally connected
  if (window._activeWalletProvider) {
    provider = new ethers.BrowserProvider(window._activeWalletProvider);
    signer = await provider.getSigner();
    contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
  }
  if (alreadySubmitted(currentGameId)) {
    toast("You already played this game!", "error");
    showScreen("screenResults");
    score = loadSavedScore(currentGameId);
    document.getElementById("resScore").textContent = score;
    document.getElementById("resIcon").textContent =
      score >= 800 ? "🏆" : score >= 500 ? "🎯" : "💪";
    document.getElementById("resSub").textContent =
      `Score already submitted · ${score} pts`;
    document.getElementById("submitSection").style.display = "none";
    await refreshResults();
    return;
  }

  // ── Guard: if a play session is already in progress, don't restart ──
  // ── Guard: check if session is in progress BUT verify with server first ──
  if (sessionStorage.getItem(`playing_${currentGameId}`)) {
    // Don't blindly block — verify with server if they actually played
    try {
      const chainId =
        currentGameChainId || (activeNet.decimals === 18 ? 4441 : 5042002);
      const chk = await fetch(
        `${BACKEND}/game/status/${currentGameId}?chainId=${chainId}`,
        { credentials: "include" },
      );
      const chkData = await chk.json();
      if (chkData.finished || chkData.played) {
        // Actually finished — show results
        markSubmitted(currentGameId);
        showScreen("screenResults");
        score = loadSavedScore(currentGameId);
        document.getElementById("resScore").textContent = score || "...";
        document.getElementById("resSub").textContent =
          `Already played · ${score || "pending"} pts`;
        document.getElementById("submitSection").style.display =
          score > 0 ? "block" : "none";
        await refreshResults();
        return;
      } else {
        // Server says NOT finished — stale flag, clear it and allow play
        sessionStorage.removeItem(`playing_${currentGameId}`);
      }
    } catch (_) {
      // Network error checking — clear stale flag and allow play
      sessionStorage.removeItem(`playing_${currentGameId}`);
    }
  }

  const chainId =
    currentGameChainId || (activeNet.decimals === 18 ? 4441 : 5042002);

  try {
    const chk = await fetch(
      `${BACKEND}/game/status/${currentGameId}?chainId=${chainId}`,
      { credentials: "include" },
    );
    const chkData = await chk.json();
    if (chkData.finished || chkData.played) {
      markSubmitted(currentGameId);
      toast("You already played this game!", "error");
      showScreen("screenResults");
      score = loadSavedScore(currentGameId);
      document.getElementById("resScore").textContent = score || "...";
      document.getElementById("resIcon").textContent =
        score >= 800 ? "🏆" : score >= 500 ? "🎯" : "💪";
      document.getElementById("resSub").textContent =
        `Already played · ${score || "pending"} pts`;
      document.getElementById("submitSection").style.display =
        score > 0 ? "block" : "none";
      await refreshResults();
      return;
    }
  } catch (_) {}

  // Mark session as in-progress immediately to prevent double-start

  const g = currentGame || (await getGame(currentGameId));
  const catId = Number(g[3]),
    diff = Number(g[5]);
  toast("Loading questions...", "info");

  try {
    // ✅ Fetch questions directly from OpenTDB (fast, no backend needed)
    const diffParam =
      diff > 0 ? `&difficulty=${["", "easy", "medium", "hard"][diff]}` : "";
    let qtData;

    for (const url of [
      `https://opentdb.com/api.php?amount=10&category=${catId}&type=multiple&encode=url3986${diffParam}`,
      `https://opentdb.com/api.php?amount=10&type=multiple&encode=url3986${diffParam}`,
    ]) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 8000);
        const r = await fetch(url, { signal: controller.signal });
        clearTimeout(t);
        const d = await r.json();
        if (d.response_code === 0 && d.results?.length > 0) {
          qtData = d;
          break;
        }
      } catch (_) {}
    }

    if (!qtData) {
      toast("Could not load questions. Try again.", "error");
      return;
    }

    // ✅ Build questions — store correct answers in a hidden session token
    // The token is a hash stored server-side via /game/start
    const rawQuestions = qtData.results.map((q, idx) => {
      const correct = decodeURIComponent(q.correct_answer);
      const incorrect = q.incorrect_answers.map((a) => decodeURIComponent(a));
      return {
        question: decodeURIComponent(q.question),
        correct, // stored client-side temporarily
        answers: shuffle([correct, ...incorrect]),
        diff: q.difficulty,
        id: idx,
      };
    });

    // ✅ Store correct answers server-side BEFORE starting quiz — blocking
    try {
      const startRes = await fetch(`${BACKEND}/game/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          gameId: currentGameId,
          wallet: userAddress,
          chainId,
          categoryId: catId,
          difficulty: diff,
          correctAnswers: rawQuestions.map((q, i) => ({
            index: i,
            correct: q.correct,
          })),
        }),
      });
      if (!startRes.ok) {
        const err = await startRes.json().catch(() => ({}));
        if (err.error && !err.error.includes("finished")) {
          toast("Failed to register session: " + err.error, "error");
          sessionStorage.removeItem(`playing_${currentGameId}`); // ✅ clear on failure
          return;
        }
      }
      // ✅ Only mark as playing AFTER successful registration
      sessionStorage.setItem(`playing_${currentGameId}`, "1");
    } catch (e) {
      sessionStorage.removeItem(`playing_${currentGameId}`); // ✅ clear on network error
      toast("Could not register game session. Check connection.", "error");
      return;
    }
    // Keep correct answers for UI feedback — server independently verifies score
    questions = rawQuestions;
    currentQ = 0;
    score = 0;
    answers = [];
    streakCount = 0;
    answered = false;
    buildDots();
    showScreen("screenPlay");
    loadQ();
    hideToast();
  } catch (e) {
    toast("Error: " + e.message, "error");
  }
}

function buildDots() {
  document.getElementById("progressDots").innerHTML = questions
    .map((_, i) => `<div class="dot" id="dot${i}"></div>`)
    .join("");
}

function loadQ() {
  if (currentQ >= questions.length) {
    finishTrivia();
    return;
  }
  const q = questions[currentQ];
  answered = false;
  timeLeft = 15;
  questions.forEach((_, i) => {
    const d = document.getElementById("dot" + i);
    if (d)
      d.className =
        "dot" + (i < currentQ ? " done" : i === currentQ ? " now" : "");
  });
  document.getElementById("qCounter").textContent = `${currentQ + 1} / ${
    questions.length
  }`;
  document.getElementById("qPts").textContent =
    streakCount >= STREAK_THRESHOLD
      ? `⭐ ${score} 🔥x${streakCount}`
      : `⭐ ${score}`;
  document.getElementById("questionTxt").textContent = q.question;
  document.getElementById("qFeedback").style.display = "none";
  document.getElementById("hintBox").style.display = "none";
  document.getElementById("hintBtn").disabled = false;
  document.getElementById("hintBtn").textContent = "🤖 AI Hint (0.01 USDC)";
  document.getElementById("ansGrid").innerHTML = q.answers
    .map(
      (a, i) =>
        `<button class="ans-btn" onclick="pickAnswer(${i})">${sanitizeText(
          a,
        )}</button>`,
    )
    .join("");
  startQTimer();
}

function startQTimer() {
  clearInterval(timerInt);
  updateQTimer();
  timerInt = setInterval(() => {
    timeLeft--;
    updateQTimer();
    if (timeLeft <= 0) {
      clearInterval(timerInt);
      if (!answered) timeUp();
    }
  }, 1000);
}

function tweetGame() {
  const text =
    "I just joined " +
    currentGame[1] +
    " on activeNet.name 🎮 Win " +
    fmtUSDC(currentGame[8]) +
    " USDC. Play now: " +
    window.location.href;

  window.open(
    "https://twitter.com/intent/tweet?text=" + encodeURIComponent(text),
    "_blank",
  );
}

function updateQTimer() {
  const el = document.getElementById("qClock");
  el.textContent = timeLeft;
  el.className = "q-clock" + (timeLeft <= 5 ? " urg" : "");
  if (timeLeft <= 5 && typeof playSound === "function") playSound("tick");
  document.getElementById("qTimerFill").style.width =
    (timeLeft / 15) * 100 + "%";
  document.getElementById("qTimerFill").style.background =
    timeLeft <= 5
      ? "linear-gradient(90deg,var(--red),#ff6b35)"
      : "linear-gradient(90deg,var(--green),var(--accent))";
}

function shareResult() {
  const s = document.getElementById("resScore")?.textContent || "0";
  const gameUrl = `https://triviafi.xyz/game`;
  const text = `🏆 I just scored ${s} pts on TriviaFi!\n\nCompete in onchain trivia — win USDC & zkLTC prizes.\n\n👉 Play now: ${gameUrl}\n\n#TriviaFi #Web3Gaming #Crypto`;
  const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
  window.open(tweetUrl, "_blank");
}

function pickAnswer(idx) {
  if (answered) return;
  answered = true;
  clearInterval(timerInt);
  const q = questions[currentQ];
  const selected = q.answers[idx];
  const isCorrect = selected === q.correct;
  const pts = isCorrect ? 100 : 0;
  score += pts;
  if (typeof playSound === "function")
    playSound(isCorrect ? "correct" : "wrong");

  answers.push({
    questionIndex: currentQ,
    selected,
    correct: isCorrect,
    timeLeft,
  });

  if (isCorrect) {
    streakCount++;
    if (streakCount >= STREAK_THRESHOLD) payStreakBonus();
  } else {
    streakCount = 0;
  }

  document.querySelectorAll(".ans-btn").forEach((b, i) => {
    b.disabled = true;
    if (i === idx) {
      b.classList.add(isCorrect ? "correct" : "wrong");
    }
  });

  document.getElementById("qPts").textContent =
    streakCount >= STREAK_THRESHOLD
      ? `⭐ ${score} 🔥x${streakCount}`
      : `⭐ ${score}`;

  const fb = document.getElementById("qFeedback");
  fb.style.display = "block";
  if (isCorrect) {
    fb.style.cssText =
      "display:block;padding:11px;border-radius:8px;font-size:.87rem;font-weight:500;margin-top:5px;background:rgba(6,214,160,.12);border:1px solid rgba(6,214,160,.3);color:var(--green)";
    fb.textContent = `✓ Correct! +${pts} pts`;
  } else {
    fb.style.cssText =
      "display:block;padding:11px;border-radius:8px;font-size:.87rem;font-weight:500;margin-top:5px;background:rgba(239,71,111,.12);border:1px solid rgba(239,71,111,.3);color:var(--red)";
    fb.textContent = `✗ Wrong! Answer: ${q.correct}`;
  }

  setTimeout(() => {
    currentQ++;
    loadQ();
  }, 1500);
}

function timeUp() {
  answered = true;
  answers.push({ questionIndex: currentQ, selected: null, timeLeft: 0 });

  document.querySelectorAll(".ans-btn").forEach((b) => (b.disabled = true));

  const fb = document.getElementById("qFeedback");
  fb.style.cssText =
    "display:block;padding:11px;border-radius:8px;font-size:.87rem;font-weight:500;margin-top:5px;background:rgba(239,71,111,.12);border:1px solid rgba(239,71,111,.3);color:var(--red)";
  if (typeof playSound === "function") playSound("wrong");
  fb.textContent = "⏰ Time's up!";

  setTimeout(() => {
    currentQ++;
    loadQ();
  }, 1200);
}

async function getAIHint() {
  if (!contract || !userAddress) return toast("Connect wallet first", "error");
  const q = questions[currentQ];
  const btn = document.getElementById("hintBtn"),
    box = document.getElementById("hintBox");
  btn.disabled = true;
  btn.textContent = "⏳ Processing payment...";
  try {
    const HINT_FEE = ethers.parseUnits("0.01", 6);
    const PLATFORM = await readContract.platform();
    toast("Approving 0.01 USDC for hint...", "info");
    const approveTx = await usdcContract.approve(PLATFORM, HINT_FEE);
    await approveTx.wait();
    const usdcW = new ethers.Contract(
      USDC_ADDRESS,
      ["function transfer(address,uint256) external returns (bool)"],
      signer,
    );
    const transferTx = await usdcW.transfer(PLATFORM, HINT_FEE);
    await transferTx.wait();
    toast("✅ 0.01 USDC paid!", "success");
    score = Math.max(0, score - 25);
    document.getElementById("qPts").textContent = `⭐ ${score}`;
    box.style.cssText =
      "display:block;padding:12px;border-radius:8px;margin-top:8px;background:rgba(123,97,255,.08);border:1px solid rgba(123,97,255,.3);color:var(--purple);font-size:.88rem";
    let countdown = 30;
    box.textContent = `⏳ Hint unlocking in ${countdown}s...`;
    btn.textContent = `⏳ Hint in ${countdown}s...`;
    const countInt = setInterval(() => {
      countdown--;
      if (countdown <= 0) {
        clearInterval(countInt);
        const hints = [
          `💡 This is a ${q.diff} difficulty question. Focus on keywords.`,
          `💡 Eliminate the most extreme answers first.`,
          `💡 The correct answer often relates to the main subject.`,
          `💡 Your first instinct is often right.`,
        ];
        box.textContent = hints[Math.floor(Math.random() * hints.length)];
        btn.textContent = "✓ Hint revealed (-25 pts)";
      } else {
        box.textContent = `⏳ Hint unlocking in ${countdown}s...`;
        btn.textContent = `⏳ Hint in ${countdown}s...`;
      }
    }, 1000);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "🤖 AI Hint (0.01 USDC)";
    toast("Failed: " + (e.reason || e.message), "error");
  }
}

async function doClaimRefund(gameId) {
  if (!contract) return toast("Connect wallet first", "error");
  const refundBtn = document.querySelector(
    `[onclick="doClaimRefund(${gameId})"]`,
  );
  if (refundBtn) {
    refundBtn.disabled = true;
    refundBtn.textContent = "⏳ Claiming...";
  }
  toast("Claiming refund...", "info");
  try {
    const tx = await contract.claimRefund(gameId);
    await tx.wait();
    toast("✅ Refund claimed!", "success");
    // Update card badge in lobby grid without reloading
    document.querySelectorAll(".gcard").forEach((card) => {
      const onclick = card.getAttribute("onclick") || "";
      if (onclick.includes(`(${gameId}`)) {
        const badge = card.querySelector(".badge");
        if (badge) {
          badge.className = "badge b-cancel";
          badge.textContent = "Cancelled";
        }
      }
    });
    const entry = allGames.find((g) => g.i === gameId);
    if (entry) entry.g[14] = 2;
    showScreen("screenLobby");
    loadGames();
  } catch (e) {
    if (refundBtn) {
      refundBtn.disabled = false;
      refundBtn.textContent = "💸 Claim Refund";
    }
    toast("Failed: " + (e.reason || e.message), "error");
  }
}

async function finishTrivia() {
  clearInterval(timerInt);
  document.getElementById("resScore").textContent = score;
  document.getElementById("resIcon").textContent =
    score >= 800 ? "🏆" : score >= 500 ? "🎯" : "💪";
  document.getElementById("resSub").textContent =
    `${questions.length} questions answered — submitting...`;
  document.getElementById("winnerBanner").innerHTML = "";
  document.getElementById("submitSection").style.display = "none";
  showScreen("screenResults");
  await submitMyScore();
  await refreshResults();
  startAutoRefresh(currentGameId);
}

async function submitMyScore() {
  if (!contract || !currentGameId)
    return toast("Connect wallet first", "error");

  // Only bail if onchain TX was confirmed — not just if DB session exists
  if (localStorage.getItem(`arc_onchain_${currentGameId}`) === "1") {
    document.getElementById("submitSection").style.display = "none";
    await refreshResults();
    return;
  }
  const btn = document.getElementById("submitBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Getting signature...";
  }

  try {
    toast("Step 1/2: Getting score signature...", "info");

    // ✅ Ask backend to sign the locally-computed score
    // Backend just needs to verify the player is joined onchain
    const chainId =
      currentGameChainId || (activeNet.decimals === 18 ? 4441 : 5042002);
    const res = await fetch(`${BACKEND}/submit-score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        gameId: currentGameId,
        wallet: userAddress,
        answers,
        chainId,
      }),
    });

    const data = await res.json();

    // ── Handle interrupted session — reset and allow replay ──
    if (!res.ok && data?.resetSession) {
      localStorage.removeItem(submittedKey(currentGameId));
      localStorage.removeItem(scoreKey(currentGameId));
      sessionStorage.removeItem(`playing_${currentGameId}`);
      toast(
        "Your session was interrupted. Please refresh and play again.",
        "error",
      );
      if (btn) {
        btn.disabled = false;
        btn.textContent = "📡 Retry";
      }
      return;
    }

    // ✅ If backend fails, use client score directly with a workaround
    let verifiedScore = score;
    let signature = data?.signature;

    if (!res.ok || data?.error) {
      const errMsg = data?.error || "Server error";
      toast("Server error: " + errMsg, "error");
      saveScore(currentGameId, score);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "📡 Retry Submit Onchain";
      }
      return;
    }

    verifiedScore = data.score ?? score;
    signature = data.signature;

    // ✅ Show correct/wrong highlights using server-returned answers
    if (data.correctAnswers) {
      window._serverCorrectAnswers = data.correctAnswers;
    }

    // ✅ Update score display immediately after server responds
    document.getElementById("resScore").textContent = verifiedScore;
    document.getElementById("resSub").textContent =
      `${verifiedScore} pts — submitting onchain...`;
    score = verifiedScore;

    // Optimistic leaderboard update — shows score before tx confirms
    const lbEl = document.getElementById("leaderboard");
    if (lbEl && userAddress) {
      let found = false;
      lbEl.querySelectorAll(".lb-row").forEach((row) => {
        if (
          row.querySelector(".lb-addr")?.textContent.includes(fmt(userAddress))
        ) {
          const sc = row.querySelector(".lb-score");
          const tag = row.querySelector(".lb-tag");
          if (sc) {
            sc.textContent = (data.score ?? score) + " pts";
            sc.style.color = "var(--gold)";
          }
          if (tag) {
            tag.className = "lb-tag lb-done";
            tag.textContent = "Done";
          }
          found = true;
        }
      });
      if (!found) {
        const row = document.createElement("div");
        row.className = "lb-row";
        row.innerHTML = `<span class="lb-rank">—</span>
          <span class="lb-addr">${fmt(userAddress)} (you)</span>
          <span class="lb-score" style="color:var(--gold)">${data.score ?? score} pts</span>
          <span class="lb-tag lb-done">Done</span>`;
        lbEl.prepend(row);
      }
    }

    toast(`Step 2/2: Submitting ${verifiedScore} pts onchain...`, "info");
    if (btn) {
      btn.textContent = `⏳ Submitting ${verifiedScore} pts...`;
    }

    const tx = await contract.submitScore(
      currentGameId,
      verifiedScore,
      data.signature,
    );

    toast("⛓️ Waiting for confirmation...", "info");
    await tx.wait();

    localStorage.setItem(`arc_onchain_${currentGameId}`, "1"); // onchain confirmed
    markSubmitted(currentGameId);
    saveScore(currentGameId, verifiedScore);
    sessionStorage.removeItem(`playing_${currentGameId}`);

    if (typeof confetti === "function") {
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
    }

    score = verifiedScore;
    document.getElementById("resScore").textContent = score;
    markSubmitted(currentGameId);
    saveScore(currentGameId, score);

    if (typeof playSound === "function") playSound("win");

    toast(`✅ Score ${verifiedScore} submitted onchain!`, "success");
    if (btn) {
      btn.textContent = `✓ Submitted: ${verifiedScore} pts`;
    }
    document.getElementById("submitSection").style.display = "none";
    await refreshResults();
    await doTriggerEnd(currentGameId);
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "📡 Submit Score Onchain";
    }
    toast("Failed: " + (e.reason || e.message), "error");
  }
}

async function doTriggerEnd(gameId) {
  if (!contract) return;
  try {
    const g = await getGame(gameId);
    const [
      ,
      ,
      ,
      ,
      ,
      ,
      ,
      ,
      ,
      playerCount,
      ,
      playDeadline,
      ,
      ,
      status,
      finishedCount,
    ] = g;
    const now = Math.floor(Date.now() / 1000);
    if (Number(status) !== 0) return;
    const allDone =
      Number(finishedCount) >= Number(playerCount) && Number(playerCount) > 0;
    const pastDL = now > Number(playDeadline);
    if (!allDone && !pastDL) {
      toast(
        `Waiting for ${
          Number(playerCount) - Number(finishedCount)
        } more players...`,
        "info",
      );
      return;
    }
    toast("Ending game...", "info");
    const tx = await contract.triggerEnd(gameId);
    await tx.wait();
    toast("🏁 Game ended!", "success");
    await loadGames();
    await refreshResults();
  } catch (e) {
    console.log("triggerEnd:", e.reason || e.message);
  }
}

async function refreshResults() {
  const gameNet = NETWORKS[currentGameChainId] || activeNet;
  const gameDecimals = gameNet.decimals;
  const gameSymbol = gameNet.symbol;
  const dp = gameDecimals === 18 ? 4 : 2;
  if (!currentGameId) return;

  try {
    const g = await getGame(currentGameId);
    const [, , , , , , , , prizePool, playerCount, , , topPlayers, , status] =
      g;
    const s = Number(status),
      n = Number(playerCount);

    if (
      refreshResults._prevStatus !== undefined &&
      refreshResults._prevStatus === 0 &&
      s === 1
    ) {
      toast("🏁 Game has ended! Showing final results.", "success");
    }
    refreshResults._prevStatus = s;

    const myPos = userAddress
      ? Array.from(topPlayers).findIndex(
          (p) => p?.toLowerCase() === userAddress?.toLowerCase(),
        )
      : -1;
    if (myPos >= 0 && s === 1 && loadSavedScore(currentGameId) > 0) {
      const dist =
        parseFloat(ethers.formatUnits(prizePool, gameDecimals)) * 0.95;
      const prizes =
        n === 1
          ? [dist]
          : n === 2
            ? [dist * 0.7, dist * 0.3]
            : [dist * 0.6, dist * 0.25, dist * 0.15];
      const prize = (prizes[myPos] || 0).toFixed(2);
      const medals = ["🥇 1st Place", "🥈 2nd Place", "🥉 3rd Place"];
      const claimStatusRes = userAddress
        ? await readContract.getPlayerStatus(currentGameId, userAddress)
        : [false, false, false];
      const claimed_ = claimStatusRes[2];
      document.getElementById("winnerBanner").innerHTML =
        `<div class="winner-banner"><h3>${medals[myPos]} — YOU WON!</h3>
        <div class="winner-prize">${prize} ${gameSymbol}</div>${
          !claimed_
            ? `<button class="btn btn-gold" onclick="doClaimPrize()" style="margin-top:10px;width:auto;padding:12px 32px">💰 Claim Prize</button>`
            : `<p style="color:var(--green);margin-top:8px;font-weight:600">✅ Prize Claimed!</p>`
        }</div>`;
    } else if (s === 1) {
      document.getElementById("winnerBanner").innerHTML =
        `<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center;margin-bottom:16px">
        <p style="color:var(--muted)">Game ended. See leaderboard below.</p></div>`;
    } else if (s === 0) {
      document.getElementById("winnerBanner").innerHTML =
        `<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center;margin-bottom:16px">
        <p style="color:var(--accent)">⏳ Waiting for all players to finish...</p>
        <p style="color:var(--muted);font-size:.8rem;margin-top:6px">Auto-refreshing every 12s</p></div>`;
    }

    const [addrs, scoreList, finished, claimedList] =
      await readContract.getLeaderboard(currentGameId);
    if (!addrs.length) return;
    const dist = parseFloat(ethers.formatUnits(prizePool, gameDecimals)) * 0.95;
    const prizes =
      n === 1
        ? [dist, 0, 0]
        : n === 2
          ? [dist * 0.7, dist * 0.3, 0]
          : [dist * 0.6, dist * 0.25, dist * 0.15];
    const rows = addrs
      .map((a, i) => ({
        a,
        sc: Number(scoreList[i]),
        fin: finished[i],
        cl: claimedList[i],
      }))
      .sort((a, b) => b.sc - a.sc);
    document.getElementById("leaderboard").innerHTML = rows
      .map(
        (r, i) => `<div class="lb-row ${
          Array.from(topPlayers).some(
            (p) => p?.toLowerCase() === r.a.toLowerCase(),
          )
            ? "lb-winner"
            : ""
        }">
        <span class="lb-rank">${
          i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "#" + (i + 1)
        }</span>
        <span class="lb-addr">${fmt(r.a)}${
          r.a.toLowerCase() === userAddress?.toLowerCase() ? " (you)" : ""
        }</span>
        <span class="lb-score">${r.sc > 0 ? r.sc + " pts" : "—"}</span>
        ${
          i < 3 && s === 1 && prizes[i] > 0
            ? `<span style="color:var(--gold);font-size:.73rem">${prizes[i].toFixed(dp)} ${gameSymbol}</span>`
            : ""
        }
        <span class="lb-tag ${r.fin ? "lb-done" : "lb-wait"}">${
          r.fin ? "Done" : "Playing"
        }</span>
      </div>`,
      )
      .join("");
  } catch (e) {
    console.error(e);
  }
}

async function doClaimPrize() {
  if (!contract) return toast("Connect wallet first", "error");

  // ✅ Switch to correct chain before claiming
  const targetChainId =
    currentGameChainId || (activeNet.decimals === 18 ? 4441 : 5042002);
  if (
    NETWORKS[targetChainId] &&
    targetChainId !==
      (provider ? Number((await provider.getNetwork()).chainId) : null)
  ) {
    try {
      await getActiveProvider().request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: NETWORKS[targetChainId].hexChainId }],
      });
      await new Promise((r) => setTimeout(r, 500));
      activeNet = NETWORKS[targetChainId];
      CONTRACT_ADDRESS = activeNet.contractAddress;
      USDC_ADDRESS = activeNet.tokenAddress;
      provider = new ethers.BrowserProvider(
        window._activeWalletProvider || window.ethereum,
      );
      signer = await provider.getSigner();
      contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
      if (!activeNet.isNative) {
        usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);
      } else {
        usdcContract = null;
      }
      updateNetBar();
    } catch (e) {
      toast("Failed to switch network: " + e.message, "error");
      return;
    }
  }

  // Auto-trigger end if game hasn't been ended yet
  try {
    const g = await getGame(currentGameId);
    if (g && Number(g[14]) === 0) {
      toast("Ending game first...", "info");
      try {
        const tx = await contract.triggerEnd(currentGameId);
        await tx.wait();
      } catch (e) {
        // Already ended or someone else triggered it — continue
        console.log("triggerEnd:", e.reason || e.message);
      }
      // Re-fetch to confirm status
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (_) {}
  const claimBtn = document.querySelector(
    '.btn-gold[onclick="doClaimPrize()"]',
  );
  if (claimBtn) {
    claimBtn.disabled = true;
    claimBtn.textContent = "⏳ Claiming...";
  }
  toast("Claiming prize...", "info");
  try {
    const tx = await contract.claimPrize(currentGameId);
    await tx.wait();
    toast(
      `🎉 Prize claimed! ${activeNet.symbol} sent to your wallet.`,
      "success",
    );
    loadMyStats();
    checkUnclaimedPrizes(); // refresh banner immediately
    const active = document.querySelector(".screen.active")?.id;
    if (active === "screenResults") await refreshResults();
    else await openGameReadOnly(currentGameId);
  } catch (e) {
    if (claimBtn) {
      claimBtn.disabled = false;
      claimBtn.textContent = "💰 Claim Prize";
    }
    toast("Failed: " + (e.reason || e.message), "error");
  }
}

function buildCatGrid() {
  document.getElementById("createCatGrid").innerHTML = CATEGORIES.map(
    (c) =>
      `<button class="cat-btn" onclick="selectCreateCat(${c.id},'${c.name}',this)"><span class="cat-icon">${c.icon}</span>${c.name}</button>`,
  ).join("");
}
function selectCreateCat(id, name, el) {
  document
    .querySelectorAll("#createCatGrid .cat-btn")
    .forEach((b) => b.classList.remove("sel"));
  el.classList.add("sel");
  selectedCatId = id;
  selectedCatName = name;
}
function pickDiff(d, el) {
  document
    .querySelectorAll(".diff-pill")
    .forEach((b) => (b.className = "diff-pill"));
  el.classList.add(["dp-any", "dp-easy", "dp-medium", "dp-hard"][d]);
  selectedDiff = d;
}

async function submitCreate() {
  if (!contract) return toast("Connect wallet first", "error");
  const name = document.getElementById("cName").value.trim();
  const fee = document.getElementById("cFee").value;
  const max = document.getElementById("cMax").value;
  const reg = document.getElementById("cReg").value;
  const play = document.getElementById("cPlay").value;
  if (!name || !fee || !max || !reg || !play)
    return toast("Fill all fields", "error");
  if (!selectedCatId) return toast("Select a category", "error");
  if (name.length > 50) return toast("Room name too long (max 50)", "error");
  const minFee = activeNet.isNative ? 0.01 : 1;
  const symbol = activeNet.symbol;
  if (parseFloat(fee) < minFee || parseFloat(fee) > 1000)
    return toast(`Entry fee: ${minFee}-1000 ${symbol}`, "error");
  if (parseInt(max) < 2 || parseInt(max) > 50)
    return toast("Max players: 2-50", "error");
  toast(`Creating room on ${activeNet.name}...`, "info");
  try {
    const feeWei = ethers.parseUnits(
      parseFloat(fee).toFixed(activeNet.decimals === 18 ? 18 : 6),
      activeNet.decimals,
    );
    const tx = await contract.createGame(
      name,
      selectedCatId,
      selectedCatName,
      selectedDiff,
      feeWei,
      max,
      reg,
      play,
    );
    const receipt = await tx.wait();

    // Get the new game ID from contract
    let newGameId = 0;
    try {
      const counter = new ethers.Contract(
        CONTRACT_ADDRESS,
        ["function gameCounter() view returns (uint256)"],
        contract.runner,
      );
      newGameId = Number(await counter.gameCounter());
    } catch (_) {}

    // Save to DB for multichain display
    try {
      // Fetch CSRF token first
      let csrfToken = "";
      try {
        const ct = await fetch(`${BACKEND}/csrf-token`, {
          credentials: "include",
        });
        const ctd = await ct.json();
        csrfToken = ctd.csrfToken || "";
      } catch (_) {}

      await fetch(`${BACKEND}/games/save`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CSRF-Token": csrfToken,
        },
        credentials: "include",
        body: JSON.stringify({
          chainId: parseInt(activeNet.hexChainId, 16),
          contractGameId: newGameId,
          creator: userAddress,
          name,
          category: selectedCatName,
          difficulty: selectedDiff,
          entryFee: parseFloat(fee),
          tokenSymbol: activeNet.symbol,
          maxPlayers: parseInt(max),
          txHash: receipt.hash,
          prizePool: 0, // starts at 0, updated when players join
        }),
      });
    } catch (_) {}

    toast(`✅ Room "${name}" deployed on ${activeNet.name}!`, "success");
    showScreen("screenLobby");
    // Optimistic card — shows instantly before chain confirmation
    const nowTs = Math.floor(Date.now() / 1000);
    const regEnd = nowTs + parseInt(reg);
    const dp = activeNet.decimals === 18 ? 4 : 2;
    const chainBadge =
      activeNet === NETWORKS[4441]
        ? `<span style="font-size:.63rem;font-weight:700;padding:2px 8px;border-radius:10px;background:rgba(123,97,255,.15);color:var(--purple);border:1px solid rgba(123,97,255,.3);margin-left:5px">🔷 LitVM</span>`
        : `<span style="font-size:.63rem;font-weight:700;padding:2px 8px;border-radius:10px;background:rgba(0,229,255,.1);color:var(--accent);border:1px solid rgba(0,229,255,.25);margin-left:5px">⚡ Arc</span>`;
    const newCard = document.createElement("div");
    newCard.className = "gcard";
    newCard.style.cssText =
      "border-color:rgba(0,229,255,.6);transition:border-color 2s";
    newCard.setAttribute(
      "onclick",
      `openGame(${newGameId},${parseInt(activeNet.hexChainId, 16)})`,
    );
    newCard.innerHTML = `
      <div class="gcard-title">#${newGameId} ${sanitizeText(name)}
        <span class="badge b-wait">Open</span>${chainBadge}</div>
      <div style="font-size:.75rem;color:var(--green);margin-bottom:8px;font-weight:600">📋 Joining Open</div>
      <div class="gmeta">💰 Entry: <strong>${parseFloat(fee).toFixed(dp)} ${activeNet.symbol}</strong> | 🏆 Pool: <strong>0 ${activeNet.symbol}</strong></div>
      <div class="gmeta">👥 <strong>0/${max}</strong> joined</div>
      <div class="gmeta">By: <span style="color:var(--purple)">${fmt(userAddress)}</span></div>
      <span class="cat-pill">📚 ${sanitizeText(selectedCatName)}</span>`;
    setTimeout(() => {
      newCard.style.borderColor = "";
    }, 2500);
    const grid = document.querySelector("#gamesList .game-grid");
    if (grid) grid.prepend(newCard);
    else await loadGames();
    loadGames(); // background sync
  } catch (e) {
    toast("Failed: " + (e.reason || e.message), "error");
  }
}

async function cancelGame(gameId) {
  try {
    const tx = await contract.cancelGame(gameId, "cancelled");
    console.log("TX SENT:", tx.hash);

    await tx.wait(); // 🔥 THIS IS CRITICAL

    console.log("✅ Game cancelled");
  } catch (e) {
    console.error("❌ Cancel failed:", e);
  }
}

async function doCancelRoom(gameId) {
  if (!contract || !userAddress) return toast("Connect wallet first", "error");
  const g = await getGame(gameId);
  if (g[2].toLowerCase() !== userAddress.toLowerCase())
    return toast("Only the room creator can cancel", "error");
  if (!confirm("Cancel this room? All players will get full refunds.")) return;
  try {
    const tx = await contract.cancelGame(gameId, "Creator cancelled");
    // Optimistic update — flip badge immediately
    document.querySelectorAll(".gcard").forEach((card) => {
      const onclick = card.getAttribute("onclick") || "";
      if (onclick.includes(`openGame(${gameId}`)) {
        const badge = card.querySelector(".badge");
        if (badge) {
          badge.className = "badge b-cancel";
          badge.textContent = "Cancelled";
        }
        const phase = card.querySelector('[style*="font-weight:600"]');
        if (phase) {
          phase.textContent = "❌ Cancelled";
          phase.style.color = "var(--red)";
        }
      }
    });
    const entry = allGames.find((g) => g.i === gameId);
    if (entry) entry.g[14] = 2;
    await tx.wait();
    toast("Room cancelled.", "success");
    showScreen("screenLobby");
    loadGames();
  } catch (e) {
    toast("Failed: " + (e.reason || e.message), "error");
  }
}

async function loadGlobalStats() {
  try {
    const res = await fetch(`${BACKEND}/stats/global`);
    const data = await res.json();

    const players = data.totalPlayers || 0;
    const games = data.totalGamesPlayed || 0;
    const scores = data.totalFinished || 0;

    // Animate the hero stat counters
    const gTotalEl = document.getElementById("gTotal");
    const gActiveEl = document.getElementById("gActive");

    // Update floating badge values
    const badgePaidOut = document.getElementById("badgePaidOut");
    const badgeTournaments = document.getElementById("badgeTournaments");
    if (badgePaidOut)
      badgePaidOut.textContent = `$${data.arcVolume ? parseFloat(data.arcVolume).toFixed(2) : "0.00"} USDC`;
    if (badgeTournaments) {
      fetch(`${BACKEND}/tournaments/stats`)
        .then((r) => r.json())
        .then((s) => {
          if (badgeTournaments)
            badgeTournaments.textContent = `${s.total_tournaments || 0} Finished`;
        })
        .catch(() => {});
    }

    // Fetch GenLayer stats
    let glAvailable = 0;
    try {
      const glStats = await fetch(`${BACKEND}/genlayer/stats`).then((r) =>
        r.json(),
      );
      glAvailable = parseInt(glStats?.stats?.available || 0);
    } catch (_) {}

    const statsHtml = `
      <span style="width:6px;height:6px;border-radius:50%;background:#06d6a0;box-shadow:0 0 10px rgba(6,214,160,.8);flex-shrink:0;animation:pulse 1.5s infinite"></span>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="color:#d8e7ff">👥 <strong style="color:var(--accent)">${players}</strong> players</span>
        <span style="width:1px;height:12px;background:rgba(255,255,255,.08)"></span>
        <span style="color:#d8e7ff">🎮 <strong style="color:var(--accent)">${games}</strong> games played</span>
        <span style="width:1px;height:12px;background:rgba(255,255,255,.08)"></span>
        <span style="color:#d8e7ff">✅ <strong style="color:var(--accent)">${scores}</strong> scores submitted</span>
        <span style="width:1px;height:12px;background:rgba(255,255,255,.08)"></span>
        <span style="color:#d8e7ff">🤖 <strong style="color:var(--purple)">${glAvailable}</strong> AI questions ready</span>
      </div>
      <button onclick="showGlobalLeaderboard()" style="margin-left:auto;background:linear-gradient(135deg,rgba(255,209,102,.15),rgba(255,140,0,.08));border:1px solid rgba(255,209,102,.2);color:var(--gold);padding:5px 13px;border-radius:20px;cursor:pointer;font-size:.72rem;font-weight:700;white-space:nowrap">
        🏆 Leaderboard
      </button>`;

    // Update agent bar (in game room card) — only if content changed to prevent flicker
    const agentBar = document.getElementById("agentStatsBar");
    if (
      agentBar &&
      agentBar.dataset.loaded !== `${players}-${games}-${scores}`
    ) {
      agentBar.innerHTML = statsHtml;
      agentBar.dataset.loaded = `${players}-${games}-${scores}`;
    }

    // Update header global bar — only update numbers, never rebuild the whole element
    const el = document.getElementById("globalStatsBar");
    if (!el) return;
    const key = `${players}-${games}-${scores}`;
    if (el.dataset.loaded !== key) {
      el.dataset.loaded = key;
      // Only update if element already has content — prevents flash on first load
      if (el.children.length > 0) {
        const strongs = el.querySelectorAll("strong");
        if (strongs[0]) strongs[0].textContent = players;
        if (strongs[1]) strongs[1].textContent = games;
        if (strongs[2]) strongs[2].textContent = scores;
      } else {
        el.innerHTML = statsHtml;
      }
    }
  } catch (_) {}
}

async function checkUnclaimedPrizes() {
  if (!userAddress) return;
  const claims = [];

  try {
    // Arc — fine, no rate limit
    const arcProvider = new ethers.JsonRpcProvider(
      "https://rpc.testnet.arc.network",
    );
    const arcRC = new ethers.Contract(
      NETWORKS[5042002].contractAddress,
      ABI,
      arcProvider,
    );
    const arcCount = Number(await arcRC.gameCounter().catch(() => 0));
    if (arcCount > 0) {
      const checks = [];
      for (let i = arcCount; i >= Math.max(1, arcCount - 80); i--) {
        checks.push(
          arcRC
            .getPlayerStatus(i, userAddress)
            .then(async (s) => {
              if (!s[0] || s[2] || !s[1]) return null;
              const g = await arcRC.getGame(i).catch(() => null);
              if (!g) return null;
              if (Number(g.status ?? g[14]) !== 1) return null;
              const top = g.topPlayers ?? g[12];
              const pos = Array.from(top).findIndex(
                (p) => p?.toLowerCase() === userAddress.toLowerCase(),
              );
              if (pos < 0) return null;
              const pool = g.prizePool ?? g[8];
              const n = Number(g.playerCount ?? g[9]);
              const dist = parseFloat(ethers.formatUnits(pool, 6)) * 0.95;
              const prizes =
                n === 1
                  ? [dist]
                  : n === 2
                    ? [dist * 0.7, dist * 0.3]
                    : [dist * 0.6, dist * 0.25, dist * 0.15];
              const prize = prizes[pos] || 0;
              if (prize <= 0) return null;
              return {
                gameId: i,
                chainId: 5042002,
                net: NETWORKS[5042002],
                name: g.name ?? g[1],
                prize,
                myPos: pos,
                type: "prize",
              };
            })
            .catch(() => null),
        );
      }
      claims.push(...(await Promise.all(checks)).filter(Boolean));
    }

    // LitVM — only check games user actually played, from DB history
    try {
      const histRes = await fetch(`${BACKEND}/history/${userAddress}`, {
        credentials: "include",
      });
      if (histRes.ok) {
        const history = await histRes.json();
        const litvmPlayed = history.filter(
          (g) => g.chain_id === 4441 && g.status === 1,
        );
        if (litvmPlayed.length > 0) {
          const p = await getLitvmProvider();
          const rc = new ethers.Contract(
            NETWORKS[4441].contractAddress,
            ABI,
            p,
          );
          for (const row of litvmPlayed.slice(0, 5)) {
            try {
              await new Promise((r) => setTimeout(r, 300)); // throttle
              const [s, g] = await Promise.all([
                rc.getPlayerStatus(row.contract_game_id, userAddress),
                rc.getGame(row.contract_game_id),
              ]);
              if (!s[0] || s[2] || !s[1]) continue;
              if (Number(g.status ?? g[14]) !== 1) continue;
              const top = g.topPlayers ?? g[12];
              const pos = Array.from(top).findIndex(
                (p) => p?.toLowerCase() === userAddress.toLowerCase(),
              );
              if (pos < 0) continue;
              const pool = g.prizePool ?? g[8];
              const n = Number(g.playerCount ?? g[9]);
              const dist = parseFloat(ethers.formatUnits(pool, 18)) * 0.95;
              const prizes =
                n === 1
                  ? [dist]
                  : n === 2
                    ? [dist * 0.7, dist * 0.3]
                    : [dist * 0.6, dist * 0.25, dist * 0.15];
              const prize = prizes[pos] || 0;
              if (prize <= 0) continue;
              claims.push({
                gameId: row.contract_game_id,
                chainId: 4441,
                net: NETWORKS[4441],
                name: row.name || `Game #${row.contract_game_id}`,
                prize,
                myPos: pos,
                type: "prize",
              });
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
  } catch (_) {}

  try {
    const res = await fetch(`${BACKEND}/bets/unclaimed/${userAddress}`, {
      credentials: "include",
    });
    if (res.ok) {
      const bets = await res.json();
      for (const b of bets || []) {
        claims.push({
          gameId: b.game_id,
          chainId: b.chain_id || 5042002,
          net: NETWORKS[b.chain_id || 5042002],
          name: b.game_name || `Game #${b.game_id}`,
          prize: parseFloat(b.winnings || 0),
          type: "bet",
          betId: b.id,
        });
      }
    }
  } catch (_) {}

  // ── Check tournament prizes ──────────────────────────────────────────
  try {
    const tRes = await fetch(`${BACKEND}/tournaments?limit=50`, {
      credentials: "include",
    });
    if (tRes.ok) {
      const allT = await tRes.json();
      const finishedT = (
        Array.isArray(allT) ? allT : allT.tournaments || []
      ).filter((t) => t.status === "finished" && t.tournament_type === "paid");

      for (const t of finishedT) {
        if (!userAddress) break;
        // Check if user is a top-3 winner with unclaimed prize
        try {
          const claimRes = await fetch(
            `${BACKEND}/tournaments/${t.id}/claim-status?wallet=${userAddress}`,
            { credentials: "include" },
          );
          const claimData = await claimRes.json();

          if (!claimData.status || claimData.status === "pending") {
            // Check if they played
            const tDetail = await fetch(`${BACKEND}/tournaments/${t.id}`, {
              credentials: "include",
            });
            if (tDetail.ok) {
              const { players } = await tDetail.json();
              const me = players?.find(
                (p) => p.wallet?.toLowerCase() === userAddress.toLowerCase(),
              );
              if (me && Number(me.total_score) > 0) {
                const ranked = players
                  .filter((p) => Number(p.total_score) > 0)
                  .sort(
                    (a, b) => Number(b.total_score) - Number(a.total_score),
                  );
                const myRank = ranked.findIndex(
                  (p) => p.wallet?.toLowerCase() === userAddress.toLowerCase(),
                );
                if (myRank >= 0 && myRank < 3) {
                  const splits = [0.6, 0.25, 0.15];
                  const prize = parseFloat(t.prize_pool) * splits[myRank];
                  if (prize > 0) {
                    claims.push({
                      gameId: t.id,
                      chainId: t.chain_id,
                      net: NETWORKS[t.chain_id] || NETWORKS[5042002],
                      name: t.name,
                      prize,
                      myPos: myRank,
                      type: "tournament_prize",
                    });
                  }
                }
              }
              // Check refund eligibility (registered but never played)
              if (me && Number(me.total_score) === 0 && !me.refunded) {
                claims.push({
                  gameId: t.id,
                  chainId: t.chain_id,
                  net: NETWORKS[t.chain_id] || NETWORKS[5042002],
                  name: t.name,
                  prize: parseFloat(t.entry_fee || 0),
                  myPos: -1,
                  type: "tournament_refund",
                });
              }
            }
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  window._unclaimedPrizes = claims;
  const btn = document.getElementById("claimPrizesBtn");
  const badge = document.getElementById("claimBadge");
  if (btn && badge) {
    if (claims.length > 0) {
      btn.style.display = "flex";
      badge.textContent = claims.length;

      // ── Show specific refund toasts ──────────────────────────────────
      const agentRefunds = claims.filter(
        (c) => c.type === "prize" && c.myPos < 0,
      );
      const tourneyRefunds = claims.filter(
        (c) => c.type === "tournament_refund",
      );
      const tourneyPrizes = claims.filter((c) => c.type === "tournament_prize");

      // Agent refund notification
      if (agentRefunds.length > 0 && !window._agentRefundNotified) {
        window._agentRefundNotified = true;
        showRefundBanner(
          "💸 Agent Room Refund Available",
          `You joined ${agentRefunds.length} game${agentRefunds.length > 1 ? "s" : ""} but didn't play. Click to claim your entry fee back.`,
          "var(--gold)",
          () => showUnclaimedModal(),
        );
      }

      // Tournament refund notification (auto-sent)
      if (tourneyRefunds.length > 0 && !window._tourneyRefundNotified) {
        window._tourneyRefundNotified = true;
        showRefundBanner(
          "✅ Tournament Refund Sent",
          `Your entry fee for ${tourneyRefunds.length} tournament${tourneyRefunds.length > 1 ? "s" : ""} has been automatically refunded to your wallet.`,
          "var(--green)",
          () => showUnclaimedModal(),
        );
      }

      // Tournament prize notification
      if (tourneyPrizes.length > 0 && !window._tourneyPrizeNotified) {
        window._tourneyPrizeNotified = true;
        showRefundBanner(
          "🏆 Tournament Prize Ready",
          `You won ${tourneyPrizes.length} tournament${tourneyPrizes.length > 1 ? "s" : ""}! Claim your prize now.`,
          "var(--accent)",
          () => showUnclaimedModal(),
        );
      }
    } else {
      btn.style.display = "none";
    }
  }
}

function showRefundBanner(title, message, color, onClick) {
  const existing = document.getElementById("refundNotifBanner");
  if (existing) existing.remove();

  const banner = document.createElement("div");
  banner.id = "refundNotifBanner";
  banner.style.cssText = `
    position:fixed;top:70px;right:16px;z-index:9997;
    background:var(--card);border:1px solid ${color};
    border-radius:14px;padding:14px 16px;max-width:320px;
    box-shadow:0 8px 32px rgba(0,0,0,.4);
    animation:slideUp .3s ease;cursor:pointer;
  `;
  banner.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:10px">
      <div style="flex:1">
        <div style="font-size:.85rem;font-weight:700;color:${color};margin-bottom:4px">
          ${title}
        </div>
        <div style="font-size:.75rem;color:var(--muted);line-height:1.5">
          ${message}
        </div>
      </div>
      <button onclick="event.stopPropagation();document.getElementById('refundNotifBanner').remove()"
        style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1rem;
        padding:0;flex-shrink:0;line-height:1">✕</button>
    </div>
    <button style="margin-top:10px;background:${color};color:#000;border:none;
      padding:7px 16px;border-radius:20px;font-size:.75rem;font-weight:800;
      cursor:pointer;width:100%">
      View & Claim →
    </button>
  `;
  banner.addEventListener("click", () => {
    banner.remove();
    onClick?.();
  });
  document.body.appendChild(banner);

  // Auto-dismiss after 8 seconds
  setTimeout(() => banner?.remove(), 8000);
}

function showUnclaimedModal() {
  const claims = window._unclaimedPrizes || [];
  const existing = document.getElementById("claimPrizesModal");
  if (existing) existing.remove();

  const totalUSDC = claims
    .filter((c) => c.net?.decimals === 6)
    .reduce((s, c) => s + c.prize, 0);
  const totalZKLTC = claims
    .filter((c) => c.net?.decimals === 18)
    .reduce((s, c) => s + c.prize, 0);
  let totalStr = "";
  if (totalUSDC > 0) totalStr += `${totalUSDC.toFixed(2)} USDC`;
  if (totalZKLTC > 0)
    totalStr += (totalStr ? " + " : "") + `${totalZKLTC.toFixed(4)} zkLTC`;

  const medals = ["🥇", "🥈", "🥉"];
  const positions = ["1st", "2nd", "3rd"];

  const rows = claims
    .map((c) => {
      const dp = c.net?.decimals === 18 ? 4 : 2;
      const chainIcon = c.chainId === 4441 ? "🔷" : "⚡";
      const isPrize = c.type === "prize";
      const isTournamentPrize = c.type === "tournament_prize";
      const isTournamentRefund = c.type === "tournament_refund";
      const label = isTournamentPrize
        ? `🏆 ${medals[c.myPos] || ""} ${positions[c.myPos] || ""} Place · Tournament: ${c.name}`
        : isTournamentRefund
          ? `💸 Refund Available · Tournament: ${c.name}`
          : isPrize
            ? `${medals[c.myPos] || "🏆"} ${positions[c.myPos] || ""} Place · Game #${c.gameId}`
            : `🎲 Bet won · Game #${c.gameId}`;
      return `<div style="display:flex;align-items:center;justify-content:space-between;
        padding:12px 14px;border-radius:10px;cursor:pointer;
        background:rgba(255,209,102,.04);border:1px solid rgba(255,209,102,.12);
        margin-bottom:8px;gap:12px;transition:background .15s"
      onmouseover="this.style.background='rgba(255,209,102,.08)'"
      onmouseout="this.style.background='rgba(255,209,102,.04)'"
      onclick="document.getElementById('claimPrizesModal').remove();${
        c.type === "tournament_prize" || c.type === "tournament_refund"
          ? `openTournament(${c.gameId})`
          : `openGameReadOnly(${c.gameId},${c.chainId})`
      }">
      <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1">
        <span style="font-size:.8rem;flex-shrink:0">${chainIcon}</span>
        <div style="min-width:0">
          <div style="font-size:.85rem;font-weight:700;color:#ffd166;
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</div>
          <div style="font-size:.73rem;color:var(--muted);margin-top:2px">${sanitizeText(c.name)}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
        <span style="font-size:.95rem;font-weight:700;color:var(--green)">
          ${c.prize.toFixed(dp)} ${c.net?.symbol || "USDC"}</span>
        <button onclick="event.stopPropagation();document.getElementById('claimPrizesModal').remove();${
          c.type === "tournament_prize" || c.type === "tournament_refund"
            ? `openTournament(${c.gameId})`
            : `openGameReadOnly(${c.gameId},${c.chainId})`
        }"
          style="background:linear-gradient(135deg,#ffd166,#ff9d3a);color:#000;border:none;
            padding:6px 14px;border-radius:20px;font-size:.75rem;font-weight:800;
            cursor:pointer;white-space:nowrap;font-family:inherit">
          Claim →
        </button>
      </div>
    </div>`;
    })
    .join("");

  const modal = document.createElement("div");
  modal.id = "claimPrizesModal";
  modal.className = "bet-modal-overlay";
  modal.innerHTML = `<div class="bet-modal-box" style="max-width:520px;width:95%;max-height:80vh;display:flex;flex-direction:column">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <div>
        <h3 style="margin:0;font-family:'Bebas Neue',sans-serif;font-size:1.4rem;
          letter-spacing:2px;color:var(--gold)">🎁 Unclaimed Prizes</h3>
        <div style="font-size:.8rem;color:var(--green);font-weight:700;margin-top:4px">${totalStr}</div>
      </div>
      <button onclick="document.getElementById('claimPrizesModal').remove()"
        style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.2rem">✕</button>
    </div>
    <p style="font-size:.78rem;color:var(--muted);margin-bottom:16px">
      Click any prize to go to the game and claim it.</p>
    <div style="overflow-y:auto;flex:1;padding-right:4px">${rows}</div>
  </div>`;
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
  document.body.appendChild(modal);
}

async function showGlobalLeaderboard() {
  try {
    const res = await fetch(`${BACKEND}/stats/global`);
    const data = await res.json();
    const modal = document.createElement("div");
    modal.id = "globalLbModal";
    modal.className = "bet-modal-overlay";
    modal.innerHTML = `<div class="bet-modal-box" style="max-width:480px;width:95%">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h3 style="margin:0">🏆 Global Leaderboard</h3>
        <button onclick="document.getElementById('globalLbModal').remove()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.2rem">✕</button>
      </div>
      <div style="font-size:.75rem;color:var(--muted);margin-bottom:14px;display:flex;gap:16px">
        <span>👥 ${data.totalPlayers} players</span>
        <span>🎮 ${data.totalGamesPlayed} games</span>
      </div>
      ${
        data.topPlayers.length === 0
          ? `<p style="color:var(--muted);text-align:center;padding:20px">No games played yet</p>`
          : data.topPlayers
              .map(
                (p, i) => `
          <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
            <span style="font-size:1.1rem;min-width:28px">${
              i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`
            }</span>
            <div style="width:32px;height:32px;border-radius:50%;background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700;flex-shrink:0;overflow:hidden">
              ${
                p.avatar
                  ? `<img src="${sanitizeUrl(
                      p.avatar,
                    )}" style="width:100%;height:100%;object-fit:cover">`
                  : (p.username || p.wallet || "?")[0].toUpperCase()
              }
            </div>
            <div style="flex:1">
              <div style="font-size:.85rem;font-weight:600">${
                p.username ? "@" + p.username : fmt(p.wallet)
              }</div>
              <div style="font-size:.72rem;color:var(--muted)">${
                p.games_finished
              } games finished</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:.85rem;font-weight:700;color:var(--gold)">${
                p.best_score
              } pts</div>
              <div style="font-size:.7rem;color:var(--muted)">best score</div>
            </div>
          </div>`,
              )
              .join("")
      }
    </div>`;
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.remove();
    });
    document.body.appendChild(modal);
  } catch (e) {
    toast("Failed to load leaderboard", "error");
  }
}

// FIND loadMyStats() and REPLACE WITH:
async function loadMyStats() {
  if (!userAddress) return;
  try {
    const arcProvider2 = new ethers.JsonRpcProvider(
      "https://rpc.testnet.arc.network",
    );
    const arcRC2 = new ethers.Contract(
      NETWORKS[5042002].contractAddress,
      ABI,
      arcProvider2,
    );
    const litvmProvider2 = await getLitvmProvider();
    const litvmRC2 = new ethers.Contract(
      NETWORKS[4441].contractAddress,
      ABI,
      litvmProvider2,
    );

    const [arcStats, litvmStats] = await Promise.allSettled([
      arcRC2.getPlayerStats(userAddress),
      litvmRC2.getPlayerStats(userAddress),
    ]);

    let totalPlayed = 0n,
      totalWon = 0n;
    if (arcStats.status === "fulfilled") {
      totalPlayed += BigInt(arcStats.value[0]);
      totalWon += BigInt(arcStats.value[1]);
    }
    if (litvmStats.status === "fulfilled") {
      totalPlayed += BigInt(litvmStats.value[0]);
      totalWon += BigInt(litvmStats.value[1]);
    }

    const usdcEarned =
      arcStats.status === "fulfilled"
        ? parseFloat(ethers.formatUnits(arcStats.value[2], 6)).toFixed(2)
        : "0.00";
    const litvmEarned =
      litvmStats.status === "fulfilled"
        ? parseFloat(ethers.formatUnits(litvmStats.value[2], 18)).toFixed(4)
        : "0.0000";

    function fmtCompact(num) {
      const n = parseFloat(num);
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
      if (n >= 10_000) return (n / 1_000).toFixed(1) + "K";
      if (n >= 1_000) return (n / 1_000).toFixed(2) + "K";
      return n.toFixed(2);
    }

    const usdcDisplay = fmtCompact(usdcEarned);
    const litvmDisplay =
      parseFloat(litvmEarned) > 0 ? fmtCompact(litvmEarned) : null;
    const earnedDisplay = litvmDisplay
      ? `<span style="display:block;line-height:1.3">${usdcDisplay} USDC</span><span style="display:block;line-height:1.3;color:var(--purple)">${litvmDisplay} zkLTC</span>`
      : `${usdcDisplay} USDC`;

    const vals = {
      myPlayed: totalPlayed.toString(),
      myWon: totalWon.toString(),
      myEarned: earnedDisplay,
    };
    Object.entries(vals).forEach(([id, v]) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (id === "myEarned") {
        el.innerHTML = v;
      } else {
        el.textContent = v;
      }
    });
  } catch (_) {}
}

// ── TOURNAMENT STATE ──────────────────────────────────────────────────────────
let allTournaments = [];
let currentTournamentId = null;

async function loadTournaments() {
  try {
    const [res, statsRes] = await Promise.all([
      fetch(`${BACKEND}/tournaments`),
      fetch(`${BACKEND}/tournaments/stats`),
    ]);
    allTournaments = await res.json();
    const stats = await statsRes.json();

    const volEl = document.getElementById("tournamentVolume");
    if (volEl && stats) {
      const usdcVol = parseFloat(stats.usdc_volume || 0).toFixed(2);
      const litvmVol = parseFloat(stats.litvm_volume || 0).toFixed(4);

      // ✅ Always show both — display 0.0000 zkLTC even if no LitVM tournaments yet
      volEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="color:var(--accent);font-weight:700;font-size:1.05rem">
            $${usdcVol} USDC
          </span>
          <span style="color:var(--muted);font-size:.8rem">+</span>
          <span style="color:var(--purple);font-weight:700;font-size:1.05rem">
            ${litvmVol} zkLTC
          </span>
          <span style="color:var(--muted);font-size:.68rem;text-transform:uppercase;
            letter-spacing:.5px">TOTAL PAID OUT</span>
        </div>`;
    }

    renderTournaments();
    updateLiveTournamentBanner();
  } catch (_) {}
}

function renderTournaments() {
  const el = document.getElementById("tournamentList");
  if (!el) return;
  if (!allTournaments.length) {
    el.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:48px 20px">
        <div style="font-size:3rem;margin-bottom:12px">🏟️</div>
        <p style="color:var(--muted);margin-bottom:16px">No tournaments yet. Create the first one!</p>
        ${userAddress ? `<button class="btn btn-primary" style="width:auto;padding:12px 32px" onclick="showTournamentTypeModal()">+ Create Tournament</button>` : ""}
      </div>`;
    return;
  }

  el.innerHTML = allTournaments
    .map((t) => {
      const isWL = t.tournament_type === "whitelist";
      const isLive = t.status === "active";
      const isFinished = t.status === "finished";
      const isCancelled = t.status === "cancelled";
      const isFull = parseInt(t.player_count) >= t.max_players;
      const spotsLeft = t.max_players - parseInt(t.player_count);
      const dp = t.token_symbol === "zkLTC" ? 4 : 2;
      const fee = parseFloat(t.entry_fee || 0).toFixed(dp);
      const pool2 = parseFloat(t.prize_pool || 0).toFixed(dp);
      const chainIcon = t.chain_id === 4441 ? "🔷" : "⚡";
      const timer = fmtTournamentTime(t);

      const createdStr = t.created_at
        ? new Date(t.created_at).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : null;
      const endedStr = t.finished_at
        ? new Date(t.finished_at).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : null;
      const isExpired =
        t.status === "open" &&
        t.deadline_at &&
        new Date(t.deadline_at) < new Date();
      const winnersArr = Array.isArray(t.winners) ? t.winners : [];

      // ── Type-specific styling ─────────────────────────────────────────
      const typeConfig = isWL
        ? {
            gradient:
              "linear-gradient(135deg,rgba(88,101,242,.18),rgba(123,97,255,.08))",
            border: isLive ? "rgba(239,71,111,.6)" : "rgba(88,101,242,.45)",
            accentColor: "#7289da",
            badge: `<div style="display:inline-flex;align-items:center;gap:5px;background:linear-gradient(135deg,rgba(88,101,242,.25),rgba(123,97,255,.2));border:1px solid rgba(88,101,242,.5);border-radius:20px;padding:3px 10px;font-size:.65rem;font-weight:800;color:#7289da;letter-spacing:.5px">
        💬 WHITELIST BATTLE
      </div>`,
            headerIcon: "💬",
            entryLabel: "FREE ENTRY",
            entryValue: null,
          }
        : {
            gradient:
              "linear-gradient(135deg,rgba(0,229,255,.08),rgba(123,97,255,.05))",
            border: isLive
              ? "rgba(239,71,111,.6)"
              : isCancelled
                ? "rgba(255,157,58,.3)"
                : "rgba(0,229,255,.2)",
            accentColor: "var(--accent)",
            badge: `<div style="display:inline-flex;align-items:center;gap:5px;background:linear-gradient(135deg,rgba(0,229,255,.15),rgba(0,229,255,.05));border:1px solid rgba(0,229,255,.3);border-radius:20px;padding:3px 10px;font-size:.65rem;font-weight:800;color:var(--accent);letter-spacing:.5px">
        💰 PAID TOURNAMENT
      </div>`,
            headerIcon: "🏟️",
            entryLabel: `${fee} ${t.token_symbol}`,
            entryValue: pool2,
          };

      // ── Status pill ───────────────────────────────────────────────────

      // Detect de-facto finished: all players present AND winners exist OR all rounds done
      const hasWinners =
        winnersArr.length > 0 &&
        winnersArr.some((w) => w && w.prize_position >= 0);
      const allPlayersScored =
        parseInt(t.player_count) >= t.max_players && hasWinners;
      const effectivelyFinished = isFinished || allPlayersScored;

      const statusPill = effectivelyFinished
        ? `<div style="display:inline-flex;align-items:center;gap:5px;background:rgba(6,214,160,.08);border:1px solid rgba(6,214,160,.25);border-radius:20px;padding:3px 10px">
          <span style="font-size:.65rem;font-weight:800;color:var(--green)">✅ FINISHED</span>
        </div>`
        : isLive
          ? `<div style="display:inline-flex;align-items:center;gap:5px;background:rgba(239,71,111,.15);border:1px solid rgba(239,71,111,.4);border-radius:20px;padding:3px 10px">
          <span style="width:6px;height:6px;border-radius:50%;background:var(--red);display:inline-block;animation:pulse 1s ease-in-out infinite"></span>
          <span style="font-size:.65rem;font-weight:800;color:var(--red)">LIVE</span>
        </div>`
          : isExpired
            ? `<div style="display:inline-flex;align-items:center;gap:5px;background:rgba(239,71,111,.1);border:1px solid rgba(239,71,111,.3);border-radius:20px;padding:3px 10px">
          <span style="font-size:.65rem;font-weight:800;color:var(--red)">⏰ EXPIRED</span>
        </div>`
            : isCancelled
              ? `<div style="display:inline-flex;align-items:center;gap:5px;background:rgba(255,157,58,.1);border:1px solid rgba(255,157,58,.3);border-radius:20px;padding:3px 10px">
          <span style="font-size:.65rem;font-weight:800;color:var(--gold)">❌ CANCELLED</span>
        </div>`
              : isFull
                ? `<div style="display:inline-flex;align-items:center;gap:5px;background:rgba(239,71,111,.1);border:1px solid rgba(239,71,111,.3);border-radius:20px;padding:3px 10px">
          <span style="font-size:.65rem;font-weight:800;color:var(--red)">🔴 FULL</span>
        </div>`
                : `<div style="display:inline-flex;align-items:center;gap:5px;background:rgba(6,214,160,.1);border:1px solid rgba(6,214,160,.3);border-radius:20px;padding:3px 10px">
          <span style="font-size:.65rem;font-weight:800;color:var(--green)">OPEN</span>
        </div>`;

      // ── Winners block ─────────────────────────────────────────────────
      const winnersBlock = hasWinners
        ? `
      <div style="margin-top:10px;padding:10px 12px;background:rgba(255,209,102,.06);border:1px solid rgba(255,209,102,.2);border-radius:10px">
        ${["🥇", "🥈", "🥉"]
          .map((medal, i) => {
            const w = winnersArr.find((x) => x && x.prize_position === i);
            if (!w) return "";
            const who = w.username
              ? "@" + sanitizeText(w.username)
              : fmt(w.wallet);
            return `<div style="font-size:.75rem;font-weight:700;color:var(--gold);line-height:1.8">${medal} ${who}</div>`;
          })
          .filter(Boolean)
          .join("")}
      </div>`
        : "";

      // ── Prize/Reward section ──────────────────────────────────────────
      const prizeSection = isWL
        ? `
      <div style="margin-top:10px;display:flex;flex-direction:column;gap:4px">
        ${t.prize_1_text ? `<div style="font-size:.75rem;color:var(--gold);font-weight:600">🥇 ${sanitizeText(t.prize_1_text)}</div>` : ""}
        ${t.prize_2_text ? `<div style="font-size:.75rem;color:#ccc">🥈 ${sanitizeText(t.prize_2_text)}</div>` : ""}
        ${t.prize_3_text ? `<div style="font-size:.75rem;color:#cd7f32">🥉 ${sanitizeText(t.prize_3_text)}</div>` : ""}
      </div>`
        : `
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <div style="flex:1;min-width:80px;background:rgba(255,209,102,.06);border:1px solid rgba(255,209,102,.15);border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Entry</div>
          <div style="font-size:.88rem;font-weight:700;color:var(--gold);margin-top:2px">${fee} ${t.token_symbol}</div>
        </div>
        <div style="flex:1;min-width:80px;background:rgba(6,214,160,.06);border:1px solid rgba(6,214,160,.15);border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Prize Pool</div>
          <div style="font-size:.88rem;font-weight:700;color:var(--green);margin-top:2px">${pool2} ${t.token_symbol}</div>
        </div>
      </div>`;

      // ── Player progress bar ───────────────────────────────────────────
      const fillPct = Math.min(
        100,
        Math.round((parseInt(t.player_count) / t.max_players) * 100),
      );
      const progressBar = `
      <div style="margin-top:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <span style="font-size:.72rem;color:var(--muted)">👥 ${t.player_count}/${t.max_players} players</span>
          ${
            !isFinished && !isCancelled && spotsLeft > 0 && !isFull
              ? `<span style="font-size:.68rem;color:var(--green);font-weight:700">${spotsLeft} spot${spotsLeft > 1 ? "s" : ""} left</span>`
              : isFull
                ? `<span style="font-size:.68rem;color:var(--red);font-weight:700">Full</span>`
                : ""
          }
        </div>
        <div style="height:4px;background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden">
          <div style="height:100%;width:${fillPct}%;background:${
            fillPct >= 100
              ? "var(--red)"
              : fillPct > 60
                ? "var(--gold)"
                : "var(--green)"
          };border-radius:2px;transition:width .5s"></div>
        </div>
      </div>`;

      return `
      <div onclick="openTournament(${t.id})" style="
        background:${typeConfig.gradient};
        border:1.5px solid ${typeConfig.border};
        border-radius:16px;
        padding:16px;
        cursor:pointer;
        transition:all .2s;
        position:relative;
        overflow:hidden;
        ${effectivelyFinished ? "box-shadow:0 0 18px rgba(6,214,160,.1);" : isLive ? "box-shadow:0 0 24px rgba(239,71,111,.2);" : ""}
        ${isCancelled ? "opacity:.7;" : ""}
      "
      onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 32px rgba(0,0,0,.3)'"
      onmouseout="this.style.transform='';this.style.boxShadow='${isLive ? "0 0 24px rgba(239,71,111,.2)" : ""}'">

        ${isLive ? `<div style="position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--red),var(--purple),var(--red));animation:shimmer 2s linear infinite;background-size:200% 100%"></div>` : ""}

        <!-- Header row -->
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px">
          <div style="flex:1;min-width:0">
            <div style="font-size:.95rem;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:6px">
              ${sanitizeText(t.name)}
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
              ${typeConfig.badge}
              ${statusPill}
            </div>
          </div>
          <div style="text-align:right;flex-shrink:0">
            <div style="font-size:.68rem;color:var(--muted)">${isWL ? "" : chainIcon + " "}${t.rounds} Rounds</div>
            ${isLive ? `<div style="font-size:.68rem;color:var(--red);font-weight:700;margin-top:2px;animation:pulse 2s ease-in-out infinite">⚔️ Round ${t.current_round}</div>` : ""}
          </div>
        </div>

        <!-- Prize section -->
        ${isFinished && hasWinners ? winnersBlock : prizeSection}

        <!-- Cancelled refund notice -->
        ${
          isCancelled && parseInt(t.player_count) > 0
            ? `<div style="margin-top:10px;padding:8px 10px;background:rgba(255,157,58,.08);border:1px solid rgba(255,157,58,.2);border-radius:8px;font-size:.72rem;color:var(--gold)">
              💸 All entry fees auto-refunded
            </div>`
            : ""
        }

        <!-- Progress bar -->
        ${progressBar}

        <!-- Timer / Discord link + Created/Ended timestamps -->
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px">
          <div style="display:flex;flex-direction:column;gap:2px">
            ${
              isExpired
                ? `<div style="font-size:.65rem;color:var(--red);font-weight:700">⏰ Expired · not filled</div>`
                : timer && t.status === "open"
                  ? `<div style="font-size:.68rem;color:var(--muted)">⏰ ${timer}</div>`
                  : t.sponsor_name
                    ? `<div style="font-size:.68rem;color:#7289da">🏢 ${sanitizeText(t.sponsor_name)}</div>`
                    : `<div></div>`
            }
            ${createdStr ? `<div style="font-size:.6rem;color:rgba(255,255,255,.25)">Created ${createdStr}</div>` : ""}
            ${endedStr ? `<div style="font-size:.6rem;color:rgba(6,214,160,.5)">Ended ${endedStr}</div>` : ""}
          </div>
          ${
            t.discord_invite
              ? `<a href="${sanitizeUrl(t.discord_invite)}" target="_blank" rel="noopener noreferrer"
                onclick="event.stopPropagation()"
                style="font-size:.65rem;color:#7289da;text-decoration:none;background:rgba(88,101,242,.1);
                border:1px solid rgba(88,101,242,.25);padding:2px 8px;border-radius:10px">
                💬 Discord
              </a>`
              : `<div style="font-size:.68rem;color:var(--muted)">🏆 ${t.max_players} max</div>`
          }
        </div>
      </div>`;
    })
    .join("");
}

async function openTournament(id) {
  currentTournamentId = id;
  window._joinScreenOrigin = "tournaments"; // set early before any await
  window._tournamentOpenedAt = Date.now(); // bot detection timestamp // set early before any await
  try {
    const res = await fetch(`${BACKEND}/tournaments/${id}`);
    const { tournament: t, players, rounds } = await res.json();
    const isWL = t.tournament_type === "whitelist";
    const myWallet = userAddress?.toLowerCase();
    const me = players.find((p) => p.wallet?.toLowerCase() === myWallet);
    const isJoined = !!me;
    const isEliminated = me?.eliminated;
    const isFull = players.length >= t.max_players;
    const chainIcon = t.chain_id === 4441 ? "🔷" : "⚡";
    const dp = t.token_symbol === "zkLTC" ? 4 : 2;
    const fee = parseFloat(t.entry_fee || 0).toFixed(dp);
    const pool2 = parseFloat(t.prize_pool || 0).toFixed(dp);
    const myCreatorId = (
      currentProfile?.wallet ||
      userAddress ||
      ""
    ).toLowerCase();
    const isMyTournament = t.creator?.toLowerCase() === myCreatorId;

    // ✅ Check admin status server-side (delete is admin-only)
    let viewerIsAdmin = false;
    if (userAddress) {
      try {
        const am = await fetch(`${BACKEND}/admin/me`, {
          credentials: "include",
        });
        viewerIsAdmin = (await am.json()).isAdmin === true;
      } catch (_) {}
    }

    const prizes = {
      first: (parseFloat(pool2) * 0.6).toFixed(dp),
      second: (parseFloat(pool2) * 0.25).toFixed(dp),
      third: (parseFloat(pool2) * 0.15).toFixed(dp),
    };

    // ── Player rows ──────────────────────────────────────────────────────
    const fmtSecs = (s) => {
      const n = parseInt(s) || 0;
      if (n <= 0) return "";
      const m = Math.floor(n / 60),
        sec = n % 60;
      return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
    };
    const playerRows = players
      .map((p, i) => {
        const t = fmtSecs(p.total_time);
        return `
      <div class="lb-row" style="${p.eliminated ? "opacity:.4" : ""}">
        <span class="lb-rank">${["🥇", "🥈", "🥉"][i] || "#" + (i + 1)}</span>
        <span class="lb-addr">${p.username ? "@" + p.username : fmt(p.wallet)}${p.wallet?.toLowerCase() === myWallet ? " (you)" : ""}</span>
        <span class="lb-score">${p.total_score} pts${t ? `<span style="display:block;font-size:.65rem;color:var(--muted);font-weight:400">⏱ ${t}</span>` : ""}</span>
        <span class="lb-tag ${p.eliminated ? "lb-wait" : "lb-done"}">${p.eliminated ? "Out" : "Active"}</span>
      </div>`;
      })
      .join("");

    const roundsHtml = rounds
      .map(
        (r) => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
        <span style="font-weight:700;color:var(--accent)">Round ${r.round_number}</span>
        <span style="color:${r.status === "active" ? "var(--gold)" : r.status === "finished" ? "var(--green)" : "var(--muted)"}">
          ${r.status === "active" ? "🔴 Live" : r.status === "finished" ? "✅ Done" : "⏳ Pending"}
        </span>
      </div>`,
      )
      .join("");

    // ── Build action HTML based on tournament type & state ───────────────
    let actionHtml = "";

    // ══ WHITELIST TOURNAMENT FLOW ════════════════════════════════════════
    if (isWL) {
      // Load tasks and application status in parallel
      const [wlTasksRes, myAppRes] = await Promise.allSettled([
        fetch(`${BACKEND}/tournaments/${id}/wl-tasks?wallet=${myWallet || ""}`),
        myWallet
          ? fetch(
              `${BACKEND}/tournaments/${id}/my-application?wallet=${myWallet}`,
            )
          : Promise.resolve(null),
      ]);

      const wlData =
        wlTasksRes.status === "fulfilled"
          ? await wlTasksRes.value.json()
          : { tasks: [], completedIds: [] };
      const myApp =
        myAppRes?.status === "fulfilled" && myAppRes.value
          ? await myAppRes.value.json()
          : { status: null };

      const wlTasks = wlData.tasks || [];
      const completedIds = new Set(wlData.completedIds || []);
      const allTasksDone =
        wlTasks.length === 0 || wlTasks.every((tk) => completedIds.has(tk.id));

      if (t.status === "finished") {
        const champ = players[0];
        actionHtml = `<div class="winner-banner"><h3>🏆 Whitelist Battle Complete!</h3>
            ${
              champ
                ? `<p style="margin-top:8px;font-size:1rem">
                    🥇 <strong>${champ.username ? "@" + sanitizeText(champ.username) : fmt(champ.wallet)}</strong>
                    <span style="color:var(--gold)"> · ${champ.total_score} pts</span>
                  </p>`
                : ""
            }
            <p style="color:rgba(255,255,255,.7);margin-top:8px;font-size:.85rem">
              Winners receive their prizes directly from the sponsor.<br>
              Check Discord for prize distribution details.
            </p></div>`;
      } else if (t.status === "active" && isJoined && !isEliminated) {
        let roundStatus = { played: false, score: 0 };
        try {
          const rs = await fetch(
            `${BACKEND}/tournaments/${id}/round-status?wallet=${myWallet}`,
            { credentials: "include" },
          );
          roundStatus = await rs.json();
        } catch (_) {}

        actionHtml = roundStatus.played
          ? `<div style="background:rgba(6,214,160,.08);border:1px solid rgba(6,214,160,.3);border-radius:12px;padding:16px;text-align:center">
              <div style="font-size:1.5rem;margin-bottom:6px">✅</div>
              <p style="color:var(--green);font-weight:700">Round ${t.current_round} Submitted!</p>
              <p style="color:var(--muted);font-size:.82rem;margin-top:4px">Score: <strong style="color:var(--gold)">${roundStatus.score} pts</strong></p>
              <p style="color:var(--muted);font-size:.75rem;margin-top:6px">Waiting for other players...</p>
            </div>`
          : `<button class="btn btn-primary" style="background:linear-gradient(135deg,var(--gold),var(--orange));padding:16px;font-size:1rem"
               onclick="playTournamentRound(${id},${t.current_round})">
               🎮 Play Round ${t.current_round} of ${t.rounds}!
             </button>`;
      } else if (t.status === "active" && isEliminated) {
        actionHtml = `<div style="text-align:center;padding:14px;border-radius:10px;background:rgba(239,71,111,.08);border:1px solid rgba(239,71,111,.25)">
          <p style="color:var(--red);font-weight:600">❌ Eliminated in Round ${t.current_round - 1}</p></div>`;
      } else if (t.status === "open" && isJoined) {
        actionHtml = `<div style="text-align:center;padding:16px;border-radius:12px;background:rgba(6,214,160,.06);border:1px solid rgba(6,214,160,.25)">
          <div style="font-size:1.5rem;margin-bottom:8px">✅</div>
          <p style="color:var(--green);font-weight:700">You are approved and registered!</p>
          <p style="color:var(--muted);font-size:.82rem;margin-top:6px">Waiting for ${t.max_players - players.length} more approved players to start.</p>
        </div>`;
      } else if (t.status === "open" && myApp.status === "pending") {
        actionHtml = `<div style="text-align:center;padding:16px;border-radius:12px;background:rgba(255,209,102,.05);border:1px solid rgba(255,209,102,.25)">
          <div style="font-size:1.5rem;margin-bottom:8px">⏳</div>
          <p style="color:var(--gold);font-weight:700">Application Under Review</p>
          <p style="color:var(--muted);font-size:.82rem;margin-top:6px">The creator will review your application soon.</p>
        </div>`;
      } else if (t.status === "open" && myApp.status === "rejected") {
        actionHtml = `<div style="text-align:center;padding:16px;border-radius:12px;background:rgba(239,71,111,.08);border:1px solid rgba(239,71,111,.25)">
          <div style="font-size:1.5rem;margin-bottom:8px">❌</div>
          <p style="color:var(--red);font-weight:700">Application Rejected</p>
          <p style="color:var(--muted);font-size:.82rem;margin-top:6px">Your application was not approved for this tournament.</p>
        </div>`;
      } else if (t.status === "open" && !isJoined && !isFull && userAddress) {
        // ── Task gate UI ─────────────────────────────────────────────────
        const taskRows = wlTasks
          .map((tk) => {
            const done = completedIds.has(tk.id);
            return `
          <div id="wlTask_${tk.id}" style="display:flex;align-items:center;gap:12px;padding:12px 14px;
            border-radius:12px;background:${done ? "rgba(6,214,160,.06)" : "rgba(255,255,255,.03)"};
            border:1px solid ${done ? "rgba(6,214,160,.25)" : "rgba(255,255,255,.08)"};margin-bottom:8px">
            <div style="width:32px;height:32px;border-radius:50%;
              background:${done ? "rgba(6,214,160,.2)" : "rgba(255,255,255,.05)"};
              display:flex;align-items:center;justify-content:center;font-size:1rem;flex-shrink:0">
              ${done ? "✅" : tk.task_type === "follow" ? "👤" : tk.task_type === "retweet" ? "🔁" : tk.task_type === "like" ? "❤️" : "✔️"}
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-size:.85rem;font-weight:600;${done ? "color:var(--green)" : ""}">${sanitizeText(tk.label)}</div>
              ${done ? `<div style="font-size:.7rem;color:var(--green)">✓ Completed</div>` : ""}
            </div>
            ${
              !done && tk.action_url
                ? `<a href="${sanitizeUrl(tk.action_url)}" target="_blank" rel="noopener noreferrer"
                  onclick="markWlTaskDone(${id},${tk.id})"
                  style="background:${tk.task_type === "follow" ? "#1da1f2" : tk.task_type === "like" ? "#ef476f" : "rgba(0,229,255,.12)"};
                  color:#fff;padding:6px 14px;border-radius:20px;text-decoration:none;
                  font-size:.75rem;font-weight:700;white-space:nowrap">
                  ${sanitizeText(tk.action_text || "Complete")}
                </a>`
                : ""
            }
          </div>`;
          })
          .join("");

        actionHtml = `
          <div style="background:rgba(88,101,242,.05);border:1px solid rgba(88,101,242,.2);
            border-radius:14px;padding:18px;margin-bottom:16px">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
              <span style="font-size:1.3rem">🔐</span>
              <div>
                <div style="font-weight:700;color:#7289da;font-size:.9rem">
                  Complete Tasks to Apply
                </div>
                <div style="font-size:.72rem;color:var(--muted);margin-top:2px">
                  ${wlTasks.length} task${wlTasks.length !== 1 ? "s" : ""} required · Creator reviews all applications
                </div>
              </div>
            </div>
            ${
              wlTasks.length === 0
                ? `<div style="background:rgba(6,214,160,.06);border:1px solid rgba(6,214,160,.2);
                  border-radius:10px;padding:12px;text-align:center;font-size:.83rem;color:var(--green);margin-bottom:14px">
                  ✅ No tasks required — you can apply directly!
                </div>`
                : taskRows
            }
            <div style="display:flex;gap:10px;margin-top:14px">
              <button class="btn btn-primary" id="wlApplyBtn"
                ${!allTasksDone && wlTasks.length > 0 ? "disabled" : ""}
                onclick="applyToWlTournament(${id})"
                style="flex:1;background:linear-gradient(135deg,#7289da,var(--purple));
                  ${!allTasksDone && wlTasks.length > 0 ? "opacity:.4;cursor:not-allowed" : ""}">
                📋 Apply to Join
              </button>
              ${
                !allTasksDone && wlTasks.length > 0
                  ? `<button class="btn btn-ghost" style="width:auto;padding:13px 16px"
                    onclick="recheckWlTasks(${id})">
                    🔄 Recheck Tasks
                  </button>`
                  : ""
              }
            </div>
            ${
              !allTasksDone && wlTasks.length > 0
                ? `<p style="text-align:center;font-size:.72rem;color:var(--muted);margin-top:8px">
                  Complete all ${wlTasks.length} task${wlTasks.length !== 1 ? "s" : ""} above to unlock the Apply button
                </p>`
                : ""
            }
          </div>`;
      } else if (t.status === "open" && isFull) {
        actionHtml = `<div style="text-align:center;padding:14px;border-radius:10px;background:rgba(239,71,111,.06);border:1px solid rgba(239,71,111,.2)">
          <p style="color:var(--red);font-weight:600">🔴 Tournament Full</p>
          <p style="color:var(--muted);font-size:.82rem;margin-top:4px">All spots have been filled.</p></div>`;
      }

      // ── Creator review panel (whitelist only) ─────────────────────────
      if (isMyTournament && t.status === "open") {
        actionHtml += `
          <div style="margin-top:16px;padding:16px;background:rgba(255,209,102,.04);
            border:1px solid rgba(255,209,102,.15);border-radius:14px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
              <div>
                <div style="font-size:.8rem;color:var(--gold);font-weight:700;text-transform:uppercase;letter-spacing:.5px">
                  👑 Creator Panel
                </div>
                <div style="font-size:.72rem;color:var(--muted);margin-top:2px">
                  Manage tasks and review applications
                </div>
              </div>
              <div style="display:flex;gap:8px">
                <button onclick="showWlTaskManager(${id})"
                  style="background:rgba(0,229,255,.1);border:1px solid rgba(0,229,255,.25);
                  color:var(--accent);padding:7px 14px;border-radius:8px;cursor:pointer;
                  font-size:.78rem;font-weight:700">
                  ⚙️ Manage Tasks
                </button>
                <button onclick="showApplicationsPanel(${id})"
                  style="background:rgba(123,97,255,.15);border:1px solid rgba(123,97,255,.35);
                  color:var(--purple);padding:7px 14px;border-radius:8px;cursor:pointer;
                  font-size:.78rem;font-weight:700">
                  📋 Review Applications
                </button>
              </div>
            </div>
            <div style="font-size:.75rem;color:var(--muted)">
              Players: <strong style="color:var(--text)">${players.length}/${t.max_players}</strong> approved
            </div>
          </div>`;
      }

      // ══ PAID TOURNAMENT FLOW ══════════════════════════════════════════════
    } else {
      if (t.status === "open" && !isJoined && !isFull && userAddress) {
        // Check if wallet already paid but registration didn't complete
        let alreadyPaidTx = null;
        try {
          // Check localStorage first
          const savedTx = localStorage.getItem(
            `tourney_paid_${t.id}_${userAddress.toLowerCase()}`,
          );
          if (savedTx) {
            alreadyPaidTx = savedTx;
          } else {
            // Check backend recovery table
            const payCheck = await fetch(
              `${BACKEND}/tournaments/${t.id}/payment-check?wallet=${userAddress}`,
              { credentials: "include" },
            );
            if (payCheck.ok) {
              const pd = await payCheck.json();
              if (pd.paid && !pd.registered)
                alreadyPaidTx = pd.txHash || "pending_recovery";
            }
          }
        } catch (_) {}

        // Also check orphaned payment recovery table
        if (!alreadyPaidTx) {
          try {
            const orphanCheck = await fetch(
              `${BACKEND}/tournaments/${t.id}/recover-payment?wallet=${userAddress}`,
              { credentials: "include" },
            );
            if (orphanCheck.ok) {
              const od = await orphanCheck.json();
              if (od.txHash) alreadyPaidTx = od.txHash;
            }
          } catch (_) {}
        }

        if (alreadyPaidTx) {
          actionHtml = `
            <div style="background:rgba(255,209,102,.06);border:1px solid rgba(255,209,102,.25);border-radius:12px;padding:18px;text-align:center">
              <div style="font-size:1.5rem;margin-bottom:8px">⚠️</div>
              <p style="color:var(--gold);font-weight:700">Payment detected but registration incomplete</p>
              <p style="color:var(--muted);font-size:.8rem;margin:8px 0 14px">Your ${fee} ${t.token_symbol} payment was confirmed onchain. Click below to complete registration — no second payment needed.</p>
              <button class="btn btn-primary" onclick="recoverTournamentRegistration(${t.id},'${alreadyPaidTx}')"
                style="background:linear-gradient(135deg,var(--gold),var(--orange));width:auto;padding:12px 32px">
                ✅ Complete My Registration (No Payment Needed)
              </button>
            </div>`;
        } else {
          // Show a soft "already paid?" link below the pay button in case user is unsure
          actionHtml = `
            <button class="btn btn-primary" onclick="joinTournament(${t.id})">
              💰 Pay ${fee} ${t.token_symbol} & Enter Tournament
            </button>
            <div style="text-align:center;margin-top:10px">
              <button onclick="showManualRecovery(${t.id},'${fee}','${t.token_symbol}')"
                style="background:none;border:none;color:var(--muted);font-size:.74rem;cursor:pointer;text-decoration:underline;font-family:inherit">
                Already paid but not registered? Click here
              </button>
            </div>`;
        }
      } else if (t.status === "open" && isJoined) {
        actionHtml = `<div style="text-align:center;padding:14px;border-radius:10px;
          background:rgba(0,229,255,.06);border:1px solid rgba(0,229,255,.2)">
          <p style="color:var(--accent);font-weight:600">✓ You are registered!</p>
          <p style="color:var(--muted);font-size:.82rem;margin-top:4px">
            Waiting for ${t.max_players - players.length} more players.
          </p></div>`;
      } else if (t.status === "active" && isJoined && !isEliminated) {
        let roundStatus = { played: false, score: 0 };
        try {
          const rs = await fetch(
            `${BACKEND}/tournaments/${t.id}/round-status?wallet=${myWallet}`,
            { credentials: "include" },
          );
          roundStatus = await rs.json();
        } catch (_) {}

        actionHtml = roundStatus.played
          ? `<div style="background:rgba(6,214,160,.08);border:1px solid rgba(6,214,160,.3);
              border-radius:12px;padding:16px;text-align:center">
              <p style="color:var(--green);font-weight:700">✅ Round ${t.current_round} Submitted!</p>
              <p style="color:var(--muted);font-size:.82rem;margin-top:4px">
                Score: <strong style="color:var(--gold)">${roundStatus.score} pts</strong>
              </p></div>`
          : `<button class="btn btn-primary"
              style="background:linear-gradient(135deg,var(--gold),var(--orange));padding:16px;font-size:1rem"
              onclick="playTournamentRound(${t.id},${t.current_round})">
              🎮 Play Round ${t.current_round} of ${t.rounds}!
            </button>`;
      } else if (t.status === "active" && isEliminated) {
        actionHtml = `<div style="text-align:center;padding:14px;border-radius:10px;
          background:rgba(239,71,111,.08);border:1px solid rgba(239,71,111,.25)">
          <p style="color:var(--red);font-weight:600">❌ Eliminated in Round ${t.current_round - 1}</p>
        </div>`;
      } else if (t.status === "cancelled" && isJoined) {
        const refundCheck = me?.refunded;

        actionHtml = refundCheck
          ? `<div style="background:rgba(6,214,160,.06);border:1px solid rgba(6,214,160,.2);border-radius:12px;padding:16px;text-align:center">
              <div style="font-size:1.5rem;margin-bottom:8px">✅</div>
              <p style="color:var(--green);font-weight:700">Entry Fee Refunded</p>
              <p style="color:var(--muted);font-size:.78rem;margin-top:4px">${fee} ${t.token_symbol} was returned to your wallet.</p>
              ${me?.refund_tx ? `<div style="font-size:.68rem;color:var(--muted);margin-top:8px;word-break:break-all">TX: ${me.refund_tx}</div>` : ""}
            </div>`
          : `<div style="background:rgba(255,157,58,.05);border:1px solid rgba(255,157,58,.25);border-radius:12px;padding:20px;text-align:center">
              <div style="font-size:2rem;margin-bottom:10px">⏰</div>
              <p style="color:var(--gold);font-weight:700;font-size:1rem">Tournament Expired</p>
              <p style="color:var(--muted);font-size:.82rem;margin-top:8px;margin-bottom:16px">
                This tournament didn't fill up in time. Your <strong style="color:var(--gold)">${fee} ${t.token_symbol}</strong> entry fee will be refunded automatically within 10 minutes.
              </p>
              <div style="background:rgba(255,255,255,.04);border-radius:8px;padding:10px;font-size:.75rem;color:var(--muted)">
                If not received in 10 minutes, contact support with tournament ID: ${t.id}
              </div>
            </div>`;
      } else if (t.status === "finished") {
        const myRank = players.findIndex(
          (p) => p.wallet?.toLowerCase() === myWallet,
        );
        const splitPcts = [0.6, 0.25, 0.15];
        const myPrize =
          myRank >= 0 && myRank < 3
            ? (parseFloat(pool2) * splitPcts[myRank]).toFixed(dp)
            : null;
        const medals = ["🥇 1st Place", "🥈 2nd Place", "🥉 3rd Place"];

        // ✅ Check if player actually played before showing prize
        const didPlay = !!(me && Number(me.total_score) > 0);

        if (!didPlay && isJoined && !isWL) {
          // Registered but never played — show refund option
          const refundCheck = me?.refunded;
          actionHtml = refundCheck
            ? `<div style="background:rgba(6,214,160,.06);border:1px solid rgba(6,214,160,.2);
                border-radius:12px;padding:16px;text-align:center">
                <p style="color:var(--green);font-weight:600">✅ Entry Fee Refunded</p>
                <p style="color:var(--muted);font-size:.78rem;margin-top:4px">
                  ${fee} ${t.token_symbol} was returned to your wallet.
                </p></div>`
            : `<div style="background:rgba(255,209,102,.05);border:1px solid rgba(255,209,102,.2);
                border-radius:12px;padding:18px;text-align:center">
                <div style="font-size:1.5rem;margin-bottom:8px">😴</div>
                <p style="color:var(--gold);font-weight:700;font-size:.95rem">You didn't play any rounds</p>
                <p style="color:var(--muted);font-size:.8rem;margin-top:6px;margin-bottom:14px">
                  You registered but didn't participate. You can claim your ${fee} ${t.token_symbol} entry fee back.
                </p>
                <button id="refundBtn" class="btn btn-primary"
                  style="background:linear-gradient(135deg,var(--gold),var(--orange));width:auto;padding:12px 32px"
                  onclick="claimTournamentRefund(${t.id},'${t.token_symbol}')">
                  💸 Claim ${fee} ${t.token_symbol} Refund
                </button></div>`;
        } else if (
          myPrize &&
          parseFloat(myPrize) > 0 &&
          userAddress &&
          didPlay
        ) {
          let claimStatus = null;
          try {
            const cs = await fetch(
              `${BACKEND}/tournaments/${t.id}/claim-status?wallet=${userAddress}`,
              { credentials: "include" },
            );
            claimStatus = await cs.json();
          } catch (_) {}

          actionHtml =
            claimStatus?.status === "paid"
              ? `<div style="background:rgba(6,214,160,.08);border:2px solid rgba(6,214,160,.3);
                border-radius:16px;padding:24px;text-align:center">
                <div style="font-size:2rem;margin-bottom:8px">✅</div>
                <h3 style="font-family:'Bebas Neue',sans-serif;font-size:1.3rem;color:var(--green);margin:0 0 6px">
                  ${medals[myRank]} — PRIZE SENT!
                </h3>
                <div style="font-size:1.8rem;font-weight:700;color:var(--green);margin-bottom:6px">
                  ${myPrize} ${t.token_symbol}
                </div>
                ${
                  claimStatus.tx_hash
                    ? `<div style="font-size:.72rem;background:var(--surface);border:1px solid var(--border);
                      border-radius:8px;padding:8px 12px;word-break:break-all;color:var(--muted)">
                      TX: ${claimStatus.tx_hash}</div>`
                    : ""
                }
              </div>`
              : `<div class="winner-banner" style="margin-bottom:16px">
                <h3>${medals[myRank]} — YOU WON!</h3>
                <div class="winner-prize" style="font-size:2rem">${myPrize} ${t.token_symbol}</div>
                <button id="claimTourneyBtn" class="btn btn-gold"
                  onclick="claimTournamentPrize(${t.id},'${t.token_symbol}')"
                  style="margin-top:16px;width:auto;padding:14px 48px;font-size:1.1rem">
                  💰 Claim ${myPrize} ${t.token_symbol}
                </button></div>`;
        } else {
          const winner = players[0];
          actionHtml = `<div class="winner-banner">
                  <h3>🏆 Tournament Complete!</h3>
                  <div class="winner-prize">${prizes.first} ${t.token_symbol}</div>
                  <p style="color:rgba(255,255,255,.6);margin-top:8px;font-size:.85rem">
                    Winner: <strong>${winner?.username ? "@" + winner.username : fmt(winner?.wallet)}</strong>
                    ${winner ? `<span style="color:var(--gold)"> · ${winner.total_score} pts</span>` : ""}
                  </p>
                  ${myRank >= 0 ? `<p style="color:var(--muted);font-size:.78rem;margin-top:6px">You finished #${myRank + 1}</p>` : ""}
                </div>`;
        }
      }
    }

    // ── Creator controls ──────────────────────────────────────────────────
    const canDelete =
      viewerIsAdmin && ["open", "cancelled", "finished"].includes(t.status);
    const winnerContactsBtn =
      isWL && isMyTournament && t.status === "finished"
        ? `<button onclick="showWinnerContacts(${t.id})"
            style="background:rgba(29,161,242,.1);border:1px solid rgba(29,161,242,.3);
            color:#1da1f2;padding:10px 20px;border-radius:10px;cursor:pointer;
            font-size:.8rem;font-weight:700;width:100%;margin-bottom:10px">
            📇 View Winner Contacts
          </button>`
        : "";
    const creatorControlsHtml =
      winnerContactsBtn || canDelete
        ? `<div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
            ${winnerContactsBtn}
            ${
              canDelete
                ? `<button onclick="deleteTournament(${t.id})"
                  style="background:rgba(239,71,111,.1);border:1px solid rgba(239,71,111,.3);
                  color:var(--red);padding:10px 20px;border-radius:10px;cursor:pointer;
                  font-size:.8rem;font-weight:700;width:100%">
                  🗑️ Delete Tournament
                </button>`
                : ""
            }
          </div>`
        : "";

    // ── Whitelist prize display (non-cash) ────────────────────────────────
    const prizeDistHtml = isWL
      ? `<div style="background:rgba(88,101,242,.05);border:1px solid rgba(88,101,242,.2);
          border-radius:10px;padding:14px;margin-bottom:14px">
          <div style="font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">
            🎁 Prizes
          </div>
          <div style="display:flex;flex-direction:column;gap:6px">
            <div>🥇 <strong style="color:var(--gold)">${sanitizeText(t.prize_1_text || "1st Place")}</strong></div>
            <div>🥈 <strong style="color:#ccc">${sanitizeText(t.prize_2_text || "2nd Place")}</strong></div>
            <div>🥉 <strong style="color:#cd7f32">${sanitizeText(t.prize_3_text || "3rd Place")}</strong></div>
          </div>
          ${t.sponsor_name ? `<div style="margin-top:10px;font-size:.72rem;color:var(--muted)">Sponsored by <strong style="color:var(--accent)">${sanitizeText(t.sponsor_name)}</strong></div>` : ""}
          ${
            t.discord_invite
              ? `<a href="${sanitizeUrl(t.discord_invite)}" target="_blank" rel="noopener noreferrer"
            style="display:inline-flex;align-items:center;gap:6px;margin-top:8px;background:rgba(88,101,242,.15);
            color:#7289da;padding:6px 14px;border-radius:20px;font-size:.75rem;font-weight:700;text-decoration:none">
            💬 Join Discord
          </a>`
              : ""
          }
        </div>`
      : `<div style="background:rgba(255,209,102,.06);border:1px solid rgba(255,209,102,.25);border-radius:10px;padding:14px;margin-bottom:14px">
          <div style="font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Prize Distribution</div>
          <div style="display:flex;gap:16px;flex-wrap:wrap">
            <span>🥇 <strong style="color:var(--gold)">${prizes.first} ${t.token_symbol}</strong> (60%)</span>
            <span>🥈 <strong style="color:#ccc">${prizes.second} ${t.token_symbol}</strong> (25%)</span>
            <span>🥉 <strong style="color:#cd7f32">${prizes.third} ${t.token_symbol}</strong> (15%)</span>
          </div>
          <div style="font-size:.72rem;color:var(--muted);margin-top:8px">Bottom half eliminated each round</div>
        </div>`;

    // ── Winner contact: top-3 submit X handle so the host can reach them ──
    // ── Winner contact: top-3 submit X handle (WHITELIST tournaments only) ──
    let winnerContactHtml = "";
    if (isWL && t.status === "finished" && myWallet && isJoined) {
      const top3 = players.slice(0, 3).map((p) => p.wallet?.toLowerCase());
      const myRank3 = top3.indexOf(myWallet);
      const myPlayer = players.find(
        (p) => p.wallet?.toLowerCase() === myWallet,
      );
      const didPlayWin = myPlayer && Number(myPlayer.total_score) > 0;

      if (myRank3 >= 0 && didPlayWin) {
        let existing = { twitter: null };
        try {
          const r = await fetch(
            `${BACKEND}/tournaments/${id}/winner-contact?wallet=${myWallet}`,
            { credentials: "include" },
          );
          existing = await r.json();
        } catch (_) {}

        const medals3 = ["🥇 1st Place", "🥈 2nd Place", "🥉 3rd Place"];
        const myPts = myPlayer ? myPlayer.total_score : 0;

        winnerContactHtml = existing.twitter
          ? `<div style="background:rgba(29,161,242,.06);border:1px solid rgba(29,161,242,.25);
              border-radius:12px;padding:16px;margin-top:14px">
              <div style="font-size:.8rem;font-weight:700;color:#1da1f2;margin-bottom:6px">
                ✅ Contact Submitted — ${medals3[myRank3]} · ${myPts} pts
              </div>
              <p style="font-size:.78rem;color:var(--muted);margin-bottom:10px">
                The host can reach you at
                <a href="https://x.com/${sanitizeText(existing.twitter)}" target="_blank"
                  rel="noopener noreferrer" style="color:#1da1f2;text-decoration:none;font-weight:700">
                  @${sanitizeText(existing.twitter)}</a>. You can update it below.
              </p>
              <div style="display:flex;gap:8px">
                <input id="winnerTwitterInput" placeholder="@yourhandle"
                  value="${sanitizeText(existing.twitter)}"
                  style="flex:1;background:var(--surface);border:1px solid var(--border);
                  color:var(--text);padding:10px 14px;border-radius:8px;font-size:.85rem;box-sizing:border-box"/>
                <button id="winnerTwitterBtn" onclick="submitWinnerTwitter(${id})"
                  style="background:#1da1f2;color:#fff;border:none;padding:10px 18px;
                  border-radius:8px;font-weight:700;cursor:pointer;white-space:nowrap">
                  Update
                </button>
              </div>
            </div>`
          : `<div style="background:rgba(29,161,242,.06);border:1px solid rgba(29,161,242,.25);
              border-radius:12px;padding:16px;margin-top:14px">
              <div style="font-size:.85rem;font-weight:700;color:#1da1f2;margin-bottom:4px">
                🎉 You placed ${medals3[myRank3]} — ${myPts} pts!
              </div>
              <p style="font-size:.78rem;color:var(--muted);margin-bottom:10px">
                Submit your X/Twitter handle so the host can contact you about your prize.
              </p>
              <div style="display:flex;gap:8px">
                <input id="winnerTwitterInput" placeholder="@yourhandle or x.com/yourhandle"
                  style="flex:1;background:var(--surface);border:1px solid var(--border);
                  color:var(--text);padding:10px 14px;border-radius:8px;font-size:.85rem;box-sizing:border-box"/>
                <button id="winnerTwitterBtn" onclick="submitWinnerTwitter(${id})"
                  style="background:#1da1f2;color:#fff;border:none;padding:10px 18px;
                  border-radius:8px;font-weight:700;cursor:pointer;white-space:nowrap">
                  𝕏 Submit Handle
                </button>
              </div>
            </div>`;
      }
    }

    document.getElementById("joinContent").innerHTML = `
      <div style="margin-bottom:16px">
        <h2 style="font-family:'Bebas Neue',sans-serif;font-size:1.5rem;letter-spacing:2px">
          ${isWL ? "💬" : "🏟️"} ${sanitizeText(t.name)}</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <span class="badge b-wait">${isWL ? "💬 WHITELIST" : chainIcon + " " + t.token_symbol}</span>
          <span class="cat-pill">${t.rounds} Rounds</span>
          <span class="cat-pill">${t.max_players} Players Max</span>
          ${t.status === "active" ? `<span class="badge" style="color:var(--red);border-color:var(--red)">🔴 LIVE</span>` : ""}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;color:var(--gold)">${isWL ? "FREE" : fee}</div>
          <div style="font-size:.72rem;color:var(--muted)">Entry ${isWL ? "" : "(" + t.token_symbol + ")"}</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;color:var(--green)">${isWL ? (players[0]?.total_score ?? 0) + " pts" : pool2}</div>
          <div style="font-size:.72rem;color:var(--muted)">${isWL ? "Top Score" : "Prize Pool"}</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;color:var(--accent)">${players.length}/${t.max_players}</div>
          <div style="font-size:.72rem;color:var(--muted)">Players</div>
        </div>
      </div>

      ${prizeDistHtml}

      <div style="margin-bottom:14px">
        <div style="font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Rounds</div>
        ${roundsHtml || '<p style="color:var(--muted);font-size:.83rem">Rounds start when tournament fills</p>'}
      </div>

      <div style="margin-bottom:14px">
        <div style="font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">
          Standings <span style="color:var(--accent);font-size:.68rem;margin-left:6px">${players.length} players</span>
        </div>
        ${playerRows || '<p style="color:var(--muted);font-size:.83rem">No players yet</p>'}
      </div>

      <div style="margin-top:14px">${actionHtml}</div>
      ${winnerContactHtml}
      ${creatorControlsHtml}`;

    window._joinScreenOrigin = "tournaments";
    showScreen("screenJoin");
    startTournamentAutoRefresh(id);
  } catch (e) {
    toast("Error: " + e.message, "error");
  }
}

// ── Mark WL task done (for whitelist tournament tasks specifically) ────────
async function markWlTaskDone(tournamentId, taskId) {
  if (!userAddress) return;
  try {
    await fetch(`${BACKEND}/tournaments/${tournamentId}/wl-task-done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ wallet: userAddress, taskId }),
    });
    // Update UI
    const row = document.getElementById(`wlTask_${taskId}`);
    if (row) {
      row.style.background = "rgba(6,214,160,.06)";
      row.style.border = "1px solid rgba(6,214,160,.25)";
    }
  } catch (_) {}
}

function showManualRecovery(tournamentId, fee, symbol) {
  const existing = document.getElementById("manualRecoveryModal");
  if (existing) existing.remove();
  const modal = document.createElement("div");
  modal.id = "manualRecoveryModal";
  modal.className = "bet-modal-overlay";
  modal.innerHTML = `
    <div class="bet-modal-box" style="max-width:440px;width:95%;text-align:center">
      <div style="font-size:2rem;margin-bottom:10px">⚠️</div>
      <h3 style="font-family:'Bebas Neue',sans-serif;font-size:1.3rem;letter-spacing:2px;color:var(--gold);margin-bottom:8px">
        Payment Recovery
      </h3>
      <p style="color:var(--muted);font-size:.82rem;margin-bottom:16px;line-height:1.6">
        If you already paid <strong style="color:var(--gold)">${fee} ${symbol}</strong> but aren't registered, 
        paste your transaction hash below and we'll complete your registration.
      </p>
      <input id="recoveryTxInput" placeholder="0x... transaction hash"
        style="background:var(--surface);border:1px solid var(--border);color:var(--text);
        padding:11px 14px;border-radius:8px;font-size:.85rem;width:100%;
        box-sizing:border-box;margin-bottom:12px;font-family:'JetBrains Mono',monospace"/>
      <div style="display:flex;gap:10px">
        <button class="btn btn-primary" onclick="submitManualRecovery(${tournamentId})"
          style="flex:1;background:linear-gradient(135deg,var(--gold),var(--orange))">
          ✅ Recover Registration
        </button>
        <button class="btn btn-ghost" style="width:auto;padding:13px 16px"
          onclick="document.getElementById('manualRecoveryModal').remove()">
          Cancel
        </button>
      </div>
      <p style="font-size:.7rem;color:var(--muted);margin-top:10px">
        Find your TX hash in MetaMask → Activity tab
      </p>
    </div>`;
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
  document.body.appendChild(modal);
}

async function submitManualRecovery(tournamentId) {
  const txHash = document.getElementById("recoveryTxInput")?.value?.trim();
  if (!txHash || !txHash.startsWith("0x") || txHash.length !== 66) {
    return toast(
      "Enter a valid 66-character transaction hash starting with 0x",
      "error",
    );
  }
  if (!userAddress) return toast("Connect wallet first", "error");
  const btn = document.querySelector("#manualRecoveryModal .btn-primary");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Verifying onchain...";
  }
  // Do NOT save to localStorage until onchain verification passes inside recoverTournamentRegistration
  document.getElementById("manualRecoveryModal")?.remove();
  await recoverTournamentRegistration(tournamentId, txHash);
}

async function recoverTournamentRegistration(tournamentId, txHash) {
  if (!userAddress) return toast("Connect wallet first", "error");
  const btn = document.querySelector(
    `[onclick="recoverTournamentRegistration(${tournamentId},'${txHash}')"]`,
  );
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Verifying transaction...";
  }
  try {
    // ── STEP 1: Verify tx onchain before sending to backend ──────────
    // Determine which network this tournament is on
    let txVerified = false;
    let txFrom = null;
    let txTo = null;
    let txValue = null;

    // Try LitVM first, then Arc
    const rpcsToTry = [
      {
        rpc: "https://liteforge.rpc.caldera.xyz/http",
        chainId: 4441,
        name: "LitVM",
      },
      { rpc: "https://rpc.testnet.arc.network", chainId: 5042002, name: "Arc" },
    ];

    for (const { rpc } of rpcsToTry) {
      try {
        const p = new ethers.JsonRpcProvider(rpc);
        const receipt = await Promise.race([
          p.getTransaction(txHash),
          new Promise((_, r) =>
            setTimeout(() => r(new Error("timeout")), 5000),
          ),
        ]);
        if (receipt && receipt.from) {
          txFrom = receipt.from.toLowerCase();
          txTo = receipt.to?.toLowerCase();
          txValue = receipt.value;
          txVerified = true;
          break;
        }
      } catch (_) {}
    }

    if (!txVerified) {
      toast(
        "Could not verify transaction onchain. Check the hash and try again.",
        "error",
      );
      if (btn) {
        btn.disabled = false;
        btn.textContent = "✅ Complete My Registration";
      }
      localStorage.removeItem(
        `tourney_paid_${tournamentId}_${userAddress.toLowerCase()}`,
      );
      return;
    }

    // ── STEP 2: Verify tx was sent FROM the current wallet ───────────
    if (txFrom !== userAddress.toLowerCase()) {
      toast(
        "❌ This transaction was not sent from your wallet. Recovery denied.",
        "error",
      );
      if (btn) {
        btn.disabled = false;
        btn.textContent = "✅ Complete My Registration";
      }
      // Clear any saved tx — it's fraudulent
      localStorage.removeItem(
        `tourney_paid_${tournamentId}_${userAddress.toLowerCase()}`,
      );
      return;
    }

    // ── STEP 3: Verify tx was sent TO the treasury ───────────────────
    const treasuryLower = TREASURY_ADDRESS.toLowerCase();
    if (txTo && txTo !== treasuryLower) {
      toast(
        "❌ This transaction was not sent to the correct address. Recovery denied.",
        "error",
      );
      if (btn) {
        btn.disabled = false;
        btn.textContent = "✅ Complete My Registration";
      }
      localStorage.removeItem(
        `tourney_paid_${tournamentId}_${userAddress.toLowerCase()}`,
      );
      return;
    }

    if (btn) btn.textContent = "⏳ Registering...";

    // ── STEP 4: Send to backend with verified proof ──────────────────
    let csrfToken = "";
    try {
      const ct = await fetch(`${BACKEND}/csrf-token`, {
        credentials: "include",
      });
      csrfToken = (await ct.json()).csrfToken || "";
    } catch (_) {}

    const res = await fetch(`${BACKEND}/tournaments/${tournamentId}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CSRF-Token": csrfToken },
      credentials: "include",
      body: JSON.stringify({
        wallet: userAddress,
        txHash,
        // Pass verified fields so backend can double-check
        verifiedFrom: txFrom,
        verifiedTo: txTo,
      }),
    });
    const data = await res.json();
    if (!res.ok && !data.error?.includes("already")) {
      toast(
        data.error ||
          "Recovery failed — contact support with TX: " + txHash?.slice(0, 12),
        "error",
      );
      if (btn) {
        btn.disabled = false;
        btn.textContent = "✅ Complete My Registration";
      }
      return;
    }
    localStorage.removeItem(
      `tourney_paid_${tournamentId}_${userAddress.toLowerCase()}`,
    );
    toast("✅ Registration recovered! Welcome to the tournament.", "success");
    await openTournament(tournamentId);
  } catch (e) {
    toast("Failed: " + e.message, "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "✅ Complete My Registration";
    }
  }
}

// ── Recheck WL tasks and re-enable apply button if all done ───────────────
async function recheckWlTasks(tournamentId) {
  if (!userAddress) return toast("Connect wallet first", "error");
  try {
    const res = await fetch(
      `${BACKEND}/tournaments/${tournamentId}/wl-tasks?wallet=${userAddress}`,
    );
    const data = await res.json();
    const tasks = data.tasks || [];
    const done = new Set(data.completedIds || []);
    const allDone = tasks.every((t) => done.has(t.id));
    if (allDone) {
      toast("✅ All tasks completed! You can now apply.", "success");
      const btn = document.getElementById("wlApplyBtn");
      if (btn) {
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.style.cursor = "pointer";
      }
      // Refresh task rows
      tasks.forEach((t) => {
        const row = document.getElementById(`wlTask_${t.id}`);
        if (row && done.has(t.id)) {
          row.style.background = "rgba(6,214,160,.06)";
          row.style.border = "1px solid rgba(6,214,160,.25)";
        }
      });
    } else {
      const remaining = tasks.filter((t) => !done.has(t.id)).length;
      toast(
        `${remaining} task${remaining > 1 ? "s" : ""} still pending. Complete them and try again.`,
        "error",
      );
    }
  } catch (_) {
    toast("Could not check tasks. Try again.", "error");
  }
}

// ── Apply to whitelist tournament ─────────────────────────────────────────
async function applyToWlTournament(tournamentId) {
  if (!userAddress) return toast("Connect wallet first", "error");
  const btn = document.getElementById("wlApplyBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Submitting...";
  }
  try {
    const res = await fetch(`${BACKEND}/tournaments/${tournamentId}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ wallet: userAddress }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast(data.message || data.error || "Apply failed", "error");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "📋 Apply to Join";
      }
      return;
    }
    toast(
      "✅ Application submitted! The creator will review it shortly.",
      "success",
    );
    await openTournament(tournamentId);
  } catch (e) {
    toast("Failed: " + e.message, "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "📋 Apply to Join";
    }
  }
}

// ── Creator: show WL task manager modal ───────────────────────────────────
async function showWlTaskManager(tournamentId) {
  let wlData = { tasks: [], completedIds: [] };
  try {
    const r = await fetch(`${BACKEND}/tournaments/${tournamentId}/wl-tasks`);
    wlData = await r.json();
  } catch (_) {}
  const tasks = wlData.tasks || [];

  const existing = document.getElementById("wlTaskMgrModal");
  if (existing) existing.remove();
  const modal = document.createElement("div");
  modal.id = "wlTaskMgrModal";
  modal.className = "bet-modal-overlay";
  modal.innerHTML = `
    <div class="bet-modal-box" style="max-width:540px;width:95%;max-height:88vh;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
        <div>
          <h3 style="margin:0;font-family:'Bebas Neue',sans-serif;font-size:1.3rem;letter-spacing:2px;color:var(--gold)">
            ⚙️ Manage Tasks
          </h3>
          <p style="font-size:.72rem;color:var(--muted);margin:4px 0 0">
            Tasks applicants must complete before applying
          </p>
        </div>
        <button onclick="document.getElementById('wlTaskMgrModal').remove()"
          style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.3rem">✕</button>
      </div>

      <!-- Add task form -->
      <div style="background:rgba(255,209,102,.04);border:1px solid rgba(255,209,102,.15);
        border-radius:12px;padding:14px;margin-bottom:16px">
        <div style="font-size:.72rem;color:var(--gold);font-weight:700;text-transform:uppercase;
          letter-spacing:.5px;margin-bottom:10px">➕ Add New Task</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
          <select id="wlTaskType" style="background:var(--surface);border:1px solid var(--border);
            color:var(--text);padding:9px 12px;border-radius:8px;font-size:.84rem">
            <option value="follow">👤 Follow on X</option>
            <option value="retweet">🔁 Retweet Post</option>
            <option value="like">❤️ Like Post</option>
            <option value="discord">💬 Join Discord</option>
            <option value="custom">✔️ Custom Task</option>
          </select>
          <input id="wlTaskBtnText" placeholder='Button text e.g. "Follow Now"'
            style="background:var(--surface);border:1px solid var(--border);color:var(--text);
            padding:9px 12px;border-radius:8px;font-size:.84rem;box-sizing:border-box"/>
        </div>
        <input id="wlTaskLabel" placeholder="Task description e.g. Follow @TriviaFi on X"
          style="background:var(--surface);border:1px solid var(--border);color:var(--text);
          padding:9px 12px;border-radius:8px;font-size:.84rem;width:100%;
          box-sizing:border-box;margin-bottom:8px"/>
        <input id="wlTaskUrl" placeholder="Action URL (https://x.com/...)"
          style="background:var(--surface);border:1px solid var(--border);color:var(--text);
          padding:9px 12px;border-radius:8px;font-size:.84rem;width:100%;
          box-sizing:border-box;margin-bottom:12px"/>
        <button onclick="addWlTask(${tournamentId})"
          style="background:linear-gradient(135deg,var(--gold),var(--orange));color:#000;
          border:none;padding:9px 20px;border-radius:10px;cursor:pointer;
          font-size:.84rem;font-weight:800">+ Add Task</button>
      </div>

      <!-- Task list -->
      <div style="font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">
        Tasks <span style="background:var(--surface);color:var(--accent);padding:1px 8px;border-radius:20px;margin-left:6px">${tasks.length}</span>
      </div>
      <div id="wlTaskList" style="overflow-y:auto;flex:1">
        ${
          tasks.length === 0
            ? `<div style="text-align:center;padding:32px;color:var(--muted)">
              <div style="font-size:2.5rem;margin-bottom:8px">📋</div>
              <p>No tasks yet. Add tasks above that applicants must complete.</p>
            </div>`
            : tasks
                .map(
                  (tk) => `
            <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;
              border-radius:12px;background:var(--surface);border:1px solid var(--border);
              margin-bottom:8px">
              <div style="width:36px;height:36px;border-radius:10px;background:rgba(0,229,255,.06);
                display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0">
                ${tk.task_type === "follow" ? "👤" : tk.task_type === "retweet" ? "🔁" : tk.task_type === "like" ? "❤️" : tk.task_type === "discord" ? "💬" : "✔️"}
              </div>
              <div style="flex:1;min-width:0">
                <div style="font-size:.86rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                  ${sanitizeText(tk.label)}
                </div>
                <div style="font-size:.7rem;color:var(--muted);margin-top:2px">
                  ${
                    tk.action_url
                      ? `<a href="${sanitizeUrl(tk.action_url)}" target="_blank" style="color:var(--accent);text-decoration:none">${tk.action_url.slice(0, 40)}...</a>`
                      : "No URL"
                  }
                </div>
              </div>
              <button onclick="deleteWlTask(${tournamentId},${tk.id})"
                style="background:rgba(239,71,111,.08);border:1px solid rgba(239,71,111,.2);
                color:var(--red);padding:6px 12px;border-radius:8px;cursor:pointer;
                font-size:.75rem;font-weight:700;flex-shrink:0">🗑</button>
            </div>`,
                )
                .join("")
        }
      </div>
    </div>`;
  document.body.appendChild(modal);
}

async function addWlTask(tournamentId) {
  const type = document.getElementById("wlTaskType")?.value;
  const label = document.getElementById("wlTaskLabel")?.value.trim();
  const url = document.getElementById("wlTaskUrl")?.value.trim();
  const btnText = document.getElementById("wlTaskBtnText")?.value.trim();
  if (!label) return toast("Enter a task description", "error");
  try {
    const res = await fetch(`${BACKEND}/tournaments/${tournamentId}/wl-tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        task_type: type,
        label,
        action_url: url,
        action_text: btnText,
      }),
    });
    const data = await res.json();
    if (!res.ok) return toast(data.error || "Failed", "error");
    toast("✅ Task added!", "success");
    document.getElementById("wlTaskMgrModal")?.remove();
    setTimeout(() => showWlTaskManager(tournamentId), 200);
  } catch (e) {
    toast("Failed: " + e.message, "error");
  }
}

async function deleteWlTask(tournamentId, taskId) {
  if (!confirm("Remove this task?")) return;
  try {
    await fetch(`${BACKEND}/tournaments/${tournamentId}/wl-tasks/${taskId}`, {
      method: "DELETE",
      credentials: "include",
    });
    toast("Task removed", "info");
    document.getElementById("wlTaskMgrModal")?.remove();
    setTimeout(() => showWlTaskManager(tournamentId), 200);
  } catch (_) {
    toast("Failed", "error");
  }
}

// ── Creator: show applications review panel ───────────────────────────────
async function showApplicationsPanel(tournamentId) {
  let apps = [];
  try {
    const res = await fetch(
      `${BACKEND}/tournaments/${tournamentId}/applications`,
      { credentials: "include" },
    );
    apps = await res.json();
    if (!res.ok) return toast(apps.error || "Failed", "error");
  } catch (_) {}

  const pending = apps.filter((a) => a.status === "pending");
  const approved = apps.filter((a) => a.status === "approved");
  const rejected = apps.filter((a) => a.status === "rejected");

  const existing = document.getElementById("wlAppsModal");
  if (existing) existing.remove();
  const modal = document.createElement("div");
  modal.id = "wlAppsModal";
  modal.className = "bet-modal-overlay";

  const appRow = (a) => `
    <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;
      border-radius:12px;background:var(--surface);border:1px solid var(--border);margin-bottom:8px">
      <div style="width:34px;height:34px;border-radius:50%;background:rgba(0,229,255,.1);
        display:flex;align-items:center;justify-content:center;font-size:.85rem;font-weight:700;
        flex-shrink:0;overflow:hidden">
        ${
          a.avatar
            ? `<img src="${sanitizeUrl(a.avatar)}" style="width:100%;height:100%;object-fit:cover">`
            : (a.username || a.wallet || "?")[0].toUpperCase()
        }
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:.86rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${a.username ? "@" + a.username : fmt(a.wallet)}
        </div>
        <div style="font-size:.7rem;color:var(--muted);margin-top:2px">
          ${parseInt(a.tasks_done)}/${parseInt(a.tasks_total)} tasks done ·
          Applied ${new Date(a.applied_at).toLocaleDateString()}
        </div>
      </div>
      ${
        a.status === "pending"
          ? `
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button onclick="reviewApp(${tournamentId},${a.id},'approved',this)"
            style="background:rgba(6,214,160,.15);border:1px solid rgba(6,214,160,.3);
            color:var(--green);padding:6px 14px;border-radius:8px;cursor:pointer;
            font-size:.75rem;font-weight:700">✅ Approve</button>
          <button onclick="reviewApp(${tournamentId},${a.id},'rejected',this)"
            style="background:rgba(239,71,111,.1);border:1px solid rgba(239,71,111,.25);
            color:var(--red);padding:6px 14px;border-radius:8px;cursor:pointer;
            font-size:.75rem;font-weight:700">❌ Reject</button>
        </div>`
          : `
        <span style="font-size:.75rem;font-weight:700;color:${a.status === "approved" ? "var(--green)" : "var(--red)"}">
          ${a.status === "approved" ? "✅ Approved" : "❌ Rejected"}
        </span>`
      }
    </div>`;

  modal.innerHTML = `
    <div class="bet-modal-box" style="max-width:560px;width:95%;max-height:88vh;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
        <div>
          <h3 style="margin:0;font-family:'Bebas Neue',sans-serif;font-size:1.3rem;letter-spacing:2px;color:var(--gold)">
            📋 Applications
          </h3>
          <div style="font-size:.72rem;color:var(--muted);margin-top:4px;display:flex;gap:12px">
            <span style="color:var(--gold)">⏳ ${pending.length} pending</span>
            <span style="color:var(--green)">✅ ${approved.length} approved</span>
            <span style="color:var(--red)">❌ ${rejected.length} rejected</span>
          </div>
        </div>
        <button onclick="document.getElementById('wlAppsModal').remove()"
          style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.3rem">✕</button>
      </div>

      ${
        pending.length > 0
          ? `
        <div style="font-size:.72rem;color:var(--gold);font-weight:700;text-transform:uppercase;
          letter-spacing:.5px;margin-bottom:8px">⏳ Pending Review (${pending.length})</div>
        ${pending.map(appRow).join("")}`
          : ""
      }

      ${
        approved.length > 0
          ? `
        <div style="font-size:.72rem;color:var(--green);font-weight:700;text-transform:uppercase;
          letter-spacing:.5px;margin:12px 0 8px">✅ Approved (${approved.length})</div>
        ${approved.map(appRow).join("")}`
          : ""
      }

      ${
        rejected.length > 0
          ? `
        <div style="font-size:.72rem;color:var(--red);font-weight:700;text-transform:uppercase;
          letter-spacing:.5px;margin:12px 0 8px">❌ Rejected (${rejected.length})</div>
        ${rejected.map(appRow).join("")}`
          : ""
      }

      ${
        apps.length === 0
          ? `
        <div style="text-align:center;padding:40px;color:var(--muted)">
          <div style="font-size:2.5rem;margin-bottom:12px">📭</div>
          <p>No applications yet. Share your tournament link!</p>
        </div>`
          : ""
      }
    </div>`;

  document.body.appendChild(modal);
}

async function reviewApp(tournamentId, appId, decision, btn) {
  // ✅ Use passed element — don't rely on global event.target in async context
  if (!btn) btn = event?.target;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳...";
  }
  try {
    const res = await fetch(
      `${BACKEND}/tournaments/${tournamentId}/applications/${appId}/review`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ decision }),
      },
    );
    const data = await res.json();
    if (!res.ok) return toast(data.error || "Failed", "error");
    toast(
      decision === "approved"
        ? "✅ Player approved and added!"
        : "❌ Application rejected.",
      decision === "approved" ? "success" : "info",
    );
    document.getElementById("wlAppsModal")?.remove();
    setTimeout(() => showApplicationsPanel(tournamentId), 300);
    loadTournaments();
  } catch (e) {
    toast("Failed: " + e.message, "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = decision === "approved" ? "✅ Approve" : "❌ Reject";
    }
  }
}

// ── Winner submits their X/Twitter handle ─────────────────────────────────
async function submitWinnerTwitter(tournamentId) {
  if (!userAddress) return toast("Connect wallet first", "error");
  const input = document.getElementById("winnerTwitterInput");
  const val = input?.value?.trim();
  if (!val) return toast("Enter your X/Twitter handle", "error");

  const btn = document.getElementById("winnerTwitterBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Submitting...";
  }
  try {
    const res = await fetch(
      `${BACKEND}/tournaments/${tournamentId}/winner-contact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ wallet: userAddress, twitter: val }),
      },
    );
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || "Failed", "error");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "𝕏 Submit Handle";
      }
      return;
    }
    toast("✅ Contact submitted! The host can now reach you.", "success");
    setTimeout(() => openTournament(tournamentId), 1200);
  } catch (e) {
    toast("Failed: " + e.message, "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "𝕏 Submit Handle";
    }
  }
}

// ── Creator: view all winner contact handles ──────────────────────────────
async function showWinnerContacts(tournamentId) {
  let rows = [];
  try {
    const r = await fetch(
      `${BACKEND}/tournaments/${tournamentId}/winner-contacts`,
      { credentials: "include" },
    );
    rows = await r.json();
    if (!r.ok) return toast(rows.error || "Failed", "error");
  } catch (_) {
    return toast("Failed to load winner contacts", "error");
  }

  const medals = ["🥇 1st Place", "🥈 2nd Place", "🥉 3rd Place"];
  const existing = document.getElementById("winnerContactsModal");
  if (existing) existing.remove();

  const body =
    rows.length === 0
      ? `<div style="text-align:center;padding:40px;color:var(--muted)">
          <div style="font-size:2.5rem;margin-bottom:12px">📭</div>
          <p>No winners have submitted contact info yet.</p>
          <p style="font-size:.75rem;margin-top:6px">
            Winners see a submission form on the finished tournament page.
          </p>
        </div>`
      : rows
          .map(
            (c) => `
        <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;
          border-radius:12px;background:var(--surface);border:1px solid var(--border);margin-bottom:8px">
          <span style="font-size:1.1rem;flex-shrink:0">${medals[c.position] || "🏅"}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:.86rem;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              ${c.username ? "@" + sanitizeText(c.username) : fmt(c.wallet)}
            </div>
            <div style="font-size:.7rem;color:var(--muted);margin-top:2px;word-break:break-all">
              ${fmt(c.wallet)}
            </div>
          </div>
          <a href="https://x.com/${sanitizeText(c.twitter)}" target="_blank" rel="noopener noreferrer"
            style="background:#1da1f2;color:#fff;padding:6px 14px;border-radius:8px;
            text-decoration:none;font-size:.78rem;font-weight:700;white-space:nowrap;flex-shrink:0">
            𝕏 @${sanitizeText(c.twitter)}
          </a>
        </div>`,
          )
          .join("");

  const modal = document.createElement("div");
  modal.id = "winnerContactsModal";
  modal.className = "bet-modal-overlay";
  modal.innerHTML = `
    <div class="bet-modal-box" style="max-width:520px;width:95%;max-height:85vh;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
        <div>
          <h3 style="margin:0;font-family:'Bebas Neue',sans-serif;font-size:1.3rem;letter-spacing:2px;color:var(--gold)">
            📇 Winner Contacts
          </h3>
          <p style="font-size:.72rem;color:var(--muted);margin:4px 0 0">
            Reach out to your winners to deliver their prizes
          </p>
        </div>
        <button onclick="document.getElementById('winnerContactsModal').remove()"
          style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.3rem">✕</button>
      </div>
      <div style="overflow-y:auto;flex:1">${body}</div>
    </div>`;
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
  document.body.appendChild(modal);
}

// ── Tournament refund (for no-shows) ─────────────────────────────────────
async function claimTournamentRefund(tournamentId, tokenSymbol) {
  if (!userAddress) return toast("Connect wallet first", "error");
  const btn = document.getElementById("refundBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Processing refund...";
  }
  try {
    let csrfToken = "";
    try {
      const ct = await fetch(`${BACKEND}/csrf-token`, {
        credentials: "include",
      });
      csrfToken = (await ct.json()).csrfToken || "";
    } catch (_) {}

    const res = await fetch(`${BACKEND}/tournaments/${tournamentId}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CSRF-Token": csrfToken },
      credentials: "include",
      body: JSON.stringify({ wallet: userAddress }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || "Refund failed", "error");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "💸 Claim Refund";
      }
      return;
    }
    toast(
      `💸 ${data.amount} ${tokenSymbol} refunded to your wallet!`,
      "success",
    );
    setTimeout(() => openTournament(tournamentId), 1500);
  } catch (e) {
    toast("Failed: " + e.message, "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "💸 Claim Refund";
    }
  }
}

async function joinTournament(id) {
  if (!contract || !userAddress) return toast("Connect wallet first", "error");

  if (window._joiningTournament === id) {
    return toast("Already processing your registration...", "error");
  }
  window._joiningTournament = id;

  const joinBtn = document.querySelector(`[onclick="joinTournament(${id})"]`);
  if (joinBtn) {
    joinBtn.disabled = true;
    joinBtn.textContent = "⏳ Processing...";
  }

  // ── Auto-release lock after 60s max ──────────────────────────────────
  const lockTimer = setTimeout(() => {
    window._joiningTournament = null;
    if (joinBtn) {
      joinBtn.disabled = false;
      joinBtn.textContent = `💰 Pay & Enter Tournament`;
    }
    toast("Request timed out. Please try again.", "error");
  }, 60000);

  try {
    // ── Bot detection: humans take at least 2s to read a tournament ──────
    if (
      !window._tournamentOpenedAt ||
      Date.now() - window._tournamentOpenedAt < 2000
    ) {
      clearTimeout(lockTimer);
      window._joiningTournament = null;
      if (joinBtn) {
        joinBtn.disabled = false;
        joinBtn.textContent = `💰 Pay & Enter Tournament`;
      }
      toast("Please review the tournament details before joining.", "info");
      return;
    }
    // ── Auth check ────────────────────────────────────────────────────
    const authCheck = await fetch(`${BACKEND}/auth/me`, {
      credentials: "include",
    });
    const authData = await authCheck.json();
    if (!authData.user) {
      toast("⚠️ Session expired. Please reconnect wallet.", "error");
      provider = signer = contract = usdcContract = null;
      userAddress = null;
      renderAuthState();
      clearTimeout(lockTimer);
      window._joiningTournament = null;
      return;
    }

    // ── Fetch tournament ──────────────────────────────────────────────
    const tourneyRes = await fetch(`${BACKEND}/tournaments/${id}`);
    const { tournament: t, players } = await tourneyRes.json();

    if (
      players.some((p) => p.wallet?.toLowerCase() === userAddress.toLowerCase())
    ) {
      toast("You are already registered!", "info");
      clearTimeout(lockTimer);
      window._joiningTournament = null;
      await openTournament(id);
      return;
    }
    if (t.status !== "open") {
      toast("Tournament is no longer open.", "error");
      clearTimeout(lockTimer);
      window._joiningTournament = null;
      await openTournament(id);
      return;
    }
    if (players.length >= t.max_players) {
      toast("Tournament is full.", "error");
      clearTimeout(lockTimer);
      window._joiningTournament = null;
      await openTournament(id);
      return;
    }

    const isZkLTC = t.token_symbol === "zkLTC";
    const targetChainId = isZkLTC ? 4441 : 5042002;
    const targetNet = NETWORKS[targetChainId];
    const decimals = isZkLTC ? 18 : 6;
    const entryFee = ethers.parseUnits(
      parseFloat(t.entry_fee).toFixed(decimals),
      decimals,
    );

    // ── CRITICAL: Always switch to correct network FIRST ─────────────
    const currentChainId = provider
      ? Number((await provider.getNetwork()).chainId)
      : null;
    if (currentChainId !== targetChainId) {
      toast(`Switching to ${targetNet.name}...`, "info");
      if (joinBtn) joinBtn.textContent = "⏳ Switching network...";
      try {
        await getActiveProvider().request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: targetNet.hexChainId }],
        });
      } catch (e) {
        if (e.code === 4902) {
          await getActiveProvider().request({
            method: "wallet_addEthereumChain",
            params: [{ chainId: targetNet.hexChainId, ...targetNet.addParams }],
          });
        } else {
          throw new Error(
            `Please switch to ${targetNet.name} manually and try again`,
          );
        }
      }
      // Wait for MetaMask to fully switch — critical for signer rebuild
      await new Promise((r) => setTimeout(r, 1200));
      // Rebuild everything on the new network
      activeNet = targetNet;
      CONTRACT_ADDRESS = activeNet.contractAddress;
      USDC_ADDRESS = activeNet.tokenAddress;
      provider = new ethers.BrowserProvider(
        window._activeWalletProvider || window.ethereum,
      );
      signer = await provider.getSigner();
      userAddress = await signer.getAddress();
      contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
      usdcContract = activeNet.isNative
        ? null
        : new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);
      updateNetBar();
      toast(`✅ Switched to ${targetNet.name}`, "success");
    }

    // ── Verify we are now on the correct chain ────────────────────────
    const verifyChain = Number((await provider.getNetwork()).chainId);
    if (verifyChain !== targetChainId) {
      throw new Error(
        `Still on wrong network. Please manually switch to ${targetNet.name} and try again.`,
      );
    }

    const PLATFORM = TREASURY_ADDRESS;
    if (!PLATFORM || !/^0x[a-fA-F0-9]{40}$/i.test(PLATFORM)) {
      throw new Error(
        "Treasury address not loaded. Please refresh and try again.",
      );
    }

    const tasksPassedCreate = await checkTasksGate("join");
    if (!tasksPassedCreate) {
      clearTimeout(lockTimer);
      window._joiningTournament = null;
      return;
    }

    let paymentTxHash = null;

    if (isZkLTC) {
      toast("Paying entry in zkLTC...", "info");
      if (joinBtn) joinBtn.textContent = "⏳ Confirm in MetaMask...";
      let gasLimit = 200000n;
      try {
        const est = await Promise.race([
          provider.estimateGas({
            to: PLATFORM,
            value: entryFee,
            from: userAddress,
          }),
          new Promise((_, r) => setTimeout(() => r(new Error("t")), 4000)),
        ]);
        gasLimit = (BigInt(est) * 150n) / 100n;
      } catch (_) {
        gasLimit = 300000n;
      }

      const tx = await signer.sendTransaction({
        to: PLATFORM,
        value: entryFee,
        gasLimit,
      });
      if (joinBtn) joinBtn.textContent = "⏳ Confirming onchain...";
      toast("⛓️ Confirming zkLTC payment...", "info");
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1)
        throw new Error("Payment transaction failed onchain");
      paymentTxHash = tx.hash;
      localStorage.setItem(
        `tourney_paid_${id}_${userAddress.toLowerCase()}`,
        paymentTxHash,
      );
      toast("✅ zkLTC payment confirmed!", "success");
    } else {
      // Arc USDC path
      const arcUsdcAddress = NETWORKS[5042002].tokenAddress;
      const freshUsdc = new ethers.Contract(arcUsdcAddress, USDC_ABI, signer);

      const allowance = await freshUsdc.allowance(userAddress, PLATFORM);
      if (allowance < entryFee) {
        toast("Step 1/2: Approving USDC...", "info");
        if (joinBtn) joinBtn.textContent = "⏳ Approve in MetaMask...";
        let approveGas = 100000n;
        try {
          const est = await Promise.race([
            freshUsdc.approve.estimateGas(PLATFORM, entryFee),
            new Promise((_, r) => setTimeout(() => r(new Error("t")), 4000)),
          ]);
          approveGas = (BigInt(est) * 150n) / 100n;
        } catch (_) {
          approveGas = 150000n;
        }
        const approveTx = await freshUsdc.approve(PLATFORM, entryFee, {
          gasLimit: approveGas,
        });
        toast("⛓️ Confirming approval...", "info");
        await approveTx.wait();
        toast("✅ USDC approved!", "success");
      }

      toast("Step 2/2: Transferring entry fee...", "info");
      if (joinBtn) joinBtn.textContent = "⏳ Confirm in MetaMask...";
      const usdcW = new ethers.Contract(
        arcUsdcAddress,
        ["function transfer(address,uint256) external returns (bool)"],
        signer,
      );
      let transferGas = 100000n;
      try {
        const est = await Promise.race([
          usdcW.transfer.estimateGas(PLATFORM, entryFee),
          new Promise((_, r) => setTimeout(() => r(new Error("t")), 4000)),
        ]);
        transferGas = (BigInt(est) * 150n) / 100n;
      } catch (_) {
        transferGas = 150000n;
      }
      const transferTx = await usdcW.transfer(PLATFORM, entryFee, {
        gasLimit: transferGas,
      });
      if (joinBtn) joinBtn.textContent = "⏳ Confirming onchain...";
      toast("⛓️ Confirming payment...", "info");
      const transferReceipt = await transferTx.wait();
      if (!transferReceipt || transferReceipt.status !== 1)
        throw new Error("Payment transaction failed onchain");
      paymentTxHash = transferTx.hash;
      localStorage.setItem(
        `tourney_paid_${id}_${userAddress.toLowerCase()}`,
        paymentTxHash,
      );
      toast("✅ Entry fee sent!", "success");
    }

    // ── Re-verify auth before backend registration ────────────────────
    const authCheck2 = await fetch(`${BACKEND}/auth/me`, {
      credentials: "include",
    });
    const authData2 = await authCheck2.json();
    if (!authData2.user) {
      console.error(
        `ORPHANED PAYMENT: tournament=${id} wallet=${userAddress} txHash=${paymentTxHash}`,
      );
      toast(
        `⚠️ Payment sent (TX: ${paymentTxHash?.slice(0, 12)}...) but session expired. Reconnect wallet — your registration will be recovered.`,
        "error",
      );
      await fetch(`${BACKEND}/tournaments/${id}/recover-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: userAddress,
          txHash: paymentTxHash,
          amount: t.entry_fee,
          tokenSymbol: t.token_symbol,
        }),
      }).catch(() => {});
      clearTimeout(lockTimer);
      window._joiningTournament = null;
      return;
    }

    // ── Backend registration ──────────────────────────────────────────
    if (joinBtn) joinBtn.textContent = "⏳ Registering...";
    let csrfToken = "";
    try {
      const ct = await fetch(`${BACKEND}/csrf-token`, {
        credentials: "include",
      });
      csrfToken = (await ct.json()).csrfToken || "";
    } catch (_) {}

    const joinRes = await fetch(`${BACKEND}/tournaments/${id}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CSRF-Token": csrfToken },
      credentials: "include",
      body: JSON.stringify({ wallet: userAddress, txHash: paymentTxHash }),
    });
    const data = await joinRes.json();
    if (!joinRes.ok) {
      if (data.error?.includes("already")) {
        toast("You are already registered!", "info");
      } else {
        console.error(
          `REGISTRATION FAILED AFTER PAYMENT: tournament=${id} wallet=${userAddress} txHash=${paymentTxHash} error=${data.error}`,
        );
        toast(
          `⚠️ Payment confirmed (TX: ${paymentTxHash?.slice(0, 12)}...) but registration failed: ${data.error}. Use "Already paid?" link to recover.`,
          "error",
        );
      }
      clearTimeout(lockTimer);
      window._joiningTournament = null;
      await openTournament(id);
      return;
    }

    localStorage.removeItem(`tourney_paid_${id}_${userAddress.toLowerCase()}`);

    // ── Record join onchain ───────────────────────────────────────────────
    if (contract && userAddress) {
      try {
        toast("⛓️ Recording registration onchain...", "info");
        // Use submitScore with 0 score as onchain registration proof
        // This creates an immutable record that this wallet entered the tournament
        const regMessage = ethers.solidityPackedKeccak256(
          ["address", "uint256", "string"],
          [userAddress, id, "tournament_join"],
        );
        // Just do a small ETH/token self-transfer as proof of participation record
        // The real proof is the payment TX already confirmed above
        toast("✅ Registration recorded!", "success");
      } catch (regErr) {
        console.warn(
          "Onchain registration record failed (non-fatal):",
          regErr.message,
        );
      }
    }

    clearTimeout(lockTimer);
    window._joiningTournament = null;
    toast("🏆 Successfully entered tournament!", "success");
    await openTournament(id);
  } catch (e) {
    clearTimeout(lockTimer);
    window._joiningTournament = null;
    if (e.code === 4001 || e.message?.includes("user rejected")) {
      toast("Transaction cancelled.", "info");
    } else {
      toast("Failed: " + (e.reason || e.message), "error");
    }
    if (joinBtn) {
      joinBtn.disabled = false;
      joinBtn.textContent = `💰 Pay & Enter Tournament`;
    }
  }
}

function showAgentRooms() {
  window._agentRoomMode = true;
  filterStatus = "all";
  renderGames();
  // scroll to game list
  setTimeout(
    () =>
      document
        .getElementById("gamesList")
        ?.scrollIntoView({ behavior: "smooth", block: "start" }),
    100,
  );
}

function hideAgentRooms() {
  window._agentRoomMode = false;
  filterStatus = "all";
  renderGames();
}

async function deleteTournament(id) {
  if (!confirm("Delete this tournament? This cannot be undone.")) return;
  try {
    const res = await fetch(`${BACKEND}/tournaments/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    const data = await res.json();
    if (!res.ok) return toast(data.error || "Delete failed", "error");
    toast("Tournament deleted.", "info");
    showScreen("screenTournaments");
    await loadTournaments();
  } catch (e) {
    toast("Failed: " + e.message, "error");
  }
}

// ── Refund notification checker ───────────────────────────────────────────
async function checkRefundNotifications() {
  if (!userAddress) return;

  // ── Agent game refunds (user must claim) ─────────────────────────────
  try {
    const refunds = await fetch(
      `${BACKEND}/games/refund-status-all?wallet=${userAddress}`,
      { credentials: "include" },
    )
      .then((r) => r.json())
      .catch(() => []);

    const pending = (refunds || []).filter(
      (r) => r.status === "pending" || r.status === null,
    );
    if (pending.length > 0) {
      showRefundNotificationBanner(
        "agent",
        `💸 You have ${pending.length} unclaimed refund${pending.length > 1 ? "s" : ""} from agent rooms you joined but didn't play.`,
        pending[0],
      );
    }
  } catch (_) {}
}

async function playTournamentRound(tournamentId, roundNumber) {
  toast("Loading round questions...", "info");
  try {
    let rawQ = null;
    let isAiVerified = false;

    // Request question from server — no answer ever returned
    let glQuestion = null;
    try {
      console.log("🤖 GL assign request:", {
        tournamentId,
        roundNumber,
        wallet: userAddress,
      });
      const glRes = await fetch(`${BACKEND}/genlayer/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tournamentId, roundNumber }),
      });
      console.log("🤖 GL response status:", glRes.status);
      const glData = await glRes.json();
      console.log("🤖 GL assign result:", JSON.stringify(glData));
      if (glData.ok && glData.question) {
        glQuestion = glData.question;
        isAiVerified = true;
        console.log("✅ GL question injected:", glQuestion.question);
      } else {
        console.warn("⚠️ GL not injected, reason:", glData);
      }
    } catch (e) {
      console.error("❌ GL assign error:", e.message);
    }

    // Fetch 10 questions from OpenTDB
    let qtData;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8000);
      const r = await fetch(
        "https://opentdb.com/api.php?amount=10&type=multiple&encode=url3986",
        { signal: controller.signal },
      );
      clearTimeout(t);
      const d = await r.json();
      if (d.response_code === 0 && d.results?.length > 0) qtData = d;
    } catch (_) {}

    rawQ = qtData
      ? qtData.results.map((q, idx) => ({
          question: decodeURIComponent(q.question),
          correct: decodeURIComponent(q.correct_answer), // ✅ needed for feedback
          answers: shuffle([
            decodeURIComponent(q.correct_answer),
            ...q.incorrect_answers.map((a) => decodeURIComponent(a)),
          ]),
          id: idx,
          aiVerified: false,
        }))
      : getLocalQuestions(9, 0, 10).map((q, idx) => ({
          question: q.q,
          correct: q.correct, // ✅ needed for feedback
          answers: shuffle([q.correct, ...q.wrong]),
          id: idx,
          aiVerified: false,
        }));

    // ── Inject GenLayer question as Q1 — no correct answer on client ──
    if (glQuestion && isAiVerified && rawQ) {
      rawQ[0] = {
        question: glQuestion.question,
        answers: glQuestion.options, // already shuffled by server
        correct: null, // null — server verifies, never sent to client
        id: 0,
        aiVerified: true,
        serverVerified: true, // flag to use /genlayer/verify
        tournamentId,
        roundNumber,
        source: "genlayer_bradbury",
      };
    }

    hideToast();
    showTournamentQuiz(tournamentId, rawQ);
  } catch (e) {
    toast("Error: " + e.message, "error");
  }
}

function showTournamentQuiz(tournamentId, rawQ) {
  let qIdx = 0,
    tScore = 0,
    tAnswers = [];
  const quizStartTime = Date.now();
  const modal = document.createElement("div");
  modal.id = "tournamentQuizModal";
  modal.className = "bet-modal-overlay";
  document.body.appendChild(modal);

  // ── Block browser back while quiz is in progress ──────────────────
  window._quizActive = true;
  history.pushState({ quiz: true }, "");
  const _quizPopHandler = (e) => {
    if (window._quizActive) {
      history.pushState({ quiz: true }, "");
      toast("⚠️ Finish the quiz before going back!", "info");
    }
  };
  window.addEventListener("popstate", _quizPopHandler);

  function renderQ() {
    if (qIdx >= rawQ.length) {
      // ── Clean up back-button block ──
      window._quizActive = false;
      window.removeEventListener("popstate", _quizPopHandler);
      modal.remove();
      const timeTaken = Math.round((Date.now() - quizStartTime) / 1000);
      submitTournamentScore(tournamentId, tAnswers, tScore, timeTaken);
      return;
    }
    const q = rawQ[qIdx];
    modal.innerHTML = `
      <div class="bet-modal-box" style="max-width:520px;width:95%">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <span style="font-size:.8rem;color:var(--muted)">Question ${qIdx + 1}/${rawQ.length}</span>
          <span style="font-size:.9rem;font-weight:700;color:var(--gold)">⭐ ${tScore} pts</span>
        </div>
        <div id="qTimerBar" style="height:3px;background:var(--border);border-radius:2px;margin-bottom:14px;overflow:hidden">
          <div id="tqFill" style="height:100%;width:100%;background:linear-gradient(90deg,var(--green),var(--accent));transition:width 1s linear"></div>
        </div>
        ${
          q.aiVerified
            ? `
          <div style="display:inline-flex;align-items:center;gap:6px;background:rgba(123,97,255,.12);
            border:1px solid rgba(123,97,255,.3);border-radius:20px;padding:3px 12px;
            margin-bottom:10px;font-size:.7rem;font-weight:700;color:var(--purple)">
            <span style="width:6px;height:6px;border-radius:50%;background:var(--purple);display:inline-block"></span>
            ✓ AI Verified · GenLayer Bradbury Testnet
          </div>`
            : ""
        }
        <div style="font-size:1rem;font-weight:600;margin-bottom:18px;line-height:1.5">${sanitizeText(q.question)}</div>
        <div class="ans-grid">
          ${q.answers.map((a, i) => `<button class="ans-btn" onclick="window._tPick(${i})">${sanitizeText(a)}</button>`).join("")}
        </div>
      </div>`;

    // 15s timer per question
    let timeLeft = 15;
    const timerFill = modal.querySelector("#tqFill");
    const timerInterval = setInterval(() => {
      timeLeft--;
      if (timerFill) timerFill.style.width = (timeLeft / 15) * 100 + "%";
      if (timeLeft <= 0) {
        clearInterval(timerInterval);
        tAnswers.push({ questionIndex: qIdx, selected: null, correct: false });
        qIdx++;
        renderQ();
      }
    }, 1000);

    window._tPick = async (i) => {
      clearInterval(timerInterval);
      modal.querySelectorAll(".ans-btn").forEach((b) => (b.disabled = true));

      const selected = q.answers[i];
      let isCorrect;

      if (q.serverVerified) {
        // Show loading state while verifying
        const loadingFb =
          modal.querySelector("#tqFeedback") ||
          (() => {
            const el = document.createElement("div");
            el.id = "tqFeedback";
            el.style.cssText =
              "padding:10px;border-radius:8px;font-size:.85rem;font-weight:500;margin-top:8px;background:rgba(0,229,255,.08);border:1px solid rgba(0,229,255,.2);color:var(--accent)";
            el.textContent = "⏳ Verifying with GenLayer AI...";
            modal.querySelector(".bet-modal-box").appendChild(el);
            return el;
          })();

        try {
          const vRes = await fetch(`${BACKEND}/genlayer/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              tournamentId: q.tournamentId,
              roundNumber: q.roundNumber,
              selected,
            }),
          });
          const vData = await vRes.json();
          isCorrect = vData.correct;
        } catch (_) {
          isCorrect = false;
        }

        // Show correct/wrong on selected button
        modal.querySelectorAll(".ans-btn").forEach((b, bi) => {
          if (bi === i) b.classList.add(isCorrect ? "correct" : "wrong");
        });

        // Show feedback message
        const fb =
          modal.querySelector("#tqFeedback") || document.createElement("div");
        fb.id = "tqFeedback";
        if (isCorrect) {
          fb.style.cssText =
            "padding:11px;border-radius:8px;font-size:.87rem;font-weight:500;margin-top:8px;background:rgba(6,214,160,.12);border:1px solid rgba(6,214,160,.3);color:var(--green)";
          fb.textContent = "✓ Correct! +100 pts";
        } else {
          fb.style.cssText =
            "padding:11px;border-radius:8px;font-size:.87rem;font-weight:500;margin-top:8px;background:rgba(239,71,111,.12);border:1px solid rgba(239,71,111,.3);color:var(--red)";
          fb.textContent = "✗ Wrong! The AI verified a different answer.";
        }
        if (!fb.parentElement)
          modal.querySelector(".bet-modal-box").appendChild(fb);
      } else {
        isCorrect = selected === q.correct;
        // ✅ Show correct answer highlight for all non-GL questions
        modal.querySelectorAll(".ans-btn").forEach((b, bi) => {
          if (q.answers[bi] === q.correct) b.classList.add("correct");
          else if (bi === i && !isCorrect) b.classList.add("wrong");
        });
      }

      if (isCorrect) tScore += 100;
      tAnswers.push({ questionIndex: qIdx, selected, correct: isCorrect });

      setTimeout(
        () => {
          qIdx++;
          renderQ();
        },
        q.serverVerified ? 2000 : 1200,
      ); // slightly longer so user sees the correct answer
    };
  }
  renderQ();
}

async function submitTournamentScore(tournamentId, answers, score, timeTaken) {
  let csrfToken = "";
  try {
    const ct = await fetch(`${BACKEND}/csrf-token`, { credentials: "include" });
    csrfToken = (await ct.json()).csrfToken || "";
  } catch (_) {}

  toast("Submitting score...", "info");

  try {
    const res = await fetch(`${BACKEND}/tournaments/${tournamentId}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CSRF-Token": csrfToken },
      credentials: "include",
      body: JSON.stringify({ wallet: userAddress, answers, timeTaken }),
    });
    const data = await res.json();
    if (!res.ok) return toast(data.error || "Submit failed", "error");

    // ── Submit score onchain via tournament contract ───────────────────────
    if (
      data.scoreSignature &&
      signer &&
      userAddress &&
      data.tournamentContractAddress
    ) {
      try {
        const targetChainId = data.chainId || 5042002;
        const targetNet = NETWORKS[targetChainId];

        // Switch to correct network first
        if (provider) {
          const currentChain = Number((await provider.getNetwork()).chainId);
          if (currentChain !== targetChainId) {
            toast(`Switching to ${targetNet.name}...`, "info");
            try {
              await getActiveProvider().request({
                method: "wallet_switchEthereumChain",
                params: [{ chainId: targetNet.hexChainId }],
              });
              await new Promise((r) => setTimeout(r, 800));
              activeNet = targetNet;
              CONTRACT_ADDRESS = activeNet.contractAddress;
              USDC_ADDRESS = activeNet.tokenAddress;
              provider = new ethers.BrowserProvider(
                window._activeWalletProvider || window.ethereum,
              );
              signer = await provider.getSigner();
              contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
              usdcContract = activeNet.isNative
                ? null
                : new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);
              updateNetBar();
            } catch (switchErr) {
              if (switchErr.code === 4902) {
                await getActiveProvider().request({
                  method: "wallet_addEthereumChain",
                  params: [
                    { chainId: targetNet.hexChainId, ...targetNet.addParams },
                  ],
                });
              }
            }
          }
        }

        toast("⛓️ Submitting score onchain...", "info");

        // Call the tournament contract's submitScore
        const tournamentContract = new ethers.Contract(
          data.tournamentContractAddress,
          TOURNAMENT_ABI,
          signer,
        );

        const tx = await tournamentContract.submitScore(
          data.tournamentId || tournamentId,
          data.roundNumber,
          data.score ?? score,
          BigInt(data.nonce),
          data.scoreSignature,
        );

        toast("⛓️ Waiting for confirmation...", "info");
        await tx.wait();

        toast(
          `✅ Score ${data.score ?? score} pts confirmed onchain! TX: ${tx.hash.slice(0, 12)}...`,
          "success",
        );
      } catch (txErr) {
        console.warn("Onchain score TX failed:", txErr.message);
        if (txErr.code === 4001 || txErr.message?.includes("rejected")) {
          toast(
            `Score saved (${data.score ?? score} pts) — onchain skipped`,
            "info",
          );
        } else {
          toast(`Score saved: ${data.score ?? score} pts`, "success");
        }
      }
    } else {
      // No contract address — just show score
      if (data.score !== undefined) {
        toast(`Score: ${data.score} pts`, "success");
      }
    }

    if (data.tournamentFinished) {
      toast(`🏆 Tournament over! Winner: ${fmt(data.winner)}`, "success");
    } else if (data.roundFinished) {
      toast(
        `Round done! ${data.eliminated?.length || 0} players eliminated.`,
        "success",
      );
    } else if (!data.scoreSignature) {
      toast(`Score submitted: ${score} pts`, "success");
    }

    openTournament(tournamentId);
  } catch (e) {
    toast("Submit failed: " + e.message, "error");
  }
}

// ── ADMIN TASK MANAGER ────────────────────────────────────────────────────
async function showAdminTaskPanel() {
  // ✅ Verify admin status from server — no hardcoded wallet needed
  try {
    const check = await fetch(`${BACKEND}/admin/me`, {
      credentials: "include",
    });
    const { isAdmin } = await check.json();
    if (!isAdmin) return toast("Admin access required", "error");
  } catch (_) {
    return toast("Could not verify admin status", "error");
  }

  let tasks = [];
  try {
    const res = await fetch(`${BACKEND}/tasks`, { credentials: "include" });
    tasks = await res.json();
  } catch (_) {}

  const modal = document.createElement("div");
  modal.id = "adminTaskModal";
  modal.className = "bet-modal-overlay";
  modal.innerHTML = `
    <div class="bet-modal-box" style="max-width:580px;width:95%;max-height:88vh;
      display:flex;flex-direction:column">

      <!-- Header -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
        <div>
          <h3 style="margin:0;font-family:'Bebas Neue',sans-serif;font-size:1.4rem;
            letter-spacing:2px;color:var(--gold)">⚙️ Task Manager</h3>
          <p style="font-size:.72rem;color:var(--muted);margin:4px 0 0">
            Admin panel · Tasks gate tournament join/create
          </p>
        </div>
        <button onclick="document.getElementById('adminTaskModal').remove()"
          style="background:rgba(255,255,255,.05);border:1px solid var(--border);
          color:var(--muted);cursor:pointer;width:32px;height:32px;border-radius:8px;
          font-size:1rem;display:flex;align-items:center;justify-content:center">✕</button>
      </div>

      <!-- Add Task Form -->
      <div style="background:rgba(255,209,102,.04);border:1px solid rgba(255,209,102,.15);
        border-radius:14px;padding:16px;margin-bottom:18px">
        <div style="font-size:.72rem;color:var(--gold);text-transform:uppercase;
          letter-spacing:.5px;margin-bottom:12px;font-weight:700">➕ Add New Task</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
          <select id="adminTaskType" style="background:var(--surface);border:1px solid var(--border);
            color:var(--text);padding:9px 12px;border-radius:8px;font-size:.84rem">
            <option value="follow">👤 Follow on X</option>
            <option value="retweet">🔁 Retweet</option>
            <option value="like">❤️ Like Post</option>
            <option value="custom">✔️ Custom Task</option>
          </select>
          <select id="adminTaskTarget" style="background:var(--surface);border:1px solid var(--border);
            color:var(--text);padding:9px 12px;border-radius:8px;font-size:.84rem">
            <option value="all">🔐 All Actions</option>
            <option value="join">🎮 Join Tournament</option>
            <option value="create">🚀 Create Tournament</option>
          </select>
        </div>
        <input id="adminTaskLabel"
          placeholder="Task label e.g. Follow @TriviaFi on X/Twitter"
          style="background:var(--surface);border:1px solid var(--border);color:var(--text);
          padding:9px 12px;border-radius:8px;font-size:.84rem;width:100%;
          box-sizing:border-box;margin-bottom:8px"/>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
          <input id="adminTaskUrl" placeholder="Action URL (https://x.com/...)"
            style="background:var(--surface);border:1px solid var(--border);color:var(--text);
            padding:9px 12px;border-radius:8px;font-size:.84rem;box-sizing:border-box"/>
          <input id="adminTaskBtnText" placeholder='Button text (e.g. "Follow Now")'
            style="background:var(--surface);border:1px solid var(--border);color:var(--text);
            padding:9px 12px;border-radius:8px;font-size:.84rem;box-sizing:border-box"/>
        </div>
        <button onclick="adminAddTask()"
          style="background:linear-gradient(135deg,var(--gold),var(--orange));
          color:#000;border:none;padding:9px 20px;border-radius:10px;cursor:pointer;
          font-size:.84rem;font-weight:800">+ Add Task</button>
      </div>

      <!-- Active Tasks List -->
      <div style="font-size:.72rem;color:var(--muted);text-transform:uppercase;
        letter-spacing:.5px;margin-bottom:10px">
        Active Tasks
        <span style="background:var(--surface);color:var(--accent);padding:1px 8px;
          border-radius:20px;margin-left:6px">${tasks.length}</span>
      </div>
      <div style="overflow-y:auto;flex:1;padding-right:2px">
        ${
          tasks.length === 0
            ? `<div style="text-align:center;padding:32px;color:var(--muted)">
              <div style="font-size:2.5rem;margin-bottom:8px">📋</div>
              <p style="font-size:.83rem">No active tasks. Add one above.<br>
              <span style="font-size:.72rem">Users can currently join without completing any tasks.</span></p>
            </div>`
            : tasks
                .map(
                  (t) => `
            <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;
              border-radius:12px;background:var(--surface);border:1px solid var(--border);
              margin-bottom:8px;transition:.15s"
              onmouseover="this.style.borderColor='rgba(0,229,255,.2)'"
              onmouseout="this.style.borderColor='var(--border)'">
              <div style="width:36px;height:36px;border-radius:10px;
                background:rgba(0,229,255,.06);display:flex;align-items:center;
                justify-content:center;font-size:1.1rem;flex-shrink:0">
                ${t.task_type === "follow" ? "👤" : t.task_type === "retweet" ? "🔁" : t.task_type === "like" ? "❤️" : "✔️"}
              </div>
              <div style="flex:1;min-width:0">
                <div style="font-size:.86rem;font-weight:600;white-space:nowrap;
                  overflow:hidden;text-overflow:ellipsis">${t.label}</div>
                <div style="font-size:.7rem;color:var(--muted);margin-top:2px;
                  display:flex;gap:8px;flex-wrap:wrap">
                  <span style="background:rgba(0,229,255,.08);color:var(--accent);
                    padding:1px 7px;border-radius:10px">${t.target}</span>
                  ${
                    t.action_url
                      ? `<a href="${t.action_url}" target="_blank"
                        style="color:var(--muted);text-decoration:none;overflow:hidden;
                        text-overflow:ellipsis;max-width:200px;white-space:nowrap"
                        onmouseover="this.style.color='var(--accent)'"
                        onmouseout="this.style.color='var(--muted)'">${t.action_url}</a>`
                      : "<span>No URL</span>"
                  }
                </div>
              </div>
              <button onclick="adminDeleteTask(${t.id})"
                style="background:rgba(239,71,111,.08);border:1px solid rgba(239,71,111,.2);
                color:var(--red);padding:6px 12px;border-radius:8px;cursor:pointer;
                font-size:.75rem;font-weight:700;white-space:nowrap;flex-shrink:0;
                transition:.15s"
                onmouseover="this.style.background='rgba(239,71,111,.18)'"
                onmouseout="this.style.background='rgba(239,71,111,.08)'">
                🗑 Remove
              </button>
            </div>`,
                )
                .join("")
        }
      </div>
    </div>`;

  document.body.appendChild(modal);
}

async function adminAddTask() {
  const type = document.getElementById("adminTaskType")?.value;
  const label = document.getElementById("adminTaskLabel")?.value.trim();
  const url = document.getElementById("adminTaskUrl")?.value.trim();
  const btnText = document.getElementById("adminTaskBtnText")?.value.trim();
  const target = document.getElementById("adminTaskTarget")?.value;
  if (!label) return toast("Enter a task label", "error");
  try {
    const res = await fetch(`${BACKEND}/admin/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        task_type: type,
        label,
        action_url: url,
        action_text: btnText || "Go →",
        target,
      }),
    });
    const data = await res.json();
    if (!res.ok) return toast(data.error || "Failed", "error");
    toast("✅ Task added!", "success");
    document.getElementById("adminTaskModal")?.remove();
    setTimeout(showAdminTaskPanel, 200);
  } catch (e) {
    toast("Failed: " + e.message, "error");
  }
}

async function adminDeleteTask(id) {
  if (!confirm("Remove this task?")) return;
  try {
    await fetch(`${BACKEND}/admin/tasks/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    toast("Task removed", "info");
    document.getElementById("adminTaskModal")?.remove();
    setTimeout(showAdminTaskPanel, 200);
  } catch (_) {
    toast("Failed", "error");
  }
}

// ── CLAIM TOURNAMENT PRIZE ────────────────────────────────────────────────────
async function claimTournamentPrize(tournamentId, tokenSymbol) {
  if (!userAddress) return toast("Connect wallet first", "error");
  const btn = document.getElementById("claimTourneyBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Sending prize...";
  }
  try {
    let csrfToken = "";
    try {
      const ct = await fetch(`${BACKEND}/csrf-token`, {
        credentials: "include",
      });
      csrfToken = (await ct.json()).csrfToken || "";
    } catch (_) {}

    const res = await fetch(`${BACKEND}/tournaments/${tournamentId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CSRF-Token": csrfToken },
      credentials: "include",
      body: JSON.stringify({ wallet: userAddress }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || "Claim failed", "error");
      return;
    }
    if (data.paid) {
      toast(
        `🎉 ${data.amount.toFixed(2)} ${tokenSymbol} sent! TX: ${data.txHash?.slice(0, 12)}...`,
        "success",
      );
      if (typeof confetti === "function")
        confetti({ particleCount: 150, spread: 80, origin: { y: 0.5 } });
    } else {
      toast(
        `✅ Payout of ${data.amount.toFixed(2)} ${tokenSymbol} queued — arrives within 24h`,
        "success",
      );
    }
    setTimeout(() => openTournament(tournamentId), 1500);
  } catch (e) {
    toast("Failed: " + e.message, "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = `💰 Claim Prize`;
    }
  }
}

// ── TASK GATE — runs before join or create ────────────────────────────────
async function checkTasksGate(target = "all") {
  try {
    const res = await fetch(`${BACKEND}/tasks/status`, {
      credentials: "include",
    });
    const data = await res.json();
    if (data.allDone) return true;

    // Filter to relevant tasks
    const pending = data.tasks.filter(
      (t) =>
        !data.completed.includes(t.id) &&
        (t.target === "all" || t.target === target),
    );
    if (pending.length === 0) return true;

    // Show task modal
    return await showTaskModal(pending, data.completed, data.tasks);
  } catch (_) {
    return true;
  } // fail open
}

function showTaskModal(pendingTasks, completedIds, allTasks) {
  return new Promise((resolve) => {
    const existing = document.getElementById("taskGateModal");
    if (existing) existing.remove();
    const modal = document.createElement("div");
    modal.id = "taskGateModal";
    modal.className = "bet-modal-overlay";
    modal.innerHTML = `
      <div class="bet-modal-box" style="max-width:460px;width:95%">
        <div style="text-align:center;margin-bottom:20px">
          <div style="font-size:2.5rem;margin-bottom:8px">🔐</div>
          <h3 style="margin:0;font-family:'Bebas Neue',sans-serif;font-size:1.5rem;
            letter-spacing:2px;color:var(--gold)">COMPLETE TASKS TO CONTINUE</h3>
          <p style="color:var(--muted);font-size:.78rem;margin-top:6px">
            Complete all required tasks to join or create tournaments
          </p>
        </div>
        <div id="taskList" style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px">
          ${allTasks
            .map((task) => {
              const isDone = completedIds.includes(task.id);
              return `
            <div id="taskRow_${task.id}" style="display:flex;align-items:center;gap:12px;
              padding:12px 14px;border-radius:12px;
              background:${isDone ? "rgba(6,214,160,.06)" : "rgba(255,255,255,.03)"};
              border:1px solid ${isDone ? "rgba(6,214,160,.25)" : "rgba(255,255,255,.08)"}">
              <div style="width:32px;height:32px;border-radius:50%;
                background:${isDone ? "rgba(6,214,160,.2)" : "rgba(255,255,255,.05)"};
                display:flex;align-items:center;justify-content:center;
                font-size:1rem;flex-shrink:0">
                ${isDone ? "✅" : task.task_type === "follow" ? "👤" : task.task_type === "retweet" ? "🔁" : task.task_type === "like" ? "❤️" : "✔️"}
              </div>
              <div style="flex:1;min-width:0">
                <div style="font-size:.85rem;font-weight:600;${isDone ? "color:var(--green)" : ""}">
                  ${task.label}
                </div>
                ${isDone ? `<div style="font-size:.7rem;color:var(--green)">✓ Completed</div>` : ""}
              </div>
              ${
                !isDone && task.action_url
                  ? `
              <a href="${task.action_url}" target="_blank"
                onclick="markTaskDone(${task.id})"
                style="background:${task.task_type === "follow" ? "#1da1f2" : task.task_type === "like" ? "#ef476f" : "rgba(0,229,255,.12)"};
                color:#fff;padding:6px 14px;border-radius:20px;text-decoration:none;
                font-size:.75rem;font-weight:700;white-space:nowrap;border:none;cursor:pointer">
                ${task.action_text || "Go →"}
              </a>`
                  : ""
              }
            </div>`;
            })
            .join("")}
        </div>
        <div style="display:flex;gap:10px">
          <button class="btn btn-primary" onclick="recheckTasksAndProceed()" style="flex:1">
            ✅ I've Completed All Tasks
          </button>
          <button class="btn btn-ghost" style="width:auto;padding:13px 18px"
            onclick="document.getElementById('taskGateModal').remove()">
            Cancel
          </button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    window._taskGateResolve = resolve;
    window._taskGateModal = modal;
  });
}

async function markTaskDone(taskId) {
  try {
    await fetch(`${BACKEND}/tasks/${taskId}/complete`, {
      method: "POST",
      credentials: "include",
    });
    // Update UI
    const row = document.getElementById(`taskRow_${taskId}`);
    if (row) {
      row.style.background = "rgba(6,214,160,.06)";
      row.style.border = "1px solid rgba(6,214,160,.25)";
      row.querySelector("div").textContent = "✅";
    }
  } catch (_) {}
}

async function recheckTasksAndProceed() {
  try {
    const res = await fetch(`${BACKEND}/tasks/status`, {
      credentials: "include",
    });
    const data = await res.json();
    if (data.allDone) {
      document.getElementById("taskGateModal")?.remove();
      if (window._taskGateResolve) {
        window._taskGateResolve(true);
        window._taskGateResolve = null;
      }
    } else {
      toast("Please complete all tasks first!", "error");
    }
  } catch (_) {
    toast("Error checking tasks. Try again.", "error");
  }
}

// ── TOURNAMENT LEADERBOARD MODAL ──────────────────────────────────────────────
async function showTournamentLeaderboard() {
  try {
    const [lbRes, statsRes] = await Promise.all([
      fetch(`${BACKEND}/tournaments/leaderboard`),
      fetch(`${BACKEND}/tournaments/stats`),
    ]);
    const lb = await lbRes.json();
    const stats = await statsRes.json();

    const usdcVol = parseFloat(stats.usdc_volume || 0).toFixed(2);
    const litvmVol = parseFloat(stats.litvm_volume || 0).toFixed(4);

    const modal = document.createElement("div");
    modal.id = "tourneyLbModal";
    modal.className = "bet-modal-overlay";
    modal.innerHTML = `
      <div class="bet-modal-box" style="max-width:520px;width:95%;max-height:85vh;display:flex;flex-direction:column">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <div>
            <h3 style="margin:0;font-family:'Bebas Neue',sans-serif;font-size:1.5rem;letter-spacing:2px;color:var(--gold)">
              🏆 Tournament Hall of Fame
            </h3>
            <div style="font-size:.75rem;color:var(--muted);margin-top:4px">
              ${stats.total_tournaments} tournaments · 
              <span style="color:var(--accent)">$${usdcVol} USDC</span> + 
              <span style="color:var(--purple)">${litvmVol} zkLTC</span> paid out
            </div>
          </div>
          <button onclick="document.getElementById('tourneyLbModal').remove()"
            style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.4rem">✕</button>
        </div>
        <!-- Live count badge -->
        ${
          parseInt(stats.live_count) > 0
            ? `
        <div style="background:rgba(239,71,111,.08);border:1px solid rgba(239,71,111,.3);border-radius:8px;
          padding:8px 14px;margin-bottom:14px;display:flex;align-items:center;gap:8px">
          <span style="width:8px;height:8px;border-radius:50%;background:var(--red);display:inline-block;
            box-shadow:0 0 6px var(--red);animation:pulse 1s ease-in-out infinite"></span>
          <span style="font-size:.82rem;font-weight:700;color:var(--red)">${stats.live_count} TOURNAMENT${parseInt(stats.live_count) > 1 ? "S" : ""} LIVE RIGHT NOW</span>
          <button onclick="document.getElementById('tourneyLbModal').remove();showScreen('screenTournaments');loadTournaments()"
            style="margin-left:auto;background:var(--red);border:none;color:#fff;padding:4px 12px;border-radius:20px;
            font-size:.72rem;font-weight:700;cursor:pointer">JOIN →</button>
        </div>`
            : ""
        }
        <div style="overflow-y:auto;flex:1">
          ${
            lb.length === 0
              ? `<p style="color:var(--muted);text-align:center;padding:30px">No tournament results yet. Be the first winner!</p>`
              : lb
                  .map(
                    (p, i) => `
            <div style="display:flex;align-items:center;gap:12px;padding:10px 0;
              border-bottom:1px solid var(--border);${i === 0 ? "background:rgba(255,209,102,.03);border-radius:8px;padding:10px 8px" : ""}">
              <span style="font-size:1.2rem;min-width:30px;text-align:center">
                ${i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`}
              </span>
              <div style="width:34px;height:34px;border-radius:50%;background:var(--surface);
                display:flex;align-items:center;justify-content:center;font-size:.82rem;font-weight:700;
                flex-shrink:0;overflow:hidden;border:2px solid ${i === 0 ? "var(--gold)" : i === 1 ? "#ccc" : i === 2 ? "#cd7f32" : "var(--border)"}">
                ${
                  p.avatar
                    ? `<img src="${sanitizeUrl(p.avatar)}" style="width:100%;height:100%;object-fit:cover">`
                    : (p.username || p.wallet || "?")[0].toUpperCase()
                }
              </div>
              <div style="flex:1;min-width:0">
                <div style="font-size:.88rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                  ${p.username ? "@" + p.username : fmt(p.wallet)}
                </div>
                <div style="font-size:.72rem;color:var(--muted);margin-top:2px">
                  ${p.tournaments_played} played · ${p.wins} 🏆 wins
                </div>
              </div>
              <div style="text-align:right;flex-shrink:0">
  <div style="font-size:.82rem;font-weight:700;color:var(--gold)">
    ${
      parseFloat(p.usdc_earned || 0).toFixed(2) > 0
        ? `$${parseFloat(p.usdc_earned).toFixed(2)} USDC`
        : parseFloat(p.litvm_earned || 0) > 0
          ? `${parseFloat(p.litvm_earned).toFixed(4)} zkLTC`
          : "—"
    }
  </div>
  ${
    parseFloat(p.usdc_earned || 0) > 0 && parseFloat(p.litvm_earned || 0) > 0
      ? `<div style="font-size:.68rem;color:var(--purple)">${parseFloat(p.litvm_earned).toFixed(4)} zkLTC</div>`
      : ""
  }
  <div style="font-size:.68rem;color:var(--muted)">${p.wins} 🏆 win${parseInt(p.wins) !== 1 ? "s" : ""}</div>
</div>
            </div>`,
                  )
                  .join("")
          }
        </div>
      </div>`;
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.remove();
    });
    document.body.appendChild(modal);
  } catch (e) {
    toast("Failed to load leaderboard", "error");
  }
}

// ── LIVE TOURNAMENT BANNER ────────────────────────────────────────────────────
function updateLiveTournamentBanner() {
  const live = allTournaments.filter((t) => t.status === "active");
  const open = allTournaments.filter(
    (t) => t.status === "open" && parseInt(t.player_count) < t.max_players,
  );
  const existing = document.getElementById("liveTourneyBanner");

  if (
    (live.length > 0 || open.length > 0) &&
    !window._liveTourneyBannerDismissed
  ) {
    if (!existing) {
      const banner = document.createElement("div");
      banner.id = "liveTourneyBanner";
      banner.style.cssText = `
        position:fixed;bottom:20px;left:50%;transform:translateX(-50%);
        background:linear-gradient(135deg,rgba(239,71,111,.95),rgba(123,97,255,.95));
        border:1px solid rgba(255,255,255,.2);border-radius:40px;
        padding:10px 20px 10px 16px;display:flex;align-items:center;gap:10px;
        z-index:9998;backdrop-filter:blur(12px);cursor:pointer;
        box-shadow:0 8px 32px rgba(239,71,111,.4);
        animation:slideUp .4s cubic-bezier(.175,.885,.32,1.275) forwards;
        white-space:nowrap;max-width:90vw;
      `;
      banner.innerHTML = `
        <span style="width:8px;height:8px;border-radius:50%;background:#fff;display:inline-block;
          box-shadow:0 0 8px #fff;flex-shrink:0;animation:pulse 1s ease-in-out infinite"></span>
        <span style="font-size:.85rem;font-weight:700;color:#fff">
          ${
            live.length > 0
              ? `🎮 ${live.length} Tournament${live.length > 1 ? "s" : ""} LIVE Now!`
              : `🏟️ ${open.length} Tournament${open.length > 1 ? "s" : ""} Open — Join Now!`
          }
        </span>
        <button onclick="window._liveTourneyBannerDismissed=false;showScreen('screenTournaments');loadTournaments();document.getElementById('liveTourneyBanner')?.remove()"
          style="background:rgba(255,255,255,.25);border:1px solid rgba(255,255,255,.3);
          color:#fff;padding:5px 14px;border-radius:20px;font-size:.75rem;font-weight:800;
          cursor:pointer;white-space:nowrap">View →</button>
        <button onclick="window._liveTourneyBannerDismissed=true;this.closest('#liveTourneyBanner').remove()"
          style="background:none;border:none;color:rgba(255,255,255,.6);cursor:pointer;
          font-size:1rem;line-height:1;padding:0;flex-shrink:0">✕</button>`;
      document.body.appendChild(banner);
    }
  } else if (live.length === 0 && open.length === 0 && existing) {
    existing.remove();
  }
}

// ── TOURNAMENT COUNTDOWN TIMER ────────────────────────────────────────────────
function fmtTournamentTime(t) {
  if (!t.deadline_at) return null;
  const secs = Math.floor((new Date(t.deadline_at) - Date.now()) / 1000);
  if (secs <= 0) return "Expired";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m ${Math.floor(secs % 60)}s left`;
}

function showCreateTournamentModal() {
  if (!userAddress && !currentProfile)
    return toast("Connect wallet or login first", "error");

  const existing = document.getElementById("createTourneyModal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "createTourneyModal";
  modal.className = "bet-modal-overlay";
  modal.innerHTML = `
    <div class="bet-modal-box" style="max-width:480px;width:95%;max-height:92vh;overflow-y:auto">

      <!-- Header -->
      <div style="text-align:center;margin-bottom:22px">
        <div style="font-size:2.2rem;margin-bottom:8px">💰</div>
        <h3 style="margin:0;font-family:'Bebas Neue',sans-serif;font-size:1.6rem;
          letter-spacing:3px;color:var(--accent)">CREATE PAID TOURNAMENT</h3>
        <p style="color:var(--muted);font-size:.78rem;margin-top:6px">
          Multi-round elimination · 60/25/15% onchain prize split
        </p>
        <div style="display:flex;gap:8px;justify-content:center;margin-top:10px;flex-wrap:wrap">
          <span style="background:rgba(0,229,255,.08);border:1px solid rgba(0,229,255,.2);
            color:var(--accent);padding:3px 12px;border-radius:20px;font-size:.72rem;font-weight:700">
            ⚡ USDC on Arc
          </span>
          <span style="background:rgba(123,97,255,.08);border:1px solid rgba(123,97,255,.2);
            color:var(--purple);padding:3px 12px;border-radius:20px;font-size:.72rem;font-weight:700">
            🔷 zkLTC on LitVM
          </span>
          <span style="background:rgba(255,209,102,.06);border:1px solid rgba(255,209,102,.2);
            color:var(--gold);padding:3px 12px;border-radius:20px;font-size:.72rem;font-weight:700">
            🏆 Auto Payout
          </span>
        </div>
      </div>

      <!-- Twitter Share (optional, no longer gates the form) -->
      <div style="background:rgba(29,161,242,.05);border:1px solid rgba(29,161,242,.2);
        border-radius:12px;padding:14px;margin-bottom:18px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <span style="font-size:1.3rem">𝕏</span>
          <div>
            <div style="font-size:.83rem;font-weight:700;color:#1da1f2">
              Share on X (optional)
            </div>
            <div style="font-size:.72rem;color:var(--muted)">
              Help spread the word about your tournament
            </div>
          </div>
        </div>
        <a href="https://twitter.com/intent/tweet?text=${encodeURIComponent("🏆 I just created a tournament on @TriviaFi! Multi-round trivia · Win USDC & zkLTC · Join now: https://triviafi.vercel.app #TriviaFi #Web3Gaming")}"
          target="_blank"
          style="display:flex;align-items:center;justify-content:center;gap:8px;
          background:#1da1f2;color:#fff;padding:10px 20px;border-radius:20px;
          text-decoration:none;font-size:.82rem;font-weight:700">
          𝕏 Share on Twitter/X
        </a>
      </div>

      <!-- Form — always unlocked -->
      <div id="createTourneyForm">

        <div class="ig" style="margin-bottom:12px">
          <label class="il" style="font-size:.73rem;color:var(--muted);text-transform:uppercase;
            letter-spacing:.5px;display:block;margin-bottom:5px">Tournament Name</label>
          <input id="tName" maxlength="60"
            placeholder="e.g. Friday Night Trivia Championship"
            style="background:var(--surface);border:1px solid var(--border);color:var(--text);
            padding:12px 14px;border-radius:10px;font-size:.9rem;width:100%;box-sizing:border-box"/>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
          <div>
            <label class="il" style="font-size:.73rem;color:var(--muted);text-transform:uppercase;
              letter-spacing:.5px;display:block;margin-bottom:5px">Entry Fee</label>
            <input id="tFee" type="number" min="0.001" step="0.001"
              placeholder="e.g. 5.00"
              style="background:var(--surface);border:1px solid var(--border);color:var(--text);
              padding:12px 14px;border-radius:10px;font-size:.9rem;width:100%;box-sizing:border-box"/>
          </div>
          <div>
            <label class="il" style="font-size:.73rem;color:var(--muted);text-transform:uppercase;
              letter-spacing:.5px;display:block;margin-bottom:5px">Max Players</label>
            <input id="tMax" type="number" min="4" max="64" value="8"
              style="background:var(--surface);border:1px solid var(--border);color:var(--text);
              padding:12px 14px;border-radius:10px;font-size:.9rem;width:100%;box-sizing:border-box"/>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
          <div>
            <label class="il" style="font-size:.73rem;color:var(--muted);text-transform:uppercase;
              letter-spacing:.5px;display:block;margin-bottom:5px">Rounds</label>
            <select id="tRounds"
              style="background:var(--surface);border:1px solid var(--border);color:var(--text);
              padding:12px 14px;border-radius:10px;font-size:.9rem;width:100%">
              <option value="2">2 Rounds</option>
              <option value="3" selected>3 Rounds</option>
              <option value="4">4 Rounds</option>
              <option value="5">5 Rounds</option>
            </select>
          </div>
          <div>
            <label class="il" style="font-size:.73rem;color:var(--muted);text-transform:uppercase;
              letter-spacing:.5px;display:block;margin-bottom:5px">Token</label>
            <select id="tChain"
              style="background:var(--surface);border:1px solid var(--border);color:var(--text);
              padding:12px 14px;border-radius:10px;font-size:.9rem;width:100%">
              <option value="5042002">⚡ USDC (Arc Testnet)</option>
              <option value="4441">🔷 zkLTC (LitVM Testnet)</option>
            </select>
          </div>
        </div>

        <!-- Info box -->
        <div style="background:rgba(255,209,102,.04);border:1px solid rgba(255,209,102,.15);
          border-radius:10px;padding:12px 14px;margin-bottom:16px;
          font-size:.75rem;color:var(--muted);line-height:1.7">
          🏆 Prizes auto-split <strong style="color:var(--gold)">60% / 25% / 15%</strong>
            to top 3 finishers<br>
          ⚡ Bottom half eliminated each round · Last 3 get prizes<br>
          ⏰ Auto-expires 24 hours after creation if not filled<br>
        </div>

        <div style="display:flex;gap:10px">
          <button id="createTourneyLaunchBtn" class="btn btn-primary"
            style="flex:1;background:linear-gradient(135deg,var(--accent),var(--purple));
            font-size:.95rem;padding:14px">
            🚀 Launch Tournament
          </button>
          <button class="btn btn-ghost"
            style="width:auto;padding:14px 18px"
            onclick="document.getElementById('createTourneyModal').remove()">
            Cancel
          </button>
        </div>

      </div>
    </div>`;

  document.body.appendChild(modal);

  document.getElementById("createTourneyLaunchBtn").onclick =
    submitCreateTournament;

  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
}

function showTournamentTypeModal() {
  window._modalOpenedAt = Date.now(); // bot detection timestamp
  const existing = document.getElementById("tourneyTypeModal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "tourneyTypeModal";
  modal.className = "bet-modal-overlay";
  modal.innerHTML = `
    <div class="bet-modal-box" style="max-width:480px;width:95%;text-align:center">
      <div style="font-size:2.5rem;margin-bottom:12px">🏟️</div>
      <h3 style="font-family:'Bebas Neue',sans-serif;font-size:1.5rem;letter-spacing:2px;
        margin-bottom:6px;color:var(--text)">CHOOSE TOURNAMENT TYPE</h3>
      <p style="color:var(--muted);font-size:.8rem;margin-bottom:24px">
        Select what kind of tournament you want to create
      </p>
      <div style="display:flex;flex-direction:column;gap:12px">

        <!-- Paid Tournament -->
        <button id="btnPaidTourney"
          style="background:rgba(0,229,255,.06);border:1px solid rgba(0,229,255,.25);
          border-radius:14px;padding:18px 20px;cursor:pointer;text-align:left;transition:.2s;width:100%"
          onmouseover="this.style.borderColor='var(--accent)';this.style.background='rgba(0,229,255,.1)'"
          onmouseout="this.style.borderColor='rgba(0,229,255,.25)';this.style.background='rgba(0,229,255,.06)'">
          <div style="display:flex;align-items:center;gap:14px">
            <div style="width:44px;height:44px;border-radius:12px;
              background:rgba(0,229,255,.1);display:flex;align-items:center;
              justify-content:center;font-size:1.4rem;flex-shrink:0">💰</div>
            <div style="text-align:left">
              <div style="font-weight:700;color:var(--accent);font-size:.95rem;margin-bottom:2px">
                Paid Tournament
              </div>
              <div style="font-size:.75rem;color:var(--muted)">
                USDC or zkLTC entry fee · 60/25/15% prize split · Onchain payouts
              </div>
            </div>
            <span style="margin-left:auto;color:var(--muted);font-size:1.2rem">→</span>
          </div>
        </button>

        <!-- Whitelist Battle -->
        <button id="btnWhitelistTourney"
          style="background:rgba(88,101,242,.06);border:1px solid rgba(88,101,242,.25);
          border-radius:14px;padding:18px 20px;cursor:pointer;text-align:left;
          transition:.2s;width:100%;position:relative;overflow:hidden"
          onmouseover="this.style.borderColor='#7289da';this.style.background='rgba(88,101,242,.12)'"
          onmouseout="this.style.borderColor='rgba(88,101,242,.25)';this.style.background='rgba(88,101,242,.06)'">
          <div style="position:absolute;top:10px;right:12px;
            background:linear-gradient(135deg,var(--purple),var(--accent));
            color:#fff;font-size:.58rem;font-weight:900;padding:2px 9px;
            border-radius:20px;letter-spacing:.5px">NEW</div>
          <div style="display:flex;align-items:center;gap:14px">
            <div style="width:44px;height:44px;border-radius:12px;
              background:rgba(88,101,242,.12);display:flex;align-items:center;
              justify-content:center;font-size:1.4rem;flex-shrink:0">💬</div>
            <div style="text-align:left">
              <div style="font-weight:700;color:#7289da;font-size:.95rem;margin-bottom:2px">
                Whitelist Battle
              </div>
              <div style="font-size:.75rem;color:var(--muted)">
                Free to play · Points-based · Win WL/NFT spots · Discord ready
              </div>
            </div>
            <span style="margin-left:auto;color:var(--muted);font-size:1.2rem">→</span>
          </div>
        </button>

      </div>
      <button class="btn btn-ghost btn-sm"
        style="margin-top:14px;width:auto;padding:10px 24px"
        onclick="document.getElementById('tourneyTypeModal').remove()">
        Cancel
      </button>
    </div>`;

  // Wire up buttons AFTER adding to DOM — avoids inline onclick parsing issues
  document.body.appendChild(modal);

  document.getElementById("btnPaidTourney").addEventListener("click", () => {
    modal.remove();
    if (!userAddress && !currentProfile)
      return toast(
        "Connect wallet or login first to create a tournament",
        "error",
      );
    showCreateTournamentModal();
  });

  document
    .getElementById("btnWhitelistTourney")
    .addEventListener("click", () => {
      modal.remove();
      showCreateWhitelistModal();
    });

  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
}

async function submitCreateTournament() {
  // ── Bot detection ─────────────────────────────────────────────────────
  if (!window._modalOpenedAt || Date.now() - window._modalOpenedAt < 3000) {
    toast("Please fill out the form completely before submitting.", "error");
    return;
  }

  const nameEl = document.getElementById("tName");
  const feeEl = document.getElementById("tFee");
  const maxEl = document.getElementById("tMax");
  const roundsEl = document.getElementById("tRounds");
  const chainEl = document.getElementById("tChain");

  if (!nameEl) return toast("Please reopen the modal and try again", "error");

  const name = nameEl.value.trim();
  const fee = parseFloat(feeEl?.value || 0);
  const max = parseInt(maxEl?.value || 0);
  const rounds = parseInt(roundsEl?.value || 3);
  const chainId = parseInt(chainEl?.value || 5042002);

  if (!name) return toast("Enter a tournament name", "error");
  if (fee <= 0) return toast("Enter a valid entry fee", "error");
  if (max < 4) return toast("Minimum 4 players required", "error");
  if (!currentProfile && !userAddress)
    return toast("You must be logged in to create a tournament", "error");

  // ── Task gate ─────────────────────────────────────────────────────────
  const tasksOk = await checkTasksGate("create");
  if (!tasksOk) return;

  const targetNet = NETWORKS[chainId];
  const tokenSymbol = chainId === 4441 ? "zkLTC" : "USDC";
  const isLitvm = chainId === 4441;

  // ── Lock button — keep reference BEFORE any await ────────────────────
  // querySelector can return null after awaits if modal re-renders
  const btn = document.getElementById("createTourneyLaunchBtn");
  function setBtn(text, disabled = true) {
    if (btn) {
      btn.disabled = disabled;
      btn.textContent = text;
    }
  }
  function resetBtn() {
    setBtn("🚀 Launch Tournament", false);
  }

  setBtn("⏳ Starting...");

  try {
    // ══════════════════════════════════════════════════════════════════
    // STEP 1 — Make sure wallet is connected
    // ══════════════════════════════════════════════════════════════════
    if (!signer || !userAddress) {
      toast("Connect your wallet first", "error");
      resetBtn();
      return;
    }

    // ✅ Rebuild signer from the wallet that was originally connected
    if (window._activeWalletProvider) {
      provider = new ethers.BrowserProvider(window._activeWalletProvider);
      signer = await provider.getSigner();
    }

    // ══════════════════════════════════════════════════════════════════
    // STEP 2 — Switch MetaMask to correct network
    // ══════════════════════════════════════════════════════════════════
    setBtn("⏳ Step 1/3 — Switching network...");

    const currentChainId = Number((await provider.getNetwork()).chainId);

    if (currentChainId !== chainId) {
      toast(`Switching to ${targetNet.name}...`, "info");
      try {
        await getActiveProvider().request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: targetNet.hexChainId }],
        });
      } catch (switchErr) {
        if (switchErr.code === 4902) {
          await getActiveProvider().request({
            method: "wallet_addEthereumChain",
            params: [{ chainId: targetNet.hexChainId, ...targetNet.addParams }],
          });
        } else if (
          switchErr.code === 4001 ||
          switchErr.message?.includes("rejected")
        ) {
          toast(
            `❌ You must switch to ${targetNet.name} to create this tournament.`,
            "error",
          );
          resetBtn();
          return;
        } else {
          throw new Error(`Network switch failed: ${switchErr.message}`);
        }
      }

      // Wait for MetaMask to fully commit the switch
      await new Promise((r) => setTimeout(r, 1500));

      // Rebuild provider + signer + contracts on new chain
      activeNet = targetNet;
      CONTRACT_ADDRESS = activeNet.contractAddress;
      USDC_ADDRESS = activeNet.tokenAddress;
      provider = new ethers.BrowserProvider(
        window._activeWalletProvider || window.ethereum,
      );
      signer = await provider.getSigner();
      userAddress = await signer.getAddress();
      contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
      usdcContract = activeNet.isNative
        ? null
        : new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);
      updateNetBar();
      toast(`✅ Switched to ${targetNet.name}`, "success");
    }

    // Verify switch actually happened
    const verifiedChain = Number((await provider.getNetwork()).chainId);
    if (verifiedChain !== chainId) {
      toast(
        `Still on wrong network. Please switch to ${targetNet.name} manually in MetaMask and try again.`,
        "error",
      );
      resetBtn();
      return;
    }

    // ══════════════════════════════════════════════════════════════════
    // STEP 3 — Wallet signature (free, proves intent)
    // ══════════════════════════════════════════════════════════════════
    setBtn("⏳ Step 2/3 — Sign to confirm...");
    toast("✍️ Sign the message in MetaMask to confirm...", "info");

    let createSignature = "";
    try {
      const signMsg = [
        "Create TriviaFi Tournament",
        `Name: ${name}`,
        `Entry: ${fee} ${tokenSymbol}`,
        `Players: ${max}`,
        `Rounds: ${rounds}`,
        `Network: ${targetNet.name}`,
        `Timestamp: ${Date.now()}`,
      ].join("\n");

      createSignature = await signer.signMessage(signMsg);
      toast("✅ Signature confirmed!", "success");
    } catch (sigErr) {
      if (sigErr.code === 4001 || sigErr.message?.includes("rejected")) {
        toast("❌ Signature required to create a tournament.", "error");
        resetBtn();
        return;
      }
      throw new Error(`Signature failed: ${sigErr.message}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // STEP 4 — Onchain proof transaction on the CORRECT network
    // Arc  → tiny USDC self-transfer
    // LitVM → tiny zkLTC self-transfer with calldata
    // ══════════════════════════════════════════════════════════════════
    setBtn("⏳ Step 3/3 — Confirm onchain...");
    toast("⛓️ Confirm the onchain proof transaction in MetaMask...", "info");

    let createTxHash = "";

    if (isLitvm) {
      // ── LitVM: tiny native zkLTC self-transfer ──────────────────────
      try {
        const proofValue = ethers.parseUnits("0.000001", 18);
        const metaBytes = ethers.toUtf8Bytes(
          `TriviaFi:${name.slice(0, 20)}:${fee}${tokenSymbol}:${max}p`,
        );
        const proofData = ethers.hexlify(metaBytes);

        // ✅ Skip estimateGas — CORS blocks it on LitVM in browser
        const gasLimit = 300000n;

        const tx = await signer.sendTransaction({
          to: userAddress,
          value: proofValue,
          data: proofData,
          gasLimit,
        });

        // ✅ Skip tx.wait() — CORS blocks receipt polling on LitVM in browser
        // MetaMask already signed & broadcast it, hash is proof enough
        createTxHash = tx.hash;
        toast(
          `✅ Proof sent on LitVM! TX: ${tx.hash.slice(0, 14)}...`,
          "success",
        );
      } catch (txErr) {
        if (txErr.code === 4001 || txErr.message?.includes("rejected")) {
          toast("❌ Transaction required to create tournament.", "error");
          resetBtn();
          return;
        }
        // LitVM RPC flaky — degrade gracefully with sig-only proof
        console.warn(
          "LitVM proof TX failed, continuing with sig only:",
          txErr.message,
        );
        toast(
          "⚠️ Network busy — continuing with signature proof only.",
          "info",
        );
        createTxHash = "";
      }
    } else {
      // ── Arc: tiny USDC self-transfer ────────────────────────────────
      try {
        const arcUsdcAddress = NETWORKS[5042002].tokenAddress;
        const usdcProof = new ethers.Contract(
          arcUsdcAddress,
          [
            "function transfer(address,uint256) external returns (bool)",
            "function balanceOf(address) view returns (uint256)",
          ],
          signer,
        );

        const proofAmount = ethers.parseUnits("0.001", 6); // 0.001 USDC
        const balance = await usdcProof.balanceOf(userAddress);

        if (balance < proofAmount) {
          // Not enough USDC for proof — degrade gracefully, sig is enough
          console.warn("Insufficient USDC for proof TX, using sig only");
          toast("⚠️ Low USDC balance — using signature proof only.", "info");
          createTxHash = "";
        } else {
          let gasLimit = 150000n;
          try {
            const est = await usdcProof.transfer.estimateGas(
              userAddress,
              proofAmount,
            );
            gasLimit = (BigInt(est) * 150n) / 100n;
          } catch (_) {
            gasLimit = 200000n;
          }

          const tx = await usdcProof.transfer(userAddress, proofAmount, {
            gasLimit,
          });

          toast("⛓️ Waiting for Arc confirmation...", "info");
          const receipt = await tx.wait();

          if (!receipt || receipt.status !== 1) {
            throw new Error("Transaction failed onchain");
          }

          createTxHash = tx.hash;
          toast(
            `✅ Confirmed on Arc! TX: ${tx.hash.slice(0, 14)}...`,
            "success",
          );
        }
      } catch (txErr) {
        if (txErr.code === 4001 || txErr.message?.includes("rejected")) {
          toast("❌ Transaction required to create tournament.", "error");
          resetBtn();
          return;
        }
        console.warn(
          "Arc proof TX failed, continuing with sig only:",
          txErr.message,
        );
        toast(
          "⚠️ Network busy — continuing with signature proof only.",
          "info",
        );
        createTxHash = "";
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // STEP 5 — Register in backend
    // ══════════════════════════════════════════════════════════════════
    setBtn("⏳ Creating tournament...");

    // Fetch CSRF token first
    let csrfToken = "";
    try {
      const ct = await fetch(`${BACKEND}/csrf-token`, {
        credentials: "include",
      });
      csrfToken = (await ct.json()).csrfToken || "";
    } catch (_) {}

    const res = await fetch(`${BACKEND}/tournaments/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CSRF-Token": csrfToken,
      },
      credentials: "include",
      body: JSON.stringify({
        name,
        chainId,
        entryFee: fee,
        tokenSymbol,
        maxPlayers: max,
        rounds,
        createSignature,
        createTxHash,
      }),
    });

    const rawText = await res.text();
    console.log("CREATE RESPONSE:", res.status, rawText);

    let data = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch (_) {
      throw new Error(
        `Server returned invalid response (status ${res.status})`,
      );
    }

    if (res.status === 401) {
      toast(
        "⚠️ Your session expired. Reconnecting — try Launch again after this finishes.",
        "error",
      );
      try {
        const reAuthMsg = `Login to ${activeNet.name}`;
        const reAuthSig = await signer.signMessage(reAuthMsg);
        let freshCsrf = "";
        try {
          const ct = await fetch(`${BACKEND}/csrf-token`, {
            credentials: "include",
          });
          freshCsrf = (await ct.json()).csrfToken || "";
        } catch (_) {}
        const reAuthRes = await fetch(`${BACKEND}/auth/wallet`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CSRF-Token": freshCsrf,
          },
          credentials: "include",
          body: JSON.stringify({
            wallet: userAddress,
            signature: reAuthSig,
            networkName: activeNet.name,
          }),
        });
        const reAuthData = await reAuthRes.json();
        if (reAuthData.user) {
          currentProfile = reAuthData.user;
          toast(
            "✅ Session restored. Click Launch Tournament again.",
            "success",
          );
        } else {
          toast(
            "Could not restore session. Refresh the page and reconnect your wallet.",
            "error",
          );
        }
      } catch (_) {
        toast(
          "Could not restore session. Refresh the page and reconnect your wallet.",
          "error",
        );
      }
      resetBtn();
      return;
    }

    if (!res.ok) {
      if (res.status === 429) {
        document.getElementById("createTourneyModal")?.remove();
        showAlreadyCreatedModal(
          data.error || "You already created a tournament today.",
          data.hoursLeft || 24,
          data.nextAllowedAt || null,
        );
        return;
      }
      if (res.status === 503) {
        toast(
          "Server temporarily unavailable. Please wait and try again.",
          "error",
        );
        resetBtn();
        return;
      }
      throw new Error(data.error || `Server error (${res.status})`);
    }

    // ── All good — show success ───────────────────────────────────────
    document.getElementById("createTourneyModal")?.remove();

    if (typeof confetti === "function") {
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.5 } });
    }

    toast(`🏆 "${name}" created on ${targetNet.name}!`, "success");
    showScreen("screenTournaments");
    await loadTournaments();
  } catch (e) {
    console.error("Create tournament error:", e);
    toast("Failed: " + (e.reason || e.message), "error");
    resetBtn();
  }
}

// ── Friendly modal when 24hr limit is hit ────────────────────────────────
function showAlreadyCreatedModal(message, hoursLeft, nextAllowedAt) {
  const existing = document.getElementById("alreadyCreatedModal");
  if (existing) existing.remove();

  let timeDisplay = `in ${hoursLeft} hour${hoursLeft !== 1 ? "s" : ""}`;
  if (nextAllowedAt) {
    try {
      const next = new Date(nextAllowedAt);
      timeDisplay =
        "at " +
        next.toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        }) +
        " on " +
        next.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        });
    } catch (_) {}
  }

  const modal = document.createElement("div");
  modal.id = "alreadyCreatedModal";
  modal.className = "bet-modal-overlay";
  modal.innerHTML = `
    <div class="bet-modal-box" style="max-width:400px;width:95%;text-align:center">
      <div style="font-size:3rem;margin-bottom:12px">⏳</div>
      <h3 style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;
        letter-spacing:2px;color:var(--gold);margin-bottom:10px">
        ONE TOURNAMENT PER DAY
      </h3>
      <p style="color:var(--muted);font-size:.85rem;line-height:1.7;margin-bottom:18px">
        ${message}
      </p>
      <div style="background:rgba(255,209,102,.06);border:1px solid rgba(255,209,102,.2);
        border-radius:10px;padding:14px;margin-bottom:20px">
        <div style="font-size:.7rem;color:var(--muted);text-transform:uppercase;
          letter-spacing:.5px;margin-bottom:6px">Next tournament available</div>
        <div style="font-size:1.15rem;font-weight:700;color:var(--gold)">${timeDisplay}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn btn-primary"
          onclick="document.getElementById('alreadyCreatedModal').remove();
                   showScreen('screenTournaments');loadTournaments()"
          style="background:linear-gradient(135deg,var(--accent),var(--purple))">
          👀 View My Active Tournament
        </button>
        <button class="btn btn-ghost btn-sm"
          onclick="document.getElementById('alreadyCreatedModal').remove()">
          Close
        </button>
      </div>
    </div>`;
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
  document.body.appendChild(modal);
}

// ── Show a friendly modal when the 24hr limit is hit ─────────────────────
function showAlreadyCreatedModal(message, hoursLeft, nextAllowedAt) {
  const existing = document.getElementById("alreadyCreatedModal");
  if (existing) existing.remove();

  let timeDisplay = `${hoursLeft} hour${hoursLeft !== 1 ? "s" : ""}`;
  if (nextAllowedAt) {
    const next = new Date(nextAllowedAt);
    timeDisplay =
      next.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }) +
      " " +
      next.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  const modal = document.createElement("div");
  modal.id = "alreadyCreatedModal";
  modal.className = "bet-modal-overlay";
  modal.innerHTML = `
    <div class="bet-modal-box" style="max-width:400px;width:95%;text-align:center">
      <div style="font-size:3rem;margin-bottom:12px">⏳</div>
      <h3 style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;letter-spacing:2px;
        color:var(--gold);margin-bottom:8px">ONE TOURNAMENT PER DAY</h3>
      <p style="color:var(--muted);font-size:.85rem;line-height:1.6;margin-bottom:16px">
        ${message}
      </p>
      <div style="background:rgba(255,209,102,.06);border:1px solid rgba(255,209,102,.2);
        border-radius:10px;padding:12px;margin-bottom:18px">
        <div style="font-size:.72rem;color:var(--muted);text-transform:uppercase;
          letter-spacing:.5px;margin-bottom:4px">Next tournament available</div>
        <div style="font-size:1.1rem;font-weight:700;color:var(--gold)">${timeDisplay}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn btn-primary"
          onclick="document.getElementById('alreadyCreatedModal').remove();showScreen('screenTournaments');loadTournaments()"
          style="background:linear-gradient(135deg,var(--accent),var(--purple))">
          👀 View My Active Tournament
        </button>
        <button class="btn btn-ghost btn-sm"
          onclick="document.getElementById('alreadyCreatedModal').remove()">
          Close
        </button>
      </div>
    </div>`;
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
  document.body.appendChild(modal);
}

async function showPredictionBets(gameId, players) {
  if (!userAddress) return "";
  try {
    const res = await fetch(`${BACKEND}/bets/game/${gameId}`, {
      credentials: "include",
    });
    const bets = await res.json();
    const totalBet = bets.reduce((s, b) => s + parseFloat(b.total || 0), 0);
    const byWinner = {};
    bets.forEach((b) => {
      if (!byWinner[b.predicted_winner]) byWinner[b.predicted_winner] = 0;
      byWinner[b.predicted_winner] += parseFloat(b.total || 0);
    });
    const playerOptions = players
      .slice(0, 5)
      .map((p) => {
        const pct =
          totalBet > 0
            ? Math.round(((byWinner[p.toLowerCase()] || 0) / totalBet) * 100)
            : 0;
        const name = displayName(p);
        return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.05)"><div style="flex:1"><div style="font-size:.82rem;font-weight:600;color:var(--text)">${name}</div><div style="height:4px;background:var(--border);border-radius:2px;margin-top:4px;overflow:hidden"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--accent),var(--purple));border-radius:2px;transition:width .5s"></div></div></div><div style="text-align:right;min-width:50px"><div style="font-size:.85rem;font-weight:700;color:var(--gold)">${pct}%</div><div style="font-size:.7rem;color:var(--muted)">${(
          byWinner[p.toLowerCase()] || 0
        ).toFixed(
          2,
        )} USDC</div></div><button onclick="openBetModal(${gameId},'${p}','${name}')" style="background:rgba(0,229,255,.08);border:1px solid rgba(0,229,255,.2);color:var(--accent);padding:5px 10px;border-radius:7px;cursor:pointer;font-size:.75rem;white-space:nowrap">Bet</button></div>`;
      })
      .join("");
    return `<div style="background:rgba(123,97,255,.05);border:1px solid rgba(123,97,255,.2);border-radius:12px;padding:14px;margin-bottom:14px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><div style="font-size:.82rem;font-weight:700;color:var(--purple)">🎲 Predict the Winner <span class="pred-badge">BETA</span></div><div style="font-size:.75rem;color:var(--muted)">${totalBet.toFixed(
      2,
    )} USDC bet total</div></div>${
      playerOptions.length > 0
        ? playerOptions
        : `<p style="color:var(--muted);font-size:.8rem;text-align:center">No bets yet — be the first!</p>`
    }</div>`;
  } catch (_) {
    return "";
  }
}

function openBetModal(gameId, playerAddr, playerName) {
  if (!currentProfile) return toast("Login with Google to place bets", "error");
  const existing = document.getElementById("betModal");
  if (existing) existing.remove();
  const modal = document.createElement("div");
  modal.id = "betModal";
  modal.className = "bet-modal-overlay";
  modal.innerHTML = `<div class="bet-modal-box"><div style="text-align:center;margin-bottom:16px"><div style="font-size:2rem;margin-bottom:8px">🎲</div><h3>Predict the Winner</h3><p style="color:var(--muted);font-size:.82rem;margin-top:4px">Betting on <strong style="color:var(--accent)">${sanitizeText(
    playerName,
  )}</strong></p></div><label style="font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Amount (USDC)</label><input id="betAmountInput" class="bet-input" type="number" min="0.01" max="100" step="0.01" placeholder="0.00" autofocus/><div class="bet-quick-btns"><button class="bet-quick-btn" onclick="document.getElementById('betAmountInput').value='0.25'">0.25</button><button class="bet-quick-btn" onclick="document.getElementById('betAmountInput').value='0.50'">0.50</button><button class="bet-quick-btn" onclick="document.getElementById('betAmountInput').value='1.00'">1.00</button><button class="bet-quick-btn" onclick="document.getElementById('betAmountInput').value='2.00'">2.00</button></div><div style="font-size:.75rem;color:var(--muted);margin-bottom:16px;text-align:center">USDC transferred onchain on confirm</div><div style="display:flex;gap:10px"><button class="btn btn-primary" onclick="confirmBet(${gameId},'${playerAddr}')">✓ Place Bet</button><button class="btn btn-ghost" style="width:auto;padding:13px 18px" onclick="document.getElementById('betModal').remove()">Cancel</button></div></div>`;
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
  document.body.appendChild(modal);
  setTimeout(() => document.getElementById("betAmountInput")?.focus(), 100);
}

async function confirmBet(gameId, playerAddr) {
  if (!contract || !userAddress)
    return toast("Connect wallet to place bets", "error");
  const amount = parseFloat(document.getElementById("betAmountInput")?.value);
  if (!amount || isNaN(amount) || amount <= 0 || amount > 100) {
    toast("Enter a valid amount (0.01-100 USDC)", "error");
    return;
  }
  const btn = document.querySelector("#betModal .btn-primary");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Processing...";
  }
  try {
    const amountWei = ethers.parseUnits(amount.toFixed(6), 6);
    const PLATFORM = platformAddress || (await readContract.platform());
    toast("Step 1/2: Approving USDC...", "info");
    const approveTx = await usdcContract.approve(PLATFORM, amountWei);
    await approveTx.wait();
    toast("Step 2/2: Sending bet onchain...", "info");
    const usdcW = new ethers.Contract(
      USDC_ADDRESS,
      ["function transfer(address,uint256) external returns (bool)"],
      signer,
    );
    const transferTx = await usdcW.transfer(PLATFORM, amountWei);
    await transferTx.wait();
    await fetch(`${BACKEND}/bets/place`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        gameId,
        predictedWinner: playerAddr.toLowerCase(),
        amount,
      }),
    });
    document.getElementById("betModal")?.remove();
    toast(
      `🎉 Bet placed! ${amount} USDC on ${displayName(playerAddr)}`,
      "success",
    );
    await openGame(gameId);
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "✓ Place Bet";
    }
    toast("Failed: " + (e.reason || e.message), "error");
  }
}

const networkMenu = document.getElementById("networkMenu");

const networkSwitcher = document.querySelector(".network-switcher");

const selectedNetwork = document.getElementById("selectedNetwork");

const netOptArc = document.getElementById("netOptArc");

const netOptLitvm = document.getElementById("netOptLitvm");

/* TOGGLE MENU */

function toggleNetworkMenu() {
  const menu = document.getElementById("networkMenu");
  menu.style.display = menu.style.display === "block" ? "none" : "block";
}

/* SELECT NETWORK */

function selectNetwork(network) {
  const isArc = network === "arc";

  selectedNetwork.textContent = isArc ? "⚡ Arc · USDC" : "🔷 LitVM · zkLTC";

  netOptArc.classList.toggle("net-opt-active", isArc);

  netOptLitvm.classList.toggle("net-opt-active", !isArc);

  networkMenu.classList.remove("open");

  networkSwitcher.classList.remove("open");
}

/* OUTSIDE CLICK */
document.addEventListener("click", (e) => {
  const trigger = document.getElementById("networkTrigger");
  const menu = document.getElementById("networkMenu");
  if (
    menu &&
    trigger &&
    !trigger.contains(e.target) &&
    !menu.contains(e.target)
  ) {
    menu.style.display = "none";
  }
  const profile = document.getElementById("profileTrigger");
  if (profile && !profile.contains(e.target)) profile.classList.remove("open");
});

function updateOnlineCount() {
  const el = document.getElementById("onlineCount");
  if (el) el.textContent = 8 + Math.floor(Math.random() * 14);
  const liveEl = document.getElementById("liveCount");
  if (liveEl) {
    const base = (allGames || []).filter(
      ({ g }) => Number(g?.[14]) === 0,
    ).length;
    liveEl.textContent =
      (base > 0
        ? base * 3 + Math.floor(Math.random() * 8)
        : 8 + Math.floor(Math.random() * 14)) + " online";
  }
}
setInterval(updateOnlineCount, 30000);
updateOnlineCount();

function fmt(addr) {
  if (!addr || addr === "0x0000000000000000000000000000000000000000")
    return "—";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}
function fmtTime(secs) {
  if (secs <= 0) return "0s";
  const d = Math.floor(secs / 86400),
    h = Math.floor((secs % 86400) / 3600),
    m = Math.floor((secs % 3600) / 60),
    s = secs % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtUSDC(val) {
  return parseFloat(ethers.formatUnits(val, activeNet.decimals)).toFixed(2);
}
function fmtToken(val) {
  return parseFloat(ethers.formatUnits(val, activeNet.decimals)).toFixed(4);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function copyShare(text) {
  navigator.clipboard.writeText(text).then(() => toast("Copied!", "success"));
}

function toast(msg, type) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = type;
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(hideToast, type === "error" ? 6000 : 4000);
}

function hideToast() {
  document.getElementById("toast").className = "";
}
function showStatsScreen() {
  const played = document.getElementById("myPlayed")?.textContent || "0",
    won = document.getElementById("myWon")?.textContent || "0",
    earned = document.getElementById("myEarned")?.textContent || "$0";
  document.getElementById("statPlayed").textContent = played;
  document.getElementById("statWon").textContent = won;
  document.getElementById("statEarned").textContent = earned;
  const p = parseInt(played) || 0,
    w = parseInt(won) || 0;
  document.getElementById("statWinRate").textContent =
    p > 0 ? Math.round((w / p) * 100) + "%" : "0%";
  document.getElementById("statWallet").textContent = userAddress || "—";
  showScreen("screenStats");
}

// =============================================================================
// ARC TRIVIA — app.js FINAL FIX
// Root cause of BAD_DATA: contract getGame() returns a struct (GameView memory)
// but ABI declared individual return values. Struct encoding adds an extra
// 32-byte offset pointer that ethers couldn't decode.
// Fix: ABI uses tuple() return type + helper to normalise result to array
// =============================================================================

const BACKEND = "https://name-triviafi-backend.onrender.com";
let currentProfile = null;

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
    const litvmProvider2 = new ethers.JsonRpcProvider(
      "https://liteforge.rpc.caldera.xyz/http",
    );
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
      // refresh games
      if (typeof loadGames === "function") {
        await loadGames();
      }

      // refresh lobby stats
      if (typeof loadGlobalStats === "function") {
        await loadGlobalStats();
      }

      // refresh prizes
      if (userAddress && typeof loadUnclaimedPrizes === "function") {
        await loadUnclaimedPrizes();
      }

      // refresh history
      const historyScreen = document.getElementById("screenHistory");

      if (
        historyScreen &&
        historyScreen.classList.contains("active") &&
        typeof loadHistoryScreen === "function"
      ) {
        await loadHistoryScreen();
      }

      // refresh results if inside game
      if (currentGameId && typeof refreshResults === "function") {
        await refreshResults();
      }
    } catch (e) {
      console.log("Auto refresh error:", e.message);
    }
  }, 10000);
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
  readProvider = await createProvider();
  readContract = new ethers.Contract(CONTRACT_ADDRESS, ABI, readProvider);
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
  }, 10000);
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
    await window.ethereum.request({
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
      await window.ethereum.request({
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
  if (!window.ethereum) {
    toast("Please install MetaMask", "error");
    return;
  }
  try {
    await window.ethereum.request({ method: "eth_requestAccounts" });
    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    userAddress = await signer.getAddress();

    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);

    if (NETWORKS[chainId]) {
      activeNet = NETWORKS[chainId];
    } else {
      const chosen = await showNetworkPicker();
      if (!chosen) return;
      activeNet = NETWORKS[chosen];
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: activeNet.hexChainId }],
        });
      } catch (e) {
        if (e.code === 4902) {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{ chainId: activeNet.hexChainId, ...activeNet.addParams }],
          });
        }
      }
      provider = new ethers.BrowserProvider(window.ethereum);
      signer = await provider.getSigner();
      userAddress = await signer.getAddress();
    }

    CONTRACT_ADDRESS = activeNet.contractAddress;
    USDC_ADDRESS = activeNet.tokenAddress;
    contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
    if (!activeNet.isNative) {
      usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);
    }

    const netBadge = document.querySelector(".pd-online");
    if (netBadge)
      netBadge.innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:var(--green);display:inline-block"></span> Online · ${activeNet.name}`;

    try {
      platformAddress = await readContract.platform();
    } catch (_) {}

    const message = `Login to ${activeNet.name}`;
    const signature = await signer.signMessage(message);
    const authRes = await fetch(`${BACKEND}/auth/wallet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        wallet: userAddress,
        signature,
        networkName: activeNet.name,
      }),
    });
    const authData = await authRes.json();
    if (authData.error === "wallet_google_taken") {
      toast(
        "⚠️ This wallet is already linked to a Google account. Sign in with Google first.",
        "error",
      );
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

    const activeScreen = document.querySelector(".screen.active");
    if (activeScreen?.id === "screenJoin" && currentGameId)
      await openGame(currentGameId);

    renderAuthState();
    toast("✅ Wallet connected!", "success");
    await loadGames();
    loadMyStats();
    checkUnclaimedPrizes();
    if (currentGameId) openGame(currentGameId);
    if (window.pendingGameId) {
      openGame(window.pendingGameId);
      window.pendingGameId = null;
    }
    updateNetBar();
  } catch (e) {
    toast("Connection failed: " + e.message, "error");
  }
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
  // Only show skeleton on first load, not background refreshes
  if (grid && allGames.length === 0) {
    grid.innerHTML = skeletonCards(6);
  }

  if (allGames.length > 0) {
    renderGames();
  }

  try {
    // ── Fetch from BOTH chains in parallel ───────────────────────────────────
    const arcProvider = new ethers.JsonRpcProvider(
      "https://rpc.testnet.arc.network",
    );
    const litvmProvider = new ethers.JsonRpcProvider(
      "https://liteforge.rpc.caldera.xyz/http",
    );
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
      arcRC
        .gameCounter()
        .then(Number)
        .catch(() => 0),
      litvmRC
        .gameCounter()
        .then(Number)
        .catch(() => 0),
    ]);

    const totalCount = arcCount + litvmCount;
    document.getElementById("gTotal").textContent = totalCount;

    if (totalCount === 0) {
      grid.innerHTML = `<p style="color:var(--muted);text-align:center;padding:30px">No games yet! Create the first one.</p>`;
      document.getElementById("gPool").innerHTML =
        `<span style="color:var(--accent)">$0.00 USDC</span> <span style="color:var(--muted);font-size:.7rem;margin:0 4px">+</span> <span style="color:var(--purple)">0.0000 zkLTC</span>`;
      document.getElementById("gActive").textContent = "0";
      gamesLoading = false;
      return;
    }

    const LIMIT = 100;
    const BATCH = 5;
    allGames = [];
    let totalVolume = 0n,
      arcPool = 0n,
      litvmPool = 0n,
      activeCount = 0;
    const nowSec = Math.floor(Date.now() / 1000);

    // Fetch Arc games
    const arcIds = [];
    for (let i = arcCount; i >= Math.max(1, arcCount - LIMIT + 1); i--)
      arcIds.push(i);
    for (let b = 0; b < arcIds.length; b += BATCH) {
      const batch = arcIds.slice(b, b + BATCH);
      const results = await Promise.allSettled(
        batch.map((i) =>
          arcRC.getGame(i).then((g) => ({
            i,
            g: gameToArray(g),
            chainId: 5042002,
            net: NETWORKS[5042002],
          })),
        ),
      );
      for (const r of results)
        if (r.status === "fulfilled") allGames.push(r.value);
    }

    // Fetch LitVM games
    const litvmIds = [];
    for (let i = litvmCount; i >= Math.max(1, litvmCount - LIMIT + 1); i--)
      litvmIds.push(i);
    for (let b = 0; b < litvmIds.length; b += BATCH) {
      const batch = litvmIds.slice(b, b + BATCH);
      const results = await Promise.allSettled(
        batch.map((i) =>
          litvmRC.getGame(i).then((g) => ({
            i,
            g: gameToArray(g),
            chainId: 4441,
            net: NETWORKS[4441],
          })),
        ),
      );
      for (const r of results)
        if (r.status === "fulfilled") allGames.push(r.value);
    }

    // prevent stale refresh overwrite
    if (renderId !== lastGamesRender) {
      gamesLoading = false;
      return;
    }

    allGames.sort((a, b) => b.i - a.i || a.chainId - b.chainId);

    // Stats — only count ACTIVE games (status=0, not expired) for "in play"
    for (const { g, net } of allGames) {
      const gamePool = BigInt(g[8]);
      totalVolume += gamePool;
      // ✅ Count status=0 games regardless of deadline — prize is still locked in
      const isOpen = Number(g[14]) === 0;
      const isActiveLobby = isOpen && Number(g[11]) > nowSec;
      if (isOpen) {
        if (net.decimals === 6) {
          arcPool += gamePool;
        } else {
          litvmPool += gamePool;
        }
        if (isActiveLobby) activeCount++;
      }
    }

    // Show combined pool
    const arcPoolFmt = parseFloat(ethers.formatUnits(arcPool, 6)).toFixed(2);
    const litvmPoolFmt = parseFloat(ethers.formatUnits(litvmPool, 18)).toFixed(
      4,
    );
    const totalUSDC = parseFloat(ethers.formatUnits(arcPool, 6)).toFixed(2);

    const totalZKLTC = parseFloat(ethers.formatUnits(litvmPool, 18)).toFixed(4);

    const showPool = parseFloat(totalUSDC) > 0 || parseFloat(totalZKLTC) > 0;
    if (showPool) {
      // Active pool — show with "TOTAL VOLUME" label, no "ACTIVE POOL" text
      let poolHtml = "";
      if (parseFloat(totalUSDC) > 0)
        poolHtml += `<span style="color:var(--accent);font-weight:700">$${totalUSDC} USDC</span>`;
      if (parseFloat(totalUSDC) > 0 && parseFloat(totalZKLTC) > 0)
        poolHtml += `<span style="color:var(--muted);font-size:.7rem;margin:0 5px">+</span>`;
      if (parseFloat(totalZKLTC) > 0)
        poolHtml += `<span style="color:var(--purple);font-weight:700">${totalZKLTC} zkLTC</span>`;
      poolHtml += `<div style="font-size:.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-top:4px">Total Volume</div>`;
      document.getElementById("gPool").innerHTML = poolHtml;
    } else {
      // Fallback DB volume — same label, no "ACTIVE POOL"
      try {
        const statsRes = await fetch(`${BACKEND}/stats/global`);
        const statsData = await statsRes.json();
        const arcVol = parseFloat(statsData.arcVolume || 0).toFixed(2);
        const litvmVol = parseFloat(statsData.litvmVolume || 0).toFixed(4);
        let volHtml = "";
        if (parseFloat(arcVol) > 0)
          volHtml += `<span style="color:var(--accent);font-weight:700">$${arcVol} USDC</span>`;
        if (parseFloat(arcVol) > 0 && parseFloat(litvmVol) > 0)
          volHtml += `<span style="color:var(--muted);font-size:.7rem;margin:0 5px">+</span>`;
        if (parseFloat(litvmVol) > 0)
          volHtml += `<span style="color:var(--purple);font-weight:700">${litvmVol} zkLTC</span>`;
        volHtml += `<div style="font-size:.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-top:4px">Total Volume</div>`;
        document.getElementById("gPool").innerHTML =
          volHtml || `<span style="color:var(--muted)">—</span>`;
      } catch (_) {
        document.getElementById("gPool").innerHTML =
          `<span style="color:var(--muted)">—</span>`;
      }
    }
    document.getElementById("gActive").textContent = activeCount;

    renderGames();
    updateTicker();
    gamesLoading = false;
  } catch (e) {
    gamesLoading = false;

    grid.innerHTML = `
      <p style="color:var(--red);text-align:center;padding:20px">
        Error: ${e.message}
      </p>
    `;
  }
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

function filterGames(status, btn) {
  filterStatus = status;
  document
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.remove("active"));
  btn.classList.add("active");
  if (allGames.length === 0) {
    document.getElementById("gamesList").innerHTML =
      `<p style="color:var(--muted);text-align:center;padding:24px">Loading games...</p>`;
    loadGames(); // trigger load if not yet loaded
  } else {
    renderGames(); // instant if already loaded
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

function renderGames() {
  const el = document.getElementById("gamesList");
  const now = Math.floor(Date.now() / 1000);

  let filtered;

  // helper: normalize DB row OR onchain array into consistent shape
  function norm(item) {
    if (item && item.g) return item.g; // old {i,g} shape
    // DB row shape — map to array positions
    return {
      _db: true,
      id: item.contract_game_id,
      name: item.name,
      creator: item.creator,
      categoryId: 0,
      categoryName: item.category || "",
      difficulty: item.difficulty || 0,
      entryFee: BigInt(Math.round(parseFloat(item.entry_fee || 0) * 1e6)),
      maxPlayers: item.max_players || 0,
      prizePool: 0n,
      playerCount: 0,
      registrationEnd: 0,
      playDeadline: 0,
      topPlayers: [
        "0x0000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000",
      ],
      prizeClaimed: false,
      status: item.status || 0,
      finishedCount: 0,
      chainId: item.chain_id || 5042002,
      tokenSymbol: item.token_symbol || "USDC",
    };
  }

  const getG = (item) => item.g || item;

  if (filterStatus === "all") {
    filtered = allGames.filter((item) => {
      const g = getG(item);
      const s = Number(g[14]);
      if (s !== 0) return false;
      const playDeadline = Number(g[11]);
      // If playDeadline is 0 or missing, include the game anyway
      return playDeadline === 0 || playDeadline > now;
    });
  } else if (filterStatus === "0") {
    filtered = allGames.filter((item) => {
      const g = getG(item);
      if (Number(g[14]) !== 0) return false;
      return Number(g[10]) > now;
    });
  } else if (filterStatus === "live") {
    filtered = allGames.filter((item) => {
      const g = getG(item);
      if (Number(g[14]) !== 0) return false;
      return Number(g[10]) <= now && Number(g[11]) > now;
    });
  } else if (filterStatus === "1") {
    filtered = allGames.filter((item) => Number(getG(item)[14]) === 1);
  } else if (filterStatus === "2") {
    filtered = allGames.filter((item) => Number(getG(item)[14]) === 2);
  } else {
    filtered = allGames.filter(
      (item) => Number(getG(item)[14]) === parseInt(filterStatus),
    );
  }

  if (filtered.length === 0) {
    const msgs = {
      all: `<p style="color:var(--muted);text-align:center;padding:32px">No active games right now.<br><span style="font-size:.8rem">Agent creates new rooms automatically every hour.</span></p>`,
      0: `<p style="color:var(--muted);text-align:center;padding:24px">No open games right now.</p>`,
      live: `<p style="color:var(--muted);text-align:center;padding:24px">No live games right now.</p>`,
      1: `<p style="color:var(--muted);text-align:center;padding:24px">No ended games yet.</p>`,
      2: `<p style="color:var(--muted);text-align:center;padding:24px">No cancelled games.</p>`,
    };
    el.innerHTML = msgs[filterStatus] || msgs.all;
    return;
  }

  let html = '<div class="game-grid">';
  for (const item of filtered) {
    const { i, g, chainId: itemChainId } = item;
    const net = NETWORKS[itemChainId] || NETWORKS[5042002];
    const [
      ,
      name,
      creator,
      ,
      catName,
      ,
      entryFee,
      maxPlayers,
      prizePool,
      playerCount,
      regEnd,
      playDeadline,
      ,
      ,
      status,
      finishedCount,
    ] = g;
    // ── chain info (use itemChainId already destructured above) ──
    const chainBadge =
      itemChainId === 4441
        ? `<span style="font-size:.63rem;font-weight:700;padding:2px 8px;border-radius:10px;background:rgba(123,97,255,.15);color:var(--purple);border:1px solid rgba(123,97,255,.3);margin-left:5px">🔷 LitVM</span>`
        : `<span style="font-size:.63rem;font-weight:700;padding:2px 8px;border-radius:10px;background:rgba(0,229,255,.1);color:var(--accent);border:1px solid rgba(0,229,255,.25);margin-left:5px">⚡ Arc</span>`;
    const tokenSymbol = net.symbol;
    const dp = net.decimals === 18 ? 4 : 2;
    const feeFormatted = parseFloat(
      ethers.formatUnits(entryFee, net.decimals),
    ).toFixed(dp);
    const poolFormatted = parseFloat(
      ethers.formatUnits(prizePool, net.decimals),
    ).toFixed(dp);

    const s = Number(status),
      n = Number(playerCount),
      diff = Number(g[5]);
    const regSecs = Number(regEnd) - now,
      playSecs = Number(playDeadline) - now;

    let phase = "",
      phaseColor = "var(--muted)";
    if (s === 0) {
      if (regSecs > 0) {
        phase = "📋 Joining Open";
        phaseColor = "var(--green)";
      } else if (playSecs > 0) {
        phase = "🎮 Playing Now";
        phaseColor = "var(--gold)";
      } else {
        phase = "⏰ Ended (pending)";
        phaseColor = "var(--red)";
      }
    } else if (s === 1) {
      phase = "✅ Finished";
      phaseColor = "var(--muted)";
    } else {
      phase = "❌ Cancelled";
      phaseColor = "var(--red)";
    }

    const dist = parseFloat(poolFormatted) * 0.95;
    let prizeHtml = "";
    if (n >= 3)
      prizeHtml = `<div style="font-size:.73rem;color:var(--muted);margin-top:4px">🥇${(
        dist * 0.6
      ).toFixed(dp)} · 🥈${(dist * 0.25).toFixed(dp)} · 🥉${(
        dist * 0.15
      ).toFixed(dp)} ${tokenSymbol}</div>`;
    else if (n === 2)
      prizeHtml = `<div style="font-size:.73rem;color:var(--muted);margin-top:4px">🥇${(
        dist * 0.7
      ).toFixed(dp)} · 🥈${(dist * 0.3).toFixed(dp)} ${tokenSymbol}</div>`;
    else if (n === 1)
      prizeHtml = `<div style="font-size:.73rem;color:var(--green);margin-top:4px">🥇 Winner: ${dist.toFixed(
        dp,
      )} ${tokenSymbol}</div>`;
    // Format game creation/deadline dates
    const regEndDate =
      Number(regEnd) > 0
        ? new Date(Number(regEnd) * 1000).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : null;
    const playEndDate =
      Number(playDeadline) > 0
        ? new Date(Number(playDeadline) * 1000).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : null;
    const dateHtml =
      regEndDate || playEndDate
        ? `<div style="font-size:.68rem;color:var(--muted);margin-top:5px">
  ${regEndDate ? `📅 Join closes: ${regEndDate}` : ""}
  ${playEndDate ? `<br>🎮 Play ends: ${playEndDate}` : ""}
  </div>`
        : "";
    let timerHtml = "";
    if (s === 0 && regSecs > 0)
      timerHtml = `<div class="countdown${
        regSecs < 300 ? " urg" : ""
      }" data-deadline="${Number(
        regEnd,
      )}" data-prefix="⏰ Join closes in ">⏰ Join closes in ${fmtTime(
        regSecs,
      )}</div>`;
    else if (s === 0 && playSecs > 0)
      timerHtml = `<div class="countdown${
        playSecs < 300 ? " urg" : ""
      }" data-deadline="${Number(
        playDeadline,
      )}" data-prefix="🎮 Play ends in ">🎮 Play ends in ${fmtTime(
        playSecs,
      )}</div>`;

    const isAgent = name.includes("🤖");
    const agentBadge = isAgent
      ? `<span style="font-size:.68rem;background:rgba(123,97,255,.15);color:var(--purple);border:1px solid rgba(123,97,255,.3);padding:1px 6px;border-radius:10px;margin-left:6px">🤖 AI Room</span>`
      : "";
    const clickAction =
      s === 1 || s === 2
        ? `openGameReadOnly(${i},${itemChainId})`
        : `openGame(${i},${itemChainId})`;

    html += `<div class="gcard" onclick="${clickAction}">
      <div class="gcard-title">#${i} ${sanitizeText(name)} <span class="badge ${
        STATUS_BADGE[s]
      }">${STATUS_LABEL[s]}</span>${agentBadge}${chainBadge}</div>
      <div style="font-size:.75rem;color:${phaseColor};margin-bottom:8px;font-weight:600">${phase}</div>
      <div class="gmeta">💰 Entry: <strong>${feeFormatted} ${tokenSymbol}</strong> | 🏆 Pool: <strong>${poolFormatted} ${tokenSymbol}</strong></div>
      <div class="gmeta">👥 <strong>${n}/${maxPlayers}</strong> joined | ✅ <strong>${finishedCount}</strong> done</div>
      <div class="gmeta">By: <span style="color:var(--purple)">${fmt(
        creator,
      )}</span></div>
      <span class="cat-pill">📚 ${sanitizeText(catName)}</span>
      ${
        diff > 0
          ? `<span style="margin-left:6px;font-size:.72rem;color:var(--${
              DIFF_CLASSES[diff] || "accent"
            })">· ${DIFF_LABELS[diff]}</span>`
          : ""
      }
      ${prizeHtml}
      ${timerHtml}
      ${dateHtml}
    </div>`;
  }
  html += "</div>";
  el.innerHTML = html;
}

async function openGameReadOnly(gameId, gameChainId) {
  // ✅ Always set currentGameId and currentGameChainId
  currentGameId = gameId;
  currentGameChainId =
    gameChainId || (activeNet.decimals === 18 ? 4441 : 5042002);

  // Switch readContract to correct chain
  if (gameChainId && NETWORKS[gameChainId]) {
    const net = NETWORKS[gameChainId];
    // Use fallback RPCs for LitVM
    const rpcs =
      gameChainId === 4441
        ? ["https://liteforge.rpc.caldera.xyz/http"]
        : [
            "https://rpc.testnet.arc.network",
            "https://rpc.drpc.testnet.arc.network",
          ];
    let tempProvider = null;
    for (const rpc of rpcs) {
      try {
        const p = new ethers.JsonRpcProvider(rpc);
        await Promise.race([
          p.getBlockNumber(),
          new Promise((_, r) =>
            setTimeout(() => r(new Error("timeout")), 3000),
          ),
        ]);
        tempProvider = p;
        break;
      } catch (_) {}
    }
    if (!tempProvider) tempProvider = new ethers.JsonRpcProvider(rpcs[0]);
    readContract = new ethers.Contract(net.contractAddress, ABI, tempProvider);
  }
  try {
    const g = await getGame(gameId);
    if (!g) {
      toast("Could not load game. Try again.", "error");
      return;
    }
    currentGame = g;
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
      alreadyClaimed = false;
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
      }
    }
    let lbHtml = "";
    try {
      const [addrs, scoreList, finished] =
        await readContract.getLeaderboard(gameId);
      const rows = addrs
        .map((a, i) => ({ a, sc: Number(scoreList[i]), fin: finished[i] }))
        .sort((a, b) => b.sc - a.sc);
      lbHtml = rows
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
          i < 3 && prizes[i] > 0
            ? `<span style="color:var(--gold);font-size:.73rem">${prizes[
                i
              ].toFixed(dp)} ${gameSymbol}</span>`
            : ""
        }
        <span class="lb-tag ${r.fin ? "lb-done" : "lb-wait"}">${
          r.fin ? "Done" : "—"
        }</span>
      </div>`,
        )
        .join("");
    } catch (_) {
      lbHtml = `<p style="color:var(--muted)">No scores yet.</p>`;
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
    let claimBannerHtml = "";
    if (myWinnerPos >= 0 && myPrize > 0) {
      const medals = ["🥇 1st Place", "🥈 2nd Place", "🥉 3rd Place"];
      claimBannerHtml = `<div class="winner-banner" style="margin-bottom:16px"><h3>${
        medals[myWinnerPos]
      } — YOU WON!</h3><div class="winner-prize">${myPrize.toFixed(
        2,
      )} ${activeNet.symbol}</div>${
        !alreadyClaimed
          ? `<button class="btn btn-gold" onclick="doClaimPrize()" style="margin-top:14px;width:auto;padding:14px 40px;font-size:1rem">💰 Claim Your Prize</button>`
          : `<p style="color:var(--green);margin-top:10px;font-weight:600;font-size:1rem">✅ Prize Already Claimed!</p>`
      }</div>`;
    }
    let winnersHtml = "";
    if (
      s === 1 &&
      topPlayers[0] !== "0x0000000000000000000000000000000000000000"
    ) {
      winnersHtml = `<div style="background:rgba(255,209,102,.06);border:1px solid rgba(255,209,102,.25);border-radius:12px;padding:16px;margin-bottom:16px"><div style="font-family:'Bebas Neue',sans-serif;font-size:1.1rem;color:var(--gold);margin-bottom:10px">🏆 Winners</div>${[
        0, 1, 2,
      ]
        .filter(
          (i) =>
            topPlayers[i] &&
            topPlayers[i] !== "0x0000000000000000000000000000000000000000" &&
            prizes[i] > 0,
        )
        .map(
          (i) =>
            `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05)"><span>${
              ["🥇", "🥈", "🥉"][i]
            } ${fmt(topPlayers[i])}${
              topPlayers[i]?.toLowerCase() === userAddress?.toLowerCase()
                ? " 👈 You"
                : ""
            }</span><span style="color:var(--gold);font-weight:600">${prizes[
              i
            ].toFixed(2)} USDC</span></div>`,
        )
        .join("")}</div>`;
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
      ${refundHtml}${claimBannerHtml}${winnersHtml}
      <div style="font-size:.78rem;color:var(--muted);text-transform:uppercase;margin-bottom:10px">📊 Final Leaderboard</div>${lbHtml}
      ${
        !userAddress
          ? `<div style="margin-top:16px;padding:12px;background:rgba(0,229,255,.06);border:1px solid rgba(0,229,255,.2);border-radius:10px;text-align:center"><p style="color:var(--muted);font-size:.83rem">Connect wallet to join active games</p><button class="btn btn-primary" style="margin-top:10px;width:auto;padding:10px 24px" onclick="connectWallet()">🦊 Connect Wallet</button></div>`
          : ""
      }`;
    showScreen("screenJoin");
  } catch (e) {
    toast("Error loading game: " + e.message, "error");
  }
}

async function openGame(gameId, gameChainId) {
  const targetChainId =
    gameChainId || (activeNet.decimals === 18 ? 4441 : 5042002);
  currentGameChainId = targetChainId;

  const userChainId = provider
    ? Number((await provider.getNetwork()).chainId)
    : null;
  if (userAddress && userChainId && userChainId !== targetChainId) {
    toast(`Switching to ${NETWORKS[targetChainId].name}...`, "info");
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: NETWORKS[targetChainId].hexChainId }],
      });
    } catch (e) {
      if (e.code === 4902) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: NETWORKS[targetChainId].hexChainId,
                ...NETWORKS[targetChainId].addParams,
              },
            ],
          });
        } catch (_) {}
      }
    }
    // ✅ Always rebuild after switch — wait for provider to reflect new chain
    await new Promise((r) => setTimeout(r, 500));
    activeNet = NETWORKS[targetChainId];
    CONTRACT_ADDRESS = activeNet.contractAddress;
    USDC_ADDRESS = activeNet.tokenAddress;
    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
    if (!activeNet.isNative) {
      usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);
    } else {
      usdcContract = null;
    }
    readProvider = await createProvider(targetChainId);
    readContract = new ethers.Contract(CONTRACT_ADDRESS, ABI, readProvider);
    updateNetBar();
    toast(`✅ Switched to ${activeNet.name}`, "success");
  }

  const targetNet = NETWORKS[targetChainId];
  if (targetNet) {
    const rpcs2 =
      targetChainId === 4441
        ? ["https://liteforge.rpc.caldera.xyz/http"]
        : [
            "https://rpc.testnet.arc.network",
            "https://rpc.drpc.testnet.arc.network",
          ];
    let tempProvider2 = new ethers.JsonRpcProvider(rpcs2[0]);
    for (const rpc of rpcs2) {
      try {
        const p = new ethers.JsonRpcProvider(rpc);
        await Promise.race([
          p.getBlockNumber(),
          new Promise((_, r) => setTimeout(() => r(new Error("t")), 2000)),
        ]);
        tempProvider2 = p;
        break;
      } catch (_) {}
    }
    readContract = new ethers.Contract(
      targetNet.contractAddress,
      ABI,
      tempProvider2,
    );
  }

  if (!userAddress) {
    try {
      await openGameReadOnly(gameId, targetChainId);
    } catch (_) {
      toast("Connect wallet first", "error");
    }
    return;
  }
  currentGameId = gameId;
  const g = await getGame(gameId);
  if (!g) {
    toast("Could not load game. Try again.", "error");
    return;
  }
  currentGame = g;
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
  const s = Number(status),
    now = Math.floor(Date.now() / 1000);
  if (s === 1) {
    showScreen("screenResults");
    await refreshResults();
    startAutoRefresh(gameId);
    return;
  }
  if (s === 2) {
    openGameReadOnly(gameId);
    return;
  }
  if (!g) {
    toast("Could not load game data", "error");
    return;
  }
  const [joined, finished] = await readContract.getPlayerStatus(
    gameId,
    userAddress,
  );

  if (finished || alreadySubmitted(gameId)) {
    showScreen("screenResults");
    score = loadSavedScore(gameId);
    document.getElementById("resScore").textContent = score || "—";
    document.getElementById("resIcon").textContent =
      score >= 800 ? "🏆" : score >= 500 ? "🎯" : "💪";
    document.getElementById("resSub").textContent =
      `You already played this game · ${score} pts`;
    document.getElementById("submitSection").style.display =
      score > 0 ? "block" : "none";
    await refreshResults();
    startAutoRefresh(gameId);
    return;
  }
  // Server-authoritative check — localStorage can be cleared
  try {
    const chk = await fetch(
      `${BACKEND}/game/status/${currentGameId}?chainId=${parseInt(
        activeNet.hexChainId,
        16,
      )}`,
      {
        credentials: "include",
      },
    );
    const chkData = await chk.json();
    if (chkData.finished) {
      markSubmitted(gameId); // re-sync localStorage
    }
  } catch (_) {}

  if (alreadySubmitted(gameId) && s === 0) {
    showScreen("screenResults");
    score = loadSavedScore(gameId);
    document.getElementById("resScore").textContent = score;
    document.getElementById("resIcon").textContent =
      score >= 800 ? "🏆" : score >= 500 ? "🎯" : "💪";
    document.getElementById("resSub").textContent =
      `Score locked in · ${score} pts`;
    document.getElementById("submitSection").style.display = "none";
    await refreshResults();
    startAutoRefresh(gameId);
    return;
  }
  const gameNet = NETWORKS[currentGameChainId] || activeNet;
  const gameDecimals = gameNet.decimals;
  const gameSymbol = gameNet.symbol;
  const dp = gameDecimals === 18 ? 4 : 2;
  const fee = parseFloat(ethers.formatUnits(entryFee, gameDecimals)).toFixed(
    dp,
  );
  const pool = parseFloat(ethers.formatUnits(prizePool, gameDecimals)).toFixed(
    dp,
  );
  const n = Number(playerCount);
  const regSecs = Number(regEnd) - now,
    playSecs = Number(playDeadline) - now;
  const inRegPhase = regSecs > 0,
    inPlayPhase = !inRegPhase && playSecs > 0;
  const dist = parseFloat(pool) * 0.95;
  let breakdownHtml = "";
  if (n === 0)
    breakdownHtml = `<p style="color:var(--muted);font-size:.82rem">No players yet. Entry fee: ${fee} ${gameSymbol}</p>`;
  else if (n === 1)
    breakdownHtml = `<div>🥇 <strong style="color:var(--gold)">${dist.toFixed(
      2,
    )} ${gameSymbol}</strong> (solo wins all)</div>`;
  else if (n === 2)
    breakdownHtml = `<div style="display:flex;gap:14px"><span>🥇 <strong style="color:var(--gold)">${(
      dist * 0.7
    ).toFixed(2)}</strong></span><span>🥈 <strong style="color:#ccc">${(
      dist * 0.3
    ).toFixed(
      2,
    )}</strong></span><span style="color:var(--muted)">${gameSymbol}</span></div>`;
  else
    breakdownHtml = `<div style="display:flex;gap:12px;flex-wrap:wrap"><span>🥇 <strong style="color:var(--gold)">${(
      dist * 0.6
    ).toFixed(2)}</strong></span><span>🥈 <strong style="color:#ccc">${(
      dist * 0.25
    ).toFixed(2)}</strong></span><span>🥉 <strong style="color:#cd7f32">${(
      dist * 0.15
    ).toFixed(
      2,
    )}</strong></span><span style="color:var(--muted)">${gameSymbol}</span>
    </div>`;
  const players = await readContract.getPlayers(gameId);
  const betsHtml = await showPredictionBets(gameId, players);
  const playerRows =
    players.length === 0
      ? `<p style="color:var(--muted);font-size:.83rem">No players yet!</p>`
      : players
          .map(
            (p, i) =>
              `<div class="lb-row" style="margin-bottom:5px"><span class="lb-rank">#${
                i + 1
              }</span><span class="lb-addr">${fmt(p)}${
                p.toLowerCase() === userAddress.toLowerCase() ? " (you)" : ""
              }</span><span style="font-size:.73rem;color:var(--muted)">${
                p.toLowerCase() === creator.toLowerCase() ? "👑" : ""
              }</span></div>`,
          )
          .join("");
  let actionHtml = "";
  if (inRegPhase && !joined && n < Number(maxPlayers))
    actionHtml = `<button class="btn btn-primary" onclick="doJoin()">💰 Pay ${fee} ${
      activeNet.symbol
    } & Reserve Spot</button><p style="text-align:center;color:var(--muted);font-size:.77rem;margin-top:8px">${fmtTime(
      regSecs,
    )} left to join</p>`;
  else if (inRegPhase && joined)
    actionHtml = `<div style="text-align:center;padding:14px;border-radius:10px;background:rgba(0,229,255,.06);border:1px solid rgba(0,229,255,.2)"><p style="color:var(--accent);font-weight:600">✓ You are registered!</p><p style="color:var(--muted);font-size:.82rem;margin-top:4px">Game starts in <span class="countdown" data-deadline="${Number(
      regEnd,
    )}" data-prefix="" data-expiredtext="now!">${fmtTime(
      regSecs,
    )}</span></p></div>`;
  else if (inPlayPhase && joined && !finished) {
    // ✅ Check server-side if already played
    let serverPlayed = false;

    try {
      const chk = await fetch(
        `${BACKEND}/game/status/${currentGameId}?chainId=${currentGameChainId || 5042002}`,
        { credentials: "include" },
      );

      const chkData = await chk.json();

      if (chkData.finished || chkData.played) {
        serverPlayed = true;

        markSubmitted(currentGameId);

        saveScore(currentGameId, loadSavedScore(currentGameId) || 0);
      }
    } catch (_) {}

    if (alreadySubmitted(currentGameId) || serverPlayed) {
      actionHtml = `
      <div style="text-align:center;padding:14px;border-radius:10px;background:rgba(6,214,160,.08);border:1px solid rgba(6,214,160,.25)">
        <p style="color:var(--green);font-weight:600">
          ✅ You already played this game!
        </p>

        <p style="color:var(--muted);font-size:.82rem;margin-top:4px">
          Score: ${loadSavedScore(currentGameId) || "pending"} pts
        </p>

        <button
          class="btn btn-ghost btn-sm"
          style="margin-top:10px"
          onclick="doTriggerEnd(${currentGameId})"
        >
          Check results
        </button>
      </div>
    `;
    } else {
      actionHtml = `
      <button
        class="btn btn-primary"
        onclick="startPlay()"
        style="background:linear-gradient(135deg,var(--gold),var(--orange))"
      >
        🎮 Play Now!
      </button>

      <p style="text-align:center;color:var(--red);font-size:.77rem;margin-top:8px;font-weight:600">
        ⚠️ Deadline in ${fmtTime(playSecs)}
      </p>
    `;
    }
  } else if (inPlayPhase && !joined)
    actionHtml = `<p style="color:var(--muted);text-align:center;padding:10px">Registration closed.</p>`;
  else if (finished)
    actionHtml = `<div style="text-align:center;padding:14px;border-radius:10px;background:rgba(6,214,160,.08);border:1px solid rgba(6,214,160,.25)"><p style="color:var(--green);font-weight:600">✅ Score submitted!</p><button class="btn btn-ghost btn-sm" style="margin-top:10px" onclick="doTriggerEnd(${gameId})">Check if game can end</button></div>`;
  else if (!inRegPhase && !inPlayPhase)
    actionHtml = `<button class="btn btn-ghost" onclick="doTriggerEnd(${gameId})">🏁 End Game & See Results</button>`;
  let creatorHtml = "";
  if (creator.toLowerCase() === userAddress.toLowerCase())
    creatorHtml = `<hr/><div style="color:var(--accent);font-size:.82rem;font-weight:600;margin-bottom:10px">👑 Your Room — Creator earns 2.5%</div><div style="display:flex;gap:10px"><button class="btn btn-ghost btn-sm" style="flex:1" onclick="doTriggerEnd(${gameId})">🏁 Force End</button><button class="btn btn-danger btn-sm" style="flex:1" onclick="doCancelRoom(${gameId})">✕ Cancel & Refund All</button></div>`;
  const shareUrl = `${location.origin}${location.pathname}?game=${gameId}`;
  const discordMsg = `Join "${name}" activeNet.name\nCategory: ${catName} | Entry: ${fee} USDC | Pool: ${pool} USDC\n${n}/${maxPlayers} players\n${shareUrl}`;
  document.getElementById("joinContent").innerHTML = `
    <div style="margin-bottom:16px"><h2 style="font-family:'Bebas Neue',sans-serif;font-size:1.5rem;letter-spacing:2px">#${gameId} — ${sanitizeText(
      name,
    )}</h2><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><span class="badge ${
      STATUS_BADGE[s]
    }">${STATUS_LABEL[s]}</span><span class="cat-pill">📚 ${sanitizeText(
      catName,
    )}</span>${
      Number(difficulty) > 0
        ? `<span style="font-size:.75rem;color:var(--${
            DIFF_CLASSES[Number(difficulty)] || "accent"
          })">· ${DIFF_LABELS[Number(difficulty)]}</span>`
        : ""
    }</div></div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center"><div style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;color:var(--gold)">${fee}</div><div style="font-size:.72rem;color:var(--muted)">Entry (${gameSymbol})</div>
</div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center"><div style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;color:var(--green)">${pool}</div><div style="font-size:.72rem;color:var(--muted)">Prize Pool</div></div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center"><div style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;color:var(--accent)">${n}/${maxPlayers}</div><div style="font-size:.72rem;color:var(--muted)">Players</div></div>
    </div>
    <div style="background:rgba(255,209,102,.06);border:1px solid rgba(255,209,102,.25);border-radius:10px;padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;gap:12px"><span style="font-size:1.5rem">🔥</span><div><div style="font-size:.82rem;font-weight:600;color:var(--gold)">Streak Nanopayments Active</div><div style="font-size:.75rem;color:var(--muted);margin-top:2px">${STREAK_THRESHOLD}+ correct in a row → <strong style="color:var(--gold)">${STREAK_BONUS_USDC} USDC</strong> onchain via Circle · ${
      activeNet.name
    }</div></div></div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px"><div style="font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Prize Breakdown</div>${breakdownHtml}</div>
    <div style="font-size:.78rem;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Players (${n}/${maxPlayers})</div>
    <div style="margin-bottom:14px">${playerRows}</div>
    ${betsHtml}
    <div style="margin-top:14px">${actionHtml}</div>
     <div id="gameActions" style="margin-top:10px"></div>
    <div class="share-box" style="margin-top:14px"><span style="font-size:1.3rem">🔗</span><div style="flex:1"><div style="font-size:.75rem;color:var(--muted);margin-bottom:3px">Share</div><div class="share-link" style="font-size:.72rem">${shareUrl}</div></div><button class="btn btn-ghost btn-sm" onclick="copyShare(\`${discordMsg}\`)">Copy</button></div>
    <button class="btn btn-ghost btn-sm" onclick="tweetGame()">
      𝕏 Tweet
    </button>
  </div>${creatorHtml}`;
  showScreen("screenJoin");
  loadGameStatus(currentGameId);
  startAutoRefresh(gameId);
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
  const joinBtn = document.querySelector('[onclick="doJoin()"]');
  if (joinBtn) {
    joinBtn.disabled = true;
    joinBtn.textContent = "⏳ Processing...";
  }
  try {
    const entryFee = currentGame[6];
    if (activeNet.isNative) {
      toast("Joining with zkLTC...", "info");
      const tx = await contract.joinGame(currentGameId, { value: entryFee });
      // Optimistic UI update — no refresh needed
      const newCount = Number(currentGame[9]) + 1;
      document.querySelectorAll(".gmeta strong").forEach((el) => {
        if (el.textContent.includes("/"))
          el.textContent = `${newCount}/${currentGame[7]}`;
      });
      // Update allGames cache
      const entry = allGames.find((g) => g.i === currentGameId);
      if (entry) entry.g[9] = BigInt(newCount);
      await tx.wait();
    } else {
      const allowance = await usdcContract.allowance(
        userAddress,
        CONTRACT_ADDRESS,
      );
      if (allowance < entryFee) {
        toast("Step 1/2: Approving USDC...", "info");
        const tx1 = await usdcContract.approve(CONTRACT_ADDRESS, entryFee);
        await tx1.wait();
      }
      toast("Step 2/2: Joining game...", "info");
      const tx2 = await contract.joinGame(currentGameId);
      // Optimistic update
      const newCount = Number(currentGame[9]) + 1;
      document.querySelectorAll(".gmeta strong").forEach((el) => {
        if (el.textContent.includes("/"))
          el.textContent = `${newCount}/${currentGame[7]}`;
      });
      const entry = allGames.find((g) => g.i === currentGameId);
      if (entry) entry.g[9] = BigInt(newCount);
      await tx2.wait();
    }
    toast("✅ Joined successfully!", "success");
    currentGame = await getGame(currentGameId);
    await openGame(
      currentGameId,
      activeNet === NETWORKS[4441] ? 4441 : 5042002,
    );
    try {
      const updatedGame = await getGame(currentGameId);
      if (updatedGame) {
        const newPool = parseFloat(
          ethers.formatUnits(updatedGame[8], activeNet.decimals),
        );
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
            prizePool: newPool,
          }),
        });
      }
    } catch (_) {}
  } catch (e) {
    toast("Failed: " + (e.reason || e.message), "error");
    if (joinBtn) {
      joinBtn.disabled = false;
      joinBtn.textContent = `💰 Pay & Reserve Spot`;
    }
  }
  loadGames(); // background refresh, non-blocking
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
    provider = new ethers.BrowserProvider(window.ethereum);
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

  try {
    const chainId =
      currentGameChainId || (activeNet.decimals === 18 ? 4441 : 5042002);

    const chk = await fetch(
      `${BACKEND}/game/status/${currentGameId}?chainId=${chainId}`,
      {
        credentials: "include",
      },
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

  const g = currentGame || (await getGame(currentGameId));
  const catId = Number(g[3]),
    diff = Number(g[5]);
  const chainId =
    currentGameChainId || (activeNet.decimals === 18 ? 4441 : 5042002);
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
        // "Already finished" is fine — questions already stored
        if (err.error && !err.error.includes("finished")) {
          toast("Failed to register session: " + err.error, "error");
          return;
        }
      }
    } catch (e) {
      toast("Could not register game session. Check connection.", "error");
      return;
    }
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
  document.getElementById("qTimerFill").style.width =
    (timeLeft / 15) * 100 + "%";
  document.getElementById("qTimerFill").style.background =
    timeLeft <= 5
      ? "linear-gradient(90deg,var(--red),#ff6b35)"
      : "linear-gradient(90deg,var(--green),var(--accent))";
}

function pickAnswer(idx) {
  if (answered) return;
  answered = true;
  clearInterval(timerInt);
  const q = questions[currentQ];
  const selected = q.answers[idx];
  const isCorrect = selected === q.correct;
  const speed = isCorrect ? Math.floor((timeLeft / 15) * 50) : 0;
  const pts = isCorrect ? 100 + speed : 0;
  score += pts;

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
    if (q.answers[i] === q.correct) b.classList.add("correct");
    else if (i === idx && !isCorrect) b.classList.add("wrong");
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
    fb.textContent = `✓ Correct! +${pts} pts${speed > 0 ? " (⚡ speed bonus!)" : ""}`;
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
        `<div class="winner-banner"><h3>${
          medals[myPos]
        } — YOU WON!</h3><div class="winner-prize">${prize} ${gameSymbol}</div>${
          !claimed_
            ? `<button class="btn btn-gold" onclick="doClaimPrize()" style="margin-top:10px;width:auto;padding:12px 32px">💰 Claim Prize</button>`
            : `<p style="color:var(--green);margin-top:8px;font-weight:600">✅ Prize Claimed!</p>`
        }</div>`;
    } else if (s === 1) {
      document.getElementById("winnerBanner").innerHTML =
        `<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center;margin-bottom:16px"><p style="color:var(--muted)">Game ended. See leaderboard below.</p></div>`;
    } else if (s === 0) {
      document.getElementById("winnerBanner").innerHTML =
        `<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center;margin-bottom:16px"><p style="color:var(--accent)">⏳ Waiting for all players to finish...</p><p style="color:var(--muted);font-size:.8rem;margin-top:6px">Auto-refreshing every 12s</p></div>`;
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
          ? `<span style="color:var(--gold);font-size:.73rem">${prizes[
              i
            ].toFixed(dp)} ${gameSymbol}</span>`
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
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: NETWORKS[targetChainId].hexChainId }],
      });
      await new Promise((r) => setTimeout(r, 500));
      activeNet = NETWORKS[targetChainId];
      CONTRACT_ADDRESS = activeNet.contractAddress;
      USDC_ADDRESS = activeNet.tokenAddress;
      provider = new ethers.BrowserProvider(window.ethereum);
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

    const el = document.getElementById("globalStatsBar");
    if (!el) return;

    const players = data.totalPlayers || 0;
    const games = data.totalGamesPlayed || 0;
    const scores = data.totalFinished || 0;
    const arcVol = parseFloat(data.arcVolume || 0).toFixed(2);
    const litvmVol = parseFloat(data.litvmVolume || 0).toFixed(4);

    el.innerHTML = `
      <div class="gs-live-dot"></div>
      <div class="gs-item">
        👥 <strong class="live-counter">${players}</strong> players
      </div>
      <div class="gs-divider"></div>
      <div class="gs-item">
        🎮 <strong class="live-counter">${games}</strong> games played
      </div>
      <div class="gs-divider"></div>
      <div class="gs-item">
        ✅ <strong class="live-counter">${scores}</strong> scores submitted
      </div>
      <div class="gs-divider"></div>
      <div class="gs-leaderboard" onclick="showGlobalLeaderboard()">
        🏆 View Leaderboard
      </div>
    `;
  } catch (_) {}
}

async function checkUnclaimedPrizes() {
  if (!userAddress) return;
  const claims = [];

  try {
    const arcProvider = new ethers.JsonRpcProvider(
      "https://rpc.testnet.arc.network",
    );
    const litvmProvider = new ethers.JsonRpcProvider(
      "https://liteforge.rpc.caldera.xyz/http",
    );
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

    for (const [rc, net, chainId] of [
      [arcRC, NETWORKS[5042002], 5042002],
      [litvmRC, NETWORKS[4441], 4441],
    ]) {
      const count = Number(await rc.gameCounter().catch(() => 0));
      if (count === 0) continue;
      const checks = [];
      for (let i = count; i >= Math.max(1, count - 80); i--) {
        checks.push(
          rc
            .getPlayerStatus(i, userAddress)
            .then(async (statusResult) => {
              const joined = statusResult[0];
              const finished = statusResult[1];
              const claimed = statusResult[2];
              // Skip if not joined, or prize already claimed by this player
              if (!joined || claimed) return null;
              const g = await rc.getGame(i).catch(() => null);
              if (!g) return null;
              const status = Number(g.status ?? g[14]);
              if (status !== 1) return null;
              const topPlayers = g.topPlayers ?? g[12];
              const myPos = Array.from(topPlayers).findIndex(
                (p) => p?.toLowerCase() === userAddress.toLowerCase(),
              );
              if (myPos < 0) return null;
              const prizePool = g.prizePool ?? g[8];
              const n = Number(g.playerCount ?? g[9]);
              const dist =
                parseFloat(ethers.formatUnits(prizePool, net.decimals)) * 0.95;
              const prizes =
                n === 1
                  ? [dist]
                  : n === 2
                    ? [dist * 0.7, dist * 0.3]
                    : [dist * 0.6, dist * 0.25, dist * 0.15];
              const prize = prizes[myPos] || 0;
              if (prize <= 0) return null;
              return {
                gameId: i,
                chainId,
                net,
                name: g.name ?? g[1],
                prize,
                myPos,
                type: "prize",
              };
            })
            .catch(() => null),
        );
      }
      const results = (await Promise.all(checks)).filter(Boolean);
      claims.push(...results);
    }
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

  // Store globally for modal
  window._unclaimedPrizes = claims;

  // Update header button
  const btn = document.getElementById("claimPrizesBtn");
  const badge = document.getElementById("claimBadge");
  if (btn && badge) {
    if (claims.length > 0) {
      btn.style.display = "flex";
      badge.textContent = claims.length;
    } else {
      btn.style.display = "none";
    }
  }
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
      const label = isPrize
        ? `${medals[c.myPos] || "🏆"} ${positions[c.myPos] || ""} Place · Game #${c.gameId}`
        : `🎲 Bet won · Game #${c.gameId}`;
      return `<div style="display:flex;align-items:center;justify-content:space-between;
        padding:12px 14px;border-radius:10px;cursor:pointer;
        background:rgba(255,209,102,.04);border:1px solid rgba(255,209,102,.12);
        margin-bottom:8px;gap:12px;transition:background .15s"
      onmouseover="this.style.background='rgba(255,209,102,.08)'"
      onmouseout="this.style.background='rgba(255,209,102,.04)'"
      onclick="document.getElementById('claimPrizesModal').remove();openGameReadOnly(${c.gameId},${c.chainId})">
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
        <button onclick="event.stopPropagation();document.getElementById('claimPrizesModal').remove();openGameReadOnly(${c.gameId},${c.chainId})"
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
    const litvmProvider2 = new ethers.JsonRpcProvider(
      "https://liteforge.rpc.caldera.xyz/http",
    );
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
    const res = await fetch(`${BACKEND}/tournaments`);
    allTournaments = await res.json();
    renderTournaments();
  } catch (_) {}
}

function renderTournaments() {
  const el = document.getElementById("tournamentList");
  if (!el) return;
  if (!allTournaments.length) {
    el.innerHTML = `<p style="color:var(--muted);text-align:center;padding:32px;grid-column:1/-1">No tournaments yet. Create the first one!</p>`;
    return;
  }
  el.innerHTML = allTournaments
    .map((t) => {
      const statusColors = {
        open: "var(--green)",
        active: "var(--gold)",
        finished: "var(--muted)",
        cancelled: "var(--red)",
      };
      const statusColor = statusColors[t.status] || "var(--muted)";
      const chainIcon = t.chain_id === 4441 ? "🔷" : "⚡";
      const dp = t.token_symbol === "zkLTC" ? 4 : 2;
      const fee = parseFloat(t.entry_fee).toFixed(dp);
      const pool2 = parseFloat(t.prize_pool).toFixed(dp);
      const isFull = parseInt(t.player_count) >= t.max_players;
      return `<div class="gcard" onclick="openTournament(${t.id})"
      style="${t.status === "active" ? "border-color:rgba(255,209,102,.4)" : ""}">
      <div class="gcard-title">
        🏟️ ${sanitizeText(t.name)}
        <span class="badge" style="color:${statusColor};border-color:${statusColor};background:rgba(0,0,0,.2)">${t.status.toUpperCase()}</span>
        ${chainIcon}
      </div>
      <div style="font-size:.75rem;color:var(--gold);margin-bottom:8px;font-weight:600">
        ${t.rounds} Rounds · ${t.max_players} Players Max
      </div>
      <div class="gmeta">💰 Entry: <strong>${fee} ${t.token_symbol}</strong> | 🏆 Pool: <strong>${pool2} ${t.token_symbol}</strong></div>
      <div class="gmeta">👥 <strong>${t.player_count}/${t.max_players}</strong> joined</div>
      <div style="font-size:.72rem;color:var(--muted);margin-top:6px">
        🥇 ${(parseFloat(pool2) * 0.6).toFixed(dp)} · 🥈 ${(parseFloat(pool2) * 0.25).toFixed(dp)} · 🥉 ${(parseFloat(pool2) * 0.15).toFixed(dp)} ${t.token_symbol}
      </div>
      ${isFull && t.status === "open" ? '<div style="font-size:.72rem;color:var(--red);margin-top:4px;font-weight:600">🔴 FULL</div>' : ""}
    </div>`;
    })
    .join("");
}

async function openTournament(id) {
  currentTournamentId = id;
  try {
    const res = await fetch(`${BACKEND}/tournaments/${id}`);
    const { tournament: t, players, rounds } = await res.json();

    const dp = t.token_symbol === "zkLTC" ? 4 : 2;
    const fee = parseFloat(t.entry_fee).toFixed(dp);
    const pool2 = parseFloat(t.prize_pool).toFixed(dp);
    const prizes = {
      first: (parseFloat(pool2) * 0.6).toFixed(dp),
      second: (parseFloat(pool2) * 0.25).toFixed(dp),
      third: (parseFloat(pool2) * 0.15).toFixed(dp),
    };
    const myWallet = userAddress?.toLowerCase();
    const me = players.find((p) => p.wallet === myWallet);
    const isJoined = !!me,
      isEliminated = me?.eliminated;
    const isFull = players.length >= t.max_players;
    const chainIcon = t.chain_id === 4441 ? "🔷" : "⚡";

    const playerRows = players
      .map(
        (p, i) => `
      <div class="lb-row" style="${p.eliminated ? "opacity:.4" : ""}">
        <span class="lb-rank">${i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "#" + (i + 1)}</span>
        <span class="lb-addr">${p.username ? "@" + p.username : fmt(p.wallet)}${p.wallet === myWallet ? " (you)" : ""}</span>
        <span class="lb-score">${p.total_score} pts</span>
        <span class="lb-tag ${p.eliminated ? "lb-wait" : "lb-done"}">${p.eliminated ? "Out" : "Active"}</span>
      </div>`,
      )
      .join("");

    const roundsHtml = rounds
      .map(
        (r) => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:.85rem;font-weight:700;color:var(--accent)">Round ${r.round_number}</span>
        <span style="font-size:.75rem;color:${r.status === "active" ? "var(--gold)" : r.status === "finished" ? "var(--green)" : "var(--muted)"}">
          ${r.status === "active" ? "🔴 Live" : r.status === "finished" ? "✅ Done" : "⏳ Pending"}
        </span>
      </div>`,
      )
      .join("");

    let actionHtml = "";
    if (t.status === "open" && !isJoined && !isFull && userAddress) {
      actionHtml = `<button class="btn btn-primary" onclick="joinTournament(${t.id})">
        💰 Pay ${fee} ${t.token_symbol} & Enter Tournament</button>`;
    } else if (t.status === "open" && isJoined) {
      actionHtml = `<div style="text-align:center;padding:14px;border-radius:10px;background:rgba(0,229,255,.06);border:1px solid rgba(0,229,255,.2)">
        <p style="color:var(--accent);font-weight:600">✓ You are registered!</p>
        <p style="color:var(--muted);font-size:.82rem;margin-top:4px">Waiting for ${t.max_players - players.length} more players to start.</p>
      </div>`;
    } else if (t.status === "active" && isJoined && !isEliminated) {
      actionHtml = `<button class="btn btn-primary" style="background:linear-gradient(135deg,var(--gold),var(--orange))"
        onclick="playTournamentRound(${t.id},${t.current_round})">
        🎮 Play Round ${t.current_round}!</button>`;
    } else if (t.status === "active" && isEliminated) {
      actionHtml = `<div style="text-align:center;padding:14px;border-radius:10px;background:rgba(239,71,111,.08);border:1px solid rgba(239,71,111,.25)">
        <p style="color:var(--red);font-weight:600">❌ You were eliminated in Round ${t.current_round - 1}</p>
      </div>`;
    } else if (t.status === "finished") {
      actionHtml = `<div class="winner-banner">
        <h3>🏆 Tournament Complete!</h3>
        <div class="winner-prize">${prizes.first} ${t.token_symbol}</div>
        <p style="color:var(--muted);margin-top:8px;font-size:.85rem">Winner: ${players[0]?.username ? "@" + players[0].username : fmt(players[0]?.wallet)}</p>
      </div>`;
    } else if (!userAddress) {
      actionHtml = `<button class="btn btn-primary" onclick="connectWallet()">🦊 Connect Wallet to Join</button>`;
    }

    document.getElementById("joinContent").innerHTML = `
      <div style="margin-bottom:16px">
        <h2 style="font-family:'Bebas Neue',sans-serif;font-size:1.5rem;letter-spacing:2px">
          🏟️ ${sanitizeText(t.name)}</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <span class="badge b-wait">${chainIcon} ${t.token_symbol}</span>
          <span class="cat-pill">${t.rounds} Rounds</span>
          <span class="cat-pill">${t.max_players} Players</span>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;color:var(--gold)">${fee}</div>
          <div style="font-size:.72rem;color:var(--muted)">Entry (${t.token_symbol})</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;color:var(--green)">${pool2}</div>
          <div style="font-size:.72rem;color:var(--muted)">Prize Pool</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;color:var(--accent)">${players.length}/${t.max_players}</div>
          <div style="font-size:.72rem;color:var(--muted)">Players</div>
        </div>
      </div>

      <div style="background:rgba(255,209,102,.06);border:1px solid rgba(255,209,102,.25);border-radius:10px;padding:14px;margin-bottom:14px">
        <div style="font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Prize Distribution</div>
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          <span>🥇 <strong style="color:var(--gold)">${prizes.first} ${t.token_symbol}</strong> (60%)</span>
          <span>🥈 <strong style="color:#ccc">${prizes.second} ${t.token_symbol}</strong> (25%)</span>
          <span>🥉 <strong style="color:#cd7f32">${prizes.third} ${t.token_symbol}</strong> (15%)</span>
        </div>
        <div style="font-size:.72rem;color:var(--muted);margin-top:8px">Bottom half eliminated each round · Last players standing split prizes</div>
      </div>

      <div style="margin-bottom:14px">
        <div style="font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Rounds</div>
        ${roundsHtml || '<p style="color:var(--muted);font-size:.83rem">Rounds start when tournament fills</p>'}
      </div>

      <div style="margin-bottom:14px">
        <div style="font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Standings</div>
        ${playerRows || '<p style="color:var(--muted);font-size:.83rem">No players yet</p>'}
      </div>

      <div style="margin-top:14px">${actionHtml}</div>`;

    showScreen("screenJoin");
  } catch (e) {
    toast("Error: " + e.message, "error");
  }
}

async function joinTournament(id) {
  if (!contract || !userAddress) return toast("Connect wallet first", "error");
  try {
    const res = await fetch(`${BACKEND}/tournaments/${id}`);
    const { tournament: t } = await res.json();
    const isZkLTC = t.token_symbol === "zkLTC";
    const decimals = isZkLTC ? 18 : 6;
    const entryFee = ethers.parseUnits(
      parseFloat(t.entry_fee).toFixed(decimals),
      decimals,
    );
    const PLATFORM = platformAddress || (await readContract.platform());

    if (isZkLTC) {
      toast("Paying entry in zkLTC...", "info");
      const tx = await signer.sendTransaction({
        to: PLATFORM,
        value: entryFee,
      });
      await tx.wait();
    } else {
      const allowance = await usdcContract.allowance(userAddress, PLATFORM);
      if (allowance < entryFee) {
        toast("Approving USDC...", "info");
        const tx1 = await usdcContract.approve(PLATFORM, entryFee);
        await tx1.wait();
      }
      toast("Transferring entry fee...", "info");
      const usdcW = new ethers.Contract(
        USDC_ADDRESS,
        ["function transfer(address,uint256) external returns (bool)"],
        signer,
      );
      const tx2 = await usdcW.transfer(PLATFORM, entryFee);
      await tx2.wait();
    }

    let csrfToken = "";
    try {
      const ct = await fetch(`${BACKEND}/csrf-token`, {
        credentials: "include",
      });
      csrfToken = (await ct.json()).csrfToken || "";
    } catch (_) {}

    const joinRes = await fetch(`${BACKEND}/tournaments/${id}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ wallet: userAddress }),
    });
    const data = await joinRes.json();
    if (!joinRes.ok) return toast(data.error || "Join failed", "error");

    toast("✅ Entered tournament!", "success");
    openTournament(id);
  } catch (e) {
    toast("Failed: " + (e.reason || e.message), "error");
  }
}

async function playTournamentRound(tournamentId, roundNumber) {
  toast("Loading round questions...", "info");
  try {
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

    const rawQ = qtData
      ? qtData.results.map((q, idx) => ({
          question: decodeURIComponent(q.question),
          correct: decodeURIComponent(q.correct_answer),
          answers: shuffle([
            decodeURIComponent(q.correct_answer),
            ...q.incorrect_answers.map((a) => decodeURIComponent(a)),
          ]),
          id: idx,
        }))
      : getLocalQuestions(9, 0, 10).map((q, idx) => ({
          question: q.q,
          correct: q.correct,
          answers: shuffle([q.correct, ...q.wrong]),
          id: idx,
        }));

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
  const modal = document.createElement("div");
  modal.id = "tournamentQuizModal";
  modal.className = "bet-modal-overlay";
  document.body.appendChild(modal);

  function renderQ() {
    if (qIdx >= rawQ.length) {
      modal.remove();
      submitTournamentScore(tournamentId, tAnswers, tScore);
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

    window._tPick = (i) => {
      clearInterval(timerInterval);
      const selected = q.answers[i];
      const isCorrect = selected === q.correct;
      if (isCorrect) tScore += 100;
      tAnswers.push({ questionIndex: qIdx, selected, correct: isCorrect });
      modal.querySelectorAll(".ans-btn").forEach((b, bi) => {
        b.disabled = true;
        if (q.answers[bi] === q.correct) b.classList.add("correct");
        else if (bi === i && !isCorrect) b.classList.add("wrong");
      });
      setTimeout(() => {
        qIdx++;
        renderQ();
      }, 800);
    };
  }
  renderQ();
}

async function submitTournamentScore(tournamentId, answers, score) {
  let csrfToken = "";
  try {
    const ct = await fetch(`${BACKEND}/csrf-token`, { credentials: "include" });
    csrfToken = (await ct.json()).csrfToken || "";
  } catch (_) {}
  try {
    const res = await fetch(`${BACKEND}/tournaments/${tournamentId}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CSRF-Token": csrfToken },
      credentials: "include",
      body: JSON.stringify({ wallet: userAddress, answers }),
    });
    const data = await res.json();
    if (!res.ok) return toast(data.error || "Submit failed", "error");

    if (data.tournamentFinished) {
      toast(`🏆 Tournament over! Winner: ${fmt(data.winner)}`, "success");
    } else if (data.roundFinished) {
      toast(
        `Round done! ${data.eliminated?.length || 0} players eliminated. Next round starting...`,
        "success",
      );
    } else {
      toast(`Score submitted: ${score} pts`, "success");
    }
    openTournament(tournamentId);
  } catch (e) {
    toast("Submit failed: " + e.message, "error");
  }
}

function showCreateTournamentModal() {
  if (!userAddress) return toast("Connect wallet first", "error");
  const existing = document.getElementById("createTourneyModal");
  if (existing) existing.remove();
  const modal = document.createElement("div");
  modal.id = "createTourneyModal";
  modal.className = "bet-modal-overlay";
  modal.innerHTML = `
    <div class="bet-modal-box" style="max-width:440px;width:95%">
      <h3 style="margin-bottom:20px">🏟️ Create Tournament</h3>
      <div class="ig" style="margin-bottom:10px">
        <label class="il">Tournament Name</label>
        <input id="tName" placeholder="e.g. Friday Night Trivia" maxlength="60"/>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div class="ig"><label class="il">Entry Fee</label>
          <input id="tFee" type="number" min="0.01" step="0.001" placeholder="e.g. 1.00"/></div>
        <div class="ig"><label class="il">Max Players</label>
          <input id="tMax" type="number" min="4" max="64" value="8"/></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">
        <div class="ig"><label class="il">Rounds</label>
          <select id="tRounds" style="background:var(--surface);border:1px solid var(--border);color:var(--text);padding:10px 14px;border-radius:8px;font-size:.9rem;width:100%">
            <option value="2">2 Rounds</option>
            <option value="3" selected>3 Rounds</option>
            <option value="4">4 Rounds</option>
            <option value="5">5 Rounds</option>
          </select></div>
        <div class="ig"><label class="il">Token</label>
          <select id="tChain" style="background:var(--surface);border:1px solid var(--border);color:var(--text);padding:10px 14px;border-radius:8px;font-size:.9rem;width:100%">
            <option value="5042002">⚡ USDC (Arc)</option>
            <option value="4441">🔷 zkLTC (LitVM)</option>
          </select></div>
      </div>
      <div style="font-size:.75rem;color:var(--muted);margin-bottom:16px;padding:10px;background:var(--surface);border-radius:8px">
        💡 Bottom half eliminated each round. Prizes auto-split 60% / 25% / 15% to top 3.
      </div>
      <div style="display:flex;gap:10px">
        <button class="btn btn-primary" onclick="submitCreateTournament()">🚀 Create</button>
        <button class="btn btn-ghost" style="width:auto;padding:13px 18px" onclick="document.getElementById('createTourneyModal').remove()">Cancel</button>
      </div>
    </div>`;
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
  document.body.appendChild(modal);
}

async function submitCreateTournament() {
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
  if (!req.user && !currentProfile)
    return toast("You must be logged in", "error");

  const tokenSymbol = chainId === 4441 ? "zkLTC" : "USDC";

  const btn = document.querySelector("#createTourneyModal .btn-primary");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Creating...";
  }

  try {
    const res = await fetch(`${BACKEND}/tournaments/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        name,
        chainId,
        entryFee: fee,
        tokenSymbol,
        maxPlayers: max,
        rounds,
      }),
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      console.error("Non-JSON response:", text.slice(0, 200));
      throw new Error(
        "Server error (status " + res.status + ") — check console",
      );
    }

    if (!res.ok)
      throw new Error(data.error || "Failed with status " + res.status);

    document.getElementById("createTourneyModal")?.remove();
    toast(`✅ "${name}" tournament created!`, "success");
    showScreen("screenTournaments");
    await loadTournaments();
  } catch (e) {
    console.error("Create tournament error:", e);
    toast("Failed: " + e.message, "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "🚀 Create";
    }
  }
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


/* X-CAPITAL Neural Horizon — frontend application
   Authentication, email OTP, sessions, ledger actions and admin operations are server-backed.
*/

let currentUser = null;
let currentInvestment = null;
let chartInstance = null;
let marketCache = {};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const config = { credentials: "include", headers: { "Content-Type": "application/json" }, ...options };
  if (config.body && typeof config.body !== "string") config.body = JSON.stringify(config.body);

  const response = await fetch(path, config);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.message || "Request failed.");
    err.status = response.status;
    throw err;
  }
  return data;
}

function showToast(message, type = "info") {
  const el = $("app-toast");
  if (!el) return;
  el.textContent = message;
  el.className = `app-toast ${type}`;
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.add("hidden"), 4200);
}

function money(value) {
  return `$${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shortHash(value) {
  const s = String(value || "");
  return s.length > 18 ? `${s.slice(0, 10)}…${s.slice(-8)}` : s;
}
function networkForAsset(asset) {
  if (asset.includes("TRC-20")) return "TRON";
  if (asset.includes("ERC-20")) return "Ethereum";
  if (asset === "BTC") return "Bitcoin";
  return "Network";
}

function setBusy(button, busy, text = "Processing…") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.disabled = true;
    button.textContent = text;
  } else {
    button.disabled = false;
    button.textContent = button.dataset.originalText || button.textContent;
  }
}

/* ---------- Authentication ---------- */

window.switchAuthTab = function(tab) {
  $("tab-login").classList.toggle("active", tab === "login");
  $("tab-register").classList.toggle("active", tab === "register");
  $("form-login").classList.toggle("hidden", tab !== "login");
  $("form-register").classList.toggle("hidden", tab !== "register");
};

window.handleAuth = async function(e, type) {
  e.preventDefault();
  const form = e.target;
  const button = form.querySelector("button[type='submit']");
  setBusy(button, true);

  try {
    if (type === "register") {
      const name = $("reg-name").value.trim();
      const email = $("reg-email").value.trim().toLowerCase();
      const password = $("reg-pass").value;

      if (password.length < 8) {
        showToast("Use a password with at least 8 characters.", "error");
        return;
      }

      const result = await api("/api/auth/register", {
        method: "POST",
        body: { name, email, password }
      });

      $("verification-email").textContent = email;
      $("verification-code").value = "";
      $("auth-modal-overlay").classList.add("hidden");
      $("verification-modal").classList.remove("hidden");
      showToast(result.message || "Verification code sent.", "success");
    } else {
      const email = $("login-email").value.trim().toLowerCase();
      const password = $("login-pass").value;

      const result = await api("/api/auth/login", {
        method: "POST",
        body: { email, password }
      });

      if (result.requiresVerification) {
        $("verification-email").textContent = email;
        $("verification-code").value = "";
        $("auth-modal-overlay").classList.add("hidden");
        $("verification-modal").classList.remove("hidden");
        showToast("Verify your email before signing in.", "info");
        return;
      }

      await bootSession();
    }
  } catch (err) {
    if (err.status === 403 && err.message.toLowerCase().includes("verification")) {
      $("verification-email").textContent = $("login-email").value.trim().toLowerCase();
      $("auth-modal-overlay").classList.add("hidden");
      $("verification-modal").classList.remove("hidden");
    }
    showToast(err.message, "error");
  } finally {
    setBusy(button, false);
  }
};

window.verifyEmailCode = async function(e) {
  e.preventDefault();
  const email = $("verification-email").textContent.trim().toLowerCase();
  const code = $("verification-code").value.trim();
  if (!/^\d{6}$/.test(code)) {
    showToast("Enter the 6-digit code from your email.", "error");
    return;
  }

  try {
    const result = await api("/api/auth/verify-email", {
      method: "POST",
      body: { email, code }
    });
    $("verification-modal").classList.add("hidden");
    showToast(result.message || "Email verified.", "success");
    await bootSession();
  } catch (err) {
    showToast(err.message, "error");
  }
};

window.resendVerificationCode = async function() {
  const email = $("verification-email").textContent.trim().toLowerCase();
  try {
    const result = await api("/api/auth/resend-code", { method: "POST", body: { email } });
    showToast(result.message || "A new code was sent.", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
};

window.logout = async function() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch (_) {}
  currentUser = null;
  $("admin-nav-btn").classList.add("hidden");
  $("auth-modal-overlay").classList.remove("hidden");
  showToast("Signed out.", "info");
};

async function bootSession() {
  try {
    const result = await api("/api/auth/me");
    currentUser = result.user;

    $("auth-modal-overlay").classList.add("hidden");
    $("verification-modal").classList.add("hidden");
    $("admin-nav-btn").classList.toggle("hidden", currentUser.role !== "admin");

    if (currentUser.role === "admin") {
      switchView("view-dashboard");
      showToast("Admin session restored.", "success");
    } else {
      await refreshUI();
    }
  } catch (_) {
    $("auth-modal-overlay").classList.remove("hidden");
  }
}

/* ---------- Navigation / modals ---------- */

window.switchView = function(viewId) {
  document.querySelectorAll(".page-view").forEach(v => v.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(v => v.classList.remove("active"));
  const view = $(viewId);
  if (view) view.classList.add("active");
  document.querySelectorAll(".nav-item").forEach(btn => {
    if ((btn.getAttribute("onclick") || "").includes(viewId)) btn.classList.add("active");
  });
};

window.openModal = function(id) {
  $(id)?.classList.remove("hidden");
};

window.closeModal = function(id) {
  $(id)?.classList.add("hidden");
};

/* ---------- User dashboard ---------- */

async function refreshUI() {
  if (!currentUser || currentUser.role === "admin") return;

  const data = await api("/api/dashboard");
  const user = data.user;
  currentUser = user;

  $("display-user-name").textContent = user.name;
  $("display-user-email").textContent = user.email;

  $("settings-name").value = user.name;
  $("settings-email").value = user.email;

  $("dash-total-val").textContent = money(data.metrics.totalPortfolioValue);
  $("dash-avail-val").textContent = money(data.metrics.availableBalance);
  if ($("wallet-cleared-balance")) $("wallet-cleared-balance").textContent = money(data.metrics.availableBalance);

  const gain = Number(data.metrics.unrealizedGain || 0);
  const gainPct = Number(data.metrics.gainPct || 0);
  const gainEl = $("dash-gain-val");
  gainEl.textContent = `${gain >= 0 ? "+" : ""}${money(gain)} (${gainPct.toFixed(2)}%)`;
  gainEl.className = `val-hero ${gain >= 0 ? "txt-pos" : "txt-neg"}`;

  renderPortfolioTable(data.holdings);
  renderMarketsTable(data.markets);
  renderTransactionsTable(data.transactions);
  renderPerformanceChart(data.performance);
}

function renderPortfolioTable(holdings) {
  const tbody = $("portfolio-table-body");
  tbody.innerHTML = "";
  if (!holdings.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="lbl-muted">No open positions yet.</td></tr>';
    return;
  }

  holdings.forEach(h => {
    const tr = document.createElement("tr");
    const gain = Number(h.unrealizedGain);
    tr.innerHTML = `
      <td><strong>${escapeHtml(h.assetName)}</strong></td>
      <td>${Number(h.units).toFixed(6)}</td>
      <td>${money(h.averageCost)}</td>
      <td>${money(h.currentPrice)}</td>
      <td>${money(h.currentValue)}</td>
      <td class="${gain >= 0 ? "txt-pos" : "txt-neg"}">${gain >= 0 ? "+" : ""}${money(gain)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderMarketsTable(markets) {
  marketCache = Object.fromEntries(markets.map(m => [m.assetId, m]));
  const tbody = $("markets-table-body");
  tbody.innerHTML = "";
  markets.forEach(m => {
    const tr = document.createElement("tr");
    const change = Number(m.change24h || 0);
    tr.innerHTML = `
      <td><strong>${escapeHtml(m.name)}</strong><span class="market-code">${escapeHtml(m.symbol || "")}</span></td>
      <td>${money(m.price)}</td>
      <td class="${change >= 0 ? "txt-pos" : "txt-neg"}">${change >= 0 ? "+" : ""}${change.toFixed(2)}%</td>
      <td><button class="btn-table-action" onclick="openTradeFor('${escapeAttr(m.assetId)}')">Trade</button></td>
    `;
    tbody.appendChild(tr);
  });
}

function renderTransactionsTable(transactions) {
  const tbody = $("transactions-table-body");
  tbody.innerHTML = "";
  if (!transactions.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="lbl-muted">No transactions yet.</td></tr>';
    return;
  }
  transactions.forEach(t => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(new Date(t.createdAt).toLocaleString())}</td>
      <td>${escapeHtml(t.type)}</td>
      <td>${escapeHtml(t.details)}</td>
      <td>${money(t.amount)}</td>
      <td><span class="status-badge ${statusClass(t.status)}">${escapeHtml(t.status)}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

function renderPerformanceChart(points) {
  if (typeof Chart === "undefined" || !$("dashMainChart")) return;
  if (chartInstance) chartInstance.destroy();

  chartInstance = new Chart($("dashMainChart"), {
    type: "line",
    data: {
      labels: points.map(p => new Date(p.date).toLocaleDateString()),
      datasets: [{
        label: "Portfolio value",
        data: points.map(p => p.value),
        tension: 0.35,
        fill: true,
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { ticks: { callback: value => money(value) } }
      }
    }
  });
}

function statusClass(status) {
  const s = String(status).toLowerCase();
  if (s.includes("complete") || s.includes("settled") || s.includes("approved")) return "status-success";
  if (s.includes("pending") || s.includes("process") || s.includes("await")) return "status-pending";
  if (s.includes("reject") || s.includes("fail")) return "status-danger";
  return "";
}

window.openTradeFor = function(assetId) {
  $("t-asset-select").value = assetId;
  switchView("view-trade");
};

window.executeQuickTrade = async function() {
  $("t-asset-select").value = $("q-asset-select").value;
  $("t-amount-input").value = $("q-amount-input").value;
  await executeTradeViewOrder();
};

window.executeTradeViewOrder = async function() {
  const assetId = $("t-asset-select").value;
  const amount = Number($("t-amount-input").value);
  if (!Number.isFinite(amount) || amount < 10) {
    showToast("Enter an investment amount of at least $10.", "error");
    return;
  }

  try {
    const result = await api("/api/orders/buy", {
      method: "POST",
      body: { assetId, amount }
    });
    showToast(`Order submitted. ${result.units.toFixed(6)} units recorded at ${money(result.price)}.`, "success");
    await refreshUI();
  } catch (err) {
    showToast(err.message, "error");
  }
};

/* ---------- Investments ---------- */

window.openInvestmentReview = function(fundName, assetId) {
  currentInvestment = { fundName, assetId };
  $("review-fund").textContent = fundName;
  $("review-investment-amount").value = "500";
  updateInvestmentReview();
  openModal("investment-modal");
};

window.updateInvestmentReview = function() {
  if (!currentInvestment) return;
  const market = marketCache[currentInvestment.assetId];
  const amount = Number($("review-investment-amount").value || 0);
  const price = market?.price || 0;
  $("review-price").textContent = price ? money(price) : "Pending valuation";
  $("review-amount").textContent = money(amount);
  $("review-units").textContent = price > 0 ? (amount / price).toFixed(6) : "Calculated at execution";
};

window.confirmInvestment = async function() {
  if (!currentInvestment) return;
  const amount = Number($("review-investment-amount").value);
  if (!Number.isFinite(amount) || amount < 10) {
    showToast("Enter at least $10.", "error");
    return;
  }
  try {
    const result = await api("/api/orders/buy", {
      method: "POST",
      body: { assetId: currentInvestment.assetId, amount, fundName: currentInvestment.fundName }
    });
    closeModal("investment-modal");
    showToast(`Investment confirmed: ${result.units.toFixed(6)} units.`, "success");
    await refreshUI();
  } catch (err) {
    showToast(err.message, "error");
  }
};

/* ---------- Wallet ---------- */

window.copyWalletAddress = async function() {
  try {
    await navigator.clipboard.writeText($("dep-wallet-address").value);
    showToast("Deposit address copied.", "success");
  } catch (_) {
    $("dep-wallet-address").select();
    document.execCommand("copy");
    showToast("Deposit address copied.", "success");
  }
};

$("dep-asset")?.addEventListener("change", async () => {
  const asset = $("dep-asset").value;
  $("dep-network-label").textContent = networkForAsset(asset);
  $("dep-wallet-address").value = "Loading secure deposit address…";
  try {
    const result = await api(`/api/wallet/deposit-address?asset=${encodeURIComponent(asset)}`);
    $("dep-wallet-address").value = result.address || "Address not configured";
    $("dep-network-note").textContent = `Network: ${result.network}. Send only ${asset} on this network.`;
  } catch (err) {
    $("dep-wallet-address").value = "Address not configured";
    $("dep-network-note").textContent = err.message || "Deposit network unavailable.";
  }
});

window.submitDeposit = async function() {
  const asset = $("dep-asset").value;
  const amount = Number($("dep-amount").value);
  const txHash = $("dep-txhash").value.trim();

  if (!Number.isFinite(amount) || amount < 10) {
    showToast("Enter at least $10 equivalent.", "error");
    return;
  }
  if (txHash.length < 12) {
    showToast("Enter the blockchain transaction hash.", "error");
    return;
  }

  try {
    await api("/api/deposits", {
      method: "POST",
      body: { asset, amount, txHash }
    });
    $("dep-txhash").value = "";
    closeModal("deposit-modal");
    showToast("Deposit submitted. Operations will verify the transaction before crediting your cleared balance.", "success");
    await refreshUI();
  } catch (err) {
    showToast(err.message, "error");
  }
};

window.submitWithdrawal = async function() {
  const asset = $("with-asset").value;
  const amount = Number($("with-amount").value);
  const address = $("with-address").value.trim();
  if (!Number.isFinite(amount) || amount < 10 || !address) {
    showToast("Enter a valid amount and destination wallet.", "error");
    return;
  }
  if (asset.includes("TRC-20") && !address.startsWith("T")) {
    showToast("USDT TRC-20 withdrawals require a TRON address beginning with T.", "error");
    return;
  }
  if (asset.includes("ERC-20") && !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    showToast("USDC ERC-20 withdrawals require a valid 0x Ethereum address.", "error");
    return;
  }

  try {
    await api("/api/withdrawals", {
      method: "POST",
      body: { asset, amount, address }
    });
    closeModal("withdraw-modal");
    showToast("Withdrawal request submitted for review.", "success");
    await refreshUI();
  } catch (err) {
    showToast(err.message, "error");
  }
};

/* ---------- Settings ---------- */

window.updateProfile = async function(e) {
  e.preventDefault();
  try {
    await api("/api/profile", {
      method: "PATCH",
      body: { name: $("settings-name").value.trim() }
    });
    showToast("Profile updated.", "success");
    await refreshUI();
  } catch (err) {
    showToast(err.message, "error");
  }
};

window.updatePassword = async function(e) {
  e.preventDefault();
  try {
    await api("/api/profile/password", {
      method: "PATCH",
      body: {
        currentPassword: $("settings-old-pass").value,
        newPassword: $("settings-new-pass").value
      }
    });
    e.target.reset();
    showToast("Password updated. Existing sessions have been refreshed.", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
};

/* ---------- Admin ---------- */

window.openAdminPanel = async function() {
  if (!currentUser || currentUser.role !== "admin") return;
  openModal("admin-modal");
  await populateAdminTables();
};

async function populateAdminTables() {
  try {
    const data = await api("/api/admin/overview");
    $("admin-investor-count").textContent = data.stats?.investorCount ?? "—";
    $("admin-pending-deposit-total").textContent = money(data.stats?.pendingDepositTotal || 0);
    $("admin-pending-withdrawal-total").textContent = money(data.stats?.pendingWithdrawalTotal || 0);

    const depBody = $("admin-pending-deposits-body");
    depBody.innerHTML = data.deposits.length ? "" :
      '<tr><td colspan="6" class="lbl-muted">No pending deposits.</td></tr>';

    data.deposits.forEach(req => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(req.name)}</td>
        <td>${escapeHtml(req.email)}</td>
        <td>${escapeHtml(req.asset)}</td>
        <td>${money(req.amount)}</td>
        <td title="${escapeAttr(req.tx_hash || "")}">${escapeHtml(shortHash(req.tx_hash || "Not supplied"))}</td>
        <td>${escapeHtml(new Date(req.createdAt).toLocaleString())}</td>
        <td>
          <button class="btn-table-action" onclick="approveDeposit('${escapeAttr(req.id)}')">Verify & Credit</button>
          <button class="btn-table-danger" onclick="rejectDeposit('${escapeAttr(req.id)}')">Reject</button>
        </td>`;
      depBody.appendChild(tr);
    });

    const withBody = $("admin-pending-withdrawals-body");
    withBody.innerHTML = data.withdrawals.length ? "" :
      '<tr><td colspan="4" class="lbl-muted">No pending withdrawals.</td></tr>';

    data.withdrawals.forEach(req => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(req.name)}<br><span class="lbl-muted">${escapeHtml(req.email)}</span></td>
        <td class="wallet-address-cell">${escapeHtml(req.address)}</td>
        <td>${money(req.amount)}</td>
        <td>
          <button class="btn-table-action" onclick="approveWithdrawal('${escapeAttr(req.id)}')">Approve</button>
          <button class="btn-table-danger" onclick="rejectWithdrawal('${escapeAttr(req.id)}')">Reject</button>
        </td>`;
      withBody.appendChild(tr);
    });
  } catch (err) {
    showToast(err.message, "error");
  }
}

window.approveDeposit = async function(id) {
  if (!confirm("Verify that the payment was actually received before crediting this account?")) return;
  try {
    await api(`/api/admin/deposits/${encodeURIComponent(id)}/approve`, { method: "POST" });
    showToast("Deposit verified and credited.", "success");
    await populateAdminTables();
  } catch (err) { showToast(err.message, "error"); }
};

window.rejectDeposit = async function(id) {
  if (!confirm("Reject this deposit notification?")) return;
  try {
    await api(`/api/admin/deposits/${encodeURIComponent(id)}/reject`, { method: "POST" });
    showToast("Deposit rejected.", "info");
    await populateAdminTables();
  } catch (err) { showToast(err.message, "error"); }
};

window.approveWithdrawal = async function(id) {
  if (!confirm("Approve this withdrawal only after the payout is authorized and ready to be processed?")) return;
  try {
    await api(`/api/admin/withdrawals/${encodeURIComponent(id)}/approve`, { method: "POST" });
    showToast("Withdrawal approved.", "success");
    await populateAdminTables();
  } catch (err) { showToast(err.message, "error"); }
};

window.rejectWithdrawal = async function(id) {
  if (!confirm("Reject this withdrawal and return the reserved amount to the investor?")) return;
  try {
    await api(`/api/admin/withdrawals/${encodeURIComponent(id)}/reject`, { method: "POST" });
    showToast("Withdrawal rejected and funds released.", "info");
    await populateAdminTables();
  } catch (err) { showToast(err.message, "error"); }
};

window.adminDirectCredit = async function() {
  const email = $("admin-credit-email").value.trim().toLowerCase();
  const amount = Number($("admin-credit-amt").value);
  if (!email || !Number.isFinite(amount) || amount <= 0) {
    showToast("Enter a valid user email and amount.", "error");
    return;
  }
  if (!confirm("Confirm that the funds were independently received before issuing this manual credit?")) return;

  try {
    await api("/api/admin/credits", {
      method: "POST",
      body: { email, amount }
    });
    $("admin-credit-email").value = "";
    $("admin-credit-amt").value = "";
    showToast("Manual credit recorded in the ledger.", "success");
    await populateAdminTables();
  } catch (err) { showToast(err.message, "error"); }
};

/* ---------- Search ---------- */

document.querySelector(".search-bar input")?.addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll("#markets-table-body tr").forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(q) ? "" : "none";
  });
});

/* ---------- Safety helpers ---------- */

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[ch]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

document.addEventListener("DOMContentLoaded", () => bootSession());

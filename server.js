
require("dotenv").config();
const fs = require("fs");
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const dbFile = process.env.DB_FILE || "./data/xcapital.db";
const dbDir = require("path").dirname(dbFile);
fs.mkdirSync(dbDir, { recursive: true });

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be set and be at least 32 characters.");
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const db = new Database(process.env.DB_FILE || path.join(__dirname, "data", "xcapital.db"));
db.pragma("journal_mode = WAL");

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'investor',
  email_verified INTEGER NOT NULL DEFAULT 0,
  available_balance REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS otp_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_registrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_sent_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS holdings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_name TEXT NOT NULL,
  units REAL NOT NULL DEFAULT 0,
  average_cost REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, asset_id)
);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  type TEXT NOT NULL,
  details TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount REAL NOT NULL,
  tx_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount REAL NOT NULL,
  address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  target_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS performance_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  value REAL NOT NULL,
  created_at TEXT NOT NULL
);
`);

function now() { return new Date().toISOString(); }
function id() { return crypto.randomUUID(); }
function hashText(v) { return crypto.createHash("sha256").update(v).digest("hex"); }

const MARKET_DATA = {
  TSLA: { assetId: "TSLA", symbol: "TSLA", name: "Tesla Inc. (TSLA)", price: Number(process.env.TSLA_PRICE || 248.12), change24h: Number(process.env.TSLA_CHANGE_24H || 0) },
  SpaceX: { assetId: "SpaceX", symbol: "SPACEX", name: "SpaceX Private Exposure", price: Number(process.env.SPACEX_PRICE || 1248.75), change24h: Number(process.env.SPACEX_CHANGE_24H || 0) },
  xAI: { assetId: "xAI", symbol: "XAI", name: "xAI Private Exposure", price: Number(process.env.XAI_PRICE || 12432.67), change24h: Number(process.env.XAI_CHANGE_24H || 0) },
  Neuralink: { assetId: "Neuralink", symbol: "NEURALINK", name: "Neuralink Private Exposure", price: Number(process.env.NEURALINK_PRICE || 7.24), change24h: Number(process.env.NEURALINK_CHANGE_24H || 0) },
  Starlink: { assetId: "Starlink", symbol: "STARLINK", name: "Starlink Private Exposure", price: Number(process.env.STARLINK_PRICE || 18.76), change24h: Number(process.env.STARLINK_CHANGE_24H || 0) }
};

// IMPORTANT: These are reference values only until a verified market-data/NAV provider is connected.
// The admin panel intentionally has no pump/crash controls.

const WALLET_ADDRESSES = {
  "USDT (TRC-20)": process.env.USDT_TRC20_ADDRESS || "",
  "USDC (ERC-20)": process.env.USDC_ERC20_ADDRESS || "",
  "BTC": process.env.BTC_ADDRESS || ""
};

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const MAIL_FROM = process.env.MAIL_FROM || "X-CAPITAL <onboarding@resend.dev>";

async function sendVerificationEmail(email, name, code) {
  if (!RESEND_API_KEY) {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[DEV OTP] ${email}: ${code}`);
      return;
    }
    throw new Error("RESEND_API_KEY is not configured.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [email],
      subject: "Your X-CAPITAL email verification code",
      html: `<div style="font-family:Arial,sans-serif;line-height:1.6"><h2>X-CAPITAL</h2><p>Hello ${escapeHtml(name)},</p><p>Your verification code is:</p><p style="font-size:30px;font-weight:700;letter-spacing:8px">${code}</p><p>This code expires in 10 minutes.</p><p>If you did not request this, you can ignore this email.</p></div>`,
      text: `Hello ${name},\n\nYour X-CAPITAL verification code is ${code}.\nIt expires in 10 minutes.\n\nIf you did not request this, ignore this email.`
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Email provider rejected the message (${response.status}). ${detail.slice(0, 300)}`);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]));
}

function makeOtp() {
  const code = String(crypto.randomInt(100000, 1000000));
  return { code, hash: hashText(code), expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
}

function pendingByEmail(email) {
  return db.prepare("SELECT * FROM pending_registrations WHERE email = ?").get(email);
}

async function createPendingRegistration({ name, email, passwordHash }) {
  const existing = pendingByEmail(email);
  if (existing && Date.now() - new Date(existing.last_sent_at).getTime() < 60 * 1000) {
    throw Object.assign(new Error("A verification code was already sent. Please wait a minute before requesting another."), { status: 429 });
  }

  const otp = makeOtp();
  const pending = {
    id: existing?.id || id(),
    name,
    email,
    password_hash: passwordHash,
    code_hash: otp.hash,
    expires_at: otp.expiresAt,
    attempts: 0,
    last_sent_at: now(),
    created_at: existing?.created_at || now()
  };

  db.prepare(`
    INSERT INTO pending_registrations (id,name,email,password_hash,code_hash,expires_at,attempts,last_sent_at,created_at)
    VALUES (@id,@name,@email,@password_hash,@code_hash,@expires_at,@attempts,@last_sent_at,@created_at)
    ON CONFLICT(email) DO UPDATE SET
      name=excluded.name,
      password_hash=excluded.password_hash,
      code_hash=excluded.code_hash,
      expires_at=excluded.expires_at,
      attempts=excluded.attempts,
      last_sent_at=excluded.last_sent_at
  `).run(pending);

  try {
    await sendVerificationEmail(email, name, otp.code);
  } catch (e) {
    db.prepare("DELETE FROM pending_registrations WHERE email = ?").run(email);
    throw e;
  }
}

function issueSession(res, user) {
  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: "7d" });
  res.cookie("xcapital_session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

function clearSession(res) {
  res.clearCookie("xcapital_session", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
}

function getUserFromRequest(req) {
  const raw = req.headers.cookie || "";
  const match = raw.match(/(?:^|;\s*)xcapital_session=([^;]+)/);
  if (!match) return null;
  try {
    const payload = jwt.verify(decodeURIComponent(match[1]), JWT_SECRET);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(payload.sub) || null;
  } catch (_) { return null; }
}

function requireAuth(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Please sign in." });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user || user.role !== "admin") return res.status(403).json({ message: "Administrator access required." });
  req.user = user;
  next();
}

async function sendVerificationEmail(email, name, code) {
  if (!mailer) {
    if (process.env.NODE_ENV !== "production") console.log(`[DEV OTP] ${email}: ${code}`);
    return;
  }
  await mailer.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: email,
    subject: "Your X-CAPITAL email verification code",
    text: `Hello ${name},\n\nYour X-CAPITAL verification code is ${code}.\nIt expires in 10 minutes.\n\nIf you did not create this account, ignore this email.`
  });
}

function publicUser(user) {
  return {
    id: user.id, name: user.name, email: user.email,
    role: user.role, emailVerified: !!user.email_verified,
    availableBalance: Number(user.available_balance)
  };
}

function logAudit(actor, action, targetId, metadata = {}) {
  db.prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_id, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id(), actor?.id || null, action, targetId || null, JSON.stringify(metadata), now());
}

function snapshotUser(userId) {
  const user = db.prepare("SELECT available_balance FROM users WHERE id = ?").get(userId);
  const holdings = db.prepare("SELECT asset_id, units FROM holdings WHERE user_id = ?").all(userId);
  const holdingsValue = holdings.reduce((sum, h) => sum + h.units * (MARKET_DATA[h.asset_id]?.price || 0), 0);
  const total = Number(user?.available_balance || 0) + holdingsValue;
  db.prepare("INSERT INTO performance_snapshots (id,user_id,value,created_at) VALUES (?,?,?,?)")
    .run(id(), userId, total, now());
}

function getDashboard(userId) {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  const holdings = db.prepare("SELECT * FROM holdings WHERE user_id = ?").all(userId).map(h => {
    const market = MARKET_DATA[h.asset_id];
    const currentPrice = market?.price || h.average_cost;
    const currentValue = h.units * currentPrice;
    return {
      assetId: h.asset_id, assetName: h.asset_name, units: h.units,
      averageCost: h.average_cost, currentPrice, currentValue,
      unrealizedGain: currentValue - h.total_cost
    };
  });
  const holdingsValue = holdings.reduce((s, h) => s + h.currentValue, 0);
  const cost = holdings.reduce((s, h) => s + h.total_cost, 0);
  const gain = holdingsValue - cost;
  const gainPct = cost > 0 ? gain / cost * 100 : 0;

  let points = db.prepare("SELECT created_at AS date, value FROM performance_snapshots WHERE user_id = ? ORDER BY created_at ASC LIMIT 90").all(userId);
  if (!points.length) {
    snapshotUser(userId);
    points = db.prepare("SELECT created_at AS date, value FROM performance_snapshots WHERE user_id = ? ORDER BY created_at ASC LIMIT 90").all(userId);
  }

  return {
    user: publicUser(user),
    metrics: {
      availableBalance: Number(user.available_balance),
      holdingsValue,
      totalPortfolioValue: Number(user.available_balance) + holdingsValue,
      unrealizedGain: gain,
      gainPct
    },
    holdings,
    markets: Object.values(MARKET_DATA),
    transactions: db.prepare("SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(userId),
    performance: points
  };
}

/* Auth */
app.post("/api/auth/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (name.length < 2) return res.status(400).json({ message: "Enter your full name." });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ message: "Enter a valid email address." });
    if (password.length < 8) return res.status(400).json({ message: "Password must be at least 8 characters." });
    if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) return res.status(409).json({ message: "An account with this email already exists." });

    await createPendingRegistration({ name, email, passwordHash: await bcrypt.hash(password, 12) });
    res.json({ ok: true, message: "Verification code sent. Your account will be created after you verify your email." });
  } catch (e) {
    console.error(e);
    const status = e.status || 500;
    res.status(status).json({ message: status === 429 ? e.message : "We could not send the verification email. Your account was not created. Please try again." });
  }
});

app.post("/api/auth/verify-email", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const code = String(req.body.code || "").trim();
  const pending = pendingByEmail(email);
  if (!pending) return res.status(404).json({ message: "No pending registration was found for this email." });
  if (new Date(pending.expires_at) < new Date()) return res.status(400).json({ message: "That code has expired. Request a new one." });
  if (pending.attempts >= 5) return res.status(429).json({ message: "Too many attempts. Request a new code." });

  db.prepare("UPDATE pending_registrations SET attempts = attempts + 1 WHERE id = ?").run(pending.id);
  if (hashText(code) !== pending.code_hash) return res.status(400).json({ message: "Incorrect verification code." });

  const user = { id: id(), name: pending.name, email: pending.email, role: "investor", password_hash: pending.password_hash, email_verified: 1, available_balance: 0, created_at: now() };
  const finish = db.transaction(() => {
    if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) throw new Error("An account with this email already exists.");
    db.prepare(`INSERT INTO users (id,name,email,password_hash,role,email_verified,available_balance,created_at) VALUES (@id,@name,@email,@password_hash,@role,@email_verified,@available_balance,@created_at)`).run(user);
    db.prepare(`INSERT INTO transactions (id,user_id,type,details,amount,status,created_at) VALUES (?,?,?,?,?,?,?)`).run(id(), user.id, "System", "Account created after email verification", 0, "Completed", now());
    db.prepare("DELETE FROM pending_registrations WHERE id = ?").run(pending.id);
  });

  try {
    finish();
  } catch (e) {
    console.error(e);
    return res.status(409).json({ message: "We could not finish creating this account. Please try registration again." });
  }

  issueSession(res, user);
  logAudit(user, "account_created_after_email_verification", user.id);
  res.json({ ok: true, message: "Email verified successfully. Your account is ready and you are now signed in." });
});

app.post("/api/auth/resend-code", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const pending = pendingByEmail(email);
  if (!pending) {
    const user = db.prepare("SELECT id,email_verified FROM users WHERE email = ?").get(email);
    if (user?.email_verified) return res.status(400).json({ message: "This email is already verified." });
    return res.status(404).json({ message: "No pending registration was found for this email." });
  }

  if (Date.now() - new Date(pending.last_sent_at).getTime() < 60 * 1000) {
    return res.status(429).json({ message: "Please wait a minute before requesting another code." });
  }

  try {
    await createPendingRegistration({ name: pending.name, email, passwordHash: pending.password_hash });
    res.json({ ok: true, message: "A new verification code has been sent." });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ message: e.status === 429 ? e.message : "We could not send a new verification email." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) {
    const pending = pendingByEmail(email);
    if (pending && await bcrypt.compare(password, pending.password_hash)) {
      return res.status(403).json({ message: "Please verify your email first.", requiresVerification: true });
    }
    return res.status(401).json({ message: "Invalid email or password." });
  }
  if (!(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ message: "Invalid email or password." });
  if (!user.email_verified) return res.status(403).json({ message: "Please verify your email first.", requiresVerification: true });
  issueSession(res, user);
  logAudit(user, "login", user.id);
  res.json({ ok: true, user: publicUser(user) });
});

app.post("/api/auth/logout", (req, res) => {
  const user = getUserFromRequest(req);
  if (user) logAudit(user, "logout", user.id);
  clearSession(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

/* User dashboard */
app.get("/api/dashboard", requireAuth, (req, res) => {
  if (req.user.role === "admin") return res.status(403).json({ message: "Admin accounts use the admin control center." });
  snapshotUser(req.user.id);
  res.json(getDashboard(req.user.id));
});

/* Profile */
app.patch("/api/profile", requireAuth, (req, res) => {
  const name = String(req.body.name || "").trim();
  if (name.length < 2) return res.status(400).json({ message: "Enter a valid name." });
  db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, req.user.id);
  logAudit(req.user, "profile_updated", req.user.id, { name });
  res.json({ ok: true });
});

app.patch("/api/profile/password", requireAuth, async (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");
  if (newPassword.length < 8) return res.status(400).json({ message: "New password must be at least 8 characters." });
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) return res.status(400).json({ message: "Current password is incorrect." });
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await bcrypt.hash(newPassword, 12), user.id);
  logAudit(user, "password_changed", user.id);
  issueSession(res, user);
  res.json({ ok: true });
});

/* Wallet */
app.get("/api/wallet/deposit-address", requireAuth, (req, res) => {
  const asset = String(req.query.asset || "");
  if (!(asset in WALLET_ADDRESSES) || !WALLET_ADDRESSES[asset]) {
    return res.status(503).json({ message: "This deposit network is not configured yet." });
  }
  res.json({ address: WALLET_ADDRESSES[asset] });
});

/* Deposits */
app.post("/api/deposits", requireAuth, (req, res) => {
  const asset = String(req.body.asset || "");
  const amount = Number(req.body.amount);
  const txHash = String(req.body.txHash || "").trim();

  if (!WALLET_ADDRESSES[asset]) return res.status(400).json({ message: "This deposit network is not configured." });
  if (!Number.isFinite(amount) || amount < 10) return res.status(400).json({ message: "Minimum deposit is $10 equivalent." });
  if (txHash.length < 12) return res.status(400).json({ message: "Enter the blockchain transaction hash so operations can verify the transfer." });

  const duplicate = db.prepare("SELECT id FROM deposits WHERE tx_hash = ? AND tx_hash IS NOT NULL").get(txHash);
  if (duplicate) return res.status(409).json({ message: "That transaction hash has already been submitted." });

  const depositId = id();
  db.prepare("INSERT INTO deposits (id,user_id,asset,amount,tx_hash,status,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(depositId, req.user.id, asset, amount, txHash, "pending", now());
  db.prepare("INSERT INTO transactions (id,user_id,type,details,amount,status,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id(), req.user.id, "Deposit", `${asset} deposit submitted • TX ${txHash.slice(0, 10)}…`, amount, "Pending Verification", now());
  logAudit(req.user, "deposit_submitted", depositId, { asset, amount, txHash });
  res.json({ ok: true, depositId });
});

/* Withdrawals: funds are reserved, not permanently deducted, until admin approval. */
app.post("/api/withdrawals", requireAuth, (req, res) => {
  const asset = String(req.body.asset || "");
  const amount = Number(req.body.amount);
  const address = String(req.body.address || "").trim();
  if (!["USDT (TRC-20)", "USDC (ERC-20)"].includes(asset)) return res.status(400).json({ message: "Unsupported withdrawal network." });
  if (!Number.isFinite(amount) || amount < 10) return res.status(400).json({ message: "Minimum withdrawal is $10." });
  if (address.length < 10) return res.status(400).json({ message: "Enter a valid destination wallet address." });

  const pending = db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM withdrawals WHERE user_id = ? AND status = 'pending'").get(req.user.id).total;
  const available = Number(req.user.available_balance) - Number(pending);
  if (amount > available) return res.status(400).json({ message: "Insufficient cleared balance." });

  const wid = id();
  db.prepare("INSERT INTO withdrawals (id,user_id,asset,amount,address,status,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(wid, req.user.id, asset, amount, address, "pending", now());
  db.prepare("INSERT INTO transactions (id,user_id,type,details,amount,status,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id(), req.user.id, "Withdrawal", `${asset} withdrawal requested`, -amount, "Pending Approval", now());
  logAudit(req.user, "withdrawal_submitted", wid, { asset, amount });
  res.json({ ok: true });
});

/* Buy order */
app.post("/api/orders/buy", requireAuth, (req, res) => {
  const assetId = String(req.body.assetId || "");
  const amount = Number(req.body.amount);
  const market = MARKET_DATA[assetId];
  if (!market) return res.status(400).json({ message: "Unknown investment asset." });
  if (!Number.isFinite(amount) || amount < 10) return res.status(400).json({ message: "Minimum order is $10." });
  if (amount > Number(req.user.available_balance)) return res.status(400).json({ message: "Insufficient cleared balance." });

  const units = amount / market.price;
  const existing = db.prepare("SELECT * FROM holdings WHERE user_id = ? AND asset_id = ?").get(req.user.id, assetId);
  const newUnits = Number(existing?.units || 0) + units;
  const newTotalCost = Number(existing?.total_cost || 0) + amount;
  const newAvg = newTotalCost / newUnits;

  const tx = db.transaction(() => {
    db.prepare("UPDATE users SET available_balance = available_balance - ? WHERE id = ?").run(amount, req.user.id);
    if (existing) {
      db.prepare("UPDATE holdings SET units=?, average_cost=?, total_cost=?, updated_at=? WHERE id=?")
        .run(newUnits, newAvg, newTotalCost, now(), existing.id);
    } else {
      db.prepare(`
        INSERT INTO holdings (id,user_id,asset_id,asset_name,units,average_cost,total_cost,updated_at)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(id(), req.user.id, assetId, market.name, units, market.price, amount, now());
    }
    db.prepare("INSERT INTO transactions (id,user_id,type,details,amount,status,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id(), req.user.id, "Asset Purchase", `${market.name} — ${units.toFixed(6)} units`, -amount, "Settled", now());
    logAudit(req.user, "buy_order", req.user.id, { assetId, amount, units, price: market.price });
  });
  tx();
  snapshotUser(req.user.id);
  res.json({ ok: true, units, price: market.price });
});

/* Admin */
app.get("/api/admin/overview", requireAdmin, (req, res) => {
  const deposits = db.prepare(`
    SELECT d.*, u.name, u.email FROM deposits d JOIN users u ON u.id=d.user_id
    WHERE d.status='pending' ORDER BY d.created_at ASC
  `).all();
  const withdrawals = db.prepare(`
    SELECT w.*, u.name, u.email FROM withdrawals w JOIN users u ON u.id=w.user_id
    WHERE w.status='pending' ORDER BY w.created_at ASC
  `).all();
  const investorCount = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='investor'").get().count;
  const pendingDepositTotal = deposits.reduce((sum, d) => sum + Number(d.amount || 0), 0);
  const pendingWithdrawalTotal = withdrawals.reduce((sum, w) => sum + Number(w.amount || 0), 0);
  res.json({ deposits, withdrawals, stats: { investorCount, pendingDepositTotal, pendingWithdrawalTotal } });
});

app.post("/api/admin/deposits/:id/approve", requireAdmin, (req, res) => {
  const deposit = db.prepare("SELECT * FROM deposits WHERE id = ? AND status='pending'").get(req.params.id);
  if (!deposit) return res.status(404).json({ message: "Pending deposit not found." });

  const tx = db.transaction(() => {
    db.prepare("UPDATE deposits SET status='approved', reviewed_at=? WHERE id=?").run(now(), deposit.id);
    db.prepare("UPDATE users SET available_balance = available_balance + ? WHERE id=?").run(deposit.amount, deposit.user_id);
    db.prepare(`
      UPDATE transactions SET status='Completed', details=?
      WHERE user_id=? AND type='Deposit' AND status='Pending Verification'
      ORDER BY created_at DESC LIMIT 1
    `).run(`${deposit.asset} deposit verified and credited`, deposit.user_id);
    db.prepare("INSERT INTO transactions (id,user_id,type,details,amount,status,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id(), deposit.user_id, "Admin Credit", `${deposit.asset} verified deposit`, deposit.amount, "Completed", now());
    logAudit(req.user, "deposit_approved", deposit.id, { userId: deposit.user_id, amount: deposit.amount });
  });
  tx();
  snapshotUser(deposit.user_id);
  res.json({ ok: true });
});

app.post("/api/admin/deposits/:id/reject", requireAdmin, (req, res) => {
  const deposit = db.prepare("SELECT * FROM deposits WHERE id = ? AND status='pending'").get(req.params.id);
  if (!deposit) return res.status(404).json({ message: "Pending deposit not found." });
  db.prepare("UPDATE deposits SET status='rejected', reviewed_at=? WHERE id=?").run(now(), deposit.id);
  db.prepare(`
    UPDATE transactions SET status='Rejected', details=?
    WHERE user_id=? AND type='Deposit' AND status='Pending Verification'
    ORDER BY created_at DESC LIMIT 1
  `).run(`${deposit.asset} deposit notification rejected`, deposit.user_id);
  logAudit(req.user, "deposit_rejected", deposit.id, { userId: deposit.user_id });
  res.json({ ok: true });
});

app.post("/api/admin/withdrawals/:id/approve", requireAdmin, (req, res) => {
  const withdrawal = db.prepare("SELECT * FROM withdrawals WHERE id = ? AND status='pending'").get(req.params.id);
  if (!withdrawal) return res.status(404).json({ message: "Pending withdrawal not found." });

  const user = db.prepare("SELECT * FROM users WHERE id=?").get(withdrawal.user_id);
  const pendingOther = db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM withdrawals WHERE user_id=? AND status='pending' AND id<>?")
    .get(user.id, withdrawal.id).total;
  const cleared = Number(user.available_balance) - Number(pendingOther);
  if (withdrawal.amount > cleared) return res.status(400).json({ message: "The user's cleared balance is no longer sufficient." });

  const tx = db.transaction(() => {
    db.prepare("UPDATE users SET available_balance = available_balance - ? WHERE id=?").run(withdrawal.amount, user.id);
    db.prepare("UPDATE withdrawals SET status='approved', reviewed_at=? WHERE id=?").run(now(), withdrawal.id);
    db.prepare(`
      UPDATE transactions SET status='Approved', details=?
      WHERE user_id=? AND type='Withdrawal' AND status='Pending Approval'
      ORDER BY created_at DESC LIMIT 1
    `).run(`${withdrawal.asset} withdrawal approved — payout address ${withdrawal.address}`, user.id);
    logAudit(req.user, "withdrawal_approved", withdrawal.id, { userId: user.id, amount: withdrawal.amount });
  });
  tx();
  snapshotUser(user.id);
  res.json({ ok: true });
});

app.post("/api/admin/withdrawals/:id/reject", requireAdmin, (req, res) => {
  const withdrawal = db.prepare("SELECT * FROM withdrawals WHERE id = ? AND status='pending'").get(req.params.id);
  if (!withdrawal) return res.status(404).json({ message: "Pending withdrawal not found." });
  db.prepare("UPDATE withdrawals SET status='rejected', reviewed_at=? WHERE id=?").run(now(), withdrawal.id);
  db.prepare(`
    UPDATE transactions SET status='Rejected', details=?
    WHERE user_id=? AND type='Withdrawal' AND status='Pending Approval'
    ORDER BY created_at DESC LIMIT 1
  `).run(`${withdrawal.asset} withdrawal rejected; reserved funds released`, withdrawal.user_id);
  logAudit(req.user, "withdrawal_rejected", withdrawal.id, { userId: withdrawal.user_id });
  res.json({ ok: true });
});

app.post("/api/admin/credits", requireAdmin, (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const amount = Number(req.body.amount);
  const user = db.prepare("SELECT * FROM users WHERE email=? AND role='investor'").get(email);
  if (!user) return res.status(404).json({ message: "Investor account not found." });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: "Enter a valid amount." });

  const tx = db.transaction(() => {
    db.prepare("UPDATE users SET available_balance=available_balance+? WHERE id=?").run(amount, user.id);
    db.prepare("INSERT INTO transactions (id,user_id,type,details,amount,status,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id(), user.id, "Admin Credit", "Manual account credit — independently verified", amount, "Completed", now());
    logAudit(req.user, "manual_credit", user.id, { amount, email });
  });
  tx();
  snapshotUser(user.id);
  res.json({ ok: true });
});

/* Serve SPA */
app.get("/*splat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`X-CAPITAL running on http://localhost:${PORT}`));

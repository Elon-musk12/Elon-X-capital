
require("dotenv").config();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const password = String(process.env.ADMIN_PASSWORD || "");
if (!email || !password) throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD.");
if (password.length < 12) throw new Error("Admin password should be at least 12 characters.");

const db = new Database(process.env.DB_FILE || "./data/xcapital.db");
const id = crypto.randomUUID();
const hash = bcrypt.hashSync(password, 12);
const existing = db.prepare("SELECT id FROM users WHERE email=?").get(email);

if (existing) {
  db.prepare("UPDATE users SET password_hash=?, role='admin', email_verified=1 WHERE id=?").run(hash, existing.id);
  console.log("Admin account updated:", email);
} else {
  db.prepare(`
    INSERT INTO users (id,name,email,password_hash,role,email_verified,available_balance,created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id, "Master Admin", email, hash, "admin", 1, 0, new Date().toISOString());
  console.log("Admin account created:", email);
}

const crypto = require("crypto");
const { Pool } = require("pg");

let pool;

function encryptionKey() {
  const secret = process.env.KEY_ENCRYPTION_SECRET;
  if (!secret) throw new Error("KEY_ENCRYPTION_SECRET is not set");
  return crypto.createHash("sha256").update(secret).digest();
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decrypt(row) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(row.secret_iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(row.secret_tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(row.secret_ciphertext, "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const external = /render\.com/.test(connectionString);
  pool = new Pool({
    connectionString,
    max: 5,
    ssl: external ? { rejectUnauthorized: false } : undefined,
  });
  return pool;
}

async function migrate() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      api_key TEXT NOT NULL UNIQUE,
      secret_ciphertext TEXT NOT NULL,
      secret_iv TEXT NOT NULL,
      secret_tag TEXT NOT NULL,
      peak_equity DOUBLE PRECISION,
      last_rebalance_day TEXT,
      halted BOOLEAN NOT NULL DEFAULT FALSE,
      last_error TEXT,
      last_run_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function saveAccount(apiKey, apiSecret) {
  const sealed = encrypt(apiSecret);
  const existing = await getPool().query("SELECT id FROM accounts WHERE api_key = $1", [apiKey]);
  if (existing.rows[0]) {
    const id = existing.rows[0].id;
    await getPool().query(
      `UPDATE accounts
       SET secret_ciphertext = $2, secret_iv = $3, secret_tag = $4,
           halted = FALSE, peak_equity = NULL, last_rebalance_day = NULL, last_error = NULL
       WHERE id = $1`,
      [id, sealed.ciphertext, sealed.iv, sealed.tag]
    );
    return id;
  }
  const id = crypto.randomUUID();
  await getPool().query(
    `INSERT INTO accounts (id, api_key, secret_ciphertext, secret_iv, secret_tag)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, apiKey, sealed.ciphertext, sealed.iv, sealed.tag]
  );
  return id;
}

async function getAccount(id) {
  const result = await getPool().query("SELECT * FROM accounts WHERE id = $1", [id]);
  return result.rows[0] || null;
}

async function secretOf(row) {
  return decrypt(row);
}

async function listTradable() {
  const result = await getPool().query(
    "SELECT * FROM accounts WHERE halted = FALSE ORDER BY created_at ASC"
  );
  return result.rows;
}

async function markRun(id, fields) {
  await getPool().query(
    `UPDATE accounts
     SET peak_equity = $2, last_rebalance_day = $3, halted = $4, last_error = $5, last_run_at = NOW()
     WHERE id = $1`,
    [id, fields.peakEquity, fields.lastRebalanceDay, fields.halted, fields.lastError]
  );
}

async function deleteAccount(id) {
  await getPool().query("DELETE FROM accounts WHERE id = $1", [id]);
}

function publicAccount(row) {
  if (!row) return null;
  const key = row.api_key || "";
  return {
    accountId: row.id,
    apiKeyHint: key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : "••••",
    halted: row.halted,
    lastRebalanceDay: row.last_rebalance_day,
    lastRunAt: row.last_run_at,
    lastError: row.last_error,
    peakEquity: row.peak_equity,
  };
}

module.exports = {
  migrate,
  saveAccount,
  getAccount,
  secretOf,
  listTradable,
  markRun,
  deleteAccount,
  publicAccount,
};

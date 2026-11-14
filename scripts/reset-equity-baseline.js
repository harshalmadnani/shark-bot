#!/usr/bin/env node
/*
 * ============================================================================================
 *   DO NOT RUN AGAINST PROD WITHOUT ARNAV'S APPROVAL.
 * ============================================================================================
 *
 * Why this exists
 * ---------------
 * Before the equity fix, rebalance.js equityOf() recorded Shark's wallet.marginBalance as equity.
 * On Shark, marginBalance is FREE cash (walletBalance minus locked position margin) and excludes
 * unrealised PnL. So every activity.equity row recorded while positions were open is understated
 * by the locked margin, and so are the admin "start equity" (first equity row) and
 * accounts.peak_equity. Equity is now walletBalance + unrealisedPnlCross + unrealisedPnlIsolated.
 *
 * What it does
 * ------------
 * Default is a DRY RUN: for each account (optionally only one book via `--book flywheel`) it
 * prints the current start equity, the latest recorded equity and peak_equity. Nothing is written.
 *
 * With `--apply` it fetches each account's live Shark futures wallet (marginAsset INR), computes
 * equityOf(live wallet), inserts an activity row with kind = 'baseline_reset' and that equity,
 * and sets accounts.peak_equity to the same value.
 *
 * How the reset takes effect
 * --------------------------
 * store.js adminOverview normally takes the FIRST equity row as the start. A baseline_reset row
 * only takes effect because adminOverview uses the equity of the most recent kind='baseline_reset'
 * row as start_equity when one exists, falling back to the first non-null equity row. After a
 * reset, admin PnL is measured from the reset point; PnL earned before the reset is not shown.
 *
 * Usage (never wired into package.json start/test):
 *   DATABASE_URL=... KEY_ENCRYPTION_SECRET=... node scripts/reset-equity-baseline.js [--book flywheel]
 *   DATABASE_URL=... KEY_ENCRYPTION_SECRET=... node scripts/reset-equity-baseline.js --book flywheel --apply
 */
const path = require("path");
const { Pool } = require("pg");
const root = path.join(__dirname, "..");
const store = require(path.join(root, "store"));
const { SharkClient, sharkError } = require(path.join(root, "shark"));
const { equityOf } = require(path.join(root, "rebalance"));

function args(argv) {
  const out = { apply: false, book: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apply") out.apply = true;
    else if (argv[i] === "--book") out.book = String(argv[++i] || "");
    else if (argv[i].startsWith("--book=")) out.book = argv[i].slice(7);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return out;
}

/** Same pg setup as store.js getPool (which is not exported). */
function makePool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const external = /render\.com/.test(connectionString);
  return new Pool({ connectionString, max: 2, ssl: external ? { rejectUnauthorized: false } : undefined });
}

async function main() {
  const { apply, book } = args(process.argv.slice(2));
  const pool = makePool();
  try {
    const { rows } = await pool.query(
      `SELECT a.id,
              COALESCE(NULLIF(a.book, ''), 'alpha') AS book,
              a.peak_equity,
              (SELECT equity FROM activity WHERE account_id = a.id AND equity IS NOT NULL ORDER BY at ASC LIMIT 1) AS first_equity,
              (SELECT equity FROM activity WHERE account_id = a.id AND kind = 'baseline_reset' AND equity IS NOT NULL ORDER BY at DESC LIMIT 1) AS reset_equity,
              (SELECT equity FROM activity WHERE account_id = a.id AND equity IS NOT NULL ORDER BY at DESC LIMIT 1) AS latest_equity
       FROM accounts a
       WHERE ($1 = '' OR COALESCE(NULLIF(a.book, ''), 'alpha') = $1)
       ORDER BY a.created_at ASC`,
      [book]
    );
    console.log(`${apply ? "APPLY" : "DRY RUN"}: ${rows.length} account(s)${book ? ` in book ${book}` : ""}`);
    for (const row of rows) {
      const start = row.reset_equity ?? row.first_equity;
      const line = `${String(row.id).slice(0, 8)} ${row.book} start=${start} latest=${row.latest_equity} peak=${row.peak_equity}`;
      if (!apply) {
        console.log(line);
        continue;
      }
      try {
        const account = await store.getAccount(row.id);
        const client = new SharkClient(account.api_key, await store.secretOf(account));
        const wallet = await client.get("/v1/wallet/futures-wallet/details", { marginAsset: "INR" });
        const error = sharkError(wallet);
        if (error) throw new Error(error);
        const equity = equityOf(wallet.body);
        if (equity == null) throw new Error("no readable walletBalance; skipped");
        await pool.query(
          `INSERT INTO activity (book, account_id, owner_id, kind, equity, ok, detail)
           VALUES ($1, $2, $3, 'baseline_reset', $4, TRUE, $5)`,
          [row.book, row.id, account.owner_id || null, equity, "equity baseline reset after marginBalance fix"]
        );
        await pool.query("UPDATE accounts SET peak_equity = $2 WHERE id = $1", [row.id, equity]);
        console.log(`${line} -> reset to ${equity}`);
      } catch (error) {
        console.log(`${line} -> FAILED: ${error.message}`);
      }
    }
  } finally {
    await pool.end();
  }
}

main().then(() => process.exit(0), (error) => {
  console.error(error.message);
  process.exit(1);
});

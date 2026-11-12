// One copy of the bot at a time per account: the run lease (2026-11-12, two instances overlapped in a deploy).
const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("https");
const { EventEmitter } = require("events");
const store = require("./store");
const rb = require("./rebalance");

const ID = "4d39ae0d-1111-2222-3333-444455556666";

function exchange() {
  const calls = [];
  https.request = (options, callback) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => setImmediate(() => {
      const path = options.path.split("?")[0];
      calls.push(path);
      const body = path === "/v1/positions/OPEN" ? [] : path === "/v1/exchange/exchangeInfo" ? { contracts: [], conversionRates: {} } : {};
      const res = new EventEmitter();
      res.statusCode = 200;
      callback(res);
      res.emit("data", JSON.stringify(body));
      res.emit("end");
    });
    return req;
  };
  return calls;
}

function stubStore({ lease = true, lastDay = null } = {}) {
  const row = { id: ID, book: "moon", owner_id: "did:privy:x", api_key: "FAKEKEYFAKEKEYFAKE", peak_equity: 100, last_rebalance_day: lastDay, halted: false };
  const log = [];
  store.getAccount = async () => (log.includes("delete") ? null : { ...row });
  store.claimRun = async () => { log.push("claim"); return lease ? { ...row } : null; };
  store.releaseRun = async () => { log.push("release"); };
  store.deleteAccount = async () => { log.push("delete"); };
  store.secretOf = async () => "FAKESECRETFAKESECRET";
  store.recordActivity = async () => {};
  store.markRun = async () => { log.push("markRun"); };
  return log;
}

test("an account leased by another copy is skipped and nothing is sent", async () => {
  const calls = exchange();
  const log = stubStore({ lease: false });
  const result = await rb.rebalanceAccount(ID, { due: true });
  assert.deepEqual(result, { skipped: true, locked: true });
  assert.deepEqual(calls, [], "no exchange call at all");
  assert.ok(!log.includes("release"), "a lease it never took is not released");
});

test("an account another copy already finished today is skipped after taking the lease", async () => {
  const calls = exchange();
  const log = stubStore({ lastDay: rb.utcDay() });
  const result = await rb.rebalanceAccount(ID, { due: true });
  assert.deepEqual(result, { skipped: true, done: true });
  assert.deepEqual(calls, []);
  assert.deepEqual(log, ["claim", "release"]);
});

test("the lease is released when a run fails", async () => {
  exchange();
  const log = stubStore();
  store.secretOf = async () => { throw new Error("bad decrypt"); };
  const result = await rb.rebalanceAccount(ID, { due: true });
  assert.equal(result.error, "bad decrypt");
  assert.equal(log.at(-1), "release");
});

test("disconnect closes and deletes while holding the lease", async () => {
  exchange();
  const log = stubStore();
  assert.deepEqual(await rb.disconnectAccount(ID), { disconnected: true });
  assert.deepEqual(log, ["claim", "delete"], "deleted under the lease; nothing can reopen positions in between");
});

test("disconnect waits for a running rebalance and answers 409 if it does not finish", async () => {
  exchange();
  const log = stubStore({ lease: false });
  await assert.rejects(rb.disconnectAccount(ID, { waitMs: 1500 }), (error) => error.status === 409);
  assert.ok(!log.includes("delete"), "the account is not deleted mid-run");
});

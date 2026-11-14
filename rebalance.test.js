// The daily run against an in-memory Shark exchange. No network: https.request is replaced.
const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("https");
const { EventEmitter } = require("events");
const store = require("./store");
const { UNIVERSE } = require("./book");
const rb = require("./rebalance");

const ID = "4d39ae0d-1111-2222-3333-444455556666";
const DAY = 86_400_000;
const RATE = 100;

function klines(index) {
  const today = Math.floor(Date.now() / DAY) * DAY;
  const rows = [];
  let close = 100 + index;
  for (let d = 120; d >= 1; d -= 1) {
    const open = close;
    close = open * (1 + (index - 7.5) * 0.004 + 0.01 * Math.sin(d + index));
    rows.push({ startTime: today - d * DAY, endTime: today - (d - 1) * DAY - 1, open: String(open), close: String(close) });
  }
  return rows;
}

/** A fake Shark exchange. Positions are { contractPair, quantity, positionType }. */
function exchange({ wallet = { walletBalance: "100000", marginBalance: "100000" }, positions = [] } = {}) {
  const state = { wallet, positions: positions.map((p) => ({ ...p })), orders: [], leverageCalls: [] };
  const signed = (p) => {
    const row = state.positions.find((x) => x.contractPair === p);
    if (!row) return 0;
    return row.positionType === "SHORT" ? -Number(row.quantity) : Number(row.quantity);
  };
  function reply(method, path, body) {
    const [p] = path.split("?");
    const params = body ? JSON.parse(body) : {};
    if (p === "/v1/wallet/futures-wallet/details") return { status: 200, body: state.wallet };
    if (p === "/v1/exchange/exchangeInfo") {
      return {
        status: 200,
        body: {
          contracts: [...UNIVERSE.map((c) => `${c}USDT`), "PEPEUSDT"].map((name) => ({
            name, quantityPrecision: 3, maxLeverage: 20,
            filters: [{ filterType: "MARKET_QTY_SIZE", minQty: "0.001" }, { filterType: "MIN_NOTIONAL", notional: "1" }],
          })),
          conversionRates: { INR_MARGIN_USDT: RATE },
        },
      };
    }
    if (p === "/v1/market/klines") return { status: 200, body: klines(UNIVERSE.indexOf(params.pair.replace(/USDT$/, ""))) };
    if (p === "/v1/positions/OPEN") return { status: 200, body: state.positions.filter((x) => Number(x.quantity) > 0) };
    if (p === "/v1/exchange/update/preference" || p === "/v1/exchange/update/leverage") {
      state.leverageCalls.push(params.contractName);
      return { status: 200, body: {} };
    }
    if (p === "/v1/order/place-order") {
      state.orders.push(params);
      const next = +(signed(params.symbol) + (params.side === "BUY" ? params.quantity : -params.quantity)).toFixed(8);
      state.positions = state.positions.filter((x) => x.contractPair !== params.symbol);
      if (next !== 0) state.positions.push({ contractPair: params.symbol, quantity: String(Math.abs(next)), positionType: next > 0 ? "LONG" : "SHORT" });
      return { status: 200, body: { orderId: state.orders.length } };
    }
    return { status: 404, body: { message: `not mocked ${p}` } };
  }
  https.request = (options, callback) => {
    const req = new EventEmitter();
    let body = "";
    req.write = (chunk) => { body += chunk; };
    req.end = () =>
      setImmediate(() => {
        const r = reply(options.method, options.path, body);
        const res = new EventEmitter();
        res.statusCode = r.status;
        callback(res);
        res.emit("data", JSON.stringify(r.body));
        res.emit("end");
      });
    return req;
  };
  state.signed = signed;
  return state;
}

function account(overrides = {}) {
  const db = { row: { id: ID, book: "alpha", owner_id: "did:privy:x", api_key: "FAKEKEYFAKEKEYFAKE", peak_equity: 100000, last_rebalance_day: null, halted: false, ...overrides } };
  store.getAccount = async (id) => (db.row && db.row.id === id ? { ...db.row } : null);
  store.secretOf = async () => "FAKESECRETFAKESECRET";
  store.recordActivity = async () => {};
  store.markRun = async (id, m) => Object.assign(db.row, { peak_equity: m.peakEquity, last_rebalance_day: m.lastRebalanceDay, halted: m.halted, last_error: m.lastError });
  return db;
}

const pos = (symbol, qty) => ({ contractPair: symbol, quantity: String(Math.abs(qty)), positionType: qty > 0 ? "LONG" : "SHORT" });

// ---- An unreadable wallet is an error, never zero equity (audit S1)

test("equity is only read from real numbers", () => {
  assert.equal(rb.equityOf({ marginBalance: null, walletBalance: null }), null);
  assert.equal(rb.equityOf({}), null);
  assert.equal(rb.equityOf(null), null);
  assert.equal(rb.equityOf({ data: { marginBalance: "5000" } }), null);
  assert.equal(rb.equityOf({ marginBalance: "" }), null);
  assert.equal(rb.equityOf({ marginBalance: "0", walletBalance: "0" }), null);
  assert.equal(rb.equityOf({ marginBalance: "5000" }), null, "marginBalance is free cash, never equity");
  assert.equal(rb.equityOf({ marginBalance: null, walletBalance: "5000", unrealisedPnlCross: "-100" }), 4900);
});

test("equity with positions open is walletBalance + unrealised PnL, not marginBalance", () => {
  const equity = rb.equityOf({
    walletBalance: "4859.96",
    marginBalance: "3431.61",
    lockedBalance: "1428.35",
    unrealisedPnlCross: "120",
    unrealisedPnlIsolated: "0",
  });
  assert.ok(Math.abs(equity - 4979.96) < 1e-6, `got ${equity}`);
});

test("negative unrealised PnL lowers equity", () => {
  assert.equal(
    rb.equityOf({ walletBalance: "5000", unrealisedPnlCross: "-300", unrealisedPnlIsolated: "-50" }),
    4650
  );
});

test("missing unrealised PnL fields count as zero", () => {
  assert.equal(rb.equityOf({ walletBalance: "5000" }), 5000);
  assert.equal(rb.equityOf({ walletBalance: "5000", unrealisedPnlCross: null, unrealisedPnlIsolated: "" }), 5000);
});

test("a missing, null, empty or zero walletBalance gives null equity", () => {
  assert.equal(rb.equityOf({ marginBalance: "5000" }), null);
  assert.equal(rb.equityOf({ walletBalance: null, unrealisedPnlCross: "100" }), null);
  assert.equal(rb.equityOf({ walletBalance: "", marginBalance: "5000" }), null);
  assert.equal(rb.equityOf({ walletBalance: "0", marginBalance: "5000" }), null);
  assert.equal(rb.equityOf({ walletBalance: "abc" }), null);
  assert.equal(rb.equityOf({}), null);
  assert.equal(rb.equityOf(null), null);
});

test("unrealisedOf sums cross + isolated and treats missing fields as zero", () => {
  assert.equal(rb.unrealisedOf({ unrealisedPnlCross: "120", unrealisedPnlIsolated: "-20" }), 100);
  assert.equal(rb.unrealisedOf({ unrealisedPnlCross: "-75" }), -75);
  assert.equal(rb.unrealisedOf({ unrealisedPnlIsolated: "30", unrealisedPnlCross: null }), 30);
  assert.equal(rb.unrealisedOf({}), 0);
  assert.equal(rb.unrealisedOf(null), null);
});

for (const [label, wallet] of [
  ["null fields", { marginBalance: null, walletBalance: null }],
  ["an empty object", {}],
  ["a wrapped reply", { data: { marginBalance: "100000" } }],
]) {
  test(`a wallet reply with ${label} sends no orders and does not halt`, async () => {
    const state = exchange({ wallet, positions: [pos("BTCUSDT", 2), pos("ETHUSDT", -3)] });
    const db = account();
    const result = await rb.rebalanceAccount(ID);
    assert.match(result.error, /readable futures wallet balance/);
    assert.equal(state.orders.length, 0);
    assert.equal(db.row.halted, false);
    assert.equal(db.row.last_rebalance_day, null, "retried on the next tick");
  });
}

test("a real 75% drawdown still closes the book and halts", async () => {
  const state = exchange({ wallet: { walletBalance: "20000", marginBalance: "20000" }, positions: [pos("BTCUSDT", 2), pos("ETHUSDT", -3)] });
  const db = account({ peak_equity: 100000 });
  const result = await rb.rebalanceAccount(ID);
  assert.equal(result.halted, true);
  assert.equal(db.row.halted, true);
  assert.equal(state.positions.length, 0);
  assert.ok(state.orders.every((o) => o.reduceOnly === true));
});

// ---- Only the book's coins are traded or closed (audit S2)

test("the daily run leaves the user's other positions alone", async () => {
  const state = exchange({ positions: [pos("PEPEUSDT", 1000), pos("XYZUSDT", -5)] });
  account();
  const result = await rb.rebalanceAccount(ID);
  assert.deepEqual(result.errors, []);
  assert.ok(state.orders.length > 0);
  assert.ok(state.orders.every((o) => rb.BOOK_SYMBOLS.has(o.symbol)), "only book coins ordered");
  assert.ok(state.leverageCalls.every((s) => rb.BOOK_SYMBOLS.has(s)), "no settings changed on other coins");
  assert.equal(state.signed("PEPEUSDT"), 1000);
  assert.equal(state.signed("XYZUSDT"), -5);
});

test("disconnect and the drawdown stop close only the book's coins, reduce-only", async () => {
  const state = exchange({ positions: [pos("BTCUSDT", 2), pos("PEPEUSDT", 1000), pos("XYZUSDT", -5)] });
  account();
  await rb.flattenAccount(ID);
  assert.deepEqual(state.orders.map((o) => [o.symbol, o.side, o.quantity, o.reduceOnly]), [["BTCUSDT", "SELL", 2, true]]);
  assert.equal(state.signed("PEPEUSDT"), 1000);
  assert.equal(state.signed("XYZUSDT"), -5);
});

test("reductions go first and reduce-only, a flip closes then opens, and reductions change no leverage", async () => {
  // Learn today's book from a flat account, then hold every coin on the wrong side.
  exchange();
  account();
  const { weights } = await rb.rebalanceAccount(ID);
  const held = Object.entries(weights).map(([coin, w]) => pos(`${coin}USDT`, w > 0 ? -1 : 1));
  const state = exchange({ positions: held });
  account();
  const result = await rb.rebalanceAccount(ID);
  assert.deepEqual(result.errors, []);

  const firstOpen = state.orders.findIndex((o) => o.reduceOnly === false);
  assert.ok(firstOpen > 0);
  assert.ok(state.orders.slice(0, firstOpen).every((o) => o.reduceOnly === true), "every reduction before any increase");
  assert.ok(state.orders.slice(firstOpen).every((o) => o.reduceOnly === false));
  assert.equal(firstOpen, held.length, "each wrong-side coin closed once");
  assert.equal(state.leverageCalls.length, Object.keys(weights).length, "leverage set only for the opening legs");
  for (const [coin, w] of Object.entries(weights)) assert.equal(Math.sign(state.signed(`${coin}USDT`)), Math.sign(w));
});

test("a coin that leaves the book is closed once, reduce-only, and ends flat", async () => {
  exchange();
  account();
  const { weights } = await rb.rebalanceAccount(ID);
  const outside = UNIVERSE.filter((coin) => !weights[coin]);
  const state = exchange({ positions: outside.slice(0, 3).map((coin, i) => pos(`${coin}USDT`, i % 2 ? -4 : 4)) });
  account();
  await rb.rebalanceAccount(ID);
  for (const coin of outside.slice(0, 3)) {
    const sent = state.orders.filter((o) => o.symbol === `${coin}USDT`);
    assert.equal(sent.length, 1, coin);
    assert.equal(sent[0].reduceOnly, true);
    assert.equal(state.signed(`${coin}USDT`), 0);
  }
});

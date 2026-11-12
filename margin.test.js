// Shark's real refusal while a coin has an open position must not block the order (2026-11-12 incident).
const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("https");
const { EventEmitter } = require("events");
const store = require("./store");
const { UNIVERSE } = require("./book");
const rb = require("./rebalance");

const ID = "4d39ae0d-1111-2222-3333-444455556666";
const DAY = 86_400_000;
const LOCKED = "Margin mode can't be updated with an open position";

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

function exchange({ positions = [], leverageAlsoLocked = false, otherError = null } = {}) {
  const state = { positions: positions.map((p) => ({ ...p })), orders: [], calls: [] };
  const held = (symbol) => state.positions.some((p) => p.contractPair === symbol && Number(p.quantity) > 0);
  function reply(path, body) {
    const p = path.split("?")[0];
    const params = body ? JSON.parse(body) : {};
    if (p === "/v1/wallet/futures-wallet/details") return [200, { marginBalance: "100000" }];
    if (p === "/v1/exchange/exchangeInfo") {
      return [200, {
        contracts: UNIVERSE.map((c) => ({ name: `${c}USDT`, quantityPrecision: 3, maxLeverage: 20,
          filters: [{ filterType: "MARKET_QTY_SIZE", minQty: "0.001" }, { filterType: "MIN_NOTIONAL", notional: "1" }] })),
        conversionRates: { INR_MARGIN_USDT: 100 },
      }];
    }
    if (p === "/v1/market/klines") return [200, klines(UNIVERSE.indexOf(params.pair.replace(/USDT$/, "")))];
    if (p === "/v1/positions/OPEN") return [200, state.positions];
    if (p === "/v1/exchange/update/preference") {
      state.calls.push(["preference", params.contractName]);
      if (otherError) return [400, { message: otherError }];
      return held(params.contractName) ? [400, { message: LOCKED }] : [200, {}];
    }
    if (p === "/v1/exchange/update/leverage") {
      state.calls.push(["leverage", params.contractName]);
      return leverageAlsoLocked && held(params.contractName) ? [400, { message: "Leverage cannot be updated with open position" }] : [200, {}];
    }
    if (p === "/v1/order/place-order") {
      state.orders.push(params);
      return [200, { orderId: state.orders.length }];
    }
    return [404, { message: `not mocked ${p}` }];
  }
  https.request = (options, callback) => {
    const req = new EventEmitter();
    let body = "";
    req.write = (chunk) => { body += chunk; };
    req.end = () => setImmediate(() => {
      const [status, data] = reply(options.path, body);
      const res = new EventEmitter();
      res.statusCode = status;
      callback(res);
      res.emit("data", JSON.stringify(data));
      res.emit("end");
    });
    return req;
  };
  return state;
}

function account() {
  const row = { id: ID, book: "moon", owner_id: "did:privy:x", api_key: "FAKEKEYFAKEKEYFAKE", peak_equity: 100000, last_rebalance_day: null, halted: false };
  store.getAccount = async () => ({ ...row });
  store.secretOf = async () => "FAKESECRETFAKESECRET";
  store.recordActivity = async () => {};
  store.markRun = async (id, m) => Object.assign(row, { last_rebalance_day: m.lastRebalanceDay, last_error: m.lastError });
  return row;
}

test("both of Shark's wordings count as locked, other errors do not", () => {
  for (const text of [LOCKED, "Leverage cannot be updated with open position", "margin mode can not be updated with an open position"]) {
    assert.equal(rb.leverageLocked(text), true, text);
  }
  for (const text of ["Insufficient margin", "API key does not have trade permissions", "Cross margin is not enabled", null]) {
    assert.equal(rb.leverageLocked(text), false, String(text));
  }
});

test("a held coin whose margin mode is locked still gets its leverage set and its order placed", async () => {
  // Learn today's book, then hold every book coin a little under target so each needs an increase.
  exchange();
  account();
  const { weights } = await rb.rebalanceAccount(ID);
  const held = Object.entries(weights).map(([coin, w]) => ({ contractPair: `${coin}USDT`, quantity: "0.5", positionType: w > 0 ? "LONG" : "SHORT" }));
  const state = exchange({ positions: held });
  const row = account();
  const result = await rb.rebalanceAccount(ID);
  assert.deepEqual(result.errors, [], "no order is blocked by the locked margin mode");
  assert.equal(row.last_rebalance_day, rb.utcDay(), "the day completes instead of retrying every 15 minutes");
  // Reductions are reduce-only and change no leverage; every increase on a held coin must go out,
  // with its leverage set on its own because the margin mode is locked.
  const increased = [...new Set(state.orders.filter((o) => o.reduceOnly === false).map((o) => o.symbol))];
  assert.ok(increased.length > 0, "the test holds coins that need an increase");
  for (const symbol of increased) {
    assert.ok(held.some((p) => p.contractPair === symbol), `${symbol} is a held coin`);
    assert.ok(state.calls.some(([kind, s]) => kind === "leverage" && s === symbol), `leverage set alone for ${symbol}`);
  }
  for (const position of held) {
    assert.ok(state.orders.some((o) => o.symbol === position.contractPair), `order placed for ${position.contractPair}`);
  }
});

test("when leverage is locked too, the order still goes out at the current setting", async () => {
  exchange();
  account();
  const { weights } = await rb.rebalanceAccount(ID);
  const held = Object.entries(weights).map(([coin, w]) => ({ contractPair: `${coin}USDT`, quantity: "0.5", positionType: w > 0 ? "LONG" : "SHORT" }));
  const state = exchange({ positions: held, leverageAlsoLocked: true });
  account();
  const result = await rb.rebalanceAccount(ID);
  assert.deepEqual(result.errors, []);
  assert.equal(new Set(state.orders.map((o) => o.symbol)).size, held.length);
});

test("any other refusal still blocks the increase and is reported", async () => {
  exchange();
  account();
  const { weights } = await rb.rebalanceAccount(ID);
  const held = Object.entries(weights).map(([coin, w]) => ({ contractPair: `${coin}USDT`, quantity: "0.5", positionType: w > 0 ? "LONG" : "SHORT" }));
  const state = exchange({ positions: held, otherError: "API key does not have trade permissions" });
  const row = account();
  const result = await rb.rebalanceAccount(ID);
  assert.equal(state.orders.filter((o) => o.reduceOnly === false).length, 0, "no increase goes out");
  assert.ok(state.orders.every((o) => o.reduceOnly === true), "only reduce-only reductions, which need no leverage change");
  assert.ok(result.errors.length > 0);
  assert.notEqual(row.last_rebalance_day, rb.utcDay());
});

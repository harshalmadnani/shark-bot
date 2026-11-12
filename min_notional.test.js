// Reductions worth less than Shark's minimum order value must be skipped, not sent (2026-11-12 incident:
// "Order quantity is out of range" on $1 to $18 trims kept accounts retrying every 15 minutes).
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
const EQUITY = 100_000; // INR: the 0.5% rebalance band is then about $5, below the $23 minimum, as on small real accounts
const MIN_NOTIONAL = 23; // USDT, Shark's value for BCH, LINK and ETH

function bars(index) {
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
const lastClose = (coin) => Number(bars(UNIVERSE.indexOf(coin)).at(-1).close);

function exchange(positions = []) {
  const state = { positions: positions.map((p) => ({ ...p })), sent: [], rejected: [] };
  function reply(path, body) {
    const p = path.split("?")[0];
    const params = body ? JSON.parse(body) : {};
    if (p === "/v1/wallet/futures-wallet/details") return [200, { marginBalance: String(EQUITY) }];
    if (p === "/v1/exchange/exchangeInfo") {
      return [200, {
        contracts: UNIVERSE.map((c) => ({ name: `${c}USDT`, quantityPrecision: 3, maxLeverage: 20,
          filters: [{ filterType: "MARKET_QTY_SIZE", minQty: "0.001" }, { filterType: "MIN_NOTIONAL", notional: String(MIN_NOTIONAL) }] })),
        conversionRates: { INR_MARGIN_USDT: RATE },
      }];
    }
    if (p === "/v1/market/klines") return [200, bars(UNIVERSE.indexOf(params.pair.replace(/USDT$/, "")))];
    if (p === "/v1/positions/OPEN") return [200, state.positions];
    if (p === "/v1/exchange/update/preference" || p === "/v1/exchange/update/leverage") return [200, {}];
    if (p === "/v1/order/place-order") {
      const notional = params.quantity * lastClose(params.symbol.replace(/USDT$/, ""));
      if (notional < MIN_NOTIONAL) {
        state.rejected.push(params);
        return [400, { message: "Order quantity is out of range" }];
      }
      state.sent.push(params);
      return [200, { orderId: state.sent.length }];
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
  const row = { id: ID, book: "moon", owner_id: "did:privy:x", api_key: "FAKEKEYFAKEKEYFAKE", peak_equity: EQUITY, last_rebalance_day: null, halted: false };
  store.getAccount = async () => ({ ...row });
  store.claimRun = async () => ({ ...row });
  store.releaseRun = async () => {};
  store.secretOf = async () => "FAKESECRETFAKESECRET";
  store.recordActivity = async () => {};
  store.markRun = async (id, m) => Object.assign(row, { last_rebalance_day: m.lastRebalanceDay, last_error: m.lastError });
  return row;
}

test("a trim worth less than the minimum is skipped, a large one is still sent reduce-only, and the day completes", async () => {
  exchange();
  account();
  const { weights } = await rb.rebalanceAccount(ID);
  const coins = Object.keys(weights);
  const target = (coin) => (weights[coin] * EQUITY) / (lastClose(coin) * RATE);
  // Every book coin held a little over target (a small trim), except the first, held at twice its target.
  const big = coins[0];
  const held = coins.map((coin) => {
    const t = target(coin);
    const extra = coin === big ? Math.abs(t) : (12 / lastClose(coin)) * Math.sign(t); // about $12 over: above the band, below the minimum
    const qty = t + extra;
    return { contractPair: `${coin}USDT`, quantity: String(Math.abs(qty).toFixed(3)), positionType: qty > 0 ? "LONG" : "SHORT" };
  });
  const state = exchange(held);
  const row = account();
  const result = await rb.rebalanceAccount(ID);
  assert.deepEqual(state.rejected, [], "no order below the minimum reaches Shark");
  assert.deepEqual(result.errors, []);
  assert.equal(row.last_rebalance_day, rb.utcDay(), "the day completes instead of retrying every 15 minutes");
  const bigOrder = state.sent.find((o) => o.symbol === `${big}USDT`);
  assert.ok(bigOrder && bigOrder.reduceOnly === true, "the large trim still goes out, reduce-only");
});

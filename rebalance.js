const { UNIVERSE, RULES, targetWeights, grossOf, leverageForGross, shouldHalt, roundQty } = require("./book");
const { SharkClient, sharkError, requestJson } = require("./shark");
const store = require("./store");

const running = new Set();

function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

async function exchangeInfo() {
  const response = await requestJson("GET", "/v1/exchange/exchangeInfo?market=USDT", {
    Accept: "application/json",
  });
  if (response.status >= 400) throw new Error(sharkError(response) || "Could not load markets");
  const contracts = new Map();
  for (const contract of response.body.contracts || []) {
    const filters = Object.fromEntries((contract.filters || []).map((filter) => [filter.filterType, filter]));
    contracts.set(contract.name, {
      name: contract.name,
      quantityPrecision: Number(contract.quantityPrecision) || 0,
      maxLeverage: Number(contract.maxLeverage) || 1,
      minQty: Number((filters.MARKET_QTY_SIZE || {}).minQty) || 0,
      minNotional: Number((filters.MIN_NOTIONAL || {}).notional) || 0,
    });
  }
  const rate = Number(response.body.conversionRates && response.body.conversionRates.INR_MARGIN_USDT) || 102;
  return { contracts, rate };
}

async function dailyHistory(coin) {
  const body = JSON.stringify({ pair: `${coin}USDT`, interval: "1d", limit: 400 });
  const response = await requestJson(
    "POST",
    "/v1/market/klines?priceType=LAST_PRICE",
    {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    body
  );
  if (response.status >= 400 || !Array.isArray(response.body)) {
    throw new Error(sharkError(response) || `No daily candles for ${coin}`);
  }
  const now = Date.now();
  const bars = [];
  for (const candle of response.body) {
    if (Number(candle.endTime) > now) continue;
    const open = Number(candle.open);
    const close = Number(candle.close);
    if (!(open > 0) || !(close > 0)) continue;
    bars.push({
      date: new Date(Number(candle.startTime)).toISOString().slice(0, 10),
      open,
      close,
    });
  }
  return { coin, bars };
}

function equityOf(wallet) {
  const margin = Number(wallet && wallet.marginBalance);
  if (Number.isFinite(margin)) return margin;
  const balance = Number(wallet && wallet.walletBalance) || 0;
  const pnl = Number(wallet && wallet.unrealisedPnlCross) || 0;
  const isolated = Number(wallet && wallet.unrealisedPnlIsolated) || 0;
  return balance + pnl + isolated;
}

function signedQty(position) {
  const qty = Math.abs(Number(position.quantity ?? position.positionAmount ?? 0));
  if (position.positionType === "SHORT") return -qty;
  if (position.positionType === "LONG") return qty;
  return Number(position.quantity ?? position.positionAmount ?? 0);
}

async function openPositions(client) {
  const response = await client.get("/v1/positions/OPEN", { sortOrder: "desc", pageSize: "100" });
  if (response.status >= 400) throw new Error(sharkError(response) || "Could not load positions");
  if (!Array.isArray(response.body)) throw new Error("Unexpected positions response");
  const rows = response.body;
  const qty = new Map();
  for (const position of rows) {
    const symbol = position.contractPair || position.symbol;
    if (!symbol) continue;
    qty.set(symbol, (qty.get(symbol) || 0) + signedQty(position));
  }
  return qty;
}

async function place(client, symbol, delta, precision) {
  const quantity = roundQty(Math.abs(delta), precision);
  if (!(quantity > 0)) return null;
  const response = await client.post("/v1/order/place-order", {
    placeType: "ORDER_FORM",
    quantity,
    side: delta > 0 ? "BUY" : "SELL",
    symbol,
    reduceOnly: false,
    marginAsset: "INR",
    type: "MARKET",
  });
  const error = sharkError(response);
  if (error) throw new Error(`${symbol}: ${error}`);
  return response.body;
}

async function flatten(client, info) {
  const positions = await openPositions(client);
  const orders = [];
  for (const [symbol, qty] of positions) {
    if (qty === 0) continue;
    const contract = info.contracts.get(symbol);
    const precision = contract ? contract.quantityPrecision : 0;
    const minQty = contract ? contract.minQty : 0;
    const quantity = roundQty(Math.abs(qty), precision);
    if (quantity < minQty) continue;
    orders.push(await place(client, symbol, -qty, precision));
    await sleep(150);
  }
  return orders.filter(Boolean);
}

async function rebalanceAccount(id) {
  if (running.has(id)) return { skipped: true };
  running.add(id);
  const today = utcDay();
  try {
    const row = await store.getAccount(id);
    if (!row) return { missing: true };
    const client = new SharkClient(row.api_key, await store.secretOf(row));
    const wallet = await client.get("/v1/wallet/futures-wallet/details", { marginAsset: "INR" });
    const walletError = sharkError(wallet);
    if (walletError) throw new Error(walletError);
    const equity = equityOf(wallet.body);
    const peak = row.peak_equity == null ? equity : Math.max(row.peak_equity, equity);
    const info = await exchangeInfo();

    if (row.halted) {
      return { halted: true };
    }

    if (shouldHalt(equity, peak)) {
      await flatten(client, info);
      await store.markRun(id, {
        peakEquity: peak,
        lastRebalanceDay: today,
        halted: true,
        lastError: null,
      });
      return { halted: true, equity };
    }

    const histories = await mapPool(UNIVERSE, 4, dailyHistory);
    const book = targetWeights(histories);
    const prices = new Map(histories.map((coin) => {
      const last = coin.bars[coin.bars.length - 1];
      return [coin.coin, last ? last.close : null];
    }));
    const positions = await openPositions(client);
    const leverage = leverageForGross(grossOf(book.weights), 100);
    const errors = [];
    let marginMode = "CROSS";
    const symbols = new Set([...positions.keys()]);
    for (const coin of UNIVERSE) symbols.add(`${coin}USDT`);

    for (const symbol of symbols) {
      const coin = symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol;
      const contract = info.contracts.get(symbol);
      const price = prices.get(coin);
      const current = positions.get(symbol) || 0;
      const weight = book.weights[coin] || 0;
      let target = 0;
      if (weight !== 0 && price > 0 && equity > 0) {
        target = (weight * equity) / (price * info.rate);
      }
      const precision = contract ? contract.quantityPrecision : 0;
      const minQty = contract ? contract.minQty : 0;
      const delta = roundQty(target, precision) - roundQty(current, precision);
      const quantity = roundQty(Math.abs(delta), precision);
      if (!(quantity > 0)) continue;
      const closing = roundQty(target, precision) === 0;
      if (!closing && quantity < minQty) continue;
      const notionalUsdt = quantity * (price || 0);
      const notionalInr = notionalUsdt * info.rate;
      if (!closing && notionalInr <= equity * RULES.rebalanceBand) continue;
      if (!closing && contract && notionalUsdt < contract.minNotional) continue;
      if (closing && quantity < minQty) continue;

      const maxLeverage = contract ? contract.maxLeverage : leverage;
      const symbolLeverage = leverageForGross(grossOf(book.weights), maxLeverage);
      try {
        let preference = await client.post("/v1/exchange/update/preference", {
          leverage: symbolLeverage,
          marginMode,
          contractName: symbol,
        });
        let preferenceError = sharkError(preference);
        if (preferenceError && marginMode === "CROSS" && /cross margin is not enabled/i.test(preferenceError)) {
          marginMode = "ISOLATED";
          preference = await client.post("/v1/exchange/update/preference", {
            leverage: symbolLeverage,
            marginMode,
            contractName: symbol,
          });
          preferenceError = sharkError(preference);
        }
        if (preferenceError && !closing) {
          errors.push(`${symbol} leverage: ${preferenceError}`);
          await sleep(150);
          continue;
        }
        if (preferenceError) errors.push(`${symbol} leverage: ${preferenceError}`);
        await place(client, symbol, delta, precision);
      } catch (error) {
        errors.push(error.message);
      }
      await sleep(150);
    }

    await store.markRun(id, {
      peakEquity: peak,
      lastRebalanceDay: errors.length ? row.last_rebalance_day : today,
      halted: false,
      lastError: errors.length ? errors.join("; ") : null,
    });
    return { date: book.date, weights: book.weights, equity, errors };
  } catch (error) {
    await store.markRun(id, {
      peakEquity: (await store.getAccount(id))?.peak_equity ?? null,
      lastRebalanceDay: (await store.getAccount(id))?.last_rebalance_day ?? null,
      halted: false,
      lastError: error.message,
    }).catch(() => {});
    return { error: error.message };
  } finally {
    running.delete(id);
  }
}

async function flattenAccount(id) {
  const row = await store.getAccount(id);
  if (!row) return { missing: true };
  const client = new SharkClient(row.api_key, await store.secretOf(row));
  const info = await exchangeInfo();
  await flatten(client, info);
  return { flattened: true };
}

async function runDue() {
  const today = utcDay();
  const accounts = await store.listTradable();
  for (const account of accounts) {
    if (account.last_rebalance_day === today) continue;
    await rebalanceAccount(account.id);
  }
}

function isRunning(id) {
  return running.has(id);
}

module.exports = { rebalanceAccount, flattenAccount, runDue, isRunning, utcDay };

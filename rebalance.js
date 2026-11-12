const { UNIVERSE, RULES, targetWeights, grossOf, leverageForGross, shouldHalt, roundQty } = require("./book");
const { SharkClient, sharkError, requestJson } = require("./shark");
const store = require("./store");

const running = new Set();

/** The only contracts the bot trades or closes. Anything else on the account is the user's own. */
const BOOK_SYMBOLS = new Set(UNIVERSE.map((coin) => `${coin}USDT`));

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

/** A number only when the field really holds one: null, "", missing or non-numeric give NaN, never 0. */
function reported(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return NaN;
  return Number(value);
}

/**
 * Futures equity in INR, or null when the wallet reply does not carry a usable balance.
 * A missing, null or empty field must never read as zero: zero equity looks like a 100% loss
 * and would trip the drawdown stop, closing the whole book.
 */
function equityOf(wallet) {
  if (!wallet || typeof wallet !== "object") return null;
  const margin = reported(wallet.marginBalance);
  if (Number.isFinite(margin) && margin > 0) return margin;
  const balance = reported(wallet.walletBalance);
  if (!Number.isFinite(balance) || balance <= 0) return null;
  const pnl = Number.isFinite(reported(wallet.unrealisedPnlCross)) ? reported(wallet.unrealisedPnlCross) : 0;
  const isolated = Number.isFinite(reported(wallet.unrealisedPnlIsolated)) ? reported(wallet.unrealisedPnlIsolated) : 0;
  const equity = balance + pnl + isolated;
  return Number.isFinite(equity) && equity > 0 ? equity : null;
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

async function setLeverage(client, symbol, leverage, state) {
  if (state.mode !== "LEVERAGE_ONLY") {
    const preference = await client.post("/v1/exchange/update/preference", {
      leverage,
      marginMode: state.mode,
      contractName: symbol,
    });
    const preferenceError = sharkError(preference);
    if (!preferenceError) return null;
    if (/cross margin is not enabled/i.test(preferenceError)) {
      state.mode = "LEVERAGE_ONLY";
    } else if (!leverageLocked(preferenceError)) {
      return preferenceError;
    }
    // Shark will not change the margin mode while this coin has an open position. Set the leverage
    // alone for this coin; the account keeps its margin mode for the others.
  }
  const updated = await client.post("/v1/exchange/update/leverage", {
    leverage,
    contractName: symbol,
  });
  return sharkError(updated);
}

/**
 * Shark refuses some setting changes while the coin has an open position. Its message has been both
 * "cannot be updated with open position" and "Margin mode can't be updated with an open position"; the
 * second did not match before, so every order on a held coin was skipped and the day was retried every
 * 15 minutes (14,890 failures across 40 accounts on 2026-11-12).
 */
function leverageLocked(error) {
  return typeof error === "string" && /(cannot|can't|can not) be updated with (an )?open position/i.test(error);
}

function track(row, fields) {
  return store.recordActivity({
    book: row?.book || null,
    accountId: row?.id || null,
    ownerId: row?.owner_id || null,
    equity: fields.equity,
    ...fields,
  });
}

async function place(client, symbol, delta, precision, reduceOnly = false) {
  if (!BOOK_SYMBOLS.has(symbol)) throw new Error(`${symbol}: not a book coin, refusing to trade it`);
  const quantity = roundQty(Math.abs(delta), precision);
  if (!(quantity > 0)) return null;
  const response = await client.post("/v1/order/place-order", {
    placeType: "ORDER_FORM",
    quantity,
    side: delta > 0 ? "BUY" : "SELL",
    symbol,
    reduceOnly,
    marginAsset: "INR",
    type: "MARKET",
  });
  const error = sharkError(response);
  if (error) throw new Error(`${symbol}: ${error}`);
  return response.body;
}

/**
 * Closes the book's own coins, reduce-only. Positions in any other contract belong to the user
 * and are left alone. Every coin is attempted; failures are collected and thrown together.
 */
async function flatten(client, info, row) {
  const positions = await openPositions(client);
  const orders = [];
  const failures = [];
  for (const [symbol, qty] of positions) {
    if (qty === 0 || !BOOK_SYMBOLS.has(symbol)) continue;
    const contract = info.contracts.get(symbol);
    const precision = contract ? contract.quantityPrecision : 0;
    const minQty = contract ? contract.minQty : 0;
    const quantity = roundQty(Math.abs(qty), precision);
    if (!(quantity > 0) || quantity < minQty) continue;
    const side = qty > 0 ? "SELL" : "BUY";
    try {
      orders.push(await place(client, symbol, -qty, precision, true));
      await track(row, { kind: "order", symbol, side, quantity, ok: true, detail: "flatten" });
    } catch (error) {
      failures.push(error.message);
      await track(row, { kind: "order", symbol, side, quantity, ok: false, detail: error.message });
    }
    await sleep(150);
  }
  if (failures.length) throw new Error(`Some positions did not close: ${failures.join("; ")}`);
  return orders.filter(Boolean);
}

async function rebalanceAccount(id) {
  if (running.has(id)) {
    await store.recordActivity({ accountId: id, kind: "skip", ok: false, detail: "already running" });
    return { skipped: true };
  }
  running.add(id);
  const today = utcDay();
  try {
    const row = await store.getAccount(id);
    if (!row) return { missing: true };
    await track(row, { kind: "rebalance", ok: true, detail: "started" });
    const client = new SharkClient(row.api_key, await store.secretOf(row));
    const wallet = await client.get("/v1/wallet/futures-wallet/details", { marginAsset: "INR" });
    const walletError = sharkError(wallet);
    if (walletError) throw new Error(walletError);
    const equity = equityOf(wallet.body);
    if (equity == null) throw new Error("Shark did not report a readable futures wallet balance");
    const peak = row.peak_equity == null ? equity : Math.max(row.peak_equity, equity);
    const info = await exchangeInfo();

    if (row.halted) {
      await track(row, { kind: "halt", equity, ok: false, detail: "already halted" });
      return { halted: true };
    }

    if (shouldHalt(equity, peak)) {
      await flatten(client, info, row);
      await store.markRun(id, {
        peakEquity: peak,
        lastRebalanceDay: today,
        halted: true,
        lastError: null,
      });
      await track(row, { kind: "halt", equity, ok: true, detail: "75% drawdown" });
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
    const marginState = { mode: "CROSS" };

    // Plan every book coin first, as reduce-only reductions and opening increases, so that all
    // reductions go out before any increase. Coins outside the book are never looked at.
    const reductions = [];
    const increases = [];
    for (const symbol of BOOK_SYMBOLS) {
      const coin = symbol.slice(0, -4);
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
      const roundedTarget = roundQty(target, precision);
      const roundedCurrent = roundQty(current, precision);
      const delta = roundedTarget - roundedCurrent;
      const quantity = roundQty(Math.abs(delta), precision);
      if (!(quantity > 0)) continue;
      const side = delta > 0 ? "BUY" : "SELL";
      const closing = roundedTarget === 0;
      const notionalUsdt = quantity * (price || 0);
      const notionalInr = notionalUsdt * info.rate;
      const base = { symbol, contract, price, precision, minQty, equity };
      if (!closing && notionalInr <= equity * RULES.rebalanceBand) {
        await track(row, { kind: "skip", symbol, side, quantity, price, notionalUsd: notionalUsdt, equity, ok: false, detail: "inside rebalance band" });
        continue;
      }

      const flips = roundedCurrent !== 0 && !closing && Math.sign(roundedCurrent) !== Math.sign(roundedTarget);
      const shrinking = roundedCurrent !== 0 && !closing && !flips && Math.abs(roundedTarget) < Math.abs(roundedCurrent);
      if (roundedCurrent !== 0 && (closing || flips || shrinking)) {
        // Close (all of it for a close or a flip, the difference when shrinking), reduce-only.
        const reduceDelta = closing || flips ? -roundedCurrent : delta;
        reductions.push({ ...base, delta: reduceDelta, closing: closing || flips });
      }
      const opening = closing || shrinking ? 0 : flips ? roundedTarget : delta;
      if (opening !== 0) increases.push({ ...base, delta: opening });
    }

    for (const leg of reductions) {
      const { symbol, delta, precision, minQty, price } = leg;
      const quantity = roundQty(Math.abs(delta), precision);
      const side = delta > 0 ? "BUY" : "SELL";
      const notionalUsdt = quantity * (price || 0);
      const orderFields = { kind: "order", symbol, side, quantity, price, notionalUsd: notionalUsdt, equity };
      if (quantity < minQty) {
        await track(row, { kind: "skip", symbol, side, quantity, price, notionalUsd: notionalUsdt, equity, ok: false, detail: "close below min quantity" });
        continue;
      }
      try {
        // A reduction needs no leverage change, so the user's leverage settings are not touched for it.
        await place(client, symbol, delta, precision, true);
        await track(row, { ...orderFields, ok: true, detail: "reduce-only" });
      } catch (error) {
        errors.push(error.message);
        await track(row, { ...orderFields, ok: false, detail: error.message });
      }
      await sleep(150);
    }

    for (const leg of increases) {
      const { symbol, delta, precision, minQty, price, contract } = leg;
      const quantity = roundQty(Math.abs(delta), precision);
      const side = delta > 0 ? "BUY" : "SELL";
      const notionalUsdt = quantity * (price || 0);
      const orderFields = { kind: "order", symbol, side, quantity, price, notionalUsd: notionalUsdt, equity };
      if (quantity < minQty) {
        await track(row, { kind: "skip", symbol, side, quantity, price, notionalUsd: notionalUsdt, equity, ok: false, detail: "below min quantity" });
        continue;
      }
      if (contract && notionalUsdt < contract.minNotional) {
        await track(row, { kind: "skip", symbol, side, quantity, price, notionalUsd: notionalUsdt, equity, ok: false, detail: "below min notional" });
        continue;
      }
      const maxLeverage = contract ? contract.maxLeverage : leverage;
      const symbolLeverage = leverageForGross(grossOf(book.weights), maxLeverage);
      try {
        const preferenceError = await setLeverage(client, symbol, symbolLeverage, marginState);
        const locked = leverageLocked(preferenceError);
        if (preferenceError && !locked) {
          errors.push(`${symbol} leverage (${marginState.mode}): ${preferenceError}`);
          await track(row, { ...orderFields, ok: false, detail: preferenceError });
          await sleep(150);
          continue;
        }
        await place(client, symbol, delta, precision, false);
        await track(row, { ...orderFields, ok: true, detail: null });
      } catch (error) {
        errors.push(error.message);
        await track(row, { ...orderFields, ok: false, detail: error.message });
      }
      await sleep(150);
    }

    await store.markRun(id, {
      peakEquity: peak,
      lastRebalanceDay: errors.length ? row.last_rebalance_day : today,
      halted: false,
      lastError: errors.length ? errors.join("; ") : null,
    });
    console.log(`rebalance ${id} mode=${marginState.mode} errors=${errors.length}`);
    await track(row, {
      kind: "rebalance",
      equity,
      ok: errors.length === 0,
      detail: `finished mode=${marginState.mode} errors=${errors.length}`,
    });
    return { date: book.date, weights: book.weights, equity, errors };
  } catch (error) {
    const saved = await store.getAccount(id).catch(() => null);
    await store.markRun(id, {
      peakEquity: saved?.peak_equity ?? null,
      lastRebalanceDay: saved?.last_rebalance_day ?? null,
      halted: false,
      lastError: error.message,
    }).catch(() => {});
    await track(saved || { id, book: null, owner_id: null }, { kind: "error", ok: false, detail: error.message });
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
  await flatten(client, info, row);
  return { flattened: true };
}

async function runDue() {
  const today = utcDay();
  const accounts = await store.listTradable();
  const due = accounts.filter((account) => account.last_rebalance_day !== today);
  console.log(`rebalance due ${due.length}`);
  for (const account of due) await rebalanceAccount(account.id);
}

function isRunning(id) {
  return running.has(id);
}

module.exports = { rebalanceAccount, flattenAccount, runDue, isRunning, utcDay, equityOf, BOOK_SYMBOLS, setLeverage, leverageLocked };

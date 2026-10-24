const { SharkClient, sharkError, requestJson } = require("./shark");
const store = require("./store");

function asList(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  for (const key of ["data", "rows", "orders", "trades", "list"]) {
    if (Array.isArray(body[key])) return body[key];
  }
  return [];
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

let rateCache = { at: 0, rate: null };

async function inrPerUsdt() {
  if (rateCache.rate && Date.now() - rateCache.at < 60_000) return rateCache.rate;
  const response = await requestJson("GET", "/v1/exchange/exchangeInfo?market=USDT", {
    Accept: "application/json",
  });
  const rate = num(response.body && response.body.conversionRates && response.body.conversionRates.INR_MARGIN_USDT);
  if (rate) rateCache = { at: Date.now(), rate };
  return rateCache.rate || 102;
}

async function lastPrice(symbol) {
  const response = await requestJson("GET", `/v1/market/ticker24Hr/${encodeURIComponent(symbol)}`, {
    Accept: "application/json",
  });
  if (!response || response.status >= 400) return null;
  const data = response.body && response.body.data ? response.body.data : response.body;
  return num(data && (data.c ?? data.lastPrice));
}

async function quotes(symbols) {
  const unique = [...new Set(symbols.map((symbol) => String(symbol || "").toUpperCase()))]
    .filter((symbol) => /^[A-Z0-9]{2,20}$/.test(symbol))
    .slice(0, 20);
  const [rate, priced] = await Promise.all([
    inrPerUsdt(),
    Promise.all(unique.map(async (symbol) => [symbol, await lastPrice(symbol)])),
  ]);
  return {
    rate,
    prices: Object.fromEntries(priced.filter(([, price]) => price != null)),
  };
}

async function readList(client, path) {
  const response = await client.get(path, { sortOrder: "desc", pageSize: "50" });
  const error = sharkError(response);
  if (error) return { error, rows: [] };
  return { error: null, rows: asList(response.body).slice(0, 50) };
}

function mapPosition(position) {
  const side = position.positionType === "SHORT" ? "short" : "long";
  return {
    symbol: text(position.contractPair || position.symbol),
    side,
    quantity: num(position.quantity ?? position.positionAmount),
    entryPrice: num(position.entryPrice),
    liquidationPrice: num(position.liquidationPrice),
    leverage: num(position.leverage),
    marginInr: num(position.marginInMarginAsset ?? position.margin),
    positionSize: num(position.positionSize),
    updatedAt: text(position.updatedTime || position.updatedAt),
  };
}

function mapTrade(trade) {
  return {
    id: text(trade.id),
    time: text(trade.time || trade.updatedAt),
    symbol: text(trade.symbol),
    side: text(trade.side),
    price: num(trade.price),
    quantity: num(trade.quantity),
    fee: num(trade.fee),
    realizedProfit: num(trade.realizedProfit),
  };
}

function mapOrder(order) {
  return {
    id: text(order.clientOrderId || order.id),
    time: text(order.updatedAt || order.time),
    symbol: text(order.symbol),
    side: text(order.side),
    type: text(order.type),
    status: text(order.status),
    price: num(order.avgPrice ?? order.price),
    quantity: num(order.executedQty ?? order.cumQty ?? order.quantity),
  };
}

async function loadPortfolio(row) {
  const client = new SharkClient(row.api_key, await store.secretOf(row));
  const [wallet, positions, trades, orders] = await Promise.all([
    client.get("/v1/wallet/futures-wallet/details", { marginAsset: "INR" }),
    client.get("/v1/positions/OPEN", { sortOrder: "desc", pageSize: "100" }),
    readList(client, "/v1/user-data/trade-history"),
    readList(client, "/v1/order/order-history"),
  ]);

  const walletError = sharkError(wallet);
  const body = walletError ? null : wallet.body || {};
  const isolatedPnl = num(body && body.unrealisedPnlIsolated) || 0;
  const crossPnl = num(body && body.unrealisedPnlCross) || 0;
  const marginBalance = num(body && body.marginBalance);
  const walletBalance = num(body && body.walletBalance);

  const positionError = sharkError(positions);
  const positionRows = positionError ? [] : asList(positions.body);
  const mapped = positionRows.map(mapPosition).filter((position) => position.symbol);
  const market = await quotes(mapped.map((position) => position.symbol)).catch(() => ({ rate: null, prices: {} }));
  for (const position of mapped) position.markPrice = market.prices[position.symbol] ?? null;

  return {
    connected: true,
    ...store.publicAccount(row),
    valueInr: walletBalance,
    walletBalance,
    marginBalance,
    inrPerUsdt: market.rate,
    unrealizedPnlInr: walletError ? null : isolatedPnl + crossPnl,
    lockedInr: num(body && body.lockedBalance),
    asset: "INR",
    walletError,
    positions: mapped,
    positionsError: positionError,
    trades: trades.rows.map(mapTrade).filter((trade) => trade.symbol),
    tradesError: trades.error,
    orders: orders.rows.map(mapOrder).filter((order) => order.symbol),
    ordersError: orders.error,
  };
}

module.exports = { loadPortfolio, quotes };

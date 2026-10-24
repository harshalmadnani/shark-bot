const crypto = require("crypto");
const http = require("http");
const store = require("./store");
const { SharkClient, sharkError } = require("./shark");
const { rebalanceAccount, flattenAccount, runDue, isRunning } = require("./rebalance");
const { loadPortfolio } = require("./portfolio");

const port = Number(process.env.PORT) || 3000;
const hits = new Map();

function authorized(req) {
  const expected = process.env.BOT_TOKEN || "";
  const header = req.headers.authorization || "";
  if (!expected || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length) return false;
  return crypto.timingSafeEqual(given, wanted);
}

function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((time) => now - time < 60 * 60 * 1000);
  if (recent.length >= 10) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function clientIp(req) {
  const fromApp = req.headers["x-client-ip"];
  if (typeof fromApp === "string" && fromApp.length && fromApp.length < 80) return fromApp.trim();
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

async function livePositions(row) {
  const client = new SharkClient(row.api_key, await store.secretOf(row));
  const response = await client.get("/v1/positions/OPEN", { sortOrder: "desc", pageSize: "100" });
  const error = sharkError(response);
  if (error) return { error };
  const rows = Array.isArray(response.body) ? response.body : [];
  return {
    positions: rows.map((position) => ({
      symbol: position.contractPair || position.symbol,
      side: position.positionType === "SHORT" ? "short" : "long",
      quantity: Number(position.quantity ?? position.positionAmount ?? 0),
      entryPrice: Number(position.entryPrice) || null,
    })),
  };
}

async function handle(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;

  if (path === "/health") {
    sendJson(res, 200, { ok: true, service: "shark-bot" });
    return;
  }

  if (!authorized(req)) {
    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Shark Bot</title></head>
<body><h1>Shark Bot</h1><p>The service is running.</p></body>
</html>`);
      return;
    }
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const accountMatch = path.match(/^\/accounts\/([0-9a-f-]{36})$/i);
  const portfolioMatch = path.match(/^\/accounts\/([0-9a-f-]{36})\/portfolio$/i);

  if (portfolioMatch && req.method === "GET") {
    const row = await store.getAccount(portfolioMatch[1]);
    if (!row) {
      sendJson(res, 404, { error: "Account not found" });
      return;
    }
    const portfolio = await loadPortfolio(row);
    sendJson(res, 200, portfolio);
    return;
  }

  if (req.method === "POST" && path === "/accounts") {
    if (limited(clientIp(req))) {
      sendJson(res, 429, { error: "Too many attempts. Try again later." });
      return;
    }
    const body = await readBody(req);
    const apiKey = String(body.apiKey || "").trim();
    const apiSecret = String(body.apiSecret || "").trim();
    if (!/^[A-Za-z0-9]{16,128}$/.test(apiKey) || !/^[A-Za-z0-9]{16,128}$/.test(apiSecret)) {
      sendJson(res, 400, { error: "Enter the API key and secret from Shark." });
      return;
    }
    const probe = new SharkClient(apiKey, apiSecret);
    const wallet = await probe.get("/v1/wallet/futures-wallet/details", { marginAsset: "INR" });
    const walletError = sharkError(wallet);
    if (walletError) {
      sendJson(res, 400, { error: walletError });
      return;
    }
    const accountId = await store.saveAccount(apiKey, apiSecret);
    rebalanceAccount(accountId).catch((error) => {
      console.error("rebalance", accountId, error.message);
    });
    sendJson(res, 200, { accountId, started: true });
    return;
  }

  if (accountMatch && req.method === "GET") {
    const row = await store.getAccount(accountMatch[1]);
    if (!row) {
      sendJson(res, 404, { error: "Account not found" });
      return;
    }
    const live = await livePositions(row).catch((error) => ({ error: error.message }));
    sendJson(res, 200, {
      connected: true,
      ...store.publicAccount(row),
      running: isRunning(row.id),
      positions: live.positions || [],
      positionsError: live.error || null,
    });
    return;
  }

  if (accountMatch && req.method === "DELETE") {
    const row = await store.getAccount(accountMatch[1]);
    if (!row) {
      sendJson(res, 404, { error: "Account not found" });
      return;
    }
    try {
      await flattenAccount(row.id);
    } catch (error) {
      sendJson(res, 502, { error: error.message });
      return;
    }
    await store.deleteAccount(row.id);
    sendJson(res, 200, { disconnected: true });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error("request", error.message);
    if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong" });
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Shark Bot listening on 0.0.0.0:${port}`);
  store.migrate()
    .then(() => {
      console.log("database ready");
      const run = () => runDue().catch((error) => console.error("rebalance", error.message));
      setTimeout(run, 5000);
      setInterval(run, 15 * 60 * 1000);
    })
    .catch((error) => console.error("database", error.message));
});

const crypto = require("crypto");
const http = require("http");
const https = require("https");

const port = Number(process.env.PORT) || 3000;
let orderAttempted = false;

function requestJson(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        let parsed = data;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function sign(payload) {
  return crypto.createHmac("sha256", process.env.SHARK_API_SECRET).update(payload).digest("hex");
}

function sharkGet(path, params) {
  const query = Object.entries({ ...params, timestamp: Date.now().toString() })
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return requestJson("GET", "api.sharkexchange.in", `${path}?${query}`, {
    "api-key": process.env.SHARK_API_KEY,
    signature: sign(query),
    Accept: "application/json",
  });
}

function sharkPost(path, params) {
  const body = JSON.stringify({ ...params, timestamp: Date.now().toString() });
  return requestJson(
    "POST",
    "api.sharkexchange.in",
    path,
    {
      "api-key": process.env.SHARK_API_KEY,
      signature: sign(body),
      Accept: "application/json",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    body
  );
}

async function placeUsdtTrade() {
  const ticker = await requestJson(
    "GET",
    "api.sharkexchange.in",
    "/v1/market/ticker24Hr/DOGEUSDT",
    { Accept: "application/json" }
  );
  const last = Number(ticker.body && ticker.body.data && ticker.body.data.c);
  const futures = await sharkGet("/v1/wallet/futures-wallet/details", { marginAsset: "INR" });
  const funding = await sharkGet("/v1/wallet/funding-wallet/details", { marginAsset: "INR" });

  if (!Number.isFinite(last) || last <= 0) {
    return { step: "ticker", ticker, futures, funding };
  }

  const minNotional = 5.75;
  let quantity = Math.ceil(minNotional / last);
  if (quantity * last < minNotional) quantity += 1;

  const orderParams = {
    placeType: "ORDER_FORM",
    quantity,
    side: "BUY",
    symbol: "DOGEUSDT",
    reduceOnly: false,
    marginAsset: "INR",
    type: "MARKET",
  };

  let leverage = null;
  let order = await sharkPost("/v1/order/place-order", orderParams);
  if (order.status === 400 && order.body && String(order.body.details || "").includes("Insufficient margin")) {
    leverage = await sharkPost("/v1/exchange/update/leverage", {
      leverage: 5,
      contractName: "DOGEUSDT",
    });
    order = await sharkPost("/v1/order/place-order", orderParams);
  }

  return {
    symbol: "DOGEUSDT",
    side: "BUY",
    type: "MARKET",
    last,
    quantity,
    notional: Math.round(quantity * last * 1000) / 1000,
    marginAsset: "INR",
    futuresStatus: futures.status,
    futures: futures.body,
    fundingStatus: funding.status,
    funding: funding.body,
    leverageStatus: leverage && leverage.status,
    leverage: leverage && leverage.body,
    orderStatus: order.status,
    order: order.body,
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];

  if (path === "/health") {
    sendJson(res, 200, { ok: true, service: "shark-bot" });
    return;
  }

  if (path === "/order-status" && req.method === "GET") {
    const token = process.env.ORDER_TOKEN;
    if (!token || req.headers["x-order-token"] !== token) {
      sendJson(res, 404, { ok: false });
      return;
    }
    Promise.all([
      sharkGet("/v1/order/m-c4834d356434dffacecd-948022-sha", {}),
      sharkGet("/v1/positions/OPEN", { symbol: "DOGEUSDT", sortOrder: "desc", pageSize: "5" }),
    ])
      .then(([order, positions]) => sendJson(res, 200, {
        orderStatus: order.status,
        order: order.body,
        positionsStatus: positions.status,
        positions: positions.body,
      }))
      .catch((error) => sendJson(res, 500, { ok: false, message: error.message }));
    return;
  }

  if (path === "/place-test-order" && req.method === "POST") {
    const token = process.env.ORDER_TOKEN;
    if (!token || req.headers["x-order-token"] !== token) {
      sendJson(res, 404, { ok: false });
      return;
    }
    if (orderAttempted) {
      sendJson(res, 409, { ok: false, message: "An order was already attempted." });
      return;
    }
    orderAttempted = true;
    placeUsdtTrade()
      .then((result) => sendJson(res, 200, result))
      .catch((error) => sendJson(res, 500, { ok: false, message: error.message }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Shark Bot</title>
</head>
<body>
  <h1>Shark Bot</h1>
  <p>The service is running.</p>
</body>
</html>`);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Shark Bot listening on 0.0.0.0:${port}`);
});

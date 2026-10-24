const http = require("http");

const port = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];

  if (path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "shark-bot" }));
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

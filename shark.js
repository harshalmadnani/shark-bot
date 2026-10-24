const crypto = require("crypto");
const https = require("https");

function requestJson(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.sharkexchange.in",
        path,
        method,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let parsed = data;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

class SharkClient {
  constructor(apiKey, apiSecret) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  sign(payload) {
    return crypto.createHmac("sha256", this.apiSecret).update(payload).digest("hex");
  }

  get(path, params = {}) {
    const query = Object.entries({ ...params, timestamp: Date.now().toString() })
      .map(([key, value]) => `${key}=${value}`)
      .join("&");
    return requestJson("GET", `${path}?${query}`, {
      "api-key": this.apiKey,
      signature: this.sign(query),
      Accept: "application/json",
    });
  }

  post(path, params = {}, signed = true) {
    const body = JSON.stringify(signed ? { ...params, timestamp: Date.now().toString() } : params);
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    };
    if (signed) {
      headers["api-key"] = this.apiKey;
      headers.signature = this.sign(body);
    }
    return requestJson("POST", path, headers, body);
  }
}

function sharkError(response) {
  if (!response || response.status < 400) return null;
  const body = response.body;
  if (body && typeof body === "object") return body.details || body.message || `Shark returned ${response.status}`;
  return `Shark returned ${response.status}`;
}

module.exports = { SharkClient, sharkError, requestJson };

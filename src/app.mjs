import fs from "node:fs";
import path from "node:path";
import { createSecurityHeaders } from "./security.mjs";
import { isValidExpiry, isValidDate } from "./massive.mjs";

class FixedWindowLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.entries = new Map();
  }

  allow(key) {
    const now = Date.now();
    const current = this.entries.get(key);
    if (!current || current.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    current.count++;
    return current.count <= this.limit;
  }
}

function clientAddress(request) {
  return request.socket.remoteAddress || "unknown";
}

function sendJson(response, config, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    ...createSecurityHeaders(config, "application/json; charset=utf-8"),
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders
  });
  response.end(body);
}

function sendText(response, config, status, text, contentType = "text/plain; charset=utf-8", extraHeaders = {}) {
  response.writeHead(status, {
    ...createSecurityHeaders(config, contentType),
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
    ...extraHeaders
  });
  response.end(text);
}

async function readForm(request, maxBytes = 16_384) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Request body is too large"), { status: 413 });
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function hostIsAllowed(request, config) {
  if (!config.publicOrigin) return true;
  try {
    return request.headers.host === new URL(config.publicOrigin).host;
  } catch {
    return false;
  }
}

function serveFile(response, config, filePath, contentType, cacheControl) {
  let stat;
  try { stat = fs.statSync(filePath); }
  catch { sendText(response, config, 503, "Required frontend asset is not installed."); return; }
  if (!stat.isFile()) { sendText(response, config, 404, "Not found"); return; }
  response.writeHead(200, {
    ...createSecurityHeaders(config, contentType),
    "Cache-Control": cacheControl,
    "Content-Length": stat.size
  });
  fs.createReadStream(filePath).pipe(response);
}

function unauthorized(response, config, wantsHtml = false) {
  if (!wantsHtml) {
    sendJson(response, config, 401, { error: "authentication_required" });
    return;
  }
  sendText(response, config, 401, "<!doctype html><meta charset=utf-8><title>Sign in required</title><h1>Sign in required</h1><p>Open this feature from the PHP application.</p>", "text/html; charset=utf-8");
}

export function createRequestHandler({ config, auth, market, provider, hub }) {
  const exchangeLimiter = new FixedWindowLimiter(10, 60_000);

  return async function requestHandler(request, response) {
    try {
      if (!hostIsAllowed(request, config)) {
        sendJson(response, config, 421, { error: "invalid_host" });
        return;
      }
      const base = config.publicOrigin || `http://${request.headers.host || "localhost"}`;
      const url = new URL(request.url || "/", base);

      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, config, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        const ready = Boolean(config.optionsApiKey || config.stocksApiKey);
        sendJson(response, config, ready ? 200 : 503, { status: ready ? "ready" : "missing-provider-credentials" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/auth/exchange") {
        if (!exchangeLimiter.allow(clientAddress(request))) {
          sendJson(response, config, 429, { error: "too_many_attempts" }, { "Retry-After": "60" });
          return;
        }
        const type = String(request.headers["content-type"] || "").split(";", 1)[0];
        if (type !== "application/x-www-form-urlencoded") {
          sendJson(response, config, 415, { error: "form_encoding_required" });
          return;
        }
        const form = await readForm(request);
        const session = auth.exchange(form.get("ticket") || "", request.headers.origin || "");
        response.writeHead(303, {
          ...createSecurityHeaders(config),
          "Cache-Control": "no-store",
          "Set-Cookie": auth.cookie(session),
          "Location": "/"
        });
        response.end();
        return;
      }

      const user = auth.authorize(request);
      const wantsHtml = url.pathname === "/" || url.pathname === "/index.html";
      if (!user) {
        unauthorized(response, config, wantsHtml);
        return;
      }

      if (request.method === "GET" && wantsHtml) {
        serveFile(response, config, path.join(config.publicDir, "index.html"), "text/html; charset=utf-8", "no-store");
        return;
      }
      if (request.method === "GET" && url.pathname === "/app.js") {
        serveFile(response, config, path.join(config.publicDir, "app.js"), "text/javascript; charset=utf-8", "no-cache");
        return;
      }
      if (request.method === "GET" && url.pathname === "/vendor/chart.umd.js") {
        serveFile(response, config, config.chartJsPath, "text/javascript; charset=utf-8", "public, max-age=31536000, immutable");
        return;
      }
      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(204, createSecurityHeaders(config));
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/session") {
        sendJson(response, config, 200, { authenticated: true, user: { id: user.sub, roles: user.roles } });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/bootstrap") {
        const expiry = url.searchParams.get("expiry") || "";
        if (!isValidExpiry(expiry)) {
          sendJson(response, config, 400, { error: "invalid_expiry" });
          return;
        }
        const payload = await market.getBootstrap(expiry);
        provider.syncSubscriptions();
        sendJson(response, config, 200, payload);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/candles") {
        const from = url.searchParams.get("from") || "";
        const to = url.searchParams.get("to") || "";
        if (!isValidDate(from) || !isValidDate(to)) {
          sendJson(response, config, 400, { error: "invalid_date_range" });
          return;
        }
        const payload = await market.getCandles(from, to);
        sendJson(response, config, 200, payload);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/stream") {
        const expiry = url.searchParams.get("expiry") || "";
        const range = Number(url.searchParams.get("range") ?? 10);
        if (!isValidExpiry(expiry) || !Number.isFinite(range) || range < 0 || range > config.maxStrikeRange) {
          sendJson(response, config, 400, { error: "invalid_subscription" });
          return;
        }
        hub.assertCapacity(user);
        response.writeHead(200, {
          ...createSecurityHeaders(config, "text/event-stream; charset=utf-8"),
          "Cache-Control": "no-cache, no-store, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no"
        });
        const client = hub.add(request, response, user, { expiry, range });
        hub.sendDirect(client, "feed_status", { ...provider.status, timestamp: Date.now() });
        provider.syncSubscriptions();
        return;
      }

      if (!['GET', 'POST'].includes(request.method || "")) {
        sendJson(response, config, 405, { error: "method_not_allowed" }, { "Allow": "GET, POST" });
        return;
      }
      sendJson(response, config, 404, { error: "not_found" });
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      const safeMessage = status >= 500 && status !== 502 && status !== 503 && status !== 504
        ? "Internal server error"
        : String(error?.message || "Request failed").slice(0, 300);
      const headers = error?.retryAfter ? { "Retry-After": String(error.retryAfter).slice(0, 30) } : {};
      if (!response.headersSent) sendJson(response, config, status, { error: safeMessage }, headers);
      else { try { response.end(); } catch {} }
    }
  };
}

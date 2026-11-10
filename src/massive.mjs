import { errorDetails, log } from "./logger.mjs";

const OPTION_SYMBOL = /^O:SPY(\d{6})([CP])(\d{8})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class UpstreamError extends Error {
  constructor(message, status = 502, retryAfter = "") {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function isValidExpiry(value) {
  if (!DATE.test(String(value || ""))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.getUTCDay() !== 0 && date.getUTCDay() !== 6;
}

export function isValidDate(value) {
  if (!DATE.test(String(value || ""))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseOptionSymbol(symbol) {
  const match = OPTION_SYMBOL.exec(String(symbol || ""));
  if (!match) return null;
  return {
    expiry: `20${match[1].slice(0, 2)}-${match[1].slice(2, 4)}-${match[1].slice(4, 6)}`,
    side: match[2] === "C" ? "call" : "put",
    strike: Number(match[3]) / 1000
  };
}

function optionSymbol(expiry, side, strike) {
  if (!isValidExpiry(expiry) || !['call', 'put'].includes(side) || !Number.isFinite(strike)) return null;
  const date = expiry.replaceAll("-", "").slice(2);
  const type = side === "call" ? "C" : "P";
  const encodedStrike = Math.round(strike * 1000).toString().padStart(8, "0");
  const symbol = `O:SPY${date}${type}${encodedStrike}`;
  return OPTION_SYMBOL.test(symbol) ? symbol : null;
}

function finite(value, { min = -Infinity, max = Infinity } = {}) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function safeTimestamp(value) {
  const number = finite(value, { min: 1 });
  return number == null ? Date.now() : number;
}

function safeConditions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).map(Number).filter(item => Number.isInteger(item) && item >= 0 && item <= 10000);
}

function numericFields(source, names, bounds = {}) {
  const output = {};
  for (const name of names) {
    const value = finite(source?.[name], bounds[name] || {});
    if (value != null) output[name] = value;
  }
  return output;
}

function sanitizeOptionContract(raw, requestedExpiry) {
  const details = raw?.details || {};
  const side = details.contract_type;
  const strike = finite(details.strike_price, { min: 0.001, max: 100_000 });
  if (!['call', 'put'].includes(side) || strike == null) return null;
  const expiry = isValidExpiry(details.expiration_date) ? details.expiration_date : requestedExpiry;
  if (expiry !== requestedExpiry) return null;
  const ticker = OPTION_SYMBOL.test(details.ticker || "") ? details.ticker : optionSymbol(expiry, side, strike);
  if (!ticker) return null;
  const day = numericFields(raw.day, ['open', 'high', 'low', 'close', 'volume', 'vwap', 'change', 'change_percent', 'last_updated']);
  const lastTrade = numericFields(raw.last_trade, ['price', 'size', 'sip_timestamp', 'exchange', 'last_updated']);
  lastTrade.conditions = safeConditions(raw.last_trade?.conditions);
  const lastQuote = numericFields(raw.last_quote, ['bid', 'ask', 'midpoint', 'bid_size', 'ask_size', 'last_updated']);
  const greeks = numericFields(raw.greeks, ['delta', 'gamma', 'theta', 'vega']);
  const underlyingAsset = numericFields(raw.underlying_asset, ['price', 'last_updated', 'change_to_break_even']);
  return {
    details: { ticker, contract_type: side, strike_price: strike, expiration_date: expiry },
    day,
    last_trade: lastTrade,
    last_quote: lastQuote,
    greeks,
    underlying_asset: underlyingAsset,
    open_interest: finite(raw.open_interest, { min: 0, max: 1_000_000_000 }),
    implied_volatility: finite(raw.implied_volatility, { min: 0, max: 100 }),
    break_even_price: finite(raw.break_even_price, { min: 0, max: 1_000_000 })
  };
}

function sanitizeCandle(raw) {
  const timestamp = finite(raw?.t, { min: 1, max: Number.MAX_SAFE_INTEGER });
  const open = finite(raw?.o, { min: 0.0001, max: 1_000_000 });
  const high = finite(raw?.h, { min: 0.0001, max: 1_000_000 });
  const low = finite(raw?.l, { min: 0.0001, max: 1_000_000 });
  const close = finite(raw?.c, { min: 0.0001, max: 1_000_000 });
  if ([timestamp, open, high, low, close].some(value => value == null) || high < low) return null;
  return {
    t: timestamp, o: open, h: high, l: low, c: close,
    v: finite(raw.v, { min: 0, max: 100_000_000_000 }) ?? 0,
    vw: finite(raw.vw, { min: 0.0001, max: 1_000_000 }) ?? close
  };
}

function safeJsonMessage(data) {
  if (typeof data !== "string" || data.length > 2_000_000) return [];
  try {
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed.slice(0, 10000) : [parsed];
  } catch {
    return [];
  }
}

export class MarketDataService {
  constructor(config) {
    this.config = config;
    this.cache = new Map();
    this.inflight = new Map();
    this.chains = new Map();
    this.currentStock = null;
    this.feedStatus = { stocks: "idle", options: "idle" };
    this.optionsAccessDeniedUntil = 0;
    this.optionsAccessError = null;
  }

  setFeedStatus(kind, status) {
    this.feedStatus[kind] = status;
  }

  updateStock(price, source, timestamp = Date.now(), previousClose = null) {
    const safePrice = finite(price, { min: 0.0001, max: 1_000_000 });
    if (safePrice == null) return;
    this.currentStock = {
      price: safePrice,
      previousClose: finite(previousClose, { min: 0.0001, max: 1_000_000 }) ?? this.currentStock?.previousClose ?? null,
      source,
      timestamp: safeTimestamp(timestamp)
    };
  }

  async cached(key, ttlMs, loader) {
    const existing = this.cache.get(key);
    if (existing && existing.expiresAt > Date.now()) return existing.value;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const pending = loader().then(value => {
      this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }

  async requestJson(pathname, apiKey, operation = "request") {
    const startedAt = performance.now();
    const logFailure = (reason, status, details) => {
      log("warn", "massive.rest.failed", {
        operation, reason, status, durationMs: Math.round(performance.now() - startedAt), ...details
      });
    };
    if (!apiKey) {
      logFailure("missing_key", 503);
      throw new UpstreamError("The server is missing a Massive API key", 503);
    }
    const target = new URL(pathname, `${this.config.restBaseUrl}/`);
    if (target.origin !== new URL(this.config.restBaseUrl).origin) {
      logFailure("unexpected_origin", 502);
      throw new UpstreamError("Rejected upstream URL", 502);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.upstreamTimeoutMs);
    timer.unref?.();
    let upstreamStatus;
    let providerError = false;
    try {
      const response = await fetch(target, {
        signal: controller.signal,
        headers: {
          "Accept": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          "User-Agent": "spy-flow-realtime-server/1.0"
        },
        redirect: "error"
      });
      upstreamStatus = response.status;
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > 15_000_000) throw new UpstreamError("Upstream response is too large", 502);
      const text = await response.text();
      if (Buffer.byteLength(text) > 15_000_000) throw new UpstreamError("Upstream response is too large", 502);
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { throw new UpstreamError("Upstream returned invalid JSON", 502); }
      if (!response.ok) {
        providerError = true;
        const message = typeof payload?.message === "string" ? payload.message : `Massive request failed with ${response.status}`;
        throw new UpstreamError(message.slice(0, 300), response.status, response.headers.get("retry-after") || "");
      }
      return payload;
    } catch (error) {
      if (error instanceof UpstreamError) {
        logFailure(providerError ? "http_error" : "invalid_response", error.status, {
          upstreamStatus, message: providerError ? undefined : error.message
        });
        throw error;
      }
      if (error?.name === "AbortError") {
        logFailure("timeout", 504, { upstreamStatus, timeoutMs: this.config.upstreamTimeoutMs });
        throw new UpstreamError("Massive request timed out", 504);
      }
      const code = String(error?.cause?.code || error?.code || "");
      logFailure("transport", 502, { upstreamStatus, error: errorDetails(error, this.config) });
      const detail = ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(code) ? ` (${code})` : "";
      throw new UpstreamError(`Cannot connect to Massive${detail}. Check the server network connection.`, 502);
    } finally {
      clearTimeout(timer);
    }
  }

  async getStockSnapshot() {
    return this.cached("stock-snapshot", this.config.restCacheMs, async () => {
      const payload = await this.requestJson("/v2/snapshot/locale/us/markets/stocks/tickers/SPY", this.config.stocksApiKey, "stock_snapshot");
      const ticker = payload?.ticker || {};
      const price = ticker?.day?.c ?? ticker?.lastTrade?.p ?? ticker?.min?.c;
      const previousClose = ticker?.prevDay?.c;
      this.updateStock(price, "rest", Date.now(), previousClose);
      return this.currentStock;
    });
  }

  async getOptionChain(expiry) {
    if (!isValidExpiry(expiry)) throw Object.assign(new Error("Invalid expiration date"), { status: 400 });
    if (this.optionsAccessError && Date.now() < this.optionsAccessDeniedUntil) throw this.optionsAccessError;
    return this.cached(`chain:${expiry}`, this.config.restCacheMs, async () => {
      let path = `/v3/snapshot/options/SPY?expiration_date=${encodeURIComponent(expiry)}&limit=250`;
      const results = [];
      const seen = new Set();
      for (let page = 0; path && page < this.config.maxOptionChainPages; page++) {
        if (seen.has(path)) throw new UpstreamError("Upstream pagination loop detected", 502);
        seen.add(path);
        const payload = await this.requestJson(path, this.config.optionsApiKey, "option_chain");
        if (Array.isArray(payload?.results)) {
          const remaining = this.config.maxOptionChainResults - results.length;
          results.push(...payload.results.slice(0, remaining).map(item => sanitizeOptionContract(item, expiry)).filter(Boolean));
        }
        if (results.length >= this.config.maxOptionChainResults || !payload?.next_url) break;
        const next = new URL(payload.next_url, this.config.restBaseUrl);
        const allowedOrigins = new Set([new URL(this.config.restBaseUrl).origin, "https://api.massive.com", "https://api.polygon.io"]);
        if (!allowedOrigins.has(next.origin) || next.pathname !== "/v3/snapshot/options/SPY") {
          throw new UpstreamError("Rejected upstream pagination URL", 502);
        }
        next.searchParams.delete("apiKey");
        path = `${next.pathname}${next.search}`;
      }
      this.chains.set(expiry, { results, fetchedAt: Date.now() });
      return results;
    }).catch(error => {
      if (error?.status === 403) {
        this.optionsAccessError = error;
        this.optionsAccessDeniedUntil = Date.now() + 60_000;
      }
      throw error;
    });
  }

  async getBootstrap(expiry) {
    const [stockResult, chainResult] = await Promise.allSettled([
      this.getStockSnapshot(),
      this.getOptionChain(expiry)
    ]);
    if (stockResult.status === "rejected" && chainResult.status === "rejected") throw stockResult.reason;
    const chain = chainResult.status === "fulfilled" ? chainResult.value : [];
    const chainPrice = chain.find(item => finite(item?.underlying_asset?.price, { min: 0.0001 }))?.underlying_asset?.price;
    if (!this.currentStock && chainPrice) this.updateStock(chainPrice, "options", Date.now());
    return {
      schemaVersion: 1,
      symbol: "SPY",
      expiry,
      generatedAt: Date.now(),
      stock: this.currentStock,
      stockWarning: stockResult.status === "rejected" ? "Stock snapshot is unavailable; using the options feed when possible." : null,
      optionsError: chainResult.status === "rejected" ? {
        status: chainResult.reason?.status || 502,
        message: String(chainResult.reason?.message || "Option chain is unavailable").slice(0, 300)
      } : null,
      chain,
      feeds: { ...this.feedStatus }
    };
  }

  async getCandles(from, to) {
    if (!isValidDate(from) || !isValidDate(to) || from > to) {
      throw Object.assign(new Error("Invalid candle date range"), { status: 400 });
    }
    const days = (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000;
    if (days > 45) throw Object.assign(new Error("Candle date range is too large"), { status: 400 });
    const key = `candles:${from}:${to}`;
    return this.cached(key, Math.max(this.config.restCacheMs, 5000), async () => {
      const payload = await this.requestJson(
        `/v2/aggs/ticker/SPY/range/1/minute/${from}/${to}?adjusted=true&sort=asc&limit=50000`,
        this.config.stocksApiKey,
        "candles"
      );
      return { results: Array.isArray(payload?.results) ? payload.results.map(sanitizeCandle).filter(Boolean).slice(0, 50000) : [] };
    });
  }

  desiredOptionContracts(subscriptions) {
    const candidates = new Map();
    const reference = this.currentStock?.price;
    for (const subscription of subscriptions) {
      const chain = this.chains.get(subscription.expiry)?.results || [];
      const range = subscription.range === 0 ? Infinity : subscription.range;
      for (const item of chain) {
        const details = item?.details || {};
        const strike = finite(details.strike_price, { min: 0.001, max: 100000 });
        if (strike == null || !['call', 'put'].includes(details.contract_type)) continue;
        if (Number.isFinite(reference) && Math.abs(strike - reference) > range) continue;
        const symbol = OPTION_SYMBOL.test(details.ticker || "")
          ? details.ticker
          : optionSymbol(subscription.expiry, details.contract_type, strike);
        if (!symbol) continue;
        const distance = Number.isFinite(reference) ? Math.abs(strike - reference) : strike;
        const previous = candidates.get(symbol);
        if (previous == null || distance < previous) candidates.set(symbol, distance);
      }
    }
    return [...candidates.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .slice(0, this.config.maxOptionContracts)
      .map(([symbol]) => symbol);
  }
}

export class MassiveProvider {
  constructor(config, hub, market) {
    this.config = config;
    this.hub = hub;
    this.market = market;
    this.stopped = false;
    this.sockets = { stocks: null, options: null };
    this.status = { stocks: "idle", options: "idle" };
    this.backoff = { stocks: 1000, options: 1000 };
    this.reconnectTimers = { stocks: null, options: null };
    this.optionSubscriptions = new Set();
    this.pendingQuotes = new Map();
    this.quoteTimer = null;
  }

  start() {
    this.stopped = false;
    if (this.config.stocksApiKey) this.connect("stocks"); else this.updateStatus("stocks", "missing-key");
    if (this.config.optionsApiKey) this.connect("options"); else this.updateStatus("options", "missing-key");
  }

  updateStatus(kind, status, detail = "") {
    const previousStatus = this.status[kind];
    this.status[kind] = status;
    this.market.setFeedStatus(kind, status);
    if (this.config.massiveWsLogs && status !== previousStatus) {
      const level = ["missing-key", "unsupported", "auth-failed", "degraded"].includes(status) ? "warn" : "info";
      log(level, "massive.ws.status", { feed: kind, previousStatus, status, detail: String(detail || "").slice(0, 200) });
    }
    this.hub.publish("feed_status", { ...this.status, detail: String(detail || "").slice(0, 200), timestamp: Date.now() });
  }

  connect(kind) {
    if (this.stopped || this.sockets[kind]?.readyState < 2) return;
    if (typeof WebSocket !== "function") {
      this.updateStatus(kind, "unsupported", "Node.js 22.4 or newer is required");
      return;
    }
    const key = kind === "stocks" ? this.config.stocksApiKey : this.config.optionsApiKey;
    const target = kind === "stocks" ? this.config.stocksWsUrl : this.config.optionsWsUrl;
    this.updateStatus(kind, "connecting");
    let socket;
    try { socket = new WebSocket(target); }
    catch (error) {
      if (this.config.massiveWsLogs) {
        log("warn", "massive.ws.error", { feed: kind, error: errorDetails(error, this.config) });
      }
      this.scheduleReconnect(kind);
      return;
    }
    this.sockets[kind] = socket;
    let authSent = false;
    const sendAuth = () => {
      if (this.sockets[kind] !== socket || authSent || socket.readyState !== WebSocket.OPEN) return;
      authSent = true;
      socket.send(JSON.stringify({ action: "auth", params: key }));
    };
    socket.addEventListener("open", sendAuth);
    socket.addEventListener("message", event => {
      if (this.sockets[kind] !== socket) return;
      const messages = safeJsonMessage(event.data);
      for (const message of messages) {
        if (message?.ev === "status") {
          if (this.config.massiveWsLogs) {
            log("info", "massive.ws.provider_status", {
              feed: kind,
              providerStatus: String(message.status || "").slice(0, 50),
              providerMessage: String(message.message || "").slice(0, 300)
            });
          }
          if (message.status === "connected" || message.message === "Connected Successfully") sendAuth();
          if (message.status === "auth_success" || message.message === "authenticated") {
            this.backoff[kind] = 1000;
            this.updateStatus(kind, "live");
            if (kind === "stocks") socket.send(JSON.stringify({ action: "subscribe", params: "T.SPY,Q.SPY,A.SPY" }));
            else { this.optionSubscriptions.clear(); this.syncSubscriptions(); }
          } else if (message.status === "auth_failed") {
            this.updateStatus(kind, "auth-failed", message.message || "Provider rejected the API key");
          } else if (message.status === "max_connections") {
            this.updateStatus(kind, "degraded", message.message || "Maximum number of websocket connections exceeded");
          } else if (message.status === "error") {
            this.updateStatus(kind, "degraded", message.message || "Provider subscription error");
          }
          continue;
        }
        if (kind === "stocks") this.handleStock(message);
        else this.handleOption(message);
      }
    });
    // A failed handshake can emit only "error". Calling close() from that handler can emit it again synchronously.
    const disconnect = event => {
      if (this.stopped || this.sockets[kind] !== socket) return;
      this.sockets[kind] = null;
      if (kind === "options") this.optionSubscriptions.clear();
      if (this.config.massiveWsLogs) {
        if (event.type === "error") {
          log("warn", "massive.ws.error", {
            feed: kind,
            status: this.status[kind],
            error: errorDetails(event.error, this.config, { includeStack: false })
          });
        } else {
          log("warn", "massive.ws.closed", { feed: kind, code: event.code, clean: event.wasClean });
        }
      }
      this.updateStatus(kind, "reconnecting");
      this.scheduleReconnect(kind);
    };
    socket.addEventListener("error", disconnect);
    socket.addEventListener("close", disconnect);
  }

  scheduleReconnect(kind) {
    if (this.stopped || this.reconnectTimers[kind]) return;
    const base = this.backoff[kind];
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.backoff[kind] = Math.min(base * 2, 30000);
    if (this.config.massiveWsLogs) {
      log("info", "massive.ws.reconnect_scheduled", { feed: kind, delayMs: delay });
    }
    this.reconnectTimers[kind] = setTimeout(() => {
      this.reconnectTimers[kind] = null;
      this.connect(kind);
    }, delay);
    this.reconnectTimers[kind].unref?.();
  }

  handleStock(message) {
    if (message?.sym !== "SPY") return;
    if (message.ev === "Q") {
      const bid = finite(message.bp, { min: 0.0001, max: 1_000_000 });
      const ask = finite(message.ap, { min: 0.0001, max: 1_000_000 });
      if (bid != null && ask != null && ask >= bid) {
        this.hub.publish("stock_quote", { bid, ask, timestamp: safeTimestamp(message.t) });
      }
      return;
    }
    if (!['T', 'A'].includes(message.ev)) return;
    const price = finite(message.ev === "T" ? message.p : (message.vw ?? message.c), { min: 0.0001, max: 1_000_000 });
    if (price == null) return;
    const timestamp = safeTimestamp(message.t ?? message.e ?? message.s);
    this.market.updateStock(price, "ws", timestamp);
    this.hub.publish("stock_tick", { price, source: "ws", timestamp });
  }

  handleOption(message) {
    const parsed = parseOptionSymbol(message?.sym);
    if (!parsed) return;
    if (message.ev === "Q") {
      const bid = finite(message.bp, { min: 0, max: 1_000_000 });
      const ask = finite(message.ap, { min: 0.0001, max: 1_000_000 });
      if (bid == null || ask == null || ask < bid) return;
      const quote = {
        ev: "Q", sym: message.sym, bp: bid, ap: ask,
        bs: finite(message.bs, { min: 0, max: 100_000_000 }) ?? 0,
        as: finite(message.as, { min: 0, max: 100_000_000 }) ?? 0,
        t: safeTimestamp(message.t)
      };
      this.pendingQuotes.set(message.sym, quote);
      this.scheduleQuoteFlush();
      return;
    }
    if (message.ev !== "T") return;
    const price = finite(message.p, { min: 0.0001, max: 1_000_000 });
    const size = finite(message.s ?? message.q, { min: 0.0001, max: 100_000_000 });
    if (price == null || size == null) return;
    const trade = {
      ev: "T", sym: message.sym, p: price, s: size,
      t: safeTimestamp(message.t ?? message.sip_timestamp),
      c: safeConditions(message.c),
      x: finite(message.x ?? message.exchange, { min: 0, max: 10000 }),
      q: finite(message.q, { min: 0, max: Number.MAX_SAFE_INTEGER })
    };
    this.hub.publish("option_trade", trade, { expiry: parsed.expiry });
  }

  scheduleQuoteFlush() {
    if (this.quoteTimer) return;
    this.quoteTimer = setTimeout(() => {
      this.quoteTimer = null;
      const groups = new Map();
      for (const quote of this.pendingQuotes.values()) {
        const expiry = parseOptionSymbol(quote.sym)?.expiry;
        if (!expiry) continue;
        if (!groups.has(expiry)) groups.set(expiry, []);
        groups.get(expiry).push(quote);
      }
      this.pendingQuotes.clear();
      for (const [expiry, quotes] of groups) {
        this.hub.publish("option_quote_batch", quotes, { expiry });
      }
    }, 100);
    this.quoteTimer.unref?.();
  }

  syncSubscriptions() {
    const socket = this.sockets.options;
    if (!socket || socket.readyState !== WebSocket.OPEN || !['live', 'degraded'].includes(this.status.options)) return;
    const desired = new Set(this.market.desiredOptionContracts(this.hub.getSubscriptions()));
    const subscribe = [...desired].filter(symbol => !this.optionSubscriptions.has(symbol));
    const unsubscribe = [...this.optionSubscriptions].filter(symbol => !desired.has(symbol));
    const sendBatches = (action, symbols) => {
      for (let index = 0; index < symbols.length; index += 100) {
        const batch = symbols.slice(index, index + 100);
        const params = batch.flatMap(symbol => [`T.${symbol}`, `Q.${symbol}`]).join(",");
        if (params) socket.send(JSON.stringify({ action, params }));
      }
    };
    sendBatches("unsubscribe", unsubscribe);
    sendBatches("subscribe", subscribe);
    for (const symbol of unsubscribe) this.optionSubscriptions.delete(symbol);
    for (const symbol of subscribe) this.optionSubscriptions.add(symbol);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.quoteTimer);
    for (const kind of ['stocks', 'options']) {
      clearTimeout(this.reconnectTimers[kind]);
      this.reconnectTimers[kind] = null;
      const socket = this.sockets[kind];
      this.sockets[kind] = null;
      try { socket?.close(); } catch {}
    }
    this.optionSubscriptions.clear();
  }
}

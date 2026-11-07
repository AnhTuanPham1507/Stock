import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SRC_DIR, "..");

function integer(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function bool(env, name, fallback) {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function url(env, name, fallback) {
  const value = env[name] || fallback;
  const parsed = new URL(value);
  if (!['https:', 'wss:'].includes(parsed.protocol)) {
    throw new Error(`${name} must use HTTPS or WSS`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export function loadConfig(env = process.env) {
  const production = (env.NODE_ENV || "development") === "production";
  const authMode = (env.FLOW_AUTH_MODE || (production ? "sso" : "none")).toLowerCase();
  if (!['none', 'sso'].includes(authMode)) {
    throw new Error("FLOW_AUTH_MODE must be none or sso");
  }
  if (production && authMode !== "sso") {
    throw new Error("Production requires FLOW_AUTH_MODE=sso");
  }
  const ssoSecret = env.FLOW_SSO_SHARED_SECRET || "";
  if (authMode === "sso" && Buffer.byteLength(ssoSecret) < 32) {
    throw new Error("FLOW_SSO_SHARED_SECRET must contain at least 32 bytes in sso mode");
  }

  return Object.freeze({
    projectDir: PROJECT_DIR,
    publicDir: path.join(PROJECT_DIR, "public"),
    chartJsPath: path.join(PROJECT_DIR, "node_modules", "chart.js", "dist", "chart.umd.js"),
    host: env.HOST || "127.0.0.1",
    port: integer(env, "PORT", 3000, 1, 65535),
    production,
    publicOrigin: env.FLOW_PUBLIC_ORIGIN || "",
    phpOrigin: env.PHP_APP_ORIGIN || "",
    authMode,
    ssoSecret,
    ssoIssuer: env.FLOW_SSO_ISSUER || "php-app",
    ssoAudience: env.FLOW_SSO_AUDIENCE || "spy-flow",
    sessionTtlSeconds: integer(env, "FLOW_SESSION_TTL_SECONDS", 3600, 300, 86400),
    secureCookies: bool(env, "FLOW_SECURE_COOKIES", production),
    stocksApiKey: env.MASSIVE_STOCKS_API_KEY || "",
    optionsApiKey: env.MASSIVE_OPTIONS_API_KEY || env.MASSIVE_STOCKS_API_KEY || "",
    restBaseUrl: url(env, "MASSIVE_REST_BASE_URL", "https://api.massive.com"),
    stocksWsUrl: url(env, "MASSIVE_STOCKS_WS_URL", "wss://socket.massive.com/stocks"),
    optionsWsUrl: url(env, "MASSIVE_OPTIONS_WS_URL", "wss://socket.massive.com/options"),
    upstreamTimeoutMs: integer(env, "UPSTREAM_TIMEOUT_MS", 10000, 1000, 60000),
    restCacheMs: integer(env, "REST_CACHE_MS", 2500, 250, 60000),
    maxSseClients: integer(env, "MAX_SSE_CLIENTS", 100, 1, 10000),
    maxSseClientsPerUser: integer(env, "MAX_SSE_CLIENTS_PER_USER", 3, 1, 20),
    maxOptionContracts: integer(env, "MAX_OPTION_CONTRACTS", 1000, 1, 1000),
    maxOptionChainPages: integer(env, "MAX_OPTION_CHAIN_PAGES", 20, 1, 100),
    maxOptionChainResults: integer(env, "MAX_OPTION_CHAIN_RESULTS", 5000, 250, 25000),
    maxStrikeRange: integer(env, "MAX_STRIKE_RANGE", 200, 1, 1000),
    maxSseQueue: integer(env, "MAX_SSE_QUEUE", 200, 10, 5000),
    sseReplaySize: integer(env, "SSE_REPLAY_SIZE", 1000, 10, 10000),
    sseHeartbeatMs: integer(env, "SSE_HEARTBEAT_MS", 20000, 5000, 55000),
    sseMaxConnectionMs: integer(env, "SSE_MAX_CONNECTION_MS", 900000, 60000, 3600000)
  });
}

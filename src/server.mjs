import http from "node:http";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { AuthService } from "./security.mjs";
import { SseHub } from "./sse-hub.mjs";
import { MarketDataService, MassiveProvider } from "./massive.mjs";
import { createRequestHandler } from "./app.mjs";
import { errorDetails, log } from "./logger.mjs";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadProjectEnv() {
  try {
    loadEnvFile(path.join(PROJECT_DIR, ".env"));
    log("info", "server.env_loaded");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function createApplication(config = loadConfig()) {
  const auth = new AuthService(config);
  const hub = new SseHub(config);
  const market = new MarketDataService(config);
  const provider = new MassiveProvider(config, hub, market);
  hub.onSubscriptionsChanged(() => provider.syncSubscriptions());
  const server = http.createServer(createRequestHandler({ config, auth, market, provider, hub }));
  server.requestTimeout = 15_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 65_000;
  return { server, auth, hub, market, provider };
}

export async function startApplication(config = loadConfig()) {
  const application = createApplication(config);
  await new Promise((resolve, reject) => {
    application.server.once("error", reject);
    application.server.listen(config.port, config.host, () => {
      application.server.off("error", reject);
      resolve();
    });
  });
  const { address, port } = application.server.address();
  log("info", "server.listening", { address, port, authMode: config.authMode, production: config.production });
  application.provider.start();
  if (config.authMode === "none") log("warn", "server.auth_disabled");
  return application;
}

async function main() {
  log("info", "server.starting", { nodeVersion: process.version });
  loadProjectEnv();
  const application = await startApplication();
  let shuttingDown = false;
  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", "server.shutdown_started", { signal });
    application.provider.stop();
    application.hub.close();
    application.server.close(error => {
      if (error) exitWithError("server.shutdown_failed", error);
      log("info", "server.shutdown_completed", { signal }, { sync: true });
      process.exit(0);
    });
    setTimeout(() => {
      log("error", "server.shutdown_timeout", { signal, timeoutMs: 10_000 }, { sync: true });
      process.exit(1);
    }, 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function exitWithError(event, error) {
  try {
    log("error", event, { error: errorDetails(error) }, { sync: true });
  } finally {
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.on("uncaughtException", error => exitWithError("process.uncaught_exception", error));
  process.on("unhandledRejection", error => exitWithError("process.unhandled_rejection", error));
  main().catch(error => exitWithError("server.startup_failed", error));
}

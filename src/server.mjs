import http from "node:http";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { AuthService } from "./security.mjs";
import { SseHub } from "./sse-hub.mjs";
import { MarketDataService, MassiveProvider } from "./massive.mjs";
import { createRequestHandler } from "./app.mjs";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadProjectEnv() {
  try {
    loadEnvFile(path.join(PROJECT_DIR, ".env"));
    console.log("Loaded configuration from .env");
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
    application.server.listen(config.port, config.host, resolve);
  });
  application.provider.start();
  const visibleHost = config.host === "127.0.0.1" ? "localhost" : config.host;
  console.log(`SPY Flow server listening on http://${visibleHost}:${config.port}`);
  if (!config.stocksApiKey) console.warn("MASSIVE_STOCKS_API_KEY is not configured");
  if (!config.optionsApiKey) console.warn("MASSIVE_OPTIONS_API_KEY is not configured");
  if (config.authMode === "none") console.warn("Authentication is disabled for local development");
  return application;
}

async function main() {
  const application = await startApplication();
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    application.provider.stop();
    application.hub.close();
    application.server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadProjectEnv();
  main().catch(error => {
    console.error(error?.message || error);
    process.exit(1);
  });
}

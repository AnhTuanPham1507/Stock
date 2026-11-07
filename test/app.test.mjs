import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { AuthService } from "../src/security.mjs";
import { createRequestHandler } from "../src/app.mjs";

async function withServer(run) {
  const config = loadConfig({ NODE_ENV: "development", FLOW_AUTH_MODE: "none" });
  const auth = new AuthService(config);
  const market = {
    getBootstrap: async expiry => ({ schemaVersion: 1, expiry, stock: { price: 500 }, chain: [] }),
    getCandles: async () => ({ results: [] })
  };
  const provider = { status: { stocks: "live", options: "live" }, syncSubscriptions() {} };
  const hub = { add() {}, sendDirect() {} };
  const server = http.createServer(createRequestHandler({ config, auth, market, provider, hub }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test("serves the migrated dashboard with security headers", () => withServer(async base => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.match(await response.text(), /\/app\.js/);
}));

test("validates bootstrap expiration", () => withServer(async base => {
  const invalid = await fetch(`${base}/api/v1/bootstrap?expiry=not-a-date`);
  assert.equal(invalid.status, 400);
  const valid = await fetch(`${base}/api/v1/bootstrap?expiry=2030-01-04`);
  assert.equal(valid.status, 200);
}));

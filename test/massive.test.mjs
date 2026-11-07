import assert from "node:assert/strict";
import test from "node:test";
import { isValidDate, isValidExpiry, MarketDataService, parseOptionSymbol, UpstreamError } from "../src/massive.mjs";

test("expiration and option symbols are strictly validated", () => {
  assert.equal(isValidExpiry("2030-01-04"), true);
  assert.equal(isValidExpiry("2030-01-05"), false);
  assert.equal(isValidDate("2030-02-29"), false);
  assert.deepEqual(parseOptionSymbol("O:SPY300104C00500000"), {
    expiry: "2030-01-04", side: "call", strike: 500
  });
  assert.equal(parseOptionSymbol("O:OTHER300104C00500000"), null);
});

test("desired option subscriptions are range-filtered and capped", () => {
  const config = { maxOptionContracts: 2 };
  const market = new MarketDataService(config);
  market.currentStock = { price: 500 };
  market.chains.set("2030-01-04", { results: [499, 500, 501].flatMap(strike => [
    { details: { ticker: `O:SPY300104C${String(strike * 1000).padStart(8, "0")}`, strike_price: strike, contract_type: "call" } }
  ]) });
  assert.deepEqual(market.desiredOptionContracts([{ expiry: "2030-01-04", range: 2 }]), [
    "O:SPY300104C00500000", "O:SPY300104C00499000"
  ]);
});

test("an Options access denial preserves a working Stocks bootstrap", async () => {
  const market = new MarketDataService({});
  market.getStockSnapshot = async () => { market.updateStock(500, "rest"); return market.currentStock; };
  market.getOptionChain = async () => { throw new UpstreamError("Options snapshot is not entitled", 403); };
  const result = await market.getBootstrap("2030-01-04");
  assert.equal(result.stock.price, 500);
  assert.deepEqual(result.chain, []);
  assert.equal(result.optionsError.status, 403);
});

test("simultaneous Stocks and Options failures remain visible", async () => {
  const market = new MarketDataService({});
  market.getStockSnapshot = async () => { throw new UpstreamError("Stocks connection failed", 502); };
  market.getOptionChain = async () => { throw new UpstreamError("Options denied", 403); };
  await assert.rejects(market.getBootstrap("2030-01-04"), /Stocks connection failed/);
});

test("Options permissions are retried at most once a minute after a denial", async () => {
  const market = new MarketDataService({restCacheMs:2500,maxOptionChainPages:1});
  let requests=0;
  market.requestJson=async()=>{requests++;throw new UpstreamError("Not entitled",403);};
  await assert.rejects(market.getOptionChain("2030-01-04"), /Not entitled/);
  await assert.rejects(market.getOptionChain("2030-01-07"), /Not entitled/);
  assert.equal(requests,1);
  market.optionsAccessDeniedUntil=0;
  await assert.rejects(market.getOptionChain("2030-01-04"), /Not entitled/);
  assert.equal(requests,2);
});

# SPY Flow realtime Node.js server

This project migrates `Pop Up.html` into a standalone Node.js service. The browser receives the dashboard and same-origin APIs from Node. Only Node communicates with Massive over REST and WebSocket, and realtime updates are fanned out to browsers through Server-Sent Events (SSE).

## What is implemented

- Existing dashboard UI, analytics, simulation, charts, filters, IndexedDB, and local preferences are preserved.
- Provider credentials were removed from browser code and old key values are cleared from `localStorage`.
- One shared stock WebSocket and one shared options WebSocket run in Node.
- Option-chain and candle REST calls are cached and single-flight, with timeouts and bounded pagination.
- Browser updates use one authenticated `/api/v1/stream` SSE connection with heartbeats, replay IDs, bounded queues, and slow-client eviction.
- Option quotes are coalesced into 100 ms batches; trades and SPY ticks are pushed immediately.
- Production supports a short-lived, one-time HMAC login ticket from the existing PHP server.
- The frontend uses no inline JavaScript handlers. Third-party messages are schema-limited before reaching the browser, and the debug console renders them with `textContent`.

## Chart update from Options Swift HTML

The chart workstation was updated from `Options_Swift_SPY_DI_ADX18_30_Candle_Patterns(3).html`. The source file in Downloads is unchanged. The running application uses `public/index.html` and `public/app.js`.

- Wilder ADX (14), +DI and −DI share the candle time scale. Automatic crossover marks require ADX ≥18 and exclude the forming candle. The ADX pane can be resized by dragging either divider or using its arrow keys. Vertical drawings can extend into the ADX pane and optionally snap to a DI crossover.
- Completed candle pattern labels, supply/demand zones, and harmonic Butterfly overlays can be switched on or off. Butterfly swing size is configurable. The direction panel reports input alignment and coverage, not a win probability.
- Visible-range Volume Profile includes POC, VAH and VAL. Flow Force uses premium × absolute delta with a per-bar or rolling lookback. It uses classified SSE trades; snapshot fallback is labelled estimated and only contributes while the options stream is stale. Prints without delta or a classified direction do not receive an invented weight.
- Flow markers have adjustable spacing, quote-based mark/P&L details, and per-candle call/put contract totals. Flow Force and contract ledgers are saved per expiration. New-window chart synchronization includes these ledgers and chart preferences.
- The Live Follow button returns to the newest candle after manual chart navigation. Dark/white backgrounds and the existing EMA 7, EMA 9/21/200, VWAP and Bollinger studies remain available.

Provider credentials and market connections remain in Node. Imported controls use the existing CSP action allowlist and popup messages retain the same-origin check. This update does not add a VIX endpoint: optional VIX confirmation is explicitly unavailable. Gamma context uses the existing dashboard calculation.

For a local preview with synthetic candles and SSE option trades, without provider credentials:

```powershell
npm run preview:chart
```

Open `http://127.0.0.1:4318`, then select **CHART**. Set `CHART_PREVIEW_PORT` to use a different port. The preview is development-only, binds to loopback, and uses synthetic data. Production remains `npm start`.

Verification covers ADX warmup/trends/flat data, completed DI crossovers, candle anatomy, Flow Force weighting, session resets, duplicate SSE trades, flow-to-candle mapping, chart markup and CSP bindings, together with the existing HTTP/provider/authentication tests. Browser checks used synthetic data; real provider entitlement, live latency and trading outcomes were not tested.

## Requirements

- Node.js 22.4 or newer (Node.js 24 LTS is recommended for deployment).
- A Massive plan with the required stock/options REST and WebSocket entitlements.
- Permission from the data provider to display or redistribute the resulting market data to the intended users.

The credentials embedded in the original HTML must be revoked and rotated before deployment.

## Local development

The server automatically loads `.env` from the project root when started directly or through `npm start`. Existing operating-system environment variables take precedence over values in that file.

```powershell
npm install
$env:FLOW_AUTH_MODE="none"
$env:MASSIVE_STOCKS_API_KEY="rotated-stocks-key"
$env:MASSIVE_OPTIONS_API_KEY="rotated-options-key"
npm start
```

Open `http://localhost:3000`. Authentication mode `none` is accepted only outside production.

Run verification with:

```powershell
npm test
npm run check
```

If Stocks data is available while the Options snapshot is denied, bootstrap now returns the Stocks result with an explicit Options error. The dashboard displays `STOCKS ONLY`; the price chart can load candles without an Options subscription. Permission-denied Options snapshots are retried at most once per minute. This does not grant access to option flow, quotes, GEX or option walls.

Use `npm run check:market` to make a small read-only check of the configured keys against stock history, today's candles, stock snapshots and an option snapshot. It reports transport errors separately and prints only status/counts, never keys or returned price data. Repeated checks count toward the provider request limit. A paid Stocks subscription does not imply Options snapshot or trade access.

## Production configuration

1. Copy `.env.example` into your deployment secret/configuration system. Do not commit a real `.env` file.
2. Set `NODE_ENV=production`, `FLOW_AUTH_MODE=sso`, both rotated provider credentials, the PHP and Node origins, and a random SSO secret of at least 32 bytes.
3. Run one Node process initially. Multiple workers would duplicate upstream provider connections unless a separate ingestion leader and pub/sub layer are introduced.
4. Bind Node to `127.0.0.1:3000` and put TLS-enabled Nginx or Caddy in front. An Nginx example is provided at `deploy/nginx-flow.conf`.
5. Copy the logic in `examples/php/launch-flow.php` into the existing PHP application and link users to it.

The PHP and Node servers must receive exactly the same values for `FLOW_SSO_SHARED_SECRET`, `FLOW_SSO_ISSUER`, and `FLOW_SSO_AUDIENCE`. The secret is dedicated to this handoff; never expose it to JavaScript.

### PHP handoff

The PHP launcher checks the existing PHP session, creates a 60-second signed ticket, releases the PHP session lock, and submits the ticket by HTTPS POST to Node. Node validates the issuer, audience, origin, expiry, and one-time ID, then issues its own `HttpOnly; Secure; SameSite=Lax` cookie and redirects to the dashboard.

No PHP session cookie, session file, or provider credential is shared with Node.

## HTTP interface

- `POST /auth/exchange` — exchanges a PHP SSO ticket for the Node session cookie.
- `GET /api/v1/bootstrap?expiry=YYYY-MM-DD` — cached SPY state and full option-chain snapshot.
- `GET /api/v1/candles?from=YYYY-MM-DD&to=YYYY-MM-DD` — allowlisted SPY minute candles.
- `GET /api/v1/stream?expiry=YYYY-MM-DD&range=10` — SSE events (`stock_tick`, `stock_quote`, `option_trade`, `option_quote_batch`, `feed_status`, `resync`).
- `GET /healthz` — process liveness without sensitive details.
- `GET /readyz` — reports whether at least one provider credential is configured.

The service deliberately has no generic upstream proxy, arbitrary symbol endpoint, or credentialed CORS policy.

## Operational notes

- Disable proxy buffering and compression for `/api/v1/stream`; the included Nginx configuration does this.
- The server writes one JSON object per log line to stdout or stderr. Logs cover startup, HTTP requests, SSE connections, Massive REST failures, and process failures or shutdowns. Successful health and readiness probes and individual market updates are omitted.
- Massive WebSocket logs are off by default. Set `MASSIVE_WS_LOGS=true` and restart the server to see connection status, errors and reconnect attempts.
- Use `docker logs -f <container>` to follow the logs in Docker. To keep a copy when running locally in PowerShell, use `npm start 2>&1 | Tee-Object -FilePath "$env:TEMP\spy-flow-server.log" -Append`.
- Request logs record a known route and omit query strings, headers, and bodies. Massive logs omit provider payloads and authentication frames. Error details mask configured credentials and URLs.
- `MAX_OPTION_CONTRACTS` cannot exceed the provider's 1,000-contract options-quote limit.
- SSE connections are periodically recycled so expired/revoked sessions are rechecked.
- For a separate Node hostname, keep the dashboard and all browser APIs on that hostname. PHP should only perform the signed launch handoff—do not make PHP poll Node or proxy every market event.

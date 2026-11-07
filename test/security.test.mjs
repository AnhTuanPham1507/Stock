import assert from "node:assert/strict";
import test from "node:test";
import { AuthService, signToken } from "../src/security.mjs";

function config() {
  return {
    authMode: "sso",
    ssoSecret: "test-secret-with-at-least-thirty-two-bytes",
    ssoIssuer: "php-app",
    ssoAudience: "spy-flow",
    phpOrigin: "https://app.example.test",
    sessionTtlSeconds: 3600,
    secureCookies: true
  };
}

test("SSO exchange creates an authenticated session and rejects replay", () => {
  const auth = new AuthService(config());
  const now = Math.floor(Date.now() / 1000);
  const ticket = signToken({
    iss: "php-app", aud: "spy-flow", sub: "user-42", roles: ["member"],
    iat: now, exp: now + 60, jti: "unique-ticket-identifier-42"
  }, config().ssoSecret);
  const session = auth.exchange(ticket, "https://app.example.test");
  const request = { headers: { cookie: `flow_session=${encodeURIComponent(session)}` } };
  assert.deepEqual(auth.authorize(request), { sub: "user-42", roles: ["member"] });
  assert.throws(() => auth.exchange(ticket, "https://app.example.test"), /already been used/);
});

test("SSO exchange rejects an unexpected PHP origin", () => {
  const auth = new AuthService(config());
  const now = Math.floor(Date.now() / 1000);
  const ticket = signToken({
    iss: "php-app", aud: "spy-flow", sub: "user-42",
    iat: now, exp: now + 60, jti: "unique-ticket-identifier-43"
  }, config().ssoSecret);
  assert.throws(() => auth.exchange(ticket, "https://evil.example"), /Untrusted login origin/);
});

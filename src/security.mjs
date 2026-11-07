import crypto from "node:crypto";

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signature(encodedPayload, secret) {
  return crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function signToken(payload, secret) {
  const encoded = b64url(JSON.stringify(payload));
  return `${encoded}.${signature(encoded, secret)}`;
}

export function verifyToken(token, secret) {
  if (typeof token !== "string" || token.length > 8192) throw new Error("Invalid token");
  const [encoded, supplied, extra] = token.split(".");
  if (!encoded || !supplied || extra) throw new Error("Invalid token");
  if (!constantTimeEqual(supplied, signature(encoded, secret))) throw new Error("Invalid token");
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid token");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid token");
  return payload;
}

export function parseCookies(header = "") {
  const cookies = Object.create(null);
  for (const item of String(header).split(";")) {
    const index = item.indexOf("=");
    if (index < 1) continue;
    const name = item.slice(0, index).trim();
    try {
      cookies[name] = decodeURIComponent(item.slice(index + 1).trim());
    } catch {
      // Ignore malformed cookies.
    }
  }
  return cookies;
}

export class AuthService {
  constructor(config) {
    this.config = config;
    this.usedTickets = new Map();
  }

  authorize(request) {
    if (this.config.authMode === "none") return { sub: "local-development", roles: ["developer"] };
    const token = parseCookies(request.headers.cookie).flow_session;
    if (!token) return null;
    try {
      const claims = verifyToken(token, this.config.ssoSecret);
      const now = Math.floor(Date.now() / 1000);
      if (claims.kind !== "session" || claims.aud !== this.config.ssoAudience) return null;
      if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 200) return null;
      if (!Number.isInteger(claims.exp) || claims.exp <= now) return null;
      return { sub: claims.sub, roles: Array.isArray(claims.roles) ? claims.roles.slice(0, 20) : [] };
    } catch {
      return null;
    }
  }

  exchange(ticket, origin) {
    if (this.config.authMode !== "sso") throw Object.assign(new Error("SSO is disabled"), { status: 404 });
    if (this.config.phpOrigin && origin !== this.config.phpOrigin) {
      throw Object.assign(new Error("Untrusted login origin"), { status: 403 });
    }
    const claims = verifyToken(ticket, this.config.ssoSecret);
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== this.config.ssoIssuer || claims.aud !== this.config.ssoAudience) {
      throw Object.assign(new Error("Invalid login ticket"), { status: 401 });
    }
    if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 200) {
      throw Object.assign(new Error("Invalid login ticket"), { status: 401 });
    }
    if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.iat > now + 10 || claims.exp <= now || claims.exp > now + 120) {
      throw Object.assign(new Error("Expired login ticket"), { status: 401 });
    }
    if (typeof claims.jti !== "string" || claims.jti.length < 16 || claims.jti.length > 200) {
      throw Object.assign(new Error("Invalid login ticket"), { status: 401 });
    }
    this.pruneUsedTickets(now);
    if (this.usedTickets.has(claims.jti)) {
      throw Object.assign(new Error("Login ticket has already been used"), { status: 401 });
    }
    this.usedTickets.set(claims.jti, claims.exp);
    const session = signToken({
      kind: "session",
      sub: claims.sub,
      roles: Array.isArray(claims.roles) ? claims.roles.slice(0, 20) : [],
      aud: this.config.ssoAudience,
      iat: now,
      exp: now + this.config.sessionTtlSeconds
    }, this.config.ssoSecret);
    return session;
  }

  cookie(token) {
    const secure = this.config.secureCookies ? "; Secure" : "";
    return `flow_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${this.config.sessionTtlSeconds}${secure}`;
  }

  pruneUsedTickets(now = Math.floor(Date.now() / 1000)) {
    for (const [id, expiry] of this.usedTickets) if (expiry <= now) this.usedTickets.delete(id);
  }
}

export function createSecurityHeaders(config, contentType = "") {
  const frameAncestors = config.phpOrigin ? `'self' ${config.phpOrigin}` : "'none'";
  const headers = {
    "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${frameAncestors}`,
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  };
  if (config.production) headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  if (contentType) headers["Content-Type"] = contentType;
  return headers;
}

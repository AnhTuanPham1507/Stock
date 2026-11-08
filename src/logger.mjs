import { writeSync } from "node:fs";

export function log(level, event, fields = {}, { sync = false } = {}) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, pid: process.pid, ...fields });
  if (sync) writeSync(level === "info" ? 1 : 2, line + "\n");
  else console[level](line);
}

function redact(value, secrets) {
  if (typeof value !== "string") return undefined;
  for (const secret of secrets) {
    if (secret) value = value.replaceAll(secret, "[redacted]");
  }
  return value
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(/\bBearer[ \t]+\S+/gi, "Bearer [redacted]");
}

export function errorDetails(error, config = {}) {
  if (!(error instanceof Error)) return { type: typeof error };
  const secrets = [
    config.stocksApiKey, config.optionsApiKey, config.ssoSecret,
    process.env.MASSIVE_STOCKS_API_KEY, process.env.MASSIVE_OPTIONS_API_KEY, process.env.FLOW_SSO_SHARED_SECRET
  ];
  const describe = value => ({
    name: redact(value.name, secrets),
    message: redact(value.message, secrets)?.slice(0, 500),
    code: redact(value.code, secrets)
  });
  const frames = typeof error.stack === "string"
    ? error.stack.split("\n").filter(line => /^\s+at /.test(line)).slice(0, 12)
    : undefined;
  return {
    ...describe(error),
    stack: redact(frames?.join("\n"), secrets),
    cause: error.cause instanceof Error ? describe(error.cause) : undefined
  };
}

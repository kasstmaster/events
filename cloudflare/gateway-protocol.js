import {
  createHash,
  createHmac,
  timingSafeEqual,
  randomUUID,
} from "node:crypto";
import { Buffer } from "node:buffer";
import { configuredHosts } from "../server/household-domains.js";

export const upstreamOrigin = (value) => {
  if (!/^https:\/\/events\.[a-z0-9-]+\.workers\.dev$/.test(value || ""))
    throw new Error("Configure the verified, exact events workers.dev origin.");
  return value;
};
export function unavailable(status = 404) {
  return new Response(
    "<!doctype html><html lang=en><meta name=viewport content='width=device-width, initial-scale=1'><title>Household unavailable</title><h1>This household address is unavailable.</h1><p>Please check the link with your host.</p></html>",
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}
const forwardedHeaders = [
  "content-type",
  "if-match",
  "cookie",
  "origin",
  "x-events-client-ip",
];
async function digest(request) {
  if (!request.body) return createHash("sha256").update("").digest("hex");
  let size = 0;
  const hash = createHash("sha256");
  for await (const part of request.clone().body) {
    size += part.length;
    if (size > 8_000_000) throw new Error("Request too large");
    hash.update(part);
  }
  return hash.digest("hex");
}
async function signature(request, secret) {
  const url = new URL(request.url);
  const message = JSON.stringify([
    "events-gateway-v1",
    request.method,
    url.origin,
    url.pathname + url.search,
    request.headers.get("x-events-hostname"),
    request.headers.get("x-events-time"),
    request.headers.get("x-events-nonce"),
    forwardedHeaders.map((key) => [key, request.headers.get(key)]),
    await digest(request),
  ]);
  return createHmac("sha256", secret).update(message).digest("hex");
}
export async function forwardRequest(request, env) {
  const url = new URL(request.url);
  const hosts = configuredHosts(env.HOUSEHOLD_HOSTS);
  if (url.protocol !== "https:" || url.port || !hosts.has(url.hostname))
    return null;
  if (!["GET", "POST", "PUT", "DELETE"].includes(request.method)) return null;
  if (
    typeof env.EVENTS_GATEWAY_SECRET !== "string" ||
    env.EVENTS_GATEWAY_SECRET.length < 32
  )
    throw new Error("Gateway is not configured");
  // No caller-controlled destination, forwarding header or Authorization is propagated.
  const headers = new Headers();
  for (const key of forwardedHeaders)
    if (key !== "x-events-client-ip" && request.headers.has(key))
      headers.set(key, request.headers.get(key));
  headers.set(
    "x-events-client-ip",
    request.headers.get("CF-Connecting-IP") || "unknown",
  );
  headers.set("x-events-hostname", url.hostname);
  headers.set("x-events-time", String(Date.now()));
  headers.set("x-events-nonce", randomUUID());
  const target = new URL(upstreamOrigin(env.EVENTS_ORIGIN));
  target.pathname = url.pathname;
  target.search = url.search;
  const forwarded = new Request(target, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
    ...(request.body ? { duplex: "half" } : {}),
  });
  forwarded.headers.set(
    "x-events-signature",
    await signature(forwarded, env.EVENTS_GATEWAY_SECRET),
  );
  return forwarded;
}
export async function verifyRequest(request, env) {
  const hostname = request.headers.get("x-events-hostname");
  if (!hostname || !configuredHosts(env.HOUSEHOLD_HOSTS).has(hostname))
    return null;
  if (new URL(request.url).origin !== upstreamOrigin(env.EVENTS_ORIGIN))
    return null;
  if (
    typeof env.EVENTS_GATEWAY_SECRET !== "string" ||
    env.EVENTS_GATEWAY_SECRET.length < 32
  )
    return null;
  const time = request.headers.get("x-events-time"),
    nonce = request.headers.get("x-events-nonce");
  if (
    !/^\d{13}$/.test(time || "") ||
    Math.abs(Date.now() - Number(time)) > 60_000 ||
    !/^[a-f0-9-]{36}$/.test(nonce || "")
  )
    return null;
  const actual = request.headers.get("x-events-signature") || "";
  if (!/^[a-f0-9]{64}$/.test(actual)) return null;
  const expected = await signature(request, env.EVENTS_GATEWAY_SECRET);
  return timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex"),
  )
    ? hostname
    : null;
}

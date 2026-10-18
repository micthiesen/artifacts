// Notification channel adapters: validate user input into a stored config,
// and deliver one message through a stored config.

import { b64uDecode, b64uEncode, sendWebPush } from "./webpush.ts";

export type ChannelType = "pushover" | "ntfy" | "webhook" | "webpush";
export type NotifyEnv = {
  PUSHOVER_TOKEN?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
};
export type NotifyMessage = {
  title: string;
  body: string;
  url: string;
  /** collapse key, e.g. artifact id */
  tag?: string;
};
/** Error whose message is safe to show to the user. */
export class ChannelError extends Error {
  override name = "ChannelError";
}
export type SendResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      /** subscription/endpoint permanently gone: caller deletes the channel */
      gone?: boolean;
    };
export type PreparedChannel = {
  config: Record<string, unknown>;
  label: string;
  /** shown to the user once, e.g. ntfy subscribe URL or webhook signing secret */
  reveal?: string;
};

const TIMEOUT_MS = 10_000;
const enc = new TextEncoder();

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const timeout = () => AbortSignal.timeout(TIMEOUT_MS);
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = max - 1;
  // Do not split a surrogate pair.
  if (cut > 0 && /[\uD800-\uDBFF]/.test(s[cut - 1]!)) cut--;
  return `${s.slice(0, cut)}…`;
}

function randomToken(bytes: number): string {
  return b64uEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

function randomTopic(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  // 252 is the largest multiple of 36 below 256: rejection sampling keeps it uniform.
  let out = "";
  while (out.length < 24) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < 252 && out.length < 24) out += alphabet[b % 36];
    }
  }
  return `art-${out}`;
}

function errorText(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "TimeoutError" || e.name === "AbortError") return "Timed out";
    return e.message;
  }
  return String(e);
}

async function responseError(res: Response): Promise<string> {
  let detail = "";
  try {
    detail = (await res.text()).trim().slice(0, 200);
  } catch {}
  return `HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
}

// ---------- Pushover ----------

const PUSHOVER_API = "https://api.pushover.net/1";

async function pushoverErrors(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { errors?: unknown };
    if (Array.isArray(j.errors) && j.errors.length) return j.errors.map(String).join("; ");
  } catch {}
  return `HTTP ${res.status}`;
}

async function preparePushover(input: Record<string, unknown>, env: NotifyEnv): Promise<PreparedChannel> {
  const user = str(input.user);
  const ownToken = str(input.token);
  const device = str(input.device);
  if (!user || !/^[A-Za-z0-9]{30}$/.test(user)) throw new ChannelError("Pushover user key must be 30 letters and digits.");
  if (ownToken && !/^[A-Za-z0-9]{30}$/.test(ownToken))
    throw new ChannelError("Pushover app token must be 30 letters and digits.");
  if (device && !/^[A-Za-z0-9_-]{1,25}$/.test(device)) throw new ChannelError("Pushover device name is invalid.");
  const token = ownToken || env.PUSHOVER_TOKEN;
  if (!token) throw new ChannelError("Pushover needs an app token: create one at pushover.net/apps and paste it.");

  const form = new URLSearchParams({ token, user });
  if (device) form.set("device", device);
  let res: Response;
  try {
    res = await fetch(`${PUSHOVER_API}/users/validate.json`, { method: "POST", body: form, signal: timeout() });
  } catch (e) {
    throw new ChannelError(`Could not reach Pushover: ${errorText(e)}`);
  }
  let status: unknown;
  let errors = "";
  try {
    const j = (await res.json()) as { status?: unknown; errors?: unknown };
    status = j.status;
    if (Array.isArray(j.errors)) errors = j.errors.map(String).join("; ");
  } catch {}
  if (status !== 1) throw new ChannelError(`Pushover rejected this: ${errors || `HTTP ${res.status}`}`);

  const config: Record<string, unknown> = { user };
  if (ownToken) config.token = ownToken;
  if (device) config.device = device;
  return { config, label: `Pushover (…${user.slice(-4)}${device ? `, ${device}` : ""})` };
}

async function sendPushover(config: Record<string, unknown>, msg: NotifyMessage, env: NotifyEnv): Promise<SendResult> {
  const token = str(config.token) || env.PUSHOVER_TOKEN;
  const user = str(config.user);
  if (!token) return { ok: false, error: "No Pushover app token configured" };
  if (!user) return { ok: false, error: "Missing Pushover user key" };
  const form = new URLSearchParams({
    token,
    user,
    title: truncate(msg.title, 250),
    message: truncate(msg.body || msg.title, 1024),
    url: msg.url.slice(0, 512),
    url_title: "Open",
    html: "0",
  });
  const device = str(config.device);
  if (device) form.set("device", device);
  const res = await fetch(`${PUSHOVER_API}/messages.json`, { method: "POST", body: form, signal: timeout() });
  if (res.ok) return { ok: true };
  return { ok: false, error: `Pushover: ${await pushoverErrors(res)}` };
}

// ---------- ntfy ----------

/** RFC 2047 encoded-word for header values ntfy decodes (e.g. Title). ASCII passes through. */
export function encodeHeaderValue(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ");
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const bytes = enc.encode(clean);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}

function parseNtfyServer(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ChannelError("ntfy server must be a URL like https://ntfy.sh.");
  }
  if (u.protocol !== "https:") throw new ChannelError("ntfy server must use https.");
  if (isBlockedHost(u.hostname)) throw new ChannelError("ntfy server must be a public address.");
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username || u.password)
    throw new ChannelError("ntfy server must be just the server address, like https://ntfy.sh.");
  return u.origin;
}

async function prepareNtfy(input: Record<string, unknown>): Promise<PreparedChannel> {
  const server = parseNtfyServer(str(input.server) ?? "https://ntfy.sh");
  const topic = str(input.topic) ?? randomTopic();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic))
    throw new ChannelError("ntfy topic must be 1-64 letters, digits, '-' or '_'.");
  const token = str(input.token);
  if (token && !/^[\x21-\x7e]+$/.test(token)) throw new ChannelError("ntfy access token is invalid.");
  const config: Record<string, unknown> = { server, topic };
  if (token) config.token = token;
  const host = new URL(server).host;
  return {
    config,
    label: host === "ntfy.sh" ? `ntfy (${topic})` : `ntfy (${host}/${topic})`,
    reveal: `${server}/${topic}`,
  };
}

async function sendNtfy(config: Record<string, unknown>, msg: NotifyMessage): Promise<SendResult> {
  const server = str(config.server);
  const topic = str(config.topic);
  if (!server || !topic) return { ok: false, error: "Invalid ntfy channel" };
  const headers: Record<string, string> = {
    Title: encodeHeaderValue(msg.title),
    Click: new URL(msg.url).href,
    Tags: "speech_balloon",
    "Content-Type": "text/plain; charset=utf-8",
  };
  const token = str(config.token);
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${server}/${topic}`, {
    method: "POST",
    headers,
    body: msg.body || msg.title,
    redirect: "manual",
    signal: timeout(),
  });
  if (res.ok) return { ok: true };
  return { ok: false, error: `ntfy: ${await responseError(res)}` };
}

// ---------- Webhook ----------

function ipv4Private(host: string): boolean | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && Number(m[3]) === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function ipv6Private(host: string): boolean | null {
  if (!host.startsWith("[")) return null;
  const h = host.slice(1, -1).toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (h.startsWith("::ffff:")) return true; // IPv4-mapped: refuse rather than re-parse
  if (/^f[cd]/.test(h)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link local
  if (h.startsWith("ff")) return true; // multicast
  return false;
}

export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h || h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h === "local" || h === "internal") return true;
  const v4 = ipv4Private(h);
  if (v4 !== null) return v4;
  const v6 = ipv6Private(h);
  if (v6 !== null) return v6;
  if (!h.includes(".")) return true; // bare intranet names
  return false;
}

function isDiscordWebhook(u: URL): boolean {
  const host = u.hostname.toLowerCase();
  const discordHost = ["discord.com", "discordapp.com"].some((d) => host === d || host.endsWith(`.${d}`));
  return discordHost && u.pathname.startsWith("/api/webhooks/");
}

async function prepareWebhook(input: Record<string, unknown>): Promise<PreparedChannel> {
  const raw = str(input.url);
  if (!raw) throw new ChannelError("Webhook URL is required.");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ChannelError("Webhook URL is not a valid URL.");
  }
  if (u.protocol !== "https:") throw new ChannelError("Webhook URL must use https.");
  if (u.username || u.password) throw new ChannelError("Webhook URL must not contain credentials.");
  if (isBlockedHost(u.hostname)) throw new ChannelError("Webhook URL must point to a public host.");
  u.hash = "";
  const secret = randomToken(32);
  const discord = isDiscordWebhook(u);
  return {
    config: { url: u.href, secret },
    label: discord ? "Discord webhook" : `Webhook (${u.host})`,
    reveal: secret,
  };
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendWebhook(config: Record<string, unknown>, msg: NotifyMessage): Promise<SendResult> {
  const url = str(config.url);
  const secret = str(config.secret);
  if (!url) return { ok: false, error: "Invalid webhook channel" };
  const u = new URL(url);
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "Artifacts-Notify/1" };
  let body: string;
  if (isDiscordWebhook(u)) {
    body = JSON.stringify({
      content: truncate(`**${msg.title}**\n${msg.body}\n${msg.url}`, 2000),
      allowed_mentions: { parse: [] },
    });
  } else {
    body = JSON.stringify({
      title: msg.title,
      body: msg.body,
      url: msg.url,
      tag: msg.tag,
      sentAt: new Date().toISOString(),
    });
  }
  if (secret) headers["X-Artifacts-Signature"] = `sha256=${await hmacHex(secret, body)}`;
  const res = await fetch(url, { method: "POST", headers, body, signal: timeout(), redirect: "manual" });
  if (res.ok) return { ok: true };
  // Only the status: a webhook URL is anyone's, so its body isn't echoed back.
  return { ok: false, error: `Webhook: HTTP ${res.status}` };
}

// ---------- Web Push ----------

const PUSH_SERVICES: { match: (host: string) => boolean; name: string }[] = [
  { match: (h) => h === "fcm.googleapis.com", name: "Chrome" },
  { match: (h) => h.endsWith(".push.services.mozilla.com"), name: "Firefox" },
  { match: (h) => h === "web.push.apple.com", name: "Apple" },
  { match: (h) => h.endsWith(".notify.windows.com"), name: "Edge" },
];

const MAX_PUSH_PAYLOAD = 3000;

function decodeKey(v: unknown, len: number): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  try {
    const bytes = b64uDecode(s);
    if (bytes.length !== len || (len === 65 && bytes[0] !== 0x04)) return undefined;
    return b64uEncode(bytes);
  } catch {
    return undefined;
  }
}

async function prepareWebPush(input: Record<string, unknown>, env: NotifyEnv): Promise<PreparedChannel> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY)
    throw new ChannelError("Browser push is not configured on this server.");
  const endpoint = str(input.endpoint);
  if (!endpoint) throw new ChannelError("Push subscription endpoint is missing.");
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new ChannelError("Push subscription endpoint is not a valid URL.");
  }
  if (u.protocol !== "https:") throw new ChannelError("Push subscription endpoint must use https.");
  const service = PUSH_SERVICES.find((s) => s.match(u.hostname.toLowerCase()));
  if (!service) throw new ChannelError("This browser's push service is not supported.");
  const keys = (input.keys && typeof input.keys === "object" ? input.keys : {}) as Record<string, unknown>;
  const p256dh = decodeKey(keys.p256dh, 65);
  const auth = decodeKey(keys.auth, 16);
  if (!p256dh || !auth) throw new ChannelError("Push subscription keys are missing or invalid.");
  return { config: { endpoint: u.href, keys: { p256dh, auth } }, label: `Browser push (${service.name})` };
}

/** Topic header: up to 32 base64url characters. */
export function pushTopic(tag: string | undefined): string | undefined {
  if (!tag) return undefined;
  const t = tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  return t || undefined;
}

/** JSON payload for the service worker, trimmed so it stays under the push size budget. */
export function pushPayload(msg: NotifyMessage): string {
  const title = truncate(msg.title, 200);
  const make = (body: string) => JSON.stringify({ title, body, url: msg.url, tag: msg.tag });
  const fits = (json: string) => enc.encode(json).length <= MAX_PUSH_PAYLOAD;
  const full = make(msg.body);
  if (fits(full)) return full;
  // Longest prefix of the body (in UTF-16 units) that still fits once JSON-escaped.
  let lo = 0;
  let hi = msg.body.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(make(truncate(msg.body, mid)))) lo = mid;
    else hi = mid - 1;
  }
  return make(lo > 1 ? truncate(msg.body, lo) : "");
}

async function sendWebPushChannel(
  config: Record<string, unknown>,
  msg: NotifyMessage,
  env: NotifyEnv,
): Promise<SendResult> {
  const endpoint = str(config.endpoint);
  const keys = (config.keys ?? {}) as Record<string, unknown>;
  const p256dh = str(keys.p256dh);
  const auth = str(keys.auth);
  if (!endpoint || !p256dh || !auth) return { ok: false, error: "Invalid push subscription" };
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return { ok: false, error: "VAPID keys are not configured" };
  const res = await sendWebPush({ endpoint, keys: { p256dh, auth } }, pushPayload(msg), env, {
    ttl: 86400,
    urgency: "normal",
    topic: pushTopic(msg.tag),
    signal: timeout(),
  });
  if (res.ok) return { ok: true };
  if (res.status === 404 || res.status === 410)
    return { ok: false, error: `Push subscription expired (HTTP ${res.status})`, gone: true };
  return { ok: false, error: `Push service: ${await responseError(res)}` };
}

// ---------- Entry points ----------

/**
 * Validate + normalize user input for a new channel. Throws ChannelError with a
 * short user-facing message. May make network calls (Pushover validation).
 */
export async function prepareChannel(
  type: ChannelType,
  input: Record<string, unknown>,
  env: NotifyEnv,
): Promise<PreparedChannel> {
  switch (type) {
    case "pushover":
      return preparePushover(input, env);
    case "ntfy":
      return prepareNtfy(input);
    case "webhook":
      return prepareWebhook(input);
    case "webpush":
      return prepareWebPush(input, env);
    default:
      throw new ChannelError("Unknown channel type.");
  }
}

/** Deliver one message. Never throws; failures come back as `{ ok: false }`. */
export async function sendToChannel(
  type: ChannelType,
  config: Record<string, unknown>,
  msg: NotifyMessage,
  env: NotifyEnv,
): Promise<SendResult> {
  try {
    switch (type) {
      case "pushover":
        return await sendPushover(config, msg, env);
      case "ntfy":
        return await sendNtfy(config, msg);
      case "webhook":
        return await sendWebhook(config, msg);
      case "webpush":
        return await sendWebPushChannel(config, msg, env);
      default:
        return { ok: false, error: `Unknown channel type: ${String(type)}` };
    }
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

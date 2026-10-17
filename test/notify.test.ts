import { afterEach, expect, test } from "bun:test";
import {
  ChannelError,
  encodeHeaderValue,
  isBlockedHost,
  prepareChannel,
  pushPayload,
  pushTopic,
  sendToChannel,
  type NotifyEnv,
} from "../src/worker/notify.ts";
import { b64uEncode } from "../src/worker/webpush.ts";

type Call = { url: string; init: RequestInit; headers: Headers; body: string | Uint8Array };
const realFetch = globalThis.fetch;
let calls: Call[] = [];

function mockFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const b = init.body;
    const body =
      typeof b === "string"
        ? b
        : b instanceof URLSearchParams
          ? b.toString()
          : b instanceof Uint8Array || b instanceof ArrayBuffer
            ? new Uint8Array(b as ArrayBuffer)
            : "";
    calls.push({ url, init, headers: new Headers(init.headers), body });
    return respond(url, init);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const msg = { title: "New comment", body: "Ana: looks good", url: "https://artifacts.example/a/abc123", tag: "abc123" };
const USER = "uQiRzpo4DXghDmr9QzzfQu27cmVRsG";
const TOKEN = "azGDORePK8gMaC0QOYAMyEEuzJnyUi";

async function expectChannelError(p: Promise<unknown>, match: RegExp) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ChannelError);
    expect((e as Error).message).toMatch(match);
    return;
  }
  throw new Error("expected ChannelError");
}

// ---------- Pushover ----------

test("pushover prepare validates with the server token and stores no token", async () => {
  mockFetch(() => Response.json({ status: 1, devices: ["phone"] }));
  const r = await prepareChannel("pushover", { user: USER, device: "phone" }, { PUSHOVER_TOKEN: TOKEN });
  expect(calls[0]!.url).toBe("https://api.pushover.net/1/users/validate.json");
  expect(calls[0]!.init.method).toBe("POST");
  const form = new URLSearchParams(calls[0]!.body as string);
  expect(form.get("token")).toBe(TOKEN);
  expect(form.get("user")).toBe(USER);
  expect(form.get("device")).toBe("phone");
  expect(r.config).toEqual({ user: USER, device: "phone" });
  expect(r.label).toContain(USER.slice(-4));
});

test("pushover prepare prefers and stores the user's own token", async () => {
  mockFetch(() => Response.json({ status: 1 }));
  const own = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const r = await prepareChannel("pushover", { user: USER, token: own }, { PUSHOVER_TOKEN: TOKEN });
  expect(new URLSearchParams(calls[0]!.body as string).get("token")).toBe(own);
  expect(r.config).toEqual({ user: USER, token: own });
});

test("pushover prepare errors", async () => {
  mockFetch(() => Response.json({ status: 0, errors: ["user key is invalid"] }, { status: 400 }));
  await expectChannelError(prepareChannel("pushover", { user: USER }, {}), /app token/);
  await expectChannelError(prepareChannel("pushover", { user: "short" }, { PUSHOVER_TOKEN: TOKEN }), /30/);
  await expectChannelError(
    prepareChannel("pushover", { user: USER }, { PUSHOVER_TOKEN: TOKEN }),
    /user key is invalid/,
  );
});

test("pushover send shape", async () => {
  mockFetch(() => Response.json({ status: 1 }));
  const r = await sendToChannel("pushover", { user: USER }, msg, { PUSHOVER_TOKEN: TOKEN });
  expect(r).toEqual({ ok: true });
  expect(calls[0]!.url).toBe("https://api.pushover.net/1/messages.json");
  const form = new URLSearchParams(calls[0]!.body as string);
  expect(Object.fromEntries(form)).toEqual({
    token: TOKEN,
    user: USER,
    title: msg.title,
    message: msg.body,
    url: msg.url,
    url_title: "Open",
    html: "0",
  });
  expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);

  mockFetch(() => Response.json({ status: 0, errors: ["user key is invalid"] }, { status: 400 }));
  const bad = await sendToChannel("pushover", { user: USER }, msg, { PUSHOVER_TOKEN: TOKEN });
  expect(bad.ok).toBe(false);
  expect(bad.ok === false && bad.gone).toBeFalsy();
  expect(bad.ok === false && bad.error).toContain("user key is invalid");
});

// ---------- ntfy ----------

test("ntfy prepare generates a topic and reveals the subscribe URL", async () => {
  const r = await prepareChannel("ntfy", {}, {});
  expect(r.config.server).toBe("https://ntfy.sh");
  expect(r.config.topic).toMatch(/^art-[a-z0-9]{24}$/);
  expect(r.reveal).toBe(`https://ntfy.sh/${r.config.topic}`);

  const custom = await prepareChannel("ntfy", { server: "https://ntfy.example.com/", topic: "my_Topic-1", token: "tk_x" }, {});
  expect(custom.config).toEqual({ server: "https://ntfy.example.com", topic: "my_Topic-1", token: "tk_x" });
  expect(custom.reveal).toBe("https://ntfy.example.com/my_Topic-1");
});

test("ntfy prepare errors", async () => {
  await expectChannelError(prepareChannel("ntfy", { topic: "bad topic!" }, {}), /topic/);
  await expectChannelError(prepareChannel("ntfy", { topic: "x".repeat(65) }, {}), /topic/);
  await expectChannelError(prepareChannel("ntfy", { server: "http://ntfy.sh" }, {}), /https/);
  await expectChannelError(prepareChannel("ntfy", { server: "https://ntfy.sh/some/path" }, {}), /server/);
});

test("ntfy send shape", async () => {
  mockFetch(() => new Response("{}"));
  const r = await sendToChannel("ntfy", { server: "https://ntfy.sh", topic: "art-x", token: "tk_1" }, msg, {});
  expect(r).toEqual({ ok: true });
  const c = calls[0]!;
  expect(c.url).toBe("https://ntfy.sh/art-x");
  expect(c.init.method).toBe("POST");
  expect(c.body).toBe(msg.body);
  expect(c.headers.get("Title")).toBe(msg.title);
  expect(c.headers.get("Click")).toBe(msg.url);
  expect(c.headers.get("Tags")).toBe("speech_balloon");
  expect(c.headers.get("Authorization")).toBe("Bearer tk_1");
});

test("ntfy non-ASCII titles use RFC 2047", async () => {
  expect(encodeHeaderValue("plain title")).toBe("plain title");
  const encoded = encodeHeaderValue("Café ✓ 🍉");
  expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  const b64 = encoded.slice("=?UTF-8?B?".length, -2);
  expect(new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)))).toBe("Café ✓ 🍉");

  mockFetch(() => new Response("{}"));
  await sendToChannel("ntfy", { server: "https://ntfy.sh", topic: "t" }, { ...msg, title: "Café ✓" }, {});
  expect(calls[0]!.headers.get("Title")).toMatch(/^=\?UTF-8\?B\?/);
  expect(calls[0]!.headers.get("Authorization")).toBeNull();
});

// ---------- Webhook ----------

test("webhook prepare validates the URL and reveals a secret", async () => {
  const r = await prepareChannel("webhook", { url: "https://hooks.example.com/in/1" }, {});
  expect(r.config.url).toBe("https://hooks.example.com/in/1");
  expect(r.config.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(r.reveal).toBe(r.config.secret as string);

  for (const url of [
    "http://hooks.example.com/x",
    "https://127.0.0.1/x",
    "https://10.1.2.3/x",
    "https://192.168.0.5/x",
    "https://172.20.0.1/x",
    "https://169.254.169.254/latest",
    "https://localhost/x",
    "https://printer.local/x",
    "https://svc.internal/x",
    "https://[::1]/x",
    "https://[fd00::1]/x",
    "not a url",
  ]) {
    await expectChannelError(prepareChannel("webhook", { url }, {}), /.+/);
  }
  expect(isBlockedHost("8.8.8.8")).toBe(false);
  expect(isBlockedHost("172.32.0.1")).toBe(false);
});

test("webhook send is signed JSON", async () => {
  mockFetch(() => new Response(null, { status: 204 }));
  const secret = "s3cret";
  const r = await sendToChannel("webhook", { url: "https://hooks.example.com/in", secret }, msg, {});
  expect(r).toEqual({ ok: true });
  const c = calls[0]!;
  expect(c.headers.get("Content-Type")).toBe("application/json");
  const payload = JSON.parse(c.body as string);
  expect(payload).toMatchObject({ title: msg.title, body: msg.body, url: msg.url, tag: msg.tag });
  expect(new Date(payload.sentAt).toISOString()).toBe(payload.sentAt);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(c.body as string)));
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  expect(c.headers.get("X-Artifacts-Signature")).toBe(`sha256=${hex}`);

  mockFetch(() => new Response("nope", { status: 500 }));
  const bad = await sendToChannel("webhook", { url: "https://hooks.example.com/in", secret }, msg, {});
  expect(bad).toEqual({ ok: false, error: "Webhook: HTTP 500: nope" });
});

test("discord webhooks get Discord's message shape", async () => {
  const r = await prepareChannel("webhook", { url: "https://discord.com/api/webhooks/1/abc" }, {});
  expect(r.label).toBe("Discord webhook");
  mockFetch(() => new Response(null, { status: 204 }));
  await sendToChannel("webhook", r.config, msg, {});
  expect(JSON.parse(calls[0]!.body as string)).toEqual({
    content: `**${msg.title}**\n${msg.body}\n${msg.url}`,
    allowed_mentions: { parse: [] },
  });
});

// ---------- Web Push ----------

async function vapidEnv(): Promise<NotifyEnv> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    VAPID_PUBLIC_KEY: b64uEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey("jwk", pair.privateKey)).d!,
    VAPID_SUBJECT: "mailto:ops@example.com",
  };
}

async function subscription(endpoint: string) {
  const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  return {
    endpoint,
    keys: {
      p256dh: b64uEncode(new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey))),
      auth: b64uEncode(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
}

test("webpush prepare validates the subscription", async () => {
  const env = await vapidEnv();
  const apple = await subscription("https://web.push.apple.com/QGuQyavXutnMH");
  const r = await prepareChannel("webpush", apple, env);
  expect(r.label).toBe("Browser push (Apple)");
  expect(r.config).toEqual(apple);
  expect((await prepareChannel("webpush", await subscription("https://fcm.googleapis.com/fcm/send/x"), env)).label).toBe(
    "Browser push (Chrome)",
  );
  expect(
    (await prepareChannel("webpush", await subscription("https://updates.push.services.mozilla.com/wpush/v2/x"), env))
      .label,
  ).toBe("Browser push (Firefox)");
  expect(
    (await prepareChannel("webpush", await subscription("https://wns2-par02p.notify.windows.com/w/?token=x"), env))
      .label,
  ).toBe("Browser push (Edge)");

  await expectChannelError(prepareChannel("webpush", apple, {}), /not configured/);
  await expectChannelError(
    prepareChannel("webpush", await subscription("https://evil.example.com/push"), env),
    /not supported/,
  );
  await expectChannelError(
    prepareChannel("webpush", await subscription("http://fcm.googleapis.com/fcm/send/x"), env),
    /https/,
  );
  await expectChannelError(prepareChannel("webpush", { ...apple, keys: { p256dh: "AAAA", auth: "x" } }, env), /keys/);
});

test("webpush send shape", async () => {
  const env = await vapidEnv();
  const sub = await subscription("https://fcm.googleapis.com/fcm/send/abc");
  mockFetch(() => new Response(null, { status: 201 }));
  const r = await sendToChannel("webpush", sub, { ...msg, tag: "art:abc/123" }, env);
  expect(r).toEqual({ ok: true });
  const c = calls[0]!;
  expect(c.url).toBe(sub.endpoint);
  expect(c.headers.get("TTL")).toBe("86400");
  expect(c.headers.get("Urgency")).toBe("normal");
  expect(c.headers.get("Topic")).toBe("artabc123");
  expect(c.headers.get("Content-Encoding")).toBe("aes128gcm");
  expect(c.headers.get("Authorization")).toMatch(
    new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${env.VAPID_PUBLIC_KEY}$`),
  );
  const body = c.body as Uint8Array;
  expect(body.length).toBeGreaterThan(86 + 16);
});

test("webpush 404/410 marks the channel gone", async () => {
  const env = await vapidEnv();
  const sub = await subscription("https://web.push.apple.com/x");
  for (const status of [404, 410]) {
    mockFetch(() => new Response("gone", { status }));
    const r = await sendToChannel("webpush", sub, msg, env);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.gone).toBe(true);
  }
  mockFetch(() => new Response("slow down", { status: 429 }));
  const r = await sendToChannel("webpush", sub, msg, env);
  expect(r.ok === false && r.gone).toBeFalsy();
});

test("push topic and payload limits", () => {
  expect(pushTopic(undefined)).toBeUndefined();
  expect(pushTopic("!!!")).toBeUndefined();
  expect(pushTopic("a".repeat(40))).toBe("a".repeat(32));
  const big = pushPayload({ ...msg, body: "é".repeat(5000) });
  expect(new TextEncoder().encode(big).length).toBeLessThanOrEqual(3000);
  expect(JSON.parse(big).body.endsWith("…")).toBe(true);
  expect(JSON.parse(pushPayload(msg))).toEqual(msg);
});

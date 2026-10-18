// Passkeys end to end through the Worker, with a software authenticator: the
// offer after a code sign-in, saving one, signing in with it (straight into a
// workspace), and the ways a response must be refused.
import { beforeEach, expect, test } from "bun:test";
import { ADMIN, createHub, FakeKV, type Harness } from "./support/do-harness.ts";
import { softAuthenticator } from "./support/authenticator.ts";

const { default: worker } = await import("../src/worker/index.ts");
const { passkeyName } = await import("../src/worker/passkeys.ts");

let h: Harness;
let env: Record<string, unknown>;
let mail: { to: string; text: string }[];
const APEX = "https://artifacts.test";
const ACME = "https://acme.artifacts.test";
const MIA = "mia@corp.com";
const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

beforeEach(async () => {
  h = await createHub();
  await h.hub.setMember(MIA, "member", ADMIN);
  mail = [];
  env = {
    ...h.env,
    WORKSPACE: { getByName: (slug: string) => (slug === "acme" ? h.hub : null) },
    OAUTH_KV: new FakeKV(),
    EMAIL: { send: async (m: { to: string; text: string }) => void mail.push(m) },
    CONSENT_SECRET: "test-consent-secret-that-is-long-enough",
    OPERATOR_TOKEN: "op-token",
    OPERATOR_EMAILS: "op@corp.com",
    APEX_HOST: "artifacts.test",
    WORKSPACE_SUFFIX: ".artifacts.test",
    MAIL_FROM: "sign-in@mail.artifacts.test",
  };
});

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

function fetchAs(url: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("Cookie", init.cookie);
  if (init.method && init.method !== "GET" && !headers.has("Origin")) headers.set("Origin", new URL(url).origin);
  return worker.fetch(new Request(url, { ...init, headers, redirect: "manual" }), env as never, ctx);
}

const json = (body: unknown, cookie?: string) => ({ method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", "User-Agent": SAFARI_MAC }, cookie });
const sessionOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-art_session="));

/** A code sign-in on the apex, as a browser that hasn't dismissed the passkey offer. */
async function codeSignIn(to = "", n = "") {
  const form = (fields: Record<string, string>) => new URLSearchParams({ to, n, return: "/", ...fields });
  await fetchAs(`${APEX}/login`, { method: "POST", body: form({ email: MIA }) });
  const code = /\b(\d{8})\b/.exec(mail.at(-1)!.text)![1];
  return fetchAs(`${APEX}/login`, { method: "POST", body: form({ email: MIA, code }) });
}

async function savePasskey(cookie: string) {
  const device = await softAuthenticator(APEX);
  const { options, token } = await (await fetchAs(`${APEX}/api/me/passkeys/options`, json({}, cookie))).json();
  expect(options.rp.id).toBe("artifacts.test");
  expect(options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
  const saved = await fetchAs(`${APEX}/api/me/passkeys`, json({ token, response: await device.create(options) }, cookie));
  expect(saved.status).toBe(200);
  return device;
}

async function passkeySignIn(device: Awaited<ReturnType<typeof softAuthenticator>>, extra: Record<string, string> = {}) {
  const { options, token } = await (await fetchAs(`${APEX}/login/passkey/options`, json({}))).json();
  const response = await device.get(options);
  return { res: await fetchAs(`${APEX}/login/passkey`, json({ token, response, return: "/", ...extra })), token, response };
}

test("after a code, the apex offers a passkey; 'Not now' is remembered", async () => {
  const offered = await codeSignIn();
  expect(offered.status).toBe(200);
  const html = await offered.text();
  expect(html).toContain("Skip the email next time");
  expect(html).toContain('data-next="/"');
  expect(sessionOf(offered)).toBeTruthy();
  // On the way to a workspace, continuing goes back through /login for a fresh hand-off.
  const start = await fetchAs(`${ACME}/login?return=/`);
  const n = new URL(start.headers.get("Location")!).searchParams.get("n")!;
  const towards = await (await codeSignIn(ACME, n)).text();
  expect(towards).toContain(`data-next="/login?to=${encodeURIComponent(ACME)}&amp;n=${n}&amp;return=%2F"`);
});

test("save a passkey, then sign in with it straight into a workspace", async () => {
  const cookie = sessionOf(await codeSignIn())!;
  const device = await savePasskey(cookie);
  const me = await (await fetchAs(`${APEX}/api/me`, { cookie })).json();
  expect(me.passkeys).toEqual([expect.objectContaining({ id: device.id, name: "Safari on Mac", lastUsedAt: null })]);

  const start = await fetchAs(`${ACME}/login?return=/settings`);
  const n = new URL(start.headers.get("Location")!).searchParams.get("n")!;
  const nonceCookie = start.headers.get("Set-Cookie")!.split(";")[0];
  const sentBefore = mail.length;
  const { res } = await passkeySignIn(device, { to: ACME, n, return: "/settings" });
  expect(res.status).toBe(200);
  const { location } = await res.json();
  expect(location).toStartWith(`${ACME}/auth/callback?code=`);
  expect(sessionOf(res)).toBeTruthy();
  expect(mail.length).toBe(sentBefore);
  const callback = await fetchAs(location, { cookie: nonceCookie });
  expect(callback.headers.get("Location")).toBe("/settings");
  expect((await (await fetchAs(`${APEX}/api/me`, { cookie })).json()).passkeys[0].lastUsedAt).not.toBeNull();
});

test("a passkey response works once, only for this site, and not after it's removed", async () => {
  const cookie = sessionOf(await codeSignIn())!;
  const device = await savePasskey(cookie);

  const { res, token, response } = await passkeySignIn(device);
  expect(res.status).toBe(200);
  expect((await res.json()).location).toBe("/");
  // Replaying the same response (and challenge) is refused.
  const replay = await fetchAs(`${APEX}/login/passkey`, json({ token, response }));
  expect(replay.status).toBe(400);
  expect(sessionOf(replay)).toBeUndefined();

  // Signed for a look-alike origin: refused.
  const { options, token: t2 } = await (await fetchAs(`${APEX}/login/passkey/options`, json({}))).json();
  const phished = await fetchAs(`${APEX}/login/passkey`, json({ token: t2, response: await device.get(options, "https://artifacts.test.evil.com") }));
  expect(phished.status).toBe(400);

  // A challenge token from registration can't be used to sign in.
  const reg = await (await fetchAs(`${APEX}/api/me/passkeys/options`, json({}, cookie))).json();
  const wrongKind = await fetchAs(`${APEX}/login/passkey`, json({ token: reg.token, response: await device.get({ challenge: reg.options.challenge, rpId: "artifacts.test" }) }));
  expect(wrongKind.status).toBe(400);

  // Cross-site posts are refused before anything is checked.
  const crossSite = await fetchAs(`${APEX}/login/passkey/options`, { ...json({}), headers: { Origin: "https://evil.example" } });
  expect(crossSite.status).toBe(403);

  const removed = await fetchAs(`${APEX}/api/me/passkeys/${device.id}`, { method: "DELETE", cookie });
  expect(await removed.json()).toEqual({ removed: true });
  const after = (await passkeySignIn(device)).res;
  expect(after.status).toBe(400);
  expect((await after.json()).error).toContain("isn't saved on this site");
});

test("once someone has a passkey, a code sign-in goes straight on", async () => {
  const cookie = sessionOf(await codeSignIn())!;
  await savePasskey(cookie);
  const again = await codeSignIn();
  expect(again.status).toBe(303);
  expect(again.headers.get("Location")).toBe("/");
});

test("saving needs a session, and the same passkey can't be saved twice", async () => {
  expect((await fetchAs(`${APEX}/api/me/passkeys/options`, json({}))).status).toBe(401);
  const cookie = sessionOf(await codeSignIn())!;
  const device = await softAuthenticator(APEX);
  const first = await (await fetchAs(`${APEX}/api/me/passkeys/options`, json({}, cookie))).json();
  const created = await device.create(first.options);
  expect((await fetchAs(`${APEX}/api/me/passkeys`, json({ token: first.token, response: created }, cookie))).status).toBe(200);
  const second = await (await fetchAs(`${APEX}/api/me/passkeys/options`, json({}, cookie))).json();
  expect(second.options.excludeCredentials).toEqual([expect.objectContaining({ id: device.id })]);
  const again = await fetchAs(`${APEX}/api/me/passkeys`, json({ token: second.token, response: await device.create(second.options) }, cookie));
  expect(again.status).toBe(400);
  expect((await again.json()).error).toContain("already saved");
});

test("passkeys are named after the password manager, else the device and browser", () => {
  expect(passkeyName("fbfc3007-154e-4ecc-8c0b-6e020557d7bd", SAFARI_MAC)).toBe("iCloud Keychain");
  expect(passkeyName("00000000-0000-0000-0000-000000000000", SAFARI_MAC)).toBe("Safari on Mac");
  expect(passkeyName("00000000-0000-0000-0000-000000000000", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toBe("Chrome on Windows");
  expect(passkeyName("00000000-0000-0000-0000-000000000000", "")).toBe("Passkey");
});

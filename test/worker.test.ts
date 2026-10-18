// The Worker end to end, in process: email sign-in on the apex, the hand-off to
// a workspace, host-bound sessions, settings, and agent tokens on /mcp.
import { beforeEach, expect, test } from "bun:test";
import { ADMIN, createHub, FakeKV, type Harness } from "./support/do-harness.ts";

const { default: worker, slugOf, isTestAddress } = await import("../src/worker/index.ts");

let h: Harness;
let env: Record<string, unknown>;
let mail: { to: string; subject: string; text: string }[];
const APEX = "https://artifacts.test";
const ACME = "https://acme.artifacts.test";
const MIA = "mia@corp.com";

beforeEach(async () => {
  h = await createHub();
  await h.hub.setMember(MIA, "member", ADMIN);
  mail = [];
  env = {
    ...h.env,
    WORKSPACE: { getByName: (slug: string) => (slug === "acme" ? h.hub : null) },
    OAUTH_KV: new FakeKV(),
    EMAIL: { send: async (m: { to: string; subject: string; text: string }) => void mail.push(m) },
    CONSENT_SECRET: "test-consent-secret-that-is-long-enough",
    OPERATOR_TOKEN: "op-token",
    OPERATOR_EMAILS: "op@corp.com",
    APEX_HOST: "artifacts.test",
    WORKSPACE_SUFFIX: ".artifacts.test",
    MAIL_FROM: "sign-in@mail.artifacts.test",
  };
});

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

async function fetchAs(url: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("Cookie", init.cookie);
  if (init.method && init.method !== "GET" && !headers.has("Origin")) headers.set("Origin", new URL(url).origin);
  return worker.fetch(new Request(url, { ...init, headers, redirect: "manual" }), env as never, ctx);
}

/** Where a response sends the browser: a redirect, or a continue page's meta refresh. */
async function nextUrl(res: Response): Promise<string> {
  const location = res.headers.get("Location");
  if (location) return location;
  const html = await res.clone().text();
  return /http-equiv="refresh" content="0;url=([^"]+)"/.exec(html)![1].replace(/&amp;/g, "&");
}

function cookieOf(res: Response): string {
  const set = res.headers.get("Set-Cookie") ?? "";
  return set.split(";")[0];
}

/**
 * Sign in on the apex with an emailed code. With `to`, start from that workspace's
 * /login (as a browser would) and finish its hand-off. Returns the apex cookie,
 * where the apex sent us, and the workspace cookie when there was a hand-off.
 */
async function signIn(email: string, to = "", ret = "/") {
  let n = "";
  let nonceCookie = "";
  if (to) {
    const start = await fetchAs(`${to}/login?return=${encodeURIComponent(ret)}`);
    n = new URL(start.headers.get("Location")!).searchParams.get("n")!;
    nonceCookie = cookieOf(start);
  }
  const form = (fields: Record<string, string>) => new URLSearchParams({ to, n, return: ret, ...fields });
  const sent = await fetchAs(`${APEX}/login`, { method: "POST", body: form({ email }) });
  expect(sent.status).toBe(200);
  const code = /\b(\d{8})\b/.exec(mail.at(-1)!.text)![1];
  // Having said "Not now" to passkeys, so the code leads straight on (the offer is tested in passkeys.test.ts).
  const done = await fetchAs(`${APEX}/login`, { method: "POST", body: form({ email, code }), cookie: "art_passkey_later=1" });
  // Straight to a page here, or a continue page on the way to a workspace.
  expect(done.status).toBe(to ? 200 : 303);
  const location = await nextUrl(done);
  const apexCookie = done.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-art_session="))!;
  return { cookie: apexCookie, location, nonceCookie };
}

test("hosts map to workspaces; unknown ones never reach a Durable Object", async () => {
  expect(slugOf("acme.artifacts.test", env as never)).toBe("acme");
  expect(slugOf("www.artifacts.test", env as never)).toBeNull();
  expect(slugOf("a.b.artifacts.test", env as never)).toBeNull();
  const res = await fetchAs("https://nope.artifacts.test/");
  expect(res.status).toBe(404);
  expect(await res.text()).toContain("No such workspace");
});

test("signed out, the apex shows the splash page, with the examples and the wordmark", async () => {
  const res = await fetchAs(`${APEX}/`);
  const html = await res.text();
  expect(html).toContain("Collaborative documents and little apps");
  expect(html).toContain('href="/login"');
  expect(html).toContain('artifacts<span class="wordmark-tld">.boo</span>');
  for (const slug of ["launch-plan", "retro", "costs"]) {
    expect(html).toContain(`id="tab-${slug}"`);
    expect(html).toMatch(new RegExp(`<iframe sandbox="allow-scripts[^"]*"[^>]* data-src="/demo/${slug}\\?v=`));
  }
  expect(html).not.toContain("allow-same-origin");
  const seed = JSON.parse(/<script type="application\/json" id="demo-seed">(.*?)<\/script>/.exec(html)![1]);
  expect(seed["launch-plan"].length).toBeGreaterThan(0);
  // The splash and the policies may be indexed; everything else stays out.
  expect(res.headers.get("X-Robots-Tag")).toBe("all");
  expect((await fetchAs(`${APEX}/privacy`)).headers.get("X-Robots-Tag")).toBe("all");
  expect((await fetchAs(`${APEX}/login`)).headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  expect(await (await fetchAs(`${APEX}/robots.txt`)).text()).toBe("User-agent: *\nAllow: /$\nAllow: /privacy\nAllow: /terms\nAllow: /security\nAllow: /pricing\nDisallow: /\n");
  expect(await (await fetchAs(`${ACME}/robots.txt`)).text()).toBe("User-agent: *\nDisallow: /\n");
});

test("email sign-in hands the browser to the workspace, which sets its own session", async () => {
  const start = await fetchAs(`${ACME}/a/xyz`);
  expect(start.headers.get("Location")).toBe(`${ACME}/login?return=%2Fa%2Fxyz`);
  const bounce = await fetchAs(`${ACME}/login?return=/`);
  const login = new URL(bounce.headers.get("Location")!);
  expect(login.origin + login.pathname).toBe(`${APEX}/login`);
  expect(login.searchParams.get("to")).toBe(ACME);

  const { cookie: apexCookie, location, nonceCookie } = await signIn(MIA, ACME, "/");
  expect(mail[0]).toMatchObject({ to: MIA });
  expect(location).toStartWith(`${ACME}/auth/callback?code=`);
  // The hand-off only works in the browser that started it.
  expect((await fetchAs(location)).status).toBe(400);
  const callback = await fetchAs(location, { cookie: nonceCookie });
  expect(callback.headers.get("Location")).toBe("/");
  const acmeCookie = cookieOf(callback);

  // Each host's session is its own: the apex cookie means nothing on the workspace and vice versa.
  expect(await (await fetchAs(`${ACME}/`, { cookie: acmeCookie })).text()).toContain("Nothing here yet");
  // Without its own session, a workspace's front page goes straight to the hand-off, like every other page.
  expect((await fetchAs(`${ACME}/`, { cookie: apexCookie })).headers.get("Location")).toBe(`${ACME}/login?return=%2F`);
  expect((await fetchAs(`${ACME}/archived`)).headers.get("Location")).toBe(`${ACME}/login?return=%2Farchived`);
  // The apex front page is the splash for everyone; signed in, it links to your workspaces.
  const front = await (await fetchAs(`${APEX}/`, { cookie: apexCookie })).text();
  expect(front).toContain("Collaborative documents");
  expect(front).toContain('href="/workspaces">Your workspaces</a>');
  expect(front).toContain(`data-email="${MIA}"`);
  const home = await (await fetchAs(`${APEX}/workspaces`, { cookie: apexCookie })).text();
  expect(home).toContain("Your workspaces");
  expect(home).toContain(`${ACME}/`);
  const signedOut = await fetchAs(`${APEX}/workspaces`, { cookie: acmeCookie });
  expect(signedOut.headers.get("Location")).toBe(`${APEX}/login?return=/workspaces`);
  expect(await (await fetchAs(`${APEX}/`, { cookie: acmeCookie })).text()).toContain('href="/login">Sign in</a>');

  // Already signed in on the apex: the next workspace hand-off needs no code.
  const again = await fetchAs(`${APEX}/login?to=${encodeURIComponent(ACME)}&return=/settings`, { cookie: apexCookie });
  expect(again.headers.get("Location")).toStartWith(`${ACME}/auth/callback?code=`);
});

test("signing in on the apex itself ends at your workspaces unless told otherwise", async () => {
  expect((await signIn(MIA, "", "")).location).toBe("/workspaces");
  expect((await signIn(MIA, "", "/me")).location).toBe("/me");
});

test("a wrong code is refused and nothing is signed in", async () => {
  await fetchAs(`${APEX}/login`, { method: "POST", body: new URLSearchParams({ email: MIA, to: "", return: "/" }) });
  const res = await fetchAs(`${APEX}/login`, { method: "POST", body: new URLSearchParams({ email: MIA, code: "12345x", to: "", return: "/" }) });
  expect(res.status).toBe(400);
  expect(res.headers.get("Set-Cookie")).toBeNull();
  // Cross-site posts are refused outright.
  expect((await fetchAs(`${APEX}/login`, { method: "POST", headers: { Origin: "https://evil.test" }, body: new URLSearchParams({ email: MIA }) })).status).toBe(403);
});

test("hand-offs only go to workspace origins", async () => {
  const { cookie } = await signIn(MIA);
  for (const to of ["https://evil.test", "http://acme.artifacts.test", "https://acme.artifacts.test.evil.test"]) {
    const res = await fetchAs(`${APEX}/login?to=${encodeURIComponent(to)}&return=/`, { cookie });
    expect(res.headers.get("Location")).toBe("/");
  }
});

test("members create agent tokens in settings and use them on /mcp", async () => {
  const { location, nonceCookie } = await signIn(MIA, ACME);
  const cookie = (await fetchAs(location, { cookie: nonceCookie })).headers.getSetCookie()[0].split(";")[0];
  const settings = (await (await fetchAs(`${ACME}/api/settings`, { cookie })).json()) as any;
  expect(settings).toMatchObject({ you: { email: MIA, role: "member" }, mcpUrl: `${ACME}/mcp` });
  const created = (await (
    await fetchAs(`${ACME}/api/settings/tokens`, { method: "POST", cookie, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "cli" }) })
  ).json()) as { token: string };
  // Members can't add members.
  const add = await fetchAs(`${ACME}/api/settings/members`, { method: "POST", cookie, body: JSON.stringify({ email: "x@corp.com", role: "member" }) });
  expect(add.status).toBe(403);

  const rpc = (token: string, body: unknown) =>
    fetchAs(`${ACME}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: "" }, body: JSON.stringify(body) });
  const create = await rpc(created.token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "artifact_create", arguments: { title: "Via MCP", files: { "index.md": "# Hi\n" } } } });
  expect(create.status).toBe(200);
  const result = ((await create.json()) as any).result;
  expect(result.isError).toBe(false);
  expect(h.hub.meta(result.structuredContent.id)!.owner).toBe(MIA);
  expect(result.structuredContent.url).toStartWith(`${ACME}/a/`);

  const anonymous = await rpc("nope", { jsonrpc: "2.0", id: 2, method: "tools/list" });
  expect(anonymous.status).toBe(401);
  expect(anonymous.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  const metadata = (await (await fetchAs(`${ACME}/.well-known/oauth-protected-resource/mcp`)).json()) as any;
  expect(metadata.resource).toBe(`${ACME}/mcp`);

  // Leaving the workspace ends the token.
  await h.hub.setMember(MIA, null, ADMIN);
  expect((await rpc(created.token, { jsonrpc: "2.0", id: 3, method: "tools/list" })).status).toBe(401);
});

test("the operator API needs the operator token or an operator's session", async () => {
  expect((await fetchAs(`${APEX}/api/admin/workspaces`)).status).toBe(403);
  const list = await fetchAs(`${APEX}/api/admin/workspaces`, { headers: { Authorization: "Bearer op-token" } });
  expect(((await list.json()) as any).workspaces.map((w: any) => w.slug)).toEqual(["acme"]);
  const { cookie } = await signIn("op@corp.com");
  expect((await fetchAs(`${APEX}/api/admin/workspaces`, { cookie })).status).toBe(200);
  expect((await fetchAs(`${APEX}/admin`, { cookie })).status).toBe(200);
  const { cookie: other } = await signIn(MIA);
  expect((await fetchAs(`${APEX}/api/admin/workspaces`, { cookie: other })).status).toBe(403);
});

test("operator test identities are limited to addresses nobody can own", async () => {
  for (const ok of ["e2e@example.com", "a@b.example.org", "x@corp.test", "y@q.invalid"]) expect(isTestAddress(ok)).toBe(true);
  for (const bad of ["michael@thiesen.dev", "a@example.com.evil.dev", "a@notexample.com", "a@test"]) expect(isTestAddress(bad)).toBe(false);
  const op = { Authorization: "Bearer op-token", "Content-Type": "application/json" };
  const refused = await fetchAs(`${APEX}/api/admin/session`, { method: "POST", headers: op, body: JSON.stringify({ email: MIA, host: "acme.artifacts.test" }) });
  expect(refused.status).toBe(400);
  const ok = (await (
    await fetchAs(`${APEX}/api/admin/session`, { method: "POST", headers: op, body: JSON.stringify({ email: "e2e@example.com", host: "acme.artifacts.test" }) })
  ).json()) as { cookie: string };
  expect(await (await fetchAs(`${ACME}/`, { cookie: ok.cookie })).text()).toContain("Nothing here yet");
});

test("return paths can't leave the site", async () => {
  const { safeNext } = await import("../src/worker/index.ts");
  for (const bad of ["//evil.test", "/\\evil.test", "/\tevil.test", "https://evil.test", "/%0a/evil", "javascript:alert(1)", ""]) {
    expect(safeNext(bad)).toBe(bad === "/%0a/evil" ? "/%0a/evil" : "/");
  }
  expect(safeNext("/a/x?y=1#t")).toBe("/a/x?y=1#t");
});

test("a presigned link opens its artifact and nothing else, even for an owner", async () => {
  const id = (await h.hub.create({ title: "Linked", files: { "index.md": "# Hi\n" }, owner: MIA })).ok && h.hub.list(MIA)[0].id;
  const { signToken } = await import("../src/worker/session.ts");
  const code = await signToken(h.env.LOGIN_SECRET, "link", 600, { e: MIA, a: id, w: "acme" });
  const opened = await fetchAs(`${ACME}/s/${code}`);
  expect(opened.headers.get("Location")).toBe(`/a/${id}`);
  const cookie = cookieOf(opened);
  const page = await (await fetchAs(`${ACME}/a/${id}`, { cookie })).text();
  expect(page).toContain('"role":"edit"');
  expect((await fetchAs(`${ACME}/`, { cookie })).headers.get("Location")).toBe(`${ACME}/login?return=%2F`);
  expect((await fetchAs(`${ACME}/api/settings`, { cookie })).status).toBe(401);
  expect((await fetchAs(`${ACME}/api/a/${id}`, { cookie })).status).toBe(401);
  // Links from another workspace don't work here.
  const foreign = await signToken(h.env.LOGIN_SECRET, "link", 600, { e: MIA, a: id, w: "other" });
  expect((await fetchAs(`${ACME}/s/${foreign}`)).status).toBe(400);
});

test("each workspace's consent uses its own authorization server, whichever this isolate saw first", async () => {
  const beta = await createHub({}, "beta");
  await beta.hub.setMember(MIA, "member", ADMIN);
  env.WORKSPACE = { getByName: (slug: string) => (slug === "acme" ? h.hub : slug === "beta" ? beta.hub : null) };
  h.directory.createWorkspace("beta", "Beta");
  const BETA = "https://beta.artifacts.test";
  const authorize = async (origin: string) => {
    const reg = (await (
      await fetchAs(`${origin}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "" }, body: JSON.stringify({ client_name: "C", redirect_uris: ["http://127.0.0.1:9/cb"], token_endpoint_auth_method: "none" }) })
    ).json()) as { client_id: string };
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "http://127.0.0.1:9/cb", code_challenge: "a".repeat(43), code_challenge_method: "S256", state: "s", resource: `${origin}/mcp` });
    const { cookieFor } = { cookieFor: async () => `__Host-art_session=${await (await import("../src/worker/session.ts")).signToken(h.env.SESSION_SECRET, "session", 600, { e: MIA, h: new URL(origin).hostname })}` };
    return fetchAs(`${origin}/authorize?${q}`, { cookie: await cookieFor() });
  };
  expect((await authorize(ACME)).status).toBe(200);
  expect((await authorize(BETA)).status).toBe(200);
});

test("OAuth: consent, code exchange with PKCE, then MCP as the member", async () => {
  const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const reg = (await (
    await fetchAs(`${ACME}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "" }, body: JSON.stringify({ client_name: "Test client", redirect_uris: ["http://127.0.0.1:9/cb"], token_endpoint_auth_method: "none" }) })
  ).json()) as { client_id: string };
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "http://127.0.0.1:9/cb", code_challenge: challenge, code_challenge_method: "S256", state: "s", resource: `${ACME}/mcp`, scope: "artifacts" });
  const { signToken } = await import("../src/worker/session.ts");
  const cookie = `__Host-art_session=${await signToken(h.env.SESSION_SECRET, "session", 600, { e: MIA, h: "acme.artifacts.test" })}`;
  const page = await fetchAs(`${ACME}/authorize?${q}`, { cookie });
  const handle = /name="handle" value="([^"]+)"/.exec(await page.text())![1];
  const consent = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const approved = await fetchAs(`${ACME}/authorize`, { method: "POST", cookie: `${cookie}; ${consent}`, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ handle, decision: "approve" }) });
  expect(approved.status).toBe(200);
  const code = new URL(await nextUrl(approved)).searchParams.get("code")!;
  const tokens = (await (
    await fetchAs(`${ACME}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "http://127.0.0.1:9/cb", client_id: reg.client_id, code_verifier: verifier, resource: `${ACME}/mcp` }) })
  ).json()) as { access_token: string };
  const mcp = await fetchAs(`${ACME}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", Origin: "" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "artifact_create", arguments: { title: "OAuth", files: { "index.md": "# Hi\n" } } } }),
  });
  const result = ((await mcp.json()) as any).result;
  expect(h.hub.meta(result.structuredContent.id)!.owner).toBe(MIA);
  const settings = (await (await fetchAs(`${ACME}/api/settings`, { cookie })).json()) as any;
  expect(settings.apps.map((a: any) => a.client)).toEqual(["Test client"]);
  // Leaving the workspace revokes the grant.
  await fetchAs(`${ACME}/api/settings/members`, { method: "POST", cookie: `__Host-art_session=${await signToken(h.env.SESSION_SECRET, "session", 600, { e: ADMIN, h: "acme.artifacts.test" })}`, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: MIA, role: null }) });
  const after = await fetchAs(`${ACME}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", Origin: "" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
  expect(after.status).toBe(401);
});

test("form posts from our own pages pass with Origin: null; cross-site ones don't", async () => {
  const { sameOrigin } = await import("../src/worker/index.ts");
  const url = new URL(`${APEX}/login`);
  const req = (headers: Record<string, string>) => new Request(url, { method: "POST", headers });
  expect(sameOrigin(req({ Origin: APEX }), url)).toBe(true);
  expect(sameOrigin(req({ Origin: "null", "Sec-Fetch-Site": "same-origin" }), url)).toBe(true);
  expect(sameOrigin(req({ "Sec-Fetch-Site": "same-origin" }), url)).toBe(true);
  expect(sameOrigin(req({ Origin: "null", "Sec-Fetch-Site": "cross-site" }), url)).toBe(false);
  expect(sameOrigin(req({ Origin: "null" }), url)).toBe(false);
  expect(sameOrigin(req({ Origin: ACME, "Sec-Fetch-Site": "same-site" }), url)).toBe(false);
  // The sign-in form as a browser sends it.
  const res = await worker.fetch(
    new Request(`${APEX}/login`, { method: "POST", headers: { Origin: "null", "Sec-Fetch-Site": "same-origin" }, body: new URLSearchParams({ email: MIA, to: "", n: "", return: "/" }), redirect: "manual" }),
    env as never,
    ctx,
  );
  expect(res.status).toBe(200);
});

test("policy pages are on the apex; workspaces point there", async () => {
  for (const p of ["privacy", "terms", "security"]) {
    const res = await fetchAs(`${APEX}/${p}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Last updated");
  }
  expect((await fetchAs(`${ACME}/privacy`)).headers.get("Location")).toBe(`${APEX}/privacy`);
  expect(await (await fetchAs(`${APEX}/`)).text()).toContain('href="/privacy"');
});

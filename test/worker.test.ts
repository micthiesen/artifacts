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
    OPERATOR_EMAILS: "op@artifacts.test",
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
  const code = /(\d{3}) (\d{3})/.exec(mail.at(-1)!.text)!.slice(1).join("");
  const done = await fetchAs(`${APEX}/login`, { method: "POST", body: form({ email, code }) });
  expect(done.status).toBe(303);
  const location = done.headers.get("Location")!;
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

test("signed out, the apex shows the splash page", async () => {
  const html = await (await fetchAs(`${APEX}/`)).text();
  expect(html).toContain("Collaborative documents and little apps");
  expect(html).toContain('href="/login"');
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
  expect(await (await fetchAs(`${ACME}/`, { cookie: apexCookie })).text()).toContain("Sign in with your email");
  const home = await (await fetchAs(`${APEX}/`, { cookie: apexCookie })).text();
  expect(home).toContain("Your workspaces");
  expect(home).toContain(`${ACME}/`);
  expect(await (await fetchAs(`${APEX}/`, { cookie: acmeCookie })).text()).toContain("Collaborative documents");

  // Already signed in on the apex: the next workspace hand-off needs no code.
  const again = await fetchAs(`${APEX}/login?to=${encodeURIComponent(ACME)}&return=/settings`, { cookie: apexCookie });
  expect(again.headers.get("Location")).toStartWith(`${ACME}/auth/callback?code=`);
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
  const { cookie } = await signIn("op@artifacts.test");
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
  expect(await (await fetchAs(`${ACME}/`, { cookie })).text()).toContain("Sign in with your email");
  expect((await fetchAs(`${ACME}/api/settings`, { cookie })).status).toBe(401);
  expect((await fetchAs(`${ACME}/api/a/${id}`, { cookie })).status).toBe(401);
  // Links from another workspace don't work here.
  const foreign = await signToken(h.env.LOGIN_SECRET, "link", 600, { e: MIA, a: id, w: "other" });
  expect((await fetchAs(`${ACME}/s/${foreign}`)).status).toBe(400);
});

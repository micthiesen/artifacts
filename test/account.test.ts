// What people do for themselves: report an artifact, leave a workspace, hand one over, delete their account.
import { beforeEach, expect, test } from "bun:test";
import { ADMIN, createHub, FakeKV, type Harness } from "./support/do-harness.ts";

const { default: worker } = await import("../src/worker/index.ts");

let h: Harness;
let env: Record<string, unknown>;
let mail: { to: string; subject: string; text: string }[] = [];
const APEX = "https://artifacts.test";
const ACME = "https://acme.artifacts.test";
const MEMBER = "member@example.com";
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const files = { "index.mdx": "# Hi\n" };

beforeEach(async () => {
  h = await createHub();
  await h.hub.setMember(MEMBER, "member", ADMIN);
  mail = [];
  env = {
    ...h.env,
    WORKSPACE: { getByName: (slug: string) => (slug === "acme" ? h.hub : null) },
    OAUTH_KV: new FakeKV(),
    // Real-looking addresses, so the operator's notes aren't dropped as test addresses.
    EMAIL: { send: async (m: { to: string; subject: string; text: string }) => void mail.push(m) },
    CONSENT_SECRET: "test-consent-secret-that-is-long-enough",
    OPERATOR_TOKEN: "op-token",
    OPERATOR_EMAILS: "op@corp.com",
    APEX_HOST: "artifacts.test",
    WORKSPACE_SUFFIX: ".artifacts.test",
    MAIL_FROM: "sign-in@mail.artifacts.test",
  };
});

async function send(path: string, init: RequestInit & { as?: string; host?: string; form?: Record<string, string> } = {}) {
  const host = init.host ?? ACME;
  const headers = new Headers(init.headers);
  if (init.as) {
    const res = await worker.fetch(
      new Request(`${APEX}/api/admin/session`, { method: "POST", headers: { Authorization: "Bearer op-token", "Content-Type": "application/json" }, body: JSON.stringify({ email: init.as, host: new URL(host).hostname }) }),
      env as never,
      ctx,
    );
    headers.set("Cookie", ((await res.json()) as { cookie: string }).cookie);
  }
  headers.set("Origin", host);
  let body = init.body;
  if (init.form) body = new URLSearchParams(init.form);
  return worker.fetch(new Request(`${host}${path}`, { ...init, body, headers }), env as never, ctx);
}
const post = (path: string, as: string, body: unknown, host = ACME) => send(path, { as, host, method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

test("anyone can report an artifact; the operator gets the details, and the form can't be used to flood them", async () => {
  const r = await h.hub.create({ title: "Sign in to your bank", files, owner: ADMIN });
  if (!r.ok) throw new Error("create");
  const form = (extra: Record<string, string> = {}) => ({ url: `${ACME}/a/${r.id}?x=1`, reason: "phishing", details: "Asks for a bank password", ...extra });
  expect((await send("/report", { host: APEX })).status).toBe(200);
  const bad = await send("/report", { host: APEX, method: "POST", form: form({ url: "https://evil.example/a/x" }) });
  expect(bad.status).toBe(400);
  const ok = await send("/report", { host: APEX, method: "POST", form: form(), headers: { "CF-Connecting-IP": "1.2.3.4" } });
  expect(await ok.text()).toContain("Thanks");
  expect(mail.at(-1)).toMatchObject({ to: "op@corp.com" });
  expect(mail.at(-1)!.subject).toContain("Phishing");
  expect(mail.at(-1)!.text).toContain(`${ACME}/a/${r.id}`);
  for (let i = 0; i < 4; i++) await send("/report", { host: APEX, method: "POST", form: form(), headers: { "CF-Connecting-IP": "1.2.3.4" } });
  expect((await send("/report", { host: APEX, method: "POST", form: form(), headers: { "CF-Connecting-IP": "1.2.3.4" } })).status).toBe(429);
});

test("people outside the workspace see a Report link on its artifacts; members don't", async () => {
  const r = await h.hub.create({ title: "Shared", files, owner: ADMIN });
  if (!r.ok) throw new Error("create");
  h.hub.share(r.id, { add: [{ email: "guest@else.example", role: "view" }] });
  const g = await send(`/a/${r.id}`, { as: "guest@else.example" });
  expect(await g.text()).toContain(`/report?url=${encodeURIComponent(`${ACME}/a/${r.id}`)}`);
  expect(await (await send(`/a/${r.id}`, { as: MEMBER })).text()).not.toContain("/report?url=");
});

test("a member leaves; the last admin can't; what the leaver owned passes to an admin", async () => {
  const r = await h.hub.create({ title: "Mine", files, owner: MEMBER });
  if (!r.ok) throw new Error("create");
  expect((await post("/api/me/leave", ADMIN, {})).status).toBe(409);
  const left = await post("/api/me/leave", MEMBER, {});
  expect(left.status).toBe(200);
  expect(h.hub.members().map((m) => m.email)).toEqual([ADMIN]);
  expect(h.hub.meta(r.id)?.owner).toBe(ADMIN);
});

test("the person who made a workspace hands it to another admin, who can then delete it", async () => {
  h.directory.ctx.storage.sql.exec(`UPDATE workspaces SET created_by = ? WHERE slug = 'acme'`, ADMIN);
  expect((await post("/api/settings/owner", ADMIN, { email: MEMBER })).status).toBe(400);
  await h.hub.setMember(MEMBER, "admin", ADMIN);
  expect((await post("/api/settings/owner", MEMBER, { email: ADMIN })).status).toBe(403);
  expect((await post("/api/settings/owner", ADMIN, { email: MEMBER })).status).toBe(200);
  expect(h.directory.workspace("acme")?.createdBy).toBe(MEMBER);
  expect(((await (await send("/api/settings", { as: MEMBER })).json()) as { canDelete: boolean }).canDelete).toBe(true);
});

test("deleting an account: blocked while you're the last admin of others; otherwise you leave, and your data goes", async () => {
  const plan = async (as: string) => (await (await send("/api/me/delete", { as, host: APEX })).json()) as { blockers: string[]; deletes: unknown[]; leaves: { slug: string }[] };
  expect((await plan(ADMIN)).blockers[0]).toContain("only admin");
  expect((await post("/api/me/delete", ADMIN, { confirm: "delete" }, APEX)).status).toBe(409);
  // A member: leaves acme, and their name and channels go.
  await h.directory.setName(MEMBER, "Mem");
  expect(await plan(MEMBER)).toMatchObject({ blockers: [], deletes: [], leaves: [{ slug: "acme" }] });
  expect((await post("/api/me/delete", MEMBER, { confirm: "nope" }, APEX)).status).toBe(400);
  const done = await post("/api/me/delete", MEMBER, { confirm: "delete" }, APEX);
  expect(done.status).toBe(200);
  expect(done.headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect(h.hub.members().map((m) => m.email)).toEqual([ADMIN]);
  expect(h.directory.profile(MEMBER)).toMatchObject({ name: null, channels: [], workspaces: [] });
});

test("deleting the account of a workspace's only member deletes the workspace too", async () => {
  await h.hub.setMember(MEMBER, null, ADMIN);
  const plan = (await (await send("/api/me/delete", { as: ADMIN, host: APEX })).json()) as { deletes: { slug: string }[] };
  expect(plan.deletes).toEqual([{ slug: "acme", name: "Acme" }]);
  expect((await post("/api/me/delete", ADMIN, { confirm: "delete" }, APEX)).status).toBe(200);
  expect(h.directory.workspace("acme")).toBeNull();
});

test("with self-serve on, the front page leads with Start free and drops the self-hosting price; help is linked", async () => {
  const front = async () => (await send("/", { host: APEX })).text();
  expect(await front()).toContain("$5 a month");
  env.SELF_SERVE = "on";
  const page = await front();
  expect(page).toContain(">Start free<");
  expect(page).not.toContain("$5 a month");
  expect(page).toContain('href="/help"');
  expect(await (await send("/help", { host: APEX })).text()).toContain("mailto:op@corp.com");
  env.SUPPORT_EMAIL = "support@artifacts.test";
  expect(await (await send("/help", { host: APEX })).text()).toContain("mailto:support@artifacts.test");
});

test("a new workspace's empty list shows how to connect the agent and a first prompt", async () => {
  const page = await (await send("/", { as: ADMIN })).text();
  expect(page).toContain(`claude mcp add --transport http artifacts-acme ${ACME}/mcp`);
  expect(page).toContain("Ask it for something");
});

test("a report is kept in the ops log even when its email can't be sent; alerts email at most once an hour", async () => {
  const r = await h.hub.create({ title: "Page", files, owner: ADMIN });
  if (!r.ok) throw new Error("create");
  env.EMAIL = { send: async () => { throw new Error("mail down"); } };
  const form = { url: `${ACME}/a/${r.id}`, reason: "other", details: "test" };
  expect(await (await send("/report", { host: APEX, method: "POST", form, headers: { "CF-Connecting-IP": "9.9.9.9" } })).text()).toContain("Thanks");
  expect(h.directory.opsEvents({ kind: "report" })[0]).toMatchObject({ slug: "acme", detail: { url: `${ACME}/a/${r.id}`, reason: "other" } });
  // A report for a workspace that doesn't exist is refused.
  expect((await send("/report", { host: APEX, method: "POST", form: { ...form, url: "https://nope.artifacts.test/a/abc" }, headers: { "CF-Connecting-IP": "9.9.9.9" } })).status).toBe(400);
  // An alerting kind is stored and emailed once an hour; repeats only count, so a flood can't evict real events.
  const flood = () => h.directory.recordOps({ kind: "x", slug: null, message: "m", detail: null, alertKey: "k" });
  expect(flood()).toEqual({ alert: true });
  for (let i = 0; i < 600; i++) expect(flood()).toEqual({ alert: false });
  expect(h.directory.opsEvents({ kind: "x" })).toHaveLength(1);
  expect(h.directory.opsEvents({ kind: "report" })).toHaveLength(1);
  // Reports are all kept, even within the hour.
  await send("/report", { host: APEX, method: "POST", form, headers: { "CF-Connecting-IP": "9.9.9.8" } });
  expect(h.directory.opsEvents({ kind: "report" })).toHaveLength(2);
});

test("removing the person who made the workspace from settings hands it to a remaining admin", async () => {
  h.directory.ctx.storage.sql.exec(`UPDATE workspaces SET created_by = ? WHERE slug = 'acme'`, MEMBER);
  expect((await post("/api/settings/members", ADMIN, { email: MEMBER, role: null })).status).toBe(200);
  expect(h.directory.workspace("acme")?.createdBy).toBe(ADMIN);
});

test("once the day's self-serve workspaces are made, /workspaces says so before the form", async () => {
  env.SELF_SERVE = "on";
  for (let i = 0; i < 100; i++) h.directory.ctx.storage.sql.exec(`INSERT INTO self_serve_log (person, slug, at) VALUES (?, ?, ?)`, `p${i}@x.com`, `s${i}`, new Date().toISOString());
  const page = await (await send("/workspaces", { as: "new@example.com", host: APEX })).text();
  expect(page).toContain("as many new workspaces as we can today");
  expect(page).not.toContain('name="slug"');
});

test("account deletion never treats an unreachable workspace as gone", async () => {
  await h.hub.setMember(MEMBER, null, ADMIN);
  const real = h.hub.members.bind(h.hub);
  h.hub.members = (() => { throw new Error("overloaded"); }) as never;
  expect((await send("/api/me/delete", { as: ADMIN, host: APEX })).ok).toBe(false);
  expect(h.directory.workspace("acme")).not.toBeNull();
  h.hub.members = real;
  // Already destroyed (an earlier attempt stopped partway): the record goes on the next try.
  await h.hub.destroy("acme");
  expect((await post("/api/me/delete", ADMIN, { confirm: "delete" }, APEX)).status).toBe(200);
  expect(h.directory.workspace("acme")).toBeNull();
});

test("a deleted account stops seeing what was shared with its address, as a guest too", async () => {
  const r = await h.hub.create({ title: "For the guest", files, owner: ADMIN });
  if (!r.ok) throw new Error("create");
  const GUEST = "gone@else.example";
  h.hub.share(r.id, { add: [{ email: GUEST, role: "view" }] });
  // Signing in to a workspace as a guest records the visit (the test session skips the sign-in itself).
  h.directory.recordVisit(GUEST, "acme");
  expect(h.hub.list(GUEST).map((a) => a.id)).toEqual([r.id]);
  const plan = (await (await send("/api/me/delete", { as: GUEST, host: APEX })).json()) as { guestOf: { slug: string }[] };
  expect(plan.guestOf.map((w) => w.slug)).toEqual(["acme"]);
  const done = await post("/api/me/delete", GUEST, { confirm: "delete" }, APEX);
  expect(((await done.json()) as { location: string }).location).toBe(`${APEX}/?deleted=account`);
  expect(h.hub.list(GUEST)).toEqual([]);
  expect(await (await send("/?deleted=account", { host: APEX })).text()).toContain("Your account is deleted.");
});

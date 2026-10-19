// Plans limit what a workspace holds; self-serve signup (off unless SELF_SERVE=on) makes Free workspaces.
import { beforeEach, expect, test } from "bun:test";
import { ADMIN, createHub, FakeCtx, FakeKV, type Harness } from "./support/do-harness.ts";
import { PLANS } from "../src/worker/plans.ts";

const { default: worker } = await import("../src/worker/index.ts");
const { Workspace } = await import("../src/worker/hub.ts");

let h: Harness;
let env: Record<string, unknown>;
let hubs: Map<string, unknown>;
const APEX = "https://artifacts.test";
const MIA = "mia@example.com";
const files = { "index.mdx": "# Hi\n\nText.\n" };
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

beforeEach(async () => {
  h = await createHub();
  hubs = new Map([["acme", h.hub]]);
  env = {
    ...h.env,
    // New workspaces get a fresh, unprovisioned object, like a Durable Object would.
    WORKSPACE: { getByName: (slug: string) => hubs.get(slug) ?? hubs.set(slug, new Workspace(new FakeCtx() as never, h.env as never)).get(slug) },
    OAUTH_KV: new FakeKV(),
    EMAIL: { send: async () => {} },
    CONSENT_SECRET: "test-consent-secret-that-is-long-enough",
    OPERATOR_TOKEN: "op-token",
    OPERATOR_EMAILS: "op@corp.com",
    APEX_HOST: "artifacts.test",
    WORKSPACE_SUFFIX: ".artifacts.test",
    MAIL_FROM: "sign-in@mail.artifacts.test",
  };
});

async function session(email: string, host = "artifacts.test") {
  const res = await worker.fetch(
    new Request(`${APEX}/api/admin/session`, { method: "POST", headers: { Authorization: "Bearer op-token", "Content-Type": "application/json" }, body: JSON.stringify({ email, host }) }),
    env as never,
    ctx,
  );
  return ((await res.json()) as { cookie: string }).cookie;
}

async function create(cookie: string, fields: Record<string, string>) {
  return worker.fetch(
    new Request(`${APEX}/workspaces`, { method: "POST", headers: { Cookie: cookie, Origin: APEX }, body: new URLSearchParams(fields), redirect: "manual" }),
    env as never,
    ctx,
  );
}

test("existing workspaces are on Team: no artifact or member limits, capped near what one Durable Object holds", async () => {
  expect(h.hub.plan()).toMatchObject({ id: "team", limits: { artifacts: null, members: null, bytes: 5 * 1024 ** 3, changesPerDay: 5000 } });
  expect(h.hub.stats().plan).toBe("team");
});

test("Free stops new artifacts and members at its limits, and deleting makes room", async () => {
  await h.hub.setPlan("free");
  const max = PLANS.free.limits.artifacts!;
  let last = "";
  for (let i = 0; i < max; i++) {
    const r = await h.hub.create({ title: `A${i}`, files, owner: ADMIN });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    last = r.id;
  }
  await expect(h.hub.create({ title: "one too many", files, owner: ADMIN })).rejects.toThrow(`allows ${max} artifacts`);
  // Reaching it is recorded (once a day), the free plan's readout.
  await new Promise((r) => setTimeout(r, 0));
  await expect(h.hub.create({ title: "again", files, owner: ADMIN })).rejects.toThrow("archived ones count");
  expect(h.directory.opsEvents({ kind: "plan_limit_reached" })).toHaveLength(1);
  // Editing what exists still works.
  expect((await h.hub.writeFiles(last, { "index.mdx": "# Changed\n" })).ok).toBe(true);
  h.hub.delete(last);
  expect((await h.hub.create({ title: "fits again", files, owner: ADMIN })).ok).toBe(true);

  const members = PLANS.free.limits.members!;
  for (let i = 1; i < members; i++) await h.hub.setMember(`m${i}@corp.com`, "member", ADMIN);
  await expect(h.hub.setMember("extra@corp.com", "member", ADMIN)).rejects.toThrow(`allows ${members} members`);
  // Changing an existing member's role isn't adding one.
  await h.hub.setMember("m1@corp.com", "admin", ADMIN);
  expect(h.hub.plan().usage.members).toBe(members);
  // Someone joining by email domain past the limit stays a guest.
  h.hub.setJoinDomains(["joiners.com"], ADMIN);
  expect(await h.hub.autoJoin("new@joiners.com")).toBeNull();
});

test("the operator moves a workspace between plans", async () => {
  const res = await worker.fetch(
    new Request(`${APEX}/api/admin/workspaces/acme/plan`, { method: "POST", headers: { Authorization: "Bearer op-token", "Content-Type": "application/json" }, body: JSON.stringify({ plan: "free" }) }),
    env as never,
    ctx,
  );
  expect(((await res.json()) as { plan: { id: string } }).plan.id).toBe("free");
  expect(h.directory.workspace("acme")!.stats?.plan).toBe("free");
});

test("self-serve signup is off unless SELF_SERVE=on", async () => {
  const cookie = await session(MIA);
  const page = await worker.fetch(new Request(`${APEX}/workspaces`, { headers: { Cookie: cookie } }), env as never, ctx);
  expect(await page.text()).not.toContain("Create a workspace");
  expect((await create(cookie, { name: "Mine", slug: "mine", terms: "on" })).status).toBe(404);
  expect(h.directory.workspace("mine")).toBeNull();
});

test("with SELF_SERVE=on, someone signed in makes one Free workspace and lands in it as admin", async () => {
  env.SELF_SERVE = "on";
  const cookie = await session(MIA);
  const page = await (await worker.fetch(new Request(`${APEX}/workspaces`, { headers: { Cookie: cookie } }), env as never, ctx)).text();
  expect(page).toContain("Create a workspace");
  expect(page).toContain(`up to ${PLANS.free.limits.artifacts} artifacts`);

  expect(await (await create(cookie, { name: "Mine", slug: "mine" })).text()).toContain("Agree to the terms");
  expect(await (await create(cookie, { name: "Mine", slug: "Admin!", terms: "on" })).text()).toContain("Pick an address");
  expect(await (await create(cookie, { name: "Mine", slug: "acme", terms: "on" })).text()).toContain("already exists");
  // Only from this site's own pages.
  const cross = await worker.fetch(
    new Request(`${APEX}/workspaces`, { method: "POST", headers: { Cookie: cookie, Origin: "https://evil.test" }, body: new URLSearchParams({ name: "x", slug: "evil", terms: "on" }) }),
    env as never,
    ctx,
  );
  expect(cross.status).toBe(403);

  const made = await create(cookie, { name: "Mine", slug: "mine", terms: "on" });
  expect(await made.text()).toContain("https://mine.artifacts.test/login?return=%2Fsettings");
  const record = h.directory.workspace("mine")!;
  expect(record.name).toBe("Mine");
  const hub = hubs.get("mine") as InstanceType<typeof Workspace>;
  expect(hub.plan().id).toBe("free");
  expect(hub.members().map((m) => [m.email, m.role])).toEqual([[MIA, "admin"]]);

  // One each.
  expect(await (await create(cookie, { name: "Second", slug: "second", terms: "on" })).text()).toContain("already made a workspace");
});

test("Free storage counts what's stored, falls when it's deleted, and still lets people trim", async () => {
  await h.hub.setPlan("free");
  const limits = PLANS.free.limits as { bytes: number | null };
  const real = limits.bytes;
  limits.bytes = 2_500_000;
  try {
    // About 1 MB in 400 KB files (each file is capped at 512 KB).
    const mb = (tag: string) => Object.fromEntries([0, 1, 2].map((i) => [`data/${tag}${i}.json`, JSON.stringify(`${tag}${i}`.padEnd(340_000, "x"))]));
    const a = await h.hub.create({ title: "A", files: { ...files, ...mb("a") }, owner: ADMIN });
    const b = await h.hub.create({ title: "B", files: { ...files, ...mb("b") }, owner: ADMIN });
    if (!a.ok || !b.ok) throw new Error("create");
    expect(h.hub.plan().usage.bytes).toBeGreaterThan(2_000_000);
    // Under the limit still: one more megabyte fits, and then nothing new does.
    expect((await h.hub.writeFiles(a.id, mb("more"))).ok).toBe(true);
    await expect(h.hub.create({ title: "C", files, owner: ADMIN })).rejects.toThrow("MB of storage");
    const grow = await h.hub.writeFiles(a.id, { "data/even-more.json": JSON.stringify("y") });
    expect(!grow.ok && grow.errors[0].message).toContain("MB of storage");
    // Trimming is allowed, and deleting makes room at once.
    expect((await h.hub.writeFiles(a.id, { "data/more0.json": null, "data/more1.json": null })).ok).toBe(true);
    h.hub.delete(b.id);
    expect(h.hub.plan().usage.bytes).toBeLessThan(2_500_000);
    expect((await h.hub.create({ title: "C", files, owner: ADMIN })).ok).toBe(true);
  } finally {
    limits.bytes = real;
  }
});

test("Free caps saved changes a day", async () => {
  await h.hub.setPlan("free");
  const r = await h.hub.create({ title: "Busy", files, owner: ADMIN });
  if (!r.ok) throw new Error("create");
  const max = PLANS.free.limits.changesPerDay!;
  // The create was one change.
  for (let i = 1; i < max; i++) expect((await h.hub.writeFiles(r.id, { "index.mdx": `# Hi ${i}\n` })).ok).toBe(true);
  const over = await h.hub.writeFiles(r.id, { "index.mdx": "# One more\n" });
  expect(over.ok).toBe(false);
  expect(!over.ok && over.errors[0].message).toContain(`${max} saved changes a day`);
});

test("one self-serve workspace per person, however they tag their address", async () => {
  env.SELF_SERVE = "on";
  await create(await session("pat@example.com"), { name: "Pat", slug: "pat", terms: "on" });
  const again = await create(await session("pat+second@example.com"), { name: "Pat 2", slug: "pat-two", terms: "on" });
  expect(await again.text()).toContain("already made a workspace");
  expect(h.directory.workspace("pat-two")).toBeNull();
});

/** Make the workspace look a few days old, past the first-day holds. */
const settle = () => h.ctx.storage.sql.exec(`UPDATE settings SET value = ? WHERE key = 'created_at'`, new Date(Date.now() - 3 * 86_400_000).toISOString());

test("Free sends at most 50 emails a day; Team keeps the workspace-wide 1,000", async () => {
  await h.hub.setPlan("free");
  settle();
  let sent = 0;
  while (h.hub.allowMail(1) && sent < 2000) sent++;
  expect(sent).toBe(PLANS.free.limits.emailsPerDay);
  await h.hub.setPlan("team");
  expect(h.hub.allowMail(1)).toBe(true);
});

test("notifications can't use up the emails a Free workspace keeps for invitations and shares", async () => {
  await h.hub.setPlan("free");
  settle();
  const { emailsPerDay, inviteEmailsPerDay } = PLANS.free.limits;
  let notes = 0;
  while (h.hub.allowMail(1, undefined, "notify") && notes < 2000) notes++;
  expect(notes).toBe(emailsPerDay - inviteEmailsPerDay);
  let invites = 0;
  while (h.hub.allowMail(1) && invites < 2000) invites++;
  expect(invites).toBe(inviteEmailsPerDay);
});

test("limit messages say who can fix it and tell agents not to delete anything", async () => {
  await h.hub.setPlan("free");
  const limits = PLANS.free.limits as { artifacts: number | null };
  const real = limits.artifacts;
  limits.artifacts = 1;
  try {
    await h.hub.create({ title: "One", files, owner: ADMIN });
    const err = await h.hub.create({ title: "Two", files, owner: ADMIN }).catch((e: Error) => e.message);
    expect(err).toContain("A workspace admin can delete artifacts nobody needs, or move the workspace to Team in its settings");
    expect(err).toContain("rather than deleting anything");
  } finally {
    limits.artifacts = real;
  }
});

test("over the storage limit, a file can still be replaced with one no bigger", async () => {
  await h.hub.setPlan("free");
  const r = await h.hub.create({ title: "Pics", files, owner: ADMIN });
  if (!r.ok) throw new Error("create");
  h.hub.putAsset(r.id, "img/a.png", "image/png", new Uint8Array(1000));
  const limits = PLANS.free.limits as { bytes: number | null };
  const real = limits.bytes;
  limits.bytes = 10;
  try {
    expect(h.hub.putAsset(r.id, "img/a.png", "image/png", new Uint8Array(800)).bytes).toBe(800);
    expect(() => h.hub.putAsset(r.id, "img/a.png", "image/png", new Uint8Array(900))).toThrow("of storage");
    expect(() => h.hub.putAsset(r.id, "img/b.png", "image/png", new Uint8Array(10))).toThrow("of storage");
  } finally {
    limits.bytes = real;
  }
});

test("a Free workspace's first day: no public links and only a handful of invitation emails", async () => {
  await h.hub.setPlan("free");
  const r = await h.hub.create({ title: "Login", files, owner: ADMIN });
  if (!r.ok) throw new Error("create");
  expect(() => h.hub.share(r.id, { public: true })).toThrow("first day");
  let invites = 0;
  while (h.hub.allowMail(1) && invites < 100) invites++;
  expect(invites).toBe(10);
  // Notifications aren't held back.
  expect(h.hub.allowMail(1, undefined, "notify")).toBe(true);
  // A day on, or on Team, both work.
  settle();
  expect(() => h.hub.share(r.id, { public: true })).not.toThrow();
  await h.hub.setPlan("team");
  h.ctx.storage.sql.exec(`UPDATE settings SET value = ? WHERE key = 'created_at'`, new Date().toISOString());
  expect(() => h.hub.share(r.id, { public: false })).not.toThrow();
  expect(() => h.hub.share(r.id, { public: true })).not.toThrow();
});

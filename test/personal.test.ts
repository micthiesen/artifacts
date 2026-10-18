// Things each person does for themselves: pins, dismissing the changed-since
// bar, and (admins) exporting the workspace.
import { beforeEach, expect, test } from "bun:test";
import { ADMIN, createHub, FakeKV, FakeR2, runJobs, type Harness } from "./support/do-harness.ts";

const { default: worker } = await import("../src/worker/index.ts");

let h: Harness;
let bucket: FakeR2;
let env: Record<string, unknown>;
const ACME = "https://acme.artifacts.test";
const DANA = "dana@example.com";
const files = { "index.mdx": "# Plan\n\nText.\n" };
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

beforeEach(async () => {
  bucket = new FakeR2();
  h = await createHub({ BACKUPS: bucket as never });
  await h.hub.setMember(DANA, "member", ADMIN);
  env = {
    ...h.env,
    WORKSPACE: { getByName: (slug: string) => (slug === "acme" ? h.hub : null) },
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

async function cookie(email: string) {
  const res = await worker.fetch(
    new Request("https://artifacts.test/api/admin/session", { method: "POST", headers: { Authorization: "Bearer op-token", "Content-Type": "application/json" }, body: JSON.stringify({ email, host: "acme.artifacts.test" }) }),
    env as never,
    ctx,
  );
  return ((await res.json()) as { cookie: string }).cookie;
}

async function as(email: string, path: string, body?: unknown) {
  return worker.fetch(
    new Request(`${ACME}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Cookie: await cookie(email), Origin: ACME, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env as never,
    ctx,
  );
}

async function make(title: string, owner = ADMIN) {
  const r = await h.hub.create({ title, files, owner });
  if (!r.ok) throw new Error("create");
  return r.id;
}

test("pins are per person: pinned first for you, untouched for everyone else", async () => {
  const a = await make("A");
  const b = await make("B");
  const c = await make("C");
  h.hub.share(a, { add: [{ email: "workspace", role: "view" }] });
  h.hub.share(b, { add: [{ email: "workspace", role: "view" }] });
  h.hub.share(c, { add: [{ email: "workspace", role: "view" }] });
  // Newest first by default.
  expect(h.hub.list(DANA).map((x) => x.title)).toEqual(["C", "B", "A"]);
  expect(await (await as(DANA, "/api/me/pin", { id: a })).json()).toEqual({ pinned: true, pinnedAt: expect.any(String) });
  await Bun.sleep(5);
  await as(DANA, "/api/me/pin", { id: b });
  expect(h.hub.list(DANA).map((x) => x.title)).toEqual(["B", "A", "C"]);
  expect(h.hub.list(ADMIN).map((x) => x.title)).toEqual(["C", "B", "A"]);
  await as(DANA, "/api/me/pin", { id: b, pinned: false });
  expect(h.hub.list(DANA).map((x) => x.title)).toEqual(["A", "C", "B"]);
  // The list page shows the pin, pressed.
  const page = await (await as(DANA, "/")).text();
  expect(page).toMatch(new RegExp(`data-id="${a}"[^>]*data-pinned=`));
  expect(page).toContain('aria-pressed="true"');
  // You can only pin what you can open; deleting an artifact drops its pins.
  const hidden = await make("Hidden");
  expect((await as(DANA, "/api/me/pin", { id: hidden })).status).toBe(404);
  h.hub.delete(a);
  expect(h.ctx.sqlStorage.exec(`SELECT COUNT(*) AS n FROM pins`).toArray()[0].n).toBe(0);
});

test("dismissing the changed-since bar keeps it gone, even on a reload soon after", async () => {
  const id = await make("Plan");
  h.hub.share(id, { add: [{ email: DANA, role: "view" }] });
  h.hub.visit(id, DANA);
  await h.hub.writeFiles(id, { "index.mdx": "# Plan\n\nMore text.\n" });
  expect(h.hub.visit(id, DANA).since?.fromVersion).toBe(1);
  // Without dismissing, a reload soon after shows it again.
  expect(h.hub.visit(id, DANA).since?.fromVersion).toBe(1);
  expect((await as(DANA, "/api/me/since", { id })).status).toBe(200);
  expect(h.hub.visit(id, DANA).since).toBeUndefined();
});

test("admins export the latest backup as JSON Lines; members can't", async () => {
  await make("Exported");
  expect((await as(DANA, "/api/settings/export")).status).toBe(403);
  expect(await (await as(ADMIN, "/api/settings/export?status=1")).json()).toEqual({ latest: null, backingUp: false });
  expect((await as(ADMIN, "/api/settings/export")).status).toBe(404);

  expect(await (await as(ADMIN, "/api/settings/export", {})).json()).toEqual({ queued: true });
  // At most one asked-for backup an hour.
  expect(await (await as(ADMIN, "/api/settings/export", {})).json()).toMatchObject({ queued: false, retryAt: expect.any(String) });
  await runJobs(h);

  const status = (await (await as(ADMIN, "/api/settings/export?status=1")).json()) as { latest: { run: string } };
  expect(status.latest.run).toBeTruthy();
  const res = await as(ADMIN, "/api/settings/export");
  expect(res.headers.get("Content-Disposition")).toContain(`acme-${status.latest.run}.jsonl`);
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  expect(lines[0]).toMatchObject({ format: "artifacts.boo/export@1", workspace: "acme", run: status.latest.run, tables: { artifacts: 1 } });
  const artifacts = lines.filter((l) => l.table === "artifacts").flatMap((l) => l.rows);
  expect(artifacts.map((a: { title: string }) => a.title)).toEqual(["Exported"]);
  expect(lines.at(-1)).toEqual({ end: true, pages: lines.length - 2 });
  // An artifact's current files rebuild from files + blobs.
  const file = lines.filter((l) => l.table === "files").flatMap((l) => l.rows)[0];
  const blob = lines.filter((l) => l.table === "blobs").flatMap((l) => l.rows).find((b: { hash: string }) => b.hash === file.hash);
  expect(blob.content).toBe(files["index.mdx"]);
});

test("a workspace default silences or widens notifications; a per-artifact choice still wins", async () => {
  const OWNED = await make("Mine", DANA);
  const other = await make("Theirs");
  h.hub.share(other, { add: [{ email: DANA, role: "edit" }] });
  await h.directory.addChannel(DANA, "ntfy", { server: "https://ntfy.sh", topic: "dana" }, "ntfy");
  h.hub.share(OWNED, { add: [{ email: "sam@example.com", role: "edit" }] });
  const sent: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    sent.push(String(url));
    return new Response("{}");
  }) as typeof fetch;
  try {
    const deliver = async () => {
      sent.length = 0;
      await h.hub.deliverDue(Date.now() + 3_600_000);
      return sent.filter((u) => u.endsWith("/dana")).length;
    };
    // Standard: a comment on what Dana owns reaches her.
    h.hub.addComment(OWNED, "sam@example.com", { text: "hi" }, ACME);
    expect(await deliver()).toBe(1);
    // "Nothing" for this workspace: not even on what she owns, nor @mentions.
    expect(await (await as(DANA, "/api/me/watch-default", { level: "mute" })).json()).toEqual({ level: "mute" });
    h.hub.addComment(OWNED, "sam@example.com", { text: "hello @dana@example.com" }, ACME);
    expect(await deliver()).toBe(0);
    expect(h.hub.watches(DANA).every((w) => w.level === "mute" && !w.custom)).toBe(true);
    // One artifact set apart still notifies.
    h.hub.setWatch(DANA, other, "all");
    h.hub.addComment(other, ADMIN, { text: "update" }, ACME);
    expect(await deliver()).toBe(1);
    // "All activity" as the default reaches her on artifacts she doesn't own.
    h.hub.setWatch(DANA, other, null);
    await as(DANA, "/api/me/watch-default", { level: "all" });
    h.hub.addComment(other, ADMIN, { text: "another" }, ACME);
    expect(await deliver()).toBe(1);
    expect(((await (await as(DANA, "/api/me")).json()) as { watchDefault: string }).watchDefault).toBe("all");
    await as(DANA, "/api/me/watch-default", { level: null });
    expect(h.hub.watchDefault(DANA)).toBeNull();
  } finally {
    globalThis.fetch = real;
  }
});

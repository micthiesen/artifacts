// Workspace roles, members, agent tokens, file history, export/import and backups.
import { beforeEach, expect, test } from "bun:test";
import { ADMIN, createHub, FakeR2, runJobs, type Harness } from "./support/do-harness.ts";

let h: Harness;
const MEMBER = "mia@corp.com";
const OTHER = "olu@corp.com";
const GUEST = "gus@client.com";
const files = { "index.mdx": "# Report\n\n<Table data=\"rows.json\" />\n", "data/rows.json": '[{"a":1}]\n' };

async function make(owner = MEMBER, title = "Report") {
  const r = await h.hub.create({ title, files, owner });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.id;
}

beforeEach(async () => {
  h = await createHub();
  await h.hub.setMember(MEMBER, "member", ADMIN);
  await h.hub.setMember(OTHER, "member", ADMIN);
});

test("owners and admins manage; members see their own and workspace shares; guests only their shares", async () => {
  const mine = await make();
  const shared = await make(OTHER, "Team doc");
  const secret = await make(OTHER, "Private");
  h.hub.share(shared, { add: [{ email: "workspace", role: "view" }] });
  h.hub.share(secret, { add: [{ email: GUEST, role: "edit" }] });

  expect(h.hub.roleFor(mine, MEMBER)).toBe("owner");
  expect(h.hub.roleFor(mine, ADMIN)).toBe("owner");
  expect(h.hub.roleFor(shared, MEMBER)).toBe("view");
  expect(h.hub.roleFor(secret, MEMBER)).toBeNull();
  // A workspace share reaches members, never guests.
  expect(h.hub.roleFor(shared, GUEST)).toBeNull();
  expect(h.hub.roleFor(secret, GUEST)).toBe("edit");

  expect(h.hub.list(MEMBER).map((a) => a.title).sort()).toEqual(["Report", "Team doc"]);
  expect(h.hub.list(GUEST).map((a) => a.title)).toEqual(["Private"]);
  expect(h.hub.list(ADMIN).map((a) => a.role)).toEqual(["owner", "owner", "owner"]);
  // Activity follows the same visibility.
  expect(new Set(h.hub.activity({ email: GUEST }).events.map((e) => e.artifact))).toEqual(new Set([secret]));
  expect(h.hub.activity({ email: ADMIN }).events.length).toBe(3);
});

test("members are mirrored to the directory; the last admin stays", async () => {
  expect(h.directory.membershipsOf(MEMBER)).toMatchObject([{ slug: "acme", role: "member" }]);
  await expect(h.hub.setMember(ADMIN, "member", ADMIN)).rejects.toThrow("at least one admin");
  await h.hub.setMember(MEMBER, "admin", ADMIN);
  await h.hub.setMember(ADMIN, null, MEMBER);
  expect(h.hub.access(ADMIN).member).toBeNull();
  expect(h.directory.membershipsOf(ADMIN)).toEqual([]);
  await expect(h.hub.setMember("not an email", "member", MEMBER)).rejects.toThrow("not an email");
});

test("agent tokens identify a member until revoked or the member leaves", async () => {
  const { id, token } = await h.hub.createToken(MEMBER, "laptop");
  expect(token).toStartWith("art_");
  expect(await h.hub.verifyAgentToken(token)).toEqual({ email: MEMBER });
  expect(await h.hub.verifyAgentToken(`${token}x`)).toBeNull();
  expect(h.hub.tokens(MEMBER)).toMatchObject([{ id, label: "laptop" }]);
  expect(JSON.stringify(h.hub.tokens())).not.toContain(token);
  expect(() => h.hub.revokeToken(id, OTHER)).toThrow("your own");
  await expect(h.hub.createToken(GUEST, "x")).rejects.toThrow("members");

  const second = await h.hub.createToken(MEMBER, "ci");
  expect(h.hub.revokeToken(id, ADMIN)).toBe(true);
  expect(await h.hub.verifyAgentToken(token)).toBeNull();
  await h.hub.setMember(MEMBER, null, ADMIN);
  expect(await h.hub.verifyAgentToken(second.token)).toBeNull();
  expect(h.hub.tokens(MEMBER)).toEqual([]);
});

test("history stores each file content once and reverts exactly", async () => {
  const id = await make();
  const blobs = () => h.ctx.sqlStorage.exec(`SELECT COUNT(*) AS n FROM blobs WHERE artifact_id = ?`, id).toArray()[0].n;
  expect(blobs()).toBe(2);
  for (let i = 2; i <= 4; i++) await h.hub.patchData(id, "data/rows.json", [{ op: "replace", path: "/0/a", value: i }]);
  // index.mdx never changed: one copy, plus one per data version.
  expect(blobs()).toBe(5);
  const r = await h.hub.revert(id, 1);
  expect(r).toMatchObject({ ok: true, version: 5 });
  expect(h.hub.files(id)).toEqual(files);
  expect(blobs()).toBe(5);
  expect(h.hub.meta(id)!.files).toEqual([
    { path: "data/rows.json", bytes: files["data/rows.json"].length },
    { path: "index.mdx", bytes: files["index.mdx"].length },
  ]);
});

test("pruned versions release content nothing else uses", async () => {
  const id = await make();
  h.ctx.sqlStorage.exec(`DELETE FROM history WHERE artifact_id = ? AND version = 1`, id);
  await h.hub.patchData(id, "data/rows.json", [{ op: "replace", path: "/0/a", value: 2 }]);
  const contents = h.ctx.sqlStorage.exec(`SELECT content FROM blobs WHERE artifact_id = ?`, id).toArray().map((r) => r.content);
  expect(contents).not.toContain(files["data/rows.json"]);
  expect(contents).toContain(files["index.mdx"]);
});

test("export pages import into an empty workspace and reproduce it", async () => {
  const id = await make();
  h.hub.share(id, { add: [{ email: GUEST, role: "view" }] });
  h.hub.putAsset(id, "assets/dot.png", "image/png", new Uint8Array([137, 80, 78, 71, 0, 255]));
  await h.hub.createToken(MEMBER, "laptop");
  const dump: Record<string, Record<string, unknown>[]> = {};
  const { DATA_TABLES } = await import("../src/worker/tables.ts");
  for (const t of DATA_TABLES) {
    let after = 0;
    dump[t] = [];
    for (;;) {
      const page = h.hub.exportPage(t, after);
      dump[t].push(...page.rows);
      if (page.next === null) break;
      after = page.next;
    }
  }
  expect(JSON.stringify(dump.assets[0].data)).toContain("$b64");

  const copy = await createHub();
  copy.hub.importBegin();
  // Offline while it loads.
  expect(copy.hub.access(ADMIN).offline).toBe(true);
  expect(() => copy.hub.importRows("artifacts", [{ nope: 1 }])).toThrow("no column nope");
  for (const t of DATA_TABLES) copy.hub.importRows(t, dump[t]);
  await copy.hub.importEnd();
  expect(copy.hub.access(ADMIN).offline).toBe(false);
  expect(copy.hub.files(id)).toEqual(files);
  expect(copy.hub.roleFor(id, GUEST)).toBe("view");
  expect(new Uint8Array(copy.hub.asset(id, "assets/dot.png")!.data)).toEqual(new Uint8Array([137, 80, 78, 71, 0, 255]));
  expect(copy.hub.members().map((m) => m.email).sort()).toEqual([ADMIN, MEMBER, OTHER].sort());
  expect(copy.directory.membershipsOf(MEMBER)).toMatchObject([{ slug: "acme" }]);
  expect(() => copy.hub.importRows("artifacts", [])).toThrow("importBegin");
});

test("a change schedules tonight's backup; the backup restores everything", async () => {
  const bucket = new FakeR2();
  h = await createHub({ BACKUPS: bucket });
  await h.hub.setMember(MEMBER, "member", ADMIN);
  const id = await make();
  const due = Number(h.ctx.sqlStorage.exec(`SELECT value FROM settings WHERE key = 'backup_due_at'`).toArray()[0].value);
  expect(new Date(due).getUTCHours()).toBe(10);
  expect(h.ctx.alarm).toBe(due);

  expect(await h.hub.backup()).toEqual({ queued: true });
  await runJobs(h);
  const [run] = await h.hub.backups();
  expect(run).toMatch(/^\d{4}-\d{2}-\d{2}T\d{9}Z$/);
  expect(bucket.objects.has(`acme/${run}/manifest.json`)).toBe(true);
  // That backup covered everything, so none is pending.
  expect(h.ctx.sqlStorage.exec(`SELECT value FROM settings WHERE key = 'backup_due_at'`).toArray()).toEqual([]);

  h.hub.delete(id);
  expect(await h.hub.restore(run)).toEqual({ queued: true });
  await runJobs(h);
  expect(h.hub.files(id)).toEqual(files);
  expect(h.hub.access(ADMIN).offline).toBe(false);
  // A fresh backup ran first, so the pre-restore state is kept too.
  expect((await h.hub.backups()).length).toBe(2);
  expect(h.directory.workspace("acme")!.stats).toMatchObject({ artifacts: 1, members: 2 });
});

test("a restore checks every page first and changes nothing if one doesn't fit", async () => {
  const bucket = new FakeR2();
  h = await createHub({ BACKUPS: bucket });
  await h.hub.setMember(MEMBER, "member", ADMIN);
  const id = await make();
  await h.hub.backup();
  await runJobs(h);
  const [run] = await h.hub.backups();
  // Corrupt the backup: a column this schema doesn't have, in a late table.
  const key = [...bucket.objects.keys()].find((k) => k.startsWith(`acme/${run}/events/`))!;
  bucket.objects.set(key, JSON.stringify([{ seq: 1, nope: 1 }]));
  await h.hub.restore(run);
  await runJobs(h);
  expect(h.hub.files(id)).toEqual(files);
  expect(h.hub.access(ADMIN).offline).toBe(false);
  expect(h.ctx.sqlStorage.exec(`SELECT value FROM settings WHERE key = 'last_job_error'`).toArray()[0].value).toContain("nope");
});

test("big backups resume across alarms", async () => {
  const bucket = new FakeR2();
  h = await createHub({ BACKUPS: bucket });
  await h.hub.setMember(MEMBER, "member", ADMIN);
  // Enough state to need many pages and pass the snapshot limit.
  for (let a = 0; a < 4; a++) {
    const id = await make(MEMBER, `Big ${a}`);
    for (let i = 0; i < 40; i++) h.hub.setState(id, { [`big/${i}`]: "x".repeat(60_000) }, null);
    for (let i = 0; i < 10; i++) h.hub.setState(id, { [`k/${i}`]: i }, null);
  }
  const { stepBackup, startBackup } = await import("../src/worker/snapshot.ts");
  const { DATA_TABLES } = await import("../src/worker/tables.ts");
  // A deadline in the past still makes progress one page at a time.
  let r = await stepBackup(bucket as never, "acme", DATA_TABLES, (t, a) => h.hub.exportPage(t, a), startBackup("2026-01-01T000000000Z"), 3, 0);
  let steps = 1;
  while ("next" in r) {
    r = await stepBackup(bucket as never, "acme", DATA_TABLES, (t, a) => h.hub.exportPage(t, a), r.next, 3, 0);
    steps++;
  }
  expect(steps).toBeGreaterThan(5);
  expect(r.done.tables.state).toBe(200);
  // Pages were uploaded as it went, not all at the end.
  expect([...bucket.objects.keys()].filter((k) => k.includes('/state/')).length).toBeGreaterThan(1);
});

test("renders store their screenshot as bytes and hand it back as base64", async () => {
  const jpeg = btoa("\xff\xd8fake jpeg");
  h = await createHub({
    BROWSER: {
      quickAction: async () =>
        Response.json({ success: true, result: { content: '<pre id="art-check">{"status":"ok","textLength":5}</pre>', screenshot: jpeg } }),
    },
  });
  await h.hub.setMember(MEMBER, "member", ADMIN);
  const id = await make();
  const r = await h.hub.runRenderCheck(id, "https://acme.artifacts.test");
  expect(r).toMatchObject({ check: { status: "ok" }, screenshot: jpeg });
  const stored = h.ctx.sqlStorage.exec(`SELECT screenshot FROM checks WHERE artifact_id = ?`, id).toArray()[0].screenshot;
  expect(stored).toBeInstanceOf(ArrayBuffer);
  expect((await h.hub.runRenderCheck(id, "https://acme.artifacts.test")).screenshot).toBe(jpeg);
  h.hub.updateMeta(id, { preview: true });
  expect(new TextDecoder("latin1").decode(h.hub.previewImage(id)!)).toBe("\xff\xd8fake jpeg");
});

test("an edit that lost a race to another write is rejected, not merged", async () => {
  const id = await make();
  const slow = h.hub.patchData(id, "data/rows.json", [{ op: "replace", path: "/0/a", value: 2 }]);
  h.ctx.sqlStorage.exec(`UPDATE artifacts SET version = 7 WHERE id = ?`, id);
  expect(await slow).toMatchObject({ ok: false, version: 7 });
});

test("approved sources arm the alarm; unapproved ones don't", async () => {
  const id = await make();
  h.hub.setSource(id, { path: "data/rows.json", url: "https://api.example.com/rows", everyMinutes: 60 });
  await h.hub.refreshSources({ id });
  expect(h.ctx.alarm).toBeNull();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json([{ a: 9 }])) as unknown as typeof fetch;
  try {
    await h.hub.setHostAllowed("api.example.com", true);
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(JSON.parse(h.hub.files(id)["data/rows.json"])).toEqual([{ a: 9 }]);
  expect(h.ctx.alarm).toBeGreaterThan(Date.now() + 58 * 60_000);
});

test("activity for a member with one share shows only what they can see", async () => {
  const shared = await make(OTHER, "Shared");
  const hidden = await make(OTHER, "Hidden");
  h.hub.share(shared, { add: [{ email: GUEST, role: "view" }] });
  h.hub.addComment(hidden, OTHER, { text: "secret plan" });
  const seen = h.hub.activity({ email: GUEST }).events;
  expect(seen.map((e) => e.artifact)).toEqual([shared]);
  expect(JSON.stringify(seen)).not.toContain("secret plan");
});

test("removing a member hands their artifacts to whoever removed them and closes their pages", async () => {
  const id = await make();
  const { connect } = await import("./support/do-harness.ts");
  const page = await connect(h, { id, email: MEMBER, role: "owner" });
  await h.hub.setMember(MEMBER, null, ADMIN);
  expect(h.hub.meta(id)!.owner).toBe(ADMIN);
  expect(h.hub.roleFor(id, MEMBER)).toBeNull();
  expect(page.socket.closed?.code).toBe(4003);
});

test("shares only take real principals and the view or edit roles", async () => {
  const id = await make();
  expect(() => h.hub.share(id, { add: [{ email: GUEST, role: "owner" as never }] })).toThrow("view or edit");
  expect(() => h.hub.share(id, { add: [{ email: "not a principal", role: "view" }] })).toThrow("not an email");
  await expect(h.hub.setMember("workspace", "member", ADMIN)).rejects.toThrow("not an email");
});

test("small workspaces back up as a point-in-time snapshot", async () => {
  const bucket = new FakeR2();
  h = await createHub({ BACKUPS: bucket });
  await h.hub.setMember(MEMBER, "member", ADMIN);
  const id = await make();
  // Make the first upload slow and edit the artifact while it's in flight.
  const put = bucket.put.bind(bucket);
  let edited = false;
  bucket.put = async (k: string, v: string) => {
    if (!edited) {
      edited = true;
      await h.hub.patchData(id, "data/rows.json", [{ op: "replace", path: "/0/a", value: 99 }]);
    }
    return put(k, v);
  };
  await h.hub.backup();
  await runJobs(h);
  const [run] = await h.hub.backups();
  const history = JSON.parse(bucket.objects.get(`acme/${run}/history/00000.json`)!);
  const artifacts = JSON.parse(bucket.objects.get(`acme/${run}/artifacts/00000.json`)!);
  // Both tables describe the same moment: version 1 everywhere, not a mix.
  expect(artifacts[0].version).toBe(1);
  expect(history.map((r: any) => r.version)).toEqual([1]);
});

test("a deleted workspace answers as missing and stores nothing; a stray object stays empty", async () => {
  await h.hub.destroy();
  expect(h.hub.access(null).slug).toBe("");
  expect(h.hub.job()).toBeNull();
  const { FakeCtx } = await import("./support/do-harness.ts");
  const { Workspace } = await import("../src/worker/hub.ts");
  const ctx = new FakeCtx();
  const stray = new Workspace(ctx as never, h.env as never);
  expect(stray.access(null).slug).toBe("");
  expect(ctx.sqlStorage.exec(`SELECT name FROM sqlite_master`).toArray()).toEqual([]);
});

test("a live source can create its data file", async () => {
  const id = await make();
  h.hub.setSource(id, { path: "data/live.json", url: "https://api.example.com/x", everyMinutes: 60 });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ ok: 1 })) as unknown as typeof fetch;
  try {
    await h.hub.setHostAllowed("api.example.com", true);
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(JSON.parse(h.hub.files(id)["data/live.json"])).toEqual({ ok: 1 });
});

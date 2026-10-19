// What deleting removes (inbox entries, a deleted comment's words, a forgotten person's traces) and how the
// workspace recovers from interrupted work (a backup read mid-save, a stalled import, a burst of notifications).
import { beforeEach, expect, test } from "bun:test";
import { ADMIN, createHub, type Harness } from "./support/do-harness.ts";

const ANA = "ana@example.com";
const ORIGIN = "https://acme.artifacts.test";
let h: Harness;

beforeEach(async () => {
  h = await createHub();
});

async function make(title = "Plan") {
  const r = await h.hub.create({ title, files: { "index.mdx": `# ${title}\n` }, owner: ADMIN });
  if (!r.ok) throw new Error("create");
  h.hub.share(r.id, { add: [{ email: ANA, role: "edit" }] });
  return r.id;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("deleting an artifact or a workspace takes its notifications out of people's inboxes", async () => {
  const id = await make();
  const other = await make("Other");
  h.hub.addComment(id, ANA, { text: "Secret plans" }, ORIGIN, undefined, "edit");
  h.hub.addComment(other, ANA, { text: "Fine" }, ORIGIN, undefined, "edit");
  await h.hub.deliverDue(Date.now() + 3_600_000);
  expect(h.directory.inbox(ADMIN).items).toHaveLength(2);
  h.hub.delete(id);
  await tick();
  expect(h.directory.inbox(ADMIN).items.map((i) => i.url?.split("#")[0])).toEqual([`${ORIGIN}/a/${other}`]);
  // Rows from before inbox entries named their workspace go by address.
  h.directory.addInbox(ADMIN, { kind: "notification", title: "Old", url: `${ORIGIN}/a/zzz` });
  h.directory.addInbox(ADMIN, { kind: "notification", title: "Elsewhere", url: "https://acmeco.artifacts.test/a/zzz" });
  await h.directory.removeWorkspace("acme");
  expect(h.directory.inbox(ADMIN).items.map((i) => i.title)).toEqual(["Elsewhere"]);
});

test("a deleted comment's words leave the activity log", async () => {
  const id = await make();
  const t = h.hub.addComment(id, ANA, { text: "my password is hunter2" }, ORIGIN, undefined, "edit");
  const logged = () => h.ctx.sqlStorage.exec(`SELECT data FROM events WHERE artifact_id = ? AND type = 'thread'`, id).toArray().map((r) => String(r.data));
  expect(logged()[0]).toContain("hunter2");
  h.hub.deleteComment(id, ANA, t.comments[0].id, "edit");
  expect(logged()[0]).not.toContain("hunter2");
});

test("forgetting a person removes them from error reports and who-added-whom", async () => {
  const id = await make();
  await h.hub.setMember(ANA, "admin", ADMIN);
  await h.hub.setMember("bo@example.com", "member", ANA);
  h.ctx.sqlStorage.exec(`INSERT INTO errors (artifact_id, at, version, viewer, message) VALUES (?, ?, 1, ?, 'boom')`, id, new Date().toISOString(), ANA);
  h.hub.forgetPerson(ANA);
  expect(h.ctx.sqlStorage.exec(`SELECT viewer FROM errors`).toArray()[0].viewer).toBeNull();
  expect(h.ctx.sqlStorage.exec(`SELECT added_by FROM members WHERE email = 'bo@example.com'`).toArray()[0].added_by).toBeNull();
});

test("a burst of notifications for one person is delivered (more rows than SQLite binds at once)", async () => {
  const id = await make();
  for (let i = 0; i < 120; i++) h.ctx.sqlStorage.exec(`INSERT INTO outbox (email, artifact_id, kind, data, due_at) VALUES (?, ?, 'comment', ?, ?)`, ADMIN, id, JSON.stringify({ by: ANA, text: `n${i}`, origin: ORIGIN }), Date.now() - 1);
  await h.hub.deliverDue(Date.now());
  expect(h.ctx.sqlStorage.exec(`SELECT COUNT(*) AS n FROM outbox`).one().n).toBe(0);
  expect(h.directory.inbox(ADMIN).items).toHaveLength(1);
});

test("after a load, an artifact's version and state counters are at least what its history and state say", async () => {
  const id = await make();
  // As a backup read mid-save leaves it: history (and state) ahead of the artifact row.
  h.ctx.sqlStorage.exec(`INSERT INTO history (artifact_id, version, files, note, created_at) VALUES (?, 7, '{}', 'x', ?)`, id, new Date().toISOString());
  h.ctx.sqlStorage.exec(`INSERT INTO state (artifact_id, key, value, seq) VALUES (?, 'k', '1', 40)`, id);
  await (h.hub as unknown as { afterLoad(): Promise<void> }).afterLoad();
  const row = h.ctx.sqlStorage.exec(`SELECT version, state_seq FROM artifacts WHERE id = ?`, id).one();
  expect(row).toMatchObject({ version: 7, state_seq: 40 });
  expect((await h.hub.writeFiles(id, { "index.mdx": "# Next\n" })).ok).toBe(true);
});

test("an import nobody feeds for an hour is cancelled, bringing the workspace back", async () => {
  await h.hub.importBegin();
  const job = JSON.parse(String(h.ctx.sqlStorage.exec(`SELECT value FROM settings WHERE key = 'job'`).one().value));
  h.ctx.sqlStorage.exec(`UPDATE settings SET value = ? WHERE key = 'job'`, JSON.stringify({ ...job, startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }));
  await h.hub.alarm();
  expect(h.hub.job()).toBeNull();
});

test("losing access to an artifact or a workspace takes its notifications out of that person's inbox", async () => {
  const id = await make();
  await h.hub.setMember("bo@example.com", "member", ADMIN);
  h.hub.share(id, { add: [{ email: "bo@example.com", role: "edit" }] });
  h.hub.addComment(id, ADMIN, { text: `For @${ANA} and @bo@example.com` }, ORIGIN, undefined, "owner");
  await h.hub.deliverDue(Date.now() + 3_600_000);
  expect(h.directory.inbox(ANA).items).toHaveLength(1);
  h.hub.share(id, { remove: [ANA] });
  await tick();
  expect(h.directory.inbox(ANA).items).toHaveLength(0);
  expect(h.directory.inbox("bo@example.com").items).toHaveLength(1);
  await h.hub.setMember("bo@example.com", null, ADMIN);
  expect(h.directory.inbox("bo@example.com").items).toHaveLength(0);
});

test("a comment deleted before its notification goes out isn't sent", async () => {
  const id = await make();
  const t = h.hub.addComment(id, ANA, { text: "oops, wrong page" }, ORIGIN, undefined, "edit");
  expect(h.ctx.sqlStorage.exec(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'comment'`).one().n).toBeGreaterThan(0);
  h.hub.deleteComment(id, ANA, t.comments[0].id, "edit");
  expect(h.ctx.sqlStorage.exec(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'comment'`).one().n).toBe(0);
});

test("a render check queued after the day's allowance is used up settles as skipped instead of waking the workspace", async () => {
  const id = await make();
  h.ctx.sqlStorage.exec(`INSERT INTO settings (key, value) VALUES ('checks_day', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, JSON.stringify({ day: new Date().toISOString().slice(0, 10), n: 10_000 }));
  h.ctx.sqlStorage.exec(`INSERT INTO checks (artifact_id, version, origin, status, at) VALUES (?, 1, ?, 'queued', ?) ON CONFLICT (artifact_id) DO UPDATE SET status = 'queued'`, id, ORIGIN, Date.now());
  await (h.hub as unknown as { runCheck(id: string, v: number, o: string): Promise<unknown> }).runCheck(id, 1, ORIGIN);
  expect(h.ctx.sqlStorage.exec(`SELECT status FROM checks WHERE artifact_id = ?`, id).one().status).toBe("done");
});

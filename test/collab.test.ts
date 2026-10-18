// Comments, activity, visits, previews and notifications in the hub.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { connect, createHub, type Harness } from "./support/do-harness.ts";

let h: Harness;
const OWNER = "owner@example.com";
const DANA = "dana@corp.com";
const SAM = "sam@corp.com";
const ORIGIN = "https://art.test";
const files = { "index.mdx": "# Plan\n\nIntro text here.\n\n## Costs\n\nWe pay $10 a month.\n\n## Risks\n\nNone yet.\n" };
const realFetch = globalThis.fetch;
let sent: { url: string; init: RequestInit }[] = [];

async function make() {
  const r = await h.hub.create({ title: "Plan", files, owner: OWNER });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  h.hub.share(r.id, { add: [{ email: DANA, role: "view" }, { email: SAM, role: "edit" }] });
  return r.id;
}

function last(conn: { socket: { messages: unknown[] } }) {
  return conn.socket.messages.at(-1) as Record<string, any>;
}

function ntfy(email: string) {
  return h.directory.addChannel(email, "ntfy", { server: "https://ntfy.sh", topic: `topic-${email.split("@")[0]}` }, "ntfy");
}

/** Run every queued notification now and return what was sent, by ntfy topic. */
async function deliver() {
  sent = [];
  await h.hub.deliverDue(Date.now() + 3_600_000);
  return sent.map((s) => ({ topic: s.url.split("/").pop(), body: String(s.init.body), title: (s.init.headers as Record<string, string>).Title }));
}

beforeEach(async () => {
  h = await createHub();
  sent = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("blocks get stable ids and hashes", async () => {
  const id = await make();
  const build = (await h.hub.build(id))!.build;
  expect(build.blocks!.map((b) => b.id)).toEqual(["plan", "plan-1", "costs", "costs-1", "risks", "risks-1"]);
});

test("viewers can start threads; replies reopen; only authors or editors resolve", async () => {
  const id = await make();
  const dana = await connect(h, { id, email: DANA, role: "view" });
  const sam = await connect(h, { id, email: SAM, role: "edit" });
  expect(dana.socket.messages.find((m: any) => m.t === "threads")).toMatchObject({ threads: [] });

  await dana.send({ t: "comment", cid: "c1", anchor: { block: "costs-1", quote: { exact: "$10", prefix: "We pay ", suffix: " a month" } }, text: "Is this per seat?" });
  const created = last(sam);
  expect(created.t).toBe("thread");
  expect(created.thread).toMatchObject({ by: DANA, version: 1, anchor: { block: "costs-1" }, resolved: null });
  const tid = created.thread.id as string;
  expect(last(dana).cid).toBe("c1");

  // Dana (view) can't resolve Sam's thread, but can resolve her own.
  await sam.send({ t: "comment", cid: "c2", text: "Separate point", anchor: null });
  const samThread = last(dana).thread.id;
  await dana.send({ t: "resolve", cid: "r1", thread: samThread, resolved: true });
  expect(last(dana)).toMatchObject({ t: "rejected", cid: "r1" });
  await dana.send({ t: "resolve", cid: "r2", thread: tid, resolved: true });
  expect(last(sam).thread.resolved.by).toBe(DANA);

  await sam.send({ t: "comment", cid: "c3", thread: tid, text: "Yes, per seat." });
  expect(last(dana).thread).toMatchObject({ id: tid, resolved: null });
  expect(last(dana).thread.comments.map((c: any) => c.by)).toEqual([DANA, SAM]);

  // Only your own comment can be deleted (owners excepted).
  const samComment = last(dana).thread.comments[1].id;
  await dana.send({ t: "comment:delete", cid: "d1", comment: samComment });
  expect(last(dana)).toMatchObject({ t: "rejected", cid: "d1" });

  // Anonymous viewers can read but not comment.
  const anon = await connect(h, { id, email: null, role: "view" });
  await anon.send({ t: "comment", cid: "a1", text: "hi" });
  expect(last(anon)).toMatchObject({ t: "rejected" });
});

test("collab keys are stamped: no forged votes or edits of others' comments", async () => {
  const id = await make();
  const sam = await connect(h, { id, email: SAM, role: "edit" });
  await sam.send({ t: "set", cid: "v1", key: `poll/pick/${DANA}`, value: ["A"] });
  expect(last(sam)).toMatchObject({ t: "rejected", cid: "v1" });
  await sam.send({ t: "set", cid: "v2", key: `poll/pick/${SAM}`, value: ["A"] });
  expect(last(sam)).toMatchObject({ t: "set", key: `poll/pick/${SAM}` });

  await sam.send({ t: "set", cid: "k1", key: "comments/main/001-x", value: { by: DANA, text: "forged author", at: 1 } });
  expect(last(sam).value.by).toBe(SAM);
  const other = await connect(h, { id, email: "lee@corp.com", role: "edit" });
  await other.send({ t: "set", cid: "k2", key: "comments/main/001-x", value: null });
  expect(last(other)).toMatchObject({ t: "rejected", cid: "k2" });
});

test("activity returns events after a cursor, with notes and resolves", async () => {
  const id = await make();
  const thread = h.hub.addComment(id, DANA, { text: "Costs look low", anchor: { block: "costs-1" } }, ORIGIN);
  const first = h.hub.activity({});
  expect(first.events.map((e) => e.type)).toEqual(["version", "thread"]);
  expect(first.events[1]).toMatchObject({ actor: DANA, thread: thread.id, text: "Costs look low", title: "Plan" });

  const r = await h.hub.editText(id, "index.mdx", [{ oldText: "$10", newText: "$12" }], undefined, {
    note: "Corrected the price",
    resolves: [thread.id],
  });
  expect(r.ok).toBe(true);
  const next = h.hub.activity({ since: first.cursor });
  expect(next.events.map((e) => e.type)).toEqual(["version", "resolve"]);
  expect(next.events[0]).toMatchObject({ note: "Corrected the price", resolves: [thread.id] });
  expect(h.hub.threads(id)[0]).toMatchObject({ addressedIn: 2, resolved: { by: "agent" } });
  expect(h.hub.activity({ since: next.cursor }).events).toEqual([]);
  expect(h.hub.history(id)[0].note).toBe("Corrected the price");
});

test("state events coalesce per key and person", async () => {
  const id = await make();
  const sam = await connect(h, { id, email: SAM, role: "edit" });
  for (const text of ["a", "ab", "abc"]) await sam.send({ t: "set", cid: text, key: "notes/n", value: { text } });
  const events = h.hub.activity({ id }).events.filter((e) => e.type === "state");
  expect(events.length).toBe(1);
  expect(String(events[0].value)).toContain("abc");
});

test("visits report what changed since last time, and unread comments", async () => {
  const id = await make();
  expect(h.hub.visit(id, DANA).since).toBeUndefined();
  await h.hub.editText(id, "index.mdx", [{ oldText: "We pay $10 a month.", newText: "We pay $12 a month." }], undefined, { note: "New price" });
  await h.hub.editText(id, "index.mdx", [{ oldText: "## Risks\n\nNone yet.\n", newText: "" }], undefined, { note: "Dropped risks" });
  h.hub.addComment(id, SAM, { text: "Looks good" });
  const listed = h.hub.list(DANA)[0];
  expect(listed).toMatchObject({ unseen: true, unread: 1 });

  const v = h.hub.visit(id, DANA);
  expect(v.since).toMatchObject({ fromVersion: 1, changedBlocks: ["costs-1"], removedHeadings: ["Risks"] });
  expect(v.since!.versions.map((x) => x.note)).toEqual(["Dropped risks", "New price"]);
  // Still shown on a reload right after, but the artifact counts as seen.
  expect(h.hub.visit(id, DANA).since?.fromVersion).toBe(1);
  expect(h.hub.list(DANA)[0]).toMatchObject({ unseen: false, unread: 1 });
});

test("previews are generic unless opted in or public", async () => {
  const id = await make();
  expect(h.hub.previewInfo(id)).toMatchObject({ rich: false, image: false });
  h.hub.updateMeta(id, { preview: true });
  expect(h.hub.previewInfo(id)).toMatchObject({ rich: true, title: "Plan" });
  h.hub.updateMeta(id, { preview: false });
  h.hub.share(id, { public: true });
  expect(h.hub.previewInfo(id)!.rich).toBe(true);
});

test("comment notifications follow watch levels, mentions and presence", async () => {
  const id = await make();
  await ntfy(OWNER);
  await ntfy(DANA);
  await ntfy(SAM);

  // Dana comments: the owner (default "all") hears; Sam (participating) doesn't; Dana never hears herself.
  const t = h.hub.addComment(id, DANA, { text: "Is $10 right?" }, ORIGIN);
  let out = await deliver();
  expect(out.map((o) => o.topic)).toEqual(["topic-owner"]);
  expect(out[0].body).toBe("dana commented: “Is $10 right?”");
  expect(out[0].title).toBe("Plan");
  expect(String(sent[0].init.headers && (sent[0].init.headers as Record<string, string>).Click)).toBe(`${ORIGIN}/a/${id}#thread=${t.id}`);

  // Sam replies and mentions nobody: Dana is a participant, the owner watches all.
  h.hub.addComment(id, SAM, { thread: t.id, text: "Yes" }, ORIGIN);
  out = await deliver();
  expect(out.map((o) => o.topic).sort()).toEqual(["topic-dana", "topic-owner"]);
  expect(out.find((o) => o.topic === "topic-dana")!.body).toBe("sam replied: “Yes”");

  // A mention reaches a participating watcher; muting silences even mentions.
  h.hub.addComment(id, DANA, { text: `@${SAM} can you check?` }, ORIGIN);
  out = await deliver();
  expect(out.find((o) => o.topic === "topic-sam")!.body).toContain("mentioned you");
  h.hub.setWatch(SAM, id, "mute");
  h.hub.addComment(id, DANA, { text: `@${SAM} ping` }, ORIGIN);
  out = await deliver();
  expect(out.map((o) => o.topic)).toEqual(["topic-owner"]);

  // Nobody is notified while they have the artifact open.
  await connect(h, { id, email: OWNER, role: "owner" });
  h.hub.addComment(id, DANA, { text: "while you're here" }, ORIGIN);
  expect(await deliver()).toEqual([]);
});

test("several comments become one message", async () => {
  const id = await make();
  await ntfy(OWNER);
  h.directory.setName(DANA, "Dana Lee");
  h.hub.addComment(id, DANA, { text: "one" }, ORIGIN);
  h.hub.addComment(id, SAM, { text: "two" }, ORIGIN);
  h.hub.addComment(id, DANA, { text: "three" }, ORIGIN);
  const out = await deliver();
  expect(out.length).toBe(1);
  expect(out[0].body).toBe("3 new comments from Dana Lee and sam");
});

test("updates reach 'all' watchers except the person whose agent made them; addressed threads notify their author", async () => {
  const id = await make();
  await ntfy(OWNER);
  await ntfy(DANA);
  await ntfy(SAM);
  h.hub.setWatch(SAM, id, "all");
  h.hub.setWatch(OWNER, id, "all");
  const t = h.hub.addComment(id, DANA, { text: "Typo in intro" }, ORIGIN);
  await deliver();
  await h.hub.editText(id, "index.mdx", [{ oldText: "Intro text", newText: "Intro" }], undefined, { note: "Fixed typo", resolves: [t.id], origin: ORIGIN, onBehalf: OWNER });
  await h.hub.editText(id, "index.mdx", [{ oldText: "None yet.", newText: "Vendor lock-in." }], undefined, { note: "Added a risk", origin: ORIGIN, onBehalf: OWNER });
  const out = await deliver();
  const byTopic = Object.fromEntries(out.map((o) => [o.topic, o.body]));
  expect(byTopic["topic-sam"]).toBe("Updated to v3: Fixed typo; Added a risk");
  expect(byTopic["topic-dana"]).toBe("Your comment was addressed in v2");
  expect(byTopic["topic-owner"]).toBeUndefined();
});

test("failing channels are paused after repeated errors; gone push endpoints are removed", async () => {
  const id = await make();
  const channel = await ntfy(OWNER);
  globalThis.fetch = mock(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  for (let i = 0; i < 5; i++) {
    h.hub.addComment(id, DANA, { text: `c${i}` }, ORIGIN);
    await h.hub.deliverDue(Date.now() + 3_600_000);
  }
  const ch = h.directory.profile(OWNER).channels.find((c) => c.id === channel)!;
  expect(ch.disabled).toBe(true);
  expect(ch.lastError).toBeTruthy();
  h.directory.recordChannelResult(channel, { ok: false, error: "gone", gone: true });
  expect(h.directory.profile(OWNER).channels).toEqual([]);
});

test("profile lists watches with defaults", async () => {
  const id = await make();
  expect(h.hub.watches(DANA)).toEqual([{ id, title: "Plan", level: "participating", custom: false }]);
  expect(h.hub.watches(OWNER)[0].level).toBe("all");
  h.hub.setWatch(DANA, id, "all");
  expect(h.hub.watches(DANA)[0]).toMatchObject({ level: "all", custom: true });
  h.hub.setWatch(DANA, id, null);
  expect(h.hub.watches(DANA)[0]).toMatchObject({ level: "participating", custom: false });
});

test("deleting an artifact removes its threads, events and watches", async () => {
  const id = await make();
  h.hub.addComment(id, DANA, { text: "x" }, ORIGIN);
  h.hub.setWatch(DANA, id, "all");
  h.hub.delete(id);
  expect(h.hub.activity({}).events).toEqual([]);
  expect(h.hub.watches(DANA)).toEqual([]);
});

test("agent replies notify participants but not the person the agent acts for", async () => {
  const id = await make();
  await ntfy(OWNER);
  await ntfy(DANA);
  const t = h.hub.addComment(id, DANA, { text: "Question" }, ORIGIN);
  await deliver();
  h.hub.addComment(id, "agent", { thread: t.id, text: "Answer", onBehalf: OWNER }, ORIGIN);
  const out = await deliver();
  expect(out.map((o) => o.topic)).toEqual(["topic-dana"]);
  expect(out[0].body).toBe("Agent replied: “Answer”");
});

test("anonymous sockets get no threads; view role sees no share list", async () => {
  const id = await make();
  h.hub.addComment(id, SAM, { text: "hello" }, ORIGIN);
  const anon = await connect(h, { id, email: null, role: "view" });
  expect(anon.socket.messages.some((m: any) => m.t === "threads")).toBe(false);
  h.hub.addComment(id, SAM, { text: "again" }, ORIGIN);
  expect(anon.socket.messages.some((m: any) => m.t === "thread")).toBe(false);
  const dana = await connect(h, { id, email: DANA, role: "view" });
  const people = (dana.socket.messages.find((m: any) => m.t === "threads") as any).people.map((p: any) => p.email);
  expect(people.sort()).toEqual([DANA, SAM].sort());
  const sam = await connect(h, { id, email: SAM, role: "edit" });
  expect((sam.socket.messages.find((m: any) => m.t === "threads") as any).people.map((p: any) => p.email)).toContain(OWNER);
});

test("a view-role reply doesn't reopen someone else's resolved thread", async () => {
  const id = await make();
  const t = h.hub.addComment(id, SAM, { text: "done?" }, ORIGIN, undefined, "edit");
  h.hub.resolveThread(id, SAM, t.id, true, { role: "edit" });
  const after = h.hub.addComment(id, DANA, { thread: t.id, text: "." }, ORIGIN, undefined, "view");
  expect(after.resolved).not.toBeNull();
  const reopened = h.hub.addComment(id, SAM, { thread: t.id, text: "more" }, ORIGIN, undefined, "edit");
  expect(reopened.resolved).toBeNull();
});

test("activity for one quiet artifact still returns its recent events; coalesced edits advance the cursor", async () => {
  const id = await make();
  h.hub.addComment(id, DANA, { text: "old comment" }, ORIGIN);
  const other = await h.hub.create({ title: "Other", files, owner: OWNER });
  if (!other.ok) throw new Error("create");
  for (let i = 0; i < 5; i++) h.hub.addComment(other.id, DANA, { text: `noise ${i}` }, ORIGIN);
  expect(h.hub.activity({ id, limit: 3 }).events.map((e) => e.type)).toEqual(["version", "thread"]);
  const sam = await connect(h, { id, email: SAM, role: "edit" });
  await sam.send({ t: "set", cid: "a", key: "notes/n", value: { text: "a" } });
  const cursor = h.hub.activity({ id }).cursor;
  await sam.send({ t: "set", cid: "b", key: "notes/n", value: { text: "ab" } });
  const next = h.hub.activity({ id, since: cursor }).events;
  expect(next.length).toBe(1);
  expect(String(next[0].value)).toContain("ab");
});

test("the changed-since banner survives a reload shortly after", async () => {
  const id = await make();
  h.hub.visit(id, DANA);
  await h.hub.editText(id, "index.mdx", [{ oldText: "None yet.", newText: "Lock-in." }], undefined, { note: "Risk" });
  expect(h.hub.visit(id, DANA).since?.versions.length).toBe(1);
  expect(h.hub.visit(id, DANA).since?.changedBlocks).toEqual(["risks-1"]);
});

test("inserting a paragraph marks only the new one", async () => {
  const id = await make();
  h.hub.visit(id, DANA);
  await h.hub.editText(id, "index.mdx", [{ oldText: "## Costs\n\n", newText: "## Costs\n\nA new first paragraph.\n\n" }]);
  expect(h.hub.visit(id, DANA).since?.changedBlocks).toEqual(["costs-1"]);
});

test("notifications go by email by default", async () => {
  const mails: { to: string; subject: string; headers?: Record<string, string> }[] = [];
  h.env.EMAIL = { send: async (m: { to: string; subject: string }) => void mails.push(m) };
  h.env.MAIL_FROM = "sign-in@mail.test";
  h.env.APEX_ORIGIN = "https://artifacts.test";
  // owner@example.com is a test address (never mailed), so this artifact belongs to a deliverable one.
  const PAT = "pat@corp.co";
  const r = await h.hub.create({ title: "Plan", files, owner: PAT });
  if (!r.ok) throw new Error("create");
  const id = r.id;
  h.hub.share(id, { add: [{ email: DANA, role: "view" }] });
  h.hub.addComment(id, DANA, { text: "Is this right?" }, ORIGIN);
  await h.hub.deliverDue(Date.now() + 3_600_000);
  expect(mails.map((m) => m.to)).toEqual([PAT]);
  expect(mails[0].subject).toContain("Plan");
  expect(mails[0].headers?.["List-Unsubscribe"]).toBe("<https://artifacts.test/me>");
  h.directory.setEmailNotifications(PAT, false);
  h.hub.addComment(id, DANA, { text: "again" }, ORIGIN);
  await h.hub.deliverDue(Date.now() + 3_600_000);
  expect(mails.length).toBe(1);
});

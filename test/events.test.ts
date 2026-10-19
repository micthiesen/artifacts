// MCP events (SEP-3415): polling, webhook subscriptions and delivery, and the
// 2026-07-28 request rules they ride on.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { ADMIN, createHub, type Harness } from "./support/do-harness.ts";
import { handleMcp, type Ctx } from "../src/worker/mcp.ts";
import { signWebhook, toOccurrence } from "../src/worker/events.ts";

let h: Harness;
const OWNER = "owner@corp.com";
const DANA = "dana@corp.com";
const SAM = "sam@corp.com";
const HOOK = "https://hooks.example.net/mcp";
const SECRET = `whsec_${btoa("k".repeat(32))}`;
const files = { "index.mdx": "# Launch\n\nShip it.\n" };
const realFetch = globalThis.fetch;
let posts: { url: string; headers: Record<string, string>; body: any }[] = [];
let answer: (body: any) => Response = () => new Response("ok");

async function make() {
  const r = await h.hub.create({ title: "Launch", files, owner: OWNER });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  h.hub.share(r.id, { add: [{ email: DANA, role: "edit" }, { email: SAM, role: "edit" }] });
  return r.id;
}

function ctx(person = OWNER): Ctx {
  return { hub: h.hub as never, origin: "https://acme.artifacts.test", env: h.env as never, slug: "acme", workspace: "Acme", person, actor: "agent" };
}

/** A 2026-07-28 request with its headers and _meta filled in; `tweak` breaks one on purpose. */
async function modern(method: string, params: Record<string, unknown> = {}, tweak: (headers: Headers, body: any) => void = () => {}, person = OWNER) {
  const body: any = {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/events": {} } } } },
  };
  const headers = new Headers({ "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method });
  if (typeof params.name === "string") headers.set("Mcp-Name", params.name);
  tweak(headers, body);
  const res = await handleMcp(new Request("https://acme.artifacts.test/mcp", { method: "POST", headers, body: JSON.stringify(body) }), ctx(person));
  return { status: res.status, body: (await res.json()) as any };
}

beforeEach(async () => {
  h = await createHub();
  for (const p of [OWNER, DANA, SAM]) await h.hub.setMember(p, "member", ADMIN);
  posts = [];
  answer = (body) => (body.type === "verification" ? Response.json({ challenge: body.challenge }) : new Response("ok"));
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "null"));
    posts.push({ url: String(url), headers: init?.headers as Record<string, string>, body });
    return answer(body);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("signatures follow Standard Webhooks (its reference vector)", async () => {
  const sig = await signWebhook(["whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"], "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}');
  expect(sig).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
});

test("agents' own activity is never an event", () => {
  const e = { seq: 3, at: "2026-10-18T00:00:00Z", artifact: "a1", title: "T", type: "thread", data: { thread: "t1", text: "hi" } };
  expect(toOccurrence({ ...e, actor: "agent" }, "comment.created", "https://x")).toBeNull();
  expect(toOccurrence({ ...e, actor: DANA }, "comment.created", "https://x")).toMatchObject({ eventId: "evt_3", data: { by: DANA, threadId: "t1", text: "hi", url: "https://x/a/a1" } });
});

test("discover advertises the events extension; requests must carry matching headers", async () => {
  const d = await modern("server/discover");
  expect(d.status).toBe(200);
  expect(d.body.result).toMatchObject({ resultType: "complete", supportedVersions: expect.arrayContaining(["2026-07-28", "2025-11-25"]) });
  expect(d.body.result.capabilities.extensions["io.modelcontextprotocol/events"]).toEqual({});
  expect(d.body.result.capabilities.events).toEqual({});
  expect(d.body.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("artifacts-acme");

  const tools = await modern("tools/list");
  expect(tools.body.result).toMatchObject({ resultType: "complete", cacheScope: "private" });
  expect(tools.body.result.tools.length).toBeGreaterThan(10);

  expect((await modern("tools/list", {}, (hd) => hd.set("MCP-Protocol-Version", "2025-11-25"))).body.error.code).toBe(-32020);
  const old = await modern("tools/list", {}, (hd, b) => {
    hd.set("MCP-Protocol-Version", "1900-01-01");
    b.params._meta["io.modelcontextprotocol/protocolVersion"] = "1900-01-01";
  });
  expect(old.status).toBe(400);
  expect(old.body.error).toMatchObject({ code: -32022, data: { requested: "1900-01-01" } });
  expect((await modern("tools/list", {}, (hd) => hd.set("Mcp-Method", "tools/call"))).body.error.code).toBe(-32020);
  expect((await modern("tools/list", {}, (_, b) => delete b.params._meta["io.modelcontextprotocol/clientCapabilities"])).body.error.code).toBe(-32602);
  const named = await modern("tools/call", { name: "artifact_list", arguments: {} }, (hd) => hd.set("Mcp-Name", `=?base64?${btoa("artifact_list")}?=`));
  expect(named.body.result.isError).toBe(false);
  expect((await modern("tools/call", { name: "artifact_list", arguments: {} }, (hd) => hd.set("Mcp-Name", "artifact_read"))).body.error.code).toBe(-32020);
  const missing = await modern("nope/nothing");
  expect(missing.status).toBe(404);
  expect(missing.body.error.code).toBe(-32601);
});

test("poll: start from now, then only people's answers and comments you can see", async () => {
  const id = await make();
  const other = await h.hub.create({ title: "Private", files, owner: SAM });
  if (!other.ok) throw new Error("create");
  const start = await modern("events/poll", { name: "artifact.answered", arguments: {}, cursor: null });
  expect(start.body.result).toMatchObject({ events: [], hasMore: false, nextPollMs: 60_000, resultType: "complete" });
  const cursor = start.body.result.cursor;

  h.hub.setState(id, { [`approve/go/${DANA}`]: { decision: "changes", note: "Cheaper" } }, DANA);
  h.hub.setState(other.id, { [`poll/p/${SAM}`]: ["A"] }, SAM); // not shared with the owner
  h.hub.setState(id, { [`check/list/x`]: { done: true } }, SAM); // checklists aren't answers
  h.hub.addComment(id, "agent", { text: "from an agent" }, "https://acme.artifacts.test");
  h.hub.addComment(id, DANA, { text: "Is Monday firm?" }, "https://acme.artifacts.test");

  const answered = await modern("events/poll", { name: "artifact.answered", arguments: {}, cursor });
  expect(answered.body.result.events).toEqual([
    {
      eventId: expect.stringMatching(/^evt_\d+$/),
      name: "artifact.answered",
      timestamp: expect.any(String),
      data: {
        artifactId: id, title: "Launch", url: expect.stringContaining(`/a/${id}`), by: DANA, component: "approval", block: "go",
        stateKey: `approve/go/${DANA}`, withdrawn: false, decision: "changes", note: "Cheaper", version: 1, untrusted: ["title", "by", "block", "stateKey", "note"],
      },
    },
  ]);
  const comments = await modern("events/poll", { name: "comment.created", arguments: { artifact: id }, cursor });
  expect(comments.body.result.events.map((e: any) => e.data.text)).toEqual(["Is Monday firm?"]);
  // The next poll from the returned cursor is empty.
  expect((await modern("events/poll", { name: "comment.created", arguments: {}, cursor: comments.body.result.cursor })).body.result.events).toEqual([]);

  expect((await modern("events/poll", { name: "nope", cursor })).body.error).toMatchObject({ code: -32023, data: { kind: "event" } });
  expect((await modern("events/poll", { name: "comment.created", arguments: { artifact: other.id }, cursor })).body.error.code).toBe(-32024);
  expect((await modern("events/poll", { name: "comment.created", arguments: { colour: "red" }, cursor })).body.error.code).toBe(-32602);
  expect((await modern("events/stream", { name: "comment.created" })).body.error.code).toBe(-32026);
});

test("webhooks: verified endpoint, signed deliveries in order, refresh, retry and unsubscribe", async () => {
  const id = await make();
  const sub = await modern("events/subscribe", { name: "artifact.answered", arguments: { artifact: id }, delivery: { mode: "webhook", url: HOOK, secret: SECRET }, ttlMs: 7 * 24 * 3600_000 });
  const subId = sub.body.result.id as string;
  expect(subId).toMatch(/^sub_[0-9a-f]{20}$/);
  expect(sub.body.result).toMatchObject({ resultType: "complete", truncated: false });
  // At most a day, whatever was asked for.
  expect(Date.parse(sub.body.result.refreshBefore) - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
  expect(posts.map((p) => p.body.type)).toEqual(["verification"]);
  expect(posts[0].headers["X-MCP-Subscription-Id"]).toBe(subId);
  expect(posts[0].headers["webhook-id"]).toMatch(/^msg_verification_/);

  posts = [];
  h.hub.setState(id, { [`approve/go/${DANA}`]: { decision: "approve" } }, DANA);
  h.hub.setState(id, { [`form/needs/${SAM}`]: { values: { team: "Support" } } }, SAM);
  await h.hub.deliverEvents(Date.now() + 5_000);
  expect(posts.map((p) => p.body.data.component)).toEqual(["approval", "form"]);
  const first = posts[0];
  expect(first.headers["webhook-id"]).toBe(first.body.eventId);
  const sig = await signWebhook([SECRET], first.headers["webhook-id"], Number(first.headers["webhook-timestamp"]), JSON.stringify(first.body));
  expect(first.headers["webhook-signature"]).toBe(sig);
  expect(first.body.cursor).toMatch(/^s\d+$/);

  // A refresh keeps the same subscription and reports delivery; the endpoint isn't challenged again.
  posts = [];
  const refresh = await modern("events/subscribe", { name: "artifact.answered", arguments: { artifact: id }, delivery: { url: HOOK, secret: SECRET } });
  expect(refresh.body.result.id).toBe(subId);
  expect(refresh.body.result.deliveryStatus).toMatchObject({ active: true, lastError: null });
  expect(posts).toEqual([]);

  // Failures retry with backoff, and are reported as a category only.
  answer = () => new Response("nope", { status: 503 });
  h.hub.setState(id, { [`approve/go/${SAM}`]: { decision: "approve" } }, SAM);
  await h.hub.deliverEvents(Date.now() + 5_000);
  expect(posts.length).toBe(1);
  await h.hub.deliverEvents(Date.now() + 6_000); // backoff not over yet
  expect(posts.length).toBe(1);
  answer = () => new Response("ok");
  await h.hub.deliverEvents(Date.now() + 20_000);
  expect(posts.length).toBe(2);
  expect(posts[1].body.data.by).toBe(SAM);

  expect((await modern("events/unsubscribe", { name: "artifact.answered", arguments: { artifact: id }, delivery: { url: HOOK } })).body.result).toEqual({ resultType: "complete", _meta: expect.any(Object) });
  expect((await modern("events/unsubscribe", { name: "artifact.answered", arguments: { artifact: id }, delivery: { url: HOOK } })).body.error.code).toBe(-32023);
});

test("webhook subscribe refuses bad endpoints and secrets", async () => {
  const sub = (delivery: Record<string, unknown>) => modern("events/subscribe", { name: "comment.created", delivery });
  expect((await sub({ url: "http://hooks.example.net/x", secret: SECRET })).body.error.code).toBe(-32602);
  expect((await sub({ url: "https://10.0.0.1/x", secret: SECRET })).body.error.code).toBe(-32602);
  expect((await sub({ url: HOOK, secret: "whsec_short" })).body.error.code).toBe(-32602);
  answer = () => Response.json({ challenge: "wrong" });
  const failed = await sub({ url: HOOK, secret: SECRET });
  expect(failed.body.error).toMatchObject({ code: -32027, data: { reason: "challenge_failed" } });
  answer = () => new Response("no", { status: 404 });
  expect((await sub({ url: HOOK, secret: SECRET })).body.error.data.reason).toBe("http_4xx");
});

test("someone removed from the workspace gets a terminated envelope", async () => {
  const id = await make();
  await modern("events/subscribe", { name: "comment.created", delivery: { url: HOOK, secret: SECRET } }, undefined, DANA);
  await h.hub.setMember(DANA, null, ADMIN);
  posts = [];
  h.hub.addComment(id, SAM, { text: "hello" }, "https://acme.artifacts.test");
  await h.hub.deliverEvents(Date.now() + 5_000);
  expect(posts.map((p) => p.body)).toEqual([{ type: "terminated", error: { code: -32024, message: "Forbidden", data: { reason: "Access revoked" } } }]);
  await h.hub.deliverEvents(Date.now() + 60_000);
  expect(posts.length).toBe(1);
});

test("deliveries only carry events from artifacts the subscriber can open", async () => {
  const shared = await make();
  const hidden = await h.hub.create({ title: "Sam's", files, owner: SAM });
  if (!hidden.ok) throw new Error("create");
  await modern("events/subscribe", { name: "comment.created", delivery: { url: HOOK, secret: SECRET } }, undefined, DANA);
  posts = [];
  h.hub.addComment(hidden.id, SAM, { text: "private" }, "https://acme.artifacts.test");
  h.hub.addComment(shared, SAM, { text: "for everyone" }, "https://acme.artifacts.test");
  await h.hub.deliverEvents(Date.now() + 5_000);
  expect(posts.map((p) => p.body.data.text)).toEqual(["for everyone"]);
  // Caught up: nothing is scheduled, so an idle workspace doesn't wake.
  expect(h.ctx.sqlStorage.exec(`SELECT next_at FROM event_subs`).toArray()[0].next_at).toBeNull();
});

test("a failing event is retried, then skipped; 410 is skipped at once; a dead endpoint pauses until refreshed", async () => {
  const id = await make();
  const subscribe = () => modern("events/subscribe", { name: "artifact.answered", delivery: { url: HOOK, secret: SECRET }, ttlMs: 24 * 3600_000 });
  await subscribe();
  answer = (b) => (b.data?.by === DANA ? new Response("gone", { status: 410 }) : new Response("ok"));
  h.hub.setState(id, { [`approve/go/${DANA}`]: { decision: "approve" } }, DANA);
  h.hub.setState(id, { [`approve/go/${SAM}`]: { decision: "approve" } }, SAM);
  posts = [];
  await h.hub.deliverEvents(Date.now() + 5_000);
  expect(posts.map((p) => p.body.data.by)).toEqual([DANA, SAM]);

  answer = () => new Response("down", { status: 500 });
  h.hub.setState(id, { [`approve/go/${OWNER}`]: { decision: "changes" } }, OWNER);
  h.hub.setState(id, { [`approve/go/${DANA}`]: { decision: "changes" } }, DANA);
  posts = [];
  let t = Date.now() + 5_000;
  for (let i = 0; i < 5; i++) {
    await h.hub.deliverEvents(t);
    t += 11 * 60_000;
  }
  // Five tries at the owner's answer, then it's skipped and Dana's is next.
  expect(posts.filter((p) => p.body.data.by === OWNER).length).toBe(5);
  await h.hub.deliverEvents(t);
  expect(posts.at(-1)!.body.data.by).toBe(DANA);

  // After an hour of failures delivery pauses: no further attempts until a refresh.
  for (let i = 0; i < 10; i++) {
    t += 11 * 60_000;
    await h.hub.deliverEvents(t);
  }
  const paused = posts.length;
  await h.hub.deliverEvents(t + 60 * 60_000);
  expect(posts.length).toBe(paused);
  const row = h.ctx.sqlStorage.exec(`SELECT suspended, last_error FROM event_subs`).toArray()[0];
  expect(row).toMatchObject({ suspended: 1, last_error: "http_5xx" });
  answer = () => new Response("ok");
  const refreshed = await subscribe();
  expect(refreshed.body.result.deliveryStatus).toMatchObject({ active: true, lastError: "http_5xx" });
  expect(h.ctx.sqlStorage.exec(`SELECT suspended FROM event_subs`).toArray()[0].suspended).toBe(0);
});

test("long answers keep their decision and note in the payload", async () => {
  const id = await make();
  const start = (await modern("events/poll", { name: "artifact.answered", cursor: null })).body.result.cursor;
  const note = "Because ".repeat(120);
  h.hub.setState(id, { [`approve/go/${DANA}`]: { decision: "changes", note } }, DANA);
  const ev = (await modern("events/poll", { name: "artifact.answered", cursor: start })).body.result.events[0];
  expect(ev.data.decision).toBe("changes");
  expect(ev.data.note).toBe(note.trim().slice(0, 500));
});

test("an answer from a tab left open on an older version is recorded against that version", async () => {
  const id = await make();
  await h.hub.writeFiles(id, { "index.mdx": "# Launch\n\nShip it Monday.\n" });
  h.hub.setState(id, { [`approve/go/${DANA}`]: { decision: "approve", version: 1 } }, DANA);
  h.hub.setState(id, { [`approve/go/${SAM}`]: { decision: "approve", version: 9 } }, SAM);
  h.hub.setState(id, { [`approve/go/${OWNER}`]: { decision: "approve" } }, OWNER);
  const state = h.hub.state(id) as Record<string, { version: number }>;
  expect([state[`approve/go/${DANA}`].version, state[`approve/go/${SAM}`].version, state[`approve/go/${OWNER}`].version]).toEqual([1, 2, 2]);
});

test("callback URLs use the default https port, and new endpoints are rate-limited", async () => {
  const sub = (url: string) => modern("events/subscribe", { name: "comment.created", delivery: { url, secret: SECRET } });
  expect((await sub("https://hooks.example.net:8443/x")).body.error.code).toBe(-32602);
  answer = () => new Response("no", { status: 500 });
  for (let i = 0; i < 10; i++) expect((await sub(`https://hooks.example.net/x${i}`)).body.error.code).toBe(-32027);
  expect((await sub("https://hooks.example.net/eleventh")).body.error).toMatchObject({ code: -32025, data: { limit: "verifications" } });
});

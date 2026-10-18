// Approvals, form responses, who has read what, and the notifications they send.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { ADMIN, createHub, type Harness } from "./support/do-harness.ts";
import { handleMcp, type Ctx } from "../src/worker/mcp.ts";

let h: Harness;
const OWNER = "owner@example.com";
const DANA = "dana@corp.com";
const SAM = "sam@corp.com";
const ORIGIN = "https://art.test";
const files = { "index.mdx": "# Launch\n\nShip it.\n" };
const realFetch = globalThis.fetch;
let sent: { url: string; init: RequestInit }[] = [];

async function make() {
  const r = await h.hub.create({ title: "Launch", files, owner: OWNER });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  h.hub.share(r.id, { add: [{ email: DANA, role: "view" }, { email: SAM, role: "edit" }] });
  return r.id;
}

async function deliver() {
  sent = [];
  await h.hub.deliverDue(Date.now() + 3_600_000);
  return sent;
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

test("decisions and responses are stamped and only ever your own", async () => {
  const id = await make();
  h.hub.setState(id, { [`approve/launch/${SAM}`]: { decision: "changes", note: "  Needs macros  ", by: DANA, at: 1 } }, SAM, undefined, { role: "edit" });
  const decision = h.hub.state(id)[`approve/launch/${SAM}`] as Record<string, unknown>;
  expect(decision).toMatchObject({ decision: "changes", note: "Needs macros", by: SAM, version: 1 });
  expect(decision.at).toBeGreaterThan(1);

  expect(() => h.hub.setState(id, { [`approve/launch/${DANA}`]: { decision: "approve" } }, SAM)).toThrow("your own decision");
  expect(() => h.hub.setState(id, { [`approve/launch/${SAM}`]: { decision: "maybe" } }, SAM)).toThrow('"approve" or "changes"');
  expect(() => h.hub.setState(id, { [`form/needs/${DANA}`]: { values: {} } }, SAM)).toThrow("your own response");
  expect(() => h.hub.setState(id, { [`form/needs/${SAM}`]: { team: "Support" } }, SAM)).toThrow("needs values");

  expect(() => h.hub.setState(id, { [`form/needs/${SAM}`]: { values: { team: { nested: true } } } }, SAM)).toThrow("text, a number or true/false");
  expect(() => h.hub.setState(id, { [`form/a"b/${SAM}`]: { values: {} } }, SAM)).toThrow("isn't a valid form id");

  h.hub.setState(id, { [`form/needs/${SAM}`]: { values: { team: "Support", agents: 12 } } }, SAM);
  expect(h.hub.state(id)[`form/needs/${SAM}`]).toMatchObject({ values: { team: "Support", agents: 12 }, by: SAM, version: 1 });
  // Withdrawing is allowed.
  h.hub.setState(id, { [`approve/launch/${SAM}`]: null }, SAM);
  expect(h.hub.state(id)[`approve/launch/${SAM}`]).toBeUndefined();
});

test("a decision notifies the owner once per person, with the latest decision", async () => {
  const id = await make();
  await h.directory.addChannel(OWNER, "ntfy", { server: "https://ntfy.sh", topic: "owner" }, "ntfy");
  await h.directory.addChannel(SAM, "ntfy", { server: "https://ntfy.sh", topic: "sam" }, "ntfy");
  h.hub.setState(id, { [`approve/launch/${SAM}`]: { decision: "changes", note: "Needs macros" } }, SAM, undefined, { origin: ORIGIN });
  h.hub.setState(id, { [`approve/launch/${SAM}`]: { decision: "approve" } }, SAM, undefined, { origin: ORIGIN });
  h.hub.setState(id, { [`form/needs/${SAM}`]: { values: { team: "Support" } } }, SAM, undefined, { origin: ORIGIN });
  const out = await deliver();
  expect(out.map((s) => s.url)).toEqual(["https://ntfy.sh/owner"]);
  expect(String(out[0].init.body)).toBe('sam approved\nsam sent a response to the "needs" form');

  // The owner's own decision (or their agent's) doesn't notify them.
  h.hub.setState(id, { [`approve/launch/${OWNER}`]: { decision: "approve" } }, OWNER, undefined, { origin: ORIGIN });
  expect(await deliver()).toEqual([]);
});

test("webhooks carry the artifact and each event for automations", async () => {
  const id = await make();
  await h.directory.addChannel(OWNER, "webhook", { url: "https://hooks.example.net/agent" }, "webhook");
  h.hub.setState(id, { [`approve/launch/${SAM}`]: { decision: "changes", note: "Needs macros" } }, SAM, undefined, { origin: ORIGIN });
  h.hub.addComment(id, DANA, { text: "Is the date firm?" }, ORIGIN);
  const out = await deliver();
  expect(out.length).toBe(1);
  const body = JSON.parse(String(out[0].init.body));
  expect(body.artifact).toEqual({ id, title: "Launch" });
  expect(body.url).toStartWith(`${ORIGIN}/a/${id}`);
  const kinds = body.events.map((e: { kind: string }) => e.kind).sort();
  expect(kinds).toEqual(["comment", "response"]);
  expect(body.events.find((e: { kind: string }) => e.kind === "response")).toEqual({
    kind: "response", component: "approval", block: "launch", decision: "changes", note: "Needs macros", changed: false, by: SAM,
  });
  expect(body.events.find((e: { kind: string }) => e.kind === "comment")).toMatchObject({ by: DANA, text: "Is the date firm?", why: "all" });
});

test("readers: who opened which version, without the owner or people who lost access", async () => {
  const id = await make();
  h.hub.visit(id, OWNER);
  h.hub.visit(id, DANA);
  expect(h.hub.readers(id)).toEqual([{ email: DANA, version: 1, at: expect.any(String) }]);
  await h.hub.writeFiles(id, { "index.mdx": "# Launch\n\nShip it Monday.\n" });
  h.hub.visit(id, SAM);
  expect(Object.fromEntries(h.hub.readers(id).map((r) => [r.email, r.version]))).toEqual({ [DANA]: 1, [SAM]: 2 });
  h.hub.share(id, { remove: [DANA] });
  expect(h.hub.readers(id).map((r) => r.email)).toEqual([SAM]);
});

test("artifact_readers tells the agent who hasn't seen the latest version", async () => {
  await h.hub.setMember(OWNER, "member", ADMIN);
  const id = await make();
  h.hub.share(id, { add: [{ email: "lee@corp.com", role: "view" }, { email: "workspace", role: "view" }] });
  await h.hub.setMember("kai@corp.com", "member", ADMIN);
  h.hub.visit(id, DANA);
  await h.hub.writeFiles(id, { "index.mdx": "# Launch\n\nShip it Monday.\n" });
  h.hub.visit(id, SAM);
  h.hub.visit(id, "kai@corp.com");
  const ctx: Ctx = { hub: h.hub as never, origin: "https://acme.artifacts.test", env: h.env as never, slug: "acme", person: OWNER, actor: "agent" };
  const call = async (person: string) => {
    const res = await handleMcp(
      new Request("https://acme.artifacts.test/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "artifact_readers", arguments: { id } } }) }),
      { ...ctx, person },
    );
    return ((await res.json()) as { result: { isError: boolean; content: { text: string }[]; structuredContent?: any } }).result;
  };
  const r = await call(OWNER);
  expect(r.isError).toBe(false);
  const text = r.content[0].text;
  expect(text).toStartWith("v2 is current.");
  expect(text).toContain(`${DANA} (view): saw v1 (1 version behind)`);
  expect(text).toContain(`${SAM} (edit): saw v2 (current)`);
  expect(text).toContain("lee@corp.com (view): hasn't opened it");
  expect(text).toContain("Also opened by:\n- kai@corp.com: saw v2 (current)");
  expect(r.structuredContent.shared.find((s: any) => s.email === "lee@corp.com").seen).toBeNull();
  // Only the owner (or an admin) sees who read it.
  expect((await call(SAM)).isError).toBe(true);
});

test("an agent can read decisions and responses but never make them", async () => {
  await h.hub.setMember(SAM, "member", ADMIN);
  const id = await make();
  h.hub.setState(id, { [`approve/launch/${SAM}`]: { decision: "approve" } }, SAM);
  const ctx: Ctx = { hub: h.hub as never, origin: "https://acme.artifacts.test", env: h.env as never, slug: "acme", person: SAM, actor: "agent" };
  const call = async (args: Record<string, unknown>) => {
    const res = await handleMcp(
      new Request("https://acme.artifacts.test/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "artifact_state", arguments: { id, ...args } } }) }),
      ctx,
    );
    return ((await res.json()) as { result: { isError: boolean; content: { text: string }[] } }).result;
  };
  for (const set of [{ [`approve/launch/${SAM}`]: { decision: "changes" } }, { [`approve/launch/${SAM}`]: null }, { [`form/needs/${SAM}`]: { values: { a: "b" } } }]) {
    const r = await call({ set });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("only be made by people on the page");
  }
  expect(h.hub.state(id)[`approve/launch/${SAM}`]).toMatchObject({ decision: "approve", by: SAM });
  const read = await call({ prefix: "approve/" });
  expect(read.isError).toBe(false);
  expect(read.content[0].text).toContain('"decision": "approve"');
  const activity = await handleMcp(
    new Request("https://acme.artifacts.test/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "artifact_activity", arguments: { id } } }) }),
    ctx,
  );
  const text = ((await activity.json()) as { result: { content: { text: string }[] } }).result.content[0].text;
  expect(text).toContain(`${SAM} approved in approval "launch"`);
});

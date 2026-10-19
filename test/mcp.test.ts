// MCP tools act as one person, with that person's role on each artifact.
import { beforeEach, expect, test } from "bun:test";
import { ADMIN, createHub, type Harness } from "./support/do-harness.ts";
import { handleMcp, runOwnerTool, type Ctx } from "../src/worker/mcp.ts";
import { verifyToken } from "../src/worker/session.ts";

let h: Harness;
const MIA = "mia@corp.com";
const OLU = "olu@corp.com";
const files = { "index.mdx": "# Hi\n\nText.\n" };

function ctx(person: string): Ctx {
  return { hub: h.hub as never, origin: "https://acme.artifacts.test", env: h.env as never, slug: "acme", person, actor: "agent" };
}

async function call(person: string, name: string, args: Record<string, unknown>) {
  const res = await handleMcp(
    new Request("https://acme.artifacts.test/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }),
    ctx(person),
  );
  const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[]; structuredContent?: any } };
  return { error: body.result.isError, text: body.result.content[0].text, data: body.result.structuredContent };
}

beforeEach(async () => {
  h = await createHub();
  await h.hub.setMember(MIA, "member", ADMIN);
  await h.hub.setMember(OLU, "member", ADMIN);
});

test("create makes the agent's person the owner; others need a share to see it", async () => {
  const created = await call(MIA, "artifact_create", { title: "Mia's", files });
  expect(created.error).toBe(false);
  const id = created.data.id as string;
  expect(h.hub.meta(id)!.owner).toBe(MIA);
  expect((await call(OLU, "artifact_list", {})).data.artifacts).toEqual([]);
  expect((await call(OLU, "artifact_read", { id })).text).toContain(`No artifact ${id}`);

  await call(MIA, "artifact_share", { id, add: [{ email: "workspace", role: "view" }] });
  expect((await call(OLU, "artifact_list", {})).data.artifacts.map((a: any) => a.id)).toEqual([id]);
  const denied = await call(OLU, "artifact_edit", { id, path: "index.mdx", edits: [{ oldText: "Text.", newText: "Mine now." }] });
  expect(denied.error).toBe(true);
  expect(denied.text).toContain("has view access");
  // An admin's agent can manage anything in the workspace.
  expect((await call(ADMIN, "artifact_edit", { id, path: "index.mdx", edits: [{ oldText: "Text.", newText: "Fixed." }] })).error).toBe(false);
});

test("sign-in links are only for the agent's own person, and bound to the workspace", async () => {
  const id = (await call(MIA, "artifact_create", { title: "x", files })).data.id as string;
  const link = (await call(MIA, "artifact_link", { id })).data;
  expect(link.email).toBe(MIA);
  const claims = await verifyToken<{ e: string; a: string; w: string }>(h.env.LOGIN_SECRET, "link", link.link.split("/s/")[1]);
  expect(claims).toMatchObject({ e: MIA, a: id, w: "acme" });
  // Never one for someone else: they get theirs by email.
  await call(MIA, "artifact_share", { id, add: [{ email: OLU, role: "view" }], notify: false });
  expect((await call(MIA, "artifact_link", { id, email: OLU })).text).toContain("only for you");
  expect((await call(OLU, "artifact_link", { id })).error).toBe(false);
});

test("agent comments don't notify their own person", async () => {
  const id = (await call(MIA, "artifact_create", { title: "x", files })).data.id as string;
  await call(MIA, "artifact_comment", { id, text: "Note to self" });
  expect(h.ctx.sqlStorage.exec(`SELECT COUNT(*) AS n FROM outbox`).toArray()[0].n).toBe(0);
});

test("the owner menu uses the same checks", async () => {
  const id = (await call(MIA, "artifact_create", { title: "x", files })).data.id as string;
  const olu: Ctx = { ...ctx(OLU), actor: OLU };
  expect((await runOwnerTool("artifact_update", { id, title: "taken" }, olu)).isError).toBe(true);
  expect((await runOwnerTool("artifact_update", { id, title: "renamed" }, { ...ctx(MIA), actor: MIA })).isError).toBeFalsy();
  expect(h.hub.meta(id)!.title).toBe("renamed");
});

test("sharing emails each new person their own link, and never hands it to the sharer", async () => {
  const sent: { to: string; subject: string; text: string }[] = [];
  h.env.EMAIL = { send: async (m: { to: string; subject: string; text: string }) => void sent.push(m) };
  h.env.MAIL_FROM = "sign-in@mail.test";
  await h.directory.verifyLogin(OLU, await h.directory.startLogin(OLU));
  const id = (await call(MIA, "artifact_create", { title: "Plan", files })).data.id as string;
  const r = await call(MIA, "artifact_share", { id, add: [{ email: "new@client.co", role: "view" }, { email: OLU, role: "view" }] });
  expect(r.data.emailed).toEqual({ "new@client.co": "link", [OLU]: "page" });
  expect(JSON.stringify(r)).not.toContain("/s/");
  expect(sent.find((m) => m.to === "new@client.co")!.text).toContain("/s/");
  expect(sent.find((m) => m.to === OLU)!.text).toContain(`/a/${id}`);
  // Re-sharing someone already on the list doesn't email them again; notify: false sends nothing.
  await call(MIA, "artifact_share", { id, add: [{ email: OLU, role: "edit" }] });
  await call(MIA, "artifact_share", { id, add: [{ email: "quiet@client.co", role: "view" }], notify: false });
  expect(sent.length).toBe(2);
});

test("a view-only person's agent can't resolve someone else's thread", async () => {
  const id = (await call(MIA, "artifact_create", { title: "x", files })).data.id as string;
  await call(MIA, "artifact_share", { id, add: [{ email: OLU, role: "view" }], notify: false });
  const thread = (await call(MIA, "artifact_comment", { id, text: "Mine" })).data.thread.id;
  expect((await call(OLU, "artifact_comment", { id, thread, resolve: true })).error).toBe(true);
  expect((await call(MIA, "artifact_comment", { id, thread, resolve: true })).error).toBe(false);
});

test("an agent's shared-state writes are its person's: it can't vote as someone else", async () => {
  const id = (await call(MIA, "artifact_create", { title: "Poll", files })).data.id as string;
  expect((await call(MIA, "artifact_state", { id, set: { [`poll/p/${OLU}`]: "A" } })).error).toBe(true);
  expect((await call(MIA, "artifact_state", { id, set: { [`poll/p/${MIA}`]: "A" } })).error).toBe(false);
  await call(MIA, "artifact_state", { id, set: { "comments/main/1": { text: "hi", by: OLU } } });
  expect(h.hub.state(id)["comments/main/1"]).toMatchObject({ by: MIA });
});

test("create with public: true on a new Free workspace saves the artifact, shares it, and says the link stayed off", async () => {
  await h.hub.setPlan("free");
  const r = await call(MIA, "artifact_create", { title: "Day one", files, public: true, share: [{ email: OLU, role: "view" }] });
  expect(r.error).toBe(false);
  expect(r.text).toContain("public link stayed off");
  expect(h.hub.list(MIA).map((a) => a.title)).toEqual(["Day one"]);
  expect(h.hub.list(OLU).map((a) => a.title)).toEqual(["Day one"]);
  expect(h.hub.meta(r.data.id)!.public).toBe(false);
});

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

test("links default to the agent's person and are bound to the workspace", async () => {
  const id = (await call(MIA, "artifact_create", { title: "x", files })).data.id as string;
  const link = (await call(MIA, "artifact_link", { id })).data;
  expect(link.email).toBe(MIA);
  const claims = await verifyToken<{ e: string; a: string; w: string }>(h.env.LOGIN_SECRET, "link", link.link.split("/s/")[1]);
  expect(claims).toMatchObject({ e: MIA, a: id, w: "acme" });
  // A link for someone else is sharing, so it needs the owner, and the person needs access.
  expect((await call(MIA, "artifact_link", { id, email: OLU })).text).toContain("no access");
  await call(MIA, "artifact_share", { id, add: [{ email: OLU, role: "view" }] });
  expect((await call(OLU, "artifact_link", { id, email: MIA })).text).toContain("has view access");
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

test("no presigned link for someone who manages the artifact", async () => {
  const id = (await call(MIA, "artifact_create", { title: "x", files })).data.id as string;
  const r = await call(MIA, "artifact_link", { id, email: ADMIN });
  expect(r.error).toBe(true);
  expect(r.text).toContain("sign in themselves");
});

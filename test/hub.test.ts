import { beforeEach, expect, test } from "bun:test";
import { advanceAlarm, connect, createHub, type Harness } from "./support/do-harness.ts";

let h: Harness;
const OWNER = { email: "owner@example.com", owner: true };
const files = { "index.mdx": "# Hello\n\nSome text.\n" };

async function make() {
  const r = await h.hub.create({ title: "Doc", files });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.id;
}

beforeEach(async () => {
  h = await createHub();
});

test("create then list as owner", async () => {
  const id = await make();
  const list = h.hub.list(OWNER);
  expect(list.map((a) => a.id)).toEqual([id]);
  expect(list[0]).toMatchObject({ title: "Doc", version: 1, role: "owner" });
  expect(h.hub.list({ email: "x@example.com", owner: false })).toEqual([]);
});

test("editText bumps version and history records notes", async () => {
  const id = await make();
  const r = await h.hub.editText(id, "index.mdx", [{ oldText: "Some text.", newText: "Other text." }]);
  expect(r).toMatchObject({ ok: true, version: 2 });
  expect(h.hub.files(id)["index.mdx"]).toContain("Other text.");
  const notes = h.hub.history(id).map((e) => e.note);
  expect(notes).toContain("created");
  expect(notes).toContain("edit index.mdx");
});

test("share and roleFor for exact email and @domain", async () => {
  const id = await make();
  h.hub.share(id, {
    add: [
      { email: "a@corp.com", role: "edit" },
      { email: "@other.com", role: "view" },
    ],
  });
  expect(h.hub.roleFor(id, "a@corp.com", false)).toBe("edit");
  expect(h.hub.roleFor(id, "b@other.com", false)).toBe("view");
  expect(h.hub.roleFor(id, "c@nowhere.com", false)).toBeNull();
  expect(h.hub.roleFor(id, null, true)).toBe("owner");
  h.hub.share(id, { remove: ["a@corp.com"] });
  expect(h.hub.roleFor(id, "a@corp.com", false)).toBeNull();
});

test("setState via socket broadcasts to other sockets; view role is rejected", async () => {
  const id = await make();
  const editor = await connect(h, { id, email: "e@corp.com", role: "edit" });
  const other = await connect(h, { id, email: "v@corp.com", role: "view" });
  expect(editor.socket.messages[0]).toMatchObject({ t: "snapshot", seq: 0 });

  await editor.send({ t: "set", key: "k", value: { n: 1 }, cid: "c1" });
  const got = other.socket.messages.find((m) => m.t === "set");
  expect(got).toMatchObject({ key: "k", value: { n: 1 }, by: "e@corp.com" });
  expect(h.hub.state(id)).toMatchObject({ k: { n: 1 } });

  await other.send({ t: "set", key: "k", value: 2, cid: "c2" });
  expect(other.socket.messages.at(-1)).toMatchObject({ t: "rejected", cid: "c2" });
  expect(h.hub.state(id)).toMatchObject({ k: { n: 1 } });
});

test("delete removes the artifact and closes sockets", async () => {
  const id = await make();
  const c = await connect(h, { id, email: "e@corp.com", role: "edit" });
  h.hub.delete(id);
  expect(h.hub.list(OWNER)).toEqual([]);
  expect(h.hub.roleFor(id, null, true)).toBeNull();
  expect(c.socket.closed?.code).toBe(4004);
});

test("render check is skipped without a BROWSER binding; no alarm pending", async () => {
  const id = await make();
  const r = await h.hub.runRenderCheck(id, "https://x.test");
  expect(r.check.status).toBe("skipped");
  expect(await advanceAlarm(h)).toBe(false);
});

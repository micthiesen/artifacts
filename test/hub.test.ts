import { beforeEach, expect, test } from "bun:test";
import { advanceAlarm, connect, createHub, type Harness } from "./support/do-harness.ts";

let h: Harness;
const OWNER = "owner@example.com";
const files = { "index.mdx": "# Hello\n\nSome text.\n" };

async function make() {
  const r = await h.hub.create({ title: "Doc", files, owner: OWNER });
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
  expect(h.hub.list("x@example.com")).toEqual([]);
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
  expect(h.hub.roleFor(id, "a@corp.com")).toBe("edit");
  expect(h.hub.roleFor(id, "b@other.com")).toBe("view");
  expect(h.hub.roleFor(id, "c@nowhere.com")).toBeNull();
  expect(h.hub.roleFor(id, OWNER)).toBe("owner");
  h.hub.share(id, { remove: ["a@corp.com"] });
  expect(h.hub.roleFor(id, "a@corp.com")).toBeNull();
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
  expect(h.hub.roleFor(id, OWNER)).toBeNull();
  expect(c.socket.closed?.code).toBe(4004);
});

test("render check is skipped without a BROWSER binding; no alarm pending", async () => {
  const id = await make();
  const r = await h.hub.runRenderCheck(id, "https://x.test");
  expect(r.check.status).toBe("skipped");
  expect(await advanceAlarm(h)).toBe(false);
});

test("archive keeps access and updated_at, and unarchives", async () => {
  const id = await make();
  h.hub.share(id, { add: [{ email: "a@corp.com", role: "view" }] });
  const before = h.hub.meta(id)!;
  const archived = h.hub.updateMeta(id, { archived: true });
  expect(archived.archivedAt).toBeString();
  expect(archived.updatedAt).toBe(before.updatedAt);
  expect(archived.version).toBe(before.version);
  // Archiving again keeps the original time.
  expect(h.hub.updateMeta(id, { archived: true }).archivedAt).toBe(archived.archivedAt);
  expect(h.hub.list(OWNER)[0].archivedAt).toBe(archived.archivedAt);
  expect(h.hub.list("a@corp.com")[0].archivedAt).toBe(archived.archivedAt);
  expect(h.hub.roleFor(id, "a@corp.com")).toBe("view");
  expect(h.hub.updateMeta(id, { archived: false }).archivedAt).toBeNull();
});

test("a build from an older compiler is recompiled on read and saved", async () => {
  const id = await make();
  // Simulate a build stored before a theme change: no stamp, old inlined colours.
  const sql = h.ctx.sqlStorage;
  const stale = { ...(await h.hub.build(id))!.build, stamp: undefined, css: ":root{--background: oklch(0.185 0.006 60)}" };
  sql.exec(`UPDATE builds SET build = ? WHERE artifact_id = ?`, JSON.stringify(stale), id);

  const served = (await h.hub.build(id))!.build;
  expect(served.css).not.toContain("oklch(0.185 0.006 60)");
  expect(served.css).toContain("--background: oklch(0.155 0.014 262)");
  const stored = JSON.parse(sql.exec(`SELECT build FROM builds WHERE artifact_id = ?`, id).toArray()[0].build as string);
  expect(stored.stamp).toBe(served.stamp);
  expect(stored.stamp).toBeTruthy();
});

test("recompiling a stale build does not overwrite a build written meanwhile", async () => {
  const id = await make();
  const sql = h.ctx.sqlStorage;
  const stale = { ...(await h.hub.build(id))!.build, stamp: undefined, css: ":root{--background: brown}" };
  sql.exec(`UPDATE builds SET build = ? WHERE artifact_id = ?`, JSON.stringify(stale), id);

  const reading = h.hub.build(id);
  // A data refresh rewrites the build without bumping the version.
  const newer = { ...stale, stamp: "newer", css: "/* newer */" };
  sql.exec(`UPDATE builds SET build = ? WHERE artifact_id = ?`, JSON.stringify(newer), id);
  expect((await reading)!.build.css).toBe("/* newer */");
  const stored = JSON.parse(sql.exec(`SELECT build FROM builds WHERE artifact_id = ?`, id).toArray()[0].build as string);
  expect(stored.css).toBe("/* newer */");
});

type Restyling = { restylePass(): boolean; afterLoad(): Promise<void> };

test("the restyle pass rewrites stored files that used the retired gradient classes, then stays done", async () => {
  const r = await h.hub.create({ title: "Old", files: { "index.mdx": `# Old\n\n<span className="bg-signal px-2">New</span>\n` }, owner: OWNER });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  // As if the workspace had last run before the restyle: the pass is due.
  const sql = h.ctx.sqlStorage;
  sql.exec(`DELETE FROM settings WHERE key IN ('restyle_done', 'restyle_pass')`);
  const { Workspace } = await import("../src/worker/hub.ts");
  const woken = new Workspace(h.ctx as never, h.env as never) as unknown as Restyling & typeof h.hub;
  expect(woken.restylePass()).toBe(false);
  expect(woken.files(r.id)["index.mdx"]).toContain(`<span className="bg-primary px-2">New</span>`);
  // A build compiled from the old names before the pass ran is stale, so the next view compiles the new files.
  expect(JSON.parse(sql.exec(`SELECT build FROM builds WHERE artifact_id = ?`, r.id).one().build as string).stamp).toBe("");
  const rebuilt = (await woken.build(r.id))!.build;
  expect(rebuilt.css).toContain("bg-primary");
  // No schema bump: the release before this one can still run against the data.
  const setting = (k: string) => sql.exec(`SELECT value FROM settings WHERE key = ?`, k).toArray()[0]?.value ?? null;
  expect(setting("restyle_done")).toBe("1");
  expect(setting("restyle_pass")).toBeNull();
  new Workspace(h.ctx as never, h.env as never);
  expect(setting("restyle_pass")).toBeNull();
});

test("a restore from before the restyle loses the retired gradient classes too", async () => {
  const r = await h.hub.create({ title: "Old", files: { "index.mdx": "# Old\n\nPlain.\n" }, owner: OWNER });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  // As an older backup would load it: the old class back in the stored file, after the pass already ran.
  h.ctx.sqlStorage.exec(`UPDATE blobs SET content = ? WHERE artifact_id = ?`, `# Old\n\n<b className="text-signal">Hi</b>\n`, r.id);
  const hub = h.hub as unknown as Restyling;
  await hub.afterLoad();
  hub.restylePass();
  expect(h.hub.files(r.id)["index.mdx"]).toContain(`<b className="text-primary">Hi</b>`);
});

test("members get different avatar colours, then the least-used ones, and a leaver's colour is freed", async () => {
  const { PALETTE } = await import("../src/shared/who.ts");
  const counts = () => {
    const c = new Array<number>(PALETTE.length).fill(0);
    for (const i of Object.values(h.hub.memberColours())) c[i]++;
    return c;
  };
  // Up to a full palette, everyone differs.
  for (let i = 0; Object.keys(h.hub.memberColours()).length < PALETTE.length; i++) await h.hub.setMember(`p${i}@example.com`, "member", OWNER);
  expect(counts().every((n) => n === 1)).toBe(true);
  // Past it, colours spread evenly: no colour is used twice before every other is.
  for (let i = 0; i < 5; i++) await h.hub.setMember(`q${i}@example.com`, "member", OWNER);
  const spread = counts();
  expect(Math.max(...spread) - Math.min(...spread)).toBeLessThanOrEqual(1);
  // Stored: asking again changes nothing.
  expect(h.hub.memberColours()).toEqual(h.hub.memberColours());
  // Someone who leaves frees their colour; the next person takes the least-used one, which is now theirs.
  const leaver = "q0@example.com";
  const freed = h.hub.memberColours([leaver])[leaver];
  await h.hub.setMember(leaver, null, OWNER);
  await h.hub.setMember("new@example.com", "member", OWNER);
  expect(h.hub.memberColours(["new@example.com"])["new@example.com"]).toBe(freed);
});

test("a member's colour reaches their bar and the artifact page", async () => {
  await h.hub.setMember("mia@example.com", "member", OWNER);
  const id = await make();
  h.hub.share(id, { add: [{ email: "mia@example.com", role: "view" }] });
  const access = await h.hub.access("mia@example.com");
  expect(access.colour).toBeNumber();
  const opened = h.hub.openArtifact(id, "mia@example.com", false) as { colours: Record<string, number> };
  expect(opened.colours["mia@example.com"]).toBe(access.colour!);
  // A guest has no stored colour: pages work theirs out from their email.
  expect((await h.hub.access("guest@example.com")).colour).toBeUndefined();
});

test("a guest or a link visitor learns only the colours of people the page already shows", async () => {
  await h.hub.setMember("mia@example.com", "member", OWNER);
  await h.hub.setMember("quiet@example.com", "member", OWNER);
  const id = await make();
  h.hub.share(id, { add: [{ email: "guest@corp.com", role: "edit" }] });
  await h.hub.setState(id, { "poll/x/mia@example.com": true }, "mia@example.com");
  const guest = h.hub.openArtifact(id, "guest@corp.com", false) as { colours: Record<string, number> };
  expect(Object.keys(guest.colours)).toEqual(["mia@example.com"]);
  // On a presigned link a member gets the same; signed in normally, everyone's, so people who turn up later
  // already have theirs.
  h.hub.share(id, { add: [{ email: "mia@example.com", role: "view" }] });
  const linked = h.hub.openArtifact(id, "mia@example.com", true) as { colours: Record<string, number> };
  expect(Object.keys(linked.colours)).toEqual(["mia@example.com"]);
  const full = h.hub.openArtifact(id, "mia@example.com", false) as { colours: Record<string, number> };
  expect(Object.keys(full.colours)).toContain("quiet@example.com");
});

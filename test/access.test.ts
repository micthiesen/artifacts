// Public links that expire, and joining a workspace by email domain.
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { ADMIN, connect, createHub, type Harness } from "./support/do-harness.ts";

let h: Harness;
const OWNER = "olu@corp.com";
const DAY = 86_400_000;
const files = { "index.mdx": "# Hello\n" };

async function make() {
  const r = await h.hub.create({ title: "Doc", files, owner: OWNER });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.id;
}

beforeEach(async () => {
  h = await createHub();
  await h.hub.setMember(OWNER, "member", ADMIN);
});

afterEach(() => setSystemTime());

// ---- public links -------------------------------------------------------------------

test("a public link with an expiry works until then, and afterwards is the same as off", async () => {
  const id = await make();
  const until = new Date(Date.now() + 7 * DAY).toISOString();
  const meta = h.hub.share(id, { public: true, publicUntil: until })!;
  expect(meta).toMatchObject({ public: true, publicUntil: until });
  expect(h.hub.roleFor(id, null)).toBe("view");
  expect(h.hub.roleFor(id, "stranger@else.com")).toBe("view");
  expect(h.hub.previewInfo(id)?.rich).toBe(true);

  setSystemTime(new Date(Date.now() + 8 * DAY));
  expect(h.hub.roleFor(id, null)).toBeNull();
  expect(h.hub.roleFor(id, "stranger@else.com")).toBeNull();
  expect(h.hub.roleFor(id, OWNER)).toBe("owner");
  expect(h.hub.meta(id)).toMatchObject({ public: false, publicUntil: null });
  expect(h.hub.list(OWNER)[0]).toMatchObject({ public: false, publicUntil: null });
  expect(h.hub.shareSummaries(OWNER, h.hub.list(OWNER))[id].public).toBe(false);
  expect(h.hub.previewInfo(id)?.rich).toBe(false);
});

test("public without an expiry never expires; turning it off forgets the expiry", async () => {
  const id = await make();
  h.hub.share(id, { public: true });
  setSystemTime(new Date(Date.now() + 400 * DAY));
  expect(h.hub.roleFor(id, null)).toBe("view");
  setSystemTime();

  h.hub.share(id, { publicUntil: new Date(Date.now() + DAY).toISOString() });
  expect(h.hub.meta(id)?.publicUntil).not.toBeNull();
  expect(h.hub.share(id, { public: false })).toMatchObject({ public: false, publicUntil: null });
  // Back on with no expiry: the old one doesn't come back.
  expect(h.hub.share(id, { public: true })).toMatchObject({ public: true, publicUntil: null });
});

test("expiries must be in the future and within a year", async () => {
  const id = await make();
  expect(() => h.hub.share(id, { public: true, publicUntil: new Date(Date.now() - 1000).toISOString() })).toThrow("future");
  expect(() => h.hub.share(id, { public: true, publicUntil: new Date(Date.now() + 366 * DAY).toISOString() })).toThrow("365 days");
  expect(() => h.hub.share(id, { public: true, publicUntil: "soon" })).toThrow("not a time");
  expect(() => h.hub.share(id, { public: false, publicUntil: new Date(Date.now() + DAY).toISOString() })).toThrow();
  expect(h.hub.meta(id)).toMatchObject({ public: false, publicUntil: null });
});

test("an anonymous viewer's socket ends when the public link expires", async () => {
  const id = await make();
  h.hub.share(id, { public: true, publicUntil: new Date(Date.now() + DAY).toISOString() });
  const viewer = await connect(h, { id, email: null, role: "view" });
  const editor = await connect(h, { id, email: OWNER, role: "owner" });
  setSystemTime(new Date(Date.now() + 2 * DAY));
  await editor.send({ t: "set", key: "k", value: 1, cid: "c1" });
  expect(viewer.socket.messages.some((m) => m.t === "set")).toBe(false);
  expect(viewer.socket.closed).toMatchObject({ code: 4003 });
  expect(editor.socket.closed).toBeNull();
  expect(editor.socket.messages.some((m) => m.t === "set")).toBe(true);
});

// ---- joining by email domain -----------------------------------------------------

test("join domains are normalized, and public mail providers are refused", () => {
  expect(h.hub.setJoinDomains(["@Corp.com", "corp.com", "eng.corp.com."], ADMIN)).toEqual(["corp.com", "eng.corp.com"]);
  expect(() => h.hub.setJoinDomains(["gmail.com"], ADMIN)).toThrow("public email provider");
  expect(() => h.hub.setJoinDomain("@Outlook.com", true, ADMIN)).toThrow("public email provider");
  expect(() => h.hub.setJoinDomains(["not a domain"], ADMIN)).toThrow("not an email domain");
  expect(() => h.hub.setJoinDomains(["localhost"], ADMIN)).toThrow("not an email domain");
  expect(() => h.hub.setJoinDomains(Array.from({ length: 21 }, (_, i) => `d${i}.com`), ADMIN)).toThrow("at most 20");
  expect(h.hub.setJoinDomain("@CORP.com", false, ADMIN)).toEqual(["eng.corp.com"]);
  expect(h.hub.joinDomains()).toEqual(["eng.corp.com"]);
});

test("people at a join domain become members on sign-in and on their next visit; others don't", async () => {
  h.hub.setJoinDomains(["corp.com"], ADMIN);
  expect(await h.hub.signedIn("new@corp.com")).toBe(true);
  expect(h.hub.members().find((m) => m.email === "new@corp.com")).toMatchObject({ role: "member", addedBy: "auto:corp.com" });
  expect(h.directory.membershipsOf("new@corp.com")).toMatchObject([{ slug: "acme", role: "member" }]);

  expect((await h.hub.access("later@corp.com")).member).toBe("member");
  expect((await h.hub.indexData("third@corp.com")).member).toBe("member");

  expect(await h.hub.signedIn("guest@client.com")).toBe(false);
  expect((await h.hub.access("guest@client.com")).member).toBeNull();
  expect((await h.hub.access("x@sub.corp.com")).member).toBeNull();
  expect(h.hub.members().map((m) => m.email)).not.toContain("guest@client.com");
});

test("joining never changes an existing member's role, and removing a domain keeps who joined", async () => {
  h.hub.setJoinDomains(["example.com"], ADMIN);
  expect((await h.hub.access(ADMIN)).member).toBe("admin");
  await h.hub.signedIn("mia@example.com");
  h.hub.setJoinDomains([], ADMIN);
  expect((await h.hub.access("mia@example.com")).member).toBe("member");
  expect((await h.hub.access("new@example.com")).member).toBeNull();
});

test("someone an admin removed isn't brought back by a join domain, until an admin adds them", async () => {
  h.hub.setJoinDomains(["corp.com"], ADMIN);
  await h.hub.signedIn("bob@corp.com");
  await h.hub.setMember("bob@corp.com", null, ADMIN);
  expect((await h.hub.access("bob@corp.com")).member).toBeNull();
  expect(await h.hub.signedIn("bob@corp.com")).toBe(false);
  expect((await h.hub.indexData("bob@corp.com")).member).toBeNull();
  await h.hub.setMember("bob@corp.com", "member", ADMIN);
  await h.hub.setMember("bob@corp.com", null, ADMIN);
  await h.hub.setMember("bob@corp.com", "admin", ADMIN);
  expect((await h.hub.access("bob@corp.com")).member).toBe("admin");
});

test("a link session doesn't join by domain; a real sign-in does", async () => {
  h.hub.setJoinDomains(["corp.com"], ADMIN);
  expect(await h.hub.signedIn("link@corp.com", false)).toBe(false);
  expect(h.hub.members().map((m) => m.email)).not.toContain("link@corp.com");
  expect(await h.hub.signedIn("link@corp.com")).toBe(true);
});

test("turning on a link that's already on keeps its expiry; null removes it", async () => {
  const id = await make();
  const until = new Date(Date.now() + 7 * DAY).toISOString();
  h.hub.share(id, { publicUntil: until });
  expect(h.hub.share(id, { public: true })).toMatchObject({ public: true, publicUntil: until });
  expect(h.hub.share(id, { public: true, publicUntil: null })).toMatchObject({ public: true, publicUntil: null });
});

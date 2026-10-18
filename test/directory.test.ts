import { beforeEach, expect, test } from "bun:test";
import { createHub, type Harness } from "./support/do-harness.ts";
const { validSlug } = await import("../src/worker/directory.ts");

let h: Harness;
beforeEach(async () => {
  h = await createHub();
});

test("workspace slugs are short, lowercase and never our own hostnames", () => {
  for (const ok of ["acme", "acme-labs", "a1b"]) expect(validSlug(ok)).toBe(true);
  for (const bad of ["ab", "Acme", "-acme", "acme-", "ac--me", "www", "auth", "mail", "admin", "1abc", "a".repeat(33)]) expect(validSlug(bad)).toBe(false);
  expect(() => h.directory.createWorkspace("acme", "Again")).toThrow("already exists");
});

test("a sign-in code works once, for its own address", async () => {
  const code = await h.directory.startLogin("dana@corp.com");
  expect(code).toMatch(/^\d{6}$/);
  expect(await h.directory.verifyLogin("sam@corp.com", code)).toBe(false);
  expect(h.directory.hasSignedIn("dana@corp.com")).toBe(false);
  expect(await h.directory.verifyLogin("dana@corp.com", `${code.slice(0, 3)} ${code.slice(3)}`)).toBe(true);
  expect(h.directory.hasSignedIn("dana@corp.com")).toBe(true);
  expect(await h.directory.verifyLogin("dana@corp.com", code)).toBe(false);
});

test("someone else asking for codes, or guessing, doesn't cancel the code in your inbox", async () => {
  const mine = await h.directory.startLogin("dana@corp.com", "10.0.0.1");
  for (let i = 0; i < 5; i++) await h.directory.startLogin("dana@corp.com", "6.6.6.6");
  await expect(h.directory.startLogin("dana@corp.com", "6.6.6.6")).rejects.toThrow("Too many codes");
  const wrong = mine === "000000" ? "111111" : "000000";
  for (let i = 0; i < 12; i++) await h.directory.verifyLogin("dana@corp.com", wrong, "6.6.6.6");
  // The attacker's network is locked out; yours isn't, and your first code still works.
  expect(await h.directory.verifyLogin("dana@corp.com", mine, "6.6.6.6")).toBe(false);
  expect(await h.directory.verifyLogin("dana@corp.com", mine, "10.0.0.1")).toBe(true);
});

test("codes expire after ten minutes", async () => {
  const now = Date.now();
  const code = await h.directory.startLogin("dana@corp.com", null, now);
  expect(await h.directory.verifyLogin("dana@corp.com", code, null, now + 11 * 60_000)).toBe(false);
});

test("sending is rate-limited per network", async () => {
  for (let i = 0; i < 100; i++) await h.directory.startLogin(`p${i}@corp.com`, "1.2.3.4");
  await expect(h.directory.startLogin("q@corp.com", "1.2.3.4")).rejects.toThrow("your network");
  await h.directory.startLogin("q@corp.com", "5.6.7.8");
});

test("guests see the workspaces they've opened; display names can't look like addresses", () => {
  h.directory.recordVisit("gus@client.com", "acme");
  expect(h.directory.membershipsOf("gus@client.com")).toMatchObject([{ slug: "acme", role: "guest" }]);
  expect(() => h.directory.setName("gus@client.com", "ceo@corp.com")).toThrow("@");
  expect(() => h.directory.createWorkspace("admin", "x")).toThrow("reserved");
});

test("the directory exports, imports and backs itself up like a workspace", async () => {
  const { FakeR2 } = await import("./support/do-harness.ts");
  const bucket = new FakeR2();
  const { Directory } = await import("../src/worker/directory.ts");
  const { FakeCtx } = await import("./support/do-harness.ts");
  const ctx = new FakeCtx();
  const dir = new Directory(ctx as never, { LOGIN_SECRET: "x", BACKUPS: bucket } as never);
  dir.setName("dana@corp.com", "Dana");
  const channel = dir.addChannel("dana@corp.com", "ntfy", { topic: "t" }, "ntfy");
  expect(ctx.alarm).toBeGreaterThan(Date.now());
  const prefix = await dir.backup();
  expect(prefix).toMatch(/^_directory\/\d{4}-\d{2}-\d{2}T\d{9}Z\/$/);
  dir.removeChannel("dana@corp.com", channel);
  await dir.restore(prefix!.split("/")[1]);
  expect(dir.profile("dana@corp.com")).toMatchObject({ name: "Dana", channels: [{ id: channel }] });
  // Login codes are never exported.
  await dir.startLogin("dana@corp.com");
  expect(() => dir.exportPage("login_codes")).toThrow("unknown table");
});

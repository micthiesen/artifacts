import { beforeEach, expect, test } from "bun:test";
import { createHub, type Harness } from "./support/do-harness.ts";
import { validSlug } from "../src/worker/directory.ts";

let h: Harness;
beforeEach(async () => {
  h = await createHub();
});

test("workspace slugs are short, lowercase and never our own hostnames", () => {
  for (const ok of ["acme", "acme-labs", "a1b"]) expect(validSlug(ok)).toBe(true);
  for (const bad of ["ab", "Acme", "-acme", "acme-", "ac--me", "www", "auth", "mail", "admin", "1abc", "a".repeat(33)]) expect(validSlug(bad)).toBe(false);
  expect(() => h.directory.createWorkspace("acme", "Again")).toThrow("already exists");
});

test("a sign-in code works once, for its own address, and dies after five wrong guesses", async () => {
  const code = await h.directory.startLogin("dana@corp.com");
  expect(code).toMatch(/^\d{6}$/);
  expect(await h.directory.verifyLogin("sam@corp.com", code)).toBe(false);
  expect(await h.directory.verifyLogin("dana@corp.com", `${code.slice(0, 3)} ${code.slice(3)}`)).toBe(true);
  expect(await h.directory.verifyLogin("dana@corp.com", code)).toBe(false);

  const next = await h.directory.startLogin("dana@corp.com");
  const wrong = next === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) expect(await h.directory.verifyLogin("dana@corp.com", wrong)).toBe(false);
  expect(await h.directory.verifyLogin("dana@corp.com", next)).toBe(false);
});

test("codes expire after ten minutes", async () => {
  const now = Date.now();
  const code = await h.directory.startLogin("dana@corp.com", null, now);
  expect(await h.directory.verifyLogin("dana@corp.com", code, now + 11 * 60_000)).toBe(false);
});

test("sending is rate-limited per network", async () => {
  for (let i = 0; i < 20; i++) await h.directory.startLogin(`p${i}@corp.com`, "1.2.3.4");
  await expect(h.directory.startLogin("q@corp.com", "1.2.3.4")).rejects.toThrow("your network");
  await h.directory.startLogin("q@corp.com", "5.6.7.8");
});

test("sending is rate-limited per address", async () => {
  for (let i = 0; i < 5; i++) await h.directory.startLogin("dana@corp.com");
  await expect(h.directory.startLogin("dana@corp.com")).rejects.toThrow("Too many codes");
  await h.directory.startLogin("sam@corp.com");
  // An hour later the window has moved on.
  await h.directory.startLogin("dana@corp.com", null, Date.now() + 3601_000);
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
  expect(prefix).toMatch(/^_directory\/\d{4}-\d{2}-\d{2}\/$/);
  dir.removeChannel("dana@corp.com", channel);
  await dir.restore(prefix!.split("/")[1]);
  expect(dir.profile("dana@corp.com")).toMatchObject({ name: "Dana", channels: [{ id: channel }] });
  // Login codes are never exported.
  await dir.startLogin("dana@corp.com");
  expect(() => dir.exportPage("login_codes")).toThrow("unknown table");
});

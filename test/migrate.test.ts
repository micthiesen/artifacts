import { expect, test } from "bun:test";
import { FakeCtx } from "./support/do-harness.ts";
import { migrate, type Migration } from "../src/worker/migrate.ts";

test("migrations run once each, in order, and pick up where an older deploy stopped", () => {
  const ctx = new FakeCtx();
  const ran: number[] = [];
  const first: Migration[] = [(sql) => (ran.push(1), sql.exec(`CREATE TABLE a (x INTEGER)`))];
  expect(migrate(ctx.storage as never, first)).toBe(1);
  expect(migrate(ctx.storage as never, first)).toBe(1);
  const next: Migration[] = [...first, (sql) => (ran.push(2), sql.exec(`ALTER TABLE a ADD COLUMN y TEXT`))];
  expect(migrate(ctx.storage as never, next)).toBe(2);
  expect(ran).toEqual([1, 2]);
});

test("a failing migration leaves the schema at the last good version", () => {
  const ctx = new FakeCtx();
  const list: Migration[] = [
    (sql) => sql.exec(`CREATE TABLE a (x INTEGER)`),
    (sql) => {
      sql.exec(`CREATE TABLE b (x INTEGER)`);
      throw new Error("boom");
    },
  ];
  expect(() => migrate(ctx.storage as never, list)).toThrow("boom");
  const version = ctx.sqlStorage.exec(`SELECT version FROM _schema`).toArray()[0].version;
  expect(version).toBe(1);
  expect(ctx.sqlStorage.exec(`SELECT name FROM sqlite_master WHERE name = 'b'`).toArray()).toEqual([]);
});

test("members from before sign-ins were recorded count as signed in when they've opened or connected something", async () => {
  const { MIGRATIONS } = await import("../src/worker/hub.ts");
  const ctx = new FakeCtx();
  migrate(ctx.storage as never, MIGRATIONS.slice(0, -1));
  const sql = ctx.sqlStorage;
  for (const e of ["viewer@x.com", "agent@x.com", "never@x.com"]) sql.exec(`INSERT INTO members (email, role, added_at) VALUES (?, 'admin', '2026-01-01')`, e);
  sql.exec(`INSERT INTO seen (email, artifact_id, version, at) VALUES ('viewer@x.com', 'a1', 1, '2026-02-01')`);
  sql.exec(`INSERT INTO tokens (id, hash, email, label, created_at) VALUES ('k1', 'h', 'agent@x.com', 'Agent', '2026-03-01')`);
  migrate(ctx.storage as never, MIGRATIONS);
  const seen = Object.fromEntries(sql.exec(`SELECT email, last_seen_at FROM members`).toArray().map((r) => [r.email, r.last_seen_at]));
  expect(seen).toEqual({ "viewer@x.com": "2026-02-01", "agent@x.com": "2026-03-01", "never@x.com": null });
});

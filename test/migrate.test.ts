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

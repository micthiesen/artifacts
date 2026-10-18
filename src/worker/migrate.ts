// Numbered schema migrations for a Durable Object's SQLite. Each object runs the
// ones it hasn't applied yet when it first wakes after a deploy, each in its own
// transaction. Migrations are append-only: never edit or reorder a shipped one;
// add the next number and convert the old shape instead.

export type Migration = (sql: SqlStorage) => void;

export function migrate(storage: DurableObjectStorage, migrations: Migration[]): number {
  const sql = storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS _schema (version INTEGER NOT NULL)`);
  const row = sql.exec(`SELECT version FROM _schema`).toArray()[0];
  let version = row ? (row.version as number) : 0;
  if (!row) sql.exec(`INSERT INTO _schema (version) VALUES (0)`);
  // Older code against a newer schema could write data the newer code misreads.
  if (version > migrations.length) throw new Error(`schema is at v${version} but this code only knows v${migrations.length}; deploy the newer code`);
  for (; version < migrations.length; version++) {
    storage.transactionSync(() => {
      migrations[version](sql);
      sql.exec(`UPDATE _schema SET version = ?`, version + 1);
    });
  }
  return version;
}

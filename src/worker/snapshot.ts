// Paged export, import and R2 backups for a Durable Object's SQLite, shared by
// workspaces and the directory. Pages hold at most a few MB however big the
// database is, so neither an export nor a backup is limited by Worker memory.
// Rows are JSON with blobs as {"$b64": ...}; a backup is the same pages under
// <root>/<date>/<table>/<n>.json plus a manifest written last.

const PAGE_BYTES = 4 * 1024 * 1024;
const PAGE_ROWS = 1000;
const BACKUP_HOUR_UTC = 10;

export type Page = { rows: Record<string, unknown>[]; next: number | null };

export function exportPage(sql: SqlStorage, tables: string[], table: string, after = 0): Page {
  if (!tables.includes(table)) throw new Error(`unknown table ${table}`);
  const rows: Record<string, unknown>[] = [];
  let size = 0;
  let last = after;
  for (const r of sql.exec(`SELECT rowid AS _rowid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`, after, PAGE_ROWS)) {
    last = r._rowid as number;
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) if (k !== "_rowid") row[k] = v instanceof ArrayBuffer ? { $b64: toB64(v) } : v;
    rows.push(row);
    size += JSON.stringify(row).length;
    if (size > PAGE_BYTES) break;
  }
  return { rows, next: rows.length === PAGE_ROWS || size > PAGE_BYTES ? last : null };
}

export function clearTables(storage: DurableObjectStorage, tables: string[]) {
  storage.transactionSync(() => {
    for (const t of tables) storage.sql.exec(`DELETE FROM ${t}`);
  });
}

export function importRows(storage: DurableObjectStorage, tables: string[], table: string, rows: Record<string, unknown>[]): number {
  if (!tables.includes(table)) throw new Error(`unknown table ${table}`);
  const sql = storage.sql;
  const known = new Set(sql.exec(`PRAGMA table_info(${table})`).toArray().map((c) => c.name as string));
  storage.transactionSync(() => {
    for (const row of rows) {
      const cols = Object.keys(row);
      for (const c of cols) if (!known.has(c)) throw new Error(`${table} has no column ${c}`);
      const values = cols.map((c) => {
        const v = row[c];
        return v && typeof v === "object" && "$b64" in v ? fromB64(String((v as { $b64: unknown }).$b64)) : (v as SqlStorageValue);
      });
      sql.exec(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...values);
    }
  });
  return rows.length;
}

/** Below this size a backup reads everything before uploading, so it's a point-in-time snapshot. */
export const SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Writes today's backup under <root>/<date>/ and keeps the newest `keep` dates.
 * With `snapshot`, every page is read synchronously first (no other request can
 * run in between), so the backup is consistent; otherwise pages are read and
 * uploaded in turn, which bounds memory for big databases but lets writes land
 * between pages.
 */
export async function writeBackup(
  bucket: R2Bucket,
  root: string,
  tables: string[],
  page: (table: string, after: number) => Page,
  keep: number,
  snapshot = false,
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const prefix = `${root}/${today}/`;
  const counts: Record<string, number> = {};
  const pages: { key: string; body: string }[] = [];
  const read = function* () {
    for (const table of tables) {
      let after = 0;
      let n = 0;
      counts[table] = 0;
      for (;;) {
        const p = page(table, after);
        if (p.rows.length) yield { key: `${prefix}${table}/${String(n++).padStart(5, "0")}.json`, body: JSON.stringify(p.rows) };
        counts[table] += p.rows.length;
        if (p.next === null) break;
        after = p.next;
      }
    }
  };
  if (snapshot) for (const p of read()) pages.push(p);
  // A second backup today replaces the first rather than mixing with its pages.
  await deletePrefix(bucket, prefix);
  for (const p of snapshot ? pages : read()) await bucket.put(p.key, p.body);
  // The manifest goes last, so a backup without one is incomplete.
  await bucket.put(`${prefix}manifest.json`, JSON.stringify({ root, at: new Date().toISOString(), tables: counts }));
  for (const old of (await backupDates(bucket, root)).slice(keep)) await deletePrefix(bucket, `${root}/${old}/`);
  // Earlier runs that never finished (no manifest) are dropped.
  for (const date of await listDates(bucket, root)) {
    if (date < today && !(await bucket.head(`${root}/${date}/manifest.json`))) await deletePrefix(bucket, `${root}/${date}/`);
  }
  return prefix;
}

/** Dates with a complete backup under <root>/, newest first. */
export async function backupDates(bucket: R2Bucket, root: string): Promise<string[]> {
  const complete: string[] = [];
  for (const d of (await listDates(bucket, root)).reverse()) if (await bucket.head(`${root}/${d}/manifest.json`)) complete.push(d);
  return complete;
}

async function listDates(bucket: R2Bucket, root: string): Promise<string[]> {
  const dates: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: `${root}/`, delimiter: "/", cursor });
    for (const p of listed.delimitedPrefixes) dates.push(p.slice(root.length + 1, -1));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return dates.sort();
}

/** Reads every page of one backup, in table order. Check the manifest exists first. */
export async function readBackup(bucket: R2Bucket, root: string, date: string, tables: string[], onRows: (table: string, rows: Record<string, unknown>[]) => void) {
  for (const table of tables) {
    let cursor: string | undefined;
    do {
      const listed = await bucket.list({ prefix: `${root}/${date}/${table}/`, cursor });
      for (const o of listed.objects) {
        const body = await bucket.get(o.key);
        if (body) onRows(table, JSON.parse(await body.text()));
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
}

export async function deletePrefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    if (listed.objects.length) await bucket.delete(listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

/** The next nightly backup slot after `now`. */
export function nextBackupAt(now = Date.now()): number {
  const d = new Date(now);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), BACKUP_HOUR_UTC);
  return at > now ? at : at + 86400_000;
}

export function toB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

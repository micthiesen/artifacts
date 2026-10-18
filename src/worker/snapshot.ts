// Paged export, import and R2 backups for a Durable Object's SQLite, shared by
// workspaces and the directory. Pages hold at most a few MB however big the
// database is, so neither an export nor a backup is limited by Worker memory.
//
// Rows are JSON with blobs as {"$b64": ...}. A backup run lives under
// <root>/<run>/, where <run> is a sortable UTC timestamp (2026-10-18T100000123Z):
// <table>/<n>.json pages, then manifest.json written last, so a run without a
// manifest is incomplete. Every run has its own prefix, so two never mix.

const PAGE_BYTES = 4 * 1024 * 1024;
const PAGE_ROWS = 1000;
const BACKUP_HOUR_UTC = 10;
/** Up to this many bytes of pages, a backup reads everything before uploading: a point-in-time snapshot. */
const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

export type Page = { rows: Record<string, unknown>[]; next: number | null };
export type Manifest = { root: string; run: string; at: string; schema: number; tables: Record<string, number>; pages: Record<string, number> };

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

/** The first column in `rows` that `table` doesn't have, if any. */
export function unknownColumn(sql: SqlStorage, table: string, rows: Record<string, unknown>[]): string | null {
  const known = new Set(sql.exec(`PRAGMA table_info(${table})`).toArray().map((c) => c.name as string));
  for (const row of rows) for (const c of Object.keys(row)) if (!known.has(c)) return c;
  return null;
}

export function importRows(storage: DurableObjectStorage, tables: string[], table: string, rows: Record<string, unknown>[]): number {
  if (!tables.includes(table)) throw new Error(`unknown table ${table}`);
  const sql = storage.sql;
  const bad = unknownColumn(sql, table, rows);
  if (bad) throw new Error(`${table} has no column ${bad}`);
  storage.transactionSync(() => {
    for (const row of rows) {
      const cols = Object.keys(row);
      const values = cols.map((c) => {
        const v = row[c];
        return v && typeof v === "object" && "$b64" in v ? fromB64(String((v as { $b64: unknown }).$b64)) : (v as SqlStorageValue);
      });
      sql.exec(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...values);
    }
  });
  return rows.length;
}

// ---- backup runs ---------------------------------------------------------------------

/** A backup in progress: the run and how far it has read. Persisted between steps. */
export type BackupCursor = { run: string; table: number; after: number; page: number; counts: Record<string, number>; pages: Record<string, number> };

/** A run id: the UTC time to the millisecond, sortable, e.g. 2026-10-18T100000123Z. */
export function newRun(now = new Date()): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 23).replace(/[:.]/g, "")}Z`;
}

export function startBackup(run = newRun()): BackupCursor {
  return { run, table: 0, after: 0, page: 0, counts: {}, pages: {} };
}

/**
 * Advance a backup until it's done or `deadline` passes, returning the
 * manifest or the cursor to continue from. On its first step a small database
 * is read in full before anything is uploaded, so nothing can change in
 * between; a big one goes page by page, so writes can land between pages.
 */
export async function stepBackup(
  bucket: R2Bucket,
  root: string,
  tables: string[],
  page: (table: string, after: number) => Page,
  cursor: BackupCursor,
  schema: number,
  deadline: number,
): Promise<{ done: Manifest } | { next: BackupCursor }> {
  const c = structuredClone(cursor);
  const prefix = `${root}/${c.run}/`;
  const advance = () => {
    const table = tables[c.table];
    const p = page(table, c.after);
    const key = p.rows.length ? `${prefix}${table}/${String(c.page).padStart(5, "0")}.json` : null;
    c.counts[table] = (c.counts[table] ?? 0) + p.rows.length;
    if (key) c.pages[table] = (c.pages[table] ?? 0) + 1;
    if (p.next === null) {
      c.table++;
      c.after = 0;
      c.page = 0;
    } else {
      c.after = p.next;
      c.page++;
    }
    return key ? { key, body: JSON.stringify(p.rows) } : null;
  };
  if (c.table === 0 && c.after === 0) {
    const start = structuredClone(c);
    const pages: { key: string; body: string }[] = [];
    let bytes = 0;
    while (c.table < tables.length && bytes <= SNAPSHOT_MAX_BYTES) {
      const p = advance();
      if (p) {
        pages.push(p);
        bytes += p.body.length;
      }
    }
    if (c.table >= tables.length) {
      await Promise.all(pages.map((p) => bucket.put(p.key, p.body)));
      return { done: await finishBackup(bucket, root, c, schema) };
    }
    // Too big to hold at once: start over, paging.
    Object.assign(c, start);
  }
  // At least one page per step, so even a step that starts late makes progress.
  let first = true;
  while (c.table < tables.length) {
    if (!first && Date.now() > deadline) return { next: c };
    first = false;
    const p = advance();
    if (p) await bucket.put(p.key, p.body);
  }
  return { done: await finishBackup(bucket, root, c, schema) };
}

async function finishBackup(bucket: R2Bucket, root: string, c: BackupCursor, schema: number): Promise<Manifest> {
  const manifest: Manifest = { root, run: c.run, at: new Date().toISOString(), schema, tables: c.counts, pages: c.pages };
  await bucket.put(`${root}/${c.run}/manifest.json`, JSON.stringify(manifest));
  return manifest;
}

/** Keep the newest `keep` complete runs; drop older ones, and incomplete runs over a day old. */
export async function pruneBackups(bucket: R2Bucket, root: string, keep: number) {
  const runs = await listRuns(bucket, root);
  const complete = await completeRuns(bucket, root, runs);
  const kept = new Set(complete.slice(0, keep));
  const dayAgo = newRun(new Date(Date.now() - 86400_000));
  for (const run of runs) {
    if (kept.has(run)) continue;
    if (complete.includes(run) || run < dayAgo) await deletePrefix(bucket, `${root}/${run}/`);
  }
}

/** Complete runs under <root>/, newest first. */
export async function backupRuns(bucket: R2Bucket, root: string): Promise<string[]> {
  return completeRuns(bucket, root, await listRuns(bucket, root));
}

async function completeRuns(bucket: R2Bucket, root: string, runs: string[]): Promise<string[]> {
  const complete: string[] = [];
  for (const run of [...runs].reverse()) if (await bucket.head(`${root}/${run}/manifest.json`)) complete.push(run);
  return complete;
}

async function listRuns(bucket: R2Bucket, root: string): Promise<string[]> {
  const runs: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: `${root}/`, delimiter: "/", cursor });
    for (const p of listed.delimitedPrefixes) runs.push(p.slice(root.length + 1, -1));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return runs.sort();
}

// ---- restores ------------------------------------------------------------------------

/**
 * A restore in progress. It first reads every page to check that it parses,
 * fits the current schema and matches the manifest, changing nothing; only
 * then does it clear the tables and load the pages. Persisted between steps.
 */
export type RestoreCursor = { run: string; phase: "validate" | "load"; keys: string[]; index: number };

export async function startRestore(bucket: R2Bucket, root: string, run: string, tables: string[], schema: number): Promise<RestoreCursor> {
  const head = await bucket.get(`${root}/${run}/manifest.json`);
  if (!head) throw new Error(`no complete backup ${run}`);
  const manifest = JSON.parse(await head.text()) as Manifest;
  if ((manifest.schema ?? 0) > schema) throw new Error(`backup ${run} is from a newer schema (v${manifest.schema}; this is v${schema})`);
  const keys: string[] = [];
  for (const table of tables) {
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const listed = await bucket.list({ prefix: `${root}/${run}/${table}/`, cursor });
      for (const o of listed.objects) found.push(o.key);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    if ((manifest.pages?.[table] ?? found.length) !== found.length) throw new Error(`backup ${run} is missing pages of ${table}`);
    keys.push(...found.sort());
  }
  return { run, phase: "validate", keys, index: 0 };
}

/**
 * Advance a restore until done or `deadline`. `check` throws for rows that
 * don't fit; `begin` clears the tables (once, between the phases); `load`
 * inserts one page. Returns the cursor to continue from, or null when done.
 */
export async function stepRestore(
  bucket: R2Bucket,
  cursor: RestoreCursor,
  deadline: number,
  steps: { check: (table: string, rows: Record<string, unknown>[]) => void; begin: () => void; load: (table: string, rows: Record<string, unknown>[]) => void },
): Promise<RestoreCursor | null> {
  const c = structuredClone(cursor);
  while (c.index < c.keys.length || c.phase === "validate") {
    if (c.index >= c.keys.length) {
      steps.begin();
      c.phase = "load";
      c.index = 0;
      continue;
    }
    if (c.index > (cursor.phase === c.phase ? cursor.index : 0) && Date.now() > deadline) return c;
    const key = c.keys[c.index];
    const body = await bucket.get(key);
    if (!body) throw new Error(`backup page ${key} disappeared`);
    const rows = JSON.parse(await body.text()) as Record<string, unknown>[];
    (c.phase === "validate" ? steps.check : steps.load)(tableOfKey(key), rows);
    c.index++;
  }
  return null;
}

function tableOfKey(key: string): string {
  const parts = key.split("/");
  return parts[parts.length - 2];
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

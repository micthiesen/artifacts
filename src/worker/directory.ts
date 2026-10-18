// Directory: the one global Durable Object. It knows which workspaces exist,
// who belongs to which, and per-person settings that follow someone across
// workspaces (display name, notification channels), and it issues sign-in
// codes. Ordinary page loads never touch it; workspaces keep their own data.
import { DurableObject } from "cloudflare:workers";
import { migrate, type Migration } from "./migrate.ts";
import type { ChannelType } from "./notify.ts";
import { DIRECTORY_TABLES } from "./tables.ts";
import { backupDates, clearTables, exportPage, importRows, nextBackupAt, readBackup, SNAPSHOT_MAX_BYTES, writeBackup, type Page } from "./snapshot.ts";

export type WorkspaceRole = "admin" | "member";

export type WorkspaceRecord = {
  slug: string;
  name: string;
  createdAt: string;
  suspended: boolean;
  stats: WorkspaceStats | null;
  statsAt: string | null;
};

export type WorkspaceStats = { artifacts: number; members: number; bytes: number; lastActivity: string | null };

export type ChannelRow = { id: string; type: ChannelType; config: Record<string, unknown> };

export class DirectoryError extends Error {}

// Typed view of the RPC stub (see HubApi in hub.ts for why).
type AsyncMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};
export type DirectoryApi = AsyncMethods<
  Pick<
    Directory,
    | "createWorkspace" | "workspace" | "workspaces" | "setSuspended" | "removeWorkspace" | "recordStats" | "setMembership"
    | "replaceMemberships" | "membershipsOf" | "names" | "profile" | "setName" | "addChannel" | "removeChannel" | "channelConfig" | "channelsFor"
    | "recordChannelResult" | "startLogin" | "verifyLogin" | "exportPage" | "importBegin" | "importRows" | "importEnd"
    | "backup" | "backups" | "restore"
  >
>;

/** Slugs that can never be workspaces: they are, or could become, our own hostnames. */
const RESERVED = new Set([
  "www", "auth", "mail", "api", "admin", "app", "apps", "dev", "staging", "stage", "test", "prod", "static", "assets",
  "status", "help", "docs", "blog", "login", "signin", "account", "billing", "mcp", "oauth", "cdn", "ws", "root",
]);

export function validSlug(slug: string): boolean {
  return /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(slug) && !slug.includes("--") && !RESERVED.has(slug);
}

const CODE_TTL_MS = 10 * 60_000;
const CODE_ATTEMPTS = 5;
const CODES_PER_EMAIL_PER_HOUR = 5;
// Anyone can ask for a code, so cap what one client, and everyone together, can make us send.
const CODES_PER_IP_PER_HOUR = 20;
const CODES_PER_HOUR = 1000;
const CHANNEL_MAX_FAILURES = 5;
const CHANNELS_MAX = 10;
const BACKUP_ROOT = "_directory";
const BACKUPS_KEEP = 30;

const MIGRATIONS: Migration[] = [
  (sql) =>
    sql.exec(`
      CREATE TABLE workspaces (
        slug TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, suspended INTEGER NOT NULL DEFAULT 0,
        stats TEXT, stats_at TEXT);
      CREATE TABLE memberships (
        email TEXT NOT NULL, slug TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (email, slug));
      CREATE INDEX memberships_by_slug ON memberships (slug);
      CREATE TABLE users (email TEXT PRIMARY KEY, name TEXT, created_at TEXT NOT NULL);
      CREATE TABLE channels (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, type TEXT NOT NULL, label TEXT NOT NULL, config TEXT NOT NULL,
        created_at TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0, last_error TEXT, disabled INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX channels_by_email ON channels (email);
      CREATE TABLE login_codes (
        email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE login_sends (email TEXT NOT NULL, ip TEXT, at INTEGER NOT NULL);
      CREATE INDEX login_sends_by_at ON login_sends (at);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `),
];

export class Directory extends DurableObject {
  private sql: SqlStorage;
  private loginSecret: string;
  private bucket?: R2Bucket;
  private dirty = false;

  constructor(ctx: DurableObjectState, env: { LOGIN_SECRET: string; BACKUPS?: R2Bucket }) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    this.loginSecret = env.LOGIN_SECRET;
    this.bucket = env.BACKUPS;
    migrate(ctx.storage, MIGRATIONS);
  }

  // ---- workspaces --------------------------------------------------------------

  createWorkspace(slug: string, name: string): WorkspaceRecord {
    if (!validSlug(slug)) throw new DirectoryError(`"${slug}" can't be a workspace name: use 3-32 lowercase letters, digits and single hyphens`);
    if (this.workspace(slug)) throw new DirectoryError(`workspace ${slug} already exists`);
    this.sql.exec(`INSERT INTO workspaces (slug, name, created_at) VALUES (?, ?, ?)`, slug, name.trim() || slug, new Date().toISOString());
    this.markDirty();
    return this.workspace(slug)!;
  }

  workspace(slug: string): WorkspaceRecord | null {
    const r = this.sql.exec(`SELECT * FROM workspaces WHERE slug = ?`, slug).toArray()[0];
    return r ? toWorkspace(r) : null;
  }

  workspaces(): (WorkspaceRecord & { admins: string[] })[] {
    const admins = new Map<string, string[]>();
    for (const m of this.sql.exec(`SELECT slug, email FROM memberships WHERE role = 'admin' ORDER BY email`)) {
      admins.set(m.slug as string, [...(admins.get(m.slug as string) ?? []), m.email as string]);
    }
    return this.sql
      .exec(`SELECT * FROM workspaces ORDER BY slug`)
      .toArray()
      .map((r) => ({ ...toWorkspace(r), admins: admins.get(r.slug as string) ?? [] }));
  }

  setSuspended(slug: string, suspended: boolean) {
    this.sql.exec(`UPDATE workspaces SET suspended = ? WHERE slug = ?`, suspended ? 1 : 0, slug);
    this.markDirty();
  }

  removeWorkspace(slug: string) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM memberships WHERE slug = ?`, slug);
      this.sql.exec(`DELETE FROM workspaces WHERE slug = ?`, slug);
    });
    this.markDirty();
  }

  recordStats(slug: string, stats: WorkspaceStats, name?: string) {
    this.sql.exec(
      `UPDATE workspaces SET stats = ?, stats_at = ?, name = COALESCE(?, name) WHERE slug = ?`,
      JSON.stringify(stats),
      new Date().toISOString(),
      name ?? null,
      slug,
    );
  }

  /** Mirror of a workspace's member list, for "your workspaces". The workspace itself is the source of truth. */
  setMembership(slug: string, email: string, role: WorkspaceRole | null) {
    this.markDirty();
    if (role === null) this.sql.exec(`DELETE FROM memberships WHERE email = ? AND slug = ?`, email, slug);
    else {
      this.sql.exec(
        `INSERT INTO memberships (email, slug, role) VALUES (?, ?, ?) ON CONFLICT (email, slug) DO UPDATE SET role = excluded.role`,
        email,
        slug,
        role,
      );
    }
  }

  /** Make the mirror match a workspace's full member list (after an import or restore). */
  replaceMemberships(slug: string, members: { email: string; role: WorkspaceRole }[]) {
    this.markDirty();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM memberships WHERE slug = ?`, slug);
      for (const m of members) this.sql.exec(`INSERT INTO memberships (email, slug, role) VALUES (?, ?, ?)`, m.email, slug, m.role);
    });
  }

  membershipsOf(email: string): { slug: string; name: string; role: WorkspaceRole; suspended: boolean }[] {
    return this.sql
      .exec(
        `SELECT w.slug, w.name, w.suspended, m.role FROM memberships m JOIN workspaces w ON w.slug = m.slug WHERE m.email = ? ORDER BY w.name`,
        email,
      )
      .toArray()
      .map((r) => ({ slug: r.slug as string, name: r.name as string, role: r.role as WorkspaceRole, suspended: Boolean(r.suspended) }));
  }

  // ---- people --------------------------------------------------------------------

  names(emails: string[]): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const e of new Set(emails)) {
      out[e] = (this.sql.exec(`SELECT name FROM users WHERE email = ?`, e).toArray()[0]?.name as string | null) ?? null;
    }
    return out;
  }

  profile(email: string) {
    const channels = this.sql
      .exec(`SELECT id, type, label, created_at, last_error, disabled FROM channels WHERE email = ? ORDER BY created_at`, email)
      .toArray()
      .map((c) => ({
        id: c.id as string,
        type: c.type as ChannelType,
        label: c.label as string,
        createdAt: c.created_at as string,
        lastError: (c.last_error as string | null) ?? null,
        disabled: Boolean(c.disabled),
      }));
    return { email, name: this.names([email])[email], channels, workspaces: this.membershipsOf(email) };
  }

  setName(email: string, name: string) {
    this.markDirty();
    this.sql.exec(
      `INSERT INTO users (email, name, created_at) VALUES (?, ?, ?) ON CONFLICT (email) DO UPDATE SET name = excluded.name`,
      email,
      name.trim().slice(0, 80) || null,
      new Date().toISOString(),
    );
  }

  addChannel(email: string, type: ChannelType, config: Record<string, unknown>, label: string): string {
    const count = this.sql.exec(`SELECT COUNT(*) AS n FROM channels WHERE email = ?`, email).one().n as number;
    if (count >= CHANNELS_MAX) throw new DirectoryError(`you can have at most ${CHANNELS_MAX} notification channels`);
    // The same browser subscribing twice replaces its old subscription.
    if (type === "webpush") {
      for (const c of this.sql.exec(`SELECT id, config FROM channels WHERE email = ? AND type = 'webpush'`, email).toArray()) {
        if ((JSON.parse(c.config as string) as { endpoint?: string }).endpoint === config.endpoint) {
          this.sql.exec(`DELETE FROM channels WHERE id = ?`, c.id);
        }
      }
    }
    const id = `n${randomId(12)}`;
    this.markDirty();
    this.sql.exec(
      `INSERT INTO channels (id, email, type, label, config, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      email,
      type,
      label,
      JSON.stringify(config),
      new Date().toISOString(),
    );
    return id;
  }

  removeChannel(email: string, id: string): boolean {
    this.markDirty();
    return this.sql.exec(`DELETE FROM channels WHERE id = ? AND email = ? RETURNING id`, id, email).toArray().length > 0;
  }

  channelConfig(email: string, id: string): ChannelRow | null {
    const c = this.sql.exec(`SELECT id, type, config FROM channels WHERE id = ? AND email = ?`, id, email).toArray()[0];
    return c ? { id: c.id as string, type: c.type as ChannelType, config: JSON.parse(c.config as string) } : null;
  }

  /** Active channels for each email, for a workspace delivering notifications. */
  channelsFor(emails: string[]): Record<string, ChannelRow[]> {
    const out: Record<string, ChannelRow[]> = {};
    for (const e of new Set(emails)) {
      out[e] = this.sql
        .exec(`SELECT id, type, config FROM channels WHERE email = ? AND disabled = 0`, e)
        .toArray()
        .map((c) => ({ id: c.id as string, type: c.type as ChannelType, config: JSON.parse(c.config as string) }));
    }
    return out;
  }

  /** Track delivery health; a channel is switched off after repeated failures or when its endpoint is gone. */
  recordChannelResult(id: string, result: { ok: boolean; error?: string; gone?: boolean }) {
    if (!result.ok) this.markDirty();
    if (result.ok) this.sql.exec(`UPDATE channels SET failures = 0, last_error = NULL, disabled = 0 WHERE id = ?`, id);
    else if (result.gone) this.sql.exec(`DELETE FROM channels WHERE id = ?`, id);
    else {
      this.sql.exec(
        `UPDATE channels SET failures = failures + 1, last_error = ?, disabled = CASE WHEN failures + 1 >= ? THEN 1 ELSE disabled END WHERE id = ?`,
        (result.error ?? "failed").slice(0, 300),
        CHANNEL_MAX_FAILURES,
        id,
      );
    }
  }

  // ---- export, import and backups (see snapshot.ts) ----------------------------------

  exportPage(table: string, after = 0): Page {
    return exportPage(this.sql, DIRECTORY_TABLES, table, after);
  }

  importBegin() {
    clearTables(this.ctx.storage, DIRECTORY_TABLES);
  }

  importRows(table: string, rows: Record<string, unknown>[]): number {
    return importRows(this.ctx.storage, DIRECTORY_TABLES, table, rows);
  }

  importEnd() {
    this.markDirty();
    return { workspaces: this.workspaces().length };
  }

  async backup(): Promise<string | null> {
    this.sql.exec(`DELETE FROM settings WHERE key = 'backup_due_at'`);
    this.dirty = false;
    return this.bucket ? writeBackup(this.bucket, BACKUP_ROOT, DIRECTORY_TABLES, (t, after) => this.exportPage(t, after), BACKUPS_KEEP, this.sql.databaseSize <= SNAPSHOT_MAX_BYTES) : null;
  }

  async backups(): Promise<string[]> {
    return this.bucket ? backupDates(this.bucket, BACKUP_ROOT) : [];
  }

  async restore(date: string) {
    if (!this.bucket) throw new DirectoryError("no backup bucket is bound");
    if (!(await this.bucket.head(`${BACKUP_ROOT}/${date}/manifest.json`))) throw new DirectoryError(`no complete backup for ${date}`);
    const bucket = this.bucket;
    return this.ctx.blockConcurrencyWhile(async () => {
      this.importBegin();
      await readBackup(bucket, BACKUP_ROOT, date, DIRECTORY_TABLES, (table, rows) => this.importRows(table, rows));
      return this.importEnd();
    });
  }

  async alarm() {
    const due = this.sql.exec(`SELECT value FROM settings WHERE key = 'backup_due_at'`).toArray()[0];
    if (due && Number(due.value) <= Date.now()) await this.backup();
  }

  /** Something worth keeping changed: schedule tonight's backup if none is pending. */
  private markDirty() {
    if (this.dirty || !this.bucket) return;
    this.dirty = true;
    if (this.sql.exec(`SELECT 1 FROM settings WHERE key = 'backup_due_at'`).toArray().length) return;
    const at = nextBackupAt();
    this.sql.exec(`INSERT INTO settings (key, value) VALUES ('backup_due_at', ?)`, String(at));
    void this.ctx.storage.setAlarm(at);
  }

  // ---- sign-in codes ---------------------------------------------------------------

  /** A fresh six-digit code for `email`, replacing any earlier one. The caller emails it. */
  async startLogin(email: string, ip: string | null = null, now = Date.now()): Promise<string> {
    const hourAgo = now - 3600_000;
    this.sql.exec(`DELETE FROM login_sends WHERE at < ?`, hourAgo);
    this.sql.exec(`DELETE FROM login_codes WHERE expires_at < ?`, now);
    const mine = this.sql.exec(`SELECT COUNT(*) AS n FROM login_sends WHERE email = ?`, email).one().n as number;
    if (mine >= CODES_PER_EMAIL_PER_HOUR) throw new DirectoryError("Too many codes for this address. Try again in an hour.");
    if (ip && (this.sql.exec(`SELECT COUNT(*) AS n FROM login_sends WHERE ip = ?`, ip).one().n as number) >= CODES_PER_IP_PER_HOUR) {
      throw new DirectoryError("Too many sign-in attempts from your network. Try again in an hour.");
    }
    const all = this.sql.exec(`SELECT COUNT(*) AS n FROM login_sends`).one().n as number;
    if (all >= CODES_PER_HOUR) throw new DirectoryError("Sign-in is busy right now. Try again in a few minutes.");
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
    const code = String(n).padStart(6, "0");
    this.sql.exec(
      `INSERT INTO login_codes (email, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)
       ON CONFLICT (email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
      email,
      await this.codeHash(email, code),
      now + CODE_TTL_MS,
    );
    this.sql.exec(`INSERT INTO login_sends (email, ip, at) VALUES (?, ?, ?)`, email, ip, now);
    return code;
  }

  /** True once for the right code; a code dies after a success, its expiry or too many wrong guesses. */
  async verifyLogin(email: string, code: string, now = Date.now()): Promise<boolean> {
    const row = this.sql.exec(`SELECT * FROM login_codes WHERE email = ?`, email).toArray()[0];
    if (!row || (row.expires_at as number) < now || (row.attempts as number) >= CODE_ATTEMPTS) return false;
    const ok = row.code_hash === (await this.codeHash(email, code.replace(/\D/g, "")));
    if (ok) this.sql.exec(`DELETE FROM login_codes WHERE email = ?`, email);
    else this.sql.exec(`UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?`, email);
    return ok;
  }

  private async codeHash(email: string, code: string): Promise<string> {
    const data = new TextEncoder().encode(`${this.loginSecret}\n${email}\n${code}`);
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
}

function toWorkspace(r: Record<string, SqlStorageValue>): WorkspaceRecord {
  return {
    slug: r.slug as string,
    name: r.name as string,
    createdAt: r.created_at as string,
    suspended: Boolean(r.suspended),
    stats: r.stats ? (JSON.parse(r.stats as string) as WorkspaceStats) : null,
    statsAt: (r.stats_at as string | null) ?? null,
  };
}

export function randomId(n: number): string {
  // base32 without look-alikes: unguessable enough for ids that are also ACL-gated.
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => alphabet[b % alphabet.length]).join("");
}

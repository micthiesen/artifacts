// Directory: the one global Durable Object. It knows which workspaces exist,
// who belongs to which, and per-person settings that follow someone across
// workspaces (display name, notification channels), and it issues sign-in
// codes. Ordinary page loads never touch it; workspaces keep their own data.
import { DurableObject } from "cloudflare:workers";
import { migrate, type Migration } from "./migrate.ts";
import type { ChannelType } from "./notify.ts";
import { DIRECTORY_TABLES } from "./tables.ts";
import type { PlanId } from "./plans.ts";
import {
  backupRuns,
  createShadows,
  dropShadows,
  exportPage,
  hasShadows,
  loadShadow,
  nextBackupAt,
  pruneBackups,
  readRun,
  startBackup,
  startRestore,
  stepBackup,
  swapShadows,
  type Page,
} from "./snapshot.ts";

export type WorkspaceRole = "admin" | "member";

export type WorkspaceRecord = {
  slug: string;
  name: string;
  createdAt: string;
  suspended: boolean;
  stats: WorkspaceStats | null;
  statsAt: string | null;
  job: WorkspaceJob | null;
  jobError: { message: string; at: string } | null;
};

export type WorkspaceStats = { artifacts: number; members: number; bytes: number; lastActivity: string | null; plan?: PlanId };
export type WorkspaceJob = { kind: string; phase?: string; error?: string; startedAt: string };

/** A saved passkey as the account page lists it (no key material). */
export type PasskeySummary = { id: string; name: string; createdAt: string; lastUsedAt: string | null };
/** What checking a passkey sign-in needs. */
export type StoredPasskey = { id: string; email: string; publicKey: string; counter: number; transports: string[] };

export type ChannelRow = { id: string; type: ChannelType; config: Record<string, unknown> };

export class DirectoryError extends Error {}

// Typed view of the RPC stub (see HubApi in hub.ts for why).
type AsyncMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};
export type DirectoryApi = AsyncMethods<
  Pick<
    Directory,
    | "createWorkspace" | "createOwnWorkspace" | "workspace" | "workspaces" | "setSuspended" | "removeWorkspace" | "recordStats" | "setMembership"
    | "replaceMemberships" | "membershipsOf" | "names" | "profile" | "setName" | "addChannel" | "removeChannel" | "channelConfig" | "channelsFor"
    | "recordChannelResult" | "recordChannelResults" | "startLogin" | "verifyLogin" | "hasSignedIn" | "recordVisit" | "allowChannelTest" | "signInDiagnostics" | "setEmailNotifications" | "recordJob" | "publish" | "exportPage" | "importBegin" | "importRows" | "importEnd"
    | "backup" | "backups" | "restore" | "passkeys" | "passkey" | "addPasskey" | "removePasskey" | "usePasskey"
  >
>;

/** Slugs that can never be workspaces: they are, or could become, our own hostnames. */
const RESERVED = new Set([
  "www", "auth", "mail", "api", "admin", "app", "apps", "dev", "staging", "stage", "test", "prod", "static", "assets",
  "status", "help", "docs", "blog", "login", "signin", "account", "billing", "mcp", "oauth", "cdn", "ws", "root",
]);

/** One person however they tag their address: name+anything@example.com is name@example.com. */
export function personKey(email: string): string {
  const [local, domain] = email.toLowerCase().split("@");
  return `${local.split("+")[0]}@${domain}`;
}

export function validSlug(slug: string): boolean {
  return /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(slug) && !slug.includes("--") && !RESERVED.has(slug);
}

/** Self-serve workspaces: how many one person may make, and how many everyone may make a day. */
const SELF_SERVE_PER_PERSON = 1;
const SELF_SERVE_PER_DAY = 50;

const CODE_TTL_MS = 10 * 60_000;
// Anyone can ask for a code, so cap what one client, one address and everyone together can make us send.
const CODES_PER_EMAIL_PER_IP_PER_HOUR = 5;
const CODES_PER_EMAIL_PER_HOUR = 10;
const CODES_PER_IP_PER_HOUR = 100;
const CODES_PER_HOUR = 2000;
/** Live codes one network can have for an address; older ones from that network make way. */
const LIVE_CODES = 3;
// Wrong guesses: a network that keeps failing for an address is shut out for the hour. Once an
// address has many failures, only networks that already failed are refused, so its owner can still
// sign in from theirs. With 8-digit codes that bounds brute force far below one in a thousand a week.
const FAILS_PER_EMAIL_PER_IP_PER_HOUR = 10;
const FAILS_PER_EMAIL_PER_HOUR = 30;
const CODE_DIGITS = 8;
const CHANNEL_TESTS_PER_HOUR = 20;
const PASSKEYS_MAX = 20;
const CHANNEL_MAX_FAILURES = 5;
const CHANNELS_MAX = 10;
/** The id the built-in email channel goes by in channelsFor; it has no row. */
const EMAIL_CHANNEL = "email";
const BACKUP_ROOT = "_directory";
/** KV key holding the workspace list the Worker routes by. */
export const WORKSPACE_LIST_KEY = "artifacts:workspaces";
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
  // Several live codes per address, so someone requesting codes for your address
  // can't cancel the one you were sent; failed guesses counted per address and
  // network; workspaces people opened as guests; channel test sends.
  (sql) =>
    sql.exec(`
      DROP TABLE login_codes;
      CREATE TABLE login_codes (id INTEGER PRIMARY KEY, email TEXT NOT NULL, ip TEXT, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX login_codes_by_email ON login_codes (email);
      CREATE TABLE login_fails (email TEXT NOT NULL, ip TEXT, at INTEGER NOT NULL);
      CREATE INDEX login_fails_by_email ON login_fails (email, at);
      CREATE INDEX login_sends_by_email ON login_sends (email, at);
      CREATE TABLE visits (email TEXT NOT NULL, slug TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (email, slug));
      CREATE INDEX visits_by_slug ON visits (slug);
      CREATE TABLE channel_tests (email TEXT NOT NULL, at INTEGER NOT NULL);
    `),
  // Email notifications are on unless someone turns them off.
  (sql) => sql.exec(`ALTER TABLE users ADD COLUMN email_off INTEGER NOT NULL DEFAULT 0`),
  // Each workspace's running job and last failure, reported by the workspace.
  (sql) => sql.exec(`ALTER TABLE workspaces ADD COLUMN job TEXT; ALTER TABLE workspaces ADD COLUMN job_error TEXT;`),
  // Passkeys, so people can sign in without an emailed code, and the challenges
  // already used to sign in with one (a challenge works once).
  (sql) =>
    sql.exec(`
      CREATE TABLE passkeys (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0,
        transports TEXT, name TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);
      CREATE INDEX passkeys_by_email ON passkeys (email);
      CREATE TABLE passkey_challenges (challenge TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    `),
  // Self-serve workspaces: who made one and which terms they agreed to.
  (sql) => sql.exec(`ALTER TABLE workspaces ADD COLUMN created_by TEXT; ALTER TABLE workspaces ADD COLUMN terms_accepted TEXT;`),
];

export class Directory extends DurableObject {
  private sql: SqlStorage;
  private loginSecret: string;
  private bucket?: R2Bucket;
  private dirty = false;

  constructor(ctx: DurableObjectState, env: { LOGIN_SECRET: string; BACKUPS?: R2Bucket; OAUTH_KV?: KVNamespace }) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    this.loginSecret = env.LOGIN_SECRET;
    this.bucket = env.BACKUPS;
    this.kv = env.OAUTH_KV;
    migrate(ctx.storage, MIGRATIONS);
  }

  private kv?: KVNamespace;
  private publishing: Promise<void> = Promise.resolve();

  /**
   * Mirror the workspace list to KV for routing (see workspaceRecord in
   * index.ts). Publishes run one after another and each reads the list when it
   * runs, so the last write is always the newest state.
   */
  publish(): Promise<void> {
    const run = async () => {
      if (!this.kv) return;
      const list = Object.fromEntries(this.workspaces().map((w) => [w.slug, { name: w.name, suspended: w.suspended }]));
      await this.kv.put(WORKSPACE_LIST_KEY, JSON.stringify({ at: new Date().toISOString(), list }));
    };
    this.publishing = this.publishing.then(run, run).catch((err) => console.error("publishing the workspace list failed", err));
    return this.publishing;
  }

  // ---- workspaces --------------------------------------------------------------

  /**
   * A workspace someone makes for themselves (self-serve, when it's on): one
   * each (name+tag@ addresses count as the same person), and a cap per day
   * across everyone, so signup can't mint workspaces in bulk. Checked and
   * recorded in one step, so two requests at once can't both pass. Records
   * the version of the terms they agreed to.
   */
  async createOwnWorkspace(email: string, slug: string, name: string, terms: string): Promise<WorkspaceRecord> {
    const person = personKey(email);
    const mine = this.sql.exec(`SELECT COUNT(*) AS n FROM workspaces WHERE created_by = ?`, person).one().n as number;
    if (mine >= SELF_SERVE_PER_PERSON) throw new DirectoryError("You already made a workspace. Ask its admins to add people, or contact us for another.");
    const today = this.sql.exec(`SELECT COUNT(*) AS n FROM workspaces WHERE created_by IS NOT NULL AND created_at > ?`, new Date(Date.now() - 86_400_000).toISOString()).one().n as number;
    if (today >= SELF_SERVE_PER_DAY) throw new DirectoryError("We can't make more workspaces today. Try again tomorrow.");
    return this.createWorkspace(slug, name, { createdBy: person, terms });
  }

  async createWorkspace(slug: string, name: string, own?: { createdBy: string; terms: string }): Promise<WorkspaceRecord> {
    if (RESERVED.has(slug)) throw new DirectoryError(`"${slug}" is reserved for the site itself; pick another workspace name`);
    if (!validSlug(slug)) throw new DirectoryError(`"${slug}" can't be a workspace name: use 3-32 lowercase letters, digits and single hyphens, starting with a letter`);
    if (this.workspace(slug)) throw new DirectoryError(`workspace ${slug} already exists`);
    this.sql.exec(
      `INSERT INTO workspaces (slug, name, created_at, created_by, terms_accepted) VALUES (?, ?, ?, ?, ?)`,
      slug,
      name.trim() || slug,
      new Date().toISOString(),
      own?.createdBy ?? null,
      own?.terms ?? null,
    );
    this.markDirty();
    await this.publish();
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

  async setSuspended(slug: string, suspended: boolean) {
    this.sql.exec(`UPDATE workspaces SET suspended = ? WHERE slug = ?`, suspended ? 1 : 0, slug);
    this.markDirty();
    await this.publish();
  }

  async removeWorkspace(slug: string) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM memberships WHERE slug = ?`, slug);
      this.sql.exec(`DELETE FROM visits WHERE slug = ?`, slug);
      this.sql.exec(`DELETE FROM workspaces WHERE slug = ?`, slug);
    });
    this.markDirty();
    await this.publish();
  }

  async recordStats(slug: string, stats: WorkspaceStats, name?: string) {
    const renamed = name !== undefined && this.workspace(slug)?.name !== name;
    this.sql.exec(
      `UPDATE workspaces SET stats = ?, stats_at = ?, name = COALESCE(?, name) WHERE slug = ?`,
      JSON.stringify(stats),
      new Date().toISOString(),
      name ?? null,
      slug,
    );
    if (renamed) await this.publish();
  }

  /** A workspace's running job and last failure, so the operator console needn't wake every workspace. */
  recordJob(slug: string, job: WorkspaceJob | null, lastError: { message: string; at: string } | null) {
    this.sql.exec(`UPDATE workspaces SET job = ?, job_error = ? WHERE slug = ?`, job ? JSON.stringify(job) : null, lastError ? JSON.stringify(lastError) : null, slug);
  }

  /** Mirror of a workspace's member list, for "your workspaces". The workspace itself is the source of truth. */
  setMembership(slug: string, email: string, role: WorkspaceRole | null) {
    // A late call from a deleted workspace mustn't leave rows a recreated one would inherit.
    if (role !== null && !this.workspace(slug)) return;
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

  /** Workspaces this person belongs to, then ones they've opened as a guest. */
  membershipsOf(email: string): { slug: string; name: string; role: WorkspaceRole | "guest"; suspended: boolean }[] {
    const rows = this.sql
      .exec(
        `SELECT w.slug, w.name, w.suspended, m.role FROM memberships m JOIN workspaces w ON w.slug = m.slug WHERE m.email = ?
         UNION ALL
         SELECT w.slug, w.name, w.suspended, 'guest' FROM visits v JOIN workspaces w ON w.slug = v.slug
         WHERE v.email = ? AND v.slug NOT IN (SELECT slug FROM memberships WHERE email = ?)`,
        email,
        email,
        email,
      )
      .toArray()
      .sort((a, b) => Number(a.role === "guest") - Number(b.role === "guest") || String(a.name).localeCompare(String(b.name)));
    return rows.map((r) => ({ slug: r.slug as string, name: r.name as string, role: r.role as WorkspaceRole | "guest", suspended: Boolean(r.suspended) }));
  }

  // ---- people --------------------------------------------------------------------

  names(emails: string[]): Record<string, string | null> {
    const unique = [...new Set(emails)];
    const out: Record<string, string | null> = Object.fromEntries(unique.map((e) => [e, null]));
    for (let i = 0; i < unique.length; i += 50) {
      const batch = unique.slice(i, i + 50);
      for (const r of this.sql.exec(`SELECT email, name FROM users WHERE email IN (${batch.map(() => "?").join(", ")})`, ...batch)) out[r.email as string] = (r.name as string | null) ?? null;
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
    return {
      email,
      name: this.names([email])[email],
      channels,
      emailNotifications: this.emailNotifications(email),
      workspaces: this.membershipsOf(email),
      passkeys: this.passkeys(email),
    };
  }

  setName(email: string, name: string) {
    // A name can't pass itself off as someone's address.
    if (name.includes("@")) throw new DirectoryError("A display name can't contain @.");
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

  /** Active channels for each email, for a workspace delivering notifications. Email is one, unless turned off. */
  channelsFor(emails: string[]): Record<string, ChannelRow[]> {
    const out: Record<string, ChannelRow[]> = {};
    for (const e of new Set(emails)) {
      out[e] = this.sql
        .exec(`SELECT id, type, config FROM channels WHERE email = ? AND disabled = 0`, e)
        .toArray()
        .map((c) => ({ id: c.id as string, type: c.type as ChannelType, config: JSON.parse(c.config as string) }));
      if (this.emailNotifications(e)) out[e].push({ id: EMAIL_CHANNEL, type: "email", config: { to: e } });
    }
    return out;
  }

  emailNotifications(email: string): boolean {
    return !this.sql.exec(`SELECT email_off FROM users WHERE email = ?`, email).toArray()[0]?.email_off;
  }

  setEmailNotifications(email: string, on: boolean) {
    this.sql.exec(
      `INSERT INTO users (email, name, created_at, email_off) VALUES (?, NULL, ?, ?) ON CONFLICT (email) DO UPDATE SET email_off = excluded.email_off`,
      email,
      new Date().toISOString(),
      on ? 0 : 1,
    );
    this.markDirty();
  }

  /** Many delivery results at once (one RPC per notification run). */
  recordChannelResults(results: { id: string; result: { ok: boolean; error?: string; gone?: boolean } }[]) {
    for (const r of results) this.recordChannelResult(r.id, r.result);
  }

  /** Track delivery health; a channel is switched off after repeated failures or when its endpoint is gone. */
  recordChannelResult(id: string, result: { ok: boolean; error?: string; gone?: boolean }) {
    if (id === EMAIL_CHANNEL) return;
    if (!result.ok) this.markDirty();
    // Successes only write when there was something to clear.
    if (result.ok) this.sql.exec(`UPDATE channels SET failures = 0, last_error = NULL, disabled = 0 WHERE id = ? AND (failures > 0 OR last_error IS NOT NULL OR disabled = 1)`, id);
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

  /** Imports load into shadow tables and swap in at importEnd, so a failed import changes nothing. */
  importBegin() {
    createShadows(this.ctx.storage, DIRECTORY_TABLES);
  }

  importRows(table: string, rows: Record<string, unknown>[]): number {
    if (!hasShadows(this.sql, DIRECTORY_TABLES)) throw new DirectoryError("call importBegin first");
    return loadShadow(this.ctx.storage, DIRECTORY_TABLES, table, rows);
  }

  async importEnd() {
    if (!hasShadows(this.sql, DIRECTORY_TABLES)) throw new DirectoryError("no import is running");
    swapShadows(this.ctx.storage, DIRECTORY_TABLES);
    return this.importDone();
  }

  private async importDone() {
    this.dirty = false;
    this.markDirty();
    await this.publish();
    return { workspaces: this.workspaces().length };
  }

  /**
   * Back up now. The directory is small, so this runs in one go; a failure is
   * retried in an hour instead of waiting for the next change.
   */
  async backup(): Promise<string | null> {
    if (!this.bucket) return null;
    const due = this.sql.exec(`SELECT value FROM settings WHERE key = 'backup_due_at'`).toArray()[0]?.value as string | undefined;
    this.sql.exec(`DELETE FROM settings WHERE key = 'backup_due_at'`);
    this.dirty = false;
    try {
      const r = await stepBackup(this.bucket, BACKUP_ROOT, DIRECTORY_TABLES, (t, after) => this.exportPage(t, after), startBackup(), this.schemaVersion(), Infinity);
      if (!("done" in r)) throw new Error("backup didn't finish");
      await pruneBackups(this.bucket, BACKUP_ROOT, BACKUPS_KEEP);
      return `${BACKUP_ROOT}/${r.done.run}/`;
    } catch (err) {
      const retry = Math.min(Number(due ?? Infinity), Date.now() + 3600_000);
      this.sql.exec(`INSERT INTO settings (key, value) VALUES ('backup_due_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, String(retry));
      await this.ctx.storage.setAlarm(retry);
      throw err;
    }
  }

  async backups(): Promise<string[]> {
    return this.bucket ? backupRuns(this.bucket, BACKUP_ROOT) : [];
  }

  /** Replace the directory with a backup run, after checking every page fits; nothing else runs meanwhile. */
  /**
   * Replace the directory with a backup run. It backs up the current state
   * first, reads the whole run (the directory is small), then loads and swaps
   * it in with no awaits in between, so it lands entirely or not at all.
   */
  async restore(run: string) {
    const bucket = this.bucket;
    if (!bucket) throw new DirectoryError("no backup bucket is bound");
    const cursor = await startRestore(bucket, BACKUP_ROOT, run, DIRECTORY_TABLES, this.schemaVersion());
    const pages = await readRun(bucket, cursor);
    await this.backup();
    createShadows(this.ctx.storage, DIRECTORY_TABLES);
    try {
      for (const p of pages) loadShadow(this.ctx.storage, DIRECTORY_TABLES, p.table, p.rows);
    } catch (err) {
      dropShadows(this.ctx.storage, DIRECTORY_TABLES);
      throw err;
    }
    swapShadows(this.ctx.storage, DIRECTORY_TABLES);
    return this.importDone();
  }

  async alarm() {
    const due = this.sql.exec(`SELECT value FROM settings WHERE key = 'backup_due_at'`).toArray()[0];
    if (due && Number(due.value) <= Date.now()) await this.backup();
  }

  private schemaVersion(): number {
    return this.sql.exec(`SELECT version FROM _schema`).one().version as number;
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

  /**
   * A fresh eight-digit code for `email`; the caller emails it. Earlier codes
   * stay valid until they expire, so a stranger asking for codes for your
   * address can't cancel the one in your inbox.
   */
  async startLogin(email: string, ip: string | null = null, now = Date.now()): Promise<string> {
    const hourAgo = now - 3600_000;
    this.sql.exec(`DELETE FROM login_sends WHERE at < ?`, hourAgo);
    this.sql.exec(`DELETE FROM login_codes WHERE expires_at < ?`, now);
    const count = (where: string, ...args: SqlStorageValue[]) => this.sql.exec(`SELECT COUNT(*) AS n FROM login_sends WHERE ${where}`, ...args).one().n as number;
    if (count("email = ? AND ip IS ?", email, ip) >= CODES_PER_EMAIL_PER_IP_PER_HOUR || count("email = ?", email) >= CODES_PER_EMAIL_PER_HOUR) {
      throw new DirectoryError("Too many codes for this address. Use the last one you were sent, or try again in an hour.");
    }
    if (ip && count("ip = ?", ip) >= CODES_PER_IP_PER_HOUR) throw new DirectoryError("Too many sign-in attempts from your network. Try again in an hour.");
    if (count("1") >= CODES_PER_HOUR) throw new DirectoryError("Sign-in is busy right now. Try again in a few minutes.");
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 10 ** CODE_DIGITS;
    const code = String(n).padStart(CODE_DIGITS, "0");
    this.sql.exec(`INSERT INTO login_codes (email, ip, code_hash, expires_at) VALUES (?, ?, ?, ?)`, email, ip, await this.codeHash(email, code), now + CODE_TTL_MS);
    // Only the requester's own older codes make way, never codes sent to someone else's request.
    this.sql.exec(
      `DELETE FROM login_codes WHERE email = ? AND ip IS ? AND id NOT IN (SELECT id FROM login_codes WHERE email = ? AND ip IS ? ORDER BY id DESC LIMIT ?)`,
      email,
      ip,
      email,
      ip,
      LIVE_CODES,
    );
    this.sql.exec(`INSERT INTO login_sends (email, ip, at) VALUES (?, ?, ?)`, email, ip, now);
    return code;
  }

  /**
   * True once for a right code. Wrong guesses are counted per address and
   * network, so guessing from one place doesn't lock out the owner elsewhere,
   * and per address overall, which caps brute force.
   */
  async verifyLogin(email: string, code: string, ip: string | null = null, now = Date.now()): Promise<boolean> {
    const hourAgo = now - 3600_000;
    this.sql.exec(`DELETE FROM login_fails WHERE at < ?`, hourAgo);
    const fails = (where: string, ...args: SqlStorageValue[]) => this.sql.exec(`SELECT COUNT(*) AS n FROM login_fails WHERE email = ? AND ${where}`, email, ...args).one().n as number;
    const mine = fails("ip IS ?", ip);
    if (mine >= FAILS_PER_EMAIL_PER_IP_PER_HOUR || (mine > 0 && fails("1") >= FAILS_PER_EMAIL_PER_HOUR)) return false;
    const hash = await this.codeHash(email, code.replace(/\D/g, ""));
    const hit = this.sql.exec(`DELETE FROM login_codes WHERE email = ? AND code_hash = ? AND expires_at >= ? RETURNING id`, email, hash, now).toArray();
    if (!hit.length) {
      this.sql.exec(`INSERT INTO login_fails (email, ip, at) VALUES (?, ?, ?)`, email, ip, now);
      return false;
    }
    // Signed in once: they have an account now (see hasSignedIn).
    this.sql.exec(`INSERT INTO users (email, name, created_at) VALUES (?, NULL, ?) ON CONFLICT (email) DO NOTHING`, email, new Date(now).toISOString());
    return true;
  }

  /** For the operator helping someone who can't sign in: their recent code sends and failed checks. */
  signInDiagnostics(email: string) {
    const rows = (sql: string) => this.sql.exec(sql, email).toArray();
    return {
      sends: rows(`SELECT ip, at FROM login_sends WHERE email = ? ORDER BY at DESC LIMIT 20`).map((r) => ({ ip: r.ip, at: new Date(r.at as number).toISOString() })),
      fails: rows(`SELECT ip, at FROM login_fails WHERE email = ? ORDER BY at DESC LIMIT 20`).map((r) => ({ ip: r.ip, at: new Date(r.at as number).toISOString() })),
      liveCodes: rows(`SELECT ip, expires_at FROM login_codes WHERE email = ?`).map((r) => ({ ip: r.ip, expires: new Date(r.expires_at as number).toISOString() })),
      signedInBefore: this.hasSignedIn(email),
    };
  }

  /** Whether this person has ever signed in with a code (so a link must not sign in as them). */
  hasSignedIn(email: string): boolean {
    return this.sql.exec(`SELECT 1 FROM users WHERE email = ?`, email).toArray().length > 0;
  }

  /** Someone opened a workspace as a guest: list it among their workspaces on the apex. */
  recordVisit(email: string, slug: string) {
    this.sql.exec(`INSERT INTO visits (email, slug, at) VALUES (?, ?, ?) ON CONFLICT (email, slug) DO UPDATE SET at = excluded.at`, email, slug, new Date().toISOString());
    this.markDirty();
  }

  /** Throws when someone sends test notifications too often (each one is an outbound request). */
  allowChannelTest(email: string, now = Date.now()) {
    this.sql.exec(`DELETE FROM channel_tests WHERE at < ?`, now - 3600_000);
    if ((this.sql.exec(`SELECT COUNT(*) AS n FROM channel_tests WHERE email = ?`, email).one().n as number) >= CHANNEL_TESTS_PER_HOUR) {
      throw new DirectoryError("Too many test notifications; try again in an hour.");
    }
    this.sql.exec(`INSERT INTO channel_tests (email, at) VALUES (?, ?)`, email, now);
  }

  // ---- passkeys (checked in the Worker, see passkeys.ts; stored here) ----------------

  passkeys(email: string): PasskeySummary[] {
    return this.sql
      .exec(`SELECT id, name, created_at, last_used_at FROM passkeys WHERE email = ? ORDER BY created_at`, email)
      .toArray()
      .map((r) => ({ id: r.id as string, name: r.name as string, createdAt: r.created_at as string, lastUsedAt: (r.last_used_at as string | null) ?? null }));
  }

  passkey(id: string): StoredPasskey | null {
    const r = this.sql.exec(`SELECT * FROM passkeys WHERE id = ?`, id).toArray()[0];
    if (!r) return null;
    return { id, email: r.email as string, publicKey: r.public_key as string, counter: r.counter as number, transports: r.transports ? JSON.parse(r.transports as string) : [] };
  }

  /** Save a verified new passkey for someone signed in. */
  addPasskey(email: string, key: { id: string; publicKey: string; counter: number; transports: string[] }, name: string): PasskeySummary[] {
    const count = this.sql.exec(`SELECT COUNT(*) AS n FROM passkeys WHERE email = ?`, email).one().n as number;
    if (count >= PASSKEYS_MAX) throw new DirectoryError(`You can have at most ${PASSKEYS_MAX} passkeys. Remove one first.`);
    if (this.sql.exec(`SELECT 1 FROM passkeys WHERE id = ?`, key.id).toArray().length) throw new DirectoryError("This passkey is already saved.");
    this.sql.exec(
      `INSERT INTO passkeys (id, email, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      key.id,
      email,
      key.publicKey,
      key.counter,
      JSON.stringify(key.transports),
      name.slice(0, 80),
      new Date().toISOString(),
    );
    this.markDirty();
    return this.passkeys(email);
  }

  removePasskey(email: string, id: string): boolean {
    const removed = this.sql.exec(`DELETE FROM passkeys WHERE id = ? AND email = ? RETURNING id`, id, email).toArray().length > 0;
    if (removed) this.markDirty();
    return removed;
  }

  /**
   * Record a verified passkey sign-in: spends its challenge (each works once,
   * so a captured response can't be replayed) and stores the new counter.
   * Returns the person, or null when the challenge was already used or the
   * passkey has since been removed.
   */
  usePasskey(id: string, counter: number, challenge: string, expiresAt: number, now = Date.now()): string | null {
    this.sql.exec(`DELETE FROM passkey_challenges WHERE expires_at < ?`, now);
    if (this.sql.exec(`SELECT 1 FROM passkey_challenges WHERE challenge = ?`, challenge).toArray().length) return null;
    const row = this.sql.exec(`UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ? RETURNING email`, counter, new Date(now).toISOString(), id).toArray()[0];
    if (!row) return null;
    this.sql.exec(`INSERT INTO passkey_challenges (challenge, expires_at) VALUES (?, ?)`, challenge, expiresAt);
    return row.email as string;
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
    job: r.job ? (JSON.parse(r.job as string) as WorkspaceJob) : null,
    jobError: r.job_error ? (JSON.parse(r.job_error as string) as { message: string; at: string }) : null,
  };
}

export function randomId(n: number): string {
  // base32 without look-alikes: unguessable enough for ids that are also ACL-gated.
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => alphabet[b % alphabet.length]).join("");
}

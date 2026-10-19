// Directory: the one global Durable Object. It knows which workspaces exist,
// who belongs to which, and per-person settings that follow someone across
// workspaces (display name, notification channels), and it issues sign-in
// codes. Ordinary page loads never touch it; workspaces keep their own data.
import { DurableObject } from "cloudflare:workers";
import { migrate, type Migration } from "./migrate.ts";
import type { ChannelType } from "./notify.ts";
import { DIRECTORY_TABLES } from "./tables.ts";
import type { PlanId } from "./plans.ts";
import { planFor, type BillingUpdate } from "./billing.ts";

export type BillingRecord = {
  provider: string;
  customerId: string | null;
  subscriptionId: string | null;
  status: string;
  periodEnd: string | null;
  updatedAt: string;
  payerEmail: string | null;
};
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
  /** Self-serve: who made it (as personKey), so they alone can delete it themselves. */
  createdBy: string | null;
  suspended: boolean;
  stats: WorkspaceStats | null;
  statsAt: string | null;
  job: WorkspaceJob | null;
  jobError: { message: string; at: string } | null;
};

export type WorkspaceStats = { artifacts: number; members: number; bytes: number; lastActivity: string | null; plan?: PlanId; freeTeam?: boolean };
export type WorkspaceJob = { kind: string; phase?: string; error?: string; startedAt: string };

/** A saved passkey as the account page lists it (no key material). */
export type PasskeySummary = { id: string; name: string; createdAt: string; lastUsedAt: string | null };
/** What checking a passkey sign-in needs. */
export type StoredPasskey = { id: string; email: string; publicKey: string; counter: number; transports: string[] };

export type ChannelRow = { id: string; type: ChannelType; config: Record<string, unknown> };

/** Reports (or another allowReport scope) accepted an hour from everyone together. */
const REPORTS_PER_HOUR_MAX = 200;

export class DirectoryError extends Error {}

export type SupportCase = {
  n: number;
  artifactId: string;
  notesId: string | null;
  reporter: string;
  viaAgent: boolean;
  workspace: string | null;
  kind: string;
  title: string;
  status: string;
  errorGroup: string | null;
  duplicateOf: number | null;
  fix: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  reopened: number;
};
export type ErrorGroup = { fp: string; kind: string; place: string; message: string; count: number; firstAt: string; lastAt: string; versions: string[]; browsers: string[]; cases: number[] };
export type InboxItem = { id: number; at: string; kind: string; title: string; body: string | null; url: string | null; read: boolean };

function toCase(r: Record<string, SqlStorageValue>): SupportCase {
  return {
    n: r.n as number,
    artifactId: r.artifact_id as string,
    notesId: (r.notes_id as string | null) ?? null,
    reporter: r.reporter as string,
    viaAgent: Boolean(r.via_agent),
    workspace: (r.workspace as string | null) ?? null,
    kind: r.kind as string,
    title: r.title as string,
    status: r.status as string,
    errorGroup: (r.error_group as string | null) ?? null,
    duplicateOf: (r.duplicate_of as number | null) ?? null,
    fix: r.fix ? (JSON.parse(r.fix as string) as Record<string, unknown>) : null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    resolvedAt: (r.resolved_at as string | null) ?? null,
    reopened: r.reopened as number,
  };
}

// Typed view of the RPC stub (see HubApi in hub.ts for why).
type AsyncMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};
export type DirectoryApi = AsyncMethods<
  Pick<
    Directory,
    | "createWorkspace" | "createOwnWorkspace" | "canMakeWorkspace" | "selfServeFullToday" | "setCreator" | "allowReport" | "forgetPerson" | "recordOps" | "opsEvents" | "billingAll" | "allowCase" | "addCase" | "updateCase" | "supportCase" | "supportCaseByArtifact" | "supportCases" | "supportStats" | "addDraft" | "draft" | "approveDraft" | "attachCase" | "dropCase" | "recordErrorGroup" | "errorGroups" | "addInbox" | "addInboxMany" | "forgetInbox" | "inbox" | "unreadCount" | "markInboxRead" | "billing" | "applyBilling" | "billingPlan" | "endBilling" | "slugForSubscription" | "workspace" | "workspaces" | "setSuspended" | "removeWorkspace" | "recordStats" | "setMembership"
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
/** Workspaces the service itself uses; nobody can make them through self-serve. */
export const SYSTEM_SLUGS = new Set(["support"]);
/** Support cases one person may open a day, and everyone together. */
const CASES_PER_PERSON_DAY = 5;
const CASES_PER_DAY = 200;
/** Inbox items kept per person. */
const INBOX_KEEP = 200;
/** ...and none older than this. */
const INBOX_DAYS = 90;
const inboxSince = () => new Date(Date.now() - INBOX_DAYS * 86_400_000).toISOString();
/** Error groups kept. */
const ERROR_GROUPS_KEEP = 500;
/** Ops events kept for the operator console. */
const OPS_KEEP = 500;
/** Deleting one and making another is fine now and then, not on a loop. */
const SELF_SERVE_PER_PERSON_MONTH = 3;
const SELF_SERVE_PER_DAY = 100;

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
const FAILS_PER_EMAIL_CEILING = 100;
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
  // Each paying workspace's subscription, as the payment provider last told us,
  // and the provider events already applied (so a retried webhook does nothing).
  (sql) =>
    sql.exec(`
      CREATE TABLE billing (
        slug TEXT PRIMARY KEY, provider TEXT NOT NULL, customer_id TEXT, subscription_id TEXT, status TEXT NOT NULL,
        period_end TEXT, event_at INTEGER NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX billing_by_subscription ON billing (subscription_id);
      CREATE TABLE billing_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
    `),
  // Who pays: only they may open the payment provider's portal, which shows their card and everything they pay for.
  (sql) => sql.exec(`ALTER TABLE billing ADD COLUMN payer_email TEXT`),
  // Every self-serve workspace ever made, kept after it's deleted, so deleting and remaking can't get round the caps.
  (sql) =>
    sql.exec(`
      CREATE TABLE self_serve_log (person TEXT NOT NULL, slug TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX self_serve_by_person ON self_serve_log (person, at);
      CREATE INDEX self_serve_by_at ON self_serve_log (at);
      INSERT INTO self_serve_log (person, slug, at) SELECT created_by, slug, created_at FROM workspaces WHERE created_by IS NOT NULL;
    `),
  // Abuse reports, counted per network so the form can't be used to flood the operator.
  (sql) => sql.exec(`CREATE TABLE reports (ip TEXT NOT NULL, at INTEGER NOT NULL); CREATE INDEX reports_by_ip ON reports (ip, at);`),
  // What the operator should know about (failures, reports, signups), the latest few hundred, and when each
  // alert last emailed them.
  (sql) =>
    sql.exec(`
      CREATE TABLE ops_events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, slug TEXT, message TEXT NOT NULL, detail TEXT);
      CREATE INDEX ops_events_by_slug ON ops_events (slug, id);
      CREATE TABLE ops_alerts (key TEXT PRIMARY KEY, at INTEGER NOT NULL, repeats INTEGER NOT NULL DEFAULT 0);
    `),
  // Support: one row per case (its page lives in the support workspace), grouped product errors, each person's
  // inbox (the Notification Centre), and announcements already sent (so approving one twice sends it once).
  (sql) =>
    sql.exec(`
      CREATE TABLE support_cases (
        n INTEGER PRIMARY KEY AUTOINCREMENT, artifact_id TEXT NOT NULL, notes_id TEXT, reporter TEXT NOT NULL, via_agent INTEGER NOT NULL DEFAULT 0,
        workspace TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, error_group TEXT, duplicate_of INTEGER, fix TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT, reopened INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX support_by_reporter ON support_cases (reporter, n);
      CREATE INDEX support_by_status ON support_cases (status, n);
      CREATE TABLE error_groups (
        fp TEXT PRIMARY KEY, kind TEXT NOT NULL, place TEXT NOT NULL, message TEXT NOT NULL, count INTEGER NOT NULL,
        first_at TEXT NOT NULL, last_at TEXT NOT NULL, versions TEXT NOT NULL, browsers TEXT NOT NULL);
      CREATE INDEX error_groups_by_last ON error_groups (last_at);
      CREATE TABLE inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
        body TEXT, url TEXT, read_at TEXT, dedupe TEXT);
      CREATE INDEX inbox_by_email ON inbox (email, id);
      CREATE UNIQUE INDEX inbox_dedupe ON inbox (email, dedupe);
      CREATE TABLE support_drafts (
        id TEXT PRIMARY KEY, n INTEGER NOT NULL, message TEXT NOT NULL, cases TEXT NOT NULL, created_at TEXT NOT NULL,
        approved_by TEXT, approved_at TEXT, sent_at TEXT);
    `),
  // Inbox rows know their workspace and artifact, so deleting either removes them; indexes for pruning reports and
  // for counting cases per error group.
  (sql) =>
    sql.exec(`
      ALTER TABLE inbox ADD COLUMN slug TEXT;
      ALTER TABLE inbox ADD COLUMN artifact_id TEXT;
      CREATE INDEX inbox_by_artifact ON inbox (slug, artifact_id);
      CREATE INDEX reports_by_at ON reports (at);
      CREATE INDEX support_by_error_group ON support_cases (error_group);
    `),
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
  /** Whether this person may still make a workspace themselves: one at a time, and a few a month. */
  canMakeWorkspace(email: string): boolean {
    const person = personKey(email);
    const now = (this.sql.exec(`SELECT COUNT(*) AS n FROM workspaces WHERE created_by = ?`, person).one().n as number) < SELF_SERVE_PER_PERSON;
    const month = new Date(Date.now() - 30 * 86_400_000).toISOString();
    return now && (this.sql.exec(`SELECT COUNT(*) AS n FROM self_serve_log WHERE person = ? AND at > ?`, person, month).one().n as number) < SELF_SERVE_PER_PERSON_MONTH;
  }

  /** Everyone together has made as many self-serve workspaces as a day allows. */
  selfServeFullToday(): boolean {
    return (this.sql.exec(`SELECT COUNT(*) AS n FROM self_serve_log WHERE at > ?`, new Date(Date.now() - 86_400_000).toISOString()).one().n as number) >= SELF_SERVE_PER_DAY;
  }

  async createOwnWorkspace(email: string, slug: string, name: string, terms: string, contact = ""): Promise<WorkspaceRecord> {
    const person = personKey(email);
    if (SYSTEM_SLUGS.has(slug)) throw new DirectoryError(`"${slug}" is taken; pick another address`);
    if (this.selfServeFullToday()) throw new DirectoryError("We can't make more workspaces today. Try again tomorrow.");
    if (!this.canMakeWorkspace(email)) {
      throw new DirectoryError(`You already made a workspace. Add people to it from its settings${contact ? `, or email ${contact} for another` : ""}.`);
    }
    const made = await this.createWorkspace(slug, name, { createdBy: person, terms });
    this.sql.exec(`INSERT INTO self_serve_log (person, slug, at) VALUES (?, ?, ?)`, person, slug, made.createdAt);
    return made;
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

  // ---- billing -------------------------------------------------------------------

  /** A workspace's subscription, if it ever had one. */
  billing(slug: string): BillingRecord | null {
    const r = this.sql.exec(`SELECT * FROM billing WHERE slug = ?`, slug).toArray()[0];
    return r
      ? {
          provider: r.provider as string,
          customerId: (r.customer_id as string | null) ?? null,
          subscriptionId: (r.subscription_id as string | null) ?? null,
          status: r.status as string,
          periodEnd: (r.period_end as string | null) ?? null,
          updatedAt: r.updated_at as string,
          payerEmail: (r.payer_email as string | null) ?? null,
        }
      : null;
  }

  /**
   * Record a provider event and return the workspace with the plan its stored
   * subscription pays for, or null when it concerns no known workspace. The
   * plan always comes from the stored record, never the event alone, so a
   * repeated delivery re-applies it (healing a plan change that failed
   * before), and events arriving out of order or from an old, replaced
   * subscription can't leave the workspace on the wrong plan.
   */
  applyBilling(u: BillingUpdate, provider: string): { slug: string; plan: PlanId; until: string | null; replaced?: string } | null {
    const bySub = u.subscriptionId ? (this.sql.exec(`SELECT slug FROM billing WHERE subscription_id = ?`, u.subscriptionId).toArray()[0]?.slug as string | undefined) : undefined;
    // By name, only the workspace that started the checkout: not a later one at the same address.
    const named = u.workspace ? this.workspace(u.workspace) : null;
    const sameWorkspace = named && (!u.workspaceCreated || named.createdAt === u.workspaceCreated);
    const slug = bySub ?? (sameWorkspace ? u.workspace : null);
    if (!slug) return null;
    const row = this.sql.exec(`SELECT * FROM billing WHERE slug = ?`, slug).toArray()[0];
    let replaced: string | undefined;
    const seen = this.sql.exec(`SELECT 1 FROM billing_events WHERE id = ?`, u.eventId).toArray().length > 0;
    if (!seen) {
      this.sql.exec(`INSERT INTO billing_events (id, at) VALUES (?, ?)`, u.eventId, Date.now());
      this.sql.exec(`DELETE FROM billing_events WHERE at < ?`, Date.now() - 90 * 86_400_000);
      const other = row && row.subscription_id && u.subscriptionId && row.subscription_id !== u.subscriptionId;
      const newer = !row || (row.event_at as number) <= u.at;
      // A different subscription only takes over by actively paying; an old one's later events change nothing.
      const takesOver = !other || u.plan === "team";
      // A workspace with no subscription yet only gets one by paying (an operator-set plan isn't touched otherwise).
      const starts = row || u.plan === "team";
      if (newer && takesOver && starts) {
        if (other) replaced = String(row!.subscription_id);
        this.sql.exec(
          `INSERT INTO billing (slug, provider, customer_id, subscription_id, status, period_end, event_at, updated_at, payer_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (slug) DO UPDATE SET provider = excluded.provider, customer_id = COALESCE(excluded.customer_id, customer_id),
             payer_email = CASE WHEN excluded.customer_id IS NOT NULL AND excluded.customer_id IS NOT customer_id THEN excluded.payer_email
               ELSE COALESCE(excluded.payer_email, payer_email) END,
             subscription_id = COALESCE(excluded.subscription_id, subscription_id), status = excluded.status,
             period_end = COALESCE(excluded.period_end, period_end), event_at = excluded.event_at, updated_at = excluded.updated_at`,
          slug,
          provider,
          u.customerId,
          u.subscriptionId,
          u.status,
          // A failed or expired subscription with no period end on record would otherwise keep Team for good:
          // count its grace from now.
          u.periodEnd ?? (["past_due", "unpaid", "expired"].includes(u.status) && !row?.period_end ? new Date().toISOString() : null),
          u.at,
          new Date().toISOString(),
          u.payerEmail,
        );
        this.markDirty();
      }
    }
    const current = this.sql.exec(`SELECT status, period_end FROM billing WHERE slug = ?`, slug).toArray()[0];
    return current ? { slug, ...planFor(current.status as string, (current.period_end as string | null) ?? null), ...(replaced ? { replaced } : {}) } : null;
  }

  /**
   * End a workspace's paid time now (after a refund or a dispute): its record reads canceled with no time
   * left, so it's Free. Events from before this don't bring Team back; a later payment still does.
   */
  endBilling(slug: string): { plan: PlanId; until: string | null } | null {
    const row = this.sql.exec(`SELECT event_at FROM billing WHERE slug = ?`, slug).toArray()[0];
    if (!row) return null;
    const now = new Date().toISOString();
    this.sql.exec(
      `UPDATE billing SET status = 'canceled', period_end = ?, event_at = MAX(event_at, ?), updated_at = ? WHERE slug = ?`,
      now,
      Date.now(),
      now,
      slug,
    );
    this.markDirty();
    return this.billingPlan(slug);
  }

  slugForSubscription(subscriptionId: string): string | null {
    return (this.sql.exec(`SELECT slug FROM billing WHERE subscription_id = ?`, subscriptionId).toArray()[0]?.slug as string | undefined) ?? null;
  }

  /** The plan a workspace's stored subscription pays for, or null when it has none (the operator sets its plan). */
  billingPlan(slug: string): { plan: PlanId; until: string | null } | null {
    const row = this.sql.exec(`SELECT status, period_end FROM billing WHERE slug = ?`, slug).toArray()[0];
    return row ? planFor(row.status as string, (row.period_end as string | null) ?? null) : null;
  }

  async setSuspended(slug: string, suspended: boolean) {
    this.sql.exec(`UPDATE workspaces SET suspended = ? WHERE slug = ?`, suspended ? 1 : 0, slug);
    this.markDirty();
    await this.publish();
  }

  /** Hand a self-serve workspace to another of its admins: they can then delete it, and it counts as theirs. */
  setCreator(slug: string, email: string) {
    this.sql.exec(`UPDATE workspaces SET created_by = ? WHERE slug = ?`, personKey(email), slug);
    this.markDirty();
  }

  /**
   * Stores an ops event (keeping the latest OPS_KEEP), and says whether its alert should email the operator now.
   * An alerting kind is stored once an hour per key; repeats in between only count, so a flood (say, junk posted
   * to the webhook) can't push real events out. `keepAll` stores every one (reports).
   */
  recordOps(e: { kind: string; slug: string | null; message: string; detail: Record<string, unknown> | null; alertKey: string | null; keepAll?: boolean }): { alert: boolean } {
    let alert = false;
    if (e.alertKey) {
      const last = this.sql.exec(`SELECT at, repeats FROM ops_alerts WHERE key = ?`, e.alertKey).toArray()[0];
      if (last && Date.now() - (last.at as number) < 3_600_000) {
        this.sql.exec(`UPDATE ops_alerts SET repeats = repeats + 1 WHERE key = ?`, e.alertKey);
        if (!e.keepAll) return { alert: false };
      } else {
        const repeats = (last?.repeats as number | undefined) ?? 0;
        if (repeats) e = { ...e, detail: { ...e.detail, repeatsInLastHour: repeats } };
        this.sql.exec(`INSERT INTO ops_alerts (key, at, repeats) VALUES (?, ?, 0) ON CONFLICT (key) DO UPDATE SET at = excluded.at, repeats = 0`, e.alertKey, Date.now());
        alert = true;
      }
    }
    this.sql.exec(
      `INSERT INTO ops_events (at, kind, slug, message, detail) VALUES (?, ?, ?, ?, ?)`,
      new Date().toISOString(),
      e.kind,
      e.slug,
      e.message.slice(0, 2000),
      e.detail ? JSON.stringify(e.detail).slice(0, 4000) : null,
    );
    // Payments are kept apart (their own latest OPS_KEEP), so a flood of other events can't push them out.
    if (e.kind.startsWith("billing")) {
      this.sql.exec(`DELETE FROM ops_events WHERE kind LIKE 'billing%' AND id NOT IN (SELECT id FROM ops_events WHERE kind LIKE 'billing%' ORDER BY id DESC LIMIT ?)`, OPS_KEEP);
    } else {
      this.sql.exec(`DELETE FROM ops_events WHERE kind NOT LIKE 'billing%' AND id NOT IN (SELECT id FROM ops_events WHERE kind NOT LIKE 'billing%' ORDER BY id DESC LIMIT ?)`, OPS_KEEP);
    }
    return { alert };
  }

  // ---- support ---------------------------------------------------------------------

  /** Room for one more case from this person today (and from everyone). */
  allowCase(reporter: string): boolean {
    const day = new Date(Date.now() - 86_400_000).toISOString();
    const mine = this.sql.exec(`SELECT COUNT(*) AS n FROM support_cases WHERE reporter = ? AND created_at > ?`, reporter, day).one().n as number;
    const all = this.sql.exec(`SELECT COUNT(*) AS n FROM support_cases WHERE created_at > ?`, day).one().n as number;
    return mine < CASES_PER_PERSON_DAY && all < CASES_PER_DAY;
  }

  addCase(c: { artifactId: string; notesId: string | null; reporter: string; viaAgent: boolean; workspace: string | null; kind: string; title: string; errorGroup: string | null }): number {
    const now = new Date().toISOString();
    const n = this.sql
      .exec(
        `INSERT INTO support_cases (artifact_id, notes_id, reporter, via_agent, workspace, kind, title, status, error_group, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?) RETURNING n`,
        c.artifactId,
        c.notesId,
        c.reporter,
        c.viaAgent ? 1 : 0,
        c.workspace,
        c.kind,
        c.title,
        c.errorGroup,
        now,
        now,
      )
      .one().n as number;
    this.markDirty();
    return n;
  }

  /** Change a case's status or links; returns it as it is now. Moving back from resolved counts as reopened. */
  updateCase(n: number, patch: { status?: string; duplicateOf?: number | null; fix?: Record<string, unknown> | null; errorGroup?: string | null; title?: string; notesId?: string }): SupportCase | null {
    const before = this.supportCase(n);
    if (!before) return null;
    const now = new Date().toISOString();
    const closed = (s: string) => ["resolved", "wont_fix", "duplicate"].includes(s);
    const status = patch.status ?? before.status;
    this.sql.exec(
      `UPDATE support_cases SET status = ?, duplicate_of = ?, fix = ?, error_group = ?, title = ?, notes_id = ?, updated_at = ?,
         resolved_at = ?, reopened = reopened + ? WHERE n = ?`,
      status,
      patch.duplicateOf === undefined ? before.duplicateOf : patch.duplicateOf,
      patch.fix === undefined ? (before.fix ? JSON.stringify(before.fix) : null) : patch.fix ? JSON.stringify(patch.fix) : null,
      patch.errorGroup === undefined ? before.errorGroup : patch.errorGroup,
      patch.title ?? before.title,
      patch.notesId ?? before.notesId,
      now,
      closed(status) ? (before.resolvedAt ?? now) : null,
      closed(before.status) && !closed(status) ? 1 : 0,
      n,
    );
    this.markDirty();
    return this.supportCase(n);
  }

  supportCase(n: number): SupportCase | null {
    const r = this.sql.exec(`SELECT * FROM support_cases WHERE n = ?`, n).toArray()[0];
    return r ? toCase(r) : null;
  }

  supportCaseByArtifact(artifactId: string): SupportCase | null {
    const r = this.sql.exec(`SELECT * FROM support_cases WHERE artifact_id = ?`, artifactId).toArray()[0];
    return r ? toCase(r) : null;
  }

  /** Cases, newest first: one person's, or (operator) by status, error group or duplicates of a case. */
  supportCases(filter: { reporter?: string; status?: string; errorGroup?: string; duplicateOf?: number; limit?: number } = {}): SupportCase[] {
    const where: string[] = [];
    const args: SqlStorageValue[] = [];
    if (filter.reporter) (where.push("reporter = ?"), args.push(filter.reporter));
    if (filter.status) (where.push("status = ?"), args.push(filter.status));
    if (filter.errorGroup) (where.push("error_group = ?"), args.push(filter.errorGroup));
    if (filter.duplicateOf !== undefined) (where.push("duplicate_of = ?"), args.push(filter.duplicateOf));
    return this.sql
      .exec(`SELECT * FROM support_cases ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY n DESC LIMIT ?`, ...args, Math.min(filter.limit ?? 50, 200))
      .toArray()
      .map(toCase);
  }

  /** What the support loop has been doing: open work, what keeps coming up, how long fixes take, and what came back. */
  supportStats(days = 90) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = this.sql.exec(`SELECT * FROM support_cases WHERE created_at > ?`, since).toArray().map(toCase);
    const byStatus: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    for (const c of rows) {
      byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
      byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
    }
    const hours = rows
      .filter((c) => c.resolvedAt && c.status === "resolved")
      .map((c) => (Date.parse(c.resolvedAt!) - Date.parse(c.createdAt)) / 3_600_000)
      .sort((a, b) => a - b);
    const mid = Math.floor(hours.length / 2);
    const median = hours.length ? Math.round((hours.length % 2 ? hours[mid] : (hours[mid - 1] + hours[mid]) / 2) * 10) / 10 : null;
    const duplicates = new Map<number, number>();
    for (const c of rows) if (c.duplicateOf) duplicates.set(c.duplicateOf, (duplicates.get(c.duplicateOf) ?? 0) + 1);
    const mostDuplicated = [...duplicates.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([n, count]) => ({ case: n, title: this.supportCase(n)?.title ?? "", kind: this.supportCase(n)?.kind ?? "", duplicates: count }));
    return {
      days,
      cases: rows.length,
      byStatus,
      byKind,
      medianHoursToResolve: median,
      reopened: rows.filter((c) => c.reopened > 0).map((c) => ({ case: c.n, title: c.title, reopened: c.reopened })),
      mostDuplicated,
      topErrors: this.errorGroups({ limit: 10 }),
    };
  }

  /** An announcement waiting for the operator's approval: the message, and every case it goes to. */
  addDraft(d: { id: string; n: number; message: string; cases: number[] }) {
    this.sql.exec(`INSERT INTO support_drafts (id, n, message, cases, created_at) VALUES (?, ?, ?, ?, ?)`, d.id, d.n, d.message, JSON.stringify(d.cases), new Date().toISOString());
  }

  draft(id: string): { id: string; n: number; message: string; cases: number[]; approvedBy: string | null; sentAt: string | null } | null {
    const r = this.sql.exec(`SELECT * FROM support_drafts WHERE id = ?`, id).toArray()[0];
    return r
      ? { id, n: r.n as number, message: r.message as string, cases: JSON.parse(r.cases as string) as number[], approvedBy: (r.approved_by as string | null) ?? null, sentAt: (r.sent_at as string | null) ?? null }
      : null;
  }

  /** Approve a draft and claim its sending: true only the first time, so approving twice sends once. */
  approveDraft(id: string, by: string): boolean {
    const now = new Date().toISOString();
    // A draft left a fortnight is stale: draft it again.
    const fresh = new Date(Date.now() - 14 * 86_400_000).toISOString();
    return this.sql.exec(`UPDATE support_drafts SET approved_by = ?, approved_at = ?, sent_at = ? WHERE id = ? AND sent_at IS NULL AND created_at > ?`, by, now, now, id, fresh).rowsWritten > 0;
  }

  /** Point a case at its pages, once they exist. */
  attachCase(n: number, artifactId: string, notesId: string | null) {
    this.sql.exec(`UPDATE support_cases SET artifact_id = ?, notes_id = ? WHERE n = ?`, artifactId, notesId, n);
    this.markDirty();
  }

  /** A case whose pages couldn't be made: forget it, so it doesn't count or show. */
  dropCase(n: number) {
    this.sql.exec(`DELETE FROM support_cases WHERE n = ?`, n);
  }

  // ---- error groups ------------------------------------------------------------------

  /** One more occurrence of a product error: counted under its fingerprint, with the versions and browsers it's seen on. */
  recordErrorGroup(e: { fp: string; kind: string; place: string; message: string; version: string; browser: string }): { fp: string; count: number; first: boolean } {
    const now = new Date().toISOString();
    const row = this.sql.exec(`SELECT count, versions, browsers FROM error_groups WHERE fp = ?`, e.fp).toArray()[0];
    const add = (json: string | undefined, v: string) => {
      const list = json ? (JSON.parse(json) as string[]) : [];
      return JSON.stringify(list.includes(v) ? list : [...list, v].slice(-10));
    };
    if (row) {
      this.sql.exec(
        `UPDATE error_groups SET count = count + 1, last_at = ?, versions = ?, browsers = ? WHERE fp = ?`,
        now,
        add(row.versions as string, e.version),
        add(row.browsers as string, e.browser),
        e.fp,
      );
      return { fp: e.fp, count: (row.count as number) + 1, first: false };
    }
    this.sql.exec(
      `INSERT INTO error_groups (fp, kind, place, message, count, first_at, last_at, versions, browsers) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      e.fp,
      e.kind,
      e.place.slice(0, 200),
      e.message.slice(0, 500),
      now,
      now,
      JSON.stringify([e.version]),
      JSON.stringify([e.browser]),
    );
    this.sql.exec(`DELETE FROM error_groups WHERE fp IN (SELECT fp FROM error_groups ORDER BY last_at DESC LIMIT -1 OFFSET ?)`, ERROR_GROUPS_KEEP);
    return { fp: e.fp, count: 1, first: true };
  }

  errorGroups(filter: { fp?: string; limit?: number; since?: string } = {}): ErrorGroup[] {
    const rows = filter.fp
      ? this.sql.exec(`SELECT * FROM error_groups WHERE fp = ?`, filter.fp).toArray()
      : this.sql.exec(`SELECT * FROM error_groups WHERE last_at > ? ORDER BY count DESC, last_at DESC LIMIT ?`, filter.since ?? "", Math.min(filter.limit ?? 50, 200)).toArray();
    return rows.map((r) => ({
      fp: r.fp as string,
      kind: r.kind as string,
      place: r.place as string,
      message: r.message as string,
      count: r.count as number,
      firstAt: r.first_at as string,
      lastAt: r.last_at as string,
      versions: JSON.parse(r.versions as string) as string[],
      browsers: JSON.parse(r.browsers as string) as string[],
      cases: this.sql.exec(`SELECT n FROM support_cases WHERE error_group = ?`, r.fp).toArray().map((c) => c.n as number),
    }));
  }

  // ---- inbox (the Notification Centre) ----------------------------------------------

  /** Something that needs this person: kept (the latest INBOX_KEEP) until they've seen it; `dedupe` makes it once only. */
  addInbox(email: string, item: { kind: string; title: string; body?: string; url?: string; dedupe?: string; slug?: string; artifact?: string }): boolean {
    const added = this.sql
      .exec(
        `INSERT INTO inbox (email, at, kind, title, body, url, dedupe, slug, artifact_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (email, dedupe) DO NOTHING RETURNING id`,
        email,
        new Date().toISOString(),
        item.kind,
        item.title.slice(0, 200),
        item.body ? item.body.slice(0, 500) : null,
        item.url ?? null,
        item.dedupe ?? null,
        item.slug ?? null,
        item.artifact ?? null,
      )
      .toArray().length > 0;
    // This person's latest INBOX_KEEP (ids are shared by everyone, so count theirs).
    if (added) {
      this.sql.exec(`DELETE FROM inbox WHERE email = ? AND id <= (SELECT id FROM inbox WHERE email = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`, email, email, INBOX_KEEP);
      this.sql.exec(`DELETE FROM inbox WHERE email = ? AND at < ?`, email, inboxSince());
    }
    return added;
  }

  /** Several at once (a workspace's notification run). */
  addInboxMany(items: { email: string; kind: string; title: string; body?: string; url?: string; dedupe?: string; slug?: string; artifact?: string }[]) {
    for (const { email, ...item } of items.slice(0, 500)) this.addInbox(email, item);
  }

  /**
   * Notifications leave inboxes when what they quote is gone or out of reach: an artifact's (deleted), or one
   * person's for an artifact or a whole workspace (unshared, removed). Rows from before inbox entries named
   * their workspace and artifact match by address.
   */
  forgetInbox(f: { slug: string; artifactId?: string; email?: string }) {
    const host = `https://${f.slug}.%`;
    const by = f.email ? `email = ? AND ` : "";
    const who: SqlStorageValue[] = f.email ? [f.email] : [];
    if (f.artifactId) this.sql.exec(`DELETE FROM inbox WHERE ${by}slug = ? AND artifact_id = ?`, ...who, f.slug, f.artifactId);
    else this.sql.exec(`DELETE FROM inbox WHERE ${by}slug = ?`, ...who, f.slug);
    // Older rows (no workspace on them) by address, while any are left: that one's a scan.
    if (this.sql.exec(`SELECT 1 FROM inbox WHERE slug IS NULL LIMIT 1`).toArray().length) {
      if (f.artifactId) this.sql.exec(`DELETE FROM inbox WHERE ${by}slug IS NULL AND url LIKE ? || '/a/' || ? || '%'`, ...who, host, f.artifactId);
      else this.sql.exec(`DELETE FROM inbox WHERE ${by}slug IS NULL AND url LIKE ?`, ...who, host);
    }
  }

  inbox(email: string, limit = 50): { items: InboxItem[]; unread: number } {
    const items = this.sql
      .exec(`SELECT * FROM inbox WHERE email = ? AND at >= ? ORDER BY id DESC LIMIT ?`, email, inboxSince(), Math.min(limit, INBOX_KEEP))
      .toArray()
      .map((r) => ({
        id: r.id as number,
        at: r.at as string,
        kind: r.kind as string,
        title: r.title as string,
        body: (r.body as string | null) ?? null,
        url: (r.url as string | null) ?? null,
        read: r.read_at !== null,
      }));
    return { items, unread: this.unreadCount(email) };
  }

  unreadCount(email: string): number {
    return this.sql.exec(`SELECT COUNT(*) AS n FROM inbox WHERE email = ? AND read_at IS NULL AND at >= ?`, email, inboxSince()).one().n as number;
  }

  /** Mark items (or, without ids, everything) read. */
  markInboxRead(email: string, ids?: number[]): number {
    const now = new Date().toISOString();
    if (!ids) return this.sql.exec(`UPDATE inbox SET read_at = ? WHERE email = ? AND read_at IS NULL`, now, email).rowsWritten;
    let n = 0;
    for (const id of ids.slice(0, 200)) n += this.sql.exec(`UPDATE inbox SET read_at = ? WHERE email = ? AND id = ? AND read_at IS NULL`, now, email, id).rowsWritten;
    return n;
  }

  /** Every workspace's subscription, for the operator console in one call. */
  billingAll(): Record<string, { status: string; periodEnd: string | null; payerEmail: string | null; subscriptionId: string | null }> {
    const out: Record<string, { status: string; periodEnd: string | null; payerEmail: string | null; subscriptionId: string | null }> = {};
    for (const r of this.sql.exec(`SELECT slug, status, period_end, payer_email, subscription_id FROM billing`)) {
      out[r.slug as string] = {
        status: r.status as string,
        periodEnd: (r.period_end as string | null) ?? null,
        payerEmail: (r.payer_email as string | null) ?? null,
        subscriptionId: (r.subscription_id as string | null) ?? null,
      };
    }
    return out;
  }

  /** The latest ops events, newest first, optionally of one kind or workspace. */
  opsEvents(filter: { kind?: string; slug?: string; limit?: number } = {}): { id: number; at: string; kind: string; slug: string | null; message: string; detail: Record<string, unknown> | null }[] {
    const where: string[] = [];
    const args: SqlStorageValue[] = [];
    if (filter.kind) (where.push("kind = ?"), args.push(filter.kind));
    if (filter.slug) (where.push("slug = ?"), args.push(filter.slug));
    return this.sql
      .exec(`SELECT * FROM ops_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`, ...args, Math.min(filter.limit ?? 100, OPS_KEEP))
      .toArray()
      .map((r) => ({
        id: r.id as number,
        at: r.at as string,
        kind: r.kind as string,
        slug: (r.slug as string | null) ?? null,
        message: r.message as string,
        detail: r.detail ? (JSON.parse(r.detail as string) as Record<string, unknown>) : null,
      }));
  }

  /** Room for one more abuse report from this network: a few an hour, and a cap for everyone. */
  allowReport(ip: string, scope = "report"): boolean {
    // An IPv6 network hands out a /64, so count the network, not the address.
    const network = `${scope}|${ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip}`;
    this.sql.exec(`DELETE FROM reports WHERE at < ?`, Date.now() - 3_600_000);
    if ((this.sql.exec(`SELECT COUNT(*) AS n FROM reports WHERE ip = ?`, network).one().n as number) >= 5) return false;
    // However many networks send them, at most this many an hour (each can email the operator).
    if ((this.sql.exec(`SELECT COUNT(*) AS n FROM reports WHERE substr(ip, 1, ?) = ?`, scope.length + 1, `${scope}|`).one().n as number) >= REPORTS_PER_HOUR_MAX) return false;
    this.sql.exec(`INSERT INTO reports (ip, at) VALUES (?, ?)`, network, Date.now());
    return true;
  }

  /**
   * Deleting an account: everything the directory holds about this person (name, channels, passkeys, codes,
   * visits). Their workspace memberships go first, through each workspace, which updates memberships here.
   */
  forgetPerson(email: string) {
    this.ctx.storage.transactionSync(() => {
      for (const table of ["users", "channels", "login_codes", "login_sends", "login_fails", "visits", "channel_tests", "passkeys", "memberships", "inbox"]) {
        this.sql.exec(`DELETE FROM ${table} WHERE email = ?`, email);
      }
    });
    this.markDirty();
  }

  async removeWorkspace(slug: string) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM memberships WHERE slug = ?`, slug);
      this.sql.exec(`DELETE FROM visits WHERE slug = ?`, slug);
      // A workspace made later with the same address must not inherit this one's subscription.
      this.sql.exec(`DELETE FROM billing WHERE slug = ?`, slug);
      this.sql.exec(`DELETE FROM workspaces WHERE slug = ?`, slug);
      // Its notifications (they quote its comments), including ones from before inbox rows named their workspace.
      this.sql.exec(`DELETE FROM inbox WHERE slug = ? OR (slug IS NULL AND url LIKE 'https://' || ? || '.%')`, slug, slug);
      this.sql.exec(`UPDATE support_cases SET workspace = NULL WHERE workspace = ?`, slug);
      // The operator's log about it, except payments (kept as the record of what was charged).
      this.sql.exec(`DELETE FROM ops_events WHERE slug = ? AND kind NOT LIKE 'billing%'`, slug);
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
    if (role === null) {
      this.sql.exec(`DELETE FROM memberships WHERE email = ? AND slug = ?`, email, slug);
      // What they were told about it goes with their access (they can sign back in as a guest to what's shared).
      this.forgetInbox({ slug, email });
    }
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
    // Only the tables the run has: one from before support and the inbox were backed up leaves those as they are.
    const tables = cursor.tables ?? DIRECTORY_TABLES;
    createShadows(this.ctx.storage, tables);
    try {
      for (const p of pages) loadShadow(this.ctx.storage, tables, p.table, p.rows);
    } catch (err) {
      dropShadows(this.ctx.storage, tables);
      throw err;
    }
    swapShadows(this.ctx.storage, tables);
    return this.importDone();
  }

  async alarm() {
    // Daily, with the backup: notifications past their 90 days go for everyone, not only people still getting new ones.
    this.sql.exec(`DELETE FROM inbox WHERE at < ?`, inboxSince());
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
    // Guessing from ever-new networks: past a ceiling for the address, its live codes are void, so the owner
    // asks for a new one (passkeys still work) and the guesses so far are wasted.
    if (fails("1") >= FAILS_PER_EMAIL_CEILING) {
      this.sql.exec(`DELETE FROM login_codes WHERE email = ?`, email);
      return false;
    }
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
    createdBy: (r.created_by as string | null) ?? null,
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

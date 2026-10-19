// Workspace: one Durable Object, and one SQLite database, per workspace. It
// stores the workspace's members and agent tokens, every artifact with its file
// history, sharing, shared state, comments and live sync sockets, and keeps its
// own alarm for render checks, notifications, live data refreshes and backups.
import { DurableObject } from "cloudflare:workers";
import { BUILD_STAMP, buildArtifact, type Build, type CompileError } from "./compile.ts";
import { isDefaultView, renderCheck, type CheckEnv, type CheckOutcome, type CheckView, type RenderCheck } from "./check.ts";
import { domainOf, isValidPrincipal, sharePrincipal, WORKSPACE_PRINCIPAL } from "./principal.ts";
import { applyJsonPatch, applyTextEdits, EditError, grepFiles, type JsonPatchOp, type TextEdit } from "./edit.ts";
import { diffBlocks, type BlockInfo } from "./blocks.ts";
import { composeMessage, mentionedEmails, type OutboxItem } from "./notifications.ts";
import { isBlockedHost, sendToChannel, type NotifyEnv } from "./notify.ts";
import { DEFAULT_PLAN, PLANS, isPlan, type PlanId } from "./plans.ts";
import { TEAM_PRICE } from "./billing.ts";
import { cleanQuery, listing, queryWords, type InContent } from "./listing.ts";
import { ops, type OpsEvent } from "./ops.ts";
import {
  EVENT_ERRORS,
  EventsFailure,
  canonicalArgs,
  cursorOf,
  errorOf,
  failureOf,
  matches,
  parseArgs,
  secretBytes,
  seqOf,
  signWebhook,
  subscriptionId,
  toOccurrence,
  type DeliveryError,
  type EventArgs,
  type EventName,
  type LoggedEvent,
  type Occurrence,
} from "./events.ts";
import { migrate, type Migration } from "./migrate.ts";
import { randomId, type DirectoryApi, type WorkspaceRole, type WorkspaceStats } from "./directory.ts";
import { b64url, timingSafeEqual } from "./session.ts";
import { DATA_TABLES } from "./tables.ts";
import {
  backupRuns,
  createShadows,
  deletePrefix,
  dropShadows,
  exportPage,
  fromB64,
  hasShadows,
  loadShadow,
  newRun,
  nextBackupAt,
  pruneBackups,
  shadowRows,
  startBackup,
  startRestore,
  stepBackup,
  stepRestore,
  swapShadows,
  toB64,
  type BackupCursor,
  type Page,
  type RestoreCursor,
} from "./snapshot.ts";
import {
  SHARED_STATE_MAX_BYTES,
  SHARED_VALUE_MAX_BYTES,
  type Anchor,
  type JsonValue,
  type Person,
  type Role,
  type SinceLastVisit,
  type SyncClientMessage,
  type SyncServerMessage,
  type Thread,
  type ThreadComment,
  type WatchLevel,
} from "../shared/protocol.ts";

export type ArtifactMeta = {
  id: string;
  title: string;
  description: string;
  /** Email of the person whose agent created it. */
  owner: string;
  version: number;
  /** Anyone with the link can view. False once a link with an expiry has expired. */
  public: boolean;
  /** When the public link stops working; null when it doesn't expire (or isn't on). */
  publicUntil: string | null;
  /** Owner opted in to rich link previews (title, description, screenshot). */
  preview: boolean;
  /** When the owner archived it: hidden from lists, still readable at its link. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** "agent" for MCP writes, an email for people. */
export type Actor = string;

/** `email` is a full address, "@domain" for everyone at that domain, or "workspace" for every member. */
export type ShareEntry = { email: string; role: Exclude<Role, "owner"> };

export type Member = { email: string; role: WorkspaceRole; addedAt: string; addedBy: string | null; lastSeenAt: string | null };

export type Access = {
  slug: string;
  name: string;
  member: WorkspaceRole | null;
  offline: boolean;
  /** When this workspace was made: a grant names it, so one from a deleted workspace of the same name doesn't carry over. */
  createdAt?: string | null;
};

export type AgentToken = { id: string; email: string; label: string; createdAt: string; lastUsedAt: string | null };

export type WriteResult =
  | { ok: true; id: string; version: number; files: string[]; warnings?: string[] }
  | { ok: false; errors: CompileError[]; version?: number };

export class HubError extends Error {}

type JobBase = { startedAt: string; gen: number; phase?: string; error?: string; retryAt?: string; tries?: number };
type BackupJob = JobBase & { kind: "backup"; cursor: BackupCursor };
type RestoreJob = JobBase & { kind: "restore"; run: string; cursor: RestoreCursor | null };
type ImportJob = JobBase & { kind: "import" };
export type Job = BackupJob | RestoreJob | ImportJob;
type QueuedJob = { kind: "backup" } | { kind: "restore"; run: string };

export type HubEnv = CheckEnv &
  NotifyEnv & {
    DIRECTORY: DurableObjectNamespace;
    /** The operator's addresses, for ops alerts. */
    OPERATOR_EMAILS?: string;
    /** Nightly backups; optional so tests and local runs work without R2. */
    BACKUPS?: R2Bucket;
  };

// Typed view of the RPC stub. DurableObjectStub<Workspace> is too deep for the
// type checker, so callers use this instead.
type AsyncMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};
export type HubApi = AsyncMethods<
  Pick<
    Workspace,
    | "provision" | "access" | "info" | "rename" | "stats" | "destroy" | "members" | "setMember" | "createToken" | "tokens"
    | "revokeToken" | "verifyAgentToken" | "signedIn" | "closeSockets" | "allowMail" | "indexData" | "listPage" | "exists" | "forgetPerson" | "spendToken" | "openArtifact" | "recordGrant" | "grants" | "forgetGrants" | "list" | "meta" | "roleFor" | "files" | "grep" | "build" | "history" | "create"
    | "editText" | "writeFiles" | "patchData" | "revert" | "updateMeta" | "share" | "delete" | "state" | "setState"
    | "recordError" | "errors" | "runRenderCheck" | "putAsset" | "deleteAsset" | "assets" | "asset" | "allowedHosts"
    | "setHostAllowed" | "sources" | "setSource" | "removeSource" | "refreshSources" | "shareSummaries" | "exportPage"
    | "importBegin" | "importRows" | "importEnd" | "backup" | "backups" | "restore" | "job" | "lastJobError" | "cancelJob" | "threads" | "addComment"
    | "resolveThread" | "deleteComment" | "activity" | "visit" | "readers" | "previewInfo" | "previewImage" | "watches" | "setWatch"
    | "joinDomains" | "setJoinDomains" | "setJoinDomain" | "autoJoin" | "eventsPoll" | "eventsSubscribe" | "eventsUnsubscribe" | "plan" | "setPlan" | "requestBackup" | "setPin" | "dismissSince" | "watchDefault" | "setWatchDefault" | "visibleCount"
  >
> & { fetch(request: Request): Promise<Response> };

type SocketTag = { id: string; email: string | null; role: Role; origin?: string; exp?: number };

const HISTORY_KEEP = 50;
/** Invitation and share emails a Free workspace may send on its first day. */
const NEW_FREE_INVITES = 10;
const ASSETS_MAX_BYTES = 20 * 1024 * 1024;
const SOURCE_MAX_BYTES = 1024 * 1024;
const SOURCES_PER_RUN = 20;
const EVENTS_KEEP = 5000;
const COMMENT_MAX_CHARS = 5000;
const ANCHOR_MAX_BYTES = 2048;
// Notifications wait briefly so a burst of comments becomes one message, and
// longer for page updates, which agents tend to make in runs.
const COMMENT_DELAY_MS = 45_000;
const UPDATE_DELAY_MS = 10 * 60_000;
const UPDATE_MAX_WAIT_MS = 30 * 60_000;
// Keep each alarm run well inside the Workers Paid subrequest limit.
const SENDS_PER_ALARM = 200;
// Browser Run quick actions are rate-limited per account; space checks a little
// and fall back to the alarm queue when Browser Run answers 429.
const CHECK_SPACING_MS = 1_000;
/** Comments aren't counted in storage, so each artifact holds at most this many. */
const COMMENTS_PER_ARTIFACT_MAX = 5000;
const CHECKS_USED_UP = "this workspace has used today's render checks; they come back tomorrow (the page itself is saved)";
const CHECK_INLINE_WAIT_MS = 8_000;
const ERRORS_KEEP = 30;
const BACKUPS_KEEP = 30;
/** Free workspaces keep a week of runs: storage for backups is the one cost that grows with free use. */
const BACKUPS_KEEP_FREE = 7;
/** How long one alarm spends on a backup or restore before yielding. */
const JOB_STEP_MS = 10_000;
const TOKEN_TOUCH_MS = 3600_000;
/** Invitations and "shared with you" emails a workspace may send per day. */
const MAIL_PER_DAY = 1000;
/** Share emails one person may send a day. */
const SHARE_MAIL_PER_PERSON = 50;

/** Tables keyed by artifact, cleared when an artifact is deleted. */
const ARTIFACT_TABLES = [
  "blobs", "files", "history", "builds", "shares", "state", "errors", "checks", "assets", "sources", "events", "threads",
  "comments", "watches", "seen", "outbox", "pins",
];

const MIGRATIONS: Migration[] = [
  (sql) =>
    sql.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE members (
        email TEXT PRIMARY KEY, role TEXT NOT NULL, added_at TEXT NOT NULL, added_by TEXT);
      CREATE TABLE tokens (
        id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, email TEXT NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL,
        last_used_at TEXT);
      CREATE TABLE allowed_hosts (host TEXT PRIMARY KEY);
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL,
        version INTEGER NOT NULL, public INTEGER NOT NULL DEFAULT 0, preview INTEGER NOT NULL DEFAULT 0, archived_at TEXT,
        state_seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX artifacts_by_owner ON artifacts (owner);
      -- File contents, stored once per artifact however many versions share them.
      CREATE TABLE blobs (artifact_id TEXT NOT NULL, hash TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (artifact_id, hash));
      CREATE TABLE files (artifact_id TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (artifact_id, path));
      -- files: JSON {path: hash}.
      CREATE TABLE history (
        artifact_id TEXT NOT NULL, version INTEGER NOT NULL, files TEXT NOT NULL, note TEXT NOT NULL, blocks TEXT,
        created_at TEXT NOT NULL, PRIMARY KEY (artifact_id, version));
      CREATE TABLE builds (artifact_id TEXT PRIMARY KEY, version INTEGER NOT NULL, build TEXT NOT NULL);
      CREATE TABLE shares (
        artifact_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (artifact_id, email));
      CREATE INDEX shares_by_email ON shares (email);
      CREATE TABLE state (
        artifact_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, seq INTEGER NOT NULL, by TEXT,
        PRIMARY KEY (artifact_id, key));
      CREATE TABLE errors (
        artifact_id TEXT NOT NULL, at TEXT NOT NULL, version INTEGER NOT NULL, viewer TEXT, message TEXT NOT NULL, stack TEXT);
      CREATE TABLE checks (
        artifact_id TEXT PRIMARY KEY, version INTEGER NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL, result TEXT,
        screenshot BLOB, at INTEGER NOT NULL);
      CREATE TABLE assets (
        artifact_id TEXT NOT NULL, path TEXT NOT NULL, content_type TEXT NOT NULL, data BLOB NOT NULL, bytes INTEGER NOT NULL,
        updated_at TEXT NOT NULL, PRIMARY KEY (artifact_id, path));
      CREATE TABLE sources (
        artifact_id TEXT NOT NULL, path TEXT NOT NULL, url TEXT NOT NULL, every_minutes INTEGER NOT NULL, pick TEXT,
        last_fetch TEXT, last_status TEXT, last_error TEXT, PRIMARY KEY (artifact_id, path));
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, artifact_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT, type TEXT NOT NULL,
        data TEXT NOT NULL);
      CREATE INDEX events_by_artifact ON events (artifact_id, seq);
      CREATE TABLE threads (
        id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, anchor TEXT, version INTEGER NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL,
        resolved_by TEXT, resolved_at TEXT, addressed_in INTEGER);
      CREATE INDEX threads_by_artifact ON threads (artifact_id);
      CREATE TABLE comments (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, artifact_id TEXT NOT NULL, by TEXT NOT NULL, text TEXT NOT NULL,
        at TEXT NOT NULL, seq INTEGER NOT NULL);
      CREATE INDEX comments_by_artifact ON comments (artifact_id, seq);
      CREATE TABLE watches (
        email TEXT NOT NULL, artifact_id TEXT NOT NULL, level TEXT NOT NULL, PRIMARY KEY (email, artifact_id));
      CREATE TABLE seen (
        email TEXT NOT NULL, artifact_id TEXT NOT NULL, version INTEGER NOT NULL, read_seq INTEGER NOT NULL DEFAULT 0,
        at TEXT NOT NULL, since_version INTEGER, since_at TEXT, PRIMARY KEY (email, artifact_id));
      CREATE TABLE outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, artifact_id TEXT NOT NULL, kind TEXT NOT NULL,
        data TEXT NOT NULL, due_at INTEGER NOT NULL);
    `),
  // OAuth grants, mirrored here so settings can list and revoke them at once
  // (the OAuth library's own list reads KV, which lags by up to a minute).
  (sql) => sql.exec(`CREATE TABLE grants (id TEXT PRIMARY KEY, email TEXT NOT NULL, client TEXT NOT NULL, created_at TEXT NOT NULL)`),
  // Indexes for the queries notifications, deletes and threads run, and when each member last signed in.
  (sql) =>
    sql.exec(`
      CREATE INDEX watches_by_artifact ON watches (artifact_id, level);
      CREATE INDEX outbox_by_due ON outbox (due_at);
      CREATE INDEX outbox_by_person ON outbox (email, artifact_id, kind);
      CREATE INDEX outbox_by_artifact ON outbox (artifact_id);
      CREATE INDEX errors_by_artifact ON errors (artifact_id, at);
      CREATE INDEX comments_by_thread ON comments (thread_id, seq);
      CREATE INDEX seen_by_artifact ON seen (artifact_id);
      ALTER TABLE members ADD COLUMN last_seen_at TEXT;
    `),
  // Public links that expire (NULL: existing links keep working as before), and
  // email domains whose people join as members on their own.
  (sql) =>
    sql.exec(`
      ALTER TABLE artifacts ADD COLUMN public_until TEXT;
      CREATE TABLE join_domains (domain TEXT PRIMARY KEY, added_by TEXT, added_at TEXT NOT NULL);
      -- People an admin removed: a join domain doesn't bring them back.
      CREATE TABLE removed_members (email TEXT PRIMARY KEY, removed_by TEXT, removed_at TEXT NOT NULL);
    `),
  // MCP events: webhook subscriptions (soft state with a TTL of at most a day,
  // not backed up) and callback URLs each person has proven they control.
  (sql) =>
    sql.exec(`
      CREATE TABLE event_subs (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, url TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL,
        secret TEXT NOT NULL, old_secret TEXT, old_secret_until INTEGER, cursor_seq INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, next_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, suspended INTEGER NOT NULL DEFAULT 0, last_delivery_at TEXT,
        last_error TEXT, failed_since TEXT, created_at TEXT NOT NULL);
      CREATE INDEX event_subs_by_next ON event_subs (next_at);
      CREATE INDEX event_subs_by_principal ON event_subs (principal);
      CREATE TABLE event_receivers (principal TEXT NOT NULL, url TEXT NOT NULL, verified_until INTEGER NOT NULL, PRIMARY KEY (principal, url));
      CREATE TABLE event_verifications (principal TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX event_verifications_by_principal ON event_verifications (principal, at);
      -- events/poll and subscribe with maxAgeMs find where to start by time.
      CREATE INDEX events_by_at ON events (at);
    `),
  // Artifacts a person pinned to the top of their own list.
  (sql) => sql.exec(`CREATE TABLE pins (email TEXT NOT NULL, artifact_id TEXT NOT NULL, pinned_at TEXT NOT NULL, PRIMARY KEY (email, artifact_id))`),
  // Each person's default notification level for this workspace, under any per-artifact choice.
  (sql) => sql.exec(`CREATE TABLE watch_defaults (email TEXT PRIMARY KEY, level TEXT NOT NULL)`),
  // Which artifacts link to which (from their current files), for "Linked from" and link titles. Derived, so
  // it isn't backed up: a restore rebuilds it.
  // Existing artifacts' links are filled in by the alarm, a batch at a time (links_backfill is the next id).
  (sql) =>
    sql.exec(`
      CREATE TABLE links (artifact_id TEXT NOT NULL, to_id TEXT NOT NULL, PRIMARY KEY (artifact_id, to_id));
      CREATE INDEX links_to ON links (to_id);
      INSERT INTO settings (key, value) SELECT 'links_backfill', '' WHERE EXISTS (SELECT 1 FROM artifacts)
        ON CONFLICT (key) DO UPDATE SET value = '';
    `),
  // Tokens that work once (a render check's frame), remembered until they'd have expired anyway.
  (sql) => sql.exec(`CREATE TABLE used_tokens (id TEXT PRIMARY KEY, until INTEGER NOT NULL)`),
];

/** Links to other artifacts in this workspace, from file contents: /a/<id> (absolute or relative). */
const LINK_RE = /\/a\/(a[a-z0-9]{12})(?![a-z0-9])/g;
/** Artifacts whose links one alarm step reads while backfilling. */
const LINKS_BATCH = 100;

/** The artifacts a page's own files link to: its markdown and code, not its data (which can be large and changes on every refresh). */
function linkTargets(files: Record<string, string>, self: string): Set<string> {
  const out = new Set<string>();
  for (const [path, text] of Object.entries(files)) {
    if (path.startsWith("data/")) continue;
    for (const m of text.matchAll(LINK_RE)) if (m[1] !== self) out.add(m[1]);
  }
  return out;
}

/** Replace one artifact's links. Targets that don't exist (yet, or any more) drop out when links are read. */
function setLinks(sql: SqlStorage, id: string, files: Record<string, string>) {
  sql.exec(`DELETE FROM links WHERE artifact_id = ?`, id);
  for (const to of linkTargets(files, id)) sql.exec(`INSERT OR IGNORE INTO links (artifact_id, to_id) VALUES (?, ?)`, id, to);
}

/** MCP event webhooks: how soon after activity they go out, how long a subscription lasts, how hard to retry. */
const EVENT_DELAY_MS = 2_000;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const EVENT_TTL_DEFAULT_MS = HOUR_MS;
const EVENT_TTL_MIN_MS = 60_000;
const EVENT_TTL_MAX_MS = DAY_MS;
const EVENT_SUBS_PER_PERSON = 20;
/** Verification challenges one person may send an hour: each is a POST to a URL they chose. */
const EVENT_VERIFICATIONS_PER_HOUR = 10;
const EVENT_RETRY_MS = [10_000, 60_000, 5 * 60_000, 10 * 60_000];
/** A subscription whose endpoint has failed this long stops until the client refreshes it. */
const EVENT_SUSPEND_AFTER_MS = HOUR_MS;
/** Log rows one delivery pass scans per subscription, and one poll scans. */
const EVENT_SCAN = 200;
const EVENT_POLL_SCAN = 500;
const EVENT_POLL_MS = 60_000;
/** One alarm spends at most this long on webhook deliveries, so a slow endpoint can't keep it awake. */
const EVENT_DELIVERY_BUDGET_MS = 10_000;
const RECEIVER_VERIFIED_MS = DAY_MS;
/** Old secrets keep signing this long after a rotation, so in-flight deliveries still verify. */
const SECRET_GRACE_MS = 10 * 60_000;
const WEBHOOK_TIMEOUT_MS = 5_000;
/** Text in event payloads is cut to this; the full answer is in shared state or the thread. */
const EVENT_TEXT_MAX = 500;

const PINS_PER_PERSON = 100;
const WATCHES_SHOWN = 50;
/** A Durable Object's SQLite holds 10 GB; writes stop short of it. */
const DATABASE_CAPACITY_BYTES = 9.5 * 1024 * 1024 * 1024;
const PUBLIC_DAYS_MAX = 365;
const JOIN_DOMAINS_MAX = 20;
/** Anyone can get an address at these, so a domain rule for them would let the whole internet in. */
const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "icloud.com", "me.com",
  "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de", "gmx.net", "mail.com", "yandex.com",
  "yandex.ru", "mail.ru", "zoho.com", "fastmail.com", "hey.com", "qq.com", "163.com", "126.com", "duck.com", "tutanota.com",
  "tuta.io", "web.de", "t-online.de", "orange.fr", "free.fr", "laposte.net", "libero.it", "naver.com", "yahoo.co.uk",
  "yahoo.co.jp", "yahoo.fr", "yahoo.de", "ymail.com", "rocketmail.com", "hotmail.co.uk", "hotmail.fr", "hotmail.de",
  "outlook.de", "outlook.fr", "live.co.uk", "live.de", "live.fr", "comcast.net", "att.net", "verizon.net", "sbcglobal.net",
]);

export class Workspace extends DurableObject {
  private sql: SqlStorage;
  private hubEnv: HubEnv;
  private nextCheckAt = 0;
  private dirty: boolean | null = null;

  constructor(ctx: DurableObjectState, env: HubEnv) {
    super(ctx, env as never);
    this.hubEnv = env;
    this.sql = ctx.storage.sql;
    // Only a provisioned workspace has tables. An object woken for a slug that
    // doesn't exist (or was just deleted) stays empty and stores nothing.
    this.ready = ctx.storage.sql.exec(`SELECT 1 FROM sqlite_master WHERE name = '_schema'`).toArray().length > 0;
    if (this.ready) migrate(ctx.storage, MIGRATIONS);
    // Work a migration left for the alarm (the links backfill) starts on the first wake.
    if (this.ready && this.setting("links_backfill") !== null) ctx.blockConcurrencyWhile(() => this.armAlarm());
  }

  private ready: boolean;

  private directory(): DirectoryApi {
    return this.hubEnv.DIRECTORY.getByName("directory") as unknown as DirectoryApi;
  }

  // ---- workspace -------------------------------------------------------------

  private setting(key: string): string | null {
    return (this.sql.exec(`SELECT value FROM settings WHERE key = ?`, key).toArray()[0]?.value as string | undefined) ?? null;
  }

  private setSetting(key: string, value: string | null) {
    if (value === null) this.sql.exec(`DELETE FROM settings WHERE key = ?`, key);
    else this.sql.exec(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value);
  }

  /** First-time setup by the operator: name the workspace and add its first admin. */
  async provision(input: { slug: string; name: string; admin: string; plan?: PlanId }) {
    if (!this.ready) {
      migrate(this.ctx.storage, MIGRATIONS);
      this.ready = true;
    }
    const existing = this.setting("slug");
    if (existing && existing !== input.slug) throw new HubError(`this object already belongs to ${existing}`);
    // Data left from a delete that didn't finish must never reappear in a new workspace.
    if (this.setting("destroyed") || (existing && (this.sql.exec(`SELECT COUNT(*) AS n FROM members`).one().n as number) > 0)) {
      throw new HubError(`data from an earlier ${input.slug} is still here; delete it again first`);
    }
    this.setSetting("slug", input.slug);
    this.setSetting("name", input.name);
    if (!this.setting("created_at")) this.setSetting("created_at", new Date().toISOString());
    if (input.plan) this.setSetting("plan", input.plan);
    await this.setMember(input.admin, "admin", null);
    return this.info();
  }

  /**
   * A deleted account, as far as this workspace goes (after it's stopped being a member): artifacts shared with
   * that address stop being shared with it, and its pins, read state, notification levels, queued notifications,
   * grants and event subscriptions go. Comments it wrote stay.
   */
  forgetPerson(email: string) {
    if (!this.ready) return;
    const clean = email.trim().toLowerCase();
    this.ctx.storage.transactionSync(() => {
      for (const table of ["shares", "seen", "pins", "watches", "watch_defaults", "outbox", "grants"]) this.sql.exec(`DELETE FROM ${table} WHERE email = ?`, clean);
      this.sql.exec(`DELETE FROM event_subs WHERE principal = ?`, clean);
      this.sql.exec(`DELETE FROM event_receivers WHERE principal = ?`, clean);
    });
    this.markDirty();
    for (const ws of this.ctx.getWebSockets()) if ((ws.deserializeAttachment() as SocketTag).email === clean) ws.close(4003, "access changed");
  }

  /** Spend a single-use token: true the first time only. Spent ones are forgotten once they'd have expired. */
  spendToken(id: string, untilMs: number): boolean {
    if (!this.ready) return false;
    this.sql.exec(`DELETE FROM used_tokens WHERE until < ?`, Date.now());
    return this.sql.exec(`INSERT INTO used_tokens (id, until) VALUES (?, ?) ON CONFLICT (id) DO NOTHING RETURNING id`, id, untilMs).toArray().length > 0;
  }

  /** Whether this workspace still has its data (false once destroyed, or never provisioned). */
  exists(): boolean {
    return this.ready && !this.setting("destroyed");
  }

  info(): { slug: string; name: string; createdAt: string | null } {
    if (!this.ready) return { slug: "", name: "", createdAt: null };
    const slug = this.setting("slug") ?? "";
    return { slug, name: this.setting("name") ?? slug, createdAt: this.setting("created_at") };
  }

  async rename(name: string) {
    const clean = name.trim().slice(0, 80);
    if (!clean) throw new HubError("the workspace needs a name");
    this.setSetting("name", clean);
    await this.directory().recordStats(this.info().slug, this.stats(), clean);
    return this.info();
  }

  /**
   * What the Worker needs per request: the workspace and this person's
   * membership. Only a newcomer from a join domain waits (see autoJoin); every
   * other request stays synchronous.
   */
  access(email: string | null, origin?: string): Access | Promise<Access> {
    const { slug, name, createdAt } = this.info();
    if (!this.ready) return { slug, name, member: null, offline: false };
    // Remembered for notifications queued by work that had no request (the alarm, imports).
    if (origin && slug && this.setting("origin") !== origin) this.setSetting("origin", origin);
    const offline = this.offline();
    const member = email ? this.memberRole(email) : null;
    if (email && !member && this.joinsByDomain(email)) return this.autoJoin(email).then((joined) => ({ slug, name, member: joined, offline, createdAt }));
    return { slug, name, member, offline, createdAt };
  }

  stats(): WorkspaceStats {
    return {
      artifacts: this.sql.exec(`SELECT COUNT(*) AS n FROM artifacts`).one().n as number,
      members: this.sql.exec(`SELECT COUNT(*) AS n FROM members`).one().n as number,
      bytes: this.sql.databaseSize,
      lastActivity: (this.sql.exec(`SELECT MAX(at) AS at FROM events`).one().at as string | null) ?? null,
      plan: this.planId(),
    };
  }

  // ---- plan ---------------------------------------------------------------------

  private planId(): PlanId {
    const p = this.setting("plan");
    // A paid-up plan that was canceled lapses to Free on its own once its period ends.
    const until = this.setting("plan_until");
    if (until && Date.parse(until) <= Date.now()) return "free";
    return isPlan(p) ? p : DEFAULT_PLAN;
  }

  /** The plan, its limits and what the workspace uses of them. */
  plan() {
    const id = this.planId();
    const { artifacts, members } = this.stats();
    const until = id === "team" ? this.setting("plan_until") : null;
    return { id, label: PLANS[id].label, limits: PLANS[id].limits, usage: { artifacts, members, bytes: this.storedBytes() }, until };
  }

  /** Operator only (no billing yet). */
  /** `until`: the plan lapses to Free at that time (a canceled subscription's paid period); null for no end. */
  async setPlan(id: PlanId, until: string | null = null) {
    if (!isPlan(id)) throw new HubError(`unknown plan ${id}`);
    this.setSetting("plan", id);
    this.setSetting("plan_until", id === "team" ? until : null);
    await this.directory().recordStats(this.info().slug, this.stats());
    return this.plan();
  }

  /**
   * Whatever the plan, a workspace's database must stay under the Durable
   * Object's 10 GB: pages freed by deletes are reused, so they don't count.
   */
  private withinCapacity() {
    let free = 0;
    try {
      const pages = this.sql.exec(`PRAGMA freelist_count`).one().freelist_count as number;
      const size = this.sql.exec(`PRAGMA page_size`).one().page_size as number;
      free = pages * size;
    } catch {
      // Not every PRAGMA is allowed; without it, the file size is the measure.
    }
    if (this.sql.databaseSize - free >= DATABASE_CAPACITY_BYTES) {
      throw new HubError("This workspace is almost out of space. Delete artifacts you no longer need, then try again.");
    }
  }

  /**
   * What a workspace stores for its plan's storage limit: file contents,
   * assets, shared state and screenshots. Unlike the database file's size, it
   * falls as soon as something is deleted.
   */
  private storedBytes(): number {
    const sum = (q: string) => this.sql.exec(q).one().n as number;
    return (
      sum(`SELECT COALESCE(SUM(length(content)), 0) AS n FROM blobs`) +
      sum(`SELECT COALESCE(SUM(bytes), 0) AS n FROM assets`) +
      sum(`SELECT COALESCE(SUM(length(value)), 0) AS n FROM state`) +
      sum(`SELECT COALESCE(SUM(length(screenshot)), 0) AS n FROM checks`)
    );
  }

  private storedSample: { at: number; n: number } | null = null;

  /** Shared state is written often (every checkbox), so its storage check reuses a reading up to 30 seconds old. */
  private withinPlanForState() {
    this.withinCapacity();
    const max = PLANS[this.planId()].limits.bytes;
    if (max === null) return;
    if (!this.storedSample || Date.now() - this.storedSample.at > 30_000) this.storedSample = { at: Date.now(), n: this.storedBytes() };
    if (this.storedSample.n >= max) {
      this.storedSample = null;
      this.withinPlan("bytes");
    }
  }

  /** Refuses a write that would go past the plan. Deleting is always allowed, so a full workspace can make room. */
  private withinPlan(kind: "artifacts" | "bytes" | "members" | "changesPerDay") {
    if (kind === "bytes") this.withinCapacity();
    const plan = PLANS[this.planId()];
    const max = plan.limits[kind];
    if (max === null) return;
    const count = (q: string, ...args: SqlStorageValue[]) => this.sql.exec(q, ...args).one().n as number;
    const used = {
      artifacts: () => count(`SELECT COUNT(*) AS n FROM artifacts`),
      members: () => count(`SELECT COUNT(*) AS n FROM members`),
      bytes: () => this.storedBytes(),
      changesPerDay: () => this.savesToday(),
    }[kind]();
    if (used < max) return;
    const size = max >= 1024 ** 3 ? `${max / 1024 ** 3} GB` : `${Math.round(max / 1024 / 1024)} MB`;
    const limit = { artifacts: `${max} artifacts (archived ones count)`, members: `${max} members`, bytes: `${size} of storage`, changesPerDay: `${max} saved changes a day` }[kind];
    // The free plan's experiment is whether people reach its limits, and then pay: record each one (once a day per kind).
    const day = new Date().toISOString().slice(0, 10);
    if (this.setting(`limit_hit_${kind}`) !== day) {
      this.setSetting(`limit_hit_${kind}`, day);
      void this.ops({ kind: "plan_limit_reached", message: `${plan.label} limit reached: ${limit}.`, detail: { limit: kind, plan: this.planId() } });
    }
    // Read by people and by agents: say who can fix it, and never suggest deleting anything (that's a person's call).
    const fix =
      kind === "changesPerDay"
        ? "Try again later: changes save again as the oldest of today's fall out of the last 24 hours."
        : `A workspace admin can ${kind === "members" ? "remove a member" : "delete artifacts nobody needs"}${this.planId() === "free" ? `, or move the workspace to Team in its settings (${TEAM_PRICE.amount} USD a ${TEAM_PRICE.period})` : ""}. (Agents: tell the person rather than deleting anything to make room.)`;
    throw new HubError(`This workspace is on the ${plan.label} plan, which allows ${limit}. ${fix}`);
  }

  /** Deletes everything this workspace stores, including its backups. */
  /** Delete everything; safe to call again if an earlier attempt failed partway. */
  async destroy(slugHint?: string) {
    const slug = this.info().slug || slugHint || "";
    if (this.ready) {
      // Marked first, so an alarm or a backup that runs during the awaits below does nothing.
      this.setSetting("destroyed", new Date().toISOString());
      for (const ws of this.ctx.getWebSockets()) ws.close(4004, "workspace deleted");
    }
    await this.ctx.storage.deleteAlarm();
    const bucket = this.hubEnv.BACKUPS;
    if (bucket && slug) await deletePrefix(bucket, `${slug}/`);
    await this.ctx.storage.deleteAll();
    // No tables any more: this instance now answers as a workspace that doesn't exist.
    this.ready = false;
    this.dirty = null;
    this.nextCheckAt = 0;
    // A backup step that was awaiting R2 may have written once more; remove that too.
    if (bucket && slug) await deletePrefix(bucket, `${slug}/`);
  }

  // ---- members and agent tokens ----------------------------------------------------

  private memberRole(email: string): WorkspaceRole | null {
    return (this.sql.exec(`SELECT role FROM members WHERE email = ?`, email).toArray()[0]?.role as WorkspaceRole | undefined) ?? null;
  }

  members(): Member[] {
    return this.sql
      .exec(`SELECT * FROM members ORDER BY role, email`)
      .toArray()
      .map((r) => ({
        email: r.email as string,
        role: r.role as WorkspaceRole,
        addedAt: r.added_at as string,
        addedBy: (r.added_by as string | null) ?? null,
        lastSeenAt: (r.last_seen_at as string | null) ?? null,
      }));
  }

  /** Add, change or (role null) remove a member. The last admin can't be removed or demoted. */
  async setMember(email: string, role: WorkspaceRole | null, by: string | null): Promise<Member[]> {
    const clean = email.trim().toLowerCase();
    if (!isValidPrincipal(clean) || !clean.includes("@") || clean.startsWith("@")) throw new HubError(`"${email}" is not an email address`);
    if (role !== null && role !== "admin" && role !== "member") throw new HubError(`unknown role ${role}`);
    const current = this.memberRole(clean);
    if (!current && role) this.withinPlan("members");
    if (current === "admin" && role !== "admin") {
      const admins = this.sql.exec(`SELECT COUNT(*) AS n FROM members WHERE role = 'admin'`).one().n as number;
      if (admins <= 1) throw new HubError("a workspace needs at least one admin");
    }
    this.ctx.storage.transactionSync(() => {
      if (role === null) {
        this.sql.exec(`DELETE FROM members WHERE email = ?`, clean);
        // Their agents lose access with them, and what they owned passes to
        // whoever removed them (or the remaining admins), so nothing is stranded.
        this.sql.exec(`DELETE FROM tokens WHERE email = ?`, clean);
        // Their event subscriptions end on the next alarm, with a terminated notice.
        this.sql.exec(`UPDATE event_subs SET next_at = ?, suspended = 0 WHERE principal = ?`, Date.now(), clean);
        const heir = by && by !== clean ? by : (this.sql.exec(`SELECT email FROM members WHERE role = 'admin' ORDER BY email LIMIT 1`).toArray()[0]?.email as string);
        if (heir) this.sql.exec(`UPDATE artifacts SET owner = ? WHERE owner = ?`, heir, clean);
        this.sql.exec(
          `INSERT INTO removed_members (email, removed_by, removed_at) VALUES (?, ?, ?) ON CONFLICT (email) DO UPDATE SET removed_by = excluded.removed_by, removed_at = excluded.removed_at`,
          clean,
          by,
          new Date().toISOString(),
        );
      } else {
        this.sql.exec(`DELETE FROM removed_members WHERE email = ?`, clean);
        this.sql.exec(
          `INSERT INTO members (email, role, added_at, added_by) VALUES (?, ?, ?, ?)
           ON CONFLICT (email) DO UPDATE SET role = excluded.role`,
          clean,
          role,
          new Date().toISOString(),
          by,
        );
      }
    });
    this.markDirty();
    // Open pages reconnect and are re-checked against the new role.
    for (const ws of this.ctx.getWebSockets()) if ((ws.deserializeAttachment() as SocketTag).email === clean) ws.close(4003, "access changed");
    await this.directory().setMembership(this.info().slug, clean, role);
    return this.members();
  }

  /**
   * Take `n` from today's email allowance (invitations, shares, notifications);
   * false when it's used up. `by` also counts against that person's own daily
   * share allowance, so one member can't use the workspace to send bulk mail.
   */
  /**
   * Today's email allowance. Invitations and shares ("invite") may use the
   * whole cap; notifications only what's left above the part set aside for
   * invitations, so a busy day of notifications can't stop someone being
   * invited.
   */
  /**
   * Saves in the last 24 hours, counted as they happen (by the hour) rather than from the activity log, so deleting
   * what was saved doesn't make room for more.
   */
  private savesToday(): number {
    const hours = JSON.parse(this.setting("saves_by_hour") ?? "{}") as Record<string, number>;
    const since = Math.floor((Date.now() - DAY_MS) / HOUR_MS);
    return Object.entries(hours).reduce((n, [h, c]) => (Number(h) > since ? n + c : n), 0);
  }

  private countSave() {
    const hours = JSON.parse(this.setting("saves_by_hour") ?? "{}") as Record<string, number>;
    const now = Math.floor(Date.now() / HOUR_MS);
    const kept: Record<string, number> = {};
    for (const [h, c] of Object.entries(hours)) if (Number(h) > now - 24) kept[h] = c;
    kept[now] = (kept[now] ?? 0) + 1;
    this.setSetting("saves_by_hour", JSON.stringify(kept));
  }

  /** Room for one more render check today on this plan; counts it. */
  private allowCheck(): boolean {
    const day = new Date().toISOString().slice(0, 10);
    const used = JSON.parse(this.setting("checks_day") ?? "{}") as { day?: string; n?: number };
    const n = used.day === day ? (used.n ?? 0) : 0;
    if (n >= PLANS[this.planId()].limits.checksPerDay) return false;
    this.setSetting("checks_day", JSON.stringify({ day, n: n + 1 }));
    return true;
  }

  /** A Free workspace less than a day old: held back from what a throwaway one could abuse. */
  private newFree(): boolean {
    const created = this.info().createdAt;
    return this.planId() === "free" && created !== null && Date.now() - Date.parse(created) < DAY_MS;
  }

  allowMail(n: number, by?: string, kind: "invite" | "notify" = "invite"): boolean {
    const day = new Date().toISOString().slice(0, 10);
    const used = JSON.parse(this.setting("mail_sent") ?? "{}") as { day?: string; n?: number; notify?: number; by?: Record<string, number> };
    const today = used.day === day ? used : { day, n: 0, notify: 0, by: {} };
    const mine = by ? (today.by?.[by] ?? 0) : 0;
    const limits = PLANS[this.planId()].limits;
    const cap = Math.min(MAIL_PER_DAY, limits.emailsPerDay);
    if ((today.n ?? 0) + n > cap) {
      // Once a day, so the operator console shows which workspaces run out (and whether a cap is too tight).
      if (this.setting("mail_capped") !== day) {
        this.setSetting("mail_capped", day);
        void this.ops({ kind: "email_cap_reached", message: `Used all ${cap} emails for ${day} (${this.planId()}).` });
      }
      return false;
    }
    if (by && mine + n > SHARE_MAIL_PER_PERSON) return false;
    if (kind === "notify" && (today.notify ?? 0) + n > cap - limits.inviteEmailsPerDay) return false;
    // On a new Free workspace's first day, invitations and shares are held to a handful.
    // Counted since creation (not per calendar day), so a workspace made just before midnight gets no more.
    const firstDay = Number(this.setting("first_day_invites") ?? 0);
    if (kind === "invite" && this.newFree()) {
      if (firstDay + n > NEW_FREE_INVITES) return false;
      this.setSetting("first_day_invites", String(firstDay + n));
    }
    this.setSetting(
      "mail_sent",
      JSON.stringify({ day, n: (today.n ?? 0) + n, notify: (today.notify ?? 0) + (kind === "notify" ? n : 0), by: by ? { ...today.by, [by]: mine + n } : today.by }),
    );
    return true;
  }

  /** Someone signed in here: note it for members ("hasn't signed in yet"); returns whether they're a member. */
  async signedIn(email: string, join = true): Promise<boolean> {
    // A link session opens one artifact; only a real sign-in joins by domain.
    if (join) await this.autoJoin(email);
    return this.sql.exec(`UPDATE members SET last_seen_at = ? WHERE email = ?`, new Date().toISOString(), email).rowsWritten > 0;
  }

  // ---- joining by email domain ----------------------------------------------------

  /** Email domains whose people become members when they first open the workspace. */
  joinDomains(): string[] {
    return this.sql.exec(`SELECT domain FROM join_domains ORDER BY domain`).toArray().map((r) => r.domain as string);
  }

  /** Replace the join domains. Admins only: the Worker checks that, as for approved hosts. */
  setJoinDomains(domains: string[], by: string): string[] {
    const clean = [...new Set(domains.map(joinDomain))];
    if (clean.length > JOIN_DOMAINS_MAX) throw new HubError(`at most ${JOIN_DOMAINS_MAX} join domains`);
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      const keep = new Set(clean);
      for (const d of this.joinDomains()) if (!keep.has(d)) this.sql.exec(`DELETE FROM join_domains WHERE domain = ?`, d);
      for (const d of clean) this.sql.exec(`INSERT OR IGNORE INTO join_domains (domain, added_by, added_at) VALUES (?, ?, ?)`, d, by, now);
    });
    this.markDirty();
    return this.joinDomains();
  }

  /** Add or remove one join domain (the settings page's route). */
  setJoinDomain(domain: string, allowed: boolean, by: string): string[] {
    const current = this.joinDomains();
    if (allowed) return this.setJoinDomains([...current, domain], by);
    const d = domain.trim().toLowerCase().replace(/^@/, "");
    return this.setJoinDomains(current.filter((c) => c !== d), by);
  }

  /** One indexed lookup; the hot path's only cost for people who aren't members. */
  private joinsByDomain(email: string): boolean {
    const domain = email.split("@")[1]?.toLowerCase();
    return Boolean(domain) && this.sql.exec(`SELECT 1 FROM join_domains WHERE domain = ?`, domain).toArray().length > 0;
  }

  /**
   * Their membership, adding them as a member first when their (verified)
   * email's domain is a join domain. Called at sign-in and on the next visit
   * of anyone already signed in. No invitation email: they're already here.
   */
  async autoJoin(email: string): Promise<WorkspaceRole | null> {
    if (!this.ready) return null;
    const current = this.memberRole(email);
    // Not while a restore or import is replacing the members.
    if (current || this.offline() || !this.joinsByDomain(email)) return current;
    if (this.sql.exec(`SELECT 1 FROM removed_members WHERE email = ?`, email).toArray().length) return null;
    // A full plan leaves them a guest: they still see what's shared with them.
    try {
      this.withinPlan("members");
    } catch {
      return null;
    }
    try {
      await this.setMember(email, "member", `auto:${email.split("@")[1]}`);
    } catch (err) {
      console.error("joining by domain failed", err);
    }
    return this.memberRole(email);
  }

  /** A new personal agent token. The plain token is returned only here. */
  async createToken(email: string, label: string): Promise<{ id: string; token: string; label: string }> {
    if (!this.memberRole(email)) throw new HubError("only workspace members can create agent tokens");
    const count = this.sql.exec(`SELECT COUNT(*) AS n FROM tokens WHERE email = ?`, email).one().n as number;
    if (count >= 20) throw new HubError("you can have at most 20 agent tokens; revoke one first");
    const token = `art_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
    const id = `k${randomId(11)}`;
    const clean = label.trim().slice(0, 60) || "Agent";
    this.sql.exec(
      `INSERT INTO tokens (id, hash, email, label, created_at) VALUES (?, ?, ?, ?, ?)`,
      id,
      await sha256Hex(token),
      email,
      clean,
      new Date().toISOString(),
    );
    this.markDirty();
    return { id, token, label: clean };
  }

  /** Agent tokens, all of them or one person's. Never includes the secret. */
  tokens(email?: string): AgentToken[] {
    const rows = email
      ? this.sql.exec(`SELECT * FROM tokens WHERE email = ? ORDER BY created_at`, email)
      : this.sql.exec(`SELECT * FROM tokens ORDER BY email, created_at`);
    return rows.toArray().map((r) => ({
      id: r.id as string,
      email: r.email as string,
      label: r.label as string,
      createdAt: r.created_at as string,
      lastUsedAt: (r.last_used_at as string | null) ?? null,
    }));
  }

  /** Revoke a token: your own, or anyone's if you are an admin. */
  revokeToken(id: string, by: string): boolean {
    const row = this.sql.exec(`SELECT email FROM tokens WHERE id = ?`, id).toArray()[0];
    if (!row) return false;
    if (row.email !== by && this.memberRole(by) !== "admin") throw new HubError("you can only revoke your own tokens");
    this.sql.exec(`DELETE FROM tokens WHERE id = ?`, id);
    this.markDirty();
    return true;
  }

  /** The member a presented agent token belongs to, or null. */
  async verifyAgentToken(token: string): Promise<{ email: string } | null> {
    if (!this.ready || !token.startsWith("art_")) return null;
    const row = this.sql.exec(`SELECT id, email, last_used_at FROM tokens WHERE hash = ?`, await sha256Hex(token)).toArray()[0];
    if (!row || !this.memberRole(row.email as string)) return null;
    const last = row.last_used_at ? Date.parse(row.last_used_at as string) : 0;
    if (Date.now() - last > TOKEN_TOUCH_MS) this.sql.exec(`UPDATE tokens SET last_used_at = ? WHERE id = ?`, new Date().toISOString(), row.id);
    return { email: row.email as string };
  }

  /** An OAuth app a member connected (the grant itself lives in the OAuth KV). */
  recordGrant(id: string, email: string, client: string) {
    this.sql.exec(
      `INSERT INTO grants (id, email, client, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      id,
      email,
      client.slice(0, 120),
      new Date().toISOString(),
    );
    this.markDirty();
  }

  grants(email?: string): { id: string; email: string; client: string; createdAt: string }[] {
    const rows = email ? this.sql.exec(`SELECT * FROM grants WHERE email = ? ORDER BY created_at`, email) : this.sql.exec(`SELECT * FROM grants ORDER BY email, created_at`);
    return rows.toArray().map((r) => ({ id: r.id as string, email: r.email as string, client: r.client as string, createdAt: r.created_at as string }));
  }

  /** Forget grants after they're revoked: one by id, or all of a person's. Returns what was forgotten. */
  forgetGrants(filter: { id?: string; email: string }): string[] {
    const rows = filter.id
      ? this.sql.exec(`DELETE FROM grants WHERE id = ? AND email = ? RETURNING id`, filter.id, filter.email)
      : this.sql.exec(`DELETE FROM grants WHERE email = ? RETURNING id`, filter.email);
    const ids = rows.toArray().map((r) => r.id as string);
    if (ids.length) this.markDirty();
    return ids;
  }

  // ---- reads -------------------------------------------------------------

  /**
   * SQL for the ids a person can see without being an admin: their own
   * artifacts, and ones shared with their email, their domain, or (for members)
   * the whole workspace.
   */
  private visibleSql(email: string): { sql: string; args: string[] } {
    const principals = [email, domainOf(email), ...(this.memberRole(email) ? [WORKSPACE_PRINCIPAL] : [])];
    return {
      sql: `SELECT v.id FROM artifacts v WHERE v.owner = ? UNION SELECT s.artifact_id FROM shares s WHERE s.email IN (${principals.map(() => "?").join(", ")})`,
      args: [email, ...principals],
    };
  }

  /**
   * Everything this person can see, newest first, with their role and what's
   * new for them. A fixed handful of queries however many artifacts there are.
   */
  list(email: string | null): (ArtifactMeta & { role: Role; unseen?: boolean; unread?: number; pinnedAt?: string })[] {
    if (!email) return [];
    const member = this.memberRole(email);
    const principals = [email, domainOf(email), ...(member ? [WORKSPACE_PRINCIPAL] : [])];
    // Most specific share wins: email, then domain, then workspace (same as roleFor).
    const shared = new Map<string, Role>();
    const rank = (p: string) => principals.indexOf(p);
    const best = new Map<string, number>();
    for (const r of this.sql.exec(`SELECT artifact_id, email, role FROM shares WHERE email IN (${principals.map(() => "?").join(", ")})`, ...principals)) {
      const id = r.artifact_id as string;
      if (!best.has(id) || rank(r.email as string) < best.get(id)!) {
        best.set(id, rank(r.email as string));
        shared.set(id, r.role as Role);
      }
    }
    const seen = new Map(
      this.sql.exec(`SELECT artifact_id, version, read_seq FROM seen WHERE email = ?`, email).toArray().map((r) => [r.artifact_id as string, r]),
    );
    const unread = new Map(
      this.sql
        .exec(
          `SELECT c.artifact_id AS id, COUNT(*) AS n FROM comments c JOIN seen s ON s.artifact_id = c.artifact_id AND s.email = ?
           WHERE c.seq > s.read_seq AND c.by != ? GROUP BY c.artifact_id`,
          email,
          email,
        )
        .toArray()
        .map((r) => [r.id as string, r.n as number]),
    );
    const pins = new Map(this.sql.exec(`SELECT artifact_id, pinned_at FROM pins WHERE email = ?`, email).toArray().map((r) => [r.artifact_id as string, r.pinned_at as string]));
    const out: (ArtifactMeta & { role: Role; unseen?: boolean; unread?: number; pinnedAt?: string })[] = [];
    for (const r of this.sql.exec(`SELECT * FROM artifacts ORDER BY updated_at DESC`)) {
      const meta = toMeta(r);
      const role: Role | undefined = member === "admin" || meta.owner === email ? "owner" : shared.get(meta.id);
      if (!role) continue;
      const s = seen.get(meta.id);
      const pinnedAt = pins.get(meta.id);
      out.push({ ...meta, role, unseen: s ? (s.version as number) < meta.version : true, unread: unread.get(meta.id) ?? 0, ...(pinnedAt ? { pinnedAt } : {}) });
    }
    // Your pins first, most recently pinned on top; the rest by last update.
    return out.sort((a, b) => (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? ""));
  }

  meta(id: string): (ArtifactMeta & { shares: ShareEntry[]; files: { path: string; bytes: number }[] }) | null {
    const row = this.sql.exec(`SELECT * FROM artifacts WHERE id = ?`, id).toArray()[0];
    if (!row) return null;
    const shares = this.sql
      .exec(`SELECT email, role FROM shares WHERE artifact_id = ? ORDER BY email`, id)
      .toArray() as unknown as ShareEntry[];
    const files = this.sql
      .exec(
        `SELECT f.path, length(CAST(b.content AS BLOB)) AS bytes FROM files f
         JOIN blobs b ON b.artifact_id = f.artifact_id AND b.hash = f.hash WHERE f.artifact_id = ? ORDER BY f.path`,
        id,
      )
      .toArray() as unknown as { path: string; bytes: number }[];
    return { ...toMeta(row), shares, files };
  }

  /**
   * Effective role, or null when this person may not open the artifact. The
   * owner and workspace admins manage it; otherwise the most specific share
   * wins (email, then domain, then workspace); public artifacts are viewable.
   */
  roleFor(id: string, email: string | null): Role | null {
    const row = this.sql.exec(`SELECT public, public_until, owner FROM artifacts WHERE id = ?`, id).toArray()[0];
    if (!row) return null;
    return this.personalRole(id, row, email) ?? (isPublic(row) ? "view" : null);
  }

  /** Role from ownership, admin or a share; null when only a public link (or nothing) lets them in. */
  private personalRole(id: string, row: Record<string, SqlStorageValue>, email: string | null): Role | null {
    if (email) {
      if (row.owner === email) return "owner";
      const member = this.memberRole(email);
      if (member === "admin") return "owner";
      const share = (p: string) => this.sql.exec(`SELECT role FROM shares WHERE artifact_id = ? AND email = ?`, id, p).toArray()[0]?.role as Role | undefined;
      const role = share(email) ?? share(domainOf(email)) ?? (member ? share(WORKSPACE_PRINCIPAL) : undefined);
      if (role) return role;
    }
    return null;
  }

  files(id: string): Record<string, string> {
    this.requireArtifact(id);
    const out: Record<string, string> = {};
    for (const r of this.sql.exec(
      `SELECT f.path, b.content FROM files f JOIN blobs b ON b.artifact_id = f.artifact_id AND b.hash = f.hash WHERE f.artifact_id = ?`,
      id,
    )) {
      out[r.path as string] = r.content as string;
    }
    return out;
  }

  grep(id: string, pattern: string, path?: string) {
    return grepFiles(this.files(id), pattern, path);
  }

  async build(id: string): Promise<{ meta: ArtifactMeta; build: Build } | null> {
    const row = this.sql.exec(`SELECT * FROM artifacts WHERE id = ?`, id).toArray()[0];
    const b = this.sql.exec(`SELECT build FROM builds WHERE artifact_id = ?`, id).toArray()[0];
    if (!row || !b) return null;
    const build: Build = JSON.parse(b.build as string);
    if (build.stamp === BUILD_STAMP) return { meta: toMeta(row), build };
    // Built by an older compiler (for example before a theme change): recompile
    // the same files once, even if several frames load at the same time. Keep
    // serving the stored build if that fails.
    let pending = this.rebuilds.get(id);
    if (!pending) {
      pending = this.rebuildStale(id, b.build as string).finally(() => this.rebuilds.delete(id));
      this.rebuilds.set(id, pending);
    }
    return { meta: toMeta(row), build: (await pending) ?? build };
  }

  private rebuilds = new Map<string, Promise<Build | null>>();

  private async rebuildStale(id: string, storedJson: string): Promise<Build | null> {
    const fresh = (await buildArtifact(this.files(id))).build;
    if (!fresh) return null;
    // An edit or data refresh may have rewritten the build while compiling; that
    // build is already current, so only replace the exact one we read.
    const updated = this.sql.exec(
      `UPDATE builds SET build = ? WHERE artifact_id = ? AND build = ?`,
      JSON.stringify(fresh),
      id,
      storedJson,
    ).rowsWritten;
    if (updated) return fresh;
    const now = this.sql.exec(`SELECT build FROM builds WHERE artifact_id = ?`, id).toArray()[0];
    return now ? JSON.parse(now.build as string) : null;
  }

  history(id: string) {
    this.requireArtifact(id);
    return this.sql
      .exec(`SELECT version, note, created_at AS createdAt, files FROM history WHERE artifact_id = ? ORDER BY version DESC`, id)
      .toArray()
      .map((r) => ({
        version: r.version as number,
        note: r.note as string,
        createdAt: r.createdAt as string,
        files: Object.keys(JSON.parse(r.files as string)),
      }));
  }

  // ---- writes ------------------------------------------------------------

  async create(input: { title: string; description?: string; files: Record<string, string>; owner: string; actor?: Actor }): Promise<WriteResult> {
    this.withinPlan("artifacts");
    this.withinPlan("bytes");
    this.withinPlan("changesPerDay");
    const { build, errors, warnings } = await buildArtifact(input.files);
    if (!build) return { ok: false, errors };
    const hashes = await hashFiles(input.files);
    const id = `a${randomId(12)}`;
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO artifacts (id, title, description, owner, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`,
        id,
        input.title,
        input.description ?? "",
        input.owner,
        now,
        now,
      );
      this.commitFiles(id, 1, input.files, hashes, build, "created", now);
      this.logEvent(id, input.actor ?? "agent", "version", { version: 1, note: "created" });
    });
    return { ok: true, id, version: 1, files: Object.keys(input.files).sort(), ...(warnings?.length ? { warnings } : {}) };
  }

  async editText(id: string, path: string, edits: TextEdit[], baseVersion?: number, opts: ChangeOptions = {}): Promise<WriteResult> {
    return this.change(id, baseVersion, opts.note || `edit ${path}`, opts, (files) => {
      if (!(path in files)) throw new EditError(`no file ${path}; files: ${Object.keys(files).join(", ")}`);
      files[path] = applyTextEdits(path, files[path], edits);
    });
  }

  async writeFiles(id: string, changes: Record<string, string | null>, baseVersion?: number, opts: ChangeOptions = {}): Promise<WriteResult> {
    const note =
      opts.note ||
      Object.entries(changes)
        .map(([p, c]) => `${c === null ? "delete" : "write"} ${p}`)
        .join(", ");
    return this.change(id, baseVersion, note, opts, (files) => {
      for (const [path, content] of Object.entries(changes)) {
        if (content === null) {
          if (!(path in files)) throw new EditError(`cannot delete ${path}: no such file`);
          delete files[path];
        } else files[path] = content;
      }
    });
  }

  async patchData(id: string, path: string, ops: JsonPatchOp[], baseVersion?: number, opts: ChangeOptions = {}): Promise<WriteResult> {
    return this.change(id, baseVersion, opts.note || `patch ${path}`, opts, (files) => {
      if (!path.startsWith("data/") || !(path in files)) throw new EditError(`no data file ${path}`);
      let doc: unknown;
      try {
        doc = JSON.parse(files[path]);
      } catch (err) {
        throw new EditError(`${path} is not valid JSON: ${(err as Error).message}`);
      }
      files[path] = `${JSON.stringify(applyJsonPatch(doc, ops), null, 2)}\n`;
    });
  }

  async revert(id: string, version: number, opts: ChangeOptions = {}): Promise<WriteResult> {
    const row = this.sql.exec(`SELECT files FROM history WHERE artifact_id = ? AND version = ?`, id, version).toArray()[0];
    if (!row) throw new HubError(`no stored version ${version}; see artifact_history`);
    const target: Record<string, string> = {};
    for (const [path, hash] of Object.entries(JSON.parse(row.files as string) as Record<string, string>)) {
      target[path] = this.sql.exec(`SELECT content FROM blobs WHERE artifact_id = ? AND hash = ?`, id, hash).one().content as string;
    }
    return this.change(id, undefined, `revert to v${version}`, opts, (files) => {
      for (const k of Object.keys(files)) delete files[k];
      Object.assign(files, target);
    });
  }

  updateMeta(id: string, patch: { title?: string; description?: string; preview?: boolean; archived?: boolean }): ArtifactMeta {
    this.requireArtifact(id);
    if (patch.title !== undefined) this.sql.exec(`UPDATE artifacts SET title = ? WHERE id = ?`, patch.title, id);
    if (patch.description !== undefined) this.sql.exec(`UPDATE artifacts SET description = ? WHERE id = ?`, patch.description, id);
    if (patch.preview !== undefined) this.sql.exec(`UPDATE artifacts SET preview = ? WHERE id = ?`, patch.preview ? 1 : 0, id);
    // Archiving doesn't touch updated_at: it isn't a change to the content.
    if (patch.archived === true) this.sql.exec(`UPDATE artifacts SET archived_at = COALESCE(archived_at, ?) WHERE id = ?`, new Date().toISOString(), id);
    if (patch.archived === false) this.sql.exec(`UPDATE artifacts SET archived_at = NULL WHERE id = ?`, id);
    this.markDirty();
    return toMeta(this.sql.exec(`SELECT * FROM artifacts WHERE id = ?`, id).one());
  }

  /**
   * Change sharing. `publicUntil` (ISO time, null for never) sets when the
   * public link stops working and implies turning it on; turning it off
   * forgets the expiry. Turning on a link that's on keeps its expiry, so an
   * agent repeating `public: true` doesn't undo the owner's choice.
   */
  share(id: string, input: { add?: ShareEntry[]; remove?: string[]; public?: boolean; publicUntil?: string | null }) {
    this.requireArtifact(id);
    const on = input.public ?? (input.publicUntil !== undefined ? true : undefined);
    if (on === false && input.publicUntil) throw new HubError("a public link that is off can't have an expiry");
    // Turning on a link that's already on keeps its expiry unless one is given (null: never).
    const current = this.sql.exec(`SELECT public, public_until FROM artifacts WHERE id = ?`, id).one();
    const keep = input.publicUntil === undefined && isPublic(current) ? ((current.public_until as string | null) ?? null) : null;
    const until = on ? (input.publicUntil === undefined ? keep : publicExpiry(input.publicUntil)) : null;
    // A brand-new Free workspace is where a phishing page would come from: no public links on its first day.
    if (on && !isPublic(current) && this.newFree()) {
      throw new HubError("Public links open after a new Free workspace's first day. Share with people by email until then, or move the workspace to Team.");
    }
    for (const s of input.add ?? []) {
      if (!isValidPrincipal(sharePrincipal(String(s.email ?? "")))) throw new HubError(`"${s.email}" is not an email address, @domain or workspace`);
      if (s.role !== "view" && s.role !== "edit") throw new HubError(`role must be view or edit, not ${s.role}`);
    }
    this.ctx.storage.transactionSync(() => {
      for (const s of input.add ?? []) {
        this.sql.exec(
          `INSERT INTO shares (artifact_id, email, role) VALUES (?, ?, ?)
           ON CONFLICT (artifact_id, email) DO UPDATE SET role = excluded.role`,
          id,
          sharePrincipal(s.email),
          s.role,
        );
      }
      for (const email of input.remove ?? []) {
        this.sql.exec(`DELETE FROM shares WHERE artifact_id = ? AND email = ?`, id, sharePrincipal(email));
      }
      if (on !== undefined) this.sql.exec(`UPDATE artifacts SET public = ?, public_until = ? WHERE id = ?`, on ? 1 : 0, until, id);
    });
    this.markDirty();
    // Open pages whose access changed (lost, or a different role) reconnect and are checked again; everyone
    // else, the person sharing included, carries on. Any doubt closes, as before.
    for (const ws of this.ctx.getWebSockets(id)) {
      const tag = ws.deserializeAttachment() as SocketTag;
      const now = tag.email ? this.roleFor(id, tag.email) : isPublic(this.sql.exec(`SELECT public, public_until FROM artifacts WHERE id = ?`, id).one()) ? "view" : null;
      if (now === null || now !== tag.role) ws.close(4003, "access changed");
    }
    return this.meta(id);
  }

  delete(id: string) {
    this.requireArtifact(id);
    this.ctx.storage.transactionSync(() => {
      for (const t of ARTIFACT_TABLES) this.sql.exec(`DELETE FROM ${t} WHERE artifact_id = ?`, id);
      this.sql.exec(`DELETE FROM links WHERE artifact_id = ? OR to_id = ?`, id, id);
      this.sql.exec(`DELETE FROM artifacts WHERE id = ?`, id);
    });
    this.markDirty();
    for (const ws of this.ctx.getWebSockets(id)) ws.close(4004, "artifact deleted");
  }

  // ---- shared state ------------------------------------------------------

  state(id: string): Record<string, JsonValue> {
    this.requireArtifact(id);
    const out: Record<string, JsonValue> = {};
    for (const r of this.sql.exec(`SELECT key, value FROM state WHERE artifact_id = ?`, id)) {
      out[r.key as string] = JSON.parse(r.value as string);
    }
    return out;
  }

  /**
   * Set (or delete with null) shared keys; broadcasts to live viewers. `by` is
   * the verified email of a socket write, or null for MCP. People's writes to
   * the kit's collab keys are stamped here so authorship can't be forged: a
   * poll vote must be your own, and only a comment's author (or an owner) can
   * change or delete it.
   */
  setState(
    id: string,
    changes: Record<string, JsonValue | null>,
    by: string | null,
    cid?: string,
    opts: { role?: Role; origin?: string; agent?: boolean } = {},
  ): number {
    const version = this.requireArtifact(id).version as number;
    // Removing state always works, so a full workspace can make room.
    if (Object.values(changes).some((v) => v !== null)) this.withinPlanForState();
    let seq = 0;
    const applied: { key: string; value: JsonValue | null; seq: number; created: boolean }[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const [key, raw] of Object.entries(changes)) {
        if (key.length === 0 || key.length > 200) throw new HubError(`state key "${key.slice(0, 40)}" must be 1-200 chars`);
        const existing = this.sql.exec(`SELECT by, value FROM state WHERE artifact_id = ? AND key = ?`, id, key).toArray()[0];
        // A ledger entry belongs to whoever added it, even after an owner edits it.
        const prior = existing && key.startsWith("ledger/") ? (JSON.parse(existing.value as string) as { by?: unknown; at?: unknown }) : null;
        const owner = prior ? (prior.by ?? existing!.by) : existing?.by;
        // A decision or form response is the person's own act on the page; their agent can read it but not make it.
        if (opts.agent && RESPONSE_KEY.test(key)) throw new HubError(`${key.split("/")[0] === "approve" ? "decisions" : "form responses"} can only be made by people on the page`);
        // A support case's status is the service's to set (through the support tools), never a person's or an agent's.
        if (key.startsWith("case/") && by !== null) throw new HubError("a support case's status is set through the support tools");
        // Ledger entries say who added them, so agents can't add or change one; they may remove one (after folding it into a data file).
        if (opts.agent && key.startsWith("ledger/") && raw !== null) throw new HubError("ledger entries are added by people on the page; keep your own rows in the Ledger's data file");
        const value = by ? stampCollab(key, raw, by, Boolean(existing), (owner as string | null | undefined) ?? null, opts.role, version, typeof prior?.at === "number" ? prior.at : undefined) : raw;
        seq = this.sql.exec(`UPDATE artifacts SET state_seq = state_seq + 1 WHERE id = ? RETURNING state_seq`, id).one().state_seq as number;
        if (value === null) {
          this.sql.exec(`DELETE FROM state WHERE artifact_id = ? AND key = ?`, id, key);
        } else {
          const text = JSON.stringify(value);
          if (text.length > SHARED_VALUE_MAX_BYTES) throw new HubError(`state value for "${key}" exceeds 64 KB`);
          this.sql.exec(
            `INSERT INTO state (artifact_id, key, value, seq, by) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (artifact_id, key) DO UPDATE SET value = excluded.value, seq = excluded.seq, by = excluded.by`,
            id,
            key,
            text,
            seq,
            by,
          );
        }
        applied.push({ key, value, seq, created: !existing && value !== null });
      }
      const total = this.sql.exec(`SELECT COALESCE(SUM(length(value)), 0) AS n FROM state WHERE artifact_id = ?`, id).one().n as number;
      if (total > SHARED_STATE_MAX_BYTES) throw new HubError(`shared state for this artifact would exceed 4 MB`);
      for (const a of applied) this.logStateEvent(id, by ?? "agent", a.key, a.value, a.created);
    });
    for (const a of applied) this.broadcast(id, { t: "set", key: a.key, value: a.value, seq: a.seq, by, cid });
    // A new comment in a <Comments> block notifies like a thread comment.
    for (const a of applied) {
      const scope = /^comments\/([^/]+)\//.exec(a.key)?.[1];
      if (!a.created || !scope || !by || !a.value || typeof a.value !== "object") continue;
      const text = String((a.value as { text?: unknown }).text ?? "");
      const earlier = this.sql
        .exec(
          `SELECT DISTINCT by FROM state WHERE artifact_id = ? AND substr(key, 1, ?) = ? AND by IS NOT NULL`,
          id,
          `comments/${scope}/`.length,
          `comments/${scope}/`,
        )
        .toArray()
        .map((r) => r.by as string);
      this.notifyComment(id, by, { thread: `comments/${scope}`, text, participants: earlier, reply: false, origin: opts.origin });
    }
    // A decision or form response is what the owner asked for, so it notifies like a comment.
    for (const a of applied) {
      const m = RESPONSE_KEY.exec(a.key);
      if (!m || !by || !a.value || typeof a.value !== "object" || Array.isArray(a.value)) continue;
      const v = a.value as { decision?: string; note?: string };
      this.notifyResponse(id, by, {
        component: m[1] === "approve" ? "approval" : "form",
        block: m[2],
        ...(v.decision ? { decision: v.decision } : {}),
        ...(v.note ? { note: v.note.slice(0, 300) } : {}),
        changed: !a.created,
        origin: opts.origin,
      });
    }
    return seq;
  }

  recordError(id: string, viewer: string | null, message: string, stack?: string) {
    const row = this.sql.exec(`SELECT version FROM artifacts WHERE id = ?`, id).toArray()[0];
    if (!row) return;
    // A few per viewer an hour: one person can't push everyone else's reports out of the log.
    const recent = this.sql
      .exec(`SELECT COUNT(*) AS n FROM errors WHERE artifact_id = ? AND viewer IS ? AND at > ?`, id, viewer, new Date(Date.now() - 3_600_000).toISOString())
      .one().n as number;
    if (recent >= 10) return;
    this.sql.exec(
      `INSERT INTO errors (artifact_id, at, version, viewer, message, stack) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      new Date().toISOString(),
      row.version,
      viewer,
      message.slice(0, 2000),
      stack?.slice(0, 4000) ?? null,
    );
    this.sql.exec(
      `DELETE FROM errors WHERE artifact_id = ? AND rowid NOT IN
       (SELECT rowid FROM errors WHERE artifact_id = ? ORDER BY at DESC LIMIT ?)`,
      id,
      id,
      ERRORS_KEEP,
    );
  }

  errors(id: string) {
    this.requireArtifact(id);
    return this.sql.exec(`SELECT at, version, viewer, message, stack FROM errors WHERE artifact_id = ? ORDER BY at DESC`, id).toArray();
  }

  // ---- render checks -------------------------------------------------------

  /**
   * Render-check the current version. Runs inline when a Browser Run slot is
   * free within a few seconds; otherwise queues it on the alarm. Reuses a stored
   * result for the same version. The screenshot comes back base64 for MCP.
   */
  async runRenderCheck(id: string, origin: string, force = false, view?: CheckView): Promise<CheckOutcome & { version: number }> {
    const version = this.requireArtifact(id).version as number;
    // Another way of looking (phone, whole page, a section): run now, on its own, and keep nothing.
    if (!isDefaultView(view)) {
      const now = Date.now();
      const slot = Math.max(now, this.nextCheckAt);
      if (slot - now > CHECK_INLINE_WAIT_MS) return { check: { status: "skipped", reason: "the headless browser is busy; try again in a few seconds" }, version };
      if (!this.allowCheck()) return { check: { status: "skipped", reason: CHECKS_USED_UP }, version };
      this.nextCheckAt = slot + CHECK_SPACING_MS;
      if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
      const result = await renderCheck(this.hubEnv, origin, id, version, this.info().slug, view);
      if ("rateLimited" in result) return { check: { status: "skipped", reason: "the headless browser is rate-limited; try again in a few seconds" }, version };
      return { ...result, version };
    }
    const stored = this.sql.exec(`SELECT version, status, result, screenshot FROM checks WHERE artifact_id = ?`, id).toArray()[0];
    if (!force && stored && stored.version === version && stored.status === "done") {
      const previous = JSON.parse(stored.result as string) as RenderCheck;
      // Only definitive results are reused; a skipped check is retried.
      if (previous.status === "ok" || previous.status === "errors") {
        return { check: previous, screenshot: stored.screenshot ? toB64(stored.screenshot as ArrayBuffer) : undefined, version };
      }
    }
    const now = Date.now();
    const slot = Math.max(now, this.nextCheckAt);
    if (slot - now <= CHECK_INLINE_WAIT_MS) {
      this.nextCheckAt = slot + CHECK_SPACING_MS;
      if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
      const result = await this.runCheck(id, version, origin);
      if (result) return { ...result, version };
    }
    return { check: this.queueCheck(id, version, origin), version };
  }

  async alarm() {
    try {
      await this.runDue();
    } finally {
      // A failing step must not lose the alarm for the others.
      await this.armAlarm();
    }
  }

  /** Each step on its own, so one failing (say, the directory being down) doesn't starve the rest. */
  private async runDue() {
    if (!this.ready || this.setting("destroyed")) return;
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        console.error(JSON.stringify({ ops: "alarm_step_failed", slug: this.info().slug, step: name, message: (err as Error).message }));
      }
    };
    await step("jobs", () => this.stepJobs(Date.now() + JOB_STEP_MS));
    await step("storage", () => this.watchStorage());
    await step("links", async () => this.backfillLinks());
    // Nothing else touches data while a restore or import replaces it.
    if (this.offline()) return;
    if (this.setting("resync_due")) await step("directory resync", () => this.resync());
    const backupAt = Number(this.setting("backup_due_at") ?? NaN);
    if (backupAt <= Date.now() && !this.job()) this.queueJobs([{ kind: "backup" }]);
    await step("render check", async () => {
      const next = this.sql.exec(`SELECT artifact_id, origin FROM checks WHERE status = 'queued' ORDER BY at LIMIT 1`).toArray()[0];
      if (!next || Date.now() < this.nextCheckAt) return;
      const id = next.artifact_id as string;
      const row = this.sql.exec(`SELECT version FROM artifacts WHERE id = ?`, id).toArray()[0];
      if (!row) this.sql.exec(`DELETE FROM checks WHERE artifact_id = ?`, id);
      else {
        this.nextCheckAt = Date.now() + CHECK_SPACING_MS;
        await this.runCheck(id, row.version as number, next.origin as string);
      }
    });
    await step("notifications", () => this.deliverDue());
    await step("events", () => this.deliverEvents());
    await step("sources", async () => {
      const sourcesAt = this.nextSourceAt();
      if (sourcesAt !== null && sourcesAt <= Date.now()) await this.refreshSources();
    });
  }

  /** A restore or a scripted import is replacing the data: no requests or alarm work until it's done. */
  private offline(): boolean {
    const kind = this.job()?.kind;
    return kind === "restore" || kind === "import";
  }

  /**
   * One alarm serves every queue: the earliest queued render check, due
   * notification, due live data source and pending backup.
   */
  private async armAlarm() {
    if (!this.ready) return;
    const times: number[] = [];
    // Offline (restoring or importing): only the job's own schedule matters.
    if (this.offline()) {
      const job = this.job();
      if (job && job.kind !== "import") {
        const at = Math.max(job.retryAt ? Date.parse(job.retryAt) : Date.now(), Date.now() + 1000);
        const existing = await this.ctx.storage.getAlarm();
        if (existing === null || existing > at || existing < Date.now()) await this.ctx.storage.setAlarm(at);
      }
      return;
    }
    const queued = this.sql.exec(`SELECT COUNT(*) AS n FROM checks WHERE status = 'queued'`).one().n as number;
    if (queued > 0) times.push(Math.max(Date.now() + CHECK_SPACING_MS, this.nextCheckAt));
    const due = this.sql.exec(`SELECT MIN(due_at) AS t FROM outbox`).one().t as number | null;
    if (due !== null) times.push(due);
    const source = this.nextSourceAt();
    if (source !== null) times.push(source);
    // Webhooks: the next due delivery, or else the next subscription to expire (to sweep it).
    const events = this.sql.exec(`SELECT MIN(MIN(COALESCE(next_at, expires_at), expires_at)) AS t FROM event_subs`).one().t as number | null;
    if (events !== null) times.push(events);
    const backup = this.setting("backup_due_at");
    if (backup) times.push(Number(backup));
    const job = this.job();
    if (job && job.kind !== "import") times.push(job.retryAt ? Date.parse(job.retryAt) : Date.now());
    else if (!job && this.setting("jobs_next")) times.push(Date.now());
    if (this.setting("resync_due")) times.push(Date.now() + 60_000);
    if (this.setting("links_backfill") !== null) times.push(Date.now() + 1000);
    if (!times.length) return;
    const at = Math.max(Math.min(...times), Date.now() + 1000);
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > at || existing < Date.now()) await this.ctx.storage.setAlarm(at);
  }

  /** Runs one check and stores it. Returns null when Browser Run rate-limited us. */
  private async runCheck(id: string, version: number, origin: string): Promise<CheckOutcome | null> {
    if (!this.allowCheck()) return { check: { status: "skipped", reason: CHECKS_USED_UP } };
    const result = await renderCheck(this.hubEnv, origin, id, version, this.info().slug);
    if ("rateLimited" in result) {
      this.nextCheckAt = Date.now() + 10_000;
      return null;
    }
    // Browser Run itself failing makes every check skip quietly; that's worth an email (once an hour, for everyone).
    if (result.check.status === "skipped" && /^browser /.test(result.check.reason)) {
      void this.ops({ kind: "render_check_skipped", message: `A render check was skipped: ${result.check.reason}`, detail: { artifactId: id, version }, alert: "render_check_unavailable" });
    }
    this.sql.exec(
      `INSERT INTO checks (artifact_id, version, origin, status, result, screenshot, at) VALUES (?, ?, ?, 'done', ?, ?, ?)
       ON CONFLICT (artifact_id) DO UPDATE SET version = excluded.version, origin = excluded.origin,
         status = 'done', result = excluded.result, screenshot = excluded.screenshot, at = excluded.at
       WHERE checks.version <= excluded.version`,
      id,
      version,
      origin,
      JSON.stringify(result.check),
      result.screenshot ? fromB64(result.screenshot) : null,
      Date.now(),
    );
    if (result.check.status === "errors") for (const e of result.check.errors) this.recordError(id, "render-check", e);
    return result;
  }

  private queueCheck(id: string, version: number, origin: string): RenderCheck {
    this.sql.exec(
      `INSERT INTO checks (artifact_id, version, origin, status, result, screenshot, at) VALUES (?, ?, ?, 'queued', NULL, NULL, ?)
       ON CONFLICT (artifact_id) DO UPDATE SET version = excluded.version, origin = excluded.origin,
         status = 'queued', result = NULL, screenshot = NULL, at = excluded.at`,
      id,
      version,
      origin,
      Date.now(),
    );
    const queued = this.sql.exec(`SELECT COUNT(*) AS n FROM checks WHERE status = 'queued'`).one().n as number;
    const at = Math.max(Date.now() + CHECK_SPACING_MS, this.nextCheckAt);
    void this.armAlarm();
    return { status: "queued", inSeconds: Math.ceil((at - Date.now()) / 1000) + (queued - 1) * 2 + 5 };
  }

  // ---- assets (images and other files, stored in SQLite) --------------------

  putAsset(id: string, path: string, contentType: string, data: Uint8Array): { path: string; bytes: number } {
    this.requireArtifact(id);
    // Replacing a file with one no bigger doesn't add to storage, so it works even over the limit.
    const previous = this.sql.exec(`SELECT bytes FROM assets WHERE artifact_id = ? AND path = ?`, id, path).toArray()[0]?.bytes as number | undefined;
    if (previous === undefined || data.byteLength > previous) this.withinPlan("bytes");
    const total = this.sql.exec(`SELECT COALESCE(SUM(bytes), 0) AS n FROM assets WHERE artifact_id = ? AND path != ?`, id, path).one().n as number;
    if (total + data.byteLength > ASSETS_MAX_BYTES) throw new HubError(`assets for this artifact would exceed ${ASSETS_MAX_BYTES / 1e6} MB`);
    this.sql.exec(
      `INSERT INTO assets (artifact_id, path, content_type, data, bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (artifact_id, path) DO UPDATE SET content_type = excluded.content_type, data = excluded.data,
         bytes = excluded.bytes, updated_at = excluded.updated_at`,
      id,
      path,
      contentType,
      data,
      data.byteLength,
      new Date().toISOString(),
    );
    this.touch(id);
    return { path, bytes: data.byteLength };
  }

  deleteAsset(id: string, path: string): boolean {
    this.requireArtifact(id);
    const n = this.sql.exec(`DELETE FROM assets WHERE artifact_id = ? AND path = ? RETURNING path`, id, path).toArray().length;
    if (n) this.touch(id);
    return n > 0;
  }

  assets(id: string): { path: string; contentType: string; bytes: number }[] {
    return this.sql
      .exec(`SELECT path, content_type AS contentType, bytes FROM assets WHERE artifact_id = ? ORDER BY path`, id)
      .toArray() as unknown as { path: string; contentType: string; bytes: number }[];
  }

  asset(id: string, path: string): { contentType: string; data: ArrayBuffer } | null {
    const row = this.sql.exec(`SELECT content_type, data FROM assets WHERE artifact_id = ? AND path = ?`, id, path).toArray()[0];
    return row ? { contentType: row.content_type as string, data: row.data as ArrayBuffer } : null;
  }

  // ---- live data sources ------------------------------------------------------

  /** Hosts a person approved for live data sources (never by an agent: MCP has no tool for it). */
  allowedHosts(): string[] {
    return this.sql.exec(`SELECT host FROM allowed_hosts ORDER BY host`).toArray().map((r) => r.host as string);
  }

  async setHostAllowed(host: string, allowed: boolean): Promise<string[]> {
    const h = host.trim().toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) throw new HubError(`"${host}" is not a hostname`);
    if (allowed) this.sql.exec(`INSERT OR IGNORE INTO allowed_hosts (host) VALUES (?)`, h);
    else this.sql.exec(`DELETE FROM allowed_hosts WHERE host = ?`, h);
    this.markDirty();
    if (allowed) await this.refreshSources();
    await this.armAlarm();
    return this.allowedHosts();
  }

  sources(id: string): SourceInfo[] {
    const allowed = new Set(this.allowedHosts());
    return this.sql
      .exec(`SELECT * FROM sources WHERE artifact_id = ? ORDER BY path`, id)
      .toArray()
      .map((r) => toSource(r, allowed));
  }

  setSource(id: string, input: { path: string; url: string; everyMinutes: number; pick?: string }): SourceInfo {
    this.requireArtifact(id);
    if (!input.path.startsWith("data/") || !input.path.endsWith(".json")) throw new HubError("source path must be data/<name>.json");
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new HubError(`"${input.url}" is not a URL`);
    }
    if (url.protocol !== "https:") throw new HubError("sources must use https");
    if (url.username || url.password) throw new HubError("sources can't carry credentials");
    const every = Math.min(Math.max(Math.round(input.everyMinutes), 15), 7 * 24 * 60);
    this.sql.exec(
      `INSERT INTO sources (artifact_id, path, url, every_minutes, pick, last_fetch, last_status, last_error)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)
       ON CONFLICT (artifact_id, path) DO UPDATE SET url = excluded.url, every_minutes = excluded.every_minutes,
         pick = excluded.pick, last_fetch = NULL, last_status = NULL, last_error = NULL`,
      id,
      input.path,
      url.href,
      every,
      input.pick ?? null,
    );
    this.markDirty();
    return this.sources(id).find((s) => s.path === input.path)!;
  }

  removeSource(id: string, path: string): boolean {
    const removed = this.sql.exec(`DELETE FROM sources WHERE artifact_id = ? AND path = ? RETURNING path`, id, path).toArray().length > 0;
    if (removed) this.markDirty();
    return removed;
  }

  /** When the next approved source is due (a minute early is fine), or null if none are. */
  private nextSourceAt(): number | null {
    const allowed = new Set(this.allowedHosts());
    let next: number | null = null;
    for (const r of this.sql.exec(`SELECT url, every_minutes, last_fetch FROM sources`)) {
      if (!allowed.has(new URL(r.url as string).hostname.toLowerCase())) continue;
      const due = r.last_fetch ? Date.parse(r.last_fetch as string) + (r.every_minutes as number) * 60_000 - 60_000 : 0;
      next = next === null ? due : Math.min(next, due);
    }
    return next;
  }

  /** Fetch every due (or, with `only`, the named) source whose host is approved. */
  async refreshSources(only?: { id: string; path?: string }): Promise<SourceInfo[]> {
    const allowed = new Set(this.allowedHosts());
    const now = Date.now();
    const rows = this.sql.exec(`SELECT * FROM sources`).toArray().filter((r) => {
      if (only) return r.artifact_id === only.id && (!only.path || r.path === only.path);
      const last = r.last_fetch ? Date.parse(r.last_fetch as string) : 0;
      return now - last >= (r.every_minutes as number) * 60_000 - 60_000;
    });
    const results: SourceInfo[] = [];
    // A bounded number per alarm run; the rest are still due on the next one.
    for (const r of only ? rows : rows.slice(0, SOURCES_PER_RUN)) {
      const info = toSource(r, allowed);
      if (!info.approved) {
        results.push(info);
        continue;
      }
      let status = "ok";
      let error: string | null = null;
      try {
        const value = await fetchSource(info.url, info.pick, allowed);
        await this.replaceDataFile(info.id, info.path, `${JSON.stringify(value, null, 2)}\n`);
      } catch (err) {
        status = "error";
        error = (err as Error).message.slice(0, 300);
      }
      this.sql.exec(
        `UPDATE sources SET last_fetch = ?, last_status = ?, last_error = ? WHERE artifact_id = ? AND path = ?`,
        new Date().toISOString(),
        status,
        error,
        info.id,
        info.path,
      );
      results.push({ ...info, lastFetch: new Date().toISOString(), lastStatus: status, lastError: error });
    }
    if (only) await this.armAlarm();
    return results;
  }

  /** Swap one data file's content and rebuild, without a new version or history entry. */
  private async replaceDataFile(id: string, path: string, content: string) {
    const hash = await sha256Hex(content);
    const current = this.sql.exec(`SELECT hash FROM files WHERE artifact_id = ? AND path = ?`, id, path).toArray()[0];
    // The data didn't change: nothing to do.
    if (current?.hash === hash) return;
    const version = this.requireArtifact(id).version as number;
    const files = this.files(id);
    if (content.length > (files[path]?.length ?? 0)) this.withinPlan("bytes");
    files[path] = content;
    const { build, errors } = await buildArtifact(files);
    if (!build) throw new Error(errors.map((e) => e.message).join("; "));
    let raced = false;
    this.ctx.storage.transactionSync(() => {
      // An edit committed while this compiled: its build is newer, so this refresh waits for next time.
      const now = this.sql.exec(`SELECT version FROM artifacts WHERE id = ?`, id).toArray()[0];
      const still = this.sql.exec(`SELECT hash FROM files WHERE artifact_id = ? AND path = ?`, id, path).toArray()[0];
      // ...or an edit deleted the file this refreshes.
      if (!now || now.version !== version || Boolean(still) !== Boolean(current)) {
        raced = true;
        return;
      }
      this.sql.exec(`INSERT OR IGNORE INTO blobs (artifact_id, hash, content) VALUES (?, ?, ?)`, id, hash, content);
      this.sql.exec(
        `INSERT INTO files (artifact_id, path, hash) VALUES (?, ?, ?) ON CONFLICT (artifact_id, path) DO UPDATE SET hash = excluded.hash`,
        id,
        path,
        hash,
      );
      this.sql.exec(`UPDATE builds SET build = ?, version = ? WHERE artifact_id = ?`, JSON.stringify(build), version, id);
      this.collectBlobs(id);
    });
    if (raced) throw new Error("the artifact changed while refreshing; retrying next time");
    this.touch(id);
  }

  // ---- owner overview ------------------------------------------------------------

  /** Everything the index page needs, in one call: membership, the list, and sharing for what you manage. */
  /** One page of the artifact list for this person (see listing.ts), with sharing summaries for its rows. */
  async indexData(email: string, view: { archived?: boolean; q?: unknown; page?: unknown } = {}) {
    const member = await this.autoJoin(email);
    const page = listing(this.list(email), { archived: view.archived === true, q: view.q, page: view.page, inContent: this.contentSearch(view.q) });
    return { member, ...page, summaries: this.shareSummaries(email, page.rows) };
  }

  /**
   * For a search: which artifacts' current files contain each word. One scan of the stored text per word, only
   * when someone searches; what each person may see is still decided by list().
   */
  private contentSearch(q: unknown): InContent | undefined {
    const words = queryWords(cleanQuery(q));
    if (!words.length) return undefined;
    const hits = new Map<string, Set<string>>();
    for (const w of words) {
      const ids = this.sql
        .exec(
          `SELECT DISTINCT f.artifact_id AS id FROM files f JOIN blobs b ON b.artifact_id = f.artifact_id AND b.hash = f.hash WHERE instr(lower(b.content), ?) > 0`,
          w,
        )
        .toArray()
        .map((r) => r.id as string);
      hits.set(w, new Set(ids));
    }
    return (id, w) => hits.get(w)?.has(id) ?? false;
  }

  /** One page of what this person can see, searched here so only that page crosses to the Worker. A page past the end is empty. */
  listPage(email: string, view: { archived?: boolean; q?: unknown; page?: unknown } = {}) {
    return listing(this.list(email), { archived: view.archived === true, q: view.q, page: view.page, clamp: false, inContent: this.contentSearch(view.q) });
  }

  /**
   * Everything the artifact page needs, in one call. `scoped` is a
   * presigned-link session: it gets the page but never its management.
   */
  openArtifact(id: string, email: string | null, scoped: boolean) {
    const full = this.roleFor(id, email);
    const role: Role | null = full === "owner" && scoped ? "edit" : full;
    if (!role) return { role: null };
    const meta = this.meta(id)!;
    const member = email ? this.memberRole(email) : null;
    // A presigned link opens one artifact only, so it learns nothing about others.
    return { role, meta, member, visit: email ? this.visit(id, email) : null, ...(scoped ? {} : this.linksFor(id, email)) };
  }

  /**
   * Artifacts linking here, and the titles of those this one links to, among those this person can open
   * (anyone else sees the bare link, and doesn't learn the page exists).
   */
  private linksFor(id: string, email: string | null): { backlinks: { id: string; title: string }[]; linkTitles: Record<string, string> } {
    const visible = (other: string) => this.roleFor(other, email) !== null;
    // Filtered after reading, so read more than are shown: most linkers are usually visible.
    const backlinks = this.sql
      .exec(`SELECT a.id, a.title FROM links l JOIN artifacts a ON a.id = l.artifact_id WHERE l.to_id = ? AND a.archived_at IS NULL ORDER BY a.updated_at DESC LIMIT 200`, id)
      .toArray()
      .filter((r) => visible(r.id as string))
      .slice(0, 50)
      .map((r) => ({ id: r.id as string, title: r.title as string }));
    const linkTitles: Record<string, string> = {};
    for (const r of this.sql.exec(`SELECT a.id, a.title FROM links l JOIN artifacts a ON a.id = l.to_id WHERE l.artifact_id = ? LIMIT 200`, id)) {
      if (visible(r.id as string)) linkTitles[r.id as string] = r.title as string;
    }
    return { backlinks, linkTitles };
  }

  /** Sharing summary per artifact, for the people who manage them on the index. */
  shareSummaries(email: string, listed: { id: string; role: Role; public: boolean; publicUntil: string | null }[]): Record<string, { shares: ShareEntry[]; public: boolean; publicUntil: string | null }> {
    const out: Record<string, { shares: ShareEntry[]; public: boolean; publicUntil: string | null }> = {};
    for (const a of listed) if (a.role === "owner") out[a.id] = { shares: [], public: a.public, publicUntil: a.publicUntil };
    const ids = Object.keys(out);
    if (!ids.length) return out;
    // Only the listed rows' shares, so a page of 50 doesn't read every share in the workspace.
    for (const s of this.sql.exec(`SELECT artifact_id, email, role FROM shares WHERE artifact_id IN (${ids.map(() => "?").join(", ")}) ORDER BY email`, ...ids)) {
      out[s.artifact_id as string]?.shares.push({ email: s.email as string, role: s.role as ShareEntry["role"] });
    }
    return out;
  }

  // ---- export, import, backups and restores ----------------------------------------
  //
  // Backups and restores run as jobs on the alarm, in steps of a few seconds,
  // so their size is never limited by one invocation; the job and its cursor
  // live in settings. A restore first checks every page of the backup against
  // the schema, then clears and loads; it is queued behind a fresh backup, and
  // the workspace is offline (see access()) while it or a scripted import runs.

  /** One bounded page of a table after the given rowid (see snapshot.ts). */
  exportPage(table: string, after = 0): Page {
    return exportPage(this.sql, DATA_TABLES, table, after);
  }

  /**
   * Start replacing every data table (members included) with rows from
   * importRows. Rows load into shadow tables; nothing live changes until
   * importEnd swaps them in. The workspace is offline meanwhile.
   */
  importBegin() {
    if (this.job()) throw new HubError(`a ${this.job()!.kind} is running; cancel it first`);
    createShadows(this.ctx.storage, DATA_TABLES);
    this.setJob({ kind: "import", startedAt: new Date().toISOString(), gen: this.nextGen() });
  }

  importRows(table: string, rows: Record<string, unknown>[]): number {
    if (this.job()?.kind !== "import") throw new HubError("call importBegin first");
    return loadShadow(this.ctx.storage, DATA_TABLES, table, rows);
  }

  async importEnd() {
    if (this.job()?.kind !== "import") throw new HubError("no import is running");
    if (!shadowRows(this.sql, "members", "role = 'admin'")) throw new HubError("the import has no admin; add one, or cancel the import");
    this.swapIn();
    this.setJob(null);
    await this.afterLoad();
    return this.stats();
  }

  /** Queue a backup now. It runs on the alarm; job() shows its progress. */
  async backup(): Promise<{ queued: true } | null> {
    if (!this.hubEnv.BACKUPS || !this.info().slug) return null;
    this.queueJobs([{ kind: "backup" }]);
    await this.armAlarm();
    return { queued: true };
  }

  /**
   * An admin asking for a fresh backup to export: at most one an hour, since
   * the nightly one usually serves, and none while one is already running.
   */
  async requestBackup(): Promise<{ queued: boolean; retryAt?: string }> {
    if (this.job()?.kind === "backup") return { queued: true };
    const last = Number(this.setting("export_backup_at") ?? 0);
    if (Date.now() - last < HOUR_MS) return { queued: false, retryAt: new Date(last + HOUR_MS).toISOString() };
    if (!(await this.backup())) return { queued: false };
    this.setSetting("export_backup_at", String(Date.now()));
    return { queued: true };
  }

  /** Complete backup runs, newest first. */
  async backups(): Promise<string[]> {
    const slug = this.info().slug;
    return this.hubEnv.BACKUPS && slug ? backupRuns(this.hubEnv.BACKUPS, slug) : [];
  }

  /** Queue a fresh backup, then a restore of `run`. */
  async restore(run: string): Promise<{ queued: true }> {
    const bucket = this.hubEnv.BACKUPS;
    const slug = this.info().slug;
    if (!bucket) throw new HubError("no backup bucket is bound");
    if (!(await bucket.head(`${slug}/${run}/manifest.json`))) throw new HubError(`no complete backup ${run}`);
    this.queueJobs([{ kind: "backup" }, { kind: "restore", run }], true);
    await this.armAlarm();
    return { queued: true };
  }

  /** The running job, if any, and the last one that failed (for the operator console). */
  job(): Job | null {
    if (!this.ready) return null;
    const raw = this.setting("job");
    return raw ? (JSON.parse(raw) as Job) : null;
  }

  lastJobError(): { message: string; at: string } | null {
    if (!this.ready) return null;
    const raw = this.setting("last_job_error");
    return raw ? (JSON.parse(raw) as { message: string; at: string }) : null;
  }

  /**
   * Drop the running and queued jobs. A restore or import that hadn't swapped
   * in yet is simply abandoned: the live data was never touched.
   */
  async cancelJob() {
    if (hasShadows(this.sql, DATA_TABLES)) dropShadows(this.ctx.storage, DATA_TABLES);
    this.nextGen();
    this.setJob(null);
    this.setSetting("jobs_next", null);
    this.setSetting("last_job_error", null);
    await this.reportJob();
  }

  private setJob(job: Job | null) {
    this.setSetting("job", job ? JSON.stringify(job) : null);
  }

  /** Each job (and each cancel) gets a new generation, so a step still in flight can tell it was cancelled. */
  private nextGen(): number {
    const gen = Number(this.setting("job_gen") ?? 0) + 1;
    this.setSetting("job_gen", String(gen));
    return gen;
  }

  /** The job as it is now, if it's still the one with generation `gen`. */
  private current(gen: number): Job | null {
    const job = this.job();
    return job && job.gen === gen ? job : null;
  }

  private queueJobs(jobs: QueuedJob[], force = false) {
    const queue = JSON.parse(this.setting("jobs_next") ?? "[]") as QueuedJob[];
    for (const j of jobs) {
      // One pending backup is enough (unless it's the one a restore relies on).
      if (!force && j.kind === "backup" && (queue.some((q) => q.kind === "backup") || this.job()?.kind === "backup")) continue;
      queue.push(j);
    }
    this.setSetting("jobs_next", JSON.stringify(queue));
  }

  /** Run jobs (starting queued ones) until they're done or `deadline` passes. */
  private async stepJobs(deadline: number) {
    for (let guard = 0; guard < 5 && Date.now() < deadline; guard++) {
      if (!(await this.stepJob(deadline))) return;
    }
  }

  /** One step of the current or next job; true when it finished and the next one may start now. */
  private async stepJob(deadline: number): Promise<boolean> {
    const bucket = this.hubEnv.BACKUPS;
    const slug = this.info().slug;
    let job = this.job();
    if (job?.kind === "import") return false;
    if (job?.retryAt && Date.parse(job.retryAt) > Date.now()) return false;
    if (!job) {
      const queue = JSON.parse(this.setting("jobs_next") ?? "[]") as QueuedJob[];
      const next = queue.shift();
      if (!next) return false;
      this.setSetting("jobs_next", queue.length ? JSON.stringify(queue) : null);
      const startedAt = new Date().toISOString();
      const gen = this.nextGen();
      job = next.kind === "backup" ? { kind: "backup", startedAt, gen, cursor: startBackup(this.nextRun()) } : { kind: "restore", startedAt, gen, run: next.run, cursor: null };
      this.setJob(job);
      if (job.kind === "backup") {
        // This backup covers everything so far; later writes schedule the next.
        this.setSetting("backup_due_at", null);
        this.dirty = false;
      }
      await this.reportJob();
    }
    if (!bucket || !slug) {
      this.setJob(null);
      return false;
    }
    const gen = job.gen;
    try {
      if (job.kind === "backup") {
        const r = await stepBackup(bucket, slug, DATA_TABLES, (t, after) => this.exportPage(t, after), job.cursor, this.schemaVersion(), deadline, () => this.ready && !this.setting("destroyed"));
        if (!this.current(gen)) return false;
        if ("next" in r) {
          this.setJob({ ...job, cursor: r.next, phase: DATA_TABLES[r.next.table] ?? "finishing", error: undefined });
          return false;
        }
        this.setJob(null);
        // Tidying up afterwards can't undo a finished backup.
        const pending = JSON.parse(this.setting("jobs_next") ?? "[]") as QueuedJob[];
        await pruneBackups(bucket, slug, this.planId() === "free" ? BACKUPS_KEEP_FREE : BACKUPS_KEEP, pending.flatMap((q) => (q.kind === "restore" ? [q.run] : []))).catch((err) => console.error(JSON.stringify({ ops: "prune_failed", slug, message: (err as Error).message })));
        await this.reportJob();
        return true;
      }
      if (!job.cursor) {
        const cursor = await startRestore(bucket, slug, job.run, DATA_TABLES, this.schemaVersion());
        if (!this.current(gen)) return false;
        createShadows(this.ctx.storage, DATA_TABLES);
        job = { ...job, cursor };
        this.setJob(job);
      }
      const next = await stepRestore(bucket, job.cursor!, deadline, (table, rows) => {
        if (!this.current(gen)) throw new Error("cancelled");
        loadShadow(this.ctx.storage, DATA_TABLES, table, rows);
      });
      if (!this.current(gen)) return false;
      if (next) {
        this.setJob({ ...job, cursor: next, phase: `loading ${next.index}/${next.keys.length}`, error: undefined });
        return false;
      }
      this.swapIn();
      this.setJob(null);
      await this.afterLoad();
      return true;
    } catch (err) {
      if (!this.current(gen)) return false;
      const message = (err as Error).message.slice(0, 300);
      const tries = (job.tries ?? 0) + 1;
      // A few quick retries for passing trouble (R2, the directory); a loading restore resumes where it was.
      if (tries < 4 && !/column|schema|missing pages|no complete backup/.test(message)) {
        this.setJob({ ...job, tries, error: message, retryAt: new Date(Date.now() + tries * 60_000).toISOString() });
        await this.reportJob();
        return false;
      }
      // Give up. Nothing live was changed: a backup failed, or a restore never swapped in.
      if (job.kind === "restore") dropShadows(this.ctx.storage, DATA_TABLES);
      await this.ops({ kind: `${job.kind}_failed`, message: `The ${job.kind} gave up after ${tries} tries: ${message}`, detail: { run: (job as { run?: string }).run }, alert: true });
      this.setJob(null);
      this.setSetting("last_job_error", JSON.stringify({ message: `${job.kind}: ${message}`, at: new Date().toISOString() }));
      if (job.kind === "backup") {
        // A restore queued behind this backup was relying on it; drop it. Try the backup again tomorrow.
        this.setSetting("jobs_next", null);
        this.setSetting("backup_due_at", String(nextBackupAt()));
      }
      await this.reportJob();
      return false;
    }
  }

  /** Swap the loaded shadows in, all at once, and drop sockets and in-memory state that described the old data. */
  private swapIn() {
    for (const ws of this.ctx.getWebSockets()) ws.close(4003, "data restored");
    swapShadows(this.ctx.storage, DATA_TABLES);
  }

  /** Tell the directory about this workspace's job (the operator console reads it there, without waking workspaces). */
  private async reportJob() {
    const job = this.job();
    const summary = job ? { kind: job.kind, phase: job.phase, error: job.error, startedAt: job.startedAt } : null;
    await this.directory()
      .recordJob(this.info().slug, summary, this.lastJobError())
      .catch((err: unknown) => console.error(JSON.stringify({ ops: "report_job_failed", slug: this.info().slug, message: (err as Error).message })));
  }

  /** An ops event for this workspace (see ops.ts): logged, kept for the operator console, urgent ones emailed. */
  private ops(e: Omit<OpsEvent, "slug">) {
    return ops(this.hubEnv, { ...e, slug: this.info().slug });
  }

  /** Once a day: tell the operator when this workspace's database passes 80% of what one Durable Object holds. */
  private async watchStorage() {
    const last = Number(this.setting("storage_checked_at") ?? 0);
    if (Date.now() - last < DAY_MS) return;
    this.setSetting("storage_checked_at", String(Date.now()));
    const used = this.sql.databaseSize;
    if (used > DATABASE_CAPACITY_BYTES * 0.8) {
      await this.ops({ kind: "storage_near_cap", message: `Database at ${(used / 1024 ** 3).toFixed(2)} GB of the ${(DATABASE_CAPACITY_BYTES / 1024 ** 3).toFixed(1)} GB writes stop at.`, alert: `storage:${this.info().slug}` });
    }
  }

  /** A run id later than any before it here, even for two backups in the same millisecond. */
  private nextRun(): string {
    const last = this.setting("last_run");
    let at = Date.now();
    while (last && newRun(new Date(at)) <= last) at++;
    const run = newRun(new Date(at));
    this.setSetting("last_run", run);
    return run;
  }

  private schemaVersion(): number {
    return this.sql.exec(`SELECT version FROM _schema`).one().version as number;
  }

  /** After a restore or import: mirror the members and stats to the directory (retried by the alarm if it's down), and back up the new state tonight. */
  private async afterLoad() {
    // Subscriptions' cursors point into the log that was just replaced; clients resubscribe.
    this.sql.exec(`DELETE FROM event_subs`);
    this.sql.exec(`DELETE FROM links`);
    this.setSetting("links_backfill", "");
    this.dirty = false;
    this.markDirty();
    this.setSetting("resync_due", "1");
    await this.resync();
  }

  private async resync() {
    const { slug, name } = this.info();
    try {
      const directory = this.directory();
      await directory.replaceMemberships(slug, this.members());
      await directory.recordStats(slug, this.stats(), name);
      this.setSetting("resync_due", null);
      await this.reportJob();
    } catch (err) {
      console.error(JSON.stringify({ ops: "resync_failed", slug, message: (err as Error).message }));
    }
  }

  /** Something worth backing up changed: schedule tonight's backup if none is pending. */
  private markDirty() {
    if (this.dirty || !this.hubEnv.BACKUPS) return;
    this.dirty = true;
    if (this.setting("backup_due_at")) return;
    this.setSetting("backup_due_at", String(nextBackupAt()));
    void this.armAlarm();
  }

  private touch(id: string) {
    this.sql.exec(`UPDATE artifacts SET updated_at = ? WHERE id = ?`, new Date().toISOString(), id);
    this.markDirty();
  }

  // ---- sync sockets --------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    // Only the Worker calls this; it has already authenticated the viewer.
    const id = request.headers.get("X-Art-Id") ?? "";
    const role = request.headers.get("X-Art-Role") as Role | null;
    const email = request.headers.get("X-Art-Email") || null;
    const origin = request.headers.get("X-Art-Origin") ?? undefined;
    let exp = Number(request.headers.get("X-Art-Exp") ?? 0) || undefined;
    if (request.headers.get("Upgrade") !== "websocket" || !role) return new Response("expected websocket", { status: 400 });
    this.requireArtifact(id);
    // Someone in only through a public link with an expiry loses the socket when the link expires.
    const row = this.sql.exec(`SELECT public, public_until, owner FROM artifacts WHERE id = ?`, id).one();
    if (isPublic(row) && row.public_until && !this.personalRole(id, row, email)) {
      const until = Math.floor(Date.parse(row.public_until as string) / 1000);
      exp = exp ? Math.min(exp, until) : until;
    }
    // Read before accepting: the snapshot and threads must describe the same moment.
    const people = email ? await this.people(id, role !== "view" ? undefined : email) : [];
    const pair = new WebSocketPair();
    const tag: SocketTag = { id, email, role, origin, ...(exp ? { exp } : {}) };
    this.ctx.acceptWebSocket(pair[1], [id]);
    pair[1].serializeAttachment(tag);
    const seq = this.sql.exec(`SELECT state_seq FROM artifacts WHERE id = ?`, id).one().state_seq as number;
    send(pair[1], { t: "snapshot", seq, state: this.state(id) });
    // Comments are for signed-in collaborators; anonymous public viewers don't get them.
    if (email) send(pair[1], { t: "threads", threads: this.threads(id), people });
    this.broadcastPresence(id);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const tag = ws.deserializeAttachment() as SocketTag;
    let msg: SyncClientMessage;
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (tag.exp && Date.now() / 1000 > tag.exp) {
      ws.close(4003, "access changed");
      return;
    }
    if (msg.t === "read") {
      if (tag.email && Number.isFinite(msg.seq)) this.markRead(tag.id, tag.email, msg.seq);
      return;
    }
    const cid = "cid" in msg ? String(msg.cid) : "";
    if (!tag.email) {
      send(ws, { t: "rejected", cid, reason: "sign in to take part" });
      return;
    }
    try {
      // Anyone signed in who can open the artifact may comment; shared state needs edit access.
      if (msg.t === "comment") {
        this.addComment(tag.id, tag.email, { thread: msg.thread, anchor: msg.anchor ?? null, text: msg.text }, tag.origin, cid, tag.role);
      } else if (msg.t === "resolve") {
        this.resolveThread(tag.id, tag.email, msg.thread, msg.resolved, { role: tag.role, origin: tag.origin, cid });
      } else if (msg.t === "comment:delete") {
        this.deleteComment(tag.id, tag.email, msg.comment, tag.role, cid);
      } else if (msg.t === "set") {
        if (tag.role === "view") throw new HubError("this viewer has read-only access");
        // On a support request, the person who sent it comments and says whether a fix helped; nothing else.
        if (this.info().slug === "support" && tag.role !== "owner" && msg.key !== `approve/fixed/${tag.email}`) {
          throw new HubError("on a support request you can comment, and say whether a fix helped");
        }
        this.setState(tag.id, { [msg.key]: msg.value }, tag.email, msg.cid, { role: tag.role, origin: tag.origin });
      }
    } catch (err) {
      send(ws, { t: "rejected", cid, reason: (err as Error).message });
    }
  }

  async webSocketClose(ws: WebSocket) {
    const tag = ws.deserializeAttachment() as SocketTag;
    this.broadcastPresence(tag.id, ws);
  }

  async webSocketError(ws: WebSocket) {
    const tag = ws.deserializeAttachment() as SocketTag;
    this.broadcastPresence(tag.id, ws);
  }

  // ---- comment threads -------------------------------------------------------

  threads(id: string): Thread[] {
    const threads = this.sql.exec(`SELECT * FROM threads WHERE artifact_id = ? ORDER BY at`, id).toArray();
    const comments = new Map<string, ThreadComment[]>();
    for (const c of this.sql.exec(`SELECT * FROM comments WHERE artifact_id = ? ORDER BY seq`, id)) {
      const list = comments.get(c.thread_id as string) ?? [];
      list.push({ id: c.id as string, by: c.by as string, text: c.text as string, at: c.at as string, seq: c.seq as number });
      comments.set(c.thread_id as string, list);
    }
    return threads.map((t) => toThread(t, comments.get(t.id as string) ?? []));
  }

  private thread(threadId: string): Thread | null {
    const t = this.sql.exec(`SELECT * FROM threads WHERE id = ?`, threadId).toArray()[0];
    if (!t) return null;
    const comments = this.sql
      .exec(`SELECT * FROM comments WHERE thread_id = ? ORDER BY seq`, threadId)
      .toArray()
      .map((c) => ({ id: c.id as string, by: c.by as string, text: c.text as string, at: c.at as string, seq: c.seq as number }));
    return toThread(t, comments);
  }

  /**
   * Start a thread (no `thread`) or reply to one. `actor` is an email or
   * "agent"; `onBehalf` is the person an agent acts for, who isn't notified
   * about their own agent's comments.
   */
  addComment(
    id: string,
    actor: Actor,
    input: { thread?: string; anchor?: Anchor | null; text: string; onBehalf?: string },
    origin?: string,
    cid?: string,
    role: Role | "agent" = "agent",
  ): Thread {
    const art = this.requireArtifact(id);
    if (actor !== "agent") {
      const recent = this.sql
        .exec(`SELECT COUNT(*) AS n FROM comments WHERE artifact_id = ? AND by = ? AND at > ?`, id, actor, new Date(Date.now() - 60_000).toISOString())
        .one().n as number;
      if (recent >= 20) throw new HubError("too many comments in a minute; wait a moment");
    }
    const text = String(input.text ?? "").trim();
    if (!text) throw new HubError("comment text is empty");
    if (text.length > COMMENT_MAX_CHARS) throw new HubError(`comments are limited to ${COMMENT_MAX_CHARS} characters`);
    this.withinCapacity();
    const comments = this.sql.exec(`SELECT COUNT(*) AS n FROM comments WHERE artifact_id = ?`, id).one().n as number;
    if (comments >= COMMENTS_PER_ARTIFACT_MAX) throw new HubError(`this artifact has ${COMMENTS_PER_ARTIFACT_MAX} comments, the most it can hold; delete old comments to add more`);
    const now = new Date().toISOString();
    let threadId = input.thread;
    const reply = Boolean(threadId);
    let participants: string[] = [];
    this.ctx.storage.transactionSync(() => {
      if (threadId) {
        const t = this.sql.exec(`SELECT id, by FROM threads WHERE id = ? AND artifact_id = ?`, threadId, id).toArray()[0];
        if (!t) throw new HubError(`no thread ${threadId} on ${id}`);
        const mayReopen = role !== "view" || t.by === actor;
        participants = this.sql
          .exec(`SELECT DISTINCT by FROM comments WHERE thread_id = ?`, threadId)
          .toArray()
          .map((r) => r.by as string);
        // A reply reopens a resolved thread, as in most review tools.
        if (mayReopen) this.sql.exec(`UPDATE threads SET resolved_by = NULL, resolved_at = NULL WHERE id = ? AND resolved_at IS NOT NULL`, threadId);
      } else {
        const anchor = cleanAnchor(input.anchor ?? null);
        threadId = `t${randomId(12)}`;
        this.sql.exec(
          `INSERT INTO threads (id, artifact_id, anchor, version, by, at) VALUES (?, ?, ?, ?, ?, ?)`,
          threadId,
          id,
          anchor ? JSON.stringify(anchor) : null,
          art.version as number,
          actor,
          now,
        );
      }
      const commentId = `c${randomId(12)}`;
      const seq = this.logEvent(id, actor, reply ? "reply" : "thread", { thread: threadId, comment: commentId, text: text.slice(0, 500) });
      this.sql.exec(
        `INSERT INTO comments (id, thread_id, artifact_id, by, text, at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        commentId,
        threadId,
        id,
        actor,
        text,
        now,
        seq,
      );
    });
    const thread = this.thread(threadId!)!;
    this.broadcast(id, { t: "thread", thread, cid });
    this.notifyComment(id, actor, { thread: threadId!, text, participants, reply, origin, onBehalf: input.onBehalf });
    return thread;
  }

  resolveThread(
    id: string,
    actor: Actor,
    threadId: string,
    resolved: boolean,
    opts: { role?: Role | "agent"; origin?: string; cid?: string; onBehalf?: string } = {},
  ): Thread {
    const role = opts.role ?? "agent";
    const t = this.sql.exec(`SELECT * FROM threads WHERE id = ? AND artifact_id = ?`, threadId, id).toArray()[0];
    if (!t) throw new HubError(`no thread ${threadId} on ${id}`);
    if (role === "view" && t.by !== actor) throw new HubError("only the thread's author or an editor can resolve it");
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE threads SET resolved_by = ?, resolved_at = ? WHERE id = ?`, resolved ? actor : null, resolved ? now : null, threadId);
      this.logEvent(id, actor, resolved ? "resolve" : "reopen", { thread: threadId });
    });
    const thread = this.thread(threadId)!;
    this.broadcast(id, { t: "thread", thread, cid: opts.cid });
    if (resolved) this.notifyResolved(id, actor, thread, opts.origin, opts.onBehalf);
    return thread;
  }

  deleteComment(id: string, actor: Actor, commentId: string, role: Role | "agent" = "agent", cid?: string): Thread | null {
    const c = this.sql.exec(`SELECT * FROM comments WHERE id = ? AND artifact_id = ?`, commentId, id).toArray()[0];
    if (!c) throw new HubError(`no comment ${commentId}`);
    if (c.by !== actor && role !== "owner" && role !== "agent") throw new HubError("you can only delete your own comments");
    const threadId = c.thread_id as string;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM comments WHERE id = ?`, commentId);
      const left = this.sql.exec(`SELECT COUNT(*) AS n FROM comments WHERE thread_id = ?`, threadId).one().n as number;
      if (left === 0) this.sql.exec(`DELETE FROM threads WHERE id = ?`, threadId);
      this.logEvent(id, actor, "comment-delete", { thread: threadId, comment: commentId });
    });
    const thread = this.thread(threadId);
    // A deleted thread is sent as an empty one so viewers drop it.
    this.broadcast(id, {
      thread: thread ?? { id: threadId, anchor: null, version: 0, by: actor, at: "", resolved: null, comments: [] },
      t: "thread",
      cid,
    });
    return thread;
  }

  /**
   * People to @mention, with display names: the owner, exact-email shares and
   * commenters. A view-role viewer (`limitedTo`) only sees commenters and
   * themselves, so the share list stays private to editors.
   */
  private async people(id: string, limitedTo?: string): Promise<Person[]> {
    const owner = this.requireArtifact(id).owner as string;
    const emails = new Set(limitedTo ? [limitedTo] : [owner]);
    if (!limitedTo) {
      for (const r of this.sql.exec(`SELECT email FROM shares WHERE artifact_id = ? AND email LIKE '%_@%'`, id)) emails.add(r.email as string);
    }
    for (const r of this.sql.exec(`SELECT DISTINCT by FROM comments WHERE artifact_id = ? AND by LIKE '%@%'`, id)) emails.add(r.by as string);
    const names = await this.directory().names([...emails]);
    return [...emails].sort().map((email) => ({ email, name: names[email] ?? null }));
  }

  // ---- activity log ------------------------------------------------------------

  private logEvent(id: string, actor: Actor | null, type: string, data: Record<string, unknown>): number {
    const seq = this.sql
      .exec(`INSERT INTO events (artifact_id, at, actor, type, data) VALUES (?, ?, ?, ?, ?) RETURNING seq`, id, new Date().toISOString(), actor, type, JSON.stringify(data))
      .one().seq as number;
    if (seq % 100 === 0) {
      this.sql.exec(
        `DELETE FROM events WHERE artifact_id = ? AND seq <= (SELECT seq FROM events WHERE artifact_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
        id,
        id,
        EVENTS_KEEP,
      );
    }
    this.markDirty();
    // Webhook subscribers hear about it on the next alarm.
    this.wakeSubscriptions(id);
    return seq;
  }

  /** State changes are logged once per key and person per minute, so typing in Notes isn't one event per pause. */
  private logStateEvent(id: string, actor: Actor, key: string, value: JsonValue | null, created: boolean) {
    const summary = value === null ? null : JSON.stringify(value).slice(0, 400);
    // Only recent rows are candidates, so the scan stays small however long the log is.
    const floor = (this.sql.exec(`SELECT COALESCE(MAX(seq), 0) AS n FROM events`).one().n as number) - 200;
    const recent = this.sql
      .exec(
        `SELECT seq, data FROM events WHERE seq > ? AND artifact_id = ? AND type = 'state' AND actor = ? AND at > ?
         ORDER BY seq DESC`,
        floor,
        id,
        actor,
        new Date(Date.now() - 60_000).toISOString(),
      )
      .toArray()
      .find((r) => (JSON.parse(r.data as string) as { key?: string }).key === key);
    const wasCreated = recent ? Boolean((JSON.parse(recent.data as string) as { created?: boolean }).created) : false;
    // Replace rather than update in place, so the event moves past readers' cursors.
    if (recent) this.sql.exec(`DELETE FROM events WHERE seq = ?`, recent.seq);
    this.logEvent(id, actor, "state", { key, value: summary, ...(created || wasCreated ? { created: true } : {}) });
  }

  /**
   * Events after `since` (one artifact, or every artifact `email` can see),
   * oldest first, with each artifact's title.
   */
  activity(input: { id?: string; since?: number; limit?: number; email?: string }) {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const latest = this.sql.exec(`SELECT COALESCE(MAX(seq), 0) AS n FROM events`).one().n as number;
    // `where` filters the events table aliased as e; the visibility subquery keeps its own names.
    let where = "";
    const args: SqlStorageValue[] = [];
    if (input.id) {
      where = "AND e.artifact_id = ?";
      args.push(input.id);
    } else if (input.email && this.memberRole(input.email) !== "admin") {
      const visible = this.visibleSql(input.email);
      where = `AND e.artifact_id IN (${visible.sql})`;
      args.push(...visible.args);
    }
    // Without a cursor, start from the most recent `limit` events (of what's visible).
    const since =
      input.since ??
      ((this.sql.exec(`SELECT MIN(seq) AS s FROM (SELECT e.seq FROM events e WHERE 1 ${where} ORDER BY e.seq DESC LIMIT ?)`, ...args, limit).one()
        .s as number | null) ?? latest + 1) - 1;
    const rows = this.sql
      .exec(
        `SELECT e.*, a.title AS title FROM events e JOIN artifacts a ON a.id = e.artifact_id
         WHERE e.seq > ? ${where} ORDER BY e.seq LIMIT ?`,
        since,
        ...args,
        limit,
      )
      .toArray();
    const events = rows.map((r) => ({
      seq: r.seq as number,
      at: r.at as string,
      artifact: r.artifact_id as string,
      title: r.title as string,
      actor: (r.actor as string | null) ?? null,
      type: r.type as string,
      ...(JSON.parse(r.data as string) as Record<string, unknown>),
    }));
    const cursor = events.length ? events[events.length - 1].seq : Math.max(since, input.since ?? latest);
    return { events, cursor, more: events.length === limit };
  }

  // ---- visits ("changed since you last looked") ------------------------------

  /**
   * Called when a signed-in viewer opens the artifact. Returns what changed
   * since their previous visit and their read position for comments, then
   * records this visit.
   */
  visit(id: string, email: string): { since?: SinceLastVisit; readSeq: number; watch: WatchLevel; pinned: boolean } {
    const art = this.requireArtifact(id);
    const version = art.version as number;
    const prev = this.sql.exec(`SELECT * FROM seen WHERE email = ? AND artifact_id = ?`, email, id).toArray()[0];
    const latestSeq = this.sql.exec(`SELECT COALESCE(MAX(seq), 0) AS n FROM events`).one().n as number;
    let since: SinceLastVisit | undefined;
    // A reload soon after seeing the banner shows it again instead of losing it.
    const recentBanner =
      prev && prev.since_version !== null && (prev.version as number) === version && Date.now() - Date.parse(prev.at as string) < 30 * 60_000;
    const from = prev ? (recentBanner ? (prev.since_version as number) : (prev.version as number)) : version;
    if (prev && from < version) {
      const versions = this.sql
        .exec(`SELECT version, note, created_at FROM history WHERE artifact_id = ? AND version > ? ORDER BY version DESC LIMIT 20`, id, from)
        .toArray()
        .map((r) => ({ version: r.version as number, note: r.note as string, at: r.created_at as string }));
      const blocksOf = (v: number): BlockInfo[] | null => {
        const r = this.sql.exec(`SELECT blocks FROM history WHERE artifact_id = ? AND version = ?`, id, v).toArray()[0];
        return r?.blocks ? (JSON.parse(r.blocks as string) as BlockInfo[]) : null;
      };
      const before = blocksOf(from);
      const after = blocksOf(version);
      const diff = before && after ? diffBlocks(before, after) : { changed: [], removedHeadings: [] };
      since = { fromVersion: from, at: (recentBanner ? prev.since_at : prev.at) as string, versions, changedBlocks: diff.changed, removedHeadings: diff.removedHeadings };
    }
    const readSeq = prev ? (prev.read_seq as number) : latestSeq;
    const keepAt = recentBanner ? (prev.at as string) : new Date().toISOString();
    this.sql.exec(
      `INSERT INTO seen (email, artifact_id, version, read_seq, at, since_version, since_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (email, artifact_id) DO UPDATE SET version = excluded.version, at = excluded.at,
         since_version = excluded.since_version, since_at = excluded.since_at`,
      email,
      id,
      version,
      readSeq,
      keepAt,
      since ? from : null,
      since ? since.at : null,
    );
    return { since, readSeq, watch: this.watchLevel(email, id), pinned: this.isPinned(email, id) };
  }

  /** "Got it" on the changed-since bar: it stays gone, even on a reload soon after. */
  dismissSince(id: string, email: string) {
    this.sql.exec(`UPDATE seen SET since_version = NULL, since_at = NULL WHERE email = ? AND artifact_id = ?`, email, id);
  }

  private isPinned(email: string, id: string): boolean {
    return this.sql.exec(`SELECT 1 FROM pins WHERE email = ? AND artifact_id = ?`, email, id).toArray().length > 0;
  }

  /** Pin an artifact to the top of this person's own list, or unpin it. Nobody else sees it. */
  setPin(email: string, id: string, pinned: boolean): { pinned: boolean; pinnedAt: string | null } {
    if (!this.canOpen(id, email)) throw new HubError(`No artifact ${id}`);
    if (pinned) {
      const count = this.sql.exec(`SELECT COUNT(*) AS n FROM pins WHERE email = ?`, email).one().n as number;
      if (count >= PINS_PER_PERSON && !this.isPinned(email, id)) throw new HubError(`You can pin up to ${PINS_PER_PERSON} artifacts; unpin one first.`);
      this.sql.exec(`INSERT INTO pins (email, artifact_id, pinned_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, email, id, new Date().toISOString());
    } else this.sql.exec(`DELETE FROM pins WHERE email = ? AND artifact_id = ?`, email, id);
    this.markDirty();
    const row = this.sql.exec(`SELECT pinned_at FROM pins WHERE email = ? AND artifact_id = ?`, email, id).toArray()[0];
    return { pinned, pinnedAt: (row?.pinned_at as string | undefined) ?? null };
  }

  /**
   * Who has opened the artifact signed in and can still open it, with the
   * version they last saw and when, most recent first. The owner isn't listed;
   * anonymous visitors on a public link leave no record.
   */
  readers(id: string): { email: string; version: number; at: string }[] {
    const owner = this.requireArtifact(id).owner as string;
    return this.sql
      .exec(`SELECT email, version, at FROM seen WHERE artifact_id = ? AND email != ? ORDER BY at DESC LIMIT 500`, id, owner)
      .toArray()
      .filter((r) => this.canOpen(id, r.email as string))
      .map((r) => ({ email: r.email as string, version: r.version as number, at: r.at as string }));
  }

  private markRead(id: string, email: string, seq: number) {
    this.sql.exec(`UPDATE seen SET read_seq = MAX(read_seq, ?) WHERE email = ? AND artifact_id = ?`, Math.floor(seq), email, id);
  }

  // ---- link previews -----------------------------------------------------------

  /** What a link-preview fetcher may see: title and screenshot only when the owner opted in or the artifact is public. */
  previewInfo(id: string): { rich: boolean; title: string; description: string; version: number; image: boolean } | null {
    const row = this.sql.exec(`SELECT * FROM artifacts WHERE id = ?`, id).toArray()[0];
    if (!row) return null;
    const rich = Boolean(row.preview) || isPublic(row);
    const shot = this.sql.exec(`SELECT screenshot IS NOT NULL AS has FROM checks WHERE artifact_id = ?`, id).toArray()[0];
    return { rich, title: row.title as string, description: row.description as string, version: row.version as number, image: rich && Boolean(shot?.has) };
  }

  /** The stored first-screen screenshot (JPEG), only for artifacts with rich previews. */
  previewImage(id: string): ArrayBuffer | null {
    if (!this.previewInfo(id)?.rich) return null;
    return (this.sql.exec(`SELECT screenshot FROM checks WHERE artifact_id = ?`, id).toArray()[0]?.screenshot as ArrayBuffer | null) ?? null;
  }

  // ---- notification levels ----------------------------------------------------------

  /** Notification level for every artifact this person can see. */
  watches(email: string) {
    const levels = new Map(
      this.sql.exec(`SELECT artifact_id, level FROM watches WHERE email = ?`, email).toArray().map((r) => [r.artifact_id as string, r.level as WatchLevel]),
    );
    const fallback = this.watchDefault(email);
    const all = this.list(email).filter((a) => !a.archivedAt);
    // Everything set apart, plus the most recent of the rest: thousands of artifacts mustn't make one huge page.
    const shown = [...all.filter((a) => levels.has(a.id)), ...all.filter((a) => !levels.has(a.id)).slice(0, WATCHES_SHOWN)];
    return shown.map((a) => ({
      id: a.id,
      title: a.title,
      level: levels.get(a.id) ?? fallback ?? defaultLevel(a.owner === email),
      custom: levels.has(a.id),
    }));
  }

  /** How many active artifacts this person can see (the notifications page lists only some). */
  visibleCount(email: string): number {
    return this.list(email).filter((a) => !a.archivedAt).length;
  }

  /** This person's default level for the whole workspace, or null for the standard one (everything on what you own, replies and mentions elsewhere). */
  watchDefault(email: string): WatchLevel | null {
    return (this.sql.exec(`SELECT level FROM watch_defaults WHERE email = ?`, email).toArray()[0]?.level as WatchLevel | undefined) ?? null;
  }

  setWatchDefault(email: string, level: WatchLevel | null): WatchLevel | null {
    if (level === null) this.sql.exec(`DELETE FROM watch_defaults WHERE email = ?`, email);
    else {
      if (!["all", "participating", "mute"].includes(level)) throw new HubError(`unknown level ${level}`);
      this.sql.exec(`INSERT INTO watch_defaults (email, level) VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET level = excluded.level`, email, level);
    }
    this.markDirty();
    return this.watchDefault(email);
  }

  /** Who might want every event on an artifact: "all" chosen for it, or as their workspace default. Callers still check watchLevel. */
  private allWatchers(id: string): string[] {
    return this.sql
      .exec(`SELECT email FROM watches WHERE artifact_id = ? AND level = 'all' UNION SELECT email FROM watch_defaults WHERE level = 'all'`, id)
      .toArray()
      .map((r) => r.email as string);
  }

  setWatch(email: string, id: string, level: WatchLevel | null): WatchLevel {
    this.requireArtifact(id);
    if (level === null) this.sql.exec(`DELETE FROM watches WHERE email = ? AND artifact_id = ?`, email, id);
    else {
      if (!["all", "participating", "mute"].includes(level)) throw new HubError(`unknown level ${level}`);
      this.sql.exec(
        `INSERT INTO watches (email, artifact_id, level) VALUES (?, ?, ?) ON CONFLICT (email, artifact_id) DO UPDATE SET level = excluded.level`,
        email,
        id,
        level,
      );
    }
    this.markDirty();
    return this.watchLevel(email, id);
  }

  /** The artifact's own choice, else the person's workspace default, else the standard default. */
  private watchLevel(email: string, id: string): WatchLevel {
    const row = this.sql.exec(`SELECT level FROM watches WHERE email = ? AND artifact_id = ?`, email, id).toArray()[0];
    if (row) return row.level as WatchLevel;
    const fallback = this.watchDefault(email);
    if (fallback) return fallback;
    const owner = this.sql.exec(`SELECT owner FROM artifacts WHERE id = ?`, id).toArray()[0]?.owner;
    return defaultLevel(owner === email);
  }

  // ---- notifications -------------------------------------------------------------

  /**
   * Queue notifications for a new comment. Mentions and replies to threads you
   * took part in reach "participating" watchers; every comment reaches "all"
   * watchers (the owner by default). Muted people get nothing.
   */
  private notifyComment(
    id: string,
    actor: Actor,
    c: { thread: string; text: string; participants: string[]; reply: boolean; origin?: string; onBehalf?: string },
  ) {
    const owner = this.requireArtifact(id).owner as string;
    const mentioned = new Set(mentionedEmails(c.text));
    const participants = new Set(c.participants);
    const candidates = new Set<string>([...mentioned, ...participants, owner]);
    for (const email of this.allWatchers(id)) candidates.add(email);
    for (const email of candidates) {
      // Nobody hears about their own comments, or their own agent's.
      if (email === actor || email === c.onBehalf || !email.includes("@")) continue;
      const level = this.watchLevel(email, id);
      if (level === "mute") continue;
      const why = mentioned.has(email) ? "mention" : participants.has(email) ? "reply" : "all";
      if (why === "all" && level !== "all") continue;
      if (!this.canOpen(id, email)) continue;
      this.enqueue(email, id, "comment", { thread: c.thread, by: actor, text: c.text.slice(0, 300), why, reply: c.reply, origin: c.origin }, COMMENT_DELAY_MS);
    }
    void this.armAlarm();
  }

  /** Approval decisions and form responses reach "all" watchers (the owner by default), batched like comments. */
  private notifyResponse(
    id: string,
    actor: Actor,
    r: { component: "approval" | "form"; block: string; decision?: string; note?: string; changed: boolean; origin?: string },
  ) {
    const owner = this.requireArtifact(id).owner as string;
    const candidates = new Set<string>([owner]);
    for (const email of this.allWatchers(id)) candidates.add(email);
    for (const email of candidates) {
      if (email === actor || !email.includes("@") || this.watchLevel(email, id) !== "all" || !this.canOpen(id, email)) continue;
      this.enqueue(email, id, "response", { ...r, by: actor }, COMMENT_DELAY_MS);
    }
    void this.armAlarm();
  }

  private notifyResolved(id: string, actor: Actor, thread: Thread, origin?: string, onBehalf?: string) {
    const author = thread.by;
    if (author === actor || author === onBehalf || !author.includes("@") || this.watchLevel(author, id) === "mute" || !this.canOpen(id, author)) return;
    this.enqueue(author, id, "resolve", { thread: thread.id, by: actor, addressedIn: thread.addressedIn ?? null, origin }, COMMENT_DELAY_MS);
    void this.armAlarm();
  }

  /** Page updates reach "all" watchers, except whoever made them (or had their agent make them), batched over a quiet period. */
  private notifyUpdate(id: string, actor: Actor, version: number, note: string, origin?: string, onBehalf?: string) {
    for (const email of this.allWatchers(id)) {
      if (email === actor || email === onBehalf || this.watchLevel(email, id) !== "all" || !this.canOpen(id, email)) continue;
      const pending = this.sql.exec(`SELECT id, data FROM outbox WHERE email = ? AND artifact_id = ? AND kind = 'update'`, email, id).toArray()[0];
      if (pending) {
        const data = JSON.parse(pending.data as string) as { notes: string[]; first: number; version: number };
        data.notes = [...data.notes, note].slice(-5);
        data.version = version;
        const due = Math.min(data.first + UPDATE_MAX_WAIT_MS, Date.now() + UPDATE_DELAY_MS);
        this.sql.exec(`UPDATE outbox SET data = ?, due_at = ? WHERE id = ?`, JSON.stringify(data), due, pending.id);
      } else {
        this.enqueue(email, id, "update", { version, notes: [note], first: Date.now(), origin }, UPDATE_DELAY_MS);
      }
    }
    void this.armAlarm();
  }

  /**
   * A new version makes decisions on the previous one stale: tell those people
   * the page changed under their approval (or request for changes), once, so
   * they can take another look. Batched with page updates, since agents edit
   * in runs; a later version in the same batch only moves the version on.
   */
  private notifyStale(id: string, actor: Actor, previous: number, version: number, note: string, origin?: string, onBehalf?: string) {
    // Notices still waiting to go out now name the latest version.
    this.sql.exec(`UPDATE outbox SET data = json_set(data, '$.version', ?, '$.note', ?) WHERE artifact_id = ? AND kind = 'stale'`, version, note, id);
    const rows = this.sql.exec(`SELECT key, value FROM state WHERE artifact_id = ? AND key LIKE 'approve/%'`, id).toArray();
    for (const r of rows) {
      const m = RESPONSE_KEY.exec(r.key as string);
      const d = JSON.parse(r.value as string) as { decision?: string; version?: number };
      // Only decisions this change made stale; older ones were told when they went stale.
      if (!m || d.version !== previous || (d.decision !== "approve" && d.decision !== "changes")) continue;
      const email = m[3];
      if (email === actor || email === onBehalf || this.watchLevel(email, id) === "mute" || !this.canOpen(id, email)) continue;
      const pending = this.sql.exec(`SELECT 1 FROM outbox WHERE email = ? AND artifact_id = ? AND kind = 'stale'`, email, id).toArray().length > 0;
      if (!pending) this.enqueue(email, id, "stale", { block: m[2], decision: d.decision, seenVersion: previous, version, note, origin }, UPDATE_DELAY_MS);
    }
    void this.armAlarm();
  }

  private canOpen(id: string, email: string): boolean {
    return this.roleFor(id, email) !== null;
  }

  private enqueue(email: string, id: string, kind: string, data: Record<string, unknown>, delayMs: number) {
    this.sql.exec(
      `INSERT INTO outbox (email, artifact_id, kind, data, due_at) VALUES (?, ?, ?, ?, ?)`,
      email,
      id,
      kind,
      JSON.stringify(data),
      Date.now() + delayMs,
    );
  }

  /** Send due notifications, one message per person and artifact, skipping people who have the page open. */
  async deliverDue(now = Date.now()): Promise<number> {
    const due = this.sql.exec(`SELECT * FROM outbox WHERE due_at <= ? ORDER BY due_at`, now).toArray();
    if (!due.length) return 0;
    const groups = new Map<string, Record<string, SqlStorageValue>[]>();
    for (const row of due) {
      const k = `${row.email}\n${row.artifact_id}`;
      groups.set(k, [...(groups.get(k) ?? []), row]);
    }
    const directory = this.directory();
    const recipients = [...new Set(due.map((r) => r.email as string))];
    const channels = await directory.channelsFor(recipients);
    const actors = due.map((r) => (JSON.parse(r.data as string) as { by?: string }).by).filter((b): b is string => Boolean(b?.includes("@")));
    const names = await directory.names(actors);
    let sends = 0;
    const results: { id: string; result: { ok: boolean; error?: string; gone?: boolean } }[] = [];
    const inbox: { email: string; kind: string; title: string; body: string; url: string }[] = [];
    for (const group of groups.values()) {
      const email = group[0].email as string;
      const id = group[0].artifact_id as string;
      const mine = channels[email] ?? [];
      if (sends + mine.length > SENDS_PER_ALARM && sends > 0) break;
      // Claim the rows as they are now: an update coalesced into one of them
      // during the awaits above (pushing it later) stays queued.
      const rows = this.sql
        .exec(`DELETE FROM outbox WHERE id IN (${group.map(() => "?").join(", ")}) AND due_at <= ? RETURNING *`, ...group.map((r) => r.id), now)
        .toArray();
      if (!rows.length) continue;
      const art = this.sql.exec(`SELECT title FROM artifacts WHERE id = ?`, id).toArray()[0];
      if (!art || this.isViewing(id, email) || !this.canOpen(id, email)) continue;
      const items: OutboxItem[] = rows.map((r) => ({ kind: r.kind as OutboxItem["kind"], data: JSON.parse(r.data as string) }));
      const origin = items.map((i) => i.data.origin).find((o): o is string => typeof o === "string" && o !== "") ?? this.setting("origin") ?? "";
      const msg = composeMessage({ title: art.title as string, artifactId: id, origin, items, nameOf: (e) => names[e] ?? null });
      // Every notification also lands in the person's inbox, whatever channels they have (or none).
      inbox.push({ email, kind: "notification", title: msg.title, body: msg.body, url: msg.url });
      if (!mine.length) continue;
      for (const c of mine) {
        // Notification emails share the workspace's daily email allowance.
        // Over today's email allowance, other channels (push, webhooks) still carry it.
        if (c.type === "email" && !this.allowMail(1, undefined, "notify")) continue;
        sends++;
        const result = await sendToChannel(c.type, c.config, msg, this.hubEnv).catch((err: Error) => ({ ok: false as const, error: err.message }));
        results.push({ id: c.id, result });
      }
    }
    if (results.length) await directory.recordChannelResults(results);
    if (inbox.length) {
      await Promise.resolve()
        .then(() => directory.addInboxMany(inbox))
        .catch((err: unknown) => console.error(JSON.stringify({ ops: "inbox_failed", slug: this.info().slug, message: (err as Error).message })));
    }
    return sends;
  }

  private isViewing(id: string, email: string): boolean {
    return this.ctx.getWebSockets(id).some((ws) => (ws.deserializeAttachment() as SocketTag).email === email);
  }

  // ---- MCP events -------------------------------------------------------------

  /** Occurrences of `name` after `seq` that `principal` may see, oldest first, scanning at most `scan` log rows. */
  private occurrences(principal: string, name: EventName, args: EventArgs, after: number, scan: number, limit: number) {
    const origin = this.setting("origin") ?? "";
    const rows = this.sql
      .exec(`SELECT e.*, a.title AS title FROM events e JOIN artifacts a ON a.id = e.artifact_id WHERE e.seq > ? ORDER BY e.seq LIMIT ?`, after, scan)
      .toArray();
    const out: Occurrence[] = [];
    let last = after;
    for (const r of rows) {
      const e: LoggedEvent = {
        seq: r.seq as number, at: r.at as string, artifact: r.artifact_id as string, title: r.title as string,
        actor: (r.actor as string | null) ?? null, type: r.type as string, data: JSON.parse(r.data as string),
      };
      // The log keeps a short summary of state values; the answer itself is read from shared state.
      const key = e.type === "state" ? String(e.data.key) : null;
      const current = key && /^(approve|form|poll|comments)\//.test(key) ? this.sql.exec(`SELECT value FROM state WHERE artifact_id = ? AND key = ?`, e.artifact, key).toArray()[0] : undefined;
      const o = toOccurrence(e, name, origin, current ? JSON.parse(current.value as string) : undefined, EVENT_TEXT_MAX);
      if (o && matches(o, args) && this.canOpen(e.artifact, principal)) {
        if (out.length >= limit) return { events: out, last, more: true };
        out.push({ ...o, cursor: cursorOf(e.seq) });
      }
      last = e.seq;
    }
    return { events: out, last, more: rows.length === scan };
  }

  private latestSeq(): number {
    return this.sql.exec(`SELECT COALESCE(MAX(seq), 0) AS n FROM events`).one().n as number;
  }

  /**
   * Where replay starts for a client's cursor: the cursor itself, unless the log
   * no longer reaches back that far or `maxAgeMs` cuts it shorter (truncated).
   */
  private replayFrom(cursor: unknown, maxAgeMs: unknown): { seq: number; truncated: boolean } {
    const requested = seqOf(cursor);
    const latest = this.latestSeq();
    if (requested === null || requested >= latest) return { seq: Math.min(requested ?? latest, latest), truncated: false };
    let floor = (this.sql.exec(`SELECT COALESCE(MIN(seq), 1) AS n FROM events`).one().n as number) - 1;
    if (typeof maxAgeMs === "number" && maxAgeMs >= 0) {
      const since = new Date(Date.now() - maxAgeMs).toISOString();
      const first = this.sql.exec(`SELECT MIN(seq) AS n FROM events WHERE at >= ?`, since).one().n as number | null;
      floor = Math.max(floor, (first ?? latest + 1) - 1);
    }
    return requested < floor ? { seq: floor, truncated: true } : { seq: requested, truncated: false };
  }

  private requireVisible(principal: string, args: EventArgs) {
    if (args.artifact && !this.canOpen(args.artifact, principal)) {
      throw new EventsFailure(EVENT_ERRORS.Forbidden, `No artifact ${args.artifact} that you can open.`);
    }
  }

  /** events/poll: one subscription's events after its cursor; nothing is stored here. */
  eventsPoll(principal: string, input: PollInput) {
    return eventsResult(() => {
      const { name, args } = parseArgs(input.name, input.arguments);
      this.requireVisible(principal, args);
      const from = this.replayFrom(input.cursor, input.maxAgeMs);
      if (input.cursor === null || input.cursor === undefined) {
        return { events: [], cursor: cursorOf(from.seq), truncated: false, hasMore: false, nextPollMs: EVENT_POLL_MS };
      }
      const max = typeof input.maxEvents === "number" && input.maxEvents >= 1 ? Math.min(Math.floor(input.maxEvents), 100) : 50;
      const r = this.occurrences(principal, name, args, from.seq, EVENT_POLL_SCAN, max);
      // Poll results carry the cursor once, at the top.
      const events = r.events.map(({ cursor: _c, ...o }) => o);
      return { events, cursor: cursorOf(r.last), truncated: from.truncated, hasMore: r.more, nextPollMs: EVENT_POLL_MS };
    });
  }

  /**
   * events/subscribe (webhook): create or refresh a subscription. A new
   * callback URL must answer a signed challenge first, so nobody can point
   * deliveries at someone else's endpoint.
   */
  async eventsSubscribe(principal: string, input: SubscribeInput) {
    return eventsResult(async () => {
      const { name, args } = parseArgs(input.name, input.arguments);
      this.requireVisible(principal, args);
      const delivery = input.delivery ?? {};
      if (delivery.mode !== undefined && delivery.mode !== "webhook") {
        throw new EventsFailure(EVENT_ERRORS.Unsupported, "events/subscribe is for webhook delivery; poll with events/poll.", { feature: "deliveryMode", value: delivery.mode });
      }
      const url = callbackUrl(delivery.url);
      const secret = String(delivery.secret ?? "");
      secretBytes(secret);
      const from = this.replayFrom(input.cursor, input.maxAgeMs);
      const id = await subscriptionId(principal, url, name, args);
      const ttl = typeof input.ttlMs === "number" ? input.ttlMs : EVENT_TTL_DEFAULT_MS;
      const now = Date.now();
      const live = () => this.sql.exec(`SELECT * FROM event_subs WHERE id = ? AND expires_at > ?`, id, Date.now()).toArray()[0];
      const roomFor = () => {
        const mine = this.sql.exec(`SELECT COUNT(*) AS n FROM event_subs WHERE principal = ? AND expires_at > ?`, principal, Date.now()).one().n as number;
        if (mine >= EVENT_SUBS_PER_PERSON) {
          throw new EventsFailure(EVENT_ERRORS.ResourceExhausted, `At most ${EVENT_SUBS_PER_PERSON} event subscriptions per person; unsubscribe one first.`, { limit: "subscriptions", max: EVENT_SUBS_PER_PERSON });
        }
      };
      let existing = live();
      if (!existing) roomFor();
      const verified = this.sql.exec(`SELECT verified_until FROM event_receivers WHERE principal = ? AND url = ?`, principal, url).toArray()[0];
      // A new endpoint, or a new secret it hasn't proven it holds, answers a challenge first.
      if (!verified || (verified.verified_until as number) < now || (existing && existing.secret !== secret)) {
        this.sql.exec(`DELETE FROM event_verifications WHERE at < ?`, now - HOUR_MS);
        const recent = this.sql.exec(`SELECT COUNT(*) AS n FROM event_verifications WHERE principal = ?`, principal).one().n as number;
        if (recent >= EVENT_VERIFICATIONS_PER_HOUR) {
          throw new EventsFailure(EVENT_ERRORS.ResourceExhausted, "Too many new webhook endpoints this hour; try again later.", { limit: "verifications", max: EVENT_VERIFICATIONS_PER_HOUR });
        }
        this.sql.exec(`INSERT INTO event_verifications (principal, at) VALUES (?, ?)`, principal, now);
        await verifyReceiver(url, id, secret);
        this.sql.exec(
          `INSERT INTO event_receivers (principal, url, verified_until) VALUES (?, ?, ?) ON CONFLICT (principal, url) DO UPDATE SET verified_until = excluded.verified_until`,
          principal,
          url,
          Date.now() + RECEIVER_VERIFIED_MS,
        );
        // Other requests may have run during the challenge.
        existing = live();
        if (!existing) roomFor();
      }
      // No subscription outlives a day: a client that stops refreshing is forgotten by then.
      const expires = Date.now() + Math.min(Math.max(ttl, EVENT_TTL_MIN_MS), EVENT_TTL_MAX_MS);
      if (existing) {
        // A live subscription keeps its position and any retry in progress; a refresh revives a suspended one.
        const rotated = existing.secret !== secret;
        const pending = (existing.attempts as number) > 0 && existing.next_at !== null && !existing.suspended;
        this.sql.exec(
          `UPDATE event_subs SET secret = ?, old_secret = ?, old_secret_until = ?, expires_at = ?, suspended = 0, next_at = ? WHERE id = ?`,
          secret,
          rotated ? existing.secret : existing.old_secret,
          rotated ? Date.now() + SECRET_GRACE_MS : existing.old_secret_until,
          expires,
          pending ? existing.next_at : Date.now() + EVENT_DELAY_MS,
          id,
        );
      } else {
        // New, or lapsed and not yet swept: delivery starts from the client's cursor.
        this.sql.exec(`DELETE FROM event_subs WHERE id = ?`, id);
        this.sql.exec(
          `INSERT INTO event_subs (id, principal, url, name, args, secret, cursor_seq, expires_at, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          principal,
          url,
          name,
          canonicalArgs(args),
          secret,
          from.seq,
          expires,
          Date.now() + EVENT_DELAY_MS,
          new Date().toISOString(),
        );
      }
      await this.armAlarm();
      const row = this.sql.exec(`SELECT * FROM event_subs WHERE id = ?`, id).one();
      return {
        id,
        refreshBefore: new Date(expires).toISOString(),
        cursor: cursorOf(row.cursor_seq as number),
        truncated: existing ? false : from.truncated,
        ...(existing
          ? {
              deliveryStatus: {
                active: true,
                lastDeliveryAt: (row.last_delivery_at as string | null) ?? null,
                lastError: (row.last_error as string | null) ?? null,
                ...(row.failed_since ? { failedSince: row.failed_since as string } : {}),
              },
            }
          : {}),
      };
    });
  }

  /** events/unsubscribe: stop a webhook subscription now. */
  async eventsUnsubscribe(principal: string, input: UnsubscribeInput) {
    return eventsResult(async () => {
      const { name, args } = parseArgs(input.name, input.arguments);
      const id = await subscriptionId(principal, callbackUrl(input.delivery?.url), name, args);
      if (!this.sql.exec(`DELETE FROM event_subs WHERE id = ?`, id).rowsWritten) {
        throw new EventsFailure(EVENT_ERRORS.NotFound, "No such subscription.", { kind: "subscription" });
      }
      return {};
    });
  }

  /** Wakes the subscriptions an event could matter to: unfiltered ones, and those filtered to its artifact. */
  private wakeSubscriptions(artifact: string) {
    const woken = this.sql.exec(
      `UPDATE event_subs SET next_at = ? WHERE next_at IS NULL AND suspended = 0 AND attempts = 0
         AND (json_extract(args, '$.artifact') IS NULL OR json_extract(args, '$.artifact') = ?)`,
      Date.now() + EVENT_DELAY_MS,
      artifact,
    ).rowsWritten;
    if (woken) void this.armAlarm();
  }

  /**
   * Webhook delivery, from the alarm: each due subscription gets its events in
   * order, one POST each, within a time budget so a slow endpoint can't keep
   * the workspace awake. Expired subscriptions are dropped first.
   */
  async deliverEvents(now = Date.now()) {
    this.sql.exec(`DELETE FROM event_subs WHERE expires_at <= ?`, now);
    this.sql.exec(`DELETE FROM event_receivers WHERE verified_until <= ?`, now);
    const due = this.sql.exec(`SELECT * FROM event_subs WHERE next_at IS NOT NULL AND next_at <= ? ORDER BY next_at LIMIT 50`, now).toArray();
    const deadline = Date.now() + EVENT_DELIVERY_BUDGET_MS;
    let sends = 0;
    for (const sub of due) {
      if (Date.now() >= deadline || sends >= SENDS_PER_ALARM) break;
      try {
        sends += await this.deliverTo(sub, now, deadline, SENDS_PER_ALARM - sends);
      } catch (err) {
        // One broken subscription doesn't hold up the rest; it tries again later.
        console.error(JSON.stringify({ ops: "event_delivery_failed", slug: this.info().slug, message: (err as Error).message }));
        this.sql.exec(`UPDATE event_subs SET next_at = ? WHERE id = ?`, now + EVENT_RETRY_MS[1], sub.id);
      }
    }
    return sends;
  }

  /** Delivers one subscription's pending events; returns how many POSTs it made. */
  private async deliverTo(sub: Record<string, SqlStorageValue>, now: number, deadline: number, maxSends: number): Promise<number> {
    const id = sub.id as string;
    const principal = sub.principal as string;
    const url = sub.url as string;
    const secrets = [sub.secret as string, ...(sub.old_secret && (sub.old_secret_until as number) > now ? [sub.old_secret as string] : [])];
    if (!this.memberRole(principal)) {
      // Removed from the workspace: say so once, and forget the subscription.
      const body = JSON.stringify({ type: "terminated", error: { code: EVENT_ERRORS.Forbidden, message: "Forbidden", data: { reason: "Access revoked" } } });
      await postWebhook(url, id, `msg_terminated_${randomId(12)}`, body, secrets);
      this.sql.exec(`DELETE FROM event_subs WHERE id = ?`, id);
      return 1;
    }
    const batch = this.occurrences(principal, sub.name as EventName, JSON.parse(sub.args as string) as EventArgs, sub.cursor_seq as number, EVENT_SCAN, 20);
    let cursor = sub.cursor_seq as number;
    let sends = 0;
    let failure: DeliveryError | null = null;
    let stopped = false;
    for (const o of batch.events) {
      if (sends >= maxSends || Date.now() >= deadline) {
        stopped = true;
        break;
      }
      sends++;
      const result = await postWebhook(url, id, o.eventId, JSON.stringify(o), secrets);
      // 410 (the receiver doesn't want it) and 413 (too large) aren't retried.
      if (result.ok || result.status === 410 || result.status === 413) {
        cursor = seqOf(o.cursor)!;
        if (result.ok) this.sql.exec(`UPDATE event_subs SET last_delivery_at = ?, last_error = NULL, failed_since = NULL WHERE id = ?`, new Date().toISOString(), id);
        continue;
      }
      failure = result.error!;
      break;
    }
    if (failure) {
      const attempts = (sub.attempts as number) + 1;
      // Out of retries: give up on that event (its cursor still lets the client replay it) and go on.
      const giveUp = attempts > EVENT_RETRY_MS.length;
      if (giveUp) cursor = seqOf(batch.events.find((o) => seqOf(o.cursor)! > cursor)!.cursor)!;
      const failedSince = (sub.failed_since as string | null) ?? new Date(now).toISOString();
      // Failing for an hour: stop until the client refreshes, which is its sign it still wants these.
      const suspend = now - Date.parse(failedSince) >= EVENT_SUSPEND_AFTER_MS;
      this.sql.exec(
        `UPDATE event_subs SET cursor_seq = ?, attempts = ?, next_at = ?, suspended = ?, last_error = ?, failed_since = ? WHERE id = ?`,
        cursor,
        giveUp ? 0 : attempts,
        suspend ? null : now + (giveUp ? EVENT_DELAY_MS : EVENT_RETRY_MS[attempts - 1]),
        suspend ? 1 : 0,
        failure,
        failedSince,
        id,
      );
      return sends;
    }
    // Every scanned row is handled, matching or not, so the cursor moves past all of them.
    if (!stopped) cursor = Math.max(cursor, batch.last);
    // Anything logged while the POSTs were in flight couldn't wake this row (it was already due), so look again.
    const more = batch.more || stopped || cursor < this.latestSeq();
    this.sql.exec(`UPDATE event_subs SET cursor_seq = ?, attempts = 0, next_at = ? WHERE id = ?`, cursor, more ? Date.now() + 1000 : null, id);
    return sends;
  }

  // ---- internals -------------------------------------------------------------

  private async change(
    id: string,
    baseVersion: number | undefined,
    note: string,
    opts: ChangeOptions,
    mutate: (files: Record<string, string>) => void,
  ): Promise<WriteResult> {
    const row = this.requireArtifact(id);
    const current = row.version as number;
    const stale = (v: number, base: number): WriteResult => ({
      ok: false,
      version: v,
      errors: [{ path: "", message: `stale baseVersion ${base}; the artifact is at v${v}. Re-read and retry.` }],
    });
    if (baseVersion !== undefined && baseVersion !== current) return stale(current, baseVersion);
    const files = this.files(id);
    const before = Object.values(files).reduce((n, t) => n + t.length, 0);
    try {
      mutate(files);
      // Over the storage limit, edits that don't add bytes still go through, so people can trim.
      if (Object.values(files).reduce((n, t) => n + t.length, 0) > before) this.withinPlan("bytes");
      this.withinPlan("changesPerDay");
    } catch (err) {
      if (err instanceof EditError || err instanceof HubError) {
        return { ok: false, version: current, errors: [{ path: "", message: err.message }] };
      }
      throw err;
    }
    const { build, errors, warnings = [] } = await buildArtifact(files);
    if (!build) return { ok: false, version: current, errors };
    const hashes = await hashFiles(files);
    const next = current + 1;
    const now = new Date().toISOString();
    const resolves = (opts.resolves ?? []).filter((t) => this.sql.exec(`SELECT 1 FROM threads WHERE id = ? AND artifact_id = ?`, t, id).toArray().length > 0);
    const actor = opts.actor ?? "agent";
    let raced: number | null = null;
    this.ctx.storage.transactionSync(() => {
      // Another write may have landed while this one compiled.
      if (!this.sql.exec(`UPDATE artifacts SET version = ?, updated_at = ? WHERE id = ? AND version = ?`, next, now, id, current).rowsWritten) {
        raced = this.requireArtifact(id).version as number;
        return;
      }
      this.commitFiles(id, next, files, hashes, build, note, now);
      this.logEvent(id, actor, "version", { version: next, note, ...(resolves.length ? { resolves } : {}) });
      for (const t of resolves) {
        this.sql.exec(
          `UPDATE threads SET addressed_in = ?, resolved_by = COALESCE(resolved_by, ?), resolved_at = COALESCE(resolved_at, ?) WHERE id = ?`,
          next,
          actor,
          now,
          t,
        );
        this.logEvent(id, actor, "resolve", { thread: t, version: next });
      }
    });
    if (raced !== null) return stale(raced, current);
    this.broadcast(id, { t: "version", version: next, note });
    for (const t of resolves) {
      const thread = this.thread(t);
      if (!thread) continue;
      this.broadcast(id, { t: "thread", thread });
      this.notifyResolved(id, actor, thread, opts.origin, opts.onBehalf);
    }
    this.notifyUpdate(id, actor, next, note, opts.origin, opts.onBehalf);
    this.notifyStale(id, actor, current, next, note, opts.origin, opts.onBehalf);
    return { ok: true, id, version: next, files: Object.keys(files).sort(), ...(warnings.length ? { warnings } : {}) };
  }

  private commitFiles(id: string, version: number, files: Record<string, string>, hashes: Record<string, string>, build: Build, note: string, now: string) {
    this.sql.exec(`DELETE FROM files WHERE artifact_id = ?`, id);
    for (const [path, content] of Object.entries(files)) {
      this.sql.exec(`INSERT OR IGNORE INTO blobs (artifact_id, hash, content) VALUES (?, ?, ?)`, id, hashes[path], content);
      this.sql.exec(`INSERT INTO files (artifact_id, path, hash) VALUES (?, ?, ?)`, id, path, hashes[path]);
    }
    this.sql.exec(
      `INSERT INTO builds (artifact_id, version, build) VALUES (?, ?, ?)
       ON CONFLICT (artifact_id) DO UPDATE SET version = excluded.version, build = excluded.build`,
      id,
      version,
      JSON.stringify(build),
    );
    this.sql.exec(
      `INSERT INTO history (artifact_id, version, files, note, created_at, blocks) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      version,
      JSON.stringify(hashes),
      note,
      now,
      JSON.stringify(build.blocks ?? []),
    );
    this.sql.exec(`DELETE FROM history WHERE artifact_id = ? AND version <= ?`, id, version - HISTORY_KEEP);
    this.collectBlobs(id);
    setLinks(this.sql, id, files);
    this.countSave();
  }

  /** One batch of the links backfill (after the migration, or a restore); true while there's more. */
  private backfillLinks(): boolean {
    const after = this.setting("links_backfill");
    if (after === null) return false;
    const ids = this.sql.exec(`SELECT id FROM artifacts WHERE id > ? ORDER BY id LIMIT ?`, after, LINKS_BATCH).toArray().map((r) => r.id as string);
    for (const id of ids) {
      const files: Record<string, string> = {};
      for (const r of this.sql.exec(
        `SELECT f.path, b.content FROM files f JOIN blobs b ON b.artifact_id = f.artifact_id AND b.hash = f.hash WHERE f.artifact_id = ? AND f.path NOT LIKE 'data/%'`,
        id,
      )) {
        files[r.path as string] = r.content as string;
      }
      setLinks(this.sql, id, files);
    }
    this.setSetting("links_backfill", ids.length === LINKS_BATCH ? ids[ids.length - 1] : null);
    return ids.length === LINKS_BATCH;
  }

  /** Drop file contents that neither the current files nor any kept version use. */
  private collectBlobs(id: string) {
    const used = new Set(this.sql.exec(`SELECT hash FROM files WHERE artifact_id = ?`, id).toArray().map((r) => r.hash as string));
    for (const r of this.sql.exec(`SELECT files FROM history WHERE artifact_id = ?`, id)) {
      for (const h of Object.values(JSON.parse(r.files as string) as Record<string, string>)) used.add(h);
    }
    for (const r of this.sql.exec(`SELECT hash FROM blobs WHERE artifact_id = ?`, id).toArray()) {
      if (!used.has(r.hash as string)) this.sql.exec(`DELETE FROM blobs WHERE artifact_id = ? AND hash = ?`, id, r.hash);
    }
  }

  private requireArtifact(id: string) {
    const row = this.sql.exec(`SELECT * FROM artifacts WHERE id = ?`, id).toArray()[0];
    if (!row) throw new HubError(`no artifact ${id}; see artifact_list`);
    return row;
  }

  private broadcast(id: string, msg: SyncServerMessage) {
    const text = JSON.stringify(msg);
    const now = Date.now() / 1000;
    for (const ws of this.ctx.getWebSockets(id)) {
      const tag = ws.deserializeAttachment() as SocketTag;
      // Expired link sessions and public links get nothing more, even if they never send;
      // the page then asks for a reload, which re-checks access.
      if (tag.exp && now > tag.exp) {
        ws.close(4003, "access changed");
        continue;
      }
      if (msg.t === "thread" && !tag.email) continue;
      try {
        ws.send(text);
      } catch {
        // closed socket; the close handler cleans up presence
      }
    }
  }

  /** Close live sockets (one artifact's, or all) so they reconnect and are re-checked. */
  closeSockets(id?: string, code = 4003, reason = "access changed") {
    for (const ws of id ? this.ctx.getWebSockets(id) : this.ctx.getWebSockets()) ws.close(code, reason);
  }

  private broadcastPresence(id: string, closing?: WebSocket) {
    const viewers = new Set<string>();
    const sockets = this.ctx.getWebSockets(id).filter((ws) => ws !== closing);
    for (const ws of sockets) {
      const tag = ws.deserializeAttachment() as SocketTag;
      if (tag.email) viewers.add(tag.email);
    }
    // Who's here is for people signed in to it; an anonymous visitor on a public link sees nobody.
    const list = [...viewers].sort();
    for (const ws of sockets) {
      const tag = ws.deserializeAttachment() as SocketTag;
      try {
        send(ws, { t: "presence", viewers: tag.email ? list : [] });
      } catch {
        // closing
      }
    }
  }
}

function send(ws: WebSocket, msg: SyncServerMessage) {
  ws.send(JSON.stringify(msg));
}

/** Whether the public link works now: an expired one is the same as off. */
function isPublic(r: Record<string, SqlStorageValue>): boolean {
  return Boolean(r.public) && (r.public_until == null || (r.public_until as string) > new Date().toISOString());
}

/** A validated public-link expiry, normalized to ISO; null for none. */
function publicExpiry(until: string | null): string | null {
  if (until === null) return null;
  const at = Date.parse(until);
  if (!Number.isFinite(at)) throw new HubError(`"${until}" is not a time`);
  if (at <= Date.now()) throw new HubError("a public link's expiry must be in the future");
  // A minute's slack, so "365 days from now" computed by a caller still fits.
  if (at > Date.now() + PUBLIC_DAYS_MAX * 86_400_000 + 60_000) throw new HubError(`a public link can last at most ${PUBLIC_DAYS_MAX} days`);
  return new Date(at).toISOString();
}

/** "@Corp.com" or "corp.com." as "corp.com", refusing what isn't a domain or anyone can sign up at. */
function joinDomain(input: string): string {
  const d = String(input).trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
  if (!/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) throw new HubError(`"${input}" is not an email domain`);
  if (PUBLIC_MAIL_DOMAINS.has(d)) throw new HubError(`${d} is a public email provider: anyone can get an address there. Add people from it one by one instead.`);
  return d;
}

function toMeta(r: Record<string, SqlStorageValue>): ArtifactMeta {
  return {
    id: r.id as string,
    title: r.title as string,
    description: r.description as string,
    owner: r.owner as string,
    version: r.version as number,
    public: isPublic(r),
    publicUntil: isPublic(r) ? ((r.public_until as string | null) ?? null) : null,
    preview: Boolean(r.preview),
    archivedAt: (r.archived_at as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashFiles(files: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) out[path] = await sha256Hex(content);
  return out;
}

export type SourceInfo = {
  id: string;
  path: string;
  url: string;
  host: string;
  everyMinutes: number;
  pick: string | null;
  approved: boolean;
  lastFetch: string | null;
  lastStatus: string | null;
  lastError: string | null;
};

function toSource(r: Record<string, SqlStorageValue>, allowed: Set<string>): SourceInfo {
  const host = new URL(r.url as string).hostname.toLowerCase();
  return {
    id: r.artifact_id as string,
    path: r.path as string,
    url: r.url as string,
    host,
    everyMinutes: r.every_minutes as number,
    pick: (r.pick as string | null) ?? null,
    approved: allowed.has(host),
    lastFetch: (r.last_fetch as string | null) ?? null,
    lastStatus: (r.last_status as string | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
  };
}

/** GET a JSON document (no credentials, size- and time-limited) and optionally pick a dot path. */
async function fetchSource(url: string, pick: string | null, allowed: Set<string>): Promise<JsonValue> {
  // Redirects are followed by hand so every hop stays on an approved https host.
  let target = url;
  let res: Response | null = null;
  for (let hop = 0; hop < 5; hop++) {
    res = await fetch(target, {
      headers: { Accept: "application/json", "User-Agent": "artifacts.boo/1 (+https://github.com/micthiesen/artifacts.boo)" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("Location") : null;
    if (!location) break;
    const next = new URL(location, target);
    if (next.protocol !== "https:" || !allowed.has(next.hostname.toLowerCase())) throw new Error(`redirected to ${next.hostname}, which isn't approved`);
    target = next.href;
    res = null;
  }
  if (!res) throw new Error("too many redirects");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > SOURCE_MAX_BYTES) throw new Error(`response is over ${SOURCE_MAX_BYTES / 1024} KB`);
  let value: JsonValue;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("response is not JSON");
  }
  if (pick) {
    for (const key of pick.split(".").filter(Boolean)) {
      if (value && typeof value === "object" && key in (value as Record<string, JsonValue>)) {
        value = (value as Record<string, JsonValue>)[key];
      } else throw new Error(`pick "${pick}": no "${key}"`);
    }
  }
  return value;
}

export type ChangeOptions = {
  /** Version note shown in history and the "changed since" banner. */
  note?: string;
  /** Thread ids this change addresses; they are resolved as "Addressed in vN". */
  resolves?: string[];
  actor?: Actor;
  /** The person an agent acts for; they aren't notified about their own agent's changes. */
  onBehalf?: string;
  origin?: string;
};

function defaultLevel(owner: boolean): WatchLevel {
  return owner ? "all" : "participating";
}

function toThread(t: Record<string, SqlStorageValue>, comments: ThreadComment[]): Thread {
  return {
    id: t.id as string,
    anchor: t.anchor ? (JSON.parse(t.anchor as string) as Anchor) : null,
    version: t.version as number,
    by: t.by as string,
    at: t.at as string,
    resolved: t.resolved_at ? { by: t.resolved_by as string, at: t.resolved_at as string } : null,
    ...(t.addressed_in ? { addressedIn: t.addressed_in as number } : {}),
    comments,
  };
}

function cleanAnchor(anchor: Anchor | null): Anchor | null {
  if (!anchor || typeof anchor !== "object") return null;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
  const out: Anchor = {};
  const block = str(anchor.block, 80);
  if (block) out.block = block;
  const row = str(anchor.row, 200);
  if (row) out.row = row;
  const label = str(anchor.label, 120);
  if (label) out.label = label;
  const q = anchor.quote;
  if (q && typeof q === "object" && typeof q.exact === "string" && q.exact.trim()) {
    out.quote = { exact: q.exact.slice(0, 1000), prefix: str(q.prefix, 64) ?? "", suffix: str(q.suffix, 64) ?? "" };
  }
  if (JSON.stringify(out).length > ANCHOR_MAX_BYTES) throw new HubError("comment anchor is too large");
  return Object.keys(out).length ? out : null;
}

/**
 * Server-side checks and stamps for the kit's collab keys written by a person.
 * Other keys pass through unchanged.
 */
/**
 * The version a person answered on: the page they had open says (a tab left
 * open on an old version answers that one), never later than the artifact.
 */
function seenVersion(claimed: unknown, current: number): number {
  return typeof claimed === "number" && Number.isInteger(claimed) && claimed >= 1 && claimed <= current ? claimed : current;
}

/** `approve/<id>/<email>` and `form/<id>/<email>`: one decision or form response per person. */
const RESPONSE_KEY = /^(approve|form)\/([^/]+)\/(.+)$/;
const RESPONSE_ID = /^[\w.-]{1,64}$/;
const FORM_FIELDS_MAX = 50;

function stampCollab(
  key: string,
  value: JsonValue | null,
  by: string,
  exists: boolean,
  existingBy: string | null,
  role: Role | undefined,
  version: number,
  existingAt?: number,
): JsonValue | null {
  const poll = /^poll\/[^/]+\/(.+)$/.exec(key);
  if (poll) {
    if (poll[1] !== by) throw new HubError("you can only change your own vote");
    return value;
  }
  // Approvals and form responses are one per person, under their own email, and
  // carry who and when so an agent can trust them.
  // Who, when and on which version, so an agent can trust and date them.
  const response = RESPONSE_KEY.exec(key);
  if (response) {
    const [, kind, id, email] = response;
    if (!RESPONSE_ID.test(id)) throw new HubError(`"${id.slice(0, 40)}" isn't a valid ${kind === "approve" ? "approval" : "form"} id (letters, digits, - _ and . only)`);
    if (email !== by) throw new HubError(kind === "approve" ? "you can only change your own decision" : "you can only change your own response");
    if (value === null) return null;
    if (typeof value !== "object" || Array.isArray(value)) throw new HubError("a response must be an object");
    if (kind === "approve") {
      if (value.decision !== "approve" && value.decision !== "changes") throw new HubError('a decision is "approve" or "changes"');
      const note = typeof value.note === "string" ? value.note.trim() : "";
      if (note.length > COMMENT_MAX_CHARS) throw new HubError(`notes are limited to ${COMMENT_MAX_CHARS} characters`);
      return { decision: value.decision, ...(note ? { note } : {}), by, at: Date.now(), version: seenVersion(value.version, version) };
    }
    const values = value.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new HubError("a form response needs values");
    const entries = Object.entries(values);
    if (entries.length > FORM_FIELDS_MAX) throw new HubError(`a form response has at most ${FORM_FIELDS_MAX} fields`);
    for (const [name, v] of entries) {
      if (name.length > 100) throw new HubError("form field names are limited to 100 characters");
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw new HubError(`form field "${name.slice(0, 40)}" must be text, a number or true/false`);
      if (typeof v === "string" && v.length > COMMENT_MAX_CHARS) throw new HubError(`form field "${name.slice(0, 40)}" is limited to ${COMMENT_MAX_CHARS} characters`);
    }
    return { values, by, at: Date.now(), version: seenVersion(value.version, version) };
  }
  // A Ledger entry: added by anyone who can edit, changed or removed only by whoever added it (or an owner),
  // stamped with who and when like a form response.
  const ledger = /^ledger\/([\w.-]{1,64})\/([\w-]{1,64})$/.exec(key);
  if (key.startsWith("ledger/")) {
    if (!ledger) throw new HubError("a ledger entry's key is ledger/<id>/<entry>");
    if (exists && existingBy !== null && existingBy !== by && role !== "owner") throw new HubError("you can only change entries you added");
    if (value === null) return null;
    if (typeof value !== "object" || Array.isArray(value)) throw new HubError("a ledger entry must be an object");
    const values = value.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new HubError("a ledger entry needs values");
    const entries = Object.entries(values);
    if (entries.length > FORM_FIELDS_MAX) throw new HubError(`a ledger entry has at most ${FORM_FIELDS_MAX} fields`);
    for (const [name, v] of entries) {
      if (name.length > 100) throw new HubError("field names are limited to 100 characters");
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw new HubError(`field "${name.slice(0, 40)}" must be text, a number or true/false`);
      if (typeof v === "string" && v.length > COMMENT_MAX_CHARS) throw new HubError(`field "${name.slice(0, 40)}" is limited to ${COMMENT_MAX_CHARS} characters`);
    }
    // The first author and time stay; an edit adds who changed it and when.
    if (!exists) return { values, by, at: Date.now() };
    return { values, by: existingBy ?? by, at: existingAt ?? Date.now(), editedBy: by, editedAt: Date.now() };
  }
  if (key.startsWith("comments/")) {
    if (exists && existingBy !== null && existingBy !== by && role !== "owner") {
      throw new HubError("you can only change your own comments");
    }
    if (value === null) return null;
    if (typeof value !== "object" || Array.isArray(value) || typeof value.text !== "string") {
      throw new HubError("a comment needs text");
    }
    if (value.text.length > COMMENT_MAX_CHARS) throw new HubError(`comments are limited to ${COMMENT_MAX_CHARS} characters`);
    return { ...value, by, at: exists && typeof value.at === "number" ? value.at : Date.now() };
  }
  if ((key.startsWith("check/") || key.startsWith("notes/")) && value && typeof value === "object" && !Array.isArray(value)) {
    return key.startsWith("notes/") ? { ...value, by, at: Date.now() } : { ...value, by };
  }
  return value;
}

export type PollInput = { name: string; arguments?: unknown; cursor?: unknown; maxAgeMs?: unknown; maxEvents?: unknown };
export type SubscribeInput = {
  name: string;
  arguments?: unknown;
  delivery?: { mode?: unknown; url?: unknown; secret?: unknown };
  cursor?: unknown;
  maxAgeMs?: unknown;
  ttlMs?: unknown;
};
export type UnsubscribeInput = { name: string; arguments?: unknown; delivery?: { url?: unknown } };

/** The answer to an events/* call as a value: errors keep their code and data, which a thrown Error loses over RPC. */
export type EventsResult<T> = { result: T } | { error: { code: number; message: string; data?: Record<string, unknown> } };

async function eventsResult<T>(fn: () => T | Promise<T>): Promise<EventsResult<T>> {
  try {
    return { result: await fn() };
  } catch (err) {
    if (err instanceof EventsFailure) return { error: { code: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) } };
    throw err;
  }
}

/** A webhook callback URL: https, a public host, no credentials or fragment. */
function callbackUrl(raw: unknown): string {
  let u: URL;
  try {
    u = new URL(String(raw ?? ""));
  } catch {
    throw new EventsFailure(EVENT_ERRORS.InvalidParams, "delivery.url must be an https URL.");
  }
  // The default https port only, so subscribing can't be used to knock on arbitrary services.
  if (u.protocol !== "https:" || u.port || u.username || u.password || isBlockedHost(u.hostname)) {
    throw new EventsFailure(EVENT_ERRORS.InvalidParams, "delivery.url must be an https URL on a public host and the default port, without credentials.");
  }
  u.hash = "";
  return u.href;
}

/**
 * One signed POST (Standard Webhooks headers plus X-MCP-Subscription-Id), never
 * following redirects. Failures are reported only as the SEP's categories.
 */
async function postWebhook(url: string, subscription: string, messageId: string, body: string, secrets: string[], readBody = false) {
  // Checked again at delivery: the host must still be public.
  if (isBlockedHost(new URL(url).hostname)) return { ok: false, status: 0, error: "connection_refused" as DeliveryError };
  const timestamp = Math.floor(Date.now() / 1000);
  try {
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "artifacts.boo-events/1",
        "webhook-id": messageId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": await signWebhook(secrets, messageId, timestamp, body),
        "X-MCP-Subscription-Id": subscription,
      },
      body,
    });
    const ok = res.status >= 200 && res.status < 300;
    // Only a verification answer is read; other bodies are dropped unread.
    if (!readBody) await res.body?.cancel();
    return { ok, status: res.status, error: ok ? undefined : failureOf(res.status), res };
  } catch (err) {
    return { ok: false, status: 0, error: errorOf(err) };
  }
}

/** The challenge handshake: the endpoint must echo a fresh nonce from a signed verification POST. */
async function verifyReceiver(url: string, subscription: string, secret: string) {
  const challenge = randomId(24);
  const r = await postWebhook(url, subscription, `msg_verification_${randomId(12)}`, JSON.stringify({ type: "verification", challenge }), [secret], true);
  let echoed: unknown = null;
  if (r.ok && r.res) echoed = ((await r.res.json().catch(() => null)) as { challenge?: unknown } | null)?.challenge;
  if (!r.ok || typeof echoed !== "string" || !timingSafeEqual(echoed, challenge)) {
    throw new EventsFailure(EVENT_ERRORS.CallbackEndpointError, "The callback URL didn't answer the verification challenge.", { reason: r.ok ? "challenge_failed" : r.error });
  }
}

// ArtifactHub: the single Durable Object that stores every artifact, its file
// history, sharing, shared state and live sync sockets. One instance ("hub") is
// plenty for a handful of viewers and keeps every write transactional.
import { DurableObject } from "cloudflare:workers";
import { buildArtifact, type Build, type CompileError } from "./compile.ts";
import { renderCheck, type CheckEnv, type CheckOutcome, type RenderCheck } from "./check.ts";
import { domainOf, sharePrincipal } from "./principal.ts";
import { applyJsonPatch, applyTextEdits, EditError, grepFiles, type JsonPatchOp, type TextEdit } from "./edit.ts";
import { diffBlocks, type BlockInfo } from "./blocks.ts";
import { composeMessage, mentionedEmails, type OutboxItem } from "./notifications.ts";
import { sendToChannel, type ChannelType, type NotifyEnv } from "./notify.ts";
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
  version: number;
  public: boolean;
  /** Owner opted in to rich link previews (title, description, screenshot). */
  preview: boolean;
  /** When the owner archived it: hidden from lists, still readable at its link. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** "agent" for MCP writes, an email for people. */
export type Actor = string;

/** `email` is a full address, or "@domain" for everyone at that domain. */
export type ShareEntry = { email: string; role: Exclude<Role, "owner"> };



export type WriteResult =
  | { ok: true; id: string; version: number; files: string[] }
  | { ok: false; errors: CompileError[]; version?: number };

export class HubError extends Error {}

// Typed view of the RPC stub. DurableObjectStub<ArtifactHub> is too deep for the
// type checker, so callers use this instead.
type AsyncMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};
export type HubApi = AsyncMethods<
  Pick<
    ArtifactHub,
    | "list" | "meta" | "roleFor" | "files" | "grep" | "build" | "history" | "create" | "editText" | "writeFiles"
    | "patchData" | "revert" | "updateMeta" | "share" | "delete" | "state" | "setState" | "recordError" | "errors"
    | "runRenderCheck" | "screenshot" | "putAsset" | "deleteAsset" | "assets" | "asset" | "allowedHosts" | "setHostAllowed"
    | "sources" | "setSource" | "removeSource" | "refreshSources" | "shareSummaries" | "exportAll" | "importAll" | "backupToR2"
    | "threads" | "addComment" | "resolveThread" | "deleteComment" | "activity" | "visit" | "people" | "previewInfo"
    | "profile" | "setName" | "addChannel" | "removeChannel" | "channelConfig" | "recordChannelResult" | "setWatch"
  >
> & { fetch(request: Request): Promise<Response> };

type SocketTag = { id: string; email: string | null; role: Role; origin?: string };

const HISTORY_KEEP = 50;
const ASSETS_MAX_BYTES = 20 * 1024 * 1024;
const SOURCE_MAX_BYTES = 1024 * 1024;
const EXPORT_TABLES = [
  "artifacts", "files", "history", "builds", "shares", "state", "errors", "checks", "assets", "sources", "allowed_hosts",
  "events", "threads", "comments", "users", "channels", "watches", "seen",
];
/** Tables keyed by artifact, cleared when an artifact is deleted. */
const ARTIFACT_TABLES = [
  "files", "history", "builds", "shares", "state", "errors", "checks", "assets", "sources",
  "events", "threads", "comments", "watches", "seen", "outbox",
];
const EVENTS_KEEP = 5000;
const COMMENT_MAX_CHARS = 5000;
const ANCHOR_MAX_BYTES = 2048;
// Notifications wait briefly so a burst of comments becomes one message, and
// longer for page updates, which agents tend to make in runs.
const COMMENT_DELAY_MS = 45_000;
const UPDATE_DELAY_MS = 10 * 60_000;
const UPDATE_MAX_WAIT_MS = 30 * 60_000;
// Workers Free allows 50 subrequests per invocation; leave headroom.
const SENDS_PER_ALARM = 40;
const CHANNEL_MAX_FAILURES = 5;
// Browser Run free plan: one quick action every 10 s.
const CHECK_SPACING_MS = 10_500;
const CHECK_INLINE_WAIT_MS = 8_000;
const ERRORS_KEEP = 30;

export class ArtifactHub extends DurableObject {
  private sql: SqlStorage;
  private checkEnv: CheckEnv;
  private nextCheckAt = 0;

  constructor(ctx: DurableObjectState, env: CheckEnv) {
    super(ctx, env as never);
    this.checkEnv = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL, public INTEGER NOT NULL DEFAULT 0, state_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (
        artifact_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (artifact_id, path));
      CREATE TABLE IF NOT EXISTS history (
        artifact_id TEXT NOT NULL, version INTEGER NOT NULL, files TEXT NOT NULL, note TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY (artifact_id, version));
      CREATE TABLE IF NOT EXISTS builds (artifact_id TEXT PRIMARY KEY, version INTEGER NOT NULL, build TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shares (
        artifact_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (artifact_id, email));
      CREATE TABLE IF NOT EXISTS state (
        artifact_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, seq INTEGER NOT NULL, by TEXT,
        PRIMARY KEY (artifact_id, key));
      CREATE TABLE IF NOT EXISTS checks (
        artifact_id TEXT PRIMARY KEY, version INTEGER NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL,
        result TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS assets (
        artifact_id TEXT NOT NULL, path TEXT NOT NULL, content_type TEXT NOT NULL, data BLOB NOT NULL,
        bytes INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (artifact_id, path));
      CREATE TABLE IF NOT EXISTS sources (
        artifact_id TEXT NOT NULL, path TEXT NOT NULL, url TEXT NOT NULL, every_minutes INTEGER NOT NULL,
        pick TEXT, last_fetch TEXT, last_status TEXT, last_error TEXT, PRIMARY KEY (artifact_id, path));
      CREATE TABLE IF NOT EXISTS allowed_hosts (host TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS errors (
        artifact_id TEXT NOT NULL, at TEXT NOT NULL, version INTEGER NOT NULL, viewer TEXT, message TEXT NOT NULL,
        stack TEXT);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, artifact_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT,
        type TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_by_artifact ON events (artifact_id, seq);
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, anchor TEXT, version INTEGER NOT NULL, by TEXT NOT NULL,
        at TEXT NOT NULL, resolved_by TEXT, resolved_at TEXT, addressed_in INTEGER);
      CREATE INDEX IF NOT EXISTS threads_by_artifact ON threads (artifact_id);
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, artifact_id TEXT NOT NULL, by TEXT NOT NULL, text TEXT NOT NULL,
        at TEXT NOT NULL, seq INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS comments_by_artifact ON comments (artifact_id, seq);
      CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, name TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, type TEXT NOT NULL, label TEXT NOT NULL, config TEXT NOT NULL,
        created_at TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0, last_error TEXT, disabled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS watches (
        email TEXT NOT NULL, artifact_id TEXT NOT NULL, level TEXT NOT NULL, PRIMARY KEY (email, artifact_id));
      CREATE TABLE IF NOT EXISTS seen (
        email TEXT NOT NULL, artifact_id TEXT NOT NULL, version INTEGER NOT NULL, read_seq INTEGER NOT NULL DEFAULT 0,
        at TEXT NOT NULL, PRIMARY KEY (email, artifact_id));
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, artifact_id TEXT NOT NULL, kind TEXT NOT NULL,
        data TEXT NOT NULL, due_at INTEGER NOT NULL);
    `);
    // Columns added after the first deploy.
    const columns = (table: string) => this.sql.exec(`PRAGMA table_info(${table})`).toArray().map((c) => c.name);
    if (!columns("checks").includes("screenshot")) this.sql.exec(`ALTER TABLE checks ADD COLUMN screenshot TEXT`);
    if (!columns("history").includes("blocks")) this.sql.exec(`ALTER TABLE history ADD COLUMN blocks TEXT`);
    if (!columns("seen").includes("since_version")) {
      this.sql.exec(`ALTER TABLE seen ADD COLUMN since_version INTEGER`);
      this.sql.exec(`ALTER TABLE seen ADD COLUMN since_at TEXT`);
    }
    if (!columns("artifacts").includes("preview")) {
      this.sql.exec(`ALTER TABLE artifacts ADD COLUMN preview INTEGER NOT NULL DEFAULT 0`);
    }
    if (!columns("artifacts").includes("archived_at")) this.sql.exec(`ALTER TABLE artifacts ADD COLUMN archived_at TEXT`);
  }

  // ---- reads -------------------------------------------------------------

  list(viewer: { email: string | null; owner: boolean }): (ArtifactMeta & { role: Role; unseen?: boolean; unread?: number })[] {
    const withActivity = <T extends ArtifactMeta>(rows: T[]) => (viewer.email ? rows.map((a) => ({ ...a, ...this.activityFor(a, viewer.email!) })) : rows);
    if (viewer.owner) {
      return withActivity(
        this.sql
          .exec(`SELECT *, 'owner' AS role FROM artifacts ORDER BY updated_at DESC`)
          .toArray()
          .map((r) => ({ ...toMeta(r), role: "owner" as Role })),
      );
    }
    const email = viewer.email ?? "";
    const rows = this.sql
      .exec(
        `SELECT a.*, s.role AS role, s.email AS principal FROM artifacts a JOIN shares s ON s.artifact_id = a.id
         WHERE s.email = ? OR s.email = ? ORDER BY a.updated_at DESC`,
        email,
        domainOf(email),
      )
      .toArray();
    // An exact-email share overrides a domain share for the same artifact.
    const byId = new Map<string, Record<string, SqlStorageValue>>();
    for (const r of rows) {
      const prev = byId.get(r.id as string);
      if (!prev || r.principal === email) byId.set(r.id as string, r);
    }
    return withActivity([...byId.values()].map((r) => ({ ...toMeta(r), role: r.role as Role })));
  }

  /** Whether a viewer has a newer version to see and how many comments by others they haven't read. */
  private activityFor(a: ArtifactMeta, email: string): { unseen: boolean; unread: number } {
    const seen = this.sql.exec(`SELECT version, read_seq FROM seen WHERE email = ? AND artifact_id = ?`, email, a.id).toArray()[0];
    if (!seen) return { unseen: true, unread: 0 };
    const unread = this.sql
      .exec(`SELECT COUNT(*) AS n FROM comments WHERE artifact_id = ? AND seq > ? AND by != ?`, a.id, seen.read_seq, email)
      .one().n as number;
    return { unseen: (seen.version as number) < a.version, unread };
  }

  meta(id: string): (ArtifactMeta & { shares: ShareEntry[]; files: { path: string; bytes: number }[] }) | null {
    const row = this.sql.exec(`SELECT * FROM artifacts WHERE id = ?`, id).toArray()[0];
    if (!row) return null;
    const shares = this.sql
      .exec(`SELECT email, role FROM shares WHERE artifact_id = ? ORDER BY email`, id)
      .toArray() as unknown as ShareEntry[];
    const files = this.sql
      .exec(`SELECT path, length(CAST(content AS BLOB)) AS bytes FROM files WHERE artifact_id = ? ORDER BY path`, id)
      .toArray() as unknown as { path: string; bytes: number }[];
    return { ...toMeta(row), shares, files };
  }

  /** Effective role of a viewer, or null when they may not open the artifact. */
  roleFor(id: string, email: string | null, owner: boolean): Role | null {
    const row = this.sql.exec(`SELECT public FROM artifacts WHERE id = ?`, id).toArray()[0];
    if (!row) return null;
    if (owner) return "owner";
    if (email) {
      const exact = this.sql.exec(`SELECT role FROM shares WHERE artifact_id = ? AND email = ?`, id, email).toArray()[0];
      if (exact) return exact.role as Role;
      const domain = this.sql.exec(`SELECT role FROM shares WHERE artifact_id = ? AND email = ?`, id, domainOf(email)).toArray()[0];
      if (domain) return domain.role as Role;
    }
    return row.public ? "view" : null;
  }

  files(id: string): Record<string, string> {
    this.requireArtifact(id);
    const out: Record<string, string> = {};
    for (const r of this.sql.exec(`SELECT path, content FROM files WHERE artifact_id = ?`, id)) {
      out[r.path as string] = r.content as string;
    }
    return out;
  }

  grep(id: string, pattern: string, path?: string) {
    return grepFiles(this.files(id), pattern, path);
  }

  build(id: string): { meta: ArtifactMeta; build: Build } | null {
    const row = this.sql.exec(`SELECT * FROM artifacts WHERE id = ?`, id).toArray()[0];
    const b = this.sql.exec(`SELECT build FROM builds WHERE artifact_id = ?`, id).toArray()[0];
    if (!row || !b) return null;
    return { meta: toMeta(row), build: JSON.parse(b.build as string) };
  }

  history(id: string) {
    this.requireArtifact(id);
    return this.sql
      .exec(
        `SELECT version, note, created_at AS createdAt, files FROM history WHERE artifact_id = ? ORDER BY version DESC`,
        id,
      )
      .toArray()
      .map((r) => ({
        version: r.version as number,
        note: r.note as string,
        createdAt: r.createdAt as string,
        files: Object.keys(JSON.parse(r.files as string)),
      }));
  }

  // ---- writes ------------------------------------------------------------

  async create(input: { title: string; description?: string; files: Record<string, string>; actor?: Actor }): Promise<WriteResult> {
    const { build, errors } = await buildArtifact(input.files);
    if (!build) return { ok: false, errors };
    const id = newId();
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO artifacts (id, title, description, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`,
        id,
        input.title,
        input.description ?? "",
        now,
        now,
      );
      this.commitFiles(id, 1, input.files, build, "created", now);
      this.logEvent(id, input.actor ?? "agent", "version", { version: 1, note: "created" });
    });
    return { ok: true, id, version: 1, files: Object.keys(input.files).sort() };
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
    const target = JSON.parse(row.files as string) as Record<string, string>;
    return this.change(id, undefined, `revert to v${version}`, opts, (files) => {
      for (const k of Object.keys(files)) delete files[k];
      Object.assign(files, target);
    });
  }

  updateMeta(id: string, patch: { title?: string; description?: string; preview?: boolean; archived?: boolean }): ArtifactMeta {
    this.requireArtifact(id);
    if (patch.title !== undefined) this.sql.exec(`UPDATE artifacts SET title = ? WHERE id = ?`, patch.title, id);
    if (patch.description !== undefined) {
      this.sql.exec(`UPDATE artifacts SET description = ? WHERE id = ?`, patch.description, id);
    }
    if (patch.preview !== undefined) this.sql.exec(`UPDATE artifacts SET preview = ? WHERE id = ?`, patch.preview ? 1 : 0, id);
    // Archiving doesn't touch updated_at: it isn't a change to the content.
    if (patch.archived === true) this.sql.exec(`UPDATE artifacts SET archived_at = COALESCE(archived_at, ?) WHERE id = ?`, new Date().toISOString(), id);
    if (patch.archived === false) this.sql.exec(`UPDATE artifacts SET archived_at = NULL WHERE id = ?`, id);
    return toMeta(this.sql.exec(`SELECT * FROM artifacts WHERE id = ?`, id).one());
  }

  share(id: string, input: { add?: ShareEntry[]; remove?: string[]; public?: boolean }) {
    this.requireArtifact(id);
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
      if (input.public !== undefined) this.sql.exec(`UPDATE artifacts SET public = ? WHERE id = ?`, input.public ? 1 : 0, id);
    });
    // Drop live sockets that lost access; they reconnect and are re-checked.
    const touched = new Set([...(input.remove ?? []), ...(input.add ?? []).map((s) => s.email)].map(sharePrincipal));
    for (const ws of this.ctx.getWebSockets(id)) {
      const tag = ws.deserializeAttachment() as SocketTag;
      const affected = tag.email !== null && (touched.has(tag.email) || touched.has(domainOf(tag.email)));
      if (affected || (input.public === false && !tag.email)) ws.close(4003, "access changed");
    }
    return this.meta(id);
  }

  delete(id: string) {
    this.requireArtifact(id);
    this.ctx.storage.transactionSync(() => {
      for (const t of ARTIFACT_TABLES) this.sql.exec(`DELETE FROM ${t} WHERE artifact_id = ?`, id);
      this.sql.exec(`DELETE FROM artifacts WHERE id = ?`, id);
    });
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
    opts: { role?: Role; origin?: string } = {},
  ): number {
    this.requireArtifact(id);
    let seq = 0;
    const applied: { key: string; value: JsonValue | null; seq: number; created: boolean }[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const [key, raw] of Object.entries(changes)) {
        if (key.length === 0 || key.length > 200) throw new HubError(`state key "${key.slice(0, 40)}" must be 1-200 chars`);
        const existing = this.sql.exec(`SELECT by FROM state WHERE artifact_id = ? AND key = ?`, id, key).toArray()[0];
        const value = by ? stampCollab(key, raw, by, Boolean(existing), (existing?.by as string | null) ?? null, opts.role) : raw;
        seq = (this.sql.exec(`UPDATE artifacts SET state_seq = state_seq + 1 WHERE id = ? RETURNING state_seq`, id).one()
          .state_seq as number);
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
      const total = this.sql
        .exec(`SELECT COALESCE(SUM(length(value)), 0) AS n FROM state WHERE artifact_id = ?`, id)
        .one().n as number;
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
    return seq;
  }

  recordError(id: string, viewer: string | null, message: string, stack?: string) {
    const row = this.sql.exec(`SELECT version FROM artifacts WHERE id = ?`, id).toArray()[0];
    if (!row) return;
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
    return this.sql
      .exec(`SELECT at, version, viewer, message, stack FROM errors WHERE artifact_id = ? ORDER BY at DESC`, id)
      .toArray();
  }

  // ---- render checks -------------------------------------------------------

  /**
   * Render-check the current version. Runs inline when a Browser Run slot is
   * free within a few seconds; otherwise queues it on an alarm. Reuses a stored
   * result for the same version.
   */
  async runRenderCheck(id: string, origin: string, force = false): Promise<CheckOutcome & { version: number }> {
    const version = this.requireArtifact(id).version as number;
    const stored = this.sql.exec(`SELECT version, status, result, screenshot FROM checks WHERE artifact_id = ?`, id).toArray()[0];
    if (!force && stored && stored.version === version && stored.status === "done") {
      const previous = JSON.parse(stored.result as string) as RenderCheck;
      // Only definitive results are reused; a skipped check is retried.
      if (previous.status === "ok" || previous.status === "errors") {
        return { check: previous, screenshot: (stored.screenshot as string | null) ?? undefined, version };
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

  /** Latest stored screenshot (base64 JPEG) for the current version, if any. */
  screenshot(id: string): string | null {
    const version = this.requireArtifact(id).version as number;
    const row = this.sql.exec(`SELECT version, screenshot FROM checks WHERE artifact_id = ?`, id).toArray()[0];
    return row && row.version === version ? ((row.screenshot as string | null) ?? null) : null;
  }

  async alarm() {
    const next = this.sql.exec(`SELECT artifact_id, origin FROM checks WHERE status = 'queued' ORDER BY at LIMIT 1`).toArray()[0];
    if (next && Date.now() >= this.nextCheckAt) {
      const id = next.artifact_id as string;
      const row = this.sql.exec(`SELECT version FROM artifacts WHERE id = ?`, id).toArray()[0];
      if (!row) {
        this.sql.exec(`DELETE FROM checks WHERE artifact_id = ?`, id);
      } else {
        this.nextCheckAt = Date.now() + CHECK_SPACING_MS;
        await this.runCheck(id, row.version as number, next.origin as string);
      }
    }
    await this.deliverDue();
    await this.armAlarm();
  }

  /** One alarm serves both queues: the earliest queued render check and the earliest due notification. */
  private async armAlarm() {
    const times: number[] = [];
    const queued = this.sql.exec(`SELECT COUNT(*) AS n FROM checks WHERE status = 'queued'`).one().n as number;
    if (queued > 0) times.push(Math.max(Date.now() + CHECK_SPACING_MS, this.nextCheckAt));
    const due = this.sql.exec(`SELECT MIN(due_at) AS t FROM outbox`).one().t as number | null;
    if (due !== null) times.push(Math.max(due, Date.now() + 1000));
    if (!times.length) return;
    const at = Math.min(...times);
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > at || existing < Date.now()) await this.ctx.storage.setAlarm(at);
  }

  /** Runs one check and stores it. Returns null when Browser Run rate-limited us. */
  private async runCheck(id: string, version: number, origin: string): Promise<CheckOutcome | null> {
    const result = await renderCheck(this.checkEnv, origin, id, version);
    if ("rateLimited" in result) {
      this.nextCheckAt = Date.now() + CHECK_SPACING_MS;
      return null;
    }
    this.sql.exec(
      `INSERT INTO checks (artifact_id, version, origin, status, result, screenshot, at) VALUES (?, ?, ?, 'done', ?, ?, ?)
       ON CONFLICT (artifact_id) DO UPDATE SET version = excluded.version, origin = excluded.origin,
         status = 'done', result = excluded.result, screenshot = excluded.screenshot, at = excluded.at`,
      id,
      version,
      origin,
      JSON.stringify(result.check),
      result.screenshot ?? null,
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
    return { status: "queued", inSeconds: Math.ceil((at - Date.now()) / 1000) + (queued - 1) * 11 + 5 };
  }

  // ---- assets (images and other files, stored in SQLite) --------------------

  putAsset(id: string, path: string, contentType: string, data: Uint8Array): { path: string; bytes: number } {
    this.requireArtifact(id);
    const total = this.sql
      .exec(`SELECT COALESCE(SUM(bytes), 0) AS n FROM assets WHERE artifact_id = ? AND path != ?`, id, path)
      .one().n as number;
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

  /** Hosts the owner approved for live data sources (managed only from the owner UI). */
  allowedHosts(): string[] {
    return this.sql.exec(`SELECT host FROM allowed_hosts ORDER BY host`).toArray().map((r) => r.host as string);
  }

  setHostAllowed(host: string, allowed: boolean): string[] {
    const h = host.trim().toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) throw new HubError(`"${host}" is not a hostname`);
    if (allowed) this.sql.exec(`INSERT OR IGNORE INTO allowed_hosts (host) VALUES (?)`, h);
    else this.sql.exec(`DELETE FROM allowed_hosts WHERE host = ?`, h);
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
    return this.sources(id).find((s) => s.path === input.path)!;
  }

  removeSource(id: string, path: string): boolean {
    return this.sql.exec(`DELETE FROM sources WHERE artifact_id = ? AND path = ? RETURNING path`, id, path).toArray().length > 0;
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
    for (const r of rows) {
      const info = toSource(r, allowed);
      if (!info.approved) {
        results.push(info);
        continue;
      }
      let status = "ok";
      let error: string | null = null;
      try {
        const value = await fetchSource(info.url, info.pick);
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
    return results;
  }

  /** Swap one data file's content and rebuild, without a new version or history entry. */
  private async replaceDataFile(id: string, path: string, content: string) {
    const files = this.files(id);
    files[path] = content;
    const { build, errors } = await buildArtifact(files);
    if (!build) throw new Error(errors.map((e) => e.message).join("; "));
    const version = this.requireArtifact(id).version as number;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO files (artifact_id, path, content) VALUES (?, ?, ?)
         ON CONFLICT (artifact_id, path) DO UPDATE SET content = excluded.content`,
        id,
        path,
        content,
      );
      this.sql.exec(`UPDATE builds SET build = ?, version = ? WHERE artifact_id = ?`, JSON.stringify(build), version, id);
    });
    this.touch(id);
  }

  // ---- owner overview, export and point-in-time restore ----------------------

  /** Sharing summary per artifact for the owner's index. */
  shareSummaries(): Record<string, { shares: ShareEntry[]; public: boolean }> {
    const out: Record<string, { shares: ShareEntry[]; public: boolean }> = {};
    for (const a of this.sql.exec(`SELECT id, public FROM artifacts`)) out[a.id as string] = { shares: [], public: Boolean(a.public) };
    for (const s of this.sql.exec(`SELECT artifact_id, email, role FROM shares ORDER BY email`)) {
      out[s.artifact_id as string]?.shares.push({ email: s.email as string, role: s.role as ShareEntry["role"] });
    }
    return out;
  }

  /** Everything, as JSON-safe rows (asset bytes base64). */
  exportAll(): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {};
    for (const t of EXPORT_TABLES) {
      out[t] = this.sql.exec(`SELECT * FROM ${t}`).toArray().map((r) => {
        const row: Record<string, unknown> = { ...r };
        if (t === "assets" && r.data) row.data = toBase64(new Uint8Array(r.data as ArrayBuffer));
        if (t === "checks") row.screenshot = null;
        return row;
      });
    }
    return out;
  }

  /** Writes today's export to the BACKUPS bucket (if bound) and keeps the newest 30. */
  async backupToR2(): Promise<string | null> {
    const bucket = (this.env as { BACKUPS?: R2Bucket }).BACKUPS;
    if (!bucket) return null;
    const key = `exports/${new Date().toISOString().slice(0, 10)}.json`;
    await bucket.put(key, JSON.stringify({ exportedAt: new Date().toISOString(), tables: this.exportAll() }), {
      httpMetadata: { contentType: "application/json" },
    });
    const listed = await bucket.list({ prefix: "exports/" });
    const old = listed.objects.map((o) => o.key).sort().slice(0, -30);
    if (old.length) await bucket.delete(old);
    return key;
  }

  /** Replace everything with an export's tables, in one transaction. */
  importAll(tables: Record<string, Record<string, unknown>[]>): Record<string, number> {
    const counts: Record<string, number> = {};
    this.ctx.storage.transactionSync(() => {
      for (const t of EXPORT_TABLES) this.sql.exec(`DELETE FROM ${t}`);
      for (const t of EXPORT_TABLES) {
        const rows = tables[t] ?? [];
        for (const row of rows) {
          const cols = Object.keys(row);
          if (!cols.every((c) => /^[a-z_]+$/.test(c))) throw new HubError(`bad column in ${t}`);
          const values = cols.map((c) => (t === "assets" && c === "data" ? fromBase64(String(row[c])) : (row[c] as SqlStorageValue)));
          this.sql.exec(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...values);
        }
        counts[t] = rows.length;
      }
    });
    for (const ws of this.ctx.getWebSockets()) ws.close(4003, "data restored");
    return counts;
  }

  private touch(id: string) {
    this.sql.exec(`UPDATE artifacts SET updated_at = ? WHERE id = ?`, new Date().toISOString(), id);
  }

  // ---- sync sockets --------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    // Only the Worker calls this; it has already authenticated the viewer.
    const id = request.headers.get("X-Art-Id") ?? "";
    const role = request.headers.get("X-Art-Role") as Role | null;
    const email = request.headers.get("X-Art-Email") || null;
    const origin = request.headers.get("X-Art-Origin") ?? undefined;
    if (request.headers.get("Upgrade") !== "websocket" || !role) return new Response("expected websocket", { status: 400 });
    this.requireArtifact(id);
    const pair = new WebSocketPair();
    const tag: SocketTag = { id, email, role, origin };
    this.ctx.acceptWebSocket(pair[1], [id]);
    pair[1].serializeAttachment(tag);
    const seq = this.sql.exec(`SELECT state_seq FROM artifacts WHERE id = ?`, id).one().state_seq as number;
    send(pair[1], { t: "snapshot", seq, state: this.state(id) });
    // Comments are for signed-in collaborators; anonymous public viewers don't get them.
    if (email) send(pair[1], { t: "threads", threads: this.threads(id), people: this.people(id, role !== "view" ? undefined : email) });
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
        this.resolveThread(tag.id, tag.email, msg.thread, msg.resolved, tag.role, tag.origin, cid);
      } else if (msg.t === "comment:delete") {
        this.deleteComment(tag.id, tag.email, msg.comment, tag.role, cid);
      } else if (msg.t === "set") {
        if (tag.role === "view") throw new HubError("this viewer has read-only access");
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

  /** Start a thread (no `thread`) or reply to one. `actor` is an email or "agent". */
  addComment(
    id: string,
    actor: Actor,
    input: { thread?: string; anchor?: Anchor | null; text: string },
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
        threadId = `t${newId().slice(1)}`;
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
      const commentId = `c${newId().slice(1)}`;
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
    this.notifyComment(id, actor, { thread: threadId!, text, participants, reply, origin });
    return thread;
  }

  resolveThread(id: string, actor: Actor, threadId: string, resolved: boolean, role: Role | "agent" = "agent", origin?: string, cid?: string): Thread {
    const t = this.sql.exec(`SELECT * FROM threads WHERE id = ? AND artifact_id = ?`, threadId, id).toArray()[0];
    if (!t) throw new HubError(`no thread ${threadId} on ${id}`);
    if (role === "view" && t.by !== actor) throw new HubError("only the thread's author or an editor can resolve it");
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE threads SET resolved_by = ?, resolved_at = ? WHERE id = ?`,
        resolved ? actor : null,
        resolved ? now : null,
        threadId,
      );
      this.logEvent(id, actor, resolved ? "resolve" : "reopen", { thread: threadId });
    });
    const thread = this.thread(threadId)!;
    this.broadcast(id, { t: "thread", thread, cid });
    if (resolved) this.notifyResolved(id, actor, thread, origin);
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
      t: "thread",
      thread: thread ?? { id: threadId, anchor: null, version: 0, by: actor, at: "", resolved: null, comments: [] },
      cid,
    });
    return thread;
  }

  /**
   * People to @mention, with display names: owners, exact-email shares and
   * commenters. A view-role viewer (`limitedTo`) only sees commenters and
   * themselves, so the share list stays private to editors.
   */
  people(id: string, limitedTo?: string): Person[] {
    const emails = new Set(limitedTo ? [limitedTo] : ownerList(this.env));
    if (!limitedTo) {
      for (const r of this.sql.exec(`SELECT email FROM shares WHERE artifact_id = ? AND email NOT LIKE '@%'`, id)) emails.add(r.email as string);
    }
    for (const r of this.sql.exec(`SELECT DISTINCT by FROM comments WHERE artifact_id = ? AND by LIKE '%@%'`, id)) emails.add(r.by as string);
    return [...emails].sort().map((email) => ({ email, name: this.nameOf(email) }));
  }

  private nameOf(email: string): string | null {
    return (this.sql.exec(`SELECT name FROM users WHERE email = ?`, email).toArray()[0]?.name as string | null) ?? null;
  }

  // ---- activity log ------------------------------------------------------------

  private logEvent(id: string, actor: Actor | null, type: string, data: Record<string, unknown>): number {
    const seq = this.sql
      .exec(
        `INSERT INTO events (artifact_id, at, actor, type, data) VALUES (?, ?, ?, ?, ?) RETURNING seq`,
        id,
        new Date().toISOString(),
        actor,
        type,
        JSON.stringify(data),
      )
      .one().seq as number;
    if (seq % 100 === 0) {
      this.sql.exec(
        `DELETE FROM events WHERE artifact_id = ? AND seq <= (SELECT seq FROM events WHERE artifact_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
        id,
        id,
        EVENTS_KEEP,
      );
    }
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

  /** Events after `since` (all artifacts, or one), oldest first, with each artifact's title. */
  activity(input: { id?: string; since?: number; limit?: number }) {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const latest = this.sql.exec(`SELECT COALESCE(MAX(seq), 0) AS n FROM events`).one().n as number;
    // Without a cursor, start from the most recent `limit` events (of this artifact, with an id).
    const since =
      input.since ??
      ((this.sql
        .exec(
          `SELECT MIN(seq) AS s FROM (SELECT seq FROM events ${input.id ? "WHERE artifact_id = ?" : ""} ORDER BY seq DESC LIMIT ?)`,
          ...(input.id ? [input.id, limit] : [limit]),
        )
        .one().s as number | null) ?? latest + 1) - 1;
    const rows = this.sql
      .exec(
        `SELECT e.*, a.title AS title FROM events e JOIN artifacts a ON a.id = e.artifact_id
         WHERE e.seq > ? ${input.id ? "AND e.artifact_id = ?" : ""} ORDER BY e.seq LIMIT ?`,
        ...(input.id ? [since, input.id, limit] : [since, limit]),
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
  visit(id: string, email: string): { since?: SinceLastVisit; readSeq: number; watch: WatchLevel } {
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
        .exec(
          `SELECT version, note, created_at FROM history WHERE artifact_id = ? AND version > ? ORDER BY version DESC LIMIT 20`,
          id,
          from,
        )
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
    return { since, readSeq, watch: this.watchLevel(email, id) };
  }

  private markRead(id: string, email: string, seq: number) {
    this.sql.exec(`UPDATE seen SET read_seq = MAX(read_seq, ?) WHERE email = ? AND artifact_id = ?`, Math.floor(seq), email, id);
  }

  // ---- link previews -----------------------------------------------------------

  /** What a link-preview fetcher may see: title and screenshot only when the owner opted in or the artifact is public. */
  previewInfo(id: string): { rich: boolean; title: string; description: string; version: number; image: string | null } | null {
    const row = this.sql.exec(`SELECT * FROM artifacts WHERE id = ?`, id).toArray()[0];
    if (!row) return null;
    const rich = Boolean(row.preview) || Boolean(row.public);
    const shot = this.sql.exec(`SELECT screenshot FROM checks WHERE artifact_id = ?`, id).toArray()[0];
    return {
      rich,
      title: row.title as string,
      description: row.description as string,
      version: row.version as number,
      image: rich ? ((shot?.screenshot as string | null) ?? null) : null,
    };
  }

  // ---- profiles, channels and watches -------------------------------------------

  profile(email: string) {
    const channels = this.sql
      .exec(`SELECT id, type, label, created_at, failures, last_error, disabled FROM channels WHERE email = ? ORDER BY created_at`, email)
      .toArray()
      .map((c) => ({
        id: c.id as string,
        type: c.type as ChannelType,
        label: c.label as string,
        createdAt: c.created_at as string,
        lastError: (c.last_error as string | null) ?? null,
        disabled: Boolean(c.disabled),
      }));
    const owner = ownerList(this.env).includes(email);
    const visible = this.list({ email, owner });
    const levels = new Map(
      this.sql.exec(`SELECT artifact_id, level FROM watches WHERE email = ?`, email).toArray().map((r) => [r.artifact_id as string, r.level as WatchLevel]),
    );
    const watches = visible.map((a) => ({
      id: a.id,
      title: a.title,
      level: levels.get(a.id) ?? defaultLevel(owner),
      custom: levels.has(a.id),
    }));
    return { email, name: this.nameOf(email), owner, channels, watches, defaultLevel: defaultLevel(owner) };
  }

  setName(email: string, name: string) {
    const clean = name.trim().slice(0, 80);
    this.sql.exec(
      `INSERT INTO users (email, name, created_at) VALUES (?, ?, ?) ON CONFLICT (email) DO UPDATE SET name = excluded.name`,
      email,
      clean || null,
      new Date().toISOString(),
    );
  }

  addChannel(email: string, type: ChannelType, config: Record<string, unknown>, label: string): string {
    const count = this.sql.exec(`SELECT COUNT(*) AS n FROM channels WHERE email = ?`, email).one().n as number;
    if (count >= 10) throw new HubError("you can have at most 10 notification channels");
    // The same browser subscribing twice replaces its old subscription.
    if (type === "webpush") {
      for (const c of this.sql.exec(`SELECT id, config FROM channels WHERE email = ? AND type = 'webpush'`, email).toArray()) {
        if ((JSON.parse(c.config as string) as { endpoint?: string }).endpoint === config.endpoint) {
          this.sql.exec(`DELETE FROM channels WHERE id = ?`, c.id);
        }
      }
    }
    const channelId = `n${newId().slice(1)}`;
    this.sql.exec(
      `INSERT INTO channels (id, email, type, label, config, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      channelId,
      email,
      type,
      label,
      JSON.stringify(config),
      new Date().toISOString(),
    );
    return channelId;
  }

  removeChannel(email: string, channelId: string): boolean {
    return this.sql.exec(`DELETE FROM channels WHERE id = ? AND email = ? RETURNING id`, channelId, email).toArray().length > 0;
  }

  channelConfig(email: string, channelId: string): { type: ChannelType; config: Record<string, unknown> } | null {
    const c = this.sql.exec(`SELECT type, config FROM channels WHERE id = ? AND email = ?`, channelId, email).toArray()[0];
    return c ? { type: c.type as ChannelType, config: JSON.parse(c.config as string) } : null;
  }

  /** Track delivery health; a channel is switched off after repeated failures or when its endpoint is gone. */
  recordChannelResult(channelId: string, result: { ok: boolean; error?: string; gone?: boolean }) {
    if (result.ok) {
      this.sql.exec(`UPDATE channels SET failures = 0, last_error = NULL, disabled = 0 WHERE id = ?`, channelId);
      return;
    }
    if (result.gone) {
      this.sql.exec(`DELETE FROM channels WHERE id = ?`, channelId);
      return;
    }
    this.sql.exec(
      `UPDATE channels SET failures = failures + 1, last_error = ?, disabled = CASE WHEN failures + 1 >= ? THEN 1 ELSE disabled END WHERE id = ?`,
      (result.error ?? "failed").slice(0, 300),
      CHANNEL_MAX_FAILURES,
      channelId,
    );
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
    return this.watchLevel(email, id);
  }

  private watchLevel(email: string, id: string): WatchLevel {
    const row = this.sql.exec(`SELECT level FROM watches WHERE email = ? AND artifact_id = ?`, email, id).toArray()[0];
    return (row?.level as WatchLevel | undefined) ?? defaultLevel(ownerList(this.env).includes(email));
  }

  // ---- notifications -------------------------------------------------------------

  /**
   * Queue notifications for a new comment. Mentions and replies to threads you
   * took part in reach "participating" watchers; every comment reaches "all"
   * watchers (owners by default). Muted people get nothing.
   */
  private notifyComment(
    id: string,
    actor: Actor,
    c: { thread: string; text: string; participants: string[]; reply: boolean; origin?: string },
  ) {
    const mentioned = new Set(mentionedEmails(c.text));
    const participants = new Set(c.participants);
    const candidates = new Set<string>([...mentioned, ...participants, ...ownerList(this.env)]);
    for (const r of this.sql.exec(`SELECT email FROM watches WHERE artifact_id = ? AND level = 'all'`, id)) candidates.add(r.email as string);
    const owners = new Set(ownerList(this.env));
    for (const email of candidates) {
      if (email === actor || !email.includes("@")) continue;
      // The agent acts for the owners, so its comments are their own actions.
      if (actor === "agent" && owners.has(email)) continue;
      const level = this.watchLevel(email, id);
      if (level === "mute") continue;
      const why = mentioned.has(email) ? "mention" : participants.has(email) ? "reply" : "all";
      if (why === "all" && level !== "all") continue;
      if (!this.canOpen(id, email)) continue;
      this.enqueue(email, id, "comment", { thread: c.thread, by: actor, text: c.text.slice(0, 300), why, reply: c.reply, origin: c.origin }, COMMENT_DELAY_MS);
    }
  }

  private notifyResolved(id: string, actor: Actor, thread: Thread, origin?: string) {
    const author = thread.by;
    if (author === actor || !author.includes("@") || this.watchLevel(author, id) === "mute" || !this.canOpen(id, author)) return;
    this.enqueue(author, id, "resolve", { thread: thread.id, by: actor, addressedIn: thread.addressedIn ?? null, origin }, COMMENT_DELAY_MS);
  }

  /** Page updates reach "all" watchers other than owners (whose agents make them), batched over a quiet period. */
  private notifyUpdate(id: string, actor: Actor, version: number, note: string, origin?: string) {
    const owners = new Set(ownerList(this.env));
    for (const r of this.sql.exec(`SELECT email FROM watches WHERE artifact_id = ? AND level = 'all'`, id).toArray()) {
      const email = r.email as string;
      if (email === actor || owners.has(email) || !this.canOpen(id, email)) continue;
      const pending = this.sql
        .exec(`SELECT id, data FROM outbox WHERE email = ? AND artifact_id = ? AND kind = 'update'`, email, id)
        .toArray()[0];
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

  private canOpen(id: string, email: string): boolean {
    return this.roleFor(id, email, ownerList(this.env).includes(email)) !== null;
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
    void this.armAlarm();
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
    const env = this.env as NotifyEnv;
    let sends = 0;
    for (const rows of groups.values()) {
      const email = rows[0].email as string;
      const id = rows[0].artifact_id as string;
      const channels = this.sql.exec(`SELECT id, type, config FROM channels WHERE email = ? AND disabled = 0`, email).toArray();
      if (sends + channels.length > SENDS_PER_ALARM && sends > 0) break;
      for (const r of rows) this.sql.exec(`DELETE FROM outbox WHERE id = ?`, r.id);
      const art = this.sql.exec(`SELECT title FROM artifacts WHERE id = ?`, id).toArray()[0];
      if (!art || !channels.length || this.isViewing(id, email) || !this.canOpen(id, email)) continue;
      const items: OutboxItem[] = rows.map((r) => ({ kind: r.kind as OutboxItem["kind"], data: JSON.parse(r.data as string) }));
      const origin = items.map((i) => i.data.origin).find((o): o is string => typeof o === "string") ?? "";
      const msg = composeMessage({ title: art.title as string, artifactId: id, origin, items, nameOf: (e) => this.nameOf(e) });
      for (const c of channels) {
        sends++;
        const result = await sendToChannel(c.type as ChannelType, JSON.parse(c.config as string), msg, env).catch((err: Error) => ({
          ok: false as const,
          error: err.message,
        }));
        this.recordChannelResult(c.id as string, result);
      }
    }
    return sends;
  }

  private isViewing(id: string, email: string): boolean {
    return this.ctx.getWebSockets(id).some((ws) => (ws.deserializeAttachment() as SocketTag).email === email);
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
    if (baseVersion !== undefined && baseVersion !== current) {
      return {
        ok: false,
        version: current,
        errors: [{ path: "", message: `stale baseVersion ${baseVersion}; the artifact is at v${current}. Re-read and retry.` }],
      };
    }
    const files = this.files(id);
    try {
      mutate(files);
    } catch (err) {
      if (err instanceof EditError || err instanceof HubError) {
        return { ok: false, version: current, errors: [{ path: "", message: err.message }] };
      }
      throw err;
    }
    const { build, errors } = await buildArtifact(files);
    if (!build) return { ok: false, version: current, errors };
    const next = current + 1;
    const now = new Date().toISOString();
    const resolves = (opts.resolves ?? []).filter((t) =>
      this.sql.exec(`SELECT 1 FROM threads WHERE id = ? AND artifact_id = ?`, t, id).toArray().length > 0,
    );
    const actor = opts.actor ?? "agent";
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM files WHERE artifact_id = ?`, id);
      this.sql.exec(`UPDATE artifacts SET version = ?, updated_at = ? WHERE id = ?`, next, now, id);
      this.commitFiles(id, next, files, build, note, now);
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
    this.broadcast(id, { t: "version", version: next, note });
    for (const t of resolves) {
      const thread = this.thread(t);
      if (!thread) continue;
      this.broadcast(id, { t: "thread", thread });
      this.notifyResolved(id, actor, thread, opts.origin);
    }
    this.notifyUpdate(id, actor, next, note, opts.origin);
    return { ok: true, id, version: next, files: Object.keys(files).sort() };
  }

  private commitFiles(id: string, version: number, files: Record<string, string>, build: Build, note: string, now: string) {
    for (const [path, content] of Object.entries(files)) {
      this.sql.exec(`INSERT INTO files (artifact_id, path, content) VALUES (?, ?, ?)`, id, path, content);
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
      JSON.stringify(files),
      note,
      now,
      JSON.stringify(build.blocks ?? []),
    );
    this.sql.exec(`DELETE FROM history WHERE artifact_id = ? AND version <= ?`, id, version - HISTORY_KEEP);
  }

  private requireArtifact(id: string) {
    const row = this.sql.exec(`SELECT * FROM artifacts WHERE id = ?`, id).toArray()[0];
    if (!row) throw new HubError(`no artifact ${id}; see artifact_list`);
    return row;
  }

  private broadcast(id: string, msg: SyncServerMessage) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets(id)) {
      if (msg.t === "thread" && !(ws.deserializeAttachment() as SocketTag).email) continue;
      try {
        ws.send(text);
      } catch {
        // closed socket; the close handler cleans up presence
      }
    }
  }

  private broadcastPresence(id: string, closing?: WebSocket) {
    const viewers = new Set<string>();
    for (const ws of this.ctx.getWebSockets(id)) {
      if (ws === closing) continue;
      const tag = ws.deserializeAttachment() as SocketTag;
      if (tag.email) viewers.add(tag.email);
    }
    this.broadcast(id, { t: "presence", viewers: [...viewers].sort() });
  }
}

function send(ws: WebSocket, msg: SyncServerMessage) {
  ws.send(JSON.stringify(msg));
}

function toMeta(r: Record<string, SqlStorageValue>): ArtifactMeta {
  return {
    id: r.id as string,
    title: r.title as string,
    description: r.description as string,
    version: r.version as number,
    public: Boolean(r.public),
    preview: Boolean(r.preview),
    archivedAt: (r.archived_at as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function newId(): string {
  // 12 chars of base32: unguessable enough for links that are also ACL-gated.
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `a${[...bytes].map((b) => alphabet[b % alphabet.length]).join("")}`;
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
async function fetchSource(url: string, pick: string | null): Promise<JsonValue> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "Shared-Artifacts/1 (+https://github.com/micthiesen/artifacts)" },
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
  });
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

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export type ChangeOptions = {
  /** Version note shown in history and the "changed since" banner. */
  note?: string;
  /** Thread ids this change addresses; they are resolved as "Addressed in vN". */
  resolves?: string[];
  actor?: Actor;
  origin?: string;
};

function ownerList(env: unknown): string[] {
  return String((env as { OWNER_EMAILS?: string }).OWNER_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

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
function stampCollab(
  key: string,
  value: JsonValue | null,
  by: string,
  exists: boolean,
  existingBy: string | null,
  role: Role | undefined,
): JsonValue | null {
  const poll = /^poll\/[^/]+\/(.+)$/.exec(key);
  if (poll) {
    if (poll[1] !== by) throw new HubError("you can only change your own vote");
    return value;
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

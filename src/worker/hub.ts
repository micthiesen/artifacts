// ArtifactHub: the single Durable Object that stores every artifact, its file
// history, sharing, shared state and live sync sockets. One instance ("hub") is
// plenty for a handful of viewers and keeps every write transactional.
import { DurableObject } from "cloudflare:workers";
import { buildArtifact, type Build, type CompileError } from "./compile.ts";
import { renderCheck, type CheckEnv, type CheckOutcome, type RenderCheck } from "./check.ts";
import { domainOf, sharePrincipal } from "./principal.ts";
import { applyJsonPatch, applyTextEdits, EditError, grepFiles, type JsonPatchOp, type TextEdit } from "./edit.ts";
import {
  SHARED_STATE_MAX_BYTES,
  SHARED_VALUE_MAX_BYTES,
  type JsonValue,
  type Role,
  type SyncClientMessage,
  type SyncServerMessage,
} from "../shared/protocol.ts";

export type ArtifactMeta = {
  id: string;
  title: string;
  description: string;
  version: number;
  public: boolean;
  createdAt: string;
  updatedAt: string;
};

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
  >
> & { fetch(request: Request): Promise<Response> };

type SocketTag = { id: string; email: string | null; role: Role };

const HISTORY_KEEP = 50;
const ASSETS_MAX_BYTES = 20 * 1024 * 1024;
const SOURCE_MAX_BYTES = 1024 * 1024;
const EXPORT_TABLES = ["artifacts", "files", "history", "builds", "shares", "state", "errors", "checks", "assets", "sources", "allowed_hosts"];
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
    `);
    // Columns added after the first deploy.
    const checkCols = this.sql.exec(`PRAGMA table_info(checks)`).toArray().map((c) => c.name);
    if (!checkCols.includes("screenshot")) this.sql.exec(`ALTER TABLE checks ADD COLUMN screenshot TEXT`);
  }

  // ---- reads -------------------------------------------------------------

  list(viewer: { email: string | null; owner: boolean }): (ArtifactMeta & { role: Role })[] {
    if (viewer.owner) {
      return this.sql
        .exec(`SELECT *, 'owner' AS role FROM artifacts ORDER BY updated_at DESC`)
        .toArray()
        .map((r) => ({ ...toMeta(r), role: "owner" as Role }));
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
    return [...byId.values()].map((r) => ({ ...toMeta(r), role: r.role as Role }));
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

  async create(input: { title: string; description?: string; files: Record<string, string> }): Promise<WriteResult> {
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
    });
    return { ok: true, id, version: 1, files: Object.keys(input.files).sort() };
  }

  async editText(id: string, path: string, edits: TextEdit[], baseVersion?: number): Promise<WriteResult> {
    return this.change(id, baseVersion, `edit ${path}`, (files) => {
      if (!(path in files)) throw new EditError(`no file ${path}; files: ${Object.keys(files).join(", ")}`);
      files[path] = applyTextEdits(path, files[path], edits);
    });
  }

  async writeFiles(id: string, changes: Record<string, string | null>, baseVersion?: number): Promise<WriteResult> {
    const note = Object.entries(changes)
      .map(([p, c]) => `${c === null ? "delete" : "write"} ${p}`)
      .join(", ");
    return this.change(id, baseVersion, note, (files) => {
      for (const [path, content] of Object.entries(changes)) {
        if (content === null) {
          if (!(path in files)) throw new EditError(`cannot delete ${path}: no such file`);
          delete files[path];
        } else files[path] = content;
      }
    });
  }

  async patchData(id: string, path: string, ops: JsonPatchOp[], baseVersion?: number): Promise<WriteResult> {
    return this.change(id, baseVersion, `patch ${path}`, (files) => {
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

  async revert(id: string, version: number): Promise<WriteResult> {
    const row = this.sql.exec(`SELECT files FROM history WHERE artifact_id = ? AND version = ?`, id, version).toArray()[0];
    if (!row) throw new HubError(`no stored version ${version}; see artifact_history`);
    const target = JSON.parse(row.files as string) as Record<string, string>;
    return this.change(id, undefined, `revert to v${version}`, (files) => {
      for (const k of Object.keys(files)) delete files[k];
      Object.assign(files, target);
    });
  }

  updateMeta(id: string, patch: { title?: string; description?: string }): ArtifactMeta {
    this.requireArtifact(id);
    if (patch.title !== undefined) this.sql.exec(`UPDATE artifacts SET title = ? WHERE id = ?`, patch.title, id);
    if (patch.description !== undefined) {
      this.sql.exec(`UPDATE artifacts SET description = ? WHERE id = ?`, patch.description, id);
    }
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
      for (const t of ["files", "history", "builds", "shares", "state", "errors", "checks", "assets", "sources"]) {
        this.sql.exec(`DELETE FROM ${t} WHERE artifact_id = ?`, id);
      }
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

  /** Set (or delete with null) shared keys as `by`; broadcasts to live viewers. */
  setState(id: string, changes: Record<string, JsonValue | null>, by: string | null, cid?: string): number {
    this.requireArtifact(id);
    let seq = 0;
    const applied: { key: string; value: JsonValue | null; seq: number }[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const [key, value] of Object.entries(changes)) {
        if (key.length === 0 || key.length > 200) throw new HubError(`state key "${key.slice(0, 40)}" must be 1-200 chars`);
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
        applied.push({ key, value, seq });
      }
      const total = this.sql
        .exec(`SELECT COALESCE(SUM(length(value)), 0) AS n FROM state WHERE artifact_id = ?`, id)
        .one().n as number;
      if (total > SHARED_STATE_MAX_BYTES) throw new HubError(`shared state for this artifact would exceed 4 MB`);
    });
    for (const a of applied) this.broadcast(id, { t: "set", key: a.key, value: a.value, seq: a.seq, by, cid });
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
    if (!next) return;
    const id = next.artifact_id as string;
    const row = this.sql.exec(`SELECT version FROM artifacts WHERE id = ?`, id).toArray()[0];
    if (!row) {
      this.sql.exec(`DELETE FROM checks WHERE artifact_id = ?`, id);
    } else {
      this.nextCheckAt = Date.now() + CHECK_SPACING_MS;
      await this.runCheck(id, row.version as number, next.origin as string);
    }
    const remaining = this.sql.exec(`SELECT COUNT(*) AS n FROM checks WHERE status = 'queued'`).one().n as number;
    if (remaining > 0) await this.ctx.storage.setAlarm(Math.max(Date.now() + CHECK_SPACING_MS, this.nextCheckAt));
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
    void this.ctx.storage.getAlarm().then((existing) => {
      if (existing === null || existing > at) return this.ctx.storage.setAlarm(at);
    });
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
    if (request.headers.get("Upgrade") !== "websocket" || !role) return new Response("expected websocket", { status: 400 });
    this.requireArtifact(id);
    const pair = new WebSocketPair();
    const tag: SocketTag = { id, email, role };
    this.ctx.acceptWebSocket(pair[1], [id]);
    pair[1].serializeAttachment(tag);
    const seq = this.sql.exec(`SELECT state_seq FROM artifacts WHERE id = ?`, id).one().state_seq as number;
    send(pair[1], { t: "snapshot", seq, state: this.state(id) });
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
    if (msg.t !== "set") return;
    if (tag.role === "view" || !tag.email) {
      send(ws, { t: "rejected", cid: msg.cid, reason: "this viewer has read-only access" });
      return;
    }
    try {
      this.setState(tag.id, { [msg.key]: msg.value }, tag.email, msg.cid);
    } catch (err) {
      send(ws, { t: "rejected", cid: msg.cid, reason: (err as Error).message });
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

  // ---- internals -------------------------------------------------------------

  private async change(
    id: string,
    baseVersion: number | undefined,
    note: string,
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
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM files WHERE artifact_id = ?`, id);
      this.sql.exec(`UPDATE artifacts SET version = ?, updated_at = ? WHERE id = ?`, next, now, id);
      this.commitFiles(id, next, files, build, note, now);
    });
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
      `INSERT INTO history (artifact_id, version, files, note, created_at) VALUES (?, ?, ?, ?, ?)`,
      id,
      version,
      JSON.stringify(files),
      note,
      now,
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

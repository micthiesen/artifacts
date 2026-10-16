// ArtifactHub: the single Durable Object that stores every artifact, its file
// history, sharing, shared state and live sync sockets. One instance ("hub") is
// plenty for a handful of viewers and keeps every write transactional.
import { DurableObject } from "cloudflare:workers";
import { buildArtifact, type Build, type CompileError } from "./compile.ts";
import { renderCheck, type CheckEnv, type RenderCheck } from "./check.ts";
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
    | "runRenderCheck"
  >
> & { fetch(request: Request): Promise<Response> };

type SocketTag = { id: string; email: string | null; role: Role };

const HISTORY_KEEP = 50;
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
      CREATE TABLE IF NOT EXISTS errors (
        artifact_id TEXT NOT NULL, at TEXT NOT NULL, version INTEGER NOT NULL, viewer TEXT, message TEXT NOT NULL,
        stack TEXT);
    `);
  }

  // ---- reads -------------------------------------------------------------

  list(viewer: { email: string | null; owner: boolean }): (ArtifactMeta & { role: Role })[] {
    const rows = viewer.owner
      ? this.sql.exec(`SELECT *, 'owner' AS role FROM artifacts ORDER BY updated_at DESC`).toArray()
      : this.sql
          .exec(
            `SELECT a.*, s.role AS role FROM artifacts a JOIN shares s ON s.artifact_id = a.id
             WHERE s.email = ? ORDER BY a.updated_at DESC`,
            viewer.email ?? "",
          )
          .toArray();
    return rows.map((r) => ({ ...toMeta(r), role: r.role as Role }));
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
      const share = this.sql.exec(`SELECT role FROM shares WHERE artifact_id = ? AND email = ?`, id, email).toArray()[0];
      if (share) return share.role as Role;
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
          s.email.trim().toLowerCase(),
          s.role,
        );
      }
      for (const email of input.remove ?? []) {
        this.sql.exec(`DELETE FROM shares WHERE artifact_id = ? AND email = ?`, id, email.trim().toLowerCase());
      }
      if (input.public !== undefined) this.sql.exec(`UPDATE artifacts SET public = ? WHERE id = ?`, input.public ? 1 : 0, id);
    });
    // Drop live sockets that lost access; they reconnect and are re-checked.
    const removed = new Set((input.remove ?? []).map((e) => e.trim().toLowerCase()));
    for (const ws of this.ctx.getWebSockets(id)) {
      const tag = ws.deserializeAttachment() as SocketTag;
      const changedRole = (input.add ?? []).some((s) => s.email.toLowerCase() === tag.email);
      if ((tag.email && removed.has(tag.email)) || changedRole || (input.public === false && !tag.email)) {
        ws.close(4003, "access changed");
      }
    }
    return this.meta(id);
  }

  delete(id: string) {
    this.requireArtifact(id);
    this.ctx.storage.transactionSync(() => {
      for (const t of ["files", "history", "builds", "shares", "state", "errors", "checks"]) {
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
  async runRenderCheck(id: string, origin: string, force = false): Promise<RenderCheck & { version: number }> {
    const version = this.requireArtifact(id).version as number;
    const stored = this.sql.exec(`SELECT version, status, result FROM checks WHERE artifact_id = ?`, id).toArray()[0];
    if (!force && stored && stored.version === version && stored.status === "done") {
      const previous = JSON.parse(stored.result as string) as RenderCheck;
      // Only definitive results are reused; a skipped check is retried.
      if (previous.status === "ok" || previous.status === "errors") return { ...previous, version };
    }
    const now = Date.now();
    const slot = Math.max(now, this.nextCheckAt);
    if (slot - now <= CHECK_INLINE_WAIT_MS) {
      this.nextCheckAt = slot + CHECK_SPACING_MS;
      if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
      const result = await this.runCheck(id, version, origin);
      if (result) return { ...result, version };
    }
    return { ...this.queueCheck(id, version, origin), version };
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
  private async runCheck(id: string, version: number, origin: string): Promise<RenderCheck | null> {
    const result = await renderCheck(this.checkEnv, origin, id, version);
    if (result.status === "rate-limited") {
      this.nextCheckAt = Date.now() + CHECK_SPACING_MS;
      return null;
    }
    this.sql.exec(
      `INSERT INTO checks (artifact_id, version, origin, status, result, at) VALUES (?, ?, ?, 'done', ?, ?)
       ON CONFLICT (artifact_id) DO UPDATE SET version = excluded.version, origin = excluded.origin,
         status = 'done', result = excluded.result, at = excluded.at`,
      id,
      version,
      origin,
      JSON.stringify(result),
      Date.now(),
    );
    if (result.status === "errors") for (const e of result.errors) this.recordError(id, "render-check", e);
    return result;
  }

  private queueCheck(id: string, version: number, origin: string): RenderCheck {
    this.sql.exec(
      `INSERT INTO checks (artifact_id, version, origin, status, result, at) VALUES (?, ?, ?, 'queued', NULL, ?)
       ON CONFLICT (artifact_id) DO UPDATE SET version = excluded.version, origin = excluded.origin,
         status = 'queued', result = NULL, at = excluded.at`,
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

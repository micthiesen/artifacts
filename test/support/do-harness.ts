// In-process harness for ArtifactHub under Bun: a bun:sqlite-backed SqlStorage,
// a fake DurableObjectState, fake hibernating WebSockets and a patched `Response`
// that tolerates status 101. Import `createHub` from here; the hub module is
// imported lazily (after `cloudflare:workers` is mocked), so never import
// src/worker/hub.ts statically in a test that uses this harness (type imports are fine).
import { Database } from "bun:sqlite";
import { mock } from "bun:test";
import type { Workspace } from "../../src/worker/hub.ts";
import type { Directory } from "../../src/worker/directory.ts";

mock.module("cloudflare:workers", () => ({
  // The OAuth library checks handlers against this.
  WorkerEntrypoint: class {},
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// ---- SqlStorage ----------------------------------------------------------------

type SqlValue = string | number | null | ArrayBuffer;

export class FakeCursor {
  readonly columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
  private rows: Record<string, SqlValue>[];
  private pos = 0;
  constructor(columnNames: string[], rows: Record<string, SqlValue>[], rowsWritten: number) {
    this.columnNames = columnNames;
    this.rows = rows;
    this.rowsRead = rows.length;
    this.rowsWritten = rowsWritten;
  }
  next(): IteratorResult<Record<string, SqlValue>> {
    return this.pos < this.rows.length ? { done: false, value: this.rows[this.pos++] } : { done: true, value: undefined };
  }
  [Symbol.iterator]() {
    return this;
  }
  toArray() {
    const rest = this.rows.slice(this.pos);
    this.pos = this.rows.length;
    return rest;
  }
  one() {
    const rest = this.toArray();
    if (rest.length !== 1) throw new Error(`Expected exactly one result from SQL query, but got ${rest.length} results.`);
    return rest[0];
  }
  raw() {
    const rest = this.toArray();
    return rest.map((r) => this.columnNames.map((c) => r[c]))[Symbol.iterator]();
  }
}

function toBinding(v: unknown): unknown {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === undefined) return null;
  return v;
}

function fromRow(row: Record<string, unknown>): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Uint8Array) out[k] = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
    else if (typeof v === "bigint") out[k] = Number(v);
    else out[k] = v as SqlValue;
  }
  return out;
}

export class FakeSqlStorage {
  readonly db = new Database(":memory:");
  get databaseSize(): number {
    const page = this.db.query("PRAGMA page_size").get() as { page_size: number };
    const count = this.db.query("PRAGMA page_count").get() as { page_count: number };
    return page.page_size * count.page_count;
  }
  exec(query: string, ...bindings: unknown[]): FakeCursor {
    if (bindings.length === 0) {
      const stmt = this.db.prepare(query);
      const cols = stmt.columnNames;
      if (cols.length > 0) return new FakeCursor(cols, stmt.all().map((r) => fromRow(r as never)), 0);
      stmt.finalize();
      // No result columns: may be a multi-statement script, so run it whole.
      const res = this.db.run(query);
      return new FakeCursor([], [], res.changes);
    }
    const stmt = this.db.prepare(query);
    const cols = stmt.columnNames;
    const args = bindings.map(toBinding) as never[];
    if (cols.length > 0) return new FakeCursor(cols, stmt.all(...args).map((r) => fromRow(r as never)), 0);
    const res = stmt.run(...args);
    return new FakeCursor([], [], res.changes);
  }
}

// ---- WebSockets ----------------------------------------------------------------

export class FakeSocket {
  /** Raw text frames sent to this socket (server side: what the client would receive). */
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private attachment: unknown = null;
  send(data: string | ArrayBuffer) {
    if (this.closed) throw new Error("socket is closed");
    this.sent.push(typeof data === "string" ? data : new TextDecoder().decode(data));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  serializeAttachment(v: unknown) {
    this.attachment = v === undefined ? null : structuredClone(v);
  }
  deserializeAttachment() {
    return this.attachment === null ? null : structuredClone(this.attachment);
  }
  /** Parsed JSON messages sent so far. */
  get messages(): any[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

export function createSocketPair(): [FakeSocket, FakeSocket] {
  return [new FakeSocket(), new FakeSocket()];
}

/** `new WebSocketPair()` yields `{0: client, 1: server}` like the Workers runtime. */
class FakeWebSocketPair {
  0: FakeSocket;
  1: FakeSocket;
  constructor() {
    [this[0], this[1]] = createSocketPair();
  }
}
(globalThis as any).WebSocketPair = FakeWebSocketPair;

// ---- DurableObjectState ----------------------------------------------------------

export class FakeCtx {
  readonly sqlStorage = new FakeSqlStorage();
  alarm: number | null = null;
  readonly sockets: { ws: FakeSocket; tags: string[] }[] = [];
  readonly waited: Promise<unknown>[] = [];
  private txDepth = 0;

  storage = {
    sql: this.sqlStorage,
    transactionSync: <T>(fn: () => T): T => {
      const db = this.sqlStorage.db;
      const name = `sp${this.txDepth++}`;
      db.run(`SAVEPOINT ${name}`);
      try {
        const out = fn();
        db.run(`RELEASE ${name}`);
        return out;
      } catch (err) {
        db.run(`ROLLBACK TO ${name}`);
        db.run(`RELEASE ${name}`);
        throw err;
      } finally {
        this.txDepth--;
      }
    },
    getAlarm: async () => this.alarm,
    setAlarm: async (ms: number | Date) => {
      this.alarm = ms instanceof Date ? ms.getTime() : ms;
    },
    deleteAlarm: async () => {
      this.alarm = null;
    },
    /** Like the runtime: every table, the schema included, is gone. */
    deleteAll: async () => {
      const db = this.sqlStorage.db;
      for (const r of db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]) {
        db.run(`DROP TABLE IF EXISTS "${r.name}"`);
      }
    },
  };

  acceptWebSocket(ws: FakeSocket, tags: string[] = []) {
    this.sockets.push({ ws, tags });
  }
  /** Like the runtime, closed sockets are not returned. */
  getWebSockets(tag?: string): FakeSocket[] {
    return this.sockets.filter((s) => !s.ws.closed && (tag === undefined || s.tags.includes(tag))).map((s) => s.ws);
  }
  async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  waitUntil(p: Promise<unknown>) {
    this.waited.push(p);
  }
}

// ---- Response with 101 --------------------------------------------------------------

/** Run `fn` with a global Response that accepts `{status: 101, webSocket}` (Bun rejects 101). */
async function withUpgradeableResponse<T>(fn: () => Promise<T>): Promise<T> {
  const Orig = globalThis.Response;
  class Patched extends Orig {
    webSocket?: unknown;
    constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
      if (init?.status === 101) {
        super(null, { ...init, status: 200 });
        this.webSocket = init.webSocket;
        Object.defineProperty(this, "status", { value: 101 });
      } else super(body, init);
    }
  }
  (globalThis as any).Response = Patched;
  try {
    return await fn();
  } finally {
    (globalThis as any).Response = Orig;
  }
}

// ---- Harness -----------------------------------------------------------------------

export type HarnessEnv = {
  SESSION_SECRET: string;
  LOGIN_SECRET: string;
  BROWSER?: unknown;
  [k: string]: unknown;
};

/** The workspace's first admin; tests that care about roles use other people. */
export const ADMIN = "admin@example.com";

export type Harness = {
  hub: Workspace;
  /** The global directory the workspace reports to (names, channels, memberships). */
  directory: Directory;
  ctx: FakeCtx;
  env: HarnessEnv;
  /** Every connection opened via connect(), in order. */
  connections: Connection[];
};

export type Connection = {
  /** Server-side socket: `.messages` / `.sent` are what the viewer receives. */
  socket: FakeSocket;
  /** Client-side end of the pair (unused by the hub, exposed for completeness). */
  client: FakeSocket;
  response: Response;
  /** Send a client message through hub.webSocketMessage. */
  send(msg: unknown): Promise<void>;
  /** Simulate the client disconnecting (closes the socket, then calls hub.webSocketClose). */
  disconnect(): Promise<void>;
};

export async function createHub(env: Partial<HarnessEnv> = {}, slug = "acme"): Promise<Harness> {
  const { Workspace } = await import("../../src/worker/hub.ts");
  const { Directory } = await import("../../src/worker/directory.ts");
  const ctx = new FakeCtx();
  const fullEnv: HarnessEnv = {
    SESSION_SECRET: "test-session-secret",
    LOGIN_SECRET: "test-login-secret",
    BROWSER: undefined, // renderCheck returns {status:"skipped"} without touching the network
    ...env,
  };
  const directory = new Directory(new FakeCtx() as never, fullEnv as never);
  fullEnv.DIRECTORY = { getByName: () => directory };
  directory.createWorkspace(slug, slug[0].toUpperCase() + slug.slice(1));
  const hub = new Workspace(ctx as never, fullEnv as never);
  await hub.provision({ slug, name: slug[0].toUpperCase() + slug.slice(1), admin: ADMIN });
  return { hub, directory, ctx, env: fullEnv, connections: [] };
}

/** Open a sync socket through hub.fetch (X-Art-* headers + Upgrade: websocket). */
export async function connect(
  h: Harness,
  opts: { id: string; email: string | null; role: "view" | "edit" | "owner" },
): Promise<Connection> {
  const headers: Record<string, string> = { Upgrade: "websocket", "X-Art-Id": opts.id, "X-Art-Role": opts.role };
  if (opts.email) headers["X-Art-Email"] = opts.email;
  const before = h.ctx.sockets.length;
  const response = await withUpgradeableResponse(() => h.hub.fetch(new Request("https://hub.test/ws", { headers })));
  if (response.status !== 101) throw new Error(`websocket upgrade failed: ${response.status} ${await response.text()}`);
  const socket = h.ctx.sockets[before].ws;
  const client = (response as any).webSocket as FakeSocket;
  const conn: Connection = {
    socket,
    client,
    response,
    send: (msg) => h.hub.webSocketMessage(socket as never, typeof msg === "string" ? msg : JSON.stringify(msg)),
    disconnect: async () => {
      socket.close(1000, "bye");
      await h.hub.webSocketClose(socket as never);
    },
  };
  h.connections.push(conn);
  return conn;
}

/** If an alarm is set, clear it and run hub.alarm(). Returns whether one fired. */
export async function advanceAlarm(h: Harness): Promise<boolean> {
  if (h.ctx.alarm === null) return false;
  h.ctx.alarm = null;
  await h.hub.alarm();
  return true;
}

// ---- R2 ---------------------------------------------------------------------------

/** Just enough of an R2 bucket for backups: put, get, head, delete and delimited list. */
export class FakeR2 {
  readonly objects = new Map<string, string>();
  async put(key: string, value: string) {
    this.objects.set(key, value);
  }
  async get(key: string) {
    const v = this.objects.get(key);
    return v === undefined ? null : { text: async () => v };
  }
  async head(key: string) {
    return this.objects.has(key) ? { key } : null;
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
  async list(opts: { prefix?: string; delimiter?: string; cursor?: string }) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
    if (!opts.delimiter) return { objects: keys.map((key) => ({ key })), delimitedPrefixes: [], truncated: false };
    const prefixes = new Set<string>();
    const objects: { key: string }[] = [];
    for (const k of keys) {
      const rest = k.slice((opts.prefix ?? "").length);
      const i = rest.indexOf(opts.delimiter);
      if (i >= 0) prefixes.add((opts.prefix ?? "") + rest.slice(0, i + 1));
      else objects.push({ key: k });
    }
    return { objects, delimitedPrefixes: [...prefixes], truncated: false };
  }
}

// ---- KV -----------------------------------------------------------------------------

/** In-memory KV with the calls the OAuth library makes. */
export class FakeKV {
  readonly data = new Map<string, string>();
  async get(key: string, type?: "json" | "text" | { type: "json" | "text" }) {
    const v = this.data.get(key);
    if (v === undefined) return null;
    const t = typeof type === "object" ? type.type : type;
    return t === "json" ? JSON.parse(v) : v;
  }
  async put(key: string, value: string) {
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  async list(opts: { prefix?: string; cursor?: string; limit?: number } = {}) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort().map((name) => ({ name }));
    return { keys, list_complete: true, cursor: "" };
  }
}

/** Run the workspace's alarm until its backup/restore jobs are done. */
export async function runJobs(h: Harness, max = 50) {
  for (let i = 0; i < max; i++) {
    const pending = h.ctx.sqlStorage.exec(`SELECT 1 FROM settings WHERE key IN ('job', 'jobs_next')`).toArray().length;
    if (!pending) return;
    await h.hub.alarm();
  }
  throw new Error(`jobs still running after ${max} alarms: ${JSON.stringify(h.hub.job())}`);
}

// In-process harness for ArtifactHub under Bun: a bun:sqlite-backed SqlStorage,
// a fake DurableObjectState, fake hibernating WebSockets and a patched `Response`
// that tolerates status 101. Import `createHub` from here; the hub module is
// imported lazily (after `cloudflare:workers` is mocked), so never import
// src/worker/hub.ts statically in a test that uses this harness (type imports are fine).
import { Database } from "bun:sqlite";
import { mock } from "bun:test";
import type { ArtifactHub } from "../../src/worker/hub.ts";

mock.module("cloudflare:workers", () => ({
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
  MCP_TOKEN: string;
  OWNER_EMAILS: string;
  BROWSER?: unknown;
  [k: string]: unknown;
};

export type Harness = {
  hub: ArtifactHub;
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

export async function createHub(env: Partial<HarnessEnv> = {}): Promise<Harness> {
  const { ArtifactHub } = await import("../../src/worker/hub.ts");
  const ctx = new FakeCtx();
  const fullEnv: HarnessEnv = {
    SESSION_SECRET: "test-session-secret",
    LOGIN_SECRET: "test-login-secret",
    MCP_TOKEN: "test-mcp-token",
    OWNER_EMAILS: "owner@example.com",
    BROWSER: undefined, // renderCheck returns {status:"skipped"} without touching the network
    ...env,
  };
  const hub = new ArtifactHub(ctx as never, fullEnv as never);
  return { hub, ctx, env: fullEnv, connections: [] };
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

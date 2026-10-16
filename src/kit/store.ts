// The frame's single state store. Every hook and stateful component reads from
// here through useSyncExternalStore; the runtime feeds it ShellMessages and it
// sends FrameMessages back through a pluggable transport (window.parent in the
// frame, a fake in tests).
import type { FrameBoot, FrameMessage, JsonValue, Viewer } from "../shared/protocol.ts";
import { SHARED_VALUE_MAX_BYTES } from "../shared/protocol.ts";

export type Theme = "light" | "dark";
type Listener = () => void;

const ANON: Viewer = { email: null, role: "view" };

let transport: (msg: FrameMessage) => void = () => {};
let boot: FrameBoot | null = null;
let viewer: Viewer = ANON;
let shared: Record<string, JsonValue> = {};
let local: Record<string, JsonValue> = {};
let presence: string[] = [];
let theme: Theme = "light";
let initialized = false;
let version = 0;
const listeners = new Set<Listener>();
const prefixCache = new Map<string, { version: number; entries: [string, JsonValue][] }>();
const warned = new Set<string>();

function emit() {
  version++;
  for (const l of [...listeners]) l();
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function setTransport(fn: (msg: FrameMessage) => void) {
  transport = fn;
}

export function post(msg: FrameMessage) {
  transport(msg);
}

export function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[artifact] ${message}`);
}

/** Reset everything (tests, and a repeated `init` from the shell). */
export function reset() {
  boot = null;
  viewer = ANON;
  shared = {};
  local = {};
  presence = [];
  theme = "light";
  initialized = false;
  prefixCache.clear();
  warned.clear();
  emit();
}

// ---- boot / init -----------------------------------------------------------

export function setBoot(b: FrameBoot) {
  boot = b;
  emit();
}
export const getBoot = () => boot;

export function init(msg: {
  viewer: Viewer;
  local: Record<string, JsonValue>;
  shared: Record<string, JsonValue>;
  presence: string[];
  theme: Theme;
}) {
  viewer = msg.viewer ?? ANON;
  local = { ...(msg.local ?? {}) };
  shared = { ...(msg.shared ?? {}) };
  presence = [...(msg.presence ?? [])];
  theme = msg.theme === "dark" ? "dark" : "light";
  initialized = true;
  emit();
}
export const isInitialized = () => initialized;

// ---- viewer / presence / theme ---------------------------------------------

export const getViewer = () => viewer;
export const getPresence = () => presence;
export const getTheme = () => theme;

export function setPresence(v: string[]) {
  presence = [...v];
  emit();
}
export function setTheme(t: Theme) {
  theme = t === "dark" ? "dark" : "light";
  emit();
}

/** Owners and editors with a verified email may write shared state. */
export function canWrite(v: Viewer = viewer): boolean {
  return v.email !== null && v.role !== "view";
}

// ---- shared state ------------------------------------------------------------

export const getShared = (key: string): JsonValue | undefined => shared[key];
export const getSharedSnapshot = () => shared;

function jsonSize(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Optimistic local write + `shared:set`. null/undefined deletes. Returns false if refused. */
export function setShared(key: string, value: JsonValue | null | undefined): boolean {
  if (!canWrite()) {
    warnOnce(
      "readonly",
      viewer.email === null
        ? "Shared state is read-only for anonymous viewers; the write was ignored."
        : "Shared state is read-only with view access; the write was ignored.",
    );
    return false;
  }
  if (typeof key !== "string" || key.length === 0) throw new Error("Shared state keys must be non-empty strings");
  if (value === undefined || value === null) {
    if (!(key in shared)) return true;
    const next = { ...shared };
    delete next[key];
    shared = next;
    emit();
    post({ t: "shared:set", key, value: null });
    return true;
  }
  const size = jsonSize(value);
  if (size > SHARED_VALUE_MAX_BYTES) {
    console.error(`[artifact] shared value for "${key}" is ${size} bytes; the limit is ${SHARED_VALUE_MAX_BYTES}. Write ignored.`);
    return false;
  }
  shared = { ...shared, [key]: value };
  emit();
  post({ t: "shared:set", key, value });
  return true;
}

/** Apply authoritative changes from the shell (null deletes). */
export function applyShared(changes: Record<string, JsonValue | null>) {
  let next: Record<string, JsonValue> | null = null;
  for (const [k, v] of Object.entries(changes)) {
    next ??= { ...shared };
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  if (next) {
    shared = next;
    emit();
  }
}

/** Entries under `${prefix}/`, keyed by the remainder, sorted by key. Stable between changes. */
export function getPrefixEntries(prefix: string): [string, JsonValue][] {
  const cached = prefixCache.get(prefix);
  if (cached && cached.version === version) return cached.entries;
  const p = `${prefix}/`;
  const entries: [string, JsonValue][] = [];
  for (const k of Object.keys(shared)) if (k.startsWith(p)) entries.push([k.slice(p.length), shared[k]]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // Keep the previous array when nothing under this prefix changed, so unrelated
  // writes don't re-render map consumers.
  if (cached && sameEntries(cached.entries, entries)) {
    cached.version = version;
    return cached.entries;
  }
  prefixCache.set(prefix, { version, entries });
  return entries;
}

function sameEntries(a: [string, JsonValue][], b: [string, JsonValue][]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  return true;
}

// ---- per-viewer browser storage ----------------------------------------------

export const getLocal = (key: string): JsonValue | undefined => local[key];
export const getLocalSnapshot = () => local;

/** Per-viewer storage, persisted by the shell. null/undefined deletes. */
export function setLocal(key: string, value: JsonValue | null | undefined) {
  if (value === undefined || value === null) {
    if (!(key in local)) return;
    const next = { ...local };
    delete next[key];
    local = next;
    emit();
    post({ t: "local:set", key, value: undefined });
    return;
  }
  local = { ...local, [key]: value };
  emit();
  post({ t: "local:set", key, value });
}

// ---- data files --------------------------------------------------------------

export function resolveDataPath(path: string): string {
  let p = path.trim().replace(/^\.?\//, "");
  if (!p.startsWith("data/")) p = `data/${p}`;
  return p;
}

export function getData(path: string): JsonValue {
  const data = boot?.data ?? {};
  const key = resolveDataPath(path);
  if (!(key in data)) {
    const have = Object.keys(data);
    throw new Error(
      `Data file "${key}" not found.` + (have.length ? ` Available: ${have.join(", ")}` : " This artifact has no data/*.json files."),
    );
  }
  return data[key];
}

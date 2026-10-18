// Frame runtime. Runs inside the sandboxed artifact frame (opaque origin, no
// network). Every capability arrives from the shell over postMessage.
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FrameBoot, FrameMessage, JsonValue, ShellMessage } from "../shared/protocol.ts";
import * as store from "./store.ts";
import { ErrorBoundary, ErrorPanel } from "./ui/error.tsx";
import { TooltipProvider } from "./ui/controls.tsx";
import { Page } from "./ui/layout.tsx";
import { focusThread, installAnnotations, markChanged, setThreads } from "./annotate.ts";
import { preparePrint } from "./print.ts";

const LS_PREFIX = "ls:";

export type BootOptions = {
  /** Window to talk to; defaults to window.parent. */
  parent?: Window;
  /** Skip storage shims (tests). */
  shims?: boolean;
};

let root: Root | null = null;
let booted = false;

export function readBoot(doc: Document = document): FrameBoot {
  const el = doc.getElementById("art-boot");
  if (!el?.textContent) throw new Error('Missing <script type="application/json" id="art-boot">');
  return JSON.parse(el.textContent) as FrameBoot;
}

/** In-memory Storage. Writes to the local one are mirrored to the shell. */
class MemoryStorage implements Storage {
  #map = new Map<string, string>();
  #onChange?: (key: string, value: string | null) => void;
  constructor(onChange?: (key: string, value: string | null) => void) {
    this.#onChange = onChange;
  }
  /** Replace contents without notifying (used when the shell sends `init`). */
  seed(values: Record<string, string>) {
    this.#map = new Map(Object.entries(values));
  }
  get length() {
    return this.#map.size;
  }
  key(i: number) {
    return [...this.#map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.#map.has(String(k)) ? (this.#map.get(String(k)) as string) : null;
  }
  setItem(k: string, v: string) {
    this.#map.set(String(k), String(v));
    this.#onChange?.(String(k), String(v));
  }
  removeItem(k: string) {
    if (!this.#map.delete(String(k))) return;
    this.#onChange?.(String(k), null);
  }
  clear() {
    for (const k of [...this.#map.keys()]) this.removeItem(k);
  }
}

/**
 * localStorage is kept in the store's per-viewer map under "ls:<key>" (string
 * values), separate from useLocal keys, so it persists through the shell.
 */
export function installStorageShims(win: Window & typeof globalThis = window) {
  const local = new MemoryStorage((key, value) => store.setLocal(LS_PREFIX + key, value));
  const session = new MemoryStorage();
  for (const [name, value] of [
    ["localStorage", local],
    ["sessionStorage", session],
  ] as const) {
    try {
      Object.defineProperty(win, name, { configurable: true, get: () => value });
    } catch (err) {
      console.warn(`[artifact] could not shim ${name}`, err);
    }
  }
  return {
    local,
    session,
    /** Load this viewer's persisted localStorage values from the store. */
    seedFromStore() {
      const seed: Record<string, string> = {};
      for (const [k, v] of Object.entries(store.getLocalSnapshot())) if (k.startsWith(LS_PREFIX) && typeof v === "string") seed[k.slice(LS_PREFIX.length)] = v;
      local.seed(seed);
    },
  };
}

function errorMessage(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message || String(err), stack: err.stack };
  return { message: typeof err === "string" ? err : JSON.stringify(err) ?? String(err) };
}

/** A DOM-only error toast, so it works even if React itself is broken. */
function showErrorToast(message: string) {
  let el = document.getElementById("art-error-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "art-error-toast";
    el.setAttribute("role", "alert");
    el.className =
      "fixed right-4 bottom-4 left-4 z-[100] mx-auto max-w-xl rounded-lg border border-negative/35 bg-popover px-4 py-3 text-sm text-foreground shadow-pop sm:left-auto";
    document.body.appendChild(el);
    const close = document.createElement("button");
    close.textContent = "Dismiss";
    close.className = "ml-3 cursor-pointer text-[13px] font-medium text-muted-foreground hover:text-foreground";
    close.onclick = () => el?.remove();
    const title = document.createElement("div");
    title.className = "flex items-center justify-between font-semibold text-negative";
    title.textContent = "Something went wrong";
    title.appendChild(close);
    const body = document.createElement("div");
    body.className = "mt-1 font-mono text-xs break-words text-muted-foreground";
    el.append(title, body);
  }
  (el.lastChild as HTMLElement).textContent = message;
}

function installErrorHandlers(send: (m: FrameMessage) => void) {
  window.addEventListener("error", (ev) => {
    // Browsers report this when an observer's callback resizes what it watches
    // (diagrams re-laying out to their width); nothing is lost, so not an error.
    if (/^ResizeObserver loop/.test(ev.message)) return;
    const { message, stack } = errorMessage(ev.error ?? ev.message);
    send({ t: "error", message, stack });
    showErrorToast(message);
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const { message, stack } = errorMessage(ev.reason);
    send({ t: "error", message: `Unhandled promise rejection: ${message}`, stack });
    showErrorToast(message);
  });
}

/** Links can't navigate out of the sandbox; ask the shell to open them instead. */
function installLinkHandler(send: (m: FrameMessage) => void) {
  document.addEventListener(
    "click",
    (ev) => {
      if (ev.defaultPrevented || ev.button !== 0) return;
      const a = (ev.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      // In-page anchors stay in the frame; everything else (absolute or relative) goes through the shell.
      if (href.startsWith("#") || /^(javascript|data|blob):/i.test(href)) return;
      if (!/^(https?|mailto):/i.test(a.href)) return;
      ev.preventDefault();
      send({ t: "open", url: a.href });
    },
    true,
  );
}

/**
 * The kit is dark only. The shell still sends `theme` (protocol unchanged), but
 * the frame always renders dark and reports "dark" through useTheme(), so
 * artifact code that branches on the theme matches what is on screen.
 */
const THEME: store.Theme = "dark";
function applyTheme() {
  document.documentElement.classList.add("dark");
  document.documentElement.style.colorScheme = THEME;
}

function isMarkdown(entry: string) {
  return /\.mdx?$/i.test(entry);
}

function Frame({ Entry, markdown }: { Entry: React.ComponentType; markdown: boolean }) {
  const content = (
    <ErrorBoundary report>
      <Entry />
    </ErrorBoundary>
  );
  return <TooltipProvider delay={300}>{markdown ? <Page>{content}</Page> : <div className="h-full">{content}</div>}</TooltipProvider>;
}

function renderFatal(el: HTMLElement, err: Error) {
  root ??= createRoot(el);
  root.render(
    <div className="mx-auto max-w-2xl px-6 py-12">
      <ErrorPanel title="This artifact failed to load" error={err} />
    </div>,
  );
}

/** Wait for `init` from the parent, then render the entry module's default export. */
export async function boot(options: BootOptions = {}): Promise<void> {
  if (booted) return;
  booted = true;
  const check = readCheckFlag();
  const parent = options.parent ?? window.parent;
  const checkErrors: string[] = [];
  (window as { __artErrors?: string[] }).__artErrors = checkErrors;
  const send = (m: FrameMessage) => {
    if (!check) return parent.postMessage(m, "*");
    if (m.t === "error") checkErrors.push(m.message);
  };
  store.setTransport(send);
  installErrorHandlers(send);
  installLinkHandler(send);

  const rootEl = document.getElementById("root") ?? document.body.appendChild(Object.assign(document.createElement("div"), { id: "root" }));

  let bootData: FrameBoot;
  try {
    bootData = readBoot();
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    send({ t: "error", message: e.message, stack: e.stack });
    renderFatal(rootEl, e);
    return;
  }
  store.setBoot(bootData);
  const markdown = isMarkdown(bootData.entry);
  if (!markdown) {
    document.documentElement.classList.add("h-full");
    document.body.classList.add("h-full");
    rootEl.classList.add("h-full");
  }

  // Shim storage before any artifact code runs: the real one throws in an opaque origin.
  const shims = options.shims === false ? null : installStorageShims();

  let resolveInit!: () => void;
  const initialized = new Promise<void>((r) => (resolveInit = r));

  window.addEventListener("message", (ev: MessageEvent) => {
    if (ev.source !== parent) return;
    const msg = ev.data as ShellMessage;
    if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return;
    switch (msg.t) {
      case "init":
        store.init({ ...msg, theme: THEME });
        applyTheme();
        shims?.seedFromStore();
        resolveInit();
        break;
      case "shared":
        store.applyShared(msg.changes as Record<string, JsonValue | null>);
        break;
      case "presence":
        store.setPresence(msg.viewers);
        break;
      case "theme":
        store.setTheme(THEME);
        applyTheme();
        break;
      case "threads":
        whenRendered(() => setThreads(msg.threads, msg.canComment));
        break;
      case "focus":
        whenRendered(() => focusThread(msg.thread));
        break;
      case "changes":
        whenRendered(() => markChanged(msg.blocks));
        break;
      case "print":
        whenRendered(() => void printDocument(msg.title, msg.meta));
        break;
    }
  });

  if (check) {
    // No shell: start from an empty, read-only state.
    store.init({ viewer: { email: null, role: "view" }, local: {}, shared: {}, presence: [], theme: THEME });
    applyTheme();
    resolveInit();
  } else send({ t: "ready" });
  await initialized;

  let mod: { default?: React.ComponentType };
  try {
    // Import only after init so module top-level code sees seeded storage. The
    // entry and its relative imports are data: URLs, so this costs no network.
    mod = (await import(/* @vite-ignore */ bootData.entry)) as { default?: React.ComponentType };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    send({ t: "error", message: `Failed to load ${bootData.entry}: ${e.message}`, stack: e.stack });
    renderFatal(rootEl, e);
    if (check) emitCheck("error", checkErrors, rootEl);
    return;
  }
  const Entry = mod.default;
  if (typeof Entry !== "function" && (typeof Entry !== "object" || Entry === null)) {
    const e = new Error(`${bootData.entry} has no default export. app.tsx must \`export default function App() {…}\`.`);
    send({ t: "error", message: e.message });
    renderFatal(rootEl, e);
    if (check) emitCheck("error", checkErrors, rootEl);
    return;
  }
  root ??= createRoot(rootEl, {
    onUncaughtError: (err) => {
      const { message, stack } = errorMessage(err);
      send({ t: "error", message, stack });
    },
  });
  root.render(<Frame Entry={Entry} markdown={markdown} />);
  if (!check) {
    installAnnotations(rootEl, send);
    // Give the first render (and lazy charts) a moment before anchoring.
    setTimeout(() => {
      rendered = true;
      for (const fn of afterRender.splice(0)) fn();
    }, 150);
  }
  if (check) {
    // Let effects and lazy chunks (charts) settle before declaring success.
    setTimeout(() => emitCheck(checkErrors.length ? "error" : "rendered", checkErrors, rootEl), 600);
  }
}

let rendered = false;
const afterRender: (() => void)[] = [];
function whenRendered(fn: () => void) {
  if (rendered) fn();
  else afterRender.push(fn);
}

let restorePrint: (() => void) | null = null;
/** Expand tabs, accordions and limited tables, then print the frame's own document. */
async function printDocument(title: string, meta: string) {
  restorePrint?.();
  document.body.dataset.printTitle = title;
  document.body.dataset.printMeta = meta;
  restorePrint = await preparePrint();
  window.print();
}
window.addEventListener("afterprint", () => {
  restorePrint?.();
  restorePrint = null;
});

/** Publishes the render-check result as `<pre id="art-check">` JSON for the headless reader. */
function emitCheck(status: "rendered" | "error", errors: string[], rootEl: HTMLElement) {
  if (document.getElementById("art-check")) return;
  const el = document.createElement("pre");
  el.id = "art-check";
  // Kept inside the viewport (1px, transparent): the scraper skips off-screen elements.
  el.style.cssText = "position:fixed;left:0;bottom:0;width:1px;height:1px;margin:0;overflow:hidden;opacity:0;pointer-events:none";
  el.textContent = JSON.stringify({ status, errors, textLength: rootEl.textContent?.trim().length ?? 0 });
  document.body.appendChild(el);
}

function readCheckFlag(): boolean {
  try {
    return readBoot().check === true;
  } catch {
    return false;
  }
}

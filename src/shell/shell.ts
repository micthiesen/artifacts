// Shell page client: hosts the sandboxed frame and bridges it to browser storage
// and the live sync socket. The frame never touches the network or this
// origin's storage directly.
import type {
  FrameMessage,
  JsonValue,
  ShellBoot,
  ShellMessage,
  SyncClientMessage,
  SyncServerMessage,
} from "../shared/protocol.ts";
import { initOwnerMenu } from "./owner-menu.ts";

const boot: ShellBoot = JSON.parse(document.getElementById("shell-boot")!.textContent!);
const localKey = `art:${boot.artifactId}:local:${boot.viewer.email ?? "anon"}`;
const cacheKey = `art:${boot.artifactId}:shared`;
const canWrite = boot.viewer.role !== "view" && boot.viewer.email !== null;

const statusEl = document.getElementById("status")!;
const presenceEl = document.getElementById("presence")!;

if (boot.viewer.role === "owner") initOwnerMenu(boot);

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

const local: Record<string, JsonValue> = readJson(localKey, {});
let shared: Record<string, JsonValue> = readJson(cacheKey, {});
let presence: string[] = [];
let snapshotReceived = false;
let frameReady = false;
let initSent = false;
const pending = new Map<string, SyncClientMessage>();

const dark = matchMedia("(prefers-color-scheme: dark)");
const theme = () => (dark.matches ? "dark" : "light");

const iframe = document.createElement("iframe");
iframe.setAttribute(
  "sandbox",
  "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads",
);
iframe.setAttribute("allow", "clipboard-write");
iframe.setAttribute("referrerpolicy", "no-referrer");
iframe.title = boot.title;
iframe.src = boot.frameUrl;
document.getElementById("frame-host")!.append(iframe);

function post(msg: ShellMessage) {
  iframe.contentWindow?.postMessage(msg, "*");
}

function maybeInit() {
  if (!frameReady || initSent || !snapshotReceived) return;
  initSent = true;
  post({ t: "init", viewer: boot.viewer, local, shared, presence, theme: theme() });
}

// Don't hold the page hostage to the socket: after a short wait, start from the
// cached snapshot and let live updates catch up.
setTimeout(() => {
  snapshotReceived = true;
  maybeInit();
}, 1500);

dark.addEventListener("change", () => post({ t: "theme", theme: theme() }));

let lastErrorAt = 0;
window.addEventListener("message", (event) => {
  if (event.source !== iframe.contentWindow) return;
  const msg = event.data as FrameMessage;
  switch (msg?.t) {
    case "ready":
      frameReady = true;
      initSent = false;
      maybeInit();
      break;
    case "local:set":
      if (msg.value === undefined) delete local[msg.key];
      else local[msg.key] = msg.value;
      try {
        localStorage.setItem(localKey, JSON.stringify(local));
      } catch {
        // storage full or disabled; the value lives for this page only
      }
      break;
    case "shared:set": {
      if (!canWrite) return;
      const value = msg.value === undefined ? null : msg.value;
      const cid = crypto.randomUUID();
      const out: SyncClientMessage = { t: "set", key: msg.key, value, cid };
      pending.set(cid, out);
      if (value === null) delete shared[msg.key];
      else shared[msg.key] = value;
      sendSync(out);
      break;
    }
    case "error": {
      const now = Date.now();
      if (now - lastErrorAt < 5000) return;
      lastErrorAt = now;
      fetch(`/a/${boot.artifactId}/errors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: String(msg.message).slice(0, 2000), stack: msg.stack?.slice(0, 4000) }),
      }).catch(() => {});
      break;
    }
    case "open":
      if (/^https?:\/\//i.test(msg.url)) window.open(msg.url, "_blank", "noopener,noreferrer");
      break;
  }
});

let socket: WebSocket | null = null;
let retry = 0;

function sendSync(msg: SyncClientMessage) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function setStatus(text: string) {
  statusEl.textContent = text;
}

function connect() {
  const ws = new WebSocket(new URL(boot.syncUrl, location.href).href.replace(/^http/, "ws"));
  socket = ws;
  ws.addEventListener("open", () => {
    retry = 0;
    setStatus("");
    for (const msg of pending.values()) ws.send(JSON.stringify(msg));
  });
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data as string) as SyncServerMessage;
    switch (msg.t) {
      case "snapshot": {
        for (const k of Object.keys(confirmedState)) delete confirmedState[k];
        Object.assign(confirmedState, msg.state);
        // Keep optimistic values that are still in flight.
        const next = { ...msg.state };
        for (const p of pending.values()) {
          if (p.value === null) delete next[p.key];
          else next[p.key] = p.value;
        }
        const changes: Record<string, JsonValue | null> = {};
        for (const k of new Set([...Object.keys(shared), ...Object.keys(next)])) {
          if (JSON.stringify(shared[k]) !== JSON.stringify(next[k])) changes[k] = next[k] ?? null;
        }
        shared = next;
        saveCache();
        snapshotReceived = true;
        if (initSent && Object.keys(changes).length) post({ t: "shared", changes });
        maybeInit();
        break;
      }
      case "set":
        if (msg.cid) pending.delete(msg.cid);
        if (msg.value === null) delete confirmedState[msg.key];
        else confirmedState[msg.key] = msg.value;
        if (msg.value === null) delete shared[msg.key];
        else shared[msg.key] = msg.value;
        saveCache();
        if (initSent) post({ t: "shared", changes: { [msg.key]: msg.value } });
        break;
      case "rejected": {
        const rejected = pending.get(msg.cid);
        pending.delete(msg.cid);
        setStatus(`Change not saved: ${msg.reason}`);
        if (rejected) {
          // Roll the frame's optimistic value back to the last confirmed one.
          const confirmed = confirmedValue(rejected.key);
          if (confirmed === null) delete shared[rejected.key];
          else shared[rejected.key] = confirmed;
          if (initSent) post({ t: "shared", changes: { [rejected.key]: confirmed } });
        }
        break;
      }
      case "presence":
        presence = msg.viewers;
        renderPresence();
        if (initSent) post({ t: "presence", viewers: presence });
        break;
    }
  });
  ws.addEventListener("close", (event) => {
    socket = null;
    if (event.code === 4003 || event.code === 4004) {
      setStatus(event.code === 4004 ? "This artifact was deleted." : "Your access changed. Reload the page.");
      return;
    }
    setStatus(pending.size ? "Offline, changes will sync when reconnected" : "Reconnecting…");
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 500 * 2 ** retry);
  });
}

// Last server-confirmed value per key, used to undo rejected optimistic writes.
const confirmedState: Record<string, JsonValue> = {};
function confirmedValue(key: string): JsonValue | null {
  return key in confirmedState ? confirmedState[key] : null;
}

function saveCache() {
  try {
    localStorage.setItem(cacheKey, JSON.stringify(shared));
  } catch {
    // ignore
  }
}

function renderPresence() {
  presenceEl.replaceChildren(
    ...presence.map((email) => {
      const el = document.createElement("span");
      el.className = "avatar";
      el.title = email;
      el.textContent = email.slice(0, 1).toUpperCase();
      return el;
    }),
  );
}

connect();

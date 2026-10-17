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
  Thread,
  WatchLevel,
} from "../shared/protocol.ts";
import { mountAccountMenu } from "./account.ts";
import { initOwnerMenu } from "./owner-menu.ts";
import { createDrawer } from "./threads.ts";
import { showSince } from "./since.ts";

const boot: ShellBoot = JSON.parse(document.getElementById("shell-boot")!.textContent!);
const localKey = `art:${boot.artifactId}:local:${boot.viewer.email ?? "anon"}`;
const cacheKey = `art:${boot.artifactId}:shared`;
const canWrite = boot.viewer.role !== "view" && boot.viewer.email !== null;

const statusEl = document.getElementById("status")!;
const presenceEl = document.getElementById("presence")!;

function printArtifact() {
  const when = new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  post({ t: "print", title: boot.title, meta: `v${boot.version} · printed ${when}` });
}

async function setWatch(level: WatchLevel): Promise<WatchLevel> {
  const res = await fetch("/api/me/watch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: boot.artifactId, level }),
  });
  if (!res.ok) throw new Error("watch failed");
  return ((await res.json()) as { level: WatchLevel }).level;
}

// Your avatar opens the account menu; owners also get Manage and a sign-in link.
const meSlot = document.getElementById("me");
if (meSlot && boot.viewer.email) {
  const common = { print: printArtifact, watch: { level: boot.watch ?? "participating", set: setWatch } };
  if (boot.viewer.role === "owner") {
    let panel: ReturnType<typeof initOwnerMenu> | null = null;
    const avatar = mountAccountMenu(meSlot, boot.viewer.email, {
      ...common,
      manage: () => panel?.show(),
      copyLink: () => panel!.copyMyLink(),
      copyLabel: "Copy my sign-in link",
    });
    panel = initOwnerMenu(boot, avatar);
  } else {
    mountAccountMenu(meSlot, boot.viewer.email, { ...common, copyLink: async () => location.href, copyLabel: "Copy page link" });
  }
}

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
type SetMessage = Extract<SyncClientMessage, { t: "set" }>;
const pending = new Map<string, SetMessage>();

// Shared Artifacts is dark only; the frame renders dark whatever it is told.
const theme = () => "dark" as const;

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
  // Comments and change marks follow the first render.
  sendThreads(lastThreads);
  if (marksOn && boot.since?.changedBlocks.length) post({ t: "changes", blocks: boot.since.changedBlocks });
}

// ---- comments ----------------------------------------------------------------------

const canComment = boot.viewer.email !== null;
let lastThreads: Thread[] = [];
let marksOn = true;

function sendThreads(threads: Thread[]) {
  lastThreads = threads;
  if (initSent) post({ t: "threads", threads: threads.map((t) => ({ id: t.id, anchor: t.anchor })), canComment });
}

const toggle = document.createElement("button");
toggle.type = "button";
toggle.className = "bar-button comments-toggle";
toggle.setAttribute("aria-controls", "threads");
toggle.setAttribute("aria-expanded", "false");
toggle.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z"/></svg><span class="count"></span><span class="sr-only">Comments</span>`;
presenceEl.after(toggle);

const drawer = createDrawer(document.getElementById("threads")!, toggle, {
  me: boot.viewer.email,
  canComment,
  canResolveAny: boot.viewer.role !== "view",
  isOwner: boot.viewer.role === "owner",
  readSeq: boot.readSeq ?? 0,
  send: (msg) => {
    if (msg.t !== "set" && "cid" in msg) pendingComments.add(msg.cid);
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    else setStatus("Offline: comment not sent. Try again when reconnected.");
  },
  focus: (thread) => post({ t: "focus", thread }),
  onThreads: sendThreads,
  onRead: (seq) => sendSync({ t: "read", seq }),
});
const pendingComments = new Set<string>();

showSince(boot, {
  openComments: () => drawer.show(),
  unread: () => drawer.unread(),
  setMarks: (on) => {
    marksOn = on;
    post({ t: "changes", blocks: on ? (boot.since?.changedBlocks ?? []) : [] });
  },
});

// #thread=<id> (from a notification) opens that thread once threads arrive.
let deepLink = /^#thread=(t[a-z0-9]+)$/.exec(location.hash)?.[1] ?? null;

// Don't hold the page hostage to the socket: after a short wait, start from the
// cached snapshot and let live updates catch up.
setTimeout(() => {
  snapshotReceived = true;
  maybeInit();
}, 1500);

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
      const out: SetMessage = { t: "set", key: msg.key, value, cid };
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
    case "comment:new":
      drawer.compose(msg.anchor);
      break;
    case "comment:open":
      drawer.open(msg.thread);
      break;
    case "anchors":
      drawer.setPlacement(msg.placed);
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
        if (pendingComments.delete(msg.cid)) {
          setStatus(`Comment not saved: ${msg.reason}`);
          break;
        }
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
      case "threads":
        drawer.setAll(msg.threads, msg.people);
        if (deepLink) {
          drawer.open(deepLink);
          deepLink = null;
        }
        break;
      case "thread":
        if (msg.cid) pendingComments.delete(msg.cid);
        drawer.upsert(msg.thread);
        break;
      case "version":
        if (msg.version > boot.version) showUpdated(msg.version, msg.note);
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

/** A newer version was saved while this page is open. */
function showUpdated(version: number, note: string) {
  let pill = document.getElementById("updated");
  if (!pill) {
    pill = document.createElement("button");
    pill.id = "updated";
    pill.className = "updated-pill";
    pill.addEventListener("click", () => location.reload());
    statusEl.before(pill);
  }
  pill.textContent = "";
  const strong = document.createElement("strong");
  strong.textContent = `Updated to v${version}`;
  const rest = document.createElement("span");
  rest.textContent = note ? ` · ${note}` : "";
  const action = document.createElement("span");
  action.className = "action";
  action.textContent = "Reload";
  pill.append(strong, rest, action);
  pill.title = `Reload to see v${version}`;
}

function renderPresence() {
  // Your own avatar is the account/manage button; show only the others here.
  presenceEl.replaceChildren(
    ...presence.filter((email) => email !== boot.viewer.email).map((email) => {
      const el = document.createElement("span");
      el.className = "avatar";
      el.title = `Viewing now: ${email}`;
      el.textContent = email.slice(0, 1).toUpperCase();
      return el;
    }),
  );
}

connect();

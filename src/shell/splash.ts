// The splash page's examples. Each tab holds a real artifact frame (built into
// /demo/<slug> at deploy time); this script plays the shell's part for them,
// in memory: it answers `ready` with the example's seeded shared state and a
// made-up viewer who may write, and keeps whatever the visitor does local to
// this page. Nothing is sent anywhere, and a reload starts over.
import type { FrameMessage, JsonValue, ShellMessage } from "../shared/protocol.ts";
import { PEOPLE, seedValue, type SeedEntry } from "../../demo/examples.ts";
import { PALETTE } from "../shared/who.ts";

const YOU = "you@example.com";
const seeds = JSON.parse(document.getElementById("demo-seed")?.textContent ?? "{}") as Record<string, SeedEntry[]>;

function sharedFor(slug: string): Record<string, JsonValue> {
  const now = Date.now();
  const out: Record<string, JsonValue> = {};
  for (const e of seeds[slug] ?? []) out[e.key] = seedValue(e, now);
  return out;
}

const frames = [...document.querySelectorAll<HTMLIFrameElement>("iframe[data-demo]")];

window.addEventListener("message", (ev) => {
  const frame = frames.find((f) => f.contentWindow === ev.source);
  const msg = ev.data as FrameMessage;
  if (!frame || !msg || typeof msg !== "object" || typeof msg.t !== "string") return;
  const slug = frame.dataset.demo!;
  const send = (m: ShellMessage) => frame.contentWindow?.postMessage(m, "*");
  if (msg.t === "ready") {
    const people = [...new Set((seeds[slug] ?? []).map((e) => e.by))];
    // Like a workspace's members: everyone gets a different colour, in the order the demo workspace handed them
    // out (its people joined in this order), so each person looks the same here as on the public demo pages.
    const colours = Object.fromEntries([...PEOPLE, YOU].map((email, i) => [email, i % PALETTE.length]));
    send({ t: "init", viewer: { email: YOU, role: "edit" }, local: {}, shared: sharedFor(slug), presence: [YOU, ...people.slice(0, 2)], theme: "dark", colours });
    frame.closest(".showcase-render")?.classList.add("ready");
  } else if (msg.t === "shared:set" && /^(approve|form)\/[^/]+\/./.test(msg.key) && msg.value && typeof msg.value === "object" && !Array.isArray(msg.value)) {
    // Stamped like the hub does, so the visitor's own decision shows who and when.
    send({ t: "shared", changes: { [msg.key]: { ...msg.value, by: YOU, at: Date.now() } } });
  } else if (msg.t === "open" && typeof msg.url === "string" && /^https?:/i.test(msg.url)) {
    window.open(msg.url, "_blank", "noopener,noreferrer");
  } else if (msg.t === "error") {
    console.warn(`[demo ${slug}]`, msg.message);
  }
  // Other shared:set and local:set need no answer: the frame applies its own writes.
  // Comment threads, "changed since" marks and printing are shell features the
  // examples don't use, so their messages are never sent.
});

/** Frames load when their tab is first shown, so the page itself stays light. */
function load(panel: HTMLElement) {
  const frame = panel.querySelector<HTMLIFrameElement>("iframe[data-src]");
  if (frame && !frame.src) frame.src = frame.dataset.src!;
}

const tabs = [...document.querySelectorAll<HTMLButtonElement>(".showcase-tabs [role=tab]")];
function select(tab: HTMLButtonElement, focus = false) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    const panel = document.getElementById(t.getAttribute("aria-controls")!)!;
    panel.hidden = !on;
    if (on) load(panel);
  }
  if (focus) tab.focus();
}
for (const [i, tab] of tabs.entries()) {
  tab.addEventListener("click", () => select(tab));
  tab.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (step) select(tabs[(i + step + tabs.length) % tabs.length], true);
    else if (e.key === "Home") select(tabs[0], true);
    else if (e.key === "End") select(tabs[tabs.length - 1], true);
    else return;
    e.preventDefault();
  });
}

// Narrow screens show one side at a time.
const showcase = document.querySelector<HTMLElement>(".showcase");
for (const b of document.querySelectorAll<HTMLButtonElement>(".showcase-toggle [data-view]")) {
  b.addEventListener("click", () => {
    showcase!.dataset.view = b.dataset.view!;
    for (const other of b.parentElement!.querySelectorAll("button")) other.setAttribute("aria-pressed", String(other === b));
  });
}

// The first example loads once it's near the screen.
const first = document.querySelector<HTMLElement>(".showcase-panel:not([hidden])");
if (first) {
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        load(first);
      }
    }, { rootMargin: "400px" });
    io.observe(first);
  } else load(first);
}

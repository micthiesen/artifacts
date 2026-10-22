// Listen: the page's readable text, gathered from what is rendered rather than
// from the source, so MDX components, data-driven tables and app.tsx pages all
// read the way they look. Each unit is one block; the element gets
// data-speak-i so the shell can mark it while it is read and the reader can
// tap a block to start there.
//
// Components can steer it: data-speak="skip" leaves an element out,
// data-speak="<kind>" reads it as one unit (stat, chart, diagram), and
// aria-hidden content is never read.

import type { SpeakUnit } from "../shared/protocol.ts";

const SKIP =
  "script,style,template,svg,canvas,button,input,textarea,select,nav,[hidden],[aria-hidden='true'],[data-speak='skip'],.art-contents,.art-linked-from,[role='tablist']";
const BLOCK = "h1,h2,h3,h4,h5,h6,p,li,pre,table,blockquote,figure,dt,dd,[data-speak],[role='note']";
const TONES: Record<string, string> = { warning: "Warning.", danger: "Caution.", success: "", info: "" };

let units: Element[] = [];

/** Text of an element as it reads, skipping what Listen never reads, with blocks separated. */
function textOf(el: Element): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (!(node instanceof Element) || node.matches(SKIP)) return;
    const block = node !== el && isBlockish(node);
    if (block) parts.push(" ");
    if (node.tagName === "BR") parts.push(" ");
    for (const child of node.childNodes) walk(child);
    // A block that ends without punctuation (a title, a label) still gets a pause before what follows.
    if (block && !/[.!?:;…,]\s*$/.test(parts.join("")) && parts.join("").trim()) parts.push(".");
    if (block) parts.push(" ");
  };
  walk(el);
  return parts.join("").replace(/\s+/g, " ").trim();
}

const INLINE = new Set(["A", "ABBR", "B", "BDI", "CITE", "CODE", "DATA", "EM", "I", "KBD", "LABEL", "MARK", "Q", "S", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME", "U", "VAR"]);

function isBlockish(el: Element): boolean {
  const d = getComputedStyle(el).display;
  // Inline tags count as blocks only when styled as one (a link turned into a card).
  if (INLINE.has(el.tagName)) return /^(block|flex|grid|list-item|table)/.test(d);
  return d !== "inline" && d !== "contents" && d !== "none";
}

function visible(el: Element): boolean {
  if (el.matches(SKIP)) return false;
  return getComputedStyle(el).display !== "none";
}

/** Ends a unit with a full stop when it has no punctuation, so headings and labels get a pause. */
function stop(text: string): string {
  return /[.!?:;…]$/.test(text) ? text : `${text}.`;
}

function push(el: Element, text: string) {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return;
  el.setAttribute("data-speak-i", String(units.length));
  units.push(el);
  out.push({ i: units.length - 1, text: stop(t) });
}

let out: SpeakUnit[] = [];

function readTable(table: HTMLTableElement): string {
  const heads = [...table.querySelectorAll("thead th")].map((th) => textOf(th)).filter(Boolean);
  const rows = table.querySelectorAll("tbody tr").length;
  const caption = table.caption ? `${textOf(table.caption)}. ` : "";
  const cols = heads.length ? `: ${heads.join(", ")}` : "";
  return `${caption}A table of ${rows} ${rows === 1 ? "row" : "rows"}${cols}`;
}

function walk(el: Element) {
  if (!visible(el)) return;
  const kind = el.getAttribute("data-speak");
  const tag = el.tagName;
  if (kind === "stat") {
    // Label, value, delta and hint, each a separate phrase.
    const bits = [...el.querySelectorAll(":scope > div, :scope > div > span")].filter((d) => !d.querySelector("div,span")).map(textOf).filter(Boolean);
    return push(el, bits.join(", ") || textOf(el));
  }
  if (kind === "chart" || kind === "diagram" || tag === "FIGURE") {
    const caption = el.querySelector("figcaption");
    const what = kind === "chart" ? "A chart" : kind === "diagram" ? "A diagram" : "";
    const img = el.querySelector("img[alt]")?.getAttribute("alt");
    return push(el, [caption ? stop(textOf(caption)) : "", what || img || ""].filter(Boolean).join(" "));
  }
  if (tag === "PRE") return push(el, "A code block");
  if (tag === "TABLE") return push(el, readTable(el as HTMLTableElement));
  if (el.getAttribute("role") === "note") {
    const tone = el.getAttribute("data-tone") ?? "";
    return push(el, `${TONES[tone] ?? ""} ${textOf(el)}`);
  }
  if (/^H[1-6]$|^P$|^DT$|^DD$/.test(tag)) return push(el, textOf(el));
  if (tag === "LI" || tag === "BLOCKQUOTE") {
    // A list item with its own paragraphs or a nested list reads its parts one by one.
    if (!el.querySelector(BLOCK)) return push(el, textOf(el));
    const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE || (n instanceof Element && !n.matches(BLOCK) && !n.querySelector(BLOCK)));
    const lead = own.map((n) => (n instanceof Element ? (n.matches(SKIP) ? "" : textOf(n)) : n.textContent ?? "")).join(" ").trim();
    if (lead) push(el, lead);
    for (const child of el.children) if (child.matches(BLOCK) || child.querySelector(BLOCK)) walk(child);
    return;
  }
  // A container: if nothing inside is a block, it is one unit (app.tsx pages are mostly divs).
  if (!el.querySelector(BLOCK)) {
    if (isBlockish(el)) push(el, textOf(el));
    return;
  }
  // Mixed: loose text between blocks still counts.
  let loose: Element[] = [];
  const flush = () => {
    const text = loose.map(textOf).join(" ");
    if (text.trim()) push(loose[0]!, text);
    loose = [];
  };
  for (const child of el.children) {
    if (child.matches(BLOCK) || child.querySelector(BLOCK) || isBlockish(child)) {
      flush();
      walk(child);
    } else if (visible(child)) loose.push(child);
  }
  flush();
}

/** Collects the page's readable units, in reading order, and numbers their elements. */
export function collectSpeech(root: Element): SpeakUnit[] {
  for (const el of units) el.removeAttribute("data-speak-i");
  units = [];
  out = [];
  walk(root);
  return out;
}

let current: Element | null = null;

/** Marks the block being read and keeps it in view. */
export function markSpeaking(i: number | null) {
  current?.removeAttribute("data-speaking");
  current = i === null ? null : (units[i] ?? null);
  if (!current) return;
  current.setAttribute("data-speaking", "");
  const r = current.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight) {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    current.scrollIntoView({ block: r.height > innerHeight * 0.6 ? "start" : "center", behavior: reduce ? "auto" : "smooth" });
  }
}

let tapping: ((e: MouseEvent) => void) | null = null;

/** While listening, tapping a block (not a control or link) starts reading there. */
export function speakMode(on: boolean, send: (i: number) => void) {
  if (tapping) document.removeEventListener("click", tapping, true);
  tapping = null;
  document.documentElement.toggleAttribute("data-listening", on);
  if (!on) return markSpeaking(null);
  tapping = (e) => {
    const target = e.target as Element | null;
    if (!target || target.closest("a,button,input,textarea,select,label,[role='button'],[role='tab']")) return;
    if (getSelection()?.toString()) return;
    const el = target.closest("[data-speak-i]");
    if (el) send(Number(el.getAttribute("data-speak-i")));
  };
  document.addEventListener("click", tapping, true);
}

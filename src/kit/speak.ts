// Listen: the page's readable text, gathered from what is rendered rather than
// from the source, so MDX components, data-driven tables and app.tsx pages all
// read the way they look. Each unit is one block; its element gets
// data-speak-i so the shell can mark it while it is read and the reader can
// tap a block to start there. Every character of a unit remembers the text
// node it came from, so the word being spoken can be marked too (with the CSS
// Custom Highlight API, which leaves the DOM alone).
//
// Components can steer it: data-speak="skip" leaves an element out,
// data-speak="<kind>" reads it as one unit (stat, chart, diagram), and
// aria-hidden content is never read.

import type { FrameMessage, SpeakUnit } from "../shared/protocol.ts";
import { wispReflow, wispTo } from "./wisp.ts";

const SKIP =
  "script,style,template,svg,canvas,button,input,textarea,select,nav,[hidden],[aria-hidden='true'],[data-speak='skip'],.art-contents,.art-linked-from,[role='tablist']";
const BLOCK = "h1,h2,h3,h4,h5,h6,p,li,pre,table,blockquote,figure,dt,dd,[data-speak],[role='note']";
const TONES: Record<string, string> = { warning: "Warning.", danger: "Caution." };
const INLINE = new Set(["A", "ABBR", "B", "BDI", "CITE", "CODE", "DATA", "EM", "I", "KBD", "LABEL", "MARK", "Q", "S", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME", "U", "VAR"]);
const WORD_HIGHLIGHT = "art-speak-word";

/** A unit's text as it is spoken, with the text node and offset each character came from (null for added words and pauses). */
class Spoken {
  text = "";
  nodes: (Text | null)[] = [];
  offsets: number[] = [];

  private put(ch: string, node: Text | null, offset: number) {
    this.text += ch;
    this.nodes.push(node);
    this.offsets.push(offset);
  }

  /** Words that aren't on the page ("A table of 3 rows", "Warning."). */
  add(s: string) {
    for (const ch of s) {
      if (/\s/.test(ch)) this.space(null, 0);
      else this.put(ch, null, 0);
    }
  }

  node(n: Text) {
    const s = n.data;
    for (let k = 0; k < s.length; k++) {
      if (/\s/.test(s[k]!)) this.space(n, k);
      else this.put(s[k]!, n, k);
    }
  }

  private space(node: Text | null, offset: number) {
    if (this.text && !this.text.endsWith(" ")) this.put(" ", node, offset);
  }

  /** Between blocks: a space, and a full stop when the last block (a title, a label) ended without punctuation. */
  pause() {
    this.trimEnd();
    if (this.text && !/[.!?:;…,]$/.test(this.text)) this.put(".", null, 0);
    this.space(null, 0);
  }

  trimEnd() {
    while (this.text.endsWith(" ")) {
      this.text = this.text.slice(0, -1);
      this.nodes.pop();
      this.offsets.pop();
    }
  }

  /** Trimmed, ending with punctuation so every unit closes with a pause. */
  finish(): Spoken {
    this.trimEnd();
    let lead = 0;
    while (this.text[lead] === " ") lead++;
    if (lead) {
      this.text = this.text.slice(lead);
      this.nodes = this.nodes.slice(lead);
      this.offsets = this.offsets.slice(lead);
    }
    if (this.text && !/[.!?:;…]$/.test(this.text)) this.put(".", null, 0);
    return this;
  }
}

/** `mark`: the element is the unit's own, so it can glow and be tapped (not a container that only holds loose text). */
type Unit = { el: Element; spoken: Spoken; mark: boolean };
let units: Unit[] = [];
/** Every element that is a block or holds one, worked out once per collection instead of a query per node. */
let blocky = new Set<Element>();
const hasBlock = (el: Element) => blocky.has(el);
const holdsBlock = (el: Element) => [...el.children].some((c) => blocky.has(c));
let out: SpeakUnit[] = [];
let heading: string | undefined;

function isBlockish(el: Element): boolean {
  const d = getComputedStyle(el).display;
  // Inline tags count as blocks only when styled as one (a link turned into a card).
  if (INLINE.has(el.tagName)) return /^(block|flex|grid|list-item|table)/.test(d);
  return d !== "inline" && d !== "contents" && d !== "none";
}

function visible(el: Element): boolean {
  return !el.matches(SKIP) && getComputedStyle(el).display !== "none";
}

/** Appends an element's readable text, skipping what Listen never reads, with blocks separated by pauses. */
function into(b: Spoken, el: Element) {
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) return b.node(node as Text);
    if (!(node instanceof Element) || node.matches(SKIP)) return;
    const block = node !== el && isBlockish(node);
    if (block) b.pause();
    if (node.tagName === "BR") b.add(" ");
    for (const child of node.childNodes) walk(child);
    if (block) b.pause();
  };
  walk(el);
}

function textOf(el: Element): string {
  const b = new Spoken();
  into(b, el);
  b.trimEnd();
  return b.text.trim();
}

function push(el: Element, b: Spoken, mark = true) {
  b.finish();
  if (!b.text) return;
  const i = units.length;
  units.push({ el, spoken: b, mark });
  if (/^H[1-6]$/.test(el.tagName)) heading = b.text.replace(/[.:]$/, "");
  out.push(heading ? { i, text: b.text, h: heading } : { i, text: b.text });
}

function pushText(el: Element) {
  const b = new Spoken();
  into(b, el);
  push(el, b);
}

function readTable(table: HTMLTableElement): Spoken {
  const b = new Spoken();
  const heads = [...table.querySelectorAll("thead th")].map(textOf).filter(Boolean);
  const rows = table.querySelectorAll("tbody tr").length;
  if (table.caption) {
    into(b, table.caption);
    b.pause();
  }
  b.add(`A table of ${rows} ${rows === 1 ? "row" : "rows"}${heads.length ? `: ${heads.join(", ")}` : ""}`);
  return b;
}

function walk(el: Element) {
  if (!visible(el)) return;
  const kind = el.getAttribute("data-speak");
  const tag = el.tagName;
  if (kind === "stat") {
    // Label, value, delta and hint, each a separate phrase.
    const b = new Spoken();
    const bits = [...el.querySelectorAll(":scope > div, :scope > div > span")].filter((d) => !d.querySelector("div,span") && textOf(d));
    for (const [k, bit] of bits.entries()) {
      if (k) b.add(", ");
      into(b, bit);
      b.trimEnd();
    }
    if (!bits.length) into(b, el);
    return push(el, b);
  }
  if (kind === "chart" || kind === "diagram" || tag === "FIGURE") {
    const b = new Spoken();
    const caption = el.querySelector("figcaption");
    if (caption) {
      into(b, caption);
      b.pause();
    }
    const img = el.querySelector("img[alt]")?.getAttribute("alt");
    b.add(kind === "chart" ? "A chart" : kind === "diagram" ? "A diagram" : (img ?? ""));
    return push(el, b);
  }
  if (tag === "PRE") {
    const b = new Spoken();
    b.add("A code block");
    return push(el, b);
  }
  if (tag === "TABLE") return push(el, readTable(el as HTMLTableElement));
  if (el.getAttribute("role") === "note") {
    const b = new Spoken();
    const tone = TONES[el.getAttribute("data-tone") ?? ""];
    if (tone) b.add(`${tone} `);
    into(b, el);
    return push(el, b);
  }
  if (/^H[1-6]$|^P$|^DT$|^DD$/.test(tag)) return pushText(el);
  if (tag === "LI" || tag === "BLOCKQUOTE") {
    // A list item with its own paragraphs or a nested list reads its parts one by one.
    if (!holdsBlock(el)) return pushText(el);
    const b = new Spoken();
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) b.node(n as Text);
      else if (n instanceof Element && !hasBlock(n)) into(b, n);
    }
    push(el, b);
    for (const child of el.children) if (hasBlock(child)) walk(child);
    return;
  }
  // A container: if nothing inside is a block, it is one unit (app.tsx pages are mostly divs).
  if (!holdsBlock(el)) {
    if (isBlockish(el)) pushText(el);
    return;
  }
  // Mixed: loose inline content between blocks still counts.
  let loose: Node[] = [];
  const flush = () => {
    const b = new Spoken();
    for (const n of loose) n instanceof Element ? into(b, n) : b.node(n as Text);
    // Bare text in a container that also holds blocks has no element of its own: it reads and its words are
    // marked, but the container doesn't glow or take taps.
    const own = loose.find((n): n is Element => n instanceof Element);
    push(own ?? el, b, Boolean(own));
    loose = [];
  };
  for (const child of el.childNodes) {
    if (child instanceof Element && (hasBlock(child) || isBlockish(child))) {
      flush();
      walk(child);
    } else if (child instanceof Element ? visible(child) : child.nodeType === Node.TEXT_NODE) loose.push(child);
  }
  flush();
}

/**
 * Collects the page's readable units, in reading order, and numbers their elements. `start` is the
 * first unit on screen, so Listen begins where the reader is looking rather than at the top.
 */
export function collectSpeech(root: Element): { units: SpeakUnit[]; start: number } {
  for (const u of units) u.el.removeAttribute("data-speak-i");
  units = [];
  out = [];
  heading = undefined;
  staleSent = false;
  // Blocks, and every ancestor of one up to the root.
  blocky = new Set();
  for (const b of root.querySelectorAll(BLOCK)) {
    for (let e: Element | null = b; e && e !== root && !blocky.has(e); e = e.parentElement) blocky.add(e);
  }
  walk(root);
  blocky = new Set();
  // Numbered after the walk, so reading styles and writing attributes don't interleave.
  units.forEach((u, i) => u.mark && u.el.setAttribute("data-speak-i", String(i)));
  let start = 0;
  if (scrollY > 0) {
    const i = units.findIndex((u) => u.el.getBoundingClientRect().bottom > 8);
    if (i > 0) start = i;
  }
  return { units: out, start };
}

// ---- following along ---------------------------------------------------------------------

let current: Element | null = null;
/** When the reader last scrolled by hand; following waits a while after that so it doesn't fight them. */
let userScrolledAt = 0;
const FOLLOW_PAUSE_MS = 6000;
const userScroll = () => (userScrolledAt = Date.now());
/** Until when a scroll is Listen's own (a smooth scroll runs a while); any other scroll is the reader's. */
let ownScrollUntil = 0;
const scrolling = () => (ownScrollUntil = Date.now() + 1200);
const onScroll = () => Date.now() > ownScrollUntil && userScroll();
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const userKey = (e: KeyboardEvent) => SCROLL_KEYS.has(e.key) && userScroll();

const following = () => Date.now() - userScrolledAt > FOLLOW_PAUSE_MS;
const scrollBehavior = (): ScrollBehavior => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

/** Marks the block being read and keeps it in view. */
export function markSpeaking(i: number | null) {
  current?.removeAttribute("data-speaking");
  const unit = i === null ? undefined : units[i];
  current = unit?.mark ? unit.el : null;
  if (!unit) {
    wispTo(null);
    return markWord(null, 0, 0);
  }
  // A block with nothing of its own to point at (a table or chart read as a summary) has no wisp. (Between
  // sentences markWord(null) deliberately leaves the wisp parked, so it hops on from there.)
  if (!unit.spoken.nodes.some(Boolean)) wispTo(null);
  if (!current) return;
  current.setAttribute("data-speaking", "");
  const r = current.getBoundingClientRect();
  if (following() && (r.top < 0 || r.bottom > innerHeight)) {
    scrolling();
    current.scrollIntoView({ block: r.height > innerHeight * 0.6 ? "start" : "center", behavior: scrollBehavior() });
  }
}

/** The page range of [start, end) in unit `i`'s text, without the words Listen added; null when none of it is on the page. */
export function wordRange(i: number, start: number, end: number): Range | null {
  const unit = units[i];
  if (!unit) return null;
  const { nodes, offsets } = unit.spoken;
  let a = start;
  while (a < end && !nodes[a]) a++;
  let z = end - 1;
  while (z >= a && !nodes[z]) z--;
  const from = nodes[a];
  const to = nodes[z];
  if (a > z || !from || !to || !from.isConnected || !to.isConnected) return null;
  const range = document.createRange();
  try {
    range.setStart(from, offsets[a]!);
    range.setEnd(to, offsets[z]! + 1);
  } catch {
    return null;
  }
  return range;
}

let wordAt: Range | null = null;
let washTimer = 0;
addEventListener("resize", () => wispReflow(wordAt));

/** Tells the shell (once per collection) that the page changed under the reading, so it collects again. */
let notify: ((msg: FrameMessage) => void) | null = null;
let staleSent = false;
function checkStale(i: number) {
  const unit = units[i];
  if (staleSent || !unit || !notify) return;
  if (unit.spoken.nodes.some((n) => n && !n.isConnected)) {
    staleSent = true;
    notify({ t: "speak:stale" });
  }
}

/**
 * Marks the word being spoken: [start, end) in the unit's text. The wisp sets off at once (hopping in `hop` ms
 * at most) and the wash follows `lead` ms later, as the word is heard, so the two agree. Words Listen added (not
 * on the page) mark nothing, and the wisp stays where it was between sentences.
 */
export function markWord(i: number | null, start: number, end: number, hop?: number, lead = 0) {
  const highlights = (globalThis.CSS as { highlights?: Map<string, unknown> } | undefined)?.highlights;
  const range = i === null ? null : wordRange(i, start, end);
  if (i !== null && !range) checkStale(i);
  wordAt = range;
  if (range) wispTo(range, hop);
  clearTimeout(washTimer);
  if (!highlights || typeof Highlight === "undefined") return;
  if (!range) return void highlights.delete(WORD_HIGHLIGHT);
  const wash = () => highlights.set(WORD_HIGHLIGHT, new Highlight(range));
  if (lead > 0) washTimer = window.setTimeout(wash, lead);
  else wash();
  // In a block taller than the screen the word can run off the bottom: bring its line back up.
  if (!following()) return;
  const r = range.getBoundingClientRect();
  if (r.height && (r.bottom > innerHeight - 24 || r.top < 0)) {
    scrolling();
    scrollBy({ top: r.top - innerHeight * 0.35, behavior: scrollBehavior() });
  }
}

let tapping: ((e: MouseEvent) => void) | null = null;

/**
 * Listening on or off. On: tapping a block (not a control or link) starts reading there, hand scrolling pauses
 * following, and a re-rendered page asks to be collected again. Off: every mark goes, numbering included.
 */
export function speakMode(on: boolean, send: (msg: FrameMessage) => void) {
  if (tapping) document.removeEventListener("click", tapping, true);
  tapping = null;
  notify = on ? send : null;
  removeEventListener("wheel", userScroll);
  removeEventListener("touchmove", userScroll);
  removeEventListener("keydown", userKey);
  removeEventListener("scroll", onScroll, true);
  document.documentElement.toggleAttribute("data-listening", on);
  if (!on) {
    wispTo(null);
    markSpeaking(null);
    for (const u of units) u.el.removeAttribute("data-speak-i");
    units = [];
    out = [];
    return;
  }
  userScrolledAt = 0;
  addEventListener("wheel", userScroll, { passive: true });
  addEventListener("touchmove", userScroll, { passive: true });
  addEventListener("keydown", userKey);
  // Scrollbar drags and anything else that scrolls by hand (capture: inner scrolling areas too).
  addEventListener("scroll", onScroll, { capture: true, passive: true });
  tapping = (e) => {
    const target = e.target as Element | null;
    if (!target || target.closest("a,button,input,textarea,select,label,summary,[role='button'],[role='tab'],[role='checkbox']")) return;
    if (getSelection()?.toString()) return;
    const el = target.closest("[data-speak-i]");
    if (!el) return;
    userScrolledAt = 0;
    send({ t: "speak:jump", i: Number(el.getAttribute("data-speak-i")) });
  };
  document.addEventListener("click", tapping, true);
}

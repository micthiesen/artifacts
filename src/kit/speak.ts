// Listen: the page's readable text, gathered from what is rendered rather than
// from the source, so MDX components, data-driven tables and app.tsx pages all
// read the way they look. Each unit is one block; its element gets
// data-speak-i so the shell can mark it while it is read and the reader can
// tap a block to start there. Every character of a unit remembers the text
// node it came from, so the wisp (src/kit/wisp.ts) can hop to the exact word
// being spoken.
//
// Components can steer it: data-speak="skip" leaves an element out,
// data-speak="<kind>" reads it as one unit (stat, chart, diagram), and
// aria-hidden content is never read.

import type { FrameMessage, SpeakUnit } from "../shared/protocol.ts";
// The wisp is loaded the first time someone listens, so pages nobody listens to don't carry it.
type Wisp = typeof import("./wisp.ts");
type WispMood = import("./wisp.ts").WispMood;
let wisp: Wisp | null = null;
let wispLoading: Promise<Wisp> | null = null;
const loadWisp = () =>
  (wispLoading ??= import("./wisp.ts").then(
    (m) => (wisp = m),
    (err: unknown) => {
      // A failed fetch (a flaky network): try again next time someone listens.
      wispLoading = null;
      throw err;
    },
  ));

const SKIP =
  "script,style,template,svg,canvas,button,input,textarea,select,nav,[hidden],[aria-hidden='true'],[data-speak='skip'],.art-contents,.art-linked-from,[role='tablist']";
const BLOCK = "h1,h2,h3,h4,h5,h6,p,li,pre,table,blockquote,figure,dt,dd,[data-speak],[role='note']";
const TONES: Record<string, string> = { warning: "Warning.", danger: "Caution." };
const INLINE = new Set(["A", "ABBR", "B", "BDI", "CITE", "CODE", "DATA", "EM", "I", "KBD", "LABEL", "MARK", "Q", "S", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME", "U", "VAR"]);

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
//
// Follow (the tray's toggle) decides whether the page scrolls itself to keep the reading in view. It starts on
// with every Listen. Scrolling by hand turns it off, so the page never fights the reader, and the tray shows
// that; pressing Follow again, or tapping a paragraph to read from, turns it back on and brings the reading
// into view. Listen's own scrolling never counts as the reader's.

let current: Element | null = null;
let wordAt: Range | null = null;
let following = true;
/** Until when a scroll is Listen's own (a smooth scroll runs a while); any other scroll is the reader's. */
let ownScrollUntil = 0;
const scrolling = () => (ownScrollUntil = Date.now() + 1200);
const scrollBehavior = (): ScrollBehavior => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

/** The reader scrolled by hand: stop following and tell the tray. */
function userScroll() {
  if (!following || !notify) return;
  following = false;
  notify({ t: "speak:follow", on: false });
}
// A scroll is the reader's only when they just did something that scrolls: a wheel, a swipe, a scroll key
// (not one that works a control: Space on a button, arrows in tabs or a slider), or a press on the
// scrollbar. Layout shifts, late images and Listen's own scrolling never count.
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const CONTROLS =
  "input,textarea,select,button,a,summary,[contenteditable],[role=button],[role=tab],[role=slider],[role=textbox],[role=combobox],[role=menuitem],[role=option],[role=radio],[role=checkbox],[role=switch],[role=spinbutton],[role=listbox],[role=menu],[role=tree],[role=grid]";
let intentAt = 0;
// The reader's own move ends any scroll Listen started: what follows is theirs.
const intent = () => {
  intentAt = Date.now();
  ownScrollUntil = 0;
};
const userKey = (e: KeyboardEvent) => SCROLL_KEYS.has(e.key) && !(e.target as Element | null)?.closest?.(CONTROLS) && intent();
const userPress = (e: PointerEvent) => (e.target === document.documentElement || e.target === document.scrollingElement) && intent();
const onScroll = () => Date.now() - intentAt < 400 && Date.now() > ownScrollUntil && userScroll();

/**
 * What glows for a block: the block itself, or, when it is a plain wrapper around one shaped box (a Summary,
 * a card), that box, so the glow follows its rounded corners instead of squaring them off.
 */
function glowTarget(el: Element): Element {
  let target = el;
  for (let depth = 0; depth < 3; depth++) {
    const only = target.children.length === 1 ? target.children[0]! : null;
    if (!only || parseFloat(getComputedStyle(target).borderTopLeftRadius) > 0) break;
    const a = target.getBoundingClientRect();
    const b = only.getBoundingClientRect();
    if (Math.abs(a.width - b.width) > 2 || Math.abs(a.height - b.height) > 2) break;
    target = only;
  }
  return target;
}

/** Brings the block (or, in a block taller than the screen, the word) into view, when following. */
function keepInView() {
  // Not while a scroll of Listen's own is still on its way.
  if (!following || !current || Date.now() < ownScrollUntil) return;
  const r = current.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight) {
    if (r.height > innerHeight * 0.6 && wordAt) {
      if (!wordAt.startContainer.isConnected) return;
      const w = wordAt.getBoundingClientRect();
      if (!w.height || (w.top >= 0 && w.bottom <= innerHeight - 24)) return;
      scrolling();
      scrollBy({ top: w.top - innerHeight * 0.35, behavior: scrollBehavior() });
      return;
    }
    scrolling();
    current.scrollIntoView({ block: r.height > innerHeight * 0.6 ? "start" : "center", behavior: scrollBehavior() });
  }
}

/** Marks the block being read (a soft glow, rounded) and keeps it in view. */
export function markSpeaking(i: number | null) {
  current?.removeAttribute("data-speaking");
  const unit = i === null ? undefined : units[i];
  current = unit?.mark ? glowTarget(unit.el) : null;
  wordAt = null;
  if (!unit) return;
  // A block with nothing of its own to point at (a table or chart read as a summary): the wisp floats over it.
  // Otherwise it stays where it is until the first word, and hops there.
  if (!unit.spoken.nodes.some(Boolean)) wisp?.wispFollow(unit.el);
  if (!current) return;
  // Shaped boxes keep their own corners; anything square gets softly rounded ones.
  current.setAttribute("data-speaking", parseFloat(getComputedStyle(current).borderTopLeftRadius) > 0 ? "" : "round");
  keepInView();
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
 * The word being spoken: [start, end) in the unit's text. The wisp hops to it. Words Listen added (not on the
 * page) have nowhere to point, and the wisp stays where it was.
 */
export function markWord(i: number | null, start: number, end: number) {
  if (i === null) return;
  const range = wordRange(i, start, end);
  if (!range) return checkStale(i);
  wordAt = range;
  wisp?.wispFollow(range);
  keepInView();
}

/** The voice's state, for the wisp: tracking words while it speaks, floating while it waits or rests. */
let mood: WispMood = "waiting";
export function speakState(state: "playing" | "waiting" | "resting") {
  mood = state === "playing" ? "tracking" : state === "waiting" ? "waiting" : "resting";
  wisp?.wispMood(mood);
}

/** Follow turned on (or off) from the tray: on brings the reading back into view. */
export function speakFollow(on: boolean) {
  following = on;
  if (on) keepInView();
}

let tapping: ((e: MouseEvent) => void) | null = null;

/**
 * Listening on or off. On: the wisp arrives, tapping a block (not a control or link) starts reading there,
 * scrolling by hand turns Follow off, and a re-rendered page asks to be collected again. Off: the wisp leaves
 * and every mark goes, numbering included.
 */
export function speakMode(on: boolean, send: (msg: FrameMessage) => void) {
  if (tapping) document.removeEventListener("click", tapping, true);
  tapping = null;
  notify = on ? send : null;
  removeEventListener("wheel", intent);
  removeEventListener("touchmove", intent);
  removeEventListener("keydown", userKey);
  removeEventListener("pointerdown", userPress);
  removeEventListener("scroll", onScroll, true);
  const already = document.documentElement.hasAttribute("data-listening");
  document.documentElement.toggleAttribute("data-listening", on);
  if (!on) {
    wisp?.wispLeave();
    markSpeaking(null);
    for (const u of units) u.el.removeAttribute("data-speak-i");
    units = [];
    out = [];
    return;
  }
  // Already listening (the shell asked again after the page changed): keep Follow as the tray has it.
  if (!already) following = true;
  loadWisp().then(
    (w) => {
      if (!notify) return;
      w.wispArrive();
      w.wispMood(mood);
    },
    () => {},
  );
  addEventListener("wheel", intent, { passive: true });
  addEventListener("touchmove", intent, { passive: true });
  addEventListener("keydown", userKey);
  addEventListener("pointerdown", userPress, { passive: true });
  // Scrollbar drags and anything else that scrolls by hand (capture: inner scrolling areas too).
  addEventListener("scroll", onScroll, { capture: true, passive: true });
  tapping = (e) => {
    const target = e.target as Element | null;
    if (!target || target.closest("a,button,input,textarea,select,label,summary,[role='button'],[role='tab'],[role='checkbox']")) return;
    if (getSelection()?.toString()) return;
    const el = target.closest("[data-speak-i]");
    if (!el) return;
    // Choosing where to read is asking to follow it.
    if (!following) {
      following = true;
      send({ t: "speak:follow", on: true });
    }
    send({ t: "speak:jump", i: Number(el.getAttribute("data-speak-i")) });
  };
  document.addEventListener("click", tapping, true);
}

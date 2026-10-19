// Comment anchoring inside the frame. The shell owns threads and the drawer;
// this module only turns a selection (or a block) into an anchor, finds where
// each thread's anchor is on the current page, draws highlights and margin
// markers, and reports clicks. Highlights use the CSS Custom Highlight API,
// so the artifact's DOM is never modified around the selected text.
import type { Anchor, AnchorStatus, FrameMessage } from "../shared/protocol.ts";

type ThreadRef = { id: string; anchor: Anchor | null; active?: boolean };
type Placed = { id: string; status: AnchorStatus; range: Range | null; el: Element | null };

const CONTEXT = 32;
const MAX_QUOTE = 1000;

let send: (m: FrameMessage) => void = () => {};
let root: HTMLElement;
let threads: ThreadRef[] = [];
let canComment = false;
let placed: Placed[] = [];
let lastReport = "";
let button: HTMLButtonElement | null = null;
let markerLayer: HTMLDivElement | null = null;
let blockButton: HTMLButtonElement | null = null;
let hoveredBlock: Element | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshDeadline = 0;
let changedBlocks: string[] = [];

const highlights = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
const HighlightCtor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

export function installAnnotations(rootEl: HTMLElement, transport: (m: FrameMessage) => void) {
  root = rootEl;
  send = transport;
  document.addEventListener("selectionchange", () => scheduleSelectionButton());
  document.addEventListener("pointerup", () => scheduleSelectionButton(), true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("resize", () => scheduleRefresh(50));
  // Layout shifts (images, fonts, charts sizing) move anchors without DOM mutations.
  new ResizeObserver(() => scheduleRefresh(100)).observe(rootEl);
  // Re-anchor when the artifact re-renders (data loads, charts mount, shared state changes).
  new MutationObserver((records) => {
    if (records.some((r) => !isOurs(r.target))) scheduleRefresh(250);
  }).observe(root, { subtree: true, childList: true, characterData: true });
}

export function setThreads(next: ThreadRef[], comment: boolean) {
  threads = next;
  canComment = comment;
  refresh();
}

export function focusThread(id: string) {
  const p = placed.find((x) => x.id === id);
  threads = threads.map((t) => ({ ...t, active: t.id === id }));
  paint();
  const target = p?.range ?? p?.el;
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const top = rect.top + window.scrollY - window.innerHeight / 3;
  window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  const el = p?.el ?? (p?.range?.commonAncestorContainer instanceof Element ? p.range.commonAncestorContainer : p?.range?.commonAncestorContainer.parentElement);
  if (el) {
    el.classList.remove("art-flash");
    void (el as HTMLElement).offsetWidth;
    el.classList.add("art-flash");
  }
}

export function markChanged(blocks: string[]) {
  changedBlocks = blocks;
  applyChanged();
}

function applyChanged() {
  const want = new Set(changedBlocks);
  for (const el of document.querySelectorAll(".art-changed")) if (!want.has(el.getAttribute("data-b") ?? "")) el.classList.remove("art-changed");
  for (const id of changedBlocks) document.querySelector(`[data-b="${cssEscape(id)}"]`)?.classList.add("art-changed");
}

// ---- anchoring ----------------------------------------------------------------

/** Debounced, but never postponed more than a second, so busy pages still re-anchor. */
function scheduleRefresh(ms: number) {
  const now = Date.now();
  if (!refreshTimer) refreshDeadline = now + 1000;
  else clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, Math.max(0, Math.min(ms, refreshDeadline - now)));
}

function refresh() {
  refreshTimer = null;
  placed = threads.map((t) => ({ id: t.id, ...locate(t.anchor) }));
  // Document order: by the start of the range or element.
  placed.sort((a, b) => compareNodes(startNode(a), startNode(b)));
  paint();
  // Re-rendered blocks lose their change marks; put them back.
  applyChanged();
  const report = JSON.stringify(placed.map((p) => [p.id, p.status]));
  if (report !== lastReport) {
    lastReport = report;
    send({ t: "anchors", placed: placed.map((p) => ({ id: p.id, status: p.status })) });
  }
}

function startNode(p: Placed): Node | null {
  return p.range?.startContainer ?? p.el ?? null;
}

function compareNodes(a: Node | null, b: Node | null): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  if (a === b) return 0;
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

/** Find an anchor on the current page. */
export function locate(anchor: Anchor | null): { status: AnchorStatus; range: Range | null; el: Element | null } {
  if (!anchor) return { status: "anchored", range: null, el: null };
  let scope: Element | null = anchor.block ? root.querySelector(`[data-b="${cssEscape(anchor.block)}"]`) : null;
  if (scope && anchor.row) scope = scope.querySelector(`tr[data-row="${cssEscape(anchor.row)}"]`) ?? scope;
  if (anchor.quote) {
    const range = (scope && findQuote(scope, anchor.quote)) ?? findQuote(root, anchor.quote);
    if (range) return { status: "anchored", range, el: scope };
    return { status: scope ? "outdated" : "orphaned", range: null, el: scope };
  }
  if (anchor.block) return scope ? { status: "anchored", range: null, el: scope } : { status: "orphaned", range: null, el: null };
  if (anchor.row) {
    const row = root.querySelector(`tr[data-row="${cssEscape(anchor.row)}"]`);
    return row ? { status: "anchored", range: null, el: row } : { status: "orphaned", range: null, el: null };
  }
  return { status: "anchored", range: null, el: null };
}

type TextIndex = { text: string; nodes: { node: Text; start: number }[] };

function textIndex(scope: Node): TextIndex {
  const nodes: { node: Text; start: number }[] = [];
  let text = "";
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (isOurs(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: text.length });
    text += (n as Text).data;
  }
  return { text, nodes };
}

function rangeAt(index: TextIndex, start: number, end: number): Range | null {
  const range = document.createRange();
  const pos = (offset: number, preferEnd: boolean) => {
    for (let i = 0; i < index.nodes.length; i++) {
      const { node, start: s } = index.nodes[i];
      const e = s + node.data.length;
      if (offset < e || (preferEnd && offset === e) || i === index.nodes.length - 1) return { node, offset: Math.min(offset - s, node.data.length) };
    }
    return null;
  };
  const a = pos(start, false);
  const b = pos(end, true);
  if (!a || !b) return null;
  range.setStart(a.node, Math.max(0, a.offset));
  range.setEnd(b.node, Math.max(0, b.offset));
  return range;
}

/** Exact match first (scored by prefix/suffix when it occurs more than once), then a whitespace-insensitive match. */
function findQuote(scope: Element, quote: NonNullable<Anchor["quote"]>): Range | null {
  const index = textIndex(scope);
  const hits: number[] = [];
  for (let i = index.text.indexOf(quote.exact); i !== -1 && hits.length < 50; i = index.text.indexOf(quote.exact, i + 1)) hits.push(i);
  if (hits.length) {
    let best = hits[0];
    let bestScore = -1;
    for (const h of hits) {
      const before = index.text.slice(Math.max(0, h - quote.prefix.length), h);
      const after = index.text.slice(h + quote.exact.length, h + quote.exact.length + quote.suffix.length);
      const score = commonSuffix(before, quote.prefix) + commonPrefix(after, quote.suffix);
      if (score > bestScore) [best, bestScore] = [h, score];
    }
    return rangeAt(index, best, best + quote.exact.length);
  }
  // Whitespace differences (line wrapping in the source, collapsed spaces).
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const target = norm(quote.exact);
  if (!target) return null;
  const map: number[] = [];
  let flat = "";
  let space = false;
  for (let i = 0; i < index.text.length; i++) {
    const ch = index.text[i];
    if (/\s/.test(ch)) {
      if (!space && flat.length) {
        flat += " ";
        map.push(i);
      }
      space = true;
    } else {
      flat += ch;
      map.push(i);
      space = false;
    }
  }
  const at = flat.indexOf(target);
  if (at === -1) return null;
  return rangeAt(index, map[at], map[at + target.length - 1] + 1);
}

function commonPrefix(a: string, b: string) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function commonSuffix(a: string, b: string) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

// ---- painting -------------------------------------------------------------------

function paint() {
  const active = new Set(threads.filter((t) => t.active).map((t) => t.id));
  if (highlights && HighlightCtor) {
    const normal = placed.filter((p) => p.range && !active.has(p.id)).map((p) => p.range!);
    const hot = placed.filter((p) => p.range && active.has(p.id)).map((p) => p.range!);
    highlights.set("art-comment", new HighlightCtor(...normal));
    highlights.set("art-comment-active", new HighlightCtor(...hot));
  }
  for (const el of root.querySelectorAll(".art-commented")) el.classList.remove("art-commented");
  for (const p of placed) if (!p.range && p.el) p.el.classList.add("art-commented");
  drawMarkers(active);
}

/** A small count bubble in the right margin beside each anchored thread. */
function drawMarkers(active: Set<string>) {
  if (!markerLayer) {
    markerLayer = document.createElement("div");
    markerLayer.className = "art-markers";
    markerLayer.setAttribute("data-print", "hide");
    document.body.append(markerLayer);
  }
  const rows = new Map<number, { ids: string[]; top: number }>();
  const column = root.querySelector(".art-page") ?? root.firstElementChild ?? root;
  const right = column.getBoundingClientRect().right;
  // On narrow screens there's no margin: highlighted text is tapped directly,
  // and only element comments (which have no highlight) get a bubble.
  const roomy = right + 34 <= window.innerWidth;
  for (const p of placed) {
    const target = p.range ?? p.el;
    if (!target || (!roomy && p.range)) continue;
    const rect = target.getBoundingClientRect();
    if (!rect.height && !rect.width) continue;
    const top = Math.round(rect.top + window.scrollY);
    // Threads within a line of each other share one bubble.
    const key = [...rows.keys()].find((k) => Math.abs(k - top) < 20) ?? top;
    const row = rows.get(key) ?? { ids: [], top };
    row.ids.push(p.id);
    rows.set(key, row);
  }
  markerLayer.replaceChildren(
    ...[...rows.values()].map(({ ids, top }) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `art-marker${ids.some((id) => active.has(id)) ? " is-active" : ""}`;
      b.style.top = `${top}px`;
      b.style.left = `${Math.min(right + 8, window.innerWidth - 36)}px`;
      b.title = ids.length === 1 ? "Open comment" : `${ids.length} comments`;
      b.setAttribute("aria-label", b.title);
      b.textContent = String(ids.length);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        send({ t: "comment:open", thread: ids[0] });
      });
      return b;
    }),
  );
}

function isOurs(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return Boolean(el?.closest(".art-markers, .art-comment-button, .art-block-comment"));
}

// ---- creating comments --------------------------------------------------------

let selectionTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSelectionButton() {
  if (selectionTimer) clearTimeout(selectionTimer);
  selectionTimer = setTimeout(updateSelectionButton, 120);
}

function currentSelectionRange(): Range | null {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer) || isOurs(range.commonAncestorContainer)) return null;
  const text = range.toString();
  if (!text.trim() || text.length > MAX_QUOTE) return null;
  const el = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  if (el?.closest("input, textarea, [contenteditable=''], [contenteditable='true']")) return null;
  return range;
}

function updateSelectionButton() {
  const range = canComment ? currentSelectionRange() : null;
  if (!range) {
    button?.remove();
    button = null;
    return;
  }
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "art-comment-button";
    button.textContent = "Comment";
    button.setAttribute("data-print", "hide");
    // Keep the selection when the button takes the press.
    button.addEventListener("pointerdown", (e) => e.preventDefault());
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = currentSelectionRange();
      if (r) send({ t: "comment:new", anchor: anchorFromRange(r) });
      // The new thread's highlight replaces the selection.
      document.getSelection()?.removeAllRanges();
      button?.remove();
      button = null;
    });
    document.body.append(button);
  }
  const rect = range.getBoundingClientRect();
  const top = rect.top + window.scrollY - 40;
  button.style.top = `${top < window.scrollY + 4 ? rect.bottom + window.scrollY + 8 : top}px`;
  button.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - 42, window.innerWidth - 100))}px`;
}

export function anchorFromRange(range: Range): Anchor {
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const block = start?.closest("[data-b]");
  const row = start?.closest("tr[data-row]");
  const scope = block ?? root;
  const index = textIndex(scope);
  const before = document.createRange();
  before.setStart(scope, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const offset = before.toString().length;
  const exact = range.toString();
  return {
    ...(block ? { block: block.getAttribute("data-b")! } : {}),
    ...(row ? { row: row.getAttribute("data-row")! } : {}),
    quote: {
      exact,
      prefix: index.text.slice(Math.max(0, offset - CONTEXT), offset),
      suffix: index.text.slice(offset + exact.length, offset + exact.length + CONTEXT),
    },
  };
}

/** On hover, a small "comment on this block" button beside the block (pointer devices only). */
function onPointerMove(e: PointerEvent) {
  if (!canComment || e.pointerType !== "mouse") return;
  const target = e.target as Element | null;
  if (target?.closest(".art-block-comment")) return;
  const block = target?.closest?.("[data-b]") ?? null;
  if (block === hoveredBlock) return;
  // Leaving a block toward its button crosses the gutter, which is no block; keep the button.
  if (!block && hoveredBlock && inButtonCorridor(e, hoveredBlock)) return;
  hoveredBlock = block;
  if (!block) {
    blockButton?.remove();
    blockButton = null;
    return;
  }
  if (!blockButton) {
    blockButton = document.createElement("button");
    blockButton.type = "button";
    blockButton.className = "art-block-comment";
    blockButton.setAttribute("data-print", "hide");
    blockButton.title = "Comment on this";
    blockButton.setAttribute("aria-label", "Comment on this");
    blockButton.textContent = "+";
    blockButton.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (hoveredBlock) send({ t: "comment:new", anchor: blockAnchor(hoveredBlock) });
    });
    document.body.append(blockButton);
  }
  const rect = block.getBoundingClientRect();
  const column = (root.querySelector(".art-page") ?? root.firstElementChild ?? root).getBoundingClientRect();
  blockButton.style.top = `${rect.top + window.scrollY + 2}px`;
  blockButton.style.left = `${Math.max(4, column.left - 30)}px`;
}

/** The band from the block's button across the gutter to the block, at the block's height. */
function inButtonCorridor(e: PointerEvent, block: Element): boolean {
  if (!blockButton) return false;
  const rect = block.getBoundingClientRect();
  const button = blockButton.getBoundingClientRect();
  const slack = 8;
  return (
    e.clientX >= button.left - slack &&
    e.clientX <= rect.right &&
    e.clientY >= Math.min(rect.top, button.top) - slack &&
    e.clientY <= Math.max(rect.bottom, button.bottom) + slack
  );
}

function blockAnchor(block: Element): Anchor {
  const id = block.getAttribute("data-b")!;
  // Charts' text is axis ticks run together; name the element instead.
  if (block.querySelector(".recharts-wrapper, canvas")) return { block: id, label: "Chart" };
  const text = (block.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!text && block.querySelector("img")) return { block: id, label: "Image" };
  return { block: id, label: text ? (text.length > 60 ? `${text.slice(0, 59)}…` : text) : "Block" };
}

/** Clicking highlighted text opens its thread. */
function onClick(e: MouseEvent) {
  if (!placed.some((p) => p.range)) return;
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | null = null;
  let offset = 0;
  const pos = doc.caretPositionFromPoint?.(e.clientX, e.clientY);
  if (pos) [node, offset] = [pos.offsetNode, pos.offset];
  else {
    const r = doc.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (r) [node, offset] = [r.startContainer, r.startOffset];
  }
  if (!node || document.getSelection()?.isCollapsed === false) return;
  for (const p of placed) {
    if (!p.range) continue;
    try {
      if (p.range.isPointInRange(node, offset) && !(p.range.endContainer === node && p.range.endOffset === offset)) {
        send({ t: "comment:open", thread: p.id });
        return;
      }
    } catch {
      // node in another document or detached
    }
  }
}

function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

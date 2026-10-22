// Listen's wisp: a small moon-white light that hops from word to word above
// the line being spoken, trailing a short tail of fainter lights, like the
// bouncing ball over lyrics but the ghost's. It is the agent's light, so it
// is moon white (AGENTS.md "Look"), and it moves only to show what changed:
// the word being spoken.
//
// Cheap by construction: four absolutely positioned dots in one layer that
// scrolls with the page, animated with transform and opacity only (Web
// Animations, no library), one short hop per word. Reduced motion places it
// without the hop.

import { motionMs } from "../shared/motion.ts";

/** Head, then the tail: each tail dot follows the same path a little later. */
const TAIL_DELAYS = [0, 26, 52, 78];
/** How far above the word's top edge the wisp rests. */
const LIFT = 7;

let layer: HTMLElement | null = null;
let dots: HTMLElement[] = [];
let at: { x: number; y: number } | null = null;

function ensure(): HTMLElement[] {
  if (layer?.isConnected) return dots;
  layer = document.createElement("div");
  layer.className = "art-wisp";
  layer.setAttribute("aria-hidden", "true");
  dots = TAIL_DELAYS.map((_, k) => {
    const d = document.createElement("span");
    d.className = k ? "art-wisp-tail" : "art-wisp-head";
    d.style.setProperty("--k", String(k));
    layer!.append(d);
    return d;
  });
  document.body.append(layer);
  return dots;
}

/** Where the wisp rests over a word: centred, just above the line, in page coordinates. */
function spot(range: Range): { x: number; y: number } | null {
  const rects = range.getClientRects();
  const r = rects[0] ?? range.getBoundingClientRect();
  if (!r || (!r.width && !r.height)) return null;
  return { x: r.left + r.width / 2 + scrollX, y: r.top - LIFT + scrollY };
}

const place = (p: { x: number; y: number }) => `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;

/** Moves the wisp over `range` (null hides it). `hopMs` caps the hop so it lands before the word is over. */
export function wispTo(range: Range | null, hopMs = 220) {
  if (!range) return hide();
  const to = spot(range);
  if (!to) return hide();
  const ds = ensure();
  const from = at;
  at = to;
  const duration = Math.min(motionMs("slow"), Math.max(90, hopMs));
  if (!from || !layer!.hasAttribute("data-on") || !duration) {
    // Arriving (or reduced motion): appear in place, fading in.
    for (const d of ds) {
      for (const a of d.getAnimations()) a.cancel();
      d.style.transform = place(to);
    }
    layer!.setAttribute("data-on", "");
    return;
  }
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  // A new line is a longer, higher leap; the next word on the same line a small skip.
  const height = Math.min(22, Math.max(6, Math.abs(dx) * 0.22 + Math.abs(dy) * 0.3));
  const steps = 10;
  const frames: Keyframe[] = [];
  for (let s = 0; s <= steps; s++) {
    const p = s / steps;
    // Ease the travel; the lift is a parabola so it rises and falls.
    const e = 1 - (1 - p) ** 2.2;
    const x = from.x + dx * e;
    const y = from.y + dy * e - 4 * height * p * (1 - p);
    frames.push({ transform: place({ x, y }), offset: p });
  }
  ds.forEach((d, k) => {
    // Start from wherever it is now, so a hop that interrupts a hop doesn't jump.
    for (const a of d.getAnimations()) {
      a.commitStyles?.();
      a.cancel();
    }
    d.style.transform = place(to);
    const head = k === 0;
    d.animate(
      head
        ? frames.map((f, s) => {
            // The head stretches along its flight and settles as it lands.
            const p = s / steps;
            const stretch = 1 + 0.32 * Math.sin(Math.PI * p);
            return { ...f, transform: `${f.transform} scale(${stretch.toFixed(3)}, ${(1 / Math.sqrt(stretch)).toFixed(3)})` };
          })
        : frames,
      { duration: duration + (head ? 0 : 20), delay: TAIL_DELAYS[k], easing: "linear", fill: "backwards" },
    );
  });
}

function hide() {
  if (!layer?.hasAttribute("data-on")) return;
  layer.removeAttribute("data-on");
  at = null;
}

/** Keeps the wisp on its word when the page reflows (a resize, fonts settling). */
export function wispReflow(range: Range | null) {
  if (!range || !layer?.hasAttribute("data-on")) return;
  const to = spot(range);
  if (!to) return;
  at = to;
  for (const d of dots) {
    for (const a of d.getAnimations()) a.cancel();
    d.style.transform = place(to);
  }
}

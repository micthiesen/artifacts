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

/** The head, then three tail dots, each following the same path a little later. */
const DOTS = 4;

let layer: HTMLElement | null = null;
let dots: HTMLElement[] = [];
let at: { x: number; y: number } | null = null;

function ensure(): HTMLElement[] {
  if (layer?.isConnected) return dots;
  layer = document.createElement("div");
  layer.className = "art-wisp";
  layer.setAttribute("aria-hidden", "true");
  dots = Array.from({ length: DOTS }, (_, k) => {
    const d = document.createElement("span");
    d.className = k ? "art-wisp-tail" : "art-wisp-head";
    d.style.setProperty("--k", String(k));
    layer!.append(d);
    return d;
  });
  document.body.append(layer);
  return dots;
}

/**
 * Where the wisp rests over a word, in page coordinates: centred on it, in the gap between its line and the
 * one above (the top of its line box), so it never sits on the letters of either.
 */
function spot(range: Range): { x: number; y: number } | null {
  const rects = range.getClientRects();
  const r = rects[0] ?? range.getBoundingClientRect();
  if (!r || (!r.width && !r.height)) return null;
  const host = range.startContainer.parentElement;
  const lh = host ? parseFloat(getComputedStyle(host).lineHeight) : NaN;
  const gap = Number.isFinite(lh) ? Math.max(3, (lh - r.height) / 2) : 4;
  return { x: r.left + r.width / 2 + scrollX, y: r.top - gap + scrollY };
}

/** Where a dot is right now, mid-hop or not, so a hop that interrupts a hop starts from there. */
function live(d: HTMLElement, fallback: { x: number; y: number }): { x: number; y: number } {
  const t = getComputedStyle(d).transform;
  if (!t || t === "none") return fallback;
  const m = new DOMMatrixReadOnly(t);
  return { x: m.e, y: m.f };
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
  // The whole hop, tail included, stays within --motion-slow; the tail trails by a fraction of --motion-fast.
  const fast = motionMs("fast");
  const spacing = Math.round(fast / 5);
  const duration = Math.min(motionMs("slow") - spacing * (DOTS - 1), Math.max(Math.round(fast * 0.75), hopMs));
  if (!from || !layer!.hasAttribute("data-on") || !duration) {
    // Arriving (or reduced motion): appear in place, fading in.
    for (const d of ds) {
      for (const a of d.getAnimations()) a.cancel();
      d.style.transform = place(to);
    }
    layer!.setAttribute("data-on", "");
    return;
  }
  const steps = 10;
  ds.forEach((d, k) => {
    const start = live(d, from);
    for (const a of d.getAnimations()) a.cancel();
    d.style.transform = place(to);
    const dx = to.x - start.x;
    const dy = to.y - start.y;
    // A new line is a longer, higher leap; the next word on the same line a small skip.
    const height = Math.min(20, Math.max(5, Math.abs(dx) * 0.2 + Math.abs(dy) * 0.3));
    const head = k === 0;
    const frames: Keyframe[] = [];
    for (let s = 0; s <= steps; s++) {
      const p = s / steps;
      // Ease the travel; the lift is a parabola so it rises and falls.
      const e = 1 - (1 - p) ** 2.2;
      let transform = place({ x: start.x + dx * e, y: start.y + dy * e - 4 * height * p * (1 - p) });
      // The head stretches in flight and settles as it lands.
      if (head) {
        const stretch = 1 + 0.3 * Math.sin(Math.PI * p);
        transform += ` scale(${stretch.toFixed(3)}, ${(1 / Math.sqrt(stretch)).toFixed(3)})`;
      }
      frames.push({ transform, offset: p });
    }
    d.animate(frames, { duration, delay: spacing * k, easing: "linear", fill: "backwards" });
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

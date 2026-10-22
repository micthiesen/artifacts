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
/** How high a hop rises above where the wisp rests, at most (px): the gap between lines leaves little more. */
const MAX_LIFT = 3;
/** Out and back in, for a jump to the next line. */
const BLINK: Keyframe[] = [{ opacity: 1 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }];

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
  return { x: r.left + r.width / 2 + scrollX, y: r.top - gap - 2 + scrollY };
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
export function wispTo(range: Range | null, hopMs = motionMs("base")) {
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
  // To the next line: a sweep back across the text would trail beads over every word, so it fades out
  // here and in there instead.
  if (to.y - from.y > 6 && (to.x < from.x || Math.abs(to.x - from.x) > 240)) {
    const half = Math.round(fast / 2);
    ds.forEach((d) => {
      for (const a of d.getAnimations()) a.cancel();
      d.style.transform = place(to);
    });
    layer!.animate(BLINK, { duration: half * 2, easing: "linear" });
    return;
  }
  // Short, quick hops (fast speech, short words) flatten so the wisp glides instead of buzzing.
  const flat = Math.min(1, duration / 180);
  const steps = 10;
  ds.forEach((d, k) => {
    const start = live(d, from);
    for (const a of d.getAnimations()) a.cancel();
    d.style.transform = place(to);
    const dx = to.x - start.x;
    const dy = to.y - start.y;
    // A small lift, kept inside the gap between the lines so it never crosses the letters above; a longer skip
    // lifts a little more than the next short word.
    const height = flat * Math.min(MAX_LIFT, Math.max(2, Math.abs(dx) * 0.06));
    const head = k === 0;
    const frames: Keyframe[] = [];
    for (let s = 0; s <= steps; s++) {
      const p = s / steps;
      // Travel eases out gently; the lift is a parabola, so it rises and falls over the middle.
      const e = 1 - (1 - p) ** 1.5;
      let transform = place({ x: start.x + dx * e, y: start.y + dy * e - 4 * height * p * (1 - p) });
      if (head) {
        // Stretched as it leaves (when it's fastest), a small squash as it lands, then round again.
        const stretch = p < 0.85 ? 1 + 0.3 * flat * Math.sin(Math.PI * Math.min(1, p * 1.6)) : p < 1 ? 1 - 0.12 * flat : 1;
        transform += ` scale(${stretch.toFixed(3)}, ${(1 / stretch).toFixed(3)})`;
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

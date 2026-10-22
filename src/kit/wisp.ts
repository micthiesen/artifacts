// Listen's wisp: a small ghost of moon light that reads along with you.
//
// What it is. The wisp is a character, not an indicator. It is the agent's light (moon white, AGENTS.md
// "Look"), and while Listen reads it keeps you company: it hops from word to word as each is spoken, flies
// to the next paragraph, and when there's nothing to point at (paused, waiting for the voice, a table read
// as a summary) it floats up a little and bobs where it is, keeping your place.
//
// How it behaves, and why:
// - It is always there while you listen. It arrives when Listen starts, rising out from behind the tray at
//   the bottom of the page, and leaves when Listen closes, diving back down under it. It never fades in or
//   out and never blinks away mid-reading: something that keeps your place shouldn't vanish.
// - It moves like something with a body. A spring pulls it toward where it wants to be, so it accelerates,
//   overshoots a touch and settles; each new word gives it a small upward kick, so a word-to-word move is a
//   hop and a paragraph-to-paragraph move is a flight. Its tail is a chain of points that each chase the one
//   before, so the faster it goes the longer and softer the tail streams behind, and at rest it gathers back
//   into one round blob.
// - It squashes and stretches along its flight and, when it's still, shows the logo's happy closed eyes.
// - It is drawn small while it tracks words (so it fits in the gap between lines without covering letters)
//   and grows a little when it floats. When it pauses beside a word it steps out into the margin to the left
//   of that line, so it keeps your place without sitting on anything you're reading.
// - If the word being read is scrolled out of view, the wisp waits at the edge of the screen nearest to it,
//   peeking, so you can see where the reading is.
// - Reduced motion: no flight, hop, bob or tail. It sits on its spot, appears when Listen starts and goes
//   when it closes.
//
// How it's drawn: src/shared/wisp-body.ts (the same body as the splash page's wisp). This file is what it
// does here. It paints only while something moves: the loop stops once it has landed, and when it has
// floated for a while it settles into a doze (still, eyes closed) until the next word, scroll or state.

import { prefersStill, WispBody, type Point } from "../shared/wisp-body.ts";

export type WispMood = "tracking" | "resting" | "waiting";

/** Head radius (css px) while tracking words, and while floating. */
const R_TRACK = 5;
const R_FLOAT = 7;
/** The spring toward the wisp's spot (stiffness per s²), by what it's doing. */
const SPRING = { tracking: 210, resting: 38, waiting: 46, leaving: 70 } as const;
/**
 * The upward kick a new word gives it (px/s), by how far away the word is: the next word on the line gets a
 * skip that stays in the gap between lines, a word on another line or further off a real leap.
 */
const kick = (d: number) => (d < 160 ? Math.min(120, 40 + d * 0.5) : Math.min(320, 120 + (d - 160) * 0.4));
/** How far above a block (with no words) it floats, the bob around its spot, and when it stops bobbing (s). */
const FLOAT_LIFT = 16;
const BOB = { x: 2.2, y: 3.2, speed: 2.1 };
const DOZE_AFTER = 12;
/** Kept this far inside the edges, so a word scrolled out of view leaves the wisp peeking from the nearest edge. */
const EDGE = 14;

let body: WispBody | null = null;
let present = false;
let leaving = false;
let mood: WispMood = "waiting";
let target: Range | Element | null = null;
let raf = 0;
let last = 0;
let clock = 0;
/** Seconds spent floating since it last moved on: after DOZE_AFTER it stops bobbing (and drawing). */
let floated = 0;

addEventListener("resize", () => wake());
// The page scrolling moves its words under the wisp: let it catch up.
addEventListener("scroll", () => wake(), { capture: true, passive: true });

const floating = () => mood !== "tracking" || !(target instanceof Range);

/** Where the wisp wants to be: over its word (in the gap above the line), or floating above its block. */
function spot(): Point {
  const head = body!.head;
  // Leaving: down past the bottom edge, under the tray.
  if (leaving) return { x: Math.min(innerWidth - EDGE, Math.max(EDGE, head.x)), y: innerHeight + 40 };
  let p: Point = { x: innerWidth / 2, y: innerHeight * 0.4 };
  if (target instanceof Range) {
    const r = target.getClientRects()[0] ?? target.getBoundingClientRect();
    if (r && (r.width || r.height)) {
      const host = target.startContainer.parentElement;
      const lh = host ? parseFloat(getComputedStyle(host).lineHeight) : NaN;
      const gap = Number.isFinite(lh) ? Math.max(3, (lh - r.height) / 2) : 4;
      p = { x: r.left + r.width / 2, y: r.top - gap - 1 };
    }
  } else if (target instanceof Element && target.isConnected) {
    const r = target.getBoundingClientRect();
    p = { x: r.left + Math.min(r.width / 2, 48), y: r.top - 4 };
  }
  if (floating()) {
    // Not pointing at a word. Beside a word (paused, waiting): it steps out into the margin to the left of
    // the line, so it keeps the place without covering anything. Over a block with no words: a little above it.
    if (target instanceof Range) {
      const r = target.getClientRects()[0] ?? target.getBoundingClientRect();
      const block = (target.startContainer.parentElement?.closest("[data-speak-i]") ?? target.startContainer.parentElement)?.getBoundingClientRect();
      if (r && block) p = { x: Math.max(R_FLOAT + 3, block.left - R_FLOAT - 8), y: r.top + r.height / 2 };
    } else p = { x: p.x, y: p.y - FLOAT_LIFT };
    const bob = prefersStill() || floated > DOZE_AFTER ? 0 : 1;
    p = { x: p.x + Math.sin(clock * BOB.speed * 0.5) * BOB.x * bob, y: p.y + Math.sin(clock * BOB.speed) * BOB.y * bob };
  }
  return { x: Math.min(innerWidth - EDGE, Math.max(EDGE, p.x)), y: Math.min(innerHeight - EDGE, Math.max(EDGE, p.y)) };
}

function wake() {
  if (!present || raf) return;
  last = performance.now();
  raf = requestAnimationFrame(frame);
}

function frame(now: number) {
  raf = 0;
  if (!body) return;
  const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
  last = now;
  clock += dt;
  floated = floating() ? floated + dt : 0;
  const goal = spot();
  const size = floating() ? R_FLOAT : R_TRACK;
  const still = prefersStill();
  body.step(dt, goal, SPRING[leaving ? "leaving" : mood], size, still);
  body.draw();
  // Gone under the tray: stop and clear.
  if (leaving && body.head.y > innerHeight + 30) return finishLeaving();
  const bobbing = floating() && !still && floated <= DOZE_AFTER;
  if (leaving || bobbing || !body.settled(goal, size)) raf = requestAnimationFrame(frame);
}

function finishLeaving() {
  present = false;
  leaving = false;
  target = null;
  cancelAnimationFrame(raf);
  raf = 0;
  body?.clear();
}

/** Listen started: the wisp rises out from under the tray, toward wherever the reading is. */
export function wispArrive() {
  if (!body?.connected) body = new WispBody("art-wisp", { light: "--foreground", ink: "--background" });
  if (present && !leaving) return;
  if (!present) {
    body.place({ x: innerWidth / 2, y: innerHeight + 24 }, { x: 0, y: -380 });
    body.radius = R_FLOAT;
    mood = "waiting";
    target = null;
    floated = 0;
  }
  present = true;
  leaving = false;
  wake();
}

/** Listen closed: the wisp dives back down under the tray (or, with reduced motion, simply goes). */
export function wispLeave() {
  if (!present || !body) return;
  if (prefersStill()) return finishLeaving();
  leaving = true;
  // A little hop up before it dives.
  body.vel.y = Math.min(body.vel.y, -160);
  wake();
}

/** What the wisp follows: the word being spoken (a Range), or a block with no words of its own (an Element). */
export function wispFollow(to: Range | Element) {
  if (!present || leaving || !body) return;
  const before = target;
  target = to;
  floated = 0;
  // A new word: a hop up, bigger for a longer way to go.
  if (to instanceof Range && before !== to && mood === "tracking" && !prefersStill()) {
    const r = to.getBoundingClientRect();
    body.vel.y -= kick(Math.hypot(r.left + r.width / 2 - body.head.x, r.top - body.head.y));
  }
  wake();
}

/** Tracking words while the voice speaks; resting (floating) when paused or done; waiting while the voice catches up. */
export function wispMood(m: WispMood) {
  if (mood === m) return;
  mood = m;
  floated = 0;
  wake();
}

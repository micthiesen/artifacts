// Listen's wisp: a small ghost of moon light that reads along with you.
//
// What it is. The wisp is a character, not an indicator. It is the agent's light (moon white, AGENTS.md
// "Look"), and while Listen reads it keeps you company: it hops from word to word as each is spoken, flies
// to the next paragraph, and when there's nothing to point at (paused, a table read as a summary) it floats
// up a little and bobs where it is, keeping your place. While the voice catches up mid-reading it just
// hovers over the word it's on: a pause in the speech never sends it anywhere.
//
// How it behaves, and why:
// - It is always there while you listen. It arrives when Listen starts, rising out from behind the tray at
//   the bottom of the page, and leaves when Listen closes, diving back down under it. It never fades in or
//   out and never blinks away mid-reading: something that keeps your place shouldn't vanish.
// - It moves smoothly, always. Word to word it hops, a little arc and a soft squash as it touches down, timed
//   so it lands as each word is heard; at speed the hops run together into a rippling glide. At the end of
//   a line it sweeps low back to the start of the next; further off (a tap, a far paragraph) it flies on a
//   taller curve. How: src/shared/wisp-pilot.ts decides each move and src/shared/wisp-motion.ts traces it,
//   an invisible guide the wisp follows through a smoothing filter, so its path never kinks, kicks, swerves
//   or overshoots, and it never turns back mid-air. spikes/wisp-sim.ts measures and scores exactly that.
//   Its tail is a chain of points that each chase the one before, so the faster it goes the longer and
//   softer the tail streams behind, and at rest it gathers back into one round blob.
// - It squashes and stretches along its flight and, when it's still, shows the logo's happy closed eyes.
// - It is drawn small while it tracks words (so it fits in the gap between lines without covering letters,
//   smaller still where lines sit tight) and grows a little when it floats. When it pauses beside a word it steps out into the margin to the left
//   of that line, so it keeps your place without sitting on anything you're reading.
// - It lives on the page, not the screen: scrolling carries it along with the text, so scrolling alone never
//   sets its tail streaming. If you scroll the reading out of view (Follow turns off), it waits at that edge
//   of the screen, in the margin, and keeps watch there (no hopping along to each word) until the reading
//   comes back. With Follow on, a word just off screen is about to be scrolled into view, so it flies there.
// - A word with no box right now (inside something collapsed) never sends it anywhere: it stays put.
// - Reduced motion: no flight, hop, bob or tail. It appears on its spot with the first word or block and
//   goes when Listen closes.
//
// How it's drawn: src/shared/wisp-body.ts (the same body as the splash page's wisp). This file is what it
// does here. It paints only while something moves: the loop stops once it has landed, and when it has
// floated for a while it stops bobbing and rests, still, until the next word, scroll, reflow or state.

import { prefersStill, viewWidth, WispBody, type Point } from "../shared/wisp-body.ts";
import { WispPilot } from "../shared/wisp-pilot.ts";

export type WispMood = "tracking" | "resting" | "waiting";

/** Head radius (css px) while tracking words, and while floating. */
const R_TRACK = 5;
const R_FLOAT = 7;
/** The soft squash as a hop touches down: how much, and for how long (s). */
const LAND_SQUASH = 0.2;
const LAND_FOR = 0.14;
const pilot = new WispPilot();
/** How far above a block (with no words) it floats, the bob around its spot, and when it stops bobbing (s). */
const FLOAT_LIFT = 16;
const BOB = { x: 2.2, y: 3.2, speed: 2.1 };
const DOZE_AFTER = 12;
/** Over this long (s) the bob eases down to stillness, so dozing off is a settle, not a slump. */
const DOZE_EASE = 2;
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
// The page scrolling carries the wisp along (it lives on the page); redraw it where it now is.
addEventListener("scroll", () => wake(), { capture: true, passive: true });

const floating = () => mood !== "tracking" || !(target instanceof Range) || parked;

/** The page's scroll: the wisp lives on the page (so scrolling carries it along), and is drawn at page minus scroll. */
const scroll = (): Point => ({ x: scrollX, y: scrollY });
let lastScroll: Point = { x: 0, y: 0 };
/** True while the word being read is scrolled out of view and the wisp waits at the screen's edge. */
let parked = false;
/** Follow is on: the page scrolls to keep the reading in view, so a word just off screen is about to be on it. */
let following = true;
/** The last good spot on the page, kept when a word has no box right now (inside something collapsed). */
let lastSpot: Point | null = null;

/**
 * The margin left of the reading column beside `el`, where the wisp waits without covering anything (screen
 * x), or null when there's no room for it there (a narrow phone, a full-width block).
 */
function marginX(el: Element | null): number | null {
  const block = (el?.closest("[data-speak-i]") ?? el)?.getBoundingClientRect();
  const x = block ? block.left - R_FLOAT - 8 : 0;
  return x >= R_FLOAT + 4 ? x : null;
}
/** With no margin, it waits small in the gap above the line, as it does while reading. */
let cramped = false;
/** Its size over the word: R_TRACK, or smaller where the lines sit tight (a big number under its label). */
let fit = R_TRACK;

/** The gap above a word's line (half the line's leading), worked out once per word. */
let gapFor: { range: Range; gap: number } | null = null;
function lineGap(range: Range, height: number): number {
  if (gapFor?.range === range) return gapFor.gap;
  const host = range.startContainer.parentElement;
  const lh = host ? parseFloat(getComputedStyle(host).lineHeight) : NaN;
  const gap = Number.isFinite(lh) ? Math.max(3, (lh - height) / 2) : 4;
  gapFor = { range, gap };
  return gap;
}

/**
 * Where the wisp wants to be, in page coordinates: over its word (in the gap above the line), beside it in the
 * margin while it waits, a little above a block with no words, or (when the reading is scrolled out of view)
 * at the nearest edge of the screen, in the margin, until the reading comes back.
 */
function spot(): Point {
  const sc = scroll();
  parked = false;
  cramped = false;
  // Leaving: down past the bottom edge, under the tray.
  if (leaving) return { x: pilot.motion.pos.x, y: sc.y + innerHeight + 40 };
  let p: Point | null = null;
  if (target instanceof Range) {
    const r = target.getClientRects()[0] ?? target.getBoundingClientRect();
    const host = target.startContainer.parentElement;
    if (r && (r.width || r.height) && target.startContainer.isConnected) {
      const margin = marginX(host);
      const gap = lineGap(target, r.height);
      fit = Math.min(R_TRACK, Math.max(3, gap + 1));
      const above = { x: r.left + r.width / 2, y: r.top - gap - 1 };
      if (!following && (r.bottom < 0 || r.top > innerHeight)) {
        // Out of view because the reader scrolled away (Follow is off): wait at that edge, in the margin (or
        // over the column's start on a narrow screen), on screen. It doesn't follow each word along the edge;
        // it keeps watch until the reading scrolls back. (With Follow on, the page is about to bring the word
        // into view, and the wisp, which lives on the page, simply flies to it.)
        parked = true;
        const y = r.bottom < 0 ? EDGE + R_FLOAT : innerHeight - EDGE - R_FLOAT;
        p = { x: margin ?? EDGE + R_FLOAT, y };
      } else if (mood === "waiting") {
        // Waiting for the voice mid-reading (the next sentence isn't ready yet): it hovers right where it
        // is, small, over the word, rather than setting off anywhere and coming back.
        cramped = true;
        p = above;
      } else if (floating() && margin !== null) {
        // Paused: step out into the margin beside the line.
        p = { x: margin, y: r.top + r.height / 2 };
      } else if (floating()) {
        // Paused with no margin (a phone): float over the paragraph, above its first line, full size.
        const block = (host?.closest("[data-speak-i]") ?? host)?.getBoundingClientRect();
        p = { x: r.left + r.width / 2, y: (block ? block.top : r.top) - FLOAT_LIFT * 0.6 };
      } else p = above;
    }
  } else if (target instanceof Element && target.isConnected) {
    const r = target.getBoundingClientRect();
    if (r.width || r.height) p = { x: r.left + Math.min(r.width / 2, 48), y: r.top - FLOAT_LIFT };
  }
  // Nothing with a box right now (a word inside something collapsed, or nothing yet): stay where it was.
  if (!p) return lastSpot ?? { ...pilot.motion.pos };
  if (floating()) {
    const bob = (prefersStill() ? 0 : Math.min(1, Math.max(0, (DOZE_AFTER + DOZE_EASE - floated) / DOZE_EASE))) * (cramped ? 0.35 : 1);
    p = { x: p.x + Math.sin(clock * BOB.speed * 0.5) * BOB.x * bob, y: p.y + Math.sin(clock * BOB.speed) * BOB.y * bob };
  }
  const x = Math.min(viewWidth() - EDGE, Math.max(EDGE, p.x));
  lastSpot = { x: x + sc.x, y: p.y + sc.y };
  return lastSpot;
}

function wake() {
  if (!present || raf) return;
  last = 0;
  raf = requestAnimationFrame(frame);
}

function frame(now: number) {
  raf = 0;
  if (!body) return;
  // The first frame after waking has no previous one: call it a 60th of a second.
  const dt = last ? Math.min(0.05, Math.max(0.001, (now - last) / 1000)) : 1 / 60;
  last = now;
  clock += dt;
  const sc = scroll();
  // Waiting at the screen's edge, it stays put on screen while the page scrolls under it.
  if (parked) {
    pilot.shift(sc.x - lastScroll.x, sc.y - lastScroll.y);
    body.shift(sc.x - lastScroll.x, sc.y - lastScroll.y);
  }
  lastScroll = sc;
  const goal = spot();
  floated = floating() ? floated + dt : 0;
  const size = floating() && !cramped ? R_FLOAT : fit;
  const still = prefersStill();
  pilot.frame(dt, goal, still);
  body.follow(pilot.motion.pos, pilot.motion.vel, dt, size, still);
  // A soft squash as a hop touches down, easing in and back out to round.
  const since = pilot.clock - pilot.landedAt;
  const landing = !still && pilot.lastWasHop && pilot.landedAt >= 0 && since < LAND_FOR;
  body.squash = landing ? LAND_SQUASH * Math.sin(Math.PI * (since / LAND_FOR)) : 0;
  body.upright = landing;
  // Waiting at the screen's edge it is pinned there, so the page scrolls under it without it moving.
  body.draw(clock, parked);
  // A trace for measuring smoothness on a real page (spikes/wisp-score.ts); off unless a test switches it on.
  const trace = globalThis as { __wispTrace?: unknown[] };
  if (trace.__wispTrace) trace.__wispTrace.push({ t: now, x: pilot.motion.pos.x, y: pilot.motion.pos.y, gx: goal.x, gy: goal.y, mood, parked });
  // Gone under the tray: stop.
  if (leaving && body.head.y - sc.y > innerHeight + 30) return finishLeaving();
  const bobbing = floating() && !still && floated <= DOZE_AFTER + DOZE_EASE;
  if (landing || leaving || bobbing || !pilot.motion.settled || !body.gathered(size)) raf = requestAnimationFrame(frame);
}

function finishLeaving() {
  present = false;
  leaving = false;
  target = null;
  gapFor = null;
  cancelAnimationFrame(raf);
  raf = 0;
  // Its canvas goes too, so a closed Listen keeps no full-screen bitmap around.
  body?.dispose();
  body = null;
}

/** Listen started: the wisp rises out from under the tray, toward wherever the reading is. */
export function wispArrive() {
  if (!body?.connected) {
    body?.dispose();
    body = new WispBody("art-wisp", { light: "--foreground", ink: "--background" });
    body.observe(wake);
  }
  if (present && !leaving) return;
  if (!present) {
    lastScroll = scroll();
    lastSpot = null;
    const start = { x: viewWidth() / 2 + lastScroll.x, y: innerHeight + 24 + lastScroll.y };
    // Its first spot is a flight from here, up out from behind the tray.
    pilot.place(start, true);
    body.place(start);
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
  wake();
}

/**
 * The spot over a word in page coordinates (in the gap above its line), or null when it has no box, or is
 * off screen and the page won't be bringing it into view (`followed` false).
 */
function wordSpot(range: Range, followed: boolean): Point | null {
  const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (!r || (!r.width && !r.height) || (!followed && (r.bottom < 0 || r.top > innerHeight))) return null;
  const gap = lineGap(range, r.height);
  return { x: Math.min(viewWidth() - EDGE, Math.max(EDGE, r.left + r.width / 2)) + scrollX, y: r.top - gap - 1 + scrollY };
}

/** What the wisp follows: the word being spoken (a Range), or a block with no words of its own (an Element). */
export function wispFollow(to: Range | Element) {
  if (!present || leaving || !body) return;
  const before = target;
  target = to;
  floated = 0;
  // A new word while reading: the pilot hops there, sweeps back to the next line, or flies (not while it waits
  // at the screen's edge). Anything else that moves its spot (a block, the margin) the pilot sees as a jump.
  if (to instanceof Range && before !== to && mood === "tracking" && !parked && !prefersStill()) {
    const at = wordSpot(to, following);
    if (at) {
      const host = to.startContainer.parentElement;
      const lh = host ? parseFloat(getComputedStyle(host).lineHeight) : NaN;
      pilot.word(at, Number.isFinite(lh) ? lh : 28);
    }
  }
  wake();
}

/** Follow turned on or off (src/kit/speak.ts): with it off, a word scrolled out of view leaves the wisp waiting at the edge. */
export function wispFollowing(on: boolean) {
  if (following === on) return;
  following = on;
  wake();
}

/** Tracking words while the voice speaks; resting (floating) when paused or done; waiting while the voice catches up. */
export function wispMood(m: WispMood) {
  if (mood === m) return;
  mood = m;
  floated = 0;
  wake();
}

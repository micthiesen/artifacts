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
// - It moves like something with a body. Word to word it hops: a short arc, a little taller in the air, a
//   soft squash as it lands. Further off (a paragraph down the page) a spring carries it in a flight, so it
//   accelerates, overshoots a touch and settles. Its tail is a chain of points that each chase the one
//   before, so the faster it goes the longer and softer the tail streams behind, and at rest it gathers back
//   into one round blob.
// - It squashes and stretches along its flight and, when it's still, shows the logo's happy closed eyes.
// - It is drawn small while it tracks words (so it fits in the gap between lines without covering letters,
//   smaller still where lines sit tight) and grows a little when it floats. When it pauses beside a word it steps out into the margin to the left
//   of that line, so it keeps your place without sitting on anything you're reading.
// - It lives on the page, not the screen: scrolling carries it along with the text, so scrolling alone never
//   sets its tail streaming. If the reading is scrolled out of view, it waits at that edge of the screen, in
//   the margin, and keeps watch there (no hopping along to each word) until the reading comes back.
// - A word with no box right now (inside something collapsed) never sends it anywhere: it stays put.
// - Reduced motion: no flight, hop, bob or tail. It appears on its spot with the first word or block and
//   goes when Listen closes.
//
// How it's drawn: src/shared/wisp-body.ts (the same body as the splash page's wisp). This file is what it
// does here. It paints only while something moves: the loop stops once it has landed, and when it has
// floated for a while it stops bobbing and rests, still, until the next word, scroll, reflow or state.

import { prefersStill, viewWidth, WispBody, type Point } from "../shared/wisp-body.ts";

export type WispMood = "tracking" | "resting" | "waiting";

/** Head radius (css px) while tracking words, and while floating. */
const R_TRACK = 5;
const R_FLOAT = 7;
/** The spring toward the wisp's spot (stiffness per s²), by what it's doing. */
const SPRING = { tracking: 210, resting: 38, waiting: 46, leaving: 70 } as const;
/**
 * Word to word it hops: a short arc, a little taller in the air and a soft squash as it lands, timed to land
 * as the word begins. Further than HOP_REACH (a block far down the page) it flies on its spring instead,
 * with an upward kick so even a flight leaves with a little leap.
 */
const HOP_REACH = 150;
/** A firm, critically damped spring carries it along the line, so the glide never stops and starts. */
const GLIDE = { k: 520, damping: 1 };
const hopTime = (d: number) => Math.min(0.24, Math.max(0.13, 0.12 + d / 1600));
const hopHeight = (d: number) => Math.min(7, Math.max(3.5, 3.5 + d * 0.04));
/** A lift that's still rising (less than this far through) is let finish rather than restarted. */
const HOP_RESTART = 0.6;
const LAND_SQUASH = 0.2;
const LAND_FOR = 0.14;
const kick = (d: number) => Math.min(320, 120 + Math.max(0, d - 160) * 0.4);
type Hop = { start: number; time: number; height: number };
let hop: Hop | null = null;
let landedAt = -1;
let lastWordAt = -1;
/** Until when it is flying (a far word, a line wrap) on the looser spring, rather than gliding. */
let flyingUntil = -1;
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
  if (leaving) return { x: body!.head.x, y: sc.y + innerHeight + 40 };
  let p: Point | null = null;
  if (target instanceof Range) {
    const r = target.getClientRects()[0] ?? target.getBoundingClientRect();
    const host = target.startContainer.parentElement;
    if (r && (r.width || r.height) && target.startContainer.isConnected) {
      const margin = marginX(host);
      const gap = lineGap(target, r.height);
      fit = Math.min(R_TRACK, Math.max(3, gap + 1));
      const above = { x: r.left + r.width / 2, y: r.top - gap - 1 };
      if (r.bottom < 0 || r.top > innerHeight) {
        // Out of view: wait at that edge, in the margin (or over the column's start on a narrow screen), on
        // screen. It doesn't follow each word along the edge; it keeps watch until the reading scrolls back.
        parked = true;
        const y = r.bottom < 0 ? EDGE + R_FLOAT : innerHeight - EDGE - R_FLOAT;
        p = { x: margin ?? EDGE + R_FLOAT, y };
      } else if (floating() && margin !== null) {
        // Paused or waiting: step out into the margin beside the line.
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
  if (!p) return lastSpot ?? { ...body!.head };
  if (floating()) {
    const bob = prefersStill() ? 0 : Math.min(1, Math.max(0, (DOZE_AFTER + DOZE_EASE - floated) / DOZE_EASE));
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
  if (parked) body.shift(sc.x - lastScroll.x, sc.y - lastScroll.y);
  lastScroll = sc;
  const goal = spot();
  floated = floating() ? floated + dt : 0;
  const size = floating() && !cramped ? R_FLOAT : fit;
  const still = prefersStill();
  if (hop && (still || leaving || floating())) hop = null;
  // Along the line it glides on a firm spring; far words and line wraps are flights on a looser one.
  const gliding = mood === "tracking" && !floating() && !leaving && clock >= flyingUntil;
  if (gliding) body.step(dt, goal, GLIDE.k, size, still, GLIDE.damping);
  else body.step(dt, goal, SPRING[leaving ? "leaving" : parked ? "waiting" : mood], size, still);
  // The hop is a lift on top of the glide: up and down once per word, taller in the air, and a soft squash
  // as it comes down.
  // In the air it stretches along the way it is actually going (the glide and the lift together), so it
  // never stands up as an egg while it moves sideways; only the landing squash is upright.
  const before = body.lift;
  body.lift = 0;
  body.squash = 0;
  body.upright = false;
  if (hop) {
    const u = (clock - hop.start) / hop.time;
    if (u >= 1) {
      hop = null;
      landedAt = clock;
    } else body.lift = hop.height * Math.sin(Math.PI * u);
  }
  body.liftSpeed = (body.lift - before) / dt;
  if (!hop && !still) {
    const since = clock - landedAt;
    if (landedAt >= 0 && since < LAND_FOR) {
      body.squash = LAND_SQUASH * Math.sin(Math.PI * (since / LAND_FOR));
      body.upright = true;
    }
  }
  body.draw({ x: -sc.x, y: -sc.y }, clock);
  // Gone under the tray: stop.
  if (leaving && body.head.y - sc.y > innerHeight + 30) return finishLeaving();
  const bobbing = floating() && !still && floated <= DOZE_AFTER + DOZE_EASE;
  const landing = clock - landedAt < LAND_FOR;
  if (hop || landing || leaving || bobbing || !body.settled(goal, size)) raf = requestAnimationFrame(frame);
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
    body.place({ x: viewWidth() / 2 + lastScroll.x, y: innerHeight + 24 + lastScroll.y }, { x: 0, y: -380 });
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
  // A new word: hop to it, or fly if it's far or on the next line (not while it waits at the edge).
  if (to instanceof Range && before !== to && mood === "tracking" && !parked && !prefersStill()) {
    const r = to.getBoundingClientRect();
    if (r.bottom >= 0 && r.top <= innerHeight) {
      const dx = r.left + r.width / 2 + scrollX - body.head.x;
      const dy = r.top + scrollY - body.head.y;
      const d = Math.hypot(dx, dy);
      const interval = lastWordAt >= 0 ? clock - lastWordAt : 0.3;
      lastWordAt = clock;
      const wrap = dy > r.height * 0.6 && dx < -120;
      if (d >= HOP_REACH || wrap) {
        // A flight: a little leap as it leaves, then the looser spring.
        hop = null;
        flyingUntil = clock + 0.45;
        body.vel.y -= kick(d);
      } else if (d > 1 && (!hop || (clock - hop.start) / hop.time >= HOP_RESTART)) {
        // Timed and sized to the speech: fast reading gets a faint ripple, slow reading a full hop.
        const time = Math.min(hopTime(d), Math.max(0.09, 0.8 * interval));
        hop = { start: clock, time, height: hopHeight(d) * Math.min(1, interval / 0.28) };
      }
    }
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

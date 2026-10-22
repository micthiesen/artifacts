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
//   and grows a little when it floats.
// - If the word being read is scrolled out of view, the wisp waits at the edge of the screen nearest to it,
//   peeking, so you can see where the reading is.
// - Reduced motion: no flight, hop, bob or tail. It sits on its spot, appears when Listen starts and goes
//   when it closes.
//
// How it's drawn. One fixed, full-screen canvas that ignores the pointer, painted only while something is
// moving: the loop stops when the wisp has settled and starts again on the next word, scroll or state.
// The shape is a tapered run of discs along the tail (one filled path, so it reads as a single soft body)
// with a small radial glow under the head (the ghost's halo, the one kind of gradient the look allows).

type Point = { x: number; y: number };
export type WispMood = "tracking" | "resting" | "waiting";

/** Head radius (css px) while tracking words, and while floating. */
const R_TRACK = 4.6;
const R_FLOAT = 6.2;
/** Points in the tail, and how quickly each catches the one before it (per second): lower is a longer, lazier tail. */
const TAIL = 18;
const TAIL_FOLLOW = 15;
/** The spring toward the wisp's spot: stiffness (per s²) by what it's doing, and how much of critical damping. */
const SPRING = { tracking: 210, resting: 38, waiting: 46, leaving: 70 } as const;
const DAMPING = 0.72;
/**
 * The upward kick a new word gives it (px/s), by how far away the word is: the next word on the line gets a
 * skip that stays in the gap between lines, a word on another line or further off a real leap.
 */
const kick = (d: number) => (d < 160 ? Math.min(120, 40 + d * 0.5) : Math.min(320, 120 + (d - 160) * 0.4));
/** It never flies faster than this (px/s), so a long jump down the page is a flight, not a teleport. */
const MAX_SPEED = 2600;
/** How far above its word or block it floats when not tracking (px), and the bob around that spot. */
const FLOAT_LIFT = 18;
const BOB = { x: 2.2, y: 3.2, speed: 2.1 };
/** Kept this far inside the edges, so a word scrolled out of view leaves the wisp peeking from the nearest edge. */
const EDGE = 14;

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let glow: HTMLCanvasElement | null = null;
let colour = "#f6f2ea";
let ink = "#13161d";
let dpr = 1;

let present = false;
let leaving = false;
let mood: WispMood = "waiting";
let target: Range | Element | null = null;
let head: Point = { x: 0, y: 0 };
let vel: Point = { x: 0, y: 0 };
let tail: Point[] = [];
let radius = R_FLOAT;
let raf = 0;
let last = 0;
let clock = 0;

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A theme colour as the canvas understands it, or the fallback when the canvas can't parse it. */
function themeColour(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!ctx || !value) return fallback;
  ctx.fillStyle = fallback;
  ctx.fillStyle = value;
  return ctx.fillStyle as string;
}

function ensureCanvas() {
  if (canvas?.isConnected) return;
  canvas = document.createElement("canvas");
  canvas.className = "art-wisp";
  canvas.setAttribute("aria-hidden", "true");
  document.body.append(canvas);
  ctx = canvas.getContext("2d");
  colour = themeColour("--foreground", colour);
  ink = themeColour("--background", ink);
  // The halo under the head, drawn once.
  glow = document.createElement("canvas");
  glow.width = glow.height = 64;
  const g = glow.getContext("2d");
  if (g) {
    g.fillStyle = colour;
    g.fillRect(0, 0, 64, 64);
    g.globalCompositeOperation = "destination-in";
    const light = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    light.addColorStop(0, "rgba(0,0,0,0.3)");
    light.addColorStop(0.45, "rgba(0,0,0,0.09)");
    light.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = light;
    g.fillRect(0, 0, 64, 64);
  }
  resize();
}

function resize() {
  if (!canvas) return;
  dpr = Math.min(3, devicePixelRatio || 1);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  wake();
}
addEventListener("resize", () => canvas && resize());
// The page scrolling moves its words under the wisp: let it catch up.
addEventListener("scroll", () => present && wake(), { capture: true, passive: true });

/** Where the wisp wants to be: over its word (in the gap above the line), or floating above its block. */
function spot(): Point {
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
    // Not pointing at a word: float a little above the spot, bobbing.
    const still = reduced();
    p = {
      x: p.x + (still ? 0 : Math.sin(clock * BOB.speed * 0.5) * BOB.x),
      y: p.y - FLOAT_LIFT + (still ? 0 : Math.sin(clock * BOB.speed) * BOB.y),
    };
  }
  return { x: Math.min(innerWidth - EDGE, Math.max(EDGE, p.x)), y: Math.min(innerHeight - EDGE, Math.max(EDGE, p.y)) };
}

const floating = () => mood !== "tracking" || !(target instanceof Range);

function wake() {
  if (!present || raf) return;
  last = performance.now();
  raf = requestAnimationFrame(frame);
}

function frame(now: number) {
  raf = 0;
  const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
  last = now;
  clock += dt;
  const goal = spot();
  const still = reduced();
  if (still) {
    head = goal;
    vel = { x: 0, y: 0 };
    tail = tail.map(() => ({ ...goal }));
  } else {
    // A damped spring toward the goal.
    const k = SPRING[leaving ? "leaving" : mood];
    const c = 2 * Math.sqrt(k) * DAMPING;
    vel.x += (k * (goal.x - head.x) - c * vel.x) * dt;
    vel.y += (k * (goal.y - head.y) - c * vel.y) * dt;
    const speed = Math.hypot(vel.x, vel.y);
    if (speed > MAX_SPEED) {
      vel.x *= MAX_SPEED / speed;
      vel.y *= MAX_SPEED / speed;
    }
    head = { x: head.x + vel.x * dt, y: head.y + vel.y * dt };
    // Each tail point chases the one before it.
    const follow = 1 - Math.exp(-TAIL_FOLLOW * dt);
    let lead = head;
    tail = tail.map((p) => {
      const q = { x: p.x + (lead.x - p.x) * follow, y: p.y + (lead.y - p.y) * follow };
      lead = q;
      return q;
    });
  }
  const want = floating() ? R_FLOAT : R_TRACK;
  radius = still ? want : radius + (want - radius) * (1 - Math.exp(-8 * dt));
  draw();
  // Gone under the tray: stop and clear.
  if (leaving && head.y > innerHeight + 30) return finishLeaving();
  const settled =
    Math.hypot(vel.x, vel.y) < 2 &&
    Math.hypot(goal.x - head.x, goal.y - head.y) < 0.3 &&
    tail.every((p) => Math.hypot(p.x - head.x, p.y - head.y) < 0.3) &&
    Math.abs(want - radius) < 0.05;
  // It bobs for as long as it floats; tracking rests (and the loop stops) once it has landed.
  if (!settled || (floating() && !still) || leaving) raf = requestAnimationFrame(frame);
}

function draw() {
  if (!ctx || !canvas) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // The halo.
  if (glow) {
    const g = radius * 5.5;
    ctx.drawImage(glow, head.x - g, head.y - g, g * 2, g * 2);
  }
  // The tail: tapering discs along the chain, close enough together to read as one body.
  const body = new Path2D();
  let prev = head;
  for (let i = 0; i < tail.length; i++) {
    const p = tail[i]!;
    const r = radius * 0.92 * (1 - (i + 1) / (tail.length + 1)) ** 1.15;
    const d = Math.hypot(p.x - prev.x, p.y - prev.y);
    const steps = Math.min(40, Math.max(1, Math.ceil(d / Math.max(0.6, r * 0.45))));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = prev.x + (p.x - prev.x) * t;
      const y = prev.y + (p.y - prev.y) * t;
      body.moveTo(x + r, y);
      body.arc(x, y, r, 0, Math.PI * 2);
    }
    prev = p;
  }
  ctx.fillStyle = colour;
  ctx.globalAlpha = 0.82;
  ctx.fill(body);
  // The head: stretched along its flight, squashed across it.
  const speed = Math.hypot(vel.x, vel.y);
  const stretch = 1 + Math.min(0.38, speed / 1400);
  ctx.globalAlpha = 1;
  ctx.save();
  ctx.translate(head.x, head.y);
  ctx.rotate(Math.atan2(vel.y, vel.x));
  ctx.scale(stretch, 1 / stretch);
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Still enough to see its face: the logo's happy closed eyes.
  const calm = Math.max(0, 1 - speed / 70);
  if (calm > 0.05 && radius > 4) {
    ctx.save();
    ctx.translate(head.x, head.y);
    ctx.globalAlpha = calm * 0.85;
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(0.8, radius * 0.17);
    ctx.lineCap = "round";
    const e = radius * 0.36;
    const er = radius * 0.2;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(side * e, radius * 0.06, er, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function finishLeaving() {
  present = false;
  leaving = false;
  target = null;
  cancelAnimationFrame(raf);
  raf = 0;
  if (ctx && canvas) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

/** Listen started: the wisp rises out from under the tray, toward wherever the reading is. */
export function wispArrive() {
  ensureCanvas();
  if (present && !leaving) return;
  if (!present) {
    const start = { x: innerWidth / 2, y: innerHeight + 24 };
    head = start;
    vel = { x: 0, y: -520 };
    tail = Array.from({ length: TAIL }, () => ({ ...start }));
    radius = R_FLOAT;
    mood = "waiting";
    target = null;
  }
  present = true;
  leaving = false;
  wake();
}

/** Listen closed: the wisp dives back down under the tray (or, with reduced motion, simply goes). */
export function wispLeave() {
  if (!present) return;
  if (reduced()) return finishLeaving();
  leaving = true;
  // A little hop up before it dives.
  vel.y = Math.min(vel.y, -160);
  wake();
}

/** What the wisp follows: the word being spoken (a Range), or a block with no words of its own (an Element). */
export function wispFollow(to: Range | Element) {
  if (!present || leaving) return;
  const before = target;
  target = to;
  // A new word: a hop up, bigger for a longer way to go.
  if (to instanceof Range && before !== to && mood === "tracking" && !reduced()) {
    const r = to.getBoundingClientRect();
    const d = Math.hypot(r.left + r.width / 2 - head.x, r.top - head.y);
    vel.y -= kick(d);
  }
  wake();
}

/** Tracking words while the voice speaks; resting (floating) when paused or done; waiting while the voice catches up. */
export function wispMood(m: WispMood) {
  if (mood === m) return;
  mood = m;
  wake();
}

// Measures how smoothly the wisp moves, offline. It lays out paragraphs of words like an artifact page, reads
// them at a given speed (word timings, sentence pauses, waits for the voice, a tap to another paragraph, a
// pause and resume), drives the real pilot (src/shared/wisp-pilot.ts) frame by frame exactly as the page
// does, and scores the path the wisp is drawn along:
//
//   jolts      frames where acceleration breaks from its own trend (a snap: the motion isn't continuous)
//   kicks      the same, upward (the "jolts up")
//   straight   frames moving almost straight up while travelling to a word across the line
//   swerve     frames where it reverses direction mid-air without stopping (the "goes left before right")
//   late       how far from its word it still is just after the word is heard (p95, px)
//   hops       word-hop heights (should read as hops: roughly 2.5 to 8 px)
//   overshoot  frames past the word it's landing on
//
// Usage: bun spikes/wisp-sim.ts [--rate 1|2] [--fps 60|120] [--png /tmp/wisp.png] [--seed n]
import { deflateSync } from "node:zlib";
import { WispPilot } from "../src/shared/wisp-pilot.ts";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};
const RATE = Number(opt("rate", "1"));
const FPS = Number(opt("fps", "120"));
const PNG = opt("png", "");
let seed = Number(opt("seed", "7"));
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

// ---- a page ----------------------------------------------------------------------------
const COL = { left: 40, width: 640 };
const LINE = 28;
const GAP = 4.5; // half the leading above a line: where the wisp rides
type Word = { x: number; y: number; w: number; line: number; para: number; sentenceEnd: boolean };
const words: Word[] = [];
function paragraph(para: number, top: number, sentences: number): number {
  let x = COL.left;
  let line = 0;
  for (let s = 0; s < sentences; s++) {
    const n = 8 + Math.floor(rand() * 12);
    for (let k = 0; k < n; k++) {
      const w = (2 + Math.floor(rand() * 9)) * 8.5;
      if (x + w > COL.left + COL.width) {
        x = COL.left;
        line++;
      }
      words.push({ x, y: top + line * LINE, w, line, para, sentenceEnd: k === n - 1 });
      x += w + 4.5;
    }
  }
  return top + (line + 1) * LINE;
}
let top = 60;
for (let p = 0; p < 4; p++) top = paragraph(p, top, 3 + Math.floor(rand() * 3)) + 24;
const spotOf = (w: Word) => ({ x: w.x + w.w / 2, y: w.y - GAP - 1 });

// ---- a reading -------------------------------------------------------------------------
type Event = { t: number; kind: "word" | "block"; i: number } | { t: number; kind: "pause" | "resume" | "wait" | "go" };
const events: Event[] = [];
const heardAt = new Map<number, number>();
/** How early words are handed to the wisp (the page's WISP_LEAD, real seconds). */
const LEAD = Number(opt("lead", "0.15"));
let t = 0.5;
let lastDur = 0.3;
const tapAt = Math.floor(words.length * 0.35);
const tapTo = Math.floor(words.length * 0.7);
const pauseAt = Math.floor(words.length * 0.55);
for (let i = 0; i < words.length; i++) {
  if (i === tapAt) {
    // A tap to a later paragraph: the block changes at once (the wisp sets off for its first word, as the page
    // does), and the voice takes a moment to start there.
    events.push({ t, kind: "wait" });
    events.push({ t, kind: "block", i: tapTo });
    t += 0.6;
    events.push({ t, kind: "go" });
    i = tapTo;
  }
  if (i === pauseAt) {
    events.push({ t, kind: "pause" });
    t += 2.5;
    events.push({ t, kind: "resume" });
  }
  // Words reach the wisp a little before they're heard (the page's lead: WISP_LEAD, but never more than half
  // the word before, so it never leaves a word before it's spoken); scored against when they're heard.
  events.push({ t: t - Math.min(LEAD, 0.5 * lastDur), kind: "word", i });
  heardAt.set(i, t);
  const w = words[i]!;
  lastDur = (0.16 + 0.012 * (w.w / 8.5)) / RATE;
  t += lastDur;
  if (w.sentenceEnd) {
    t += 0.25 / RATE;
    // Sometimes the next sentence isn't ready yet.
    if (rand() < 0.3) {
      events.push({ t, kind: "wait" });
      t += 0.3 + rand() * 0.5;
      events.push({ t, kind: "go" });
    }
  }
}
const END = t + 0.6;
events.sort((a, b) => a.t - b.t);

// ---- drive the pilot as the page does ----------------------------------------------------------
const pilot = new WispPilot();
const dt = 1 / FPS;
let mood: "tracking" | "waiting" | "resting" = "waiting";
let current = 0;
pilot.place(spotOf(words[0]!));
const SPRING = { tracking: 520, waiting: 46, resting: 38 };
type Frame = { t: number; x: number; y: number; vx: number; vy: number; goal: { x: number; y: number }; word: number; mood: string; moving: boolean; segAge: number };
const frames: Frame[] = [];
const wordTimes: { t: number; i: number }[] = [];
let e = 0;
for (let clock = 0; clock < END; clock += dt) {
  while (e < events.length && events[e]!.t <= clock) {
    const ev = events[e++]!;
    if (ev.kind === "block") current = ev.i;
    else if (ev.kind === "word") {
      current = ev.i;
      mood = "tracking";
      wordTimes.push({ t: heardAt.get(ev.i) ?? ev.t, i: ev.i });
      pilot.word(spotOf(words[ev.i]!), LINE);
    } else if (ev.kind === "pause") mood = "resting";
    else if (ev.kind === "resume" || ev.kind === "go") mood = "tracking";
    else mood = "waiting";
  }
  const w = words[current]!;
  // Paused: out in the margin beside the line, bobbing. Waiting: hovering over its word.
  let goal = spotOf(w);
  if (mood === "resting") goal = { x: COL.left - 15 + Math.sin(clock * 1.05) * 2.2, y: w.y + 10 + Math.sin(clock * 2.1) * 3.2 };
  else if (mood === "waiting") goal = { x: goal.x, y: goal.y + Math.sin(clock * 2.1) * 1.1 };
  pilot.frame(dt, goal);
  const m = pilot.motion;
  frames.push({ t: clock, x: m.pos.x, y: m.pos.y, vx: m.vel.x, vy: m.vel.y, goal, word: current, mood, moving: m.moving, segAge: m.seg ? +(m.clock - m.seg.t0).toFixed(3) : -1 });
}

if (args.includes("--peek")) {
  const from = Number(opt("peek", "0"));
  for (const f of frames.filter((f) => f.t >= from && f.t < from + 0.5).filter((_, k) => k % 6 === 0)) console.log(JSON.stringify({ t: +f.t.toFixed(3), x: +f.x.toFixed(1), y: +f.y.toFixed(1), gx: +f.goal.x.toFixed(1), gy: +f.goal.y.toFixed(1), mood: f.mood, moving: f.moving, age: f.segAge, word: f.word }));
  console.log(JSON.stringify(events.filter((e) => e.t > from - 3 && e.t < from + 0.5).map((e) => ({ ...e, t: +e.t.toFixed(2) }))));
}
// ---- score -----------------------------------------------------------------------------------
// A jolt is a snap: in one frame the acceleration changes far more than it does in the frames either side
// (a smooth path's acceleration changes steadily, even as a hop takes off). JOLT is the floor (px/s²) under
// which a change is too small to see.
const JOLT = 1500;
let jolts = 0;
const joltFrames: number[] = [];
let kicks = 0;
let straight = 0;
let backtrack = 0;
let overshoot = 0;
let maxAccel = 0;
for (let i = 2; i < frames.length; i++) {
  const f = frames[i]!;
  const p = frames[i - 1]!;
  const ax = (f.vx - p.vx) / dt;
  const ay = (f.vy - p.vy) / dt;
  const a = Math.hypot(ax, ay);
  maxAccel = Math.max(maxAccel, a);
  if (i >= 3 && i + 1 < frames.length) {
    const acc = (k: number) => ({ x: (frames[k]!.vx - frames[k - 1]!.vx) / dt, y: (frames[k]!.vy - frames[k - 1]!.vy) / dt });
    const da = (k: number) => {
      const a1 = acc(k);
      const a0 = acc(k - 1);
      return { x: a1.x - a0.x, y: a1.y - a0.y };
    };
    const here = da(i);
    const size = Math.hypot(here.x, here.y);
    const around = Math.max(Math.hypot(da(i - 1).x, da(i - 1).y), Math.hypot(da(i + 1).x, da(i + 1).y));
    if (size > JOLT && size > 2.5 * around) {
      jolts++;
      joltFrames.push(i);
      if (-here.y > JOLT && -here.y > 2.5 * around) kicks++;
      if (args.includes("--debug") && jolts <= 8) console.log("jolt", JSON.stringify({ t: +f.t.toFixed(3), da: Math.round(size), around: Math.round(around), mood: f.mood, moving: f.moving, segAge: f.segAge, prevMoving: p.moving, x: +f.x.toFixed(1), gx: +f.goal.x.toFixed(1) }));
    }
  }
  if (f.mood !== "tracking") continue;
  const speed = Math.hypot(f.vx, f.vy);
  const sameLine = Math.abs(f.goal.y - f.y) < LINE * 0.4;
  const towardRight = f.goal.x - f.x > 2;
  const towardLeft = f.goal.x - f.x < -2;
  if (speed > 40 && f.vy < 0 && Math.abs(f.vy) > 2.5 * Math.abs(f.vx) && Math.abs(f.goal.x - f.x) > 20) straight++;
  // A swerve: horizontal direction flips from one frame to the next while it's moving fast both sides (it
  // turned in mid-air; landing and then hopping the other way passes through rest and isn't one).
  // (Turning back at the end of a line for the next one is the line return, not a swerve.)
  if (sameLine && Math.sign(f.vx) !== Math.sign(p.vx) && Math.abs(f.vx) > 60 && Math.abs(p.vx) > 60) backtrack++;
  // Past its word and still moving away from it (it went too far and has to come back).
  if (sameLine && Math.abs(f.x - f.goal.x) > 1.5 && Math.sign(f.x - f.goal.x) === Math.sign(f.vx) && Math.abs(f.vx) > 10) overshoot++;
}
// Late: how far from each word the wisp is just after that word is heard (is it on the word being spoken?).
// The first word after a tap, a pause, a wait or a new line is a flight or a sweep and is left out.
const late: { d: number; i: number; t: number }[] = [];
for (let k = 1; k < wordTimes.length; k++) {
  const w = wordTimes[k]!;
  const prev = wordTimes[k - 1]!;
  if (w.i !== prev.i + 1 || words[w.i]!.line !== words[prev.i]!.line || words[w.i]!.para !== words[prev.i]!.para) continue;
  if (events.some((ev) => ev.kind !== "word" && ev.t > prev.t - 0.3 && ev.t <= w.t)) continue;
  const at = frames.find((f) => f.t >= w.t + 0.05);
  const g = spotOf(words[w.i]!);
  if (at && at.mood === "tracking") late.push({ d: Math.hypot(g.x - at.x, g.y - at.y), i: w.i, t: w.t });
}
late.sort((a, b) => a.d - b.d);
if (args.includes("--debug")) {
  console.log("worst late", JSON.stringify(late.slice(-4).map((l) => ({ ...l, d: +l.d.toFixed(1) }))));
  const sw = frames.filter((f, i) => i > 0 && f.mood === "tracking" && Math.abs(f.goal.y - f.y) < LINE * 0.4 && Math.sign(f.vx) !== Math.sign(frames[i - 1]!.vx) && Math.abs(f.vx) > 25 && Math.abs(frames[i - 1]!.vx) > 25);
  console.log("swerve sample", JSON.stringify(sw.slice(0, 5).map((f) => ({ t: +f.t.toFixed(3), x: +f.x.toFixed(1), gx: +f.goal.x.toFixed(1), vx: +f.vx.toFixed(0), moving: f.moving, word: f.word, mood: f.mood }))));
}
const p95 = late[Math.floor(late.length * 0.95)]?.d ?? 0;
// Hop heights: how far each word-to-word hop on a line bows up above the straight line from where it took
// off to its word (so the tail end of a line return, still coming down, isn't counted as a hop).
const heights: number[] = [];
for (let i = 1; i < wordTimes.length; i++) {
  const a = words[wordTimes[i - 1]!.i]!;
  const b = words[wordTimes[i]!.i]!;
  if (a.line !== b.line || a.para !== b.para) continue;
  const span = frames.filter((f) => f.t >= wordTimes[i]!.t && f.t < (wordTimes[i + 1]?.t ?? END));
  if (span.length < 2) continue;
  const s0 = span[0]!;
  const g = spotOf(b);
  let h = 0;
  for (const f of span) {
    const along = g.x === s0.x ? 1 : Math.min(1, Math.max(0, (f.x - s0.x) / (g.x - s0.x)));
    h = Math.max(h, s0.y + (g.y - s0.y) * along - f.y);
  }
  heights.push(h);
  if (args.includes("--debug") && h > 8.5) console.log("tall hop", JSON.stringify({ t: +wordTimes[i]!.t.toFixed(2), h: +h.toFixed(1), from: wordTimes[i - 1]!.i, to: wordTimes[i]!.i }));
}
if (args.includes("--debug")) {
  const over = frames.filter((f) => f.mood === "tracking" && Math.abs(f.goal.y - f.y) < LINE * 0.4 && Math.abs(f.x - f.goal.x) > 1.5 && Math.sign(f.x - f.goal.x) === Math.sign(f.vx) && Math.abs(f.vx) > 10);
  console.log("overshoot sample", JSON.stringify(over.slice(0, 4).map((f) => ({ t: +f.t.toFixed(3), x: +f.x.toFixed(1), gx: +f.goal.x.toFixed(1), vx: +f.vx.toFixed(0), word: f.word, moving: f.moving }))));
  let worst = 0;
  let at = 0;
  for (let i = 2; i < frames.length; i++) {
    const a = Math.hypot((frames[i]!.vx - frames[i - 1]!.vx) / dt, (frames[i]!.vy - frames[i - 1]!.vy) / dt);
    if (a > worst) {
      worst = a;
      at = i;
    }
  }
  const f = frames[at]!;
  console.log("max accel at", JSON.stringify({ t: +f.t.toFixed(3), a: Math.round(worst), mood: f.mood, moving: f.moving, segAge: f.segAge, x: +f.x.toFixed(0), y: +f.y.toFixed(0), gx: +f.goal.x.toFixed(0), gy: +f.goal.y.toFixed(0), prevMood: frames[at - 1]!.mood }));
}
heights.sort((a, b) => a - b);
const hopMedian = heights[Math.floor(heights.length / 2)] ?? 0;
const hopsOut = heights.filter((h) => h > 8.5).length;

const penalty = jolts * 2 + kicks * 4 + straight * 1 + backtrack * 2 + overshoot * 0.5 + Math.max(0, p95 - 6 * RATE) * 2 + hopsOut * 2 + (hopMedian < 2 ? 10 : 0);
const score = Math.max(0, 100 - penalty);
console.log(
  JSON.stringify({ rate: RATE, fps: FPS, frames: frames.length, words: wordTimes.length, jolts, kicks, straight, swerve: backtrack, overshoot, lateP95: +p95.toFixed(2), hopMedian: +hopMedian.toFixed(2), hopMax: +(heights.at(-1) ?? 0).toFixed(2), hopsOver8: hopsOut, maxAccel: Math.round(maxAccel), score: +score.toFixed(1) }),
);

// ---- picture -----------------------------------------------------------------------------------
if (PNG) {
  // The first paragraph (and the start of the tap's flight): words as grey boxes, the path in white, a red
  // dot on jolt frames.
  const W = 760;
  const H = 260;
  const S = 2;
  const img = new Uint8Array(W * S * H * S * 4);
  const put = (x: number, y: number, r: number, g: number, b: number) => {
    const px = Math.round(x * S);
    const py = Math.round(y * S);
    if (px < 0 || py < 0 || px >= W * S || py >= H * S) return;
    const o = (py * W * S + px) * 4;
    img[o] = r;
    img[o + 1] = g;
    img[o + 2] = b;
    img[o + 3] = 255;
  };
  for (let i = 0; i < img.length; i += 4) img.set([20, 22, 30, 255], i);
  for (const w of words.filter((w) => w.y < H)) for (let x = w.x; x < w.x + w.w; x += 0.5) for (let y = w.y; y < w.y + 16; y += 0.5) put(x, y, 70, 74, 90);
  for (const f of frames) if (f.y < H) put(f.x, f.y, 240, 236, 225);
  for (const j of joltFrames) {
    const f = frames[j]!;
    if (f.y < H) for (let k = -1.5; k <= 1.5; k += 0.5) for (let q = -1.5; q <= 1.5; q += 0.5) put(f.x + k, f.y + q, 255, 80, 80);
  }
  const raw = new Uint8Array((W * S * 4 + 1) * H * S);
  for (let y = 0; y < H * S; y++) raw.set(img.subarray(y * W * S * 4, (y + 1) * W * S * 4), y * (W * S * 4 + 1) + 1);
  const crc = (buf: Uint8Array) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, W * S);
  hv.setUint32(4, H * S);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
  await Bun.write(PNG, png);
}

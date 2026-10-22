import { expect, test } from "bun:test";
import { NavGrid, PathFollower, rectDistance, type Point, type Rect } from "../src/shared/wisp-nav.ts";

const BOUNDS: Rect = { left: 0, top: 0, right: 800, bottom: 600 };
const HARD = 9;

/** A small seeded random source, so a failing layout can be reproduced. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const nearest = (solid: Rect[], p: Point) => Math.min(...solid.map((r) => rectDistance(r, p)));

test("a route goes round a wall, never through it, and keeps its distance", () => {
  const wall: Rect = { left: 380, top: 0, right: 420, bottom: 480 };
  const grid = new NavGrid(BOUNDS, [wall]);
  const path = grid.path({ x: 100, y: 100 }, { x: 700, y: 100 }, HARD)!;
  expect(path).not.toBeNull();
  // Round the bottom of the wall: somewhere it dips below it.
  expect(Math.max(...path.map((p) => p.y))).toBeGreaterThan(480);
  for (const p of path) expect(rectDistance(wall, p)).toBeGreaterThanOrEqual(HARD);
  expect(path[0]).toEqual({ x: 100, y: 100 });
  expect(path.at(-1)).toEqual({ x: 700, y: 100 });
});

test("no route into a closed room", () => {
  const room: Rect[] = [
    { left: 300, top: 200, right: 500, bottom: 210 },
    { left: 300, top: 390, right: 500, bottom: 400 },
    { left: 300, top: 200, right: 310, bottom: 400 },
    { left: 490, top: 200, right: 500, bottom: 400 },
  ];
  const grid = new NavGrid(BOUNDS, room);
  expect(grid.route({ x: 50, y: 50 }, { x: 400, y: 300 })).toBeNull();
});

test("a gap too narrow for its body is not a way through", () => {
  // Two blocks 20 px apart: less than twice the clearance.
  const solid: Rect[] = [
    { left: 0, top: 280, right: 390, bottom: 320 },
    { left: 410, top: 280, right: 800, bottom: 320 },
  ];
  const grid = new NavGrid(BOUNDS, solid);
  expect(grid.route({ x: 400, y: 100 }, { x: 400, y: 500 })).toBeNull();
});

test("it would rather go round a soft thing than across it, but will cross when there's no other way", () => {
  const rule: Rect = { left: 0, top: 299, right: 260, bottom: 301 };
  const round = new NavGrid(BOUNDS, [], { soft: [rule] }).path({ x: 200, y: 200 }, { x: 200, y: 400 }, HARD)!;
  expect(Math.max(...round.map((p) => p.x))).toBeGreaterThan(260);
  const full = { ...rule, right: 800 };
  const across = new NavGrid(BOUNDS, [], { soft: [full] }).path({ x: 200, y: 200 }, { x: 200, y: 400 }, HARD)!;
  expect(across).not.toBeNull();
});

test("running from the pointer, it keeps away from it", () => {
  const grid = new NavGrid(BOUNDS, []);
  const pointer = { x: 400, y: 300 };
  const path = grid.path({ x: 250, y: 300 }, { x: 600, y: 300 }, HARD, { p: pointer, r: 120 })!;
  expect(path).not.toBeNull();
  for (const p of path.slice(8)) expect(Math.hypot(p.x - pointer.x, p.y - pointer.y)).toBeGreaterThan(100);
});

test("with the pointer right on top of it, it can still get away, and only ever moves away while close", () => {
  const grid = new NavGrid(BOUNDS, [{ left: 0, top: 200, right: 800, bottom: 260 }]);
  const pointer = { x: 400, y: 330 };
  const path = grid.path({ x: 402, y: 332 }, { x: 700, y: 500 }, HARD, { p: pointer, r: 140 })!;
  expect(path).not.toBeNull();
  let was = 0;
  for (const p of path) {
    const d = Math.hypot(p.x - pointer.x, p.y - pointer.y);
    if (was < 120) expect(d).toBeGreaterThanOrEqual(was - 4);
    was = d;
  }
});

test("on random pages every path it takes keeps clear of everything", () => {
  const random = rng(7);
  let planned = 0;
  for (let page = 0; page < 60; page++) {
    const solid: Rect[] = Array.from({ length: 6 + Math.floor(random() * 18) }, () => {
      const w = 20 + random() * 260;
      const h = 8 + random() * 120;
      const left = random() * (800 - w);
      const top = random() * (600 - h);
      return { left, top, right: left + w, bottom: top + h };
    });
    const grid = new NavGrid(BOUNDS, solid);
    for (let k = 0; k < 6; k++) {
      const a = grid.nearestOpen({ x: random() * 800, y: random() * 600 });
      const b = grid.nearestOpen({ x: random() * 800, y: random() * 600 });
      if (!a || !b) continue;
      const path = grid.path(a, b, HARD);
      if (!path) continue;
      planned++;
      for (const p of path) expect(nearest(solid, p)).toBeGreaterThanOrEqual(HARD - 0.01);
      // No jumps: consecutive points are close together.
      for (let i = 1; i < path.length; i++) expect(Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y)).toBeLessThan(6);
    }
  }
  expect(planned).toBeGreaterThan(150);
});

test("an open cell really is clear by the clearance", () => {
  const random = rng(3);
  const solid: Rect[] = Array.from({ length: 20 }, () => {
    const left = random() * 700;
    const top = random() * 500;
    return { left, top, right: left + random() * 100, bottom: top + random() * 60 };
  });
  const grid = new NavGrid(BOUNDS, solid, { clearance: 16 });
  for (let i = 0; i < 4000; i++) {
    const p = { x: random() * 800, y: random() * 600 };
    // Cell centres are what routes pass through.
    const c = { x: (Math.floor(p.x / 8) + 0.5) * 8, y: (Math.floor(p.y / 8) + 0.5) * 8 };
    if (grid.open(c)) expect(nearest(solid, c)).toBeGreaterThanOrEqual(16);
  }
});

test("along a path it gathers speed, slows into a bend, and stops softly at the end", () => {
  // Straight on, a right-angle bend rounded off, straight on.
  const path: Point[] = [];
  for (let x = 0; x <= 300; x += 3) path.push({ x, y: 0 });
  for (let a = 0; a <= 90; a += 3) path.push({ x: 300 + 30 * Math.sin((a * Math.PI) / 180), y: 30 - 30 * Math.cos((a * Math.PI) / 180) });
  for (let y = 30; y <= 330; y += 3) path.push({ x: 330, y });
  const pace = { cruise: 400, accel: 1500, lateral: 1500 };
  const f = new PathFollower(path, pace);
  const dt = 1 / 120;
  let last = { x: 0, y: 0 };
  let lastSpeed = 0;
  const speeds: { s: number; v: number }[] = [];
  let lastAccel = 0;
  let maxAccelStep = 0;
  for (let t = 0; t < 5; t += dt) {
    const { pos, vel, done } = f.advance(dt);
    const v = Math.hypot(vel.x, vel.y);
    // Never faster than cruise, never a sudden change of speed.
    expect(v).toBeLessThanOrEqual(pace.cruise + 0.01);
    expect(Math.abs(v - lastSpeed)).toBeLessThan(pace.accel * dt * 1.6 + 1);
    // Always forward along the path, in small steps.
    expect(Math.hypot(pos.x - last.x, pos.y - last.y)).toBeLessThan(pace.cruise * dt + 0.5);
    speeds.push({ s: f.travelled, v });
    // Its speed changes smoothly too: no step in acceleration from one frame to the next (a jolt).
    const accel = (v - lastSpeed) / dt;
    if (speeds.length > 2) maxAccelStep = Math.max(maxAccelStep, Math.abs(accel - lastAccel));
    lastAccel = accel;
    last = pos;
    lastSpeed = v;
    if (done) break;
  }
  expect(f.travelled).toBeCloseTo(f.length, 1);
  expect(maxAccelStep).toBeLessThan(400);
  // Through the bend (radius 30) no faster than its sideways limit allows, give or take.
  const bend = speeds.filter((p) => p.s > 310 && p.s < 340);
  expect(Math.max(...bend.map((p) => p.v))).toBeLessThan(Math.sqrt(1500 * 30) * 1.25);
  // Up to cruise on the long straight.
  expect(Math.max(...speeds.map((p) => p.v))).toBeGreaterThan(pace.cruise * 0.95);
});

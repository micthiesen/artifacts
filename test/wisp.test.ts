import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());
const { WispBody } = await import("../src/shared/wisp-body.ts");

const run = (fps: number, seconds: number) => {
  const body = new WispBody("t", { light: "--x", ink: "--y" });
  body.place({ x: 0, y: 0 });
  const goal = { x: 300, y: -120 };
  let maxGap = 0;
  let maxSpeed = 0;
  for (let i = 0; i < fps * seconds; i++) {
    body.step(1 / fps, goal, 210, 6);
    let prev = body.head;
    for (const p of body.tail) {
      maxGap = Math.max(maxGap, Math.hypot(p.x - prev.x, p.y - prev.y));
      prev = p;
    }
    maxSpeed = Math.max(maxSpeed, Math.hypot(body.vel.x, body.vel.y));
  }
  const settled = body.settled(goal, 6);
  body.dispose();
  return { body, settled, maxGap, maxSpeed };
};

test("the wisp's spring lands it on its spot, the same at 60 and 120 frames a second", () => {
  for (const fps of [60, 120]) {
    const { body, settled } = run(fps, 3);
    expect(settled).toBe(true);
    expect(body.head.x).toBeCloseTo(300, 1);
    expect(body.head.y).toBeCloseTo(-120, 1);
    // Settled means gathered: the tail sits under the head.
    for (const p of body.tail) expect(Math.hypot(p.x - 300, p.y + 120)).toBeLessThan(0.01);
  }
});

test("its tail never stretches into a streak, and it never flies faster than its limit", () => {
  const { maxGap, maxSpeed } = run(60, 1);
  // Each link stays within a radius of the one before (TAIL_GAP), so a flight trails a teardrop.
  expect(maxGap).toBeLessThanOrEqual(6 * 0.85 + 1e-6);
  expect(maxSpeed).toBeLessThanOrEqual(2600 + 1e-6);
});

test("moving what it sits on moves all of it at once, so scrolling never sets its tail streaming", () => {
  const body = new WispBody("t", { light: "--x", ink: "--y" });
  body.place({ x: 10, y: 10 });
  body.shift(0, 500);
  expect(body.head).toEqual({ x: 10, y: 510 });
  for (const p of body.tail) expect(p).toEqual({ x: 10, y: 510 });
  expect(body.settled({ x: 10, y: 510 }, body.radius)).toBe(true);
  body.dispose();
});

test("gliding word to word it never backs up, even when the next word comes before it has landed", () => {
  const body = new WispBody("t", { light: "--x", ink: "--y" });
  body.place({ x: 0, y: 0 });
  // Words every 0.13 s (2x speech), 40 px apart, at 120 frames a second, on the glide spring (k 520, critically damped).
  let goal = 0;
  let lastX = 0;
  for (let frame = 0; frame < 240; frame++) {
    if (frame % 16 === 0) goal += 40;
    body.step(1 / 120, { x: goal, y: 0 }, 520, 5, false, 1);
    expect(body.head.x).toBeGreaterThanOrEqual(lastX - 1e-9);
    expect(body.head.x).toBeLessThanOrEqual(goal + 1e-9);
    lastX = body.head.x;
  }
  body.dispose();
});

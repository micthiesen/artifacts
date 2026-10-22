import { expect, test } from "bun:test";
import { WispPilot } from "../src/shared/wisp-pilot.ts";

// Reads a line of words at a given speed through the real pilot and returns every frame of the path.
function readLine(rate: number, fps: number) {
  const pilot = new WispPilot();
  const words = Array.from({ length: 14 }, (_, i) => ({ x: 60 + i * 52 + (i % 3) * 9, y: 100 }));
  pilot.place(words[0]!);
  const dt = 1 / fps;
  const path: { x: number; y: number; vx: number; vy: number }[] = [];
  let next = 1;
  let due = 0.3 / rate;
  for (let t = 0; t < 14 * (0.3 / rate) + 1; t += dt) {
    if (next < words.length && t >= due) {
      pilot.word(words[next]!, 28);
      next++;
      due += (0.22 + (next % 4) * 0.04) / rate;
    }
    pilot.frame(dt, words[Math.min(next - 1, words.length - 1)]!);
    const m = pilot.motion;
    path.push({ x: m.pos.x, y: m.pos.y, vx: m.vel.x, vy: m.vel.y });
  }
  return path;
}

for (const rate of [1, 2]) {
  for (const fps of [60, 120]) {
    test(`along a line at ${rate}x (${fps} fps) the wisp never turns back, kicks or jolts, and rises only in small hops`, () => {
      const path = readLine(rate, fps);
      const dt = 1 / fps;
      for (let i = 1; i < path.length; i++) {
        // Never moves back along the line (no swerve, no overshoot past a word and back).
        expect(path[i]!.x).toBeGreaterThanOrEqual(path[i - 1]!.x - 0.05);
        // Hops stay small: never more than a hop's height above the line.
        expect(path[i]!.y).toBeGreaterThan(100 - 12);
      }
      // Smooth: acceleration changes steadily, with no one-frame snap (what reads as a jolt).
      for (let i = 3; i + 1 < path.length; i++) {
        const acc = (k: number) => ({ x: (path[k]!.vx - path[k - 1]!.vx) / dt, y: (path[k]!.vy - path[k - 1]!.vy) / dt });
        const da = (k: number) => Math.hypot(acc(k).x - acc(k - 1).x, acc(k).y - acc(k - 1).y);
        const here = da(i);
        expect(here > 1500 && here > 2.5 * Math.max(da(i - 1), da(i + 1))).toBe(false);
      }
      // And it does hop: the path rises off the line between words.
      expect(Math.min(...path.map((p) => p.y))).toBeLessThan(100 - 1.5);
    });
  }
}

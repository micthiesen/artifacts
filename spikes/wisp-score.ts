// Scores a wisp trace recorded on a real page with the same measures as spikes/wisp-sim.ts. Record one in the
// artifact frame with `globalThis.__wispTrace = []` while Listen reads, then save the array as JSON.
// Each entry: { t (ms), x, y, gx, gy (page px), mood, parked }.
//
// Usage: bun spikes/wisp-score.ts trace.json [more.json ...]
type Row = { t: number; x: number; y: number; gx: number; gy: number; mood: string; parked: boolean };

const LINE = 28;
const JOLT = 1500;

function score(rows: Row[]) {
  // Velocities and accelerations from positions, with each frame's own time step.
  const f = rows.map((r) => ({ ...r, vx: 0, vy: 0 }));
  for (let i = 1; i < f.length; i++) {
    const dt = (f[i]!.t - f[i - 1]!.t) / 1000 || 1 / 120;
    f[i]!.vx = (f[i]!.x - f[i - 1]!.x) / dt;
    f[i]!.vy = (f[i]!.y - f[i - 1]!.y) / dt;
  }
  const acc = (k: number) => {
    const dt = (f[k]!.t - f[k - 1]!.t) / 1000 || 1 / 120;
    return { x: (f[k]!.vx - f[k - 1]!.vx) / dt, y: (f[k]!.vy - f[k - 1]!.vy) / dt };
  };
  let jolts = 0;
  let kicks = 0;
  let swerve = 0;
  let straight = 0;
  let overshoot = 0;
  let maxAccel = 0;
  const frameMs: number[] = [];
  for (let i = 3; i + 1 < f.length; i++) {
    const r = f[i]!;
    const p = f[i - 1]!;
    frameMs.push(r.t - p.t);
    // Skip frames around a long gap (the tab was busy): no measure of smoothness there.
    if (r.t - p.t > 40 || f[i + 1]!.t - r.t > 40 || p.t - f[i - 2]!.t > 40) continue;
    const a = acc(i);
    maxAccel = Math.max(maxAccel, Math.hypot(a.x, a.y));
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
      if (-here.y > JOLT && -here.y > 2.5 * around) kicks++;
    }
    if (r.mood !== "tracking" || r.parked) continue;
    const sameLine = Math.abs(r.gy - r.y) < LINE * 0.4;
    if (Math.hypot(r.vx, r.vy) > 40 && r.vy < 0 && Math.abs(r.vy) > 2.5 * Math.abs(r.vx) && Math.abs(r.gx - r.x) > 20) straight++;
    if (sameLine && Math.sign(r.vx) !== Math.sign(p.vx) && Math.abs(r.vx) > 60 && Math.abs(p.vx) > 60) swerve++;
    if (sameLine && Math.abs(r.x - r.gx) > 1.5 && Math.sign(r.x - r.gx) === Math.sign(r.vx) && Math.abs(r.vx) > 10) overshoot++;
  }
  frameMs.sort((a, b) => a - b);
  return {
    frames: f.length,
    seconds: +((f.at(-1)!.t - f[0]!.t) / 1000).toFixed(1),
    frameMsMedian: +(frameMs[Math.floor(frameMs.length / 2)] ?? 0).toFixed(1),
    jolts,
    kicks,
    straight,
    swerve,
    overshoot,
    maxAccel: Math.round(maxAccel),
  };
}

for (const file of process.argv.slice(2)) {
  const data = (await Bun.file(file).json()) as Row[] | { log: Row[] };
  console.log(file, JSON.stringify(score(Array.isArray(data) ? data : data.log)));
}

// Scores a wisp trace recorded on a real page with the same measures as spikes/wisp-sim.ts. Record one in the
// artifact frame with `globalThis.__wispTrace = []` while Listen reads, then save the array as JSON.
// Each entry: { t (ms), x, y, gx, gy (page px), mood, parked }.
//
// Usage: bun spikes/wisp-score.ts trace.json [more.json ...]
type Row = { t: number; x: number; y: number; gx: number; gy: number; mood: string; parked: boolean };

const LINE = 28;
const JOLT = 1500;

/**
 * Velocity and acceleration at each frame from a least-squares quadratic through the five frames around it,
 * using their real timestamps: browsers deliver frames a millisecond or two early or late, and differencing
 * raw positions twice turns that jitter into fake jolts.
 */
function derivatives(rows: Row[]) {
  return rows.map((_, i) => {
    const lo = Math.max(0, i - 2);
    const hi = Math.min(rows.length - 1, i + 2);
    const t0 = rows[i]!.t / 1000;
    // Fit x(t) = a + b·τ + c·τ² (τ = t − t0) for x and y by normal equations.
    let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0;
    let X0 = 0, X1 = 0, X2 = 0, Y0 = 0, Y1 = 0, Y2 = 0;
    for (let k = lo; k <= hi; k++) {
      const tau = rows[k]!.t / 1000 - t0;
      const t2 = tau * tau;
      S0 += 1;
      S1 += tau;
      S2 += t2;
      S3 += t2 * tau;
      S4 += t2 * t2;
      X0 += rows[k]!.x;
      X1 += rows[k]!.x * tau;
      X2 += rows[k]!.x * t2;
      Y0 += rows[k]!.y;
      Y1 += rows[k]!.y * tau;
      Y2 += rows[k]!.y * t2;
    }
    const solve = (A0: number, A1: number, A2: number) => {
      // [S0 S1 S2; S1 S2 S3; S2 S3 S4] [a b c] = [A0 A1 A2]
      const det = S0 * (S2 * S4 - S3 * S3) - S1 * (S1 * S4 - S3 * S2) + S2 * (S1 * S3 - S2 * S2);
      if (Math.abs(det) < 1e-18) return { b: 0, c: 0 };
      const b = (S0 * (A1 * S4 - S3 * A2) - A0 * (S1 * S4 - S3 * S2) + S2 * (S1 * A2 - A1 * S2)) / det;
      const c = (S0 * (S2 * A2 - A1 * S3) - S1 * (S1 * A2 - A1 * S2) + A0 * (S1 * S3 - S2 * S2)) / det;
      return { b, c };
    };
    const fx = solve(X0, X1, X2);
    const fy = solve(Y0, Y1, Y2);
    return { vx: fx.b, vy: fy.b, ax: 2 * fx.c, ay: 2 * fy.c };
  });
}

function score(rows: Row[]) {
  const d = derivatives(rows);
  const f = rows.map((r, i) => ({ ...r, vx: d[i]!.vx, vy: d[i]!.vy }));
  const acc = (k: number) => ({ x: d[k]!.ax, y: d[k]!.ay });
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

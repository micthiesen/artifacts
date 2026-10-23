// How the splash page's wisp finds its way around a page without ever crossing what's on it. Pure (no DOM),
// so it is tested offline (test/wisp-nav.test.ts).
//
// The page becomes a grid of small cells, and everything solid on it (lines of text, buttons, cards) is
// painted in. A distance transform then gives every cell its distance to the nearest solid thing, and a cell
// is open when the wisp's centre could sit there with its whole body, and a little air, clear. A search (A*)
// finds a route through open cells that prefers the middle of a gap to hugging an edge, avoids a pointer it's
// shy of, and goes the long way round rather than across a thin rule. The route is pulled taut (corners it
// can see past are dropped), rounded off (Chaikin's corner cutting), and every point of the result is checked
// against the real rectangles; if rounding cuts a corner too close, a plainer version is used instead.
//
// A follower then moves along the path like something small with a little weight: it gathers speed, slows
// into bends (no faster than a sideways acceleration allows) and comes to a soft stop.

export type Point = { x: number; y: number };
export type Rect = { left: number; top: number; right: number; bottom: number };

/** A point to keep away from (the pointer it's running from) and how far. */
export type Avoid = { p: Point; r: number };

export const inflate = (r: Rect, by: number): Rect => ({ left: r.left - by, top: r.top - by, right: r.right + by, bottom: r.bottom + by });

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Distance from a point to a rectangle (0 inside it). */
export function rectDistance(r: Rect, p: Point): number {
  const dx = Math.max(r.left - p.x, 0, p.x - r.right);
  const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
  return Math.hypot(dx, dy);
}

type Heap = { f: number; i: number }[];
function push(h: Heap, n: { f: number; i: number }) {
  h.push(n);
  let k = h.length - 1;
  while (k > 0) {
    const p = (k - 1) >> 1;
    if (h[p]!.f <= h[k]!.f) break;
    [h[p], h[k]] = [h[k]!, h[p]!];
    k = p;
  }
}
function pop(h: Heap) {
  const top = h[0]!;
  const last = h.pop()!;
  if (h.length) {
    h[0] = last;
    let k = 0;
    for (;;) {
      const l = 2 * k + 1;
      const r = l + 1;
      let m = k;
      if (l < h.length && h[l]!.f < h[m]!.f) m = l;
      if (r < h.length && h[r]!.f < h[m]!.f) m = r;
      if (m === k) break;
      [h[m], h[k]] = [h[k]!, h[m]!];
      k = m;
    }
  }
  return top;
}

export type NavOptions = {
  /** Cell size (px). */
  cell?: number;
  /** How far from anything solid a route keeps the wisp's centre (its radius and some air). */
  clearance?: number;
  /** Things it may cross but would rather go round (thin rules, the call to action's surroundings). */
  soft?: Rect[];
};

export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly clearance: number;
  /** Roughly how far (px) each cell's centre is from the nearest solid thing (never more than it really is). */
  private free: Float32Array;
  /** Extra cost of passing through each cell (soft things). */
  private toll: Uint8Array;

  constructor(
    readonly bounds: Rect,
    readonly solid: Rect[],
    opts: NavOptions = {},
  ) {
    const cell = (this.cell = opts.cell ?? 8);
    this.clearance = opts.clearance ?? 16;
    const cols = (this.cols = Math.max(1, Math.ceil((bounds.right - bounds.left) / cell)));
    const rows = (this.rows = Math.max(1, Math.ceil((bounds.bottom - bounds.top) / cell)));
    const n = cols * rows;
    const dist = new Float32Array(n).fill(1e6);
    this.toll = new Uint8Array(n);
    const span = (r: Rect, f: (i: number) => void) => {
      const c0 = Math.max(0, Math.floor((r.left - bounds.left) / cell));
      const c1 = Math.min(cols - 1, Math.floor((r.right - bounds.left) / cell));
      const r0 = Math.max(0, Math.floor((r.top - bounds.top) / cell));
      const r1 = Math.min(rows - 1, Math.floor((r.bottom - bounds.top) / cell));
      for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) f(y * cols + x);
    };
    for (const r of solid) span(r, (i) => (dist[i] = 0));
    for (const r of opts.soft ?? []) span(r, (i) => (this.toll[i] = 1));
    // Two-pass chamfer distance transform (exact along rows, columns and diagonals, a few % long between).
    const a = cell;
    const b = cell * Math.SQRT2;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        let d = dist[i]!;
        if (x > 0) d = Math.min(d, dist[i - 1]! + a);
        if (y > 0) {
          d = Math.min(d, dist[i - cols]! + a);
          if (x > 0) d = Math.min(d, dist[i - cols - 1]! + b);
          if (x < cols - 1) d = Math.min(d, dist[i - cols + 1]! + b);
        }
        dist[i] = d;
      }
    }
    for (let y = rows - 1; y >= 0; y--) {
      for (let x = cols - 1; x >= 0; x--) {
        const i = y * cols + x;
        let d = dist[i]!;
        if (x < cols - 1) d = Math.min(d, dist[i + 1]! + a);
        if (y < rows - 1) {
          d = Math.min(d, dist[i + cols]! + a);
          if (x < cols - 1) d = Math.min(d, dist[i + cols + 1]! + b);
          if (x > 0) d = Math.min(d, dist[i + cols - 1]! + b);
        }
        dist[i] = d;
      }
    }
    // Distances run between cell centres, and a solid cell may only be touched at its far corner: allow for
    // that (and for the chamfer running long) so a cell never looks further from something than it is.
    this.free = dist.map((d) => (d === 0 ? 0 : Math.max(0, d * 0.93 - cell * 0.71)));
  }

  private centre(c: number, r: number): Point {
    return { x: this.bounds.left + (c + 0.5) * this.cell, y: this.bounds.top + (r + 0.5) * this.cell };
  }

  private index(p: Point): [number, number] {
    return [Math.floor((p.x - this.bounds.left) / this.cell), Math.floor((p.y - this.bounds.top) / this.cell)];
  }

  private openCell(c: number, r: number) {
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows && this.free[r * this.cols + c]! >= this.clearance;
  }

  /** About how much room there is around `p` (px to the nearest solid thing; 0 outside the grid). */
  room(p: Point): number {
    const [c, r] = this.index(p);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return 0;
    return this.free[r * this.cols + c]!;
  }

  /** The centre of the cell `p` is in (where a route would really pass). */
  snap(p: Point): Point {
    const [c, r] = this.index(p);
    return this.centre(c, r);
  }

  /** A route could pass through `p`. */
  open(p: Point): boolean {
    const [c, r] = this.index(p);
    return this.openCell(c, r);
  }

  /** Exactly how far `p` is from the nearest solid rectangle (capped at 400). */
  distanceAt(p: Point): number {
    let best = 400;
    for (const s of this.solid) {
      const d = rectDistance(s, p);
      if (d < best) best = d;
      if (best === 0) break;
    }
    return best;
  }

  /** The nearest open point to `p` (itself, if it's open), or null if there's none within a few hundred px. */
  nearestOpen(p: Point): Point | null {
    if (this.open(p)) return p;
    const [c0, r0] = this.index(p);
    for (let ring = 1; ring < 50; ring++) {
      let best: Point | null = null;
      let bestD = Infinity;
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring || !this.openCell(c0 + dc, r0 + dr)) continue;
          const q = this.centre(c0 + dc, r0 + dr);
          const d = Math.hypot(q.x - p.x, q.y - p.y);
          if (d < bestD) {
            bestD = d;
            best = q;
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * A route of cell centres from `from` to `to` through open cells, or null if they aren't connected. With
   * `avoid`, it keeps well away from that point (the pointer it's running from): cells within `avoid.r` are
   * shut, and those within twice that cost more.
   */
  route(from: Point, to: Point, avoid?: Avoid): Point[] | null {
    const a = this.nearestOpen(from);
    const b = this.nearestOpen(to);
    if (!a || !b) return null;
    const [ac, ar] = this.index(a);
    const [bc, br] = this.index(b);
    const cols = this.cols;
    const n = cols * this.rows;
    const g = new Float32Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const start = ar * cols + ac;
    const goal = br * cols + bc;
    g[start] = 0;
    const heap: Heap = [];
    const h = (i: number) => {
      const dx = Math.abs((i % cols) - bc);
      const dy = Math.abs(((i / cols) | 0) - br);
      return (dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy)) * this.cell;
    };
    push(heap, { f: h(start), i: start });
    // Cells this close to something solid cost extra, so routes keep to the middle of a gap.
    const comfy = this.clearance * 2.5;
    while (heap.length) {
      const { i } = pop(heap);
      if (closed[i]) continue;
      closed[i] = 1;
      if (i === goal) break;
      const c = i % cols;
      const r = (i / cols) | 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nc = c + dc;
          const nr = r + dr;
          if (!this.openCell(nc, nr)) continue;
          // No squeezing diagonally between two shut cells.
          if (dr && dc && (!this.openCell(c + dc, r) || !this.openCell(c, r + dr))) continue;
          const j = nr * cols + nc;
          if (closed[j]) continue;
          let cost = 1 + 2.5 * (Math.max(0, comfy - this.free[j]!) / comfy) + this.toll[j]! * 50;
          if (avoid) {
            const q = this.centre(nc, nr);
            const d = Math.hypot(q.x - avoid.p.x, q.y - avoid.p.y);
            // Within reach of the pointer it may only move away from it (so it can always get out).
            if (d < avoid.r && d < dist(this.centre(c, r), avoid.p)) continue;
            if (d < avoid.r * 2) cost += 6 * (1 - d / (avoid.r * 2));
          }
          const ng = g[i]! + (dr && dc ? Math.SQRT2 : 1) * this.cell * cost;
          if (ng < g[j]!) {
            g[j] = ng;
            came[j] = i;
            push(heap, { f: ng + h(j), i: j });
          }
        }
      }
    }
    if (!Number.isFinite(g[goal]!)) return null;
    const out: Point[] = [];
    for (let i = goal; i !== -1; i = came[i]!) out.push(this.centre(i % cols, (i / cols) | 0));
    out.reverse();
    // Start and end exactly where asked (when those are open).
    out[0] = a;
    if (out.length > 1) out[out.length - 1] = b;
    else out.push(b);
    return out;
  }

  /**
   * The straight line from `a` to `b` stays in open cells, off soft things and (with `avoid`) out of reach of
   * the pointer the whole way.
   */
  sees(a: Point, b: Point, avoid?: Avoid): boolean {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(d / (this.cell / 2)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const [c, r] = this.index(p);
      if (!this.openCell(c, r) || this.toll[r * this.cols + c]) return false;
      if (avoid && Math.hypot(p.x - avoid.p.x, p.y - avoid.p.y) < Math.min(avoid.r * 1.2, Math.hypot(a.x - avoid.p.x, a.y - avoid.p.y)) - 1) return false;
    }
    return true;
  }

  /** The soft cells `path` passes through. */
  private tolls(path: Point[]): Set<number> {
    const cells = new Set<number>();
    for (const p of path) {
      const [c, r] = this.index(p);
      if (c >= 0 && r >= 0 && c < this.cols && r < this.rows && this.toll[r * this.cols + c]) cells.add(r * this.cols + c);
    }
    return cells;
  }

  /**
   * Every soft cell `curve` passes through is one `plain` passes through, or next to one: rounding may wobble
   * within a soft thing the route crosses anyway (the strip off a phone's edge, which is all the margin there
   * is), but never cut across one the route went round.
   */
  private softWithin(curve: Set<number>, plain: Set<number>): boolean {
    const cols = this.cols;
    for (const i of curve) {
      const c = i % cols;
      let near = false;
      for (let dr = -1; dr <= 1 && !near; dr++) for (let dc = -1; dc <= 1 && !near; dc++) near = c + dc >= 0 && c + dc < cols && plain.has(i + dr * cols + dc);
      if (!near) return false;
    }
    return true;
  }

  /** Every point of `path` (but its ends) is at least `margin` px from anything solid, measured exactly. */
  clearAll(path: Point[], margin: number): boolean {
    return path.every((p, i) => i === 0 || i === path.length - 1 || this.distanceAt(p) >= margin);
  }

  /**
   * A route made smooth: pulled taut, then rounded off, checked to keep at least `hard` px from anything
   * solid all the way (the wisp's radius and a hair). Falls back to plainer versions if rounding cuts in.
   */
  smooth(route: Point[], hard: number, avoid?: Avoid): Point[] {
    const taut = [route[0]!];
    let k = 0;
    while (k < route.length - 1) {
      let far = k + 1;
      for (let j = Math.min(route.length - 1, k + 80); j > k + 1; j--) {
        if (this.sees(route[k]!, route[j]!, avoid)) {
          far = j;
          break;
        }
      }
      taut.push(route[far]!);
      k = far;
    }
    // Rounding a corner mustn't cut across a soft thing the route went round, either.
    const plain = densify(route, 3);
    const crossings = this.tolls(plain);
    for (const [base, passes] of [
      [taut, 4],
      [taut, 2],
      [route, 3],
    ] as const) {
      const curve = densify(chaikin(base, passes), 3);
      if (this.clearAll(curve, hard) && this.softWithin(this.tolls(curve), crossings)) return curve;
    }
    return plain;
  }

  /** A smooth route from `from` to `to` (see `route` and `smooth`), or null. */
  path(from: Point, to: Point, hard: number, avoid?: Avoid): Point[] | null {
    const r = this.route(from, to, avoid);
    return r && this.smooth(r, hard, avoid);
  }
}

/** Chaikin's corner cutting: each pass replaces every corner with two points a quarter of the way along. */
export function chaikin(pts: readonly Point[], passes: number): Point[] {
  let out = [...pts];
  for (let p = 0; p < passes && out.length > 2; p++) {
    const next = [out[0]!];
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i]!;
      const b = out[i + 1]!;
      if (i > 0) next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      if (i < out.length - 2) next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    next.push(out[out.length - 1]!);
    out = next;
  }
  return out;
}

/** Extra points so no two are more than `step` px apart (for even motion, and for checking). */
export function densify(pts: readonly Point[], step: number): Point[] {
  const out = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let s = 1; s <= n; s++) out.push({ x: a.x + ((b.x - a.x) * s) / n, y: a.y + ((b.y - a.y) * s) / n });
  }
  return out;
}

export type Pace = {
  /** Top speed (px/s). */
  cruise: number;
  /** How quickly it gathers speed and brakes (px/s²). */
  accel: number;
  /** The most sideways acceleration it takes a bend with (px/s²): lower slows it more into bends. */
  lateral: number;
};

/**
 * Moves along a path: it gathers speed, slows into bends and comes to a soft stop at the end, so it travels
 * like something small with a little weight rather than a cursor.
 */
/** How tightly what you see follows the planned progress along a path (rad/s). */
const SMOOTH = 28;

export class PathFollower {
  private cum: number[] = [0];
  /** The fastest it may be going at each point and still make every bend and stop ahead. */
  private cap: number[];
  private s = 0;
  v: number;
  /**
   * Where it's drawn along the path, and how fast that moves: the planned progress through a critically damped
   * spring, so its speed changes smoothly (the plan's acceleration switches on and off at once). Smoothed along
   * the path rather than across the page, it can't cut a corner the path goes round.
   */
  private shown = 0;
  private shownV: number;
  readonly length: number;

  constructor(
    private path: Point[],
    private pace: Pace,
    startSpeed = 0,
  ) {
    const n = path.length;
    for (let i = 1; i < n; i++) this.cum.push(this.cum[i - 1]! + Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y));
    this.length = this.cum[n - 1]!;
    // How sharply it turns at each point, averaged over a short stretch (the path is a chain of short straight
    // pieces, so the turning is all at their joins).
    const turn = path.map((p, i) => {
      if (i === 0 || i === n - 1) return 0;
      const a = path[i - 1]!;
      const b = path[i + 1]!;
      const t = Math.atan2(b.y - p.y, b.x - p.x) - Math.atan2(p.y - a.y, p.x - a.x);
      return Math.abs(Math.atan2(Math.sin(t), Math.cos(t)));
    });
    const WINDOW = 12;
    const curve = path.map((_, i) => {
      let angle = 0;
      let lo = i;
      let hi = i;
      while (lo > 0 && this.cum[i]! - this.cum[lo - 1]! <= WINDOW) angle += turn[--lo]!;
      while (hi < n - 1 && this.cum[hi + 1]! - this.cum[i]! <= WINDOW) angle += turn[++hi]!;
      angle += turn[i]!;
      const span = this.cum[hi]! - this.cum[lo]!;
      return span > 0 ? angle / span : 0;
    });
    this.cap = curve.map((k) => Math.min(pace.cruise, k > 1e-4 ? Math.sqrt(pace.lateral / k) : pace.cruise));
    this.cap[n - 1] = 0;
    for (let i = n - 2; i >= 0; i--) {
      const ds = this.cum[i + 1]! - this.cum[i]!;
      this.cap[i] = Math.min(this.cap[i]!, Math.sqrt(this.cap[i + 1]! ** 2 + 2 * pace.accel * ds));
    }
    this.v = Math.min(startSpeed, pace.cruise);
    this.shownV = this.v;
  }

  /** How far along it is (px). */
  get travelled() {
    return this.shown;
  }

  /** Where it is after `dt` more seconds, its velocity, and whether it has arrived. */
  advance(dt: number): { pos: Point; vel: Point; done: boolean } {
    // Speed up, but never past what the bends and the stop just ahead allow (the caps already ease down at
    // its braking rate); and a crawl at the very least, so the last pixel always arrives.
    const left = this.length - this.s;
    this.v = Math.max(Math.min(this.v + this.pace.accel * dt, this.capAt(this.s + this.v * dt)), Math.min(12, left / Math.max(dt, 1e-3)));
    this.s = Math.min(this.length, this.s + this.v * dt);
    const steps = Math.max(1, Math.ceil(dt * 240));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.shownV += (SMOOTH ** 2 * (this.s - this.shown) - 2 * SMOOTH * this.shownV) * h;
      this.shown = Math.min(this.length, this.shown + this.shownV * h);
    }
    const done = this.s >= this.length - 0.01 && this.length - this.shown < 0.3;
    if (done) this.shown = this.length;
    const pos = this.at(this.shown);
    const p0 = this.at(Math.max(0, this.shown - 1.5));
    const p1 = this.at(Math.min(this.length, this.shown + 1.5));
    const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
    const speed = Math.max(0, this.shownV);
    return { pos, vel: { x: ((p1.x - p0.x) / len) * speed, y: ((p1.y - p0.y) / len) * speed }, done };
  }

  private seek(s: number): number {
    let lo = 0;
    let hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid]! <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  private capAt(s: number): number {
    const i = this.seek(Math.min(this.length, s));
    const j = Math.min(this.cap.length - 1, i + 1);
    const span = this.cum[j]! - this.cum[i]! || 1;
    const t = Math.min(1, Math.max(0, (s - this.cum[i]!) / span));
    return this.cap[i]! + (this.cap[j]! - this.cap[i]!) * t;
  }

  /** The point `s` px along the path. */
  at(s: number): Point {
    const i = this.seek(s);
    const j = Math.min(this.path.length - 1, i + 1);
    const a = this.path[i]!;
    const b = this.path[j]!;
    const span = this.cum[j]! - this.cum[i]! || 1;
    const t = Math.min(1, Math.max(0, (s - this.cum[i]!) / span));
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
}

// How the wisp gets from where it is to where it wants to be, as one smooth path. Pure (no DOM), so it is
// measured and scored offline (spikes/wisp-sim.ts) as well as used on the page.
//
// Two layers. An invisible guide traces the path the wisp means to take: each move is a segment from where
// the guide is to a fixed destination, eased in and out (smootherstep) and bowed out into an arc by a bump
// that rises and falls with no speed or acceleration of its own at either end (64·s³(1−s)³): up for a move
// across the page, to the side for one up or down it. The wisp itself follows the guide through two
// critically damped springs in a row. That follower is a weighted average of where the guide has recently
// been, with only positive weights, so whatever the guide does the wisp's path is smooth in position,
// velocity and acceleration, never overshoots the guide's furthest point, and only turns back if the guide
// does (the pilot never asks it to mid-move). The price is a lag of about 2/ω seconds, which the words are
// handed over early enough to cover.

export type Point = { x: number; y: number };

/** A move under way: when it started, how long it takes, where from and to, and how far its arc bows out. */
export type Segment = { t0: number; time: number; from: Point; to: Point; bow: Point };

/** The follower's natural frequency (rad/s): higher is tighter on the guide, lower is floatier. */
export const FOLLOW_OMEGA = 44;

const smootherstep = (s: number) => s * s * s * (s * (s * 6 - 15) + 10);
const bump = (s: number) => 64 * (s * (1 - s)) ** 3;

/**
 * The way an arc bows from `from` to `to`: up for a move across the page, to the right for one straight up or
 * down it (on the screen, y grows downward).
 */
export function bowOut(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const a = { x: dy / len, y: -dx / len };
  const b = { x: -a.x, y: -a.y };
  if (Math.abs(a.y - b.y) > 0.2) return a.y < b.y ? a : b;
  return a.x > b.x ? a : b;
}

export class WispMotion {
  /** Where the wisp is drawn, and how it's moving. */
  pos: Point = { x: 0, y: 0 };
  vel: Point = { x: 0, y: 0 };
  /** The first follower stage (between the guide and the wisp). */
  private mid: Point = { x: 0, y: 0 };
  private midVel: Point = { x: 0, y: 0 };
  /** Where the guide is. */
  guide: Point = { x: 0, y: 0 };
  seg: Segment | null = null;
  clock = 0;
  omega = FOLLOW_OMEGA;

  place(p: Point, v: Point = { x: 0, y: 0 }) {
    this.pos = { ...p };
    this.vel = { ...v };
    this.mid = { ...p };
    this.midVel = { ...v };
    this.guide = { ...p };
    this.seg = null;
  }

  /** Sends the guide off for `to` over `time` seconds, its path bowing out `height` px, from where it is now. */
  move(to: Point, time: number, height: number) {
    const dir = bowOut(this.guide, to);
    this.seg = { t0: this.clock, time: Math.max(0.05, time), from: { ...this.guide }, to: { ...to }, bow: { x: dir.x * height, y: dir.y * height } };
  }

  /** The guide is on its way somewhere (rather than resting on its spot)? */
  get moving() {
    return this.seg !== null;
  }

  /** Which way the guide is heading right now (zero when it isn't moving). */
  get heading(): Point {
    const seg = this.seg;
    if (!seg) return { x: 0, y: 0 };
    return { x: seg.to.x - this.guide.x, y: seg.to.y - this.guide.y };
  }

  /**
   * One frame. The guide follows its move, or, between moves, sits on `goal` (a bob, the page settling). The
   * wisp follows the guide. Returns true on the frame the guide arrives.
   */
  step(dt: number, goal: Point): boolean {
    this.clock += dt;
    let arrived = false;
    const seg = this.seg;
    if (seg) {
      const s = Math.min(1, (this.clock - seg.t0) / seg.time);
      const e = smootherstep(s);
      const b = bump(s);
      this.guide = { x: seg.from.x + (seg.to.x - seg.from.x) * e + seg.bow.x * b, y: seg.from.y + (seg.to.y - seg.from.y) * e + seg.bow.y * b };
      if (s >= 1) {
        this.seg = null;
        arrived = true;
      }
    } else this.guide = { ...goal };
    // Two critically damped springs in a row, integrated in small steps so they stay exact at any frame rate.
    const k = this.omega * this.omega;
    const c = 2 * this.omega;
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.midVel = { x: this.midVel.x + (k * (this.guide.x - this.mid.x) - c * this.midVel.x) * h, y: this.midVel.y + (k * (this.guide.y - this.mid.y) - c * this.midVel.y) * h };
      this.mid = { x: this.mid.x + this.midVel.x * h, y: this.mid.y + this.midVel.y * h };
      this.vel = { x: this.vel.x + (k * (this.mid.x - this.pos.x) - c * this.vel.x) * h, y: this.vel.y + (k * (this.mid.y - this.pos.y) - c * this.vel.y) * h };
      this.pos = { x: this.pos.x + this.vel.x * h, y: this.pos.y + this.vel.y * h };
    }
    return arrived;
  }

  /** At rest: the guide is home and the wisp has caught up with it. */
  get settled() {
    return !this.seg && Math.hypot(this.guide.x - this.pos.x, this.guide.y - this.pos.y) < 0.3 && Math.hypot(this.vel.x, this.vel.y) < 2;
  }

  /** Moves everything by (dx, dy) at once (what it sits on moved: the page scrolled under it). */
  shift(dx: number, dy: number) {
    const add = (p: Point) => ({ x: p.x + dx, y: p.y + dy });
    this.pos = add(this.pos);
    this.mid = add(this.mid);
    this.guide = add(this.guide);
    if (this.seg) this.seg = { ...this.seg, from: add(this.seg.from), to: add(this.seg.to) };
  }
}

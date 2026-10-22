// What the wisp decides as reading goes along: which moves are word hops, which are line returns and which
// are flights, how long each takes and how high it bows, and when it simply holds its spot. Pure (no DOM):
// src/kit/wisp.ts feeds it spots worked out from the page, and spikes/wisp-sim.ts feeds it simulated reading
// to measure and score how smooth the result is.
//
// The rule that keeps it smooth: a new destination replans the guide's move at once only if it lies ahead of
// the way the guide is going. One behind it (the next word arriving while it sweeps back to the start of a
// line) waits until the current move lands, so the wisp never swerves backwards mid-air. (The wisp follows
// the guide through a smoothing filter, src/shared/wisp-motion.ts, so it can't jolt or overshoot either.)

import { WispMotion, type Point } from "./wisp-motion.ts";

/** A word this far away (px) is a flight rather than a hop. */
export const HOP_REACH = 150;

/** Duration (s) and bow (px) of a word-to-word hop, sized to the gap and to the rhythm of the speech. */
export function hopShape(d: number, interval: number): { time: number; height: number } {
  // Most of the word's length: it lands as the word is heard and is barely settled when the next comes, so
  // reading reads as a run of little hops rather than a stop at every word.
  const time = Math.min(0.1 + d / 800, Math.max(0.09, 0.8 * interval), 0.24);
  // A full hop at a relaxed pace; a ripple when words come fast.
  // (The follower softens the guide's arc, so the guide's is drawn a little taller than the hop you see.)
  // (A nudge of a pixel or two gets a nudge of a hop.)
  const height = Math.min(16, 8 + d * 0.09) * Math.min(1, Math.max(0.45, interval / 0.3)) * Math.min(1, d / 24);
  return { time, height };
}

/**
 * Duration (s) and bow (px) of the sweep back to the start of the next line (or paragraph): steady, and low,
 * so it glides back through the gap between the lines instead of looping over the line above.
 */
export function wrapShape(d: number, interval: number): { time: number; height: number } {
  return { time: Math.min(0.3, Math.max(0.12, 0.8 * interval, d / 4200)), height: Math.min(7, 2 + d * 0.008) };
}

/** Duration (s) and bow (px) of a flight: a far word, a tap, the margin and back. */
export function flightShape(d: number): { time: number; height: number } {
  return { time: Math.min(0.62, Math.max(0.26, 0.2 + d / 1400)), height: Math.min(26, Math.max(5, d * 0.06)) * Math.min(1, d / 40) };
}

type Plan = { goal: Point; time: number; height: number; hop: boolean };

export class WispPilot {
  motion = new WispMotion();
  private lastWordAt = -1;
  private lastGoal: Point | null = null;
  private wordNow = false;
  /** A move waiting for the current one to land (its destination is behind the way the wisp is going). */
  private queued: Plan | null = null;
  /** When it last arrived at the end of a move (for the landing squash), in its clock's seconds. */
  landedAt = -1;
  /** The last move to land was a word hop (so its landing squashes), not a sweep or a flight. */
  lastWasHop = false;
  private movingHop = false;

  get clock() {
    return this.motion.clock;
  }

  /**
   * Puts it somewhere without a move (reduced motion), or, with `flyFrom`, somewhere it will fly from: the
   * first spot it's given is then a flight from here (arriving from under the tray).
   */
  place(p: Point, flyFrom = false) {
    this.motion.place(p);
    this.lastGoal = flyFrom ? { ...p } : null;
    this.queued = null;
  }

  /** Moves everything by (dx, dy) at once (the page scrolled under it while it waits at the screen's edge). */
  shift(dx: number, dy: number) {
    this.motion.shift(dx, dy);
    if (this.lastGoal) this.lastGoal = { x: this.lastGoal.x + dx, y: this.lastGoal.y + dy };
  }

  /** Starts a move now, or, if its destination is behind the way it's going, once the current move lands. */
  private go(plan: Plan) {
    const m = this.motion;
    const h = m.heading;
    const ahead = (plan.goal.x - m.guide.x) * h.x + (plan.goal.y - m.guide.y) * h.y;
    // Nor while the wisp itself is still drifting the other way, catching up with the guide.
    const against = (plan.goal.x - m.pos.x) * m.vel.x + (plan.goal.y - m.pos.y) * m.vel.y < 0 && Math.hypot(m.vel.x, m.vel.y) > 20;
    if ((m.moving && ahead < 0) || against) {
      this.queued = plan;
      return;
    }
    this.queued = null;
    m.move(plan.goal, plan.time, plan.height);
    this.movingHop = plan.hop;
  }

  /** The next word is `goal`: a hop along the line, a sweep back to the next line, or a flight. */
  word(goal: Point, lineHeight: number) {
    const m = this.motion;
    const interval = this.lastWordAt >= 0 ? m.clock - this.lastWordAt : 0.3;
    this.lastWordAt = m.clock;
    this.wordNow = true;
    // Sized from where it's heading (or where it is, at rest), so a word that comes while it's still on its
    // way is measured from where it will be.
    const from = this.queued?.goal ?? m.seg?.to ?? m.guide;
    const dx = goal.x - from.x;
    const dy = goal.y - from.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.5 && !m.moving) return;
    // On to the next line, or the next paragraph down, as reading goes: a steady low sweep back.
    if (dy > lineHeight * 0.5 && dy < lineHeight * 4 && dx < 0) return this.go({ goal, ...wrapShape(d, interval), hop: false });
    if (d >= HOP_REACH || Math.abs(dy) > lineHeight * 0.5) return this.go({ goal, ...flightShape(d), hop: false });
    this.go({ goal, ...hopShape(d, interval), hop: true });
  }

  /**
   * One frame toward `goal`. A jump in the goal that wasn't a word (a tap elsewhere, out to the margin, back
   * from the screen's edge) becomes a flight; small drifts (a bob, the page settling) are followed directly. `still` (reduced motion) puts it there at once. Returns true as a move lands.
   */
  frame(dt: number, goal: Point, still = false): boolean {
    const m = this.motion;
    if (still) {
      m.clock += dt;
      m.place(goal);
      this.lastGoal = goal;
      this.wordNow = false;
      this.queued = null;
      return false;
    }
    if (!this.wordNow && this.lastGoal && Math.hypot(goal.x - this.lastGoal.x, goal.y - this.lastGoal.y) > 12) {
      this.go({ goal, ...flightShape(Math.hypot(goal.x - m.guide.x, goal.y - m.guide.y)), hop: false });
    }
    this.wordNow = false;
    this.lastGoal = goal;
    const landed = m.step(dt, goal);
    if (landed) {
      this.landedAt = m.clock;
      this.lastWasHop = this.movingHop;
    }
    // Carry on to what came in while it was on its way, once it can go without turning back mid-air.
    if (this.queued && !m.moving) this.go(this.queued);
    return landed;
  }
}

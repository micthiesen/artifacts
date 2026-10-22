// The wisp's body: how it moves and how it's drawn, shared by every place it lives. What it does is up to
// whoever owns it: in an artifact it reads along with Listen (src/kit/wisp.ts, whose header is the
// character's brief); on the splash page it plays (src/shell/splash-wisp.ts).
//
// The body is a head on a damped spring and a tail of points that each chase the one before, so it
// stretches and streams when it flies and gathers back into one round blob at rest. It is drawn on one
// fixed, full-screen canvas that ignores the pointer: a tapered run of discs along the tail (one filled
// path, so it reads as a single soft body), the head stretched along its flight, a small radial glow
// under it (the ghost's halo, the one kind of gradient the look allows), and, when it is still, the logo's
// happy closed eyes and blush. It is moon white because it is the agent's light (AGENTS.md "Look").

export type Point = { x: number; y: number };

/**
 * Points in the tail, how quickly each catches the one before it (per second: lower is a longer, lazier
 * tail), and how far apart two may get, in head radii, so even a fast flight trails a teardrop, never a
 * streak across the page.
 */
const TAIL = 14;
const TAIL_FOLLOW = 26;
const TAIL_GAP = 0.9;
const DAMPING = 0.72;
/** It never flies faster than this (px/s), so a long way is a flight, not a teleport. */
const MAX_SPEED = 2600;

/** The logo's blush (src/shell/icons/logo.svg). */
const BLUSH = "#ff7ab0";

export class WispBody {
  head: Point = { x: 0, y: 0 };
  vel: Point = { x: 0, y: 0 };
  tail: Point[] = [];
  radius = 6;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private glow: HTMLCanvasElement | null = null;
  private light = "#f6f2ea";
  private ink = "#13161d";
  private dpr = 1;
  private onResize = () => this.resize();

  /** `colours`: the theme's custom properties for the body and for its eyes. */
  constructor(className: string, colours: { light: string; ink: string }) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = className;
    this.canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.light = this.themeColour(colours.light, this.light);
    this.ink = this.themeColour(colours.ink, this.ink);
    this.glow = this.makeGlow();
    this.resize();
    addEventListener("resize", this.onResize);
  }

  /** A theme colour as the canvas understands it, or the fallback when the canvas can't parse it. */
  private themeColour(name: string, fallback: string): string {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!this.ctx || !value) return fallback;
    this.ctx.fillStyle = fallback;
    this.ctx.fillStyle = value;
    return this.ctx.fillStyle as string;
  }

  /** The halo under the head, drawn once. */
  private makeGlow(): HTMLCanvasElement | null {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    if (!g) return null;
    g.fillStyle = this.light;
    g.fillRect(0, 0, 64, 64);
    g.globalCompositeOperation = "destination-in";
    const fade = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    fade.addColorStop(0, "rgba(0,0,0,0.3)");
    fade.addColorStop(0.45, "rgba(0,0,0,0.09)");
    fade.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = fade;
    g.fillRect(0, 0, 64, 64);
    return c;
  }

  resize() {
    this.dpr = Math.min(3, devicePixelRatio || 1);
    this.canvas.width = Math.round(innerWidth * this.dpr);
    this.canvas.height = Math.round(innerHeight * this.dpr);
  }

  get connected() {
    return this.canvas.isConnected;
  }

  /** Puts the whole body at one point, still. */
  place(p: Point, vel: Point = { x: 0, y: 0 }) {
    this.head = { ...p };
    this.vel = { ...vel };
    this.tail = Array.from({ length: TAIL }, () => ({ ...p }));
  }

  /**
   * One step toward `goal` on a spring of stiffness `k` (per s²), the radius easing toward `size`. `still`
   * (reduced motion) puts it there at once, tail gathered.
   */
  step(dt: number, goal: Point, k: number, size: number, still = false) {
    if (still) {
      this.place(goal);
      this.radius = size;
      return;
    }
    const c = 2 * Math.sqrt(k) * DAMPING;
    this.vel.x += (k * (goal.x - this.head.x) - c * this.vel.x) * dt;
    this.vel.y += (k * (goal.y - this.head.y) - c * this.vel.y) * dt;
    const speed = Math.hypot(this.vel.x, this.vel.y);
    if (speed > MAX_SPEED) {
      this.vel.x *= MAX_SPEED / speed;
      this.vel.y *= MAX_SPEED / speed;
    }
    this.head = { x: this.head.x + this.vel.x * dt, y: this.head.y + this.vel.y * dt };
    const follow = 1 - Math.exp(-TAIL_FOLLOW * dt);
    const gap = Math.max(1, this.radius * TAIL_GAP);
    let lead = this.head;
    this.tail = this.tail.map((p) => {
      let q = { x: p.x + (lead.x - p.x) * follow, y: p.y + (lead.y - p.y) * follow };
      const d = Math.hypot(q.x - lead.x, q.y - lead.y);
      if (d > gap) q = { x: lead.x + ((q.x - lead.x) * gap) / d, y: lead.y + ((q.y - lead.y) * gap) / d };
      lead = q;
      return q;
    });
    this.radius += (size - this.radius) * (1 - Math.exp(-8 * dt));
  }

  /** At rest on `goal`: not moving, tail gathered, the size it wants. */
  settled(goal: Point, size: number): boolean {
    return (
      Math.hypot(this.vel.x, this.vel.y) < 2 &&
      Math.hypot(goal.x - this.head.x, goal.y - this.head.y) < 0.3 &&
      this.tail.every((p) => Math.hypot(p.x - this.head.x, p.y - this.head.y) < 0.3) &&
      Math.abs(size - this.radius) < 0.05
    );
  }

  draw() {
    const { ctx, canvas, head, vel, radius } = this;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.glow) {
      const g = radius * 5.5;
      ctx.drawImage(this.glow, head.x - g, head.y - g, g * 2, g * 2);
    }
    // The tail: tapering discs along the chain, close enough together to read as one body.
    const body = new Path2D();
    let prev = head;
    for (let i = 0; i < this.tail.length; i++) {
      const p = this.tail[i]!;
      const r = radius * 0.92 * (1 - (i + 1) / (this.tail.length + 1)) ** 1.15;
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
    ctx.fillStyle = this.light;
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
      ctx.strokeStyle = this.ink;
      ctx.lineWidth = Math.max(0.8, radius * 0.17);
      ctx.lineCap = "round";
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(side * radius * 0.36, radius * 0.06, radius * 0.2, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      }
      // And its blush, once it's big enough to see.
      if (radius >= 5.5) {
        ctx.fillStyle = BLUSH;
        ctx.globalAlpha = calm * 0.7;
        for (const side of [-1, 1]) {
          ctx.beginPath();
          ctx.ellipse(side * radius * 0.5, radius * 0.36, radius * 0.16, radius * 0.1, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  clear() {
    if (!this.ctx) return;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}

export const prefersStill = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

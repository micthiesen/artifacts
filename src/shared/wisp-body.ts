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
const TAIL = 12;
const TAIL_FOLLOW = 22;
const TAIL_GAP = 0.5;
const DAMPING = 0.72;
/** It never flies faster than this (px/s), so a long way is a flight, not a teleport. */
const MAX_SPEED = 2600;

/** The logo's blush (src/shell/icons/logo.svg, at its 0.45 opacity). */
const BLUSH = "#ff7ab0";

export class WispBody {
  head: Point = { x: 0, y: 0 };
  vel: Point = { x: 0, y: 0 };
  tail: Point[] = [];
  radius = 6;
  /** Squash (positive: wide and low, as it lands) or stretch (negative: tall and narrow, in the air), drawn on the head. */
  squash = 0;
  /** Drawn upright with `squash` (a hop) rather than stretched along its flight. */
  upright = false;
  /**
   * How far off its straight path the head is drawn this frame (a hop or flight bowing out into a curve);
   * the tail follows the head where it's drawn.
   */
  arc: Point = { x: 0, y: 0 };
  /** How fast that offset is changing (px/s), so the head stretches along its real path. */
  arcVel: Point = { x: 0, y: 0 };
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private glow: HTMLCanvasElement | null = null;
  private light = "#f6f2ea";
  private ink = "#13161d";
  private dpr = 1;
  private onResize = () => this.resize();
  private observer: ResizeObserver | null = null;

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

  /** Watches the page for reflows (late images, fonts), so a wisp at rest can catch up with what it sits on. */
  observe(onChange: () => void) {
    this.observer?.disconnect();
    if (typeof ResizeObserver === "undefined") return;
    this.observer = new ResizeObserver(onChange);
    this.observer.observe(document.body);
  }

  /** Gone for good: its canvas (and its memory) and its listeners. */
  dispose() {
    removeEventListener("resize", this.onResize);
    this.observer?.disconnect();
    this.canvas.width = this.canvas.height = 0;
    this.canvas.remove();
  }

  /**
   * A theme colour as the canvas understands it, or the fallback when the canvas can't parse it (setting an
   * unparsable fillStyle leaves the previous one, so a value the canvas rejects reads back as the fallback).
   */
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

  /** Sized to the box the canvas actually has (the viewport without a classic scrollbar), at the screen's density. */
  resize() {
    this.dpr = Math.min(3, devicePixelRatio || 1);
    this.canvas.width = Math.round(viewWidth() * this.dpr);
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
  step(dt: number, goal: Point, k: number, size: number, still = false, damping = DAMPING) {
    if (still) {
      this.place(goal);
      this.radius = size;
      return;
    }
    const c = 2 * Math.sqrt(k) * damping;
    this.vel.x += (k * (goal.x - this.head.x) - c * this.vel.x) * dt;
    this.vel.y += (k * (goal.y - this.head.y) - c * this.vel.y) * dt;
    const speed = Math.hypot(this.vel.x, this.vel.y);
    if (speed > MAX_SPEED) {
      this.vel.x *= MAX_SPEED / speed;
      this.vel.y *= MAX_SPEED / speed;
    }
    this.head = { x: this.head.x + this.vel.x * dt, y: this.head.y + this.vel.y * dt };
    this.chase(dt);
    this.radius += (size - this.radius) * (1 - Math.exp(-8 * dt));
  }

  /** Each tail point chases the one before it, never further than a radius or so behind. */
  private chase(dt: number) {
    const follow = 1 - Math.exp(-TAIL_FOLLOW * dt);
    const gap = Math.max(1, this.radius * TAIL_GAP);
    let lead = { x: this.head.x + this.arc.x, y: this.head.y + this.arc.y };
    this.tail = this.tail.map((p) => {
      let q = { x: p.x + (lead.x - p.x) * follow, y: p.y + (lead.y - p.y) * follow };
      const d = Math.hypot(q.x - lead.x, q.y - lead.y);
      if (d > gap) q = { x: lead.x + ((q.x - lead.x) * gap) / d, y: lead.y + ((q.y - lead.y) * gap) / d };
      lead = q;
      return q;
    });
  }

  /** At rest on `goal`: not moving, tail gathered, the size it wants. Settling snaps the last fraction of a pixel. */
  settled(goal: Point, size: number): boolean {
    const done =
      Math.hypot(this.vel.x, this.vel.y) < 2 &&
      Math.hypot(goal.x - this.head.x, goal.y - this.head.y) < 0.4 &&
      this.tail.every((p) => Math.hypot(p.x - this.head.x, p.y - this.head.y) < 0.6) &&
      Math.abs(size - this.radius) < 0.05;
    if (done) {
      this.place(goal);
      this.radius = size;
      this.draw(this.lastOffset, this.lastTime);
    }
    return done;
  }

  private lastOffset: Point = { x: 0, y: 0 };
  private lastTime = 0;

  /** Moves the whole body by (dx, dy) at once, tail and all: for when what it sits on moves (the page scrolling). */
  shift(dx: number, dy: number) {
    if (!dx && !dy) return;
    this.head = { x: this.head.x + dx, y: this.head.y + dy };
    this.tail = this.tail.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  }

  /**
   * Paints it. Its coordinates are its owner's (the page's, so it rides along when the page scrolls);
   * `offset` turns them into the screen's.
   */
  draw(offset: Point = { x: 0, y: 0 }, time = 0) {
    const { ctx, canvas, vel, radius } = this;
    if (!ctx) return;
    this.lastOffset = offset;
    this.lastTime = time;
    const head = { x: this.head.x + this.arc.x + offset.x, y: this.head.y + this.arc.y + offset.y };
    const tail = this.tail.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y }));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.glow) {
      const g = radius * 5.5;
      ctx.drawImage(this.glow, head.x - g, head.y - g, g * 2, g * 2);
    }
    // The tail: the hem of a ghost's sheet, not a line. It stays nearly as wide as the head for most of its
    // length and rounds off at the end, rippling a little from side to side as it goes. Drawn as discs along
    // the chain, close enough together to read as one soft body.
    const body = new Path2D();
    const speed = Math.hypot(vel.x, vel.y);
    const ripple = Math.min(1, speed / 500) * radius * 0.18;
    let prev = head;
    let along = 0;
    const n = tail.length;
    for (let i = 0; i < n; i++) {
      const p = tail[i]!;
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      const d = Math.hypot(dx, dy);
      const steps = Math.min(40, Math.max(1, Math.ceil(d / Math.max(0.6, radius * 0.3))));
      for (let s = 1; s <= steps; s++) {
        const t = (i + s / steps) / n;
        const r = radius * 0.96 * (1 - t ** 2.6) ** 0.6;
        if (r < 0.3) continue;
        along += d / steps;
        const wave = d > 0 ? Math.sin(time * 14 - along * 0.25) * ripple * t : 0;
        const x = prev.x + dx * (s / steps) + (d > 0 ? (-dy / d) * wave : 0);
        const y = prev.y + dy * (s / steps) + (d > 0 ? (dx / d) * wave : 0);
        body.moveTo(x + r, y);
        body.arc(x, y, r, 0, Math.PI * 2);
      }
      prev = p;
    }
    // Head and tail are one colour, one body (the canvas itself is a touch translucent, in CSS).
    ctx.fillStyle = this.light;
    ctx.globalAlpha = 1;
    ctx.fill(body);
    // The head: stretched along its flight and squashed across it; a hop's squash and stretch is upright.
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.translate(head.x, head.y);
    if (this.upright) {
      // Squashed on landing, it keeps its bottom where it was; stretched in the air, it stays centred.
      if (this.squash > 0) ctx.translate(0, radius * this.squash);
      ctx.scale(1 + this.squash, 1 - this.squash);
    } else {
      // Along its real path: the spring's motion with the curve's on top.
      const vx = vel.x + this.arcVel.x;
      const vy = vel.y + this.arcVel.y;
      const stretch = 1 + Math.min(0.38, Math.hypot(vx, vy) / 1400);
      ctx.rotate(Math.atan2(vy, vx));
      ctx.scale(stretch, 1 / stretch);
    }
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // Still enough, and big enough, to see its face: the logo's happy closed eyes and blush, fading in as it
    // slows and grows (so they never flicker on the small hops between words).
    const face = Math.max(0, 1 - speed / 70) * Math.min(1, Math.max(0, (radius - 5.6) / 0.8));
    if (face > 0.05) {
      ctx.save();
      ctx.translate(head.x, head.y);
      ctx.globalAlpha = face * 0.85;
      ctx.strokeStyle = this.ink;
      ctx.lineWidth = Math.max(0.8, radius * 0.17);
      ctx.lineCap = "round";
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(side * radius * 0.36, radius * 0.06, radius * 0.2, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      }
      ctx.fillStyle = BLUSH;
      ctx.globalAlpha = face * 0.45;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(side * radius * 0.5, radius * 0.36, radius * 0.16, radius * 0.1, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

}

/** The viewport's width without a classic scrollbar: what a fixed, full-width element actually covers. */
export const viewWidth = () => document.documentElement.clientWidth || innerWidth;

export const prefersStill = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

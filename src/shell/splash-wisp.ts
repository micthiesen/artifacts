// The splash page's wisp: the same little ghost of moon light that reads along with Listen
// (src/kit/wisp.ts), here with nothing to read, so it plays.
//
// What it does. It slips out of the big ghost in the hero (or in from an edge, on screens without one) and
// treats the page as somewhere to explore: it perches on the top edges of the things on it (the title, the
// buttons, the example window, the code, the section headings), bobs a moment, settles with its eyes closed,
// and after a while hops to another perch. Now and then it wanders off the edge of the screen and comes
// back somewhere else. It is shy: bring the pointer near and it darts away to a perch far from you; chase it
// and it hides off screen for a bit before sneaking back. On a touch screen, tap near it to shoo it.
//
// What it must never do. Sit on text or anything you'd read or press (it perches on top edges, in the space
// above), take the pointer (its canvas ignores it), or cost anything when nobody is watching: it draws only
// while it moves, stops when the tab is hidden, and settles into a still doze between hops. With reduced
// motion it doesn't come out at all: here it is play, not help.

import { prefersStill, WispBody, type Point } from "../shared/wisp-body.ts";

/** Where it likes to perch: the visible things on the splash page, in rough reading order. */
const PERCHES = [
  ".splash h1",
  ".splash-actions .button",
  ".splash-ghost",
  ".showcase h2",
  ".showcase-tabs [role=tab]",
  ".showcase-window",
  ".splash-fact h3",
  ".splash-grid h2",
  ".splash-self h2",
  ".splash-self .splash-code",
].join(",");
const RADIUS = 6;
/** Springs (stiffness per s²): a floaty flight, a quick dart away, a firm landing. */
const SPRING = { flying: 55, fleeing: 95, perched: 140 } as const;
/** How near the pointer may come before it darts (px), and how many darts in a while make it hide. */
const SHY = 110;
const CHASED = { darts: 3, withinMs: 8000 };
/** Seconds: a perch lasts this long, it bobs this long after landing, and it stays away this long. */
const PERCH_FOR = [5, 11] as const;
const BOB_FOR = 2.5;
const AWAY_FOR = [4, 9] as const;

type Perch = { el: Element; u: number };
type State = "away" | "flying" | "fleeing" | "perched";

const between = ([a, b]: readonly [number, number]) => a + Math.random() * (b - a);

export function startSplashWisp() {
  if (prefersStill()) return;
  const body = new WispBody("splash-wisp", { light: "--moon", ink: "--bg" });
  let state: State = "away";
  let perch: Perch | null = null;
  let away: Point | null = null;
  let timer = 0;
  let raf = 0;
  let last = 0;
  let clock = 0;
  let landedAt = 0;
  let darts: number[] = [];

  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 24 && r.top > 40 && r.top < innerHeight - 40 && r.left > -1 && r.right < innerWidth + 1;
  };
  const perchPoint = (p: Perch): Point | null => {
    if (!p.el.isConnected) return null;
    const r = p.el.getBoundingClientRect();
    return { x: r.left + r.width * p.u, y: r.top - RADIUS - 0.5 };
  };
  const candidates = () => [...document.querySelectorAll(PERCHES)].filter(visible);

  function choosePerch(prefer?: (p: Point) => number): Perch | null {
    const options = candidates().map((el) => ({ el, u: 0.15 + Math.random() * 0.7 })).filter((p) => p.el !== perch?.el);
    if (!options.length) return null;
    if (!prefer) return options[Math.floor(Math.random() * options.length)]!;
    return options.map((p) => ({ p, score: prefer(perchPoint(p)!) + Math.random() * 80 })).sort((a, b) => b.score - a.score)[0]!.p;
  }

  /** A spot just past the nearest edge (or the edge away from `from`). */
  function offscreen(from?: Point): Point {
    const h = body.head;
    const side = from ? (from.x < h.x ? "right" : "left") : h.x < innerWidth / 2 ? "left" : "right";
    return { x: side === "left" ? -40 : innerWidth + 40, y: Math.min(innerHeight - 60, Math.max(60, h.y + (Math.random() - 0.5) * 120)) };
  }

  function goal(): Point {
    if (state === "away" || !perch) return away ?? offscreen();
    const p = perchPoint(perch);
    if (!p) return away ?? offscreen();
    if (state !== "perched") return p;
    // Perched: a little bob after landing, then still.
    const t = clock - landedAt;
    const bob = t < BOB_FOR ? Math.sin(t * 5) * 2.4 * (1 - t / BOB_FOR) : 0;
    return { x: p.x, y: p.y + bob };
  }

  function wake() {
    if (raf || document.hidden) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function frame(now: number) {
    raf = 0;
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    clock += dt;
    // The perch scrolled away: find another, or wander off.
    if (perch && state !== "away" && !visible(perch.el)) {
      perch = choosePerch((p) => -Math.hypot(p.x - body.head.x, p.y - body.head.y));
      if (!perch) goAway();
      else state = "flying";
    }
    const g = goal();
    const k = SPRING[state === "away" ? "flying" : state];
    body.step(dt, g, k, RADIUS);
    // Landed.
    if ((state === "flying" || state === "fleeing") && Math.hypot(g.x - body.head.x, g.y - body.head.y) < 1.5) {
      state = "perched";
      landedAt = clock;
      schedule(between(PERCH_FOR), wander);
    }
    body.draw();
    const resting = state === "perched" && clock - landedAt > BOB_FOR && body.settled(g, RADIUS);
    const gone = state === "away" && (body.head.x < -30 || body.head.x > innerWidth + 30) && body.settled(g, RADIUS);
    if (!resting && !gone) raf = requestAnimationFrame(frame);
  }

  function schedule(seconds: number, then: () => void) {
    clearTimeout(timer);
    timer = window.setTimeout(then, seconds * 1000);
  }

  function flyTo(p: Perch | null, how: "flying" | "fleeing" = "flying") {
    if (!p) return goAway();
    perch = p;
    away = null;
    state = how;
    // A little leap up as it sets off.
    body.vel.y -= how === "fleeing" ? 260 : 140;
    clearTimeout(timer);
    wake();
  }

  function goAway(from?: Point) {
    state = "away";
    perch = null;
    away = offscreen(from);
    schedule(between(AWAY_FOR), comeBack);
    wake();
  }

  function comeBack() {
    const p = choosePerch();
    if (!p) return schedule(between(AWAY_FOR), comeBack);
    // In from whichever edge is nearer the perch.
    const at = perchPoint(p)!;
    body.place({ x: at.x < innerWidth / 2 ? -30 : innerWidth + 30, y: Math.min(innerHeight - 40, Math.max(40, at.y + 60)) });
    flyTo(p);
  }

  /** Time to move on: usually to another perch nearby, sometimes off for a wander. */
  function wander() {
    if (Math.random() < 0.25) return goAway();
    flyTo(choosePerch((p) => -Math.abs(Math.hypot(p.x - body.head.x, p.y - body.head.y) - 320)));
  }

  /** Something came too close: dart to the far side, or hide if it keeps happening. */
  function startle(from: Point) {
    if (state === "away") return;
    const now = performance.now();
    darts = [...darts.filter((t) => now - t < CHASED.withinMs), now];
    const dx = body.head.x - from.x;
    const dy = body.head.y - from.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    body.vel.x += (dx / d) * 700;
    body.vel.y += (dy / d) * 700 - 200;
    if (darts.length >= CHASED.darts) {
      darts = [];
      return goAway(from);
    }
    const far = choosePerch((p) => Math.hypot(p.x - from.x, p.y - from.y));
    if (far && Math.hypot(perchPoint(far)!.x - from.x, perchPoint(far)!.y - from.y) > 240) flyTo(far, "fleeing");
    else goAway(from);
  }

  addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType !== "mouse" || state === "away") return;
      if (Math.hypot(e.clientX - body.head.x, e.clientY - body.head.y) < SHY) startle({ x: e.clientX, y: e.clientY });
    },
    { passive: true },
  );
  addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "mouse" || state === "away") return;
      if (Math.hypot(e.clientX - body.head.x, e.clientY - body.head.y) < SHY * 0.8) startle({ x: e.clientX, y: e.clientY });
    },
    { passive: true },
  );
  addEventListener("scroll", wake, { passive: true });
  addEventListener("resize", wake);
  document.addEventListener("visibilitychange", wake);

  // Out it comes: from the big ghost when there is one on screen, otherwise in from an edge.
  window.setTimeout(() => {
    const ghost = document.querySelector(".splash-ghost");
    const r = ghost?.getBoundingClientRect();
    if (r && r.width && visible(ghost!)) {
      body.place({ x: r.left + r.width / 2, y: r.top + r.height * 0.45 }, { x: -60, y: -380 });
      body.radius = 2;
      flyTo(choosePerch((p) => -Math.hypot(p.x - (r.left + r.width / 2), p.y - r.top)));
    } else comeBack();
  }, 1600);
}

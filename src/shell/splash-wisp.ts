// The splash page's wisp: the same little ghost of moon light that reads along with Listen
// (src/kit/wisp.ts), here with nothing to read, so it plays.
//
// What it does. It slips out of the big ghost in the hero (or in from an edge, on screens without one) and
// treats the page as somewhere to explore: it perches on the top edges of the things on it (the title, the
// example window and its tabs, the code, the section headings), bobs a moment, settles with its eyes closed,
// and after a while hops to another perch. It lives on the page: scrolling carries it along with what it's
// sitting on. Now and then it wanders off the edge of the screen and comes
// back somewhere else. It is shy: bring the pointer near and it darts away to a perch far from you; chase it
// and it hides off screen for a bit before sneaking back. On a touch screen, tap near it to shoo it.
//
// What it must never do. Get between you and the page: it never perches on a button or link, never sits on
// text (only on top edges, in the space above), never darts about while you're heading for the call to
// action, and its canvas ignores the pointer. Nor cost anything for the page: it is loaded after the page is
// idle (and not at all with Save-Data or reduced motion: here it is play, not help), draws only while it
// moves, and stops when the tab is hidden.

import { prefersStill, viewWidth, WispBody, type Point } from "../shared/wisp-body.ts";

/** Where it likes to perch: the visible things on the splash page, in rough reading order. */
const PERCHES = [
  ".splash h1",
  ".showcase h2",
  ".showcase-tabs",
  ".showcase-window",
  ".splash-fact h3",
  ".splash-grid h2",
  ".splash-self h2",
  ".splash-self .splash-code",
].join(",");
const RADIUS = 6;
/** Springs (stiffness per s²): a floaty flight, a quick dart away, a firm landing. */
const SPRING = { flying: 55, fleeing: 95, perched: 140 } as const;
/** How near the pointer may come before it darts (px), how many darts in a while make it hide, and a breather between darts. */
const SHY = 110;
const CHASED = { darts: 3, withinMs: 8000 };
const DART_COOLDOWN_MS = 700;
/** Where the pointer is on its way to the call to action: no darting here, so the wisp never distracts from it. */
const QUIET_ZONE = ".splash-actions";
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
  /** Nothing moves (or draws) until it has come out. */
  let started = false;
  let lastDart = 0;
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
    return r.width > 24 && r.top > 40 && r.top < innerHeight - 40 && r.left > -1 && r.right < viewWidth() + 1;
  };
  const perchPoint = (p: Perch): Point | null => {
    if (!p.el.isConnected) return null;
    const r = p.el.getBoundingClientRect();
    return { x: r.left + r.width * p.u + scrollX, y: r.top - RADIUS - 0.5 + scrollY };
  };
  const candidates = () => [...document.querySelectorAll(PERCHES)].filter(visible);

  function choosePerch(prefer?: (p: Point) => number): Perch | null {
    const options = candidates().map((el) => ({ el, u: 0.15 + Math.random() * 0.7 })).filter((p) => p.el !== perch?.el);
    if (!options.length) return null;
    if (!prefer) return options[Math.floor(Math.random() * options.length)]!;
    return options.map((p) => ({ p, score: prefer(perchPoint(p)!) + Math.random() * 80 })).sort((a, b) => b.score - a.score)[0]!.p;
  }

  /** A spot just past the nearest edge (or the edge away from `from`), in page coordinates. */
  function offscreen(from?: Point): Point {
    const h = { x: body.head.x - scrollX, y: body.head.y - scrollY };
    const side = from ? (from.x < h.x ? "right" : "left") : h.x < viewWidth() / 2 ? "left" : "right";
    return { x: (side === "left" ? -40 : viewWidth() + 40) + scrollX, y: Math.min(innerHeight - 60, Math.max(60, h.y + (Math.random() - 0.5) * 120)) + scrollY };
  }
  /** While away it waits beside the screen, not the page: scrolling moves its hiding spot along. */
  let lastScroll = { x: scrollX, y: scrollY };

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
    if (!started || raf || document.hidden) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function frame(now: number) {
    raf = 0;
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    clock += dt;
    const dsx = scrollX - lastScroll.x;
    const dsy = scrollY - lastScroll.y;
    lastScroll = { x: scrollX, y: scrollY };
    if (state === "away") {
      body.shift(dsx, dsy);
      if (away) away = { x: away.x + dsx, y: away.y + dsy };
    }
    // The perch scrolled away: find another, or wander off.
    if (perch && state !== "away" && !visible(perch.el)) {
      perch = choosePerch((p) => -Math.hypot(p.x - body.head.x, p.y - body.head.y));
      if (!perch) goAway();
      else state = "flying";
    }
    const g = goal();
    const k = SPRING[state === "away" ? "flying" : state];
    body.step(dt, g, k, RADIUS);
    // Landed: there and slowed down (not just passing through on an overshoot).
    if ((state === "flying" || state === "fleeing") && Math.hypot(g.x - body.head.x, g.y - body.head.y) < 1.5 && Math.hypot(body.vel.x, body.vel.y) < 80) {
      state = "perched";
      landedAt = clock;
      schedule(between(PERCH_FOR), wander);
    }
    body.draw({ x: -scrollX, y: -scrollY }, clock);
    const screenX = body.head.x - scrollX;
    const resting = state === "perched" && clock - landedAt > BOB_FOR && body.settled(g, RADIUS);
    const gone = state === "away" && (screenX < -30 || screenX > viewWidth() + 30) && body.settled(g, RADIUS);
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
    const sx = at.x - scrollX;
    body.place({ x: (sx < viewWidth() / 2 ? -30 : viewWidth() + 30) + scrollX, y: Math.min(innerHeight - 40, Math.max(40, at.y - scrollY + 60)) + scrollY });
    flyTo(p);
  }

  /** Time to move on: usually to another perch nearby, sometimes off for a wander. */
  function wander() {
    if (Math.random() < 0.25) return goAway();
    flyTo(choosePerch((p) => -Math.abs(Math.hypot(p.x - body.head.x, p.y - body.head.y) - 320)));
  }

  /** Something came too close: dart to the far side, or hide if it keeps happening. */
  function startle(screen: Point) {
    const now = performance.now();
    // One dart per approach: not while it's already darting off, nor again a moment later.
    if (state === "away" || state === "fleeing" || now - lastDart < DART_COOLDOWN_MS) return;
    lastDart = now;
    const from = { x: screen.x + scrollX, y: screen.y + scrollY };
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

  /** Near enough to startle, and not on the way to the call to action. */
  const near = (e: PointerEvent, reach: number) => {
    if (!started || state === "away") return false;
    const zone = document.querySelector(QUIET_ZONE)?.getBoundingClientRect();
    if (zone && e.clientX > zone.left - 40 && e.clientX < zone.right + 40 && e.clientY > zone.top - 40 && e.clientY < zone.bottom + 40) return false;
    return Math.hypot(e.clientX - (body.head.x - scrollX), e.clientY - (body.head.y - scrollY)) < reach;
  };
  const onMove = (e: PointerEvent) => e.pointerType === "mouse" && near(e, SHY) && startle({ x: e.clientX, y: e.clientY });
  const onTap = (e: PointerEvent) => e.pointerType !== "mouse" && near(e, SHY * 0.8) && startle({ x: e.clientX, y: e.clientY });
  addEventListener("pointermove", onMove, { passive: true });
  addEventListener("pointerdown", onTap, { passive: true });
  addEventListener("scroll", wake, { passive: true });
  addEventListener("resize", wake);
  document.addEventListener("visibilitychange", wake);
  body.observe(wake);
  // Reduced motion switched on mid-visit: it goes home for good.
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const stop = () => {
    if (!still.matches) return;
    started = false;
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    removeEventListener("pointermove", onMove);
    removeEventListener("pointerdown", onTap);
    removeEventListener("scroll", wake);
    removeEventListener("resize", wake);
    document.removeEventListener("visibilitychange", wake);
    still.removeEventListener("change", stop);
    body.dispose();
  };
  still.addEventListener("change", stop);

  // Out it comes: from the big ghost when there is one on screen, otherwise in from an edge.
  started = true;
  lastScroll = { x: scrollX, y: scrollY };
  const ghost = document.querySelector(".splash-ghost");
  const r = ghost?.getBoundingClientRect();
  if (r && r.width && visible(ghost!)) {
    const from = { x: r.left + r.width / 2 + scrollX, y: r.top + r.height * 0.45 + scrollY };
    body.place(from, { x: -60, y: -380 });
    body.radius = 2;
    flyTo(choosePerch((p) => -Math.hypot(p.x - from.x, p.y - from.y)));
  } else comeBack();
}

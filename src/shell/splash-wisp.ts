// The splash page's wisp: the same little ghost of moon light that reads along with Listen
// (src/kit/wisp.ts), here with nothing to read, so it plays.
//
// What it is. A small, shy creature that lives in the empty spaces of the page. The page is a maze to it:
// the text, buttons and cards are walls, and it runs only on the clear background between them, round
// corners and through gaps, never across a word (src/shared/wisp-nav.ts finds its way). Its canvas sits
// behind the page, so the cards are things it can duck behind: it slips behind the example window, the
// terminal or the big ghost, and peeks out round an edge with one eye showing before it dares come out.
//
// What it does. It comes out of the big ghost in the hero (peeking over its head first) or, on screens
// without one, peeks in from the side of the screen. Then it potters: it scurries to a nook (it likes
// corners, tucked against a card or under a heading), lands with a little squash and bob, settles with its
// eyes closed, and after a while sets off again; sometimes it stops halfway to look around, sometimes it
// hides and peeks, sometimes it wanders off the edge of the screen and comes back later somewhere else. It
// lives on the page: scrolling carries it along, and if you scroll away from it, it catches up.
//
// How it is with you. Shy but curious. Bring the pointer close and it crouches and leans away; closer, and
// it bolts, by a route that keeps clear of you, to a far nook or behind a card. Peeking, it ducks back.
// Chase it about and it runs off the screen for a while. Leave the pointer still and it may creep a little
// closer, until you move. On a touch screen, tap near it to shoo it.
//
// What it must never do. Get between you and the page: it never crosses text, buttons or links, never rests
// beside the call to action or reacts to a pointer on its way there, and its canvas ignores the pointer.
// Nor cost anything for the page: it is loaded after the page is idle (and not at all with Save-Data or
// reduced motion: here it is play, not help), draws only while it moves, and stops when the tab is hidden.

import { prefersStill, viewWidth, WispBody, type Point } from "../shared/wisp-body.ts";
import { densify, inflate, NavGrid, PathFollower, rectDistance, type Avoid, type Pace, type Rect } from "../shared/wisp-nav.ts";

const RADIUS = 6;
/** How far its centre keeps from anything on the page when it can (its body and some air)... */
const CLEARANCE = RADIUS + 11;
/** ...and the least it ever comes to it, rounding a corner. */
const HARD = RADIUS + 4;

/** The page's walls: blocks of text (each line counts, so it can use the space a short line leaves)... */
const TEXT = "h1, h2, h3, p, li, .splash-foot";
/** ...and whole things: anything you can press, and the cards. */
const SOLID = ".bar, .button, .splash-notice, .showcase-tabs, .showcase-toggle, .showcase-window, .splash-code, .splash-ghost, iframe, img";
/** Opaque things above its canvas it can hide behind. */
const COVERS = ".showcase-window, .splash-code, .splash-ghost";
/** Hairline rules (their top borders): it may cross one, but would rather go round. */
const RULES = ".splash-fact, .splash-self, .splash-foot";
/** Where the pointer is on its way to the call to action: no reacting here, and no resting nearby. */
const QUIET_ZONE = ".splash-actions";

/** The big ghost (src/shell/icons/logo.svg) as fractions of its box: where to peek round it, and its middle. */
const GHOST_PEEKS = [
  { u: 0.5, v: 0.022, n: { x: 0, y: -1 } },
  { u: 0.111, v: 0.45, n: { x: -1, y: 0 } },
  { u: 0.889, v: 0.45, n: { x: 1, y: 0 } },
];
const GHOST_MIDDLE = { u: 0.5, v: 0.6 };
/** How deep behind a card it hides (px past the edge): out of sight, glow and all. */
const DEPTH = 30;

/** How it moves: a potter, a careful creep, a bolt. */
const PACE = {
  stroll: { cruise: 230, accel: 700, lateral: 1100 },
  sneak: { cruise: 110, accel: 380, lateral: 700 },
  scurry: { cruise: 640, accel: 2800, lateral: 3400 },
} satisfies Record<string, Pace>;

/** How near the pointer may come before it bolts (px), and where it starts to notice. */
const SHY = 120;
const NOTICE = 240;
/** How many bolts in a while send it off the screen, and a breather between bolts. */
const CHASED = { darts: 3, withinMs: 8000 };
const DART_COOLDOWN_MS = 700;
/** Seconds: a rest, the bob after landing, hiding, a peek, a pause to look round, time away. */
const REST_FOR = [4, 10] as const;
const BOB_FOR = 2.2;
const HIDE_FOR = [2.5, 6] as const;
const PEEK_FOR = [1.2, 2.6] as const;
const LOOK_FOR = [0.5, 1.1] as const;
const AWAY_FOR = [4, 9] as const;

type Mode = "away" | "moving" | "resting" | "hidden" | "peeking";
/** Something on the page and where it is (page px). */
type Thing = { r: Rect; el: Element };
type Nav = { grid: NavGrid; things: Thing[] };
/**
 * A place to hide and peek from: behind a card (or off the side of the screen), the spot just round its
 * edge where one eye shows, and clear ground outside. Worked out afresh each time, so it follows the page.
 */
type Hole = { el: Element | null; inside(): Point | null; peek(): Point | null; out(): Point | null };
/** A move under way, and how to plan it again from where it is if the page reflows under it (false: can't). */
type Leg = { f: PathFollower; then: () => void; fleeing: boolean; replan?: () => boolean };

const between = ([a, b]: readonly [number, number]) => a + Math.random() * (b - a);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const pageRect = (r: DOMRect | Rect): Rect => ({ left: r.left + scrollX, top: r.top + scrollY, right: r.right + scrollX, bottom: r.bottom + scrollY });

/** Lines of text from a range's boxes: the boxes on one line merged into one. */
function lines(boxes: DOMRectList): Rect[] {
  const out: Rect[] = [];
  for (const b of [...boxes].filter((b) => b.width > 0.5 && b.height > 0.5).sort((a, b) => a.top - b.top)) {
    const same = out.find((l) => Math.min(l.bottom, b.bottom) - Math.max(l.top, b.top) > Math.min(l.bottom - l.top, b.height) * 0.5);
    if (same) {
      same.left = Math.min(same.left, b.left);
      same.right = Math.max(same.right, b.right);
      same.top = Math.min(same.top, b.top);
      same.bottom = Math.max(same.bottom, b.bottom);
    } else out.push({ left: b.left, top: b.top, right: b.right, bottom: b.bottom });
  }
  return out;
}

export function startSplashWisp() {
  if (prefersStill()) return;
  const body = new WispBody("splash-wisp", { light: "--moon", ink: "--bg" });
  body.radius = RADIUS;
  /** Nothing moves (or draws) until it has come out. */
  let started = false;
  let mode: Mode = "away";
  let leg: Leg | null = null;
  let hole: Hole | null = null;
  let spot: Point | null = null;
  let bobbing = false;
  let landedAt = 0;
  /** Where it rested lately, so it doesn't keep going back to the same nook. */
  let recent: Point[] = [];
  let timer = 0;
  let raf = 0;
  let last = 0;
  let clock = 0;
  let darts: number[] = [];
  let lastDart = 0;
  /** The pointer, on the screen, when it last moved, and whether it's a mouse (that can hover). */
  let pointer: { x: number; y: number; t: number; mouse: boolean } | null = null;
  /** Bumped when the page reflows, so the maze is redrawn. */
  let layout = 0;
  let cache: { key: string; nav: Nav } | null = null;

  const onScreen = (p: Point, inset = 0) => {
    const x = p.x - scrollX;
    const y = p.y - scrollY;
    return x >= inset && x <= viewWidth() - inset && y >= inset && y <= innerHeight - inset;
  };
  const pointerAt = (): Point | null => (pointer ? { x: pointer.x + scrollX, y: pointer.y + scrollY } : null);
  const quiet = () => {
    const el = document.querySelector(QUIET_ZONE);
    return el ? pageRect(el.getBoundingClientRect()) : null;
  };

  /** The maze around the screen (and a little past it, so it can come and go): what's solid, what's soft. */
  function nav(): Nav {
    const vw = viewWidth();
    const key = [scrollX, scrollY, vw, innerHeight, layout].join();
    if (cache?.key === key) return cache.nav;
    const bounds: Rect = {
      left: scrollX - 80,
      right: scrollX + vw + 80,
      top: Math.max(0, scrollY - 420),
      bottom: Math.min(document.documentElement.scrollHeight, scrollY + innerHeight + 420),
    };
    const things: Thing[] = [];
    const keep = (r: DOMRect | Rect, el: Element) => {
      const p = pageRect(r);
      if (p.right - p.left < 0.5 || p.bottom - p.top < 0.5) return;
      if (p.right < bounds.left || p.left > bounds.right || p.bottom < bounds.top || p.top > bounds.bottom) return;
      things.push({ r: p, el });
    };
    for (const el of document.querySelectorAll(SOLID)) if (!el.parentElement?.closest(SOLID)) keep(el.getBoundingClientRect(), el);
    const range = document.createRange();
    for (const el of document.querySelectorAll(TEXT)) {
      if (el.closest(SOLID)) continue;
      range.selectNodeContents(el);
      // A list item's bullet is drawn in its padding, left of the text: that's part of the line too.
      const from = el.tagName === "LI" ? el.getBoundingClientRect().left : Infinity;
      for (const line of lines(range.getClientRects())) keep({ ...line, left: Math.min(line.left, from) }, el);
    }
    const soft: Rect[] = [];
    for (const el of document.querySelectorAll(RULES)) {
      const r = pageRect(el.getBoundingClientRect());
      if (r.right > r.left) soft.push({ ...r, bottom: r.top + 1 });
    }
    const q = quiet();
    if (q) soft.push(inflate(q, 36));
    // Right off the screen is for coming and going, not a short cut.
    soft.push({ ...bounds, right: scrollX - 8 }, { ...bounds, left: scrollX + vw + 8 });
    const grid = new NavGrid(bounds, things.map((t) => t.r), { clearance: CLEARANCE, soft });
    cache = { key, nav: { grid, things } };
    return cache.nav;
  }

  /** How far `p` is from anything on the page except `cover` (the card it's peeking round) and what's in it. */
  function clearOf(n: Nav, p: Point, cover: Element | null) {
    let best = Infinity;
    for (const t of n.things) if (!cover || (t.el !== cover && !cover.contains(t.el))) best = Math.min(best, rectDistance(t.r, p));
    return best;
  }

  /** A place behind `el`, at fraction (u, v) of its box on the edge facing `n`. */
  function coverHole(el: Element, u: number, v: number, n: Point, middle?: { u: number; v: number }): Hole {
    const at = (fu: number, fv: number) => {
      if (!el.isConnected) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.left + r.width * fu + scrollX, y: r.top + r.height * fv + scrollY };
    };
    // Over the top it shows a little more, so its eyes clear the edge.
    const show = n.y < 0 ? RADIUS * 0.4 : RADIUS * 0.12;
    const off = (by: number) => {
      const p = at(u, v);
      return p && { x: p.x + n.x * by, y: p.y + n.y * by };
    };
    // Clear ground is measured from the box, not the edge it peeks round (the big ghost is rounder than its box).
    const out = () => {
      const r = el.getBoundingClientRect();
      const p = at(u, v);
      if (!p) return null;
      const toBox = n.x < 0 ? p.x - (r.left + scrollX) : n.x > 0 ? r.right + scrollX - p.x : n.y < 0 ? p.y - (r.top + scrollY) : r.bottom + scrollY - p.y;
      return off(toBox + CLEARANCE + 12);
    };
    return { el, inside: () => (middle ? at(middle.u, middle.v) : off(-DEPTH)), peek: () => off(show), out };
  }

  function coverHoles(el: Element): Hole[] {
    if (el.matches(".splash-ghost")) return GHOST_PEEKS.map((p) => coverHole(el, p.u, p.v, p.n, GHOST_MIDDLE));
    const t = () => 0.25 + Math.random() * 0.5;
    return [
      coverHole(el, 0, t(), { x: -1, y: 0 }),
      coverHole(el, 1, t(), { x: 1, y: 0 }),
      coverHole(el, t(), 0, { x: 0, y: -1 }),
      coverHole(el, t(), 1, { x: 0, y: 1 }),
    ];
  }

  /** Off the side of the screen at height `y` (page px), peeking in. Follows the screen as the page scrolls. */
  function edgeHole(side: "left" | "right", y: number): Hole {
    const top = scrollY;
    const at = (by: number) => ({ x: side === "left" ? scrollX + by : scrollX + viewWidth() - by, y: y - top + scrollY });
    return { el: null, inside: () => at(-30), peek: () => at(RADIUS * 0.12), out: () => at(2) };
  }

  /** It can peek from here now: on screen, with clear ground outside, its eye clear of everything else. */
  function usable(h: Hole, n: Nav): boolean {
    const peek = h.peek();
    const out = h.out();
    if (!peek || !out || !onScreen(peek, h.el ? 24 : -1) || peek.y - scrollY < 48 || peek.y - scrollY > innerHeight - 24) return false;
    // The whole way from its peek to clear ground keeps clear of everything but the card itself.
    // (The grid's open cells are a cautious estimate: the last step onto one is checked exactly here.)
    const ground = n.grid.nearestOpen(out);
    if (!ground || dist(ground, out) > 24) return false;
    return densify([peek, out, ground], 2).every((p) => clearOf(n, p, h.el) >= HARD);
  }

  function allHoles(n: Nav): Hole[] {
    return [...document.querySelectorAll(COVERS)].filter((el) => !el.parentElement?.closest(COVERS)).flatMap(coverHoles).filter((h) => usable(h, n));
  }

  /**
   * Nooks on screen: clear spots snug against something (it likes corners best), away from the call to
   * action and from where it was lately, best first by `score` (null rules one out).
   */
  function nooks(n: Nav, score: (p: Point) => number | null, count = 8): Point[] {
    const { grid } = n;
    const q = quiet();
    const found: { p: Point; s: number }[] = [];
    const reach = CLEARANCE + 12;
    const wall = (p: Point, dx: number, dy: number) => grid.room({ x: p.x + dx * reach, y: p.y + dy * reach }) < 2;
    for (let y = scrollY + 56; y < scrollY + innerHeight - 22; y += 12) {
      for (let x = scrollX + 22; x < scrollX + viewWidth() - 22; x += 12) {
        const p = grid.snap({ x, y });
        const room = grid.room(p);
        if (room < CLEARANCE || room > CLEARANCE + 18 || !onScreen(p, 20)) continue;
        if (q && rectDistance(q, p) < 70) continue;
        if (recent.some((r) => dist(r, p) < 70)) continue;
        const s = score(p);
        if (s === null) continue;
        const corner = (wall(p, -1, 0) || wall(p, 1, 0)) && (wall(p, 0, -1) || wall(p, 0, 1));
        found.push({ p, s: s + (corner ? 1.2 : 0) + Math.random() * 0.9 });
      }
    }
    return found.sort((a, b) => b.s - a.s).slice(0, count).map((f) => f.p);
  }

  /** Away from the pointer, if there's one about. */
  function shyOf(p: Point, from = 220): boolean {
    const at = pointerAt();
    return !at || !pointer || performance.now() - pointer.t > 8000 || dist(p, at) > from;
  }

  // Movement.

  function schedule(seconds: number, then: () => void) {
    clearTimeout(timer);
    timer = window.setTimeout(then, seconds * 1000);
  }

  /** Sets off along `path` from wherever it is now, keeping its speed if it's going that way anyway. */
  function travel(path: Point[], pace: Pace, then: () => void, fleeing = false, replan?: () => boolean): void {
    const from = body.head;
    const pts = [...densify([from, path[0]!], 3), ...path.slice(1)];
    let start = 0;
    const speed = Math.hypot(body.vel.x, body.vel.y);
    const ahead = pts.find((p) => dist(p, from) > 6);
    if (mode === "moving" && speed > 1 && ahead) {
      const d = dist(ahead, from);
      start = speed * Math.max(0, ((ahead.x - from.x) * body.vel.x + (ahead.y - from.y) * body.vel.y) / (d * speed));
    }
    leg = { f: new PathFollower(pts, pace, start), then, fleeing, replan };
    mode = "moving";
    clearTimeout(timer);
    body.upright = false;
    wake();
  }

  /**
   * Plans a way from where it is to `dest` (or, `into` a hole, to the clear ground outside it and then behind
   * the card) and sets off. False if there's no way. Planned again if the page reflows on the way.
   */
  function goTo(dest: Point, pace: Pace, then: () => void, opts: { avoid?: Avoid; into?: Hole; fleeing?: boolean } = {}): boolean {
    const n = nav();
    const out = opts.into ? opts.into.out() : dest;
    const inside = opts.into?.inside();
    if (!out || (opts.into && !inside)) return false;
    const path = n.grid.path(body.head, out, HARD, opts.avoid);
    if (!path) return false;
    const full = inside ? [...path, ...densify([out, inside], 3).slice(1)] : path;
    travel(full, pace, then, opts.fleeing, () => goTo(dest, pace, then, opts));
    return true;
  }

  /** Is it out of sight, so it may be put somewhere else without anyone seeing it jump? */
  function unseen(): boolean {
    if (mode === "away" || !onScreen(body.head, -RADIUS * 3)) return true;
    if (mode !== "hidden" || !hole?.el?.isConnected) return false;
    const r = pageRect(hole.el.getBoundingClientRect());
    return r.right > r.left && body.head.x > r.left + RADIUS * 2 && body.head.x < r.right - RADIUS * 2 && body.head.y > r.top + RADIUS * 2 && body.head.y < r.bottom - RADIUS * 2;
  }

  /** Arrived somewhere to rest: a squash as it lands, a bob, then still. */
  function rest(at: Point, bob = true): void {
    mode = "resting";
    spot = { ...at };
    hole = null;
    landedAt = clock;
    bobbing = bob;
    body.upright = true;
    if (bob) {
      body.squash = 0.16;
      recent = [at, ...recent].slice(0, 4);
    }
    if (!onScreen(at, -RADIUS)) schedule(between([0.6, 1.8]), regroup);
    else schedule(between(REST_FOR), wander);
    wake();
  }

  function hideIn(h: Hole): void {
    mode = "hidden";
    hole = h;
    schedule(between(HIDE_FOR), peekOut);
    wake();
  }

  /** Creeps from behind `h` to its edge, and looks. */
  function peekFrom(h: Hole): void {
    const inside = h.inside();
    const peek = h.peek();
    if (!inside || !peek) return comeBack();
    hole = h;
    travel(densify([inside, peek], 3), PACE.sneak, () => {
      mode = "peeking";
      body.upright = true;
      landedAt = clock;
      schedule(h.el ? between(PEEK_FOR) : between([0.8, 1.8]), comeOut);
    });
  }

  /** Back behind whatever it was peeking round, quick. */
  function duck(): void {
    const h = hole;
    const inside = h?.inside();
    if (!h || !inside) {
      hole = null;
      return leave();
    }
    travel(densify([body.head, inside], 3), PACE.scurry, () => {
      if (h.el) return hideIn(h);
      mode = "away";
      schedule(between(AWAY_FOR), comeBack);
    }, true);
  }

  /** Hidden a while: peek out again, round the same edge or another (it's out of sight, so it can just be there). */
  function peekOut(): void {
    if (document.hidden) return schedule(2, peekOut);
    const n = nav();
    const options = hole?.el ? coverHoles(hole.el).filter((h) => usable(h, n)) : [];
    if (!options.length || !unseen()) {
      hole = null;
      if (!unseen()) return leave();
      mode = "away";
      return comeBack();
    }
    const h = options[Math.floor(Math.random() * options.length)]!;
    body.place(h.inside()!);
    peekFrom(h);
  }

  /** Done peeking: out to a nook, unless someone's right there. */
  function comeOut(): void {
    const h = hole;
    const peek = h?.peek();
    const out = h?.out();
    if (!h || !peek || !out) {
      hole = null;
      return wander();
    }
    if (!shyOf(peek, 200)) return duck();
    const n = nav();
    for (const nook of nooks(n, (p) => (shyOf(p) && dist(p, out) > 60 ? -Math.abs(dist(p, out) - 260) / 260 : null), 4)) {
      const path = n.grid.path(out, nook, HARD, avoidPointer());
      if (!path) continue;
      hole = null;
      const home = () => rest(nook);
      return travel([...densify([peek, out], 3), ...path], PACE.stroll, home, false, () => goTo(nook, PACE.stroll, home));
    }
    duck();
  }

  /** Off the side of the screen for a while (running from `from`, if it was chased). */
  function leave(from?: Point): void {
    const n = nav();
    const vw = viewWidth();
    const nearer = body.head.x - scrollX < vw / 2 ? "left" : "right";
    const first = from ? (from.x < body.head.x ? "right" : "left") : nearer;
    for (const side of [first, first === "left" ? "right" : "left"] as const) {
      for (const dy of [0, -90, 90, -180, 180]) {
        const target = { x: side === "left" ? scrollX - 45 : scrollX + vw + 45, y: clamp(body.head.y + dy, scrollY + 60, scrollY + innerHeight - 60) };
        const gone = () => {
          mode = "away";
          schedule(between(AWAY_FOR), comeBack);
        };
        if (goTo(target, from ? PACE.scurry : PACE.stroll, gone, { avoid: from && { p: from, r: SHY + 20 }, fleeing: !!from })) return;
      }
    }
    if (from) flee(from, false);
    // Nowhere to go: try again in a while.
    else if (mode !== "moving") schedule(between(REST_FOR), wander);
  }

  /** Back from away: in from the side of the screen nearest a nook it fancies, peeking first. */
  function comeBack(): void {
    if (document.hidden || !started) return schedule(2, comeBack);
    // Never pops from one place to another in plain sight.
    if (!unseen()) return leave();
    const n = nav();
    const vw = viewWidth();
    for (const nook of nooks(n, (p) => (shyOf(p, 260) ? 0 : null), 4)) {
      const side = nook.x - scrollX < vw / 2 ? "left" : "right";
      for (const dy of [0, -60, 60, -120, 120]) {
        const h = edgeHole(side, clamp(nook.y + dy, scrollY + 70, scrollY + innerHeight - 50));
        if (!usable(h, n) || !shyOf(h.peek()!, 200)) continue;
        if (!n.grid.path(h.out()!, nook, HARD)) continue;
        body.place(h.inside()!);
        return peekFrom(h);
      }
    }
    mode = "away";
    schedule(between(AWAY_FOR), comeBack);
  }

  /** The page scrolled away from it: catch up if it's near, otherwise come back from the side. */
  function regroup(): void {
    if (mode === "moving" || mode === "away" || document.hidden) return;
    const inside = hole?.inside();
    if (mode === "hidden" || mode === "peeking") {
      // Peeking in from the side of the screen, it's where the screen is anyway.
      if (hole && !hole.el) return;
      if (inside && onScreen(inside, 40)) return mode === "hidden" ? schedule(between(HIDE_FOR), peekOut) : schedule(0.5, comeOut);
      mode = "away";
      return comeBack();
    }
    if (onScreen(body.head, 10)) return schedule(between(REST_FOR), wander);
    const n = nav();
    if (n.grid.room(body.head) >= HARD) {
      const near = nooks(n, (p) => -dist(p, body.head) / 400);
      for (const nook of near.slice(0, 4)) if (goTo(nook, PACE.stroll, () => rest(nook))) return;
    }
    mode = "away";
    comeBack();
  }

  const avoidPointer = (): Avoid | undefined => {
    const at = pointerAt();
    return at && pointer && performance.now() - pointer.t < 4000 ? { p: at, r: SHY } : undefined;
  };

  /** Time to move on: potter to another nook, hide, creep up on a still pointer, or wander off a while. */
  function wander(): void {
    if (document.hidden) return schedule(3, wander);
    const n = nav();
    const r = Math.random();
    const at = pointerAt();
    const curious = at && pointer?.mouse && performance.now() - pointer.t > 2500 && onScreen(at, 0);
    if (curious && r < 0.3) {
      for (const nook of nooks(n, (p) => (dist(p, at) > 140 && dist(p, at) < 250 ? 1 - Math.abs(dist(p, at) - 180) / 100 : null), 4)) {
        if (goTo(nook, PACE.sneak, () => rest(nook), { avoid: { p: at, r: SHY } })) return;
      }
    }
    if (r < 0.48) {
      const options = allHoles(n).filter((h) => shyOf(h.out()!, 240) && dist(h.out()!, body.head) > 40);
      for (const h of options.sort(() => Math.random() - 0.5).slice(0, 3)) {
        if (goTo(h.out()!, PACE.stroll, () => hideIn(h), { avoid: avoidPointer(), into: h })) return;
      }
    }
    if (r > 0.92) return leave();
    for (const nook of nooks(n, (p) => (shyOf(p) && dist(p, body.head) > 110 ? 1 - Math.abs(dist(p, body.head) - 320) / 320 : null), 4)) {
      const path = n.grid.path(body.head, nook, HARD, avoidPointer());
      if (!path) continue;
      const home = () => rest(nook);
      const again = () => goTo(nook, PACE.stroll, home, { avoid: avoidPointer() });
      // Now and then it stops partway to look around, then carries on (planned afresh: the page may have moved).
      const half = Math.floor(path.length * (0.4 + Math.random() * 0.2));
      if (path.length > 120 && Math.random() < 0.3) {
        return travel(path.slice(0, half + 1), PACE.stroll, () => {
          rest(path[half]!, false);
          schedule(between(LOOK_FOR), () => {
            if (!again()) wander();
          });
        }, false, again);
      }
      return travel(path, PACE.stroll, home, false, again);
    }
    schedule(between(REST_FOR), wander);
  }

  /** Bolt from `from`: behind a card if there's one handy, else to a far nook, else off the screen. */
  function flee(from: Point, mayLeave = true): void {
    const n = nav();
    const avoid = { p: from, r: SHY + 20 };
    if (Math.random() < 0.45) {
      for (const h of allHoles(n).filter((h) => dist(h.out()!, from) > 240).slice(0, 3)) {
        if (goTo(h.out()!, PACE.scurry, () => hideIn(h), { avoid, into: h, fleeing: true })) return;
      }
    }
    for (const nook of nooks(n, (p) => (dist(p, from) > 260 ? Math.min(1, dist(p, from) / 600) - dist(p, body.head) / 1200 : null), 4)) {
      if (goTo(nook, PACE.scurry, () => rest(nook), { avoid, fleeing: true })) return;
    }
    if (mayLeave) leave(from);
  }

  /** The pointer came too close: bolt, duck, or (chased once too often) leave. */
  function startle(from: Point): void {
    const now = performance.now();
    if (now - lastDart < DART_COOLDOWN_MS || (mode === "moving" && leg?.fleeing)) return;
    lastDart = now;
    darts = [...darts.filter((t) => now - t < CHASED.withinMs), now];
    // Peeking, or creeping out to peek: back behind it.
    if (mode === "peeking" || (mode === "moving" && hole)) return duck();
    if (darts.length >= CHASED.darts) {
      darts = [];
      return leave(from);
    }
    flee(from);
  }

  // Each frame.

  /** How near the pointer is, 0 (not noticed) to 1 (about to bolt), and which way is away from it. */
  function wary(): { k: number; away: Point } {
    const at = pointerAt();
    if (!at || !pointer?.mouse) return { k: 0, away: { x: 0, y: 0 } };
    const d = Math.max(1, dist(body.head, at));
    const k = clamp((NOTICE - d) / (NOTICE - SHY), 0, 1);
    return { k, away: { x: (body.head.x - at.x) / d, y: (body.head.y - at.y) / d } };
  }

  /** Where it means to be when not travelling. */
  function target(): Point {
    if (mode === "peeking") return hole?.peek() ?? body.head;
    // Hidden, it stays put (it's out of sight: no need to follow the big ghost's drift).
    if (mode === "hidden") return body.head;
    if (mode !== "resting" || !spot) return body.head;
    const t = clock - landedAt;
    const bob = bobbing && t < BOB_FOR ? Math.sin(t * 5) * 2.2 * (1 - t / BOB_FOR) : 0;
    // It leans away from a pointer it has noticed.
    const { k, away } = wary();
    return { x: spot.x + away.x * 3 * k, y: spot.y + bob + away.y * 3 * k };
  }

  /** Inside a frame: wake() leaves the scheduling to the frame itself, so only one loop ever runs. */
  let inFrame = false;
  function wake() {
    if (!started || raf || inFrame || document.hidden) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function frame(now: number) {
    raf = 0;
    inFrame = true;
    try {
      step(now);
    } finally {
      inFrame = false;
    }
  }

  const trace = globalThis as { __wispTrace?: object[] };

  function step(now: number) {
    const dt = clamp((now - last) / 1000, 0.001, 0.05);
    last = now;
    clock += dt;
    let goal: Point | null = null;
    if (mode === "moving" && leg) {
      const { pos, vel, done } = leg.f.advance(dt);
      body.follow(pos, vel, dt, RADIUS);
      if (done) {
        const then = leg.then;
        leg = null;
        then();
      }
    } else {
      goal = target();
      body.step(dt, goal, mode === "peeking" ? 220 : 160, RADIUS);
    }
    // Squashed as it lands, then crouched low when a pointer it has noticed is near.
    const crouch = mode === "resting" ? wary().k * 0.12 : 0;
    body.squash += (crouch - body.squash) * (1 - Math.exp(-dt / 0.09));
    if (Math.abs(body.squash - crouch) < 0.003) body.squash = crouch;
    // Peeking in from the side of the screen it is pinned there; everywhere else it rides with the page.
    body.draw(clock, (mode === "peeking" || mode === "hidden") && !!hole && !hole.el);
    trace.__wispTrace?.push({ t: now, x: body.head.x, y: body.head.y, mode, sx: scrollX, sy: scrollY });
    const busy =
      mode === "moving" ||
      mode === "peeking" ||
      (mode === "resting" && bobbing && clock - landedAt < BOB_FOR) ||
      body.squash !== crouch ||
      !body.settled(goal ?? body.head, RADIUS);
    if (busy && !document.hidden) raf = requestAnimationFrame(frame);
  }

  // The pointer, the page and the tab.

  /** Near enough to react, and not on the way to the call to action. */
  function react(e: PointerEvent, reach: number) {
    if (!started || mode === "away" || mode === "hidden") return;
    const d = Math.hypot(e.clientX - (body.head.x - scrollX), e.clientY - (body.head.y - scrollY));
    if (d >= NOTICE + 40) return;
    const zone = document.querySelector(QUIET_ZONE)?.getBoundingClientRect();
    if (zone && e.clientX > zone.left - 40 && e.clientX < zone.right + 40 && e.clientY > zone.top - 40 && e.clientY < zone.bottom + 40) return;
    if (d < reach) startle({ x: e.clientX + scrollX, y: e.clientY + scrollY });
    else wake();
  }
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    pointer = { x: e.clientX, y: e.clientY, t: performance.now(), mouse: true };
    react(e, SHY);
  };
  const onTap = (e: PointerEvent) => {
    if (e.pointerType === "mouse") return;
    pointer = { x: e.clientX, y: e.clientY, t: performance.now(), mouse: false };
    react(e, SHY * 1.2);
  };
  const onLeave = () => {
    pointer = null;
    wake();
  };
  let scrolled = 0;
  const onScroll = () => {
    wake();
    clearTimeout(scrolled);
    scrolled = window.setTimeout(() => {
      if (mode === "resting" || mode === "hidden" || mode === "peeking") {
        if (mode !== "resting" && hole && !hole.el) return;
        const at = mode === "resting" ? body.head : hole?.inside();
        if (!at || !onScreen(at, mode === "resting" ? -RADIUS : 40)) schedule(between([0.6, 2]), regroup);
      }
    }, 900);
  };
  let reflowed = 0;
  const onLayout = () => {
    layout++;
    wake();
    clearTimeout(reflowed);
    // Something moved onto its nook: find another.
    reflowed = window.setTimeout(() => {
      if (mode === "resting" && spot && nav().grid.distanceAt(spot) < HARD) wander();
      // The card it was behind (or peeking round) is gone: off it goes.
      if ((mode === "hidden" || mode === "peeking") && hole?.el && !hole.inside()) {
        hole = null;
        leave();
      }
    }, 400);
    // On its way: plan the rest of the way afresh at once, so it never follows a path across text that moved.
    if (mode === "moving" && leg?.replan && !leg.replan()) leave();
  };
  addEventListener("pointermove", onMove, { passive: true });
  addEventListener("pointerdown", onTap, { passive: true });
  document.documentElement.addEventListener("pointerleave", onLeave);
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onLayout);
  document.addEventListener("visibilitychange", wake);
  body.observe(onLayout);
  // Reduced motion switched on mid-visit: it goes home for good.
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const stop = () => {
    if (!still.matches) return;
    started = false;
    clearTimeout(timer);
    clearTimeout(scrolled);
    clearTimeout(reflowed);
    cancelAnimationFrame(raf);
    removeEventListener("pointermove", onMove);
    removeEventListener("pointerdown", onTap);
    document.documentElement.removeEventListener("pointerleave", onLeave);
    removeEventListener("scroll", onScroll);
    removeEventListener("resize", onLayout);
    document.removeEventListener("visibilitychange", wake);
    still.removeEventListener("change", stop);
    body.dispose();
  };
  still.addEventListener("change", stop);

  // Out it comes: from behind the big ghost when there's one on screen (over its head first), otherwise
  // peeking in from the side of the screen.
  started = true;
  const ghost = document.querySelector(".splash-ghost");
  const first = ghost && ghost.getBoundingClientRect().width ? coverHoles(ghost).filter((h) => usable(h, nav())) : [];
  if (first.length) {
    body.place(first[0]!.inside()!);
    hideIn(first[0]!);
    schedule(0.5, () => peekFrom(first[0]!));
  } else comeBack();
}

// Watches the splash page's wisp for a while and scores it: does it ever touch text, how smooth is it, what
// does it get up to. Paste into the page's console (or evaluate it from a browser driver) once the page has
// loaded; it resolves with a report after `seconds`. It plays a visitor along the way: rests, chases the wisp
// with the pointer, leaves the pointer still, scrolls down and back up.
//
// Usage: await (PASTE)({ seconds: 70 })
async ({ seconds = 70, chase = true, scroll = true } = {}) => {
  const RADIUS = 6;
  const TEXT = "h1, h2, h3, p, li, .splash-foot";
  const SOLID = ".bar, .button, .splash-notice, .showcase-tabs, .showcase-toggle, .showcase-window, .splash-code, .splash-ghost, iframe, img";
  const COVERS = ".showcase-window, .splash-code, .splash-ghost";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  globalThis.__wispTrace = [];
  const trace = globalThis.__wispTrace;
  const t0 = performance.now();
  const elapsed = () => (performance.now() - t0) / 1000;
  const lastPoint = () => trace[trace.length - 1];
  const move = (x, y) => window.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, pointerType: "mouse", bubbles: true }));
  const events = [];

  // The visitor.
  while (!document.querySelector(".splash-wisp") && elapsed() < 10) await sleep(200);
  events.push({ at: elapsed(), what: "wisp canvas present" });
  await sleep(12000);
  if (chase) {
    for (let i = 0; i < 6; i++) {
      const p = lastPoint();
      if (p && p.mode !== "away" && p.mode !== "hidden") {
        const sx = p.x - scrollX;
        const sy = p.y - scrollY;
        // Come at it from 320 px away in 16 steps.
        const fx = sx + 320 * Math.cos(i);
        const fy = sy + 320 * Math.sin(i);
        events.push({ at: elapsed(), what: `chase from ${Math.round(fx)},${Math.round(fy)} to ${Math.round(sx)},${Math.round(sy)} (${p.mode})` });
        for (let k = 0; k <= 16; k++) {
          move(fx + ((sx - fx) * k) / 16, fy + ((sy - fy) * k) / 16);
          await sleep(25);
        }
      }
      await sleep(2500);
    }
    // The pointer rests somewhere open, for curiosity.
    move(innerWidth * 0.8, innerHeight * 0.55);
    events.push({ at: elapsed(), what: "pointer still" });
    await sleep(14000);
  }
  if (scroll) {
    for (let i = 0; i < 3; i++) {
      window.scrollBy(0, innerHeight * 0.7);
      events.push({ at: elapsed(), what: `scrolled to ${Math.round(scrollY)}` });
      await sleep(7000);
    }
    window.scrollTo(0, 0);
    events.push({ at: elapsed(), what: "back to top" });
  }
  while (elapsed() < seconds) await sleep(500);
  globalThis.__wispTrace = undefined;

  // The page, in page px.
  const page = (r) => ({ left: r.left + scrollX, top: r.top + scrollY, right: r.right + scrollX, bottom: r.bottom + scrollY });
  const walls = [];
  for (const el of document.querySelectorAll(SOLID)) if (!el.parentElement?.closest(SOLID) && !el.matches(COVERS)) walls.push(page(el.getBoundingClientRect()));
  const range = document.createRange();
  for (const el of document.querySelectorAll(TEXT)) {
    if (el.closest(SOLID)) continue;
    range.selectNodeContents(el);
    const from = el.tagName === "LI" ? el.getBoundingClientRect().left : Infinity;
    for (const b of range.getClientRects()) if (b.width > 0.5 && b.height > 0.5) walls.push(page({ left: Math.min(b.left, from), top: b.top, right: b.right, bottom: b.bottom }));
  }
  const covers = [...document.querySelectorAll(COVERS)].map((el) => page(el.getBoundingClientRect())).filter((r) => r.right > r.left);
  const gap = (r, p) => Math.hypot(Math.max(r.left - p.x, 0, p.x - r.right), Math.max(r.top - p.y, 0, p.y - r.bottom));
  const inside = (r, p, by) => p.x > r.left + by && p.x < r.right - by && p.y > r.top + by && p.y < r.bottom - by;

  let visible = 0;
  let over = 0;
  let close = 0;
  let nearest = Infinity;
  const overAt = [];
  const modes = {};
  const story = [];
  for (const f of trace) {
    modes[f.mode] = (modes[f.mode] ?? 0) + 1;
    if (story.at(-1)?.mode !== f.mode) story.push({ mode: f.mode, at: +((f.t - trace[0].t) / 1000).toFixed(1) });
    const onScreen = f.x - f.sx > -RADIUS && f.x - f.sx < innerWidth + RADIUS && f.y - f.sy > -RADIUS && f.y - f.sy < innerHeight + RADIUS;
    // Wholly behind a card, it can't be over anything.
    if (!onScreen || covers.some((c) => inside(c, f, RADIUS))) continue;
    visible++;
    const d = Math.min(...walls.map((w) => gap(w, f)));
    nearest = Math.min(nearest, d);
    if (d < RADIUS) {
      over++;
      if (overAt.length < 12) overAt.push({ t: +((f.t - trace[0].t) / 1000).toFixed(2), x: Math.round(f.x), y: Math.round(f.y), mode: f.mode, d: +d.toFixed(1) });
    } else if (d < RADIUS + 3) close++;
  }

  // Smoothness while moving: velocity and acceleration from a quadratic fit over five frames (frame times
  // jitter), and one-frame spikes in the change of acceleration (what reads as a jolt).
  const fit = (i) => {
    const lo = Math.max(0, i - 2);
    const hi = Math.min(trace.length - 1, i + 2);
    const t0 = trace[i].t / 1000;
    let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, X0 = 0, X1 = 0, X2 = 0, Y0 = 0, Y1 = 0, Y2 = 0;
    for (let k = lo; k <= hi; k++) {
      const u = trace[k].t / 1000 - t0;
      const u2 = u * u;
      S0 += 1; S1 += u; S2 += u2; S3 += u2 * u; S4 += u2 * u2;
      X0 += trace[k].x; X1 += trace[k].x * u; X2 += trace[k].x * u2;
      Y0 += trace[k].y; Y1 += trace[k].y * u; Y2 += trace[k].y * u2;
    }
    const det = S0 * (S2 * S4 - S3 * S3) - S1 * (S1 * S4 - S3 * S2) + S2 * (S1 * S3 - S2 * S2);
    const solve = (A0, A1, A2) => {
      if (Math.abs(det) < 1e-18) return { b: 0, c: 0 };
      return {
        b: (S0 * (A1 * S4 - S3 * A2) - A0 * (S1 * S4 - S3 * S2) + S2 * (S1 * A2 - A1 * S2)) / det,
        c: (S0 * (S2 * A2 - A1 * S3) - S1 * (S1 * A2 - A1 * S2) + A0 * (S1 * S3 - S2 * S2)) / det,
      };
    };
    const fx = solve(X0, X1, X2);
    const fy = solve(Y0, Y1, Y2);
    return { v: Math.hypot(fx.b, fy.b), ax: 2 * fx.c, ay: 2 * fy.c };
  };
  const d = trace.map((_, i) => fit(i));
  let jolts = 0;
  let maxSpeed = 0;
  let teleports = 0;
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1];
    const b = trace[i];
    // A jump on screen while visible (placing it while hidden or away is fine).
    const shown = (f) =>
      f.mode !== "hidden" && f.mode !== "away" && !covers.some((c) => inside(c, f, RADIUS)) &&
      f.x - f.sx > -RADIUS && f.x - f.sx < innerWidth + RADIUS && f.y - f.sy > -RADIUS && f.y - f.sy < innerHeight + RADIUS;
    if (shown(a) && shown(b) && b.t - a.t < 40 && Math.hypot(b.x - a.x, b.y - a.y) > 40) teleports++;
  }
  for (let i = 3; i + 1 < trace.length; i++) {
    if (trace[i].mode !== "moving" || trace[i].t - trace[i - 1].t > 40 || trace[i + 1].t - trace[i].t > 40 || trace[i - 1].t - trace[i - 2].t > 40) continue;
    maxSpeed = Math.max(maxSpeed, d[i].v);
    const da = (k) => Math.hypot(d[k].ax - d[k - 1].ax, d[k].ay - d[k - 1].ay);
    if (da(i) > 4000 && da(i) > 2.5 * Math.max(da(i - 1), da(i + 1))) jolts++;
  }
  return {
    seconds: +elapsed().toFixed(1),
    frames: trace.length,
    visibleFrames: visible,
    overText: over,
    within3pxOfText: close,
    nearestToText: +nearest.toFixed(1),
    overAt,
    teleports,
    jolts,
    maxSpeed: Math.round(maxSpeed),
    modes,
    story: story.slice(0, 80),
    events,
    viewport: `${innerWidth}x${innerHeight}`,
  };
};

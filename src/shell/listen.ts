// Listen: reads the artifact aloud in the ghost's voice. The frame gathers the
// page's readable text (src/kit/speak.ts); a worker on this origin turns each
// sentence into audio on this device, with the time each word is heard
// (src/tts/worker.ts); this file is the tray under the page and the playback.
// Speech is media the reader asked for, not a feedback cue, so it plays
// through an <audio> element and ignores the Sounds setting. Nothing here
// costs anything while nobody listens: the model is a cached static asset and
// the worker only starts on the first Listen.
import type { ShellMessage, SpeakUnit } from "../shared/protocol.ts";
import type { FromWorker, TimedWord, ToWorker } from "../tts/types.ts";

/** Playback rates on top of the voice's own pace (Listen's 1× is already a little brisk). */
const RATES = [0.75, 0.9, 1, 1.25, 1.5, 1.75, 2];
const RATE_KEY = "art:listen:rate";
const HINT_KEY = "art:listen:hinted";
/**
 * Long sentences are said in pieces of about this many characters (split at commas, then spaces), so the first
 * sound comes quickly, a jump never waits behind a long one, and the model doesn't drift.
 */
const MAX_CHARS = 160;
/** What the tray takes from a page, at most: beyond this a page is read up to here. */
const MAX_UNITS = 5000;
const MAX_UNIT_CHARS = 20_000;
const MAX_TOTAL_CHARS = 1_000_000;
/** Sentences made ahead of the one playing. */
const AHEAD = 2;
/** The wisp leaves this early (seconds of real time) so it lands as the word begins. */
const WISP_LEAD = 0.08;
/** Short waits don't announce themselves: a status that flashes for a moment is noise. */
const QUIET_MS = 400;

type Sentence = { unit: number; start: number; text: string; h?: string };
type Made = { url: string; words: TimedWord[] };
type State = "loading" | "collecting" | "buffering" | "playing" | "paused" | "ended" | "empty" | "error";

const svg = (body: string, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
const ICON = {
  play: svg(`<path fill="currentColor" d="M8.5 5.6v12.8a1 1 0 0 0 1.52.85l10.2-6.4a1 1 0 0 0 0-1.7L10.02 4.75A1 1 0 0 0 8.5 5.6Z"/>`, 20),
  pause: svg(`<path fill="currentColor" d="M7 5.5A1.5 1.5 0 0 1 8.5 4h1A1.5 1.5 0 0 1 11 5.5v13A1.5 1.5 0 0 1 9.5 20h-1A1.5 1.5 0 0 1 7 18.5zM13 5.5A1.5 1.5 0 0 1 14.5 4h1A1.5 1.5 0 0 1 17 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-1a1.5 1.5 0 0 1-1.5-1.5z"/>`, 20),
  replay: svg(`<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 12a8 8 0 1 0 2.35-5.65M4 4v4h4"/>`, 20),
  prev: svg(`<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M17 6.5 9.5 12l7.5 5.5zM6.5 6v12"/>`),
  next: svg(`<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="m7 6.5 7.5 5.5L7 17.5zM17.5 6v12"/>`),
  slower: svg(`<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 12h12"/>`, 16),
  faster: svg(`<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 12h12M12 6v12"/>`, 16),
  close: svg(`<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>`),
};

function splitSentences(units: SpeakUnit[]): Sentence[] {
  const seg = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("en", { granularity: "sentence" }) : null;
  const out: Sentence[] = [];
  for (const u of units) {
    const parts = seg
      ? [...seg.segment(u.text)].map((s) => ({ index: s.index, segment: s.segment }))
      : [...u.text.matchAll(/[^.!?]+[.!?]*\s*/g)].map((m) => ({ index: m.index!, segment: m[0] }));
    for (const { index, segment } of parts) {
      const lead = segment.length - segment.trimStart().length;
      const text = segment.trim();
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      const at = index + lead;
      if (text.length <= MAX_CHARS) {
        out.push({ unit: u.i, start: at, text, h: u.h });
        continue;
      }
      // Too long: break after commas, semicolons and dashes (and at spaces when a clause is itself too long),
      // packing pieces up to the limit.
      let line = "";
      let lineAt = at;
      let offset = at;
      const pieces = text.split(/(?<=[,;:—])\s+/).flatMap((p) => (p.length <= MAX_CHARS ? [p] : (p.match(new RegExp(`.{1,${MAX_CHARS}}(?:\\s+|$)|\\S+`, "gs")) ?? [p]).map((x) => x.trim()).filter(Boolean)));
      for (const piece of pieces) {
        const pieceAt = u.text.indexOf(piece, offset);
        offset = pieceAt + piece.length;
        if (line && line.length + piece.length + 1 > MAX_CHARS) {
          out.push({ unit: u.i, start: lineAt, text: line, h: u.h });
          line = "";
        }
        if (!line) lineAt = pieceAt;
        line = u.text.slice(lineAt, pieceAt + piece.length);
      }
      if (line) out.push({ unit: u.i, start: lineAt, text: line, h: u.h });
    }
  }
  return out;
}

const mb = (n: number) => `${Math.round(n / 1e6)}`;
const rateLabel = (r: number) => `${r}×`;

function readRate(): number {
  const r = Number(load(RATE_KEY));
  return RATES.includes(r) ? r : 1;
}

export function listenSupported(): boolean {
  return typeof WebAssembly === "object" && typeof Worker === "function" && typeof Audio === "function";
}

/** localStorage, which can throw (blocked storage) and must never take the shell down with it. */
function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // blocked or full: the choice lasts for this page only
  }
}

export function createListen(opts: { title: string; apex: string; post: (msg: ShellMessage) => void; host: HTMLElement; trigger: HTMLButtonElement }) {
  // ---- the tray ------------------------------------------------------------------------
  const tray = document.createElement("section");
  tray.className = "listen";
  tray.hidden = true;
  tray.setAttribute("aria-label", "Listen");
  tray.innerHTML = `
<div class="listen-track" role="progressbar" aria-label="Reading progress" aria-valuemin="0"><div class="listen-fill"></div></div>
<span class="listen-ghost" aria-hidden="true"><img src="/static/icons/logo.svg" alt="" width="28" height="28"></span>
<div class="listen-now"><span class="listen-where"></span><span class="listen-line"><span class="listen-state" role="status"></span> <span class="listen-detail" aria-hidden="true"></span></span></div>
<div class="listen-deck">
  <div class="listen-speed" role="group" aria-label="Speed">
    <button type="button" class="listen-icon listen-slower" aria-label="Slower">${ICON.slower}</button>
    <output class="listen-rate" aria-label="Speed"></output>
    <button type="button" class="listen-icon listen-faster" aria-label="Faster">${ICON.faster}</button>
  </div>
  <div class="listen-controls">
    <button type="button" class="listen-icon listen-prev" aria-label="Previous sentence" title="Previous sentence">${ICON.prev}</button>
    <button type="button" class="listen-play">
      <svg class="listen-ring" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22.5" pathLength="100"></circle></svg>
      <span class="listen-glyph"></span>
    </button>
    <button type="button" class="listen-icon listen-next" aria-label="Next sentence" title="Next sentence">${ICON.next}</button>
  </div>
</div>
<button type="button" class="listen-icon listen-close" aria-label="Stop listening" title="Stop listening">${ICON.close}</button>`;
  opts.host.append(tray);
  const $ = <T extends Element>(sel: string) => tray.querySelector<T>(sel)!;
  const fill = $<HTMLElement>(".listen-fill");
  const where = $<HTMLElement>(".listen-where");
  const stateEl = $<HTMLElement>(".listen-state");
  const detail = $<HTMLElement>(".listen-detail");
  const track = $<HTMLElement>(".listen-track");
  const play = $<HTMLButtonElement>(".listen-play");
  const glyph = $<HTMLElement>(".listen-glyph");
  const ring = $<SVGCircleElement>(".listen-ring circle");
  const prev = $<HTMLButtonElement>(".listen-prev");
  const next = $<HTMLButtonElement>(".listen-next");
  const slower = $<HTMLButtonElement>(".listen-slower");
  const faster = $<HTMLButtonElement>(".listen-faster");
  const rateOut = $<HTMLOutputElement>(".listen-rate");
  const close = $<HTMLButtonElement>(".listen-close");

  // ---- state ---------------------------------------------------------------------------
  const audio = new Audio();
  audio.preload = "auto";
  let rate = readRate();
  let worker: Worker | null = null;
  let ready = false;
  let download: { loaded: number; total: number } | null = null;
  let sentences: Sentence[] = [];
  let at = 0;
  let state: State = "loading";
  let errorText = "";
  let nextId = 1;
  /** Bumped whenever what should be playing changes; stale results are dropped. */
  let generation = 0;
  /** The sentence audio now in the element, and which sentence it is. */
  let current: (Made & { i: number }) | null = null;
  /** The reader wants it playing (false after Pause, until Play). */
  let wantPlay = true;
  /** Sentences that failed in a row. */
  let failures = 0;
  let word = -1;
  let quietTimer = 0;
  let quiet = true;
  /** The first time anyone listens on this device, the tray says once that tapping a paragraph starts there. */
  let hinting = false;
  /** A speak:collect is out; only its answer is taken (a frame can't push text unasked). */
  let collectPending = false;
  const made = new Map<number, { id: number; result: Promise<Made> }>();
  const waiting = new Map<number, { resolve: (m: Made) => void; reject: (e: Error) => void }>();

  /** Play can't do anything until there is something to read; it says why instead. */
  const playBlocked = () => state === "empty" || ((state === "loading" || state === "collecting") && !sentences.length);

  function paint() {
    tray.dataset.state = state;
    const busy = state === "loading" || state === "collecting" || state === "buffering";
    const speaking = state === "playing";
    const blocked = playBlocked();
    const icon = blocked ? ICON.play : speaking || busy ? ICON.pause : state === "ended" ? ICON.replay : ICON.play;
    if (glyph.dataset.icon !== icon) {
      glyph.innerHTML = icon;
      glyph.dataset.icon = icon;
    }
    const label =
      state === "empty" ? "Nothing to read" : blocked ? "Getting the voice ready" : speaking || busy ? "Pause" : state === "ended" ? "Read again" : "Play";
    play.setAttribute("aria-label", label);
    play.title = label;
    play.setAttribute("aria-disabled", String(blocked));
    play.setAttribute("aria-busy", String(busy));
    // The ring: download progress while the voice arrives, a spinner while waiting, nothing otherwise.
    const determinate = state === "loading" && download && download.total > 0 ? download.loaded / download.total : null;
    tray.toggleAttribute("data-spinning", busy && determinate === null && !quiet);
    ring.style.strokeDashoffset = determinate === null ? "" : String(100 - determinate * 100);
    tray.toggleAttribute("data-progress", determinate !== null);
    prev.disabled = !sentences.length || at <= 0;
    next.disabled = !sentences.length || at >= sentences.length - 1;
    const done = at + (state === "ended" ? 1 : 0);
    fill.style.transform = `scaleX(${sentences.length ? done / sentences.length : 0})`;
    track.setAttribute("aria-valuemax", String(sentences.length));
    track.setAttribute("aria-valuenow", String(done));
    track.setAttribute("aria-valuetext", sentences.length ? `Sentence ${Math.min(done + 1, sentences.length)} of ${sentences.length}` : "Not started");
    const s = sentences[at];
    const heading = s?.h ?? opts.title;
    if (where.textContent !== heading) where.textContent = heading;
    // The live region changes only when what it says changes, so a repaint never re-announces it.
    const text = stateText();
    if (stateEl.textContent !== text) stateEl.textContent = text;
    const numbers = state === "loading" && !quiet && download?.total && !ready ? `${mb(download.loaded)} of ${mb(download.total)} MB` : "";
    if (detail.textContent !== numbers) detail.textContent = numbers;
    tray.toggleAttribute("data-quiet", !text);
    const i = RATES.indexOf(rate);
    rateOut.textContent = rateLabel(rate);
    slower.disabled = i <= 0;
    faster.disabled = i >= RATES.length - 1;
    slower.title = i <= 0 ? "Slower (this is the slowest)" : "Slower";
    faster.title = i >= RATES.length - 1 ? "Faster (this is the fastest)" : "Faster";
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = speaking ? "playing" : state === "paused" ? "paused" : "none";
  }

  function stateText(): string {
    switch (state) {
      case "loading":
        if (download && download.total && !ready && !quiet) return "Getting the voice ready, only this once:";
        return quiet ? "" : "Getting ready…";
      case "collecting":
        return quiet ? "" : "Getting ready…";
      case "buffering":
        return quiet ? "" : "Catching up…";
      case "playing":
        return hinting ? "Tap any paragraph to start there" : "";
      case "paused":
        return "Paused";
      case "ended":
        return "Finished";
      case "empty":
        return "There's nothing to read on this page";
      case "error":
        return errorText;
      default:
        return "";
    }
  }

  /** Enter a state; waiting states stay quiet for a moment so quick ones don't flash. */
  function set(next: State) {
    if (next === "playing" && state !== "playing" && !load(HINT_KEY)) {
      store(HINT_KEY, "1");
      hinting = true;
      setTimeout(() => {
        hinting = false;
        paint();
      }, 6000);
    }
    state = next;
    clearTimeout(quietTimer);
    quiet = next === "loading" || next === "collecting" || next === "buffering";
    if (quiet) {
      quietTimer = window.setTimeout(() => {
        quiet = false;
        paint();
      }, QUIET_MS);
    }
    paint();
  }

  // ---- the speech worker ---------------------------------------------------------------
  const send = (msg: ToWorker) => worker?.postMessage(msg);
  const voiceFailed = () => fail(navigator.onLine ? "Couldn't get the voice ready." : "You're offline, so the voice couldn't load.");

  function startWorker() {
    clearTimeout(idleTimer);
    if (worker) return;
    worker = new Worker(`/static/tts-worker.js${new URL(import.meta.url).search}`, { type: "module" });
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const msg = e.data;
      if (msg.t === "progress") {
        download = msg;
        if (state === "loading") paint();
      } else if (msg.t === "ready") {
        ready = true;
        download = null;
        paint();
      } else if (msg.t === "audio") {
        const w = waiting.get(msg.id);
        waiting.delete(msg.id);
        const url = URL.createObjectURL(new Blob([msg.wav], { type: "audio/wav" }));
        if (w) w.resolve({ url, words: msg.words });
        else URL.revokeObjectURL(url);
      } else if (msg.t === "error") {
        if (msg.id === undefined) return voiceFailed();
        const w = waiting.get(msg.id);
        waiting.delete(msg.id);
        w?.reject(Object.assign(new Error(msg.message), { fatal: msg.fatal }));
      }
    };
    worker.onerror = (e) => {
      e.preventDefault();
      stopWorker();
      fail("The voice stopped working.");
    };
    send({ t: "load", base: opts.apex });
  }

  function stopWorker() {
    worker?.terminate();
    worker = null;
    ready = false;
    for (const w of waiting.values()) w.reject(Object.assign(new Error("stopped"), { fatal: true }));
    waiting.clear();
    forget();
  }

  function fail(text: string) {
    errorText = text;
    generation++;
    cancelAnimationFrame(raf);
    audio.pause();
    current = null;
    // Nothing queued keeps running (or re-downloading) behind the error.
    forget();
    retry.hidden = false;
    set("error");
    // Keyboard users land on the way forward.
    if (document.activeElement === play) retry.focus();
  }

  // An error offers one way forward, beside the message.
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "listen-retry";
  retry.textContent = "Try again";
  retry.hidden = true;
  stateEl.parentElement!.after(retry);
  retry.addEventListener("click", () => {
    retry.hidden = true;
    failures = 0;
    startWorker();
    if (sentences.length) return void playAt(at);
    // The page never answered: ask again.
    set(ready ? "collecting" : "loading");
    collect();
  });

  function audioFor(i: number): Promise<Made> {
    let entry = made.get(i);
    if (!entry) {
      const id = nextId++;
      const result = new Promise<Made>((resolve, reject) => waiting.set(id, { resolve, reject }));
      result.catch(() => made.get(i)?.id === id && made.delete(i));
      entry = { id, result };
      made.set(i, entry);
      send({ t: "synth", id, text: sentences[i]!.text });
    }
    return entry.result;
  }

  /** Forget made audio and drop what's still queued. */
  function forget() {
    for (const { result } of made.values()) result.then((m) => URL.revokeObjectURL(m.url), () => {});
    made.clear();
    send({ t: "cancel", before: nextId });
  }

  // ---- playback ------------------------------------------------------------------------
  /** One sentence the model couldn't say is skipped; several in a row means something is wrong. */
  function skipFailed(i: number) {
    failures++;
    if (failures >= 3) return fail("Couldn't read this page aloud.");
    if (i + 1 < sentences.length) void playAt(i + 1);
    else finish();
  }

  function finish() {
    cancelAnimationFrame(raf);
    markWord(-1);
    set("ended");
    opts.post({ t: "speak:at", i: null });
  }

  async function playAt(i: number) {
    if (!sentences.length) return;
    i = Math.max(0, Math.min(sentences.length - 1, i));
    const mine = ++generation;
    wantPlay = true;
    startWorker();
    // Whatever was playing stops now, so it can't be resumed under the new sentence.
    cancelAnimationFrame(raf);
    audio.pause();
    current = null;
    const moved = i !== at;
    at = i;
    retry.hidden = true;
    markWord(-1);
    opts.post({ t: "speak:at", i: sentences[i]!.unit });
    // Jumping makes everything queued for the old place useless.
    if (moved) send({ t: "cancel", before: made.get(i)?.id ?? nextId });
    for (let k = i; k < Math.min(sentences.length, i + 1 + AHEAD); k++) void audioFor(k).catch(() => {});
    // Let go of audio well behind or ahead of us.
    for (const [k, { result }] of made) {
      if (k < i - 1 || k > i + AHEAD + 4) {
        result.then((m) => URL.revokeObjectURL(m.url), () => {});
        made.delete(k);
      }
    }
    set(ready ? "buffering" : "loading");
    let m: Made;
    try {
      m = await audioFor(i);
    } catch (err) {
      if (mine !== generation) return;
      const e = err as Error & { fatal?: boolean };
      if (e.message === "cancelled") return void playAt(i);
      if (e.fatal) return voiceFailed();
      return skipFailed(i);
    }
    if (mine !== generation) return;
    current = { ...m, i };
    word = -1;
    audio.src = m.url;
    audio.playbackRate = rate;
    audio.preservesPitch = true;
    try {
      await audio.play();
      if (mine !== generation) return;
      failures = 0;
      set("playing");
      follow();
    } catch (err) {
      if (mine !== generation) return;
      // Autoplay refused (the tap that opened Listen has expired): wait for the reader. Anything else is a bad clip.
      if ((err as DOMException).name === "NotAllowedError") set("paused");
      else skipFailed(i);
    }
  }

  /** Marks the word being heard, every frame while playing. */
  let raf = 0;
  function follow() {
    cancelAnimationFrame(raf);
    const tick = () => {
      if (state !== "playing" || !current) return;
      // Looking slightly ahead (in audio time, so it holds at any speed).
      const t = audio.currentTime + WISP_LEAD * rate;
      const words = current.words;
      let k = word >= 0 && words[word] && words[word]!.t0 <= t ? word : 0;
      while (k + 1 < words.length && words[k + 1]!.t0 <= t) k++;
      const on = words[k] && words[k]!.t0 <= t ? k : -1;
      if (on !== word) markWord(on);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function markWord(k: number) {
    word = k;
    const s = current ? sentences[current.i] : undefined;
    const w = k >= 0 ? current?.words[k] : undefined;
    if (!s || !w) return opts.post({ t: "speak:word", i: null, start: 0, end: 0 });
    // The hop takes at most most of the word, so the wisp is resting by the time the next one comes.
    const hop = Math.round(((w.t1 - w.t0) / rate) * 1000 * 0.8);
    opts.post({ t: "speak:word", i: s.unit, start: s.start + w.s, end: s.start + w.e, hop });
  }

  const ours = () => current !== null && current.i === at && audio.src === current.url;
  audio.addEventListener("ended", () => {
    if (state !== "playing" || !ours()) return;
    if (at + 1 < sentences.length) void playAt(at + 1);
    else finish();
  });
  audio.addEventListener("error", () => {
    if ((state === "playing" || state === "paused") && ours()) skipFailed(at);
  });
  // Paused or resumed from elsewhere (headphones, the lock screen, another app taking the audio).
  audio.addEventListener("pause", () => {
    if (state === "playing" && !audio.ended && ours()) {
      generation++;
      wantPlay = false;
      set("paused");
    }
  });
  audio.addEventListener("play", () => {
    if (state === "paused" && ours()) {
      wantPlay = true;
      set("playing");
      follow();
    }
  });

  function pause() {
    generation++;
    wantPlay = false;
    cancelAnimationFrame(raf);
    audio.pause();
    if (sentences.length) set("paused");
  }

  function resume() {
    if (state === "ended") return void playAt(0);
    if (!sentences.length) return;
    // Mid-sentence: carry on from the same spot.
    if (ours() && !audio.ended && audio.currentTime > 0) {
      const mine = ++generation;
      wantPlay = true;
      void audio.play().then(
        () => {
          if (mine !== generation) return;
          set("playing");
          follow();
        },
        () => mine === generation && set("paused"),
      );
    } else void playAt(at);
  }

  function setRate(r: number) {
    rate = r;
    store(RATE_KEY, String(r));
    audio.playbackRate = r;
    paint();
  }

  play.addEventListener("click", () => {
    if (playBlocked()) return;
    if (state === "playing" || state === "buffering" || state === "collecting" || state === "loading") pause();
    else resume();
  });
  prev.addEventListener("click", () => playAt(at - 1));
  next.addEventListener("click", () => playAt(at + 1));
  slower.addEventListener("click", () => setRate(RATES[Math.max(0, RATES.indexOf(rate) - 1)]!));
  faster.addEventListener("click", () => setRate(RATES[Math.min(RATES.length - 1, RATES.indexOf(rate) + 1)]!));
  close.addEventListener("click", () => closeTray());
  tray.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeTray();
    }
  });

  /** After Listen closes, the voice stays loaded a while for a quick reopen, then the worker goes and its memory with it. */
  const IDLE_MS = 2 * 60_000;
  let idleTimer = 0;

  function closeTray() {
    collectPending = false;
    clearTimeout(collectTimer);
    generation++;
    cancelAnimationFrame(raf);
    audio.pause();
    audio.removeAttribute("src");
    current = null;
    forget();
    sentences = [];
    markWord(-1);
    opts.post({ t: "speak:mode", on: false });
    tray.hidden = true;
    opts.trigger.setAttribute("aria-pressed", "false");
    opts.trigger.focus();
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
    }
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(stopWorker, IDLE_MS);
  }

  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", resume);
    navigator.mediaSession.setActionHandler("pause", pause);
    navigator.mediaSession.setActionHandler("previoustrack", () => void playAt(at - 1));
    navigator.mediaSession.setActionHandler("nexttrack", () => void playAt(at + 1));
  }

  /** A few milliseconds of silence, played inside the tap that opens Listen so iOS lets later sentences start on their own. */
  const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YQAAAAA=";
  /** If the page doesn't answer (its script failed, or it's still starting and missed the ask), say so. */
  const COLLECT_TIMEOUT_MS = 8000;
  let collectTimer = 0;

  function collect() {
    collectPending = true;
    opts.post({ t: "speak:mode", on: true });
    opts.post({ t: "speak:collect" });
    clearTimeout(collectTimer);
    collectTimer = window.setTimeout(() => {
      if (collectPending && !tray.hidden) fail("Couldn't read this page.");
    }, COLLECT_TIMEOUT_MS);
  }

  function open() {
    if (!tray.hidden) return void play.focus();
    audio.src = SILENCE;
    void audio.play().catch(() => {});
    current = null;
    at = 0;
    failures = 0;
    wantPlay = true;
    sentences = [];
    errorText = "";
    retry.hidden = true;
    tray.hidden = false;
    opts.trigger.setAttribute("aria-pressed", "true");
    set(ready ? "collecting" : "loading");
    startWorker();
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: opts.title, artist: "Listen", artwork: [{ src: "/static/icons/icon-512.png", sizes: "512x512", type: "image/png" }] });
    }
    collect();
    play.focus();
  }

  opts.trigger.addEventListener("click", () => (tray.hidden ? open() : closeTray()));

  return {
    /** The frame's readable text arrived: start where the reader is looking. */
    units(units: SpeakUnit[], start: number) {
      if (tray.hidden || !collectPending || !Array.isArray(units)) return;
      collectPending = false;
      clearTimeout(collectTimer);
      forget();
      // The frame is untrusted: take a bounded, well-formed page.
      let total = 0;
      const taken: SpeakUnit[] = [];
      for (const u of units.slice(0, MAX_UNITS)) {
        if (typeof u?.i !== "number" || typeof u.text !== "string") continue;
        const text = u.text.slice(0, MAX_UNIT_CHARS);
        total += text.length;
        if (total > MAX_TOTAL_CHARS) break;
        taken.push({ i: u.i, text, h: typeof u.h === "string" ? u.h.slice(0, 200) : undefined });
      }
      sentences = splitSentences(taken);
      if (!sentences.length) return set("empty");
      const first = Math.max(0, sentences.findIndex((s) => s.unit >= (Number(start) || 0)));
      // Paused while the page was being read: wait there instead of starting.
      if (!wantPlay) {
        at = first;
        opts.post({ t: "speak:at", i: sentences[first]!.unit });
        return set("paused");
      }
      void playAt(first);
    },
    /** The reader tapped a block. */
    jump(unit: number) {
      if (tray.hidden || !sentences.length) return;
      const i = sentences.findIndex((s) => s.unit === unit);
      if (i >= 0) void playAt(i);
    },
    /** The frame (re)started: if Listen is waiting on it, ask again. */
    frameReady() {
      if (!tray.hidden && collectPending) collect();
    },
  };
}

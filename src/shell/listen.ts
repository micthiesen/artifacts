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
/** Long sentences are split at commas so the first sound comes quickly and the model doesn't drift. */
const MAX_CHARS = 240;
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
      // Too long: break after commas, semicolons and dashes, packing pieces up to the limit.
      let line = "";
      let lineAt = at;
      let offset = at;
      for (const piece of text.split(/(?<=[,;:—])\s+/)) {
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
  const r = Number(localStorage.getItem(RATE_KEY));
  return RATES.includes(r) ? r : 1;
}

export function listenSupported(): boolean {
  return typeof WebAssembly === "object" && typeof Worker === "function" && typeof Audio === "function";
}

export function createListen(opts: { title: string; post: (msg: ShellMessage) => void; host: HTMLElement; trigger: HTMLButtonElement }) {
  // ---- the tray ------------------------------------------------------------------------
  const tray = document.createElement("section");
  tray.className = "listen";
  tray.hidden = true;
  tray.setAttribute("aria-label", "Listen");
  tray.innerHTML = `
<div class="listen-track" aria-hidden="true"><div class="listen-fill"></div></div>
<span class="listen-ghost" aria-hidden="true"><img src="/static/icons/logo.svg" alt="" width="28" height="28"></span>
<div class="listen-now"><span class="listen-where"></span><span class="listen-state" role="status"></span></div>
<div class="listen-deck">
  <div class="listen-speed" role="group" aria-label="Speed">
    <button type="button" class="listen-icon listen-slower">${ICON.slower}</button>
    <output class="listen-rate" aria-live="polite"></output>
    <button type="button" class="listen-icon listen-faster">${ICON.faster}</button>
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
  /** The sentence audio now in the element. */
  let current: Made | null = null;
  let word = -1;
  let quietTimer = 0;
  let quiet = true;
  const made = new Map<number, { id: number; result: Promise<Made> }>();
  const waiting = new Map<number, { resolve: (m: Made) => void; reject: (e: Error) => void }>();

  function paint() {
    tray.dataset.state = state;
    const busy = state === "loading" || state === "collecting" || state === "buffering";
    const speaking = state === "playing";
    glyph.innerHTML = state === "playing" || (busy && state !== "loading") ? ICON.pause : state === "ended" ? ICON.replay : ICON.play;
    const label = speaking || state === "buffering" || state === "collecting" ? "Pause" : state === "ended" ? "Read again" : "Play";
    play.setAttribute("aria-label", label);
    play.title = label;
    play.setAttribute("aria-busy", String(busy));
    // The ring: download progress while the voice arrives, a spinner while waiting, nothing otherwise.
    const determinate = state === "loading" && download && download.total > 0 ? download.loaded / download.total : null;
    tray.toggleAttribute("data-spinning", busy && determinate === null && !quiet);
    ring.style.strokeDashoffset = determinate === null ? "" : String(100 - determinate * 100);
    tray.toggleAttribute("data-progress", determinate !== null);
    prev.disabled = !sentences.length || at <= 0;
    next.disabled = !sentences.length || at >= sentences.length - 1;
    fill.style.transform = `scaleX(${sentences.length ? (at + (state === "ended" ? 1 : 0)) / sentences.length : 0})`;
    const s = sentences[at];
    where.textContent = s?.h ?? opts.title;
    stateEl.textContent = stateText();
    tray.toggleAttribute("data-quiet", !stateEl.textContent);
    const i = RATES.indexOf(rate);
    rateOut.textContent = rateLabel(rate);
    slower.disabled = i <= 0;
    faster.disabled = i >= RATES.length - 1;
    slower.setAttribute("aria-label", i <= 0 ? "Slower (already the slowest)" : `Slower, ${rateLabel(RATES[i - 1]!)}`);
    faster.setAttribute("aria-label", i >= RATES.length - 1 ? "Faster (already the fastest)" : `Faster, ${rateLabel(RATES[i + 1]!)}`);
    slower.title = slower.getAttribute("aria-label")!;
    faster.title = faster.getAttribute("aria-label")!;
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = speaking ? "playing" : state === "paused" ? "paused" : "none";
  }

  function stateText(): string {
    switch (state) {
      case "loading":
        if (download && download.total && !ready && !quiet) return `Getting the voice ready: ${mb(download.loaded)} of ${mb(download.total)} MB, only this once`;
        return quiet ? "" : "Getting ready…";
      case "collecting":
        return quiet ? "" : "Getting ready…";
      case "buffering":
        return quiet ? "" : "Catching up…";
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

  function startWorker() {
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
        w?.resolve({ url: URL.createObjectURL(new Blob([msg.wav], { type: "audio/wav" })), words: msg.words });
      } else if (msg.t === "error") {
        if (msg.id !== undefined) {
          const w = waiting.get(msg.id);
          waiting.delete(msg.id);
          w?.reject(Object.assign(new Error(msg.message), { fatal: msg.fatal }));
        } else fail(navigator.onLine ? "Couldn't get the voice ready." : "You're offline, so the voice couldn't load.");
      }
    };
    worker.onerror = (e) => {
      e.preventDefault();
      worker?.terminate();
      worker = null;
      ready = false;
      for (const w of waiting.values()) w.reject(Object.assign(new Error("worker"), { fatal: true }));
      waiting.clear();
      made.clear();
      fail("The voice stopped working.");
    };
    send({ t: "load" });
  }

  function fail(text: string) {
    errorText = text;
    generation++;
    audio.pause();
    set("error");
    retry.hidden = false;
  }

  // An error offers one way forward, beside the message.
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "listen-retry";
  retry.textContent = "Try again";
  retry.hidden = true;
  stateEl.after(retry);
  retry.addEventListener("click", () => {
    retry.hidden = true;
    startWorker();
    if (sentences.length) void playAt(at);
    else {
      set("loading");
      send({ t: "load" });
    }
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
  async function playAt(i: number) {
    if (!sentences.length) return;
    i = Math.max(0, Math.min(sentences.length - 1, i));
    const mine = ++generation;
    const moved = i !== at;
    at = i;
    retry.hidden = true;
    markWord(-1);
    opts.post({ t: "speak:at", i: sentences[i]!.unit });
    // Jumping far makes everything queued for the old place useless.
    if (moved) send({ t: "cancel", before: made.get(i)?.id ?? nextId });
    for (let k = i; k < Math.min(sentences.length, i + 1 + AHEAD); k++) void audioFor(k).catch(() => {});
    // Let go of audio well behind us.
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
      if (e.fatal) return fail(navigator.onLine ? "Couldn't get the voice ready." : "You're offline, so the voice couldn't load.");
      // One sentence the model couldn't say: skip it rather than stopping.
      return void playAt(i + 1 < sentences.length ? i + 1 : i);
    }
    if (mine !== generation) return;
    current = m;
    word = -1;
    audio.src = m.url;
    audio.playbackRate = rate;
    audio.preservesPitch = true;
    try {
      await audio.play();
      if (mine !== generation) return;
      set("playing");
      follow();
    } catch {
      if (mine !== generation) return;
      // Autoplay refused (the tap that opened Listen has expired): wait for the reader.
      set("paused");
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
    const s = sentences[at];
    const w = k >= 0 ? current?.words[k] : undefined;
    if (!s || !w) return opts.post({ t: "speak:word", i: null, start: 0, end: 0 });
    // The hop takes at most most of the word, so the wisp is resting by the time the next one comes.
    const hop = Math.round(((w.t1 - w.t0) / rate) * 1000 * 0.8);
    opts.post({ t: "speak:word", i: s.unit, start: s.start + w.s, end: s.start + w.e, hop });
  }

  audio.addEventListener("ended", () => {
    if (state !== "playing" || !current || audio.src !== current.url) return;
    if (at + 1 < sentences.length) void playAt(at + 1);
    else {
      markWord(-1);
      set("ended");
      opts.post({ t: "speak:at", i: null });
    }
  });
  // Paused or resumed from elsewhere (headphones, the lock screen, another app taking the audio).
  audio.addEventListener("pause", () => {
    if (state === "playing" && !audio.ended) {
      generation++;
      set("paused");
    }
  });
  audio.addEventListener("play", () => {
    if (state === "paused" && current && audio.src === current.url) {
      set("playing");
      follow();
    }
  });

  function pause() {
    generation++;
    audio.pause();
    set(sentences.length ? "paused" : state);
  }

  function resume() {
    if (state === "ended") return void playAt(0);
    if (!sentences.length) return;
    // Mid-sentence: carry on from the same spot.
    if (current && audio.src === current.url && !audio.ended && audio.currentTime > 0 && made.get(at)) {
      void audio.play().then(() => {
        set("playing");
        follow();
      }, () => set("paused"));
    } else void playAt(at);
  }

  function setRate(r: number) {
    rate = r;
    localStorage.setItem(RATE_KEY, String(r));
    audio.playbackRate = r;
    paint();
  }

  play.addEventListener("click", () => (state === "playing" || state === "buffering" || state === "collecting" ? pause() : resume()));
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

  function closeTray() {
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
  }

  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", resume);
    navigator.mediaSession.setActionHandler("pause", pause);
    navigator.mediaSession.setActionHandler("previoustrack", () => void playAt(at - 1));
    navigator.mediaSession.setActionHandler("nexttrack", () => void playAt(at + 1));
  }

  /** A few milliseconds of silence, played inside the tap that opens Listen so iOS lets later sentences start on their own. */
  const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YQAAAAA=";

  function open() {
    if (!tray.hidden) return void play.focus();
    audio.src = SILENCE;
    void audio.play().catch(() => {});
    current = null;
    at = 0;
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
    opts.post({ t: "speak:mode", on: true });
    opts.post({ t: "speak:collect" });
    play.focus();
  }

  opts.trigger.addEventListener("click", () => (tray.hidden ? open() : closeTray()));

  return {
    /** The frame's readable text arrived: start where the reader is looking. */
    units(units: SpeakUnit[], start: number) {
      if (tray.hidden) return;
      forget();
      sentences = splitSentences(units);
      if (!sentences.length) return set("empty");
      const first = sentences.findIndex((s) => s.unit >= start);
      void playAt(first < 0 ? 0 : first);
    },
    /** The reader tapped a block. */
    jump(unit: number) {
      const i = sentences.findIndex((s) => s.unit === unit);
      if (i >= 0) void playAt(i);
    },
  };
}

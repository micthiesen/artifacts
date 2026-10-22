// Listen: reads the artifact aloud in the ghost's voice. The frame gathers the
// page's readable text (src/kit/speak.ts); a worker on this origin turns each
// sentence into audio on this device, with the time each word is heard
// (src/tts/worker.ts); this file is the tray under the page and the playback.
// Speech is media the reader asked for, not a feedback cue, so it plays
// through an <audio> element and ignores the Sounds setting.
//
// Nothing here costs anything until someone listens: shell.ts creates this on
// the first press of the Listen button, the model is a cached static asset,
// and the worker shuts down a couple of minutes after the tray closes.
import type { ShellMessage, SpeakUnit } from "../shared/protocol.ts";
import { motionMs } from "../shared/motion.ts";
import type { FromWorker, TimedWord, ToWorker } from "../tts/types.ts";
import { splitSentences, takeUnits, type Sentence } from "./listen-text.ts";

/** Playback rates on top of the voice's own pace (Listen's 1× is already a little brisk). */
const RATES = [0.75, 0.9, 1, 1.25, 1.5, 1.75, 2];
const RATE_KEY = "art:listen:rate";
const HINT_KEY = "art:listen:hinted";
/** Sentences made ahead of the one playing. */
const AHEAD = 2;
/** The wisp sets off this early (seconds of real time) so it is landing as the word begins. */
const WISP_LEAD = 0.12;
/** Short waits don't announce themselves: a status that flashes for a moment is noise. */
const QUIET_MS = 400;
/** If the page doesn't answer (its script failed), say so rather than wait forever. */
const COLLECT_TIMEOUT_MS = 8000;
/** After the tray closes the voice stays loaded this long for a quick reopen, then the worker and its memory go. */
const IDLE_MS = 2 * 60_000;
/** Sentences that fail in a row before Listen gives up on the page. */
const MAX_FAILURES = 3;

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
  follow: svg(`<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M5 6h10M5 10h7M5 14h10M5 18h6M18.5 9v10M15.5 16l3 3 3-3"/>`, 18),
  close: svg(`<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>`),
};

/** localStorage, which can throw (blocked storage) and must never take the shell down with it. */
function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // blocked or full: the choice lasts for this page only
  }
}

/**
 * 50 ms of real silence, played inside the tap that opens Listen: iOS only lets an audio element start on its
 * own later if it has already played something in a gesture. Made as a blob (no data: URL in the CSP).
 */
function silence(): string {
  const samples = 1200;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 24000, true);
  v.setUint32(28, 48000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

const mb = (n: number) => `${Math.round(n / 1e6)}`;
const rateLabel = (r: number) => `${r}×`;

export function listenSupported(): boolean {
  return typeof WebAssembly === "object" && typeof Worker === "function" && typeof Audio === "function";
}

export type Listen = ReturnType<typeof createListen>;

export function createListen(opts: { title: string; apex: string; post: (msg: ShellMessage) => void; host: HTMLElement; trigger: HTMLButtonElement }) {
  // ---- the tray ------------------------------------------------------------------------
  const tray = document.createElement("section");
  tray.className = "listen";
  tray.hidden = true;
  tray.setAttribute("aria-label", "Listen");
  tray.innerHTML = `
<div class="listen-track" role="progressbar" aria-label="Reading progress" aria-valuemin="0"><div class="listen-fill"></div></div>
<div class="listen-now">
  <span class="listen-ghost" aria-hidden="true"><img src="/static/icons/logo.svg" alt="" width="26" height="26"></span>
  <div class="listen-text">
    <span class="listen-where"></span>
    <span class="listen-line"><span class="listen-state" role="status"></span><span class="listen-detail" aria-hidden="true"></span><button type="button" class="listen-retry" hidden>Try again</button></span>
  </div>
</div>
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
  <button type="button" class="listen-follow" aria-pressed="true" title="Scroll the page to keep the reading in view">${ICON.follow}<span>Follow</span></button>
</div>
<button type="button" class="listen-icon listen-close" aria-label="Stop listening" title="Stop listening">${ICON.close}</button>`;
  opts.host.append(tray);
  const $ = <T extends Element>(sel: string) => tray.querySelector<T>(sel)!;
  const track = $<HTMLElement>(".listen-track");
  const fill = $<HTMLElement>(".listen-fill");
  const where = $<HTMLElement>(".listen-where");
  const stateEl = $<HTMLElement>(".listen-state");
  const detail = $<HTMLElement>(".listen-detail");
  const retry = $<HTMLButtonElement>(".listen-retry");
  const play = $<HTMLButtonElement>(".listen-play");
  const glyph = $<HTMLElement>(".listen-glyph");
  const ring = $<SVGCircleElement>(".listen-ring circle");
  const prev = $<HTMLButtonElement>(".listen-prev");
  const next = $<HTMLButtonElement>(".listen-next");
  const slower = $<HTMLButtonElement>(".listen-slower");
  const faster = $<HTMLButtonElement>(".listen-faster");
  const rateOut = $<HTMLOutputElement>(".listen-rate");
  const close = $<HTMLButtonElement>(".listen-close");
  const followButton = $<HTMLButtonElement>(".listen-follow");

  // ---- state ---------------------------------------------------------------------------
  const audio = new Audio();
  audio.preload = "auto";
  let rate = RATES.includes(Number(recall(RATE_KEY))) ? Number(recall(RATE_KEY)) : 1;
  let worker: Worker | null = null;
  let ready = false;
  let download: { loaded: number; total: number } | null = null;
  let sentences: Sentence[] = [];
  /** Characters before each sentence, so progress moves with the reading rather than the sentence count. */
  let charsBefore: number[] = [];
  let truncated = false;
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
  let failures = 0;
  let word = -1;
  let quiet = true;
  let quietTimer = 0;
  /** The first time anyone listens on this device, the tray says once that tapping a paragraph starts there. */
  let hinting = false;
  let hintTimer = 0;
  /** A speak:collect is out; only its answer is taken (a frame can't push text unasked). */
  let collectPending = false;
  let collectTimer = 0;
  /** Set when the page is being collected again mid-reading (the frame reloaded or re-rendered): carry on from this. */
  let resyncFrom: string | null = null;
  let idleTimer = 0;
  let raf = 0;
  /** Follow: the page scrolls to keep the reading in view. On with every Listen; scrolling by hand turns it off. */
  let followOn = true;
  /** What the wisp was last told, so it hears each change once. */
  let wispState = "";
  let unlockUrl = "";
  const made = new Map<number, { id: number; result: Promise<Made> }>();
  const waiting = new Map<number, { resolve: (m: Made) => void; reject: (e: Error) => void }>();

  const busy = () => state === "loading" || state === "collecting" || state === "buffering";
  /** Play can't do anything until there is something to read; it says why instead. */
  const playBlocked = () => state === "empty" || (sentences.length === 0 && (busy() || state === "error"));

  function paint() {
    tray.dataset.state = state;
    const speaking = state === "playing";
    const blocked = playBlocked();
    const icon = blocked ? ICON.play : speaking || busy() ? ICON.pause : state === "ended" ? ICON.replay : ICON.play;
    if (glyph.dataset.icon !== icon) {
      glyph.innerHTML = icon;
      glyph.dataset.icon = icon;
    }
    const label =
      state === "empty" ? "Nothing to read" : state === "error" && blocked ? "Try again below" : blocked ? "Getting the voice ready" : speaking || busy() ? "Pause" : state === "ended" ? "Read again" : "Play";
    play.setAttribute("aria-label", label);
    play.title = label;
    play.setAttribute("aria-disabled", String(blocked));
    play.setAttribute("aria-busy", String(busy()));
    // The ring: download progress while the voice arrives, a spinner while waiting, nothing otherwise.
    const determinate = state === "loading" && download && download.total > 0 ? download.loaded / download.total : null;
    tray.toggleAttribute("data-spinning", busy() && determinate === null && !quiet);
    tray.toggleAttribute("data-progress", determinate !== null);
    ring.style.strokeDashoffset = determinate === null ? "" : String(100 - determinate * 100);
    prev.disabled = !sentences.length || at <= 0;
    next.disabled = !sentences.length || at >= sentences.length - 1;
    const total = charsBefore[sentences.length] ?? 0;
    const done = state === "ended" ? total : (charsBefore[at] ?? 0);
    fill.style.transform = `scaleX(${total ? done / total : 0})`;
    track.setAttribute("aria-valuemax", String(sentences.length));
    track.setAttribute("aria-valuenow", String(Math.min(at + 1, sentences.length)));
    track.setAttribute("aria-valuetext", sentences.length ? `Sentence ${Math.min(at + 1, sentences.length)} of ${sentences.length}` : "Not started");
    const heading = sentences[at]?.h ?? opts.title;
    if (where.textContent !== heading) where.textContent = heading;
    // The live region changes only when what it says changes, so a repaint never re-announces it.
    const text = stateText();
    if (stateEl.textContent !== text) stateEl.textContent = text;
    // Beside it, quietly: download size, or how far through the page.
    const numbers =
      state === "loading" && !ready && download?.total && !quiet
        ? `${mb(download.loaded)} of ${mb(download.total)} MB`
        : sentences.length && !text
          ? `${Math.min(at + 1, sentences.length)} of ${sentences.length}`
          : "";
    if (detail.textContent !== numbers) detail.textContent = numbers;
    const i = RATES.indexOf(rate);
    rateOut.textContent = rateLabel(rate);
    slower.disabled = i <= 0;
    faster.disabled = i >= RATES.length - 1;
    slower.title = i <= 0 ? "Slower (this is the slowest)" : "Slower";
    faster.title = i >= RATES.length - 1 ? "Faster (this is the fastest)" : "Faster";
    followButton.setAttribute("aria-pressed", String(followOn));
    // The wisp tracks words while the voice speaks, and floats while it waits or rests.
    const ws = state === "playing" ? "playing" : busy() ? "waiting" : "resting";
    if (ws !== wispState && !tray.hidden) {
      wispState = ws;
      opts.post({ t: "speak:state", state: ws });
    }
    if ("mediaSession" in navigator && !tray.hidden) navigator.mediaSession.playbackState = wantPlay && (speaking || busy()) ? "playing" : "paused";
  }

  function stateText(): string {
    switch (state) {
      case "loading":
        if (quiet) return "";
        return download?.total && !ready ? "Getting the voice ready, only this once: " : "Getting ready…";
      case "collecting":
        return quiet ? "" : "Getting ready…";
      case "buffering":
        return quiet ? "" : "Catching up…";
      case "playing":
        return hinting ? "Tap any paragraph to start there" : "";
      case "paused":
        return "Paused";
      case "ended":
        return truncated ? "Finished the part of this page Listen can read" : "Finished";
      case "empty":
        return "There's nothing to read on this page";
      case "error":
        return errorText;
    }
  }

  /** Enter a state; waiting states stay quiet for a moment so quick ones don't flash. */
  function set(to: State) {
    if (to === "playing" && state !== "playing" && !recall(HINT_KEY)) {
      remember(HINT_KEY, "1");
      hinting = true;
      clearTimeout(hintTimer);
      hintTimer = window.setTimeout(() => {
        hinting = false;
        paint();
      }, 6000);
    }
    state = to;
    if (to !== "error") retry.hidden = true;
    clearTimeout(quietTimer);
    quiet = busy();
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
    download = null;
    worker = new Worker(`/static/tts-worker.js${new URL(import.meta.url).search}`, { type: "module" });
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const msg = e.data;
      if (msg.t === "progress") {
        download = msg;
        if (state === "loading") paint();
      } else if (msg.t === "ready") {
        ready = true;
        // The ring completes before it fades, rather than draining back.
        if (download) {
          download = { loaded: download.total, total: download.total };
          paint();
          setTimeout(() => {
            download = null;
            paint();
          }, motionMs("base"));
        } else paint();
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
    download = null;
    for (const w of waiting.values()) w.reject(Object.assign(new Error("stopped"), { fatal: true }));
    waiting.clear();
    forget();
  }

  function fail(text: string) {
    if (tray.hidden) return;
    errorText = text;
    generation++;
    cancelAnimationFrame(raf);
    audio.pause();
    current = null;
    // Nothing queued keeps running (or re-downloading) behind the error.
    forget();
    set("error");
    retry.hidden = false;
    // Keyboard users land on the way forward.
    if (document.activeElement === play) retry.focus();
  }

  function tryAgain() {
    failures = 0;
    startWorker();
    if (sentences.length) return void playAt(at);
    // The page never answered: ask again.
    set(ready ? "collecting" : "loading");
    collect();
    play.focus();
  }

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

  /** Forget made audio (except what is playing) and drop what's still queued. */
  function forget() {
    for (const { result } of made.values()) result.then((m) => m.url !== current?.url && URL.revokeObjectURL(m.url), () => {});
    made.clear();
    send({ t: "cancel", before: nextId });
  }

  // ---- playback ------------------------------------------------------------------------
  /** One sentence the model couldn't say is skipped; several in a row means something is wrong. */
  function skipFailed(i: number) {
    if (++failures >= MAX_FAILURES) return fail("Couldn't read this page aloud.");
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
    const old = current;
    current = null;
    if (old && made.get(old.i)?.id === undefined) URL.revokeObjectURL(old.url);
    const moved = i !== at;
    at = i;
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
      trackWords();
    } catch (err) {
      if (mine !== generation) return;
      // Autoplay refused (the tap that opened Listen has expired): wait for the reader. Anything else is a bad clip.
      if ((err as DOMException).name === "NotAllowedError") {
        wantPlay = false;
        set("paused");
      } else skipFailed(i);
    }
  }

  /** Marks the word being heard, every frame while playing. */
  function trackWords() {
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
    opts.post({ t: "speak:word", i: s.unit, start: s.start + w.s, end: s.start + w.e });
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
      cancelAnimationFrame(raf);
      set("paused");
    }
  });
  audio.addEventListener("play", () => {
    if (state === "paused" && ours()) {
      wantPlay = true;
      set("playing");
      trackWords();
    }
  });

  function pause() {
    generation++;
    wantPlay = false;
    cancelAnimationFrame(raf);
    audio.pause();
    if (sentences.length) set("paused");
    else paint();
  }

  function resume() {
    if (state === "error") return tryAgain();
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
          trackWords();
        },
        () => mine === generation && set("paused"),
      );
    } else void playAt(at);
  }

  function setRate(r: number) {
    rate = r;
    remember(RATE_KEY, String(r));
    audio.playbackRate = r;
    paint();
  }

  play.addEventListener("click", () => {
    if (playBlocked()) return;
    if (state === "playing" || busy()) pause();
    else resume();
  });
  retry.addEventListener("click", tryAgain);
  followButton.addEventListener("click", () => setFollow(!followOn, true));

  function setFollow(on: boolean, tell: boolean) {
    followOn = on;
    if (tell) opts.post({ t: "speak:follow", on });
    paint();
  }
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

  // Lock screen and headphone controls belong to Listen only while the tray is open.
  const MEDIA_ACTIONS = ["play", "pause", "previoustrack", "nexttrack"] as const;
  function mediaSession(on: boolean) {
    if (!("mediaSession" in navigator)) return;
    const handlers = { play: resume, pause, previoustrack: () => void playAt(at - 1), nexttrack: () => void playAt(at + 1) };
    for (const action of MEDIA_ACTIONS) {
      try {
        navigator.mediaSession.setActionHandler(action, on ? handlers[action] : null);
      } catch {
        // an action this browser doesn't support
      }
    }
    navigator.mediaSession.metadata = on
      ? new MediaMetadata({ title: opts.title, artist: "Listen", artwork: [{ src: "/static/icons/icon-512.png", sizes: "512x512", type: "image/png" }] })
      : null;
    navigator.mediaSession.playbackState = "none";
  }

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
    // Played inside this tap so iOS lets the sentences start on their own later.
    unlockUrl ||= silence();
    audio.src = unlockUrl;
    void audio.play().catch(() => {});
    current = null;
    at = 0;
    failures = 0;
    wantPlay = true;
    resyncFrom = null;
    sentences = [];
    charsBefore = [];
    errorText = "";
    followOn = true;
    wispState = "";
    tray.hidden = false;
    opts.trigger.setAttribute("aria-pressed", "true");
    set(ready ? "collecting" : "loading");
    startWorker();
    mediaSession(true);
    collect();
    play.focus();
  }

  function closeTray() {
    collectPending = false;
    resyncFrom = null;
    clearTimeout(collectTimer);
    clearTimeout(hintTimer);
    hinting = false;
    generation++;
    cancelAnimationFrame(raf);
    audio.pause();
    audio.removeAttribute("src");
    const old = current;
    current = null;
    if (old) URL.revokeObjectURL(old.url);
    forget();
    sentences = [];
    charsBefore = [];
    markWord(-1);
    opts.post({ t: "speak:mode", on: false });
    tray.hidden = true;
    opts.trigger.setAttribute("aria-pressed", "false");
    opts.trigger.focus();
    mediaSession(false);
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(stopWorker, IDLE_MS);
  }

  /** Takes a freshly collected page; when re-collecting mid-reading, keeps the sentence playing if it is still there. */
  function take(units: SpeakUnit[], start: number) {
    const taken = takeUnits(units);
    truncated = taken.truncated;
    const fresh = splitSentences(taken.units);
    const carry = resyncFrom;
    resyncFrom = null;
    if (carry !== null && current) {
      const i = fresh.findIndex((s) => s.text === carry);
      if (i >= 0) {
        // Same sentence, new numbering: keep playing it, and make the rest afresh for the new page.
        forget();
        sentences = fresh;
        charsBefore = prefixSums(fresh);
        at = i;
        current.i = i;
        opts.post({ t: "speak:at", i: fresh[i]!.unit });
        for (let k = i + 1; k < Math.min(fresh.length, i + 1 + AHEAD); k++) void audioFor(k).catch(() => {});
        paint();
        return;
      }
    }
    forget();
    sentences = fresh;
    charsBefore = prefixSums(fresh);
    if (!sentences.length) return set("empty");
    const first = Math.max(0, sentences.findIndex((s) => s.unit >= (Number(start) || 0)));
    // Paused while the page was being read (from the lock screen): wait there instead of starting.
    if (!wantPlay) {
      at = first;
      opts.post({ t: "speak:at", i: sentences[first]!.unit });
      return set("paused");
    }
    void playAt(first);
  }

  return {
    /** The Listen button. */
    toggle() {
      if (tray.hidden) open();
      else closeTray();
    },
    /** The frame's readable text arrived. */
    units(units: SpeakUnit[], start: number) {
      if (tray.hidden || !collectPending) return;
      collectPending = false;
      clearTimeout(collectTimer);
      take(units, start);
    },
    /** The frame turned Follow off (the reader scrolled by hand) or on (they tapped a paragraph). */
    follow(on: boolean) {
      if (!tray.hidden) setFollow(on, false);
    },
    /** The reader tapped a block. */
    jump(unit: number) {
      if (tray.hidden || !sentences.length) return;
      const i = sentences.findIndex((s) => s.unit === unit);
      if (i >= 0) void playAt(i);
    },
    /**
     * The frame (re)started, or its page changed under Listen (re-rendered blocks): collect again. Mid-reading,
     * the sentence being read carries on and the marks come back on the new page.
     */
    frameChanged() {
      if (tray.hidden) return;
      if (sentences.length && current) resyncFrom = sentences[current.i]?.text ?? null;
      collect();
    },
  };
}

function prefixSums(sentences: Sentence[]): number[] {
  const out = [0];
  for (const s of sentences) out.push(out[out.length - 1]! + s.chars);
  return out;
}

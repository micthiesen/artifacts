// Listen: reads the artifact aloud in the ghost's voice. The frame gathers the
// page's readable text (src/kit/speak.ts); a worker on this origin turns each
// sentence into audio on this device (src/tts/worker.ts); this file is the
// player bar under the page. Speech is media the reader asked for, not a
// feedback cue, so it plays through an <audio> element and ignores the Sounds
// setting.
import type { ShellMessage, SpeakUnit } from "../shared/protocol.ts";
import type { FromWorker, ToWorker } from "../tts/types.ts";

const VOICES = ["Luna", "Bella", "Rosie", "Kiki", "Jasper", "Bruno", "Hugo", "Leo"];
const SPEEDS = [0.8, 0.9, 1, 1.15, 1.3, 1.5];
const PREFS = "art:listen";
/** Long sentences are split at commas so the first sound comes quickly and the model doesn't drift. */
const MAX_CHARS = 240;
const AHEAD = 2;

type Prefs = { voice: string; speed: number; ghost: boolean };
type Sentence = { unit: number; text: string };

const ICON = {
  play: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>`,
  prev: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M18 6 10 12l8 6V6ZM6 6v12"/></svg>`,
  next: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="m6 6 8 6-8 6V6ZM18 6v12"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M6 6l12 12M18 6 6 18"/></svg>`,
};

/** A few milliseconds of silence, played inside the tap that opens Listen so iOS lets later audio start on its own. */
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YQAAAAA=";

function readPrefs(): Prefs {
  const fallback: Prefs = { voice: "Luna", speed: 1, ghost: true };
  try {
    const p = { ...fallback, ...(JSON.parse(localStorage.getItem(PREFS) ?? "{}") as Partial<Prefs>) };
    if (!VOICES.includes(p.voice)) p.voice = fallback.voice;
    if (!SPEEDS.includes(p.speed)) p.speed = 1;
    return p;
  } catch {
    return fallback;
  }
}

function splitSentences(units: SpeakUnit[]): Sentence[] {
  const seg = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("en", { granularity: "sentence" }) : null;
  const out: Sentence[] = [];
  for (const u of units) {
    const parts = seg ? [...seg.segment(u.text)].map((s) => s.segment) : u.text.split(/(?<=[.!?])\s+/);
    for (const raw of parts) {
      const text = raw.trim();
      if (!text) continue;
      if (text.length <= MAX_CHARS) {
        out.push({ unit: u.i, text });
        continue;
      }
      // Too long: break after commas, semicolons and dashes, packing pieces up to the limit.
      let line = "";
      for (const piece of text.split(/(?<=[,;:—])\s+/)) {
        if (line && line.length + piece.length + 1 > MAX_CHARS) {
          out.push({ unit: u.i, text: line });
          line = "";
        }
        line = line ? `${line} ${piece}` : piece;
      }
      if (line) out.push({ unit: u.i, text: line });
    }
  }
  return out;
}

const mb = (n: number) => (n / 1e6).toFixed(n < 1e7 ? 1 : 0);

export function createListen(opts: { title: string; post: (msg: ShellMessage) => void; host: HTMLElement }) {
  const prefs = readPrefs();
  const save = () => localStorage.setItem(PREFS, JSON.stringify(prefs));

  // ---- the bar -------------------------------------------------------------------------
  const bar = document.createElement("section");
  bar.className = "listen";
  bar.hidden = true;
  bar.setAttribute("aria-label", "Listen");
  const button = (cls: string, label: string, icon: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `bar-button listen-${cls}`;
    b.setAttribute("aria-label", label);
    b.title = label;
    b.innerHTML = icon;
    return b;
  };
  const prev = button("prev", "Previous sentence", ICON.prev);
  const play = button("play", "Play", ICON.play);
  const next = button("next", "Next sentence", ICON.next);
  const close = button("close", "Stop listening", ICON.close);
  const status = document.createElement("span");
  status.className = "listen-status";
  status.setAttribute("role", "status");
  const stats = document.createElement("span");
  stats.className = "listen-stats";
  const select = (label: string, options: [string, string][], value: string, onChange: (v: string) => void) => {
    const s = document.createElement("select");
    s.className = "listen-select";
    s.setAttribute("aria-label", label);
    s.title = label;
    for (const [v, text] of options) s.append(new Option(text, v, false, v === value));
    s.addEventListener("change", () => onChange(s.value));
    return s;
  };
  const voiceSel = select("Voice", VOICES.map((v) => [v, v]), prefs.voice, (v) => {
    prefs.voice = v;
    save();
    restart();
  });
  const speedSel = select("Speed", SPEEDS.map((s) => [String(s), `${s}×`]), String(prefs.speed), (v) => {
    prefs.speed = Number(v);
    save();
    audio.playbackRate = prefs.speed;
  });
  const ghostLabel = document.createElement("label");
  ghostLabel.className = "listen-ghost";
  const ghostBox = document.createElement("input");
  ghostBox.type = "checkbox";
  ghostBox.checked = prefs.ghost;
  ghostBox.addEventListener("change", () => {
    prefs.ghost = ghostBox.checked;
    save();
    restart();
  });
  ghostLabel.append(ghostBox, " Ghost");
  ghostLabel.title = "A touch higher, in a small soft room";

  const controls = document.createElement("div");
  controls.className = "listen-controls";
  controls.append(prev, play, next);
  const text = document.createElement("div");
  text.className = "listen-text";
  text.append(status, stats);
  const options = document.createElement("div");
  options.className = "listen-options";
  options.append(voiceSel, speedSel, ghostLabel, close);
  bar.append(controls, text, options);
  opts.host.append(bar);

  // ---- speech --------------------------------------------------------------------------
  const audio = new Audio();
  audio.preload = "auto";
  let worker: Worker | null = null;
  let ready = false;
  let sentences: Sentence[] = [];
  let at = 0;
  let playing = false;
  let nextId = 1;
  /** Bumped whenever what should be playing changes; stale results are dropped. */
  let generation = 0;
  /** The sentence audio now in the element (not the unlocking silence). */
  let current = "";
  const cache = new Map<number, { id: number; url: Promise<string> }>();
  const waiting = new Map<number, { resolve: (url: string) => void; reject: (e: Error) => void }>();

  const setStatus = (s: string) => (status.textContent = s);
  const paintPlay = () => {
    play.innerHTML = playing ? ICON.pause : ICON.play;
    play.setAttribute("aria-label", playing ? "Pause" : "Play");
    play.title = playing ? "Pause" : "Play";
    prev.disabled = at <= 0;
    next.disabled = at >= sentences.length - 1;
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  };

  function startWorker() {
    if (worker) return;
    const version = new URL(import.meta.url).search;
    worker = new Worker(`/static/tts-worker.js${version}`, { type: "module" });
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const msg = e.data;
      if (msg.t === "progress") {
        if (!ready) setStatus(msg.total ? `Getting the voice ready: ${mb(msg.loaded)} of ${mb(msg.total)} MB (once)` : "Getting the voice ready…");
      } else if (msg.t === "ready") {
        ready = true;
        stats.textContent = `Voice ready in ${(msg.ms / 1000).toFixed(1)} s`;
        if (playing) setStatus(`Reading ${at + 1} of ${sentences.length}`);
      } else if (msg.t === "audio") {
        const w = waiting.get(msg.id);
        waiting.delete(msg.id);
        w?.resolve(URL.createObjectURL(new Blob([msg.wav], { type: "audio/wav" })));
        stats.textContent = `Made ${msg.seconds.toFixed(1)} s of speech in ${(msg.ms / 1000).toFixed(2)} s (${(msg.ms / 1000 / Math.max(msg.seconds, 0.01)).toFixed(2)}× real time)`;
        console.debug("[listen]", msg.phonemes);
      } else if (msg.t === "error") {
        if (msg.id !== undefined) {
          const w = waiting.get(msg.id);
          waiting.delete(msg.id);
          w?.reject(new Error(msg.message));
        } else {
          setStatus(`Couldn't load the voice: ${msg.message}`);
          playing = false;
          paintPlay();
        }
      }
    };
    worker.onerror = (e) => {
      setStatus(`The voice stopped: ${e.message || "worker error"}`);
      playing = false;
      paintPlay();
    };
    send({ t: "load", voice: prefs.voice });
  }
  const send = (msg: ToWorker) => worker?.postMessage(msg);

  function audioFor(i: number): Promise<string> {
    let entry = cache.get(i);
    if (!entry) {
      const id = nextId++;
      const url = new Promise<string>((resolve, reject) => waiting.set(id, { resolve, reject }));
      url.catch(() => cache.get(i)?.id === id && cache.delete(i));
      entry = { id, url };
      cache.set(i, entry);
      send({ t: "synth", id, text: sentences[i]!.text, voice: prefs.voice, ghost: prefs.ghost });
    }
    return entry.url;
  }

  /** Forget made audio (the voice changed, or Listen closed), and drop what's still queued. */
  function clearCache() {
    for (const { url } of cache.values()) url.then(URL.revokeObjectURL, () => {});
    cache.clear();
    send({ t: "cancel", before: nextId });
  }

  async function playAt(i: number) {
    if (i < 0 || i >= sentences.length) return;
    const mine = ++generation;
    at = i;
    playing = true;
    paintPlay();
    opts.post({ t: "speak:at", i: sentences[i]!.unit });
    for (let k = i; k < Math.min(sentences.length, i + 1 + AHEAD); k++) void audioFor(k).catch(() => {});
    // Let go of audio well behind us.
    for (const [k, { url }] of cache) {
      if (k < i - 2) {
        url.then(URL.revokeObjectURL, () => {});
        cache.delete(k);
      }
    }
    if (ready) setStatus(`Reading ${i + 1} of ${sentences.length}`);
    let url: string;
    try {
      url = await audioFor(i);
    } catch (err) {
      if (mine !== generation) return;
      if ((err as Error).message === "cancelled") return void playAt(i);
      setStatus(`Couldn't read this sentence: ${(err as Error).message}`);
      playing = false;
      paintPlay();
      return;
    }
    if (mine !== generation || !playing) return;
    audio.src = current = url;
    audio.playbackRate = prefs.speed;
    try {
      await audio.play();
    } catch {
      playing = false;
      paintPlay();
      setStatus("Press play to start");
    }
  }

  audio.addEventListener("ended", () => {
    if (!playing || audio.src !== current) return;
    if (at + 1 < sentences.length) void playAt(at + 1);
    else {
      playing = false;
      paintPlay();
      setStatus("Finished");
      opts.post({ t: "speak:at", i: null });
    }
  });

  function pause() {
    playing = false;
    generation++;
    audio.pause();
    paintPlay();
    setStatus(`Paused at ${at + 1} of ${sentences.length}`);
  }

  function resume() {
    if (!sentences.length) return;
    // Resume mid-sentence when the audio is still the current one.
    if (current && audio.src === current && !audio.ended && audio.currentTime > 0) {
      playing = true;
      paintPlay();
      setStatus(`Reading ${at + 1} of ${sentences.length}`);
      void audio.play();
    } else void playAt(at);
  }

  function restart() {
    clearCache();
    current = "";
    if (playing) {
      audio.pause();
      void playAt(at);
    }
  }

  play.addEventListener("click", () => (playing ? pause() : resume()));
  prev.addEventListener("click", () => playAt(Math.max(0, at - 1)));
  next.addEventListener("click", () => playAt(Math.min(sentences.length - 1, at + 1)));
  close.addEventListener("click", () => {
    pause();
    clearCache();
    audio.removeAttribute("src");
    bar.hidden = true;
    opts.post({ t: "speak:mode", on: false });
  });

  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", resume);
    navigator.mediaSession.setActionHandler("pause", pause);
    navigator.mediaSession.setActionHandler("previoustrack", () => void playAt(Math.max(0, at - 1)));
    navigator.mediaSession.setActionHandler("nexttrack", () => void playAt(Math.min(sentences.length - 1, at + 1)));
  }

  return {
    /** The account menu's Listen: a tap, so audio may start. */
    open() {
      audio.src = SILENCE;
      void audio.play().catch(() => {});
      bar.hidden = false;
      setStatus(ready ? "Finding the words…" : "Getting the voice ready…");
      startWorker();
      if ("mediaSession" in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: opts.title, artist: "artifacts.boo", artwork: [{ src: "/static/icons/icon-512.png", sizes: "512x512", type: "image/png" }] });
      opts.post({ t: "speak:mode", on: true });
      opts.post({ t: "speak:collect" });
      play.focus();
    },
    /** The frame's readable text arrived: start reading from the top. */
    units(units: SpeakUnit[]) {
      if (bar.hidden) return;
      clearCache();
      sentences = splitSentences(units);
      if (!sentences.length) {
        setStatus("There's nothing to read on this page");
        return;
      }
      void playAt(0);
    },
    /** The reader tapped a block. */
    jump(unit: number) {
      const i = sentences.findIndex((s) => s.unit === unit);
      if (i >= 0) void playAt(i);
    },
  };
}

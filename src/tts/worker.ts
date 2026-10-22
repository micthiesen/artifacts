// Listen's speech worker. Runs on the shell's origin (never in the artifact
// frame, which has no network or workers), downloads the model once (the
// files are immutable static assets, so the browser cache keeps them for
// every workspace on this site), and turns sentences into WAV audio, with
// the time each word is heard, on the reader's device. Nothing is sent
// anywhere, and nothing runs on a server.
import * as ort from "onnxruntime-web/wasm";
import { Phonemizer } from "./phonemize.ts";
import { planParts, SAMPLE_RATE, wordTimes } from "./plan.ts";
import { styleFor, STYLE_WIDTH } from "./style.ts";
import { toWav } from "./dsp.ts";
import { MAX_SENTENCE, type FromWorker, type TimedWord, type ToWorker, type TtsManifest } from "./types.ts";

declare const __TTS_MANIFEST__: TtsManifest;
declare const __ORT_WASM__: { wasm: string; mjs: string; bytes: number };
const manifest = __TTS_MANIFEST__;

/** Bruno at the model's own pace sounds slow; this is Listen's 1×. The reader's speed control scales playback on top. */
const BASE_RATE = 1.15;
/** The model ends every clip with a tail of near-silence, which the reference implementation trims. */
const TAIL_SAMPLES = 5000;

const scope = self as unknown as { postMessage(msg: FromWorker, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null };
const reply = (msg: FromWorker, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

/** Where the files live: the apex origin, so every workspace shares one cached copy. */
let base = "";

/** Fetches the files the voice needs, reporting progress against their known sizes (bodies arrive decompressed). */
async function fetchAll(files: { url: string; bytes: number }[]): Promise<Uint8Array[]> {
  const total = files.reduce((n, f) => n + f.bytes, 0);
  const loaded = files.map(() => 0);
  let last = 0;
  const report = () => {
    const now = performance.now();
    if (now - last < 100) return;
    last = now;
    reply({ t: "progress", loaded: Math.min(total, loaded.reduce((a, b) => a + b, 0)), total });
  };
  return Promise.all(
    files.map(async ({ url }, i) => {
      const res = await fetch(base + url);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      // Written straight into one buffer of the known size, so the model never sits in memory twice.
      let out = new Uint8Array(files[i]!.bytes);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (loaded[i]! + value.byteLength > out.length) {
          const grown = new Uint8Array(Math.max(out.length * 2, loaded[i]! + value.byteLength));
          grown.set(out.subarray(0, loaded[i]!));
          out = grown;
        }
        out.set(value, loaded[i]!);
        loaded[i]! += value.byteLength;
        report();
      }
      return out.subarray(0, loaded[i]!);
    }),
  );
}

type Engine = { session: ort.InferenceSession; phonemizer: Phonemizer; voice: Float32Array };
let engine: Promise<Engine> | null = null;

function load(): Promise<Engine> {
  engine ??= (async () => {
    const [model, wasm, lexicon, g2p, voice] = await fetchAll([
      { url: manifest.model, bytes: manifest.bytes.model },
      { url: __ORT_WASM__.wasm, bytes: __ORT_WASM__.bytes },
      { url: manifest.lexicon, bytes: manifest.bytes.lexicon },
      { url: manifest.g2p, bytes: manifest.bytes.g2p },
      { url: manifest.voice.url, bytes: manifest.bytes.voice },
    ]);
    ort.env.wasm.numThreads = 1; // no cross-origin isolation, so no SharedArrayBuffer threads
    ort.env.wasm.wasmBinary = wasm!;
    ort.env.wasm.wasmPaths = { mjs: base + __ORT_WASM__.mjs, wasm: base + __ORT_WASM__.wasm };
    const session = await ort.InferenceSession.create(model!, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    // The runtime has compiled its copy; let go of ours.
    ort.env.wasm.wasmBinary = undefined;
    const phonemizer = new Phonemizer(new TextDecoder().decode(lexicon), g2p!.slice().buffer);
    reply({ t: "ready" });
    return { session, phonemizer, voice: new Float32Array(voice!.slice().buffer) };
  })();
  // A failed download can be retried: the next load starts over.
  engine.catch(() => (engine = null));
  return engine;
}

/** The model starts every clip with about 0.8 s of silence (all on the start token); keep only a breath of it. */
const LEAD_KEEP_SAMPLES = Math.round(0.12 * SAMPLE_RATE);

async function synth(text: string): Promise<{ pcm: Float32Array; words: TimedWord[] }> {
  const { session, phonemizer, voice } = await load();
  const pieces: Float32Array[] = [];
  const words: TimedWord[] = [];
  let offset = 0;
  // A sentence longer than the model takes (512 ids) is said in parts, back to back.
  for (const part of planParts(phonemizer, text)) {
    if (part.ids.length <= 3) continue;
    const out = await session.run({
      input_ids: new ort.Tensor("int64", BigInt64Array.from(part.ids, BigInt), [1, part.ids.length]),
      style: new ort.Tensor("float32", styleFor(voice, part.styleLength), [1, STYLE_WIDTH]),
      speed: new ort.Tensor("float32", new Float32Array([manifest.voice.speed * BASE_RATE]), [1]),
    });
    const wave = out.waveform!.data as Float32Array;
    const durations = Array.from(out.duration!.data as ArrayLike<number | bigint>, Number);
    // Samples per duration frame, from this clip itself (the model's is 600).
    const frames = durations.reduce((n, d) => n + Math.max(0, d), 0);
    const perFrame = frames > 0 ? wave.length / frames : 0;
    const cut = Math.max(0, Math.min(wave.length, Math.round((durations[0] ?? 0) * perFrame) - LEAD_KEEP_SAMPLES));
    const pcm = wave.subarray(cut, Math.max(cut, wave.length - TAIL_SAMPLES));
    const seconds = pcm.length / SAMPLE_RATE;
    for (const w of wordTimes(part.words, durations, wave.length, SAMPLE_RATE)) {
      const t0 = Math.max(0, Math.min(seconds, w.start - cut / SAMPLE_RATE));
      const t1 = Math.max(t0, Math.min(seconds, w.end - cut / SAMPLE_RATE));
      words.push({ s: w.src[0], e: w.src[1], t0: offset + t0, t1: offset + t1 });
    }
    pieces.push(pcm);
    offset += seconds;
  }
  const pcm = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pieces) {
    pcm.set(p, at);
    at += p.length;
  }
  return { pcm, words };
}

// One sentence at a time, in the order asked; a jump cancels what was queued before it.
let queue: Promise<void> = Promise.resolve();
let cancelledBefore = 0;

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.t === "load") {
    base = msg.base;
    load().catch((err: Error) => reply({ t: "error", message: err.message, fatal: true }));
  } else if (msg.t === "cancel") {
    cancelledBefore = Math.max(cancelledBefore, msg.before);
  } else if (msg.t === "synth") {
    queue = queue.then(async () => {
      if (msg.id < cancelledBefore) return reply({ t: "error", id: msg.id, message: "cancelled" });
      try {
        const { pcm, words } = await synth(msg.text.slice(0, MAX_SENTENCE));
        const wav = toWav(pcm, SAMPLE_RATE);
        reply({ t: "audio", id: msg.id, wav, words }, [wav]);
      } catch (err) {
        reply({ t: "error", id: msg.id, message: err instanceof Error ? err.message : String(err), fatal: engine === null });
      }
    });
  }
};

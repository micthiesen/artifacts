// Listen's speech worker. Runs on the shell's origin (never in the artifact
// frame, which has no network or workers), downloads the model once (the
// files are immutable static assets, so the browser cache keeps them for
// every workspace on this site), and turns sentences into WAV audio on the
// reader's device. Nothing is sent anywhere.
import * as ort from "onnxruntime-web/wasm";
import { normalizeForSpeech } from "./normalize.ts";
import { Phonemizer } from "./phonemize.ts";
import { tokenize } from "./tokens.ts";
import { styleFor, STYLE_WIDTH } from "./style.ts";
import { ghostly, toWav, SAMPLE_RATE } from "./dsp.ts";
import type { TtsManifest, ToWorker, FromWorker } from "./types.ts";

declare const __TTS_MANIFEST__: TtsManifest;
declare const __ORT_WASM__: { wasm: string; mjs: string };
const manifest = __TTS_MANIFEST__;

const scope = self as unknown as { postMessage(msg: FromWorker, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null };
const reply = (msg: FromWorker, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

/** Fetches several files, reporting combined progress. */
async function fetchAll(urls: string[]): Promise<ArrayBuffer[]> {
  const loaded = urls.map(() => 0);
  const totals = urls.map(() => 0);
  const report = () => reply({ t: "progress", loaded: loaded.reduce((a, b) => a + b, 0), total: totals.reduce((a, b) => a + b, 0) });
  return Promise.all(
    urls.map(async (url, i) => {
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`Couldn't load ${url} (${res.status})`);
      totals[i] = Number(res.headers.get("content-length")) || 0;
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded[i]! += value.byteLength;
        if (totals[i]! < loaded[i]!) totals[i] = loaded[i]!;
        report();
      }
      const out = new Uint8Array(loaded[i]!);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.byteLength;
      }
      return out.buffer;
    }),
  );
}

type Engine = { session: ort.InferenceSession; phonemizer: Phonemizer };
let engine: Promise<Engine> | null = null;
const voices = new Map<string, Promise<Float32Array>>();

function load(): Promise<Engine> {
  engine ??= (async () => {
    const t0 = performance.now();
    const [model, wasm, lexicon, g2p] = await fetchAll([manifest.model, __ORT_WASM__.wasm, manifest.lexicon, manifest.g2p]);
    ort.env.wasm.numThreads = 1; // no cross-origin isolation, so no SharedArrayBuffer threads
    ort.env.wasm.wasmBinary = wasm;
    ort.env.wasm.wasmPaths = { mjs: __ORT_WASM__.mjs, wasm: __ORT_WASM__.wasm };
    const session = await ort.InferenceSession.create(new Uint8Array(model!), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    const phonemizer = new Phonemizer(new TextDecoder().decode(lexicon), g2p!);
    reply({ t: "ready", ms: Math.round(performance.now() - t0) });
    return { session, phonemizer };
  })();
  engine.catch(() => (engine = null));
  return engine;
}

function voice(name: string): Promise<Float32Array> {
  const entry = manifest.voices[name] ?? Object.values(manifest.voices)[0]!;
  let v = voices.get(entry.url);
  if (!v) {
    v = fetch(entry.url).then(async (r) => {
      if (!r.ok) throw new Error(`Couldn't load the voice (${r.status})`);
      return new Float32Array(await r.arrayBuffer());
    });
    v.catch(() => voices.delete(entry.url));
    voices.set(entry.url, v);
  }
  return v;
}

/** The ghost's voice sits a little higher; raising pitch by resampling also shortens it, so synthesise that much slower. */
const GHOST_PITCH = 1.07;

async function synth(text: string, voiceName: string, ghost: boolean): Promise<{ pcm: Float32Array; phonemes: string }> {
  const { session, phonemizer } = await load();
  const ref = await voice(voiceName);
  const spoken = normalizeForSpeech(text);
  const phonemes = phonemizer.phonemize(spoken);
  const ids = tokenize(phonemes);
  const prior = manifest.voices[voiceName]?.speed ?? 1;
  const speed = prior / (ghost ? GHOST_PITCH : 1);
  const out = await session.run({
    input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    style: new ort.Tensor("float32", styleFor(ref, [...spoken].length), [1, STYLE_WIDTH]),
    speed: new ort.Tensor("float32", new Float32Array([speed]), [1]),
  });
  const first = out[session.outputNames[0]!]!;
  let pcm = first.data as Float32Array;
  // The model pads its output with a tail of near-silence, which the reference implementation trims.
  pcm = pcm.subarray(0, Math.max(0, pcm.length - 5000));
  if (ghost) pcm = ghostly(pcm, GHOST_PITCH);
  return { pcm, phonemes };
}

// One sentence at a time, in the order asked.
let queue: Promise<void> = Promise.resolve();
let cancelledBefore = 0;

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.t === "load") {
    load().catch((err: Error) => reply({ t: "error", message: err.message }));
    void voice(msg.voice).catch(() => {});
    return;
  }
  if (msg.t === "cancel") {
    cancelledBefore = Math.max(cancelledBefore, msg.before);
    return;
  }
  if (msg.t === "synth") {
    queue = queue.then(async () => {
      if (msg.id < cancelledBefore) return reply({ t: "error", id: msg.id, message: "cancelled" });
      try {
        const t0 = performance.now();
        const { pcm, phonemes } = await synth(msg.text, msg.voice, msg.ghost);
        const wav = toWav(pcm, SAMPLE_RATE);
        reply({ t: "audio", id: msg.id, wav, ms: Math.round(performance.now() - t0), seconds: pcm.length / SAMPLE_RATE, phonemes }, [wav]);
      } catch (err) {
        reply({ t: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) });
      }
    });
  }
};

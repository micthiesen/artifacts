// Speaks text with the Listen engine under Bun, for listening tests and A/B
// against espeak-ng phonemes:
//
//   bun scripts/build-tts.ts            # once, for node_modules/.cache/tts/out
//   bun spikes/tts-say.ts "Hello, world." --voice Luna --out /tmp/x.wav [--espeak] [--speed 1] [--threads 1]
//
// --espeak phonemizes with the espeak-ng CLI instead of src/tts/phonemize.ts.
// espeak-ng is GPL: it is used here and in tests only to measure our phonemes,
// never in anything that ships.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { chunkText, normalizeForSpeech } from "../src/tts/normalize.ts";
import { Phonemizer } from "../src/tts/phonemize.ts";
import { styleFor } from "../src/tts/style.ts";
import { tokenize } from "../src/tts/tokens.ts";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "node_modules/.cache/tts/out");
const SAMPLE_RATE = 24000;
const TRIM = 5000;

// phonemizer's default punctuation marks, which preserve_punctuation keeps.
const MARKS = /([;:,.!?¡¿—…"«»“”(){}[\]]+)/;

export function hasEspeak(): boolean {
  return spawnSync("espeak-ng", ["--version"]).status === 0;
}

/** espeak-ng en-us IPA with stress, punctuation kept as python phonemizer's EspeakBackend(preserve_punctuation=True) does. */
export function espeakPhonemize(text: string): string {
  let out = "";
  for (const part of text.split(MARKS)) {
    if (!part) continue;
    if (MARKS.test(part) && part.match(MARKS)![0] === part) {
      out = `${out.trimEnd()}${part.trim()} `;
      continue;
    }
    if (!part.trim()) continue;
    const r = spawnSync("espeak-ng", ["-q", "-v", "en-us", "--ipa", part.trim()], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`espeak-ng: ${r.stderr}`);
    out += `${r.stdout.replace(/\s+/g, " ").trim()} `;
  }
  return out.trim();
}

function wav(samples: Float32Array): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Uint8Array(buf);
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const [value] = args.splice(i, 2).slice(1);
    return value;
  };
  const voiceName = flag("--voice") ?? "Luna";
  const outPath = flag("--out") ?? "/tmp/tts-say.wav";
  const speedArg = Number(flag("--speed") ?? 1);
  const threads = Number(flag("--threads") ?? 1);
  const useEspeak = args.includes("--espeak");
  const text = args.filter((a) => a !== "--espeak").join(" ");
  if (!text) throw new Error('usage: bun spikes/tts-say.ts "text" [--voice Luna] [--out x.wav] [--espeak] [--speed 1]');

  const manifest = (await Bun.file(join(ROOT, "node_modules/.cache/tts/manifest.json")).json()) as { voices: Record<string, { speed: number }> };
  const voiceMeta = manifest.voices[voiceName];
  if (!voiceMeta) throw new Error(`unknown voice ${voiceName}; try ${Object.keys(manifest.voices).join(", ")}`);

  const ort = await import("onnxruntime-web");
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.wasmPaths = `${join(ROOT, "node_modules/onnxruntime-web/dist")}/`;
  let t = performance.now();
  const session = await ort.InferenceSession.create(new Uint8Array(await Bun.file(join(OUT, "kitten-nano-0.8.onnx")).arrayBuffer()), {
    executionProviders: ["wasm"],
  });
  const loadModelMs = performance.now() - t;
  t = performance.now();
  const phonemizer = useEspeak ? undefined : new Phonemizer(await Bun.file(join(OUT, "lexicon.txt")).text(), await Bun.file(join(OUT, "g2p.bin")).arrayBuffer());
  const loadPhonemizerMs = performance.now() - t;
  const voice = new Float32Array(await Bun.file(join(OUT, `voice-${voiceName}.bin`)).arrayBuffer());

  const normalized = normalizeForSpeech(text);
  const pieces: Float32Array[] = [];
  let phonemeMs = 0;
  let inferMs = 0;
  for (const chunk of chunkText(normalized)) {
    t = performance.now();
    const phonemes = phonemizer ? phonemizer.phonemize(chunk) : espeakPhonemize(chunk);
    phonemeMs += performance.now() - t;
    const ids = tokenize(phonemes);
    console.log(`  ${chunk}\n  ${phonemes}`);
    t = performance.now();
    const result = await session.run({
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      style: new ort.Tensor("float32", styleFor(voice, [...chunk].length), [1, 256]),
      speed: new ort.Tensor("float32", new Float32Array([speedArg * voiceMeta.speed]), [1]),
    });
    inferMs += performance.now() - t;
    const audio = result[session.outputNames[0]].data as Float32Array;
    pieces.push(audio.slice(0, Math.max(0, audio.length - TRIM)));
  }
  const total = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pieces) {
    total.set(p, at);
    at += p.length;
  }
  let peak = 0;
  let sumSq = 0;
  let nan = 0;
  for (const s of total) {
    if (Number.isNaN(s)) nan++;
    else {
      peak = Math.max(peak, Math.abs(s));
      sumSq += s * s;
    }
  }
  await Bun.write(outPath, wav(total));
  const seconds = total.length / SAMPLE_RATE;
  console.log(
    `${outPath}: ${seconds.toFixed(2)} s audio, peak ${peak.toFixed(3)}, rms ${Math.sqrt(sumSq / Math.max(1, total.length)).toFixed(4)}, NaN ${nan}\n` +
      `model load ${loadModelMs.toFixed(0)} ms, phonemizer load ${loadPhonemizerMs.toFixed(0)} ms, phonemes ${phonemeMs.toFixed(1)} ms, ` +
      `inference ${inferMs.toFixed(0)} ms = ${(inferMs / seconds).toFixed(0)} ms per second of audio (${useEspeak ? "espeak" : "ours"})`,
  );
}

if (import.meta.main) await main();

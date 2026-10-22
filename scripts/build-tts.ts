// Builds the speech engine's assets for the "Listen" reader:
//
//   node_modules/.cache/tts/src/   pinned downloads, checked against sha256
//   node_modules/.cache/tts/out/   the files below, under plain names
//   dist/kit/kit/v1/tts/           the same files with content hashes in their names
//   node_modules/.cache/tts/manifest.json   their URLs, for the shell to import
//
// Assets:
//   kitten-nano-0.8.onnx   Kitten TTS nano 0.8 int8 (Apache-2.0, KittenML)
//   voice-Bruno.bin        the voice's style table: raw little-endian float32,
//                          rows of STYLE_WIDTH (256), one row per text length
//   lexicon.txt            CMUdict (BSD-2-Clause) as "word\tipa\n", see src/tts/phonemize.ts
//   g2p.bin                g2p_en's GRU weights (Apache-2.0), layout in src/tts/phonemize.ts
//   NOTICES.txt            licences for all of the above
//
// Idempotent and deterministic: downloads are cached, outputs are rewritten
// from them. scripts/build-kit.ts wipes dist/kit, so run this after it.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { inflateRawSync } from "node:zlib";
import { arpabetToIpa } from "../src/tts/phonemize.ts";
import { STYLE_WIDTH } from "../src/tts/style.ts";

const ROOT = join(import.meta.dir, "..");
const CACHE = join(ROOT, "node_modules/.cache/tts");
const SRC = join(CACHE, "src");
const OUT = join(CACHE, "out");
const DIST = join(ROOT, "dist/kit/kit/v1/tts");
const URL_BASE = "/kit/v1/tts";

const KITTEN = "https://huggingface.co/KittenML/kitten-tts-nano-0.8-int8/resolve/84781d74e29ee25217551556398b42f80593a813";
const CMUDICT = "https://raw.githubusercontent.com/cmusphinx/cmudict/74790861f652b15e4ac49015a90074ad62a27690";
const SOURCES = {
  model: { url: `${KITTEN}/kitten_tts_nano_v0_8.onnx`, sha256: "f7b0afcbee92870b32b8e0276d855b954dc25470c9f051b376ac7eee537c76fc" },
  voices: { url: `${KITTEN}/voices.npz`, sha256: "8aa7cee235abb0739cb51e6559685f65a4dacd95568833d05699b1633f519b3f" },
  config: { url: `${KITTEN}/config.json`, sha256: "b66006ccbeccd4de5fc3c9272059c47f5725df7215fd889785c03602652fab64" },
  cmudict: { url: `${CMUDICT}/cmudict.dict`, sha256: "81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22" },
  cmudictLicense: { url: `${CMUDICT}/LICENSE`, sha256: "bd4ce8e44170a5f9f481310ca85c51de3c4f851a65e679b40e603b143bd3542a" },
  g2pWheel: {
    url: "https://files.pythonhosted.org/packages/d7/d9/b77dc634a7a0c0c97716ba97dd0a28cbfa6267c96f359c4f27ed71cbd284/g2p_en-2.1.0-py3-none-any.whl",
    sha256: "2a7aabf1fc7f270fcc3349881407988c9245173c2413debbe5432f4a4f31319f",
  },
} as const;

/** Weights precision in g2p.bin. float16 halves the download; greedy decoding agrees with float32 (see src/tts/phonemize.test.ts). */
const G2P_DTYPE: "float16" | "float32" = "float16";

export type Manifest = {
  model: string;
  lexicon: string;
  g2p: string;
  notices: string;
  voice: { url: string; speed: number };
  /** Uncompressed file sizes, for a download progress total. */
  bytes: { model: number; lexicon: number; g2p: number; voice: number };
};

/** The one voice Listen ships (a config.json alias). */
const VOICE = "Bruno";

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

async function fetchPinned(name: keyof typeof SOURCES): Promise<Uint8Array> {
  const { url, sha256: want } = SOURCES[name];
  const path = join(SRC, url.split("/").pop()!);
  if (existsSync(path)) {
    const cached = new Uint8Array(await readFile(path));
    if (sha256(cached) === want) return cached;
  }
  // A cold cache downloads from Hugging Face, GitHub and PyPI: don't hang on a slow one, and ride out a blip.
  let data: Uint8Array | null = null;
  for (let attempt = 1; !data; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (attempt >= 3) throw new Error(`${url}: ${(err as Error).message} after ${attempt} tries`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  const got = sha256(data);
  if (got !== want) throw new Error(`${url}: sha256 ${got}, expected ${want}`);
  await mkdir(SRC, { recursive: true });
  await writeFile(path, data);
  return data;
}

/** Reads every file from a zip archive (stored or deflated), via the central directory. */
export function unzip(zip: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("zip: no end of central directory");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("zip: bad central directory");
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = zip.subarray(dataAt, dataAt + compressed);
    if (method === 0) files.set(name, raw.slice());
    else if (method === 8) files.set(name, new Uint8Array(inflateRawSync(raw)));
    else throw new Error(`zip: ${name} uses method ${method}`);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** Parses a little-endian float32 .npy array. */
export function readNpy(npy: Uint8Array): { shape: number[]; data: Float32Array } {
  const view = new DataView(npy.buffer, npy.byteOffset, npy.byteLength);
  const major = npy[6];
  const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerAt = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(npy.subarray(headerAt, headerAt + headerLen));
  if (!/'descr':\s*'<f4'/.test(header)) throw new Error(`npy: unsupported dtype in ${header}`);
  if (/'fortran_order':\s*True/.test(header)) throw new Error("npy: fortran order");
  const shape = (/'shape':\s*\(([^)]*)\)/.exec(header)?.[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  const start = headerAt + headerLen;
  const size = shape.reduce((a, b) => a * b, 1);
  const data = new Float32Array(npy.slice(start, start + size * 4).buffer);
  return { shape, data };
}

function readNpz(npz: Uint8Array): Map<string, { shape: number[]; data: Float32Array }> {
  const out = new Map<string, { shape: number[]; data: Float32Array }>();
  for (const [name, bytes] of unzip(npz)) out.set(name.replace(/\.npy$/, ""), readNpy(bytes));
  return out;
}

/** float32 -> IEEE half, rounding to nearest even. */
function toHalf(value: number): number {
  const f32 = new Float32Array([value]);
  const x = new Uint32Array(f32.buffer)[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const mid = 1 << (shift - 1);
    if (rem > mid || (rem === mid && half & 1)) half++;
    return sign | half;
  }
  let half = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && half & 1)) half++;
  return sign | half;
}

const G2P_TENSORS = [
  "enc_emb", "enc_w_ih", "enc_w_hh", "enc_b_ih", "enc_b_hh",
  "dec_emb", "dec_w_ih", "dec_w_hh", "dec_b_ih", "dec_b_hh", "fc_w", "fc_b",
];

function packG2p(npz: Map<string, { shape: number[]; data: Float32Array }>): Uint8Array {
  const bytesPer = G2P_DTYPE === "float16" ? 2 : 4;
  const tensors: { name: string; shape: number[]; offset: number }[] = [];
  let offset = 0;
  for (const name of G2P_TENSORS) {
    const t = npz.get(name);
    if (!t) throw new Error(`g2p checkpoint lacks ${name}`);
    tensors.push({ name, shape: t.shape, offset });
    offset = (offset + t.data.length * bytesPer + 3) & ~3;
  }
  const header = new TextEncoder().encode(JSON.stringify({ dtype: G2P_DTYPE, tensors }));
  const dataStart = (8 + header.length + 3) & ~3;
  const out = new Uint8Array(dataStart + offset);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode("G2PE"), 0);
  view.setUint32(4, header.length, true);
  out.set(header, 8);
  for (const t of tensors) {
    const data = npz.get(t.name)!.data;
    const at = dataStart + t.offset;
    for (let i = 0; i < data.length; i++) {
      if (bytesPer === 2) view.setUint16(at + i * 2, toHalf(data[i]), true);
      else view.setFloat32(at + i * 4, data[i], true);
    }
  }
  return out;
}

/** CMUdict -> "word\tipa" lines: first pronunciation of each word, comments dropped. */
export function buildLexicon(cmudict: string): string {
  const entries = new Map<string, string>();
  for (const line of cmudict.split("\n")) {
    const body = line.split("#")[0].trim();
    if (!body) continue;
    const [head, ...phones] = body.split(/\s+/);
    if (/\(\d+\)$/.test(head) || entries.has(head) || !phones.length) continue;
    entries.set(head, arpabetToIpa(phones, head));
  }
  return [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([w, ipa]) => `${w}\t${ipa}\n`).join("");
}

function notices(cmudictLicense: string, apache: string): string {
  return `Third-party components of the artifacts.boo speech engine
========================================================

Kitten TTS nano 0.8 (kitten-nano-0.8.onnx, voice-Bruno.bin)
  Copyright KittenML. Licensed under the Apache License, Version 2.0.
  https://huggingface.co/KittenML/kitten-tts-nano-0.8-int8
  Voice tables converted from voices.npz to raw float32; the model is unmodified.

g2p_en grapheme-to-phoneme model (g2p.bin)
  Copyright Kyubyong Park and Jongseok Kim. Licensed under the Apache License, Version 2.0.
  https://github.com/Kyubyong/g2p
  Weights from checkpoint20.npz (g2p_en 2.1.0), repacked as ${G2P_DTYPE}.

Parts of the text normaliser follow KittenTTS's preprocess.py
  Copyright KittenML. Licensed under the Apache License, Version 2.0.
  https://github.com/KittenML/KittenTTS

CMU Pronouncing Dictionary (lexicon.txt)
  https://github.com/cmusphinx/cmudict
  Converted from ARPAbet to IPA; first pronunciation of each word only.

${cmudictLicense.trim()}

onnxruntime-web (tts-worker.js, ort-wasm-simd-threaded.wasm)
  Copyright (c) Microsoft Corporation. Licensed under the MIT License.
  https://github.com/microsoft/onnxruntime

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.

------------------------------------------------------------------------
Apache License, Version 2.0 (applies to Kitten TTS and g2p_en)
------------------------------------------------------------------------

${apache.trim()}
`;
}

const shortHash = (data: Uint8Array) => sha256(data).slice(0, 12);

export async function buildTts(): Promise<Manifest> {
  const t0 = performance.now();
  const [model, voicesNpz, configBytes, cmudict, cmudictLicense, wheel] = await Promise.all([
    fetchPinned("model"),
    fetchPinned("voices"),
    fetchPinned("config"),
    fetchPinned("cmudict"),
    fetchPinned("cmudictLicense"),
    fetchPinned("g2pWheel"),
  ]);
  const config = JSON.parse(new TextDecoder().decode(configBytes)) as {
    speed_priors?: Record<string, number>;
    voice_aliases: Record<string, string>;
  };
  const wheelFiles = unzip(wheel);
  const checkpoint = wheelFiles.get("g2p_en/checkpoint20.npz");
  const apache = wheelFiles.get("g2p_en-2.1.0.dist-info/LICENSE.txt");
  if (!checkpoint || !apache) throw new Error("g2p_en wheel lacks checkpoint20.npz or LICENSE.txt");

  const outputs = new Map<string, Uint8Array>();
  outputs.set("kitten-nano-0.8.onnx", model);
  const voices = readNpz(voicesNpz);
  const voiceId = config.voice_aliases[VOICE];
  const v = voiceId ? voices.get(voiceId) : undefined;
  if (!v) throw new Error(`voices.npz lacks ${VOICE} (${voiceId})`);
  if (v.shape[1] !== STYLE_WIDTH) throw new Error(`${voiceId}: style width ${v.shape[1]}, expected ${STYLE_WIDTH}`);
  outputs.set(`voice-${VOICE}.bin`, new Uint8Array(v.data.buffer, v.data.byteOffset, v.data.byteLength));
  outputs.set("lexicon.txt", new TextEncoder().encode(buildLexicon(new TextDecoder().decode(cmudict))));
  outputs.set("g2p.bin", packG2p(readNpz(checkpoint)));
  outputs.set("NOTICES.txt", new TextEncoder().encode(notices(new TextDecoder().decode(cmudictLicense), new TextDecoder().decode(apache))));

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  const urls = new Map<string, string>();
  for (const [name, data] of outputs) {
    // Workers static assets refuse files over 25 MiB at deploy time; fail the build instead.
    if (data.byteLength > 25 * 1024 * 1024) throw new Error(`${name} is ${data.byteLength} bytes, over the 25 MiB static asset limit`);
    await writeFile(join(OUT, name), data);
    const dot = name.lastIndexOf(".");
    const hashed = `${name.slice(0, dot)}.${shortHash(data)}${name.slice(dot)}`;
    await copyFile(join(OUT, name), join(DIST, hashed));
    urls.set(name, `${URL_BASE}/${hashed}`);
  }

  const manifest: Manifest = {
    model: urls.get("kitten-nano-0.8.onnx")!,
    lexicon: urls.get("lexicon.txt")!,
    g2p: urls.get("g2p.bin")!,
    notices: urls.get("NOTICES.txt")!,
    voice: { url: urls.get(`voice-${VOICE}.bin`)!, speed: config.speed_priors?.[voiceId] ?? 1 },
    bytes: {
      model: outputs.get("kitten-nano-0.8.onnx")!.byteLength,
      lexicon: outputs.get("lexicon.txt")!.byteLength,
      g2p: outputs.get("g2p.bin")!.byteLength,
      voice: outputs.get(`voice-${VOICE}.bin`)!.byteLength,
    },
  };
  await writeFile(join(CACHE, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const sizes = (await readdir(DIST)).length;
  console.log(`tts built in ${(performance.now() - t0).toFixed(0)} ms -> ${relative(ROOT, DIST)} (${sizes} files)`);
  return manifest;
}

if (import.meta.main) await buildTts();

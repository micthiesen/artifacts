// Listen's audio processing, done on the samples in the speech worker (no Web
// Audio: src/shared/sound.ts stays the only file that touches it).

export const SAMPLE_RATE = 24000;

/** Raises pitch by `factor` by resampling (which also shortens it by the same factor). */
export function resample(pcm: Float32Array, factor: number): Float32Array {
  const out = new Float32Array(Math.floor(pcm.length / factor));
  for (let i = 0; i < out.length; i++) {
    const x = i * factor;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = (pcm[j] ?? 0) * (1 - f) + (pcm[j + 1] ?? 0) * f;
  }
  return out;
}

/** A small, soft room (Schroeder: four combs into two allpasses), mixed in quietly, with its tail kept. */
export function room(pcm: Float32Array, wet = 0.14, rate = SAMPLE_RATE): Float32Array {
  const tail = Math.round(rate * 0.35);
  const n = pcm.length + tail;
  const dry = new Float32Array(n);
  dry.set(pcm);
  const sum = new Float32Array(n);
  for (const [ms, g] of [
    [29.7, 0.72],
    [37.1, 0.7],
    [41.1, 0.68],
    [43.7, 0.66],
  ] as const) {
    const d = Math.round((ms / 1000) * rate);
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      buf[i] = dry[i]! + (i >= d ? buf[i - d]! * g : 0);
      sum[i]! += buf[i]! * 0.25;
    }
  }
  let y = sum;
  for (const [ms, g] of [
    [5, 0.7],
    [1.7, 0.7],
  ] as const) {
    const d = Math.round((ms / 1000) * rate);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const xd = i >= d ? y[i - d]! : 0;
      const yd = i >= d ? out[i - d]! : 0;
      out[i] = -g * y[i]! + xd + g * yd;
    }
    y = out;
  }
  const mixed = new Float32Array(n);
  for (let i = 0; i < n; i++) mixed[i] = dry[i]! * (1 - wet) + y[i]! * wet;
  return mixed;
}

/** The ghost's voice: a touch higher and in a small soft room. */
export function ghostly(pcm: Float32Array, pitch: number): Float32Array {
  return room(resample(pcm, pitch));
}

/** 16-bit mono WAV, peak-limited so nothing clips. */
export function toWav(pcm: Float32Array, rate: number): ArrayBuffer {
  let peak = 0;
  for (const s of pcm) peak = Math.max(peak, Math.abs(s));
  const gain = peak > 0.98 ? 0.98 / peak : 1;
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i]! * gain)) * 0x7fff, true);
  return buf;
}

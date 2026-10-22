// Kitten TTS voices are tables of style vectors, one row per input length. The
// Python picks row min(len(text), rows - 1), where text is the chunk being
// spoken (before phonemisation) and len counts code points.

/** Floats per style row; the model's `style` input is [1, STYLE_WIDTH] float32. */
export const STYLE_WIDTH = 256;

/** The style row for a chunk of `textLength` code points (`[...chunk].length`). */
export function styleFor(voice: Float32Array, textLength: number): Float32Array {
  const rows = Math.floor(voice.length / STYLE_WIDTH);
  if (rows < 1) throw new Error("voice table is empty");
  const row = Math.min(Math.max(0, Math.floor(textLength)), rows - 1);
  return voice.slice(row * STYLE_WIDTH, (row + 1) * STYLE_WIDTH);
}

// What to say for one sentence, and which tokens say which words of it, so the
// reader can highlight the word being spoken.
//
//   for (const part of planParts(phonemizer, sentence)) {     // each within the model's 512 ids
//     const out = await session.run({ input_ids: part.ids, style: styleFor(voice, part.styleLength), speed });
//     const kept = out.waveform.data.length - 5000;          // the reference trims the tail
//     const times = wordTimes(part.words, out.duration.data, out.waveform.data.length, SAMPLE_RATE, kept / SAMPLE_RATE);
//   }
//
// plan(text).ids are exactly tokenize(phonemizer.phonemize(normalizeForSpeech(text))).

import { normalizeWithSpans } from "./normalize.ts";
import type { Phonemizer } from "./phonemize.ts";
import { tokenizeWithOffsets } from "./tokens.ts";

export const SAMPLE_RATE = 24000;

/** Kitten nano 0.8 fails on more input ids than this (its BERT's position table). */
export const MAX_IDS = 512;

/**
 * One spoken word: `src` is a half-open UTF-16 range of the original text,
 * `tokens` a half-open range of `ids`, `spoken` the range of the plan's
 * normalised text that says it.
 */
export type PlannedWord = { src: [number, number]; tokens: [number, number]; spoken: [number, number] };

export type Plan = {
  ids: number[];
  words: PlannedWord[];
  /** The normalised text this plan says (for a part from planParts, its share of the sentence's). */
  spoken: string;
  /** What to pass styleFor: the code-point length of `spoken`. */
  styleLength: number;
};

/**
 * Plans one sentence (raw, as on the page). Words come in order and never
 * overlap, in `src` or in `tokens`. An expansion ("$420", "2026-10-21") is one
 * word covering all the tokens that say it. Punctuation, the spaces between
 * words, and anything unspeakable (emoji, symbols) belong to no word.
 * Never throws for a string argument.
 */
export function plan(phonemizer: Phonemizer, text: string): Plan {
  const norm = normalizeWithSpans(text);
  const { phonemes, words: phWords } = phonemizer.phonemizeWords(norm.text);
  const { ids, start, end } = tokenizeWithOffsets(phonemes);

  const words: PlannedWord[] = [];
  for (const w of phWords) {
    const t0 = start[w.phonemes[0]];
    const t1 = end[w.phonemes[1]];
    if (t1 <= t0) continue;
    // Where in the source this word came from, without surrounding whitespace.
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = w.text[0]; i < w.text[1]; i++) {
      lo = Math.min(lo, norm.start[i]);
      hi = Math.max(hi, norm.end[i]);
    }
    if (lo === Infinity) continue;
    // Without surrounding spaces or the sentence's own punctuation (a rewrite can take a
    // full stop along: "3:30pm."), but keeping an abbreviation's dots ("U.S.").
    while (lo < hi && /\s/.test(text[lo])) lo++;
    while (hi > lo && (/[\s,;:!?\u2026]/.test(text[hi - 1]) || (text[hi - 1] === "." && !text.slice(lo, hi - 1).includes(".")))) hi--;
    if (hi <= lo) hi = Math.min(text.length, lo + 1);
    const prev = words[words.length - 1];
    // Words made from overlapping or touching source are one word: "Oct 21, 2026" ->
    // "October twenty-first, ...", "R2-D2's" -> "R two-D two's", "R&D" -> "R and D".
    if (prev && lo <= prev.src[1]) {
      prev.src = [Math.min(prev.src[0], lo), Math.max(prev.src[1], hi)];
      prev.tokens = [prev.tokens[0], Math.max(prev.tokens[1], t1)];
      prev.spoken = [prev.spoken[0], Math.max(prev.spoken[1], w.text[1])];
      continue;
    }
    words.push({ src: [lo, hi], tokens: [t0, t1], spoken: [w.text[0], w.text[1]] });
  }
  return { ids, words, spoken: norm.text, styleLength: [...norm.text].length };
}

const SPACE_ID = 16;
// Ids of ; : , . ! ? — … : good places to break a long plan.
const PAUSE_IDS = new Set([1, 2, 3, 4, 5, 6, 9, 10]);

/**
 * plan(), split so no part has more than `maxIds` ids (the model's limit).
 * Parts break between words, after punctuation where possible; a single word
 * too long for one part (a 1,000-digit number) is cut, and appears in both
 * parts with the same `src`. Each part is wrapped in the start and end ids
 * like a whole plan, and its words' `tokens` index its own `ids`.
 */
export function planParts(phonemizer: Phonemizer, text: string, maxIds = MAX_IDS): Plan[] {
  const whole = plan(phonemizer, text);
  if (whole.ids.length <= maxIds) return [whole];
  const body = whole.ids.slice(1, -2); // without the start and end ids
  const room = Math.max(1, maxIds - 3);
  // Token positions (in body) where a part may end: after a word or after punctuation.
  const wordEnds = new Set(whole.words.map((w) => w.tokens[1] - 1));
  const parts: Plan[] = [];
  let a = 0;
  while (a < body.length) {
    while (a < body.length && body[a] === SPACE_ID) a++;
    if (a >= body.length) break;
    let b = Math.min(body.length, a + room);
    if (b < body.length) {
      let best = -1;
      for (let i = b; i > a + room / 2; i--) {
        if (PAUSE_IDS.has(body[i - 1])) {
          best = i;
          break;
        }
        if (best < 0 && wordEnds.has(i)) best = i;
      }
      if (best > a) b = best;
    }
    const ids = [0, ...body.slice(a, b), whole.ids[whole.ids.length - 2], 0];
    const words: PlannedWord[] = [];
    for (const w of whole.words) {
      const t0 = Math.max(w.tokens[0] - 1, a);
      const t1 = Math.min(w.tokens[1] - 1, b);
      if (t1 <= t0) continue;
      words.push({ src: w.src, tokens: [t0 - a + 1, t1 - a + 1], spoken: w.spoken });
    }
    // This part's share of the normalised text: from its first word to the next part's first word.
    const from = parts.length === 0 ? 0 : (words[0]?.spoken[0] ?? 0);
    const next = whole.words.find((w) => w.tokens[0] - 1 >= b);
    const to = b >= body.length || !next ? whole.spoken.length : next.spoken[0];
    const spoken = whole.spoken.slice(from, Math.max(from, to)).trim();
    parts.push({ ids, words, spoken, styleLength: [...spoken].length });
    a = b;
  }
  return parts;
}

/**
 * Each word's start and end in seconds, from the model's per-token `durations`
 * (its "duration" output, in frames) and the length of its untrimmed waveform.
 * Samples per frame are taken as totalSamples / sum(durations): 600 for Kitten
 * nano 0.8, whose waveform is exactly 600 samples per duration frame.
 * Times past `limitSeconds` (e.g. the audio after trimming its tail) are clamped.
 */
export function wordTimes(
  words: Pick<PlannedWord, "src" | "tokens">[],
  durations: Float32Array | ArrayLike<number>,
  totalSamples: number,
  sampleRate = SAMPLE_RATE,
  limitSeconds = Infinity,
): { src: [number, number]; start: number; end: number }[] {
  const cum = new Float64Array(durations.length + 1);
  for (let i = 0; i < durations.length; i++) cum[i + 1] = cum[i] + Math.max(0, Number(durations[i]) || 0);
  const frames = cum[durations.length];
  const secondsPerFrame = frames > 0 ? totalSamples / frames / sampleRate : 0;
  const at = (token: number) => Math.min(limitSeconds, cum[Math.max(0, Math.min(durations.length, token))] * secondsPerFrame);
  return words.map((w) => ({ src: w.src, start: at(w.tokens[0]), end: at(w.tokens[1]) }));
}

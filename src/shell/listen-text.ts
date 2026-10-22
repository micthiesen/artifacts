// Listen's text handling in the shell: what it takes from the page, and how a page's blocks become sentences
// the voice says one at a time. Pure, so it is tested directly (listen-text.test.ts).
import type { SpeakUnit } from "../shared/protocol.ts";

/**
 * Long sentences are said in pieces of about this many characters, so the first sound comes quickly, a jump
 * never waits behind a long one, and the model doesn't drift.
 */
export const MAX_CHARS = 160;
/** What Listen takes from a page, at most. Beyond this it reads up to here and says so. */
export const MAX_UNITS = 5000;
export const MAX_UNIT_CHARS = 20_000;
export const MAX_TOTAL_CHARS = 1_000_000;

/** One thing the voice says: [start, start + text.length) in unit `unit`'s text, under heading `h`. */
export type Sentence = { unit: number; start: number; text: string; h?: string; chars: number };

/** The frame is untrusted: a bounded, well-formed copy of what it sent, and whether anything was left out. */
export function takeUnits(raw: unknown): { units: SpeakUnit[]; truncated: boolean } {
  if (!Array.isArray(raw)) return { units: [], truncated: false };
  const units: SpeakUnit[] = [];
  let total = 0;
  let truncated = raw.length > MAX_UNITS;
  for (const u of raw.slice(0, MAX_UNITS) as Partial<SpeakUnit>[]) {
    if (typeof u?.i !== "number" || typeof u.text !== "string") continue;
    if (u.text.length > MAX_UNIT_CHARS) truncated = true;
    const text = u.text.slice(0, MAX_UNIT_CHARS);
    if (total + text.length > MAX_TOTAL_CHARS) {
      truncated = true;
      break;
    }
    total += text.length;
    units.push({ i: u.i, text, h: typeof u.h === "string" ? u.h.slice(0, 200) : undefined });
  }
  return { units, truncated };
}

const MONTH = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}$/;
/** A space right after these would split a phrase the normaliser reads as one ("$1.2 million", "Oct 21"). */
const NO_BREAK_AFTER = /(?:[$€£]\s?\d[\d.,]*|\d[\d.,]*|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?)$/;

/**
 * Where to break a sentence longer than MAX_CHARS: [start, end) pieces of `text`, trimmed. Prefers a break
 * after ; : or a dash, then after a comma (not inside a date like "Oct 21, 2026"), then at a space that doesn't
 * split a number from its unit, and only as a last resort mid-word.
 */
export function pieces(text: string, max = MAX_CHARS): [number, number][] {
  const out: [number, number][] = [];
  let a = 0;
  while (text.length - a > max) {
    const win = text.slice(a, a + max + 1);
    const floor = Math.floor(max / 3);
    let strong = -1;
    let comma = -1;
    let space = -1;
    for (const m of win.matchAll(/\s+/g)) {
      const at = m.index!;
      if (at < floor) continue;
      const before = win.slice(0, at);
      const after = win.slice(at + m[0].length);
      if (/[;:—–]$/.test(before)) strong = at;
      else if (/,$/.test(before) && !(MONTH.test(before.slice(0, -1)) && /^\d{4}\b/.test(after))) comma = at;
      else if (!NO_BREAK_AFTER.test(before)) space = at;
    }
    const cut = strong >= 0 ? strong : comma >= 0 ? comma : space >= 0 ? space : -1;
    if (cut < 0) {
      out.push([a, a + max]);
      a += max;
    } else {
      out.push([a, a + cut]);
      a += cut;
    }
    while (/\s/.test(text[a] ?? "")) a++;
  }
  if (a < text.length) out.push([a, text.length]);
  return out.filter(([s, e]) => /[\p{L}\p{N}]/u.test(text.slice(s, e)));
}

/** A page's blocks as the sentences the voice says, each pointing back at where it sits in its block. */
export function splitSentences(units: SpeakUnit[], segmenter: { segment(s: string): Iterable<{ index: number; segment: string }> } | null = defaultSegmenter()): Sentence[] {
  const out: Sentence[] = [];
  for (const u of units) {
    const parts = segmenter
      ? [...segmenter.segment(u.text)].map((s) => ({ index: s.index, segment: s.segment }))
      : [...u.text.matchAll(/[^.!?]+[.!?]*\s*/g)].map((m) => ({ index: m.index!, segment: m[0] }));
    for (const { index, segment } of parts) {
      const lead = segment.length - segment.trimStart().length;
      const text = segment.trim();
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      for (const [s, e] of pieces(text)) {
        const piece = text.slice(s, e);
        out.push({ unit: u.i, start: index + lead + s, text: piece, h: u.h, chars: piece.length });
      }
    }
  }
  return out;
}

function defaultSegmenter() {
  return typeof Intl.Segmenter === "function" ? new Intl.Segmenter("en", { granularity: "sentence" }) : null;
}

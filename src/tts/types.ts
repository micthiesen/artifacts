// Messages between the shell's Listen player and the speech worker, and the
// asset manifest scripts/build-tts.ts writes.

export type TtsManifest = {
  model: string;
  lexicon: string;
  g2p: string;
  notices: string;
  /** The one voice (Bruno), with its speed prior from the model's config. */
  voice: { url: string; speed: number };
  /** Uncompressed sizes, so the first download can show real progress. */
  bytes: { model: number; lexicon: number; g2p: number; voice: number };
};

/** A spoken word: [s, e) in the sentence's text, and when it is heard, in seconds of audio. */
export type TimedWord = { s: number; e: number; t0: number; t1: number };

/** The longest sentence the worker will say; the shell splits text well under this. */
export const MAX_SENTENCE = 1000;

export type ToWorker =
  /**
   * Start downloading everything before the first sentence is asked for, from `base` (the apex origin):
   * browsers cache by URL, so one origin for every workspace means one download for all of them.
   */
  | { t: "load"; base: string }
  /** At most MAX_SENTENCE characters; longer text is cut. */
  | { t: "synth"; id: number; text: string }
  /** Drop queued sentences with an id below this (the reader jumped). */
  | { t: "cancel"; before: number };

export type FromWorker =
  | { t: "progress"; loaded: number; total: number }
  | { t: "ready" }
  /** A WAV file of one sentence, and when each word is heard. */
  | { t: "audio"; id: number; wav: ArrayBuffer; words: TimedWord[] }
  | { t: "error"; id?: number; message: string; fatal?: boolean };

// Messages between the shell's Listen player and the speech worker, and the
// asset manifest scripts/build-tts.ts writes.

export type TtsManifest = {
  model: string;
  lexicon: string;
  g2p: string;
  notices: string;
  voices: Record<string, { url: string; speed: number }>;
};

export type ToWorker =
  /** Start downloading the model (and this voice) before the first sentence is asked for. */
  | { t: "load"; voice: string }
  | { t: "synth"; id: number; text: string; voice: string; ghost: boolean }
  /** Drop queued sentences with an id below this (the reader jumped or changed the voice). */
  | { t: "cancel"; before: number };

export type FromWorker =
  | { t: "progress"; loaded: number; total: number }
  | { t: "ready"; ms: number }
  /** A WAV file of one sentence, how long it took to make and how long it plays. */
  | { t: "audio"; id: number; wav: ArrayBuffer; ms: number; seconds: number; phonemes: string }
  | { t: "error"; id?: number; message: string };

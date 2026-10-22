import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { espeakPhonemize, hasEspeak } from "../../spikes/tts-say.ts";
import { normalizeForSpeech } from "./normalize.ts";
import { HELD_OUT } from "./test-sentences.ts";
import { G2p, Phonemizer, arpabetToIpa } from "./phonemize.ts";

const OUT = join(import.meta.dir, "../../node_modules/.cache/tts/out");
const built = existsSync(join(OUT, "lexicon.txt")) && existsSync(join(OUT, "g2p.bin"));
const g2pBytes = () => {
  const b = readFileSync(join(OUT, "g2p.bin"));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
let shared: Phonemizer | undefined;
const phonemizer = () => (shared ??= new Phonemizer(readFileSync(join(OUT, "lexicon.txt"), "utf8"), g2pBytes()));

describe("arpabetToIpa", () => {
  const cases: [string, string, string][] = [
    ["hello", "HH AH0 L OW1", "həlˈoʊ"],
    ["world", "W ER1 L D", "wˈɜːld"],
    ["button", "B AH1 T AH0 N", "bˈʌʔn\u0329"],
    ["city", "S IH1 T IY0", "sˈɪɾi"],
    ["party", "P AA1 R T IY0", "pˈɑːɹɾi"],
    ["wanted", "W AO1 N T IH0 D", "wˈɔːntᵻd"],
    ["every", "EH1 V ER0 IY0", "ˈɛvɹi"],
    ["inbox", "IH1 N B AA2 K S", "ˈɪnbɑːks"],
    ["everyone", "EH1 V R IY0 W AH2 N", "ˈɛvɹiwˌʌn"],
    ["request", "R IH0 K W EH1 S T", "ɹᵻkwˈɛst"],
    ["about", "AH0 B AW1 T", "ɐbˈaʊt"],
    ["limit", "L IH1 M AH0 T", "lˈɪmɪt"],
    ["long", "L AO1 NG", "lˈɔŋ"],
    ["computer", "K AH0 M P Y UW1 T ER0", "kəmpjˈuːɾɚ"],
  ];
  for (const [word, arpa, ipa] of cases) test(word, () => expect(arpabetToIpa(arpa.split(" "), word)).toBe(ipa));
});

describe.skipIf(!built)("with built assets (bun scripts/build-tts.ts)", () => {
  test("the g2p GRU matches g2p_en's Python predictions", () => {
    // Computed with g2p_en 2.1.0's predict() in NumPy (float32 weights).
    const expected: Record<string, string> = {
      kubernetes: "K AH0 B ER1 N AH0 T S",
      webassembly: "W EH1 B AH0 S M AH0 B L IY0",
      onnx: "AA1 N K S",
      anthropic: "AE2 N TH R AH0 P IH1 K",
      tailwind: "T EY1 L W EH2 N D",
      supabase: "S UW1 P AH0 B EY2 S",
      karakeep: "K EH1 R AH0 K IY2 P",
      activationist: "AE2 K T IH0 V EY1 SH AH0 N IH0 S T",
      blorptastic: "B L AO2 R P T AE1 S T IH0 K",
      zustand: "Z AH1 S T AH0 N D",
    };
    const g2p = new G2p(g2pBytes());
    for (const [word, arpa] of Object.entries(expected)) expect(g2p.predict(word).join(" ")).toBe(arpa);
  });

  test("phonemizes like espeak-ng en-us", () => {
    const p = phonemizer();
    expect(p.phonemize("Hello, world.")).toBe("həlˈoʊ, wˈɜːld.");
    expect(p.phonemize("The quick brown fox.")).toBe("ðə kwˈɪk bɹˈaʊn fˈɑːks.");
    expect(p.phonemize("the apple")).toBe("ðɪ ˈæpəl");
    expect(p.phonemize("Ask the MCP server.")).toBe("ˈæsk ðɪ ˌɛmsˌiːpˈiː sˈɜːvɚ.");
    expect(p.phonemize("APIs")).toBe("ˌeɪpˌiːˈaɪz");
    expect(p.phonemize("It's Michael's turn; we're done.")).toBe("ɪts mˈaɪkəlz tˈɜːn; wɪɹ dˈʌn.");
    expect(p.phonemize("month-over-month")).toBe("mˈʌnθˈoʊvɚmˈʌnθ");
    expect(p.phonemize("I read it.")).toBe("aɪ ɹˈiːd ɪt.");
    expect(p.phonemize("NASA")).toBe(p.phonemize("nasa"));
    expect(p.phonemize("OpenAI")).toBe("ˈoʊpən ˌeɪˈaɪ");
    expect(p.phonemize("after a while")).toBe("ˈæftɚɹ ɐ wˌaɪl");
    // Out of the dictionary: the GRU, with espeak's stress marks.
    expect(p.phonemize("kubernetes")).toBe("kəbˈɜːnɪts");
  });

  test.skipIf(!hasEspeak())(
    "similarity to espeak-ng over varied sentences (dev only; espeak-ng never ships)",
    () => {
      const p = phonemizer();
      let distance = 0;
      let length = 0;
      for (const sentence of HELD_OUT) {
        const text = normalizeForSpeech(sentence);
        const ours = [...p.phonemize(text)];
        const ref = [...espeakPhonemize(text)];
        distance += levenshtein(ours, ref);
        length += Math.max(ours.length, ref.length);
      }
      const similarity = 1 - distance / length;
      console.log(`phoneme similarity to espeak-ng: ${(similarity * 100).toFixed(1)}% over ${HELD_OUT.length} sentences`);
      expect(similarity).toBeGreaterThan(0.92);
    },
    60_000,
  );
});

function levenshtein(a: string[], b: string[]): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

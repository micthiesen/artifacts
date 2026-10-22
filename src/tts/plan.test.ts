import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeForSpeech } from "./normalize.ts";
import { Lexicon, Phonemizer } from "./phonemize.ts";
import { MAX_IDS, type Plan, plan, planParts, wordTimes } from "./plan.ts";
import { HELD_OUT, TUNING } from "./test-sentences.ts";
import { tokenize } from "./tokens.ts";

const OUT = join(import.meta.dir, "../../node_modules/.cache/tts/out");
const built = existsSync(join(OUT, "lexicon.txt")) && existsSync(join(OUT, "g2p.bin"));
let shared: Phonemizer | undefined;
const phonemizer = () => {
  if (!shared) {
    const g2p = readFileSync(join(OUT, "g2p.bin"));
    shared = new Phonemizer(readFileSync(join(OUT, "lexicon.txt"), "utf8"), g2p.buffer.slice(g2p.byteOffset, g2p.byteOffset + g2p.byteLength) as ArrayBuffer);
  }
  return shared;
};
const SENTENCES = [...TUNING, ...HELD_OUT];

/** Words are in order, non-overlapping in source and tokens, inside the text and ids, and never on punctuation-only tokens. */
function checkShape(text: string, p: Plan) {
  let lastSrc = 0;
  let lastTok = 1;
  for (const w of p.words) {
    expect(w.src[0]).toBeGreaterThanOrEqual(lastSrc);
    expect(w.src[1]).toBeGreaterThan(w.src[0]);
    expect(w.src[1]).toBeLessThanOrEqual(text.length);
    expect(w.tokens[0]).toBeGreaterThanOrEqual(lastTok);
    expect(w.tokens[1]).toBeGreaterThan(w.tokens[0]);
    expect(w.tokens[1]).toBeLessThanOrEqual(p.ids.length - 2);
    lastSrc = w.src[1];
    lastTok = w.tokens[1];
  }
}

const said = (text: string, p: Plan) => p.words.map((w) => text.slice(...w.src));

describe.skipIf(!built)("plan (needs bun scripts/build-tts.ts)", () => {
  test("ids are exactly the pipeline's, and unchanged from before word timing", () => {
    const p = phonemizer();
    const all: string[] = [];
    for (const s of SENTENCES) {
      const ids = plan(p, s).ids;
      expect(ids).toEqual(tokenize(p.phonemize(normalizeForSpeech(s))));
      all.push(ids.join(","));
    }
    // sha256 of the ids the pipeline produced before plan.ts existed. Changing the
    // normaliser, the phonemizer's rules or the lexicon changes this on purpose: update it then.
    const digest = new Bun.CryptoHasher("sha256").update(all.join("\n")).digest("hex");
    expect(digest).toBe("15a51f4ace563782c49c5f88bc1961a1fa24902bb8704c7d1a86c34a169ae94a");
  });

  test("words cover every letter and digit of the sentences, in order", () => {
    const p = phonemizer();
    for (const s of SENTENCES) {
      const pl = plan(p, s);
      checkShape(s, pl);
      const covered = new Uint8Array(s.length);
      for (const w of pl.words) covered.fill(1, ...w.src);
      for (let i = 0; i < s.length; i++) if (/[\p{L}\p{N}]/u.test(s[i])) expect(`${s}@${i}:${covered[i]}`).toBe(`${s}@${i}:1`);
    }
  });

  test("hand cases", () => {
    const p = phonemizer();
    const cases: [string, string[]][] = [
      ["Hello, world.", ["Hello", "world"]],
      ["It costs $420 — that's 15% off!", ["It", "costs", "$420", "that's", "15%", "off"]],
      ["See https://github.com/foo/bar?x=1 or mail michael@thiesen.dev.", ["See", "https://github.com/foo/bar?x=1", "or", "mail", "michael@thiesen.dev"]],
      ["Michael's MCP server isn't month-over-month 😀 ready.", ["Michael's", "MCP", "server", "isn't", "month-over-month", "ready"]],
      ["We met on Oct 21, 2026 at 3:30pm.", ["We", "met", "on", "Oct 21, 2026", "at", "3:30pm"]],
      ["The build took 6m 10s (v1.2.3).", ["The", "build", "took", "6m", "10s", "v1.2.3"]],
      ["“Quoted” words… and ★ stars ☃!", ["Quoted", "words", "and", "stars"]],
      ["Our R&D team uses M3 chips.", ["Our", "R&D", "team", "uses", "M3", "chips"]],
      ["Costs $5-10/mo, <2% fees.", ["Costs", "$5-10/mo", "<2%", "fees"]],
      ["Edit ./src/speak.ts at 9am-5pm.", ["Edit", "src", "speak.ts", "at", "9am-5pm"]],
      ["GPT-4 & R2-D2's 1920×1080 screen", ["GPT-4", "&", "R2-D2's", "1920×1080", "screen"]],
    ];
    for (const [text, words] of cases) {
      const pl = plan(p, text);
      checkShape(text, pl);
      expect(said(text, pl)).toEqual(words);
    }
  });

  test("an expansion's tokens all belong to its one word; punctuation to none", () => {
    const p = phonemizer();
    const text = "Pay $420, now.";
    const pl = plan(p, text);
    const money = pl.words[1];
    expect(text.slice(...money.src)).toBe("$420");
    expect(pl.ids.slice(...money.tokens)).toEqual(tokenize(p.phonemize("four hundred twenty dollars")).slice(1, -2));
    const comma = pl.ids.indexOf(3);
    expect(pl.words.some((w) => w.tokens[0] <= comma && comma < w.tokens[1])).toBe(false);
  });

  test("never throws, and stays fast, on arbitrary text", () => {
    const p = phonemizer();
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pools = [
      "abcdefghijklmnopqrstuvwxyz ", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "0123456789",
      " .,;:!?-—–…'\"()[]{}$€£%&@#/\\*+=~<>|_^`×°", "éüñçøßİı", "日本語中文한국어가", "😀👍🏽🇨🇦\u200d",
      "\u0301\u0329\u200b\u00a0\n\t\r\u2028", "ـ\u064b\u064c\u064d\u064e\u064f\u0650\u0651\u0652", "𐏿\ud83d",
    ];
    const texts: string[] = [];
    for (let i = 0; i < 300; i++) {
      let s = "";
      const n = Math.floor(rnd() * 120);
      for (let j = 0; j < n; j++) {
        const pool = pools[Math.floor(rnd() * pools.length)];
        s += pool[Math.floor(rnd() * pool.length)];
      }
      texts.push(s);
    }
    texts.push(
      "the quick brown fox ".repeat(1000), "1".repeat(5000), `${"1".repeat(400)}st`, `${"a.".repeat(5000)}com`,
      `https://${"a".repeat(10000)}`, "x".repeat(10000), "a-".repeat(5000), " ".repeat(10000), "😀".repeat(5000),
      `e${"\u0301".repeat(5000)}`, "$1,000,000.5% 12:30pm v1.2.3 ".repeat(300), `$${"9".repeat(30)}M`,
      "100000000000000000000th", "2026-13-45 9999-99-99", "", " ", ".", "'", "-", "—",
    );
    const t0 = performance.now();
    for (const text of texts) {
      const pl = plan(p, text);
      checkShape(text, pl);
      for (const part of planParts(p, text)) {
        expect(part.ids.length).toBeLessThanOrEqual(MAX_IDS);
        checkShape(text, part);
      }
    }
    expect(performance.now() - t0).toBeLessThan(10_000);
  }, 30_000);

  test("planParts keeps every part within the model's limit, broken at punctuation", () => {
    const p = phonemizer();
    const text = HELD_OUT.join(" ");
    const whole = plan(p, text);
    expect(whole.ids.length).toBeGreaterThan(MAX_IDS);
    const parts = planParts(p, text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.ids.length).toBeLessThanOrEqual(MAX_IDS);
      expect(part.ids[0]).toBe(0);
      expect(part.ids.slice(-2)).toEqual([10, 0]);
      expect(part.styleLength).toBe([...part.spoken].length);
      expect(part.spoken.length).toBeGreaterThan(0);
    }
    expect(parts.flatMap((part) => said(text, part))).toEqual(said(text, whole));
    // Each part's style length comes from the normalised text it says, which together make the whole.
    expect(parts.map((part) => part.spoken).join(" ")).toBe(whole.spoken);
    expect(planParts(p, "Short.")).toEqual([plan(p, "Short.")]);
  });
});

describe("wordTimes", () => {
  test("converts token durations to seconds at totalSamples / sum(durations) samples per frame", () => {
    const words = [
      { src: [0, 5] as [number, number], tokens: [1, 3] as [number, number] },
      { src: [6, 11] as [number, number], tokens: [4, 6] as [number, number] },
    ];
    const durations = [10, 2, 3, 1, 4, 4, 6];
    const times = wordTimes(words, durations, 30 * 600, 24000);
    expect(times.map((t) => t.src)).toEqual([[0, 5], [6, 11]]);
    expect(times.flatMap((t) => [t.start, t.end]).map((x) => Math.round(x * 1e9) / 1e9)).toEqual([0.25, 0.375, 0.4, 0.6]);
    expect(wordTimes(words, new Float32Array(durations), 30 * 600, 24000, 0.5)[1].end).toBe(0.5);
    expect(wordTimes(words, [], 0)).toEqual([
      { src: [0, 5], start: 0, end: 0 },
      { src: [6, 11], start: 0, end: 0 },
    ]);
  });
});

describe("Lexicon", () => {
  test("finds every entry by binary search, and nothing else", () => {
    const entries = ["a\tə", "aa\tɑː", "b\tb", "bb\tbb", "c'est\tse", "zz\tz"];
    const lex = new Lexicon(`${entries.join("\n")}\n`);
    for (const e of entries) {
      const [w, ipa] = e.split("\t");
      expect(lex.get(w)).toBe(ipa);
    }
    for (const miss of ["", "0", "ab", "ba", "zzz", "c", "￿"]) expect(lex.get(miss)).toBeUndefined();
  });

  test.skipIf(!built)("agrees with a full parse of the built lexicon", () => {
    const text = readFileSync(join(OUT, "lexicon.txt"), "utf8");
    const lex = new Lexicon(text);
    const lines = text.split("\n").filter(Boolean);
    for (let i = 0; i < lines.length; i += 97) {
      const [w, ipa] = lines[i].split("\t");
      expect(lex.get(w)).toBe(ipa);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { chunkText, normalizeForSpeech, numberToWords, ordinalToWords, yearToWords } from "./normalize.ts";

const CASES: [string, string][] = [
  ["$420", "four hundred twenty dollars"],
  ["CA$12", "twelve Canadian dollars"],
  ["€5", "five euros"],
  ["$4.99", "four dollars and ninety-nine cents"],
  ["$0.50", "fifty cents"],
  ["$1", "one dollar"],
  ["$2.5M", "two point five million dollars"],
  ["€1,200.50", "twelve hundred euros and fifty cents"],
  ["12 USD", "twelve US dollars"],
  ["15%", "fifteen percent"],
  ["3.5%", "three point five percent"],
  ["1st", "first"],
  ["22nd", "twenty-second"],
  ["103rd", "one hundred third"],
  ["1999", "nineteen ninety-nine"],
  ["2005", "two thousand five"],
  ["2026", "twenty twenty-six"],
  ["3.14", "three point one four"],
  ["-5", "minus five"],
  ["0.5", "zero point five"],
  [".5", "zero point five"],
  ["1,234", "one thousand two hundred thirty-four"],
  ["3:30pm", "three thirty PM"],
  ["14:00", "fourteen hundred"],
  ["9:05 AM", "nine oh five AM"],
  ["10:15:30", "ten fifteen and thirty seconds"],
  ["2026-10-21", "October twenty-first, twenty twenty-six"],
  ["2026-10-21T14:05:00Z", "October twenty-first, twenty twenty-six, at fourteen oh five UTC"],
  ["Oct 21, 2026", "October twenty-first, twenty twenty-six"],
  ["21 October 2026", "the twenty-first of October twenty twenty-six"],
  ["v1.2.3", "version one point two point three"],
  ["v2", "version two"],
  ["1.2.3", "one point two point three"],
  ["12 MB", "twelve megabytes"],
  ["2.5GB", "two point five gigabytes"],
  ["300ms", "three hundred milliseconds"],
  ["10km", "ten kilometers"],
  ["6m 10s", "six minutes ten seconds"],
  ["1h 30m", "one hour thirty minutes"],
  ["45s", "forty-five seconds"],
  ["3×", "three times"],
  ["1920×1080", "nineteen twenty by ten eighty"],
  ["R&D", "R and D"],
  ["Tom & Jerry", "Tom and Jerry"],
  ["https://github.com/foo/bar", "github dot com"],
  ["www.example.com/x", "example dot com"],
  ["artifacts.boo", "artifacts dot boo"],
  ["michael@thiesen.dev", "michael at thiesen dot dev"],
  ["Dr. Smith", "Doctor Smith"],
  ["e.g. this", "for example this"],
  ["i.e. that", "that is that"],
  ["etc.", "et cetera."],
  ["vs.", "versus"],
  ["GPT-4", "GPT four"],
  ["7B", "seven billion"],
  ["1/2", "one half"],
  ["the 1990s", "the nineteen nineties"],
  ["'90s", "nineties"],
  ["COVID-19", "COVID nineteen"],
  ["007", "zero zero seven"],
  ["M3", "M three"],
  ["#5", "number five"],
  ["~10", "about ten"],
  ["->", "to"],
  ["(see above)", "see above"],
  ["Heading\nBody text", "Heading. Body text"],
  ["line one,\nline two", "line one, line two"],
];

describe("normalizeForSpeech", () => {
  for (const [input, spoken] of CASES) test(JSON.stringify(input), () => expect(normalizeForSpeech(input)).toBe(spoken));

  test("sentences keep their punctuation and casing", () => {
    expect(normalizeForSpeech("It costs $420, or CA$12 and €5 — that's 15% off.")).toBe(
      "It costs four hundred twenty dollars, or twelve Canadian dollars and five euros — that's fifteen percent off.",
    );
    expect(normalizeForSpeech("The build took 6m 10s on the 3rd try; v1.2.3 is 2.5GB.")).toBe(
      "The build took six minutes ten seconds on the third try; version one point two point three is two point five gigabytes.",
    );
    expect(normalizeForSpeech("See https://github.com/foo/bar?x=1. Then mail michael@thiesen.dev!")).toBe(
      "See github dot com. Then mail michael at thiesen dot dev!",
    );
    expect(normalizeForSpeech("Dr. Smith & Mr. Jones met at 3:30pm on Oct 21, 2026 (in the 1990s style).")).toBe(
      "Doctor Smith and Mister Jones met at three thirty PM on October twenty-first, twenty twenty-six, in the nineteen nineties style.",
    );
  });

  test("leaves no digits or stray symbols", () => {
    const out = normalizeForSpeech("Up 12.5% to $3.2B in Q3 2026 (vs. 9% & 4x) — see #42, ~3 GB/s, 50°C, 1e-4.");
    expect(out).not.toMatch(/[0-9$%&#~()°/]/);
  });
});

describe("number words", () => {
  test("cardinals, ordinals and years", () => {
    expect(numberToWords(0)).toBe("zero");
    expect(numberToWords(42)).toBe("forty-two");
    expect(numberToWords(1200)).toBe("twelve hundred");
    expect(numberToWords(1000)).toBe("one thousand");
    expect(numberToWords(2_000_001)).toBe("two million one");
    expect(ordinalToWords(21)).toBe("twenty-first");
    expect(ordinalToWords(12)).toBe("twelfth");
    expect(ordinalToWords(40)).toBe("fortieth");
    expect(yearToWords(1905)).toBe("nineteen oh five");
    expect(yearToWords(2000)).toBe("two thousand");
  });
});

describe("chunkText", () => {
  test("splits at sentence ends but not after abbreviations, and ends each chunk in punctuation", () => {
    expect(chunkText("Hi there. Dr. Who is here! What? ok")).toEqual(["Hi there.", "Dr. Who is here!", "What?", "ok,"]);
  });

  test("breaks long sentences between words", () => {
    const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkText(long, 100);
    expect(chunks.every((c) => c.length <= 101)).toBe(true);
    expect(chunks.join(" ").replace(/,/g, "")).toBe(long);
  });
});

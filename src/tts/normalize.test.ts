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
  ["10:15:30", "ten hours fifteen minutes thirty seconds"],
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

// Each defect from the speech audit, mid-sentence and at the end of a sentence.
// "{}" in a template is replaced by the input, and by the expected words.
const AUDIT: [string, string, string][] = [
  // 1. Ranges keep "to" before a full stop.
  ["We saw 2020-2024", "We saw twenty twenty to twenty twenty-four", "ranges"],
  ["It scored 3–2", "It scored three to two", "ranges"],
  ["Read pages 10-20", "Read pages ten to twenty", "ranges"],
  // 2. Money and time ranges.
  ["It costs $5-10", "It costs five to ten dollars", "money ranges"],
  ["It costs $5–$10", "It costs five to ten dollars", "money ranges"],
  ["It costs $2.50-$4", "It costs two dollars and fifty cents to four dollars", "money ranges"],
  ["Open 9am-5pm", "Open nine AM to five PM", "time ranges"],
  ["Open 9am–5pm", "Open nine AM to five PM", "time ranges"],
  ["Open 9:30am-5:15pm", "Open nine thirty AM to five fifteen PM", "time ranges"],
  // 3. Rates.
  ["It is $12.50/mo", "It is twelve dollars and fifty cents per month", "rates"],
  ["It is $0.0002/min", "It is zero point zero zero zero two dollars per minute", "rates"],
  ["It reads 10 MB/s", "It reads ten megabytes per second", "rates"],
  ["It stores 24 GB/mo", "It stores twenty-four gigabytes per month", "rates"],
  ["It is $5/user", "It is five dollars per user", "rates"],
  ["It is $8/seat", "It is eight dollars per seat", "rates"],
  ["It is $99/yr", "It is ninety-nine dollars per year", "rates"],
  ["It is $2/hr", "It is two dollars per hour", "rates"],
  ["It is $1/day", "It is one dollar per day", "rates"],
  ["It is $0.01/req", "It is one cent per request", "rates"],
  // 4. Comparisons.
  ["Errors stay <2%", "Errors stay under two percent", "comparisons"],
  ["Latency is >5 ms", "Latency is over five milliseconds", "comparisons"],
  ["We need ≥10 users", "We need at least ten users", "comparisons"],
  ["We need >=10 users", "We need at least ten users", "comparisons"],
  ["Retry ≤3 times", "Retry at most three times", "comparisons"],
  ["Retry <=3 times", "Retry at most three times", "comparisons"],
  ["Check that a < b", "Check that a less than b", "comparisons"],
  ["Check that x ≥ y", "Check that x at least y", "comparisons"],
  // 5. Scale words after money.
  ["They raised $1.5 billion", "They raised one point five billion dollars", "money scale"],
  ["They raised $5 million", "They raised five million dollars", "money scale"],
  // 6. Fractions and ratios.
  ["Support runs 24/7", "Support runs twenty-four seven", "ratios"],
  ["We split it 50/50", "We split it fifty fifty", "ratios"],
  ["It got 4.5/5 stars", "It got four point five out of five stars", "ratios"],
  ["We had 12/15 passing", "We had twelve out of fifteen passing", "ratios"],
  ["Add 1/2 cup", "Add one half cup", "ratios"],
  ["Add 3/4 cup", "Add three quarters cup", "ratios"],
  ["Add 2/3 cup", "Add two thirds cup", "ratios"],
  // 8. Dotted identifiers.
  ["Install Node.js", "Install Node JS", "dotted"],
  ["Edit speak.ts", "Edit speak dot TS", "dotted"],
  ["Run ./scripts/build.sh", "Run scripts build dot SH", "dotted"],
  ["Run ../tools/x.py", "Run tools x dot PY", "dotted"],
  ["Open package.json", "Open package dot JSON", "dotted"],
  ["Open main.go", "Open main dot go", "dotted"],
  ["They moved to the U.S. Army", "They moved to the US Army", "dotted"],
  ["She has a Ph.D. degree", "She has a PHD degree", "dotted"],
  ["He studied at M.I.T. once", "He studied at MIT once", "dotted"],
  // 10. Signs, symbols and the rest.
  ["Revenue is up +5", "Revenue is up plus five", "signs"],
  ["Revenue is up +250%", "Revenue is up plus two hundred fifty percent", "signs"],
  ["It fell \u22123 points", "It fell minus three points", "signs"],
  ["The value is 2e3", "The value is two times ten to the three", "signs"],
  ["She won the 100m dash", "She won the one hundred meters dash", "meters"],
  ["It took 1h 30m", "It took one hour thirty minutes", "durations"],
  ["It took 6m 10s", "It took six minutes ten seconds", "durations"],
  ["It costs 5 €", "It costs five euros", "trailing currency"],
  ["It costs 20 £", "It costs twenty pounds", "trailing currency"],
  ["I write C++", "I write C plus plus", "languages"],
  ["I write C#", "I write C sharp", "languages"],
  ["Set x = y + 1", "Set x equals y plus one", "operators"],
  ["It ran 01:23:45", "It ran one hour twenty-three minutes forty-five seconds", "clock durations"],
  ["It ran 00:05:12", "It ran five minutes twelve seconds", "clock durations"],
  ["Open localhost:3000", "Open localhost port three thousand", "ports"],
  ["Open example.com:8080", "Open example dot com port eight thousand eighty", "ports"],
];

describe("audit: mid-sentence and at the end", () => {
  for (const [input, spoken, kind] of AUDIT) {
    test(`${kind}: ${input}`, () => {
      expect(normalizeForSpeech(`${input} today.`)).toBe(`${spoken} today.`);
      expect(normalizeForSpeech(`${input}.`)).toBe(`${spoken}.`);
      expect(normalizeForSpeech(`${input}. Then more.`)).toBe(`${spoken}. Then more.`);
    });
  }

  // 9. Abbreviations whose stop ends the sentence keep the break.
  const BREAKS: [string, string][] = [
    ["Meet at 3 PM. Then go.", "Meet at three PM. Then go."],
    ["Meet at 3 p.m. Then go.", "Meet at three PM. Then go."],
    ["Meet at 3pm. Then go.", "Meet at three PM. Then go."],
    ["Meet at 3:30 p.m. Then go.", "Meet at three thirty PM. Then go."],
    ["Meet at 3 p.m.", "Meet at three PM."],
    ["Bring apples, pears, etc. Then go.", "Bring apples, pears, et cetera. Then go."],
    ["Bring apples, pears, etc.", "Bring apples, pears, et cetera."],
    ["Bring apples etc. to the party.", "Bring apples et cetera to the party."],
    ["Meet at 3 p.m. today.", "Meet at three PM today."],
    ["It came from the U.K.", "It came from the UK."],
    ["Dr. Smith is here.", "Doctor Smith is here."],
  ];
  for (const [input, spoken] of BREAKS) test(`sentence breaks: ${input}`, () => expect(normalizeForSpeech(input)).toBe(spoken));
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

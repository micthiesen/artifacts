import { expect, test } from "bun:test";
import { MAX_CHARS, MAX_UNITS, pieces, splitSentences, takeUnits } from "../src/shell/listen-text.ts";

const unit = (i: number, text: string, h?: string) => ({ i, text, h });

test("sentences point back at exactly their text in the block", () => {
  const u = unit(3, "First one.  Second, with a comma! Third?", "Costs");
  const out = splitSentences([u]);
  expect(out.map((s) => s.text)).toEqual(["First one.", "Second, with a comma!", "Third?"]);
  for (const s of out) {
    expect(u.text.slice(s.start, s.start + s.text.length)).toBe(s.text);
    expect(s.unit).toBe(3);
    expect(s.h).toBe("Costs");
  }
});

test("the fallback splitter (no Intl.Segmenter) keeps offsets right too", () => {
  const u = unit(0, "One. Two! Three");
  const out = splitSentences([u], null);
  expect(out.map((s) => s.text)).toEqual(["One.", "Two!", "Three"]);
  for (const s of out) expect(u.text.slice(s.start, s.start + s.text.length)).toBe(s.text);
});

test("a long sentence breaks at clause boundaries, never beyond the limit, and keeps its offsets", () => {
  const clause = "the model reads this clause aloud";
  const text = `${Array.from({ length: 12 }, () => clause).join(", ")}; and then it ends.`;
  const u = unit(1, text);
  const out = splitSentences([u]);
  expect(out.length).toBeGreaterThan(1);
  for (const s of out) {
    expect(s.text.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(u.text.slice(s.start, s.start + s.text.length)).toBe(s.text);
    expect(s.text).toBe(s.text.trim());
  }
  // Nothing is lost: the pieces cover every word.
  expect(out.map((s) => s.text).join(" ").split(/\s+/).length).toBe(text.split(/\s+/).length);
});

test("a long comma-free clause breaks at spaces, and an unbroken token is cut at the limit", () => {
  const words = Array.from({ length: 80 }, (_, k) => `word${k}`).join(" ");
  for (const [s, e] of pieces(words)) expect(e - s).toBeLessThanOrEqual(MAX_CHARS);
  const hash = "a".repeat(400);
  const cut = pieces(hash);
  expect(cut.map(([s, e]) => e - s)).toEqual([160, 160, 80]);
});

test("breaks avoid splitting a date, a sum or a number from its unit", () => {
  const filler = "x".repeat(10);
  const text = `${Array.from({ length: 11 }, () => filler).join(" ")} launched on Oct 21, 2026 for $1.2 million in total with more words after it`;
  const out = pieces(text).map(([s, e]) => text.slice(s, e));
  expect(out.some((p) => p.endsWith("Oct 21,") || p.startsWith("2026"))).toBe(false);
  expect(out.some((p) => p.endsWith("$1.2") || p.startsWith("million"))).toBe(false);
});

test("a frame's units are bounded and malformed ones dropped", () => {
  expect(takeUnits("nope")).toEqual({ units: [], truncated: false });
  const { units, truncated } = takeUnits([{ i: 0, text: "ok" }, { i: "x", text: "bad" }, null, { i: 2, text: 5 }]);
  expect(units).toEqual([{ i: 0, text: "ok", h: undefined }]);
  expect(truncated).toBe(false);
  const many = Array.from({ length: MAX_UNITS + 5 }, (_, i) => ({ i, text: "a" }));
  const taken = takeUnits(many);
  expect(taken.units.length).toBe(MAX_UNITS);
  expect(taken.truncated).toBe(true);
});

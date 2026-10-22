import { expect, test } from "bun:test";
import { STYLE_WIDTH, styleFor } from "./style.ts";

test("picks row min(length, rows - 1), as the Python does", () => {
  const rows = 400;
  const voice = new Float32Array(rows * STYLE_WIDTH);
  for (let r = 0; r < rows; r++) voice.fill(r, r * STYLE_WIDTH, (r + 1) * STYLE_WIDTH);
  expect(STYLE_WIDTH).toBe(256);
  expect(styleFor(voice, 0)[0]).toBe(0);
  expect(styleFor(voice, 37)).toEqual(new Float32Array(STYLE_WIDTH).fill(37));
  expect(styleFor(voice, 399)[255]).toBe(399);
  expect(styleFor(voice, 5000)[0]).toBe(399);
  expect(styleFor(voice, 37).length).toBe(STYLE_WIDTH);
});

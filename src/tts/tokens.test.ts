import { describe, expect, test } from "bun:test";
import { tokenize } from "./tokens.ts";

// Expected ids computed with KittenTTS's own basic_english_tokenize and
// TextCleaner (kittentts_legacy/onnx_model.py) under Python 3.
const PYTHON: [string, number[]][] = [
  ["həlˈoʊ, wˈɜːld.", [0, 50, 83, 54, 156, 57, 135, 16, 3, 16, 65, 156, 87, 158, 54, 46, 16, 4, 10, 0]],
  [
    "bˈʌʔn\u0329 ðə kwˈɪk bɹˈaʊn fˈɑːks!",
    [0, 44, 156, 138, 148, 56, 16, 175, 16, 81, 83, 16, 53, 65, 156, 102, 53, 16, 44, 123, 156, 43, 135, 56, 16, 48, 156, 69, 158, 53, 61, 16, 5, 10, 0],
  ],
  [
    "ˌɛmsˌiːpˈiː — “quoted” (x) 42_a; é?",
    [0, 157, 86, 55, 61, 157, 51, 158, 58, 156, 51, 158, 16, 9, 16, 16, 59, 63, 57, 62, 47, 46, 16, 16, 16, 66, 16, 16, 43, 16, 1, 16, 16, 6, 10, 0],
  ],
  ["", [0, 10, 0]],
  [
    "aɪm ɹˈiːdɪŋ: ðə sˈɪɾiz nˈuːz…",
    [0, 43, 102, 55, 16, 123, 156, 51, 158, 46, 102, 112, 16, 2, 16, 81, 83, 16, 61, 156, 102, 125, 51, 68, 16, 56, 156, 63, 158, 68, 16, 10, 10, 0],
  ],
];

describe("tokenize", () => {
  for (const [phonemes, ids] of PYTHON) {
    test(JSON.stringify(phonemes), () => expect(tokenize(phonemes)).toEqual(ids));
  }

  test("ᵻ and the syllabic mark are in the symbol table", () => {
    expect(tokenize("ᵻ")).toEqual([0, 177, 10, 0]);
    expect(tokenize("n\u0329")).toEqual([0, 56, 16, 175, 10, 0]);
  });
});

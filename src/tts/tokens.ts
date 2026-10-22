// Phoneme string -> Kitten TTS input ids, exactly as KittenTTS's Python does it
// (kittentts_legacy/onnx_model.py, Apache-2.0): basic_english_tokenize splits
// on `\w+|[^\w\s]` and rejoins with single spaces, TextCleaner maps each
// character through its symbol table (unknown characters are dropped), and the
// ids are wrapped as [0, ...ids, 10, 0].

const PAD = "$";
const PUNCTUATION = ";:,.!?¡¿—…\"«»\"\" ";
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LETTERS_IPA =
  "ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘'\u0329'ᵻ";

/** Character -> id. Duplicates in the table resolve to the last index, as a Python dict built in order does. */
const SYMBOLS = new Map<string, number>();
[PAD, ...PUNCTUATION, ...LETTERS, ...LETTERS_IPA].forEach((s, i) => SYMBOLS.set(s, i));

const SPACE = SYMBOLS.get(" ")!;

/** The id the Python appends after the text, before the final pad. */
export const END_TOKEN = 10;

// Python's `\w` on str is "alphanumeric or underscore": letters (L*) and
// numbers (N*), but not combining marks, so the syllabic mark under n (U+0329) is its own token.
const WORD_OR_PUNCT = /[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu;

export function tokenize(phonemes: string): number[] {
  return tokenizeWithOffsets(phonemes).ids;
}

/**
 * tokenize(), plus where each character of `phonemes` went: the characters
 * [a, b) became ids [start[a], end[b]). The separating space the tokenizer puts
 * before a token belongs to neither neighbour unless both are in the range.
 */
export function tokenizeWithOffsets(phonemes: string): { ids: number[]; start: Int32Array; end: Int32Array } {
  const ids = [0];
  const start = new Int32Array(phonemes.length + 1);
  const end = new Int32Array(phonemes.length + 1);
  let p = 0;
  let first = true;
  for (const m of phonemes.matchAll(WORD_OR_PUNCT)) {
    for (; p < m.index; p++) start[p] = end[p] = ids.length;
    end[p] = ids.length;
    if (!first) ids.push(SPACE);
    first = false;
    start[p] = ids.length;
    for (const ch of m[0]) {
      const id = SYMBOLS.get(ch);
      if (id !== undefined) ids.push(id);
      for (let k = 1; k <= ch.length; k++) start[p + k] = end[p + k] = ids.length;
      p += ch.length;
    }
  }
  for (; p <= phonemes.length; p++) start[p] = end[p] = ids.length;
  ids.push(END_TOKEN, 0);
  return { ids, start, end };
}

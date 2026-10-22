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

/** The id the Python appends after the text, before the final pad. */
export const END_TOKEN = 10;

// Python's `\w` on str is "alphanumeric or underscore": letters (L*) and
// numbers (N*), but not combining marks, so the syllabic mark under n (U+0329) is its own token.
const WORD_OR_PUNCT = /[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu;

export function tokenize(phonemes: string): number[] {
  const joined = (phonemes.match(WORD_OR_PUNCT) ?? []).join(" ");
  const ids = [0];
  for (const ch of joined) {
    const id = SYMBOLS.get(ch);
    if (id !== undefined) ids.push(id);
  }
  ids.push(END_TOKEN, 0);
  return ids;
}

// English text -> IPA phonemes in the style of espeak-ng en-us (stress marks
// before the stressed vowel, punctuation kept), which is what Kitten TTS was
// trained on. espeak-ng is GPL, so this reimplements the parts that matter from
// permissively licensed data instead:
//
// - CMUdict (BSD-2-Clause, Carnegie Mellon University) for known words, converted
//   from ARPAbet to IPA at build time (scripts/build-tts.ts) with arpabetToIpa below.
// - g2p_en's grapheme-to-phoneme GRU (Apache-2.0, Kyubyong Park and Jongseok Kim,
//   https://github.com/Kyubyong/g2p) for words CMUdict lacks, run here in plain TS.
//
// Lexicon format (one word per line, sorted, first CMUdict pronunciation only):
//   word<TAB>ipa\n
//
// G2P weights format (little-endian):
//   bytes 0-3   "G2PE"
//   bytes 4-7   u32 header length H
//   bytes 8..   H bytes of UTF-8 JSON: { "dtype": "float16" | "float32",
//               "tensors": [{ "name", "shape": number[], "offset": bytes into data }] }
//   then zero padding to a multiple of 4, then the data section: each tensor
//   row-major, starting at its offset (4-byte aligned).
// Tensors are g2p_en's checkpoint20.npz: enc_emb [29,256], enc_w_ih [768,256],
// enc_w_hh [768,256], enc_b_ih [768], enc_b_hh [768], dec_emb [74,256],
// dec_w_ih [768,256], dec_w_hh [768,256], dec_b_ih [768], dec_b_hh [768],
// fc_w [74,256], fc_b [74]. Gate rows are ordered reset, update, new (PyTorch's GRU).

// ---------------------------------------------------------------------------
// ARPAbet -> espeak-style IPA

const VOWELS: Record<string, string> = {
  AA: "ɑː", AE: "æ", AH: "ʌ", AO: "ɔː", AW: "aʊ", AY: "aɪ", EH: "ɛ", ER: "ɜː",
  EY: "eɪ", IH: "ɪ", IY: "iː", OW: "oʊ", OY: "ɔɪ", UH: "ʊ", UW: "uː",
};
const CONSONANTS: Record<string, string> = {
  B: "b", CH: "tʃ", D: "d", DH: "ð", F: "f", G: "ɡ", HH: "h", JH: "dʒ", K: "k", L: "l",
  M: "m", N: "n", NG: "ŋ", P: "p", R: "ɹ", S: "s", SH: "ʃ", T: "t", TH: "θ", V: "v",
  W: "w", Y: "j", Z: "z", ZH: "ʒ",
};

const base = (p: string) => p.replace(/[0-2]$/, "");
const stressOf = (p: string) => (/[0-2]$/.test(p) ? Number(p.slice(-1)) : -1);
const isVowel = (p: string | undefined) => p !== undefined && base(p) in VOWELS;

/** espeak-isms applied by arpabetToIpa, each kept because it raised similarity to espeak-ng on a word list and sentences. */
const RULES = {
  dropTrailingSecondary: true,
  finalSyllableI: true,
  prefixE: true,
  initialA: true,
  initialUn: true,
  shortO: true,
  doubleR: true,
  everyR: true,
  dropLeadingSecondary: true,
};

/** Spelling of the vowel letters in the last syllable ("edit" -> "i", "service" -> "i", "product" -> "u"). */
function lastVowelLetters(word: string): string {
  const w = word.replace(/'.*$/, "").replace(/(?<=[^aeiouy])(es|s|ed)$/, "").replace(/(?<=[^aeiouy])e$/, "");
  return /([aeiouy]+)[^aeiouy]*$/.exec(w)?.[1] ?? "";
}

/**
 * ARPAbet phones (with CMUdict stress digits) for one word -> IPA with
 * espeak's conventions. `word` is the spelling, which some of espeak's vowel
 * choices depend on.
 */
export function arpabetToIpa(phones: string[], word = ""): string {
  const n = phones.length;
  const spelled = word.toLowerCase();
  const vowelAt = phones.map(isVowel);
  const firstVowel = vowelAt.indexOf(true);
  const lastVowel = vowelAt.lastIndexOf(true);
  const primary = phones.findIndex((p) => stressOf(p) === 1);
  let out = "";
  for (let i = 0; i < n; i++) {
    const p = phones[i];
    const b = base(p);
    const prev = phones[i - 1];
    const next = phones[i + 1];
    if (b in VOWELS) {
      let s = stressOf(p);
      // espeak leaves the second half of most compounds unstressed (inbox, workspace, feedback).
      // Only right after the primary, though: "everyone" keeps its ˌ after an unstressed syllable.
      let v = VOWELS[b];
      if (RULES.dropTrailingSecondary && s === 2 && primary >= 0 && vowelAt.lastIndexOf(true, i - 1) === primary) {
        s = 0;
        if (b === "IY") v = "i";
      } else if (RULES.dropLeadingSecondary && s === 2 && i === firstVowel && vowelAt.indexOf(true, i + 1) === primary) {
        // inside, instead, review: a secondary right before the primary goes, and re- reduces.
        s = 0;
        if ((b === "IY" || b === "IH") && /^(re|de|be|pre)/.test(spelled)) v = "ᵻ";
      } else if (s === 0 || s === -1) {
        if (b === "AH") v = "ə";
        else if (b === "ER") v = "ɚ";
        else if (b === "IY") v = "i";
        else if (b === "UW" && i === n - 1 && base(prev ?? "") !== "Y") v = "ʊ";
        // -ed, -es after the stem: espeak's reduced ᵻ.
        if ((b === "AH" || b === "IH") && i === n - 2 && (next === "D" || next === "Z") && firstVowel < i) v = "ᵻ";
        // edit, limit, service, latest: a schwa spelled i or e is ɪ.
        else if (RULES.finalSyllableI && b === "AH" && i === lastVowel && firstVowel < i && next !== undefined && !["L", "M", "N"].includes(next) && !spelled.endsWith("less") && /^(i|e)$/.test(lastVowelLetters(spelled))) v = "ɪ";
        else if (RULES.finalSyllableI && b === "AH" && i === lastVowel && next === "JH" && spelled.endsWith("age")) v = "ɪ";
        if (i === firstVowel && i < primary) {
          // request, delete, before, event: an unstressed first syllable spelled e.
          if (RULES.prefixE && (b === "IH" || b === "IY" || (b === "AH" && /^(re|de|be|pre|se)/.test(spelled))) && /^[^aeiouy]*e(?![aeiouyx])/.test(spelled)) v = "ᵻ";
          // example, expect: ex- is ɛ.
          else if (RULES.prefixE && b === "IH" && /^ex/.test(spelled)) v = "ɛ";
          // about, account, again: ɐ.
          else if (RULES.initialA && b === "AH" && i === 0 && spelled.startsWith("a")) v = "ɐ";
          // until, unusual, subscription: ʌ.
          else if (RULES.initialUn && b === "AH" && /^(un|sub|up)/.test(spelled)) v = "ʌ";
        }
      }
      // long, off, cost, log: a short ɔ.
      if (RULES.shortO && b === "AO" && s !== 0 && ["NG", "F", "S", "TH", "G"].includes(next ?? "") && /o/.test(spelled) && !/(ou|oa|au|aw)/.test(spelled)) v = "ɔ";
      if (b === "UW" && next === "R") v = "ʊ";
      if (b === "ER" && isVowel(next)) v = RULES.everyR && s <= 0 && stressOf(next) <= 0 && vowelAt.lastIndexOf(true, i - 1) === primary ? "ɹ" : `${v}ɹ`;
      out += (s === 1 ? "ˈ" : s === 2 ? "ˌ" : "") + v;
      // durable, security: espeak doubles the r after ʊ before a vowel.
      if (RULES.doubleR && (b === "UH" || b === "UW") && next === "R" && isVowel(phones[i + 2])) out += "ɹ";
      continue;
    }
    const c = CONSONANTS[b] ?? "";
    if (b === "T" && (isVowel(prev) || prev === "R") && next !== undefined) {
      const after = phones[i + 2];
      // button, certain: a glottal stop and syllabic n.
      if (base(next) === "AH" && stressOf(next) === 0 && after === "N" && i + 2 === n - 1 && isVowel(prev)) {
        out += "ʔn\u0329";
        i += 2;
        continue;
      }
      // butter, city, party: t between a vowel (or r) and an unstressed vowel flaps.
      if (isVowel(next) && stressOf(next) === 0) {
        out += "ɾ";
        continue;
      }
    }
    out += c;
  }
  return out;
}

// ---------------------------------------------------------------------------
// g2p_en GRU, greedy decoding

const GRAPHEMES = ["<pad>", "<unk>", "</s>", ..."abcdefghijklmnopqrstuvwxyz"];
const G2P_PHONEMES = [
  "<pad>", "<unk>", "<s>", "</s>",
  "AA0", "AA1", "AA2", "AE0", "AE1", "AE2", "AH0", "AH1", "AH2", "AO0", "AO1", "AO2", "AW0", "AW1", "AW2",
  "AY0", "AY1", "AY2", "B", "CH", "D", "DH", "EH0", "EH1", "EH2", "ER0", "ER1", "ER2", "EY0", "EY1", "EY2",
  "F", "G", "HH", "IH0", "IH1", "IH2", "IY0", "IY1", "IY2", "JH", "K", "L", "M", "N", "NG", "OW0", "OW1",
  "OW2", "OY0", "OY1", "OY2", "P", "R", "S", "SH", "T", "TH", "UH0", "UH1", "UH2", "UW", "UW0", "UW1", "UW2",
  "V", "W", "Y", "Z", "ZH",
];

type Tensor = { data: Float32Array; shape: number[] };

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

let halfTable: Float32Array | undefined;
/** Every float16 bit pattern as float32, so decoding the weights is a table lookup. */
function halves(): Float32Array {
  if (!halfTable) {
    halfTable = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) halfTable[h] = halfToFloat(h);
  }
  return halfTable;
}

export function readG2pWeights(buf: ArrayBuffer): Map<string, Tensor> {
  const view = new DataView(buf);
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (magic !== "G2PE") throw new Error("not a G2PE weights file");
  const headerLen = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headerLen))) as {
    dtype: "float16" | "float32";
    tensors: { name: string; shape: number[]; offset: number }[];
  };
  const dataStart = (8 + headerLen + 3) & ~3;
  const out = new Map<string, Tensor>();
  for (const t of header.tensors) {
    const size = t.shape.reduce((a, b) => a * b, 1);
    const at = dataStart + t.offset;
    let data: Float32Array;
    if (header.dtype === "float32") data = new Float32Array(buf.slice(at, at + size * 4));
    else {
      data = new Float32Array(size);
      const table = halves();
      for (let i = 0; i < size; i++) data[i] = table[view.getUint16(at + i * 2, true)];
    }
    out.set(t.name, { data, shape: t.shape });
  }
  return out;
}

/** One GRU layer's weights, with each input embedding already projected through W_ih. */
class Gru {
  readonly hidden: number;
  readonly inputGates: Float32Array[]; // per token: W_ih · emb + b_ih
  constructor(emb: Tensor, wih: Tensor, readonly whh: Tensor, readonly bhh: Tensor, bih: Tensor) {
    this.hidden = whh.shape[1];
    const [vocab, dim] = emb.shape;
    const gates = wih.shape[0];
    this.inputGates = [];
    for (let v = 0; v < vocab; v++) {
      const g = new Float32Array(gates);
      for (let r = 0; r < gates; r++) {
        let sum = bih.data[r];
        for (let k = 0; k < dim; k++) sum += wih.data[r * dim + k] * emb.data[v * dim + k];
        g[r] = sum;
      }
      this.inputGates.push(g);
    }
  }

  step(token: number, h: Float32Array): Float32Array {
    const H = this.hidden;
    const ih = this.inputGates[token];
    const hh = new Float32Array(3 * H);
    const w = this.whh.data;
    for (let r = 0; r < 3 * H; r++) {
      let sum = this.bhh.data[r];
      const row = r * H;
      for (let k = 0; k < H; k++) sum += w[row + k] * h[k];
      hh[r] = sum;
    }
    const next = new Float32Array(H);
    for (let j = 0; j < H; j++) {
      const r = 1 / (1 + Math.exp(-(ih[j] + hh[j])));
      const z = 1 / (1 + Math.exp(-(ih[H + j] + hh[H + j])));
      const nGate = Math.tanh(ih[2 * H + j] + r * hh[2 * H + j]);
      next[j] = (1 - z) * nGate + z * h[j];
    }
    return next;
  }
}

export class G2p {
  private enc: Gru;
  private dec: Gru;
  private fcW: Tensor;
  private fcB: Tensor;
  private gIndex = new Map(GRAPHEMES.map((g, i) => [g, i]));

  constructor(weights: ArrayBuffer) {
    const t = readG2pWeights(weights);
    const get = (name: string) => {
      const x = t.get(name);
      if (!x) throw new Error(`g2p weights lack ${name}`);
      return x;
    };
    this.enc = new Gru(get("enc_emb"), get("enc_w_ih"), get("enc_w_hh"), get("enc_b_hh"), get("enc_b_ih"));
    this.dec = new Gru(get("dec_emb"), get("dec_w_ih"), get("dec_w_hh"), get("dec_b_hh"), get("dec_b_ih"));
    this.fcW = get("fc_w");
    this.fcB = get("fc_b");
  }

  /** Lowercase a-z word -> ARPAbet phones, as g2p_en's G2p.predict. */
  predict(word: string): string[] {
    let h: Float32Array = new Float32Array(this.enc.hidden);
    for (const ch of [...word, "</s>"]) h = this.enc.step(this.gIndex.get(ch) ?? 1, h);
    const out: string[] = [];
    let token = 2; // <s>
    const H = this.dec.hidden;
    const vocab = this.fcB.data.length;
    for (let i = 0; i < 20; i++) {
      h = this.dec.step(token, h);
      let best = 0;
      let bestScore = -Infinity;
      for (let v = 0; v < vocab; v++) {
        let s = this.fcB.data[v];
        for (let k = 0; k < H; k++) s += this.fcW.data[v * H + k] * h[k];
        if (s > bestScore) {
          bestScore = s;
          best = v;
        }
      }
      if (best === 3) break; // </s>
      out.push(G2P_PHONEMES[best] ?? "<unk>");
      token = best;
    }
    return out.filter((p) => !p.startsWith("<"));
  }
}

// ---------------------------------------------------------------------------
// Words in context

// Function words as espeak says them inside a sentence: mostly unstressed.
const FUNCTION_WORDS: Record<string, string> = {
  a: "ɐ", an: "ɐn", the: "ðə", and: "ænd", of: "ʌv", to: "tə", in: "ɪn", is: "ɪz", it: "ɪt", "it's": "ɪts",
  for: "fɔːɹ", you: "juː", i: "aɪ", my: "maɪ", that: "ðæt", on: "ɔn", at: "æt", as: "æz", by: "baɪ",
  be: "biː", was: "wʌz", were: "wɜː", are: "ɑːɹ", he: "hiː", she: "ʃiː", we: "wiː", they: "ðeɪ", his: "hɪz",
  her: "hɜː", its: "ɪts", their: "ðɛɹ", them: "ðɛm", us: "ʌs", me: "miː", him: "hɪm", your: "jʊɹ",
  from: "fɹʌm", or: "ɔːɹ", but: "bˌʌt", with: "wɪð", this: "ðɪs", has: "hɐz", have: "hæv", had: "hæd",
  can: "kæn", will: "wɪl", would: "wʊd", should: "ʃˌʊd", could: "kʊd", do: "duː", does: "dʌz", if: "ɪf",
  than: "ðɐn", there: "ðɛɹ", so: "sˌoʊ", been: "bˌɪn", "i'm": "aɪm", "you're": "jʊɹ", "we're": "wɪɹ",
  "they're": "ðɛɹ", "i'll": "aɪl", "you'll": "juːl", "we'll": "wiːl", "i've": "aɪv", "you've": "juːv",
  "we've": "wiːv", "they've": "ðeɪv", "i'd": "aɪd", "he's": "hiːz", "she's": "ʃiːz", "that's": "ðæts",
  while: "wˌaɪl", our: "ˌaʊɚ", before: "bᵻfˌɔːɹ", over: "ˌoʊvɚ", some: "sˌʌm", into: "ˌɪntʊ", above: "əbˌʌv",
  about: "ɐbˌaʊt", any: "ˌɛni", how: "hˌaʊ", what: "wˌʌt", "couldn't": "kˌʊdənt", when: "wˌɛn", which: "wˌɪtʃ",
  who: "hˌuː", where: "wˌɛɹ", why: "wˌaɪ", not: "nˌɑːt", just: "dʒˌʌst", then: "ðˈɛn", these: "ðiːz", those: "ðoʊz",
};

// Homographs where CMUdict's first entry is not the everyday reading.
const HOMOGRAPHS: Record<string, string> = {
  read: "ɹˈiːd", live: "lˈɪv", lead: "lˈiːd", wind: "wˈɪnd", close: "klˈoʊz", use: "jˈuːz", tear: "tˈɛɹ",
  record: "ɹˈɛkɚd", present: "pɹˈɛzənt", object: "ˈɑːbdʒɛkt", minute: "mˈɪnɪt", content: "kˈɑːntɛnt",
};

const LETTERS: Record<string, string> = {
  a: "eɪ", b: "biː", c: "siː", d: "diː", e: "iː", f: "ɛf", g: "dʒiː", h: "eɪtʃ", i: "aɪ", j: "dʒeɪ",
  k: "keɪ", l: "ɛl", m: "ɛm", n: "ɛn", o: "oʊ", p: "piː", q: "kjuː", r: "ɑːɹ", s: "ɛs", t: "tiː",
  u: "juː", v: "viː", w: "dˈʌbəljuː", x: "ɛks", y: "waɪ", z: "ziː",
};

const IPA_VOWEL = /[ɑæʌɔaɛɜeɪiʊuoəɚᵻɐ]/;

/** Puts a stress mark before the first vowel of a letter name ("piː" -> "pˈiː"). */
function stressFirstVowel(ipa: string, mark: string): string {
  if (/[ˈˌ]/.test(ipa)) return mark === "ˈ" ? ipa : ipa.replace("ˈ", "ˌ");
  const i = ipa.search(IPA_VOWEL);
  return i < 0 ? ipa : ipa.slice(0, i) + mark + ipa.slice(i);
}

/** "MCP" -> "ˌɛmsˌiːpˈiː", as espeak spells an acronym: secondary stress on each letter, primary on the last. */
function spell(letters: string): string {
  const names = [...letters.toLowerCase()].filter((c) => LETTERS[c]).map((c) => LETTERS[c]);
  return names.map((ipa, i) => stressFirstVowel(ipa, i === names.length - 1 ? "ˈ" : "ˌ")).join("");
}

const VOICELESS_FINAL = /[ptkfθ]$/;
const SIBILANT_FINAL = /(s|z|ʃ|ʒ|tʃ|dʒ)$/;

/** Adds an -s suffix (plural, possessive, third person) after a pronunciation. */
function withS(ipa: string): string {
  if (SIBILANT_FINAL.test(ipa)) return `${ipa}ᵻz`;
  if (VOICELESS_FINAL.test(ipa)) return `${ipa}s`;
  return `${ipa}z`;
}

/** Stressed monosyllables: espeak marks a lone content word's vowel. */
function ensureStress(ipa: string): string {
  if (/[ˈˌ]/.test(ipa)) return ipa;
  return stressFirstVowel(ipa, "ˈ");
}

/**
 * The lexicon, looked up in place: lines are sorted by word (JS string order),
 * so a binary search over the text finds a word without building a Map of
 * 135k entries (which costs a phone hundreds of milliseconds and many MB).
 */
export class Lexicon {
  constructor(private readonly text: string) {}

  get(word: string): string | undefined {
    const text = this.text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = text.lastIndexOf("\n", ((lo + hi) >>> 1) - 1) + 1;
      let eol = text.indexOf("\n", mid);
      if (eol < 0) eol = text.length;
      let tab = text.indexOf("\t", mid);
      if (tab < 0 || tab > eol) tab = eol;
      const key = text.slice(mid, tab);
      if (key === word) return tab < eol ? text.slice(tab + 1, eol) : undefined;
      if (key < word) lo = eol + 1;
      else hi = mid;
    }
    return undefined;
  }

  has(word: string): boolean {
    return this.get(word) !== undefined;
  }
}

const MAX_G2P_LETTERS = 24;

/** Everyday words, said as words when written in capitals for emphasis ("Do NOT", "ALL users", "Mind the GAP"). */
const COMMON_WORDS = new Set(
  (
    "a an the and or nor but if so as at by for from in into of off on onto out over per to up upon via with not no yes " +
    "all any both each few many more most much none one two six ten own some such only same very just also too now then " +
    "here there when where why how what who whom whose which that this these those than once ever never ago soon " +
    "i me my mine we us our you your he him his she her they them it its is am are was were be been being do does did " +
    "done have has had can could may might must will would shall should let get got go goes went make made take took " +
    "use used see saw say said try put set run ran keep give gave come came know knew need want like look find read " +
    "send stop wait help note save sell buy pay add move turn call ask tell show hide join quit fail pass skip lose " +
    "new old big small good bad best less last next free full true real sure safe live dead open shut done easy hard " +
    "fast slow high low hot cold top end gap day week year time way life work home team user data file code test plan " +
    "away back down left right near far late soon well even ever ok wow hey oh gone lost won win tie due key max min " +
    "warn tip bug fix pro max min"
  ).split(" "),
);
/**
 * Acronyms always spelled, even where the lexicon has a word with those letters
 * or the text is all capitals. "IT" and "US" are not here: in prose they are
 * likelier emphasis ("IT matters", "tell US"); the normaliser spells "the US"
 * and "IT team" from context.
 */
const TECH_ACRONYMS = new Set(
  (
    "am pm id ai ui ux os pc tv hr pr qa ci cd ip vm api url uri css pdf cpu gpu ram rom ssd usb sdk cli ssh dns " +
    "tcp udp tls ssl sql kpi okr roi ceo cto cfo coo vp faq eta fyi diy nyc la uk eu gpt llm mcp tts stt aws gcp " +
    "html json http https xml yaml jwt csv svg png jpg gif npm ide vpn lan wan seo crm erp b2b saas iot ml nlp"
  ).split(" "),
);

/** Has a vowel and no run of four consonants: worth letting the GRU say ("CHANGELOG"), rather than spelling. */
const looksPronounceable = (w: string) => /[aeiouy]/.test(w) && !/[^aeiouy]{4}/.test(w);

const WORD_OR_PUNCT = /[\p{L}\p{M}\p{N}]+(?:['-][\p{L}\p{M}\p{N}]+)*'?|[.,?!;:—…"]/gu;
const STARTS_WITH_VOWEL_SOUND = /^[ˈˌ]?[ɑæʌɔaɛɜeɪiʊuoəɚᵻɐ]/;

export class Phonemizer {
  private lexicon: Lexicon;
  private g2p: G2p;
  private cache = new Map<string, string>();

  constructor(lexicon: string, g2p: ArrayBuffer) {
    this.lexicon = new Lexicon(lexicon);
    this.g2p = new G2p(g2p);
  }

  phonemize(text: string): string {
    return this.phonemizeWords(text).phonemes;
  }

  /**
   * phonemize(), also saying where each word went: `text` and `phonemes` are
   * half-open UTF-16 ranges into text.normalize("NFC") and the returned
   * phoneme string. Punctuation is in no word.
   */
  phonemizeWords(text: string): { phonemes: string; words: { text: [number, number]; phonemes: [number, number] }[] } {
    const nfc = text.normalize("NFC");
    const tokens = [...nfc.matchAll(WORD_OR_PUNCT)];
    // All capitals is shouting (a heading, a label) unless it is three words or fewer.
    const shouting = !/\p{Ll}/u.test(text) && tokens.filter((t) => /[\p{L}\p{N}]/u.test(t[0])).length > 3;
    const isWord = (t: string | undefined) => t !== undefined && /[\p{L}\p{N}]/u.test(t);
    let out = "";
    const raw: { text: [number, number]; from: number; to: number }[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i][0];
      if (!isWord(tok)) {
        if (tok === '"') continue;
        out = out.trimEnd() + (tok === "\u2014" ? " \u2014 " : `${tok} `);
        continue;
      }
      const next = tokens[i + 1]?.[0];
      const nextWord = isWord(next) ? next : undefined;
      let ipa = this.word(tok, shouting, nextWord);
      // Linking r and "to" before a vowel, within a phrase.
      if (nextWord && STARTS_WITH_VOWEL_SOUND.test(this.word(nextWord, shouting, undefined))) {
        if (ipa.endsWith("ɚ")) ipa += "ɹ";
        else if (ipa === "tə") ipa = "tʊ";
      }
      const lead = ipa.length - ipa.trimStart().length;
      raw.push({ text: [tokens[i].index, tokens[i].index + tok.length], from: out.length + lead, to: out.length + ipa.trimEnd().length });
      out += `${ipa} `;
    }
    // Collapse whitespace runs and trim, mapping raw positions to final ones.
    const phonemes = out.replace(/\s+/g, " ").trim();
    const kept = new Int32Array(out.length + 1);
    for (let i = 0, n = 0; i < out.length; i++) {
      kept[i] = n;
      if (!(/\s/.test(out[i]) && i > 0 && /\s/.test(out[i - 1]))) n++;
      kept[i + 1] = n;
    }
    const leadTrim = out.length && /\s/.test(out[0]) ? 1 : 0;
    const at = (p: number) => Math.min(phonemes.length, Math.max(0, kept[Math.min(p, out.length)] - leadTrim));
    const words = raw.map((w) => ({ text: w.text, phonemes: [at(w.from), Math.max(at(w.from), at(w.to))] as [number, number] }));
    return { phonemes, words };
  }

  /** One word in context: function words stay unstressed; "the" before a vowel is ðɪ. */
  private word(raw: string, shouting: boolean, nextWord: string | undefined): string {
    const lower = raw.toLowerCase();
    const acronym = raw.length > 1 && /^\p{Lu}+$/u.test(raw) && this.spellsCaps(raw, shouting);
    if (!acronym && FUNCTION_WORDS[lower] !== undefined) {
      if (lower === "the" && nextWord) {
        const next = this.word(nextWord, shouting, undefined);
        if (STARTS_WITH_VOWEL_SOUND.test(next)) return "ðɪ";
      }
      return FUNCTION_WORDS[lower];
    }
    return this.content(raw, shouting);
  }

  private capsAsWords: Record<string, true> = { a: true, i: true, ok: true };

  /** A content word, with a stressed vowel. */
  private content(raw: string, shouting: boolean): string {
    const key = `${shouting ? "!" : ""}${raw}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const ipa = this.lookup(raw, shouting);
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(key, ipa);
    return ipa;
  }

  private lookup(raw: string, shouting: boolean): string {
    // Digits that survived normalisation are read one by one.
    if (/^\d+$/.test(raw)) return [...raw].map((d) => this.lookup(["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][+d], false)).join(" ");
    const lower = raw.toLowerCase();
    if (lower === "ok") return "ˌoʊkˈeɪ";
    // Hyphenated words: each part, run together as espeak does.
    if (raw.includes("-")) return raw.split("-").filter(Boolean).map((p) => this.content(p, shouting)).join("");
    // Acronyms: "MCP", "APIs".
    const caps = /^(\p{Lu}{2,})(s?)$/u.exec(raw);
    if (caps && this.spellsCaps(caps[1], shouting)) return caps[2] ? `${spell(caps[1])}z` : spell(caps[1]);
    // Single letters other than "a" and "I" are letter names.
    if (/^\p{L}$/u.test(raw) && lower !== "a" && lower !== "i") return spell(raw);
    const known = HOMOGRAPHS[lower] ?? this.lexicon.get(lower);
    if (known !== undefined) return ensureStress(known);
    // Possessives and contractions on a known word.
    const clitic = /^(.+?)('s|s'|'ll|'re|'ve|'d|')$/.exec(lower);
    if (clitic) {
      const stem = this.content(clitic[1], shouting);
      switch (clitic[2]) {
        case "'s": return withS(stem);
        case "'ll": return `${stem}l`;
        case "'re": return `${stem}ɹ`;
        case "'ve": return `${stem}v`;
        case "'d": return `${stem}d`;
        default: return stem;
      }
    }
    // CamelCase: "GitHub", "OpenAI", "JavaScript".
    const parts = raw.match(/\p{Lu}+(?!\p{Ll})|\p{Lu}?\p{Ll}+|\p{N}+/gu);
    if (parts && parts.length > 1) return parts.map((p) => this.content(p, shouting)).join(" ");
    // Plurals of known words.
    if (lower.length > 3 && lower.endsWith("s") && !lower.endsWith("ss")) {
      const stem = this.lexicon.get(lower.slice(0, -1));
      if (stem !== undefined) return ensureStress(withS(stem));
    }
    const letters = lower.normalize("NFD").replace(/[^a-z]/g, "");
    if (!letters) return "";
    // The GRU was trained on dictionary words; very long strings are said in pieces, which also bounds its cost.
    if (letters.length > MAX_G2P_LETTERS) {
      const pieces = letters.match(new RegExp(`.{1,${MAX_G2P_LETTERS / 2}}`, "g"))!;
      return pieces.map((p) => this.content(p, shouting)).join("");
    }
    return ensureStress(arpabetToIpa(this.g2p.predict(letters), letters));
  }

  /** "NASA" is said as a word; "HTML" and "MCP" are spelled. */
  /**
   * Whether an all-caps word is spelled out rather than said. Emphasis ("Do
   * NOT", "the FIRST step") is common in prose, acronyms in tech, so:
   * - TECH_ACRONYMS are always spelled.
   * - Up to three letters: said only if an everyday word (COMMON_WORDS) the lexicon knows.
   * - Four or more: said if the lexicon knows it, or if it is six or more letters that look pronounceable.
   * - In shouting text (all capitals, over three words): five letters or fewer are said
   *   only if the lexicon knows them; longer misses are spelled unless they look pronounceable.
   */
  private spellsCaps(caps: string, shouting: boolean): boolean {
    const lower = caps.toLowerCase();
    if (this.capsAsWords[lower]) return false;
    if (TECH_ACRONYMS.has(lower)) return true;
    const known = this.lexicon.has(lower);
    if (shouting) return caps.length <= 5 ? !known : !known && !looksPronounceable(lower);
    if (caps.length <= 3) return !(known && COMMON_WORDS.has(lower));
    return !known && !(caps.length >= 6 && looksPronounceable(lower));
  }
}

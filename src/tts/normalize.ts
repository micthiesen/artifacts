// Text -> words a speech model can say: numbers, money, dates, times, units,
// versions, URLs and abbreviations become plain English words; punctuation that
// shapes prosody (. , ? ! ; : —) stays. Pure and dependency-free.
//
// Several rules are ported from KittenTTS's preprocess.py (Apache-2.0,
// https://github.com/KittenML/KittenTTS).

const ONES = [
  "", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALE = ["", "thousand", "million", "billion", "trillion", "quadrillion"];
const DIGITS = ["zero", ...ONES.slice(1, 10)];

function threeDigits(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h) parts.push(`${ONES[h]} hundred`);
  if (r >= 20) parts.push(r % 10 ? `${TENS[Math.floor(r / 10)]}-${ONES[r % 10]}` : TENS[Math.floor(r / 10)]);
  else if (r) parts.push(ONES[r]);
  return parts.join(" ");
}

/** 0 -> "zero", 1200 -> "twelve hundred", 1000 -> "one thousand", 42 -> "forty-two". */
export function numberToWords(n: number): string {
  if (!Number.isFinite(n)) return "";
  n = Math.trunc(n);
  if (n === 0) return "zero";
  if (n < 0) return `minus ${numberToWords(-n)}`;
  if (n >= 1100 && n < 2000 && n % 100 === 0) return `${ONES[n / 100]} hundred`;
  const parts: string[] = [];
  for (let i = 0; n > 0 && i < SCALE.length; i++) {
    const chunk = n % 1000;
    if (chunk) parts.unshift(SCALE[i] ? `${threeDigits(chunk)} ${SCALE[i]}` : threeDigits(chunk));
    n = Math.floor(n / 1000);
  }
  return parts.join(" ");
}

const spellDigits = (s: string) => [...s].filter((c) => c >= "0" && c <= "9").map((c) => DIGITS[+c]).join(" ");

/** A run of digits as a cardinal, or digit by digit when it has a leading zero or is too long to be a quantity. */
function integerWords(raw: string): string {
  const digits = raw.replace(/,/g, "");
  if ((digits.length > 1 && digits[0] === "0") || digits.length > 15) return spellDigits(digits);
  return numberToWords(Number(digits));
}

/** "3.14" -> "three point one four"; "1,200" -> "twelve hundred"; ".5" -> "zero point five". */
function decimalWords(raw: string): string {
  let s = raw.replace(/,/g, "");
  const negative = s.startsWith("-") || s.startsWith("−");
  if (negative) s = s.slice(1);
  const [int, frac] = s.split(".");
  let out = int ? integerWords(int) : "zero";
  if (frac) out += ` point ${spellDigits(frac)}`;
  return negative ? `minus ${out}` : out;
}

const ORDINAL_EXCEPTIONS: Record<string, string> = {
  one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth",
};

function ordinalWord(word: string): string {
  if (ORDINAL_EXCEPTIONS[word]) return ORDINAL_EXCEPTIONS[word];
  if (word.endsWith("y")) return `${word.slice(0, -1)}ieth`;
  if (word.endsWith("e")) return `${word.slice(0, -1)}th`;
  return `${word}th`;
}

/** 1 -> "first", 21 -> "twenty-first", 100 -> "one hundredth". */
export function ordinalToWords(n: number): string {
  const words = numberToWords(n);
  const m = /^(.*?)([a-z]+)$/.exec(words);
  return m ? m[1] + ordinalWord(m[2]) : words;
}

/** 1999 -> "nineteen ninety-nine", 2005 -> "two thousand five", 2026 -> "twenty twenty-six". */
export function yearToWords(y: number): string {
  if (y >= 2000 && y <= 2009) return numberToWords(y);
  if (y >= 1100 && y <= 2099) {
    const hi = Math.floor(y / 100);
    const lo = y % 100;
    if (lo === 0) return `${numberToWords(hi)} hundred`;
    return `${numberToWords(hi)} ${lo < 10 ? `oh ${ONES[lo]}` : numberToWords(lo)}`;
  }
  return numberToWords(y);
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_BY_PREFIX: Record<string, string> = Object.fromEntries(
  MONTHS.flatMap((m) => [[m.toLowerCase(), m], [m.slice(0, 3).toLowerCase(), m]]),
);
MONTH_BY_PREFIX.sept = "September";
const MONTH_RE = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";

const plural = (n: string, singular: string, pluralForm = `${singular}s`) => (n === "one" ? singular : pluralForm);

// Currency: prefix codes ("CA$", "US$") and symbols.
const CURRENCY_PREFIX: Record<string, [string, string]> = {
  "$": ["dollar", "dollars"],
  "US$": ["US dollar", "US dollars"],
  "CA$": ["Canadian dollar", "Canadian dollars"],
  "C$": ["Canadian dollar", "Canadian dollars"],
  "A$": ["Australian dollar", "Australian dollars"],
  "AU$": ["Australian dollar", "Australian dollars"],
  "NZ$": ["New Zealand dollar", "New Zealand dollars"],
  "HK$": ["Hong Kong dollar", "Hong Kong dollars"],
  "S$": ["Singapore dollar", "Singapore dollars"],
  "€": ["euro", "euros"],
  "£": ["pound", "pounds"],
  "¥": ["yen", "yen"],
  "₹": ["rupee", "rupees"],
  "₩": ["won", "won"],
  "₿": ["bitcoin", "bitcoin"],
};
const CURRENCY_CODE: Record<string, [string, string]> = {
  USD: ["US dollar", "US dollars"],
  CAD: ["Canadian dollar", "Canadian dollars"],
  AUD: ["Australian dollar", "Australian dollars"],
  EUR: ["euro", "euros"],
  GBP: ["pound", "pounds"],
  JPY: ["yen", "yen"],
  CHF: ["Swiss franc", "Swiss francs"],
};
const MINOR: Record<string, [string, string]> = {
  dollar: ["cent", "cents"], euro: ["cent", "cents"], pound: ["penny", "pence"],
};

const SCALE_SUFFIX: Record<string, string> = {
  k: "thousand", K: "thousand", m: "million", M: "million", mm: "million", MM: "million",
  b: "billion", B: "billion", bn: "billion", T: "trillion", t: "trillion",
  thousand: "thousand", million: "million", billion: "billion", trillion: "trillion",
};

function money(amount: string, scale: string | undefined, names: [string, string]): string {
  const raw = amount.replace(/,/g, "");
  if (scale) return `${decimalWords(raw)} ${SCALE_SUFFIX[scale]} ${names[1]}`;
  const [int, frac = ""] = raw.split(".");
  const major = int ? integerWords(int) : "zero";
  const base = names[0].split(" ").pop()!;
  const minorNames = MINOR[base];
  if (frac && minorNames && frac.length <= 2) {
    const cents = Number(frac.padEnd(2, "0"));
    const centWords = cents ? `${numberToWords(cents)} ${cents === 1 ? minorNames[0] : minorNames[1]}` : "";
    if (major === "zero" && centWords) return centWords;
    const majorWords = `${major} ${plural(major, names[0], names[1])}`;
    return centWords ? `${majorWords} and ${centWords}` : majorWords;
  }
  const words = frac ? decimalWords(raw) : major;
  return `${words} ${plural(words, names[0], names[1])}`;
}

// Units after a number: [singular, plural]. Keys are case-sensitive first, then lowercase.
const UNITS: Record<string, [string, string]> = {
  KB: ["kilobyte", "kilobytes"], kB: ["kilobyte", "kilobytes"], KiB: ["kibibyte", "kibibytes"],
  MB: ["megabyte", "megabytes"], MiB: ["mebibyte", "mebibytes"], GB: ["gigabyte", "gigabytes"], GiB: ["gibibyte", "gibibytes"],
  TB: ["terabyte", "terabytes"], TiB: ["tebibyte", "tebibytes"], PB: ["petabyte", "petabytes"],
  Kb: ["kilobit", "kilobits"], Mb: ["megabit", "megabits"], Gb: ["gigabit", "gigabits"],
  kbps: ["kilobit per second", "kilobits per second"], Kbps: ["kilobit per second", "kilobits per second"],
  Mbps: ["megabit per second", "megabits per second"], Gbps: ["gigabit per second", "gigabits per second"],
  ms: ["millisecond", "milliseconds"], µs: ["microsecond", "microseconds"], us: ["microsecond", "microseconds"],
  ns: ["nanosecond", "nanoseconds"],
  km: ["kilometer", "kilometers"], cm: ["centimeter", "centimeters"], mm: ["millimeter", "millimeters"],
  kg: ["kilogram", "kilograms"], mg: ["milligram", "milligrams"], g: ["gram", "grams"], lb: ["pound", "pounds"],
  lbs: ["pound", "pounds"], oz: ["ounce", "ounces"], ml: ["milliliter", "milliliters"], mL: ["milliliter", "milliliters"],
  Hz: ["hertz", "hertz"], kHz: ["kilohertz", "kilohertz"], MHz: ["megahertz", "megahertz"], GHz: ["gigahertz", "gigahertz"],
  mph: ["mile per hour", "miles per hour"], kph: ["kilometer per hour", "kilometers per hour"], "km/h": ["kilometer per hour", "kilometers per hour"],
  px: ["pixel", "pixels"], fps: ["frame per second", "frames per second"], rem: ["rem", "rem"], em: ["em", "ems"],
  "°C": ["degree Celsius", "degrees Celsius"], "°F": ["degree Fahrenheit", "degrees Fahrenheit"], "°": ["degree", "degrees"],
  ft: ["foot", "feet"], mi: ["mile", "miles"], in: ["inch", "inches"],
  // Durations, when glued to the number ("6m 10s", "2h", "3d", "500ms").
  s: ["second", "seconds"], sec: ["second", "seconds"], secs: ["second", "seconds"],
  m: ["minute", "minutes"], min: ["minute", "minutes"], mins: ["minute", "minutes"],
  h: ["hour", "hours"], hr: ["hour", "hours"], hrs: ["hour", "hours"], d: ["day", "days"], w: ["week", "weeks"],
  wk: ["week", "weeks"], wks: ["week", "weeks"], y: ["year", "years"], yr: ["year", "years"], yrs: ["year", "years"],
  x: ["times", "times"], "×": ["times", "times"],
};
// Units that may follow a space ("12 MB"); the short and ambiguous ones (m, s, in, g, ...) must be glued on.
const SPACED_UNITS = new Set([
  "KB", "kB", "KiB", "MB", "MiB", "GB", "GiB", "TB", "TiB", "PB", "Kb", "Mb", "Gb", "kbps", "Kbps", "Mbps", "Gbps",
  "ms", "µs", "ns", "km", "cm", "mm", "kg", "mg", "lbs", "oz", "ml", "mL", "Hz", "kHz", "MHz", "GHz", "mph", "kph",
  "km/h", "px", "fps", "°C", "°F", "°", "ft", "hrs", "mins", "secs",
]);

const TLDS = "com|org|net|io|dev|ai|app|boo|co|uk|us|ca|de|fr|nl|eu|edu|gov|me|sh|xyz|so|gg|tv|fm|info|biz|page|site|tech|cloud|run|new";

function domainWords(host: string): string {
  return host
    .toLowerCase()
    .replace(/^www\./, "")
    .split(".")
    .filter(Boolean)
    .map((part) => part.replace(/-/g, " "))
    .join(" dot ");
}

function emailWords(local: string, domain: string): string {
  return `${local.replace(/[._+-]+/g, " ").trim()} at ${domainWords(domain)}`;
}

const ABBREVIATIONS: [RegExp, string][] = [
  [/\be\.g\.(?=\s|,|$)/gi, "for example"],
  [/\bi\.e\.(?=\s|,|$)/gi, "that is"],
  [/\b[Ee]tc\.(?=\s*$|\s+[A-Z])/g, "et cetera."],
  [/\betc\./gi, "et cetera"],
  [/\bvs\.?(?=\s|$)/gi, "versus"],
  [/\bapprox\.(?=\s)/gi, "approximately"],
  [/\bet al\./gi, "et al"],
  [/\bDr\.(?=\s)/g, "Doctor"],
  [/\bMr\.(?=\s)/g, "Mister"],
  [/\bMrs\.(?=\s)/g, "Missus"],
  [/\bMs\.(?=\s)/g, "Miz"],
  [/\bProf\.(?=\s)/g, "Professor"],
  [/\bSt\.(?=\s+[A-Z])/g, "Saint"],
  [/\bJr\./g, "Junior"],
  [/\bSr\./g, "Senior"],
  [/\bInc\./g, "Incorporated"],
  [/\bLtd\./g, "Limited"],
  [/\bNo\.(?=\s*\d)/g, "number"],
  [/\bFig\.(?=\s*\d)/gi, "figure"],
  [/\bp\.(?=\s*\d)/g, "page"],
  [/\bpp\.(?=\s*\d)/g, "pages"],
  [/\bw\/o\b/gi, "without"],
  [/\bw\/(?=\s)/gi, "with"],
];

/** Where an abbreviation's own full stop also ends the sentence: at the end, or before a capital. */
const ENDS_SENTENCE = /^\s*$|^\s+[A-Z]/;

/** Units a price or rate can be per: "$12/mo", "10 MB/s", "$5/user". */
const PER: Record<string, string> = {
  s: "second", sec: "second", second: "second", ms: "millisecond", min: "minute", minute: "minute",
  h: "hour", hr: "hour", hour: "hour", d: "day", day: "day", wk: "week", week: "week",
  mo: "month", month: "month", yr: "year", y: "year", year: "year",
  user: "user", seat: "seat", member: "member", person: "person", req: "request", request: "request",
  call: "call", token: "token", page: "page", item: "item", unit: "unit", GB: "gigabyte", MB: "megabyte", TB: "terabyte",
};

/** File extensions read letter by letter after "dot": "speak.ts" -> "speak dot T S". */
const EXTENSIONS = "js|ts|tsx|jsx|mjs|cjs|md|mdx|json|css|scss|html|htm|sh|yml|yaml|toml|rs|go|sql|py|rb|txt|csv|svg|png|jpg|jpeg|gif|pdf|wasm|lock|env|xml|ini|zip";

function timeWords(h: number, min: number, sec: string | undefined, suffix: string | undefined): string {
  const ampm = suffix ? (suffix[0].toLowerCase() === "a" ? " AM" : " PM") : "";
  let hour = h;
  if (suffix && hour > 12) hour -= 12;
  let out: string;
  if (min === 0) {
    if (suffix) out = numberToWords(hour);
    else if (hour === 0) out = "midnight";
    else if (hour > 12) out = `${numberToWords(hour)} hundred`;
    else out = `${numberToWords(hour)} o'clock`;
  } else {
    out = `${hour === 0 && !suffix ? "zero" : numberToWords(hour)} ${min < 10 ? `oh ${ONES[min]}` : numberToWords(min)}`;
  }
  if (sec && Number(sec)) out += ` and ${numberToWords(Number(sec))} ${Number(sec) === 1 ? "second" : "seconds"}`;
  return out + ampm;
}

function dateWords(month: string, day: string | undefined, year: string | undefined): string {
  const name = MONTH_BY_PREFIX[month.toLowerCase().replace(/\.$/, "")] ?? month;
  let out = name;
  if (day) out += ` ${ordinalToWords(Number(day))}`;
  if (year) out += `${day ? "," : ""} ${yearToWords(Number(year))}`;
  return out;
}

/** "1.2.3" -> "one point two point three". */
const versionWords = (v: string) => v.split(".").map((p) => integerWords(p)).join(" point ");

/** A bare number: years in 1100-2099 read as years when they look like one (four digits, no comma). */
function numberWords(raw: string): string {
  if (raw.includes(".")) return decimalWords(raw);
  const negative = /^[-−]/.test(raw);
  const digits = raw.replace(/^[-−]/, "");
  if (!negative && /^\d{4}$/.test(digits)) {
    const n = Number(digits);
    if (n >= 1100 && n <= 2099 && n % 1000 !== 0) return yearToWords(n);
  }
  return (negative ? "minus " : "") + integerWords(digits);
}

/** Keeps a sentence break when a rewrite swallowed a full stop that also ended the sentence ("3 p.m. Then"). */
function keepStop(match: string, offset: number, whole: string, always = false): string {
  if (!match.endsWith(".")) return "";
  const after = whole.slice(offset + match.length);
  return (always ? ENDS_SENTENCE : /^\s*$/).test(after) ? "." : "";
}

/** "01:23:45" -> "one hour twenty-three minutes forty-five seconds". */
function durationWords(h: number, m: number, s: number): string {
  const parts: string[] = [];
  if (h) parts.push(`${numberToWords(h)} ${h === 1 ? "hour" : "hours"}`);
  if (m) parts.push(`${numberToWords(m)} ${m === 1 ? "minute" : "minutes"}`);
  if (s || !parts.length) parts.push(`${numberToWords(s)} ${s === 1 ? "second" : "seconds"}`);
  return parts.join(" ");
}

/** Screen sizes read in pairs: 1920 -> "nineteen twenty", 1080 -> "ten eighty". */
function dimensionWords(raw: string): string {
  const digits = raw.replace(/,/g, "");
  if (!/^\d{4}$/.test(digits) || digits.endsWith("00")) return numberWords(raw);
  const lo = Number(digits.slice(2));
  return `${numberToWords(Number(digits.slice(0, 2)))} ${lo < 10 ? `oh ${ONES[lo]}` : numberToWords(lo)}`;
}

const NUM = String.raw`\d+(?:,\d{3})*(?:\.\d+)?`;

/** Normalised text with, for each UTF-16 unit, the source range [start[i], end[i]) it came from. */
export type SpannedText = { text: string; start: Int32Array; end: Int32Array };

type Replacer = string | ((match: string, ...rest: any[]) => string);

/** A string that remembers where each of its characters came from, edited with String.replace's semantics. */
class Spanned {
  text: string;
  start: number[];
  end: number[];

  constructor(text: string) {
    this.text = text;
    this.start = Array.from({ length: text.length }, (_, i) => i);
    this.end = this.start.map((i) => i + 1);
  }

  replace(re: RegExp, rep: Replacer): this {
    const src = this.text;
    const matches = re.global ? [...src.matchAll(re)] : [re.exec(src)].filter((m): m is RegExpExecArray => m !== null);
    if (re.global === false) re.lastIndex = 0;
    if (!matches.length) return this;
    let text = "";
    const start: number[] = [];
    const end: number[] = [];
    let at = 0;
    for (const m of matches) {
      const from = m.index;
      const to = from + m[0].length;
      const out = typeof rep === "string" ? expand(rep, m) : rep(m[0], ...m.slice(1), from, src);
      text += src.slice(at, from);
      for (let i = at; i < from; i++) start.push(this.start[i]), end.push(this.end[i]);
      // Characters the edit kept at either end keep their own source; the rest map to what they replaced.
      let pre = 0;
      while (pre < out.length && pre < to - from && out[pre] === src[from + pre]) pre++;
      let suf = 0;
      while (suf < out.length - pre && suf < to - from - pre && out[out.length - 1 - suf] === src[to - 1 - suf]) suf++;
      // ...but only when what changed was spacing or symbols: a rewritten word ("Oct 21" -> "October twenty-first") stays whole.
      if (/[\p{L}\p{N}]/u.test(src.slice(from + pre, to - suf))) pre = suf = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = from + pre; i < to - suf; i++) (lo = Math.min(lo, this.start[i])), (hi = Math.max(hi, this.end[i]));
      if (lo === Infinity) {
        for (let i = from; i < to; i++) (lo = Math.min(lo, this.start[i])), (hi = Math.max(hi, this.end[i]));
        if (lo === Infinity) (lo = from < src.length ? this.start[from] : this.end[from - 1] ?? 0), (hi = lo);
      }
      for (let i = 0; i < out.length; i++) {
        if (i < pre) start.push(this.start[from + i]), end.push(this.end[from + i]);
        else if (i >= out.length - suf) {
          const j = to - (out.length - i);
          start.push(this.start[j]), end.push(this.end[j]);
        } else start.push(lo), end.push(hi);
      }
      text += out;
      at = to;
    }
    text += src.slice(at);
    for (let i = at; i < src.length; i++) start.push(this.start[i]), end.push(this.end[i]);
    this.text = text;
    this.start = start;
    this.end = end;
    return this;
  }

  trim(): this {
    const lead = this.text.length - this.text.trimStart().length;
    const kept = this.text.trim().length;
    this.text = this.text.trim();
    this.start = this.start.slice(lead, lead + kept);
    this.end = this.end.slice(lead, lead + kept);
    return this;
  }

  /** Unicode NFC, a base character and its marks at a time, so each composed character maps to its parts. */
  nfc(): this {
    const whole = this.text.normalize("NFC");
    if (whole === this.text) return this;
    const start: number[] = [];
    const end: number[] = [];
    let text = "";
    for (const m of this.text.matchAll(/\P{M}\p{M}*|\p{M}+/gsu)) {
      const piece = m[0].normalize("NFC");
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = m.index; i < m.index + m[0].length; i++) (lo = Math.min(lo, this.start[i])), (hi = Math.max(hi, this.end[i]));
      text += piece;
      for (let i = 0; i < piece.length; i++) start.push(lo), end.push(hi);
    }
    if (text !== whole) {
      // Composition across marks (Hangul jamo): fall back to the whole text's range.
      let lo = Infinity;
      let hi = 0;
      for (let i = 0; i < this.start.length; i++) (lo = Math.min(lo, this.start[i])), (hi = Math.max(hi, this.end[i]));
      if (lo === Infinity) lo = 0;
      this.text = whole;
      this.start = new Array<number>(whole.length).fill(lo);
      this.end = new Array<number>(whole.length).fill(hi);
      return this;
    }
    this.text = text;
    this.start = start;
    this.end = end;
    return this;
  }
}

/** String.replace's replacement patterns: $&, $1-$99, $$. */
function expand(rep: string, m: RegExpExecArray): string {
  return rep.replace(/\$(\$|&|\d{1,2})/g, (all, g: string) => {
    if (g === "$") return "$";
    if (g === "&") return m[0];
    const n = Number(g);
    return n > 0 && n < m.length ? (m[n] ?? "") : all;
  });
}

/** Text as said aloud. Equivalent to normalizeWithSpans(text).text. */
export function normalizeForSpeech(text: string): string {
  return normalizeWithSpans(text).text;
}

/**
 * normalizeForSpeech, also mapping each UTF-16 unit of the output back to the
 * half-open range of `text` (UTF-16 indices) it was made from. Expansions map
 * every character to the whole source they replace ("$420" for all of "four
 * hundred twenty dollars"); characters an edit kept map to themselves.
 */
export function normalizeWithSpans(text: string): SpannedText {
  const t = new Spanned(text).nfc();

  // Typography to plain forms.
  t
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[\u00a0\u2007\u202f\u2009\u200a]/g, " ")
    .replace(/[\u200b-\u200d\ufeff\u00ad]/g, "")
    .replace(/\.{3,}/g, "…");

  // Whitespace runs to one character first, so the \s* rules below stay linear on long gaps.
  t.replace(/[^\S\n]*\n\s*/g, "\n").replace(/[^\S\n]{2,}/g, " ");

  // A line that ends without punctuation (a heading, a list item) still ends a sentence.
  t.replace(/([^\s.,;:!?…—-])[ \t]*\n+\s*/g, "$1. ").replace(/\s*\n+\s*/g, " ");

  // URLs: the domain only. Emails: local part "at" domain.
  t.replace(/\b(?:https?|ftp):\/\/([^\s/?#:]+)(?::\d+)?[^\s]*?(?=[.,;:!?)\]]*(?:\s|$))/gi, (_, host: string) => domainWords(host));
  t.replace(/\b([\w.+-]+)@([\w-]+(?:\.[\w-]+)*\.[a-z]{2,})\b/gi, (_, local: string, domain: string) => emailWords(local, domain));
  t.replace(/\bREADME\b/g, "read me");

  // Ports and relative paths: "localhost:3000" -> "localhost port 3000", "./x.sh" -> "x.sh".
  t.replace(/\b(localhost|\d{1,3}(?:\.\d{1,3}){3}|[a-z][\w-]*(?:\.[\w-]+)+):(\d{2,5})\b/gi, "$1 port $2");
  t.replace(/(?<![^\s(["'])\.{1,2}\//g, "");
  // Libraries named for their extension, files by name: "Node.js" -> "Node JS", "speak.ts" -> "speak dot TS".
  t.replace(/\b([A-Z][A-Za-z0-9]*)\.js\b(?!\.?\w)/g, "$1 JS");
  t.replace(new RegExp(String.raw`\b([\w-]+)\.(${EXTENSIONS})\b(?!\.?\w)`, "gi"), (_, name: string, ext: string) =>
    `${name} dot ${ext.toLowerCase() === "go" ? "go" : ext.toUpperCase()}`,
  );

  t.replace(/\bwww\.([\w-]+(?:\.[\w-]+)+)[^\s]*?(?=[.,;:!?)\]]*(?:\s|$))/gi, (_, host: string) => domainWords(host));
  t.replace(new RegExp(String.raw`\b((?:[a-z0-9-]+\.)+(?:${TLDS}))(\/[^\s]*?)?(?=[.,;:!?)\]]*(?:\s|$))`, "gi"), (m, host: string) =>
    /^\d+(\.\d+)*$/.test(host) ? m : domainWords(host),
  );

  for (const [re, words] of ABBREVIATIONS) t.replace(re, words);

  // Dotted abbreviations: U.S., Ph.D., M.I.T., a.m. -> letters, with no stops inside.
  t.replace(/(?<![\w.])(?:[A-Za-z][a-z]?\.){2,}/g, (m: string, off: number, whole: string) => {
    const letters = m.replace(/\./g, "").toUpperCase();
    return letters + keepStop(m, off, whole, letters === "AM" || letters === "PM");
  });
  // Signs before numbers: +5, −3, <2%, >= 10, C++, C#.
  t.replace(/\u2212(?=\s?[\d.$€£])/g, "-");
  t.replace(/\b([A-Za-z])\+\+(?![\w+])/g, "$1 plus plus").replace(/\b([CF])#(?!\w)/g, "$1 sharp");
  const NEXT_NUM = String.raw`(?=[-$€£¥]?\.?\d)`;
  t.replace(new RegExp(String.raw`(?:<=|≤)\s?${NEXT_NUM}`, "g"), "at most ")
    .replace(new RegExp(String.raw`(?:>=|≥)\s?${NEXT_NUM}`, "g"), "at least ")
    .replace(new RegExp(String.raw`(?<![-=<])<\s?${NEXT_NUM}`, "g"), "under ")
    .replace(new RegExp(String.raw`(?<![-=])>\s?${NEXT_NUM}`, "g"), "over ")
    .replace(new RegExp(String.raw`(?<![\w)\]])\+\s?(?=[$€£¥]?\.?\d)`, "g"), "plus ");

  // Rates: "$12/mo", "10 MB/s", "$5/user" -> "... per month".
  t.replace(new RegExp(String.raw`(?<=\d\s?(?:[kKMBT]|bn|[KMGT]i?B|[KMG]b|ms)?|%)\/(${Object.keys(PER).join("|")})\b`, "g"), (_, u: string) => ` per ${PER[u]}`);

  // ISO dates and datetimes: 2026-10-21, 2026-10-21T14:05.
  t.replace(/\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z)?)?\b/g, (m, y, mo, d, hh, mm, ss, z) => {
    const month = Number(mo);
    const day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) return m;
    let out = dateWords(MONTHS[month - 1], d, y);
    if (hh !== undefined) out += `, at ${timeWords(Number(hh), Number(mm), ss, undefined)}${z ? " UTC" : ""}`;
    return out;
  });
  // Month-name dates: "Oct 21, 2026", "October 21st 2026", "21 October 2026", "October 2026", "Oct 21".
  t.replace(new RegExp(String.raw`\b${MONTH_RE}\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`, "g"), (_, mon, d, y) =>
    dateWords(mon, d, y),
  );
  t.replace(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+${MONTH_RE}(?:,?\s+(\d{4}))?\b`, "g"), (_, d, mon, y) =>
    `the ${ordinalToWords(Number(d))} of ${dateWords(mon, undefined, y)}`,
  );
  t.replace(new RegExp(String.raw`\b${MONTH_RE}\s+(\d{4})\b`, "g"), (_, mon, y) => dateWords(mon, undefined, y));

  // Times: 9am-5pm, 3:30pm, 14:00, 9:05 AM; h:mm:ss is a duration.
  const AMPM = String.raw`\s*([ap])(?:\.?m\b\.?)`;
  t.replace(new RegExp(String.raw`\b(\d{1,2})(?::(\d{2}))?${AMPM}?\s?[-–]\s?(\d{1,2})(?::(\d{2}))?${AMPM}`, "gi"), (m: string, h1, m1, a1, h2, m2, a2, off: number, whole: string) => {
    if (+h1 < 1 || +h1 > 12 || +h2 < 1 || +h2 > 12 || +(m1 ?? 0) > 59 || +(m2 ?? 0) > 59) return m;
    return `${timeWords(+h1, +(m1 ?? 0), undefined, a1 ?? a2)} to ${timeWords(+h2, +(m2 ?? 0), undefined, a2)}${keepStop(m, off, whole, true)}`;
  });
  t.replace(new RegExp(String.raw`\b(\d{1,2}):(\d{2})(?::(\d{2}))?(?:${AMPM})?`, "gi"), (m: string, h, min, sec, ap, off: number, whole: string) => {
    const hour = Number(h);
    const mins = Number(min);
    if (hour > 24 || mins > 59 || (sec !== undefined && Number(sec) > 59)) return m;
    if (sec !== undefined && !ap) return durationWords(hour, mins, Number(sec));
    return timeWords(hour, mins, sec, ap) + keepStop(m, off, whole, true);
  });
  t.replace(new RegExp(String.raw`\b(\d{1,2})${AMPM}(?=[\s,.;:!?)]|$)`, "gi"), (m: string, h, ap: string, off: number, whole: string) =>
    Number(h) >= 1 && Number(h) <= 12 ? `${numberToWords(Number(h))} ${ap.toLowerCase() === "a" ? "AM" : "PM"}${keepStop(m, off, whole, true)}` : m,
  );
  t.replace(/\b(\d{1,2})\s(AM|PM)\b/g, (_, h: string, ap: string) => `${numberToWords(Number(h))} ${ap}`);

  // Money: $5-10, $420, CA$12, €5, $4.99, $2.5M, $1.5 billion, 12 USD, 5 €.
  const SCALE = String.raw`(?:\s?(bn|mm|MM|[kKmMbBtT])(?![\w])|\s(thousand|million|billion|trillion)\b)?`;
  t.replace(
    new RegExp(String.raw`(?<![\w$])([A-Z]{1,2}\$|[$€£¥₹₩₿])\s?(${NUM})\s?[-–]\s?(?:\1)?\s?(${NUM})${SCALE}`, "g"),
    (m, sym: string, a: string, b: string, s1: string | undefined, s2: string | undefined) => {
      const names = CURRENCY_PREFIX[sym];
      if (!names) return m;
      const from = a.includes(".") ? money(a, undefined, names) : decimalWords(a);
      return `${from} to ${money(b, s1 ?? s2, names)}`;
    },
  );
  t.replace(
    new RegExp(String.raw`(?<![\w$])([A-Z]{1,2}\$|[$€£¥₹₩₿])\s?(${NUM}|\.\d+)${SCALE}`, "g"),
    (m, sym: string, amount: string, s1: string | undefined, s2: string | undefined) => {
      const names = CURRENCY_PREFIX[sym];
      return names ? money(amount, s1 ?? s2, names) : m;
    },
  );
  t.replace(new RegExp(String.raw`(?<![\w.])(${NUM})\s?([€£¥₹₩])(?![\w\d])`, "g"), (_, amount: string, sym: string) => money(amount, undefined, CURRENCY_PREFIX[sym]));
  t.replace(new RegExp(String.raw`\b(${NUM})\s?(${Object.keys(CURRENCY_CODE).join("|")})\b`, "g"), (_, amount, code: string) =>
    money(amount, undefined, CURRENCY_CODE[code]),
  );

  // Ranges of percentages and plain percentages.
  t.replace(new RegExp(String.raw`(?<![\w.])(-?${NUM})\s?[-–](\s?)(${NUM})\s?%`, "g"), (_, a, _s, b) => `${numberWords(a)} to ${numberWords(b)} percent`);
  t.replace(new RegExp(String.raw`(?<![\w.])([-−]?${NUM}|[-−]?\.\d+)\s?%`, "g"), (_, n) => `${numberWords(n)} percent`);

  // Ordinals: 1st, 22nd, 103rd.
  t.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_, n: string) => (n.length > 15 ? integerWords(n) : ordinalToWords(Number(n))));

  // Decades: 1980s, '90s, "the 80s". A bare "30s" elsewhere is a duration.
  const DECADES = ["hundreds", "tens", "twenties", "thirties", "forties", "fifties", "sixties", "seventies", "eighties", "nineties"];
  t.replace(/\b(1\d|20)(\d)0s\b/g, (_, century: string, decade: string) =>
    century === "20" && decade === "0" ? "two thousands" : `${numberToWords(Number(century))} ${DECADES[Number(decade)]}`,
  );
  t.replace(/(?:'|(?<=\b(?:the|early|mid|late|of)\s))(\d)0s\b/gi, (_, decade: string) => DECADES[Number(decade)]);

  // IPv4 addresses, octet by octet.
  t.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (...m) => m.slice(1, 5).map((o: string) => integerWords(o)).join(" dot "));

  // Versions: v1.2.3, 1.2.3, v2.
  t.replace(/\b[vV](\d+(?:\.\d+)*)\b/g, (_, v: string) => `version ${versionWords(v)}`);
  t.replace(/(?<![\d.])(\d+(?:\.\d+){2,})(?![\d.]*\d)/g, (_, v: string) => versionWords(v));

  // Model names: GPT-4, gpt-3.5, Llama-3.
  t.replace(/\b([A-Za-z][A-Za-z]*)-(\d+(?:\.\d+)?)\b/g, (_, name: string, n: string) => `${name} ${numberWords(n)}`);

  // Phone numbers before ranges claim the hyphens.
  t.replace(/(?<![\d-])(?:(\+?1)[-. ])?\(?(\d{3})\)?[-. ](\d{3})[-.](\d{4})(?![\d-])/g, (_, c, a, b, d) =>
    [c, a, b, d].filter(Boolean).map((g: string) => spellDigits(g)).join(", "),
  );

  // Scientific notation: 1e-4, 6.022E23.
  t.replace(/(?<![\w.])(-?\d+(?:\.\d+)?)[eE]([+-]?\d+)(?!\w|\.\d)/g, (_, c, e) => {
    const exp = Number(e);
    return `${decimalWords(c)} times ten to the ${exp < 0 ? "minus " : ""}${numberToWords(Math.abs(exp))}`;
  });

  // Durations and units glued to numbers or after a space: "6m 10s", "500ms", "12 MB", "3×".
  const unitKeys = Object.keys(UNITS).sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
  t.replace(new RegExp(String.raw`(?<![\w.])(-?${NUM}|-?\.\d+)(\s?)(${unitKeys.join("|")})(?![\w°])`, "g"), (m: string, n: string, space: string, unit: string, ...rest: any[]) => {
    if (space && !SPACED_UNITS.has(unit)) return m;
    const words = numberWords(n);
    let [one, many] = UNITS[unit];
    // "m" is minutes only beside other time ("1h 30m", "6m 10s") or after "took", "in", "every"...; else meters.
    if (unit === "m") {
      const before = rest[rest.length - 1].slice(0, rest[rest.length - 2]);
      const after = rest[rest.length - 1].slice(rest[rest.length - 2] + m.length);
      const time = /\d\s?h\s*$|\b(?:took|takes|take|in|for|every|after|within|last|about|over|under|wait)\s+$/i.test(before) || /^\s*\d+\s?s\b|^\s+ago\b/.test(after);
      if (!time) [one, many] = ["meter", "meters"];
    }
    return `${words} ${words === "one" ? one : many}`;
  });
  // Bare scale suffixes: 7B parameters, 340M, 1.5k.
  t.replace(new RegExp(String.raw`(?<![\w.])(${NUM})\s?(bn|[kKMBT])(?![\w])`, "g"), (_, n, s: string) => `${decimalWords(n)} ${SCALE_SUFFIX[s]}`);

  // Multiplication and dimensions: 1920×1080, 3 x 4.
  t.replace(new RegExp(String.raw`(${NUM})\s?[×x]\s?(${NUM})`, "g"), (_, a, b) => `${dimensionWords(a)} by ${dimensionWords(b)}`);
  t.replace(/\s?×\s?/g, " times ");

  // Fractions and ratios: 1/2, 3/4 (denominators 2-10, smaller numerators); 24/7, 50/50, 4.5/5, 12/15.
  t.replace(/(?<![\d/.])(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)(?![\d/]|\.\d)/g, (_, a: string, b: string) => {
    const num = Number(a);
    const den = Number(b);
    if (a === "24" && b === "7") return "twenty-four seven";
    if (a === b) return `${numberWords(a)} ${numberWords(b)}`;
    if (Number.isInteger(num) && Number.isInteger(den) && den >= 2 && den <= 10 && num >= 1 && num < den) {
      let denWords: string;
      if (den === 2) denWords = "half";
      else if (den === 4) denWords = num === 1 ? "quarter" : "quarters";
      else denWords = ordinalToWords(den) + (num === 1 ? "" : "s");
      return `${numberToWords(num)} ${denWords}`;
    }
    return `${numberWords(a)} ${num <= den ? "out of" : "over"} ${numberWords(b)}`;
  });

  // Numeric ranges: 10-20, 2020-2024, pages 5–7.
  t.replace(new RegExp(String.raw`(?<![\w.-])(${NUM})\s?[-–]\s?(${NUM})(?!\w|\.\d)`, "g"), (_, a, b) => `${numberWords(a)} to ${numberWords(b)}`);

  // Symbols between words.
  t
    .replace(/\s*&\s*/g, " and ")
    .replace(new RegExp(String.raw`(${NUM})\s?\+\s?(${NUM})`, "g"), "$1 plus $2")
    .replace(/(\w)\+(?=\s|$)/g, "$1 plus")
    .replace(/\s=\s/g, " equals ")
    .replace(/\s\+\s/g, " plus ")
    .replace(/\s*(?:<=|≤)\s*/g, " at most ")
    .replace(/\s*(?:>=|≥)\s*/g, " at least ")
    .replace(/\s<\s/g, " less than ")
    .replace(/\s>\s/g, " greater than ")
    .replace(/\s*(?:->|→|=>)\s*/g, " to ")
    .replace(/~\s?(?=\d)/g, "about ")
    .replace(/#(?=\d)/g, "number ")
    .replace(/(\d)\s?°(?![CF])/g, "$1 degrees")
    .replace(/([A-Za-z])\/([A-Za-z])/g, "$1 $2");

  // Remaining numbers, split from letters they touch ("M3" -> "M three", "3D" -> "three D").
  t.replace(/(\p{L})(?=\d)|(\d)(?=\p{L})/gu, "$1$2 ");
  t.replace(/(?<![\w.])([-−]?\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)(?![\d])/g, (_, n: string) => numberWords(n));
  t.replace(/\d+/g, (n) => ` ${integerWords(n)} `);

  // Punctuation the speech model can use; parentheses and brackets become commas.
  t
    .replace(/\s+[-–]\s+/g, " — ")
    .replace(/\s*—\s*/g, " — ")
    .replace(/\s*[([{]\s*/g, ", ")
    .replace(/\s*[)\]}]\s*(?=[.,;:!?])/g, "")
    .replace(/\s*[)\]}]\s*/g, ", ")
    .replace(/[^\p{L}\p{N}\p{M}\s.,?!;:'\-—…]/gu, " ")
    .replace(/(^|\s)'+|'+(?=\s|$|[.,?!;:])/g, "$1")
    .replace(/\s+([.,?!;:…])/g, "$1")
    .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
    .replace(/^[\s,;:.]+/, "")
    .replace(/[\s,;:]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .nfc();
  return { text: t.text, start: Int32Array.from(t.start), end: Int32Array.from(t.end) };
}

const NON_BOUNDARY = new Set([
  "dr", "prof", "mr", "mrs", "ms", "fig", "figs", "pp", "p", "ch", "sec", "st", "jr", "sr", "no", "vs", "etc", "al",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "inc", "ltd", "e", "i", "g",
]);

function isSentenceEnd(text: string, i: number): boolean {
  const ch = text[i];
  if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "…") return false;
  const next = text[i + 1];
  if (next !== undefined && !/\s/.test(next)) return false;
  if (ch === ".") {
    const word = /([A-Za-z]+)$/.exec(text.slice(0, i))?.[1]?.toLowerCase() ?? "";
    if (NON_BOUNDARY.has(word)) return false;
  }
  return true;
}

function endWithPause(s: string): string {
  s = s.trim();
  return s && !/[.!?,;:…]$/.test(s) ? `${s},` : s;
}

/**
 * Splits normalised text into sentence chunks of at most `maxLen` characters,
 * each ending in punctuation, as KittenTTS's chunk_text does. Kitten picks the
 * voice's style row from each chunk's length, so synthesise chunk by chunk.
 */
export function chunkText(text: string, maxLen = 400): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (isSentenceEnd(text, i)) {
      sentences.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) sentences.push(text.slice(start));
  const chunks: string[] = [];
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length <= maxLen) {
      chunks.push(endWithPause(sentence));
      continue;
    }
    // Long sentences break between words.
    let current = "";
    for (const piece of sentence.split(/\s+/)) {
      if (current && current.length + piece.length + 1 > maxLen) {
        chunks.push(endWithPause(current));
        current = piece;
      } else current = current ? `${current} ${piece}` : piece;
    }
    if (current) chunks.push(endWithPause(current));
  }
  return chunks;
}

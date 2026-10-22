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
  const m = /^(.*?)([a-z]+)$/.exec(words)!;
  return m[1] + ordinalWord(m[2]);
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
  [/\betc\.(?=\s*$)/gi, "et cetera."],
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
  [/\ba\.m\.(?=\s|$)/gi, "AM"],
  [/\bp\.m\.(?=\s|$)/gi, "PM"],
];

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

/** Screen sizes read in pairs: 1920 -> "nineteen twenty", 1080 -> "ten eighty". */
function dimensionWords(raw: string): string {
  const digits = raw.replace(/,/g, "");
  if (!/^\d{4}$/.test(digits) || digits.endsWith("00")) return numberWords(raw);
  const lo = Number(digits.slice(2));
  return `${numberToWords(Number(digits.slice(0, 2)))} ${lo < 10 ? `oh ${ONES[lo]}` : numberToWords(lo)}`;
}

const NUM = String.raw`\d+(?:,\d{3})*(?:\.\d+)?`;

export function normalizeForSpeech(text: string): string {
  let t = text.normalize("NFC");

  // Typography to plain forms.
  t = t
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[\u00a0\u2007\u202f\u2009\u200a]/g, " ")
    .replace(/[\u200b-\u200d\ufeff\u00ad]/g, "")
    .replace(/\.{3,}/g, "…");

  // A line that ends without punctuation (a heading, a list item) still ends a sentence.
  t = t.replace(/([^\s.,;:!?…—-])[ \t]*\n+\s*/g, "$1. ").replace(/\s*\n+\s*/g, " ");

  // URLs: the domain only. Emails: local part "at" domain.
  t = t.replace(/\b(?:https?|ftp):\/\/([^\s/?#:]+)(?::\d+)?[^\s]*?(?=[.,;:!?)\]]*(?:\s|$))/gi, (_, host: string) => domainWords(host));
  t = t.replace(/\b([\w.+-]+)@([\w-]+(?:\.[\w-]+)*\.[a-z]{2,})\b/gi, (_, local: string, domain: string) => emailWords(local, domain));
  t = t.replace(/\bwww\.([\w-]+(?:\.[\w-]+)+)[^\s]*?(?=[.,;:!?)\]]*(?:\s|$))/gi, (_, host: string) => domainWords(host));
  t = t.replace(new RegExp(String.raw`\b((?:[a-z0-9-]+\.)+(?:${TLDS}))(\/[^\s]*?)?(?=[.,;:!?)\]]*(?:\s|$))`, "gi"), (m, host: string) =>
    /^\d+(\.\d+)*$/.test(host) ? m : domainWords(host),
  );

  for (const [re, words] of ABBREVIATIONS) t = t.replace(re, words);

  // ISO dates and datetimes: 2026-10-21, 2026-10-21T14:05.
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z)?)?\b/g, (m, y, mo, d, hh, mm, ss, z) => {
    const month = Number(mo);
    const day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) return m;
    let out = dateWords(MONTHS[month - 1], d, y);
    if (hh !== undefined) out += `, at ${timeWords(Number(hh), Number(mm), ss, undefined)}${z ? " UTC" : ""}`;
    return out;
  });
  // Month-name dates: "Oct 21, 2026", "October 21st 2026", "21 October 2026", "October 2026", "Oct 21".
  t = t.replace(new RegExp(String.raw`\b${MONTH_RE}\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`, "g"), (_, mon, d, y) =>
    dateWords(mon, d, y),
  );
  t = t.replace(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+${MONTH_RE}(?:,?\s+(\d{4}))?\b`, "g"), (_, d, mon, y) =>
    `the ${ordinalToWords(Number(d))} of ${dateWords(mon, undefined, y)}`,
  );
  t = t.replace(new RegExp(String.raw`\b${MONTH_RE}\s+(\d{4})\b`, "g"), (_, mon, y) => dateWords(mon, undefined, y));

  // Times: 3:30pm, 14:00, 9:05 AM, 10:15:30.
  t = t.replace(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?m\.?\b|\s*([AP])M\b)?/gi, (m, h, min, s, ap1, ap2) => {
    const hour = Number(h);
    const mins = Number(min);
    if (hour > 24 || mins > 59) return m;
    return timeWords(hour, mins, s, ap1 ?? ap2);
  });
  t = t.replace(/\b(\d{1,2})\s*([ap])\.?m\.?(?=[\s,.;:!?]|$)/gi, (m, h, ap) =>
    Number(h) >= 1 && Number(h) <= 12 ? `${numberToWords(Number(h))} ${ap.toLowerCase() === "a" ? "AM" : "PM"}` : m,
  );

  // Money: $420, CA$12, €5, $4.99, $2.5M, 12 USD.
  t = t.replace(
    new RegExp(String.raw`(?<![\w$])([A-Z]{1,2}\$|[$€£¥₹₩₿])\s?(${NUM}|\.\d+)(?:\s?(bn|mm|MM|[kKmMbBtT])(?![\w]))?`, "g"),
    (m, sym: string, amount: string, scale: string | undefined) => {
      const names = CURRENCY_PREFIX[sym];
      return names ? money(amount, scale, names) : m;
    },
  );
  t = t.replace(new RegExp(String.raw`\b(${NUM})\s?(${Object.keys(CURRENCY_CODE).join("|")})\b`, "g"), (_, amount, code: string) =>
    money(amount, undefined, CURRENCY_CODE[code]),
  );

  // Ranges of percentages and plain percentages.
  t = t.replace(new RegExp(String.raw`(?<![\w.])(-?${NUM})\s?[-–](\s?)(${NUM})\s?%`, "g"), (_, a, _s, b) => `${numberWords(a)} to ${numberWords(b)} percent`);
  t = t.replace(new RegExp(String.raw`(?<![\w.])([-−]?${NUM}|[-−]?\.\d+)\s?%`, "g"), (_, n) => `${numberWords(n)} percent`);

  // Ordinals: 1st, 22nd, 103rd.
  t = t.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_, n) => ordinalToWords(Number(n)));

  // Decades: 1980s, '90s, "the 80s". A bare "30s" elsewhere is a duration.
  const DECADES = ["hundreds", "tens", "twenties", "thirties", "forties", "fifties", "sixties", "seventies", "eighties", "nineties"];
  t = t.replace(/\b(1\d|20)(\d)0s\b/g, (_, century: string, decade: string) =>
    century === "20" && decade === "0" ? "two thousands" : `${numberToWords(Number(century))} ${DECADES[Number(decade)]}`,
  );
  t = t.replace(/(?:'|(?<=\b(?:the|early|mid|late|of)\s))(\d)0s\b/gi, (_, decade: string) => DECADES[Number(decade)]);

  // IPv4 addresses, octet by octet.
  t = t.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (...m) => m.slice(1, 5).map((o: string) => integerWords(o)).join(" dot "));

  // Versions: v1.2.3, 1.2.3, v2.
  t = t.replace(/\b[vV](\d+(?:\.\d+)*)\b/g, (_, v: string) => `version ${versionWords(v)}`);
  t = t.replace(/(?<![\d.])(\d+(?:\.\d+){2,})(?![\d.]*\d)/g, (_, v: string) => versionWords(v));

  // Model names: GPT-4, gpt-3.5, Llama-3.
  t = t.replace(/\b([A-Za-z][A-Za-z]*)-(\d+(?:\.\d+)?)\b/g, (_, name: string, n: string) => `${name} ${numberWords(n)}`);

  // Phone numbers before ranges claim the hyphens.
  t = t.replace(/(?<![\d-])(?:(\+?1)[-. ])?\(?(\d{3})\)?[-. ](\d{3})[-.](\d{4})(?![\d-])/g, (_, c, a, b, d) =>
    [c, a, b, d].filter(Boolean).map((g: string) => spellDigits(g)).join(", "),
  );

  // Scientific notation: 1e-4, 6.022E23.
  t = t.replace(/(?<![\w.])(-?\d+(?:\.\d+)?)[eE]([+-]?\d+)(?![\w.])/g, (_, c, e) => {
    const exp = Number(e);
    return `${decimalWords(c)} times ten to the ${exp < 0 ? "minus " : ""}${numberToWords(Math.abs(exp))}`;
  });

  // Durations and units glued to numbers or after a space: "6m 10s", "500ms", "12 MB", "3×".
  const unitKeys = Object.keys(UNITS).sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
  t = t.replace(new RegExp(String.raw`(?<![\w.])(-?${NUM}|-?\.\d+)(\s?)(${unitKeys.join("|")})(?![\w°])`, "g"), (m, n: string, space: string, unit: string) => {
    if (space && !SPACED_UNITS.has(unit)) return m;
    const words = numberWords(n);
    const [one, many] = UNITS[unit];
    return `${words} ${words === "one" ? one : many}`;
  });
  // Bare scale suffixes: 7B parameters, 340M, 1.5k.
  t = t.replace(new RegExp(String.raw`(?<![\w.])(${NUM})\s?(bn|[kKMBT])(?![\w])`, "g"), (_, n, s: string) => `${decimalWords(n)} ${SCALE_SUFFIX[s]}`);

  // Multiplication and dimensions: 1920×1080, 3 x 4.
  t = t.replace(new RegExp(String.raw`(${NUM})\s?[×x]\s?(${NUM})`, "g"), (_, a, b) => `${dimensionWords(a)} by ${dimensionWords(b)}`);
  t = t.replace(/\s?×\s?/g, " times ");

  // Fractions: 1/2, 3/4, 5/8 (not dates like 10/21/2026, which read as numbers).
  t = t.replace(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g, (m, a: string, b: string) => {
    const num = Number(a);
    const den = Number(b);
    if (!den) return m;
    const numWords = numberToWords(num);
    let denWords: string;
    if (den === 2) denWords = num === 1 ? "half" : "halves";
    else if (den === 4) denWords = num === 1 ? "quarter" : "quarters";
    else denWords = ordinalToWords(den) + (num === 1 ? "" : "s");
    return `${numWords} ${denWords}`;
  });

  // Numeric ranges: 10-20, 2020-2024, pages 5–7.
  t = t.replace(new RegExp(String.raw`(?<![\w.-])(${NUM})\s?[-–]\s?(${NUM})(?![\w.])`, "g"), (_, a, b) => `${numberWords(a)} to ${numberWords(b)}`);

  // Symbols between words.
  t = t
    .replace(/\s*&\s*/g, " and ")
    .replace(new RegExp(String.raw`(${NUM})\s?\+\s?(${NUM})`, "g"), "$1 plus $2")
    .replace(/(\w)\+(?=\s|$)/g, "$1 plus")
    .replace(/\s=\s/g, " equals ")
    .replace(/\s*(?:->|→|=>)\s*/g, " to ")
    .replace(/~\s?(?=\d)/g, "about ")
    .replace(/#(?=\d)/g, "number ")
    .replace(/(\d)\s?°(?![CF])/g, "$1 degrees")
    .replace(/([A-Za-z])\/([A-Za-z])/g, "$1 $2");

  // Remaining numbers, split from letters they touch ("M3" -> "M three", "3D" -> "three D").
  t = t.replace(/(\p{L})(?=\d)|(\d)(?=\p{L})/gu, "$1$2 ");
  t = t.replace(/(?<![\w.])([-−]?\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)(?![\d])/g, (_, n: string) => numberWords(n));
  t = t.replace(/\d+/g, (n) => ` ${integerWords(n)} `);

  // Punctuation the speech model can use; parentheses and brackets become commas.
  t = t
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
    .trim();
  return t;
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

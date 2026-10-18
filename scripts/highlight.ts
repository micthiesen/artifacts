// A small syntax highlighter for the splash page's example sources (MDX and
// TSX), run at build time so the page itself does no work. Output is escaped
// HTML with <span class="t-*"> around tokens; shell.css colours them.
const RULES: [cls: string, re: RegExp][] = [
  ["c", /\/\/[^\n]*|\/\*[\s\S]*?\*\//y],
  ["h", /^#{1,6} [^\n]*/my],
  ["m", /^```[^\n]*/my],
  ["s", /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/y],
  ["t", /<\/?[A-Za-z][\w.]*|\/?>/y],
  ["a", /\b[a-zA-Z][\w-]*(?==)/y],
  ["k", /\b(?:import|from|export|default|function|const|let|return|type|if|else|true|false|null|undefined)\b/y],
  ["n", /\b\d[\d_.]*\b/y],
  ["b", /\*\*[^*\n]+\*\*/y],
];

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

export function highlight(source: string): string {
  let out = "";
  let plain = "";
  let i = 0;
  // Only start tokens at a word boundary, so "co2" or "a.b" don't split.
  while (i < source.length) {
    let matched = false;
    if (i === 0 || !/[\w$]/.test(source[i - 1]) || !/[\w$]/.test(source[i])) {
      for (const [cls, re] of RULES) {
        re.lastIndex = i;
        const m = re.exec(source);
        if (!m || m[0].length === 0) continue;
        out += escape(plain) + `<span class="t-${cls}">${escape(m[0])}</span>`;
        plain = "";
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) plain += source[i++];
  }
  return out + escape(plain);
}

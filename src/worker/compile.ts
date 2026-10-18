// Compiles artifact source files to browser ES modules on write, so agents get
// errors in the tool result and viewers never transpile.
import { transform } from "sucrase";
import { init as initLexer, parse as parseModule } from "es-module-lexer/js";
import { compile as compileMdx } from "@mdx-js/mdx";
import remarkGfm from "remark-gfm";
import { compile as compileTailwind } from "tailwindcss";
import preflightCss from "tailwindcss/preflight.css";
import themeCss from "tailwindcss/theme.css";
import utilitiesCss from "tailwindcss/utilities.css";
import kitThemeCss from "../kit/theme.css";
import type { JsonValue } from "../shared/protocol.ts";
import kitExports from "./kit-exports.json";
import { remarkBlockIds, type BlockInfo } from "./blocks.ts";
import { checkMermaid, remarkMermaid, type MermaidBlock } from "./mermaid.ts";

export const ALLOWED_IMPORTS = new Set([
  "react",
  "react/jsx-runtime",
  "@a/ui",
  "@a/hooks",
  "lucide-react",
  "recharts",
]);

export type CompileError = { path: string; message: string; line?: number };
export type CompiledModule = { path: string; code: string; classes: string[]; blocks?: BlockInfo[] };


export async function compileFile(
  path: string,
  source: string,
  files: Set<string>,
): Promise<{ module?: CompiledModule; errors: CompileError[] }> {
  let code: string;
  let blocks: BlockInfo[] | undefined;
  const errors: CompileError[] = [];
  try {
    if (path.endsWith(".mdx") || path.endsWith(".md")) {
      blocks = [];
      const diagrams: MermaidBlock[] = [];
      const out = await compileMdx(stripFrontmatter(source), {
        jsxImportSource: "react",
        format: path.endsWith(".md") ? "md" : "mdx",
        providerImportSource: "@a/ui",
        remarkPlugins: [remarkGfm, remarkMermaid(diagrams), remarkBlockIds(blocks)],
      });
      code = String(out.value);
      errors.push(...(await checkMermaid(path, diagrams)));
    } else if (/\.(tsx|ts|jsx|js)$/.test(path)) {
      code = transform(source, {
        transforms: ["typescript", "jsx"],
        jsxRuntime: "automatic",
        production: true,
        // Keep unused imports so a bad specifier is still reported.
        keepUnusedImports: true,
        filePath: path,
      }).code;
    } else {
      return { errors: [] };
    }
  } catch (err) {
    const e = err as { message?: string; place?: { line?: number; start?: { line?: number } } };
    const message = e.message ?? String(err);
    const fromMessage = /\((\d+):\d+\)/.exec(message)?.[1];
    const line = fromMessage ? Number(fromMessage) : (e.place?.line ?? e.place?.start?.line);
    return { errors: [{ path, message, line }] };
  }

  let specs: string[];
  try {
    specs = await importSpecifiers(code);
  } catch (err) {
    return { errors: [{ path, message: `could not parse compiled module: ${(err as Error).message}` }] };
  }
  for (const spec of specs) {
    if (spec.startsWith("./") || spec.startsWith("../")) {
      if (!resolveImport(path, spec, files)) {
        errors.push({ path, message: `import "${spec}": no such file in this artifact` });
      }
    } else if (!ALLOWED_IMPORTS.has(spec)) {
      errors.push({
        path,
        message: `import "${spec}" is not available. Allowed: ${[...ALLOWED_IMPORTS].join(", ")} and relative files`,
      });
    }
  }
  errors.push(...checkNames(path, code));
  return { module: { path, code, classes: extractCandidates(source), blocks }, errors };
}

const MODULE_EXPORTS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(kitExports.modules).map(([m, names]) => [m, new Set(names)]),
);
const MDX_COMPONENTS = new Set(kitExports.mdxComponents);

/** Reject named imports a module doesn't export and MDX components the kit lacks. */
function checkNames(path: string, code: string): CompileError[] {
  const errors: CompileError[] = [];
  for (const imp of lexImports(code)) {
    const exported = imp.spec ? MODULE_EXPORTS[imp.spec] : undefined;
    if (!exported || imp.ss < 0 || imp.se <= imp.ss) continue;
    const statement = code.slice(imp.ss, imp.se);
    const named = /\{([^}]*)\}/.exec(statement)?.[1];
    if (!named) continue;
    for (const part of named.split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();
      if (!name || exported.has(name)) continue;
      errors.push({ path, message: `"${name}" is not exported by ${imp.spec}.${suggest(name, exported)}` });
    }
  }
  if (path.endsWith(".mdx") || path.endsWith(".md")) {
    for (const m of code.matchAll(/_missingMdxReference\("([^"]+)"/g)) {
      const name = m[1].split(".")[0];
      if (!/^[A-Z]/.test(name) || MDX_COMPONENTS.has(name) || declaredInModule(code, name)) continue;
      errors.push({ path, message: `<${name}> is not a kit component.${suggest(name, MDX_COMPONENTS)} See artifact_guide for the list.` });
    }
  }
  return errors;
}

function declaredInModule(code: string, name: string): boolean {
  return new RegExp(`(?:import|export)\\s[^;]*\\b${name}\\b|(?:const|let|function)\\s+${name}\\b`).test(code);
}

function suggest(name: string, options: Set<string>): string {
  let best: string | null = null;
  let bestScore = Infinity;
  const lower = name.toLowerCase();
  for (const o of options) {
    const d = distance(lower, o.toLowerCase());
    if (d < bestScore) [best, bestScore] = [o, d];
  }
  return best && bestScore <= Math.max(2, Math.floor(name.length / 3)) ? ` Did you mean ${best}?` : "";
}

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]++;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

const SOURCE_EXTENSIONS = ["", ".tsx", ".ts", ".jsx", ".js", ".mdx", ".md"];

export function resolveImport(from: string, spec: string, files: Set<string>): string | null {
  const base = resolveRelative(from, spec);
  for (const ext of SOURCE_EXTENSIONS) if (files.has(base + ext)) return base + ext;
  return null;
}

type LexedImport = { spec: string | undefined; s: number; e: number; ss: number; se: number };

// es-module-lexer 2.x names fields specifier/start/end; 1.x used n/s/e.
function lexImports(code: string): LexedImport[] {
  const [imports] = parseModule(code) as unknown as [Record<string, unknown>[]];
  return imports.map((i) => ({
    spec: (i.specifier ?? i.n) as string | undefined,
    s: (i.start ?? i.s) as number,
    e: (i.end ?? i.e) as number,
    ss: (i.importStart ?? i.ss) as number,
    se: (i.importEnd ?? i.se) as number,
  }));
}

/** Static and string-literal dynamic import specifiers of a JS module. */
export async function importSpecifiers(code: string): Promise<string[]> {
  await initLexer;
  return lexImports(code).map((i) => i.spec).filter((n): n is string => typeof n === "string");
}

export function resolveRelative(from: string, spec: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

// Tailwind ignores invalid candidates, so a generous token split is enough and
// avoids the native oxide scanner, which cannot run in a Worker.
export function extractCandidates(source: string): string[] {
  const out = new Set<string>();
  for (const tok of source.split(/[\s"'`{}()<>;,]+/)) {
    if (tok.length > 0 && tok.length < 120 && /^[!@\w-][\w:/.%#\[\]()=&>+*,-]*$/.test(tok)) out.add(tok);
  }
  return [...out];
}

const STYLESHEETS: Record<string, string> = {
  "tailwindcss/preflight.css": preflightCss,
  "tailwindcss/theme.css": themeCss,
  "tailwindcss/utilities.css": utilitiesCss,
};

export async function compileCss(entryCss: string, candidates: Iterable<string>): Promise<string> {
  const compiler = await compileTailwind(entryCss, {
    base: "/",
    loadStylesheet: async (id: string) => {
      const key = id.startsWith("tailwindcss/") ? id : `tailwindcss/${id.replace(/^\.\//, "")}`;
      const content = STYLESHEETS[key];
      if (content === undefined) throw new Error(`stylesheet ${id} not available`);
      return { path: key, base: "/", content };
    },
  });
  return compiler.build([...candidates]);
}

export function stripFrontmatter(source: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(source);
  // Keep line numbers stable for error messages.
  return m ? "\n".repeat(m[0].split("\n").length - 1) + source.slice(m[0].length) : source;
}

export const ENTRY_FILES = ["index.mdx", "index.md", "app.tsx"];
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

export type Build = {
  entry: string;
  /** Import-map entries for this artifact's modules, as data: URLs. */
  imports: Record<string, string>;
  css: string;
  data: Record<string, JsonValue>;
  /** Top-level blocks of an MDX/MD entry, in order (empty for app.tsx). */
  blocks?: BlockInfo[];
  /** BUILD_STAMP of the compiler that produced this build; absent on old builds. */
  stamp?: string;
};

const ART_PREFIX = "@art/";

export function validatePath(path: string): string | null {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(path) || path.includes("..") || path.includes("//") || path.endsWith("/")) {
    return `invalid path "${path}": use relative paths like "app.tsx", "components/chart.tsx" or "data/rows.json"`;
  }
  if (path.startsWith("data/")) return path.endsWith(".json") ? null : `"${path}": files under data/ must be .json`;
  if (!/\.(tsx|ts|jsx|js|mdx|md)$/.test(path)) {
    return `"${path}": unsupported file type. Use .mdx/.md/.tsx/.ts/.jsx/.js for code and data/*.json for data`;
  }
  return null;
}

/** Compile a whole artifact. Returns errors instead of a build if anything fails. */
/** Phones are about 390 px wide; a page's own padding leaves a little less. */
const PHONE_PX = 360;
const BREAKPOINT = /^(sm|md|lg|xl|2xl|min-\[[^\]]+\]):/;

/** A Tailwind width class's fixed width in px, if it has one (w-[800px], min-w-[40rem], w-120). */
function fixedWidth(cls: string): number | null {
  const m = /^(?:min-)?w-(?:\[(\d+(?:\.\d+)?)(px|rem)\]|(\d+(?:\.\d+)?))$/.exec(cls);
  if (!m) return null;
  if (m[3]) return Number(m[3]) * 4; // the spacing scale: w-1 is 0.25rem
  return Number(m[1]) * (m[2] === "rem" ? 16 : 1);
}

/**
 * Widths that won't fit a phone, found while compiling, so the agent hears
 * about them on save without rendering the page again. Classes behind a
 * breakpoint (md:w-[800px]) are fine: they only apply on wider screens.
 */
export function phoneWidthWarnings(classes: Iterable<string>, sources: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const cls of classes) {
    if (BREAKPOINT.test(cls)) continue;
    const px = fixedWidth(cls.replace(/^!/, ""));
    if (px !== null && px > PHONE_PX) out.add(`${cls} is ${Math.round(px)} px wide, wider than a phone (about 390 px): use w-full or max-w-…, or put it behind md:`);
  }
  for (const [path, source] of Object.entries(sources)) {
    // Inline styles: style={{ width: 800 }} or width: "50rem".
    for (const m of source.matchAll(/\b(?:minWidth|width)\s*:\s*["']?(\d+(?:\.\d+)?)(px|rem)?["']?/g)) {
      const px = Number(m[1]) * (m[2] === "rem" ? 16 : 1);
      if (px > PHONE_PX) out.add(`${path}: ${m[0].trim()} is ${Math.round(px)} px wide, wider than a phone: use maxWidth or a percentage`);
    }
  }
  return [...out];
}

export async function buildArtifact(files: Record<string, string>): Promise<{ build?: Build; errors: CompileError[]; warnings?: string[] }> {
  const errors: CompileError[] = [];
  const paths = Object.keys(files);
  const pathSet = new Set(paths);
  let total = 0;
  for (const path of paths) {
    const bad = validatePath(path);
    if (bad) errors.push({ path, message: bad });
    const size = new TextEncoder().encode(files[path]).length;
    total += size;
    if (size > MAX_FILE_BYTES) errors.push({ path, message: `file is ${size} bytes; the limit is ${MAX_FILE_BYTES}` });
  }
  if (total > MAX_ARTIFACT_BYTES) errors.push({ path: "", message: `artifact is ${total} bytes; the limit is ${MAX_ARTIFACT_BYTES}` });
  const entries = ENTRY_FILES.filter((e) => pathSet.has(e));
  if (entries.length !== 1) {
    errors.push({
      path: "",
      message: entries.length === 0
        ? `no entry file: add exactly one of ${ENTRY_FILES.join(", ")}`
        : `several entry files (${entries.join(", ")}): keep exactly one`,
    });
  }
  if (errors.length) return { errors };

  const imports: Record<string, string> = {};
  const data: Record<string, JsonValue> = {};
  const candidates = new Set<string>();
  let blocks: BlockInfo[] = [];
  for (const path of paths) {
    if (path.startsWith("data/")) {
      try {
        data[path] = JSON.parse(files[path]);
      } catch (err) {
        errors.push({ path, message: `invalid JSON: ${(err as Error).message}` });
      }
      continue;
    }
    const result = await compileFile(path, files[path], pathSet);
    errors.push(...result.errors);
    if (!result.module) continue;
    for (const c of result.module.classes) candidates.add(c);
    if (path === entries[0] && result.module.blocks) blocks = result.module.blocks;
    const code = await rewriteRelativeImports(path, result.module.code, pathSet);
    imports[ART_PREFIX + path] = `data:text/javascript;base64,${toBase64(code)}`;
  }
  if (errors.length) return { errors };

  let css: string;
  try {
    css = await compileCss(ARTIFACT_CSS_ENTRY, candidates);
  } catch (err) {
    return { errors: [{ path: "", message: `stylesheet: ${(err as Error).message}` }] };
  }
  const code = Object.fromEntries(paths.filter((p) => !p.startsWith("data/")).map((p) => [p, files[p]]));
  const warnings = phoneWidthWarnings(candidates, code);
  return { build: { entry: ART_PREFIX + entries[0], imports, css, data, blocks, stamp: BUILD_STAMP }, errors: [], ...(warnings.length ? { warnings } : {}) };
}

const ARTIFACT_CSS_ENTRY = `@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
${kitThemeCss}`;

/**
 * Identifies the stylesheet inputs baked into every build. Each build inlines
 * the kit theme, so a build made before a theme change keeps the old colours
 * until it is recompiled; the hub rebuilds any build whose stamp differs.
 * Bump BUILD_FORMAT for compiler changes that should also trigger a rebuild.
 */
const BUILD_FORMAT = 1;
export const BUILD_STAMP = `${BUILD_FORMAT}.${fnv1a(themeCss + utilitiesCss + ARTIFACT_CSS_ENTRY)}`;

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

async function rewriteRelativeImports(from: string, code: string, files: Set<string>): Promise<string> {
  await initLexer;
  let out = "";
  let last = 0;
  for (const imp of lexImports(code)) {
    if (!imp.spec || !(imp.spec.startsWith("./") || imp.spec.startsWith("../"))) continue;
    const target = resolveImport(from, imp.spec, files);
    if (!target) continue;
    // s..e spans the specifier without quotes for static imports; dynamic
    // imports with a string literal include the quotes.
    const raw = code.slice(imp.s, imp.e);
    const quoted = raw.startsWith('"') || raw.startsWith("'");
    out += code.slice(last, imp.s) + (quoted ? JSON.stringify(ART_PREFIX + target) : ART_PREFIX + target);
    last = imp.e;
  }
  return out + code.slice(last);
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

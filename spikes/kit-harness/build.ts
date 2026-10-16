// Builds frame documents for the kit harness the way the Worker will: each
// sample is compiled with src/worker/compile.ts (MDX/TSX -> ESM, Tailwind
// classes -> per-artifact CSS on src/kit/theme.css), modules become data: URLs
// in an import map, and the kit is referenced at /kit/v1/.
//   bun spikes/kit-harness/build.ts   (expects `bun run build:kit` first)
import "../text-loader.ts";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const { compileFile, compileCss } = await import("../../src/worker/compile.ts");

const ROOT = resolve(import.meta.dir, "../..");
const SAMPLES = join(import.meta.dir, "samples");
const OUT = join(ROOT, "dist/kit-harness");
const THEME = await readFile(join(ROOT, "src/kit/theme.css"), "utf8");
const ENTRY_CSS = `@import "tailwindcss/theme.css" layer(theme);\n@import "tailwindcss/utilities.css" layer(utilities);\n${THEME}`;

export const KIT_IMPORTS: Record<string, string> = {
  react: "/kit/v1/react.js",
  "react/jsx-runtime": "/kit/v1/jsx-runtime.js",
  "@a/ui": "/kit/v1/ui.js",
  "@a/hooks": "/kit/v1/hooks.js",
  "lucide-react": "/kit/v1/lucide.js",
  recharts: "/kit/v1/recharts.js",
};

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
const dataUrl = (code: string) => `data:text/javascript;base64,${Buffer.from(code, "utf8").toString("base64")}`;

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, "frames"), { recursive: true });
const manifest: { name: string; entry: string }[] = [];

for (const name of (await readdir(SAMPLES)).sort()) {
  const dir = join(SAMPLES, name);
  const files = (await walk(dir)).map((f) => relative(dir, f));
  const paths = new Set(files);
  const entry = ["index.mdx", "index.md", "app.tsx"].find((e) => paths.has(e));
  if (!entry) throw new Error(`${name}: no entry file`);
  const imports: Record<string, string> = { ...KIT_IMPORTS };
  const data: Record<string, unknown> = {};
  const classes = new Set<string>();
  for (const path of files) {
    const source = await readFile(join(dir, path), "utf8");
    if (path.startsWith("data/") && path.endsWith(".json")) {
      data[path] = JSON.parse(source);
      continue;
    }
    const { module, errors } = await compileFile(path, source, paths);
    if (errors.length) throw new Error(`${name}/${path}: ${errors.map((e) => e.message).join("; ")}`);
    if (!module) continue;
    // The Worker rewrites relative imports to @art/<path>; the samples have none.
    imports[`@art/${path}`] = dataUrl(module.code);
    for (const c of module.classes) classes.add(c);
  }
  const css = await compileCss(ENTRY_CSS, classes);
  const boot = { artifactId: `sample-${name}`, version: 1, entry: `@art/${entry}`, data, title: name };
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/kit/v1/kit.css">
<style>${css}</style>
<script type="importmap">${scriptJson({ imports })}</script>
<script type="application/json" id="art-boot">${scriptJson(boot)}</script>
<script type="module" src="/kit/v1/boot.js"></script>
</head>
<body><div id="root"></div></body>
</html>
`;
  await writeFile(join(OUT, "frames", `${name}.html`), html);
  manifest.push({ name, entry });
  console.log(`${name}: ${entry}, ${files.length} files, frame ${(html.length / 1024).toFixed(1)} KB, css ${(css.length / 1024).toFixed(1)} KB`);
}
await writeFile(join(OUT, "samples.json"), JSON.stringify(manifest));
console.log(`harness frames -> ${relative(ROOT, OUT)}`);

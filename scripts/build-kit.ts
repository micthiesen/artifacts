// Builds the frame kit into dist/kit/, laid out so the directory maps 1:1 onto
// URLs when used as a Workers static-assets directory:
//   dist/kit/_headers            CORS + immutable caching for /kit/v1/*, a day's caching for /static/*
//   dist/kit/kit/v1/*.js         ESM entries (import-map targets)
//   dist/kit/kit/v1/chunks/*.js  shared code-split chunks (one React instance)
//   dist/kit/kit/v1/kit.css      Tailwind v4 (preflight, theme, kit classes) + @font-face
//   dist/kit/kit/v1/fonts/*      Inter Variable (self-hosted)
import { build } from "esbuild";
import { createRequire } from "node:module";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const ROOT = resolve(import.meta.dir, "..");
const OUT_ROOT = join(ROOT, "dist/kit");
const OUT = join(OUT_ROOT, "kit/v1");
const GEN = join(ROOT, "node_modules/.cache/build-kit");
const require = createRequire(join(ROOT, "package.json"));

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** CJS packages need explicit named re-exports so the import map gets static ESM names. */
function cjsReexport(spec: string, prodFile: string, withDefault: boolean): string {
  // Package `exports` hide the cjs/ files, so load the production build by path.
  const [pkg, ...rest] = prodFile.split("/");
  const mod = require(join(dirname(require.resolve(`${pkg}/package.json`)), ...rest)) as Record<string, unknown>;
  const names = Object.keys(mod).filter((k) => IDENT.test(k) && k !== "default" && k !== "__esModule");
  return [
    `import * as M from ${JSON.stringify(spec)};`,
    `const R = M.default ?? M;`,
    `export const { ${names.join(", ")} } = R;`,
    withDefault ? `export default R;` : "",
  ].join("\n");
}

async function generateEntries() {
  await rm(GEN, { recursive: true, force: true });
  await mkdir(GEN, { recursive: true });
  const files: Record<string, string> = {
    "react.js": cjsReexport("react", "react/cjs/react.production.js", true),
    "jsx-runtime.js": cjsReexport("react/jsx-runtime", "react/cjs/react-jsx-runtime.production.js", false),
    "react-dom-client.js": cjsReexport("react-dom/client", "react-dom/cjs/react-dom-client.production.js", true),
    "lucide.js": `export * from "lucide-react";`,
    "recharts.js": `export * from "recharts";`,
  };
  for (const [name, src] of Object.entries(files)) await writeFile(join(GEN, name), src + "\n");
}

async function buildJs() {
  const result = await build({
    metafile: true,
    entryPoints: {
      react: join(GEN, "react.js"),
      "jsx-runtime": join(GEN, "jsx-runtime.js"),
      "react-dom-client": join(GEN, "react-dom-client.js"),
      lucide: join(GEN, "lucide.js"),
      recharts: join(GEN, "recharts.js"),
      ui: join(ROOT, "src/kit/ui/index.ts"),
      hooks: join(ROOT, "src/kit/hooks.ts"),
      runtime: join(ROOT, "src/kit/runtime.tsx"),
      boot: join(ROOT, "src/kit/boot.ts"),
    },
    absWorkingDir: ROOT,
    outdir: OUT,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    sourcemap: false,
    jsx: "automatic",
    jsxImportSource: "react",
    chunkNames: "chunks/[name]-[hash]",
    entryNames: "[name]",
    define: { "process.env.NODE_ENV": '"production"' },
    legalComments: "external",
    logLevel: "warning",
  });
  await writeFile(join(GEN, "meta.json"), JSON.stringify(result.metafile));
}

async function buildFonts(): Promise<string> {
  const pkg = dirname(require.resolve("@fontsource-variable/inter/package.json"));
  await mkdir(join(OUT, "fonts"), { recursive: true });
  let css = "";
  for (const sheet of ["wght.css", "wght-italic.css"]) {
    const src = await readFile(join(pkg, sheet), "utf8");
    for (const m of src.matchAll(/url\(\.\/files\/([^)]+\.woff2)\)/g)) await copyFile(join(pkg, "files", m[1]), join(OUT, "fonts", m[1]));
    css += src.replace(/url\(\.\/files\//g, "url(./fonts/");
  }
  await copyFile(join(pkg, "LICENSE"), join(OUT, "fonts/LICENSE-Inter.txt"));
  return css;
}

async function buildCss(fontCss: string) {
  const bin = join(ROOT, "node_modules/.bin/tailwindcss");
  const tmp = join(GEN, "kit.css");
  const proc = Bun.spawn([bin, "-i", join(ROOT, "src/kit/kit.css"), "-o", tmp, "--minify"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`tailwindcss failed (${code}):\n${await new Response(proc.stderr).text()}`);
  const tw = await readFile(tmp, "utf8");
  // Strip comments/whitespace from the fontsource CSS; @font-face must stay unlayered.
  const fonts = fontCss.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s*\n\s*/g, "").replace(/;\}/g, "}");
  await writeFile(join(OUT, "kit.css"), fonts + "\n" + tw);
}

async function writeHeaders() {
  await writeFile(
    join(OUT_ROOT, "_headers"),
    [
      "/kit/v1/*",
      "  Access-Control-Allow-Origin: *",
      "  Cache-Control: public, max-age=31536000, immutable",
      "  X-Content-Type-Options: nosniff",
      // The shell's own scripts and styles: pages link them with ?v=<build>, so a day's caching never serves an
      // old one after a deploy (icons, linked without it, can be a day stale).
      "/static/*",
      "  Cache-Control: public, max-age=86400",
      "  X-Content-Type-Options: nosniff",
      "",
    ].join("\n"),
  );
  await copyFile(join(ROOT, "THIRD_PARTY_NOTICES.md"), join(OUT, "THIRD_PARTY_NOTICES.md"));
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out.sort();
}

async function report() {
  const rows: [string, number, number][] = [];
  for (const f of await walk(OUT_ROOT)) {
    const raw = (await stat(f)).size;
    const gz = /\.(js|css|txt|md)$|_headers$/.test(f) ? gzipSync(await readFile(f)).length : raw;
    rows.push([relative(OUT_ROOT, f), raw, gz]);
  }
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`.padStart(10);
  for (const [f, raw, gz] of rows) console.log(`${f.padEnd(56)} ${kb(raw)} ${kb(gz)} gz`);
  const total = rows.reduce((a, r) => [a[0] + r[1], a[1] + r[2]], [0, 0]);
  console.log(`${"total".padEnd(56)} ${kb(total[0])} ${kb(total[1])} gz`);
}

const t0 = performance.now();
await rm(OUT_ROOT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await generateEntries();
const [, fontCss] = await Promise.all([buildJs(), buildFonts()]);
await buildCss(fontCss);
await writeHeaders();
if (!process.argv.includes("--quiet")) await report();
console.log(`kit built in ${(performance.now() - t0).toFixed(0)} ms -> ${relative(ROOT, OUT_ROOT)}`);

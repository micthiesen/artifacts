// Builds the Worker bundles and the shell client. The kit is built separately
// (scripts/build-kit.ts) into dist/kit, which is also the Worker's asset directory.
import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

const common = {
  bundle: true,
  format: "esm" as const,
  minify: true,
  sourcemap: false,
  target: "es2022",
  logLevel: "warning" as const,
};

await build({
  ...common,
  entryPoints: ["src/worker/index.ts"],
  outfile: "build/worker/index.js",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["worker", "browser"],
  external: ["cloudflare:workers"],
  loader: { ".css": "text", ".md": "text" },
  metafile: true,
});
await build({
  ...common,
  entryPoints: ["src/auth/index.ts"],
  outfile: "build/auth/index.js",
  platform: "neutral",
});
await mkdir("dist/kit/static", { recursive: true });
await build({ ...common, entryPoints: ["src/shell/shell.ts"], outfile: "dist/kit/static/shell.js", platform: "browser" });
await cp("src/shell/shell.css", "dist/kit/static/shell.css");
console.log("built build/worker, build/auth, dist/kit/static");

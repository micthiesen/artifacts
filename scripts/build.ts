// Builds the shell client and the Worker bundles. The kit is built separately
// (scripts/build-kit.ts) into dist/kit, which is also the Worker's asset directory.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile } from "node:fs/promises";

const common = {
  bundle: true,
  format: "esm" as const,
  minify: true,
  sourcemap: false,
  target: "es2022",
  logLevel: "warning" as const,
};

await mkdir("dist/kit/static", { recursive: true });
await build({ ...common, entryPoints: ["src/shell/shell.ts"], outfile: "dist/kit/static/shell.js", platform: "browser" });
await build({ ...common, entryPoints: ["src/shell/account.ts"], outfile: "dist/kit/static/account.js", platform: "browser" });
await cp("src/shell/shell.css", "dist/kit/static/shell.css");
// Icons: tab favicon (SVG + PNG), iOS home screen / favourites, and the paths
// browsers probe at the root.
await cp("src/shell/icons", "dist/kit/static/icons", { recursive: true });
await cp("src/shell/icons/apple-touch-icon.png", "dist/kit/apple-touch-icon.png");
await cp("src/shell/icons/apple-touch-icon.png", "dist/kit/apple-touch-icon-precomposed.png");
await cp("src/shell/icons/favicon-32.png", "dist/kit/favicon.ico");
await Bun.write(
  "dist/kit/manifest.webmanifest",
  JSON.stringify({
    name: "Shared Artifacts",
    short_name: "Artifacts",
    start_url: "/",
    display: "standalone",
    background_color: "#0b0d15",
    theme_color: "#0b0d15",
    icons: [
      { src: "/static/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/static/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  }),
);

// Static files keep stable names, and edge caches hold them, so the Worker
// references them with ?v=<hash of all assets>.
const hash = createHash("sha256");
for (const name of (await readdir("dist/kit", { recursive: true })).sort()) {
  const data = await readFile(`dist/kit/${name}`).catch(() => null);
  if (data) hash.update(name).update(data);
}
const assetVersion = hash.digest("hex").slice(0, 12);

await build({
  ...common,
  entryPoints: ["src/worker/index.ts"],
  outfile: "build/worker/index.js",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["worker", "browser"],
  external: ["cloudflare:workers"],
  loader: { ".css": "text", ".md": "text" },
  define: { __ASSET_VERSION__: JSON.stringify(assetVersion) },
});
await build({
  ...common,
  entryPoints: ["src/auth/index.ts"],
  outfile: "build/auth/index.js",
  platform: "neutral",
});
console.log(`built build/worker (assets ${assetVersion}), build/auth, dist/kit/static`);

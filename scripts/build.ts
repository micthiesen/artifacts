// Builds the shell client and the Worker bundles. The kit is built separately
// (scripts/build-kit.ts) into dist/kit, which is also the Worker's asset directory.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { PRODUCT } from "../src/shared/brand.ts";
import demos from "../src/worker/demos.json";

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
await build({ ...common, entryPoints: ["src/shell/home.ts"], outfile: "dist/kit/static/home.js", platform: "browser" });
await build({ ...common, entryPoints: ["src/shell/splash.ts"], outfile: "dist/kit/static/splash.js", platform: "browser" });
await build({ ...common, entryPoints: ["src/shell/me.ts"], outfile: "dist/kit/static/me.js", platform: "browser" });
await build({ ...common, entryPoints: ["src/shell/login.ts"], outfile: "dist/kit/static/login.js", platform: "browser" });
await build({ ...common, entryPoints: ["src/shell/settings.ts"], outfile: "dist/kit/static/settings.js", platform: "browser" });
await build({ ...common, entryPoints: ["src/shell/admin.ts"], outfile: "dist/kit/static/admin.js", platform: "browser" });
await build({ ...common, entryPoints: ["src/shell/layout-check.ts"], outfile: "dist/kit/static/layout-check.js", platform: "browser" });
await build({ ...common, entryPoints: ["src/shell/forms.ts"], outfile: "dist/kit/static/forms.js", platform: "browser" });
// The service worker must be served from the root to control every page.
await build({ ...common, entryPoints: ["src/shell/sw/sw.ts"], outfile: "dist/kit/sw.js", platform: "browser" });
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
    name: PRODUCT,
    short_name: PRODUCT,
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

// The splash page embeds every example; scripts/build-demos.ts must have built them.
for (const d of demos) {
  if (!(await Bun.file(`dist/kit/demo/${d.slug}.html`).exists())) throw new Error(`dist/kit/demo/${d.slug}.html is missing: run the full bun run build`);
}

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
console.log(`built build/worker (assets ${assetVersion}), dist/kit/static`);

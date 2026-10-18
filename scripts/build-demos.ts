// Compiles the splash page's example artifacts (demo/) with the Worker's own
// compiler and writes:
//   dist/kit/demo/<slug>.html  static frame documents, served as assets so the
//                              splash costs no Worker time to show them
//   src/worker/demos.json      what the splash page needs: highlighted source,
//                              labels, the seeded shared state and the public
//                              copy's link (demo/links.json)
// Run after build:kit (the frames point at the kit by its content hash).
//   bun --preload ./spikes/text-loader.ts scripts/build-demos.ts
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { buildArtifact, ENTRY_FILES } from "../src/worker/compile.ts";
import { DEMO_FRAME_CSP, frameHtml } from "../src/worker/pages.ts";
import { EXAMPLES } from "../demo/examples.ts";
import { highlight } from "./highlight.ts";

const ROOT = resolve(import.meta.dir, "..");
const KIT_DIR = join(ROOT, "dist/kit/kit/v1");
const OUT = join(ROOT, "dist/kit/demo");

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out.sort();
}

// The kit's files are cached as immutable, so frames name them by content.
const hash = createHash("sha256");
for (const file of await walk(KIT_DIR)) hash.update(relative(KIT_DIR, file)).update(await readFile(file));
const kitVersion = hash.digest("hex").slice(0, 12);

// Public copies in the demo workspace, from scripts/seed-demo.ts.
const links = JSON.parse(await readFile(join(ROOT, "demo/links.json"), "utf8").catch(() => "{}")) as Record<string, string>;

await mkdir(OUT, { recursive: true });
const demos = [];
for (const ex of EXAMPLES) {
  const dir = join(ROOT, "demo", ex.slug);
  const files: Record<string, string> = {};
  for (const file of await walk(dir)) files[relative(dir, file)] = await readFile(file, "utf8");
  const { build, errors } = await buildArtifact(files);
  if (!build) throw new Error(`demo/${ex.slug}: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
  const entry = ENTRY_FILES.find((f) => f in files)!;
  const html = frameHtml({ artifactId: `demo-${ex.slug}`, version: 1, entry: build.entry, data: build.data, title: ex.title }, build, kitVersion);
  await writeFile(join(OUT, `${ex.slug}.html`), html);
  demos.push({
    slug: ex.slug,
    label: ex.label,
    title: ex.title,
    blurb: ex.blurb,
    entry,
    source: files[entry],
    html: highlight(files[entry]),
    data: Object.keys(files).filter((f) => f.startsWith("data/")),
    seed: ex.seed,
    ...(links[ex.slug] ? { link: links[ex.slug] } : {}),
  });
  console.log(`demo/${ex.slug}: ${entry}, frame ${(html.length / 1024).toFixed(1)} KB`);
}
await writeFile(join(ROOT, "src/worker/demos.json"), JSON.stringify(demos, null, 1) + "\n");

// Frames are sandboxed by their CSP (opaque origin, no network) like an
// artifact's, and only the apex may embed them. build-kit writes _headers;
// replace any /demo/* rule from an earlier run of this script. no-transform
// keeps Cloudflare's analytics beacon out, as for artifact frames.
const HEADERS = join(ROOT, "dist/kit/_headers");
const rules = (await readFile(HEADERS, "utf8")).replace(/^\/demo\/\*\n(?:[ \t].*\n)*/m, "");
await writeFile(
  HEADERS,
  rules +
    ["/demo/*", `  Content-Security-Policy: ${DEMO_FRAME_CSP}`, "  X-Content-Type-Options: nosniff", "  Referrer-Policy: no-referrer", "  X-Robots-Tag: noindex", "  Cache-Control: public, max-age=0, must-revalidate, no-transform", ""].join("\n"),
);

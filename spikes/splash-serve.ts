// Serves the splash page locally from the last build (`bun run build`), for trying the splash wisp without a
// deploy: the page itself from src/worker/pages.ts, its scripts, styles and example frames from dist/kit.
// Nothing else works here (no sign-in, no workspaces).
//
// Usage: bun spikes/splash-serve.ts [port]   then open http://localhost:4790/
import { splashPage } from "../src/worker/pages.ts";
import { PRODUCT } from "../src/shared/brand.ts";

const port = Number(process.argv[2] ?? 4790);
const brand = { name: PRODUCT, home: "/", apex: `http://localhost:${port}` };

Bun.serve({
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/") return splashPage(brand, undefined, undefined, true, true);
    for (const candidate of [`dist/kit${path}`, `dist/kit${path}.html`, `dist/kit${path}/index.html`]) {
      const file = Bun.file(candidate);
      if (!candidate.includes("..") && (await file.exists())) return new Response(file);
    }
    return new Response("Not found", { status: 404 });
  },
});
console.log(`splash at http://localhost:${port}/`);

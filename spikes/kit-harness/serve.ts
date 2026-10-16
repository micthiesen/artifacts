// Static server for the kit harness. Mimics production routing and headers:
//   /                  harness shell (index.html)
//   /frame/<name>.html sandboxed frame document with a CSP like the Worker's
//   /kit/v1/*          dist/kit/kit/v1/* with the headers from dist/kit/_headers
//   /harness/*         dist/kit-harness/*
// Usage: bun run build:kit && bun spikes/kit-harness/build.ts && bun spikes/kit-harness/serve.ts
import { join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const PORT = Number(process.env.PORT ?? 4380);

async function file(base: string, rel: string, headers: Record<string, string> = {}) {
  const path = normalize(join(base, rel));
  if (!path.startsWith(base)) return new Response("bad path", { status: 400 });
  const f = Bun.file(path);
  if (!(await f.exists())) return new Response("not found", { status: 404 });
  return new Response(f, { headers });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const p = decodeURIComponent(url.pathname);
    if (p === "/" || p === "/index.html") return file(import.meta.dir, "index.html", { "Cache-Control": "no-store" });
    if (p.startsWith("/kit/v1/"))
      return file(join(ROOT, "dist/kit/kit/v1"), p.slice("/kit/v1/".length), {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store", // production: public, max-age=31536000, immutable
        "X-Content-Type-Options": "nosniff",
      });
    if (p.startsWith("/frame/")) {
      const kit = `${url.origin}/kit/v1/`;
      const csp = [
        "sandbox allow-scripts",
        "default-src 'none'",
        `script-src 'unsafe-inline' data: ${kit}`,
        `style-src 'unsafe-inline' ${kit}`,
        `font-src ${kit}`,
        "img-src data: blob:",
        "connect-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
      ].join("; ");
      return file(join(ROOT, "dist/kit-harness/frames"), p.slice("/frame/".length), {
        "Content-Security-Policy": csp,
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
    }
    if (p.startsWith("/harness/")) return file(join(ROOT, "dist/kit-harness"), p.slice("/harness/".length), { "Cache-Control": "no-store" });
    return new Response("not found", { status: 404 });
  },
});
console.log(`kit harness: http://localhost:${server.port}/`);

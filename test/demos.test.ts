// The splash page's examples: the build output matches demo/, and the source
// highlighter's HTML is safe to put in the page.
import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { DEMO_FRAME_CSP, frameCsp } from "../src/worker/pages.ts";
import { highlight } from "../scripts/highlight.ts";
import { EXAMPLES } from "../demo/examples.ts";
import demos from "../src/worker/demos.json";

const unhighlight = (html: string) =>
  html.replace(/<\/?span[^>]*>/g, "").replace(/&(lt|gt|quot|#39|amp);/g, (_, e) => ({ lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" })[e as string]!);

test("highlighting only adds spans: the text round-trips and stays escaped", () => {
  const source = `import { x } from "y";\n// <script>alert(1)</script>\n<Poll id='a&b' options={["</code>"]} />\n# Title **bold**\nconst n = 42 > 1;`;
  const html = highlight(source);
  expect(unhighlight(html)).toBe(source);
  expect(html).not.toContain("<script");
  expect(html).not.toContain("</code>");
  expect(html.replace(/<\/?span[^>]*>/g, "")).not.toMatch(/[<>"']/);
  expect(html).toContain('<span class="t-k">import</span>');
  expect(html).toContain('<span class="t-t">&lt;Poll</span>');
  expect(html).toContain('<span class="t-a">id</span>');
  expect(html).toContain('<span class="t-h"># Title **bold**</span>');
});

test("src/worker/demos.json matches demo/ (run bun run build after changing an example)", async () => {
  const links = JSON.parse(await readFile("demo/links.json", "utf8").catch(() => "{}")) as Record<string, string>;
  expect(demos.map((d) => d.slug)).toEqual(EXAMPLES.map((e) => e.slug));
  for (const [i, d] of demos.entries()) {
    const ex = EXAMPLES[i];
    const files = (await readdir(`demo/${d.slug}`, { recursive: true })).filter((f) => /\.\w+$/.test(f)).sort();
    const entry = files.find((f) => ["index.mdx", "index.md", "app.tsx"].includes(f))!;
    const source = await readFile(`demo/${d.slug}/${entry}`, "utf8");
    expect(d as unknown).toEqual({
      slug: ex.slug,
      label: ex.label,
      title: ex.title,
      blurb: ex.blurb,
      entry,
      source,
      html: highlight(source),
      data: files.filter((f) => f.startsWith("data/")),
      seed: ex.seed,
      ...(links[ex.slug] ? { link: links[ex.slug] } : {}),
    });
  }
});

test("example frames get an artifact frame's sandbox and no network", () => {
  const directives = DEMO_FRAME_CSP.split("; ");
  expect(directives).toContain("sandbox allow-scripts allow-forms allow-modals allow-downloads");
  expect(directives).toContain("connect-src 'none'");
  expect(directives).toContain("frame-ancestors 'self'");
  expect(DEMO_FRAME_CSP).not.toContain("allow-same-origin");
  // Same directives as a real artifact frame, with 'self' for the kit's origin.
  const real = frameCsp("https://acme.test").replaceAll("https://acme.test/kit/v1/", "'self'").replace(" https://acme.test/asset/", "").replace(" https://acme.test/asset/", "");
  expect(DEMO_FRAME_CSP).toBe(real.replace("frame-ancestors https://acme.test", "frame-ancestors 'self'"));
});

test("seeded state only uses keys its own author may write", () => {
  for (const ex of EXAMPLES) {
    for (const e of ex.seed) {
      const poll = /^poll\/[^/]+\/(.+)$/.exec(e.key);
      if (poll) expect(poll[1]).toBe(e.by);
      const value = e.value as { by?: string } | null;
      if (value && typeof value === "object" && "by" in value) expect(value.by).toBe(e.by);
    }
  }
});

import { expect, test } from "bun:test";
import { buildArtifact, compileFile } from "../src/worker/compile.ts";

const files = new Set<string>(["app.tsx", "chart.tsx"]);

test("prose mentioning import/export is not treated as an import", async () => {
  const src = `import { Poll } from "@a/ui";
const notes = ["Import notes from Evernote", 'export "markdown" files'];
export default function App() { return <div>{notes.join(" ")}<Poll id="p" options={["a", "b"]} /></div>; }`;
  expect((await compileFile("app.tsx", src, files)).errors).toEqual([]);
  const mdx = `# Plan\n\nWe import "Notion" pages and export "PDF" files.\n\n<Checklist id="x" items={["Import data", "Export: \\"all\\""]} />\n`;
  expect((await compileFile("index.mdx", mdx, files)).errors).toEqual([]);
});

test("unused or type-only bad imports are still reported", async () => {
  const r = await compileFile("app.tsx", 'import x from "lodash";\nexport default () => <div />;', files);
  expect(r.errors[0]?.message).toContain('"lodash"');
  const dyn = await compileFile("app.tsx", 'export default () => { import("left-pad"); return null; };', files);
  expect(dyn.errors[0]?.message).toContain('"left-pad"');
});

test("relative imports resolve without extensions and are rewritten", async () => {
  const r = await buildArtifact({
    "app.tsx": 'import Chart from "./chart";\nexport default () => <Chart />;',
    "chart.tsx": 'export default () => <p className="text-primary">x</p>;',
  });
  expect(r.errors).toEqual([]);
  const app = atob(r.build!.imports["@art/app.tsx"].split(",")[1]);
  expect(app).toContain('"@art/chart.tsx"');
  expect(r.build!.css).toContain("text-primary");
});

test("missing relative import and entry rules", async () => {
  expect((await buildArtifact({ "app.tsx": 'import X from "./nope";\nexport default X;' })).errors[0].message).toContain("./nope");
  expect((await buildArtifact({ "x.tsx": "export default 1;" })).errors[0].message).toContain("no entry file");
  expect((await buildArtifact({ "app.tsx": "export default 1;", "index.mdx": "# x" })).errors[0].message).toContain("several entry files");
  expect((await buildArtifact({ "index.mdx": "# x", "data/a.json": "{bad" })).errors[0].path).toBe("data/a.json");
});

test("MDX supports GFM tables and frontmatter is stripped", async () => {
  const r = await compileFile("index.mdx", "---\ntitle: X\n---\n| a | b |\n|---|---|\n| 1 | 2 |\n", new Set());
  expect(r.errors).toEqual([]);
  expect(r.module!.code).toContain("table");
  expect(r.module!.code).not.toContain("title: X");
});

test("unknown kit names are rejected with suggestions", async () => {
  const tsx = await compileFile("app.tsx", 'import { Buton, Card } from "@a/ui";\nimport { useShared } from "@a/hooks";\nexport default () => <Card><Buton /></Card>;', new Set());
  expect(tsx.errors.map((e) => e.message)).toEqual(['"Buton" is not exported by @a/ui. Did you mean Button?']);
  const mdx = await compileFile("index.mdx", "# Hi\n\n<Pol id=\"x\" options={[\"a\"]} />\n\n<Poll id=\"y\" options={[\"a\"]} />\n", new Set());
  expect(mdx.errors.map((e) => e.message)).toEqual(["<Pol> is not a kit component. Did you mean Poll? See artifact_guide for the list."]);
  const local = await compileFile("index.mdx", "export const Hello = () => <b>hi</b>;\n\n<Hello />\n", new Set());
  expect(local.errors).toEqual([]);
  const icons = await compileFile("app.tsx", 'import { Check, NotAnIcon } from "lucide-react";\nexport default () => <Check />;', new Set());
  expect(icons.errors.length).toBe(1);
});

test("mermaid fences become <Diagram> and are syntax-checked at write time", async () => {
  const ok = await compileFile("index.mdx", "# Flow\n\n```mermaid\nflowchart LR\n  A[Write] --> B[Check]\n```\n", files);
  expect(ok.errors).toEqual([]);
  expect(ok.module!.code).toContain("Diagram");
  expect(ok.module!.blocks!.map((b) => b.id)).toEqual(["flow", "flow-1"]);
  const md = await compileFile("index.md", "```mermaid\nsequenceDiagram\n  A->>B: Hi\n```\n", files);
  expect(md.errors).toEqual([]);
  expect(md.module!.code).toContain("Diagram");

  const bad = await compileFile("index.mdx", "# Flow\n\n```mermaid\nflowchart LR\n  A[Write --> B\n```\n", files);
  expect(bad.errors).toHaveLength(1);
  expect(bad.errors[0].message).toStartWith("mermaid diagram (fence on line 3");
  expect(bad.errors[0].line).toBeGreaterThan(3);

  const pie = await compileFile("index.mdx", '```mermaid\npie title Share\n  "A" : 60\n  "B" : 40\n```\n', files);
  expect(pie.errors[0]?.message).toContain('<Chart type="pie">');
});

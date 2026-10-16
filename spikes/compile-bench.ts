// Spike 1: compile cost of a large data-heavy artifact and a typical MDX report.
import { compileFile, compileCss } from "../src/worker/compile.ts";

const rows = Array.from({ length: 400 }, (_, i) =>
  `  { name: "Option ${i}", price: "$${i}/user", selfHost: ${i % 2 === 0}, notes: "Lorem ipsum dolor sit amet consectetur ${i}" },`,
).join("\n");
const bigTsx = `import { Button, Badge, Input } from "@a/ui";
import { useState } from "react";
type Row = { name: string; price: string; selfHost: boolean; notes: string };
const DATA: Row[] = [
${rows}
];
export default function App() {
  const [q, setQ] = useState<string>("");
  return <div className="flex h-full flex-col gap-4 p-4 text-sm md:grid-cols-3">
    <Input value={q} onChange={(e) => setQ(e.target.value)} />
    {DATA.filter((r) => r.name.includes(q)).map((r) => <div key={r.name} className="rounded-lg border px-3 py-2 hover:bg-muted"><Badge>{r.price}</Badge> {r.notes}</div>)}
    <Button className="bg-primary text-primary-foreground">Go</Button>
  </div>;
}
`;
const mdx = `---
title: GitHub alternatives
---
<Summary>Forgejo wins for self-hosting; GitLab if CI matters most.</Summary>

## Shortlist
<Table data="repos.json" columns="name price selfHost ci" sort="price" />

## Decide
<Poll id="pick" options={["Forgejo", "GitLab", "Gitea"]} />
<Checklist id="next" items={["Trial Forgejo on Boris", "Price GitLab Premium"]} />
<Comments />
`;
console.log("bigTsx chars", bigTsx.length);
for (const [path, src] of [["app.tsx", bigTsx], ["index.mdx", mdx]] as const) {
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const r = await compileFile(path, src, new Set());
    console.log(path, `run${i}`, (performance.now() - t).toFixed(1), "ms", "errors", r.errors.length, "out", r.module?.code.length);
  }
}
const r = await compileFile("app.tsx", bigTsx, new Set());
for (let i = 0; i < 3; i++) {
  const t = performance.now();
  const css = await compileCss('@import "tailwindcss/theme.css" layer(theme);\n@import "tailwindcss/utilities.css" layer(utilities);', r.module!.classes);
  console.log("css", `run${i}`, (performance.now() - t).toFixed(1), "ms", css.length, "bytes", css.includes(".hover\\:bg-muted") ? "" : "", css.includes("flex-col"));
}
const bad = await compileFile("app.tsx", 'import x from "lodash";\nexport default () => <div>{</div>', new Set());
console.log("bad", JSON.stringify(bad.errors));
const bad2 = await compileFile("app.tsx", 'import x from "lodash";\nexport default () => <div/>', new Set());
console.log("bad import", JSON.stringify(bad2.errors));

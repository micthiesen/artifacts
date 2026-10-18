// Creates a large data-heavy artifact a few times to exercise compile CPU, in a
// throwaway workspace. Usage: bun spikes/cpu.ts (reads DOMAIN and OPERATOR_TOKEN from .env)
import { call, finish, setup } from "./e2e-lib.ts";

const rows = Array.from({ length: 400 }, (_, i) => `  { name: "Option ${i}", price: "$${i}/user", selfHost: ${i % 2 === 0}, notes: "Lorem ipsum dolor sit amet consectetur ${i}" },`).join("\n");
const app = `import { Button, Badge, Input } from "@a/ui";\nimport { useState } from "react";\nconst DATA = [\n${rows}\n];\nexport default function App() {\n  const [q, setQ] = useState("");\n  return <div className="flex h-full flex-col gap-4 p-4">{DATA.filter((r) => r.name.includes(q)).map((r) => <div key={r.name} className="rounded-lg border px-3 py-2 hover:bg-muted"><Badge>{r.price}</Badge> {r.notes}</div>)}<Input value={q} onChange={(e) => setQ(e.target.value)} /><Button>Go</Button></div>;\n}\n`;
await setup();
console.log("chars", app.length);
for (let i = 0; i < 5; i++) {
  const r = await call("artifact_create", { title: `cpu ${i}`, files: { "app.tsx": app } });
  console.log(i, r.ms, "ms", r.isError ? r.content[0].text : r.structuredContent.id);
}
await finish();

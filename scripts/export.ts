// Downloads one workspace (or, with "directory", the directory), page by page, to exports/.
// Usage: bun scripts/export.ts <slug|directory>
// Reads DOMAIN and OPERATOR_TOKEN from .env.
import { mkdir } from "node:fs/promises";
import { DATA_TABLES, DIRECTORY_TABLES } from "../src/worker/tables.ts";

const slug = process.argv[2];
if (!slug) throw new Error("usage: bun scripts/export.ts <slug>");
const api = `https://${process.env.DOMAIN}/api/admin/${slug === "directory" ? "directory" : `workspaces/${slug}`}`;
const headers = { Authorization: `Bearer ${process.env.OPERATOR_TOKEN}` };
const tables: Record<string, unknown[]> = {};
for (const table of slug === "directory" ? DIRECTORY_TABLES : DATA_TABLES) {
  tables[table] = [];
  let after = 0;
  for (;;) {
    const res = await fetch(`${api}/export?table=${table}&after=${after}`, { headers });
    if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
    const page = (await res.json()) as { rows: unknown[]; next: number | null };
    tables[table].push(...page.rows);
    if (page.next === null) break;
    after = page.next;
  }
}
await mkdir("exports", { recursive: true });
const file = `exports/${slug}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await Bun.write(file, JSON.stringify({ slug, exportedAt: new Date().toISOString(), tables }));
console.log(`wrote ${file} (${Object.entries(tables).map(([t, r]) => `${t} ${r.length}`).join(", ")})`);

// Replaces ALL of one workspace's (or the directory's) data with an export: a .json from scripts/export.ts,
// or the .jsonl download from Settings → Export your data (docs/EXPORT.md).
// Usage: bun scripts/import.ts <slug|directory> <export.json|.jsonl>. Reads DOMAIN and OPERATOR_TOKEN from .env.
import { DATA_TABLES, DIRECTORY_TABLES } from "../src/worker/tables.ts";

const [slug, file] = [process.argv[2], process.argv[3]];
if (!slug || !file) throw new Error("usage: bun scripts/import.ts <slug> <export.json|.jsonl>");
const tables = file.endsWith(".jsonl") ? await fromJsonl(file) : ((await Bun.file(file).json()) as { tables: Record<string, Record<string, unknown>[]> }).tables;

/** The settings download: a header line, then pages of {table, rows}, then {end}. Refuses a file that was cut off. */
async function fromJsonl(path: string): Promise<Record<string, Record<string, unknown>[]>> {
  const out: Record<string, Record<string, unknown>[]> = {};
  let ended = false;
  for (const line of (await Bun.file(path).text()).split("\n")) {
    if (!line.trim()) continue;
    const v = JSON.parse(line) as { format?: string; table?: string; rows?: Record<string, unknown>[]; end?: boolean };
    if (v.end) ended = true;
    else if (v.table && v.rows) (out[v.table] ??= []).push(...v.rows);
    else if (!v.format?.startsWith("artifacts.boo/export@")) throw new Error(`${path} isn't an artifacts.boo export`);
  }
  if (!ended) throw new Error(`${path} was cut off (no end line); download it again`);
  return out;
}
const api = `https://${process.env.DOMAIN}/api/admin/${slug === "directory" ? "directory" : `workspaces/${slug}`}/import`;
async function step(body: unknown) {
  const res = await fetch(api, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPERATOR_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  return res.json();
}
await step({ step: "begin" });
for (const table of slug === "directory" ? DIRECTORY_TABLES : DATA_TABLES) {
  const rows = tables[table] ?? [];
  // Requests stay well under the Worker's body limit.
  let batch: Record<string, unknown>[] = [];
  let size = 0;
  for (const row of rows) {
    const n = JSON.stringify(row).length;
    if (batch.length && size + n > 4_000_000) {
      await step({ step: "rows", table, rows: batch });
      batch = [];
      size = 0;
    }
    batch.push(row);
    size += n;
  }
  if (batch.length) await step({ step: "rows", table, rows: batch });
}
console.log(JSON.stringify(await step({ step: "end" })));

// Downloads a full export (GET /admin/export) to exports/. Usage: bun scripts/export.ts <origin>
import { mkdir } from "node:fs/promises";
const origin = (process.argv[2] ?? "").replace(/\/$/, "");
if (!origin) throw new Error("usage: bun scripts/export.ts <origin>");
const res = await fetch(`${origin}/admin/export`, { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` } });
if (!res.ok) throw new Error(`export failed: HTTP ${res.status} ${await res.text()}`);
await mkdir("exports", { recursive: true });
const file = `exports/artifacts-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await Bun.write(file, await res.text());
console.log(`wrote ${file}`);

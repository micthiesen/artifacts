// Replaces ALL data with an export. Usage: bun scripts/import.ts <origin> <export.json>
const [origin, file] = [process.argv[2]?.replace(/\/$/, ""), process.argv[3]];
if (!origin || !file) throw new Error("usage: bun scripts/import.ts <origin> <export.json>");
const res = await fetch(`${origin}/admin/import`, {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}`, "Content-Type": "application/json" },
  body: await Bun.file(file).text(),
});
console.log(res.status, await res.text());

// Publishes the splash page's examples (demo/) as public artifacts in a "demo"
// workspace, so anyone can open a real one. Safe to run again: it creates what's
// missing and replaces the files of what exists. Shared state (votes, comments)
// is written once, when an artifact is created, each entry by its own person;
// --reseed writes it again. Visitors of a public artifact can't change anything.
// Writes demo/links.json, which the next build puts on the splash page.
// Usage: bun scripts/seed-demo.ts [--reseed] [--stage <name>]
// Reads DOMAIN and OPERATOR_TOKEN from .env. With --stage it seeds that stage
// (<stage>.<domain>) and leaves demo/links.json alone.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { EXAMPLES, PEOPLE, seedValue } from "../demo/examples.ts";

const ROOT = resolve(import.meta.dir, "..");
const SLUG = "demo";
const domain = process.env.DOMAIN;
if (!domain || !process.env.OPERATOR_TOKEN) throw new Error("set DOMAIN and OPERATOR_TOKEN in .env");
const reseed = process.argv.includes("--reseed");
const stageAt = process.argv.indexOf("--stage");
const stage = stageAt > 0 ? process.argv[stageAt + 1] : undefined;
if (stageAt > 0 && !stage) throw new Error("--stage needs a name");
const apex = `https://${stage ? `${stage}.` : ""}${domain}`;
const host = stage ? `${SLUG}--${stage}.${domain}` : `${SLUG}.${domain}`;
const origin = `https://${host}`;
// Example people only (reserved domains are never emailed); the first is the admin and owner.
const [ADMIN] = PEOPLE;

async function operator(path: string, body?: unknown) {
  const res = await fetch(`${apex}/api/admin${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${process.env.OPERATOR_TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

/** A request to the workspace as a signed-in person (settings API). */
async function asPerson(cookie: string, path: string, method: string, body?: unknown) {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json() as Promise<any>;
}

async function tool(token: string, name: string, args: unknown) {
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${await res.text()}`);
  const { result } = (await res.json()) as any;
  if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text}`);
  return result;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

// ---- workspace and people -------------------------------------------------------
const workspaces = (await operator("/workspaces")).workspaces as { slug: string }[];
if (!workspaces.some((w) => w.slug === SLUG)) {
  await operator("/workspaces", { slug: SLUG, name: "Demo", admin: ADMIN });
  console.log(`created workspace ${origin}`);
  // Isolates that looked it up before cache it as missing for up to 30 s.
  for (let i = 0; i < 20 && (await fetch(`${origin}/healthz`)).status !== 200; i++) await Bun.sleep(2000);
}
const adminCookie = (await operator("/session", { email: ADMIN, host })).cookie as string;
for (const email of PEOPLE.slice(1)) await asPerson(adminCookie, "/api/settings/members", "POST", { email, role: "member" });

// Agent tokens, one per person, revoked when the script ends or is interrupted.
const tokens = new Map<string, { id: string; token: string }>();
async function revokeTokens() {
  for (const [email, { id }] of tokens) {
    await asPerson(adminCookie, `/api/settings/tokens/${id}`, "DELETE").catch((e) => console.error(`token for ${email} NOT revoked: ${e}`));
  }
  tokens.clear();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void revokeTokens().then(() => process.exit(130)));
for (const email of PEOPLE) tokens.set(email, await operator(`/workspaces/${SLUG}/tokens`, { email }));
const owner = tokens.get(ADMIN)!.token;

try {
  const listed = (await tool(owner, "artifact_list", {})).structuredContent.artifacts as { id: string; title: string }[];
  const links: Record<string, string> = {};
  for (const ex of EXAMPLES) {
    const dir = join(ROOT, "demo", ex.slug);
    const files: Record<string, string> = {};
    for (const file of await walk(dir)) files[relative(dir, file)] = await readFile(file, "utf8");
    const existing = listed.find((a) => a.title === ex.title);
    let id: string;
    let status = "created";
    if (existing) {
      id = existing.id;
      const read = (await tool(owner, "artifact_read", { id })).structuredContent as { files: { path: string }[] };
      const changes: Record<string, string | null> = {};
      for (const { path } of read.files) if (!(path in files)) changes[path] = null;
      for (const [path, text] of Object.entries(files)) {
        const current = read.files.some((f) => f.path === path) ? (await tool(owner, "artifact_read", { id, path })).structuredContent.content : null;
        if (current !== text) changes[path] = text;
      }
      if (Object.keys(changes).length) await tool(owner, "artifact_write_files", { id, files: changes, note: "Synced from demo/" });
      status = Object.keys(changes).length ? "updated" : "unchanged";
    } else {
      const made = await tool(owner, "artifact_create", {
        title: ex.title,
        description: ex.blurb,
        files,
        share: [{ email: "workspace", role: "edit" }],
        public: true,
      });
      id = made.structuredContent.id;
    }
    await tool(owner, "artifact_share", { id, public: true, notify: false });
    if (!existing || reseed) {
      const now = Date.now();
      for (const e of ex.seed) {
        await tool(tokens.get(e.by)!.token, "artifact_state", { id, set: { [e.key]: seedValue(e, now) } });
      }
    }
    links[ex.slug] = `${origin}/a/${id}`;
    console.log(`${ex.slug}: ${links[ex.slug]} (${status})`);
  }
  if (!stage) await writeFile(join(ROOT, "demo/links.json"), JSON.stringify(links, null, 1) + "\n");
} finally {
  await revokeTokens();
}

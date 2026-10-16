// End-to-end check against a deployed Worker.
// Usage: bun spikes/e2e.ts https://artifacts.<sub>.workers.dev
// Reads MCP_TOKEN, SESSION_SECRET and OWNER_EMAILS from .env (bun loads it).
import { signToken } from "../src/worker/session.ts";

const origin = (process.argv[2] ?? "").replace(/\/$/, "");
if (!origin) throw new Error("pass the Worker origin");
const MCP_TOKEN = process.env.MCP_TOKEN!;
const owner = process.env.OWNER_EMAILS!.split(",")[0].trim();

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || detail === undefined ? "" : ` -> ${JSON.stringify(detail).slice(0, 400)}`}`);
  if (!ok) failures++;
}

let rpcId = 0;
async function rpc(method: string, params?: unknown, token = MCP_TOKEN) {
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as any) : await res.text() };
}
async function call(name: string, args: unknown) {
  const t = performance.now();
  const r = await rpc("tools/call", { name, arguments: args });
  return { ...r.body.result, ms: Math.round(performance.now() - t) };
}

check("mcp rejects bad token", (await rpc("tools/list", undefined, "nope")).status === 401);
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
check("initialize", init.body.result?.serverInfo?.name === "shared-artifacts", init.body);
const list = await rpc("tools/list");
check("tools/list", list.body.result?.tools?.length >= 10, list.body.result?.tools?.map((t: any) => t.name));

const files = {
  "index.mdx": `---\ntitle: E2E\n---\n# E2E report\n\n<Summary>Forgejo wins.</Summary>\n\n<Table data="repos.json" columns="name price" />\n\n<Poll id="pick" options={["Forgejo", "GitLab"]} />\n`,
  "data/repos.json": JSON.stringify([{ name: "Forgejo", price: "$0" }, { name: "GitLab", price: "$29" }], null, 2),
};
const created = await call("artifact_create", { title: "E2E test", description: "e2e", files });
check("create", !created.isError, created);
console.log(`  create took ${created.ms} ms`);
const id = created.structuredContent?.id as string;

async function settled(r: any) {
  let check = r.structuredContent?.renderCheck;
  for (let i = 0; i < 8 && check?.status === "queued"; i++) {
    await Bun.sleep(6000);
    check = (await call("artifact_check", { id })).structuredContent?.renderCheck;
  }
  return check;
}
const createdCheck = await settled(created);
check("create ran a passing render check", createdCheck?.status === "ok", createdCheck);
const unknown = await call("artifact_write_files", { id, files: { "index.mdx": "# Hi\n\n<Pol id=\"x\" />\n" } });
check("unknown MDX component rejected", unknown.isError === true && /Did you mean Poll/.test(unknown.content[0].text), unknown.content);
const crash = await call("artifact_write_files", {
  id,
  files: { "index.mdx": null, "app.tsx": 'export default function App() { const x: any = null; return <div>{x.boom}</div>; }' },
});
const crashCheck = await settled(crash);
check("runtime crash reported by render check", crashCheck?.status === "errors" && /boom/.test(JSON.stringify(crashCheck)), crashCheck);
const errs = await call("artifact_errors", { id });
check("render-check errors recorded", /boom/.test(errs.content[0].text), errs.content);
const restore = await call("artifact_revert", { id, version: 1 });
const restoreCheck = await settled(restore);
check("revert restores a rendering version", restoreCheck?.status === "ok", restoreCheck);
const bad = await call("artifact_write_files", { id, files: { "extra.tsx": 'import _ from "lodash";\nexport default 1;' } });
check("bad import rejected atomically", bad.isError === true && /lodash/.test(bad.content[0].text), bad);
const syntax = await call("artifact_edit", { id, path: "index.mdx", edits: [{ oldText: "# E2E report", newText: "# E2E report <Broken" }] });
check("syntax error rejected with location", syntax.isError === true && /index\.mdx/.test(syntax.content[0].text), syntax.content);

const grep = await call("artifact_grep", { id, pattern: "Summary" });
check("grep", /index\.mdx:6/.test(grep.content[0].text), grep.content);
const edit = await call("artifact_edit", { id, path: "index.mdx", edits: [{ oldText: "Forgejo wins.", newText: "Forgejo wins for self-hosting." }], baseVersion: 3 });
check("edit", edit.structuredContent?.version === 4, edit);
const stale = await call("artifact_edit", { id, path: "index.mdx", edits: [{ oldText: "E2E", newText: "x", replaceAll: true }], baseVersion: 3 });
check("stale baseVersion rejected", stale.isError === true && /stale/.test(stale.content[0].text), stale.content);
const patch = await call("artifact_patch_data", { id, path: "data/repos.json", ops: [{ op: "replace", path: "/1/price", value: "$19" }] });
check("patch data", patch.structuredContent?.version === 5, patch);
const read = await call("artifact_read", { id, path: "data/repos.json" });
check("read reflects patch", read.content[0].text.includes("$19"), read.content);
const hist = await call("artifact_history", { id });
check("history", hist.structuredContent?.versions?.length === 5, hist.structuredContent);

// Viewer side, unauthenticated.
const anon = await fetch(`${origin}/a/${id}`, { redirect: "manual" });
check("private artifact hidden from anonymous", anon.status === 401 || anon.status === 302, anon.status);

// Owner session minted with the deploy secret (stands in for an Access login).
const session = await signToken(process.env.SESSION_SECRET!, "session", 600, { e: owner });
const cookie = `__Host-art_session=${session}`;
const shell = await fetch(`${origin}/a/${id}`, { headers: { Cookie: cookie } });
const shellHtml = await shell.text();
check("owner opens shell", shell.status === 200 && shellHtml.includes("shell-boot"), shell.status);
const frameUrl = JSON.parse(/<script type="application\/json" id="shell-boot">(.*?)<\/script>/s.exec(shellHtml)![1]).frameUrl;
const frame = await fetch(`${origin}${frameUrl}`);
const csp = frame.headers.get("Content-Security-Policy") ?? "";
const frameHtml = await frame.text();
check("frame served", frame.status === 200 && frameHtml.includes("importmap"), frame.status);
check("frame CSP sandboxes and blocks network", csp.startsWith("sandbox allow-scripts") && csp.includes("connect-src 'none'") && !csp.includes("allow-same-origin"), csp);
check("frame link needs token", (await fetch(`${origin}/frame/${id}`)).status === 403);
const kit = await fetch(`${origin}/kit/v1/runtime.js`);
check("kit served with CORS", kit.status === 200 && kit.headers.get("Access-Control-Allow-Origin") === "*", [kit.status, kit.headers.get("Access-Control-Allow-Origin")]);

// Sync: two sockets, owner writes, both see it; measure latency.
const wsUrl = `${origin.replace(/^http/, "ws")}/a/${id}/sync`;
function open(): Promise<{ ws: WebSocket; msgs: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie, Origin: origin } } as any);
    const msgs: any[] = [];
    ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)));
    ws.onopen = () => resolve({ ws, msgs });
    ws.onerror = (e) => reject(e);
  });
}
const a = await open();
const b = await open();
await Bun.sleep(300);
check("snapshot on connect", a.msgs.some((m) => m.t === "snapshot"), a.msgs);
const t0 = performance.now();
a.ws.send(JSON.stringify({ t: "set", key: `poll/pick/${owner}`, value: "Forgejo", cid: "c1" }));
let latency = -1;
for (let i = 0; i < 100; i++) {
  if (b.msgs.some((m) => m.t === "set" && m.key === `poll/pick/${owner}`)) {
    latency = performance.now() - t0;
    break;
  }
  await Bun.sleep(10);
}
check("second socket receives write", latency >= 0, b.msgs);
console.log(`  sync latency ${latency.toFixed(0)} ms`);
check("presence lists owner", b.msgs.some((m) => m.t === "presence" && m.viewers.includes(owner)), b.msgs);
a.ws.close();
b.ws.close();
const state = await call("artifact_state", { id });
check("agent reads shared state", state.structuredContent?.state?.[`poll/pick/${owner}`] === "Forgejo", state.structuredContent);

// Cross-origin socket must be refused (CSWSH).
const evilResult = await new Promise<string>((resolve) => {
  const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie, Origin: "https://evil.example" } } as any);
  ws.onopen = () => {
    ws.close();
    resolve("opened");
  };
  ws.onerror = () => resolve("refused");
  setTimeout(() => resolve("timeout"), 5000);
});
check("cross-origin sync refused", evilResult === "refused", evilResult);

// Sharing: public read-only, then revoke.
await call("artifact_share", { id, public: true });
check("public link opens anonymously", (await fetch(`${origin}/a/${id}`)).status === 200);
await call("artifact_share", { id, public: false });
check("public link revoked", (await fetch(`${origin}/a/${id}`, { redirect: "manual" })).status !== 200);
const stranger = await signToken(process.env.SESSION_SECRET!, "session", 600, { e: "stranger@example.com" });
check("unshared email refused", (await fetch(`${origin}/a/${id}`, { headers: { Cookie: `__Host-art_session=${stranger}` } })).status === 403);
await call("artifact_share", { id, add: [{ email: "stranger@example.com", role: "view" }] });
check("shared email allowed", (await fetch(`${origin}/a/${id}`, { headers: { Cookie: `__Host-art_session=${stranger}` } })).status === 200);
await call("artifact_share", { id, remove: ["stranger@example.com"] });
check("removed email refused immediately", (await fetch(`${origin}/a/${id}`, { headers: { Cookie: `__Host-art_session=${stranger}` } })).status === 403);

// Domain shares.
const asEmail = async (e: string) => `__Host-art_session=${await signToken(process.env.SESSION_SECRET!, "session", 600, { e })}`;
await call("artifact_share", { id, add: [{ email: "@example.org", role: "view" }] });
check("domain member can open", (await fetch(`${origin}/a/${id}`, { headers: { Cookie: await asEmail("anyone@example.org") } })).status === 200);
check("other domain refused", (await fetch(`${origin}/a/${id}`, { headers: { Cookie: await asEmail("anyone@example.net") } })).status === 403);
check("subdomain lookalike refused", (await fetch(`${origin}/a/${id}`, { headers: { Cookie: await asEmail("x@evil-example.org") } })).status === 403);
const domainLink = await call("artifact_link", { id, email: "pat@example.org" });
check("link allowed for domain member", !domainLink.isError, domainLink.content);
const badDomain = await call("artifact_share", { id, add: [{ email: "@localhost", role: "view" }] });
check("invalid domain rejected", badDomain.isError === true, badDomain.content);
await call("artifact_share", { id, remove: ["@example.org"] });
check("domain removal revokes", (await fetch(`${origin}/a/${id}`, { headers: { Cookie: await asEmail("anyone@example.org") } })).status === 403);

// Presigned sign-in links.
const ownerLink = await call("artifact_link", { id });
const linkUrl = ownerLink.structuredContent?.link as string;
check("owner link issued", typeof linkUrl === "string" && linkUrl.includes("/s/"), ownerLink.content);
const opened = await fetch(linkUrl, { redirect: "manual" });
const linkCookie = (opened.headers.get("Set-Cookie") ?? "").split(";")[0];
check("owner link signs in and redirects", opened.status === 303 && opened.headers.get("Location") === `/a/${id}` && linkCookie.startsWith("__Host-art_session="), opened.status);
check("owner link session opens private artifact", (await fetch(`${origin}/a/${id}`, { headers: { Cookie: linkCookie } })).status === 200);
const noAccess = await call("artifact_link", { id, email: "nobody@example.com" });
check("link refused for unshared email", noAccess.isError === true, noAccess.content);
const shared = await call("artifact_share", { id, add: [{ email: "guest@example.com", role: "view" }] });
const guestLink = shared.structuredContent?.links?.["guest@example.com"] as string;
check("share returns a link per added person", typeof guestLink === "string", shared.structuredContent);
await call("artifact_share", { id, remove: ["guest@example.com"] });
const revoked = await fetch(guestLink, { redirect: "manual" });
check("link stops working after unshare", revoked.status === 403, revoked.status);
// Flip a character inside the payload (the signature's last base64 char has spare bits).
const cut = linkUrl.indexOf("/s/") + 10;
const tamperedUrl = linkUrl.slice(0, cut) + (linkUrl[cut] === "A" ? "B" : "A") + linkUrl.slice(cut + 1);
const tampered = await fetch(tamperedUrl, { redirect: "manual" });
check("tampered link rejected", tampered.status === 400, tampered.status);

if (process.env.KEEP !== "1") {
  const del = await call("artifact_delete", { id });
  check("delete", !del.isError, del);
} else console.log(`kept ${origin}/a/${id}`);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);

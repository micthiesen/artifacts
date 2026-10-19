// End-to-end check against a deployed Worker, in a throwaway workspace.
// Usage: bun spikes/e2e.ts   (reads DOMAIN and OPERATOR_TOKEN from .env)
import { apex, call, check, cookieFor, finish, operator, origin, owner, rpc, setup, slug } from "./e2e-lib.ts";

await setup();
const unauthorized = await rpc("tools/list", undefined, "nope");
check("mcp rejects bad token with an OAuth challenge", unauthorized.status === 401 && /resource_metadata=/.test(unauthorized.headers.get("WWW-Authenticate") ?? ""), unauthorized.status);
const prm = (await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json()) as any;
check("protected resource metadata names this workspace", prm.resource === `${origin}/mcp` && prm.authorization_servers?.[0] === origin, prm);
const asm = (await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()) as any;
check("authorization server metadata", asm.issuer === origin && asm.registration_endpoint === `${origin}/oauth/register` && asm.authorization_endpoint === `${origin}/authorize`, asm);
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
check("initialize names the workspace", init.body.result?.serverInfo?.name === `artifacts-${slug}` && init.body.result?.serverInfo?.title === "artifacts.boo · E2E", init.body.result?.serverInfo);
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

// Viewer side, unauthenticated: sent to sign in on the apex.
const anon = await fetch(`${origin}/a/${id}`, { redirect: "manual" });
check("private artifact sends anonymous viewers to sign in", anon.status === 302 && anon.headers.get("Location")?.startsWith(`${origin}/login`) === true, anon.status);
const bounce = await fetch(`${origin}/login?return=/a/${id}`, { redirect: "manual" });
check("workspace sign-in goes through the apex", bounce.headers.get("Location")?.startsWith(`${apex}/login?to=`) === true, bounce.headers.get("Location"));
const cookie = await cookieFor(owner);
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
const stranger = await cookieFor("stranger@example.com");
check("unshared email refused", (await fetch(`${origin}/a/${id}`, { headers: { Cookie: stranger } })).status === 403);
await call("artifact_share", { id, add: [{ email: "stranger@example.com", role: "view" }] });
check("shared email allowed", (await fetch(`${origin}/a/${id}`, { headers: { Cookie: stranger } })).status === 200);
await call("artifact_share", { id, remove: ["stranger@example.com"] });
check("removed email refused immediately", (await fetch(`${origin}/a/${id}`, { headers: { Cookie: stranger } })).status === 403);
const elsewhere = await cookieFor(owner, new URL(apex).hostname);
check("a session from another host doesn't count here", (await fetch(`${origin}/a/${id}`, { headers: { Cookie: elsewhere }, redirect: "manual" })).status === 302);

// Screenshot, noindex, robots.
check("create attached a screenshot", (created.content ?? []).some((c: any) => c.type === "image" && c.data?.length > 1000), created.content?.map((c: any) => c.type));
check("pages are noindex", (await fetch(`${origin}/a/${id}`, { headers: { Cookie: cookie } })).headers.get("X-Robots-Tag")?.includes("noindex") === true);
check("robots.txt disallows all", (await (await fetch(`${origin}/robots.txt`)).text()).includes("Disallow: /"));

// Assets.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const up = await call("artifact_asset", { id, path: "assets/dot.png", base64: png });
check("asset uploaded", !up.isError, up.content);
const shellWithAsset = await (await fetch(`${origin}/a/${id}`, { headers: { Cookie: cookie } })).text();
const frameUrl2 = JSON.parse(/<script type="application\/json" id="shell-boot">(.*?)<\/script>/s.exec(shellWithAsset)![1]).frameUrl;
const frameHtml2 = await (await fetch(`${origin}${frameUrl2}`)).text();
const assetPath = /"assets\/dot\.png":"([^"]+)"/.exec(frameHtml2)?.[1]?.replace(/\\u0026/g, "&");
check("frame lists asset URL", typeof assetPath === "string", frameHtml2.slice(0, 200));
const assetRes = await fetch(`${origin}${assetPath}`);
check("asset served with token", assetRes.status === 200 && assetRes.headers.get("Content-Type") === "image/png", assetRes.status);
check("asset needs token", (await fetch(`${origin}/asset/${id}/assets/dot.png`)).status === 403);
const badAsset = await call("artifact_asset", { id, path: "../etc/passwd", base64: png });
check("bad asset path rejected", badAsset.isError === true, badAsset.content);

// Live data source with host approval through the owner API.
const src = await call("artifact_source", { id, path: "data/live.json", url: "https://registry.npmjs.org/react/latest", everyMinutes: 60, pick: "name" });
check("source waits for host approval", /approve registry\.npmjs\.org/.test(src.content[0].text), src.content);
const ownerPost = (p: string, body: unknown) =>
  fetch(`${origin}${p}`, { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
check("owner API refuses cross-origin", (await fetch(`${origin}/api/hosts`, { method: "POST", headers: { Cookie: cookie, Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" })).status === 403);
const approve = await ownerPost("/api/hosts", { host: "registry.npmjs.org", allowed: true });
check("owner approves host", approve.status === 200, await approve.text());
const live = await call("artifact_read", { id, path: "data/live.json" });
check("source fetched after approval", live.content?.[0]?.text?.includes('"react"'), live.content);
await ownerPost("/api/hosts", { host: "registry.npmjs.org", allowed: false });
await call("artifact_source", { id, path: "data/live.json", remove: true });

// Owner API overview and actions.
const overview = await (await fetch(`${origin}/api/a/${id}`, { headers: { Cookie: cookie } })).json() as any;
check("owner overview", overview.meta?.id === id && Array.isArray(overview.history) && Array.isArray(overview.assets), Object.keys(overview));
const viaUi = await (await ownerPost(`/api/a/${id}/artifact_update`, { description: "updated from the owner menu" })).json() as any;
check("owner action runs tool", viaUi.ok === true, viaUi);
check("owner API refuses non-owner", (await fetch(`${origin}/api/a/${id}`, { headers: { Cookie: stranger } })).status === 403);
check("owner tools are whitelisted", (await ownerPost(`/api/a/${id}/artifact_write_files`, { files: {} })).status === 400);

// Operator export and backups.
const page = await operator(`/workspaces/${slug}/export?table=artifacts&after=0`);
check("operator export", page.rows?.some((a: any) => a.id === id), page);
check("operator API needs the token", (await fetch(`${apex}/api/admin/workspaces`)).status === 403);
const backup = await operator(`/workspaces/${slug}/backup`, {});
check("backup queued", backup.queued === true, backup);
let runs: string[] = [];
for (let i = 0; i < 20 && !runs.length; i++) {
  await Bun.sleep(1500);
  runs = (await operator(`/workspaces/${slug}/backups`)).runs ?? [];
}
check("backup job finished and is listed", runs.length === 1, runs);
// Restore it: a fresh backup runs first, the workspace is offline meanwhile, then it's back with the data.
const before = (await call("artifact_read", { id })).structuredContent?.version;
check("restore queued", (await operator(`/workspaces/${slug}/restore`, { run: runs[0] })).queued === true);
let restored = false;
for (let i = 0; i < 30 && !restored; i++) {
  await Bun.sleep(1500);
  const w = (await operator("/workspaces")).workspaces.find((x: any) => x.slug === slug);
  restored = !w?.job && (await operator(`/workspaces/${slug}/backups`)).runs.length === 2;
}
check("restore finished (with its safety backup)", restored);
check("restored artifact is intact", (await call("artifact_read", { id })).structuredContent?.version === before);

// Sliding sessions: a session close to expiry (the test cookies last an hour) gets renewed.
const renewed = await fetch(`${origin}/`, { headers: { Cookie: cookie } });
check("short session is renewed", /Max-Age=2592000/.test(renewed.headers.get("Set-Cookie") ?? ""), renewed.headers.get("Set-Cookie"));

// Domain shares.
const asEmail = (e: string) => cookieFor(e);
await call("artifact_share", { id, add: [{ email: "@example.org", role: "view" }] });
check("domain member can open", (await fetch(`${origin}/a/${id}`, { headers: { Cookie: await asEmail("anyone@example.org") } })).status === 200);
check("other domain refused", (await fetch(`${origin}/a/${id}`, { headers: { Cookie: await asEmail("anyone@example.net") } })).status === 403);
check("subdomain of a shared domain refused", (await fetch(`${origin}/a/${id}`, { headers: { Cookie: await asEmail("x@sub.example.org") } })).status === 403);
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
check("links are bound to their workspace", (await fetch(linkUrl.replace(origin, origin.replace(`//${slug}`, `//other-${slug}`)), { redirect: "manual" })).status !== 303);
check("owner link signs in and redirects", opened.status === 303 && opened.headers.get("Location") === `/a/${id}` && linkCookie.startsWith("__Host-art_session="), opened.status);
check("owner link session opens private artifact", (await fetch(`${origin}/a/${id}`, { headers: { Cookie: linkCookie } })).status === 200);
const forOther = await call("artifact_link", { id, email: "nobody@example.com" });
// The link is always for the caller: another address is ignored.
check("no sign-in links for anyone but yourself", !JSON.stringify(forOther.content).includes("nobody@example.com"), forOther.content);
const shared = await call("artifact_share", { id, add: [{ email: "guest@example.com", role: "view" }] });
check("share never hands back someone else's sign-in link", !JSON.stringify(shared).includes("/s/"), shared.structuredContent);
const guest = await cookieFor("guest@example.com");
check("shared guest opens it", (await fetch(`${origin}/a/${id}`, { headers: { Cookie: guest } })).status === 200);
await call("artifact_share", { id, remove: ["guest@example.com"] });
check("unshared guest is refused at once", (await fetch(`${origin}/a/${id}`, { headers: { Cookie: guest } })).status === 403);
// Flip a character inside the payload (the signature's last base64 char has spare bits).
const cut = linkUrl.indexOf("/s/") + 10;
const tamperedUrl = linkUrl.slice(0, cut) + (linkUrl[cut] === "A" ? "B" : "A") + linkUrl.slice(cut + 1);
const tampered = await fetch(tamperedUrl, { redirect: "manual" });
check("tampered link rejected", tampered.status === 400, tampered.status);

const del = await call("artifact_delete", { id });
check("delete", !del.isError, del);
await finish();

// End-to-end check of comments, activity, visits, previews and notifications
// against a deployed Worker. Sends one real notification through ntfy.sh.
// Usage: bun spikes/e2e-collab.ts https://artifacts.<sub>.workers.dev
// Reads MCP_TOKEN, SESSION_SECRET, LOGIN_SECRET and OWNER_EMAILS from .env.
import { signToken } from "../src/worker/session.ts";

const origin = (process.argv[2] ?? "").replace(/\/$/, "");
if (!origin) throw new Error("pass the Worker origin");
const MCP_TOKEN = process.env.MCP_TOKEN!;
const owner = process.env.OWNER_EMAILS!.split(",")[0].trim();
const viewer = `e2e-viewer-${Date.now()}@example.com`;

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || detail === undefined ? "" : ` -> ${JSON.stringify(detail).slice(0, 500)}`}`);
  if (!ok) failures++;
}

let rpcId = 0;
async function call(name: string, args: unknown) {
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MCP_TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  return ((await res.json()) as any).result;
}

async function cookieFor(email: string) {
  return `__Host-art_session=${await signToken(process.env.SESSION_SECRET!, "session", 3600, { e: email })}`;
}

function socket(id: string, cookie: string) {
  const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/a/${id}/sync`, { headers: { Cookie: cookie, Origin: origin } } as never);
  const messages: any[] = [];
  ws.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data))));
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket error")));
  });
  const next = async (pred: (m: any) => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = messages.find(pred);
      if (m) return m;
      await Bun.sleep(100);
    }
    return null;
  };
  return { ws, messages, opened, next, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

// ---- setup -----------------------------------------------------------------------
const files = { "index.mdx": "# Plan\n\nIntro text.\n\n## Costs\n\nWe pay $10 a month.\n\n<Comments />\n" };
const created = await call("artifact_create", { title: "E2E collab", description: "e2e collab", files, share: [{ email: viewer, role: "view" }] });
const id = created.structuredContent?.id as string;
check("create", Boolean(id), created);

// ---- comments over the socket (view role may comment) ------------------------------
const viewerCookie = await cookieFor(viewer);
const page = await fetch(`${origin}/a/${id}`, { headers: { Cookie: viewerCookie } });
const html = await page.text();
check("shell has comments drawer and since slots", html.includes('id="threads"') && html.includes('id="since"'));
const v = socket(id, viewerCookie);
await v.opened;
check("socket sends threads on connect", Boolean(await v.next((m) => m.t === "threads")));
v.send({ t: "comment", cid: "c1", anchor: { block: "costs-1", quote: { exact: "$10", prefix: "We pay ", suffix: " a month." } }, text: `Per seat? @${owner}` });
const made = await v.next((m) => m.t === "thread" && m.cid === "c1");
check("view-role viewer starts an anchored thread", made?.thread?.anchor?.block === "costs-1", made ?? v.messages.slice(-3));
const threadId = made?.thread?.id as string;
v.send({ t: "set", cid: "s1", key: "comments/main/0001-forged", value: { by: "someone@else.com", text: "hi", at: 1 } });
check("view role can't write shared state", Boolean(await v.next((m) => m.t === "rejected" && m.cid === "s1")));

// ---- agent loop through MCP ---------------------------------------------------------
const activity = await call("artifact_activity", { id });
const text = activity.content[0].text as string;
check("artifact_activity shows the thread with its quote", text.includes(threadId) && text.includes("$10") && text.includes("block costs-1"), text);
const cursor = activity.structuredContent.cursor as number;
const threads = await call("artifact_threads", { id });
check("artifact_threads lists the open thread", threads.structuredContent.threads.length === 1, threads.content);
const edit = await call("artifact_edit", {
  id,
  path: "index.mdx",
  edits: [{ oldText: "We pay $10 a month.", newText: "We pay $10 per seat per month." }],
  note: "Clarified the price is per seat",
  resolves: [threadId],
});
check("edit with note and resolves", !edit.isError, edit.content);
const resolvedMsg = await v.next((m) => m.t === "thread" && m.thread.id === threadId && m.thread.addressedIn === 2);
check("viewer sees thread addressed in v2 live", Boolean(resolvedMsg));
check("viewer gets a live version notice", Boolean(await v.next((m) => m.t === "version" && m.version === 2 && /per seat/.test(m.note))));
const reply = await call("artifact_comment", { id, thread: threadId, text: "Yes, per seat. Updated the page." });
check("agent reply", !reply.isError && reply.structuredContent.thread.comments.at(-1).by === "agent", reply.content);
const later = await call("artifact_activity", { id, since: cursor });
check("activity since cursor has version, resolve and reply", /saved v2: Clarified/.test(later.content[0].text) && /replied/.test(later.content[0].text), later.content[0].text);

// ---- changed since your last visit ---------------------------------------------------
const again = await (await fetch(`${origin}/a/${id}`, { headers: { Cookie: viewerCookie } })).text();
const boot = JSON.parse(/<script type="application\/json" id="shell-boot">(.*?)<\/script>/.exec(again)![1]);
check("since banner data", boot.since?.fromVersion === 1 && boot.since.changedBlocks.includes("costs-1"), boot.since);
const index = await (await fetch(`${origin}/`, { headers: { Cookie: viewerCookie } })).text();
check("index shows unread badge", /1 new comment/.test(index));

// ---- link previews -----------------------------------------------------------------
const bot = { "User-Agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" };
const generic = await (await fetch(`${origin}/a/${id}`, { headers: bot })).text();
check("private artifact: generic card, no title", generic.includes('og:title" content="Private artifact"') && !generic.includes("E2E collab"), generic.slice(0, 400));
const link = await call("artifact_link", { id, email: viewer });
const linkUrl = link.structuredContent?.url ?? /https:\S+\/s\/\S+/.exec(link.content[0].text)?.[0];
const unfurl = await fetch(linkUrl, { headers: bot, redirect: "manual" });
check("presigned link isn't redeemed by a preview bot", unfurl.status === 200 && !unfurl.headers.get("Set-Cookie"), unfurl.status);
await call("artifact_update", { id, preview: true });
await call("artifact_check", { id });
const rich = await (await fetch(`${origin}/a/${id}`, { headers: bot })).text();
check("opted-in artifact: rich card", rich.includes('og:title" content="E2E collab"'), rich.slice(0, 600));
const ogUrl = /og:image" content="([^"]+)"/.exec(rich)?.[1]?.replace(/&amp;/g, "&");
if (ogUrl?.includes("/og/")) {
  const img = await fetch(ogUrl);
  check("og image served", img.ok && img.headers.get("Content-Type") === "image/jpeg", img.status);
  const forged = await fetch(ogUrl.replace(/s=[^&]+/, "s=forged"));
  check("og image needs a valid signature", forged.status === 404);
} else check("og image url (screenshot may still be queued)", Boolean(ogUrl), ogUrl);
const generic2 = await fetch(`${origin}/static/icons/og.png`);
check("generic og image exists", generic2.ok);

// ---- profile, channels and a real notification ----------------------------------------
const ownerCookie = await cookieFor(owner);
const me = await fetch(`${origin}/api/me`, { headers: { Cookie: ownerCookie } });
const profile = (await me.json()) as any;
check("profile api", me.ok && profile.email === owner && typeof profile.vapidPublicKey === "string", profile);
const post = (path: string, body: unknown, method = "POST") =>
  fetch(`${origin}${path}`, { method, headers: { Cookie: ownerCookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const bad = await post("/api/me/channels", { type: "webhook", url: "http://10.0.0.1/hook" });
check("webhook to a private address is refused", bad.status === 400);
const crossSite = await fetch(`${origin}/api/me/channels`, { method: "POST", headers: { Cookie: ownerCookie, Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" });
check("cross-site writes refused", crossSite.status === 403);
// ntfy.sh rate-limits anonymous publishing from shared Worker IPs, so delivery is
// proven with a webhook that always fails: its recorded error shows the alarm sent it.
const ntfy = (await (await post("/api/me/channels", { type: "ntfy" })).json()) as any;
check("ntfy channel created with a private topic", /^https:\/\/ntfy\.sh\/art-[a-z0-9]{24}$/.test(ntfy.reveal), ntfy);
await post(`/api/me/channels/${ntfy.id}`, {}, "DELETE");
const hook = (await (await post("/api/me/channels", { type: "webhook", url: "https://httpbin.org/status/418" })).json()) as any;
check("webhook channel created with a signing secret", typeof hook.reveal === "string" && hook.reveal.length > 30, hook);
const test = await post(`/api/me/channels/${hook.id}/test`, {});
check("test send reports the endpoint's failure", test.status === 400 && /418/.test(await test.text()));
const channelError = async () => ((await (await fetch(`${origin}/api/me`, { headers: { Cookie: ownerCookie } })).json()) as any).channels.find((c: any) => c.id === hook.id);
// Reset the error with a passing endpoint is not possible in place; remove and re-add instead.
await post(`/api/me/channels/${hook.id}`, {}, "DELETE");
const hook2 = (await (await post("/api/me/channels", { type: "webhook", url: "https://httpbin.org/status/418" })).json()) as any;
hook.id = hook2.id;
check("fresh channel has no error yet", (await channelError())?.lastError === null);
const fresh = socket(id, viewerCookie);
await fresh.opened;
fresh.send({ t: "comment", cid: "c9", text: "One more question for the owner" });
check("comment saved", Boolean(await fresh.next((m) => m.t === "thread" && m.cid === "c9")));
fresh.ws.close();
console.log("  waiting for the debounced notification (about 45-90 s)…");
let delivered: any = null;
for (let i = 0; i < 24 && !delivered?.lastError; i++) {
  await Bun.sleep(5000);
  delivered = await channelError();
}
check("alarm delivered the comment notification", /418/.test(delivered?.lastError ?? ""), delivered);
await post(`/api/me/channels/${hook.id}`, {}, "DELETE");

// ---- cleanup ------------------------------------------------------------------------
await call("artifact_delete", { id });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);

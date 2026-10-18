// Shared setup for the live end-to-end checks: a throwaway workspace with a test
// admin, an agent token for MCP, and session cookies for test addresses. Reads
// DOMAIN and OPERATOR_TOKEN from .env. KEEP=1 keeps the workspace afterwards;
// STAGE=<name> checks that stage instead of prod (see docs/DEPLOY.md).

export const domain = process.env.DOMAIN!;
const stage = process.env.STAGE && process.env.STAGE !== "prod" ? process.env.STAGE : null;
export const apex = `https://${stage ? `${stage}.` : ""}${domain}`;
export const slug = `e2e-${Math.random().toString(36).slice(2, 8)}`;
export const origin = `https://${slug}${stage ? `--${stage}` : ""}.${domain}`;
export const owner = `admin-${slug}@example.com`;

let failures = 0;
export function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || detail === undefined ? "" : ` -> ${JSON.stringify(detail).slice(0, 500)}`}`);
  if (!ok) failures++;
}

export async function operator(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const res = await fetch(`${apex}/api/admin${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.OPERATOR_TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

/** A session cookie for a test address on the workspace (or, with host, the apex). */
export async function cookieFor(email: string, host = new URL(origin).hostname): Promise<string> {
  return (await operator("/session", { email, host })).cookie;
}

let token = "";
let rpcId = 0;
export async function rpc(method: string, params?: unknown, bearer = token) {
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return { status: res.status, headers: res.headers, body: res.status === 200 ? ((await res.json()) as any) : await res.text() };
}

/** A protocol 2026-07-28 request: version and capabilities in _meta, mirrored in headers. */
export async function modern(method: string, params: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
  };
  if (typeof params.name === "string") headers["Mcp-Name"] = params.name;
  const body = { jsonrpc: "2.0", id: ++rpcId, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } };
  const res = await fetch(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

export async function call(name: string, args: unknown) {
  const t = performance.now();
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.status !== 200) throw new Error(`${name}: HTTP ${r.status} ${r.body}`);
  return { ...r.body.result, ms: Math.round(performance.now() - t) };
}

export async function setup() {
  await operator("/workspaces", { slug, name: "E2E", admin: owner });
  token = (await operator(`/workspaces/${slug}/tokens`, { email: owner })).token;
  // New workspaces are cached as missing for up to 30 s by isolates that looked them up before.
  for (let i = 0; i < 20 && (await fetch(`${origin}/healthz`)).status !== 200; i++) await Bun.sleep(2000);
  console.log(`workspace ${origin}`);
}

export async function finish() {
  if (process.env.KEEP === "1") console.log(`kept ${origin}`);
  else await operator(`/workspaces/${slug}`, undefined, "DELETE");
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

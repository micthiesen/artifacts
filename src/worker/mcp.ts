// Stateless MCP server (Streamable HTTP, JSON responses only). Every tool acts
// as the owner; the bearer token is the only credential.
import type { ArtifactHub, HubApi } from "./hub.ts";
import { domainOf, isValidPrincipal, sharePrincipal } from "./principal.ts";
import { describeCheck, type RenderCheck } from "./check.ts";
import { signToken } from "./session.ts";
import type { Env } from "./index.ts";
import guideIntro from "../../docs/guide.md";
import catalog from "../kit/CATALOG.md";

export const SERVER_NAME = "shared-artifacts";
const SERVER_TITLE = "Shared Artifacts";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Shared Artifacts publishes small interactive pages (reports, dashboards, polls, checklists, mini apps) that verified people can open in a browser, with per-viewer browser storage and live shared state. Use these artifact_* tools, not Executor's built-in create-artifact, whenever you make an artifact. Call artifact_guide once before writing your first artifact in a session. Change existing artifacts with artifact_edit, artifact_patch_data or artifact_write_files; never recreate one to change it. Every write reports a render check; fix a failed one (or wait for a queued one with artifact_check) before giving the user a link. Hand the user an artifact_link URL (it opens with no login).`;

type Hub = HubApi;
type Ctx = { hub: Hub; origin: string; env: Env };
type Json = Record<string, unknown>;

type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  run: (args: Json, ctx: Ctx) => Promise<ToolResult>;
};

type ToolResult = { text: string; structured?: unknown; isError?: boolean };

const id = { type: "string", description: "Artifact id, e.g. from artifact_list or artifact_create." };
const baseVersion = {
  type: "integer",
  description: "Optional: the version you last read. The write is rejected if the artifact changed since.",
};
const filesMap = {
  type: "object",
  additionalProperties: { type: "string" },
  description:
    'Files keyed by path. Exactly one entry: "index.mdx" (Markdown + components, best for reports), "index.md", or "app.tsx" (default-exported React component). Optional extra .tsx/.ts modules and data/*.json files.',
};
const shareList = {
  type: "array",
  items: {
    type: "object",
    properties: {
      email: {
        type: "string",
        description: 'A person ("sam@example.com"), or "@example.com" for everyone with a verified email at that domain.',
      },
      role: { type: "string", enum: ["view", "edit"], description: "edit may change shared state; view is read-only." },
    },
    required: ["email", "role"],
    additionalProperties: false,
  },
};

const url = (origin: string, artifactId: string) => `${origin}/a/${artifactId}`;

const LINK_DEFAULT_DAYS = 7;
const LINK_MAX_DAYS = 30;

function ownerList(env: Env): string[] {
  return (env.OWNER_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

/** Presigned sign-in link: opens the artifact as `email`, within that email's access. */
async function signInLink(ctx: Ctx, artifactId: string, email: string, days = LINK_DEFAULT_DAYS): Promise<string> {
  const ttl = Math.round(Math.min(Math.max(days, 1 / 24), LINK_MAX_DAYS) * 86400);
  const code = await signToken(ctx.env.LOGIN_SECRET, "link", ttl, { e: email.toLowerCase(), a: artifactId });
  return `${ctx.origin}/s/${code}`;
}

async function writeResult(r: Awaited<ReturnType<ArtifactHub["create"]>>, ctx: Ctx): Promise<ToolResult> {
  const { origin } = ctx;
  if (!r.ok) {
    const lines = r.errors.map((e) => `- ${e.path ? `${e.path}${"line" in e && e.line ? `:${e.line}` : ""}: ` : ""}${e.message}`);
    return {
      isError: true,
      text: `Nothing was saved${r.version ? ` (artifact still at v${r.version})` : ""}.\n${lines.join("\n")}`,
      structured: r,
    };
  }
  const check = await checkAndRecord(ctx, r.id, r.version);
  const out = { ...r, url: url(origin, r.id), renderCheck: check };
  return {
    text: `Saved ${r.id} v${r.version}: ${out.url}\nFiles: ${r.files.join(", ")}\n${describeCheck(check)}`,
    structured: out,
  };
}

async function checkAndRecord(ctx: Ctx, id: string, _version: number, force = false): Promise<RenderCheck> {
  const { version: _v, ...check } = await ctx.hub.runRenderCheck(id, ctx.origin, force);
  return check as RenderCheck;
}

export const TOOLS: Tool[] = [
  {
    name: "artifact_guide",
    title: "Shared Artifacts: authoring guide",
    description:
      "Shared Artifacts: returns the authoring guide and the component and hook reference. Read it once before writing your first artifact.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async () => ({ text: `${guideIntro}\n\n${catalog}` }),
  },
  {
    name: "artifact_list",
    title: "Shared Artifacts: list",
    description: "Shared Artifacts: list artifacts (id, title, description, version, url), newest first. Optional text filter.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Case-insensitive filter on title and description." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args, { hub, origin }) => {
      const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
      const rows = (await hub.list({ email: null, owner: true }))
        .filter((a) => !q || `${a.title} ${a.description}`.toLowerCase().includes(q))
        .map((a) => ({ id: a.id, title: a.title, description: a.description, version: a.version, public: a.public, updatedAt: a.updatedAt, url: url(origin, a.id) }));
      return {
        text: rows.length ? rows.map((a) => `${a.id} v${a.version} ${a.title}${a.description ? `: ${a.description}` : ""}`).join("\n") : "No artifacts.",
        structured: { artifacts: rows },
      };
    },
  },
  {
    name: "artifact_create",
    title: "Shared Artifacts: create",
    description:
      "Shared Artifacts: create a new artifact from files and return its URL. Validates and compiles everything; nothing is saved if any file fails. Optionally share it in the same call. To change an existing artifact use artifact_edit instead.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short human-readable title." },
        description: { type: "string", description: "One sentence on what it shows; used to find it later." },
        files: filesMap,
        share: { ...shareList, description: "People to share with now." },
        public: { type: "boolean", description: "Anyone with the link can view (read-only). Default false." },
      },
      required: ["title", "files"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const { hub } = ctx;
      const r = await hub.create({
        title: String(args.title),
        description: typeof args.description === "string" ? args.description : "",
        files: args.files as Record<string, string>,
      });
      if (r.ok && (Array.isArray(args.share) || typeof args.public === "boolean")) {
        await hub.share(r.id, { add: (args.share as never) ?? [], public: args.public as boolean | undefined });
      }
      return writeResult(r, ctx);
    },
  },
  {
    name: "artifact_read",
    title: "Shared Artifacts: read",
    description:
      "Shared Artifacts: without path, returns the artifact's version, file list with sizes, sharing and URL. With path, returns that file's text (optionally a 1-based line range). Read only what you need to edit.",
    inputSchema: {
      type: "object",
      properties: {
        id,
        path: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args, { hub, origin }) => {
      const artifactId = String(args.id);
      const meta = await hub.meta(artifactId);
      if (!meta) return { isError: true, text: `No artifact ${artifactId}; see artifact_list.` };
      if (typeof args.path !== "string") {
        const info = { ...meta, url: url(origin, artifactId) };
        const files = meta.files.map((f) => `  ${f.path} (${f.bytes} bytes)`).join("\n");
        const shares = meta.shares.length ? meta.shares.map((s) => `${s.email} (${s.role})`).join(", ") : "nobody";
        return {
          text: `${meta.title} — ${info.url}\nversion ${meta.version}, public ${meta.public}, shared with ${shares}\nfiles:\n${files}`,
          structured: info,
        };
      }
      const files = await hub.files(artifactId);
      const content = files[args.path];
      if (content === undefined) return { isError: true, text: `No file ${args.path}. Files: ${Object.keys(files).join(", ")}` };
      const lines = content.split("\n");
      const start = typeof args.startLine === "number" ? args.startLine : 1;
      const end = Math.min(typeof args.endLine === "number" ? args.endLine : lines.length, lines.length);
      const body = lines.slice(start - 1, end).join("\n");
      return {
        text: `${args.path} at v${meta.version}, lines ${start}-${end} of ${lines.length}:\n${body}`,
        structured: { path: args.path, version: meta.version, startLine: start, endLine: end, totalLines: lines.length, content: body },
      };
    },
  },
  {
    name: "artifact_grep",
    title: "Shared Artifacts: grep",
    description:
      "Shared Artifacts: search an artifact's files (regex, case-insensitive) and return matching lines with line numbers. Use it to find exact text for artifact_edit without reading whole files.",
    inputSchema: {
      type: "object",
      properties: { id, pattern: { type: "string" }, path: { type: "string", description: "Limit to one file." } },
      required: ["id", "pattern"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args, { hub }) => {
      const matches = await hub.grep(String(args.id), String(args.pattern), args.path as string | undefined);
      return {
        text: matches.length ? matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") : "No matches.",
        structured: { matches },
      };
    },
  },
  {
    name: "artifact_edit",
    title: "Shared Artifacts: edit file",
    description:
      "Shared Artifacts: change one file with exact find-and-replace edits, applied in order. Each oldText must match exactly once (whitespace included) unless replaceAll is set. All-or-nothing: if an edit misses or the result fails to compile, nothing is saved and the errors are returned. Prefer this for small code or text changes.",
    inputSchema: {
      type: "object",
      properties: {
        id,
        path: { type: "string" },
        edits: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: { oldText: { type: "string" }, newText: { type: "string" }, replaceAll: { type: "boolean" } },
            required: ["oldText", "newText"],
            additionalProperties: false,
          },
        },
        baseVersion,
      },
      required: ["id", "path", "edits"],
      additionalProperties: false,
    },
    run: async (args, ctx) =>
      writeResult(
        await ctx.hub.editText(String(args.id), String(args.path), args.edits as never, args.baseVersion as number | undefined),
        ctx,
      ),
  },
  {
    name: "artifact_patch_data",
    title: "Shared Artifacts: patch data file",
    description:
      'Shared Artifacts: change a data/*.json file with RFC 6902 JSON Patch operations, e.g. [{"op":"replace","path":"/2/price","value":"$4"}, {"op":"add","path":"/-","value":{...}}]. Cheapest way to update rows or values. All-or-nothing.',
    inputSchema: {
      type: "object",
      properties: {
        id,
        path: { type: "string", description: 'e.g. "data/rows.json"' },
        ops: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["add", "remove", "replace", "move", "copy", "test"] },
              path: { type: "string" },
              from: { type: "string" },
              value: {},
            },
            required: ["op", "path"],
          },
        },
        baseVersion,
      },
      required: ["id", "path", "ops"],
      additionalProperties: false,
    },
    run: async (args, ctx) =>
      writeResult(
        await ctx.hub.patchData(String(args.id), String(args.path), args.ops as never, args.baseVersion as number | undefined),
        ctx,
      ),
  },
  {
    name: "artifact_write_files",
    title: "Shared Artifacts: write files",
    description:
      "Shared Artifacts: add, fully replace, or delete (null) whole files in one atomic change. Use for new files or rewrites; use artifact_edit for small changes to existing files.",
    inputSchema: {
      type: "object",
      properties: {
        id,
        files: { type: "object", additionalProperties: { type: ["string", "null"] }, description: "Path -> new content, or null to delete." },
        baseVersion,
      },
      required: ["id", "files"],
      additionalProperties: false,
    },
    run: async (args, ctx) =>
      writeResult(
        await ctx.hub.writeFiles(String(args.id), args.files as Record<string, string | null>, args.baseVersion as number | undefined),
        ctx,
      ),
  },
  {
    name: "artifact_update",
    title: "Shared Artifacts: rename",
    description: "Shared Artifacts: change an artifact's title or description.",
    inputSchema: {
      type: "object",
      properties: { id, title: { type: "string" }, description: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    run: async (args, { hub }) => {
      const meta = await hub.updateMeta(String(args.id), {
        title: args.title as string | undefined,
        description: args.description as string | undefined,
      });
      return { text: `Updated ${meta.id}: ${meta.title}`, structured: meta };
    },
  },
  {
    name: "artifact_share",
    title: "Shared Artifacts: share",
    description:
      "Shared Artifacts: share an artifact with people by email, or with everyone at a domain (\"@example.com\"), change roles, remove entries, or toggle a public read-only link. A person's own entry overrides their domain's role. Removal takes effect immediately. Returns the current sharing and a sign-in link for each person added (domains get none; make one per person with artifact_link).",
    inputSchema: {
      type: "object",
      properties: {
        id,
        add: { ...shareList, description: "Add people or change their role." },
        remove: { type: "array", items: { type: "string" }, description: 'Emails or "@domain" entries to remove.' },
        public: { type: "boolean", description: "true: anyone with the link can view read-only. false: only shared people." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const { hub, origin } = ctx;
      for (const entry of [...((args.add as { email: string }[] | undefined) ?? []).map((a) => a.email), ...((args.remove as string[] | undefined) ?? [])]) {
        if (!isValidPrincipal(sharePrincipal(entry))) {
          return { isError: true, text: `"${entry}" is not an email address or @domain.` };
        }
      }
      const meta = await hub.share(String(args.id), {
        add: args.add as never,
        remove: args.remove as string[] | undefined,
        public: args.public as boolean | undefined,
      });
      if (!meta) return { isError: true, text: `No artifact ${args.id}` };
      const shares = meta.shares.length ? meta.shares.map((s) => `${s.email} (${s.role})`).join(", ") : "nobody";
      // Links go to people; a domain share has no single person to sign in as.
      const added = ((args.add as { email: string }[] | undefined) ?? [])
        .map((a) => sharePrincipal(a.email))
        .filter((p) => !p.startsWith("@"));
      const links: Record<string, string> = {};
      for (const email of added) links[email] = await signInLink(ctx, meta.id, email);
      const linkText = added.length
        ? `\nSign-in links (valid ${LINK_DEFAULT_DAYS} days; each signs in as that person, so send it only to them):\n${added.map((e) => `- ${e}: ${links[e]}`).join("\n")}`
        : "";
      return {
        text: `${url(origin, meta.id)}\nShared with: ${shares}. Public link: ${meta.public ? "on" : "off"}.${linkText}`,
        structured: { url: url(origin, meta.id), shares: meta.shares, public: meta.public, links },
      };
    },
  },
  {
    name: "artifact_link",
    title: "Shared Artifacts: sign-in link",
    description:
      "Shared Artifacts: make a presigned link that opens an artifact already signed in as one email, with no login step. Defaults to the owner (the user), so use it when handing the user a link. The email must be the owner, shared directly, or at a shared @domain. Valid 7 days by default (max 30); unsharing still revokes it. Anyone holding the link acts as that email, so give each link only to its person.",
    inputSchema: {
      type: "object",
      properties: {
        id,
        email: { type: "string", description: "Who the link signs in as. Default: the owner." },
        days: { type: "number", minimum: 0.05, maximum: 30, description: "Validity in days. Default 7." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const artifactId = String(args.id);
      const owners = ownerList(ctx.env);
      const email = (typeof args.email === "string" && args.email.trim() ? args.email : owners[0] ?? "").trim().toLowerCase();
      if (!email) return { isError: true, text: "No owner email is configured; pass email." };
      const meta = await ctx.hub.meta(artifactId);
      if (!meta) return { isError: true, text: `No artifact ${artifactId}; see artifact_list.` };
      if (!owners.includes(email) && !meta.shares.some((s) => s.email === email || s.email === domainOf(email))) {
        return { isError: true, text: `${email} has no access to ${artifactId}. Share it first with artifact_share.` };
      }
      const days = typeof args.days === "number" ? args.days : LINK_DEFAULT_DAYS;
      const link = await signInLink(ctx, artifactId, email, days);
      return { text: `Sign-in link for ${email} (valid ${days} days):\n${link}`, structured: { email, link, days } };
    },
  },
  {
    name: "artifact_state",
    title: "Shared Artifacts: shared state",
    description:
      "Shared Artifacts: read an artifact's live shared state (poll votes, checklist items, comments, useShared keys), and optionally set keys (null deletes). Viewers see changes immediately.",
    inputSchema: {
      type: "object",
      properties: {
        id,
        set: { type: "object", additionalProperties: {}, description: "Keys to set; null deletes a key." },
        prefix: { type: "string", description: "Only return keys starting with this prefix." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    run: async (args, { hub }) => {
      const artifactId = String(args.id);
      if (args.set && typeof args.set === "object") await hub.setState(artifactId, args.set as never, null);
      const state = await hub.state(artifactId);
      const prefix = typeof args.prefix === "string" ? args.prefix : "";
      const filtered = Object.fromEntries(Object.entries(state).filter(([k]) => k.startsWith(prefix)));
      return { text: JSON.stringify(filtered, null, 1), structured: { state: filtered } };
    },
  },
  {
    name: "artifact_errors",
    title: "Shared Artifacts: runtime errors",
    description:
      "Shared Artifacts: recent runtime errors reported by viewers' browsers (newest first). Check after a change if someone reports a problem.",
    inputSchema: { type: "object", properties: { id }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async (args, { hub }) => {
      const errors = await hub.errors(String(args.id));
      return {
        text: errors.length ? errors.map((e) => `${e.at} v${e.version}: ${e.message}`).join("\n") : "No runtime errors reported.",
        structured: { errors },
      };
    },
  },
  {
    name: "artifact_history",
    title: "Shared Artifacts: history",
    description: "Shared Artifacts: list stored versions (newest first, last 50) with what changed.",
    inputSchema: { type: "object", properties: { id }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async (args, { hub }) => {
      const versions = await hub.history(String(args.id));
      return { text: versions.map((v) => `v${v.version} ${v.createdAt} ${v.note}`).join("\n"), structured: { versions } };
    },
  },
  {
    name: "artifact_revert",
    title: "Shared Artifacts: revert",
    description: "Shared Artifacts: restore the files of an earlier version as a new version. Shared state is not changed.",
    inputSchema: {
      type: "object",
      properties: { id, version: { type: "integer", minimum: 1 } },
      required: ["id", "version"],
      additionalProperties: false,
    },
    run: async (args, ctx) => writeResult(await ctx.hub.revert(String(args.id), Number(args.version)), ctx),
  },
  {
    name: "artifact_check",
    title: "Shared Artifacts: render check",
    description:
      "Shared Artifacts: render the current version in a headless browser and report runtime errors. Writes already run this automatically; use it to re-check or after a skipped check.",
    inputSchema: { type: "object", properties: { id }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async (args, ctx) => {
      const meta = await ctx.hub.meta(String(args.id));
      if (!meta) return { isError: true, text: `No artifact ${args.id}; see artifact_list.` };
      const check = await checkAndRecord(ctx, meta.id, meta.version);
      // A stored "done" result for this version is returned as is.
      return { text: `v${meta.version}: ${describeCheck(check)}`, structured: { version: meta.version, renderCheck: check }, isError: check.status === "errors" };
    },
  },
  {
    name: "artifact_delete",
    title: "Shared Artifacts: delete",
    description: "Shared Artifacts: permanently delete an artifact, its history and its shared state.",
    inputSchema: { type: "object", properties: { id }, required: ["id"], additionalProperties: false },
    annotations: { destructiveHint: true },
    run: async (args, { hub }) => {
      await hub.delete(String(args.id));
      return { text: `Deleted ${args.id}.` };
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

type RpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Json };

export async function handleMcp(request: Request, hub: Hub, origin: string, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Use POST for MCP requests.", { status: 405, headers: { Allow: "POST" } });
  }
  let body: RpcRequest | RpcRequest[];
  try {
    body = await request.json();
  } catch {
    return rpcResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const batch = Array.isArray(body) ? body : [body];
  const responses = (await Promise.all(batch.map((msg) => handleMessage(msg, { hub, origin, env })))).filter(Boolean);
  if (responses.length === 0) return new Response(null, { status: 202 });
  return rpcResponse(Array.isArray(body) ? responses : responses[0]);
}

function rpcResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
}

async function handleMessage(msg: RpcRequest, ctx: Ctx): Promise<Json | null> {
  const isNotification = msg.id === undefined;
  const reply = (result: unknown) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, error: { code, message } });
  switch (msg.method) {
    case "initialize": {
      const requested = String(msg.params?.protocolVersion ?? "");
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
      });
    case "tools/call": {
      const tool = TOOL_MAP.get(String(msg.params?.name));
      if (!tool) return fail(-32602, `Unknown tool ${msg.params?.name}`);
      try {
        const r = await tool.run((msg.params?.arguments as Json) ?? {}, ctx);
        return reply({
          content: [{ type: "text", text: r.text }],
          ...(r.structured !== undefined ? { structuredContent: r.structured } : {}),
          isError: r.isError ?? false,
        });
      } catch (err) {
        return reply({ content: [{ type: "text", text: (err as Error).message }], isError: true });
      }
    }
    default:
      if (isNotification) return null;
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

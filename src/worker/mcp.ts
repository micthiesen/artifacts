// Stateless MCP server (Streamable HTTP, JSON responses only). An agent acts as
// the workspace member whose OAuth grant or agent token it presented, with that
// person's access to each artifact.
import { PRODUCT } from "../shared/brand.ts";
import type { HubApi, SourceInfo, Workspace } from "./hub.ts";
import type { Thread } from "../shared/protocol.ts";
import { isValidPrincipal, sharePrincipal } from "./principal.ts";
import { describeCheck, type RenderCheck } from "./check.ts";
import { signToken } from "./session.ts";
import { sendShare } from "./mail.ts";
import type { DirectoryApi } from "./directory.ts";
import { publicMessage } from "./errors.ts";
import type { Env } from "./index.ts";
import guideIntro from "../../docs/guide.md";
import catalog from "../kit/CATALOG.md";

export const SERVER_NAME = "artifacts";
const SERVER_TITLE = PRODUCT;
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `This server publishes small interactive pages (reports, dashboards, polls, checklists, mini apps) that verified people can open in a browser, with per-viewer browser storage and live shared state. Use these artifact_* tools, not Executor's built-in create-artifact, whenever you make an artifact. Call artifact_guide once before writing your first artifact in a session. Change existing artifacts with artifact_edit, artifact_patch_data or artifact_write_files; never recreate one to change it. Every write reports a render check; fix a failed one (or wait for a queued one with artifact_check) before giving the user a link. Hand the user an artifact_link URL (it opens with no login). Readers can comment; use artifact_activity to pick up their feedback and pass note and resolves on the edit that addresses it.`;

type Hub = HubApi;
export type Ctx = {
  hub: Hub;
  origin: string;
  env: Env;
  /** Workspace slug, bound into presigned links. */
  slug: string;
  /** Workspace display name (for messages and the server's title). */
  workspace?: string;
  /** The person is a workspace admin (so list covers every artifact). */
  admin?: boolean;
  /** The person acting: the agent's member, or the signed-in owner in the owner menu. */
  person: string;
  /** How writes are attributed: "agent" for MCP, the person's email for the owner menu. */
  actor: string;
};
type Role = "view" | "edit" | "owner";
type Json = Record<string, unknown>;

type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  /** Role the person needs on args.id. Omitted for tools without an artifact. A function picks it from the arguments. */
  need?: Role | ((args: Json, ctx: Ctx) => Role | null);
  run: (args: Json, ctx: Ctx) => Promise<ToolResult>;
};

type ToolResult = { text: string; structured?: unknown; isError?: boolean; images?: string[] };

const id = { type: "string", description: "Artifact id, e.g. from artifact_list or artifact_create." };
const baseVersion = {
  type: "integer",
  description: "Optional: the version you last read. The write is rejected if the artifact changed since.",
};
const changeProps = {
  note: {
    type: "string",
    description:
      'One short line for readers on what changed and why, e.g. "Tightened the cost section after Dana\'s question". Shown in history, in the "changed since your last visit" banner and in update notifications.',
  },
  resolves: {
    type: "array",
    items: { type: "string" },
    description: "Comment thread ids (from artifact_activity or artifact_threads) this change addresses. They are resolved and marked \"Addressed in vN\", and their authors are notified.",
  },
};
function changeOptions(args: Json, ctx: Ctx) {
  return {
    note: typeof args.note === "string" ? args.note.trim().slice(0, 200) : undefined,
    resolves: Array.isArray(args.resolves) ? args.resolves.map(String) : undefined,
    actor: ctx.actor,
    onBehalf: ctx.actor === "agent" ? ctx.person : undefined,
    origin: ctx.origin,
  };
}
const filesMap = {
  type: "object",
  additionalProperties: { type: "string" },
  description:
    'Files keyed by path. Exactly one entry: "index.mdx" (Markdown + components, best for reports), "index.md", or "app.tsx" (default-exported React component). Optional extra .tsx/.ts modules and data/*.json files.',
};
const publicDays = { type: "integer", minimum: 0, maximum: 365, description: "Public link expires after this many days (turns it on); 0 removes the expiry. Omitted: an existing expiry is kept." };

/** public_days as the hub's expiry time: undefined when not given, an error message when invalid. */
function publicUntil(args: Json): { until?: string | null; error?: string } {
  if (args.public_days === undefined) return {};
  const days = args.public_days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > 365) return { error: "public_days must be a whole number from 0 (no expiry) to 365." };
  if (args.public === false) return { error: "public_days needs the public link on; omit public or set it to true." };
  return { until: days === 0 ? null : new Date(Date.now() + days * 86_400_000).toISOString() };
}

/** "on", "on until 2026-11-17" or "off". */
function publicLine(meta: { public: boolean; publicUntil: string | null }): string {
  return meta.public ? (meta.publicUntil ? `on until ${meta.publicUntil.slice(0, 10)}` : "on") : "off";
}

const shareList = {
  type: "array",
  items: {
    type: "object",
    properties: {
      email: {
        type: "string",
        description:
          'A person ("sam@example.com"), "@example.com" for everyone with a verified email at that domain, or "workspace" for every member of this workspace.',
      },
      role: { type: "string", enum: ["view", "edit"], description: "edit may change shared state; view is read-only." },
    },
    required: ["email", "role"],
    additionalProperties: false,
  },
};

const url = (origin: string, artifactId: string) => `${origin}/a/${artifactId}`;

const ASSET_MAX_BYTES = 1.5 * 1024 * 1024;

const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  avif: "image/avif", ico: "image/x-icon", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", pdf: "application/pdf",
  csv: "text/csv", txt: "text/plain",
};
function guessType(path: string): string {
  return TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

const LINK_DEFAULT_DAYS = 7;
const LINK_MAX_DAYS = 30;

function directoryOf(ctx: Ctx): DirectoryApi {
  return (ctx.env.DIRECTORY as unknown as { getByName(n: string): DirectoryApi }).getByName("directory");
}

/**
 * Email people newly shared on an artifact. Someone who has never signed in
 * gets a presigned link (no sign-in step); anyone else gets the page and
 * signs in as themselves. The link only ever goes into that person's inbox:
 * it's never returned to whoever shared, so nobody can act as someone else.
 */
async function announceShares(ctx: Ctx, id: string, title: string, emails: string[], notify: boolean): Promise<Record<string, "link" | "page" | "not emailed">> {
  const out: Record<string, "link" | "page" | "not emailed"> = {};
  for (const email of emails) {
    if (!notify || !ctx.env.EMAIL || !(await ctx.hub.allowMail(1, ctx.person))) {
      out[email] = "not emailed";
      continue;
    }
    const fresh = !(await directoryOf(ctx).hasSignedIn(email));
    try {
      await sendShare(ctx.env, email, { title, workspace: ctx.workspace ?? ctx.slug, link: fresh ? await signInLink(ctx, id, email) : url(ctx.origin, id), by: ctx.person });
      out[email] = fresh ? "link" : "page";
    } catch (err) {
      console.error("share email failed", err);
      out[email] = "not emailed";
    }
  }
  return out;
}

/** Presigned sign-in link: opens the artifact as `email`, within that email's access. */
async function signInLink(ctx: Ctx, artifactId: string, email: string, days = LINK_DEFAULT_DAYS): Promise<string> {
  const ttl = Math.round(Math.min(Math.max(days, 1 / 24), LINK_MAX_DAYS) * 86400);
  const code = await signToken(ctx.env.LOGIN_SECRET, "link", ttl, { e: email.toLowerCase(), a: artifactId, w: ctx.slug });
  return `${ctx.origin}/s/${code}`;
}

async function writeResult(r: Awaited<ReturnType<Workspace["create"]>>, ctx: Ctx, withScreenshot = false): Promise<ToolResult> {
  const { origin } = ctx;
  if (!r.ok) {
    const lines = r.errors.map((e) => `- ${e.path ? `${e.path}${"line" in e && e.line ? `:${e.line}` : ""}: ` : ""}${e.message}`);
    return {
      isError: true,
      text: `Nothing was saved${r.version ? ` (artifact still at v${r.version})` : ""}.\n${lines.join("\n")}`,
      structured: r,
    };
  }
  const { check, screenshot } = await checkAndRecord(ctx, r.id);
  const out = { ...r, url: url(origin, r.id), renderCheck: check };
  const shot = withScreenshot && screenshot;
  return {
    text: `Saved ${r.id} v${r.version}: ${out.url}\nFiles: ${r.files.join(", ")}\n${describeCheck(check)}${
      shot ? "\nScreenshot of the first screen (1024×768) attached." : screenshot ? "\nartifact_check returns a screenshot." : ""
    }`,
    structured: out,
    images: shot ? [screenshot] : undefined,
  };
}

async function checkAndRecord(ctx: Ctx, id: string, force = false): Promise<{ check: RenderCheck; screenshot?: string }> {
  const { check, screenshot } = await ctx.hub.runRenderCheck(id, ctx.origin, force);
  return { check, screenshot };
}

export const TOOLS: Tool[] = [
  {
    name: "artifact_guide",
    title: "artifacts.boo: authoring guide",
    description:
      "artifacts.boo: returns the authoring guide and the component and hook reference. Read it once before writing your first artifact.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async () => ({ text: `${guideIntro}\n\n${catalog}` }),
  },
  {
    name: "artifact_list",
    title: "artifacts.boo: list",
    description:
      "artifacts.boo: list the artifacts the user this agent acts for can see in this workspace (theirs, ones shared with them or the workspace, and for an admin every artifact), newest first, with their role and owner. Optional text filter. Archived artifacts are left out unless archived is true.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive filter on title and description." },
        archived: { type: "boolean", description: "true: list only archived artifacts. Default: only active ones." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args, { hub, origin, person }) => {
      const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
      const archived = args.archived === true;
      const all = await hub.list(person);
      const rows = all
        .filter((a) => Boolean(a.archivedAt) === archived)
        .filter((a) => !q || `${a.title} ${a.description}`.toLowerCase().includes(q))
        .map((a) => ({
          id: a.id,
          title: a.title,
          description: a.description,
          version: a.version,
          public: a.public,
          role: a.role,
          owner: a.owner,
          updatedAt: a.updatedAt,
          archivedAt: a.archivedAt,
          url: url(origin, a.id),
        }));
      const hidden = archived ? 0 : all.filter((a) => a.archivedAt).length;
      const lines = rows.map(
        (a) =>
          `${a.id} v${a.version} ${a.title}${a.description ? `: ${a.description}` : ""} [${a.owner === person ? "yours" : `${a.role}, owner ${a.owner}`}]${a.archivedAt ? ` (archived ${a.archivedAt.slice(0, 10)})` : ""}`,
      );
      if (hidden) lines.push(`(${hidden} archived not shown; pass archived: true to list them.)`);
      return {
        text: rows.length ? lines.join("\n") : archived ? "No archived artifacts." : ["No artifacts.", ...lines].join("\n"),
        structured: { artifacts: rows },
      };
    },
  },
  {
    name: "artifact_create",
    title: "artifacts.boo: create",
    description:
      "artifacts.boo: create a new artifact from files and return its URL. Validates and compiles everything; nothing is saved if any file fails. Optionally share it in the same call. To change an existing artifact use artifact_edit instead.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short human-readable title." },
        description: { type: "string", description: "One sentence on what it shows; used to find it later." },
        files: filesMap,
        share: { ...shareList, description: "People to share with now." },
        public: { type: "boolean", description: "Anyone with the link can view (read-only). Default false." },
        public_days: publicDays,
      },
      required: ["title", "files"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const { hub } = ctx;
      for (const a of (Array.isArray(args.share) ? args.share : []) as { email?: unknown; role?: unknown }[]) {
        if (!a || typeof a.email !== "string" || !isValidPrincipal(sharePrincipal(a.email))) return { isError: true, text: `"${a?.email}" is not an email address, @domain or workspace.` };
        if (a.role !== "view" && a.role !== "edit") return { isError: true, text: `role must be view or edit, not ${String(a.role)}.` };
      }
      const expiry = publicUntil(args);
      if (expiry.error) return { isError: true, text: expiry.error };
      const r = await hub.create({
        title: String(args.title),
        description: typeof args.description === "string" ? args.description : "",
        files: args.files as Record<string, string>,
        owner: ctx.person,
        actor: ctx.actor,
      });
      if (r.ok && (Array.isArray(args.share) || typeof args.public === "boolean" || expiry.until)) {
        const add = ((args.share as { email: string; role: string }[] | undefined) ?? []).filter((a) => a && typeof a.email === "string");
        await hub.share(r.id, { add: add as never, public: args.public as boolean | undefined, publicUntil: expiry.until });
        const people = add.map((a) => sharePrincipal(a.email)).filter((p) => p.includes("@") && !p.startsWith("@") && p !== ctx.person);
        if (people.length) await announceShares(ctx, r.id, String(args.title), people, true);
      }
      return writeResult(r, ctx, true);
    },
  },
  {
    name: "artifact_read",
    title: "artifacts.boo: read",
    description:
      "artifacts.boo: without path, returns the artifact's version, file list with sizes, sharing and URL. With path, returns that file's text (optionally a 1-based line range). Read only what you need to edit.",
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
    need: "view",
    run: async (args, { hub, origin }) => {
      const artifactId = String(args.id);
      const meta = await hub.meta(artifactId);
      if (!meta) return { isError: true, text: `No artifact ${artifactId}; see artifact_list.` };
      if (typeof args.path !== "string") {
        const [assets, sources] = await Promise.all([hub.assets(artifactId), hub.sources(artifactId)]);
        const info = { ...meta, url: url(origin, artifactId), assets, sources };
        const files = [
          ...meta.files.map((f) => `  ${f.path} (${f.bytes} bytes)`),
          ...assets.map((a) => `  ${a.path} (${a.bytes} bytes, ${a.contentType})`),
          ...sources.map((s) => `  source: ${s.path} ← ${s.url}${s.approved ? "" : ` (host ${s.host} not approved yet)`}`),
        ].join("\n");
        const shares = meta.shares.length ? meta.shares.map((s) => `${s.email} (${s.role})`).join(", ") : "nobody";
        return {
          text: `${meta.title} — ${info.url}\nversion ${meta.version}, public link ${publicLine(meta)}, shared with ${shares}\nfiles:\n${files}`,
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
    title: "artifacts.boo: grep",
    description:
      "artifacts.boo: search an artifact's files (regex, case-insensitive) and return matching lines with line numbers. Use it to find exact text for artifact_edit without reading whole files.",
    inputSchema: {
      type: "object",
      properties: { id, pattern: { type: "string" }, path: { type: "string", description: "Limit to one file." } },
      required: ["id", "pattern"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    need: "view",
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
    title: "artifacts.boo: edit file",
    description:
      "artifacts.boo: change one file with exact find-and-replace edits, applied in order. Each oldText must match exactly once (whitespace included) unless replaceAll is set. All-or-nothing: if an edit misses or the result fails to compile, nothing is saved and the errors are returned. Prefer this for small code or text changes.",
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
        ...changeProps,
      },
      required: ["id", "path", "edits"],
      additionalProperties: false,
    },
    need: "owner",
    run: async (args, ctx) =>
      writeResult(
        await ctx.hub.editText(String(args.id), String(args.path), args.edits as never, args.baseVersion as number | undefined, changeOptions(args, ctx)),
        ctx,
      ),
  },
  {
    name: "artifact_patch_data",
    title: "artifacts.boo: patch data file",
    description:
      'artifacts.boo: change a data/*.json file with RFC 6902 JSON Patch operations, e.g. [{"op":"replace","path":"/2/price","value":"$4"}, {"op":"add","path":"/-","value":{...}}]. Cheapest way to update rows or values. All-or-nothing.',
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
        ...changeProps,
      },
      required: ["id", "path", "ops"],
      additionalProperties: false,
    },
    need: "owner",
    run: async (args, ctx) =>
      writeResult(
        await ctx.hub.patchData(String(args.id), String(args.path), args.ops as never, args.baseVersion as number | undefined, changeOptions(args, ctx)),
        ctx,
      ),
  },
  {
    name: "artifact_write_files",
    title: "artifacts.boo: write files",
    description:
      "artifacts.boo: add, fully replace, or delete (null) whole files in one atomic change. Use for new files or rewrites; use artifact_edit for small changes to existing files.",
    inputSchema: {
      type: "object",
      properties: {
        id,
        files: { type: "object", additionalProperties: { type: ["string", "null"] }, description: "Path -> new content, or null to delete." },
        baseVersion,
        ...changeProps,
      },
      required: ["id", "files"],
      additionalProperties: false,
    },
    need: "owner",
    run: async (args, ctx) =>
      writeResult(
        await ctx.hub.writeFiles(
          String(args.id),
          args.files as Record<string, string | null>,
          args.baseVersion as number | undefined,
          changeOptions(args, ctx),
        ),
        ctx,
      ),
  },
  {
    name: "artifact_update",
    title: "artifacts.boo: update details or archive",
    description:
      "artifacts.boo: change an artifact's title or description, archive or unarchive it, or turn rich link previews on or off. Archiving hides an artifact the user is done with from everyone's list; it stays readable at its link with its history and can be unarchived. Prefer archiving over artifact_delete unless the user explicitly asks to delete. With preview on, links pasted into Slack, iMessage and similar apps show the title, description and a screenshot; off (the default for private artifacts), they show a generic card.",
    inputSchema: {
      type: "object",
      properties: {
        id,
        title: { type: "string" },
        description: { type: "string" },
        archived: { type: "boolean", description: "true archives, false unarchives." },
        preview: { type: "boolean" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    need: "owner",
    run: async (args, { hub }) => {
      for (const k of ["archived", "preview"]) {
        if (args[k] !== undefined && typeof args[k] !== "boolean") return { isError: true, text: `${k} must be true or false.` };
      }
      const meta = await hub.updateMeta(String(args.id), {
        title: args.title as string | undefined,
        description: args.description as string | undefined,
        preview: typeof args.preview === "boolean" ? args.preview : undefined,
        archived: typeof args.archived === "boolean" ? args.archived : undefined,
      });
      const verb = args.archived === true ? "Archived" : args.archived === false ? "Unarchived" : "Updated";
      return { text: `${verb} ${meta.id}: ${meta.title}`, structured: meta };
    },
  },
  {
    name: "artifact_share",
    title: "artifacts.boo: share",
    description:
      "artifacts.boo: share an artifact with people by email, with everyone at a domain (\"@example.com\") or with every workspace member (\"workspace\"), change roles, remove entries, or toggle a public read-only link, optionally expiring. A person's own entry overrides their domain's role. Removal takes effect immediately. Each newly added person is emailed (notify: false to skip): someone new gets their own sign-in link, someone who has signed in before gets the page. Sign-in links only ever go to their person, never back to you. Returns the current sharing and who was emailed.",
    inputSchema: {
      type: "object",
      properties: {
        id,
        add: { ...shareList, description: "Add people or change their role." },
        remove: { type: "array", items: { type: "string" }, description: 'Emails or "@domain" entries to remove.' },
        public: { type: "boolean", description: "true: anyone with the link can view read-only. false: only shared people." },
        public_days: publicDays,
        notify: { type: "boolean", description: "Email each person added (default true). Set false if you'll send the links yourself." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    need: "owner",
    run: async (args, ctx) => {
      const { hub, origin } = ctx;
      for (const entry of [...((args.add as { email: string }[] | undefined) ?? []).map((a) => a.email), ...((args.remove as string[] | undefined) ?? [])]) {
        if (!isValidPrincipal(sharePrincipal(entry))) {
          return { isError: true, text: `"${entry}" is not an email address or @domain.` };
        }
      }
      const expiry = publicUntil(args);
      if (expiry.error) return { isError: true, text: expiry.error };
      const before = new Set(((await hub.meta(String(args.id)))?.shares ?? []).map((s) => s.email));
      const meta = await hub.share(String(args.id), {
        add: args.add as never,
        remove: args.remove as string[] | undefined,
        public: args.public as boolean | undefined,
        publicUntil: expiry.until,
      });
      if (!meta) return { isError: true, text: `No artifact ${args.id}` };
      const shares = meta.shares.length ? meta.shares.map((s) => `${s.email} (${s.role})`).join(", ") : "nobody";
      // Links go to people; a domain or workspace share has no single person to sign in as.
      const added = ((args.add as { email: string }[] | undefined) ?? [])
        .map((a) => sharePrincipal(a.email))
        .filter((p) => p.includes("@") && !p.startsWith("@"));
      // Only people who weren't already on the list hear about it.
      const people = await announceShares(ctx, meta.id, meta.title, added.filter((e) => e !== ctx.person && !before.has(e)), args.notify !== false);
      const said = { link: "emailed a sign-in link", page: "emailed the page (they sign in as themselves)", "not emailed": "not emailed; send them the page URL" };
      const lines = Object.entries(people).map(([e, p]) => `- ${e}: ${said[p]}`);
      return {
        text: `${url(origin, meta.id)}\nShared with: ${shares}. Public link: ${publicLine(meta)}.${lines.length ? `\n${lines.join("\n")}` : ""}`,
        structured: { url: url(origin, meta.id), shares: meta.shares, public: meta.public, publicUntil: meta.publicUntil, emailed: people },
      };
    },
  },
  {
    name: "artifact_link",
    title: "artifacts.boo: sign-in link",
    description:
      "artifacts.boo: make a presigned link for the user this agent acts for that opens one artifact already signed in, with no login step: use it when handing the user a link. Other people get their own by email when you share with them (artifact_share). Valid 7 days by default (max 30). Anyone holding it acts as the user, so give it only to them.",
    inputSchema: {
      type: "object",
      properties: {
        id,
        email: { type: "string", description: "Leave out: the link is for the user this agent acts for." },
        days: { type: "number", minimum: 0.05, maximum: 30, description: "Validity in days. Default 7." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    need: "view",
    run: async (args, ctx) => {
      const artifactId = String(args.id);
      const email = (typeof args.email === "string" && args.email.trim() ? args.email : ctx.person).trim().toLowerCase();
      const role = await ctx.hub.roleFor(artifactId, email);
      if (!role) return { isError: true, text: `${email} has no access to ${artifactId}. Share it first with artifact_share.` };
      // A link signs in as its person, so you only get one for yourself; other people get theirs by email (artifact_share).
      if (email !== ctx.person) {
        return { isError: true, text: `Sign-in links are only for you. artifact_share emails ${email} their own; or send them ${url(ctx.origin, artifactId)}.` };
      }
      const days = typeof args.days === "number" ? args.days : LINK_DEFAULT_DAYS;
      const link = await signInLink(ctx, artifactId, email, days);
      return { text: `Sign-in link for ${email} (valid ${days} days):\n${link}`, structured: { email, link, days } };
    },
  },
  {
    name: "artifact_asset",
    title: "artifacts.boo: images and files",
    description:
      'artifacts.boo: upload (base64) or delete an image or other file used by an artifact, e.g. path "assets/logo.png". Reference it in MDX as ![alt](assets/logo.png) or in code with useAsset("assets/logo.png"). External image URLs are blocked, so upload images instead. Max 1.5 MB each, 20 MB per artifact.',
    inputSchema: {
      type: "object",
      properties: {
        id,
        path: { type: "string", description: 'Must start with "assets/".' },
        base64: { type: "string", description: "File bytes, base64-encoded. Omit with delete: true." },
        contentType: { type: "string", description: "e.g. image/png. Default: guessed from the extension." },
        delete: { type: "boolean" },
      },
      required: ["id", "path"],
      additionalProperties: false,
    },
    need: "owner",
    run: async (args, ctx) => {
      const artifactId = String(args.id);
      const path = String(args.path);
      if (!/^assets\/[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(path) || path.includes("..")) {
        return { isError: true, text: 'path must look like "assets/logo.png"' };
      }
      if (args.delete === true) {
        const removed = await ctx.hub.deleteAsset(artifactId, path);
        return { text: removed ? `Deleted ${path}.` : `No asset ${path}.`, isError: !removed };
      }
      if (typeof args.base64 !== "string") return { isError: true, text: "base64 is required to upload" };
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(atob(args.base64.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
      } catch {
        return { isError: true, text: "base64 is not valid" };
      }
      if (bytes.byteLength > ASSET_MAX_BYTES) return { isError: true, text: `asset is ${bytes.byteLength} bytes; the limit is ${ASSET_MAX_BYTES}` };
      const contentType = typeof args.contentType === "string" ? args.contentType : guessType(path);
      const r = await ctx.hub.putAsset(artifactId, path, contentType, bytes);
      return { text: `Stored ${r.path} (${r.bytes} bytes, ${contentType}). Reload viewers to see it.`, structured: r };
    },
  },
  {
    name: "artifact_source",
    title: "artifacts.boo: live data source",
    description:
      'artifacts.boo: keep a data/*.json file updated from a public HTTPS JSON URL on a schedule (every 15 min to 7 days). Optional pick extracts a dot path such as "data.items". The URL\'s host must be approved by a workspace admin (in the artifact\'s Manage panel or workspace settings) before anything is fetched; if it is not, tell the user to ask an admin to approve it. Also lists, removes or refreshes sources.',
    inputSchema: {
      type: "object",
      properties: {
        id,
        path: { type: "string", description: 'Target data file, e.g. "data/prices.json". Omit to list sources.' },
        url: { type: "string" },
        everyMinutes: { type: "integer", minimum: 15, maximum: 10080, description: "Default 60." },
        pick: { type: "string" },
        remove: { type: "boolean" },
        refresh: { type: "boolean", description: "Fetch now." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    need: "owner",
    run: async (args, ctx) => {
      const artifactId = String(args.id);
      const path = typeof args.path === "string" ? args.path : undefined;
      const fmt = (s: SourceInfo) =>
        `${s.path} ← ${s.url} every ${s.everyMinutes} min${s.pick ? ` (pick ${s.pick})` : ""}: ${
          s.approved ? (s.lastStatus ? `${s.lastStatus}${s.lastError ? ` (${s.lastError})` : ""} at ${s.lastFetch}` : "not fetched yet") : `waiting for the user to approve ${s.host} in the owner menu`
        }`;
      if (path && args.remove === true) {
        const removed = await ctx.hub.removeSource(artifactId, path);
        return { text: removed ? `Removed the source for ${path}. The file keeps its last data.` : `No source for ${path}.`, isError: !removed };
      }
      if (path && typeof args.url === "string") {
        await ctx.hub.setSource(artifactId, {
          path,
          url: args.url,
          everyMinutes: typeof args.everyMinutes === "number" ? args.everyMinutes : 60,
          pick: typeof args.pick === "string" ? args.pick : undefined,
        });
        const [s] = await ctx.hub.refreshSources({ id: artifactId, path });
        return { text: fmt(s), structured: s, isError: s.lastStatus === "error" };
      }
      if (path && args.refresh === true) {
        const [s] = await ctx.hub.refreshSources({ id: artifactId, path });
        return s ? { text: fmt(s), structured: s, isError: s.lastStatus === "error" } : { isError: true, text: `No source for ${path}.` };
      }
      const list = await ctx.hub.sources(artifactId);
      return { text: list.length ? list.map(fmt).join("\n") : "No sources.", structured: { sources: list } };
    },
  },
  {
    name: "artifact_state",
    title: "artifacts.boo: shared state",
    description:
      "artifacts.boo: read an artifact's live shared state (poll votes, checklist items, comments, useShared keys), and optionally set keys (null deletes). Viewers see changes immediately.",
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
    need: (args) => (args.set && typeof args.set === "object" ? "edit" : "view"),
    run: async (args, ctx) => {
      const { hub } = ctx;
      const artifactId = String(args.id);
      // Writes are stamped with the person the agent acts for: it can't vote or comment as anyone else.
      if (args.set && typeof args.set === "object") {
        const role = (await hub.roleFor(artifactId, ctx.person)) ?? "view";
        await hub.setState(artifactId, args.set as never, ctx.person, undefined, { role, origin: ctx.origin });
      }
      const state = await hub.state(artifactId);
      const prefix = typeof args.prefix === "string" ? args.prefix : "";
      const filtered = Object.fromEntries(Object.entries(state).filter(([k]) => k.startsWith(prefix)));
      return { text: JSON.stringify(filtered, null, 1), structured: { state: filtered } };
    },
  },
  {
    name: "artifact_activity",
    title: "artifacts.boo: activity",
    description:
      "artifacts.boo: what people did since you last looked: new comment threads and replies (with the quoted text and block they point at), resolves, votes, checklist ticks, shared-state edits and new versions, oldest first. Pass the returned cursor as `since` next time to get only newer events. Omit `id` for every artifact. Use this to pick up feedback, then change the artifact (pass `resolves` with the thread ids you addressed) or reply with artifact_comment.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Only this artifact. Omit for all." },
        since: { type: "integer", description: "Cursor from a previous call. Omit for the most recent events." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Default 100." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    need: (args) => (typeof args.id === "string" ? "view" : null),
    run: async (args, { hub, person }) => {
      const r = await hub.activity({
        email: person,
        id: typeof args.id === "string" ? args.id : undefined,
        since: typeof args.since === "number" ? args.since : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      // Thread context (anchor, status) for every thread mentioned, so the agent needn't fetch it.
      const threadIds = new Set(r.events.map((e) => (e as { thread?: string }).thread).filter((t): t is string => typeof t === "string" && t.startsWith("t")));
      const byArtifact = new Map<string, Thread[]>();
      for (const e of r.events) {
        if (threadIds.size && !byArtifact.has(e.artifact)) byArtifact.set(e.artifact, await hub.threads(e.artifact));
      }
      const threads = [...byArtifact.values()].flat().filter((t) => threadIds.has(t.id));
      const lines = r.events.map(describeEvent);
      const context = threads.map(describeThread);
      return {
        text: [
          lines.length ? lines.join("\n") : "No new activity.",
          context.length ? `\nThreads:\n${context.join("\n")}` : "",
          `\ncursor: ${r.cursor}${r.more ? " (more events: call again with this cursor)" : ""}`,
        ].join("\n"),
        structured: { ...r, threads },
      };
    },
  },
  {
    name: "artifact_threads",
    title: "artifacts.boo: comment threads",
    description:
      "artifacts.boo: list an artifact's comment threads with every comment, what each points at (block id, quoted text, table row) and whether it is open, resolved or addressed. Open threads only unless includeResolved.",
    inputSchema: {
      type: "object",
      properties: { id, includeResolved: { type: "boolean" } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    need: "view",
    run: async (args, { hub }) => {
      const all = await hub.threads(String(args.id));
      const threads = args.includeResolved ? all : all.filter((t) => !t.resolved);
      return {
        text: threads.length ? threads.map(describeThread).join("\n\n") : args.includeResolved ? "No comments yet." : "No open threads.",
        structured: { threads },
      };
    },
  },
  {
    name: "artifact_comment",
    title: "artifacts.boo: comment",
    description:
      'artifacts.boo: reply to a comment thread, resolve or reopen it, or start a new thread (optionally anchored to a block id from artifact_threads, or to an exact quote). Your comments show as "Agent". Prefer fixing the artifact and passing `resolves` on the edit; reply when you need to answer a question or explain why you did not change something.',
    inputSchema: {
      type: "object",
      properties: {
        id,
        thread: { type: "string", description: "Thread to reply to or resolve. Omit to start a new thread." },
        text: { type: "string", description: "Comment text. Mention someone as @name@example.com." },
        resolve: { type: "boolean", description: "true resolves the thread, false reopens it." },
        block: { type: "string", description: "New thread only: block id to anchor to." },
        quote: { type: "string", description: "New thread only: exact text on the page to anchor to." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    need: "view",
    run: async (args, ctx) => {
      const artifactId = String(args.id);
      const actor = ctx.actor;
      const onBehalf = actor === "agent" ? ctx.person : undefined;
      // The agent has its person's powers over threads, no more: a viewer's agent can't resolve others' threads.
      const role = (await ctx.hub.roleFor(artifactId, ctx.person)) ?? "view";
      let thread: Thread | null = null;
      if (typeof args.text === "string" && args.text.trim()) {
        const anchor =
          !args.thread && (args.block || args.quote)
            ? {
                ...(typeof args.block === "string" ? { block: args.block } : {}),
                ...(typeof args.quote === "string" ? { quote: { exact: args.quote, prefix: "", suffix: "" } } : {}),
              }
            : null;
        thread = await ctx.hub.addComment(
          artifactId,
          actor,
          { thread: typeof args.thread === "string" ? args.thread : undefined, anchor, text: args.text, onBehalf },
          ctx.origin,
          undefined,
          role,
        );
      }
      if (typeof args.resolve === "boolean") {
        const target = thread?.id ?? (typeof args.thread === "string" ? args.thread : "");
        if (!target) return { isError: true, text: "resolve needs a thread id" };
        thread = await ctx.hub.resolveThread(artifactId, onBehalf ?? actor, target, args.resolve, { role, origin: ctx.origin, onBehalf });
      }
      if (!thread) return { isError: true, text: "Nothing to do: pass text and/or resolve." };
      return { text: `${describeThread(thread)}\n${url(ctx.origin, artifactId)}#thread=${thread.id}`, structured: { thread } };
    },
  },
  {
    name: "artifact_errors",
    title: "artifacts.boo: runtime errors",
    description:
      "artifacts.boo: recent runtime errors reported by viewers' browsers (newest first). Check after a change if someone reports a problem.",
    inputSchema: { type: "object", properties: { id }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: true },
    need: "view",
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
    title: "artifacts.boo: history",
    description: "artifacts.boo: list stored versions (newest first, last 50) with what changed.",
    inputSchema: { type: "object", properties: { id }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: true },
    need: "view",
    run: async (args, { hub }) => {
      const versions = await hub.history(String(args.id));
      return { text: versions.map((v) => `v${v.version} ${v.createdAt} ${v.note}`).join("\n"), structured: { versions } };
    },
  },
  {
    name: "artifact_revert",
    title: "artifacts.boo: revert",
    description: "artifacts.boo: restore the files of an earlier version as a new version. Shared state is not changed.",
    inputSchema: {
      type: "object",
      properties: { id, version: { type: "integer", minimum: 1 } },
      required: ["id", "version"],
      additionalProperties: false,
    },
    need: "owner",
    run: async (args, ctx) => writeResult(await ctx.hub.revert(String(args.id), Number(args.version), changeOptions({}, ctx)), ctx),
  },
  {
    name: "artifact_check",
    title: "artifacts.boo: render check",
    description:
      "artifacts.boo: render the current version in a headless browser, report runtime errors, and return a screenshot of the first screen. Writes already run the check; use this to see the page, re-check, or collect a queued result.",
    inputSchema: {
      type: "object",
      properties: { id, screenshot: { type: "boolean", description: "Include the screenshot (default true)." } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    need: "view",
    run: async (args, ctx) => {
      const meta = await ctx.hub.meta(String(args.id));
      if (!meta) return { isError: true, text: `No artifact ${args.id}; see artifact_list.` };
      const { check, screenshot } = await checkAndRecord(ctx, meta.id);
      const shot = args.screenshot !== false && screenshot;
      return {
        text: `v${meta.version}: ${describeCheck(check)}${shot ? "\nScreenshot of the first screen (1024×768) attached." : ""}`,
        structured: { version: meta.version, renderCheck: check },
        isError: check.status === "errors",
        images: shot ? [screenshot] : undefined,
      };
    },
  },
  {
    name: "artifact_delete",
    title: "artifacts.boo: delete",
    description:
      "artifacts.boo: permanently delete an artifact, its history and its shared state. Only when the user explicitly asks to delete; to tidy up finished work, archive it with artifact_update instead.",
    inputSchema: { type: "object", properties: { id }, required: ["id"], additionalProperties: false },
    annotations: { destructiveHint: true },
    need: "owner",
    run: async (args, { hub }) => {
      await hub.delete(String(args.id));
      return { text: `Deleted ${args.id}.` };
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

function who(actor: string | null): string {
  return actor === "agent" ? "Agent" : actor ?? "someone";
}

function describeEvent(e: { seq: number; at: string; artifact: string; title: string; actor: string | null; type: string } & Record<string, unknown>): string {
  const head = `#${e.seq} ${e.at.slice(0, 16).replace("T", " ")} ${e.artifact} (${e.title}): ${who(e.actor)}`;
  const text = typeof e.text === "string" ? ` “${e.text}”` : "";
  switch (e.type) {
    case "thread":
      return `${head} started thread ${e.thread}:${text}`;
    case "reply":
      return `${head} replied in ${e.thread}:${text}`;
    case "resolve":
      return `${head} resolved ${e.thread}${e.version ? ` (addressed in v${e.version})` : ""}`;
    case "reopen":
      return `${head} reopened ${e.thread}`;
    case "comment-delete":
      return `${head} deleted a comment in ${e.thread}`;
    case "version":
      return `${head} saved v${e.version}: ${e.note}`;
    case "state": {
      const key = String(e.key);
      if (key.startsWith("comments/")) return `${head} commented in <Comments id="${key.split("/")[1]}">: ${e.value ?? "(deleted)"}`;
      if (key.startsWith("poll/")) return `${head} voted in poll "${key.split("/")[1]}": ${e.value ?? "(cleared)"}`;
      if (key.startsWith("check/")) return `${head} updated checklist "${key.split("/")[1]}" item "${key.split("/")[2]}": ${e.value ?? "(removed)"}`;
      return `${head} set ${key} = ${e.value ?? "null"}`;
    }
    default:
      return `${head} ${e.type}`;
  }
}

function describeThread(t: Thread): string {
  const status = t.resolved ? (t.addressedIn ? `addressed in v${t.addressedIn}` : `resolved by ${who(t.resolved.by)}`) : "open";
  const a = t.anchor;
  const where = a
    ? [a.block && `block ${a.block}`, a.row && `row "${a.row}"`, a.label, a.quote && `on “${a.quote.exact}”`].filter(Boolean).join(", ")
    : "whole page";
  const comments = t.comments.map((c) => `  - ${who(c.by)} (${c.at.slice(0, 16).replace("T", " ")}): ${c.text}`).join("\n");
  return `Thread ${t.id} [${status}] on v${t.version}, ${where}\n${comments}`;
}

/** Tools the owner menu may call directly (same validation as agents get). */
const OWNER_UI_TOOLS = new Set([
  "artifact_share",
  "artifact_link",
  "artifact_update",
  "artifact_revert",
  "artifact_delete",
  "artifact_source",
  "artifact_check",
]);

export async function runOwnerTool(name: string, args: Json, ctx: Ctx): Promise<ToolResult> {
  const tool = TOOL_MAP.get(name);
  if (!tool || !OWNER_UI_TOOLS.has(name)) return { isError: true, text: `unknown action ${name}` };
  try {
    const r = await runTool(tool, args, ctx);
    return { ...r, images: undefined };
  } catch (err) {
    return { isError: true, text: publicMessage(err).message };
  }
}

const RANK: Record<Role, number> = { view: 0, edit: 1, owner: 2 };

/** Runs a tool after checking the person's role on the artifact it names. */
async function runTool(tool: Tool, args: Json, ctx: Ctx): Promise<ToolResult> {
  const need = typeof tool.need === "function" ? tool.need(args, ctx) : tool.need;
  if (need) {
    const artifactId = String(args.id ?? "");
    const role = await ctx.hub.roleFor(artifactId, ctx.person);
    // Without access the artifact doesn't exist, as far as this person can tell.
    if (!role) return { isError: true, text: `No artifact ${artifactId}; see artifact_list.` };
    if (RANK[role] < RANK[need]) {
      return {
        isError: true,
        text: `${ctx.person} has ${role} access to ${artifactId}; this needs ${need === "owner" ? "the owner or a workspace admin" : "edit access"}. Ask its owner to change your role.`,
      };
    }
  }
  return tool.run(args, ctx);
}

type RpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Json };

export async function handleMcp(request: Request, ctx: Ctx): Promise<Response> {
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
  const responses = (await Promise.all(batch.map((msg) => handleMessage(msg, ctx)))).filter(Boolean);
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
        // Named for the workspace, so someone in several can tell their connections apart.
        serverInfo: { name: `${SERVER_NAME}-${ctx.slug}`, title: ctx.workspace ? `${SERVER_TITLE} · ${ctx.workspace}` : SERVER_TITLE, version: SERVER_VERSION },
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
        const r = await runTool(tool, (msg.params?.arguments as Json) ?? {}, ctx);
        return reply({
          content: [
            { type: "text", text: r.text },
            ...(r.images ?? []).map((data) => ({ type: "image", data, mimeType: "image/jpeg" })),
          ],
          ...(r.structured !== undefined ? { structuredContent: r.structured } : {}),
          isError: r.isError ?? false,
        });
      } catch (err) {
        return reply({ content: [{ type: "text", text: publicMessage(err).message }], isError: true });
      }
    }
    default:
      if (isNotification) return null;
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

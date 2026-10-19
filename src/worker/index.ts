// artifacts.boo Worker. The apex domain is the front door (splash, sign-in, your
// workspaces, notification settings, the operator console); every workspace is
// served at its own subdomain, backed by its own Durable Object, and is its own
// OAuth authorization server and MCP resource.
import { OAuthProvider, AuthorizationError, CimdFetchError, getOAuthApi, type OAuthHelpers, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { handleMcp, runOwnerTool, type Ctx } from "./mcp.ts";
import {
  adminPage,
  consentPage,
  continuePage,
  linkSwitchPage,
  policyPage,
  type PolicyKind,
  frameDocument,
  indexPage,
  loginPage,
  messagePage,
  passkeyOfferPage,
  previewPage,
  PRODUCT,
  DESCRIPTION,
  profilePage,
  settingsPage,
  shellPage,
  splashPage,
  workspacesPage,
  POLICY_UPDATED,
  pricingPage,
  helpPage,
  inboxPage,
  switchPage,
  supportPage,
  REPORT_REASONS,
  reportPage,
  type Brand,
} from "./pages.ts";
import { prepareChannel, sendToChannel, type ChannelType } from "./notify.ts";
import { isTestAddress, sendCode, sendInvite } from "./mail.ts";
import { ops } from "./ops.ts";
import { approveAnnouncement, browserOf, caseUrl, openCase, placeOf, recordProductError, supportHub, SupportError, type CaseKind } from "./support.ts";
import { publicMessage } from "./errors.ts";
import { isPlan } from "./plans.ts";
import { BillingError, billingOn, billingReady, planFor, portalLink, readEvent, startCheckout, subscriptionLive, subscriptionMayCharge, TEAM_PRICE, verifyWebhook } from "./billing.ts";
import { checkLayout } from "./layout.ts";
import { exportRun, latestManifest } from "./snapshot.ts";
import { DATA_TABLES } from "./tables.ts";
import { PasskeyError, registrationOptions, signInOptions, verifyRegistration, verifySignIn } from "./passkeys.ts";
export { isTestAddress };
import {
  b64url,
  clearSessionCookie,
  readCookie,
  SESSION_COOKIE,
  SESSION_TTL,
  sessionCookie,
  signToken,
  timingSafeEqual,
  verifyToken,
} from "./session.ts";
import { personKey, validSlug, WORKSPACE_LIST_KEY, type DirectoryApi, type WorkspaceRecord, type WorkspaceRole } from "./directory.ts";
import type { HubApi, Workspace } from "./hub.ts";
import type { Directory } from "./directory.ts";
import type { Role } from "../shared/protocol.ts";

export { Workspace } from "./hub.ts";
export { Directory } from "./directory.ts";

export type Env = {
  WORKSPACE: DurableObjectNamespace<Workspace>;
  DIRECTORY: DurableObjectNamespace<Directory>;
  /** OAuth clients, grants and tokens (hashed), shared by every workspace's authorization server. */
  OAUTH_KV: KVNamespace;
  /** Sends sign-in codes. */
  EMAIL?: SendEmail;
  BACKUPS?: R2Bucket;
  /** Cloudflare Browser Run, used for render checks after writes. */
  BROWSER?: { quickAction(action: "snapshot", options: Record<string, unknown>): Promise<Response> };
  SESSION_SECRET: string;
  LOGIN_SECRET: string;
  /** Signs remembered OAuth consent. */
  CONSENT_SECRET: string;
  /** Bearer token for the operator API (scripts). */
  OPERATOR_TOKEN: string;
  /** Comma-separated emails who run this deployment. */
  OPERATOR_EMAILS: string;
  /** Where people write for help (support@<domain> when Email Routing forwards it); else the first operator. */
  SUPPORT_EMAIL?: string;
  /** The front door, e.g. "artifacts.boo". */
  APEX_HOST: string;
  /** https://<APEX_HOST>, for links in notification emails. */
  APEX_ORIGIN?: string;
  /** Appended to a slug to make its host, e.g. ".artifacts.boo" ("acme.artifacts.boo"). */
  WORKSPACE_SUFFIX: string;
  /** "on" lets anyone signed in make a Free workspace from /workspaces. Off unless set. */
  SELF_SERVE?: string;
  /** Billing through Creem (src/worker/billing.ts): BILLING=on plus the keys. */
  BILLING?: string;
  CREEM_API_KEY?: string;
  CREEM_WEBHOOK_SECRET?: string;
  CREEM_PRODUCT_ID?: string;
  /** Sender address for sign-in codes. */
  MAIL_FROM: string;
  /** Pushover application token shared by every user's Pushover channel. */
  PUSHOVER_TOKEN?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
};

/**
 * Link-preview fetchers (Slack, iMessage, Discord, Teams, …). They never carry a
 * session. Only bot user agents: in-app browsers (Teams, Slack, Signal) are people.
 */
const PREVIEW_BOT =
  /Slackbot|facebookexternalhit|Facebot|Twitterbot|Discordbot|TelegramBot|LinkedInBot|WhatsApp\/|SkypeUriPreview|MicrosoftPreview|Google-?Chat|Googlebot|bingbot|Applebot|redditbot|Mastodon\/|Pinterestbot|Embedly|Iframely|vkShare|Bluesky Cardyb/i;

const FRAME_TTL = 10 * 60;
const OG_TTL = 10 * 365 * 86400;
const WORKSPACE_CACHE_MS = 30_000;
const MISSING_CACHE_MS = 5_000;
const WORKSPACE_CACHE_MAX = 2000;
const NONCE_COOKIE = "__Host-art_login";
/** Set on the apex when someone answers "Not now" to saving a passkey; the offer returns when it lapses. */
export const PASSKEY_LATER_COOKIE = "art_passkey_later";

/**
 * `only` is set for a session from a presigned link: it opens that one
 * artifact and nothing else (no list, settings, owner actions or OAuth).
 */
type Viewer = { email: string | null; only?: string; exp?: number; /** When they signed in (seconds), for actions that need a recent sign-in. */ iat?: number };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    if (url.hostname === `www.${env.APEX_HOST}`) {
      url.hostname = env.APEX_HOST;
      return Response.redirect(url.toString(), 301);
    }
    try {
    if (url.hostname === env.APEX_HOST) response = await apex(request, env, ctx);
    else {
      // Unknown hosts stop here, so a random subdomain never wakes a Durable Object.
      const slug = slugOf(url.hostname, env);
      const signingIn = url.pathname === "/login" || url.pathname.startsWith("/s/") || Boolean(readCookie(request, SESSION_COOKIE));
      const record = slug ? await workspaceRecord(env, slug, ctx, signingIn) : null;
      response = record
        ? await providerFor(url.origin).fetch(request, env, ctx)
        : messagePage("No such workspace", `There's no workspace at ${url.hostname}.`, 404, { href: apexOrigin(env), label: PRODUCT }, apexBrand(env));
    }
    } catch (err) {
      // Something we didn't expect: recorded as a product error, and the person gets its code and a way to report it.
      console.error(err);
      const code = await recordProductError(env, { kind: "server", place: url.pathname, message: err instanceof Error ? err.message : String(err), browser: browserOf(request.headers.get("User-Agent")) });
      if (url.pathname.startsWith("/api/") || url.pathname === "/mcp") return Response.json({ error: `Something went wrong on our side (error ${code}).`, errorId: code }, { status: 500 });
      return messagePage("Something went wrong", `That failed on our side (error ${code}). Trying again often works; if it doesn't, tell us and we'll look into it.`, 500, { href: `${apexOrigin(env)}/support?error=${code}`, label: "Report this" }, apexBrand(env));
    }
    await renewSession(request, env, response);
    if (response.status !== 101) {
      try {
        // Nothing here should be indexed by search engines, public artifacts included.
        if (!response.headers.has("X-Robots-Tag")) response.headers.set("X-Robots-Tag", "noindex, nofollow");
        response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
        if (!response.headers.has("X-Content-Type-Options")) response.headers.set("X-Content-Type-Options", "nosniff");
      } catch {
        // immutable headers (e.g. redirects); those pages carry no content
      }
    }
    return response;
  },
};

function directory(env: Env): DirectoryApi {
  return env.DIRECTORY.getByName("directory") as unknown as DirectoryApi;
}

function workspaceHub(env: Env, slug: string): HubApi {
  return env.WORKSPACE.getByName(slug) as unknown as HubApi;
}

export function slugOf(hostname: string, env: Pick<Env, "WORKSPACE_SUFFIX">): string | null {
  if (!hostname.endsWith(env.WORKSPACE_SUFFIX)) return null;
  const slug = hostname.slice(0, -env.WORKSPACE_SUFFIX.length);
  return validSlug(slug) ? slug : null;
}

export function workspaceOrigin(env: Pick<Env, "WORKSPACE_SUFFIX">, slug: string): string {
  return `https://${slug}${env.WORKSPACE_SUFFIX}`;
}

/**
 * Reporting an artifact (phishing, malware, anything that breaks the terms): anyone, signed in or not,
 * from the Report link on artifacts they don't belong to. It emails the operator, who can suspend the
 * workspace from the operator console.
 */
async function reportRoute(request: Request, url: URL, env: Env, brand: Brand): Promise<Response> {
  const target = (request.method === "POST" ? null : url.searchParams.get("url")) ?? "";
  if (request.method !== "POST") return reportPage(brand, { url: ourArtifactUrl(env, target) ?? "" });
  if (!sameOrigin(request, url)) return new Response("bad origin", { status: 403 });
  const form = await request.formData().catch(() => new FormData());
  const field = (k: string, max: number) => String(form.get(k) ?? "").trim().slice(0, max);
  const state = { url: field("url", 500), reason: field("reason", 40), details: field("details", 2000), email: field("email", 200) };
  const artifact = ourArtifactUrl(env, state.url);
  if (!artifact) return reportPage(brand, { ...state, error: `Paste the artifact's link (it looks like https://<workspace>${env.WORKSPACE_SUFFIX}/a/…).` }, 400);
  if (!REPORT_REASONS.some(([k]) => k === state.reason)) return reportPage(brand, { ...state, error: "Pick what's wrong." }, 400);
  if (!(await directory(env).allowReport(request.headers.get("CF-Connecting-IP") ?? "unknown"))) {
    return reportPage(brand, { ...state, error: `Too many reports from your network just now. Email ${contactEmail(env)} instead.` }, 429);
  }
  const slug = new URL(artifact).hostname.slice(0, -env.WORKSPACE_SUFFIX.length);
  if (!(await directory(env).workspace(slug))) return reportPage(brand, { ...state, error: "There's no workspace at that link." }, 400);
  // Kept in the ops log (the operator console lists reports) as well as emailed: an email alone can be lost.
  const label = REPORT_REASONS.find(([k]) => k === state.reason)![1];
  const stored = await ops(env, {
    kind: "report",
    slug,
    message: `Report (${label}): ${artifact}. Suspend the workspace from the operator console if it's real.`,
    detail: { url: artifact, reason: state.reason, details: state.details || undefined, from: state.email || "anonymous" },
    alert: `report:${slug}`,
    keepAll: true,
  });
  if (!stored) return reportPage(brand, { ...state, error: `We couldn't take the report just now. Email ${contactEmail(env)} instead.` }, 503);
  return reportPage(brand, { done: true });
}

/**
 * Help & feedback (apex): send us a problem, idea or question, and see your requests. `from` is the page the
 * person came from (included only if they leave it ticked), `error` an error code from an error page.
 */
async function supportRoute(request: Request, url: URL, env: Env, viewer: { email: string; operator: boolean } | null, brand: Brand): Promise<Response> {
  const dir = directory(env);
  const ours = (raw: string | null) => {
    try {
      const u = new URL(raw ?? "");
      return u.protocol === "https:" && (u.hostname === env.APEX_HOST || u.hostname.endsWith(env.WORKSPACE_SUFFIX)) ? u : null;
    } catch {
      return null;
    }
  };
  const requests = async () =>
    viewer ? (await dir.supportCases({ reporter: viewer.email, limit: 50 })).filter((c) => c.artifactId).map((c) => ({ n: c.n, title: c.title, status: c.status, url: caseUrl(env, c), updatedAt: c.updatedAt })) : [];
  const from = ours(url.searchParams.get("from"));
  const errorCode = /^e[0-9a-f]{10}$/.test(url.searchParams.get("error") ?? "") ? url.searchParams.get("error")! : undefined;
  if (request.method !== "POST") {
    return supportPage(brand, viewer, { requests: await requests(), contact: contactEmail(env), ...(from ? { page: from.href } : {}), ...(errorCode ? { error: errorCode } : {}) });
  }
  if (!sameOrigin(request, url)) return new Response("bad origin", { status: 403 });
  if (!viewer) return Response.redirect(`${url.origin}/login?return=/support`, 302);
  const form = await request.formData().catch(() => new FormData());
  const field = (k: string) => String(form.get(k) ?? "");
  const page = ours(form.get("page") ? field("page") : null);
  const state = { kind: field("kind"), title: field("title"), details: field("details"), ...(page ? { page: page.href } : {}), ...(/^e[0-9a-f]{10}$/.test(field("error")) ? { error: field("error") } : {}) };
  try {
    const made = await openCase(env, {
      reporter: viewer.email,
      viaAgent: false,
      kind: state.kind as CaseKind,
      title: state.title,
      details: state.details,
      context: {
        ...(page ? { page: `${page.hostname}${placeOf(page.pathname)}`, ...(slugOf(page.hostname, env) ? { workspace: slugOf(page.hostname, env)! } : {}) } : {}),
        ...(page || form.get("browser") ? { browser: browserOf(request.headers.get("User-Agent")) } : {}),
      },
      ...(state.error ? { errorId: state.error } : {}),
    });
    return continuePage(made.url);
  } catch (err) {
    if (!(err instanceof SupportError)) throw err;
    return supportPage(brand, viewer, { requests: await requests(), contact: contactEmail(env), ...state, problem: err.message }, 400);
  }
}

/** The Notification Centre: what needs you, newest first; opening it marks it read. The operator approves announcements here. */
async function inboxRoute(request: Request, url: URL, env: Env, viewer: { email: string; operator: boolean } | null, brand: Brand): Promise<Response> {
  if (!viewer) return Response.redirect(`${url.origin}/login?return=/inbox`, 302);
  const dir = directory(env);
  let notice: string | undefined;
  if (request.method === "POST") {
    if (!sameOrigin(request, url)) return new Response("bad origin", { status: 403 });
    const form = await request.formData().catch(() => new FormData());
    const draft = String(form.get("approve") ?? "");
    if (/^d[0-9a-f]{16}$/.test(draft)) {
      try {
        const r = await approveAnnouncement(env, draft, viewer.email);
        notice = r.sent ? `Sent to ${r.sent} ${r.sent === 1 ? "request" : "requests"}.` : "That one was already sent.";
      } catch (err) {
        if (!(err instanceof SupportError)) throw err;
        notice = err.message;
      }
    }
  }
  const { items } = await dir.inbox(viewer.email, 100);
  // An announcement to approve shows all of it, and everyone it goes to, from the draft itself.
  const shown = await Promise.all(
    items.map(async (i) => {
      const id = i.kind === "approve-announcement" ? /#(d[0-9a-f]{16})$/.exec(i.url ?? "")?.[1] : undefined;
      const draft = id ? await dir.draft(id) : null;
      return draft ? { ...i, body: `${draft.message}\n\nGoes to requests ${draft.cases.map((n) => `#${n}`).join(", ")}.`, sent: Boolean(draft.sentAt) } : i;
    }),
  );
  await dir.markInboxRead(viewer.email);
  return inboxPage(brand, viewer, shown, notice);
}

/** An error in one of our own pages (never an artifact's): grouped with the same ones, a few per network an hour. */
async function clientError(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { message?: unknown; place?: unknown } | null;
  if (!body || typeof body.message !== "string" || !body.message.trim()) return new Response(null, { status: 204 });
  if (!(await directory(env).allowReport(request.headers.get("CF-Connecting-IP") ?? "unknown", "client-error"))) return new Response(null, { status: 204 });
  const place = typeof body.place === "string" ? body.place : "/";
  await recordProductError(env, { kind: "client", place, message: body.message.slice(0, 1000), browser: browserOf(request.headers.get("User-Agent")) });
  return new Response(null, { status: 204 });
}

/** An artifact link on one of our workspaces, normalized; null for anything else. */
function ourArtifactUrl(env: Env, raw: string): string | null {
  try {
    const u = new URL(raw);
    const m = /^\/a\/([a-z0-9]+)/.exec(u.pathname);
    if (u.protocol !== "https:" || !u.hostname.endsWith(env.WORKSPACE_SUFFIX) || !m) return null;
    return `${u.origin}/a/${m[1]}`;
  } catch {
    return null;
  }
}

/** Where people reach us: the support address, else the first operator. */
function contactEmail(env: Env): string {
  return env.SUPPORT_EMAIL || (env.OPERATOR_EMAILS ?? "").split(",")[0].trim();
}

function apexOrigin(env: Env): string {
  return `https://${env.APEX_HOST}`;
}

function apexBrand(env: Env): Brand {
  return { name: PRODUCT, home: "/", apex: apexOrigin(env) };
}

type Routable = Pick<WorkspaceRecord, "slug" | "name" | "suspended">;
type WorkspaceList = { at: string; list: Record<string, { name: string; suspended: boolean }> };
/** KV is edge-cached this long; a missing slug is trusted only once the list is older than that plus a margin. */
const LIST_CACHE_S = 30;
const LIST_SETTLE_MS = (LIST_CACHE_S + 90) * 1000;

/**
 * The workspace for a host, without touching the directory on ordinary
 * requests: the directory mirrors its list of workspaces to KV whenever one
 * is created, renamed, suspended or deleted. A slug the list doesn't have is
 * answered from the list alone once the list has settled, so random
 * subdomains never reach the directory or wake a Durable Object; only just
 * after a change does a miss fall back to asking the directory.
 */
const workspaceCache = new Map<string, { record: Routable | null; at: number }>();
let listCache: { value: WorkspaceList | null; at: number } | null = null;
let publishing = false;

async function workspaceRecord(env: Env, slug: string, ctx?: ExecutionContext, verifyMiss = false): Promise<Routable | null> {
  const hit = workspaceCache.get(slug);
  if (hit && Date.now() - hit.at < (hit.record ? WORKSPACE_CACHE_MS : MISSING_CACHE_MS) && !(verifyMiss && !hit.record)) return hit.record;
  const remember = (record: Routable | null) => {
    // Random subdomains shouldn't grow an isolate's memory without bound.
    if (workspaceCache.size >= WORKSPACE_CACHE_MAX) workspaceCache.clear();
    workspaceCache.set(slug, { record, at: Date.now() });
    return record;
  };
  if (!listCache || Date.now() - listCache.at > LIST_CACHE_S * 1000) {
    const value = (await env.OAUTH_KV.get<WorkspaceList>(WORKSPACE_LIST_KEY, { type: "json", cacheTtl: LIST_CACHE_S }).catch(() => null)) ?? null;
    listCache = { value, at: Date.now() };
  }
  const listed = listCache.value;
  const entry = listed && Object.hasOwn(listed.list, slug) ? listed.list[slug] : null;
  if (entry) return remember({ slug, ...entry });
  // Our copy of the list can be a minute behind; a just-made workspace would 404. Only a browser that's signing
  // in or signed in (verifyMiss) asks the directory about a miss, so random subdomains still never reach it.
  if (listed && Date.now() - Date.parse(listed.at) > LIST_SETTLE_MS && !verifyMiss) return remember(null);
  if (!listed && ctx && !publishing) {
    publishing = true;
    ctx.waitUntil(directory(env).publish().finally(() => (publishing = false)));
  }
  const record = await directory(env).workspace(slug);
  return remember(record ? { slug, name: record.name, suspended: record.suspended } : null);
}

/** After a change to the workspace list: forget this isolate's copies (the directory has republished). */
function forgetWorkspaces() {
  workspaceCache.clear();
  listCache = null;
}

// ---- workspace hosts: OAuth around the app --------------------------------------------

/** `gen`: when the workspace was made, so a grant can't outlive it into a new workspace of the same name. */
type McpProps = { email: string; slug: string; gen?: string };

const providers = new Map<string, { provider: OAuthProvider<Env>; options: OAuthProviderOptions<Env> }>();

/** Each workspace origin is its own OAuth authorization server for its own /mcp resource. */
function providerFor(origin: string): OAuthProvider<Env> {
  return oauthFor(origin).provider;
}

/** The OAuth helpers (grants, consent) for one workspace origin, outside its /authorize page. */
function oauthApi(origin: string, env: Env): OAuthHelpers {
  return getOAuthApi(oauthFor(origin).options, env);
}

function oauthFor(origin: string) {
  const cached = providers.get(origin);
  if (cached) return cached;
  const options: OAuthProviderOptions<Env> = {
    apiRoute: "/mcp",
    apiHandler: { fetch: (request, env, ctx) => mcpApi(request, env, (ctx as ExecutionContext & { props: McpProps }).props) },
    defaultHandler: { fetch: (request, env) => workspaceRoute(request as Request, env as Env) },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: ["artifacts"],
    resourceMetadata: { resource: `${origin}/mcp`, resource_name: PRODUCT },
    accessTokenTTL: 3600,
    refreshTokenTTL: 365 * 86400,
    // Grants live as long as the agent keeps using them.
    refreshTokenIdleTTL: 60 * 86400,
    clientIdMetadataDocumentEnabled: true,
    // Agents that can't run a browser sign-in use a personal token from /settings.
    resolveExternalToken: async ({ token, request, env }) => {
      const slug = slugOf(new URL(request.url).hostname, env);
      if (!slug || !token.startsWith("art_")) return null;
      const who = await workspaceHub(env, slug).verifyAgentToken(token);
      // Agent tokens live in the workspace itself, so they can't outlive it: no generation needed.
      return who ? { props: { email: who.email, slug } satisfies McpProps, audience: `${origin}/mcp` } : null;
    },
  };
  const entry = { provider: new OAuthProvider<Env>(options), options };
  providers.set(origin, entry);
  return entry;
}

/** An MCP-shaped refusal, so clients show the reason rather than a bare HTTP status. */
function mcpRefusal(status: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }, { status });
}

async function mcpApi(request: Request, env: Env, props: McpProps): Promise<Response> {
  const url = new URL(request.url);
  const slug = slugOf(url.hostname, env);
  const record = slug ? await workspaceRecord(env, slug) : null;
  if (!slug || !record || props.slug !== slug) return mcpRefusal(404, "unknown workspace");
  if (record.suspended) return mcpRefusal(403, `${record.name} is suspended`);
  const hub = workspaceHub(env, slug);
  const access = await hub.access(props.email);
  if (access.offline) return mcpRefusal(503, `${record.name} is being restored; try again in a few minutes`);
  // Leaving the workspace ends an agent's access, whatever token it holds.
  if (!access.member) return mcpRefusal(403, `${props.email} is no longer a member of ${record.name}; ask a workspace admin to add you back`);
  // A grant from a deleted workspace that had this name doesn't work here.
  if (props.gen && access.createdAt && props.gen !== access.createdAt) return mcpRefusal(401, "This connection was for an earlier workspace at this address; connect again.");
  return handleMcp(request, { hub, origin: url.origin, env, slug, workspace: record.name, admin: access.member === "admin", person: props.email, actor: "agent" });
}

async function workspaceRoute(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const slug = slugOf(url.hostname, env)!;
  // ?deep=1 also reaches the directory, so an uptime monitor notices when it's down.
  if (path === "/healthz") {
    if (url.searchParams.get("deep") === "1") await directory(env).workspace("healthz");
    return new Response("ok", { headers: { "Cache-Control": "no-store" } });
  }
  if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
  if (path === "/privacy" || path === "/terms" || path === "/security" || path === "/help") return Response.redirect(`${apexOrigin(env)}${path}`, 301);
  if (path === "/support") return Response.redirect(`${apexOrigin(env)}/support${url.search}`, 302);
  if (path === "/api/client-error" && request.method === "POST") return clientError(request, env);
  const record = await workspaceRecord(env, slug);
  const brand: Brand = { name: record?.name ?? slug, home: "/", apex: apexOrigin(env) };
  if (!record) return messagePage("No such workspace", `There's no workspace at ${url.hostname}.`, 404, { href: apexOrigin(env), label: PRODUCT }, apexBrand(env));
  if (record.suspended) return messagePage("Workspace suspended", `${record.name} is suspended. Contact whoever runs it.`, 403, { href: apexOrigin(env), label: PRODUCT }, brand);
  const hub = workspaceHub(env, slug);
  // Pages and APIs check the workspace itself first (deleted, or offline for a restore). Frames,
  // assets and images carry their own short-lived tokens, and anything else is a 404, so neither
  // wakes the workspace for nothing.
  if (/^\/($|archived$|me$|settings$|authorize$|switch$|login$|auth\/|s\/|a\/|api\/)/.test(path)) {
    const state = await hub.access(null, workspaceOrigin(env, slug));
    // A deleted workspace's object may still be cached here for a few seconds.
    if (state.slug !== slug) return messagePage("No such workspace", `There's no workspace at ${url.hostname}.`, 404, { href: apexOrigin(env), label: PRODUCT }, apexBrand(env));
    if (state.offline) {
      const res = messagePage("Back in a few minutes", `${record.name} is being restored from a backup. Try again in a few minutes.`, 503, { href: path, label: "Try again" }, brand);
      res.headers.set("Retry-After", "60");
      return res;
    }
  }

  const og = /^\/og\/([a-z0-9]+)\.jpg$/.exec(path);
  if (og) return ogImage(og[1], url, env, hub, slug);

  // Previews are answered before any sign-in redirect, and a presigned link
  // is never redeemed by a preview fetcher.
  if (PREVIEW_BOT.test(request.headers.get("User-Agent") ?? "")) {
    const target = /^\/a\/([a-z0-9]+)$/.exec(path)?.[1] ?? (await linkTarget(path, env, slug));
    if (target || path === "/") return linkPreview(target ?? null, url, env, hub, slug);
  }

  const session = await currentViewer(request, env);
  // A presigned-link session counts only on its own artifact's pages.
  const viewer: Viewer = session.only ? { email: null } : session;
  const signIn = (next: string) => Response.redirect(`${url.origin}/login?return=${encodeURIComponent(next)}`, 302);

  if (path === "/login") {
    // The nonce ties the hand-off back to this browser, so nobody can sign someone else in as themselves.
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)));
    const target = new URL(`${apexOrigin(env)}/login`);
    target.searchParams.set("to", url.origin);
    target.searchParams.set("n", nonce);
    target.searchParams.set("return", safeNext(url.searchParams.get("return")));
    // "Sign in again" from a workspace page has to reach the apex, or the old session would just carry on.
    if (url.searchParams.get("fresh") === "1") target.searchParams.set("fresh", "1");
    return new Response(null, {
      status: 302,
      headers: { Location: target.href, "Set-Cookie": `${NONCE_COOKIE}=${nonce}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900` },
    });
  }
  if (path === "/auth/callback") return authCallback(request, url, env);
  if (path === "/logout" && request.method === "POST") {
    if (!sameOrigin(request, url)) return new Response("bad origin", { status: 403 });
    return continuePage(`${apexOrigin(env)}/signed-out`, new Headers({ "Set-Cookie": clearSessionCookie() }));
  }
  const presigned = /^\/s\/([A-Za-z0-9_.-]+)$/.exec(path);
  if (presigned) return presignedSignIn(request, presigned[1], url, env, hub, slug, brand, session);

  if (path === "/" || path === "/archived") {
    // Signed in on the apex already, this comes straight back signed in here.
    if (!viewer.email) return signIn(path);
    const archived = path === "/archived";
    const data = await hub.indexData(viewer.email, { archived, q: url.searchParams.get("q"), page: url.searchParams.get("page") });
    return indexPage({ email: viewer.email, member: data.member }, data, brand, data.summaries, archived, { mcpUrl: `${url.origin}/mcp`, name: `artifacts-${slug}` });
  }
  if (path === "/me") {
    if (!viewer.email) return signIn("/me");
    return profilePage(viewer.email, "workspace", brand, Boolean(env.VAPID_PUBLIC_KEY), Boolean(env.PUSHOVER_TOKEN));
  }
  if (path === "/api/me" || path.startsWith("/api/me/")) return workspaceMeApi(request, url, env, hub, session);
  if (path === "/settings") {
    if (!viewer.email) return signIn("/settings");
    const { member } = await hub.access(viewer.email);
    if (!member) return messagePage("Members only", `${viewer.email} isn't a member of ${record.name}. Ask a workspace admin to add you.`, 403, undefined, brand);
    return settingsPage(viewer.email, brand);
  }
  if (path === "/api/settings" || path.startsWith("/api/settings/")) return settingsApi(request, url, env, hub, viewer, slug);
  if (path === "/authorize") return authorize(request, url, env, hub, viewer, record, brand);
  // "Sign in with a different email": end this workspace's session and the apex's, then sign in again.
  // Signing out to sign in as someone else changes things, so it's a POST from a page that asks; a link
  // (or an artifact navigating the tab) only shows that page.
  if (path === "/switch" && request.method !== "POST") return switchPage(safeNext(url.searchParams.get("return")), brand);
  if (path === "/switch") {
    if (!sameOrigin(request, url)) return new Response("bad origin", { status: 403 });
    const form = await request.formData().catch(() => new FormData());
    const next = safeNext(String(form.get("return") ?? url.searchParams.get("return") ?? "/"));
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)));
    const target = new URL(`${apexOrigin(env)}/login`);
    target.searchParams.set("to", url.origin);
    target.searchParams.set("n", nonce);
    target.searchParams.set("return", next);
    target.searchParams.set("switch", "1");
    const headers = new Headers({ Location: target.href });
    headers.append("Set-Cookie", clearSessionCookie());
    headers.append("Set-Cookie", `${NONCE_COOKIE}=${nonce}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900`);
    return new Response(null, { status: 302, headers });
  }

  const frame = /^\/frame\/([a-z0-9]+)$/.exec(path);
  if (frame) {
    const claims = await verifyToken<{ id: string; w: string; c?: boolean; j?: string }>(env.SESSION_SECRET, "frame", url.searchParams.get("t"));
    if (!claims || claims.id !== frame[1] || claims.w !== slug) return new Response("frame link expired; reload the page", { status: 403 });
    // A render check's frame runs without the sandbox, so its link works once (and only with its one-time id).
    if (claims.c && (!claims.j || !(await hub.spendToken(`check:${claims.j}`, claims.exp * 1000)))) {
      return new Response("this check link was already used", { status: 403 });
    }
    const result = await hub.build(frame[1]);
    if (!result) return new Response("not found", { status: 404 });
    // Asset URLs reuse this frame's token; it also authorizes /asset/ reads.
    const token = url.searchParams.get("t")!;
    const assets = Object.fromEntries(
      (await hub.assets(frame[1])).map((a) => [a.path, `/asset/${frame[1]}/${a.path}?t=${encodeURIComponent(token)}`]),
    );
    return frameDocument(url.origin, result.meta, result.build, claims.c === true, assets);
  }

  if (path.startsWith("/api/")) return ownerApi(request, url, env, hub, viewer, slug);

  const asset = /^\/asset\/([a-z0-9]+)\/(assets\/[A-Za-z0-9_./-]+)$/.exec(path);
  if (asset) {
    const claims = await verifyToken<{ id: string; w: string }>(env.SESSION_SECRET, "frame", url.searchParams.get("t"));
    if (!claims || claims.id !== asset[1] || claims.w !== slug) return new Response("asset link expired; reload the page", { status: 403 });
    const file = await hub.asset(asset[1], asset[2]);
    if (!file) return new Response("not found", { status: 404 });
    return new Response(file.data, {
      headers: {
        "Content-Type": file.contentType,
        // SVGs and HTML can't run script or reach anything when opened directly.
        "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=600",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  }

  const art = /^\/a\/([a-z0-9]+)(\/sync|\/errors)?$/.exec(path);
  if (art) {
    const [, id, sub] = art;
    const here = session.only === id ? session : viewer;
    const scoped = Boolean(here.only);
    // The page itself gets everything in one call; sync and error reports only need the role.
    const opened = sub ? null : await hub.openArtifact(id, here.email, scoped);
    const full = opened ? opened.role : await hub.roleFor(id, here.email);
    // From a link, even an owner gets the page, not its management.
    const role = full === "owner" && scoped ? "edit" : full;
    if (!role) {
      if (!here.email && !sub) return signIn(path);
      return sub
        ? new Response("forbidden", { status: 403 })
        : messagePage("Not available", `${here.email} doesn't have access to this artifact, or it doesn't exist.`, 403, { href: `/switch?return=${encodeURIComponent(path)}`, label: "Sign in with a different email" }, brand);
    }
    if (sub === "/sync") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      if (!sameOrigin(request, url)) return new Response("bad origin", { status: 403 });
      const headers = new Headers(request.headers);
      headers.set("X-Art-Id", id);
      headers.set("X-Art-Role", role);
      headers.set("X-Art-Email", here.email ?? "");
      // A link session's socket ends when its link would have.
      if (here.exp) headers.set("X-Art-Exp", String(here.exp));
      headers.set("X-Art-Origin", url.origin);
      return hub.fetch(new Request(request.url, { headers }));
    }
    if (sub === "/errors") {
      if (request.method !== "POST" || !sameOrigin(request, url)) return new Response("bad request", { status: 400 });
      // Only signed-in viewers report errors (anyone could post to a public artifact's log), a few an hour each.
      if (!here.email) return new Response(null, { status: 204 });
      const body = (await request.json().catch(() => null)) as { message?: string; stack?: string } | null;
      if (body?.message) await hub.recordError(id, here.email, String(body.message).slice(0, 2000), body.stack ? String(body.stack).slice(0, 4000) : undefined);
      return new Response(null, { status: 204 });
    }
    const { meta, visit, member, backlinks, linkTitles } = opened as Extract<typeof opened, { meta: unknown }>;
    const token = await signToken(env.SESSION_SECRET, "frame", FRAME_TTL, { id, e: here.email, w: slug });
    return shellPage(
      {
        artifactId: id,
        title: meta.title,
        version: meta.version,
        frameUrl: `/frame/${id}?v=${meta.version}&t=${encodeURIComponent(token)}`,
        syncUrl: `/a/${id}/sync`,
        viewer: { email: here.email, role: role as Role },
        apex: apexOrigin(env),
        ...(backlinks?.length ? { backlinks } : {}),
        ...(linkTitles && Object.keys(linkTitles).length ? { linkTitles } : {}),
        member: Boolean(member),
        admin: member === "admin" && !scoped,
        scoped,
        ...(meta.archivedAt ? { archivedAt: meta.archivedAt } : {}),
        ...(visit ? { since: visit.since, readSeq: visit.readSeq, watch: visit.watch, ...(scoped ? {} : { pinned: visit.pinned }) } : {}),
      },
      brand,
      // Anyone outside the workspace can report what they were sent; it sits outside the frame, so a page can't hide it.
      member ? undefined : `${apexOrigin(env)}/report?url=${encodeURIComponent(`${url.origin}/a/${id}`)}`,
    );
  }

  return messagePage("Not found", "There's nothing here.", 404, undefined, brand);
}

/**
 * Email someone who was just added (as a member, or a workspace's first admin).
 * Returns whether it went out; a full daily quota or a send failure never
 * fails the action that triggered it.
 */
async function invite(env: Env, hub: HubApi, to: string, input: { workspace: string; url: string; by: string | null; role: string }): Promise<boolean> {
  try {
    if (isTestAddress(to) || !(await hub.allowMail(1))) return false;
    await sendInvite(env, to, input);
    return true;
  } catch (err) {
    console.error("invite email failed", err);
    return false;
  }
}

/**
 * Note a sign-in to a workspace: members' "last seen", or the workspace among a
 * guest's on the apex. `join`: a real sign-in, which may join by email domain.
 */
async function noteSignIn(env: Env, slug: string, email: string, join = true) {
  try {
    if (!(await workspaceHub(env, slug).signedIn(email, join))) await directory(env).recordVisit(email, slug);
  } catch (err) {
    console.error("noting sign-in failed", err);
  }
}

// ---- apex: front door, sign-in, account and operator -------------------------------------

/** Public apex pages search engines may index (pricing only exists with billing on). */
const indexablePages = (env: Env) => ["/", "/help", "/privacy", "/terms", "/security", ...(billingOn(env) ? ["/pricing"] : [])];

/** Opt a public apex page out of the default noindex (see the fetch handler). */
function indexable(response: Response): Response {
  response.headers.set("X-Robots-Tag", "all");
  return response;
}

async function apex(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const brand = apexBrand(env);
  // ?deep=1 also reaches the directory, so an uptime monitor notices when it's down.
  if (path === "/healthz") {
    if (url.searchParams.get("deep") === "1") await directory(env).workspace("healthz");
    return new Response("ok", { headers: { "Cache-Control": "no-store" } });
  }
  // Search engines may index the front page, help, pricing and the policies, nothing else.
  if (path === "/robots.txt") {
    const allow = indexablePages(env).map((p) => `Allow: ${p === "/" ? "/$" : `${p}$`}\n`).join("");
    return new Response(`User-agent: *\n${allow}Disallow: /\n\nSitemap: ${apexOrigin(env)}/sitemap.xml\n`, { headers: { "Content-Type": "text/plain" } });
  }
  if (path === "/sitemap.xml") {
    const urls = indexablePages(env).map((p) => `<url><loc>${apexOrigin(env)}${p}</loc></url>`).join("");
    return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`, {
      headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" },
    });
  }
  if (PREVIEW_BOT.test(request.headers.get("User-Agent") ?? "")) return previewPage({ url: url.href, origin: url.origin, title: PRODUCT, description: DESCRIPTION });
  const viewer = await currentViewer(request, env);
  const operator = viewer.email !== null && operatorEmails(env).has(viewer.email);

  // The front page is the same for everyone; signed in, it links to /workspaces.
  if (path === "/") return indexable(splashPage(brand, url.searchParams.get("deleted") === "account" ? "Your account is deleted." : undefined, viewer.email ? { email: viewer.email, operator } : undefined, billingOn(env), env.SELF_SERVE === "on"));
  if (path === "/workspaces") {
    if (!viewer.email) return Response.redirect(`${url.origin}/login?return=/workspaces`, 302);
    const selfServe = env.SELF_SERVE === "on";
    const list = async () => (await directory(env).membershipsOf(viewer.email!)).map((w) => ({ ...w, url: workspaceOrigin(env, w.slug) }));
    // Once they've made their one workspace, there's no form to fill in only to be told no.
    // A full day shows as such up front, rather than after filling in the form.
    const create = async (state: { error?: string; name?: string; slug?: string } = {}) => {
      if (!selfServe || !(state.error || (await directory(env).canMakeWorkspace(viewer.email!)))) return null;
      return { ...state, suffix: env.WORKSPACE_SUFFIX, full: !state.error && (await directory(env).selfServeFullToday()) };
    };
    if (request.method === "POST") {
      if (!selfServe) return new Response("not found", { status: 404 });
      if (!sameOrigin(request, url)) return new Response("bad origin", { status: 403 });
      const form = await request.formData().catch(() => new FormData());
      const name = String(form.get("name") ?? "").trim().slice(0, 80);
      const slug = String(form.get("slug") ?? "").trim().toLowerCase();
      const made = await createOwnWorkspace(env, viewer.email, { name, slug, terms: form.get("terms") === "on" });
      if ("location" in made) return continuePage(made.location);
      const res = workspacesPage(viewer.email, await list(), operator, brand, await create({ error: made.error, name, slug }), undefined, billingOn(env));
      return new Response(res.body, { status: 400, headers: res.headers });
    }
    const deleted = url.searchParams.get("deleted");
    const left = url.searchParams.get("left");
    const unread = await directory(env).unreadCount(viewer.email);
    const note = deleted ? `Deleted ${deleted.slice(0, 80)}.` : left ? `You left ${left.slice(0, 80)}.` : unread ? `${unread} new in your inbox.` : undefined;
    return workspacesPage(viewer.email, await list(), operator, brand, await create(), note, billingOn(env));
  }
  if (path === "/login") return apexLogin(request, url, env, viewer, brand);
  if (path === "/login/passkey/options" && request.method === "POST") {
    if (!sameOrigin(request, url)) return Response.json({ error: "bad origin" }, { status: 403 });
    return Response.json(await signInOptions(env));
  }
  if (path === "/login/passkey" && request.method === "POST") return passkeyLogin(request, url, env);
  if (path === "/privacy" || path === "/terms" || path === "/security") {
    return indexable(policyPage(path.slice(1) as PolicyKind, brand, contactEmail(env), billingOn(env)));
  }
  if (path === "/report") return reportRoute(request, url, env, brand);
  if (path === "/help") return indexable(helpPage(brand, contactEmail(env)));
  if (path === "/support") return supportRoute(request, url, env, viewer.email ? { email: viewer.email, operator } : null, brand);
  if (path === "/inbox") return inboxRoute(request, url, env, viewer.email ? { email: viewer.email, operator } : null, brand);
  if (path === "/api/client-error" && request.method === "POST") return clientError(request, env);
  // Billing: the pricing page and the payment provider's webhook, only while billing is on.
  if (path === "/pricing" && billingOn(env)) return indexable(pricingPage(brand, env.SELF_SERVE === "on", viewer.email ? { email: viewer.email, operator } : undefined));
  if (path === "/api/billing/webhook" && request.method === "POST") return billingWebhook(request, env);
  if (path === "/logout" && request.method === "POST") {
    if (!sameOrigin(request, url)) return new Response("bad origin", { status: 403 });
    return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": clearSessionCookie() } });
  }
  // Where a workspace's Sign out lands: end the apex session too, so the next sign-in asks again.
  if (path === "/signed-out") {
    const res = splashPage(brand, "You're signed out. Other workspaces you opened sign out separately.", undefined, billingOn(env), env.SELF_SERVE === "on");
    res.headers.append("Set-Cookie", clearSessionCookie());
    return res;
  }
  if (path === "/me") {
    if (!viewer.email) return Response.redirect(`${url.origin}/login?return=/me`, 302);
    return profilePage(viewer.email, "account", brand, Boolean(env.VAPID_PUBLIC_KEY), Boolean(env.PUSHOVER_TOKEN));
  }
  if (path === "/api/me" || path.startsWith("/api/me/")) return accountApi(request, url, env, viewer);
  if (path === "/admin") {
    if (!viewer.email) return Response.redirect(`${url.origin}/login?return=/admin`, 302);
    if (!operator) return messagePage("Not available", "This page is for whoever runs this deployment.", 403, undefined, brand);
    return adminPage(viewer.email, brand);
  }
  if (path.startsWith("/api/admin/")) return operatorApi(request, url, env, viewer, ctx);
  return messagePage("Not found", "There's nothing here.", 404, undefined, brand);
}

/** What settings shows an admin about paying: the price, whether checkout works yet, and the subscription. */
/**
 * What deleting this person's account means: workspaces where they're the only member go with it;
 * the rest they leave (anything they made passes to another admin). Refused while they're the
 * last admin of a workspace with other people, or one of theirs is still billed.
 */
async function accountDeletion(env: Env, email: string) {
  const dir = directory(env);
  const blockers: string[] = [];
  const deletes: { slug: string; name: string }[] = [];
  const leaves: { slug: string; name: string; heir: string | null }[] = [];
  const guestOf: { slug: string; name: string }[] = [];
  for (const w of await dir.membershipsOf(email)) {
    if (w.role === "guest") {
      guestOf.push({ slug: w.slug, name: w.name });
      continue;
    }
    // A workspace whose data is already gone (an earlier attempt stopped partway) only needs its record removed.
    // A workspace whose data is already gone (an earlier attempt stopped partway) only needs its record removed;
    // one that's merely unreachable right now is never treated as gone.
    const hub = workspaceHub(env, w.slug);
    if (!(await hub.exists())) {
      deletes.push({ slug: w.slug, name: w.name });
      continue;
    }
    const members = await hub.members();
    const others = members.filter((m) => m.email !== email);
    const otherAdmins = others.filter((m) => m.role === "admin");
    const record = await dir.billing(w.slug);
    const billed = record && subscriptionMayCharge(record.status);
    if (!others.length) {
      if (billed) blockers.push(`${w.name} still has a subscription: cancel it in its settings (Manage billing) first.`);
      else deletes.push({ slug: w.slug, name: w.name });
    } else if (w.role === "admin" && !otherAdmins.length) {
      blockers.push(`You're the only admin of ${w.name}: make someone else an admin there first.`);
    } else {
      if (billed && record?.payerEmail === email) blockers.push(`You pay for ${w.name}: cancel it in its settings (Manage billing), or ask us to move billing.`);
      const mine = (await dir.workspace(w.slug))?.createdBy === personKey(email);
      leaves.push({ slug: w.slug, name: w.name, heir: mine ? (otherAdmins[0]?.email ?? null) : null });
    }
  }
  return { blockers, deletes, leaves, guestOf };
}

/** Self-serve workspaces belong to whoever made them. */
async function ownWorkspace(env: Env, slug: string, email: string): Promise<boolean> {
  const record = await directory(env).workspace(slug);
  return Boolean(record?.createdBy && record.createdBy === personKey(email));
}

async function billingState(env: Env, slug: string) {
  const record = await directory(env).billing(slug);
  return {
    ready: billingReady(env),
    price: TEAM_PRICE,
    subscription: record ? { status: record.status, periodEnd: record.periodEnd, manageable: Boolean(record.customerId), payer: record.payerEmail } : null,
  };
}

/**
 * The payment provider's webhook: verified by its signature, recorded in the
 * directory (repeats and late, older events do nothing), and the workspace
 * moved to the plan the subscription now pays for.
 */
async function billingWebhook(request: Request, env: Env): Promise<Response> {
  if (!billingOn(env) || !env.CREEM_WEBHOOK_SECRET) return new Response("not found", { status: 404 });
  const raw = await request.text();
  if (!(await verifyWebhook(env.CREEM_WEBHOOK_SECRET, raw, request.headers.get("creem-signature")))) {
    // A burst of these after a deploy usually means CREEM_WEBHOOK_SECRET doesn't match Creem's.
    await ops(env, { kind: "billing_bad_signature", message: "A billing webhook failed its signature check. If payments stop moving workspaces, check CREEM_WEBHOOK_SECRET.", alert: "billing_bad_signature" });
    return Response.json({ error: "bad signature" }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return Response.json({ error: "bad JSON" }, { status: 400 });
  }
  const update = readEvent(payload);
  if (!update) {
    // Events we don't act on are expected; one about a subscription we couldn't read isn't.
    const e = payload as { id?: string; eventType?: string; object?: Record<string, unknown> & { object?: string; subscription?: unknown } };
    const type = String(e?.eventType ?? "");
    // Refunds and disputes don't change the plan by themselves: the operator decides (End billing in the console).
    if (type.startsWith("refund.") || type.startsWith("dispute.")) {
      const slug = await refundWorkspace(env, e?.object);
      await ops(env, {
        kind: "billing_refund_or_dispute",
        slug,
        message: `Creem sent ${type}${slug ? ` for ${slug}` : ""}. The plan hasn't changed: if Team should end now, use End billing in the operator console.`,
        detail: { eventId: e?.id, eventType: type },
        alert: true,
      });
      return Response.json({ ignored: true });
    }
    const aboutSubscription = e?.object?.object === "subscription" || Boolean(e?.object?.subscription) || type.startsWith("subscription.");
    await ops(env, {
      kind: aboutSubscription ? "billing_event_unread" : "billing_event_ignored",
      message: aboutSubscription ? "A subscription webhook couldn't be read: has Creem changed its payload? The workspace's plan didn't change." : `Ignored billing event ${e?.eventType ?? "?"}.`,
      detail: { eventId: e?.id, eventType: e?.eventType },
      alert: aboutSubscription ? "billing_event_unread" : false,
    });
    return Response.json({ ignored: true });
  }
  try {
    return await applyBillingEvent(env, update);
  } catch (err) {
    // Creem retries a failed delivery for about a day; if it keeps failing, someone paid and nothing happened.
    await ops(env, {
      kind: "billing_apply_failed",
      slug: update.workspace,
      message: `Applying a billing event failed (Creem will retry): ${(err as Error).message}. If it persists, fix the plan with Resync plan in the operator console.`,
      detail: { eventId: update.eventId, subscriptionId: update.subscriptionId, status: update.status },
      alert: true,
    });
    throw err;
  }
}

/** KV: a workspace's checkout started in the last 15 minutes. */
const CHECKOUT_PREFIX = "checkout:";

/**
 * Which workspace a refund or dispute is about: from metadata on it or on what it's nested with (its
 * subscription, checkout or transaction), else by its subscription's id.
 */
async function refundWorkspace(env: Env, object: Record<string, unknown> | undefined): Promise<string | undefined> {
  if (!object) return undefined;
  const nested = ["subscription", "checkout", "transaction", "order"].map((k) => object[k]).filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null);
  for (const o of [object, ...nested]) {
    const ws = (o.metadata as { workspace?: unknown } | undefined)?.workspace;
    if (typeof ws === "string") return ws;
  }
  const subId = [object.subscription, ...nested.map((o) => o.subscription), ...nested.filter((o) => o.object === "subscription").map((o) => o.id)].find((v): v is string => typeof v === "string");
  return subId ? ((await directory(env).slugForSubscription(subId)) ?? undefined) : undefined;
}

async function applyBillingEvent(env: Env, update: NonNullable<ReturnType<typeof readEvent>>): Promise<Response> {
  const before = update.workspace ? await directory(env).billing(update.workspace) : null;
  const applied = await directory(env).applyBilling(update, "creem");
  if (!applied) {
    // Someone paid for a workspace we can't find (deleted mid-checkout?): refund them.
    if (update.plan === "team" && update.workspace) {
      await ops(env, {
        kind: "billing_unknown_workspace",
        slug: update.workspace,
        message: `A subscription paid for ${update.workspace}, which doesn't exist (deleted during checkout, or since made again by someone else). Refund and cancel it in Creem.`,
        detail: { eventId: update.eventId, subscriptionId: update.subscriptionId },
        alert: true,
      });
    }
    return Response.json({ ok: true, ignored: true });
  }
  if (applied.replaced) {
    await ops(env, {
      kind: "billing_replaced",
      slug: applied.slug,
      message: `${applied.slug} has a new subscription (${update.subscriptionId}) replacing ${applied.replaced}. Check the old one is canceled in Creem, or they pay twice.`,
      detail: { eventId: update.eventId, subscriptionId: update.subscriptionId, replaced: applied.replaced },
      alert: true,
    }).catch(() => {});
  }
  // Two webhooks at once can finish in either order, so settle on what the record says now.
  let plan = applied.plan;
  let until = applied.until;
  for (let i = 0; i < 3; i++) {
    await workspaceHub(env, applied.slug).setPlan(plan, until);
    const now = await directory(env).billingPlan(applied.slug);
    if (!now || (now.plan === plan && now.until === until)) break;
    ({ plan, until } = now);
  }
  // The plan is set; telling the operator mustn't make Creem retry (or raise a misleading "apply failed").
  try {
    const after = await directory(env).billing(applied.slug);
    if (after && after.status !== before?.status) {
      const what: Record<string, string> = {
        active: "subscribed to Team",
        trialing: "started a Team trial",
        past_due: "has a failed payment (Team kept while Creem retries)",
        unpaid: "has an unpaid subscription",
        canceled: "canceled Team",
        scheduled_cancel: "scheduled a cancel",
        paused: "paused its subscription",
        expired: "has an expired subscription",
      };
      await ops(env, {
        kind: "billing",
        slug: applied.slug,
        message: `${applied.slug} ${what[after.status] ?? `is now ${after.status}`}${after.payerEmail ? ` (billed to ${after.payerEmail})` : ""}. Plan now: ${plan}${until ? ` until ${until.slice(0, 10)}` : ""}.`,
        detail: { eventId: update.eventId, subscriptionId: update.subscriptionId, status: after.status },
        alert: `billing:${applied.slug}:${after.status}`,
      });
    }
  } catch (err) {
    console.error("billing note failed", applied.slug, err);
  }
  return Response.json({ ok: true, workspace: applied.slug, plan, ...(until ? { until } : {}) });
}

/**
 * Self-serve: make a Free workspace with this person as its admin, then send
 * them into it, signed in, at its settings (where the agent gets connected).
 */
async function createOwnWorkspace(env: Env, email: string, input: { name: string; slug: string; terms: boolean }): Promise<{ location: string } | { error: string }> {
  if (!input.name) return { error: "Give the workspace a name." };
  if (!validSlug(input.slug)) return { error: "Pick an address of 3-32 lowercase letters, digits and single hyphens, starting with a letter." };
  if (!input.terms) return { error: "Agree to the terms and privacy policy to continue." };
  try {
    await directory(env).createOwnWorkspace(email, input.slug, input.name, POLICY_UPDATED, contactEmail(env));
  } catch (err) {
    return { error: publicMessage(err).message };
  }
  const hub = workspaceHub(env, input.slug);
  try {
    await hub.provision({ slug: input.slug, name: input.name, admin: email, plan: "free" });
  } catch (err) {
    console.error("provisioning a self-serve workspace failed", err);
    // Nothing half-made stays behind, and the slot is free to try again.
    await hub.destroy(input.slug).catch((e) => console.error("cleaning up the workspace failed", e));
    await directory(env).removeWorkspace(input.slug).catch((e) => console.error("removing the workspace record failed", e));
    return { error: "Something went wrong making the workspace. Try again." };
  }
  forgetWorkspaces();
  await ops(env, { kind: "signup", slug: input.slug, message: `${email} made “${input.name}” (${input.slug}) on Free.`, alert: `signup:${input.slug}` });
  return { location: `${workspaceOrigin(env, input.slug)}/login?return=${encodeURIComponent("/settings")}` };
}

/**
 * Email sign-in: ask for an address, email a code, check it. With
 * `to` (a workspace origin) the browser is then handed to that workspace.
 */
async function apexLogin(request: Request, url: URL, env: Env, viewer: Viewer, brand: Brand): Promise<Response> {
  const form = request.method === "POST" ? await request.formData().catch(() => new FormData()) : null;
  const field = (k: string) => String(form?.get(k) ?? url.searchParams.get(k) ?? "").trim();
  const to = field("to");
  const nonce = field("n");
  // Signing in on the apex itself ends at your workspaces; a workspace hand-off at its front page.
  const ret = field("return") ? safeNext(field("return")) : to ? "/" : "/workspaces";
  const state = { to, n: nonce, return: ret };
  if (!form) {
    if (url.searchParams.get("switch") === "1" || url.searchParams.get("fresh") === "1") {
      // Signing in as someone else: ask for the email. The apex session is replaced when they sign in, not cleared
      // here, so a link to this page can't sign anyone out.
      return loginPage({ ...state, step: "email" }, brand);
    }
    // Handed off from an existing session: the workspace's session keeps its sign-in time, so an old cookie can't be
    // turned into a "recent sign-in" there.
    if (viewer.email) return finishLogin(viewer.email, to, nonce, ret, env, false, viewer.iat ?? nowSeconds());
    return loginPage({ ...state, step: "email" }, brand);
  }
  if (!sameOrigin(request, url)) return new Response("bad origin", { status: 403 });
  const email = field("email").toLowerCase();
  if (!/^[^\s@]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email)) return loginPage({ ...state, step: "email", email, error: "Enter a valid email address." }, brand, 400);
  if (form.has("code")) {
    if (!(await directory(env).verifyLogin(email, field("code"), clientNetwork(request)))) {
      return loginPage({ ...state, step: "code", email, error: "That code didn't work. Check it, or send a new one." }, brand, 400);
    }
    // Offer a passkey so next time needs no email, unless they have one or said "Not now" lately.
    // Continuing goes back through GET /login, which hands off to the workspace afresh (a minute).
    const res = readCookie(request, PASSKEY_LATER_COOKIE) || (await directory(env).passkeys(email)).length
      ? await finishLogin(email, to, nonce, ret, env, true, nowSeconds())
      : passkeyOfferPage(to ? `/login?${new URLSearchParams({ to, n: nonce, return: ret })}` : ret, brand);
    const session = await signToken(env.SESSION_SECRET, "session", SESSION_TTL, { e: email, h: env.APEX_HOST, iat: nowSeconds() });
    res.headers.append("Set-Cookie", sessionCookie(session));
    return res;
  }
  let code: string;
  try {
    code = await directory(env).startLogin(email, clientNetwork(request));
  } catch (err) {
    // Rate limits; the message is written for the person signing in.
    return loginPage({ ...state, step: "email", email, error: (err as Error).message }, brand, 429);
  }
  try {
    await sendCode(env, email, code);
  } catch (err) {
    // If sending fails for everyone, nobody can sign in (or pay): worth an email, once an hour.
    await ops(env, { kind: "signin_email_failed", message: `A sign-in email failed: ${(err as Error).message}`, detail: { domain: email.split("@")[1] }, alert: "signin_email_failed" });
    return loginPage({ ...state, step: "email", email, error: "We couldn't send the email. Try again in a moment." }, brand, 502);
  }
  return loginPage({ ...state, step: "code", email }, brand);
}

/** The client's network for rate limits: its IPv4 address, or its IPv6 /64 (one host can hold a whole /64). */
export function clientNetwork(request: Request): string | null {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || !ip.includes(":")) return ip;
  const full = ip.includes("::") ? expandIpv6(ip) : ip.split(":");
  return `${full.slice(0, 4).join(":")}::/64`;
}

function expandIpv6(ip: string): string[] {
  const [head, tail] = ip.split("::");
  const a = head ? head.split(":") : [];
  const b = tail ? tail.split(":") : [];
  return [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
}

/** Where a signed-in browser goes next: a workspace's callback with a one-minute hand-off code, or null for a page here. */
async function handoff(email: string, to: string, nonce: string, ret: string, env: Env, iat: number): Promise<string | null> {
  let target: URL | null = null;
  try {
    target = to ? new URL(to) : null;
  } catch {
    target = null;
  }
  if (!target || target.protocol !== "https:" || !slugOf(target.hostname, env) || target.origin !== to) return null;
  const code = await signToken(env.LOGIN_SECRET, "login", 60, { e: email, aud: target.origin, n: nonce, iat });
  const callback = new URL(`${target.origin}/auth/callback`);
  callback.searchParams.set("code", code);
  callback.searchParams.set("next", ret);
  return callback.href;
}

/** Send a signed-in browser on: to a workspace via a one-minute hand-off code, or to a page here. */
async function finishLogin(email: string, to: string, nonce: string, ret: string, env: Env, fromForm: boolean, iat: number): Promise<Response> {
  const callback = await handoff(email, to, nonce, ret, env, iat);
  // After the code form, a redirect to the workspace would be blocked (see continuePage).
  if (callback) return fromForm ? continuePage(callback) : new Response(null, { status: 303, headers: { Location: callback } });
  return new Response(null, { status: 303, headers: { Location: ret } });
}

/**
 * Passkey sign-in (login.js posts the browser's response): signs this browser
 * in on the apex and says where to go next, the same places a code leads.
 */
async function passkeyLogin(request: Request, url: URL, env: Env): Promise<Response> {
  if (!sameOrigin(request, url)) return Response.json({ error: "bad origin" }, { status: 403 });
  const body = await jsonBody(request);
  const to = String(body.to ?? "");
  const ret = body.return ? safeNext(String(body.return)) : to ? "/" : "/workspaces";
  let email: string;
  try {
    email = await verifySignIn(env, directory(env), String(body.token ?? ""), body.response as never);
  } catch (err) {
    if (err instanceof PasskeyError) return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }
  const location = (await handoff(email, to, String(body.n ?? ""), ret, env, nowSeconds())) ?? ret;
  const session = await signToken(env.SESSION_SECRET, "session", SESSION_TTL, { e: email, h: env.APEX_HOST, iat: nowSeconds() });
  return Response.json({ location }, { headers: { "Set-Cookie": sessionCookie(session) } });
}

async function authCallback(request: Request, url: URL, env: Env): Promise<Response> {
  const claims = await verifyToken<{ e: string; aud: string; n: string; iat?: number }>(env.LOGIN_SECRET, "login", url.searchParams.get("code"));
  const nonce = readCookie(request, NONCE_COOKIE);
  if (!claims || claims.aud !== url.origin || !nonce || !claims.n || !timingSafeEqual(claims.n, nonce)) {
    return messagePage("Sign-in failed", "That sign-in link expired. Try again.", 400, { href: "/login", label: "Sign in" });
  }
  const email = claims.e.toLowerCase();
  const session = await signToken(env.SESSION_SECRET, "session", SESSION_TTL, { e: email, h: url.hostname, iat: typeof claims.iat === "number" ? Math.min(claims.iat, nowSeconds()) : nowSeconds() });
  const slug = slugOf(url.hostname, env);
  if (slug) await noteSignIn(env, slug, email);
  const headers = new Headers({ Location: safeNext(url.searchParams.get("next")) });
  headers.append("Set-Cookie", sessionCookie(session));
  headers.append("Set-Cookie", `${NONCE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
  return new Response(null, { status: 303, headers });
}

/**
 * Presigned sign-in link (from artifact_link / artifact_share): signs this
 * browser in as the link's email and opens the artifact. The link only grants
 * what that email already has, so unsharing still cuts it off.
 */
async function presignedSignIn(request: Request, code: string, url: URL, env: Env, hub: HubApi, slug: string, brand: Brand, session: Viewer): Promise<Response> {
  const claims = await verifyToken<{ e: string; a: string; w: string; exp: number }>(env.LOGIN_SECRET, "link", code);
  if (!claims || claims.w !== slug) {
    return messagePage("Link expired", "This link has expired or is invalid. Ask for a new one, or sign in with your email.", 400, { href: "/login?return=/", label: "Sign in" }, brand);
  }
  const email = claims.e.toLowerCase();
  const target = `/a/${claims.a}`;
  if (!(await hub.roleFor(claims.a, email))) {
    return messagePage("Not available", `${email} doesn't have access to this artifact anymore.`, 403, { href: `/switch?return=${encodeURIComponent(target)}`, label: "Sign in with a different email" }, brand);
  }
  // Already signed in here as this person: keep the full session.
  if (session.email === email && !session.only) return new Response(null, { status: 303, headers: { Location: target } });
  // Signed in as someone else: ask before switching, so a link can't silently swap who you are.
  if (session.email && session.email !== email && request.method !== "POST") return linkSwitchPage(url, session.email, email, brand);
  if (request.method === "POST" && !sameOrigin(request, url)) return new Response("bad origin", { status: 403 });
  // The session opens this artifact only, and lasts no longer than the link; signing in with email gives the rest.
  const ttl = Math.max(60, Math.min(SESSION_TTL, Math.floor(claims.exp - Date.now() / 1000)));
  const cookie = await signToken(env.SESSION_SECRET, "session", ttl, { e: email, h: url.hostname, a: claims.a, iat: nowSeconds() });
  await noteSignIn(env, slug, email, false);
  return new Response(null, {
    status: 303,
    headers: { Location: target, "Set-Cookie": sessionCookie(cookie, ttl), "Referrer-Policy": "no-referrer" },
  });
}

// ---- sessions ------------------------------------------------------------------------

/** Session cookies are per host, and each names its host so one can't be replayed on another. */
async function currentViewer(request: Request, env: Env): Promise<Viewer> {
  const claims = await verifyToken<{ e: string; h: string; a?: string; iat?: number }>(env.SESSION_SECRET, "session", readCookie(request, SESSION_COOKIE));
  if (!claims || claims.h !== new URL(request.url).hostname) return { email: null };
  // Signed in before they signed out everywhere (or deleted the account): that session is over.
  const iat = claims.iat ?? claims.exp - SESSION_TTL;
  if (iat < (await signedOutAt(env, claims.e))) return { email: null };
  return claims.a ? { email: claims.e, only: claims.a, exp: claims.exp, iat } : { email: claims.e, iat };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const SIGNED_OUT_PREFIX = "signed-out:";
const signedOutCache = new Map<string, { at: number; value: number }>();

/** When this person last signed out everywhere (seconds; 0 if never). One KV read a minute per isolate at most. */
async function signedOutAt(env: Env, email: string): Promise<number> {
  const hit = signedOutCache.get(email);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const raw = env.OAUTH_KV ? await env.OAUTH_KV.get(`${SIGNED_OUT_PREFIX}${email}`, { cacheTtl: 60 }).catch(() => null) : null;
  const value = Number(raw ?? 0) || 0;
  if (signedOutCache.size > 5000) signedOutCache.clear();
  signedOutCache.set(email, { at: Date.now(), value });
  return value;
}

/** Ends every session this person has, everywhere (within about a minute, as KV spreads). */
async function signOutEverywhere(env: Env, email: string) {
  const now = nowSeconds();
  await env.OAUTH_KV.put(`${SIGNED_OUT_PREFIX}${email}`, String(now), { expirationTtl: SESSION_TTL + 86_400 });
  signedOutCache.set(email, { at: Date.now(), value: now });
  // Agents too: a stolen session could have connected one. Their tokens and connections end, and open pages close.
  const memberships = await Promise.resolve()
    .then(() => directory(env).membershipsOf(email))
    .catch((err: Error) => {
      console.error(JSON.stringify({ ops: "sign_out_everywhere_partial", message: err.message }));
      return [];
    });
  for (const w of memberships) {
    try {
      const hub = workspaceHub(env, w.slug);
      await hub.endSessions(email);
      await revokeGrants(env, workspaceOrigin(env, w.slug), w.slug, email, hub);
    } catch (err) {
      console.error(JSON.stringify({ ops: "sign_out_everywhere_partial", slug: w.slug, message: (err as Error).message }));
    }
  }
}

/** Actions that take over or end an account need a sign-in in the last half hour (a stolen cookie isn't enough). */
const RECENT_SIGN_IN_S = 30 * 60;
const recentlySignedIn = (viewer: Viewer) => typeof viewer.iat === "number" && nowSeconds() - viewer.iat < RECENT_SIGN_IN_S;

/**
 * Sliding sessions: a visit more than a day after the cookie was issued gets a
 * fresh 30-day cookie, so a session only lapses after 30 days without use.
 */
async function renewSession(request: Request, env: Env, response: Response) {
  if (response.status === 101 || response.headers.has("Set-Cookie")) return;
  const claims = await verifyToken<{ e: string; h: string; a?: string; iat?: number }>(env.SESSION_SECRET, "session", readCookie(request, SESSION_COOKIE));
  // Link sessions end when their link would have; only real sign-ins slide (keeping when they signed in).
  if (!claims || claims.a || claims.h !== new URL(request.url).hostname || claims.exp - Date.now() / 1000 > SESSION_TTL - 86400) return;
  const iat = claims.iat ?? claims.exp - SESSION_TTL;
  if (iat < (await signedOutAt(env, claims.e))) return;
  const fresh = await signToken(env.SESSION_SECRET, "session", SESSION_TTL, { e: claims.e, h: claims.h, iat });
  try {
    response.headers.append("Set-Cookie", sessionCookie(fresh));
  } catch {
    // immutable headers (e.g. Response.redirect); the next page view renews instead
  }
}

function operatorEmails(env: Env): Set<string> {
  return new Set(
    (env.OPERATOR_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** A same-site path to go to next. Anything a browser could read as another origin becomes "/". */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || /[\\\x00-\x20\x7f]/.test(next)) return "/";
  const base = "https://same.invalid";
  try {
    const u = new URL(next, base);
    // "/.//evil.com" normalizes to the path "//evil.com", which a browser reads as another host.
    if (u.origin !== base || u.pathname.startsWith("//")) return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}

/**
 * Whether a state-changing request comes from our own page on this host. Form
 * posts from our pages carry `Origin: null` (they're served with
 * Referrer-Policy: no-referrer), so for those the browser's Sec-Fetch-Site,
 * which a page can't set, has to say same-origin.
 */
export function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  if (origin === url.origin) return true;
  return (origin === null || origin === "null") && request.headers.get("Sec-Fetch-Site") === "same-origin";
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  return (((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>) || {};
}

/** Validation errors from a Durable Object arrive as plain Errors over RPC, so every failure is shown as its message. */
/** A failed API call: the person's own mistake (400), or ours, recorded as a product error (500, with its code). */
async function failure(err: unknown, env: Env, request: Request): Promise<Response> {
  const { message, internal } = publicMessage(err);
  if (!internal) return Response.json({ error: message }, { status: 400 });
  const code = await recordProductError(env, { kind: "server", place: new URL(request.url).pathname, message: err instanceof Error ? err.message : String(err), browser: browserOf(request.headers.get("User-Agent")) });
  return Response.json({ error: `${message} (error ${code})`, errorId: code }, { status: 500 });
}

// ---- OAuth consent ---------------------------------------------------------------------

async function authorize(request: Request, url: URL, env: Env, hub: HubApi, viewer: Viewer, record: Routable, brand: Brand): Promise<Response> {
  // Not env.OAUTH_PROVIDER: the library sets that once per isolate, so it would
  // belong to whichever workspace this isolate served first.
  const oauth = oauthApi(url.origin, env);
  const local = (message: string, status = 400) => messagePage("Can't connect", message, status, undefined, brand);
  try {
    if (!viewer.email) return Response.redirect(`${url.origin}/login?return=${encodeURIComponent(url.pathname + url.search)}`, 302);
    const access = await hub.access(viewer.email);
    const member = access.member;
    if (!member) return local(`${viewer.email} isn't a member of ${record.name}, so it can't connect an agent here. Ask a workspace admin to add you.`, 403);
    const userId = grantUser(record.slug, viewer.email);
    const remember = { secret: env.CONSENT_SECRET, subject: userId };
    const complete = async (authRequest: Awaited<ReturnType<OAuthHelpers["parseAuthRequest"]>>, headers = new Headers()) => {
      const client = await oauth.lookupClient(authRequest.clientId);
      const name = client?.clientName ?? authRequest.clientId;
      const { redirectTo } = await oauth.completeAuthorization({
        request: authRequest,
        userId,
        metadata: { client: name, at: new Date().toISOString() },
        scope: authRequest.scope,
        props: { email: viewer.email!, slug: record.slug, ...(access.createdAt ? { gen: access.createdAt } : {}) } satisfies McpProps,
      });
      // The code is "<user>:<grant>:<secret>"; keep the grant so settings can show and revoke it.
      const grantId = new URL(redirectTo).searchParams.get("code")?.split(":")[1];
      if (grantId) await hub.recordGrant(grantId, viewer.email!, name);
      // From the consent form the redirect to the client would be blocked (see continuePage).
      if (request.method === "POST") return continuePage(redirectTo, headers);
      headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers });
    };
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      if (await oauth.isConsentRemembered(request, authRequest, remember)) return complete(authRequest);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      const page = consentPage(details, consent.handle, viewer.email, brand, member === "admin");
      for (const [k, v] of consent.headers) if (k.toLowerCase() !== "content-type") page.headers.append(k, v);
      return page;
    }
    if (request.method === "POST") {
      if (!sameOrigin(request, url)) return new Response("bad origin", { status: 403 });
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return continuePage(denied.redirectTo, denied.headers);
      }
      const approved = await oauth.approveConsent(request, handle, { remember: { ...remember, maxAgeSeconds: 90 * 86400 } });
      return complete(approved.request, approved.headers);
    }
    return new Response("method not allowed", { status: 405 });
  } catch (err) {
    if (err instanceof AuthorizationError && err.redirectTo) return Response.redirect(err.redirectTo, 302);
    if (err instanceof AuthorizationError) return local(err.description ?? "This sign-in request isn't valid. Start again from your agent.");
    if (err instanceof CimdFetchError) return local("This app could not be verified. Start again from your agent.");
    throw err;
  }
}

/** The OAuth library's user id for a person in one workspace (it may not contain ":"). */
function grantUser(slug: string, email: string): string {
  return `${slug}/${encodeURIComponent(email)}`;
}

/**
 * Revoke every OAuth grant a person holds in a workspace (when they leave it):
 * the ones the workspace recorded, and any the OAuth store lists (its list can
 * lag a minute behind, which is why the workspace records them too).
 */
async function revokeGrants(env: Env, origin: string, slug: string, email: string, hub: HubApi) {
  const oauth = oauthApi(origin, env);
  const userId = grantUser(slug, email);
  const ids = new Set(await hub.forgetGrants({ email }));
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(userId, { cursor });
    for (const g of page.items) ids.add(g.id);
    cursor = page.cursor;
  } while (cursor);
  for (const id of ids) await oauth.revokeGrant(id, userId);
}

// ---- workspace settings ------------------------------------------------------------------

/**
 * Workspace settings (session cookie, members only, same-origin JSON):
 * - GET    /api/settings                 workspace, you, members, tokens, connected apps, approved hosts, MCP URL
 * - POST   /api/settings/name {name}     rename (admin)
 * - POST   /api/settings/members {email, role|null}   add, change or remove (admin)
 * - POST   /api/settings/tokens {label}  new agent token for you (returned once)
 * - DELETE /api/settings/tokens/<id>     revoke (yours, or any as admin)
 * - DELETE /api/settings/apps/<grant>    disconnect one of your OAuth apps
 * - POST   /api/settings/hosts {host, allowed}   approve or revoke a live-data host (admin)
 * - POST   /api/settings/join {domain, allowed}  add or remove an auto-join email domain (admin)
 */
async function settingsApi(request: Request, url: URL, env: Env, hub: HubApi, viewer: Viewer, slug: string): Promise<Response> {
  const email = viewer.email;
  if (!email) return Response.json({ error: "sign in first" }, { status: 401 });
  if (request.method !== "GET" && !sameOrigin(request, url)) return Response.json({ error: "bad origin" }, { status: 403 });
  const { member, name } = await hub.access(email);
  if (!member) return Response.json({ error: "members only" }, { status: 403 });
  const admin = member === "admin";
  const adminOnly = () => Response.json({ error: "only workspace admins can do that" }, { status: 403 });
  const oauth = oauthApi(url.origin, env);
  try {
    const path = url.pathname;
    if (path === "/api/settings" && request.method === "GET") {
      return Response.json({
        workspace: { slug, name, url: url.origin },
        you: { email, role: member },
        mcpUrl: `${url.origin}/mcp`,
        mcpName: `artifacts-${slug}`,
        members: await hub.members(),
        tokens: await hub.tokens(admin ? undefined : email),
        apps: (await hub.grants(email)).map((g) => ({ id: g.id, client: g.client, createdAt: g.createdAt })),
        hosts: await hub.allowedHosts(),
        joinDomains: await hub.joinDomains(),
        plan: await hub.plan(),
        billing: billingOn(env) && admin ? await billingState(env, slug) : null,
        canDelete: admin && (await ownWorkspace(env, slug, email)),
      });
    }
    // Self-serve: whoever made the workspace can hand it to another admin, who can then delete it.
    if (path === "/api/settings/owner" && request.method === "POST") {
      if (!admin || !(await ownWorkspace(env, slug, email))) return Response.json({ error: "Only the person who made this workspace can hand it over." }, { status: 403 });
      const to = String((await jsonBody(request)).email ?? "").trim().toLowerCase();
      if (!(await hub.members()).some((m) => m.email === to && m.role === "admin") || to === email) {
        return Response.json({ error: "Hand it to another admin of this workspace." }, { status: 400 });
      }
      await directory(env).setCreator(slug, to);
      return Response.json({ owner: to });
    }
    // Self-serve: whoever made the workspace can delete it (and then make another), once nothing is billed.
    if (path === "/api/settings/delete" && request.method === "POST") {
      if (!admin || !(await ownWorkspace(env, slug, email))) return Response.json({ error: "Only the person who made this workspace can delete it. Email us if that's not possible." }, { status: 403 });
      const body = await jsonBody(request);
      if (body.confirm !== slug) return Response.json({ error: `Type ${slug} to confirm.` }, { status: 400 });
      const record = await directory(env).billing(slug);
      if (record && subscriptionMayCharge(record.status)) {
        return Response.json({ error: "Cancel the subscription in Manage billing first, so it stops charging." }, { status: 409 });
      }
      for (const m of await hub.members()) {
        await revokeGrants(env, url.origin, slug, m.email, hub).catch((err) => console.error("revoking grants failed", err));
      }
      await hub.destroy(slug);
      await directory(env).removeWorkspace(slug);
      forgetWorkspaces();
      return Response.json({ location: `${apexOrigin(env)}/workspaces?deleted=${encodeURIComponent(name)}` });
    }
    // Billing (admins): start paying for Team, or open the provider's portal to manage it.
    if (path === "/api/settings/billing/checkout" && request.method === "POST") {
      if (!admin) return adminOnly();
      const existing = await directory(env).billing(slug);
      // Canceled with paid time left is still Team, but subscribing again is how to keep it (the new one takes over).
      if ((await hub.plan()).id === "team" && existing?.status !== "canceled") return Response.json({ error: "This workspace is already on Team." }, { status: 400 });
      // A subscription that still exists would mean paying twice: put the plan right instead.
      if (existing && subscriptionLive(existing.status, existing.periodEnd)) {
        const fix = planFor(existing.status, existing.periodEnd);
        await hub.setPlan(fix.plan, fix.until);
        return Response.json({ error: existing.status === "paused" ? "This workspace's subscription is paused: resume it from Manage billing." : "This workspace already has a subscription; reload to see it." }, { status: 409 });
      }
      // Clicking Upgrade again soon after (the payment's webhook can lag) reopens the same checkout, which Creem
      // charges at most once, instead of starting a second one.
      // (Only this admin's, for this workspace: not one a workspace deleted and made again at the address started.)
      const created = (await directory(env).workspace(slug))?.createdAt ?? null;
      const key = `${CHECKOUT_PREFIX}${slug}:${created ?? ""}:${email}`;
      const recent = await env.OAUTH_KV.get(key).catch(() => null);
      if (recent) return Response.json({ url: recent });
      try {
        const checkout = await startCheckout(env, { workspace: slug, created, email, successUrl: `${url.origin}/settings?billing=done` });
        await env.OAUTH_KV.put(key, checkout, { expirationTtl: 15 * 60 }).catch(() => {});
        return Response.json({ url: checkout });
      } catch (err) {
        if (err instanceof BillingError) return Response.json({ error: err.message }, { status: 503 });
        throw err;
      }
    }
    if (path === "/api/settings/billing/portal" && request.method === "POST") {
      if (!admin) return adminOnly();
      const record = await directory(env).billing(slug);
      if (!record?.customerId) return Response.json({ error: "This workspace has no subscription to manage." }, { status: 400 });
      // The portal shows the payer's card and everything they pay for, so it's theirs alone.
      // Whoever paid, and only them (removing them doesn't hand it to anyone else). With no payer on record,
      // any admin; for anything else, we move it by hand.
      if (record.payerEmail && personKey(record.payerEmail) !== personKey(email)) {
        return Response.json({ error: `Billing is managed by ${record.payerEmail}, who paid for it. Ask them, or email ${contactEmail(env)} to move it.` }, { status: 403 });
      }
      try {
        return Response.json({ url: await portalLink(env, record.customerId) });
      } catch (err) {
        if (err instanceof BillingError) return Response.json({ error: err.message }, { status: 503 });
        throw err;
      }
    }
    // Export: the latest backup, streamed as JSON Lines (docs/EXPORT.md). Admins only: it's everything.
    if (path === "/api/settings/export" && request.method === "GET") {
      if (!admin) return adminOnly();
      if (!env.BACKUPS) return Response.json({ error: "backups aren't set up on this server" }, { status: 501 });
      const manifest = await latestManifest(env.BACKUPS, slug);
      if (url.searchParams.get("status") === "1") {
        return Response.json({ latest: manifest ? { run: manifest.run, at: manifest.at } : null, backingUp: (await hub.job())?.kind === "backup" });
      }
      if (!manifest) return Response.json({ error: "no backup yet; make one first" }, { status: 404 });
      const header = { format: "artifacts.boo/export@1", workspace: slug, docs: "https://github.com/micthiesen/artifacts.boo/blob/main/docs/EXPORT.md" };
      return new Response(exportRun(env.BACKUPS!, manifest, DATA_TABLES, header), {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Content-Disposition": `attachment; filename="${slug}-${manifest.run}.jsonl"`,
          "Cache-Control": "no-store",
        },
      });
    }
    if (path === "/api/settings/export" && request.method === "POST") {
      if (!admin) return adminOnly();
      return Response.json(await hub.requestBackup());
    }
    const body = await jsonBody(request);
    if (path === "/api/settings/name" && request.method === "POST") {
      if (!admin) return adminOnly();
      const info = await hub.rename(String(body.name ?? ""));
      forgetWorkspaces();
      return Response.json(info);
    }
    if (path === "/api/settings/members" && request.method === "POST") {
      if (!admin) return adminOnly();
      const role = body.role === null ? null : (String(body.role) as WorkspaceRole);
      const target = String(body.email ?? "").trim().toLowerCase();
      const existed = (await hub.members()).some((m) => m.email === target);
      // Whoever made the workspace owns it: another admin can't remove or demote them into owning it themselves.
      const made = (await directory(env).workspace(slug))?.createdBy;
      if (made && made === personKey(target) && role !== "admin" && target !== email) {
        return Response.json({ error: `${target} made this workspace. They can hand it over (or leave) themselves; email ${contactEmail(env)} if that's not possible.` }, { status: 409 });
      }
      const members = await hub.setMember(target, role, email);
      if (role === null) await revokeGrants(env, url.origin, slug, target, hub);
      // Whoever made a self-serve workspace owns it; if they're removed (or remove themselves), an admin does.
      if (role === null && (await directory(env).workspace(slug))?.createdBy === personKey(target)) {
        const heir = members.find((m) => m.role === "admin");
        if (heir) await directory(env).setCreator(slug, heir.email);
      }
      const emailed = role !== null && !existed && (await invite(env, hub, target, { workspace: name, url: url.origin, by: email, role }));
      return Response.json({ members, existed, emailed });
    }
    if (path === "/api/settings/tokens" && request.method === "POST") {
      // A token outlives sessions, so a stolen cookie mustn't be enough to mint one.
      if (!recentlySignedIn(viewer)) return Response.json({ error: "Sign in again to make a token.", reauth: true }, { status: 403 });
      return Response.json(await hub.createToken(email, String(body.label ?? "")));
    }
    const token = /^\/api\/settings\/tokens\/([a-z0-9]+)$/.exec(path);
    if (token && request.method === "DELETE") return Response.json({ revoked: await hub.revokeToken(token[1], email) });
    const app = /^\/api\/settings\/apps\/([A-Za-z0-9_-]+)$/.exec(path);
    if (app && request.method === "DELETE") {
      // Only your own: the grant must be one the workspace recorded for you. Revoked first, then forgotten.
      if (!(await hub.grants(email)).some((g) => g.id === app[1])) return Response.json({ error: "not found" }, { status: 404 });
      await oauth.revokeGrant(app[1], grantUser(slug, email));
      await hub.forgetGrants({ id: app[1], email });
      return Response.json({ revoked: true });
    }
    if (path === "/api/settings/hosts" && request.method === "POST") {
      if (!admin) return adminOnly();
      if (body.allowed !== false && !recentlySignedIn(viewer)) return Response.json({ error: "Sign in again to approve a host.", reauth: true }, { status: 403 });
      return Response.json({ hosts: await hub.setHostAllowed(String(body.host ?? ""), body.allowed !== false) });
    }
    if (path === "/api/settings/join" && request.method === "POST") {
      if (!admin) return adminOnly();
      return Response.json({ joinDomains: await hub.setJoinDomain(String(body.domain ?? ""), body.allowed !== false, email) });
    }
  } catch (err) {
    return await failure(err, env, request);
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

/**
 * Owner menu API (session cookie, same-origin JSON), for the artifact's owner and workspace admins:
 * - GET  /api/a/<id>               overview: meta, shares, history, errors, sources, assets, approved hosts, readers
 * - POST /api/a/<id>/<tool>        one of the owner-menu MCP tools, with the same arguments
 * - POST /api/hosts {host, allowed} approve or revoke a live-data host (workspace admins)
 */
async function ownerApi(request: Request, url: URL, env: Env, hub: HubApi, viewer: Viewer, slug: string): Promise<Response> {
  if (!viewer.email) return Response.json({ error: "sign in first" }, { status: 401 });
  if (request.method !== "GET" && !sameOrigin(request, url)) return Response.json({ error: "bad origin" }, { status: 403 });
  if (url.pathname === "/api/hosts" && request.method === "POST") {
    if ((await hub.access(viewer.email)).member !== "admin") return Response.json({ error: "only workspace admins approve data hosts" }, { status: 403 });
    const body = await jsonBody(request);
    try {
      return Response.json({ hosts: await hub.setHostAllowed(String(body.host ?? ""), body.allowed !== false) });
    } catch (err) {
      return await failure(err, env, request);
    }
  }
  const m = /^\/api\/a\/([a-z0-9]+)(?:\/([a-z_]+))?$/.exec(url.pathname);
  if (!m) return Response.json({ error: "not found" }, { status: 404 });
  const [, id, action] = m;
  if ((await hub.roleFor(id, viewer.email)) !== "owner") return Response.json({ error: "owner only" }, { status: 403 });
  const ctx: Ctx = { hub, origin: url.origin, env, slug, person: viewer.email, actor: viewer.email };
  if (!action && request.method === "GET") {
    const meta = await hub.meta(id);
    if (!meta) return Response.json({ error: "not found" }, { status: 404 });
    const [history, errors, sources, assets, hosts, readers] = await Promise.all([
      hub.history(id), hub.errors(id), hub.sources(id), hub.assets(id), hub.allowedHosts(), hub.readers(id),
    ]);
    return Response.json({ meta, history, errors, sources, assets, hosts, readers });
  }
  if (action && request.method === "POST") {
    const r = await runOwnerTool(action, { ...(await jsonBody(request)), id }, ctx);
    return Response.json({ ok: !r.isError, text: r.text, data: r.structured ?? null }, { status: r.isError ? 400 : 200 });
  }
  return Response.json({ error: "method not allowed" }, { status: 405 });
}

/**
 * Per-artifact notification levels in this workspace (session cookie, same-origin JSON):
 * - GET  /api/me                     your levels here
 * - POST /api/me/watch {id, level}   set one (null resets to the default)
 */
async function workspaceMeApi(request: Request, url: URL, env: Env, hub: HubApi, viewer: Viewer): Promise<Response> {
  const email = viewer.email;
  if (!email) return Response.json({ error: "sign in first" }, { status: 401 });
  // A link session may only set the level of its own artifact.
  if (viewer.only && !["/api/me/watch", "/api/me/since"].includes(url.pathname)) return Response.json({ error: "sign in first" }, { status: 401 });
  if (request.method !== "GET" && !sameOrigin(request, url)) return Response.json({ error: "bad origin" }, { status: 403 });
  try {
    if (url.pathname === "/api/me" && request.method === "GET") {
      return Response.json({
        email,
        workspace: { name: (await hub.access(null)).name },
        watches: await hub.watches(email),
        watchesTotal: await hub.visibleCount(email),
        watchDefault: await hub.watchDefault(email),
        account: `${apexOrigin(env)}/me`,
        member: viewer.only ? null : (await hub.access(email)).member,
      });
    }
    // Pins and dismissing the changed-since bar: your own, on artifacts you can open.
    const own = /^\/api\/me\/(pin|since)$/.exec(url.pathname);
    if (own && request.method === "POST") {
      const body = await jsonBody(request);
      const id = String(body.id ?? "");
      if ((viewer.only && viewer.only !== id) || !(await hub.roleFor(id, email))) return Response.json({ error: "not found" }, { status: 404 });
      if (own[1] === "pin") return Response.json(await hub.setPin(email, id, body.pinned !== false));
      await hub.dismissSince(id, email);
      return Response.json({ dismissed: true });
    }
    // Leaving: a member takes themselves out. What they owned passes to an admin, and so does the
    // workspace itself if they made it; the last admin has to hand over or delete it instead.
    if (url.pathname === "/api/me/leave" && request.method === "POST") {
      const slug = (await hub.info()).slug;
      const { member } = await hub.access(email);
      if (!member) return Response.json({ error: "You're not a member here." }, { status: 400 });
      const admins = (await hub.members()).filter((m) => m.role === "admin" && m.email !== email);
      if (member === "admin" && !admins.length) {
        return Response.json({ error: "You're the only admin. Make someone else an admin first, or delete the workspace in settings." }, { status: 409 });
      }
      // Handed over first, so a failure partway never leaves the workspace owned by someone who's gone.
      const record = await directory(env).workspace(slug);
      if (record?.createdBy === personKey(email) && admins[0]) await directory(env).setCreator(slug, admins[0].email);
      await revokeGrants(env, url.origin, slug, email, hub);
      await hub.setMember(email, null, null);
      return Response.json({ location: `${apexOrigin(env)}/workspaces?left=${encodeURIComponent((await hub.access(null)).name)}` });
    }
    if (url.pathname === "/api/me/watch-default" && request.method === "POST") {
      const body = await jsonBody(request);
      const level = body.level === null ? null : (String(body.level) as "all" | "participating" | "mute");
      return Response.json({ level: await hub.setWatchDefault(email, level) });
    }
    if (url.pathname === "/api/me/watch" && request.method === "POST") {
      const body = await jsonBody(request);
      const id = String(body.id ?? "");
      if ((viewer.only && viewer.only !== id) || !(await hub.roleFor(id, email))) return Response.json({ error: "not found" }, { status: 404 });
      const level = body.level === null ? null : (String(body.level) as "all" | "participating" | "mute");
      return Response.json({ level: await hub.setWatch(email, id, level) });
    }
  } catch (err) {
    return await failure(err, env, request);
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

/**
 * Your account, on the apex (session cookie, same-origin JSON):
 * - GET    /api/me                     profile, channels, workspaces
 * - POST   /api/me {name}              display name
 * - POST   /api/me/channels {type,...} add a channel (validated; may reveal a secret once)
 * - DELETE /api/me/channels/<id>       remove one
 * - POST   /api/me/channels/<id>/test  send a test notification
 * - POST   /api/me/passkeys/options    start saving a passkey
 * - POST   /api/me/passkeys {token, response}  save it
 * - DELETE /api/me/passkeys/<id>       remove one
 */
async function accountApi(request: Request, url: URL, env: Env, viewer: Viewer): Promise<Response> {
  const email = viewer.email;
  if (!email) return Response.json({ error: "sign in first" }, { status: 401 });
  if (request.method !== "GET" && !sameOrigin(request, url)) return Response.json({ error: "bad origin" }, { status: 403 });
  const dir = directory(env);
  const body = request.method === "GET" ? {} : await jsonBody(request);
  try {
    if (url.pathname === "/api/me") {
      if (request.method === "POST" && typeof body.name === "string") await dir.setName(email, body.name);
      if (request.method === "POST" && typeof body.emailNotifications === "boolean") await dir.setEmailNotifications(email, body.emailNotifications);
      const profile = await dir.profile(email);
      return Response.json({
        ...profile,
        workspaces: profile.workspaces.map((w) => ({ ...w, url: workspaceOrigin(env, w.slug) })),
        vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
        pushover: Boolean(env.PUSHOVER_TOKEN),
      });
    }
    // Deleting your account: GET says what would happen (and what's in the way), POST {confirm: "delete"} does it.
    if (url.pathname === "/api/me/delete") {
      const plan = await accountDeletion(env, email);
      if (request.method === "GET") return Response.json(plan);
      if (request.method !== "POST") return Response.json({ error: "not found" }, { status: 404 });
      if (!recentlySignedIn(viewer)) return Response.json({ error: "Sign in again to delete your account.", reauth: true }, { status: 403 });
      if (body.confirm !== "delete") return Response.json({ error: "Type delete to confirm." }, { status: 400 });
      if (plan.blockers.length) return Response.json({ error: plan.blockers[0], ...plan }, { status: 409 });
      for (const w of plan.deletes) {
        const hub = workspaceHub(env, w.slug);
        await revokeGrants(env, workspaceOrigin(env, w.slug), w.slug, email, hub).catch((err) => console.error("revoking grants failed", err));
        await hub.destroy(w.slug);
        await dir.removeWorkspace(w.slug);
      }
      for (const w of plan.leaves) {
        const hub = workspaceHub(env, w.slug);
        if (w.heir) await dir.setCreator(w.slug, w.heir);
        await revokeGrants(env, workspaceOrigin(env, w.slug), w.slug, email, hub).catch((err) => console.error("revoking grants failed", err));
        await hub.setMember(email, null, null);
      }
      // Wherever they were a member or a guest, what was shared with their address stops being shared with it.
      for (const w of [...plan.leaves, ...plan.guestOf]) {
        const hub = workspaceHub(env, w.slug);
        await Promise.resolve()
          .then(() => hub.forgetPerson(email))
          .catch((err: unknown) => console.error(JSON.stringify({ ops: "forget_person_failed", slug: w.slug, message: (err as Error).message })));
      }
      await dir.forgetPerson(email);
      forgetWorkspaces();
      // Every session they have, on every workspace, ends too.
      await signOutEverywhere(env, email);
      return Response.json({ deleted: true, location: `${apexOrigin(env)}/?deleted=account` }, { headers: { "Set-Cookie": clearSessionCookie() } });
    }
    if (url.pathname === "/api/me/channels" && request.method === "POST") {
      const type = String(body.type) as ChannelType;
      if (!["pushover", "ntfy", "webhook", "webpush"].includes(type)) return Response.json({ error: "unknown channel type" }, { status: 400 });
      // Everything you're notified about would go to it (a push endpoint too comes from the request): a stolen
      // cookie mustn't be enough.
      if (!recentlySignedIn(viewer)) return Response.json({ error: "Sign in again to add a channel.", reauth: true }, { status: 403 });
      const prepared = await prepareChannel(type, body, env);
      const id = await dir.addChannel(email, type, prepared.config, prepared.label);
      return Response.json({ id, label: prepared.label, reveal: prepared.reveal ?? null });
    }
    // Signing out everywhere: every session, on every workspace and device (this one too).
    if (url.pathname === "/api/me/sign-out-everywhere" && request.method === "POST") {
      await signOutEverywhere(env, email);
      return Response.json({ location: `${apexOrigin(env)}/login` }, { headers: { "Set-Cookie": clearSessionCookie() } });
    }
    if (url.pathname.startsWith("/api/me/passkeys") && (request.method === "POST" || request.method === "DELETE") && !recentlySignedIn(viewer)) {
      return Response.json({ error: "Sign in again to change your passkeys.", reauth: true }, { status: 403 });
    }
    if (url.pathname === "/api/me/passkeys/options" && request.method === "POST") return Response.json(await registrationOptions(env, dir, email));
    if (url.pathname === "/api/me/passkeys" && request.method === "POST") {
      const passkeys = await verifyRegistration(env, dir, email, String(body.token ?? ""), body.response as never, request.headers.get("User-Agent") ?? "");
      return Response.json({ passkeys });
    }
    const pk = /^\/api\/me\/passkeys\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (pk && request.method === "DELETE") return Response.json({ removed: await dir.removePasskey(email, pk[1]) });
    const m = /^\/api\/me\/channels\/([a-z0-9]+)(\/test)?$/.exec(url.pathname);
    if (m && request.method === "DELETE" && !m[2]) return Response.json({ removed: await dir.removeChannel(email, m[1]) });
    if (m && request.method === "POST" && m[2]) {
      await dir.allowChannelTest(email);
      const channel = await dir.channelConfig(email, m[1]);
      if (!channel) return Response.json({ error: "not found" }, { status: 404 });
      const result = await sendToChannel(
        channel.type,
        channel.config,
        { title: PRODUCT, body: "Test notification: this channel works.", url: `${url.origin}/me`, tag: "test" },
        env,
      );
      await dir.recordChannelResult(m[1], result);
      return result.ok ? Response.json({ ok: true }) : Response.json({ error: result.error }, { status: 400 });
    }
  } catch (err) {
    return await failure(err, env, request);
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

// ---- operator ----------------------------------------------------------------------------

/**
 * Operator API (an operator's session with same-origin requests, or the
 * OPERATOR_TOKEN bearer for scripts):
 * - GET    /api/admin/workspaces                         every workspace with its last stats and admins
 * - POST   /api/admin/workspaces {slug, name, admin}     create one with its first admin
 * - POST   /api/admin/workspaces/<slug> {suspended?}     suspend or resume
 * - DELETE /api/admin/workspaces/<slug>                  delete it, its data and its backups
 * - POST   /api/admin/workspaces/<slug>/stats            refresh its stats now
 * - GET    /api/admin/workspaces/<slug>/export?table=&after=   one page of one table
 * - POST   /api/admin/workspaces/<slug>/import {step: "begin"|"rows"|"end", table?, rows?}
 * - GET    /api/admin/workspaces/<slug>/backups          complete backup runs, newest first
 * - POST   /api/admin/workspaces/<slug>/backup           queue a backup now
 * - DELETE /api/admin/workspaces/<slug>/job              cancel the running job (nothing live changes)
 * - POST   /api/admin/test-code {email}                  a sign-in code for a test address
 * - GET    /api/admin/signins?email=                     recent code sends and failures, for support
 * - POST   /api/admin/workspaces/<slug>/restore {run}    back up, then replace everything with that run
 * - the same export, import, backups, backup and restore under /api/admin/directory/ for the directory
 * - POST   /api/admin/workspaces/<slug>/free-team {on}   Team at no charge, whatever billing says (or not)
 * - POST   /api/admin/workspaces/<slug>/end-billing      end its paid time now (refund, dispute), so it's Free
 * - POST   /api/admin/workspaces/<slug>/hosts {host, allowed}   approve or revoke a live-data host, as its admins can
 * - POST   /api/admin/workspaces/<slug>/tokens {email}   an agent token for a member
 * - POST   /api/admin/session {email, host}              a session cookie value for the apex or a workspace host
 * The last two exist for end-to-end checks and only accept test addresses
 * (example.com/.org/.net, .test, .invalid), so they can't act as a real person.
 */
async function operatorApi(request: Request, url: URL, env: Env, viewer: Viewer, ctx: ExecutionContext): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") && Boolean(env.OPERATOR_TOKEN) && timingSafeEqual(auth.slice(7), env.OPERATOR_TOKEN);
  const session = viewer.email !== null && operatorEmails(env).has(viewer.email) && (request.method === "GET" || sameOrigin(request, url));
  if (!bearer && !session) return Response.json({ error: "operator only" }, { status: 403 });
  const dir = directory(env);
  const path = url.pathname;
  try {
    if (path === "/api/admin/session" && request.method === "POST") {
      const body = await jsonBody(request);
      const email = String(body.email ?? "").toLowerCase();
      const host = String(body.host ?? "");
      if (!isTestAddress(email)) return Response.json({ error: "only test addresses" }, { status: 400 });
      if (host !== env.APEX_HOST && !slugOf(host, env)) return Response.json({ error: "unknown host" }, { status: 400 });
      return Response.json({ cookie: `${SESSION_COOKIE}=${await signToken(env.SESSION_SECRET, "session", 3600, { e: email, h: host, iat: nowSeconds() })}` });
    }
    // End-to-end checks sign in through the real forms: a code for a test address (whose mail is never sent).
    if (path === "/api/admin/test-code" && request.method === "POST") {
      const email = String((await jsonBody(request)).email ?? "").toLowerCase();
      if (!isTestAddress(email)) return Response.json({ error: "only test addresses" }, { status: 400 });
      return Response.json({ code: await dir.startLogin(email, "operator") });
    }
    if (path === "/api/admin/signins" && request.method === "GET") {
      return Response.json(await dir.signInDiagnostics(String(url.searchParams.get("email") ?? "").toLowerCase()));
    }
    // Phone-width overflow check of one of our own pages (spikes/e2e-layout.ts).
    if (path === "/api/admin/layout" && request.method === "POST") {
      const body = await jsonBody(request);
      let target: URL;
      try {
        target = new URL(String(body.url ?? ""));
      } catch {
        return Response.json({ error: "url must be a URL" }, { status: 400 });
      }
      if (target.protocol !== "https:" || (target.hostname !== env.APEX_HOST && !target.hostname.endsWith(env.WORKSPACE_SUFFIX))) {
        return Response.json({ error: "only this site's own pages" }, { status: 400 });
      }
      const cookie = typeof body.cookie === "string" && /^[\w-]+=/.test(body.cookie) ? { name: body.cookie.split("=")[0], value: body.cookie.slice(body.cookie.indexOf("=") + 1) } : undefined;
      return Response.json(await checkLayout(env as never, target.href, cookie));
    }
    if (path === "/api/admin/workspaces" && request.method === "GET") {
      // Jobs come from the directory, which each workspace reports to, so this wakes no workspace.
      const billing = await dir.billingAll();
      return Response.json({ workspaces: (await dir.workspaces()).map((w) => ({ ...w, url: workspaceOrigin(env, w.slug), billing: billing[w.slug] ?? null })) });
    }
    // Make the support workspace now (it's otherwise made by the first request), so the assistant can connect first.
    if (path === "/api/admin/support" && request.method === "POST") {
      await supportHub(env);
      return Response.json({ url: workspaceOrigin(env, "support") });
    }
    // What happened lately: signups, billing changes, reports and failures (the ops log, see ops.ts).
    if (path === "/api/admin/ops" && request.method === "GET") {
      const q = url.searchParams;
      return Response.json({ events: await dir.opsEvents({ kind: q.get("kind") ?? undefined, slug: q.get("slug") ?? undefined, limit: Number(q.get("limit")) || 50 }) });
    }
    if (path === "/api/admin/workspaces" && request.method === "POST") {
      const body = await jsonBody(request);
      const slug = String(body.slug ?? "").trim().toLowerCase();
      const admin = String(body.admin ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(admin)) return Response.json({ error: "the first admin needs a valid email" }, { status: 400 });
      const record = await dir.createWorkspace(slug, String(body.name ?? slug));
      try {
        await workspaceHub(env, slug).provision({ slug, name: record.name, admin });
      } catch (err) {
        await dir.removeWorkspace(slug);
        throw err;
      }
      forgetWorkspaces();
      const origin = workspaceOrigin(env, slug);
      const emailed = await invite(env, workspaceHub(env, slug), admin, { workspace: record.name, url: origin, by: null, role: "admin" });
      return Response.json({ workspace: { ...record, url: origin }, emailed });
    }
    // The directory's own data: names, channels, memberships and the workspace list.
    const d = /^\/api\/admin\/directory\/([a-z]+)$/.exec(path);
    if (d) {
      const body = request.method === "POST" ? await jsonBody(request) : {};
      const done = await snapshotAction(dir, d[1], request.method, url, body);
      if (d[1] === "restore" || (d[1] === "import" && body.step === "end")) forgetWorkspaces();
      return done ?? Response.json({ error: "not found" }, { status: 404 });
    }
    const m = /^\/api\/admin\/workspaces\/([a-z0-9-]+)(?:\/([a-z-]+))?$/.exec(path);
    if (!m) return Response.json({ error: "not found" }, { status: 404 });
    const [, slug, action] = m;
    const hub = workspaceHub(env, slug);
    const listed = await dir.workspace(slug);
    // Deleting again finishes a delete that failed partway, even after the directory forgot the workspace.
    if (!action && request.method === "DELETE") {
      if (!validSlug(slug)) return Response.json({ error: `no workspace ${slug}` }, { status: 404 });
      // A paying workspace would keep being charged: cancel its subscription first (or force).
      const rec = await dir.billing(slug);
      if (rec && subscriptionMayCharge(rec.status) && url.searchParams.get("force") !== "1") {
        return Response.json({ error: `${slug} has a subscription that can still charge (${rec.status}); cancel it in Creem first, or delete with ?force=1` }, { status: 409 });
      }
      for (const m of await Promise.resolve().then(() => hub.members()).catch(() => [])) {
        await revokeGrants(env, workspaceOrigin(env, slug), slug, m.email, hub).catch((err) => console.error("revoking grants failed", err));
      }
      await hub.destroy(slug);
      if (listed) await dir.removeWorkspace(slug);
      forgetWorkspaces();
      return Response.json({ deleted: slug });
    }
    if (!listed) return Response.json({ error: `no workspace ${slug}` }, { status: 404 });
    const body = request.method === "POST" ? await jsonBody(request) : {};
    if (!action && request.method === "POST") {
      if (typeof body.suspended === "boolean") {
        await dir.setSuspended(slug, body.suspended);
        // Open pages reconnect and meet the suspended page.
        if (body.suspended) await hub.closeSockets();
        forgetWorkspaces();
      }
      return Response.json({ workspace: await dir.workspace(slug) });
    }
    // Fix the admins without a role inside the workspace: say, a mistyped first admin.
    if (action === "members" && request.method === "POST") {
      const target = String(body.email ?? "").trim().toLowerCase();
      const role = body.role === null ? null : (String(body.role) as WorkspaceRole);
      const existed = (await hub.members()).some((m) => m.email === target);
      const members = await hub.setMember(target, role, null);
      if (role === null) await revokeGrants(env, workspaceOrigin(env, slug), slug, target, hub);
      const emailed = role !== null && !existed && (await invite(env, hub, target, { workspace: (await hub.access(null)).name, url: workspaceOrigin(env, slug), by: null, role }));
      return Response.json({ members, emailed });
    }
    // Plans are set by hand until there's billing.
    // Put the plan back to what its subscription record says (after a webhook that kept failing).
    if (action === "resync" && request.method === "POST") {
      const rec = await dir.billingPlan(slug);
      if (!rec) return Response.json({ error: `${slug} has no subscription record` }, { status: 400 });
      await hub.setPlan(rec.plan, rec.until);
      return Response.json({ plan: rec.plan, until: rec.until });
    }
    // Team at no charge (the operator's own workspaces, say), whatever billing says; off puts billing back in charge.
    if (action === "free-team" && request.method === "POST") {
      if (typeof body.on !== "boolean") return Response.json({ error: "on must be true or false" }, { status: 400 });
      return Response.json({ plan: await hub.setFreeTeam(body.on) });
    }
    // After a refund or dispute: Team ends now, whatever the subscription said (cancel it in Creem too).
    if (action === "end-billing" && request.method === "POST") {
      const rec = await dir.endBilling(slug);
      if (!rec) return Response.json({ error: `${slug} has no subscription record` }, { status: 400 });
      await hub.setPlan(rec.plan, rec.until);
      await ops(env, { kind: "billing", slug, message: `An operator ended ${slug}'s paid time; it's on Free now.`, alert: false });
      return Response.json({ plan: rec.plan, until: rec.until });
    }
    if (action === "plan" && request.method === "POST") {
      if (!isPlan(body.plan)) return Response.json({ error: "plan must be free or team" }, { status: 400 });
      // A paying workspace's plan follows its subscription: the next webhook or resync would undo a hand-set one.
      if (body.force !== true && (await dir.billing(slug))) {
        return Response.json({ error: `${slug} has a subscription record, so its plan follows it. Use Resync plan or End billing, or send force: true.` }, { status: 409 });
      }
      return Response.json({ plan: await hub.setPlan(body.plan) });
    }
    // Like fixing admins: put back a data host an admin removed by mistake.
    if (action === "hosts" && request.method === "POST") {
      if (typeof body.allowed !== "boolean") return Response.json({ error: "allowed must be true or false" }, { status: 400 });
      return Response.json({ hosts: await hub.setHostAllowed(String(body.host ?? ""), body.allowed) });
    }
    if (action === "job" && request.method === "DELETE") {
      await hub.cancelJob();
      return Response.json({ cancelled: true });
    }
    if (action === "stats" && request.method === "POST") {
      const stats = await hub.stats();
      await dir.recordStats(slug, stats);
      return Response.json({ stats });
    }
    const done = action ? await snapshotAction(hub, action, request.method, url, body) : null;
    if (done) return done;
    // Agent tokens for test addresses (the end-to-end checks), or for an operator's own services (say, the
    // events adapter that relays this workspace's MCP events): never for anyone else.
    if (action === "tokens" && request.method === "POST") {
      const email = String(body.email ?? "").toLowerCase();
      const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 60) : "End-to-end check";
      if (!isTestAddress(email) && !operatorEmails(env).has(email)) return Response.json({ error: "only test addresses or operators" }, { status: 400 });
      return Response.json(await hub.createToken(email, label));
    }
  } catch (err) {
    return await failure(err, env, request);
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

type Snapshots = Pick<HubApi, "exportPage" | "importRows" | "backups"> & {
  importBegin(): Promise<unknown>;
  importEnd(): Promise<unknown>;
  backup(): Promise<unknown>;
  restore(run: string): Promise<unknown>;
};

/** Export, import and backup actions, the same for a workspace and the directory. Null when `action` isn't one. */
async function snapshotAction(store: Snapshots, action: string, method: string, url: URL, body: Record<string, unknown>): Promise<Response | null> {
  if (action === "export" && method === "GET") {
    return Response.json(await store.exportPage(url.searchParams.get("table") ?? "", Number(url.searchParams.get("after") ?? 0)));
  }
  if (action === "import" && method === "POST") {
    if (body.step === "begin") {
      await store.importBegin();
      return Response.json({ ok: true });
    }
    if (body.step === "rows") return Response.json({ imported: await store.importRows(String(body.table ?? ""), (body.rows as Record<string, unknown>[]) ?? []) });
    if (body.step === "end") return Response.json({ done: await store.importEnd() });
    return Response.json({ error: "step must be begin, rows or end" }, { status: 400 });
  }
  if (action === "backups" && method === "GET") return Response.json({ runs: await store.backups() });
  if (action === "backup" && method === "POST") {
    const r = await store.backup();
    return Response.json(typeof r === "string" ? { prefix: r } : (r ?? { error: "no backup bucket" }));
  }
  if (action === "restore" && method === "POST") {
    const r = await store.restore(String(body.run ?? ""));
    return Response.json(r && typeof r === "object" && "queued" in r ? r : { done: r });
  }
  return null;
}

// ---- link previews ---------------------------------------------------------------------

/** The artifact a presigned /s/<code> link points at, without redeeming it. */
async function linkTarget(path: string, env: Env, slug: string): Promise<string | null> {
  const code = /^\/s\/([A-Za-z0-9_.-]+)$/.exec(path)?.[1];
  if (!code) return null;
  const claims = await verifyToken<{ a: string; w: string }>(env.LOGIN_SECRET, "link", code);
  return claims && claims.w === slug ? claims.a : null;
}

/** Card for a link-preview fetcher: generic unless the owner opted in or the artifact is public. */
async function linkPreview(id: string | null, url: URL, env: Env, hub: HubApi, slug: string): Promise<Response> {
  const info = id ? await hub.previewInfo(id) : null;
  if (!info?.rich) return previewPage({ url: url.href, origin: url.origin });
  let image: string | undefined;
  if (info.image) {
    const sig = await signToken(env.SESSION_SECRET, "og", OG_TTL, { id, w: slug });
    image = `${url.origin}/og/${id}.jpg?v=${info.version}&s=${encodeURIComponent(sig)}`;
  }
  return previewPage({ url: url.href, origin: url.origin, title: info.title, description: info.description, image });
}

/** The stored first-screen screenshot, for opted-in previews only. */
async function ogImage(id: string, url: URL, env: Env, hub: HubApi, slug: string): Promise<Response> {
  const claims = await verifyToken<{ id: string; w: string }>(env.SESSION_SECRET, "og", url.searchParams.get("s"));
  if (!claims || claims.id !== id || claims.w !== slug) return new Response("not found", { status: 404 });
  const bytes = await hub.previewImage(id);
  if (!bytes) return new Response("not found", { status: 404 });
  return new Response(bytes, {
    headers: {
      "Content-Type": "image/jpeg",
      // Versioned URL; previews are cached by the apps anyway.
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

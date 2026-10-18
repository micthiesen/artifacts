// Artifacts Worker. The apex domain is the front door (splash, sign-in, your
// workspaces, notification settings, the operator console); every workspace is
// served at its own subdomain, backed by its own Durable Object, and is its own
// OAuth authorization server and MCP resource.
import { OAuthProvider, AuthorizationError, CimdFetchError, getOAuthApi, type OAuthHelpers, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { handleMcp, runOwnerTool, type Ctx } from "./mcp.ts";
import {
  adminPage,
  consentPage,
  continuePage,
  frameDocument,
  indexPage,
  loginPage,
  messagePage,
  previewPage,
  profilePage,
  settingsPage,
  shellPage,
  splashPage,
  workspacesPage,
  type Brand,
} from "./pages.ts";
import { prepareChannel, sendToChannel, type ChannelType } from "./notify.ts";
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
import { validSlug, type DirectoryApi, type WorkspaceRecord, type WorkspaceRole } from "./directory.ts";
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
  /** The front door, e.g. "artifacts.boo". */
  APEX_HOST: string;
  /** Appended to a slug to make its host, e.g. ".artifacts.boo" ("acme.artifacts.boo"). */
  WORKSPACE_SUFFIX: string;
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
const MISSING_CACHE_MS = 10_000;
const WORKSPACE_CACHE_MAX = 2000;
const NONCE_COOKIE = "__Host-art_login";

/**
 * `only` is set for a session from a presigned link: it opens that one
 * artifact and nothing else (no list, settings, owner actions or OAuth).
 */
type Viewer = { email: string | null; only?: string };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    if (url.hostname === `www.${env.APEX_HOST}`) {
      url.hostname = env.APEX_HOST;
      return Response.redirect(url.toString(), 301);
    }
    if (url.hostname === env.APEX_HOST) response = await apex(request, env);
    else {
      // Unknown hosts stop here, so a random subdomain never wakes a Durable Object.
      const slug = slugOf(url.hostname, env);
      const record = slug ? await workspaceRecord(env, slug) : null;
      response = record
        ? await providerFor(url.origin).fetch(request, env, ctx)
        : messagePage("No such workspace", `There's no workspace at ${url.hostname}.`, 404, { href: apexOrigin(env), label: "Artifacts" }, apexBrand(env));
    }
    await renewSession(request, env, response);
    // Nothing here should be indexed by search engines, public artifacts included.
    if (!response.headers.has("X-Robots-Tag") && response.status !== 101) {
      try {
        response.headers.set("X-Robots-Tag", "noindex, nofollow");
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

function apexOrigin(env: Env): string {
  return `https://${env.APEX_HOST}`;
}

function apexBrand(env: Env): Brand {
  return { name: "Artifacts", home: "/", apex: apexOrigin(env) };
}

/**
 * Workspace records, cached briefly per isolate so a page load doesn't ask the
 * directory, and so a random subdomain never creates a Durable Object.
 */
const workspaceCache = new Map<string, { record: WorkspaceRecord | null; at: number }>();

async function workspaceRecord(env: Env, slug: string): Promise<WorkspaceRecord | null> {
  const hit = workspaceCache.get(slug);
  if (hit && Date.now() - hit.at < (hit.record ? WORKSPACE_CACHE_MS : MISSING_CACHE_MS)) return hit.record;
  const record = await directory(env).workspace(slug);
  // Random subdomains shouldn't grow an isolate's memory without bound.
  if (workspaceCache.size >= WORKSPACE_CACHE_MAX) workspaceCache.clear();
  workspaceCache.set(slug, { record, at: Date.now() });
  return record;
}

// ---- workspace hosts: OAuth around the app --------------------------------------------

type McpProps = { email: string; slug: string };

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
    resourceMetadata: { resource: `${origin}/mcp`, resource_name: "Artifacts" },
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
      return who ? { props: { email: who.email, slug } satisfies McpProps, audience: `${origin}/mcp` } : null;
    },
  };
  const entry = { provider: new OAuthProvider<Env>(options), options };
  providers.set(origin, entry);
  return entry;
}

async function mcpApi(request: Request, env: Env, props: McpProps): Promise<Response> {
  const url = new URL(request.url);
  const slug = slugOf(url.hostname, env);
  const record = slug ? await workspaceRecord(env, slug) : null;
  if (!slug || !record || props.slug !== slug) return Response.json({ error: "unknown workspace" }, { status: 404 });
  if (record.suspended) return Response.json({ error: "this workspace is suspended" }, { status: 403 });
  const hub = workspaceHub(env, slug);
  // Leaving the workspace ends an agent's access, whatever token it holds.
  if (!(await hub.access(props.email)).member) return Response.json({ error: `${props.email} is no longer a member of ${slug}` }, { status: 403 });
  return handleMcp(request, { hub, origin: url.origin, env, slug, person: props.email, actor: "agent" });
}

async function workspaceRoute(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const slug = slugOf(url.hostname, env)!;
  if (path === "/healthz") return new Response("ok");
  if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
  const record = await workspaceRecord(env, slug);
  const brand: Brand = { name: record?.name ?? slug, home: "/", apex: apexOrigin(env) };
  if (!record) return messagePage("No such workspace", `There's no workspace at ${url.hostname}.`, 404, { href: apexOrigin(env), label: "Artifacts" }, apexBrand(env));
  if (record.suspended) return messagePage("Workspace suspended", `${record.name} is suspended. Contact whoever runs it.`, 403, { href: apexOrigin(env), label: "Artifacts" }, brand);
  const hub = workspaceHub(env, slug);

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
  if (presigned) return presignedSignIn(presigned[1], url, env, hub, slug, brand);

  if (path === "/" || path === "/archived") {
    if (!viewer.email) return indexPage({ email: null, member: null }, [], brand);
    const { member } = await hub.access(viewer.email);
    const artifacts = await hub.list(viewer.email);
    return indexPage({ email: viewer.email, member }, artifacts, brand, await hub.shareSummaries(viewer.email), path === "/archived");
  }
  if (path === "/me") {
    if (!viewer.email) return signIn("/me");
    return profilePage(viewer.email, "workspace", brand, Boolean(env.VAPID_PUBLIC_KEY), Boolean(env.PUSHOVER_TOKEN));
  }
  if (path === "/api/me" || path.startsWith("/api/me/")) return workspaceMeApi(request, url, env, hub, session);
  if (path === "/settings") {
    if (!viewer.email) return signIn("/settings");
    const { member } = await hub.access(viewer.email);
    if (!member) return messagePage("Members only", `${viewer.email} isn't a member of ${record.name}.`, 403, undefined, brand);
    return settingsPage(viewer.email, brand);
  }
  if (path === "/api/settings" || path.startsWith("/api/settings/")) return settingsApi(request, url, env, hub, viewer, slug);
  if (path === "/authorize") return authorize(request, url, env, hub, viewer, record, brand);

  const frame = /^\/frame\/([a-z0-9]+)$/.exec(path);
  if (frame) {
    const claims = await verifyToken<{ id: string; w: string; c?: boolean }>(env.SESSION_SECRET, "frame", url.searchParams.get("t"));
    if (!claims || claims.id !== frame[1] || claims.w !== slug) return new Response("frame link expired; reload the page", { status: 403 });
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
    const full = await hub.roleFor(id, here.email);
    // From a link, even an owner gets the page, not its management.
    const role = full === "owner" && here.only ? "edit" : full;
    if (!role) {
      if (!here.email && !sub) return signIn(path);
      return sub
        ? new Response("forbidden", { status: 403 })
        : messagePage("Not available", `${here.email} doesn't have access to this artifact, or it doesn't exist.`, 403, undefined, brand);
    }
    if (sub === "/sync") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      if (!sameOrigin(request, url)) return new Response("bad origin", { status: 403 });
      const headers = new Headers(request.headers);
      headers.set("X-Art-Id", id);
      headers.set("X-Art-Role", role);
      headers.set("X-Art-Email", here.email ?? "");
      headers.set("X-Art-Origin", url.origin);
      return hub.fetch(new Request(request.url, { headers }));
    }
    if (sub === "/errors") {
      if (request.method !== "POST" || !sameOrigin(request, url)) return new Response("bad request", { status: 400 });
      const body = (await request.json().catch(() => null)) as { message?: string; stack?: string } | null;
      if (body?.message) await hub.recordError(id, here.email, String(body.message), body.stack ? String(body.stack) : undefined);
      return new Response(null, { status: 204 });
    }
    const meta = await hub.meta(id);
    if (!meta) return messagePage("Not found", "This artifact doesn't exist.", 404, undefined, brand);
    const token = await signToken(env.SESSION_SECRET, "frame", FRAME_TTL, { id, e: here.email, w: slug });
    const visit = here.email ? await hub.visit(id, here.email) : null;
    const member = here.email ? (await hub.access(here.email)).member : null;
    return shellPage(
      {
        artifactId: id,
        title: meta.title,
        version: meta.version,
        frameUrl: `/frame/${id}?v=${meta.version}&t=${encodeURIComponent(token)}`,
        syncUrl: `/a/${id}/sync`,
        viewer: { email: here.email, role: role as Role },
        apex: apexOrigin(env),
        member: Boolean(member),
        ...(meta.archivedAt ? { archivedAt: meta.archivedAt } : {}),
        ...(visit ? { since: visit.since, readSeq: visit.readSeq, watch: visit.watch } : {}),
      },
      brand,
    );
  }

  return messagePage("Not found", "There's nothing here.", 404, undefined, brand);
}

// ---- apex: front door, sign-in, account and operator -------------------------------------

async function apex(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const brand = apexBrand(env);
  if (path === "/healthz") return new Response("ok");
  if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
  if (PREVIEW_BOT.test(request.headers.get("User-Agent") ?? "")) return previewPage({ url: url.href, origin: url.origin, title: "Artifacts", description: "Collaborative documents and little apps your agent can build, inspect and maintain." });
  const viewer = await currentViewer(request, env);
  const operator = viewer.email !== null && operatorEmails(env).has(viewer.email);

  if (path === "/") {
    if (!viewer.email) return splashPage(brand);
    const workspaces = (await directory(env).membershipsOf(viewer.email)).map((w) => ({ ...w, url: workspaceOrigin(env, w.slug) }));
    return workspacesPage(viewer.email, workspaces, operator, brand);
  }
  if (path === "/login") return apexLogin(request, url, env, viewer, brand);
  if (path === "/logout" && request.method === "POST") {
    if (!sameOrigin(request, url)) return new Response("bad origin", { status: 403 });
    return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": clearSessionCookie() } });
  }
  // Where a workspace's Sign out lands: end the apex session too, so the next sign-in asks again.
  if (path === "/signed-out") {
    const res = splashPage(brand, "You're signed out.");
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
  if (path.startsWith("/api/admin/")) return operatorApi(request, url, env, viewer);
  return messagePage("Not found", "There's nothing here.", 404, undefined, brand);
}

/**
 * Email sign-in: ask for an address, email a six-digit code, check it. With
 * `to` (a workspace origin) the browser is then handed to that workspace.
 */
async function apexLogin(request: Request, url: URL, env: Env, viewer: Viewer, brand: Brand): Promise<Response> {
  const form = request.method === "POST" ? await request.formData().catch(() => new FormData()) : null;
  const field = (k: string) => String(form?.get(k) ?? url.searchParams.get(k) ?? "").trim();
  const to = field("to");
  const nonce = field("n");
  const ret = safeNext(field("return") || null);
  const state = { to, n: nonce, return: ret };
  if (!form) {
    if (viewer.email) return finishLogin(viewer.email, to, nonce, ret, env, false);
    return loginPage({ ...state, step: "email" }, brand);
  }
  if (!sameOrigin(request, url)) return new Response("bad origin", { status: 403 });
  const email = field("email").toLowerCase();
  if (!/^[^\s@]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email)) return loginPage({ ...state, step: "email", email, error: "Enter a valid email address." }, brand, 400);
  if (form.has("code")) {
    if (!(await directory(env).verifyLogin(email, field("code")))) {
      return loginPage({ ...state, step: "code", email, error: "That code didn't work. Check it, or send a new one." }, brand, 400);
    }
    const res = await finishLogin(email, to, nonce, ret, env, true);
    const session = await signToken(env.SESSION_SECRET, "session", SESSION_TTL, { e: email, h: env.APEX_HOST });
    res.headers.append("Set-Cookie", sessionCookie(session));
    return res;
  }
  let code: string;
  try {
    code = await directory(env).startLogin(email, request.headers.get("CF-Connecting-IP"));
  } catch (err) {
    // Rate limits; the message is written for the person signing in.
    return loginPage({ ...state, step: "email", email, error: (err as Error).message }, brand, 429);
  }
  try {
    await sendCode(env, email, code);
  } catch (err) {
    console.error("sign-in email failed", err);
    return loginPage({ ...state, step: "email", email, error: "We couldn't send the email. Try again in a moment." }, brand, 502);
  }
  return loginPage({ ...state, step: "code", email }, brand);
}

async function sendCode(env: Env, email: string, code: string) {
  if (!env.EMAIL) throw new Error("no EMAIL binding");
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  await env.EMAIL.send({
    from: { name: "Artifacts", email: env.MAIL_FROM },
    to: email,
    subject: `${spaced} is your Artifacts code`,
    text: `Your Artifacts sign-in code is ${spaced}.\n\nIt works once, for 10 minutes. If you didn't try to sign in, ignore this email.\n`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#222"><p>Your Artifacts sign-in code is</p><p style="font-size:28px;font-weight:600;letter-spacing:4px">${spaced}</p><p style="color:#666">It works once, for 10 minutes. If you didn't try to sign in, ignore this email.</p></div>`,
  });
}

/** Send a signed-in browser on: to a workspace via a one-minute hand-off code, or to a page here. */
async function finishLogin(email: string, to: string, nonce: string, ret: string, env: Env, fromForm: boolean): Promise<Response> {
  let target: URL | null = null;
  try {
    target = to ? new URL(to) : null;
  } catch {
    target = null;
  }
  if (target && target.protocol === "https:" && slugOf(target.hostname, env) && target.origin === to) {
    const code = await signToken(env.LOGIN_SECRET, "login", 60, { e: email, aud: target.origin, n: nonce });
    const callback = new URL(`${target.origin}/auth/callback`);
    callback.searchParams.set("code", code);
    callback.searchParams.set("next", ret);
    // After the code form, a redirect to the workspace would be blocked (see continuePage).
    return fromForm ? continuePage(callback.href) : new Response(null, { status: 303, headers: { Location: callback.href } });
  }
  return new Response(null, { status: 303, headers: { Location: ret } });
}

async function authCallback(request: Request, url: URL, env: Env): Promise<Response> {
  const claims = await verifyToken<{ e: string; aud: string; n: string }>(env.LOGIN_SECRET, "login", url.searchParams.get("code"));
  const nonce = readCookie(request, NONCE_COOKIE);
  if (!claims || claims.aud !== url.origin || !nonce || !claims.n || !timingSafeEqual(claims.n, nonce)) {
    return messagePage("Sign-in failed", "That sign-in link expired. Try again.", 400, { href: "/login", label: "Sign in" });
  }
  const session = await signToken(env.SESSION_SECRET, "session", SESSION_TTL, { e: claims.e.toLowerCase(), h: url.hostname });
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
async function presignedSignIn(code: string, url: URL, env: Env, hub: HubApi, slug: string, brand: Brand): Promise<Response> {
  const claims = await verifyToken<{ e: string; a: string; w: string }>(env.LOGIN_SECRET, "link", code);
  if (!claims || claims.w !== slug) return messagePage("Link expired", "This link has expired or is invalid. Ask for a new one.", 400, undefined, brand);
  const email = claims.e.toLowerCase();
  if (!(await hub.roleFor(claims.a, email))) return messagePage("Not available", `${email} doesn't have access to this artifact anymore.`, 403, undefined, brand);
  // The session opens this artifact only; signing in with email gives the rest.
  const session = await signToken(env.SESSION_SECRET, "session", SESSION_TTL, { e: email, h: url.hostname, a: claims.a });
  return new Response(null, {
    status: 303,
    headers: { Location: `/a/${claims.a}`, "Set-Cookie": sessionCookie(session), "Referrer-Policy": "no-referrer" },
  });
}

// ---- sessions ------------------------------------------------------------------------

/** Session cookies are per host, and each names its host so one can't be replayed on another. */
async function currentViewer(request: Request, env: Env): Promise<Viewer> {
  const claims = await verifyToken<{ e: string; h: string; a?: string }>(env.SESSION_SECRET, "session", readCookie(request, SESSION_COOKIE));
  if (!claims || claims.h !== new URL(request.url).hostname) return { email: null };
  return claims.a ? { email: claims.e, only: claims.a } : { email: claims.e };
}

/**
 * Sliding sessions: a visit more than a day after the cookie was issued gets a
 * fresh 30-day cookie, so a session only lapses after 30 days without use.
 */
async function renewSession(request: Request, env: Env, response: Response) {
  if (response.status === 101 || response.headers.has("Set-Cookie")) return;
  const claims = await verifyToken<{ e: string; h: string; a?: string }>(env.SESSION_SECRET, "session", readCookie(request, SESSION_COOKIE));
  if (!claims || claims.h !== new URL(request.url).hostname || claims.exp - Date.now() / 1000 > SESSION_TTL - 86400) return;
  const fresh = await signToken(env.SESSION_SECRET, "session", SESSION_TTL, { e: claims.e, h: claims.h, ...(claims.a ? { a: claims.a } : {}) });
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

/** Addresses no real person can hold (RFC 2606 / 6761), for end-to-end checks. */
export function isTestAddress(email: string): boolean {
  return /^[^\s@]+@([a-z0-9-]+\.)*(example\.(com|org|net)|[a-z0-9-]+\.(test|invalid|example))$/.test(email);
}

/** A same-site path to go to next. Anything a browser could read as another origin becomes "/". */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || /[\\\x00-\x20\x7f]/.test(next)) return "/";
  const base = "https://same.invalid";
  try {
    const u = new URL(next, base);
    return u.origin === base ? u.pathname + u.search + u.hash : "/";
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
function failure(err: unknown): Response {
  return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
}

// ---- OAuth consent ---------------------------------------------------------------------

async function authorize(request: Request, url: URL, env: Env, hub: HubApi, viewer: Viewer, record: WorkspaceRecord, brand: Brand): Promise<Response> {
  // Not env.OAUTH_PROVIDER: the library sets that once per isolate, so it would
  // belong to whichever workspace this isolate served first.
  const oauth = oauthApi(url.origin, env);
  const local = (message: string, status = 400) => messagePage("Can't connect", message, status, undefined, brand);
  try {
    if (!viewer.email) return Response.redirect(`${url.origin}/login?return=${encodeURIComponent(url.pathname + url.search)}`, 302);
    if (!(await hub.access(viewer.email)).member) {
      return local(`${viewer.email} isn't a member of ${record.name}, so it can't connect an agent here.`, 403);
    }
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
        props: { email: viewer.email!, slug: record.slug } satisfies McpProps,
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
      const page = consentPage(details, consent.handle, viewer.email, brand);
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
  return `${slug}/${email}`;
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
        members: await hub.members(),
        tokens: await hub.tokens(admin ? undefined : email),
        apps: (await hub.grants(email)).map((g) => ({ id: g.id, client: g.client, createdAt: g.createdAt })),
        hosts: await hub.allowedHosts(),
      });
    }
    const body = await jsonBody(request);
    if (path === "/api/settings/name" && request.method === "POST") {
      if (!admin) return adminOnly();
      const info = await hub.rename(String(body.name ?? ""));
      workspaceCache.delete(slug);
      return Response.json(info);
    }
    if (path === "/api/settings/members" && request.method === "POST") {
      if (!admin) return adminOnly();
      const role = body.role === null ? null : (String(body.role) as WorkspaceRole);
      const target = String(body.email ?? "").trim().toLowerCase();
      const members = await hub.setMember(target, role, email);
      if (role === null) await revokeGrants(env, url.origin, slug, target, hub);
      return Response.json({ members });
    }
    if (path === "/api/settings/tokens" && request.method === "POST") {
      return Response.json(await hub.createToken(email, String(body.label ?? "")));
    }
    const token = /^\/api\/settings\/tokens\/([a-z0-9]+)$/.exec(path);
    if (token && request.method === "DELETE") return Response.json({ revoked: await hub.revokeToken(token[1], email) });
    const app = /^\/api\/settings\/apps\/([A-Za-z0-9_-]+)$/.exec(path);
    if (app && request.method === "DELETE") {
      // Only your own: the grant must be one the workspace recorded for you.
      if (!(await hub.forgetGrants({ id: app[1], email })).length) return Response.json({ error: "not found" }, { status: 404 });
      await oauth.revokeGrant(app[1], grantUser(slug, email));
      return Response.json({ revoked: true });
    }
    if (path === "/api/settings/hosts" && request.method === "POST") {
      if (!admin) return adminOnly();
      return Response.json({ hosts: await hub.setHostAllowed(String(body.host ?? ""), body.allowed !== false) });
    }
  } catch (err) {
    return failure(err);
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

/**
 * Owner menu API (session cookie, same-origin JSON), for the artifact's owner and workspace admins:
 * - GET  /api/a/<id>               overview: meta, shares, history, errors, sources, assets, approved hosts
 * - POST /api/a/<id>/<tool>        one of the owner-menu MCP tools, with the same arguments
 * - POST /api/hosts {host, allowed} approve or revoke a live-data host (any member)
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
      return failure(err);
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
    const [history, errors, sources, assets, hosts] = await Promise.all([hub.history(id), hub.errors(id), hub.sources(id), hub.assets(id), hub.allowedHosts()]);
    return Response.json({ meta, history, errors, sources, assets, hosts });
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
  if (viewer.only && url.pathname !== "/api/me/watch") return Response.json({ error: "sign in first" }, { status: 401 });
  if (request.method !== "GET" && !sameOrigin(request, url)) return Response.json({ error: "bad origin" }, { status: 403 });
  try {
    if (url.pathname === "/api/me" && request.method === "GET") {
      return Response.json({ email, watches: await hub.watches(email), account: `${apexOrigin(env)}/me` });
    }
    if (url.pathname === "/api/me/watch" && request.method === "POST") {
      const body = await jsonBody(request);
      const id = String(body.id ?? "");
      if ((viewer.only && viewer.only !== id) || !(await hub.roleFor(id, email))) return Response.json({ error: "not found" }, { status: 404 });
      const level = body.level === null ? null : (String(body.level) as "all" | "participating" | "mute");
      return Response.json({ level: await hub.setWatch(email, id, level) });
    }
  } catch (err) {
    return failure(err);
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
      const profile = await dir.profile(email);
      return Response.json({
        ...profile,
        workspaces: profile.workspaces.map((w) => ({ ...w, url: workspaceOrigin(env, w.slug) })),
        vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
        pushover: Boolean(env.PUSHOVER_TOKEN),
      });
    }
    if (url.pathname === "/api/me/channels" && request.method === "POST") {
      const type = String(body.type) as ChannelType;
      if (!["pushover", "ntfy", "webhook", "webpush"].includes(type)) return Response.json({ error: "unknown channel type" }, { status: 400 });
      const prepared = await prepareChannel(type, body, env);
      const id = await dir.addChannel(email, type, prepared.config, prepared.label);
      return Response.json({ id, label: prepared.label, reveal: prepared.reveal ?? null });
    }
    const m = /^\/api\/me\/channels\/([a-z0-9]+)(\/test)?$/.exec(url.pathname);
    if (m && request.method === "DELETE" && !m[2]) return Response.json({ removed: await dir.removeChannel(email, m[1]) });
    if (m && request.method === "POST" && m[2]) {
      const channel = await dir.channelConfig(email, m[1]);
      if (!channel) return Response.json({ error: "not found" }, { status: 404 });
      const result = await sendToChannel(
        channel.type,
        channel.config,
        { title: "Artifacts", body: "Test notification: this channel works.", url: `${url.origin}/me`, tag: "test" },
        env,
      );
      await dir.recordChannelResult(m[1], result);
      return result.ok ? Response.json({ ok: true }) : Response.json({ error: result.error }, { status: 400 });
    }
  } catch (err) {
    return failure(err);
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
 * - GET    /api/admin/workspaces/<slug>/backups          dates with a complete backup
 * - POST   /api/admin/workspaces/<slug>/backup           back up now
 * - POST   /api/admin/workspaces/<slug>/restore {date}   replace everything with that backup
 * - the same export, import, backups, backup and restore under /api/admin/directory/ for the directory
 * - POST   /api/admin/workspaces/<slug>/tokens {email}   an agent token for a member
 * - POST   /api/admin/session {email, host}              a session cookie value for the apex or a workspace host
 * The last two exist for end-to-end checks and only accept test addresses
 * (example.com/.org/.net, .test, .invalid), so they can't act as a real person.
 */
async function operatorApi(request: Request, url: URL, env: Env, viewer: Viewer): Promise<Response> {
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
      return Response.json({ cookie: `${SESSION_COOKIE}=${await signToken(env.SESSION_SECRET, "session", 3600, { e: email, h: host })}` });
    }
    if (path === "/api/admin/workspaces" && request.method === "GET") {
      return Response.json({ workspaces: (await dir.workspaces()).map((w) => ({ ...w, url: workspaceOrigin(env, w.slug) })) });
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
      workspaceCache.delete(slug);
      return Response.json({ workspace: { ...record, url: workspaceOrigin(env, slug) } });
    }
    // The directory's own data: names, channels, memberships and the workspace list.
    const d = /^\/api\/admin\/directory\/([a-z]+)$/.exec(path);
    if (d) {
      const body = request.method === "POST" ? await jsonBody(request) : {};
      const done = await snapshotAction(dir, d[1], request.method, url, body);
      workspaceCache.clear();
      return done ?? Response.json({ error: "not found" }, { status: 404 });
    }
    const m = /^\/api\/admin\/workspaces\/([a-z0-9-]+)(?:\/([a-z]+))?$/.exec(path);
    if (!m) return Response.json({ error: "not found" }, { status: 404 });
    const [, slug, action] = m;
    if (!(await dir.workspace(slug))) return Response.json({ error: `no workspace ${slug}` }, { status: 404 });
    const hub = workspaceHub(env, slug);
    const body = request.method === "POST" ? await jsonBody(request) : {};
    workspaceCache.delete(slug);
    if (!action && request.method === "POST") {
      if (typeof body.suspended === "boolean") await dir.setSuspended(slug, body.suspended);
      return Response.json({ workspace: await dir.workspace(slug) });
    }
    if (!action && request.method === "DELETE") {
      // Agents' OAuth grants live outside the workspace; end them first.
      for (const m of await hub.members()) await revokeGrants(env, workspaceOrigin(env, slug), slug, m.email, hub);
      await hub.destroy();
      await dir.removeWorkspace(slug);
      return Response.json({ deleted: slug });
    }
    if (action === "stats" && request.method === "POST") {
      const stats = await hub.stats();
      await dir.recordStats(slug, stats);
      return Response.json({ stats });
    }
    const done = action ? await snapshotAction(hub, action, request.method, url, body) : null;
    if (done) return done;
    if (action === "tokens" && request.method === "POST") {
      const email = String(body.email ?? "").toLowerCase();
      if (!isTestAddress(email)) return Response.json({ error: "only test addresses" }, { status: 400 });
      return Response.json(await hub.createToken(email, "End-to-end check"));
    }
  } catch (err) {
    return failure(err);
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

type Snapshots = Pick<HubApi, "exportPage" | "importRows" | "backup" | "backups"> & {
  importBegin(): Promise<unknown>;
  importEnd(): Promise<unknown>;
  restore(date: string): Promise<unknown>;
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
  if (action === "backups" && method === "GET") return Response.json({ dates: await store.backups() });
  if (action === "backup" && method === "POST") return Response.json({ prefix: await store.backup() });
  if (action === "restore" && method === "POST") return Response.json({ done: await store.restore(String(body.date ?? "")) });
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

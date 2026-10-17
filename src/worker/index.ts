// Shared Artifacts Worker: viewer pages, sessions, frame documents, sync and MCP.
import { handleMcp, runOwnerTool } from "./mcp.ts";
import { frameDocument, indexPage, messagePage, shellPage } from "./pages.ts";
import {
  clearSessionCookie,
  readCookie,
  SESSION_COOKIE,
  SESSION_TTL,
  sessionCookie,
  signToken,
  timingSafeEqual,
  verifyToken,
} from "./session.ts";
import type { ArtifactHub, HubApi } from "./hub.ts";
import type { Role } from "../shared/protocol.ts";

export { ArtifactHub } from "./hub.ts";

export type Env = {
  HUB: DurableObjectNamespace<ArtifactHub>;
  SESSION_SECRET: string;
  LOGIN_SECRET: string;
  MCP_TOKEN: string;
  /** Comma-separated owner emails. */
  OWNER_EMAILS: string;
  /** Base URL of the Access-protected auth Worker; empty until sign-in is configured. */
  AUTH_URL?: string;
  /** Cloudflare Browser Run, used for render checks after writes. */
  BROWSER?: { quickAction(action: "scrape", options: Record<string, unknown>): Promise<Response> };
};

const FRAME_TTL = 10 * 60;

type Viewer = { email: string | null; owner: boolean };

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const hub = env.HUB.getByName("hub") as unknown as HubApi;
    ctx.waitUntil(hub.refreshSources().then(() => undefined));
    // Once a day (the 10:00 UTC run), copy everything to R2 when a bucket is bound.
    const now = new Date(_event.scheduledTime);
    if (now.getUTCHours() === 10 && now.getUTCMinutes() < 15) ctx.waitUntil(hub.backupToR2().then(() => undefined));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await route(request, env);
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

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const hub = env.HUB.getByName("hub") as unknown as HubApi;
  const path = url.pathname;

  if (path === "/mcp") {
    const auth = request.headers.get("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!env.MCP_TOKEN || !timingSafeEqual(token, env.MCP_TOKEN)) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return handleMcp(request, hub, url.origin, env);
  }
  if (path === "/healthz") return new Response("ok");
  if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
  if (path.startsWith("/admin/")) return admin(request, url, env, hub);

  const viewer = await currentViewer(request, env);

  if (path === "/") {
    const artifacts = viewer.email ? await hub.list(viewer) : [];
    const summaries = viewer.owner ? await hub.shareSummaries() : undefined;
    return indexPage(viewer, artifacts, Boolean(env.AUTH_URL), summaries);
  }
  if (path === "/login") return login(url, env);
  const signin = /^\/s\/([A-Za-z0-9_.-]+)$/.exec(path);
  if (signin) return presignedSignIn(signin[1], url, env, hub);
  if (path === "/auth/callback") return authCallback(url, env);
  if (path === "/logout" && request.method === "POST") {
    if (!sameOrigin(request, url)) return new Response("bad origin", { status: 403 });
    return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": clearSessionCookie() } });
  }

  const frame = /^\/frame\/([a-z0-9]+)$/.exec(path);
  if (frame) {
    const claims = await verifyToken<{ id: string; c?: boolean }>(env.SESSION_SECRET, "frame", url.searchParams.get("t"));
    if (!claims || claims.id !== frame[1]) return new Response("frame link expired; reload the page", { status: 403 });
    const result = await hub.build(frame[1]);
    if (!result) return new Response("not found", { status: 404 });
    // Asset URLs reuse this frame's token; it also authorizes /asset/ reads.
    const token = url.searchParams.get("t")!;
    const assets = Object.fromEntries(
      (await hub.assets(frame[1])).map((a) => [a.path, `/asset/${frame[1]}/${a.path}?t=${encodeURIComponent(token)}`]),
    );
    return frameDocument(url.origin, result.meta, result.build, claims.c === true, assets);
  }

  if (path.startsWith("/api/")) return ownerApi(request, url, env, hub, viewer);

  const asset = /^\/asset\/([a-z0-9]+)\/(assets\/[A-Za-z0-9_./-]+)$/.exec(path);
  if (asset) {
    const claims = await verifyToken<{ id: string }>(env.SESSION_SECRET, "frame", url.searchParams.get("t"));
    if (!claims || claims.id !== asset[1]) return new Response("asset link expired; reload the page", { status: 403 });
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
    const role = await hub.roleFor(id, viewer.email, viewer.owner);
    if (!role) {
      if (!viewer.email && env.AUTH_URL && !sub) {
        return Response.redirect(`${url.origin}/login?return=${encodeURIComponent(path)}`, 302);
      }
      return sub
        ? new Response("forbidden", { status: 403 })
        : messagePage(
            "Not available",
            viewer.email
              ? `${viewer.email} doesn't have access to this artifact, or it doesn't exist.`
              : "Sign in to open this artifact.",
            viewer.email ? 403 : 401,
            viewer.email ? undefined : env.AUTH_URL ? { href: `/login?return=${encodeURIComponent(path)}`, label: "Sign in" } : undefined,
          );
    }
    if (sub === "/sync") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      if (!sameOrigin(request, url)) return new Response("bad origin", { status: 403 });
      const headers = new Headers(request.headers);
      headers.set("X-Art-Id", id);
      headers.set("X-Art-Role", role);
      headers.set("X-Art-Email", viewer.email ?? "");
      return hub.fetch(new Request(request.url, { headers }));
    }
    if (sub === "/errors") {
      if (request.method !== "POST" || !sameOrigin(request, url)) return new Response("bad request", { status: 400 });
      const body = (await request.json().catch(() => null)) as { message?: string; stack?: string } | null;
      if (body?.message) await hub.recordError(id, viewer.email, String(body.message), body.stack ? String(body.stack) : undefined);
      return new Response(null, { status: 204 });
    }
    const meta = await hub.meta(id);
    if (!meta) return messagePage("Not found", "This artifact doesn't exist.", 404);
    const token = await signToken(env.SESSION_SECRET, "frame", FRAME_TTL, { id, e: viewer.email });
    return shellPage({
      artifactId: id,
      title: meta.title,
      version: meta.version,
      frameUrl: `/frame/${id}?v=${meta.version}&t=${encodeURIComponent(token)}`,
      syncUrl: `/a/${id}/sync`,
      viewer: { email: viewer.email, role: role as Role },
    });
  }

  return messagePage("Not found", "There's nothing here.", 404);
}

/**
 * Sliding sessions: a visit more than a day after the cookie was issued gets a
 * fresh 30-day cookie, so a session only lapses after 30 days without use.
 */
async function renewSession(request: Request, env: Env, response: Response) {
  if (response.status === 101 || response.headers.has("Set-Cookie")) return;
  const claims = await verifyToken<{ e: string }>(env.SESSION_SECRET, "session", readCookie(request, SESSION_COOKIE));
  if (!claims || claims.exp - Date.now() / 1000 > SESSION_TTL - 86400) return;
  const fresh = await signToken(env.SESSION_SECRET, "session", SESSION_TTL, { e: claims.e });
  try {
    response.headers.append("Set-Cookie", sessionCookie(fresh));
  } catch {
    // immutable headers (e.g. Response.redirect); the next page view renews instead
  }
}

async function currentViewer(request: Request, env: Env): Promise<Viewer> {
  const claims = await verifyToken<{ e: string }>(env.SESSION_SECRET, "session", readCookie(request, SESSION_COOKIE));
  const email = claims?.e ?? null;
  return { email, owner: email !== null && ownerEmails(env).has(email) };
}

function ownerEmails(env: Env): Set<string> {
  return new Set(
    (env.OWNER_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

function login(url: URL, env: Env): Response {
  if (!env.AUTH_URL) return messagePage("Sign-in unavailable", "Sign-in is not configured yet.", 503);
  const next = safeNext(url.searchParams.get("return"));
  const callback = `${url.origin}/auth/callback?next=${encodeURIComponent(next)}`;
  return Response.redirect(`${env.AUTH_URL.replace(/\/$/, "")}/?return=${encodeURIComponent(callback)}`, 302);
}

async function authCallback(url: URL, env: Env): Promise<Response> {
  const claims = await verifyToken<{ e: string; aud: string }>(env.LOGIN_SECRET, "login", url.searchParams.get("code"));
  if (!claims || claims.aud !== url.origin) {
    return messagePage("Sign-in failed", "That sign-in link expired. Try again.", 400, { href: "/login", label: "Sign in" });
  }
  const session = await signToken(env.SESSION_SECRET, "session", SESSION_TTL, { e: claims.e.toLowerCase() });
  return new Response(null, {
    status: 303,
    headers: { Location: safeNext(url.searchParams.get("next")), "Set-Cookie": sessionCookie(session) },
  });
}

/**
 * Presigned sign-in link (from artifact_link / artifact_share): signs this
 * browser in as the link's email and opens the artifact. The link only grants
 * what that email already has, so unsharing still cuts it off.
 */
async function presignedSignIn(code: string, url: URL, env: Env, hub: HubApi): Promise<Response> {
  const claims = await verifyToken<{ e: string; a: string }>(env.LOGIN_SECRET, "link", code);
  if (!claims) {
    return messagePage("Link expired", "This link has expired or is invalid. Ask for a new one.", 400);
  }
  const email = claims.e.toLowerCase();
  const role = await hub.roleFor(claims.a, email, ownerEmails(env).has(email));
  if (!role) return messagePage("Not available", `${email} doesn't have access to this artifact anymore.`, 403);
  const session = await signToken(env.SESSION_SECRET, "session", SESSION_TTL, { e: email });
  return new Response(null, {
    status: 303,
    headers: { Location: `/a/${claims.a}`, "Set-Cookie": sessionCookie(session), "Referrer-Policy": "no-referrer" },
  });
}

function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function sameOrigin(request: Request, url: URL): boolean {
  return request.headers.get("Origin") === url.origin;
}

/**
 * Admin endpoints (bearer MCP token):
 * - GET /admin/export: everything as JSON (asset bytes base64, screenshots omitted).
 * - POST /admin/import <export>: replace ALL data with an export (one transaction).
 * - POST /admin/backup: write today's export to the R2 bucket now (the cron does it daily).
 */
async function admin(request: Request, url: URL, env: Env, hub: HubApi): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!env.MCP_TOKEN || !timingSafeEqual(auth.startsWith("Bearer ") ? auth.slice(7) : "", env.MCP_TOKEN)) {
    return new Response("unauthorized", { status: 401 });
  }
  if (url.pathname === "/admin/export" && request.method === "GET") {
    const data = await hub.exportAll();
    return new Response(JSON.stringify({ exportedAt: new Date().toISOString(), tables: data }), {
      headers: { "Content-Type": "application/json", "Content-Disposition": "attachment; filename=artifacts-export.json" },
    });
  }
  if (url.pathname === "/admin/backup" && request.method === "POST") {
    const key = await hub.backupToR2();
    return key ? Response.json({ key }) : Response.json({ error: "no BACKUPS bucket bound" }, { status: 409 });
  }
  if (url.pathname === "/admin/import" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { tables?: Record<string, Record<string, unknown>[]> } | null;
    if (!body?.tables?.artifacts) return new Response("expected an export ({ tables: { artifacts: [...] } })", { status: 400 });
    try {
      return Response.json({ imported: await hub.importAll(body.tables) });
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 400 });
    }
  }
  return new Response("not found", { status: 404 });
}

/**
 * Owner menu API (session cookie, owner only, same-origin JSON):
 * - GET  /api/a/<id>               overview: meta, shares, history, errors, sources, assets, approved hosts
 * - POST /api/a/<id>/<tool>        one of the owner-menu MCP tools, with the same arguments
 * - POST /api/hosts {host, allowed} approve or revoke a live-data host
 */
async function ownerApi(request: Request, url: URL, env: Env, hub: HubApi, viewer: Viewer): Promise<Response> {
  if (!viewer.owner) return Response.json({ error: "owner only" }, { status: 403 });
  if (request.method !== "GET" && !sameOrigin(request, url)) return Response.json({ error: "bad origin" }, { status: 403 });
  const ctx = { hub, origin: url.origin, env };
  if (url.pathname === "/api/hosts" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { host?: string; allowed?: boolean };
    try {
      const hosts = await hub.setHostAllowed(String(body.host ?? ""), body.allowed !== false);
      if (body.allowed !== false) await hub.refreshSources();
      return Response.json({ hosts });
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 400 });
    }
  }
  const m = /^\/api\/a\/([a-z0-9]+)(?:\/([a-z_]+))?$/.exec(url.pathname);
  if (!m) return Response.json({ error: "not found" }, { status: 404 });
  const [, id, action] = m;
  if (!action && request.method === "GET") {
    const meta = await hub.meta(id);
    if (!meta) return Response.json({ error: "not found" }, { status: 404 });
    const [history, errors, sources, assets, hosts] = await Promise.all([
      hub.history(id),
      hub.errors(id),
      hub.sources(id),
      hub.assets(id),
      hub.allowedHosts(),
    ]);
    return Response.json({ meta, history, errors, sources, assets, hosts });
  }
  if (action && request.method === "POST") {
    const args = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    const r = await runOwnerTool(action, { ...args, id }, ctx);
    return Response.json({ ok: !r.isError, text: r.text, data: r.structured ?? null }, { status: r.isError ? 400 : 200 });
  }
  return Response.json({ error: "method not allowed" }, { status: 405 });
}

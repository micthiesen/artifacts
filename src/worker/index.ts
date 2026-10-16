// Shared Artifacts Worker: viewer pages, sessions, frame documents, sync and MCP.
import { handleMcp } from "./mcp.ts";
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
};

const FRAME_TTL = 10 * 60;

type Viewer = { email: string | null; owner: boolean };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
      return handleMcp(request, hub, url.origin);
    }
    if (path === "/healthz") return new Response("ok");

    const viewer = await currentViewer(request, env);

    if (path === "/") {
      const artifacts = viewer.email ? await hub.list(viewer) : [];
      return indexPage(viewer, artifacts, Boolean(env.AUTH_URL));
    }
    if (path === "/login") return login(url, env);
    if (path === "/auth/callback") return authCallback(url, env);
    if (path === "/logout" && request.method === "POST") {
      if (!sameOrigin(request, url)) return new Response("bad origin", { status: 403 });
      return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": clearSessionCookie() } });
    }

    const frame = /^\/frame\/([a-z0-9]+)$/.exec(path);
    if (frame) {
      const claims = await verifyToken<{ id: string }>(env.SESSION_SECRET, "frame", url.searchParams.get("t"));
      if (!claims || claims.id !== frame[1]) return new Response("frame link expired; reload the page", { status: 403 });
      const result = await hub.build(frame[1]);
      if (!result) return new Response("not found", { status: 404 });
      return frameDocument(url.origin, result.meta, result.build);
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
  },
};

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

function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function sameOrigin(request: Request, url: URL): boolean {
  return request.headers.get("Origin") === url.origin;
}

// HTML documents: the index, the shell around an artifact, and the sandboxed
// frame document that renders it.
import type { Build } from "./compile.ts";
import type { ArtifactMeta } from "./hub.ts";
import type { FrameBoot, Role, ShellBoot } from "../shared/protocol.ts";

const KIT = "/kit/v1";
declare const __ASSET_VERSION__: string;
const ASSET_VERSION = typeof __ASSET_VERSION__ === "string" ? __ASSET_VERSION__ : "dev";
const kit = (file: string) => `${KIT}/${file}?v=${ASSET_VERSION}`;
const asset = (path: string) => `${path}?v=${ASSET_VERSION}`;

export const KIT_IMPORTS: Record<string, string> = {
  react: kit("react.js"),
  "react/jsx-runtime": kit("jsx-runtime.js"),
  "react-dom/client": kit("react-dom-client.js"),
  "@a/ui": kit("ui.js"),
  "@a/hooks": kit("hooks.js"),
  "lucide-react": kit("lucide.js"),
  recharts: kit("recharts.js"),
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** JSON safe to embed inside a <script> element. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function page(title: string, body: string, init: ResponseInit = {}): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<meta name="theme-color" content="#0b0d15">
<meta name="apple-mobile-web-app-title" content="Artifacts">
<link rel="icon" href="${asset("/static/icons/icon.svg")}" type="image/svg+xml">
<link rel="icon" href="${asset("/static/icons/favicon-32.png")}" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="${asset("/static/icons/apple-touch-icon.png")}">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="${asset("/static/shell.css")}">
</head>
<body>${body}</body>
</html>`;
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", PAGE_CSP);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "no-store");
  return new Response(html, { ...init, headers });
}

function topBar(right = ""): string {
  return `<header class="bar"><span class="lead"><a class="mark" href="/" aria-label="All artifacts">◆</a><a class="title" href="/">Artifacts</a></span>${right}</header>`;
}

function relativeTime(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return iso.slice(0, 10);
}

type ShareSummary = { shares: { email: string; role: string }[]; public: boolean };

function sharingLine(s: ShareSummary | undefined): string {
  if (!s) return "";
  const parts = s.shares.map((x) => `${escapeHtml(x.email)}${x.role === "edit" ? " (edit)" : ""}`);
  if (s.public) parts.unshift("public link");
  if (!parts.length) return `<span class="sharing">Only you</span>`;
  const shown = parts.slice(0, 4).join(", ");
  return `<span class="sharing">Shared with ${shown}${parts.length > 4 ? ` +${parts.length - 4} more` : ""}</span>`;
}

const ICON_ARCHIVE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>';
const ICON_RESTORE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h2"/><path d="M20 8v11a2 2 0 0 1-2 2h-2"/><path d="m9 15 3-3 3 3"/><path d="M12 12v9"/></svg>';

type ListedArtifact = ArtifactMeta & { role: Role; unseen?: boolean; unread?: number };

/**
 * The artifact list. `archived` shows the archive instead: artifacts the owner
 * is done with, hidden from the main list but still readable.
 */
export function indexPage(
  viewer: { email: string | null; owner?: boolean },
  all: ListedArtifact[],
  loginConfigured: boolean,
  summaries?: Record<string, ShareSummary>,
  archived = false,
): Response {
  const account = viewer.email
    ? `<span id="me" class="me" data-email="${escapeHtml(viewer.email)}"></span><script type="module" src="${asset("/static/account.js")}"></script>`
    : loginConfigured
      ? `<a class="button small" href="/login?return=${archived ? "/archived" : "/"}">Sign in</a>`
      : "";
  const artifacts = all.filter((a) => Boolean(a.archivedAt) === archived);
  if (archived) artifacts.sort((a, b) => b.archivedAt!.localeCompare(a.archivedAt!));
  const archivedCount = archived ? 0 : all.length - artifacts.length;
  // Always present (hidden at zero) so archiving the first row can reveal it.
  const archivedLink = `<p class="archived-link"${archivedCount ? "" : " hidden"}><a href="/archived">${ICON_ARCHIVE}Archived · <span data-archived-count>${archivedCount}</span></a></p>`;
  let body: string;
  if (!viewer.email) {
    body = `<section class="empty"><h1>Artifacts</h1><p class="muted">${
      loginConfigured
        ? "Sign in with your email to see artifacts shared with you."
        : "Open the link you were sent to view an artifact."
    }</p></section>`;
  } else if (archived) {
    body = `<p class="back-link"><a href="/">← All artifacts</a></p><h1 class="page-title">Archived</h1><p class="muted page-lede">Hidden from the main list. They still open at their links, with history and comments.</p>${
      list(artifacts, viewer, summaries, true)
    }<p class="muted archive-empty" data-list-empty${artifacts.length ? " hidden" : ""}>Nothing archived.</p>`;
  } else if (!artifacts.length) {
    body = all.length
      ? `<section class="empty"><h1>All tidy</h1><p class="muted">Everything here is archived.</p></section>${archivedLink}`
      : `<section class="empty"><h1>Nothing here yet</h1><p class="muted">Artifacts shared with ${escapeHtml(viewer.email)} will show up here.</p></section>`;
  } else {
    body = `<h1 class="page-title">Artifacts</h1>${list(artifacts, viewer, summaries, false)}<section class="empty" data-list-empty hidden><h1>All tidy</h1><p class="muted">Everything here is archived.</p></section>${archivedLink}`;
  }
  const script = `<script type="module" src="${asset("/static/home.js")}"></script>`;
  return page(archived ? "Archived · Artifacts" : "Artifacts", `${topBar(account)}<main class="content">${body}</main>${script}`);
}

function list(artifacts: ListedArtifact[], viewer: { owner?: boolean }, summaries: Record<string, ShareSummary> | undefined, archived: boolean): string {
  return `<ul class="list" data-list="${archived ? "archived" : "active"}">${artifacts
    .map((a, i) => {
      const when = archived ? `archived ${relativeTime(a.archivedAt!)}` : relativeTime(a.updatedAt);
      const action = viewer.owner
        ? `<button type="button" class="row-action" data-action="${archived ? "unarchive" : "archive"}" title="${archived ? "Unarchive" : "Archive"}" aria-label="${
            archived ? "Unarchive" : "Archive"
          } ${escapeHtml(a.title)}">${archived ? ICON_RESTORE : ICON_ARCHIVE}</button>`
        : "";
      return `<li data-id="${a.id}" data-order="${i}" data-title="${escapeHtml(a.title)}"><a href="/a/${a.id}"><span class="title">${escapeHtml(a.title)}${archived ? "" : activityBadge(a)}</span>${
        a.description ? `<span class="desc">${escapeHtml(a.description)}</span>` : ""
      }${summaries ? sharingLine(summaries[a.id]) : ""}<span class="meta">${when} · v${a.version}${a.public && !summaries ? " · public" : ""}${
        a.role === "owner" ? "" : ` · ${a.role}`
      } · <code>${a.id}</code></span></a>${action}</li>`;
    })
    .join("")}</ul>`;
}

function activityBadge(a: { unseen?: boolean; unread?: number }): string {
  const parts: string[] = [];
  if (a.unread) parts.push(`<span class="badge" title="Unread comments">${a.unread} new ${a.unread === 1 ? "comment" : "comments"}</span>`);
  else if (a.unseen) parts.push(`<span class="dot" title="Updated since you last looked" aria-label="Updated since you last looked"></span>`);
  return parts.join("");
}

/**
 * What link-preview fetchers get. Without `title` it's a generic card that
 * reveals nothing about the artifact.
 */
export function previewPage(p: { url: string; origin: string; title?: string; description?: string; image?: string }): Response {
  const title = p.title ?? "Private artifact";
  const description = p.title ? p.description || "Artifacts" : "Artifacts · sign in to view";
  const image = p.image ?? `${p.origin}${asset("/static/icons/og.png")}`;
  const [w, h] = p.image ? [1024, 768] : [1200, 630];
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="robots" content="noindex, nofollow">
<meta name="description" content="${escapeHtml(description)}">
<meta name="theme-color" content="#7c6cff">
<meta property="og:site_name" content="Artifacts">
<meta property="og:type" content="website">
<meta property="og:url" content="${escapeHtml(p.url)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta property="og:image:width" content="${w}">
<meta property="og:image:height" content="${h}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(image)}">
<link rel="icon" href="${asset("/static/icons/favicon-32.png")}" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="${asset("/static/icons/apple-touch-icon.png")}">
</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300", "X-Robots-Tag": "noindex, nofollow" },
  });
}

/** Profile and notification settings; the client (me.js) loads and edits everything through /api/me. */
export function profilePage(email: string, webPush: boolean, pushover: boolean): Response {
  return page(
    "Notifications · Artifacts",
    `${topBar(`<span id="me" class="me" data-email="${escapeHtml(email)}"></span>`)}<main class="content profile" id="profile" data-webpush="${webPush ? "1" : ""}" data-pushover="${pushover ? "1" : ""}"><h1 class="page-title">Profile and notifications</h1><p class="muted">Loading…</p></main><script type="module" src="${asset("/static/account.js")}"></script><script type="module" src="${asset("/static/me.js")}"></script>`,
  );
}

export function messagePage(title: string, message: string, status: number, action?: { href: string; label: string }): Response {
  const act = action ?? { href: "/", label: "All artifacts" };
  return page(
    title,
    `${topBar()}<main class="content"><section class="empty"><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(message)}</p><p><a class="button" href="${escapeHtml(act.href)}">${escapeHtml(act.label)}</a></p></section></main>`,
    { status },
  );
}

export function shellPage(boot: ShellBoot): Response {
  return page(
    boot.title,
    `<div class="shell">
<header class="bar"><span class="lead"><a class="mark" href="/" title="All artifacts" aria-label="All artifacts">◆</a><span class="title" title="${escapeHtml(boot.title)}">${escapeHtml(boot.title)}</span></span><span id="status" class="status"></span><span id="presence" class="presence"></span>${
      boot.viewer.email ? `<span id="me" class="me" data-email="${escapeHtml(boot.viewer.email)}"></span>` : ""
    }</header>
<div id="since" class="since" hidden></div>
<div class="workspace"><div id="frame-host" class="frame-host"></div><aside id="threads" class="threads" hidden aria-label="Comments"></aside></div>
</div>
<script type="application/json" id="shell-boot">${scriptJson(boot)}</script>
<script type="module" src="${asset("/static/shell.js")}"></script>`,
  );
}

export function frameCsp(origin: string, sandbox = true): string {
  const kit = `${origin}${KIT}/`;
  return [
    // The render checker opens frames top-level with no cookies; Browser Run
    // doesn't run module scripts from an opaque origin, so check mode is the
    // one case served unsandboxed. Network access stays blocked either way.
    ...(sandbox ? ["sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"] : []),
    "default-src 'none'",
    `script-src 'unsafe-inline' data: ${kit}`,
    `style-src 'unsafe-inline' ${kit}`,
    `font-src ${kit} data:`,
    `img-src data: blob: ${origin}/asset/`,
    `media-src data: blob: ${origin}/asset/`,
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${origin}`,
  ].join("; ");
}

export function frameDocument(origin: string, meta: ArtifactMeta, build: Build, check = false, assets: Record<string, string> = {}): Response {
  const boot: FrameBoot = {
    artifactId: meta.id,
    version: meta.version,
    entry: build.entry,
    data: build.data,
    title: meta.title,
    ...(check ? { check: true } : {}),
    ...(Object.keys(assets).length ? { assets } : {}),
  };
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${kit("kit.css")}">
<style>${build.css.replace(/<\/style/gi, "<\\/style")}</style>
<script type="importmap">${scriptJson({ imports: { ...KIT_IMPORTS, ...build.imports } })}</script>
<script type="application/json" id="art-boot">${scriptJson(boot)}</script>
<script type="module" src="${kit("boot.js")}"></script>
</head>
<body><div id="root"></div></body>
</html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": frameCsp(origin, !check),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

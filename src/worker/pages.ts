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
  return `<header class="bar"><a class="brand" href="/"><span class="mark">◆</span>Shared Artifacts</a><span class="spacer"></span>${right}</header>`;
}

function relativeTime(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return iso.slice(0, 10);
}

export function indexPage(viewer: { email: string | null }, artifacts: (ArtifactMeta & { role: Role })[], loginConfigured: boolean): Response {
  const account = viewer.email
    ? `<form class="account" method="post" action="/logout"><span class="muted email">${escapeHtml(viewer.email)}</span><button class="link">Sign out</button></form>`
    : loginConfigured
      ? `<a class="button small" href="/login?return=/">Sign in</a>`
      : "";
  let body: string;
  if (!viewer.email) {
    body = `<section class="empty"><h1>Shared Artifacts</h1><p class="muted">${
      loginConfigured
        ? "Sign in with your email to see artifacts shared with you."
        : "Open the link you were sent to view an artifact."
    }</p><p class="fine"><a href="/owner">Owner sign-in</a></p></section>`;
  } else if (!artifacts.length) {
    body = `<section class="empty"><h1>Nothing here yet</h1><p class="muted">Artifacts shared with ${escapeHtml(viewer.email)} will show up here.</p></section>`;
  } else {
    body = `<h1 class="page-title">Artifacts</h1><ul class="list">${artifacts
      .map(
        (a) => `<li><a href="/a/${a.id}"><span class="title">${escapeHtml(a.title)}</span>${
          a.description ? `<span class="desc">${escapeHtml(a.description)}</span>` : ""
        }<span class="meta">${relativeTime(a.updatedAt)} · v${a.version}${a.public ? " · public" : ""}${
          a.role === "owner" ? "" : ` · ${a.role}`
        } · <code>${a.id}</code></span></a></li>`,
      )
      .join("")}</ul>`;
  }
  return page("Shared Artifacts", `${topBar(account)}<main class="content">${body}</main>`);
}

export function messagePage(title: string, message: string, status: number, action?: { href: string; label: string }): Response {
  const act = action ?? { href: "/", label: "All artifacts" };
  return page(
    title,
    `${topBar()}<main class="content"><section class="empty"><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(message)}</p><p><a class="button" href="${escapeHtml(act.href)}">${escapeHtml(act.label)}</a></p></section></main>`,
    { status },
  );
}

export function ownerLoginPage(): Response {
  return page(
    "Owner sign-in",
    `${topBar()}<main class="content"><section class="empty"><h1>Owner sign-in</h1><p id="owner-status" class="muted">Signing in…</p>
<form id="owner-form" class="key-form" hidden><input type="text" name="username" value="owner" autocomplete="username" hidden><label for="owner-key">Owner key</label><div class="row"><input id="owner-key" class="input" type="password" autocomplete="current-password" required><button class="button" type="submit">Sign in</button></div></form></section></main>
<script type="module" src="${asset("/static/owner.js")}"></script>`,
  );
}

export function shellPage(boot: ShellBoot): Response {
  return page(
    boot.title,
    `<div class="shell">
<header class="bar"><a class="home" href="/" title="All artifacts" aria-label="All artifacts">◆</a><span class="title" title="${escapeHtml(boot.title)}">${escapeHtml(boot.title)}</span><span id="status" class="status"></span><span id="presence" class="presence"></span></header>
<div id="frame-host" class="frame-host"></div>
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
    "img-src data: blob:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${origin}`,
  ].join("; ");
}

export function frameDocument(origin: string, meta: ArtifactMeta, build: Build, check = false): Response {
  const boot: FrameBoot = {
    artifactId: meta.id,
    version: meta.version,
    entry: build.entry,
    data: build.data,
    title: meta.title,
    ...(check ? { check: true } : {}),
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

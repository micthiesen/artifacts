// HTML documents: the splash page and sign-in on the apex, workspace pages, the
// shell around an artifact, and the sandboxed frame document that renders it.
import type { SoundsCookie } from "../shared/sound.ts";
import type { Build } from "./compile.ts";
import type { ArtifactMeta } from "./hub.ts";
import type { WorkspaceRole } from "./directory.ts";
import type { FrameBoot, Role, ShellBoot } from "../shared/protocol.ts";
import { PRODUCT } from "../shared/brand.ts";
import { relativeTime } from "../shared/time.ts";
import { PLANS } from "./plans.ts";
import type { Listing } from "./listing.ts";
import { TEAM_PRICE } from "./billing.ts";
import demos from "./demos.json";
import demoLinks from "../../demo/links.json";

const KIT = "/kit/v1";
declare const __ASSET_VERSION__: string;
const ASSET_VERSION = typeof __ASSET_VERSION__ === "string" ? __ASSET_VERSION__ : "dev";
/** This deployment's build, as support cases and error reports record it. */
export const APP_VERSION = ASSET_VERSION;
const kit = (file: string, version = ASSET_VERSION) => `${KIT}/${file}?v=${version}`;
const asset = (path: string) => `${path}?v=${ASSET_VERSION}`;

function kitImports(version: string): Record<string, string> {
  return {
    react: kit("react.js", version),
    "react/jsx-runtime": kit("jsx-runtime.js", version),
    "react-dom/client": kit("react-dom-client.js", version),
    "@a/ui": kit("ui.js", version),
    "@a/hooks": kit("hooks.js", version),
    "lucide-react": kit("lucide.js", version),
    recharts: kit("recharts.js", version),
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** JSON safe to embed inside a <script> element. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// Cloudflare injects its Web Analytics beacon into shell pages; the CSP lets it
// load and report. Artifact frames opt out with no-transform (see frameDocument).
const PAGE_CSP =
  "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://cloudflareinsights.com; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// Declared inline so the very first paint is dark: without it the browser shows
// its white default canvas until the stylesheet arrives, and a frame that is
// still "light" inside the dark shell gets an opaque white backdrop.
const DARK_HEAD = `<meta name="color-scheme" content="dark">
<style>html{background:oklch(0.16 0.017 275)}</style>`;

/** shell.css's face, fetched with the stylesheet instead of after it: the same URL, so the two share one cache entry. */
const INTER_PRELOAD = `<link rel="preload" href="/kit/v1/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>`;

function page(title: string, body: string, init: ResponseInit = {}, head = ""): Response {
  // Pages with server-rendered POST forms load the double-submit guard (src/shell/forms.ts).
  const forms = /<form\b[^>]*\bmethod="post"/i.test(body) ? `<script type="module" src="${asset("/static/forms.js")}"></script>\n` : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${DARK_HEAD}
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<meta name="theme-color" content="#0b0d15">
<meta name="apple-mobile-web-app-title" content="${PRODUCT}">
<link rel="icon" href="${asset("/static/icons/icon.svg")}" type="image/svg+xml">
<link rel="icon" href="${asset("/static/icons/favicon-32.png")}" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="${asset("/static/icons/apple-touch-icon.png")}">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="${asset("/static/shell.css")}">
${INTER_PRELOAD}
${forms}${head}</head>
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

export { PRODUCT };

/** Whose pages these are: the apex (PRODUCT) or a workspace (its name). */
/** `sounds`: the cookie the apex and every workspace share for the Sounds choice (src/shared/sound.ts). */
export type Brand = { name: string; home: string; apex: string; sounds?: SoundsCookie };

/** The ghost logo, drawn by CSS (a gradient through an SVG mask). */
const GHOST = `<span class="logo-ghost" aria-hidden="true"></span>`;

/** The brand's name as a title: the product's own name gets its wordmark. */
function brandName(brand: Brand): string {
  return brand.name === PRODUCT ? `artifacts<span class="wordmark-tld">.boo</span>` : escapeHtml(brand.name);
}

function topBar(brand: Brand, right = ""): string {
  return `<header class="bar"><span class="lead"><a class="mark" href="${escapeHtml(brand.home)}" aria-label="${escapeHtml(brand.name)}">${GHOST}</a><a class="title" href="${escapeHtml(brand.home)}">${brandName(brand)}</a></span>${right}</header>`;
}

/** The avatar slot account.js mounts the menu into. `context` and the flags decide which links it offers. */
function avatar(email: string, brand: Brand, context: "account" | "workspace", flags: { member?: boolean; scoped?: boolean; operator?: boolean } = {}): string {
  const attrs = [
    `data-email="${escapeHtml(email)}"`,
    `data-apex="${escapeHtml(brand.apex)}"`,
    `data-context="${context}"`,
    ...(brand.sounds ? [`data-sounds-cookie="${escapeHtml(brand.sounds.name)}"`, `data-sounds-domain="${escapeHtml(brand.sounds.domain)}"`] : []),
    ...(flags.member ? ['data-member="1"'] : []),
    ...(flags.scoped ? ['data-scoped="1"'] : []),
    ...(flags.operator ? ['data-operator="1"'] : []),
  ];
  return `<span id="me" class="me" ${attrs.join(" ")}></span>`;
}

const ACCOUNT_SCRIPT = `<script type="module" src="${asset("/static/account.js")}"></script>`;

type ShareSummary = { shares: { email: string; role: string }[]; public: boolean; publicUntil?: string | null };

function sharingLine(s: ShareSummary | undefined): string {
  if (!s) return "";
  const parts = s.shares.map((x) => `${x.email === "workspace" ? "everyone in the workspace" : escapeHtml(x.email)}${x.role === "edit" ? " (edit)" : ""}`);
  if (s.public) parts.unshift(s.publicUntil ? `public link until ${s.publicUntil.slice(0, 10)}` : "public link");
  if (!parts.length) return `<span class="sharing">Only you</span>`;
  const shown = parts.slice(0, 4).join(", ");
  return `<span class="sharing">Shared with ${shown}${parts.length > 4 ? ` +${parts.length - 4} more` : ""}</span>`;
}

const ICON_ARCHIVE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>';
const ICON_RESTORE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h2"/><path d="M20 8v11a2 2 0 0 1-2 2h-2"/><path d="m9 15 3-3 3 3"/><path d="M12 12v9"/></svg>';

const ICON_PIN =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';

type ListedArtifact = ArtifactMeta & { role: Role; unseen?: boolean; unread?: number; pinnedAt?: string };

/**
 * A workspace's artifact list. `archived` shows the archive instead: artifacts
 * their owners are done with, hidden from the main list but still readable.
 */
export function indexPage(
  viewer: { email: string; member: WorkspaceRole | null },
  view: Listing<ListedArtifact>,
  brand: Brand,
  summaries?: Record<string, ShareSummary>,
  archived = false,
  connect?: { mcpUrl: string; name: string },
): Response {
  const account = `${avatar(viewer.email, brand, "workspace", { member: Boolean(viewer.member) })}${ACCOUNT_SCRIPT}`;
  const artifacts = view.rows;
  const here = archived ? "/archived" : "/";
  const href = (page: number, q = view.q) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (page > 1) params.set("page", String(page));
    const qs = params.toString();
    return `${here}${qs ? `?${qs}` : ""}`;
  };
  const archivedCount = archived ? 0 : view.archivedCount;
  // Always present (hidden at zero) so archiving the first row can reveal it.
  const archivedLink = `<p class="archived-link"${archivedCount ? "" : " hidden"}><a href="/archived">${ICON_ARCHIVE}Archived · <span data-archived-count>${archivedCount}</span></a></p>`;
  const inView = archived ? view.archivedCount : view.activeCount;
  // Search once there's enough to search, or while a search is on.
  const search =
    inView > 8 || view.q
      ? `<form class="list-search" method="get" action="${here}" role="search"><input class="input" type="search" name="q" value="${escapeHtml(view.q)}" placeholder="Search ${archived ? "archived artifacts" : "artifacts"}" aria-label="Search artifacts" maxlength="100" autocomplete="off">${
          view.q ? `<a class="list-search-clear" href="${here}">Clear</a>` : ""
        }</form>`
      : "";
  const results = view.q ? `<p class="muted list-count">${view.total} ${view.total === 1 ? "match" : "matches"} for “${escapeHtml(view.q)}”</p>` : "";
  const pager =
    view.pages > 1
      ? `<nav class="pager" aria-label="Pages">${view.page > 1 ? `<a href="${escapeHtml(href(view.page - 1))}" rel="prev">← Newer</a>` : `<span></span>`}<span class="muted">Page ${view.page} of ${view.pages}</span>${
          view.page < view.pages ? `<a href="${escapeHtml(href(view.page + 1))}" rel="next">Older →</a>` : `<span></span>`
        }</nav>`
      : "";
  const noMatch = `<section class="empty"><h1>No matches</h1><p class="muted">Nothing ${archived ? "archived " : ""}matches “${escapeHtml(view.q)}”. <a href="${here}">Show all</a></p></section>`;
  let body: string;
  if (archived) {
    body = `<p class="back-link"><a href="/">← All artifacts</a></p><h1 class="page-title">Archived</h1><p class="muted page-lede">Hidden from the main list. They still open at their links, with history and comments.</p>${search}${results}${
      view.q && !artifacts.length ? noMatch : list(artifacts, summaries, true)
    }${pager}<p class="muted archive-empty" data-list-empty${artifacts.length || view.q ? " hidden" : ""}>Nothing archived.</p>`;
  } else if (!view.activeCount) {
    const nothing = viewer.member
      ? firstRun(connect)
      : `<section class="empty"><h1>Nothing here yet</h1><p class="muted">Artifacts in ${escapeHtml(brand.name)} shared with ${escapeHtml(viewer.email)} will show up here.</p></section>`;
    body = view.archivedCount ? `<section class="empty"><h1>All tidy</h1><p class="muted">Everything here is archived.</p></section>${archivedLink}` : nothing;
  } else {
    body = `<h1 class="page-title">Artifacts</h1>${search}${results}${view.q && !artifacts.length ? noMatch : list(artifacts, summaries, false)}${pager}<section class="empty" data-list-empty hidden><h1>All tidy</h1><p class="muted">Everything here is archived.</p></section>${archivedLink}`;
  }
  const script = `<script type="module" src="${asset("/static/home.js")}"></script>`;
  const title = archived ? `Archived · ${brand.name}` : brand.name;
  return page(title, `${topBar(brand, account)}<main class="content">${body}</main>${script}`);
}

/** A new workspace's empty list: connect an agent, then ask it for a first artifact. */
function firstRun(connect?: { mcpUrl: string; name: string }): string {
  const copy = (value: string) => `<div class="reveal-row"><code class="reveal">${escapeHtml(value)}</code><button type="button" class="button small ghost" data-copy="${escapeHtml(value)}">Copy</button></div>`;
  const prompt = "Make an artifacts.boo page with this week's project status for the team, and an approval at the end for the go-ahead.";
  return `<section class="empty first-run"><h1>Nothing here yet</h1>
<p class="muted">Your agent makes artifacts here. Two steps:</p>
<ol class="first-steps">
<li><strong>Connect it.</strong> In Claude Code:${connect ? copy(`claude mcp add --transport http ${connect.name} ${connect.mcpUrl}`) : ""}<span class="muted small">Codex, Cursor, Claude Desktop and others: see <a href="/settings">settings</a>.</span></li>
<li><strong>Ask it for something.</strong> For example:${copy(prompt)}</li>
</ol>
<p class="muted small">It signs you in the first time. Artifacts people share with you show up here too.</p></section>`;
}

function list(artifacts: ListedArtifact[], summaries: Record<string, ShareSummary> | undefined, archived: boolean): string {
  return `<ul class="list" data-list="${archived ? "archived" : "active"}">${artifacts
    .map((a, i) => {
      const when = archived ? `archived ${relativeTime(a.archivedAt!)}` : relativeTime(a.updatedAt);
      const manages = a.role === "owner";
      const pinned = Boolean(a.pinnedAt) && !archived;
      // Anyone pins for themselves (the main list only); owners also archive.
      const pin = archived
        ? ""
        : `<button type="button" class="row-action pin" data-action="${pinned ? "unpin" : "pin"}" aria-pressed="${pinned}" title="${pinned ? "Unpin" : "Pin to top"}" aria-label="${
            pinned ? "Unpin" : "Pin"
          } ${escapeHtml(a.title)}">${ICON_PIN}</button>`;
      const archiveAction = manages
        ? `<button type="button" class="row-action" data-action="${archived ? "unarchive" : "archive"}" title="${archived ? "Unarchive" : "Archive"}" aria-label="${
            archived ? "Unarchive" : "Archive"
          } ${escapeHtml(a.title)}">${archived ? ICON_RESTORE : ICON_ARCHIVE}</button>`
        : "";
      const action = pin || archiveAction ? `<span class="row-actions">${pin}${archiveAction}</span>` : "";
      const summary = manages ? summaries?.[a.id] : undefined;
      return `<li data-id="${a.id}" data-order="${i}" data-updated="${escapeHtml(a.updatedAt)}"${pinned ? ` data-pinned="${escapeHtml(a.pinnedAt!)}"` : ""} data-title="${escapeHtml(a.title)}"><a href="/a/${a.id}"><span class="title">${escapeHtml(a.title)}${archived ? "" : activityBadge(a)}</span>${
        a.description ? `<span class="desc">${escapeHtml(a.description)}</span>` : ""
      }${sharingLine(summary)}<span class="meta">${when} · v${a.version}${a.public && !summary ? " · public" : ""}${
        manages ? "" : ` · ${a.role}`
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
  const description = p.title ? p.description || PRODUCT : `${PRODUCT} · sign in to view`;
  const image = p.image ?? `${p.origin}${asset("/static/icons/og.png")}`;
  const [w, h] = p.image ? [1024, 768] : [1200, 630];
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="robots" content="noindex, nofollow">
<meta name="description" content="${escapeHtml(description)}">
<meta name="theme-color" content="#7c6cff">
<meta property="og:site_name" content="${PRODUCT}">
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
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300, no-transform", "X-Robots-Tag": "noindex, nofollow" },
  });
}

const REPO = "https://github.com/micthiesen/artifacts.boo";
/** The public principles page in the demo workspace (demo/principles, published by scripts/seed-demo.ts). */
const PRINCIPLES = (demoLinks as Record<string, string>).principles ?? null;

type Demo = { slug: string; label: string; title: string; blurb: string; entry: string; html: string; data: string[]; seed: unknown[]; link?: string };
const DEMOS = demos as Demo[];

/** The splash's examples: source on one side, the real artifact running on the other. */
function showcase(host: string): string {
  const tabs = DEMOS.map(
    (d, i) =>
      `<button type="button" role="tab" id="tab-${d.slug}" aria-controls="demo-${d.slug}" aria-selected="${i === 0}"${i ? ' tabindex="-1"' : ""}>${escapeHtml(d.label)}<span>${d.entry.endsWith(".tsx") ? "React" : "MDX"}</span></button>`,
  ).join("");
  const panels = DEMOS.map(
    (d, i) => `<div class="showcase-panel" role="tabpanel" id="demo-${d.slug}" aria-labelledby="tab-${d.slug}"${i ? " hidden" : ""}>
<div class="showcase-window">
<div class="splash-code showcase-code"><div class="splash-code-head"><span>${escapeHtml(d.entry)}</span><span class="muted">${d.data.map(escapeHtml).join(" · ") || "one file"}</span></div><pre tabindex="0"><code>${d.html}</code></pre></div>
<div class="showcase-render"><div class="showcase-url"><span class="showcase-live" aria-hidden="true"></span>acme.${escapeHtml(host)}/a/${escapeHtml(d.slug)}</div><iframe sandbox="allow-scripts allow-forms allow-modals allow-downloads" title="${escapeHtml(d.title)}, rendered" data-src="${asset(`/demo/${d.slug}`)}" data-demo="${d.slug}"></iframe></div>
</div>
<p class="showcase-blurb muted">${escapeHtml(d.blurb)}${d.link ? ` <a href="${escapeHtml(d.link)}">Open it as a public page</a>.` : ""}</p>
</div>`,
  ).join("\n");
  const seeds = Object.fromEntries(DEMOS.map((d) => [d.slug, d.seed]));
  return `<section class="showcase" id="examples" aria-labelledby="examples-title">
<h2 id="examples-title">What the agent writes, and what people open</h2>
<p class="muted showcase-lede">Three real artifacts, compiled and rendered by the same code as any other. Vote, tick and type in them: nothing leaves your browser.</p>
<div class="showcase-bar"><div class="showcase-tabs" role="tablist" aria-label="Examples">${tabs}</div>
<div class="showcase-toggle" role="group" aria-label="Show"><button type="button" data-view="render" aria-pressed="true">Rendered</button><button type="button" data-view="code" aria-pressed="false">Source</button></div></div>
${panels}
<noscript><p class="muted">Turn on JavaScript to see the examples running.</p></noscript>
</section>
<script type="application/json" id="demo-seed">${scriptJson(seeds)}</script>
<script type="module" src="${asset("/static/splash.js")}"></script>`;
}

/** What this is, in one sentence: the splash page and link previews of the apex. */
export const DESCRIPTION = "Collaborative documents and little apps your agent can build, inspect and maintain.";

/** A public apex page's description and canonical address, for search engines and link previews. */
function publicHead(brand: Brand, path: string, description: string, extra = ""): string {
  return `<meta name="description" content="${escapeHtml(description)}">\n<link rel="canonical" href="${escapeHtml(brand.apex)}${path}">\n${extra}`;
}

/** What the front page says about the product to search engines: only what's true (no ratings or reviews). */
function appJsonLd(brand: Brand, pricing: boolean): string {
  const app: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: PRODUCT,
    url: `${brand.apex}/`,
    description: DESCRIPTION,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
  };
  if (pricing) {
    app.offers = [
      { "@type": "Offer", name: PLANS.free.label, price: "0", priceCurrency: "USD" },
      { "@type": "Offer", name: PLANS.team.label, price: String(TEAM_PRICE.amount), priceCurrency: "USD", description: `per workspace a ${TEAM_PRICE.period}`, url: `${brand.apex}/pricing` },
    ];
  }
  return `<script type="application/ld+json">${scriptJson(app)}</script>\n`;
}

/**
 * The apex front page, for everyone: what this is, for developers, and how to
 * run it. Someone signed in also gets their account menu and a way to their
 * workspaces (/workspaces).
 */
export function splashPage(brand: Brand, notice?: string, viewer?: { email: string; operator: boolean }, pricing = false, selfServe = false): Response {
  const card = (title: string, body: string, points: string[]) =>
    `<div class="splash-card"><h3>${escapeHtml(title)}</h3><p class="muted">${escapeHtml(body)}</p><ul>${points.map((x) => `<li>${x}</li>`).join("")}</ul></div>`;
  const host = brand.apex.replace(/^https?:\/\//, "") || PRODUCT;
  return page(
    `${PRODUCT}: live pages your agent builds`,
    `${topBar(
      brand,
      // Signed in, the bar holds the account controls; pricing stays in the footer and settings.
      `${pricing && !viewer ? `<a class="bar-link" href="/pricing">Pricing</a>` : ""}<a class="bar-link" href="${REPO}">GitHub</a>${
        viewer
          ? `<a class="button small secondary" href="/workspaces">Your workspaces</a>${avatar(viewer.email, brand, "account", { operator: viewer.operator })}${ACCOUNT_SCRIPT}`
          : `<a class="button small secondary" href="/login">Sign in</a>`
      }`,
    )}<main class="splash">
<section class="splash-hero">
${notice ? `<p class="splash-notice" role="status">${escapeHtml(notice)}</p>` : ""}
<p class="splash-kicker">${selfServe ? "Free to start · no card needed" : "Source available · runs on Cloudflare"}</p>
<h1>${escapeHtml(DESCRIPTION)}</h1>
<p class="splash-lede muted">Your agent (Claude, Codex, Cursor or any MCP client) writes MDX or React over MCP. People open a link, sign in with an emailed code, and get a live page: shared state, per-person state, presence, comments, approvals and forms built in, with no backend to wire up. What they decide comes back to the agent. Everyone it isn't shared with never sees it.</p>
<p class="splash-actions">${
      selfServe
        ? `<a class="button" href="/workspaces">Start free</a><a class="button secondary" href="#examples">See examples</a>`
        : `<a class="button" href="#examples">See examples</a><a class="button secondary" href="${REPO}">View the source</a>`
    }</p>
<span class="splash-ghost" aria-hidden="true"></span>
</section>

${showcase(host)}

<section class="splash-grid" aria-label="What's different">
${card("Live pages, not static HTML", "State, people and data are part of the page, not something to wire up.", [
  "<code>useShared</code>, <code>useSharedMap</code> and <code>useLocal</code> sync over a WebSocket; <code>useViewer</code> and <code>usePresence</code> know who's looking",
  "Polls, approvals, forms, checklists, notes and comments work out of the box, alongside tables, charts and Mermaid diagrams",
  "A data file can refresh from a JSON URL on a schedule, once a person approves the host",
])}
${card("An edit-and-check loop for agents", "Agents change artifacts the way they change code, and find out when they broke something.", [
  "Ranged reads, grep, exact find-and-replace edits and JSON Patch, with version guards against stale writes",
  "Imports, components and syntax validated before anything is saved",
  "Every write rendered in a headless browser; runtime errors and a screenshot come back in the tool result",
])}
${card("People answer, agents close the loop", "An artifact can ask for a decision and get it back, not just be read.", [
  "Approvals, form responses and comments anchored to exact text, each signed with the person's verified email",
  "The agent reads every answer over MCP, and MCP events or a webhook can wake it when one arrives; fixes are marked addressed in the version that made them",
  "Owners and agents see who has read which version; readers see what changed since their last visit",
])}
${card("Isolated by construction", "Tenancy and untrusted code are handled by the platform, not by convention.", [
  "Each workspace is its own Durable Object with its own SQLite database, on its own subdomain and browser origin",
  "Artifact code runs in a sandboxed, opaque-origin frame with no network access",
  "Comments live outside the frame and collab writes are stamped server-side, so votes and authorship can't be forged",
])}
</section>
${PRINCIPLES ? `<p class="splash-why"><a href="${PRINCIPLES}">How artifacts.boo thinks: the principles behind these choices</a></p>` : ""}

<section class="splash-self" id="self-host">
<div>
<h2>${selfServe ? "Prefer to run it yourself?" : "Self-host it for your team in one deploy"}</h2>
${selfServe ? `<p class="muted">It's source available: one deploy puts the same thing on your own Cloudflare account, with your own domain and data.</p>` : `<p class="muted"><a href="https://alchemy.run">Alchemy</a>, an infrastructure-as-code tool for TypeScript, creates everything: the Worker and its Durable Objects, DNS for workspace subdomains, the sign-in email sender, OAuth storage, R2 backups and every secret. Schema changes migrate themselves when each workspace wakes up.</p>`}
${
  selfServe
    ? ""
    : `<ul class="splash-facts">
<li><strong>$5 a month</strong> for Workers Paid; an idle workspace costs only its stored bytes</li>
<li><strong>OAuth for MCP</strong>, or personal agent tokens for headless clients</li>
<li><strong>Nightly backups</strong> to R2, paged so size never hits Worker memory</li>
</ul>`
}
<p class="muted splash-license"><strong>No lock-in.</strong> Admins can download everything in their workspace any time, as plain JSON an agent can read (<a href="${REPO}/blob/main/docs/EXPORT.md">the format</a>), and run it on their own account from the source. Free to run for your own organization under the <a href="${REPO}/blob/main/LICENSE.md">Functional Source License</a>; offering it to others as a hosted service isn't. Each release becomes Apache 2.0 after two years.</p>
</div>
<div class="splash-code"><div class="splash-code-head"><span>terminal</span></div><pre><code>git clone ${REPO}
cd artifacts.boo &amp;&amp; bun install
# set DOMAIN, OPERATOR_EMAILS, OPERATOR_TOKEN in .env
bun run deploy</code></pre></div>
</section>

<footer class="splash-foot muted">${pricing ? `<a href="/pricing">Pricing</a> · ` : ""}${PRINCIPLES ? `<a href="${PRINCIPLES}">Principles</a> · ` : ""}<a href="${REPO}">GitHub</a> · <a href="${REPO}/blob/main/docs/guide.md">Agent guide</a> · <a href="${REPO}/blob/main/docs/AUTOMATIONS.md">Automations</a> · <a href="${REPO}/blob/main/src/kit/CATALOG.md">Components</a> · <a href="${REPO}/blob/main/docs/DESIGN.md">Design</a> · <a href="${REPO}/blob/main/docs/DEPLOY.md">Deploy guide</a> · <a href="${REPO}/blob/main/LICENSE.md">License</a> · <a href="/help">Help</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/security">Security and data</a> · ${viewer ? `<a href="/workspaces">Your workspaces</a>` : `<a href="/login">Sign in</a>`}</footer>
</main>`,
    {},
    publicHead(brand, "/", DESCRIPTION, appJsonLd(brand, pricing)),
  );
}

export type LoginState = { step: "email" | "code"; email?: string; error?: string; to: string; n: string; return: string };

/** Email sign-in: the address form, then the code form. `to`/`return` ride along as hidden fields. */
export function loginPage(state: LoginState, brand: Brand, status = 200): Response {
  const hidden = `<input type="hidden" name="to" value="${escapeHtml(state.to)}"><input type="hidden" name="n" value="${escapeHtml(state.n)}"><input type="hidden" name="return" value="${escapeHtml(state.return)}">`;
  const error = state.error ? `<p class="notice error" role="alert" id="login-error">${escapeHtml(state.error)}</p>` : "";
  // The one field on each step is what the error is about.
  const invalid = state.error ? ` aria-invalid="true" aria-describedby="login-error"` : "";
  let where = "";
  try {
    if (state.to) where = ` to continue to <strong>${escapeHtml(new URL(state.to).hostname)}</strong>`;
  } catch {
    where = "";
  }
  const body =
    state.step === "email"
      ? `<h1>Sign in</h1><p class="muted">We'll email you a sign-in code${where}.</p>${error}
<form class="key-form" method="post" action="/login">${hidden}
<label for="email">Email</label>
<div class="row"><input class="input" id="email" name="email" type="email" autocomplete="email webauthn" required autofocus${invalid} value="${escapeHtml(state.email ?? "")}"><button class="button" type="submit">Send code</button></div>
</form>
<p class="passkey-alt" id="passkey-alt" hidden><button class="link" type="button" id="passkey-button">Sign in with a passkey</button></p>`
      : `<h1>Check your email</h1><p class="muted">We sent a code to <strong>${escapeHtml(state.email ?? "")}</strong>. It works for 10 minutes.</p>${error}
<form class="key-form" method="post" action="/login">${hidden}<input type="hidden" name="email" value="${escapeHtml(state.email ?? "")}">
<label for="code">Code</label>
<div class="row"><input class="input code-input" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{8,9}" maxlength="9" required autofocus${invalid}><button class="button" type="submit">Sign in</button></div>
</form>
<form method="post" action="/login" class="resend">${hidden}<input type="hidden" name="email" value="${escapeHtml(state.email ?? "")}"><button class="link" type="submit">Send a new code</button> <a href="/login?to=${encodeURIComponent(state.to)}&n=${encodeURIComponent(state.n)}&return=${encodeURIComponent(state.return)}">Use a different email</a></form>`;
  // login.js offers saved passkeys in the email field's autofill (or, where a browser can't, the button above).
  const passkeys = state.step === "email" ? `<script type="module" src="${asset("/static/login.js")}"></script>` : "";
  return page(
    `Sign in · ${PRODUCT}`,
    `${topBar(brand)}<main class="content"><section class="empty" id="login" data-to="${escapeHtml(state.to)}" data-n="${escapeHtml(state.n)}" data-return="${escapeHtml(state.return)}">${body}<p class="muted fine">By signing in you agree to the <a href="/terms">terms</a>; see how we handle your data in <a href="/privacy">Privacy</a>.</p></section></main>${passkeys}`,
    { status },
  );
}

/**
 * After a code sign-in: offer to save a passkey so next time needs no email.
 * login.js skips straight on where the browser can't make one; "Not now" waits
 * 30 days before asking again. `next` is where to go either way.
 */
export function passkeyOfferPage(next: string, brand: Brand): Response {
  const href = escapeHtml(next);
  return page(
    `Save a passkey · ${PRODUCT}`,
    `${topBar(brand)}<main class="content"><section class="empty" id="passkey-offer" data-next="${href}"><h1>Skip the email next time</h1><p class="muted">Save a passkey and sign in with Face ID, Touch ID or your device's screen lock. Your email code still works whenever you need it.</p>
<p class="notice error" role="alert" id="passkey-error" hidden></p>
<p class="consent-actions"><button class="button" type="button" id="passkey-save">Save a passkey</button><a class="button secondary" href="${href}" id="passkey-later">Not now</a></p></section></main><script type="module" src="${asset("/static/login.js")}"></script>`,
  );
}

/** The apex for someone signed in: their workspaces. */
export function workspacesPage(
  email: string,
  workspaces: { slug: string; name: string; role: WorkspaceRole | "guest"; suspended: boolean; url: string }[],
  operator: boolean,
  brand: Brand,
  /** Self-serve signup, when it's on: the form's state and the workspace host suffix. */
  create: { error?: string; name?: string; slug?: string; suffix: string; full?: boolean } | null = null,
  notice?: string,
  /** Billing is on: admins get a way to each workspace's plan, so the pricing page's upgrade leads somewhere. */
  billing = false,
): Response {
  const rows = workspaces
    .map(
      (w) =>
        `<li><a href="${escapeHtml(w.url)}/"><span class="title">${escapeHtml(w.name)}</span><span class="meta">${escapeHtml(new URL(w.url).hostname)} · ${w.role}${w.suspended ? " · suspended" : ""}</span></a>${
          billing && w.role === "admin" ? `<a class="row-link" href="${escapeHtml(w.url)}/settings#plan-and-billing" aria-label="Plan and billing for ${escapeHtml(w.name)}">Plan and billing</a>` : ""
        }</li>`,
    )
    .join("");
  const body = workspaces.length
    ? `<h1 class="page-title">Your workspaces</h1><ul class="list">${rows}</ul>`
    : `<section class="empty"><h1>No workspaces yet</h1><p class="muted">${escapeHtml(email)} isn't a member of a workspace. Artifacts shared with you open from the links you were sent.</p></section>`;
  const admin = operator ? `<p class="archived-link"><a href="/admin">Operator console</a></p>` : "";
  return page(
    `Your workspaces · ${PRODUCT}`,
    `${topBar(brand, `${avatar(email, brand, "account", { operator })}${ACCOUNT_SCRIPT}`)}<main class="content">${notice ? `<p class="notice ok" role="status">${escapeHtml(notice)}</p>` : ""}${body}${create ? createForm(create) : ""}${admin}</main>${POLICY_FOOTER}`,
  );
}

/** Make a Free workspace (self-serve). Posts back to /workspaces. */
function createForm(c: { error?: string; name?: string; slug?: string; suffix: string; full?: boolean }): string {
  const free = PLANS.free.limits;
  if (c.full) {
    return `<section class="card-section create-workspace"><h2>Create a workspace</h2><p class="muted">We've opened as many new workspaces as we can today. Come back tomorrow, or ask someone with a workspace to add you.</p></section>`;
  }
  // The error can be about any field, so each one points to it.
  const desc = c.error ? ` aria-describedby="create-error"` : "";
  return `<section class="card-section create-workspace">
<h2>Create a workspace</h2>
<p class="muted">A workspace is where your agent publishes artifacts for you and your team. It's free for up to ${free.artifacts} artifacts (archived ones included), ${free.members} members and ${Math.round((free.bytes ?? 0) / 1024 / 1024)} MB; people you share artifacts with never need an account or a plan.</p>
${c.error ? `<p class="notice error" role="alert" id="create-error">${escapeHtml(c.error)}</p>` : ""}
<form method="post" action="/workspaces" class="create-form">
<label class="field"><span>Name</span><input class="input" name="name"${desc} required maxlength="80" autocomplete="organization" value="${escapeHtml(c.name ?? "")}" placeholder="Acme"></label>
<label class="field"><span>Address</span><span class="slug-row"><input class="input" name="slug"${desc} required pattern="[a-z][a-z0-9\\-]{1,30}[a-z0-9]" maxlength="32" autocapitalize="none" spellcheck="false" value="${escapeHtml(c.slug ?? "")}" placeholder="acme"><span class="muted slug-suffix">${escapeHtml(c.suffix)}</span></span></label>
<label class="check"><input type="checkbox" name="terms"${desc} required> <span>I agree to the <a href="/terms">terms</a> and <a href="/privacy">privacy policy</a>.</span></label>
<button class="button" type="submit">Create workspace</button>
</form>
</section>`;
}

/**
 * Notification settings. On the apex (`account`): your name and channels. In
 * a workspace: per-artifact levels there. The client (me.js) loads both through /api/me.
 */
export function profilePage(email: string, context: "account" | "workspace", brand: Brand, webPush: boolean, pushover: boolean): Response {
  return page(
    context === "account" ? `Account · ${PRODUCT}` : `Notifications · ${brand.name}`,
    `${topBar(brand, avatar(email, brand, context))}<main class="content profile" id="profile" data-context="${context}" data-webpush="${webPush ? "1" : ""}" data-pushover="${pushover ? "1" : ""}"><h1 class="page-title">${context === "account" ? "Account" : `Notification settings in ${escapeHtml(brand.name)}`}</h1><p class="muted">Loading…</p></main>${ACCOUNT_SCRIPT}<script type="module" src="${asset("/static/me.js")}"></script>`,
  );
}

/** Workspace settings: connect agents, members, approved hosts. The client is settings.js. */
export function settingsPage(email: string, brand: Brand): Response {
  return page(
    `Settings · ${brand.name}`,
    `${topBar(brand, avatar(email, brand, "workspace", { member: true }))}<main class="content profile" id="settings"><h1 class="page-title">Workspace settings</h1><p class="muted">Loading…</p></main>${ACCOUNT_SCRIPT}<script type="module" src="${asset("/static/settings.js")}"></script>`,
  );
}

/** Operator console: workspaces, usage, backups. The client is admin.js. */
export function adminPage(email: string, brand: Brand): Response {
  return page(
    `Operator · ${PRODUCT}`,
    `${topBar(brand, avatar(email, brand, "account", { operator: true }))}<main class="content profile wide" id="admin"><h1 class="page-title">Workspaces</h1><p class="muted">Loading…</p></main>${ACCOUNT_SCRIPT}<script type="module" src="${asset("/static/admin.js")}"></script>`,
  );
}

/** OAuth consent: which app, where its tokens go, and who it will act as. */
export function consentPage(
  details: { clientName: string; clientDomain?: string; redirectHost: string; redirectIsLoopback: boolean; scope: string[] },
  handle: string,
  email: string,
  brand: Brand,
  admin = false,
): Response {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name isn't verified.";
  const local = details.redirectIsLoopback
    ? `<p class="notice"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>`
    : "";
  return page(
    `Connect ${details.clientName} · ${brand.name}`,
    `${topBar(brand)}<main class="content"><section class="empty consent">
<h1>Connect ${name} to ${escapeHtml(brand.name)}?</h1>
<p class="muted">${origin} Access goes to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${local}
<p>It will act as <strong>${escapeHtml(email)}</strong> in ${escapeHtml(brand.name)}, with your access: create artifacts, edit and share the ones you manage${admin ? " (as an admin, that's every artifact here)" : ""}, and read and reply to comments. You can disconnect it any time in workspace settings.</p>
<form method="post" action="/authorize" class="consent-actions"><input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button class="button" name="decision" value="approve" type="submit">Connect</button>
<button class="button secondary" name="decision" value="deny" type="submit">Cancel</button>
</form></section></main>`,
  );
}

/**
 * The answer to a form post that must end up on another origin. Our CSP's
 * form-action also covers the redirect after a form submit, so a 303 there is
 * blocked; a meta refresh is an ordinary navigation and isn't.
 */
export function continuePage(location: string, headers: Headers = new Headers()): Response {
  let host = location;
  try {
    host = new URL(location).host;
  } catch {
    host = location;
  }
  headers.delete("Location");
  const url = escapeHtml(location);
  const res = page(
    "Continuing…",
    `<meta http-equiv="refresh" content="0;url=${url}"><main class="content"><section class="empty"><h1>Continuing to ${escapeHtml(host)}…</h1><p><a class="button" href="${url}">Continue</a></p></section></main>`,
  );
  for (const [k, v] of headers) if (k.toLowerCase() !== "content-type") res.headers.append(k, v);
  return res;
}

export type PolicyKind = "privacy" | "terms" | "security";

export const POLICY_UPDATED = "2026-10-18";

/** Plans and prices (only while billing is on). A workspace pays; people you share with never do. */
export function pricingPage(brand: Brand, selfServe: boolean, viewer?: { email: string; operator: boolean }): Response {
  const free = PLANS.free.limits;
  const team = PLANS.team.limits;
  const gb = (b: number) => (b >= 1024 ** 3 ? `${b / 1024 ** 3} GB` : `${Math.round(b / 1024 / 1024)} MB`);
  const plan = (name: string, price: string, blurb: string, points: string[], cta: string) =>
    `<div class="splash-card pricing-card"><h2>${name}</h2><p class="pricing-price">${price}</p><p class="muted">${blurb}</p><ul>${points.map((x) => `<li>${x}</li>`).join("")}</ul>${cta}</div>`;
  const account = viewer
    ? `<a class="button small secondary" href="/workspaces">Your workspaces</a>${avatar(viewer.email, brand, "account", { operator: viewer.operator })}${ACCOUNT_SCRIPT}`
    : `<a class="button small secondary" href="/login">Sign in</a>`;
  return page(
    `Pricing · ${PRODUCT}`,
    `${topBar(brand, account)}<main class="splash pricing">
<section class="splash-hero"><h1>Pricing</h1>
<p class="splash-lede muted">A workspace pays, once, however many people read its artifacts. Guests, the people you share with, never need an account or a plan.</p></section>
<section class="splash-grid pricing-grid">
${plan("Free", `$0 <span class="muted">/ workspace</span>`, "For trying it out, or a small personal workspace.", [
  `${free.artifacts} artifacts (archived ones count; delete to make room) and ${free.members} members`,
  `${gb(free.bytes!)} of storage, ${free.changesPerDay} saves, ${free.checksPerDay} render checks and ${free.emailsPerDay} emails a day (${free.inviteEmailsPerDay} kept for invitations and shares)`,
  "Guests, approvals, forms, comments and MCP events, with no limit",
], selfServe ? `<a class="button secondary" href="/workspaces">Start free</a>` : `<p class="muted small">New workspaces are by invitation for now.</p>`)}
${plan("Team", `$${TEAM_PRICE.amount} <span class="muted">/ workspace / ${TEAM_PRICE.period}</span>`, "For a team that publishes and decides with its agents every day.", [
  "No artifact or member limit",
  `${gb(team.bytes!)} of storage, ${team.changesPerDay!.toLocaleString("en-US")} saves, ${team.checksPerDay.toLocaleString("en-US")} render checks and ${team.emailsPerDay.toLocaleString("en-US")} emails a day`,
  "Guests, approvals, forms, comments and MCP events, with no limit",
], `<a class="button" href="/workspaces">Choose a workspace to upgrade</a>`)}
</section>
<section class="pricing-notes muted">
<p><strong>No lock-in.</strong> Admins can download everything at any time, and the <a href="${REPO}">source</a> runs on your own Cloudflare account.</p>
<p>The person who pays can <strong>cancel any time</strong> from the workspace's settings. Team stays until the end of the period you paid for, then the workspace moves to Free and keeps everything.</p>
<p>Payments are handled by Creem, our merchant of record: they're the seller on your invoice and handle sales tax and VAT. Prices are in US dollars, plus tax where it applies. See the <a href="/terms">terms</a> for refunds.</p>
<p>To keep throwaway workspaces from being used for spam, a new Free workspace's first day has no public links and only a few invitation and share emails. Sharing with people works from the start.</p>
</section>
<footer class="splash-foot muted"><a href="/help">Help</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/security">Security and data</a></footer>
</main>`,
    {},
    publicHead(brand, "/pricing", `${PRODUCT} pricing: Free for small workspaces, Team at $${TEAM_PRICE.amount} a workspace a month. Guests are always free.`),
  );
}

/** Privacy, terms, and security and data: what this hosted instance does with your data and expects of you. */
export function policyPage(kind: PolicyKind, brand: Brand, contact: string, paid = false): Response {
  const mail = contact ? `<a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a>` : "the operator";
  const sections: Record<PolicyKind, { title: string; body: string }> = {
    privacy: {
      title: "Privacy",
      body: `
<p>${escapeHtml(brand.apex.replace(/^https:\/\//, ""))} is run by Michael Thiesen ("we"). This page says what we store, why, who else handles it, and how long we keep it. Questions or requests: ${mail}.</p>
<h2>What we store</h2>
<ul>
<li><strong>Your email address</strong>, to sign you in with one-time codes (or a passkey, if you save one), to know who an artifact is shared with, and to email you invitations, shares and notifications (on by default; you can turn notification emails off).</li>
<li><strong>Your display name</strong>, if you set one; it's shown on your comments.</li>
<li><strong>Passkeys</strong>, if you save any: each one's public key, a name for it (such as "iCloud Keychain"), and when it was added and last used. The private key never leaves your device or password manager.</li>
<li><strong>Artifacts</strong>: the files your agent writes (up to 50 versions each), images and data files, and live data fetched from hosts a workspace admin approved.</li>
<li><strong>What people do on an artifact</strong>: comments, votes, approvals, form responses, checklists, notes and other shared state; which version you last saw and which comments you've read; an activity log (the latest 5,000 events per artifact).</li>
<li><strong>Billing</strong>, for a workspace on a paid plan: the payment provider's customer and subscription ids, the subscription's status and when the paid period ends. Card details go to the provider, never to us.</li>
<li><strong>Workspace membership</strong>: who belongs to which workspace and in what role, and when members last signed in; for a workspace someone made themselves, who made it and which version of the terms they agreed to.</li>
<li><strong>Guest visits</strong>: which workspaces you've opened a shared artifact in as a guest, and when you last did, so they show up in your workspaces list.</li>
<li><strong>Agent access</strong>: OAuth grants and personal agent tokens, stored only as hashes, with when each was last used.</li>
<li><strong>Notification settings</strong>: whether you want emails, and any channels you add (browser push subscriptions, Pushover user keys, ntfy topics and tokens, webhook URLs and their signing secrets).</li>
<li><strong>Render checks</strong>: after each change a headless browser renders the artifact; we keep the result, a screenshot and any errors. Viewers' browsers also report runtime errors (the latest 30 per artifact).</li>
<li><strong>Sign-in records</strong>: when codes were sent and checked, with your IP address or network, to limit abuse. Kept for an hour.</li>
<li><strong>Your inbox</strong>: a copy of each notification for you (what happened, on which artifact, and the start of any comment), your latest 200, for up to 90 days. A notification leaves your inbox when its artifact or workspace is deleted, when you're removed from the workspace or from the artifact's sharing, or when you delete your account.</li>
<li><strong>Support requests</strong>: what you send us from Help &amp; feedback (or your agent sends for you), and what you chose to include with it (the page you came from, your browser and an error code), kept as a page in our support workspace that only you and we can open, with our replies. We never include what's in your artifacts. You can ask us to delete a request.</li>
<li><strong>Errors</strong>: when something fails on our side or in our own pages, we keep where (with ids removed), a message with addresses and links taken out, the version and your browser family, counted together with the same errors. Errors inside artifacts go to their owners, not to us.</li>
<li><strong>Reports</strong>: if you report an artifact, what you wrote and, if you give it, your email go to us by email and into our operations log; your network address is kept for an hour to limit repeat reports. The workspace isn't told who reported it.</li>
<li><strong>Request logs</strong>: Cloudflare keeps the Workers request and error logs for a few days (up to 7), for debugging. They can include workspace addresses and error text, never passwords or codes.</li>
</ul>
<h2>In your browser</h2>
<p>A session cookie per site you sign in to (it lasts 30 days from your last visit), a short-lived cookie during sign-in, and cookies that remember OAuth approvals. Artifacts can keep per-person data in your browser's storage, separately for each artifact. No advertising or cross-site tracking. Pages load Cloudflare Web Analytics, which counts visits without cookies.</p>
<h2>Who can see what</h2>
<ul>
<li>An artifact is visible to its owner, the admins of its workspace, and the people, domains or workspace it's shared with; a public artifact to anyone with its link.</li>
<li>Workspace admins can see and manage every artifact in their workspace and its member list.</li>
<li>An artifact's owner, its workspace's admins and their agents can see who has opened it while signed in, which version each person last saw and when. Visits through a public link without signing in aren't recorded.</li>
<li>People signed in to an artifact see who else is viewing it at the same time, by name or email address. Someone on a public link without signing in sees nobody, and isn't shown.</li>
<li>Everyone who can open an artifact sees its comments, votes, approvals and form responses, with who made them.</li>
<li>We, as operator, can access stored data to run the service: backups, restores and support. We don't sell it, use it for advertising, or train models on it.</li>
</ul>
<h2>Who else handles it</h2>
<ul>
<li><strong>Cloudflare</strong> hosts everything: compute, storage (Durable Objects, R2, KV), email sending, the headless browser for render checks, analytics and logs. Data lives on Cloudflare's network; a workspace's database is placed near where it was first used.</li>
<li><strong>Creem</strong> (payments, for paid plans): the merchant of record, which processes payments and handles tax; it receives the billing details you give at checkout.</li>
<li><strong>Services you choose</strong>: if you add Pushover, ntfy, a webhook or browser push, notifications go to that service. Live data sources are fetched from the hosts your workspace approved.</li>
</ul>
<h2>How long we keep it</h2>
<ul>
<li>As long as the artifact or workspace exists. Deleting an artifact removes it from the live database at once.</li>
<li>Each workspace is backed up nightly when it changed; up to 30 backups are kept (7 on Free), so deleted data leaves backups within about a month.</li>
<li>Deleting a workspace deletes its data and its backups, the notifications about it in people's inboxes, and ends its agents' access. Our directory's records about it (members, notifications and billing ids) leave our backups within about a month, and payment entries about it in our operations log stay until they roll off.</li>
<li>Accounts are backed up the same way: your email, name, passkeys, notification channels (with their keys and secrets), memberships, guest visits, inbox and billing records. The newest 30 backups are kept, so after you delete your account these leave backups within about a month.</li>
<li>A workspace's billing record (its subscription's status, and the payer's email) is kept while the workspace exists, and in payment log entries until they roll off.</li>
<li>After you delete your account, your address stays in two places, to limit abuse: our record of who made which self-serve workspaces (so the free plan can't be farmed), and in the list of people removed from each workspace you left (so joining by email domain doesn't add you back).</li>
<li>What you did in a workspace stays there under your address after you delete your account, until an admin removes it or the workspace is deleted: your comments, votes, approvals and form responses, and the artifact's activity log.</li>
<li>Support requests you sent stay in our support workspace, with your address, until you ask us to delete them.</li>
<li>Our operations log (sign-ups, billing changes, reports and failures, with workspace names and sometimes an email address) keeps its latest 500 entries.</li>
</ul>
<h2>Your choices</h2>
<p>Turn email notifications off in your account. Leave a workspace from its notifications page, or ask the owner or an admin to remove you from an artifact or workspace. Delete your account from your account page: it removes you from every workspace, and your name, notification channels and passkeys (comments you wrote stay in their workspaces, under your address, until an admin there removes them). Workspace admins can download a full export of their workspace from its settings at any time. To get a copy of your own data, or to have anything else deleted, email ${mail}; we reply within 30 days.</p>
<h2>Changes</h2>
<p>We'll update this page when what we do changes, and change the date below.</p>`,
    },
    terms: {
      title: "Terms",
      body: `
<p>These terms cover using ${escapeHtml(brand.apex.replace(/^https:\/\//, ""))}, run by Michael Thiesen. Using the service means you accept them. Questions: ${mail}.</p>
<h2>Your content</h2>
<p>You own what you and your agents put in ${PRODUCT}. You let us store it, render it and show it to the people you share it with, only to run the service. You're responsible for what your agents create and share in your name, and for having the right to share it.</p>
<h2>Acceptable use</h2>
<ul>
<li>No unlawful content, malware, phishing, or content that infringes others' rights.</li>
<li>No using shares or invitations to send unwanted email.</li>
<li>No attempts to break the isolation between workspaces or artifacts, get around rate limits or sign in as someone else. Security research is welcome through responsible disclosure (see Security and data).</li>
<li>No load meant to degrade the service for others.</li>
</ul>
<h2>Workspaces and accounts</h2>
<p>Workspace admins decide who belongs to a workspace and can manage everything in it. We may suspend or delete a workspace or content that breaks these terms, or to protect the service and its users, telling the admins where we can.</p>
<h2>Your data</h2>
<p>Workspace admins can download everything in their workspace at any time, from its settings, in a documented format. If you stop using ${PRODUCT}, you keep your data.</p>
<h2>Plans and prices</h2>
${
  paid
    ? `<p>Each workspace is on Free or Team. Free is free, with limits on artifacts, members, storage, and saves and emails a day, listed on the <a href="/pricing">pricing page</a> and in workspace settings. Team is $${TEAM_PRICE.amount} a ${TEAM_PRICE.period} per workspace, with more room. People you share artifacts with as guests never need a plan. To limit abuse, a new Free workspace can't turn on public links in its first day, and sends only a few invitation and share emails until then.</p>
<p>Moving a workspace to Free keeps everything in it; past Free's limits, nothing new can be added until it's back under them or on Team again. We'll tell workspace admins at least 30 days before a price or limit change that affects them, and a new price applies from the first billing period after that. Workspaces made before paid plans began keep the plan they had unless we've told their admins 30 days ahead.</p>`
    : `<p>${PRODUCT} is free while it's in early access. If we introduce paid plans, workspace admins hear about it at least 30 days before anything they use costs money, and nothing is charged without their agreement. People you share artifacts with as guests won't need a paid plan.</p>`
}
<h2>Payments and refunds</h2>
<p>${paid ? "Team is" : "When paid plans are offered, they're"} sold by Creem, our merchant of record, which processes the payment and handles sales tax and VAT; their terms cover the purchase itself. A paid plan renews each period until the person who pays cancels it from the workspace's settings, and stays in place until the end of the period already paid for. If a payment fails, the workspace keeps Team for up to 14 days after its period ends while the card is retried, then moves to Free. If you were charged by mistake, or ask within 14 days of your first payment, we'll refund it in full: email us.</p>
<h2>The source code</h2>
<p>The software behind ${PRODUCT} is published under the <a href="${REPO}/blob/main/LICENSE.md">Functional Source License</a>, which covers the code itself. These terms cover the hosted service.</p>
<h2>The service</h2>
<p>${PRODUCT} is provided as is, without warranties or a guaranteed level of availability. We back data up nightly but can't promise nothing is ever lost; keep copies of anything critical. To the extent the law allows, we aren't liable for indirect or consequential losses, and our total liability is limited to what you paid us in the last twelve months.</p>
<h2>Changes</h2>
<p>We may change these terms; continuing to use the service after a change means you accept it. The date below shows the latest version.</p>`,
    },
    security: {
      title: "Security and data",
      body: `
<p>How ${PRODUCT} keeps workspaces and readers safe, for anyone deciding whether to use it at work. The design is public in the <a href="${REPO}">source on GitHub</a>. Report a vulnerability to ${mail}; please give us a chance to fix it before publishing.</p>
<h2>Isolation</h2>
<ul>
<li>Each workspace is its own Cloudflare Durable Object with its own SQLite database, served from its own subdomain, so browser cookies and storage are separated by origin too.</li>
<li>Artifact code is treated as untrusted. It runs in a sandboxed, opaque-origin frame that can't make network requests or open popups; links that leave the workspace ask first. Storage, shared state and comments reach it only through the page around it, scoped to that one artifact. A frame that tries to navigate itself elsewhere is replaced.</li>
<li>Comments are drawn outside the frame, and votes, comments and checklist ticks are stamped with the verified signed-in email on the server, so artifact code can't forge them.</li>
</ul>
<h2>Sign-in and access</h2>
<ul>
<li>People sign in with eight-digit one-time codes emailed to them; codes are stored hashed, expire in 10 minutes, and sending and guessing are limited per address and network.</li>
<li>Or with a passkey they saved: only its public key is stored, every sign-in requires the device's own check (Face ID, fingerprint or screen lock), and each sign-in challenge works once.</li>
<li>Sessions are signed, HTTP-only, secure cookies bound to one host. Every request checks the artifact's sharing, so removing someone takes effect immediately.</li>
<li>Agents connect with OAuth 2.1 (PKCE, per-workspace audience) or a personal token stored as a hash. An agent acts as one member, with that member's access, and loses it when they leave the workspace.</li>
<li>Links that sign straight into an artifact are only ever emailed to their own person (or given to an agent for its own person), open that one artifact, and expire.</li>
</ul>
<h2>Data</h2>
<ul>
<li>Everything is served over HTTPS with HSTS. Data is stored on Cloudflare (Durable Objects, R2, KV), encrypted at rest by Cloudflare.</li>
<li>Nightly backups to R2, up to 30 kept (7 on Free). A restore loads everything first and swaps it in at once, so it never leaves data half-replaced.</li>
<li>Live data is only fetched from hosts a workspace admin approved, over HTTPS, without credentials.</li>
<li>See <a href="/privacy">Privacy</a> for what's stored, who handles it and for how long.</li>
</ul>
<h2>Subprocessors</h2>
<p>Cloudflare, Inc. (hosting, storage, email, headless browser, analytics, logs).${paid ? " Creem (payments: merchant of record for paid plans)." : ""} Notification services you add yourself (Pushover, ntfy, webhook targets, browser push services) receive the notifications you route to them.</p>`,
    },
  };
  const { title, body } = sections[kind];
  const nav = (["privacy", "terms", "security"] as PolicyKind[])
    .map((k) => (k === kind ? `<strong>${sections[k].title}</strong>` : `<a href="/${k}">${sections[k].title}</a>`))
    .join(" · ");
  return page(
    `${title} · ${PRODUCT}`,
    `${topBar(brand)}<main class="content policy"><p class="muted policy-nav">${nav}</p><h1>${title}</h1>${body}<p class="muted policy-date">Last updated ${POLICY_UPDATED}.</p></main>`,
    {},
    publicHead(brand, `/${kind}`, `${title} for ${PRODUCT}.`),
  );
}

/** Links to the policies, at the bottom of public pages. */
export const POLICY_FOOTER = `<footer class="site-foot muted"><a href="/help">Help</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/security">Security and data</a></footer>`;

/** Help: the guides, how to reach us, and how to report something. */
export function helpPage(brand: Brand, contact: string): Response {
  const mail = contact ? `<a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a>` : "the operator";
  return page(
    `Help · ${PRODUCT}`,
    `${topBar(brand)}<main class="content policy"><h1 class="page-title">Help</h1>
<h2>Getting started</h2>
<p>Make a workspace from <a href="/workspaces">your workspaces</a>, connect your agent from its settings, then ask the agent for an artifact. The <a href="${REPO}/blob/main/docs/guide.md">agent guide</a> covers what agents can build, and <a href="${REPO}/blob/main/src/kit/CATALOG.md">the components</a> lists what's built in.</p>
<h2>Common questions</h2>
<ul>
<li><strong>Do people I share with need an account or a plan?</strong> No. They sign in with a code we email them, and guests are always free.</li>
<li><strong>My agent can't connect.</strong> Settings shows the steps for each client. If the sign-in window doesn't open, an agent token from settings works in any client.</li>
<li><strong>I didn't get the sign-in email.</strong> Check spam for a message from ${PRODUCT}; codes last 10 minutes. You can also save a passkey in <a href="/me">your account</a> to skip the code.</li>
<li><strong>Billing.</strong> Team is billed per workspace by Creem, who handles tax. Change the card, get invoices or cancel from workspace settings → Manage billing. Canceling keeps Team until the end of the period you paid for.</li>
<li><strong>Leaving or deleting.</strong> Leave a workspace from its Notifications page (your avatar menu inside the workspace); delete your account from <a href="/me">your account</a>. Admins can download everything from workspace settings first.</li>
</ul>
<h2>Contact us</h2>
<p>Send a problem, idea or question from <a href="/support">Help &amp; feedback</a> (your agent can too, with its support_report tool), and follow it there. Or email ${mail}. We usually answer within a day.</p>
<h2>Report something</h2>
<p>If a page made with ${PRODUCT} is phishing, malware or abusive, <a href="/report">report it</a>.</p>
</main>${POLICY_FOOTER}`,
    {},
    publicHead(brand, "/help", `Help with ${PRODUCT}: getting started, common questions, and how to reach us.`),
  );
}

/** A presigned link for someone other than whoever is signed in here: switch only if they say so. */
export function linkSwitchPage(url: URL, current: string, linked: string, brand: Brand): Response {
  return page(
    `Switch account · ${brand.name}`,
    `${topBar(brand)}<main class="content"><section class="empty"><h1>Open as ${escapeHtml(linked)}?</h1><p class="muted">You're signed in here as <strong>${escapeHtml(current)}</strong>. This link signs in as <strong>${escapeHtml(linked)}</strong> and opens one artifact.</p>
<form method="post" action="${escapeHtml(url.pathname)}" class="consent-actions"><button class="button" type="submit">Continue as ${escapeHtml(linked)}</button><a class="button secondary" href="/">Stay as ${escapeHtml(current)}</a></form></section></main>`,
  );
}

/** What the product is and where its docs are, for language models (llmstxt.org). Lists only public pages. */
export function llmsTxt(brand: Brand, workspaceSuffix: string, pricing: boolean): Response {
  const raw = (path: string) => `${REPO.replace("github.com", "raw.githubusercontent.com")}/main/${path}`;
  const body = `# ${PRODUCT}

> ${DESCRIPTION}

Agents publish small interactive pages (reports, dashboards, polls, checklists, mini apps) that specific people open after verifying their email. Artifacts get live shared state, per-viewer storage and anchored comments. Each team has a workspace at its own subdomain.

Agents connect to a workspace's MCP server at \`https://<workspace>${workspaceSuffix}/mcp\`, with OAuth or a personal agent token from the workspace's settings, and act as that member. Call the \`artifact_guide\` tool first; it returns the agent guide and the component catalog below.

## Docs

- [Agent guide](${raw("docs/guide.md")}): what agents can build and how to write artifacts
- [Components](${raw("src/kit/CATALOG.md")}): the built-in component kit
- [Design](${raw("docs/DESIGN.md")}): what the system is for and the decisions behind it
- [Export format](${raw("docs/EXPORT.md")}): the workspace export archive

## Pages

- [Home](${brand.apex}/)
- [Help](${brand.apex}/help)${pricing ? `\n- [Pricing](${brand.apex}/pricing)` : ""}
- [Privacy](${brand.apex}/privacy)
- [Terms](${brand.apex}/terms)
- [Security](${brand.apex}/security)

## Optional

- [Source code](${REPO})
- [Sitemap](${brand.apex}/sitemap.xml)
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}

/** Asks before signing out here to sign in with a different email. */
export function switchPage(next: string, brand: Brand): Response {
  return page(
    `Sign in with a different email · ${brand.name}`,
    `${topBar(brand)}<main class="content"><section class="empty"><h1>Sign in with a different email?</h1><p class="muted">This signs you out here, then asks for the email to use instead.</p><form method="post" action="/switch"><input type="hidden" name="return" value="${escapeHtml(next)}"><button class="button" type="submit">Sign out and continue</button></form><p><a href="/">Cancel</a></p></section></main>`,
  );
}

export function messagePage(title: string, message: string, status: number, action?: { href: string; label: string }, brand?: Brand): Response {
  const b = brand ?? { name: PRODUCT, home: "/", apex: "" };
  const act = action ?? { href: "/", label: brand && brand.name !== PRODUCT ? "All artifacts" : "Home" };
  return page(
    title,
    `${topBar(b)}<main class="content"><section class="empty"><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(message)}</p><p><a class="button" href="${escapeHtml(act.href)}">${escapeHtml(act.label)}</a></p></section></main>`,
    { status },
  );
}

/**
 * Help & feedback: send a problem, idea or question about artifacts.boo itself, and see the requests you've
 * sent and where each stands. Signed out, it says how to reach us instead.
 */
export function supportPage(
  brand: Brand,
  viewer: { email: string; operator: boolean } | null,
  s: { requests: { n: number; title: string; status: string; url: string; updatedAt: string }[]; kind?: string; title?: string; details?: string; page?: string; error?: string; problem?: string; contact: string },
  status = 200,
): Response {
  const mail = s.contact ? `<a href="mailto:${escapeHtml(s.contact)}">${escapeHtml(s.contact)}</a>` : "us";
  const label: Record<string, string> = {
    new: "Received", triaged: "Looking into it", investigating: "Looking into it", needs_info: "Waiting for you", fix_proposed: "Fix in progress",
    fix_deployed: "Fix released", resolved: "Resolved", wont_fix: "Closed", duplicate: "Being handled with another report",
  };
  const kinds: [string, string][] = [["bug", "Something's wrong"], ["feature", "An idea"], ["question", "A question"]];
  const right = viewer ? `${avatar(viewer.email, brand, "account", { operator: viewer.operator })}${ACCOUNT_SCRIPT}` : `<a class="button small secondary" href="/login?return=/support">Sign in</a>`;
  const desc = s.problem ? ` aria-describedby="support-error"` : "";
  const form = viewer
    ? `<section class="card-section create-workspace"><h2>Tell us</h2>
<p class="muted">About artifacts.boo itself. For something in an artifact, comment on it instead, so its owner sees it.</p>
${s.problem ? `<p class="notice error" role="alert" id="support-error">${escapeHtml(s.problem)}</p>` : ""}
<form method="post" action="/support" class="create-form">
<fieldset class="kind-row"><legend>What is it?</legend>${kinds.map(([k, l]) => `<label class="check"><input type="radio" name="kind" value="${k}"${(s.kind ?? "bug") === k ? " checked" : ""}> <span>${l}</span></label>`).join("")}</fieldset>
<label class="field"><span>Title</span><input class="input" name="title"${desc} required maxlength="120" value="${escapeHtml(s.title ?? "")}" placeholder="One line"></label>
<label class="field"><span>Details</span><textarea class="input" name="details"${desc} required rows="6" maxlength="5000" placeholder="What happened, and what you expected (or what you'd like)">${escapeHtml(s.details ?? "")}</textarea></label>
${s.page ? `<label class="check"><input type="checkbox" name="page" value="${escapeHtml(s.page)}" checked> <span>Include the page I came from (${escapeHtml(s.page)}) and my browser</span></label>` : `<label class="check"><input type="checkbox" name="browser" value="1" checked> <span>Include my browser</span></label>`}
${s.error ? `<input type="hidden" name="error" value="${escapeHtml(s.error)}"><p class="muted small">The error code ${escapeHtml(s.error)} goes with it.</p>` : ""}
<p class="muted small">We never include what's in your artifacts. Replies come to the request's own page, and we'll let you know.</p>
<button class="button" type="submit">Send</button>
</form></section>`
    : `<section class="card-section"><h2>Tell us</h2><p class="muted"><a href="/login?return=/support">Sign in</a> to send a request and follow it here, or email ${mail}.</p></section>`;
  const list = viewer
    ? `<section class="card-section"><h2>Your requests</h2>${
        s.requests.length
          ? `<ul class="channels">${s.requests
              .map(
                (r) =>
                  `<li><a class="channel-label" href="${escapeHtml(r.url)}">#${r.n} ${escapeHtml(r.title)}</a><span class="chip${r.status === "needs_info" ? " caution" : ["resolved", "fix_deployed"].includes(r.status) ? " positive" : ""}">${escapeHtml(label[r.status] ?? r.status)}</span></li>`,
              )
              .join("")}</ul>`
          : `<p class="muted">None yet.</p>`
      }</section>`
    : "";
  return page(
    `Help & feedback · ${PRODUCT}`,
    `${topBar(brand, right)}<main class="content"><h1 class="page-title">Help &amp; feedback</h1><p class="muted page-lede">Something not working, an idea, or a question: it comes straight to us. Guides are on the <a href="/help">help page</a>.</p>${form}${list}</main>${POLICY_FOOTER}`,
    { status },
  );
}

/** Your inbox: what needs you across workspaces, newest first. The operator approves announcements here. */
export function inboxPage(
  brand: Brand,
  viewer: { email: string; operator: boolean },
  items: { id: number; at: string; kind: string; title: string; body: string | null; url: string | null; read: boolean; sent?: boolean }[],
  unread: number,
  notice?: string,
): Response {
  const draftOf = (url: string | null) => (url && /#(d[0-9a-f]{16})$/.exec(url)?.[1]) || null;
  const rows = items
    .map((i) => {
      const draft = i.kind === "approve-announcement" ? draftOf(i.url) : null;
      const open = i.url && !draft ? `<a href="/inbox/${i.id}">${escapeHtml(i.title)}</a>` : escapeHtml(i.title);
      const approve = !draft
        ? ""
        : i.sent
          ? `<p class="muted small inline-form">Sent.</p>`
          : `<form method="post" action="/inbox" class="inline-form"><input type="hidden" name="approve" value="${draft}"><button class="button small" type="submit">Approve and send</button></form>`;
      return `<li id="${draft ?? `i${i.id}`}" class="inbox-item${i.read ? "" : " unread"}"><div class="inbox-title">${open}</div>${i.body ? `<div class="muted small inbox-body">${escapeHtml(i.body)}</div>` : ""}<div class="muted small">${relativeTime(i.at)}</div>${approve}</li>`;
    })
    .join("");
  return page(
    `Inbox · ${PRODUCT}`,
    `${topBar(brand, `${avatar(viewer.email, brand, "account", { operator: viewer.operator })}${ACCOUNT_SCRIPT}`)}<main class="content"><h1 class="page-title">Inbox</h1>${
      notice ? `<p class="notice ok" role="status">${escapeHtml(notice)}</p>` : ""
    }<p class="muted page-lede">What needs you, from every workspace: replies, mentions, approvals and your requests to us. Where notifications also go is set in <a href="/me">your account</a>.</p>${
      unread ? `<form method="post" action="/inbox" class="inline-form"><input type="hidden" name="read" value="all"><button class="button small secondary" type="submit">Mark all read</button></form>` : ""
    }${
      rows ? `<ul class="inbox">${rows}</ul>` : `<p class="muted">Nothing yet.</p>`
    }</main>${POLICY_FOOTER}`,
  );
}

export const REPORT_REASONS: [string, string][] = [
  ["phishing", "Phishing or a scam"],
  ["malware", "Malware or a harmful download"],
  ["illegal", "Illegal content"],
  ["abuse", "Harassment or hate"],
  ["other", "Something else"],
];

/** Report an artifact to us: what's wrong, optionally how to reach you. */
export function reportPage(brand: Brand, s: { url?: string; reason?: string; details?: string; email?: string; error?: string; done?: boolean }, status = 200): Response {
  const body = s.done
    ? `<section class="empty"><h1>Thanks, we'll look at it</h1><p class="muted">We review every report and take down what breaks our <a href="/terms">terms</a>. You can close this tab.</p><p><a class="button secondary" href="/">${PRODUCT}</a></p></section>`
    : `<section class="card-section create-workspace"><h1 class="page-title">Report an artifact</h1>
<p class="muted">Tell us about a page made with ${PRODUCT} that's phishing, malware, illegal or abusive. Its workspace isn't told who reported it.</p>
${s.error ? `<p class="notice error" role="alert">${escapeHtml(s.error)}</p>` : ""}
<form method="post" action="/report" class="create-form">
<label class="field"><span>Link</span><input class="input" name="url" type="url" required maxlength="500" value="${escapeHtml(s.url ?? "")}" placeholder="https://…/a/…"></label>
<label class="field"><span>What's wrong</span><select class="input" name="reason" required><option value="">Choose…</option>${REPORT_REASONS.map(([k, label]) => `<option value="${k}"${s.reason === k ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label>
<label class="field"><span>Details <span class="muted">(optional)</span></span><textarea class="input" name="details" rows="4" maxlength="2000">${escapeHtml(s.details ?? "")}</textarea></label>
<label class="field"><span>Your email <span class="muted">(optional, if we may follow up)</span></span><input class="input" name="email" type="email" maxlength="200" value="${escapeHtml(s.email ?? "")}"></label>
<button class="button" type="submit">Send report</button>
</form></section>`;
  return page(`Report an artifact · ${PRODUCT}`, `${topBar(brand)}<main class="content">${body}</main>${POLICY_FOOTER}`, { status });
}

export function shellPage(boot: ShellBoot, brand: Brand, reportUrl?: string): Response {
  return page(
    boot.title,
    `<div class="shell">
<header class="bar"><span class="lead"><a class="mark" href="/" title="${escapeHtml(brand.name)}" aria-label="${escapeHtml(brand.name)}">${GHOST}</a><span class="title" title="${escapeHtml(boot.title)}">${escapeHtml(boot.title)}</span></span><span id="status" class="status" role="status" aria-live="polite"></span><span id="presence" class="presence"></span>${reportUrl ? `<a class="bar-link report-link" href="${escapeHtml(reportUrl)}" target="_blank" rel="noopener">Report</a>` : ""}${
      boot.viewer.email ? avatar(boot.viewer.email, brand, "workspace", { member: boot.member, scoped: boot.scoped }) : ""
    }</header>
<div id="since" class="since" hidden></div>
<div class="workspace"><div id="frame-host" class="frame-host"></div><aside id="threads" class="threads" hidden aria-label="Comments"></aside></div>
</div>
<script type="application/json" id="shell-boot">${scriptJson(boot)}</script>
<script type="module" src="${asset("/static/shell.js")}"></script>`,
  );
}

export function frameCsp(origin: string, sandbox = true): string {
  return cspFor({ kit: `${origin}${KIT}/`, assets: `${origin}/asset/`, ancestors: origin, sandbox });
}

/**
 * The splash page's example frames (static assets, see scripts/build-demos.ts):
 * the same policy, but they have no uploaded assets and are built before the
 * domain is known, so the kit is 'self'. The sandbox keeps their origin opaque.
 */
export const DEMO_FRAME_CSP = cspFor({ kit: "'self'", assets: "", ancestors: "'self'", sandbox: true });

function cspFor({ kit, assets, ancestors, sandbox }: { kit: string; assets: string; ancestors: string; sandbox: boolean }): string {
  return [
    // The render checker opens frames top-level with no cookies; Browser Run
    // doesn't run module scripts from an opaque origin, so check mode is the
    // one case served unsandboxed. Network access stays blocked either way.
    // No popups: the frame asks the shell to open links (see shell.ts openLink).
    ...(sandbox ? ["sandbox allow-scripts allow-forms allow-modals allow-downloads"] : []),
    "default-src 'none'",
    `script-src 'unsafe-inline' data: ${kit}`,
    `style-src 'unsafe-inline' ${kit}`,
    `font-src ${kit} data:`,
    `img-src data: blob:${assets && ` ${assets}`}`,
    `media-src data: blob:${assets && ` ${assets}`}`,
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${ancestors}`,
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
  const html = frameHtml(boot, build);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": frameCsp(origin, !check),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-DNS-Prefetch-Control": "off",
      // no-transform keeps Cloudflare's analytics beacon out of artifact content:
      // the shell page already counts the view, and the frame CSP would block it.
      "Cache-Control": "private, no-store, no-transform",
    },
  });
}

/**
 * The frame document's HTML. The build also writes the splash page's examples
 * with it (scripts/build-demos.ts), passing the kit's own version.
 */
export function frameHtml(boot: FrameBoot, build: Pick<Build, "css" | "imports">, version = ASSET_VERSION): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${DARK_HEAD}
<link rel="stylesheet" href="${kit("kit.css", version)}">
<style>${build.css.replace(/<\/style/gi, "<\\/style")}</style>
<script type="importmap">${scriptJson({ imports: { ...kitImports(version), ...build.imports } })}</script>
<script type="application/json" id="art-boot">${scriptJson(boot)}</script>
<script type="module" src="${kit("boot.js", version)}"></script>
</head>
<body><div id="root"></div></body>
</html>`;
}

// HTML documents: the splash page and sign-in on the apex, workspace pages, the
// shell around an artifact, and the sandboxed frame document that renders it.
import type { Build } from "./compile.ts";
import type { ArtifactMeta } from "./hub.ts";
import type { WorkspaceRole } from "./directory.ts";
import type { FrameBoot, Role, ShellBoot } from "../shared/protocol.ts";
import { PRODUCT } from "../shared/brand.ts";
import demos from "./demos.json";

const KIT = "/kit/v1";
declare const __ASSET_VERSION__: string;
const ASSET_VERSION = typeof __ASSET_VERSION__ === "string" ? __ASSET_VERSION__ : "dev";
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

function page(title: string, body: string, init: ResponseInit = {}, head = ""): Response {
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
${head}</head>
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
export type Brand = { name: string; home: string; apex: string };

/** The ghost logo, drawn by CSS (a gradient through an SVG mask). */
const GHOST = `<span class="ghost" aria-hidden="true"></span>`;

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
    ...(context === "workspace" ? [`data-workspace="${escapeHtml(brand.name)}"`] : []),
    ...(flags.member ? ['data-member="1"'] : []),
    ...(flags.scoped ? ['data-scoped="1"'] : []),
    ...(flags.operator ? ['data-operator="1"'] : []),
  ];
  return `<span id="me" class="me" ${attrs.join(" ")}></span>`;
}

const ACCOUNT_SCRIPT = `<script type="module" src="${asset("/static/account.js")}"></script>`;

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
  const parts = s.shares.map((x) => `${x.email === "workspace" ? "everyone in the workspace" : escapeHtml(x.email)}${x.role === "edit" ? " (edit)" : ""}`);
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
 * A workspace's artifact list. `archived` shows the archive instead: artifacts
 * their owners are done with, hidden from the main list but still readable.
 */
export function indexPage(
  viewer: { email: string | null; member: WorkspaceRole | null },
  all: ListedArtifact[],
  brand: Brand,
  summaries?: Record<string, ShareSummary>,
  archived = false,
): Response {
  const account = viewer.email
    ? `${avatar(viewer.email, brand, "workspace", { member: Boolean(viewer.member) })}${ACCOUNT_SCRIPT}`
    : `<a class="button small" href="/login?return=${archived ? "/archived" : "/"}">Sign in</a>`;
  const artifacts = all.filter((a) => Boolean(a.archivedAt) === archived);
  if (archived) artifacts.sort((a, b) => b.archivedAt!.localeCompare(a.archivedAt!));
  const archivedCount = archived ? 0 : all.length - artifacts.length;
  // Always present (hidden at zero) so archiving the first row can reveal it.
  const archivedLink = `<p class="archived-link"${archivedCount ? "" : " hidden"}><a href="/archived">${ICON_ARCHIVE}Archived · <span data-archived-count>${archivedCount}</span></a></p>`;
  let body: string;
  if (!viewer.email) {
    body = `<section class="empty"><h1>${escapeHtml(brand.name)}</h1><p class="muted">Sign in with your email to see the artifacts shared with you here.</p><p><a class="button" href="/login?return=/">Sign in</a></p></section>`;
  } else if (archived) {
    body = `<p class="back-link"><a href="/">← All artifacts</a></p><h1 class="page-title">Archived</h1><p class="muted page-lede">Hidden from the main list. They still open at their links, with history and comments.</p>${
      list(artifacts, summaries, true)
    }<p class="muted archive-empty" data-list-empty${artifacts.length ? " hidden" : ""}>Nothing archived.</p>`;
  } else if (!artifacts.length) {
    const nothing = viewer.member
      ? `<section class="empty"><h1>Nothing here yet</h1><p class="muted">Ask your agent to make an artifact: connect it from <a href="/settings">workspace settings</a>. Artifacts shared with you show up here too.</p></section>`
      : `<section class="empty"><h1>Nothing here yet</h1><p class="muted">Artifacts in ${escapeHtml(brand.name)} shared with ${escapeHtml(viewer.email)} will show up here.</p></section>`;
    body = all.length ? `<section class="empty"><h1>All tidy</h1><p class="muted">Everything here is archived.</p></section>${archivedLink}` : nothing;
  } else {
    body = `<h1 class="page-title">Artifacts</h1>${list(artifacts, summaries, false)}<section class="empty" data-list-empty hidden><h1>All tidy</h1><p class="muted">Everything here is archived.</p></section>${archivedLink}`;
  }
  const script = `<script type="module" src="${asset("/static/home.js")}"></script>`;
  const title = archived ? `Archived · ${brand.name}` : brand.name;
  // Policies live on the apex; signed-out visitors may want them before signing in.
  const foot = viewer.email ? "" : POLICY_FOOTER.replace(/href="\//g, `href="${escapeHtml(brand.apex)}/`);
  return page(title, `${topBar(brand, account)}<main class="content">${body}</main>${foot}${script}`);
}

function list(artifacts: ListedArtifact[], summaries: Record<string, ShareSummary> | undefined, archived: boolean): string {
  return `<ul class="list" data-list="${archived ? "archived" : "active"}">${artifacts
    .map((a, i) => {
      const when = archived ? `archived ${relativeTime(a.archivedAt!)}` : relativeTime(a.updatedAt);
      const manages = a.role === "owner";
      const action = manages
        ? `<button type="button" class="row-action" data-action="${archived ? "unarchive" : "archive"}" title="${archived ? "Unarchive" : "Archive"}" aria-label="${
            archived ? "Unarchive" : "Archive"
          } ${escapeHtml(a.title)}">${archived ? ICON_RESTORE : ICON_ARCHIVE}</button>`
        : "";
      const summary = manages ? summaries?.[a.id] : undefined;
      return `<li data-id="${a.id}" data-order="${i}" data-title="${escapeHtml(a.title)}"><a href="/a/${a.id}"><span class="title">${escapeHtml(a.title)}${archived ? "" : activityBadge(a)}</span>${
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

/** The apex for someone who isn't signed in: what this is, for developers, and how to run it. */
export function splashPage(brand: Brand, notice?: string): Response {
  const card = (title: string, body: string, points: string[]) =>
    `<div class="splash-card"><h3>${escapeHtml(title)}</h3><p class="muted">${escapeHtml(body)}</p><ul>${points.map((x) => `<li>${x}</li>`).join("")}</ul></div>`;
  const host = brand.apex.replace(/^https?:\/\//, "") || PRODUCT;
  return page(
    `${PRODUCT}: live pages your agent builds`,
    `${topBar(brand, `<a class="bar-link" href="${REPO}">GitHub</a><a class="button small secondary" href="/login">Sign in</a>`)}<main class="splash">
<section class="splash-hero">
${notice ? `<p class="splash-notice" role="status">${escapeHtml(notice)}</p>` : ""}
<p class="splash-kicker">Open source · runs on Cloudflare</p>
<h1>${escapeHtml(DESCRIPTION)}</h1>
<p class="splash-lede muted">Your agent writes MDX or React over MCP. People open a link, sign in with an emailed code, and get a live page: shared state, per-person state, presence and comments built in, with no backend to wire up. Everyone it isn't shared with never sees it.</p>
<p class="splash-actions"><a class="button" href="#examples">See examples</a><a class="button secondary" href="${REPO}">View the source</a></p>
<span class="splash-ghost" aria-hidden="true"></span>
</section>

${showcase(host)}

<section class="splash-grid" aria-label="What's different">
${card("Live pages, not static HTML", "State, people and data are part of the page, not something to wire up.", [
  "<code>useShared</code>, <code>useSharedMap</code> and <code>useLocal</code> sync over a WebSocket; <code>useViewer</code> and <code>usePresence</code> know who's looking",
  "Polls, checklists, notes and comments work out of the box, alongside tables, charts and Mermaid diagrams",
  "A data file can refresh from a JSON URL on a schedule, once a person approves the host",
])}
${card("An edit-and-check loop for agents", "Agents change artifacts the way they change code, and find out when they broke something.", [
  "Ranged reads, grep, exact find-and-replace edits and JSON Patch, with version guards against stale writes",
  "Imports, components and syntax validated before anything is saved",
  "Every write rendered in a headless browser; runtime errors and a screenshot come back in the tool result",
])}
${card("Readers catch up, agents close the loop", "Artifacts people come back to tell them what moved.", [
  "Comments anchored to the exact text or table row",
  "Feedback marked addressed in a specific version, with its author notified",
  "“Changed since your last visit” down to the sections that changed or disappeared",
])}
${card("Isolated by construction", "Tenancy and untrusted code are handled by the platform, not by convention.", [
  "Each workspace is its own Durable Object with its own SQLite database, on its own subdomain and browser origin",
  "Artifact code runs in a sandboxed, opaque-origin frame with no network access",
  "Comments live outside the frame and collab writes are stamped server-side, so votes and authorship can't be forged",
])}
</section>

<section class="splash-self" id="self-host">
<div>
<h2>Self-host it in one deploy</h2>
<p class="muted">Alchemy creates everything: the Worker and its Durable Objects, DNS for workspace subdomains, the sign-in email sender, OAuth storage, R2 backups and every secret. Schema changes migrate themselves when each workspace wakes up.</p>
<ul class="splash-facts">
<li><strong>$5 a month</strong> for Workers Paid; an idle workspace costs only its stored bytes</li>
<li><strong>OAuth for MCP</strong>, or personal agent tokens for headless clients</li>
<li><strong>Nightly backups</strong> to R2, paged so size never hits Worker memory</li>
</ul>
</div>
<div class="splash-code"><div class="splash-code-head"><span>terminal</span></div><pre><code>git clone ${REPO}
cd artifacts.boo &amp;&amp; bun install
# set DOMAIN, OPERATOR_EMAILS, OPERATOR_TOKEN in .env
bun run deploy</code></pre></div>
</section>

<footer class="splash-foot muted"><a href="${REPO}">GitHub</a> · <a href="${REPO}/blob/main/docs/DESIGN.md">Design</a> · <a href="${REPO}/blob/main/docs/DEPLOY.md">Deploy guide</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/security">Security and data</a> · <a href="/login">Sign in</a></footer>
</main>`,
    {},
    `<meta name="description" content="${escapeHtml(DESCRIPTION)}">\n<link rel="canonical" href="${escapeHtml(brand.apex)}/">\n`,
  );
}

export type LoginState = { step: "email" | "code"; email?: string; error?: string; to: string; n: string; return: string };

/** Email sign-in: the address form, then the code form. `to`/`return` ride along as hidden fields. */
export function loginPage(state: LoginState, brand: Brand, status = 200): Response {
  const hidden = `<input type="hidden" name="to" value="${escapeHtml(state.to)}"><input type="hidden" name="n" value="${escapeHtml(state.n)}"><input type="hidden" name="return" value="${escapeHtml(state.return)}">`;
  const error = state.error ? `<p class="notice error" role="alert">${escapeHtml(state.error)}</p>` : "";
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
<div class="row"><input class="input" id="email" name="email" type="email" autocomplete="email" required autofocus value="${escapeHtml(state.email ?? "")}"><button class="button" type="submit">Send code</button></div>
</form>`
      : `<h1>Check your email</h1><p class="muted">We sent a code to <strong>${escapeHtml(state.email ?? "")}</strong>. It works for 10 minutes.</p>${error}
<form class="key-form" method="post" action="/login">${hidden}<input type="hidden" name="email" value="${escapeHtml(state.email ?? "")}">
<label for="code">Code</label>
<div class="row"><input class="input code-input" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{8,9}" maxlength="9" required autofocus><button class="button" type="submit">Sign in</button></div>
</form>
<form method="post" action="/login" class="resend">${hidden}<input type="hidden" name="email" value="${escapeHtml(state.email ?? "")}"><button class="link" type="submit">Send a new code</button> <a href="/login?to=${encodeURIComponent(state.to)}&n=${encodeURIComponent(state.n)}&return=${encodeURIComponent(state.return)}">Use a different email</a></form>`;
  return page(`Sign in · ${PRODUCT}`, `${topBar(brand)}<main class="content"><section class="empty">${body}<p class="muted fine">By signing in you agree to the <a href="/terms">terms</a>; see how we handle your data in <a href="/privacy">Privacy</a>.</p></section></main>`, { status });
}

/** The apex for someone signed in: their workspaces. */
export function workspacesPage(
  email: string,
  workspaces: { slug: string; name: string; role: WorkspaceRole | "guest"; suspended: boolean; url: string }[],
  operator: boolean,
  brand: Brand,
): Response {
  const rows = workspaces
    .map(
      (w) =>
        `<li><a href="${escapeHtml(w.url)}/"><span class="title">${escapeHtml(w.name)}</span><span class="meta">${escapeHtml(new URL(w.url).hostname)} · ${w.role}${w.suspended ? " · suspended" : ""}</span></a></li>`,
    )
    .join("");
  const body = workspaces.length
    ? `<h1 class="page-title">Your workspaces</h1><ul class="list">${rows}</ul>`
    : `<section class="empty"><h1>No workspaces yet</h1><p class="muted">${escapeHtml(email)} isn't a member of a workspace. Artifacts shared with you open from the links you were sent.</p></section>`;
  const admin = operator ? `<p class="archived-link"><a href="/admin">Operator console</a></p>` : "";
  return page(PRODUCT, `${topBar(brand, `${avatar(email, brand, "account", { operator })}${ACCOUNT_SCRIPT}`)}<main class="content">${body}${admin}</main>${POLICY_FOOTER}`);
}

/**
 * Notification settings. On the apex (`account`): your name and channels. In
 * a workspace: per-artifact levels there. The client (me.js) loads both through /api/me.
 */
export function profilePage(email: string, context: "account" | "workspace", brand: Brand, webPush: boolean, pushover: boolean): Response {
  return page(
    context === "account" ? `Account · ${PRODUCT}` : `Notifications · ${brand.name}`,
    `${topBar(brand, avatar(email, brand, context))}<main class="content profile" id="profile" data-context="${context}" data-webpush="${webPush ? "1" : ""}" data-pushover="${pushover ? "1" : ""}"><h1 class="page-title">${context === "account" ? "Account" : `Notifications in ${escapeHtml(brand.name)}`}</h1><p class="muted">Loading…</p></main>${ACCOUNT_SCRIPT}<script type="module" src="${asset("/static/me.js")}"></script>`,
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

const POLICY_UPDATED = "2026-10-18";

/** Privacy, terms, and security and data: what this hosted instance does with your data and expects of you. */
export function policyPage(kind: PolicyKind, brand: Brand, contact: string): Response {
  const mail = contact ? `<a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a>` : "the operator";
  const sections: Record<PolicyKind, { title: string; body: string }> = {
    privacy: {
      title: "Privacy",
      body: `
<p>${escapeHtml(brand.apex.replace(/^https:\/\//, ""))} is run by Michael Thiesen ("we"). This page says what we store, why, who else handles it, and how long we keep it. Questions or requests: ${mail}.</p>
<h2>What we store</h2>
<ul>
<li><strong>Your email address</strong>, to sign you in with one-time codes, to know who an artifact is shared with, and to email you invitations, shares and notifications (on by default; you can turn notification emails off).</li>
<li><strong>Your display name</strong>, if you set one; it's shown on your comments.</li>
<li><strong>Artifacts</strong>: the files your agent writes (up to 50 versions each), images and data files, and live data fetched from hosts a workspace admin approved.</li>
<li><strong>What people do on an artifact</strong>: comments, votes, checklists, notes and other shared state; which version you last saw and which comments you've read; an activity log (the latest 5,000 events per artifact).</li>
<li><strong>Workspace membership</strong>: who belongs to which workspace and in what role, and when members last signed in.</li>
<li><strong>Agent access</strong>: OAuth grants and personal agent tokens, stored only as hashes, with when each was last used.</li>
<li><strong>Notification settings</strong>: whether you want emails, and any channels you add (browser push subscriptions, Pushover user keys, ntfy topics and tokens, webhook URLs and their signing secrets).</li>
<li><strong>Render checks</strong>: after each change a headless browser renders the artifact; we keep the result, a screenshot and any errors. Viewers' browsers also report runtime errors (the latest 30 per artifact).</li>
<li><strong>Sign-in records</strong>: when codes were sent and checked, with your IP address or network, to limit abuse. Kept for an hour.</li>
<li><strong>Request logs</strong>: Cloudflare keeps logs of requests to this service for debugging, for a limited period.</li>
</ul>
<h2>In your browser</h2>
<p>A session cookie per site you sign in to (it lasts 30 days from your last visit), a short-lived cookie during sign-in, and cookies that remember OAuth approvals. Artifacts can keep per-person data in your browser's storage, separately for each artifact. No advertising or cross-site tracking. Pages load Cloudflare Web Analytics, which counts visits without cookies.</p>
<h2>Who can see what</h2>
<ul>
<li>An artifact is visible to its owner, the admins of its workspace, and the people, domains or workspace it's shared with; a public artifact to anyone with its link.</li>
<li>Workspace admins can see and manage every artifact in their workspace and its member list.</li>
<li>We, as operator, can access stored data to run the service: backups, restores and support. We don't sell it, use it for advertising, or train models on it.</li>
</ul>
<h2>Who else handles it</h2>
<ul>
<li><strong>Cloudflare</strong> hosts everything: compute, storage (Durable Objects, R2, KV), email sending, the headless browser for render checks, analytics and logs. Data lives on Cloudflare's network; a workspace's database is placed near where it was first used.</li>
<li><strong>Services you choose</strong>: if you add Pushover, ntfy, a webhook or browser push, notifications go to that service. Live data sources are fetched from the hosts your workspace approved.</li>
</ul>
<h2>How long we keep it</h2>
<ul>
<li>As long as the artifact or workspace exists. Deleting an artifact removes it from the live database at once.</li>
<li>Each workspace is backed up nightly when it changed; the newest 30 backups are kept, so deleted data leaves backups within about a month.</li>
<li>Deleting a workspace deletes its data and its backups, and ends its agents' access.</li>
</ul>
<h2>Your choices</h2>
<p>Turn email notifications off in your account. Ask the owner or an admin to remove you from an artifact or workspace. To get a copy of your data, or to have it deleted, email ${mail}; we reply within 30 days.</p>
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
<li>Sessions are signed, HTTP-only, secure cookies bound to one host. Every request checks the artifact's sharing, so removing someone takes effect immediately.</li>
<li>Agents connect with OAuth 2.1 (PKCE, per-workspace audience) or a personal token stored as a hash. An agent acts as one member, with that member's access, and loses it when they leave the workspace.</li>
<li>Links that sign straight into an artifact are only ever emailed to their own person (or given to an agent for its own person), open that one artifact, and expire.</li>
</ul>
<h2>Data</h2>
<ul>
<li>Everything is served over HTTPS with HSTS. Data is stored on Cloudflare (Durable Objects, R2, KV), encrypted at rest by Cloudflare.</li>
<li>Nightly backups to R2, the newest 30 kept. A restore loads everything first and swaps it in at once, so it never leaves data half-replaced.</li>
<li>Live data is only fetched from hosts a workspace admin approved, over HTTPS, without credentials.</li>
<li>See <a href="/privacy">Privacy</a> for what's stored, who handles it and for how long.</li>
</ul>
<h2>Subprocessors</h2>
<p>Cloudflare, Inc. (hosting, storage, email, headless browser, analytics, logs). Notification services you add yourself (Pushover, ntfy, webhook targets, browser push services) receive the notifications you route to them.</p>`,
    },
  };
  const { title, body } = sections[kind];
  const nav = (["privacy", "terms", "security"] as PolicyKind[])
    .map((k) => (k === kind ? `<strong>${sections[k].title}</strong>` : `<a href="/${k}">${sections[k].title}</a>`))
    .join(" · ");
  return page(
    `${title} · ${PRODUCT}`,
    `${topBar(brand)}<main class="content policy"><p class="muted policy-nav">${nav}</p><h1>${title}</h1>${body}<p class="muted policy-date">Last updated ${POLICY_UPDATED}.</p></main>`,
  );
}

/** Links to the policies, at the bottom of public pages. */
export const POLICY_FOOTER = `<footer class="site-foot muted"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/security">Security and data</a></footer>`;

/** A presigned link for someone other than whoever is signed in here: switch only if they say so. */
export function linkSwitchPage(url: URL, current: string, linked: string, brand: Brand): Response {
  return page(
    `Switch account · ${brand.name}`,
    `${topBar(brand)}<main class="content"><section class="empty"><h1>Open as ${escapeHtml(linked)}?</h1><p class="muted">You're signed in here as <strong>${escapeHtml(current)}</strong>. This link signs in as <strong>${escapeHtml(linked)}</strong> and opens one artifact.</p>
<form method="post" action="${escapeHtml(url.pathname)}" class="consent-actions"><button class="button" type="submit">Continue as ${escapeHtml(linked)}</button><a class="button secondary" href="/">Stay as ${escapeHtml(current)}</a></form></section></main>`,
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

export function shellPage(boot: ShellBoot, brand: Brand): Response {
  return page(
    boot.title,
    `<div class="shell">
<header class="bar"><span class="lead"><a class="mark" href="/" title="${escapeHtml(brand.name)}" aria-label="${escapeHtml(brand.name)}">${GHOST}</a><span class="title" title="${escapeHtml(boot.title)}">${escapeHtml(boot.title)}</span></span><span id="status" class="status"></span><span id="presence" class="presence"></span>${
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

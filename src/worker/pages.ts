// HTML documents: the splash page and sign-in on the apex, workspace pages, the
// shell around an artifact, and the sandboxed frame document that renders it.
import type { Build } from "./compile.ts";
import type { ArtifactMeta } from "./hub.ts";
import type { WorkspaceRole } from "./directory.ts";
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

// Cloudflare injects its Web Analytics beacon into shell pages; the CSP lets it
// load and report. Artifact frames opt out with no-transform (see frameDocument).
const PAGE_CSP =
  "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://cloudflareinsights.com; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// Declared inline so the very first paint is dark: without it the browser shows
// its white default canvas until the stylesheet arrives, and a frame that is
// still "light" inside the dark shell gets an opaque white backdrop.
const DARK_HEAD = `<meta name="color-scheme" content="dark">
<style>html{background:oklch(0.16 0.017 275)}</style>`;

function page(title: string, body: string, init: ResponseInit = {}): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${DARK_HEAD}
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

/** Whose pages these are: the apex ("Artifacts") or a workspace (its name). */
export type Brand = { name: string; home: string; apex: string };

function topBar(brand: Brand, right = ""): string {
  return `<header class="bar"><span class="lead"><a class="mark" href="${escapeHtml(brand.home)}" aria-label="${escapeHtml(brand.name)}">◆</a><a class="title" href="${escapeHtml(brand.home)}">${escapeHtml(brand.name)}</a></span>${right}</header>`;
}

/** The avatar slot account.js mounts the menu into. `context` decides which links it offers. */
function avatar(email: string, brand: Brand, context: "account" | "workspace", member = false): string {
  return `<span id="me" class="me" data-email="${escapeHtml(email)}" data-apex="${escapeHtml(brand.apex)}" data-context="${context}"${member ? ' data-member="1"' : ""}></span>`;
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
    ? `${avatar(viewer.email, brand, "workspace", Boolean(viewer.member))}${ACCOUNT_SCRIPT}`
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
  return page(title, `${topBar(brand, account)}<main class="content">${body}</main>${script}`);
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
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300, no-transform", "X-Robots-Tag": "noindex, nofollow" },
  });
}

const REPO = "https://github.com/micthiesen/artifacts";

const SAMPLE = `---
title: Launch plan
---
<Summary>Ship on the 14th unless the load test fails.</Summary>

\`\`\`mermaid
flowchart LR
  Freeze --> LoadTest --> Ship
\`\`\`

<Chart data="signups.json" x="week" y="count" />

<Poll id="date" options={["Oct 14", "Oct 21"]} />
<Checklist id="launch" items={["Docs", "Status page", "Email"]} />`;

/** The apex for someone who isn't signed in: what this is, for developers, and how to run it. */
export function splashPage(brand: Brand, notice?: string): Response {
  const card = (title: string, body: string, points: string[]) =>
    `<div class="splash-card"><h3>${escapeHtml(title)}</h3><p class="muted">${escapeHtml(body)}</p><ul>${points.map((x) => `<li>${x}</li>`).join("")}</ul></div>`;
  return page(
    "Artifacts",
    `${topBar(brand, `<a class="bar-link" href="${REPO}">GitHub</a><a class="button small secondary" href="/login">Sign in</a>`)}<main class="splash">
<section class="splash-hero">
${notice ? `<p class="splash-notice" role="status">${escapeHtml(notice)}</p>` : ""}
<p class="splash-kicker">Artifacts · source on GitHub · runs on Cloudflare</p>
<h1>Collaborative documents and little apps your agent can build, inspect and maintain.</h1>
<p class="splash-lede muted">Your agent writes MDX or React over MCP. People open a link, sign in with an emailed code, and get a live page: shared state, per-person state, presence and comments built in, with no backend to wire up.</p>
<p class="splash-actions"><a class="button" href="${REPO}">View the source</a><a class="button secondary" href="#self-host">Self-host it</a></p>
</section>

<section class="splash-split" aria-label="An artifact">
<div class="splash-code"><div class="splash-code-head"><span>index.mdx</span><span class="muted">what the agent writes</span></div><pre><code>${escapeHtml(SAMPLE)}</code></pre></div>
<div class="splash-list">
<h2>Live pages, not static HTML</h2>
<ul>
<li><strong>Shared and per-person state.</strong> <code>useShared</code>, <code>useSharedMap</code> and <code>useLocal</code> sync over a WebSocket; <code>useViewer</code> and <code>usePresence</code> know who's looking.</li>
<li><strong>Components that do things.</strong> Polls, checklists, notes and comment threads work out of the box, alongside tables, charts and Mermaid diagrams.</li>
<li><strong>Live data.</strong> A data file can refresh from a JSON URL on a schedule, once a person approves the host.</li>
</ul>
</div>
</section>

<section class="splash-grid" aria-label="What's different">
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
cd artifacts &amp;&amp; bun install
# set DOMAIN, OPERATOR_EMAILS, OPERATOR_TOKEN in .env
bun run deploy</code></pre></div>
</section>

<footer class="splash-foot muted"><a href="${REPO}">GitHub</a> · <a href="${REPO}/blob/main/docs/DESIGN.md">Design</a> · <a href="${REPO}/blob/main/docs/DEPLOY.md">Deploy guide</a> · <a href="/login">Sign in</a></footer>
</main>`,
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
      ? `<h1>Sign in</h1><p class="muted">We'll email you a six-digit code${where}.</p>${error}
<form class="key-form" method="post" action="/login">${hidden}
<label for="email">Email</label>
<div class="row"><input class="input" id="email" name="email" type="email" autocomplete="email" required autofocus value="${escapeHtml(state.email ?? "")}"><button class="button" type="submit">Send code</button></div>
</form>`
      : `<h1>Check your email</h1><p class="muted">We sent a code to <strong>${escapeHtml(state.email ?? "")}</strong>. It works for 10 minutes.</p>${error}
<form class="key-form" method="post" action="/login">${hidden}<input type="hidden" name="email" value="${escapeHtml(state.email ?? "")}">
<label for="code">Code</label>
<div class="row"><input class="input code-input" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus><button class="button" type="submit">Sign in</button></div>
</form>
<form method="post" action="/login" class="resend">${hidden}<input type="hidden" name="email" value="${escapeHtml(state.email ?? "")}"><button class="link" type="submit">Send a new code</button> <a href="/login?to=${encodeURIComponent(state.to)}&n=${encodeURIComponent(state.n)}&return=${encodeURIComponent(state.return)}">Use a different email</a></form>`;
  return page("Sign in · Artifacts", `${topBar(brand)}<main class="content"><section class="empty">${body}</section></main>`, { status });
}

/** The apex for someone signed in: their workspaces. */
export function workspacesPage(
  email: string,
  workspaces: { slug: string; name: string; role: WorkspaceRole; suspended: boolean; url: string }[],
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
  return page("Artifacts", `${topBar(brand, `${avatar(email, brand, "account")}${ACCOUNT_SCRIPT}`)}<main class="content">${body}${admin}</main>`);
}

/**
 * Notification settings. On the apex (`account`): your name and channels. In
 * a workspace: per-artifact levels there. The client (me.js) loads both through /api/me.
 */
export function profilePage(email: string, context: "account" | "workspace", brand: Brand, webPush: boolean, pushover: boolean): Response {
  return page(
    `Notifications · ${brand.name}`,
    `${topBar(brand, avatar(email, brand, context))}<main class="content profile" id="profile" data-context="${context}" data-webpush="${webPush ? "1" : ""}" data-pushover="${pushover ? "1" : ""}"><h1 class="page-title">Notifications</h1><p class="muted">Loading…</p></main>${ACCOUNT_SCRIPT}<script type="module" src="${asset("/static/me.js")}"></script>`,
  );
}

/** Workspace settings: connect agents, members, approved hosts. The client is settings.js. */
export function settingsPage(email: string, brand: Brand): Response {
  return page(
    `Settings · ${brand.name}`,
    `${topBar(brand, avatar(email, brand, "workspace", true))}<main class="content profile" id="settings"><h1 class="page-title">Workspace settings</h1><p class="muted">Loading…</p></main>${ACCOUNT_SCRIPT}<script type="module" src="${asset("/static/settings.js")}"></script>`,
  );
}

/** Operator console: workspaces, usage, backups. The client is admin.js. */
export function adminPage(email: string, brand: Brand): Response {
  return page(
    "Operator · Artifacts",
    `${topBar(brand, avatar(email, brand, "account"))}<main class="content profile wide" id="admin"><h1 class="page-title">Workspaces</h1><p class="muted">Loading…</p></main>${ACCOUNT_SCRIPT}<script type="module" src="${asset("/static/admin.js")}"></script>`,
  );
}

/** OAuth consent: which app, where its tokens go, and who it will act as. */
export function consentPage(
  details: { clientName: string; clientDomain?: string; redirectHost: string; redirectIsLoopback: boolean; scope: string[] },
  handle: string,
  email: string,
  brand: Brand,
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
<p>It will act as <strong>${escapeHtml(email)}</strong> here: list, create and edit your artifacts, share them, and read and reply to comments. You can disconnect it any time in workspace settings.</p>
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

export function messagePage(title: string, message: string, status: number, action?: { href: string; label: string }, brand?: Brand): Response {
  const b = brand ?? { name: "Artifacts", home: "/", apex: "" };
  const act = action ?? { href: "/", label: brand && brand.name !== "Artifacts" ? "All artifacts" : "Home" };
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
<header class="bar"><span class="lead"><a class="mark" href="/" title="${escapeHtml(brand.name)}" aria-label="${escapeHtml(brand.name)}">◆</a><span class="title" title="${escapeHtml(boot.title)}">${escapeHtml(boot.title)}</span></span><span id="status" class="status"></span><span id="presence" class="presence"></span>${
      boot.viewer.email ? avatar(boot.viewer.email, brand, "workspace", boot.member) : ""
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
${DARK_HEAD}
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
      // no-transform keeps Cloudflare's analytics beacon out of artifact content:
      // the shell page already counts the view, and the frame CSP would block it.
      "Cache-Control": "private, no-store, no-transform",
    },
  });
}

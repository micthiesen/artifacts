// Workspace settings (/settings): connect an agent (MCP URL, OAuth apps, agent
// tokens), members and approved live-data hosts. Admins can change members,
// hosts and the name; everyone else sees their own agents and the member list.
// Everything goes through /api/settings. A failed action only shows its notice,
// so what you typed stays put; a successful one reloads and re-renders.

import { PLANS } from "../worker/plans.ts";

type Settings = {
  workspace: { slug: string; name: string; url: string };
  you: { email: string; role: "admin" | "member" };
  mcpUrl: string;
  mcpName: string;
  members: { email: string; role: "admin" | "member"; addedAt: string; lastSeenAt: string | null }[];
  tokens: { id: string; email: string; label: string; createdAt: string; lastUsedAt: string | null }[];
  apps: { id: string; client: string; createdAt: string }[];
  hosts: string[];
  /** Email domains whose people join as members when they first sign in. */
  joinDomains: string[];
  /** Admins, while billing is on: the price, whether checkout works, and the subscription. */
  billing: {
    ready: boolean;
    price: { amount: number; currency: string; period: string };
    subscription: { status: string; periodEnd: string | null; manageable: boolean; payer: string | null } | null;
  } | null;
  /** You made this workspace yourself, so you can delete it. */
  canDelete: boolean;
  plan: {
    id: string;
    label: string;
    limits: { artifacts: number | null; bytes: number | null; members: number | null; changesPerDay: number | null; emailsPerDay: number };
    usage: { artifacts: number; bytes: number; members: number };
    /** A canceled subscription's Team lasts until then. */
    until?: string | null;
    /** Team given free by us, whatever billing says. */
    free?: boolean;
  };
};
type Notice = { tone: "ok" | "warn" | "error"; text: string; signIn?: boolean; reveal?: string; snippet?: string };

const main = document.getElementById("settings")!;
let data: Settings;
let notice: Notice | null = null;

/** Thrown on 401: the session cookie expired or was revoked. */
class SessionEnded extends Error {}

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 401) throw new SessionEnded("Your session ended.");
  const out = (await res.json().catch(() => ({}))) as T & { error?: string; reauth?: boolean };
  // Some changes (agent tokens, approving a host) need a recent sign-in: say so, with a way to sign in again.
  if (out.reauth) throw new SessionEnded(out.error ?? "Sign in again to do that.");
  if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
  return out;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  e.append(...children);
  return e;
}

function btn(label: string, onClick: () => void | Promise<void>, cls = "button small") {
  const b = h("button", { type: "button", class: cls }, label);
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await onClick();
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

function copyButton(value: string) {
  const b = btn("Copy", async () => {
    await navigator.clipboard.writeText(value);
    b.textContent = "Copied ✓";
    setTimeout(() => (b.textContent = "Copy"), 1600);
  }, "button small ghost");
  return b;
}

function copyRow(value: string) {
  return h("div", { class: "reveal-row" }, h("code", { class: "reveal" }, value), copyButton(value));
}

const failed = (err: unknown): Notice =>
  err instanceof SessionEnded ? { tone: "error", text: err.message, signIn: true } : { tone: "error", text: (err as Error).message };

function noticeNode(n: Notice) {
  // Errors interrupt: a failed action or an ended session is announced at once.
  const el = h("div", { class: `notice ${n.tone}`, role: n.tone === "error" ? "alert" : "status" }, n.text);
  if (n.signIn) el.append(" ", h("a", { href: `/login?fresh=1&return=${encodeURIComponent(location.pathname + location.search)}` }, "Sign in again"));
  if (n.reveal) {
    el.append(copyRow(n.reveal));
    if (n.snippet) el.append(h("p", { class: "muted small" }, "Or add it to Claude Code:"), copyRow(n.snippet));
    el.append(h("p", { class: "muted small" }, "It isn't shown again. Anyone with it can act as you in this workspace, so keep it in your agent's config only."));
  }
  return el;
}

/** Shows a notice at the top without re-rendering, so inputs keep their values. */
function flash(n: Notice) {
  const el = noticeNode(n);
  const existing = main.querySelector(":scope > .notice");
  const title = main.querySelector(":scope > .page-title");
  if (existing) existing.replaceWith(el);
  else if (title) title.after(el);
  else main.prepend(el);
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// Requests cut off by leaving the page (Safari says "Load failed") aren't errors worth showing.
let leaving = false;
addEventListener("pagehide", () => (leaving = true));
addEventListener("pageshow", (e) => {
  leaving = false;
  // Back from the provider through the back button: the page is as we left it (Upgrade busy), so refresh it.
  if (e.persisted) void load().catch(() => {});
});

async function act(fn: () => Promise<unknown>, ok?: string | (() => string)) {
  try {
    await fn();
  } catch (err) {
    if (leaving) return;
    notice = null;
    flash(failed(err));
    return;
  }
  if (ok && !notice) notice = { tone: "ok", text: typeof ok === "function" ? ok() : ok };
  try {
    await load();
  } catch (err) {
    if (!leaving) flash(failed(err));
  }
}

const size = (b: number) =>
  b < 1024 * 1024 ? "under 1 MB" : b >= 1024 ** 3 ? `${Math.round((b / 1024 ** 3) * 10) / 10} GB` : `${Math.round(b / 1024 / 1024)} MB`;

const FREE = PLANS.free.limits;
/** What moving back to Free means, said where the customer decides. */
const AFTER_FREE = `After that, this workspace keeps everything but can't add anything while it's over ${FREE.artifacts} artifacts, ${FREE.members} members or ${size(FREE.bytes!)} of storage.`;

/** Statuses after which a subscription can't charge again. */
const ENDED = ["canceled", "expired", "scheduled_cancel"];

/** Whether you see Manage billing: the payer does, and so does every admin once the payer is no longer one. */
function seesBilling(): boolean {
  const payer = data.billing?.subscription?.payer ?? null;
  const payerAdmin = payer !== null && data.members.some((m) => m.email === payer && m.role === "admin");
  return !payerAdmin || payer === data.you.email.toLowerCase();
}

/** Admins, while billing is on: upgrade to Team, or manage the subscription with the payment provider. */
function billingSection(billing: NonNullable<Settings["billing"]>): HTMLElement {
  const sub = billing.subscription;
  const team = data.plan.id === "team";
  const until = sub?.periodEnd ? new Date(sub.periodEnd).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : null;
  const go = (path: string) =>
    act(async () => {
      const r = await api<{ url: string }>(path, { body: {} });
      location.href = r.url;
      // We're leaving for the provider: don't refresh this page meanwhile (the browser would cancel it mid-way).
      await new Promise(() => {});
    });
  const day = (v: string) => new Date(v).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const plainUntil = data.plan.until ? day(data.plan.until) : null;
  const payer = sub?.payer ?? null;
  const mine = seesBilling();
  const state = data.plan.free
    ? `Team, free: arranged with us.${sub && !["canceled", "expired"].includes(sub.status) ? " It still has a subscription: cancel it in Manage billing if you don't need it." : ""}`
    : !team
    ? `This workspace is on Free. Team is $${billing.price.amount} a ${billing.price.period} for the whole workspace: no artifact or member limit, and more storage. Guests are always free.`
    : sub && ["active", "trialing", "paid"].includes(sub.status)
      ? `Team, paid${until ? ` through ${until}` : ""}.`
      : sub && ["past_due", "unpaid", "expired"].includes(sub.status)
        ? `Team, but the last payment didn't go through. ${mine ? "Update the card in Manage billing" : `Ask ${payer} to update the card`}${plainUntil ? ` by ${plainUntil}` : ""} to keep it.`
        : sub?.status === "paused"
          ? `Team until ${plainUntil ?? until ?? "the end of the paid period"}, then Free: the subscription is paused. ${mine ? "Resume it from Manage billing" : `Ask ${payer} to resume it`} to keep Team. ${AFTER_FREE}`
          : data.plan.until || sub?.status === "scheduled_cancel"
            ? `Team until ${plainUntil ?? until ?? "the end of the paid period"}, then Free: the subscription is canceled. Subscribe again to keep Team. ${AFTER_FREE}`
            : "Team, arranged with us directly.";
  // Matches the server: a subscription that's canceled or lapsed to Free can be replaced by a new one.
  const live = sub && sub.status !== "canceled" && team;
  const actions = h("div", { class: "row" });
  const notes: HTMLElement[] = [];
  // Canceled with paid time left: subscribing again keeps Team past the date (the new subscription takes over).
  const resubscribe = team && sub?.status === "canceled" && Boolean(data.plan.until);
  if ((!team && !live) || resubscribe) {
    const b = btn(resubscribe ? "Subscribe again" : "Upgrade to Team", () => go("/api/settings/billing/checkout"));
    if (!billing.ready || checkout !== "idle") {
      b.setAttribute("disabled", "");
      b.setAttribute("aria-describedby", "billing-not-ready");
      notes.push(
        checkout === "pending"
          ? h("p", { class: "muted small", id: "billing-not-ready" }, "Waiting for the payment to be confirmed…")
          : checkout === "stuck"
            ? h("p", { class: "muted small", id: "billing-not-ready" }, "Don't pay again: ", h("a", { href: "/support" }, "contact support"), " and we'll check.")
            : h("p", { class: "muted small", id: "billing-not-ready" }, "Upgrades are unavailable for now. ", h("a", { href: "/support" }, "Ask us"), " and we'll sort out an upgrade."),
      );
    }
    actions.append(b);
  }
  if (sub?.manageable && mine) {
    actions.append(btn("Manage billing", () => go("/api/settings/billing/portal"), "button small secondary"));
    notes.push(h("p", { class: "muted small" }, "Receipts and invoices are in Manage billing."));
  }
  if (payer) notes.push(h("p", { class: "muted small" }, payer === data.you.email.toLowerCase() ? `Billed to you (${payer}).` : mine ? `Billed to ${payer}.` : `Billed to ${payer}: they can change the card or cancel.`));
  return h(
    "section",
    { class: "card-section" },
    h("h2", { id: "plan-and-billing" }, "Plan and billing"),
    h("p", { class: "muted" }, state),
    ...notes,
    actions,
    h("p", { class: "muted small billing-note" }, "Payments are handled by Creem, who is the seller on the invoice and handles sales tax and VAT."),
  );
}

/** Whoever made the workspace: delete it for good, after typing its address. */
function deleteSection(): HTMLElement[] {
  const slug = data.workspace.slug;
  const confirm = h("input", { class: "input", type: "text", autocomplete: "off", spellcheck: "false", "aria-label": `Type ${slug} to confirm`, placeholder: slug });
  const go = btn(
    "Delete workspace",
    () =>
      act(async () => {
        const r = await api<{ location: string }>("/api/settings/delete", { body: { confirm: confirm.value.trim() } });
        location.href = r.location;
        await new Promise(() => {});
      }),
    "button small danger-solid",
  );
  // Deleting doesn't stop a subscription, so it has to end first.
  const sub = data.billing?.subscription;
  const charging = Boolean(sub && !ENDED.includes(sub.status));
  if (charging) {
    go.setAttribute("disabled", "");
    confirm.setAttribute("disabled", "");
    go.setAttribute("aria-describedby", "delete-billing");
  }
  const others = data.members.filter((m) => m.role === "admin" && m.email !== data.you.email);
  const handOver: HTMLElement[] = [];
  if (others.length) {
    const pick = h("select", { class: "input", "aria-label": "Admin to hand the workspace to" }) as HTMLSelectElement;
    for (const m of others) pick.append(h("option", { value: m.email }, m.email));
    handOver.push(
      h(
        "section",
        { class: "card-section" },
        h("h2", {}, "Hand it over"),
        h("p", { class: "muted" }, "Make another admin its owner: they can then delete it, and you could make a workspace of your own."),
        h(
          "div",
          { class: "row" },
          pick,
          btn("Hand over", () => {
            const to = pick.value;
            if (!window.confirm(`Hand ${data.workspace.name} to ${to}? Only they can delete it afterwards.`)) return;
            return act(() => api("/api/settings/owner", { body: { email: to } }), () => `${to} owns this workspace now.`);
          }, "button small secondary"),
        ),
      ),
    );
  }
  return [
    ...handOver,
    h(
      "section",
      { class: "card-section" },
      h("h2", {}, "Delete workspace"),
      h("p", { class: "muted" }, `Deletes every artifact, comment and member, and its backups. It can't be undone: download a copy above first. Type ${slug} to confirm.`),
      ...(charging
        ? [h("p", { class: "muted small", id: "delete-billing" }, seesBilling() ? "Cancel the subscription in Manage billing first." : `Ask ${sub!.payer} to cancel the subscription first.`)]
        : []),
      h("div", { class: "row" }, confirm, go),
    ),
  ];
}

/** Admins: download everything as of the latest backup, or ask for a fresh one. Filled in once the status loads. */
function exportSection(): HTMLElement {
  const status = h("p", { class: "muted small" }, "Checking for a backup…");
  const actions = h("div", { class: "row" });
  const section = h(
    "section",
    { class: "card-section" },
    h("h2", { id: "export" }, "Export your data"),
    h(
      "p",
      { class: "muted" },
      "Everything in this workspace, artifacts with their latest 50 versions, shared state, comments and members, as one JSON Lines file your agent can read. No lock-in: take it anywhere, or run your own copy from the source. ",
      h("a", { href: "https://github.com/micthiesen/artifacts.boo/blob/main/docs/EXPORT.md" }, "What's in it"),
      ".",
    ),
    status,
    actions,
  );
  const backupNow = () =>
    btn("Back up now", async () => {
      try {
        const r = await api<{ queued: boolean; retryAt?: string }>("/api/settings/export", { body: {} });
        status.textContent = r.queued
          ? "Backing up. Check back in a minute, then download."
          : r.retryAt
            ? `A backup was made in the last hour; the next can start at ${new Date(r.retryAt).toLocaleTimeString()}.`
            : "Backups aren't set up on this server.";
      } catch (err) {
        status.textContent = (err as Error).message;
      }
    }, "button small secondary");
  api<{ latest: { run: string; at: string } | null; backingUp: boolean }>("/api/settings/export?status=1").then(
    (r) => {
      status.textContent = r.backingUp
        ? "A backup is running now."
        : r.latest
          ? `From the backup made ${new Date(r.latest.at).toLocaleString()}. Backups run nightly on days something changed.`
          : "There's no backup yet. Make one, then download it.";
      if (r.latest) {
        // Checked first, so an error (say, the backup was just pruned) shows here instead of downloading as a file.
        const link = h("a", { class: "button small", href: "/api/settings/export", download: "" }, "Download export");
        link.addEventListener("click", async (e) => {
          if (link.dataset.checked) return;
          e.preventDefault();
          try {
            const now = await api<{ latest: { run: string } | null }>("/api/settings/export?status=1");
            if (!now.latest) throw new Error("There's no backup to download any more. Make one first.");
            link.dataset.checked = "1";
            link.click();
            delete link.dataset.checked;
          } catch (err) {
            status.textContent = (err as Error).message;
          }
        });
        actions.append(link);
      }
      actions.append(backupNow());
    },
    (err: Error) => (status.textContent = err.message),
  );
  return section;
}

// Back from checkout: the plan changes once the payment provider tells us, usually within a few seconds.
// Until then Upgrade stays off (a second checkout would mean paying twice), and we check back for a minute
// without re-rendering, so what you type and the notice stay put. If it never comes, Upgrade stays off until reload.
let checkout: "idle" | "pending" | "stuck" = "idle";
if (new URLSearchParams(location.search).get("billing") === "done") {
  notice = { tone: "ok", text: "Thanks! Your workspace moves to Team as soon as the payment is confirmed, usually within a few seconds." };
  history.replaceState(null, "", location.pathname + location.hash);
  checkout = "pending";
  let tries = 0;
  // Only the plan counts: an earlier subscription's record is already there on a resubscribe.
  const confirmed = (s: Settings) => s.plan.id === "team" && !(s.billing?.subscription?.status === "canceled" && s.plan.until);
  const check = async () => {
    tries++;
    let fresh: Settings | null = null;
    try {
      fresh = await api<Settings>("/api/settings");
    } catch {
      // try again next time
    }
    if (fresh && confirmed(fresh)) {
      checkout = "idle";
      data = fresh;
      notice = { tone: "ok", text: "Payment confirmed: this workspace is on Team." };
      render({ keepTyped: true });
    } else if (tries < 20) {
      if (fresh && data && (fresh.plan.id !== data.plan.id || fresh.plan.until !== data.plan.until)) {
        data = fresh;
        render({ keepTyped: true });
      }
      setTimeout(check, 3000);
    } else {
      checkout = "stuck";
      if (fresh) data = fresh;
      notice = { tone: "warn", text: "The payment hasn't been confirmed yet." };
      if (data) render({ keepTyped: true });
    }
  };
  setTimeout(check, 3000);
}

async function load() {
  data = await api<Settings>("/api/settings");
  render();
}

const when = (v: string | null) => (v === null ? "never" : new Date(v).toLocaleDateString());
const mcpAdd = (extra = "") => `claude mcp add --transport http ${data.mcpName} ${data.mcpUrl}${extra}`;
const bearer = (token: string) => mcpAdd(` --header "Authorization: Bearer ${token}"`);

/** How to add the MCP server in each client, as steps and copyable snippets. */
const CLIENTS: { id: string; label: string; steps: () => (string | { copy: string })[] }[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    steps: () => ["Run this, then /mcp in Claude Code to sign in:", { copy: mcpAdd() }],
  },
  {
    id: "codex",
    label: "Codex",
    steps: () => ["Add the server, then sign in from the terminal:", { copy: `codex mcp add ${data.mcpName} --url ${data.mcpUrl}` }, { copy: `codex mcp login ${data.mcpName}` }],
  },
  {
    id: "claude-app",
    label: "Claude app",
    steps: () => ["On claude.ai or in the desktop app, open Settings → Connectors → Add custom connector, paste this URL, then Connect:", { copy: data.mcpUrl }],
  },
  {
    id: "cursor",
    label: "Cursor",
    steps: () => [
      "Add this to ~/.cursor/mcp.json (or .cursor/mcp.json in a project), then sign in from Cursor's MCP settings:",
      { copy: JSON.stringify({ mcpServers: { [data.mcpName]: { url: data.mcpUrl } } }) },
    ],
  },
  {
    id: "vscode",
    label: "VS Code",
    steps: () => ["Run this, then start the server from the MCP view and sign in:", { copy: `code --add-mcp '${JSON.stringify({ name: data.mcpName, type: "http", url: data.mcpUrl })}'` }],
  },
  {
    id: "other",
    label: "Other",
    steps: () => ["Any MCP client with Streamable HTTP and OAuth works with this URL. Without OAuth, use an agent token below.", { copy: data.mcpUrl }],
  },
];
const CLIENT_KEY = "artifacts.client";

/** Client picker; switching only redraws its own steps, so nothing else on the page resets. */
function clientSetup() {
  const steps = h("div", { class: "client-steps" });
  const tabs = h("div", { class: "client-tabs", role: "group", "aria-label": "Your agent" });
  let current = localStorage.getItem(CLIENT_KEY) ?? CLIENTS[0].id;
  if (!CLIENTS.some((c) => c.id === current)) current = CLIENTS[0].id;
  const show = () => {
    const client = CLIENTS.find((c) => c.id === current)!;
    for (const b of tabs.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.client === current));
    steps.replaceChildren(...client.steps().map((s) => (typeof s === "string" ? h("p", { class: "muted small snippet-label" }, s) : copyRow(s.copy))));
  };
  for (const c of CLIENTS) {
    const b = h("button", { type: "button", class: "client-tab", "data-client": c.id }, c.label);
    b.addEventListener("click", () => {
      current = c.id;
      localStorage.setItem(CLIENT_KEY, c.id);
      show();
    });
    tabs.append(b);
  }
  show();
  return h("div", {}, tabs, steps);
}

/** `keepTyped`: a refresh nobody asked for (a payment confirmed), so fields keep what's typed in them. */
function render(opts: { keepTyped?: boolean } = {}) {
  const admin = data.you.role === "admin";
  const sections: HTMLElement[] = [h("h1", { class: "page-title" }, data.workspace.name)];
  // Only plans with limits say anything: there's nothing to buy yet.
  const { limits, usage } = data.plan;
  if (limits.artifacts !== null || limits.bytes !== null || limits.members !== null) {
    const mb = size;
    const parts = [
      limits.artifacts !== null && `${usage.artifacts} of ${limits.artifacts} artifacts (archived included)`,
      limits.members !== null && `${usage.members} of ${limits.members} members`,
      limits.bytes !== null && `${mb(usage.bytes)} of ${mb(limits.bytes)}`,
    ].filter((p): p is string => Boolean(p));
    const usageLine = h("p", { class: "muted plan-usage" }, `${data.plan.label} plan: ${parts.join(" · ")}. People you share artifacts with don't count.`);
    // Close to a limit, admins get a way to more room before they hit it.
    const near = [
      limits.artifacts !== null && usage.artifacts >= limits.artifacts * 0.8,
      limits.members !== null && usage.members >= limits.members,
      limits.bytes !== null && usage.bytes >= limits.bytes * 0.8,
    ].some(Boolean);
    if (near && data.billing && data.plan.id === "free") usageLine.append(" ", h("a", { href: "#plan-and-billing" }, "Upgrade to Team for more room"));
    else if (near && !admin) usageLine.append(" For more room, ask a workspace admin to upgrade, or delete artifacts you don't need.");
    sections.push(usageLine);
    // On Free, the way to more room comes first.
    if (admin && data.billing && data.plan.id === "free") sections.push(billingSection(data.billing));
    // Over a limit (say, after moving to Free): say what still works and what doesn't.
    const over = [
      limits.artifacts !== null && usage.artifacts > limits.artifacts && "artifacts",
      limits.members !== null && usage.members > limits.members && "members",
      limits.bytes !== null && usage.bytes > limits.bytes && "storage",
    ].filter((x): x is string => Boolean(x));
    if (over.length) {
      // Part of the page, not news: no alert role, or it would be announced on every re-render.
      const overNotice = noticeNode({
        tone: "warn",
        text: `This workspace is over the ${data.plan.label} plan's limit for ${over.join(" and ")}. Everything here still opens and can be changed, but nothing that adds to it (new artifacts, members or stored content) until it's back under${data.billing ? ", or the workspace moves to Team" : ""}. Archiving doesn't free room; deleting does.`,
      });
      overNotice.removeAttribute("role");
      sections.push(overNotice);
    }
  }
  if (notice) {
    sections.push(noticeNode(notice));
  }

  // Connect an agent
  const apps = h("ul", { class: "channels" });
  for (const a of data.apps) {
    apps.append(
      h(
        "li",
        {},
        h("span", { class: "channel-label" }, a.client),
        h("span", { class: "muted small" }, `connected ${when(a.createdAt)}`),
        h("span", { class: "channel-actions" }, btn("Disconnect", () => act(() => api(`/api/settings/apps/${a.id}`, { method: "DELETE" }), `Disconnected ${a.client}.`), "button small ghost danger")),
      ),
    );
  }
  const mine = data.tokens.filter((t) => t.email === data.you.email);
  const tokens = h("ul", { class: "channels" });
  for (const t of mine) tokens.append(tokenRow(t));
  const label = h("input", { type: "text", placeholder: "Label, e.g. Codex", maxlength: "60", "aria-label": "Token label" }) as HTMLInputElement;
  sections.push(
    h(
      "section",
      { class: "card-section" },
      h("h2", {}, "Connect an agent"),
      h("p", { class: "muted" }, "Add this workspace's MCP server to your agent. It signs in with OAuth in your browser and then acts as you here."),
      clientSetup(),
      h(
        "p",
        { class: "muted small snippet-label" },
        "To have your agent act on answers as they come in, use MCP events or a scheduled run: ",
        h("a", { href: "https://github.com/micthiesen/artifacts.boo/blob/main/docs/AUTOMATIONS.md" }, "automation recipes"),
        ".",
      ),
      h("h3", { class: "subhead" }, "Connected apps"),
      data.apps.length ? apps : h("p", { class: "muted small" }, "None yet."),
      h("h3", { class: "subhead" }, "Agent tokens"),
      h("p", { class: "muted small" }, "For agents that can't open a browser: send the token as Authorization: Bearer <token> to the MCP URL. In Claude Code:"),
      copyRow(bearer("<token>")),
      h("p", { class: "muted small snippet-label" }, "In Codex, with the token in ARTIFACTS_TOKEN:"),
      copyRow(`codex mcp add ${data.mcpName} --url ${data.mcpUrl} --bearer-token-env-var ARTIFACTS_TOKEN`),
      mine.length ? tokens : h("p", { class: "muted small" }, "None yet."),
      h(
        "div",
        { class: "row" },
        label,
        btn("Create token", () =>
          act(async () => {
            const r = await api<{ token: string; label: string }>("/api/settings/tokens", { body: { label: label.value } });
            notice = { tone: "ok", text: `Created “${r.label}”.`, reveal: r.token, snippet: bearer(r.token) };
          }),
        ),
      ),
    ),
  );

  // Members
  const members = h("ul", { class: "channels" });
  for (const m of data.members) {
    const li = h("li", {}, h("span", { class: "channel-label" }, m.email), h("span", { class: `chip${m.role === "admin" ? " positive" : ""}` }, m.role));
    if (m.lastSeenAt === null) li.append(h("span", { class: "chip" }, "hasn't signed in yet"));
    if (admin) {
      const other = m.role === "admin" ? "member" : "admin";
      const self = m.email === data.you.email;
      li.append(
        h(
          "span",
          { class: "channel-actions" },
          btn(`Make ${other}`, () => setMember(m.email, other), "button small ghost"),
          btn("Remove", () => {
            const question = self
              ? `Remove yourself from ${data.workspace.name}? You lose access to it and your agents stop working here.`
              : `Remove ${m.email}? Their agents lose access, and artifacts they own pass to you.`;
            if (!confirm(question)) return;
            if (self) return leave();
            return act(() => api("/api/settings/members", { body: { email: m.email, role: null } }), `Removed ${m.email}. Artifacts they owned now belong to you.`);
          }, "button small ghost danger"),
        ),
      );
    }
    members.append(li);
  }
  const memberSection = h(
    "section",
    { class: "card-section" },
    h("h2", {}, "Members"),
    h(
      "p",
      { class: "muted" },
      "Members connect their own agents and make artifacts. Admins also manage members, approved hosts and every artifact. Anyone else you share an artifact with signs in as a guest and sees only that artifact.",
    ),
    members,
  );
  if (admin) {
    const email = h("input", { type: "email", placeholder: "name@example.com", autocomplete: "off", "aria-label": "Email address" }) as HTMLInputElement;
    const role = h("select", { "aria-label": "Role" }, h("option", { value: "member" }, "Member"), h("option", { value: "admin" }, "Admin")) as HTMLSelectElement;
    memberSection.append(h("div", { class: "row" }, email, role, btn("Add", () => setMember(email.value.trim(), role.value as "admin" | "member"))));
  }
  // Join domains: everyone sees the rule when there is one; only admins change it.
  const joinDomains = data.joinDomains ?? [];
  if (admin || joinDomains.length) {
    const domains = h("ul", { class: "channels" });
    for (const domain of joinDomains) {
      const li = h("li", {}, h("span", { class: "channel-label" }, domain));
      if (admin) li.append(h("span", { class: "channel-actions" }, btn("Remove", () => act(() => api("/api/settings/join", { body: { domain, allowed: false } }), `People at ${domain} no longer join on their own. Current members stay.`), "button small ghost danger")));
      domains.append(li);
    }
    memberSection.append(
      h("h3", { class: "subhead" }, "Join by email domain"),
      h("p", { class: "muted small" }, "Anyone with an email at these domains joins as a member when they sign in, without an invitation. People you remove stay removed."),
      joinDomains.length ? domains : h("p", { class: "muted small" }, "None yet."),
    );
    if (admin) {
      const domain = h("input", { type: "text", placeholder: "example.com", autocomplete: "off", spellcheck: "false", "aria-label": "Email domain" }) as HTMLInputElement;
      memberSection.append(
        h("div", { class: "row" }, domain, btn("Add domain", () => act(() => api("/api/settings/join", { body: { domain: domain.value, allowed: true } }), `Anyone at ${domain.value.trim().replace(/^@/, "").toLowerCase()} now joins as a member.`))),
      );
    }
  }
  sections.push(memberSection);

  // Everyone's tokens (admins)
  if (admin) {
    const others = data.tokens.filter((t) => t.email !== data.you.email);
    if (others.length) {
      const list = h("ul", { class: "channels" });
      for (const t of others) list.append(tokenRow(t, true));
      sections.push(h("section", { class: "card-section" }, h("h2", {}, "Other members' agent tokens"), h("p", { class: "muted" }, "Revoke one if it may have leaked."), list));
    }
  }

  // Approved hosts
  const hosts = h("ul", { class: "channels" });
  for (const host of data.hosts) {
    const li = h("li", {}, h("span", { class: "channel-label" }, host));
    if (admin) li.append(h("span", { class: "channel-actions" }, btn("Revoke", () => act(() => api("/api/settings/hosts", { body: { host, allowed: false } }), `Revoked ${host}.`), "button small ghost danger")));
    hosts.append(li);
  }
  const hostSection = h(
    "section",
    { class: "card-section" },
    h("h2", {}, "Approved data hosts"),
    h(
      "p",
      { class: "muted" },
      admin
        ? "Live data sources only fetch from hosts an admin approved; agents can't approve them. Approve one from an artifact's Manage panel when its agent asks, or here."
        : "Live data sources only fetch from hosts an admin approved; agents can't approve them. Ask a workspace admin to approve a new one.",
    ),
    data.hosts.length ? hosts : h("p", { class: "muted small" }, "None yet."),
  );
  if (admin) {
    const host = h("input", { type: "text", placeholder: "api.example.com", autocomplete: "off", spellcheck: "false", "aria-label": "Host" }) as HTMLInputElement;
    hostSection.append(h("div", { class: "row" }, host, btn("Approve", () => act(() => api("/api/settings/hosts", { body: { host: host.value, allowed: true } }), `Approved ${host.value.trim()}.`))));
  }
  sections.push(hostSection);

  if (admin) {
    const name = h("input", { type: "text", value: data.workspace.name, maxlength: "80", "aria-label": "Workspace name" }) as HTMLInputElement;
    sections.push(
      h(
        "section",
        { class: "card-section" },
        h("h2", {}, "Workspace"),
        h("p", { class: "muted" }, `Shown in the top bar and in “your workspaces”. The address stays ${new URL(data.workspace.url).hostname}.`),
        h("div", { class: "row" }, name, btn("Rename", () => act(() => api("/api/settings/name", { body: { name: name.value } }), "Renamed."))),
      ),
    );
    if (data.billing && data.plan.id !== "free") sections.push(billingSection(data.billing));
    sections.push(exportSection());
    if (data.canDelete) sections.push(...deleteSection());
  }
  // A re-render (say, a payment confirmed while you type) keeps what's typed in each field, and where you were.
  const fieldKey = (el: HTMLInputElement | HTMLTextAreaElement) => el.name || el.getAttribute("aria-label") || el.placeholder;
  const typed = new Map<string, string>();
  let focused: string | null = null;
  for (const el of opts.keepTyped ? main.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea") : []) {
    if (el.type === "hidden" || el.type === "checkbox" || el.type === "radio" || !fieldKey(el)) continue;
    if (el.value) typed.set(fieldKey(el), el.value);
    if (el === document.activeElement) focused = fieldKey(el);
  }
  main.replaceChildren(...sections);
  for (const el of opts.keepTyped ? main.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea") : []) {
    const key = fieldKey(el);
    if (!key) continue;
    if (!el.value && typed.has(key)) el.value = typed.get(key)!;
    if (key === focused) el.focus();
  }
  if (notice) main.querySelector(".notice")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  notice = null;
}

/** Adds someone or changes their role; the server says which it was and whether it emailed them. */
function setMember(email: string, role: "admin" | "member") {
  let text = "";
  return act(
    async () => {
      const r = await api<{ existed: boolean; emailed: boolean }>("/api/settings/members", { body: { email, role } });
      text = r.existed
        ? `Changed ${email}'s role to ${role}.`
        : r.emailed
          ? `Added ${email} and emailed them a sign-in link.`
          : `Added ${email}. They sign in at ${data.workspace.url} with that email.`;
    },
    () => text,
  );
}

/** Removing yourself: there's nothing left to show here afterwards, so go to the workspace's front page. */
async function leave() {
  try {
    await api("/api/settings/members", { body: { email: data.you.email, role: null } });
  } catch (err) {
    flash(failed(err));
    return;
  }
  location.href = "/";
}

function tokenRow(t: Settings["tokens"][number], showOwner = false) {
  return h(
    "li",
    {},
    h("span", { class: "channel-label" }, showOwner ? `${t.label} · ${t.email}` : t.label),
    h("span", { class: "muted small" }, `created ${when(t.createdAt)} · last used ${when(t.lastUsedAt)}`),
    h("span", { class: "channel-actions" }, btn("Revoke", () => act(() => api(`/api/settings/tokens/${t.id}`, { method: "DELETE" }), `Revoked “${t.label}”.`), "button small ghost danger")),
  );
}

load()
  // Rendered after the page loaded, so a link to a section (say, #export from Account) scrolls here.
  .then(() => location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView())
  .catch((err) => {
    main.replaceChildren(h("h1", { class: "page-title" }, "Workspace settings"), noticeNode(failed(err)));
  });

export {};

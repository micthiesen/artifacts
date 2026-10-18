// Workspace settings (/settings): connect an agent (MCP URL, OAuth apps, agent
// tokens), members and approved live-data hosts. Admins can change members,
// hosts and the name; everyone else sees their own agents and the member list.
// Everything goes through /api/settings. A failed action only shows its notice,
// so what you typed stays put; a successful one reloads and re-renders.

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
  plan: {
    id: string;
    label: string;
    limits: { artifacts: number | null; bytes: number | null; members: number | null; changesPerDay: number | null };
    usage: { artifacts: number; bytes: number; members: number };
  };
};
type Notice = { tone: "ok" | "error"; text: string; signIn?: boolean; reveal?: string; snippet?: string };

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
  const out = (await res.json().catch(() => ({}))) as T & { error?: string };
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
  err instanceof SessionEnded ? { tone: "error", text: "Your session ended.", signIn: true } : { tone: "error", text: (err as Error).message };

function noticeNode(n: Notice) {
  const el = h("div", { class: `notice ${n.tone}`, role: "status" }, n.text);
  if (n.signIn) el.append(" ", h("a", { href: `/login?return=${encodeURIComponent(location.pathname + location.search)}` }, "Sign in again"));
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

async function act(fn: () => Promise<unknown>, ok?: string | (() => string)) {
  try {
    await fn();
  } catch (err) {
    notice = null;
    flash(failed(err));
    return;
  }
  if (ok && !notice) notice = { tone: "ok", text: typeof ok === "function" ? ok() : ok };
  try {
    await load();
  } catch (err) {
    flash(failed(err));
  }
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

function render() {
  const admin = data.you.role === "admin";
  const sections: HTMLElement[] = [h("h1", { class: "page-title" }, data.workspace.name)];
  // Only plans with limits say anything: there's nothing to buy yet.
  const { limits, usage } = data.plan;
  if (limits.artifacts !== null || limits.bytes !== null || limits.members !== null) {
    const mb = (b: number) => (b < 1024 * 1024 ? "under 1 MB" : `${Math.round(b / 1024 / 1024)} MB`);
    const parts = [
      limits.artifacts !== null && `${usage.artifacts} of ${limits.artifacts} artifacts`,
      limits.members !== null && `${usage.members} of ${limits.members} members`,
      limits.bytes !== null && `${mb(usage.bytes)} of ${mb(limits.bytes)}`,
    ].filter((p): p is string => Boolean(p));
    sections.push(h("p", { class: "muted plan-usage" }, `${data.plan.label} plan: ${parts.join(" · ")}. People you share artifacts with don't count.`));
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
  const label = h("input", { type: "text", placeholder: "Label, e.g. Codex on my laptop", maxlength: "60" }) as HTMLInputElement;
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
    const email = h("input", { type: "email", placeholder: "name@example.com", autocomplete: "off" }) as HTMLInputElement;
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
    const host = h("input", { type: "text", placeholder: "api.example.com", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
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
  }
  main.replaceChildren(...sections);
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

load().catch((err) => {
  main.replaceChildren(h("h1", { class: "page-title" }, "Workspace settings"), noticeNode(failed(err)));
});

export {};

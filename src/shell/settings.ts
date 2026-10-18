// Workspace settings (/settings): connect an agent (MCP URL, OAuth apps, agent
// tokens), members and approved live-data hosts. Admins can change members,
// hosts and the name; everyone else sees their own agents and the member list.
// Everything goes through /api/settings.

type Settings = {
  workspace: { slug: string; name: string; url: string };
  you: { email: string; role: "admin" | "member" };
  mcpUrl: string;
  members: { email: string; role: "admin" | "member"; addedAt: string }[];
  tokens: { id: string; email: string; label: string; createdAt: string; lastUsedAt: string | null }[];
  apps: { id: string; client: string; createdAt: number | string }[];
  hosts: string[];
};

const main = document.getElementById("settings")!;
let data: Settings;
let notice: { tone: "ok" | "error"; text: string; reveal?: string } | null = null;

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
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

async function act(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
    if (ok && !notice) notice = { tone: "ok", text: ok };
  } catch (err) {
    notice = { tone: "error", text: (err as Error).message };
  }
  await load();
}

async function load() {
  data = await api<Settings>("/api/settings");
  render();
}

const when = (v: string | number | null) => (v === null ? "never" : new Date(typeof v === "number" && v < 1e12 ? v * 1000 : v).toLocaleDateString());

function render() {
  const admin = data.you.role === "admin";
  const sections: HTMLElement[] = [h("h1", { class: "page-title" }, data.workspace.name)];
  if (notice) {
    const n = h("div", { class: `notice ${notice.tone}`, role: "status" }, notice.text);
    if (notice.reveal) {
      n.append(
        h("div", { class: "reveal-row" }, h("code", { class: "reveal" }, notice.reveal), copyButton(notice.reveal)),
        h("p", { class: "muted small" }, "It isn't shown again. Anyone with it can act as you in this workspace, so keep it in your agent's config only."),
      );
    }
    sections.push(n);
    notice = null;
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
      h("p", { class: "muted" }, "Add this MCP server to Claude, Codex or any MCP client. It signs in with OAuth in your browser and then acts as you here."),
      h("div", { class: "reveal-row" }, h("code", { class: "reveal" }, data.mcpUrl), copyButton(data.mcpUrl)),
      h("h3", { class: "subhead" }, "Connected apps"),
      data.apps.length ? apps : h("p", { class: "muted small" }, "None yet. A newly connected app can take a minute to show up here."),
      h("h3", { class: "subhead" }, "Agent tokens"),
      h("p", { class: "muted small" }, "For agents that can't open a browser: send the token as Authorization: Bearer <token> to the MCP URL."),
      mine.length ? tokens : h("p", { class: "muted small" }, "None yet."),
      h(
        "div",
        { class: "row" },
        label,
        btn("Create token", () =>
          act(async () => {
            const r = await api<{ token: string; label: string }>("/api/settings/tokens", { body: { label: label.value } });
            notice = { tone: "ok", text: `Created “${r.label}”.`, reveal: r.token };
          }),
        ),
      ),
    ),
  );

  // Members
  const members = h("ul", { class: "channels" });
  for (const m of data.members) {
    const li = h("li", {}, h("span", { class: "channel-label" }, m.email), h("span", { class: `chip${m.role === "admin" ? " positive" : ""}` }, m.role));
    if (admin) {
      const other = m.role === "admin" ? "member" : "admin";
      li.append(
        h(
          "span",
          { class: "channel-actions" },
          btn(`Make ${other}`, () => act(() => api("/api/settings/members", { body: { email: m.email, role: other } }), `${m.email} is now ${other === "admin" ? "an admin" : "a member"}.`), "button small ghost"),
          btn("Remove", () => {
            if (!confirm(`Remove ${m.email}? Their agents lose access. Artifacts they own stay, and admins can manage them.`)) return;
            return act(() => api("/api/settings/members", { body: { email: m.email, role: null } }), `Removed ${m.email}.`);
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
    memberSection.append(
      h(
        "div",
        { class: "row" },
        email,
        role,
        btn("Add", () =>
          act(() => api("/api/settings/members", { body: { email: email.value, role: role.value } }), `Added ${email.value.trim()}. They sign in at ${data.workspace.url} with that email.`),
        ),
      ),
    );
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
    h("p", { class: "muted" }, "Live data sources only fetch from hosts a person approved; agents can't approve them. Approve one from an artifact's Manage panel when its agent asks, or here."),
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
  main.querySelector(".notice")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
  main.replaceChildren(h("h1", { class: "page-title" }, "Workspace settings"), h("p", { class: "notice error" }, (err as Error).message));
});

export {};

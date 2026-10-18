// Operator console (/admin on the apex): every workspace with its usage, and
// create, suspend, back up, restore and delete. Everything goes through /api/admin.

type Stats = { artifacts: number; members: number; bytes: number; lastActivity: string | null };
type Workspace = { slug: string; name: string; createdAt: string; suspended: boolean; stats: Stats | null; statsAt: string | null; admins: string[]; url: string };

const main = document.getElementById("admin")!;
let workspaces: Workspace[] = [];
let notice: { tone: "ok" | "error"; text: string } | null = null;
const backups = new Map<string, string[]>();

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

function btn(label: string, onClick: () => void | Promise<void>, cls = "button small ghost") {
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

async function act(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
    if (ok) notice = { tone: "ok", text: ok };
  } catch (err) {
    notice = { tone: "error", text: (err as Error).message };
  }
  await load();
}

async function load() {
  workspaces = (await api<{ workspaces: Workspace[] }>("/api/admin/workspaces")).workspaces;
  render();
}

function size(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function render() {
  const sections: HTMLElement[] = [h("h1", { class: "page-title" }, "Workspaces")];
  if (notice) sections.push(h("div", { class: `notice ${notice.tone}`, role: "status" }, notice.text));
  notice = null;

  const total = workspaces.reduce((n, w) => n + (w.stats?.bytes ?? 0), 0);
  sections.push(h("p", { class: "muted" }, `${workspaces.length} workspaces · ${size(total)} stored (as of each workspace's last stats)`));

  for (const w of workspaces) {
    const s = w.stats;
    const card = h(
      "section",
      { class: "card-section" },
      h("h2", {}, h("a", { href: `${w.url}/` }, w.name), " ", h("span", { class: `chip${w.suspended ? " caution" : " positive"}` }, w.suspended ? "suspended" : "active")),
      h(
        "p",
        { class: "muted small" },
        `${new URL(w.url).hostname} · admins ${w.admins.join(", ") || "none"} · created ${w.createdAt.slice(0, 10)}`,
      ),
      h(
        "p",
        { class: "small" },
        s
          ? `${s.artifacts} artifacts · ${s.members} members · ${size(s.bytes)} · last activity ${s.lastActivity ? s.lastActivity.slice(0, 16).replace("T", " ") : "none"} · stats from ${w.statsAt?.slice(0, 16).replace("T", " ")}`
          : "No stats yet.",
      ),
    );
    const dates = backups.get(w.slug);
    const restore = h("span", {});
    if (dates) {
      if (!dates.length) restore.append(h("span", { class: "muted small" }, "No backups yet."));
      else {
        const select = h("select", { "aria-label": `Backup to restore for ${w.slug}` }, ...dates.map((d) => h("option", { value: d }, d))) as HTMLSelectElement;
        restore.append(
          select,
          btn("Restore", () => {
            if (!confirm(`Replace everything in ${w.slug} with the ${select.value} backup? Changes since then are lost.`)) return;
            return act(() => api(`/api/admin/workspaces/${w.slug}/restore`, { body: { date: select.value } }), `Restored ${w.slug} from ${select.value}.`);
          }, "button small ghost danger"),
        );
      }
    }
    card.append(
      h(
        "div",
        { class: "channel-actions" },
        btn("Refresh stats", () => act(() => api(`/api/admin/workspaces/${w.slug}/stats`, { body: {} }))),
        btn("Back up now", () => act(() => api(`/api/admin/workspaces/${w.slug}/backup`, { body: {} }), `Backed up ${w.slug}.`)),
        btn("Backups…", () =>
          act(async () => {
            backups.set(w.slug, (await api<{ dates: string[] }>(`/api/admin/workspaces/${w.slug}/backups`)).dates);
          }),
        ),
        btn(w.suspended ? "Resume" : "Suspend", () => act(() => api(`/api/admin/workspaces/${w.slug}`, { body: { suspended: !w.suspended } }), `${w.suspended ? "Resumed" : "Suspended"} ${w.slug}.`)),
        btn("Delete…", () => {
          const typed = prompt(`This deletes ${w.slug}, its data and its backups. Type ${w.slug} to confirm.`);
          if (typed !== w.slug) return;
          return act(() => api(`/api/admin/workspaces/${w.slug}`, { method: "DELETE" }), `Deleted ${w.slug}.`);
        }, "button small ghost danger"),
        restore,
      ),
    );
    sections.push(card);
  }

  // The directory: everyone's names, notification channels and memberships, and the workspace list.
  const dirDates = backups.get("_directory");
  const dirRestore = h("span", {});
  if (dirDates?.length) {
    const select = h("select", { "aria-label": "Directory backup to restore" }, ...dirDates.map((d) => h("option", { value: d }, d))) as HTMLSelectElement;
    dirRestore.append(
      select,
      btn("Restore", () => {
        if (!confirm(`Replace the directory (names, channels, memberships, workspace list) with the ${select.value} backup?`)) return;
        return act(() => api("/api/admin/directory/restore", { body: { date: select.value } }), `Restored the directory from ${select.value}.`);
      }, "button small ghost danger"),
    );
  } else if (dirDates) dirRestore.append(h("span", { class: "muted small" }, "No backups yet."));
  sections.push(
    h(
      "section",
      { class: "card-section" },
      h("h2", {}, "Directory"),
      h("p", { class: "muted" }, "Names, notification channels, memberships and the workspace list. Backed up nightly when it changes."),
      h(
        "div",
        { class: "channel-actions" },
        btn("Back up now", () => act(() => api("/api/admin/directory/backup", { body: {} }), "Backed up the directory.")),
        btn("Backups…", () =>
          act(async () => {
            backups.set("_directory", (await api<{ dates: string[] }>("/api/admin/directory/backups")).dates);
          }),
        ),
        dirRestore,
      ),
    ),
  );

  const slug = h("input", { type: "text", placeholder: "slug, e.g. acme", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const name = h("input", { type: "text", placeholder: "Name, e.g. Acme Inc." }) as HTMLInputElement;
  const admin = h("input", { type: "email", placeholder: "First admin's email", autocomplete: "off" }) as HTMLInputElement;
  sections.push(
    h(
      "section",
      { class: "card-section" },
      h("h2", {}, "New workspace"),
      h("p", { class: "muted" }, "The slug becomes its address (slug.domain) and can't change later. The first admin adds everyone else."),
      h("div", { class: "row" }, slug, name),
      h(
        "div",
        { class: "row" },
        admin,
        btn("Create", () => act(() => api("/api/admin/workspaces", { body: { slug: slug.value, name: name.value || slug.value, admin: admin.value } }), `Created ${slug.value.trim()}.`), "button small"),
      ),
    ),
  );
  main.replaceChildren(...sections);
}

load().catch((err) => {
  main.replaceChildren(h("h1", { class: "page-title" }, "Workspaces"), h("p", { class: "notice error" }, (err as Error).message));
});

export {};

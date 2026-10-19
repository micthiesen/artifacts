// Operator console (/admin on the apex): every workspace with its usage, and
// create, suspend, back up, restore and delete. Everything goes through /api/admin.
// Workspace backups, restores and imports run in the background as jobs; the
// list polls while one is running. Typed values are kept across re-renders
// (keyed by data-key), and a failed action only shows its notice.

type Stats = { artifacts: number; members: number; bytes: number; lastActivity: string | null; plan?: "free" | "team"; freeTeam?: boolean };
type Job = { kind: "backup" | "restore" | "import"; phase?: string; progress?: string; error?: string; startedAt: string };
type Workspace = {
  slug: string;
  name: string;
  createdAt: string;
  suspended: boolean;
  stats: Stats | null;
  statsAt: string | null;
  admins: string[];
  url: string;
  job: Job | null;
  /** Self-serve: who made it. */
  createdBy: string | null;
  billing: { status: string; periodEnd: string | null; payerEmail: string | null; subscriptionId: string | null } | null;
};
type OpsEvent = { id: number; at: string; kind: string; slug: string | null; message: string; detail: Record<string, unknown> | null };
type Notice = { tone: "ok" | "error"; text: string; signIn?: boolean };

const main = document.getElementById("admin")!;
let workspaces: Workspace[] = [];
let events: OpsEvent[] = [];
let eventFilter = "";
let notice: Notice | null = null;
const backups = new Map<string, string[]>();
const drafts = new Map<string, string>();
let poll: ReturnType<typeof setTimeout> | undefined;

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

/** An input or select whose value survives re-renders. */
function kept<T extends HTMLInputElement | HTMLSelectElement>(el: T, key: string): T {
  const saved = drafts.get(key);
  if (saved !== undefined && (!(el instanceof HTMLSelectElement) || [...el.options].some((o) => o.value === saved))) el.value = saved;
  el.addEventListener(el instanceof HTMLSelectElement ? "change" : "input", () => drafts.set(key, el.value));
  return el;
}

/** Names a button for screen readers, where the same label repeats on every workspace. */
function named<T extends HTMLElement>(el: T, label: string): T {
  el.setAttribute("aria-label", label);
  return el;
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

const failed = (err: unknown): Notice =>
  err instanceof SessionEnded ? { tone: "error", text: "Your session ended.", signIn: true } : { tone: "error", text: (err as Error).message };

function noticeNode(n: Notice) {
  const el = h("div", { class: `notice ${n.tone}`, role: "status" }, n.text);
  if (n.signIn) el.append(" ", h("a", { href: `/login?return=${encodeURIComponent(location.pathname + location.search)}` }, "Sign in again"));
  return el;
}

/** Shows a notice at the top without re-rendering. */
function flash(n: Notice) {
  const el = noticeNode(n);
  const existing = main.querySelector(":scope > .notice");
  const title = main.querySelector(":scope > .page-title");
  if (existing) existing.replaceWith(el);
  else if (title) title.after(el);
  else main.prepend(el);
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/** Runs an action; on success shows `ok` and reloads, and `clear` lists draft keys to empty. */
async function act(fn: () => Promise<unknown>, ok?: string | (() => string), clear: string[] = []) {
  try {
    await fn();
  } catch (err) {
    flash(failed(err));
    return;
  }
  if (ok) notice = { tone: "ok", text: typeof ok === "function" ? ok() : ok };
  for (const k of clear) drafts.delete(k);
  await refresh();
}

async function load() {
  const previous = new Map(workspaces.map((w) => [w.slug, w.job]));
  const [list, ops] = await Promise.all([
    api<{ workspaces: Workspace[] }>("/api/admin/workspaces"),
    api<{ events: OpsEvent[] }>(`/api/admin/ops?limit=40${eventFilter ? `&kind=${eventFilter}` : ""}`),
  ]);
  // Newest first, so new signups are at the top.
  workspaces = list.workspaces.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  events = ops.events;
  // A job that was running and is gone has finished.
  for (const w of workspaces) {
    const was = previous.get(w.slug);
    if (was && !was.error && !w.job && !notice) notice = { tone: "ok", text: `${jobName(was.kind)} of ${w.slug} finished.` };
  }
  render();
}

async function refresh() {
  try {
    await load();
  } catch (err) {
    flash(failed(err));
  }
}

const running = () => workspaces.some((w) => w.job && !w.job.error);

// Polls every 5 s while a job runs. It waits while you're typing so a re-render
// doesn't take focus away mid-word.
function schedulePoll() {
  clearTimeout(poll);
  if (!running()) return;
  poll = setTimeout(() => {
    if (main.contains(document.activeElement) && document.activeElement?.matches("input, select")) schedulePoll();
    else void refresh();
  }, 5000);
}

function size(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const jobName = (kind: Job["kind"]) => ({ backup: "Backup", restore: "Restore", import: "Import" })[kind];
const stamp = (iso: string) => iso.slice(0, 16).replace("T", " ");

function jobLine(w: Workspace, job: Job) {
  const detail = [job.phase, job.progress].filter(Boolean).join(" · ");
  const line = h(
    "div",
    { class: `job-line${job.error ? " failed" : ""}`, role: "status" },
    h("strong", {}, job.error ? `${jobName(job.kind)} failed` : `${jobName(job.kind)} running`),
    h("span", { class: "muted small" }, `${detail ? `${detail} · ` : ""}started ${stamp(job.startedAt)}`),
  );
  if (job.error) line.append(h("span", { class: "job-error small" }, job.error));
  line.append(
    h(
      "span",
      { class: "channel-actions" },
      named(btn(job.error ? "Dismiss" : "Cancel job", () => {
        if (!job.error && !confirm(`Cancel the ${job.kind} of ${w.slug}?`)) return;
        return act(() => api(`/api/admin/workspaces/${w.slug}/job`, { method: "DELETE" }), job.error ? undefined : `Cancelled the ${job.kind} of ${w.slug}.`);
      }, "button small ghost danger"), job.error ? `Dismiss the ${job.kind} error for ${w.slug}` : `Cancel the ${job.kind} of ${w.slug}`),
    ),
  );
  return line;
}

const EVENT_FILTERS: [string, string][] = [
  ["", "Everything"],
  ["report", "Reports"],
  ["signup", "Signups"],
  ["billing", "Billing"],
];

/** The ops log: signups, billing changes, reports and failures, newest first. */
function eventsSection(): HTMLElement {
  const filter = h("select", { "aria-label": "Show" }, ...EVENT_FILTERS.map(([v, label]) => h("option", { value: v }, label))) as HTMLSelectElement;
  filter.value = eventFilter;
  filter.addEventListener("change", () => {
    eventFilter = filter.value;
    void act(async () => {});
  });
  const urgent = /failed|unread|unknown|bad_signature|near_cap|report/;
  const rows = events.map((e) =>
    h(
      "li",
      {},
      h("span", { class: `chip${urgent.test(e.kind) ? " caution" : ""}` }, e.kind.replaceAll("_", " ")),
      h("span", { class: "small" }, e.message),
      h("span", { class: "muted small" }, `${e.slug ? `${e.slug} · ` : ""}${stamp(e.at)}${e.detail ? ` · ${Object.entries(e.detail).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ")}` : ""}`),
    ),
  );
  return h(
    "section",
    { class: "card-section" },
    h("h2", {}, "Recent events"),
    h("div", { class: "row" }, filter),
    rows.length ? h("ul", { class: "channels ops-events" }, ...rows) : h("p", { class: "muted" }, "Nothing yet."),
  );
}

function render() {
  const sections: HTMLElement[] = [h("h1", { class: "page-title" }, "Workspaces")];
  if (notice) sections.push(noticeNode(notice));
  notice = null;

  const total = workspaces.reduce((n, w) => n + (w.stats?.bytes ?? 0), 0);
  const paying = workspaces.filter((w) => w.billing && ["active", "trialing", "paid"].includes(w.billing.status)).length;
  sections.push(h("p", { class: "muted" }, `${workspaces.length} workspaces · ${paying} paying · ${size(total)} stored (as of each workspace's last stats)`));
  sections.push(eventsSection());

  for (const w of workspaces) {
    const s = w.stats;
    const busy = w.job != null && !w.job.error;
    const card = h(
      "section",
      { class: "card-section" },
      h("h2", {}, h("a", { href: `${w.url}/` }, w.name), " ", h("span", { class: `chip${w.suspended ? " caution" : " positive"}` }, w.suspended ? "suspended" : "active")),
      h("p", { class: "muted small" }, `${new URL(w.url).hostname} · admins ${w.admins.join(", ") || "none"} · created ${w.createdAt.slice(0, 10)}${w.createdBy ? ` by ${w.createdBy} (self-serve)` : ""}`),
      ...(w.billing
        ? [h("p", { class: "small" }, `Billing: ${w.billing.status}${w.billing.periodEnd ? `, period ends ${w.billing.periodEnd.slice(0, 10)}` : ""}${w.billing.payerEmail ? ` · paid by ${w.billing.payerEmail}` : ""}${w.billing.subscriptionId ? ` · ${w.billing.subscriptionId}` : ""}`)]
        : []),
      h(
        "p",
        { class: "small" },
        s
          ? `${s.freeTeam ? "Team (free)" : s.plan === "free" ? "Free" : "Team"} plan · ${s.artifacts} artifacts · ${s.members} members · ${size(s.bytes)} · last activity ${s.lastActivity ? stamp(s.lastActivity) : "none"} · stats from ${w.statsAt ? stamp(w.statsAt) : "never"}`
          : "No stats yet.",
      ),
    );
    if (w.job) card.append(jobLine(w, w.job));

    const runs = backups.get(w.slug);
    const restore = h("span", {});
    if (runs) {
      if (!runs.length) restore.append(h("span", { class: "muted small" }, "No backups yet."));
      else {
        const select = kept(h("select", { "aria-label": `Backup to restore for ${w.slug}` }, ...runs.map((r) => h("option", { value: r }, r))) as HTMLSelectElement, `run-${w.slug}`);
        restore.append(
          select,
          named(btn("Restore", () => {
            const run = select.value;
            if (!confirm(`Replace everything in ${w.slug} with the ${run} backup? A fresh backup runs first, and the workspace is offline until the restore finishes.`)) return;
            return act(
              () => api(`/api/admin/workspaces/${w.slug}/restore`, { body: { run } }),
              "Restore queued (a fresh backup runs first). The workspace is offline until it finishes.",
            );
          }, "button small ghost danger"), `Restore ${w.slug}`),
        );
      }
    }
    const backup = named(btn("Back up now", () => act(() => api(`/api/admin/workspaces/${w.slug}/backup`, { body: {} }), `Backup of ${w.slug} started.`)), `Back up ${w.slug} now`);
    if (busy) backup.disabled = true;
    card.append(
      h(
        "div",
        { class: "channel-actions" },
        named(btn("Refresh stats", () => act(() => api(`/api/admin/workspaces/${w.slug}/stats`, { body: {} }))), `Refresh stats for ${w.slug}`),
        ...(w.billing
          ? [
              named(btn("Resync plan", () => act(() => api(`/api/admin/workspaces/${w.slug}/resync`, { body: {} }), `${w.slug}'s plan is set from its subscription.`)), `Resync plan for ${w.slug}`),
              named(btn("End billing", () => {
                if (!confirm(`End ${w.slug}'s paid time now, so it's on Free? Cancel or refund the subscription in Creem as well.`)) return;
                return act(() => api(`/api/admin/workspaces/${w.slug}/end-billing`, { body: {} }), `${w.slug} is on Free now.`);
              }), `End billing for ${w.slug}`),
            ]
          : []),
        // Team at no charge, whatever billing says (the operator's own workspaces); off hands the plan back to billing.
        named(
          btn(s?.freeTeam ? "End free Team" : "Give Team free", () =>
            act(() => api(`/api/admin/workspaces/${w.slug}/free-team`, { body: { on: !s?.freeTeam } }), s?.freeTeam ? `${w.slug}'s plan follows billing again.` : `${w.slug} has Team free.`),
          ),
          `${s?.freeTeam ? "End free Team for" : "Give Team free to"} ${w.slug}`,
        ),
        backup,
        named(btn("Backups…", () =>
          act(async () => {
            backups.set(w.slug, (await api<{ runs: string[] }>(`/api/admin/workspaces/${w.slug}/backups`)).runs);
          }),
        ), `Backups of ${w.slug}`),
        named(btn(w.suspended ? "Resume" : "Suspend", () => act(() => api(`/api/admin/workspaces/${w.slug}`, { body: { suspended: !w.suspended } }), `${w.suspended ? "Resumed" : "Suspended"} ${w.slug}.`)), `${w.suspended ? "Resume" : "Suspend"} ${w.slug}`),
        named(btn("Delete…", () => {
          const typed = prompt(`This deletes ${w.slug}, its data and its backups. Type ${w.slug} to confirm.`);
          if (typed !== w.slug) return;
          return act(() => api(`/api/admin/workspaces/${w.slug}`, { method: "DELETE" }), `Deleted ${w.slug}.`);
        }, "button small ghost danger"), `Delete ${w.slug}`),
        restore,
      ),
    );

    // Admins: fixes a mistyped first admin without signing in as anyone.
    const adminKey = `admin-${w.slug}`;
    const email = kept(h("input", { type: "email", placeholder: "Admin's email", autocomplete: "off", "aria-label": `Add an admin to ${w.slug}` }) as HTMLInputElement, adminKey);
    const admins = h("div", { class: "admin-row" }, h("span", { class: "muted small" }, "Admins:"));
    for (const a of w.admins) {
      admins.append(
        h(
          "span",
          { class: "admin-chip" },
          a,
          named(btn("Remove", () => {
            if (!confirm(`Remove ${a} from ${w.slug}? Artifacts they own pass to another admin.`)) return;
            return act(() => api(`/api/admin/workspaces/${w.slug}/members`, { body: { email: a, role: null } }), `Removed ${a} from ${w.slug}.`);
          }, "om-text-button danger"), `Remove ${a} from ${w.slug}`),
        ),
      );
    }
    if (!w.admins.length) admins.append(h("span", { class: "muted small" }, "none"));
    card.append(
      admins,
      h(
        "div",
        { class: "row" },
        email,
        named(btn("Add or replace admin", () => {
          const who = email.value.trim();
          return act(() => api(`/api/admin/workspaces/${w.slug}/members`, { body: { email: who, role: "admin" } }), `${who} is now an admin of ${w.slug}.`, [adminKey]);
        }), `Add or replace an admin of ${w.slug}`),
      ),
    );
    sections.push(card);
  }

  // The directory: everyone's names, notification channels and memberships, and the workspace list.
  const dirRuns = backups.get("_directory");
  const dirRestore = h("span", {});
  if (dirRuns?.length) {
    const select = kept(h("select", { "aria-label": "Directory backup to restore" }, ...dirRuns.map((r) => h("option", { value: r }, r))) as HTMLSelectElement, "run-_directory");
    dirRestore.append(
      select,
      btn("Restore", () => {
        const run = select.value;
        if (!confirm(`Replace the directory (names, channels, memberships, workspace list) with the ${run} backup?`)) return;
        return act(() => api("/api/admin/directory/restore", { body: { run } }), `Restored the directory from ${run}.`);
      }, "button small ghost danger"),
    );
  } else if (dirRuns) dirRestore.append(h("span", { class: "muted small" }, "No backups yet."));
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
            backups.set("_directory", (await api<{ runs: string[] }>("/api/admin/directory/backups")).runs);
          }),
        ),
        dirRestore,
      ),
    ),
  );

  const slug = kept(h("input", { type: "text", placeholder: "slug, e.g. acme", autocomplete: "off", spellcheck: "false", "aria-label": "Slug" }) as HTMLInputElement, "new-slug");
  const name = kept(h("input", { type: "text", placeholder: "Name, e.g. Acme Inc.", "aria-label": "Name" }) as HTMLInputElement, "new-name");
  const admin = kept(h("input", { type: "email", placeholder: "First admin's email", autocomplete: "off", "aria-label": "First admin's email" }) as HTMLInputElement, "new-admin");
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
        btn("Create", () => {
          const email = admin.value.trim();
          let text = "";
          return act(
            async () => {
              const r = await api<{ workspace: { name: string; url: string }; emailed: boolean }>("/api/admin/workspaces", {
                body: { slug: slug.value, name: name.value || slug.value, admin: email },
              });
              text = r.emailed
                ? `Created ${r.workspace.name} at ${r.workspace.url}. We emailed ${email} a sign-in link.`
                : `Created ${r.workspace.name} at ${r.workspace.url}. The sign-in email to ${email} didn't send, so send them the address yourself.`;
            },
            () => text,
            ["new-slug", "new-name", "new-admin"],
          );
        }, "button small"),
      ),
    ),
  );
  main.replaceChildren(...sections);
  schedulePoll();
}

load().catch((err) => {
  main.replaceChildren(h("h1", { class: "page-title" }, "Workspaces"), noticeNode(failed(err)));
});

export {};

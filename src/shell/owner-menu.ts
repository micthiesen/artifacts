// Owner menu: a "Manage" button in the artifact bar that opens a side panel for
// sharing, history, problems, live data sources and settings. Talks to the
// owner API (/api/a/<id>, /api/a/<id>/<tool>, /api/hosts) with the session cookie.
import type { ShellBoot } from "../shared/protocol.ts";

type ShareRole = "view" | "edit";
type Overview = {
  meta: {
    id: string;
    title: string;
    description: string;
    version: number;
    public: boolean;
    createdAt: string;
    updatedAt: string;
    shares: { email: string; role: ShareRole }[];
    files: { path: string; bytes: number }[];
  };
  history: { version: number; note: string; createdAt: string; files?: unknown }[];
  errors: { at: string; version: number; viewer: string | null; message: string; stack?: string | null }[];
  sources: {
    path: string;
    url: string;
    host: string;
    everyMinutes: number;
    pick: string | null;
    approved: boolean;
    lastFetch: string | null;
    lastStatus: string | null;
    lastError: string | null;
  }[];
  assets: { path: string; contentType: string; bytes: number }[];
  hosts: string[];
};
type ToolResponse = { ok: boolean; text: string; data: Record<string, unknown> | null };
type TabId = "sharing" | "history" | "problems" | "data" | "settings";
type Note = { text: string; error?: boolean; pre?: boolean };

const TABS: { id: TabId; label: string }[] = [
  { id: "sharing", label: "Sharing" },
  { id: "history", label: "History" },
  { id: "problems", label: "Problems" },
  { id: "data", label: "Data" },
  { id: "settings", label: "Settings" },
];

// --- DOM helpers ----------------------------------------------------------

type Attrs = Record<string, string | number | boolean | undefined | null | ((e: Event) => void)>;
type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (k === "class") el.className = String(v);
    else if (k === "value" && "value" in el) (el as HTMLInputElement).value = String(v);
    else if (k === "checked" && el instanceof HTMLInputElement) el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function icon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}
const ICON_MANAGE = ["M21 4h-7", "M10 4H3", "M21 12h-9", "M8 12H3", "M21 20h-5", "M12 20H3", "M14 2v4", "M8 10v4", "M16 18v4"];
const ICON_CLOSE = ["M6 6l12 12", "M18 6L6 18"];

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.round((t - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), "day");
  if (abs < 86400 * 365) return rtf.format(Math.round(s / (86400 * 30)), "month");
  return rtf.format(Math.round(s / (86400 * 365)), "year");
}
function time(iso: string | null | undefined): HTMLTimeElement {
  return h("time", { datetime: iso ?? "", title: iso ? new Date(iso).toLocaleString() : "" }, ago(iso));
}

function cadence(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? "daily" : `every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "hourly" : `every ${minutes / 60} hours`;
  return `every ${minutes} min`;
}

// --- API ------------------------------------------------------------------

async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(
    path,
    body === undefined
      ? { credentials: "same-origin" }
      : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  let json: Record<string, unknown>;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Request failed (${res.status}).`);
  }
  if (!res.ok || json.ok === false) {
    throw new Error(String(json.text ?? json.error ?? `Request failed (${res.status}).`));
  }
  return json as T;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// --- Menu -----------------------------------------------------------------

export function initOwnerMenu(boot: ShellBoot): void {
  const slot = document.getElementById("owner-menu");
  if (!slot) return;
  const base = `/api/a/${encodeURIComponent(boot.artifactId)}`;
  const tool = (name: string, args: Record<string, unknown> = {}) => request<ToolResponse>(`${base}/${name}`, args);

  let data: Overview | null = null;
  let loadError: string | null = null;
  let tab: TabId = "sharing";
  let open = false;
  let returnFocus: HTMLElement | null = null;
  const notes: Partial<Record<TabId, Note>> = {};
  const busy = new Set<string>();
  // Text typed into inputs, kept across re-renders (keyed by data-key).
  const drafts = new Map<string, string>();
  function draft<T extends HTMLInputElement | HTMLTextAreaElement>(el: T, initial: string): T {
    const key = el.dataset.key!;
    el.value = drafts.get(key) ?? initial;
    el.addEventListener("input", () => drafts.set(key, el.value));
    return el;
  }

  const button = h(
    "button",
    {
      type: "button",
      class: "om-trigger",
      "aria-haspopup": "dialog",
      "aria-expanded": "false",
      "aria-controls": "om-panel",
      title: "Manage this artifact",
      onclick: () => (open ? close() : show()),
    },
    icon(ICON_MANAGE),
    h("span", { class: "om-trigger-label" }, "Manage"),
  );
  button.setAttribute("aria-label", "Manage");
  slot.append(button);

  const backdrop = h("div", { class: "om-backdrop", hidden: true, onclick: () => close() });
  const titleId = "om-title";
  const body = h("div", { class: "om-body" });
  const tablist = h("div", { class: "om-tabs", role: "tablist", "aria-label": "Manage sections" });
  const panel = h(
    "aside",
    { id: "om-panel", class: "om-panel", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, hidden: true, tabindex: "-1" },
    h(
      "div",
      { class: "om-head" },
      h("h2", { id: titleId, class: "om-title" }, "Manage"),
      h("button", { type: "button", class: "om-icon-button", "aria-label": "Close", "data-key": "close", onclick: () => close() }, icon(ICON_CLOSE)),
    ),
    tablist,
    body,
  );
  document.body.append(backdrop, panel);

  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      trapFocus(e);
    }
  });

  function focusables(): HTMLElement[] {
    return [
      ...panel.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])"),
    ].filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null && el.tabIndex >= 0);
  }
  function trapFocus(e: KeyboardEvent) {
    const els = focusables();
    if (!els.length) return;
    const first = els[0];
    const last = els[els.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function show() {
    open = true;
    returnFocus = document.activeElement as HTMLElement | null;
    backdrop.hidden = false;
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    document.querySelector<HTMLElement>(".shell")?.setAttribute("inert", "");
    document.body.classList.add("om-open");
    render();
    (panel.querySelector<HTMLElement>("[role=tab][aria-selected=true]") ?? panel).focus();
    void load();
  }
  function close() {
    if (!open) return;
    open = false;
    backdrop.hidden = true;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.querySelector<HTMLElement>(".shell")?.removeAttribute("inert");
    document.body.classList.remove("om-open");
    (returnFocus && document.contains(returnFocus) ? returnFocus : button).focus();
  }

  async function load() {
    try {
      data = await request<Overview>(base);
      loadError = null;
    } catch (err) {
      loadError = (err as Error).message;
    }
    if (open) render();
  }

  /** Runs an action with a busy key, records its outcome as the tab's note, then reloads. */
  async function act(key: string, section: TabId, fn: () => Promise<Note | void>, reload = true) {
    if (busy.has(key)) return;
    busy.add(key);
    render();
    try {
      const note = await fn();
      if (note) notes[section] = note;
      else delete notes[section];
    } catch (err) {
      notes[section] = { text: (err as Error).message, error: true };
    } finally {
      busy.delete(key);
    }
    if (reload) await load();
    else render();
  }

  // Rebuild the panel content, keeping focus on the same logical control.
  function render() {
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.key;
    const tabs = TABS.filter((t) => t.id !== "data" || !data || data.sources.length > 0 || data.hosts.length > 0);
    if (!tabs.some((t) => t.id === tab)) tab = "sharing";
    tablist.replaceChildren(
      ...tabs.map((t) =>
        h(
          "button",
          {
            type: "button",
            role: "tab",
            id: `om-tab-${t.id}`,
            class: "om-tab",
            "aria-selected": String(t.id === tab),
            "aria-controls": "om-section",
            tabindex: t.id === tab ? "0" : "-1",
            "data-key": `tab-${t.id}`,
            onclick: () => {
              tab = t.id;
              render();
            },
            onkeydown: (e: Event) => {
              const k = (e as KeyboardEvent).key;
              const i = tabs.findIndex((x) => x.id === tab);
              let next = -1;
              if (k === "ArrowRight") next = (i + 1) % tabs.length;
              else if (k === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
              else if (k === "Home") next = 0;
              else if (k === "End") next = tabs.length - 1;
              if (next < 0) return;
              e.preventDefault();
              tab = tabs[next].id;
              render();
              tablist.querySelector<HTMLElement>(`#om-tab-${tab}`)?.focus();
            },
          },
          t.label,
        ),
      ),
    );
    const section = h("section", { id: "om-section", class: "om-section", role: "tabpanel", "aria-labelledby": `om-tab-${tab}` });
    if (!data) {
      section.append(
        loadError
          ? h("p", { class: "om-note error", role: "alert" }, loadError, " ", h("button", { type: "button", class: "link", onclick: () => void load() }, "Retry"))
          : h("p", { class: "muted" }, "Loading…"),
      );
    } else {
      if (loadError) section.append(h("p", { class: "om-note error", role: "alert" }, loadError));
      section.append(...renderTab(data));
    }
    const note = notes[tab];
    section.append(
      h(
        "div",
        { class: `om-note${note?.error ? " error" : ""}`, role: note?.error ? "alert" : "status", "aria-live": "polite" },
        note ? (note.pre ? h("pre", { class: "om-pre" }, note.text) : note.text) : "",
      ),
    );
    body.replaceChildren(section);
    if (focusKey) body.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
    if (focusKey?.startsWith("tab-")) tablist.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
  }

  function renderTab(d: Overview): Node[] {
    switch (tab) {
      case "sharing":
        return renderSharing(d);
      case "history":
        return renderHistory(d);
      case "problems":
        return renderProblems(d);
      case "data":
        return renderData(d);
      case "settings":
        return renderSettings(d);
    }
  }

  function btn(label: string, key: string, onclick: () => void, cls = "button small", extra: Attrs = {}) {
    const isBusy = busy.has(key);
    return h("button", { type: "button", class: cls, "data-key": key, disabled: isBusy, "aria-busy": isBusy ? "true" : undefined, onclick, ...extra }, label);
  }

  // --- Sharing --------------------------------------------------------------

  function renderSharing(d: Overview): Node[] {
    const shares = [...d.meta.shares].sort((a, b) => a.email.localeCompare(b.email));
    const list = shares.length
      ? h(
          "ul",
          { class: "om-list" },
          ...shares.map((s) => {
            const isDomain = s.email.startsWith("@");
            const label = isDomain ? `Everyone at ${s.email.slice(1)}` : s.email;
            return h(
              "li",
              { class: "om-row" },
              h("span", { class: "om-grow om-ellipsis", title: s.email }, label),
              h(
                "select",
                {
                  class: "om-select",
                  "aria-label": `Role for ${s.email}`,
                  "data-key": `role-${s.email}`,
                  disabled: busy.has(`role-${s.email}`),
                  onchange: (e: Event) => {
                    const role = (e.target as HTMLSelectElement).value as ShareRole;
                    void act(`role-${s.email}`, "sharing", async () => {
                      await tool("artifact_share", { add: [{ email: s.email, role }] });
                      return { text: `${label} can now ${role}.` };
                    });
                  },
                },
                h("option", { value: "view", selected: s.role === "view" }, "Can view"),
                h("option", { value: "edit", selected: s.role === "edit" }, "Can edit"),
              ),
              !isDomain &&
                btn("Copy link", `link-${s.email}`, () =>
                  void act(`link-${s.email}`, "sharing", () => copyLink(s.email), false), "om-text-button"),
              btn("Remove", `remove-${s.email}`, () =>
                void act(`remove-${s.email}`, "sharing", async () => {
                  await tool("artifact_share", { remove: [s.email] });
                  return { text: `Removed ${label}.` };
                }), "om-text-button danger", { "aria-label": `Remove ${s.email}` }),
            );
          }),
        )
      : h("p", { class: "muted om-empty" }, "Not shared with anyone yet.");

    const emailInput = draft(h("input", {
      class: "input",
      id: "om-add-email",
      type: "text",
      inputmode: "email",
      autocomplete: "off",
      placeholder: "name@example.com or @example.com",
      "data-key": "add-email",
      required: true,
    }), "");
    const roleSelect = h(
      "select",
      { class: "om-select", "aria-label": "Role", "data-key": "add-role" },
      h("option", { value: "view" }, "Can view"),
      h("option", { value: "edit" }, "Can edit"),
    );
    const form = h(
      "form",
      {
        class: "om-form",
        onsubmit: (e: Event) => {
          e.preventDefault();
          const email = emailInput.value.trim().toLowerCase();
          if (!email) return;
          const role = roleSelect.value as ShareRole;
          void act("add", "sharing", async () => {
            await tool("artifact_share", { add: [{ email, role }] });
            drafts.delete("add-email");
            return { text: email.startsWith("@") ? `Shared with everyone at ${email.slice(1)}.` : `Shared with ${email}. Use "Copy link" to send them a sign-in link.` };
          });
        },
      },
      h("label", { for: "om-add-email", class: "om-label" }, "Add a person or domain"),
      h("div", { class: "om-inline" }, emailInput, roleSelect, btn("Add", "add", () => form.requestSubmit())),
    );

    const publicToggle = h(
      "label",
      { class: "om-switch" },
      h("input", {
        type: "checkbox",
        role: "switch",
        checked: d.meta.public,
        "data-key": "public",
        disabled: busy.has("public"),
        onchange: (e: Event) => {
          const on = (e.target as HTMLInputElement).checked;
          void act("public", "sharing", async () => {
            await tool("artifact_share", { public: on });
            return { text: on ? "Anyone with the link can now view." : "Only people it's shared with can open it." };
          });
        },
      }),
      h(
        "span",
        {},
        h("span", { class: "om-strong" }, "Public link"),
        h("span", { class: "muted om-small" }, "Anyone with the link can view, read-only, without signing in."),
      ),
    );

    return [
      h("div", { class: "om-group" }, h("h3", { class: "om-h" }, "People"), list, form),
      h("div", { class: "om-group" }, publicToggle),
      h(
        "div",
        { class: "om-group" },
        h("h3", { class: "om-h" }, "Your link"),
        h("p", { class: "muted om-small" }, "A sign-in link for you, valid 7 days. Anyone holding it acts as you."),
        btn("Copy my link", "my-link", () => void act("my-link", "sharing", () => copyLink(boot.viewer.email ?? undefined, "you"), false), "button small secondary"),
      ),
    ];
  }

  async function copyLink(email?: string, who = email ?? "you"): Promise<Note> {
    const r = await tool("artifact_link", email ? { email } : {});
    const link = String(r.data?.link ?? "");
    if (!link) throw new Error(r.text || "No link returned.");
    if (await copyText(link)) return { text: `Copied a sign-in link for ${who}. It signs in as ${who}, so send it only to them.` };
    return { text: `Couldn't reach the clipboard. Link for ${who}:\n${link}`, pre: true };
  }

  // --- History --------------------------------------------------------------

  function renderHistory(d: Overview): Node[] {
    const versions = [...d.history].sort((a, b) => b.version - a.version);
    if (!versions.length) return [h("p", { class: "muted om-empty" }, "No versions stored.")];
    return [
      h(
        "ol",
        { class: "om-list" },
        ...versions.map((v) =>
          h(
            "li",
            { class: "om-row" },
            h(
              "div",
              { class: "om-grow" },
              h("div", { class: "om-strong" }, `v${v.version}`, v.version === d.meta.version ? h("span", { class: "om-badge" }, "Current") : null),
              v.note ? h("div", { class: "om-small" }, v.note) : null,
              h("div", { class: "muted om-small" }, time(v.createdAt)),
            ),
            v.version !== d.meta.version &&
              btn("Restore", `revert-${v.version}`, () => {
                if (!confirm(`Restore v${v.version}? Its files become a new version v${d.meta.version + 1}. Shared state is not changed.`)) return;
                void act(`revert-${v.version}`, "history", async () => {
                  await tool("artifact_revert", { version: v.version });
                  location.reload();
                  return { text: `Restored v${v.version}. Reloading…` };
                }, false);
              }, "button small secondary"),
          ),
        ),
      ),
    ];
  }

  // --- Problems -------------------------------------------------------------

  function renderProblems(d: Overview): Node[] {
    const errors = [...d.errors].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return [
      h(
        "div",
        { class: "om-group" },
        h("h3", { class: "om-h" }, "Render check"),
        h("p", { class: "muted om-small" }, "Opens the current version in a headless browser and reports what goes wrong."),
        btn("Run render check", "check", () =>
          void act("check", "problems", async () => {
            const r = await tool("artifact_check");
            return { text: r.text, pre: true };
          }), "button small secondary"),
      ),
      h(
        "div",
        { class: "om-group" },
        h("h3", { class: "om-h" }, "Errors from viewers"),
        errors.length
          ? h(
              "ul",
              { class: "om-list" },
              ...errors.map((e) =>
                h(
                  "li",
                  { class: "om-row om-col" },
                  h("div", { class: "om-error-msg" }, e.message),
                  h(
                    "div",
                    { class: "muted om-small" },
                    `v${e.version} · `,
                    time(e.at),
                    ` · ${e.viewer ?? "anonymous viewer"}`,
                  ),
                  e.stack ? h("details", { class: "om-small" }, h("summary", {}, "Stack"), h("pre", { class: "om-pre" }, e.stack)) : null,
                ),
              ),
            )
          : h("p", { class: "muted om-empty" }, "No errors reported."),
      ),
    ];
  }

  // --- Data sources ---------------------------------------------------------

  function renderData(d: Overview): Node[] {
    const out: Node[] = [];
    if (d.sources.length) {
      out.push(
        h(
          "div",
          { class: "om-group" },
          h("h3", { class: "om-h" }, "Live data sources"),
          h(
            "ul",
            { class: "om-list" },
            ...d.sources.map((s) => {
              const status = !s.approved
                ? h("span", { class: "om-status warn" }, `Waiting for approval of ${s.host}`)
                : !s.lastStatus
                  ? h("span", { class: "om-status" }, "Not fetched yet")
                  : s.lastStatus === "error"
                    ? h("span", { class: "om-status error" }, `Failed${s.lastError ? `: ${s.lastError}` : ""} · `, time(s.lastFetch))
                    : h("span", { class: "om-status ok" }, `Updated `, time(s.lastFetch));
              return h(
                "li",
                { class: "om-row om-col" },
                h("div", { class: "om-strong" }, s.path),
                h("div", { class: "muted om-small om-ellipsis", title: s.url }, `${s.url} · ${cadence(s.everyMinutes)}${s.pick ? ` · pick ${s.pick}` : ""}`),
                h("div", { class: "om-small" }, status),
                !s.approved &&
                  h(
                    "p",
                    { class: "muted om-small" },
                    `Approving lets Shared Artifacts fetch from ${s.host} on a schedule for any artifact that uses it. Approve only hosts you trust.`,
                  ),
                h(
                  "div",
                  { class: "om-actions" },
                  !s.approved &&
                    btn(`Approve ${s.host}`, `approve-${s.path}`, () =>
                      void act(`approve-${s.path}`, "data", async () => {
                        await request("/api/hosts", { host: s.host, allowed: true });
                        return { text: `Approved ${s.host}.` };
                      })),
                  s.approved &&
                    btn("Refresh now", `refresh-${s.path}`, () =>
                      void act(`refresh-${s.path}`, "data", async () => {
                        const r = await tool("artifact_source", { path: s.path, refresh: true });
                        return { text: r.text };
                      }), "button small secondary"),
                  btn("Remove", `rmsrc-${s.path}`, () => {
                    if (!confirm(`Stop updating ${s.path}? The file keeps its last data.`)) return;
                    void act(`rmsrc-${s.path}`, "data", async () => {
                      const r = await tool("artifact_source", { path: s.path, remove: true });
                      return { text: r.text };
                    });
                  }, "om-text-button danger"),
                ),
              );
            }),
          ),
        ),
      );
    }
    out.push(
      h(
        "div",
        { class: "om-group" },
        h("h3", { class: "om-h" }, "Approved hosts"),
        h("p", { class: "muted om-small" }, "Hosts Shared Artifacts may fetch live data from. This list applies to all your artifacts."),
        d.hosts.length
          ? h(
              "ul",
              { class: "om-list" },
              ...[...d.hosts].sort().map((host) =>
                h(
                  "li",
                  { class: "om-row" },
                  h("span", { class: "om-grow om-ellipsis" }, host),
                  btn("Revoke", `revoke-${host}`, () => {
                    if (!confirm(`Revoke ${host}? Sources on it stop updating in every artifact.`)) return;
                    void act(`revoke-${host}`, "data", async () => {
                      await request("/api/hosts", { host, allowed: false });
                      return { text: `Revoked ${host}.` };
                    });
                  }, "om-text-button danger", { "aria-label": `Revoke ${host}` }),
                ),
              ),
            )
          : h("p", { class: "muted om-empty" }, "None yet."),
      ),
    );
    return out;
  }

  // --- Settings -------------------------------------------------------------

  function renderSettings(d: Overview): Node[] {
    const titleInput = draft(h("input", { class: "input", id: "om-title-input", "data-key": "set-title", required: true }), d.meta.title);
    const descInput = draft(h("textarea", { class: "input om-textarea", id: "om-desc-input", rows: 3, "data-key": "set-desc" }), d.meta.description ?? "");
    const form = h(
      "form",
      {
        class: "om-form",
        onsubmit: (e: Event) => {
          e.preventDefault();
          const title = titleInput.value.trim();
          if (!title) return;
          void act("save", "settings", async () => {
            await tool("artifact_update", { title, description: descInput.value.trim() });
            drafts.delete("set-title");
            drafts.delete("set-desc");
            const barTitle = document.querySelector<HTMLElement>(".bar .title");
            if (barTitle) {
              barTitle.textContent = title;
              barTitle.title = title;
            }
            document.title = document.title.replace(d.meta.title, title);
            return { text: "Saved." };
          });
        },
      },
      h("label", { for: "om-title-input", class: "om-label" }, "Title"),
      titleInput,
      h("label", { for: "om-desc-input", class: "om-label" }, "Description"),
      descInput,
      h("div", {}, btn("Save", "save", () => form.requestSubmit())),
    );

    const confirmInput = draft(h("input", {
      class: "input",
      id: "om-delete-confirm",
      autocomplete: "off",
      "data-key": "delete-confirm",
    }), "");
    const deleteButton = btn("Delete artifact", "delete", () => {
      if (confirmInput.value.trim() !== d.meta.title.trim()) return;
      void act("delete", "settings", async () => {
        await tool("artifact_delete");
        location.href = "/";
        return { text: "Deleted. Leaving…" };
      }, false);
    }, "button small om-danger-button");
    const syncDelete = () => {
      deleteButton.disabled = busy.has("delete") || confirmInput.value.trim() !== d.meta.title.trim();
    };
    syncDelete();
    confirmInput.addEventListener("input", syncDelete);

    return [
      h("div", { class: "om-group" }, form),
      h(
        "div",
        { class: "om-group om-danger-zone" },
        h("h3", { class: "om-h" }, "Delete"),
        h("p", { class: "muted om-small" }, "Permanently deletes this artifact, its history and its shared state. Everyone loses access."),
        h("label", { for: "om-delete-confirm", class: "om-label" }, "Type ", h("strong", {}, d.meta.title), " to confirm"),
        confirmInput,
        h("div", {}, deleteButton),
      ),
    ];
  }
}

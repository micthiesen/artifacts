// The signed-in viewer's inbox bell (with its unread count) and avatar in the
// top bar. The avatar opens a small menu: Manage artifact… (owners, on an
// artifact), Copy my link, Print, notification level for this artifact, then
// links: in a workspace its notification settings, settings (members) and list;
// everywhere your account and workspaces on the apex; Sign out.
// The slot's data attributes pick the links: data-apex, data-context
// ("account" | "workspace"), data-member, data-operator
// (apex) and data-scoped (a presigned-link session that opens one artifact only,
// so it gets a way to sign in properly instead of links it can't open).
import type { WatchLevel } from "../shared/protocol.ts";
import "./report-errors.ts";

const LEVELS: [WatchLevel, string][] = [
  ["all", "All activity"],
  ["participating", "Replies and mentions"],
  ["mute", "Nothing"],
];

export type AccountMenuOptions = {
  /** Print the artifact (or save it as PDF). */
  print?: () => void;
  /** This artifact's notification level and a setter. */
  watch?: { level: WatchLevel; set: (level: WatchLevel) => Promise<WatchLevel> };
  /** Opens the Manage panel (owner on an artifact page). */
  manage?: () => void;
  /** Returns a link to copy; owners get a presigned sign-in link, others the page URL. */
  copyLink?: () => Promise<string>;
  copyLabel?: string;
  /** Owner on an artifact page: archive or unarchive it. */
  archive?: { archived: () => boolean; toggle: () => Promise<void> };
  /** On an artifact page: pin it to the top of your own list, or unpin it. */
  pin?: { pinned: () => boolean; toggle: () => Promise<void> };
  /** On an artifact page: its id, so opening it reads what the inbox said about it. */
  seen?: string;
};

const BELL = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`;

/** The inbox link with its unread count, refreshed whenever the page comes back into view. */
function mountInboxBell(slot: HTMLElement, href: string, seen?: string) {
  const bell = document.createElement("a");
  bell.className = "bar-button inbox-bell";
  bell.href = href;
  bell.innerHTML = `${BELL}<span class="count"></span>`;
  const paint = (unread: number) => {
    bell.querySelector(".count")!.textContent = unread ? (unread > 99 ? "99+" : String(unread)) : "";
    bell.classList.toggle("has-unread", unread > 0);
    const label = unread ? `Inbox, ${unread} unread` : "Inbox";
    bell.setAttribute("aria-label", label);
    bell.title = label;
  };
  paint(0);
  // Coming back to the tab refreshes it, at most every half minute. While an artifact is open, what
  // arrives about it counts as read.
  let last = 0;
  const refresh = async () => {
    if (Date.now() - last < 30_000) return;
    last = Date.now();
    try {
      const res = await fetch("/api/me/inbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(seen ? { seen } : {}) });
      if (!res.ok) return;
      paint(((await res.json()) as { unread: number }).unread);
    } catch {
      // Offline: the count stays as it was.
    }
  };
  void refresh();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });
  slot.append(bell);
}

export function mountAccountMenu(slot: HTMLElement, email: string, options: AccountMenuOptions = {}): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "avatar avatar-button";
  button.textContent = email.slice(0, 1).toUpperCase();
  button.title = email;
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", `Account menu for ${email}`);

  const menu = document.createElement("div");
  menu.className = "account-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;

  const who = document.createElement("div");
  who.className = "account-email";
  who.textContent = email;
  menu.append(who);

  const item = (label: string, onSelect: () => void | Promise<void>) => {
    const el = document.createElement("button");
    el.type = "button";
    el.setAttribute("role", "menuitem");
    el.textContent = label;
    el.addEventListener("click", () => void onSelect());
    menu.append(el);
    return el;
  };

  if (options.manage) {
    const manage = options.manage;
    item("Manage artifact…", () => {
      setOpen(false);
      button.focus();
      manage();
    }).classList.add("account-primary");
  }
  if (options.copyLink) {
    const copyLink = options.copyLink;
    const label = options.copyLabel ?? "Copy link";
    const el = item(label, async () => {
      try {
        const link = await copyLink();
        await navigator.clipboard.writeText(link);
        el.textContent = "Copied ✓";
      } catch {
        el.textContent = "Couldn't copy";
      }
      setTimeout(() => (el.textContent = label), 1600);
    });
  }
  if (options.print) {
    const print = options.print;
    item("Print or save as PDF", () => {
      setOpen(false);
      print();
    });
  }
  if (options.pin) {
    const pin = options.pin;
    let paintPin = () => {};
    const el = item("", async () => {
      try {
        await pin.toggle();
        paintPin();
        setOpen(false);
        button.focus();
      } catch {
        el.textContent = "Couldn't update";
        setTimeout(paintPin, 1600);
      }
    });
    paintPin = () => (el.textContent = pin.pinned() ? "Unpin from your list" : "Pin to top of your list");
    paintPin();
  }
  let paintArchive = () => {};
  if (options.archive) {
    const archive = options.archive;
    const el = item("", async () => {
      try {
        await archive.toggle();
        setOpen(false);
        button.focus();
      } catch {
        el.textContent = "Couldn't update";
        setTimeout(paintArchive, 1600);
      }
    });
    paintArchive = () => (el.textContent = archive.archived() ? "Unarchive" : "Archive");
    paintArchive();
  }
  if (options.watch) {
    const watch = options.watch;
    const group = document.createElement("div");
    group.className = "account-group";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Notify me about this artifact");
    const label = document.createElement("div");
    label.className = "account-label";
    label.textContent = "Notify me about";
    group.append(label);
    const radios = LEVELS.map(([level, text]) => {
      const el = document.createElement("button");
      el.type = "button";
      el.setAttribute("role", "menuitemradio");
      el.dataset.level = level;
      el.textContent = text;
      el.addEventListener("click", async () => {
        try {
          paint(await watch.set(level));
        } catch {
          el.textContent = "Couldn't save";
          setTimeout(() => (el.textContent = text), 1600);
        }
      });
      group.append(el);
      return el;
    });
    const paint = (current: WatchLevel) => {
      for (const r of radios) r.setAttribute("aria-checked", String(r.dataset.level === current));
    };
    paint(watch.level);
    menu.append(group);
  }
  const link = (href: string, label: string) => {
    const here = new URL(href, location.href);
    if (here.origin === location.origin && here.pathname === location.pathname) return;
    const a = document.createElement("a");
    a.href = href;
    a.textContent = label;
    a.setAttribute("role", "menuitem");
    menu.append(a);
  };
  const apex = slot.dataset.apex || location.origin;
  const { context, member, scoped, operator } = slot.dataset;
  if (context === "workspace" && scoped) {
    link(`/login?return=${encodeURIComponent(location.pathname + location.search)}`, "Sign in for full access");
  } else if (context === "workspace") {
    link("/me", "Notification settings");
    if (member) link("/settings", "Workspace settings");
    link("/", "All artifacts");
    link(`${apex}/me`, "Account");
    link(`${apex}/workspaces`, "Your workspaces");
    link(`${apex}/support?from=${encodeURIComponent(location.href.split("#")[0])}`, "Help & feedback");
  } else {
    link("/me", "Account");
    link("/workspaces", "Your workspaces");
    link(`/support?from=${encodeURIComponent(location.href.split("#")[0])}`, "Help & feedback");
    if (operator) link("/admin", "Operator console");
  }
  const form = document.createElement("form");
  form.method = "post";
  form.action = "/logout";
  const out = document.createElement("button");
  out.type = "submit";
  out.textContent = "Sign out";
  out.setAttribute("role", "menuitem");
  out.className = "account-quiet";
  form.append(out);
  menu.append(form);

  function setOpen(open: boolean) {
    if (open) paintArchive();
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) menu.querySelector<HTMLElement>("[role=menuitem], [role=menuitemradio]")?.focus();
  }
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(menu.hidden === true);
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) setOpen(false);
  });
  // Clicks inside the artifact iframe never reach this document; they show up
  // here as the window losing focus to the frame.
  window.addEventListener("blur", () => {
    setTimeout(() => {
      if (!menu.hidden && document.activeElement instanceof HTMLIFrameElement) setOpen(false);
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      setOpen(false);
      button.focus();
    }
  });
  // Menu keys: arrows move between items (wrapping), Home and End jump to the ends.
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll<HTMLElement>("[role=menuitem], [role=menuitemradio]")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "ArrowDown" ? (at + 1) % items.length
      : e.key === "ArrowUp" ? (at - 1 + items.length) % items.length
      : e.key === "Home" ? 0
      : e.key === "End" ? items.length - 1
      : null;
    if (next === null || !items.length) return;
    e.preventDefault();
    items[next].focus();
  });
  // Tabbing out of the menu closes it, so it never stays open behind the focus.
  menu.addEventListener("focusout", (e) => {
    const to = e.relatedTarget as Node | null;
    if (to && !menu.contains(to) && to !== button) setOpen(false);
  });
  if (!scoped) mountInboxBell(slot, `${apex}/inbox`, options.seen);
  slot.append(button, menu);
  return button;
}

// Standalone pages (the index) load this module directly.
const slot = document.getElementById("me");
if (slot && slot.dataset.email && !document.getElementById("shell-boot")) mountAccountMenu(slot, slot.dataset.email);

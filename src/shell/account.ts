// The signed-in viewer's inbox bell (with its unread count; it opens the latest
// items in a panel) and avatar in the top bar. The avatar opens a small menu in three parts: this artifact (Manage
// artifact… for owners, Copy link, Copy as Markdown, Print, Pin), then how it reaches you (its
// notification level as one segmented row, Sounds), then links: in a workspace
// its notification settings (which link on to your account), settings (members)
// and list, and your workspaces; on the apex your account and workspaces; Sign out.
// Archiving lives in the Manage panel and the archived bar, not here.
// The slot's data attributes pick the links: data-apex, data-context
// ("account" | "workspace"), data-member, data-operator
// (apex) and data-scoped (a presigned-link session that opens one artifact only,
// so it gets a way to sign in properly instead of links it can't open).
import type { WatchLevel } from "../shared/protocol.ts";
import "./report-errors.ts";
import { cue, move } from "../shared/motion.ts";
import { relativeTime } from "../shared/time.ts";
import { readSoundsCookie, setSoundsEnabled, soundsCookie, soundsScopeOf, unlockAudio } from "../shared/sound.ts";

// Short labels for the segmented row; the title says it in full.
const LEVELS: [WatchLevel, string, string][] = [
  ["all", "All", "All activity"],
  ["participating", "Replies", "Replies and mentions"],
  ["mute", "Off", "Nothing"],
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
  /** Copies this artifact as one Markdown document, for agents without MCP (fetches the URL it returns). */
  markdownUrl?: string;
  /** On an artifact page: pin it to the top of your own list, or unpin it. */
  pin?: { pinned: () => boolean; toggle: () => Promise<void> };
  /** On an artifact page: its id, so opening it reads what the inbox said about it. */
  seen?: string;
  /** Sounds were turned on or off here (the artifact page tells its frame). */
  onSounds?: (on: boolean) => void;
};

const BELL = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`;

type InboxEntry = { id: number; at: string; title: string; body: string | null; read: boolean; href: string | null };

/** Only one of the bar's popovers is open at a time: opening one tells the others on the slot to close. */
const OPEN_EVENT = "art-popover-open";

/**
 * The inbox bell with its unread count, refreshed whenever the page comes back into view. Clicking it opens
 * the latest few items in a panel under it, so you can look without leaving the page; each opens where it
 * points (reading it), and Open inbox goes to the full page. Middle-click and the inbox page itself just follow the link.
 */
function mountInboxBell(slot: HTMLElement, apex: string, seen?: string) {
  const href = `${apex}/inbox`;
  const bell = document.createElement("a");
  bell.className = "bar-button inbox-bell";
  bell.href = href;
  bell.innerHTML = `${BELL}<span class="count"></span>`;
  bell.setAttribute("aria-haspopup", "dialog");
  bell.setAttribute("aria-expanded", "false");
  const draw = (unread: number) => {
    bell.querySelector(".count")!.textContent = unread ? (unread > 99 ? "99+" : String(unread)) : "";
    bell.classList.toggle("has-unread", unread > 0);
    const label = unread ? `Inbox, ${unread} unread` : "Inbox";
    bell.setAttribute("aria-label", label);
    bell.title = label;
  };
  draw(0);
  // Null until the first count arrives. More unread than last time pops the count as it changes (motion only:
  // the inbox is about other pages).
  let shown: number | null = null;
  const paint = (unread: number) => {
    draw(unread);
    if (shown !== null && unread > shown) move(bell.querySelector(".count"), "pop");
    shown = unread;
  };
  const ask = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/me/inbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(String(res.status));
    const json = (await res.json()) as { unread: number; items?: InboxEntry[] };
    paint(json.unread);
    return json;
  };
  // Coming back to the tab refreshes it, at most every half minute. While an artifact is open, what
  // arrives about it counts as read.
  let last = 0;
  const refresh = async () => {
    if (Date.now() - last < 30_000) return;
    last = Date.now();
    try {
      await ask(seen ? { seen } : {});
    } catch {
      // Offline: the count stays as it was.
    }
  };
  void refresh();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });

  const panel = document.createElement("div");
  panel.className = "bar-popover inbox-pop";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Inbox");
  panel.hidden = true;
  const head = document.createElement("div");
  head.className = "inbox-pop-head";
  const heading = document.createElement("strong");
  heading.textContent = "Inbox";
  const readAll = document.createElement("button");
  readAll.type = "button";
  readAll.className = "inbox-pop-read";
  readAll.textContent = "Mark all read";
  head.append(heading, readAll);
  const list = document.createElement("div");
  list.className = "inbox-pop-list";
  list.setAttribute("aria-live", "polite");
  const all = document.createElement("a");
  all.className = "inbox-pop-all";
  all.href = href;
  all.textContent = "Open inbox";
  panel.append(head, list, all);

  const render = (items: InboxEntry[]) => {
    readAll.hidden = !shown;
    if (!items.length) {
      list.replaceChildren(Object.assign(document.createElement("p"), { className: "inbox-pop-empty", textContent: "Nothing yet. Replies, mentions and approvals for you land here." }));
      return;
    }
    list.replaceChildren(
      ...items.map((i) => {
        const a = document.createElement("a");
        a.className = `inbox-pop-item${i.read ? "" : " unread"}`;
        // Approvals have no link of their own: they're done on the inbox page.
        a.href = i.href ? `${apex}${i.href}` : href;
        const title = document.createElement("span");
        title.className = "inbox-pop-title";
        title.textContent = i.title;
        a.append(title);
        if (i.body) a.append(Object.assign(document.createElement("span"), { className: "inbox-pop-body", textContent: i.body }));
        a.append(Object.assign(document.createElement("span"), { className: "inbox-pop-when", textContent: relativeTime(i.at) }));
        return a;
      }),
    );
  };
  let opened = 0;
  const setOpen = (open: boolean) => {
    panel.hidden = !open;
    bell.setAttribute("aria-expanded", String(open));
    if (!open) return;
    slot.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: panel }));
    list.replaceChildren(Object.assign(document.createElement("p"), { className: "inbox-pop-empty", textContent: "Loading…" }));
    readAll.hidden = true;
    // Only the latest opening's answer draws, so a quick close and reopen never shows an older list.
    const asked = ++opened;
    ask({ items: true, ...(seen ? { seen } : {}) }).then(
      (r) => {
        if (asked === opened && !panel.hidden) render(r.items ?? []);
      },
      () => {
        if (asked === opened && !panel.hidden) list.replaceChildren(Object.assign(document.createElement("p"), { className: "inbox-pop-empty", textContent: "Couldn't load your inbox. Open inbox shows it all." }));
      },
    );
    panel.focus();
  };
  panel.tabIndex = -1;
  slot.addEventListener(OPEN_EVENT, (e) => {
    if ((e as CustomEvent).detail !== panel && !panel.hidden) setOpen(false);
  });
  readAll.addEventListener("click", async () => {
    try {
      const r = await ask({ read: "all", items: true });
      render(r.items ?? []);
      bell.focus();
    } catch {
      readAll.textContent = "Couldn't mark read";
      setTimeout(() => (readAll.textContent = "Mark all read"), 1600);
    }
  });
  bell.addEventListener("click", (e) => {
    const onInboxPage = location.origin === new URL(href).origin && location.pathname === "/inbox";
    if (onInboxPage || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(panel.hidden === true);
  });
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target as Node) && e.target !== bell) setOpen(false);
  });
  // Clicks inside the artifact iframe show up as the window losing focus to the frame.
  window.addEventListener("blur", () => {
    setTimeout(() => {
      if (!panel.hidden && document.activeElement instanceof HTMLIFrameElement) setOpen(false);
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) {
      setOpen(false);
      bell.focus();
    }
  });
  panel.addEventListener("focusout", (e) => {
    const to = e.relatedTarget as Node | null;
    if (to && !panel.contains(to) && to !== bell) setOpen(false);
  });
  slot.append(bell, panel);
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
  menu.className = "bar-popover account-menu";
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
  if (options.markdownUrl) {
    const url = options.markdownUrl;
    const label = "Copy as Markdown for AI";
    const el = item(label, async () => {
      el.setAttribute("aria-busy", "true");
      const text = fetch(url).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      });
      try {
        // Safari only copies inside the click, so hand it the pending text; writeText where ClipboardItem can't wait.
        if (typeof ClipboardItem !== "undefined" && ClipboardItem.supports?.("text/plain") !== false) {
          await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
        } else {
          await navigator.clipboard.writeText(await text);
        }
        el.textContent = "Copied ✓";
      } catch {
        el.textContent = "Couldn't copy";
      }
      el.removeAttribute("aria-busy");
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
  // A hairline between the parts, only where there's something on both sides.
  const divide = () => {
    const last = menu.lastElementChild;
    if (last && last !== who && !last.classList.contains("account-divider")) {
      const hr = document.createElement("div");
      hr.className = "account-divider";
      hr.setAttribute("role", "separator");
      menu.append(hr);
    }
  };
  divide();
  if (options.watch) {
    const watch = options.watch;
    const group = document.createElement("div");
    group.className = "account-group";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Notify me about this artifact");
    const label = document.createElement("div");
    label.className = "account-label";
    label.textContent = "Notify me about this";
    const segments = document.createElement("div");
    segments.className = "account-segments";
    group.append(label, segments);
    const radios = LEVELS.map(([level, text, full]) => {
      const el = document.createElement("button");
      el.type = "button";
      el.setAttribute("role", "menuitemradio");
      el.title = full;
      el.dataset.level = level;
      el.textContent = text;
      el.addEventListener("click", async () => {
        try {
          paint(await watch.set(level));
        } catch {
          el.textContent = "Failed";
          setTimeout(() => (el.textContent = text), 1600);
        }
      });
      segments.append(el);
      return el;
    });
    const paint = (current: WatchLevel) => {
      for (const r of radios) r.setAttribute("aria-checked", String(r.dataset.level === current));
    };
    paint(watch.level);
    menu.append(group);
  }
  // Sounds: a per-device choice, remembered in a cookie every workspace on this browser can read.
  const scope = soundsScopeOf(slot);
  let soundsOn = readSoundsCookie(document.cookie, scope.name);
  setSoundsEnabled(soundsOn);
  const sounds = document.createElement("button");
  sounds.type = "button";
  sounds.setAttribute("role", "menuitemcheckbox");
  sounds.textContent = "Sounds";
  sounds.title = "Short, quiet sounds when your changes land and when other people's arrive (this device only)";
  const paintSounds = () => sounds.setAttribute("aria-checked", String(soundsOn));
  paintSounds();
  sounds.addEventListener("click", () => {
    soundsOn = !soundsOn;
    document.cookie = soundsCookie(soundsOn, scope, location.hostname, location.protocol === "https:");
    setSoundsEnabled(soundsOn);
    paintSounds();
    if (soundsOn) {
      // This click is the gesture that lets audio start, and the tick says what turning it on sounds like.
      unlockAudio();
      cue(sounds, "toggle");
    }
    options.onSounds?.(soundsOn);
  });
  menu.append(sounds);
  divide();
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
    // Your account is one step on from Notification settings, which links to it.
    link("/me", "Notification settings");
    if (member) link("/settings", "Workspace settings");
    link("/", "All artifacts");
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
  divide();
  menu.append(form);

  function setOpen(open: boolean) {
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) slot.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: menu }));
    if (open) menu.querySelector<HTMLElement>("[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]")?.focus();
  }
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(menu.hidden === true);
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) setOpen(false);
  });
  slot.addEventListener(OPEN_EVENT, (e) => {
    if ((e as CustomEvent).detail !== menu && !menu.hidden) setOpen(false);
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
    const items = [...menu.querySelectorAll<HTMLElement>("[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    // Left and right also step through the notification levels, which sit side by side.
    const sideways = (document.activeElement as HTMLElement | null)?.getAttribute("role") === "menuitemradio";
    const next =
      e.key === "ArrowDown" || (sideways && e.key === "ArrowRight") ? (at + 1) % items.length
      : e.key === "ArrowUp" || (sideways && e.key === "ArrowLeft") ? (at - 1 + items.length) % items.length
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
  if (!scoped) mountInboxBell(slot, apex, options.seen);
  slot.append(button, menu);
  return button;
}

// Standalone pages (the index) load this module directly.
const slot = document.getElementById("me");
if (slot && slot.dataset.email && !document.getElementById("shell-boot")) mountAccountMenu(slot, slot.dataset.email);

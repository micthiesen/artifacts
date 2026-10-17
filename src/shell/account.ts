// The signed-in viewer's avatar in the top bar opens a small menu: Manage
// artifact… (owners, on an artifact), Copy my link, Print, notification level
// for this artifact, Notifications settings, All artifacts, Sign out.
import type { WatchLevel } from "../shared/protocol.ts";

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
};

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
  const settings = document.createElement("a");
  settings.href = "/me";
  settings.textContent = "Notification settings";
  settings.setAttribute("role", "menuitem");
  if (location.pathname !== "/me") menu.append(settings);
  if (location.pathname !== "/") {
    const home = document.createElement("a");
    home.href = "/";
    home.textContent = "All artifacts";
    home.setAttribute("role", "menuitem");
    menu.append(home);
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
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      setOpen(false);
      button.focus();
    }
  });
  slot.append(button, menu);
  return button;
}

// Standalone pages (the index) load this module directly.
const slot = document.getElementById("me");
if (slot && slot.dataset.email && !document.getElementById("shell-boot")) mountAccountMenu(slot, slot.dataset.email);

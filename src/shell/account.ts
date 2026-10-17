// The signed-in viewer's avatar in the top bar opens a small menu: Manage
// artifact… (owners, on an artifact), Copy my link, All artifacts, Sign out.

export type AccountMenuOptions = {
  /** Opens the Manage panel (owner on an artifact page). */
  manage?: () => void;
  /** Returns a link to copy; owners get a presigned sign-in link, others the page URL. */
  copyLink?: () => Promise<string>;
  copyLabel?: string;
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
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) menu.querySelector<HTMLElement>("[role=menuitem]")?.focus();
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

// The signed-in viewer's avatar in the top bar. Owners on an artifact page get
// the Manage panel from it (wired in shell.ts); everywhere else it opens a small
// account menu with the email and Sign out.

export function avatarButton(email: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "avatar avatar-button";
  button.textContent = email.slice(0, 1).toUpperCase();
  button.title = email;
  return button;
}

export function mountAccountMenu(slot: HTMLElement, email: string): HTMLButtonElement {
  const button = avatarButton(email);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", `Account: ${email}`);

  const menu = document.createElement("div");
  menu.className = "account-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const who = document.createElement("div");
  who.className = "account-email";
  who.textContent = email;
  const home = document.createElement("a");
  home.href = "/";
  home.textContent = "All artifacts";
  home.setAttribute("role", "menuitem");
  const form = document.createElement("form");
  form.method = "post";
  form.action = "/logout";
  const out = document.createElement("button");
  out.type = "submit";
  out.textContent = "Sign out";
  out.setAttribute("role", "menuitem");
  form.append(out);
  menu.append(who, ...(location.pathname === "/" ? [] : [home]), form);

  const setOpen = (open: boolean) => {
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  };
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(menu.hidden === true);
  });
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target as Node)) setOpen(false);
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

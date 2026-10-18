// The artifact list page. Owners archive a row from the main list or
// unarchive it from /archived, with an Undo toast either way. Anyone pins a
// row to the top of their own list.
import { setArchived } from "./archive.ts";
import { setPinned } from "./pins.ts";

// On the list itself, the logo reloads the page (handy for checking changes).
for (const a of document.querySelectorAll<HTMLAnchorElement>(".bar a[href='/']")) {
  a.addEventListener("click", (e) => {
    if (location.pathname !== "/" || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    location.reload();
  });
}

const removals = new WeakMap<HTMLLIElement, ReturnType<typeof setTimeout>>();

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string, action?: { label: string; run: () => void }) {
  document.querySelector(".toast")?.remove();
  clearTimeout(toastTimer);
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  const text = document.createElement("span");
  text.textContent = message;
  el.append(text);
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.addEventListener("click", () => {
      el.remove();
      action.run();
    });
    el.append(b);
  }
  document.body.append(el);
  toastTimer = setTimeout(() => el.remove(), 6000);
}

function adjustCount(delta: number) {
  const el = document.querySelector<HTMLElement>("[data-archived-count]");
  if (!el) return;
  const n = Math.max(0, Number(el.textContent) + delta);
  el.textContent = String(n);
  el.closest<HTMLElement>(".archived-link")!.hidden = n === 0;
}

/** Show the list's empty note when its last row has gone, hide it otherwise. */
function syncEmpty(list: HTMLUListElement) {
  // Paged or searched: an emptied page isn't an empty list, so fetch the page again (the server moves to the last one if need be).
  if ((document.querySelector(".pager") || new URLSearchParams(location.search).get("q")) && !list.querySelector("li")) {
    location.reload();
    return;
  }
  const empty = document.querySelector<HTMLElement>("[data-list-empty]");
  if (empty) empty.hidden = list.querySelector("li") !== null;
}

function removeRow(li: HTMLLIElement) {
  const list = li.parentElement as HTMLUListElement;
  li.classList.add("leaving");
  const done = () => {
    removals.delete(li);
    li.remove();
    li.classList.remove("leaving");
    syncEmpty(list);
  };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) done();
  else removals.set(li, setTimeout(done, 180));
  return list;
}

/** Put a row back where it belongs: pinned first, then by last update. */
function restoreRow(li: HTMLLIElement, list: HTMLUListElement) {
  clearTimeout(removals.get(li));
  removals.delete(li);
  li.classList.remove("leaving");
  list.append(li);
  placeRow(li);
  for (const b of li.querySelectorAll<HTMLButtonElement>(".row-action")) b.disabled = false;
  syncEmpty(list);
}

function undo(li: HTMLLIElement, list: HTMLUListElement, id: string, archive: boolean) {
  setArchived(id, !archive).then(
    () => {
      restoreRow(li, list);
      if (archive) adjustCount(-1);
    },
    (err: Error) => toast(`Couldn't undo: ${err.message}`, { label: "Retry", run: () => undo(li, list, id, archive) }),
  );
}

/** Pinned rows first, newest pin on top; then the rest by last update, as the server orders them. */
function placeRow(li: HTMLLIElement) {
  const list = li.parentElement as HTMLUListElement;
  const key = (x: HTMLLIElement) => [x.dataset.pinned ? 1 : 0, x.dataset.pinned ?? x.dataset.updated ?? ""] as const;
  const [mine, at] = key(li);
  const before = [...list.querySelectorAll<HTMLLIElement>(":scope > li")].find((x) => {
    if (x === li) return false;
    const [p, t] = key(x);
    return p < mine || (p === mine && t < at);
  });
  list.insertBefore(li, before ?? null);
}

function paintPin(button: HTMLButtonElement, pinned: boolean, title: string) {
  button.dataset.action = pinned ? "unpin" : "pin";
  button.setAttribute("aria-pressed", String(pinned));
  button.title = pinned ? "Unpin" : "Pin to top";
  button.setAttribute("aria-label", `${pinned ? "Unpin" : "Pin"} ${title}`);
}

function togglePin(button: HTMLButtonElement, li: HTMLLIElement, id: string, title: string) {
  const pinned = button.dataset.action === "pin";
  button.disabled = true;
  setPinned(id, pinned).then(
    (r) => {
      button.disabled = false;
      if (r.pinnedAt) li.dataset.pinned = r.pinnedAt;
      else delete li.dataset.pinned;
      paintPin(button, pinned, title);
      placeRow(li);
      button.focus();
      // Pins sit at the top of page 1, which may not be this one.
      if (pinned && new URLSearchParams(location.search).has("page") && new URLSearchParams(location.search).get("page") !== "1") toast("Pinned: it's at the top of page 1.");
    },
    (err: Error) => {
      button.disabled = false;
      toast(err.message);
    },
  );
}

document.addEventListener("click", (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>(".row-action");
  if (!button || button.disabled) return;
  const li = button.closest<HTMLLIElement>("li[data-id]")!;
  const id = li.dataset.id!;
  const title = li.dataset.title ?? id;
  if (button.dataset.action === "pin" || button.dataset.action === "unpin") {
    togglePin(button, li, id, title);
    return;
  }
  const archive = button.dataset.action === "archive";
  button.disabled = true;
  setArchived(id, archive).then(
    () => {
      const list = removeRow(li);
      if (archive) adjustCount(1);
      toast(archive ? `Archived “${title}”` : `Restored “${title}” to the main list`, { label: "Undo", run: () => undo(li, list, id, archive) });
    },
    (err: Error) => {
      button.disabled = false;
      toast(err.message);
    },
  );
});

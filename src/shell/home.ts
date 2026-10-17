// Owner actions on the artifact list: archive a row from the main list or
// unarchive it from /archived, with an Undo toast either way.
import { setArchived } from "./archive.ts";

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

/** Put a row back where the server ordered it (rows carry their index). */
function restoreRow(li: HTMLLIElement, list: HTMLUListElement) {
  clearTimeout(removals.get(li));
  removals.delete(li);
  li.classList.remove("leaving");
  const order = Number(li.dataset.order);
  const after = [...list.querySelectorAll<HTMLLIElement>(":scope > li")].find((x) => x !== li && Number(x.dataset.order) > order);
  list.insertBefore(li, after ?? null);
  li.querySelector<HTMLButtonElement>(".row-action")!.disabled = false;
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

document.addEventListener("click", (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>(".row-action");
  if (!button || button.disabled) return;
  const li = button.closest<HTMLLIElement>("li[data-id]")!;
  const id = li.dataset.id!;
  const title = li.dataset.title ?? id;
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

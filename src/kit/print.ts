// Print preparation. Base UI does not mount inactive tab panels or closed
// accordion panels, and Table renders only `limit` rows until "Show all" is
// pressed, so CSS alone cannot print them. The runtime calls preparePrint()
// on `beforeprint` (and the restore function it returns on `afterprint`):
//
//   let restore: (() => void) | null = null;
//   async function print() { restore?.(); restore = await preparePrint(); window.print(); }
//   addEventListener("afterprint", () => { restore?.(); restore = null; });
//
// Async (tab/accordion updates need a tick to commit), so the runtime should
// `const restore = await preparePrint(); window.print();` and restore on
// `afterprint`. Idempotent: a second call first undoes the previous one.

/** Opens every closed accordion panel and expands every limited table. */
function expandDisclosures(undo: (() => void)[]) {
  for (const b of document.querySelectorAll<HTMLButtonElement>("h3 > button[aria-expanded='false']")) {
    b.click();
    undo.push(() => b.isConnected && b.getAttribute("aria-expanded") === "true" && b.click());
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("button")) {
    if (!/^Show all \d+ rows$/.test(b.textContent?.trim() ?? "")) continue;
    b.click();
    // The same button flips to "Show fewer".
    undo.push(() => b.isConnected && b.textContent?.trim() === "Show fewer" && b.click());
  }
}

/** Clones every tab panel after its Tabs root, labelled, and hides the live tabs. */
async function expandTabs(undo: (() => void)[]) {
  for (const list of Array.from(document.querySelectorAll<HTMLElement>("[role='tablist']"))) {
    const root = list.parentElement;
    if (!root || root.closest("[data-print-tabs]")) continue;
    const tabs = Array.from(list.querySelectorAll<HTMLElement>("[role='tab']"));
    if (tabs.length === 0) continue;
    const active = tabs.find((t) => t.getAttribute("aria-selected") === "true") ?? tabs[0]!;
    const holder = document.createElement("div");
    holder.setAttribute("data-print-tabs", "");
    for (const tab of tabs) {
      if (tab !== active) tab.click();
      await settle();
      const panel = root.querySelector<HTMLElement>("[role='tabpanel']:not([hidden])");
      if (!panel) continue;
      const section = document.createElement("section");
      const label = document.createElement("h4");
      label.setAttribute("data-print-tab-label", "");
      label.textContent = tab.textContent;
      const copy = panel.cloneNode(true) as HTMLElement;
      copy.removeAttribute("hidden");
      for (const el of [copy, ...copy.querySelectorAll<HTMLElement>("[id]")]) el.removeAttribute("id");
      section.append(label, copy);
      holder.append(section);
    }
    await settle();
    if (active.getAttribute("aria-selected") !== "true") active.click();
    root.after(holder);
    const prev = root.getAttribute("data-print");
    root.setAttribute("data-print", "hide");
    undo.push(() => {
      holder.remove();
      if (prev === null) root.removeAttribute("data-print");
      else root.setAttribute("data-print", prev);
    });
  }
}

/** Marks links whose visible text already is the URL so CSS skips the "(url)" suffix. */
function markBareLinks(undo: (() => void)[]) {
  for (const a of document.querySelectorAll<HTMLAnchorElement>("a[href^='http']")) {
    const text = (a.textContent ?? "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
    const href = (a.getAttribute("href") ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (text !== href) continue;
    a.setAttribute("data-print-url", "same");
    undo.push(() => a.removeAttribute("data-print-url"));
  }
}

/** Lets React and Base UI commit a click-driven update. */
const settle = () => new Promise<void>((r) => setTimeout(r, 40));

let current: (() => void) | null = null;

/** Expands what CSS cannot reveal. Returns a function that restores the live UI. */
export async function preparePrint(): Promise<() => void> {
  current?.();
  const undo: (() => void)[] = [];
  // Tabs first: expanding accordions inside inactive panels is out of scope, but
  // disclosures in the active panel (and elsewhere) are opened before cloning.
  expandDisclosures(undo);
  await settle();
  await expandTabs(undo);
  markBareLinks(undo);
  const restore = () => {
    if (current === restore) current = null;
    for (const fn of undo.splice(0).reverse()) fn();
  };
  current = restore;
  return restore;
}

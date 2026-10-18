// Loaded only by the operator's layout check (src/worker/layout.ts), never by
// a page: once the page settles, records its width, how wide it scrolls, and
// the elements sticking out past the screen outside any scroll box.

function contained(el: Element): boolean {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const o = getComputedStyle(p).overflowX;
    if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return true;
  }
  return false;
}

setTimeout(() => {
  const width = innerWidth;
  const offenders: { el: string; right: number; text: string }[] = [];
  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (!r.width || r.right <= width + 1 || contained(el)) continue;
    const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
    offenders.push({ el: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls}`, right: Math.round(r.right), text: (el.textContent ?? "").trim().slice(0, 60) });
  }
  const pre = document.createElement("pre");
  pre.id = "layout-check";
  pre.hidden = true;
  pre.textContent = JSON.stringify({ width, scrollWidth: document.documentElement.scrollWidth, offenders: offenders.slice(0, 12) });
  document.body.append(pre);
}, 1500);

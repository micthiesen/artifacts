import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeEach, expect, test } from "bun:test";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());
const { anchorFromRange, installAnnotations, locate } = await import("./annotate.ts");

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = `<div id="root"><div class="art-page">
    <h2 data-b="costs">Costs</h2>
    <p data-b="costs-1">We pay $10 a month, and $10 more for support.</p>
    <table data-b="costs-2"><tbody><tr data-row="Forgejo"><td>Forgejo</td><td>$0</td></tr></tbody></table>
  </div></div>`;
  root = document.getElementById("root")!;
  installAnnotations(root, () => {});
});

function select(el: Element, text: string, nth = 0) {
  const node = el.firstChild as Text;
  let at = -1;
  for (let i = 0; i <= nth; i++) at = node.data.indexOf(text, at + 1);
  const r = document.createRange();
  r.setStart(node, at);
  r.setEnd(node, at + text.length);
  return r;
}

test("anchor from a selection carries block, quote and context", () => {
  const p = root.querySelector('[data-b="costs-1"]')!;
  const a = anchorFromRange(select(p, "$10", 1));
  expect(a).toMatchObject({ block: "costs-1", quote: { exact: "$10", prefix: "We pay $10 a month, and ", suffix: " more for support." } });
});

test("locate prefers the occurrence whose context matches", () => {
  const p = root.querySelector('[data-b="costs-1"]')!;
  const a = anchorFromRange(select(p, "$10", 1));
  const found = locate(a);
  expect(found.status).toBe("anchored");
  const before = document.createRange();
  before.setStart(p.firstChild!, 0);
  before.setEnd(found.range!.startContainer, found.range!.startOffset);
  expect(before.toString()).toBe("We pay $10 a month, and ");
});

test("changed text is outdated, a removed block is orphaned, rows anchor by key", () => {
  const p = root.querySelector('[data-b="costs-1"]')!;
  const a = anchorFromRange(select(p, "a month"));
  p.textContent = "We pay $12 per year.";
  expect(locate(a).status).toBe("outdated");
  p.remove();
  expect(locate(a).status).toBe("orphaned");
  const row = locate({ block: "costs-2", row: "Forgejo" });
  expect(row.status).toBe("anchored");
  expect(row.el?.getAttribute("data-row")).toBe("Forgejo");
});

test("whitespace differences still match", () => {
  const p = root.querySelector('[data-b="costs-1"]')!;
  p.textContent = "We pay $10   a\nmonth, and more.";
  expect(locate({ block: "costs-1", quote: { exact: "$10 a month", prefix: "", suffix: "" } }).status).toBe("anchored");
});

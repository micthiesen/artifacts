import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());
const { collectSpeech } = await import("./speak.ts");

test("reads blocks in order, summarises tables and figures, skips code and controls", () => {
  document.body.innerHTML = `<div id="root"><div class="art-page">
    <h1>Picking a CI provider</h1>
    <nav class="art-contents"><a href="#a">Options</a></nav>
    <div><p>Use <strong>Buildkite</strong>: fastest on our <a href="#">monorepo</a>.</p></div>
    <div data-speak="stat"><div>Median build</div><div><span>6m 10s</span><span>-38%</span></div></div>
    <ul><li>First thing</li><li><p>Second thing</p><ul><li>Nested</li></ul></li></ul>
    <div role="note" data-tone="warning"><svg></svg><div><div>Heads up</div><p>Runners cost more.</p></div></div>
    <table><thead><tr><th>Name</th><th>Price</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr><tr><td>B</td><td>2</td></tr></tbody></table>
    <pre><code>bun run build</code></pre>
    <figure data-speak="chart"><figcaption>Build times</figcaption><svg></svg></figure>
    <section data-speak="skip"><p>A comment</p></section>
    <div>Loose text in an app <button>Click me</button></div>
  </div></div>`;
  const texts = collectSpeech(document.getElementById("root")!).units.map((u) => u.text);
  expect(texts).toEqual([
    "Picking a CI provider.",
    "Use Buildkite: fastest on our monorepo.",
    "Median build, 6m 10s, -38%.",
    "First thing.",
    "Second thing.",
    "Nested.",
    "Warning. Heads up. Runners cost more.",
    "A table of 2 rows: Name, Price.",
    "A code block.",
    "Build times. A chart.",
    "Loose text in an app.",
  ]);
  expect(document.querySelector("h1")!.getAttribute("data-speak-i")).toBe("0");
});

test("each spoken character maps back to the page, so a word can be marked", async () => {
  const { wordRange } = await import("./speak.ts");
  document.body.innerHTML = `<div id="root"><p>Costs   <strong>$420</strong> a month</p><div data-speak="stat"><div>Fixed cost</div><div><span>$0</span></div></div></div>`;
  const { units } = collectSpeech(document.getElementById("root")!);
  expect(units.map((u) => u.text)).toEqual(["Costs $420 a month.", "Fixed cost, $0."]);
  const at = (i: number, word: string) => {
    const start = units[i]!.text.indexOf(word);
    return wordRange(i, start, start + word.length)?.toString();
  };
  expect(at(0, "$420")).toBe("$420");
  expect(at(0, "month")).toBe("month");
  expect(at(1, "$0")).toBe("$0");
  // The full stop Listen added maps to nothing on the page.
  expect(wordRange(0, units[0]!.text.length - 1, units[0]!.text.length)).toBeNull();
});

test("Follow: scrolling by hand turns it off (once), Listen's own scrolls and layout shifts don't, and tapping a paragraph turns it back on", async () => {
  const { speakMode, collectSpeech: collect } = await import("./speak.ts");
  document.body.innerHTML = `<div id="root"><p>First paragraph.</p><p>Second paragraph.</p><button>Press</button></div>`;
  collect(document.getElementById("root")!);
  const sent: unknown[] = [];
  speakMode(true, (m) => sent.push(m));
  const scroll = () => window.dispatchEvent(new Event("scroll"));
  // A scroll nobody asked for (a late image, a layout shift): Follow stays on.
  scroll();
  expect(sent).toEqual([]);
  // Space on a button works the button; it isn't scrolling.
  document.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  scroll();
  expect(sent).toEqual([]);
  // A wheel, then the scroll it causes: off, told once.
  window.dispatchEvent(new Event("wheel"));
  scroll();
  window.dispatchEvent(new Event("wheel"));
  scroll();
  expect(sent).toEqual([{ t: "speak:follow", on: false }]);
  // Tapping a paragraph to read from asks to follow it again, then jumps there.
  (document.querySelectorAll("p")[1] as HTMLElement).click();
  expect(sent.slice(1)).toEqual([{ t: "speak:follow", on: true }, { t: "speak:jump", i: 1 }]);
  speakMode(false, () => {});
  expect(document.querySelector("[data-speak-i]")).toBeNull();
});

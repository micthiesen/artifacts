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
  const texts = collectSpeech(document.getElementById("root")!).map((u) => u.text);
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

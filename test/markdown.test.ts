import { expect, test } from "bun:test";
import { artifactMarkdown } from "../src/worker/markdown.ts";

const meta = { title: "App", description: "", version: 3, updatedAt: "2026-10-20T10:00:00.000Z" };
const URL_ = "https://acme.x.test/a/abc";

test("an app's source is fenced, with a fence longer than any backticks inside", () => {
  const text = artifactMarkdown(meta, { "app.tsx": "const s = ````;\n" }, URL_);
  expect(text).toContain("### File: app.tsx\n\n`````tsx\nconst s = ````;\n`````");
  expect(text).toContain("> Version 3, updated 2026-10-20.");
  expect(text.trimEnd()).toEndWith(`End of the export of ${URL_}.`);
});

test("a page keeps a first heading that isn't its title, and drops one that is", () => {
  expect(artifactMarkdown({ ...meta, title: "Q3" }, { "index.md": "# Revenue deep-dive\n\nBody\n" }, URL_)).toContain("# Revenue deep-dive\n\nBody");
  const same = artifactMarkdown({ ...meta, title: "Q3" }, { "index.md": "\n# Q3\nBody" }, URL_);
  expect(same.match(/^# Q3$/gm)?.length).toBe(1);
  expect(same).toContain("---\n\nBody");
});

test("every description line stays quoted, links to artifacts become absolute, assets are listed", () => {
  const text = artifactMarkdown(
    { ...meta, description: "One\n# Not a heading" },
    { "index.mdx": "See [the plan](/a/xyz#costs) and [docs](https://e.test).\n" },
    URL_,
    [{ path: "assets/logo.png", contentType: "image/png", bytes: 2048 }],
  );
  expect(text).toContain("> One\n>\n> # Not a heading");
  expect(text).toContain("[the plan](https://acme.x.test/a/xyz#costs)");
  expect(text).toContain("[docs](https://e.test)");
  expect(text).toContain("- `assets/logo.png` (image/png, 2.0 KB): not included");
});

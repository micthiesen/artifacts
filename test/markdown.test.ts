import { expect, test } from "bun:test";
import { artifactMarkdown } from "../src/worker/markdown.ts";

const meta = { title: "App", description: "", version: 3, updatedAt: "2026-10-20T10:00:00.000Z" };

test("an app's source is fenced, with a fence longer than any backticks inside", () => {
  const text = artifactMarkdown(meta, { "app.tsx": "const s = ````;\n" }, "https://x.test/a/1");
  expect(text).toContain("## app.tsx\n\n`````tsx\nconst s = ````;\n`````");
  expect(text).toContain("> Version 3, updated 2026-10-20.");
  expect(text).not.toContain("> \n");
});

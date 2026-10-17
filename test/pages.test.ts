import { expect, test } from "bun:test";
import { indexPage } from "../src/worker/pages.ts";

const base = { description: "", version: 1, public: false, preview: false, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", role: "owner" as const };
const rows = [
  { ...base, id: "aaa", title: "Active one", archivedAt: null },
  { ...base, id: "bbb", title: "Old report", archivedAt: "2026-10-10T00:00:00Z" },
  { ...base, id: "ccc", title: "Older report", archivedAt: "2026-10-05T00:00:00Z" },
];
const owner = { email: "me@example.com", owner: true };

test("main list hides archived artifacts and links to them with a count", async () => {
  const html = await indexPage(owner, rows, true).text();
  expect(html).toContain("Active one");
  expect(html).not.toContain("Old report");
  expect(html).toMatch(/href="\/archived"[^]*data-archived-count>2</);
  expect(html).toContain('data-action="archive"');
  expect(html).toContain("/static/home.js");
});

test("archived view lists only archived, newest archive first, with unarchive", async () => {
  const html = await indexPage(owner, rows, true, undefined, true).text();
  expect(html).not.toContain("Active one");
  expect(html.indexOf("Old report")).toBeLessThan(html.indexOf("Older report"));
  expect(html).toContain('data-action="unarchive"');
});

test("non-owners see the split but no archive buttons", async () => {
  const html = await indexPage({ email: "x@example.com", owner: false }, rows.map((r) => ({ ...r, role: "view" as const })), true).text();
  expect(html).toContain("data-archived-count>2<");
  expect(html).not.toContain("row-action");
});

test("everything archived shows a tidy empty state with the archive link", async () => {
  const html = await indexPage(owner, rows.slice(1), true).text();
  expect(html).toContain("All tidy");
  expect(html).toContain('href="/archived"');
});

test("with nothing archived the archive link is present but hidden, ready for the first archive", async () => {
  const html = await indexPage(owner, rows.slice(0, 1), true).text();
  expect(html).toContain('<p class="archived-link" hidden>');
  expect(html).toContain("data-archived-count>0<");
  expect(html).toContain('data-order="0"');
});

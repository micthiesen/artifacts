import { expect, test } from "bun:test";
import { indexPage, loginPage, policyPage } from "../src/worker/pages.ts";
import { listing } from "../src/worker/listing.ts";

/** The page as the workspace would hand it over. */
const view = <T extends Parameters<typeof listing>[0][number]>(all: T[], archived = false, q?: string, page?: number) => listing(all, { archived, q, page });

const base = { description: "", owner: "me@example.com", version: 1, public: false, preview: false, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", role: "owner" as const };
const rows = [
  { ...base, id: "aaa", title: "Active one", archivedAt: null },
  { ...base, id: "bbb", title: "Old report", archivedAt: "2026-10-10T00:00:00Z" },
  { ...base, id: "ccc", title: "Older report", archivedAt: "2026-10-05T00:00:00Z" },
];
const owner = { email: "me@example.com", member: "member" as const };
const brand = { name: "Acme", home: "/", apex: "https://artifacts.test" };

test("main list hides archived artifacts and links to them with a count", async () => {
  const html = await indexPage(owner, view(rows), brand).text();
  expect(html).toContain("Active one");
  expect(html).not.toContain("Old report");
  expect(html).toMatch(/href="\/archived"[^]*data-archived-count>2</);
  expect(html).toContain('data-action="archive"');
  expect(html).toContain("/static/home.js");
});

test("archived view lists only archived, newest archive first, with unarchive", async () => {
  const html = await indexPage(owner, view(rows, true), brand, undefined, true).text();
  expect(html).not.toContain("Active one");
  expect(html.indexOf("Old report")).toBeLessThan(html.indexOf("Older report"));
  expect(html).toContain('data-action="unarchive"');
});

test("non-owners see the split and can pin, but get no archive buttons", async () => {
  const html = await indexPage({ email: "x@example.com", member: null }, view(rows.map((r) => ({ ...r, role: "view" as const }))), brand).text();
  expect(html).toContain("data-archived-count>2<");
  expect(html).not.toContain('data-action="archive"');
  expect(html).toContain('data-action="pin"');
});

test("everything archived shows a tidy empty state with the archive link", async () => {
  const html = await indexPage(owner, view(rows.slice(1)), brand).text();
  expect(html).toContain("All tidy");
  expect(html).toContain('href="/archived"');
});

test("with nothing archived the archive link is present but hidden, ready for the first archive", async () => {
  const html = await indexPage(owner, view(rows.slice(0, 1)), brand).text();
  expect(html).toContain('<p class="archived-link" hidden>');
  expect(html).toContain("data-archived-count>0<");
  expect(html).toContain('data-order="0"');
});

test("search matches every word in title, description or id, and pages hold 50", async () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ ...base, id: `a${String(i).padStart(3, "0")}`, title: i % 2 ? `Budget ${i}` : `Roadmap ${i}`, description: i === 7 ? "quarterly plan" : "", archivedAt: null }));
  const first = await indexPage(owner, view(many), brand).text();
  expect(first.match(/<li data-id=/g)?.length).toBe(50);
  expect(first).toContain("Page 1 of 3");
  expect(first).toContain('href="/?page=2" rel="next"');
  expect(first).toContain('name="q"');
  const last = await indexPage(owner, view(many, false, "", 3), brand).text();
  expect(last.match(/<li data-id=/g)?.length).toBe(20);
  expect(last).toContain('href="/?page=2" rel="prev"');
  const found = await indexPage(owner, view(many, false, "quarterly budget"), brand).text();
  expect(found).toContain("1 match for “quarterly budget”");
  expect(found).toContain('data-id="a007"');
  expect(found).not.toContain("Page 1 of");
  const none = await indexPage(owner, view(many, false, "zebra"), brand).text();
  expect(none).toContain("No matches");
  // A page past the end shows the last page; the query survives paging.
  expect(view(many, false, "budget", 99)).toMatchObject({ page: 2, pages: 2, total: 60 });
  expect(await indexPage(owner, view(many, false, "budget"), brand).text()).toContain('href="/?q=budget&amp;page=2"');
});

test("a short list has no search box or pager", async () => {
  const html = await indexPage(owner, view(rows), brand).text();
  expect(html).not.toContain('name="q"');
  expect(html).not.toContain("Page 1 of");
});

test("people asking past the last page get the last one; agents get an empty page", () => {
  const all = Array.from({ length: 120 }, (_, i) => ({ id: `a${i}`, title: `Item ${i}`, description: "", archivedAt: null }));
  expect(listing(all, { archived: false, page: 9 })).toMatchObject({ page: 3, pages: 3, total: 120 });
  expect(listing(all, { archived: false, page: 3 }).rows).toHaveLength(20);
  const agent = listing(all, { archived: false, page: 9, clamp: false });
  expect(agent).toMatchObject({ page: 9, pages: 3, total: 120 });
  expect(agent.rows).toHaveLength(0);
  expect(listing(all, { archived: false, q: "item 11" }).total).toBe(11);
});

test("workspace admins get a way to plan and billing while billing is on; members don't", async () => {
  const { workspacesPage } = await import("../src/worker/pages.ts");
  const list = [
    { slug: "mine", name: "Mine", role: "admin" as const, suspended: false, url: "https://mine.artifacts.test" },
    { slug: "theirs", name: "Theirs", role: "member" as const, suspended: false, url: "https://theirs.artifacts.test" },
  ];
  const on = await workspacesPage("me@example.com", list, false, brand, null, undefined, true).text();
  expect(on).toContain('href="https://mine.artifacts.test/settings#plan-and-billing"');
  expect(on).not.toContain("theirs.artifacts.test/settings");
  const off = await workspacesPage("me@example.com", list, false, brand).text();
  expect(off).not.toContain("plan-and-billing");
});

test("pricing lists Free's render checks and invitations from the plan, under h2 plan names", async () => {
  const { pricingPage } = await import("../src/worker/pages.ts");
  const { PLANS } = await import("../src/worker/plans.ts");
  const html = await pricingPage(brand, true).text();
  expect(html).toContain(`${PLANS.free.limits.checksPerDay} render checks`);
  expect(html).toContain(`${PLANS.free.limits.inviteEmailsPerDay} kept for invitations`);
  expect(html).toContain("<h2>Free</h2>");
  expect(html).not.toContain("<h3>");
  expect(html).toContain("The person who pays can");
});

test("pages with POST forms load the double-submit guard; others don't", async () => {
  const login = await loginPage({ step: "email", to: "", n: "", return: "/" }, brand).text();
  expect(login).toContain("/static/forms.js");
  const policy = await policyPage("privacy", brand, "").text();
  expect(policy).not.toContain("/static/forms.js");
  // Both preload shell.css's font at the URL shell.css uses.
  const css = await Bun.file(new URL("../src/shell/shell.css", import.meta.url)).text();
  for (const font of ["inter-latin-wght-normal.woff2", "fraunces-latin-soft-normal.woff2"]) {
    expect(policy).toContain(`<link rel="preload" href="/kit/v1/fonts/${font}" as="font" type="font/woff2" crossorigin>`);
    expect(css).toContain(`url(/kit/v1/fonts/${font})`);
  }
});

test("only the artifact page widens its policy, and only for Listen", async () => {
  const { PAGE_CSP, shellCsp } = await import("../src/worker/pages.ts");
  const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";
  // Every other page: no WebAssembly, no media, no other origin to fetch from.
  expect(PAGE_CSP).not.toContain("wasm-unsafe-eval");
  expect(directive(PAGE_CSP, "media-src")).toBe("");
  expect(directive(PAGE_CSP, "connect-src")).toBe("connect-src 'self' https://cloudflareinsights.com");
  // The artifact page: the speech worker's WebAssembly, the voice from the apex, sentences from blob: URLs.
  const shell = shellCsp("https://artifacts.test");
  expect(directive(shell, "script-src")).toBe("script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com");
  expect(directive(shell, "connect-src")).toBe("connect-src 'self' https://artifacts.test https://cloudflareinsights.com");
  expect(directive(shell, "media-src")).toBe("media-src 'self' blob:");
  // Everything else is the same.
  const rest = (csp: string) => csp.split("; ").filter((d) => !/^(script|connect|media)-src /.test(d));
  expect(rest(shell)).toEqual(rest(PAGE_CSP));
});

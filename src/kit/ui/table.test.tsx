import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { Table } = await import("./table.tsx");

// Let React flush its scheduled work before tearing down the DOM globals.
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 20));
  await GlobalRegistrator.unregister();
});

test("every column header sorts, including the last text column", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const rows = [
    { name: "Forgejo", price: 0, ci: "Actions-compatible" },
    { name: "GitLab", price: 29, ci: "Excellent" },
    { name: "Gitea", price: 0, ci: "Actions-compatible" },
  ];
  const root = createRoot(container);
  await act(async () => root.render(<Table data={rows} columns="name price ci" sort="price" />));
  const header = () => [...container.querySelectorAll("th")].find((th) => th.textContent?.includes("CI"))!;
  const firstCells = () => [...container.querySelectorAll("tbody tr")].map((tr) => tr.querySelectorAll("td")[2]?.textContent);
  await act(async () => header().querySelector("button")!.click());
  expect(header().getAttribute("aria-sort")).toBe("ascending");
  await act(async () => header().querySelector("button")!.click());
  expect(header().getAttribute("aria-sort")).toBe("descending");
  expect(firstCells()[0]).toBe("Excellent");
  root.unmount();
});

test("columns match their data in any case; ISO dates read as dates; {label, url} cells are links", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const rows = [{ name: "Board A", made: "2026-10-04T00:18:13.115Z", docs: { label: "Gerbers", url: "https://example.com/a.zip" } }];
  const root = createRoot(container);
  await act(async () => root.render(<Table data={rows} columns="Name Made Docs" cards="never" />));
  const cells = [...container.querySelectorAll("tbody td")].map((td) => td.textContent);
  expect(cells[0]).toBe("Board A");
  expect(cells[1]).not.toContain("T00:18");
  expect(container.querySelector("tbody a")?.textContent).toBe("Gerbers");
  expect(container.querySelector("tbody a")?.getAttribute("href")).toBe("https://example.com/a.zip");
  root.unmount();
});

test("as cards, each row is a card titled by its first column, with the rest as label and value", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const rows = [
    { item: "Yarn", qty: 2, colour: "Black", fibre: "", hook: 4 },
    { item: "Hook", qty: 1, colour: "", fibre: "", hook: 5 },
  ];
  const root = createRoot(container);
  await act(async () => root.render(<Table data={rows} cards="always" />));
  const cards = [...container.querySelectorAll("li")];
  expect(cards).toHaveLength(2);
  expect(cards[0].textContent).toContain("Yarn");
  expect([...cards[0].querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["Qty", "Colour", "Hook"]);
  expect(container.querySelector("table")).toBeNull();
  root.unmount();
});

test("money: only US dollars are a bare $; several links in one cell are each links", async () => {
  const { money } = await import("./table.tsx");
  expect(money(10, "CAD")).toContain("CA$");
  expect(money(10, "USD")).not.toContain("US");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const rows = [{ name: "PR", links: [{ label: "#966", url: "https://github.com/x/pull/966" }, { label: "#1171", url: "https://github.com/x/pull/1171" }] }];
  await act(async () => root.render(<Table data={rows} cards="never" />));
  expect([...container.querySelectorAll("tbody a")].map((a) => a.textContent)).toEqual(["#966", "#1171"]);
  root.unmount();
});

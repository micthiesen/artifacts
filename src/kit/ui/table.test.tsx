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

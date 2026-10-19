// Ledger: entries people add on the page, beside rows an agent keeps in data/.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { FrameMessage } from "../../shared/protocol.ts";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const store = await import("../store.ts");
const { Ledger } = await import("./ledger.tsx");

let sent: FrameMessage[] = [];
let container: HTMLElement;
let root: { render(el: React.ReactElement): void; unmount(): void };
const ME = "me@x.dev";
const fields = [
  { name: "date", label: "Date", type: "date" as const, required: true },
  { name: "amount", label: "Amount", type: "number" as const, required: true, format: "currency:CAD" as const },
  { name: "note", label: "Note" },
];

beforeEach(() => {
  store.reset();
  sent = [];
  store.setTransport((m) => sent.push(m));
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

async function show(role: "edit" | "view", shared: Record<string, unknown> = {}) {
  store.setBoot({ artifactId: "a1", version: 1, entry: "@art/index.mdx", data: { "data/past.json": [{ date: "2026-09-01", amount: 100, note: "From the import" }] }, title: "t" } as never);
  store.init({ viewer: { email: ME, role }, shared: shared as never, local: {}, presence: [], theme: "dark" });
  await act(async () => root.render(<Ledger id="pay" fields={fields} data="past.json" total="amount" cards="never" />));
}

const button = (name: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(name) || b.getAttribute("aria-label") === name)!;
const type = async (id: string, value: string) => {
  const el = container.querySelector<HTMLInputElement>(`#ledger-pay-${id}`)!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

test("people add an entry (stored as one shared key), totals include the agent's rows", async () => {
  await show("edit", { "ledger/pay/k1": { values: { date: "2026-10-01", amount: 50.5 }, by: "dana@x.dev", at: 1 } });
  expect(container.textContent).toContain("From the import");
  expect(container.textContent).toContain("CA$150.50");
  await act(async () => button("Add entry").click());
  await type("date", "2026-10-02");
  await type("amount", "12,5");
  await act(async () => button("Add entry").click());
  const set = sent.find((m) => m.t === "shared:set") as { key: string; value: { values: Record<string, unknown> } } | undefined;
  expect(set?.key).toMatch(/^ledger\/pay\/[a-z0-9]+$/);
  expect(set?.value.values).toEqual({ date: "2026-10-02", amount: 12.5 });
});

test("a required field is required; others' entries can't be edited; viewers can't add", async () => {
  await show("edit", { "ledger/pay/k1": { values: { date: "2026-10-01", amount: 5 }, by: "dana@x.dev", at: 1 } });
  expect(button("Edit entry")).toBeUndefined();
  await act(async () => button("Add entry").click());
  await act(async () => button("Add entry").click());
  expect(container.textContent).toContain("Date is required.");
  expect(sent.some((m) => m.t === "shared:set")).toBe(false);
  await act(async () => root.unmount());
  root = createRoot(container);
  await show("view");
  expect(button("Add entry")).toBeUndefined();
});

test("each row's edit and delete buttons name their entry", async () => {
  await show("edit", { "ledger/pay/k1": { values: { date: "2026-10-01", amount: 5 }, by: ME, at: 1 } });
  expect(button("Edit entry: 2026-10-01")).toBeDefined();
  expect(button("Delete entry: 2026-10-01")).toBeDefined();
});

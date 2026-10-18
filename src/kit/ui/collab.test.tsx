// Approval: decisions made on an earlier version than the page stop counting.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { FrameMessage } from "../../shared/protocol.ts";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const store = await import("../store.ts");
const { Approval } = await import("./collab.tsx");

let sent: FrameMessage[] = [];
let container: HTMLElement;
let root: { render(el: React.ReactElement): void; unmount(): void };
const ME = "me@x.dev";
const DANA = "dana@x.dev";

async function show(version: number, shared: Record<string, unknown>) {
  store.setBoot({ artifactId: "a1", version, entry: "@art/index.mdx", data: {}, title: "t" } as never);
  store.init({ viewer: { email: ME, role: "edit" }, shared: shared as never, local: {}, presence: [], theme: "dark" });
  await act(async () => root.render(<Approval id="go" approvers={[ME, DANA]} />));
  return container.textContent ?? "";
}

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

const approve = (by: string, version: number) => ({ decision: "approve", by, at: 1, version });

test("approvals on the current version count", async () => {
  const text = await show(3, { [`approve/go/${ME}`]: approve(ME, 3), [`approve/go/${DANA}`]: approve(DANA, 3) });
  expect(text).toContain("Approved");
  expect(text).not.toContain("needs a new look");
});

test("an approval from before the page changed needs a new look, and approving again confirms it", async () => {
  const text = await show(3, { [`approve/go/${ME}`]: approve(ME, 2), [`approve/go/${DANA}`]: approve(DANA, 3) });
  expect(text).toContain("Waiting on 1 of 2");
  expect(text).toContain("approved v2");
  expect(text).toContain("needs a new look");
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Approve"))!;
  expect(button.textContent).toContain("Approve");
  expect(button.textContent).not.toContain("Approved");
  await act(async () => button.click());
  expect(sent.find((m) => m.t === "shared:set")).toMatchObject({ key: `approve/go/${ME}`, value: { decision: "approve" } });
});

test("a current approval isn't re-sent by clicking it again", async () => {
  await show(3, { [`approve/go/${ME}`]: approve(ME, 3) });
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Approved"))!;
  await act(async () => button.click());
  expect(sent.filter((m) => m.t === "shared:set")).toEqual([]);
});

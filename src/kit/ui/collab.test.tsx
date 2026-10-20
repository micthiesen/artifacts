// Approval: decisions made on an earlier version than the page stop counting. Poll, Checklist,
// Comments and Form: what people need is reachable without hover, and errors sit by their field.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { FrameMessage } from "../../shared/protocol.ts";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const store = await import("../store.ts");
const { Approval, Checklist, Comments, Form, Poll, readField } = await import("./collab.tsx");

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

// Feedback runs a frame after the change renders: wait two.
const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

test("approving pops the status it changed; someone else's decision glows their row as it arrives", async () => {
  await show(3, {});
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Approve"))!;
  await act(async () => {
    button.click();
    await frame();
  });
  expect(container.querySelector("[role=status]")?.classList.contains("art-move-pop")).toBe(true);
  // In a browser React renders the change before the next frame; act holds it back until its scope ends.
  await act(async () => store.applyShared({ [`approve/go/${DANA}`]: approve(DANA, 3) }, "remote"));
  await act(frame);
  expect(container.querySelector(`[data-email="${DANA}"]`)?.classList.contains("art-move-glow")).toBe(true);
  // An echo of your own write is not an arrival.
  await act(async () => store.applyShared({ [`approve/go/${ME}`]: approve(ME, 3) }));
  await act(frame);
  expect(container.querySelector(`[data-email="${ME}"]`)?.classList.contains("art-move-glow")).toBe(false);
});

test("a decision the server refused glows where it snapped back", async () => {
  const changes = { decision: "changes", by: ME, at: 1, version: 3 };
  await show(3, { [`approve/go/${ME}`]: changes });
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Approve")!;
  await act(async () => button.click());
  await act(async () => store.applyShared({ [`approve/go/${ME}`]: changes }, "reverted"));
  await act(frame);
  expect(container.querySelector(`[data-email="${ME}"]`)?.classList.contains("art-move-glow")).toBe(true);
});

async function mount(el: React.ReactElement, shared: Record<string, unknown> = {}) {
  store.setBoot({ artifactId: "a1", version: 1, entry: "@art/index.mdx", data: {}, title: "t" } as never);
  store.init({ viewer: { email: ME, role: "edit" }, shared: shared as never, local: {}, presence: [], theme: "dark" });
  await act(async () => root.render(el));
}
const sets = () => sent.filter((m) => m.t === "shared:set");

test("number fields take a currency sign and spaces", () => {
  const f = { name: "amount", type: "number" as const };
  expect(readField(f, "$12.50")).toEqual({ value: 12.5 });
  expect(readField(f, "-$3")).toEqual({ value: -3 });
  expect(readField(f, "1 200 €")).toEqual({ value: 1200 });
  expect(readField(f, "£0,5")).toEqual({ value: 0.5 });
  expect(readField(f, "12$5")).toEqual({ error: "amount must be a number." });
  expect(readField(f, "$")).toEqual({ error: "amount must be a number." });
});

test("a form marks optional fields, and an error sits under its field, linked and focused", async () => {
  await mount(
    <Form
      id="f"
      fields={[
        { name: "who", label: "Name", required: true },
        { name: "team", label: "Team", type: "select", options: ["A", "B"], required: true },
        { name: "note", label: "Note" },
      ]}
    />,
  );
  const labels = [...container.querySelectorAll("label")].map((l) => l.textContent);
  expect(labels).toEqual(["Name", "Note (optional)"]);
  expect(container.textContent).not.toContain("*");
  expect(container.querySelector("#form-f-who")?.getAttribute("aria-required")).toBe("true");
  const name = container.querySelector<HTMLInputElement>("#form-f-who")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Dana");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Send"))!;
  await act(async () => send.click());
  // The select is the field that failed: its trigger carries the id, so it's marked and takes focus.
  const trigger = container.querySelector("#form-f-team")!;
  const alert = container.querySelector("[role=alert]")!;
  expect(alert.textContent).toBe("Team is required.");
  expect(alert.id).toBe("form-f-team-error");
  expect(alert.parentElement).toBe(trigger.parentElement);
  expect(trigger.getAttribute("aria-invalid")).toBe("true");
  expect(trigger.getAttribute("aria-describedby")).toBe("form-f-team-error");
  expect(document.activeElement).toBe(trigger);
  expect(name.getAttribute("aria-invalid")).toBeNull();
  expect(sets()).toEqual([]);
});

test("a checklist row is one checkbox named by its text; who ticked it is a button", async () => {
  await mount(<Checklist id="c" items={["Book the room", "Order food"]} />, { "check/c/order-food": { done: true, by: "dana@x.dev" } });
  const boxes = [...container.querySelectorAll("[role=checkbox]")];
  expect(boxes.map((b) => b.textContent)).toEqual(["Book the room", "Order food"]);
  await act(async () => (boxes[0] as HTMLElement).click());
  expect(sets()[0]).toMatchObject({ key: "check/c/book-the-room", value: { done: true } });
  expect(container.querySelector("button[aria-label='Done by Dana']")).not.toBeNull();
});

test("tapping who voted doesn't vote", async () => {
  await mount(<Poll id="p" options={["Tea", "Coffee"]} />, { "poll/p/dana@x.dev": ["Tea"] });
  const who = container.querySelector<HTMLButtonElement>("button[aria-label^='Who voted for Tea']")!;
  expect(who.getAttribute("aria-label")).toBe("Who voted for Tea: Dana");
  expect(who.closest("[role=radio]")).toBeNull();
  await act(async () => who.click());
  expect(sets()).toEqual([]);
  await act(async () => container.querySelector<HTMLButtonElement>("[role=radio]")!.click());
  expect(sets()[0]).toMatchObject({ key: `poll/p/${ME}`, value: ["Tea"] });
});

test("deleting your comment asks first", async () => {
  await mount(<Comments id="m" />, { "comments/m/00000000000001-a": { by: ME, text: "Hi", at: 1 } });
  const del = container.querySelector<HTMLButtonElement>("button[aria-label='Delete comment']")!;
  const answers = [false, true];
  const asked: string[] = [];
  const original = globalThis.confirm;
  globalThis.confirm = (q?: string) => (asked.push(String(q)), answers.shift()!);
  try {
    await act(async () => del.click());
    expect(sets()).toEqual([]);
    await act(async () => del.click());
    expect(sets()).toEqual([expect.objectContaining({ key: "comments/m/00000000000001-a" })]);
    expect(asked).toEqual(["Delete this comment?", "Delete this comment?"]);
  } finally {
    globalThis.confirm = original;
  }
});

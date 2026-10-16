import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { FrameMessage, Viewer } from "../shared/protocol.ts";
import type { SharedMap } from "./hooks.ts";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const store = await import("./store.ts");
const hooks = await import("./hooks.ts");

let sent: FrameMessage[] = [];
let container: HTMLElement;
const roots: { unmount(): void }[] = [];

function init(viewer: Viewer, shared: Record<string, unknown> = {}) {
  store.init({ viewer, shared: shared as never, local: {}, presence: [], theme: "light" });
}

async function render(el: React.ReactElement) {
  const root = createRoot(container);
  await act(async () => root.render(el));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await act(async () => {
    for (const r of roots.splice(0)) r.unmount();
  });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
beforeEach(() => {
  store.reset();
  sent = [];
  store.setTransport((m) => sent.push(m));
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
});

describe("useShared", () => {
  test("default, functional update, remote change, delete", async () => {
    init({ email: "a@x.dev", role: "edit" });
    let setter!: (v: number | ((p: number) => number) | null) => void;
    let renders = 0;
    function C() {
      const [n, setN] = hooks.useShared("n", 5);
      setter = setN;
      renders++;
      return <span id="v">{n}</span>;
    }
    await render(<C />);
    expect(container.textContent).toBe("5");
    await act(async () => {
      setter((p) => p + 1);
      setter((p) => p + 1);
    });
    expect(container.textContent).toBe("7");
    expect(sent).toEqual([
      { t: "shared:set", key: "n", value: 6 },
      { t: "shared:set", key: "n", value: 7 },
    ]);
    await act(async () => store.applyShared({ n: 42 }));
    expect(container.textContent).toBe("42");
    const before = renders;
    await act(async () => store.applyShared({ unrelated: 1 }));
    expect(renders).toBe(before);
    await act(async () => setter(null));
    expect(container.textContent).toBe("5");
    expect(sent.at(-1)).toEqual({ t: "shared:set", key: "n", value: null });
  });

  test("view role: setter no-ops", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    init({ email: "v@x.dev", role: "view" }, { n: 1 });
    let setter!: (v: number) => void;
    function C() {
      const [n, setN] = hooks.useShared("n", 0);
      setter = setN;
      return <span>{n}</span>;
    }
    await render(<C />);
    await act(async () => setter(9));
    expect(container.textContent).toBe("1");
    expect(sent).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("useSharedMap", () => {
  test("one key per item; entries strip the prefix", async () => {
    init({ email: "a@x.dev", role: "edit" }, { "todo/1": { t: "a" }, "todox/9": 1 });
    let map!: SharedMap<{ t: string }>;
    function C() {
      map = hooks.useSharedMap<{ t: string }>("todo");
      return <span>{map.entries.map(([k, v]) => `${k}=${v.t}`).join(",")}</span>;
    }
    await render(<C />);
    expect(container.textContent).toBe("1=a");
    await act(async () => map.set("2", { t: "b" }));
    expect(container.textContent).toBe("1=a,2=b");
    expect(sent).toEqual([{ t: "shared:set", key: "todo/2", value: { t: "b" } }]);
    expect(map.get("2")).toEqual({ t: "b" });
    await act(async () => map.delete("1"));
    expect(container.textContent).toBe("2=b");
    expect(sent.at(-1)).toEqual({ t: "shared:set", key: "todo/1", value: null });
  });
});

describe("useLocal, useViewer, usePresence, useData", () => {
  test("work together", async () => {
    store.setBoot({ artifactId: "a", version: 1, entry: "@art/app.tsx", title: "t", data: { "data/x.json": { ok: true } } });
    init({ email: null, role: "view" });
    let setLocal!: (v: string) => void;
    function C() {
      const [tab, setTab] = hooks.useLocal("tab", "one");
      setLocal = setTab;
      const v = hooks.useViewer();
      const p = hooks.usePresence();
      const d = hooks.useData<{ ok: boolean }>("x.json");
      return <span>{`${tab}|${v.email}|${v.role}|${v.canWrite}|${p.length}|${d.ok}`}</span>;
    }
    await render(<C />);
    expect(container.textContent).toBe("one|null|view|false|0|true");
    await act(async () => setLocal("two"));
    await act(async () => store.setPresence(["a@x.dev"]));
    expect(container.textContent).toBe("two|null|view|false|1|true");
    expect(sent).toEqual([{ t: "local:set", key: "tab", value: "two" }]);
  });
});

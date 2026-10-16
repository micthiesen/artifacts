import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import type { FrameMessage, ShellMessage } from "../shared/protocol.ts";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { boot } = await import("./runtime.tsx");

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test("handshake: ready, ignores foreign messages, renders after init, bridges storage and updates", async () => {
  document.body.innerHTML = `<div id="root"></div><script type="application/json" id="art-boot">${JSON.stringify({
    artifactId: "a1",
    version: 1,
    entry: join(import.meta.dir, "test-fixtures/entry.tsx"),
    data: {},
    title: "Test",
  })}</script>`;
  const sent: FrameMessage[] = [];
  const parent = { postMessage: (m: FrameMessage) => sent.push(m) } as unknown as Window;
  const deliver = (data: ShellMessage, source: unknown = parent) =>
    window.dispatchEvent(new MessageEvent("message", { data, source: source as Window }));

  const done = boot({ parent });
  await tick();
  expect(sent).toEqual([{ t: "ready" }]);

  const init: ShellMessage = {
    t: "init",
    viewer: { email: "a@x.dev", role: "edit" },
    local: { "ls:seen": "yes" },
    shared: { n: 1 },
    presence: ["a@x.dev"],
    theme: "dark",
  };
  deliver({ ...init, viewer: { email: "evil@x.dev", role: "owner" } }, {});
  await tick();
  expect(document.getElementById("out")).toBeNull();

  await act(async () => {
    deliver(init);
    await done;
    await tick(50);
  });
  expect(document.getElementById("out")?.textContent).toBe("n=1 viewer=a@x.dev ls=yes");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(document.getElementById("root")?.classList.contains("h-full")).toBe(true);

  await act(async () => {
    deliver({ t: "shared", changes: { n: 2 } });
    deliver({ t: "theme", theme: "light" });
    await tick();
  });
  expect(document.getElementById("out")?.textContent).toContain("n=2");
  expect(document.documentElement.classList.contains("dark")).toBe(false);

  window.localStorage.setItem("seen", "again");
  sessionStorage.setItem("s", "1");
  expect(sent.filter((m) => m.t === "local:set")).toEqual([{ t: "local:set", key: "ls:seen", value: "again" }]);
});

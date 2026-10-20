import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { FrameMessage, Viewer } from "../shared/protocol.ts";
import { SHARED_VALUE_MAX_BYTES } from "../shared/protocol.ts";
import * as store from "./store.ts";

let sent: FrameMessage[] = [];

function initAs(viewer: Viewer, shared: Record<string, never> | Record<string, unknown> = {}, local: Record<string, unknown> = {}) {
  store.init({ viewer, shared: shared as never, local: local as never, presence: ["a@x.dev"], theme: "light" });
}

beforeEach(() => {
  store.reset();
  sent = [];
  store.setTransport((m) => sent.push(m));
});

describe("shared state", () => {
  test("optimistic set posts shared:set and updates the snapshot", () => {
    initAs({ email: "a@x.dev", role: "edit" });
    expect(store.setShared("count", 3)).toBe(true);
    expect(store.getShared("count")).toBe(3);
    expect(sent).toEqual([{ t: "shared:set", key: "count", value: 3 }]);
  });

  test("null and undefined delete, and posting null tells the shell to delete", () => {
    initAs({ email: "a@x.dev", role: "owner" }, { k: 1, j: 2 });
    store.setShared("k", null);
    store.setShared("j", undefined);
    expect(store.getShared("k")).toBeUndefined();
    expect(store.getShared("j")).toBeUndefined();
    expect(sent).toEqual([
      { t: "shared:set", key: "k", value: null },
      { t: "shared:set", key: "j", value: null },
    ]);
  });

  test("deleting a missing key is a silent no-op", () => {
    initAs({ email: "a@x.dev", role: "edit" });
    store.setShared("nope", null);
    expect(sent).toEqual([]);
  });

  test("view role and anonymous viewers cannot write; writes warn once and no-op", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    for (const viewer of [{ email: "v@x.dev", role: "view" }, { email: null, role: "view" }, { email: null, role: "edit" }] as Viewer[]) {
      store.reset();
      store.setTransport((m) => sent.push(m));
      initAs(viewer, { k: 1 });
      expect(store.canWrite()).toBe(false);
      expect(store.setShared("k", 2)).toBe(false);
      store.setShared("k", 3);
      expect(store.getShared("k")).toBe(1);
    }
    expect(sent).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  test("oversized values are refused", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    initAs({ email: "a@x.dev", role: "edit" });
    expect(store.setShared("big", "x".repeat(SHARED_VALUE_MAX_BYTES + 1))).toBe(false);
    expect(store.getShared("big")).toBeUndefined();
    expect(sent).toEqual([]);
    err.mockRestore();
  });

  test("applyShared merges changes and null deletes; listeners fire", () => {
    initAs({ email: "a@x.dev", role: "edit" }, { a: 1, b: 2 });
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.applyShared({ a: 10, b: null, c: "new" });
    expect(store.getSharedSnapshot()).toEqual({ a: 10, c: "new" });
    expect(calls).toBe(1);
    store.applyShared({});
    expect(calls).toBe(1);
    off();
  });

  test("shell echo of our own optimistic write leaves the value in place", () => {
    initAs({ email: "a@x.dev", role: "edit" });
    store.setShared("k", { n: 1 });
    store.applyShared({ k: { n: 1 } });
    expect(store.getShared("k")).toEqual({ n: 1 });
  });

  test("a rejected write is reverted by the shell sending the server value", () => {
    initAs({ email: "a@x.dev", role: "edit" }, { k: "server" });
    store.setShared("k", "mine");
    store.applyShared({ k: "server" });
    expect(store.getShared("k")).toBe("server");
  });
});

describe("remote changes", () => {
  // No DOM here, so the store falls back to a timeout for its frame: one turn of the loop flushes it.
  const flush = () => new Promise((r) => setTimeout(r, 5));

  test("only what someone else added or changed reaches the arrival listeners, after the page updates", async () => {
    initAs({ email: "a@x.dev", role: "edit" }, { "check/c/x": { done: true }, "poll/p/a@x.dev": ["Yes"], "poll/p/c@x.dev": ["Yes"] });
    const heard: string[][] = [];
    const kinds: string[] = [];
    const stop = store.onRemoteChange((keys, kind) => {
      heard.push(keys);
      kinds.push(kind);
    });
    // Your own write coming back is not an arrival.
    store.applyShared({ "poll/p/a@x.dev": ["No"] });
    // From someone else: a new key, a changed one, a removal of an existing key, and a value written again as it was.
    store.applyShared({ "poll/p/b@x.dev": ["No"], "poll/p/c@x.dev": ["No"], "check/c/x": null, "poll/p/a@x.dev": ["No"] }, "remote");
    expect(heard).toEqual([]);
    expect(store.getShared("check/c/x")).toBeUndefined();
    await flush();
    expect(heard).toEqual([["poll/p/b@x.dev", "poll/p/c@x.dev"]]);
    // Your own write the server refused, rolled back: reported as such.
    store.applyShared({ "poll/p/a@x.dev": ["Yes"] }, "reverted");
    await flush();
    expect(kinds).toEqual(["remote", "reverted"]);
    stop();
    store.applyShared({ n: 1 }, "remote");
    await flush();
    expect(heard).toHaveLength(2);
  });
});

describe("prefix entries", () => {
  test("returns sorted remainder keys and is referentially stable across unrelated writes", () => {
    initAs({ email: "a@x.dev", role: "edit" }, { "todo/b": 2, "todo/a": 1, "todos/x": 9, other: 0 });
    const first = store.getPrefixEntries("todo");
    expect(first).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(store.getPrefixEntries("todo")).toBe(first);
    store.setShared("other", 1);
    expect(store.getPrefixEntries("todo")).toBe(first);
    store.setShared("todo/c", 3);
    const next = store.getPrefixEntries("todo");
    expect(next).not.toBe(first);
    expect(next.map((e) => e[0])).toEqual(["a", "b", "c"]);
  });
});

describe("local storage", () => {
  test("setLocal posts local:set; delete posts undefined", () => {
    initAs({ email: null, role: "view" });
    store.setLocal("tab", "b");
    store.setLocal("tab", null);
    expect(sent).toEqual([
      { t: "local:set", key: "tab", value: "b" },
      { t: "local:set", key: "tab", value: undefined },
    ]);
    expect(store.getLocal("tab")).toBeUndefined();
  });

  test("anonymous viewers can still use local storage", () => {
    initAs({ email: null, role: "view" }, {}, { seen: true });
    expect(store.getLocal("seen")).toBe(true);
    store.setLocal("seen", false);
    expect(store.getLocal("seen")).toBe(false);
  });
});

describe("data files", () => {
  test("resolves with or without the data/ prefix and explains a miss", () => {
    store.setBoot({ artifactId: "a", version: 1, entry: "@art/app.tsx", title: "t", data: { "data/repos.json": [{ name: "x" }] } });
    expect(store.getData("repos.json")).toEqual([{ name: "x" }]);
    expect(store.getData("data/repos.json")).toEqual([{ name: "x" }]);
    expect(store.getData("./data/repos.json")).toEqual([{ name: "x" }]);
    expect(() => store.getData("missing.json")).toThrow(/data\/missing\.json.*Available: data\/repos\.json/);
  });
});

describe("viewer, presence, theme", () => {
  test("init and updates", () => {
    initAs({ email: "a@x.dev", role: "owner" });
    expect(store.getViewer()).toEqual({ email: "a@x.dev", role: "owner" });
    expect(store.getPresence()).toEqual(["a@x.dev"]);
    store.setPresence(["a@x.dev", "b@x.dev"]);
    expect(store.getPresence()).toEqual(["a@x.dev", "b@x.dev"]);
    store.setTheme("dark");
    expect(store.getTheme()).toBe("dark");
  });
});

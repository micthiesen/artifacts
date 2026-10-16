import { describe, expect, test } from "bun:test";
import { applyJsonPatch, applyTextEdits, EditError, grepFiles } from "../src/worker/edit.ts";

describe("applyTextEdits", () => {
  test("replaces a unique match", () => {
    expect(applyTextEdits("a.tsx", "one two three", [{ oldText: "two", newText: "2" }])).toBe("one 2 three");
  });
  test("rejects ambiguous matches with the count", () => {
    expect(() => applyTextEdits("a.tsx", "x x", [{ oldText: "x", newText: "y" }])).toThrow(/matches 2 places/);
  });
  test("replaceAll replaces every match", () => {
    expect(applyTextEdits("a.tsx", "x x", [{ oldText: "x", newText: "y", replaceAll: true }])).toBe("y y");
  });
  test("missing text names the edit", () => {
    expect(() => applyTextEdits("a.tsx", "abc", [{ oldText: "a", newText: "b" }, { oldText: "zz", newText: "" }])).toThrow(
      /edit 2: oldText not found/,
    );
  });
  test("edits apply in order and $ patterns are literal", () => {
    expect(applyTextEdits("a", "price", [{ oldText: "price", newText: "$& $1" }])).toBe("$& $1");
  });
});

describe("applyJsonPatch", () => {
  const doc = { rows: [{ name: "a", price: 1 }, { name: "b", price: 2 }] };
  test("replace, add, remove, move, test", () => {
    const out = applyJsonPatch(doc, [
      { op: "test", path: "/rows/0/name", value: "a" },
      { op: "replace", path: "/rows/1/price", value: 5 },
      { op: "add", path: "/rows/-", value: { name: "c", price: 3 } },
      { op: "remove", path: "/rows/0" },
      { op: "move", from: "/rows/0", path: "/first" },
    ]);
    expect(out).toEqual({ rows: [{ name: "c", price: 3 }], first: { name: "b", price: 5 } });
    expect(doc.rows[1].price).toBe(2);
  });
  test("replace of a missing path fails", () => {
    expect(() => applyJsonPatch(doc, [{ op: "replace", path: "/rows/9", value: 1 }])).toThrow(EditError);
  });
  test("escaped pointer tokens", () => {
    expect(applyJsonPatch({ "a/b": 1 }, [{ op: "replace", path: "/a~1b", value: 2 }])).toEqual({ "a/b": 2 });
  });
});

test("grepFiles returns line numbers", () => {
  expect(grepFiles({ "a.md": "x\nfoo bar\ny" }, "foo")).toEqual([{ path: "a.md", line: 2, text: "foo bar" }]);
});

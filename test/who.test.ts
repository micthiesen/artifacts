import { expect, test } from "bun:test";
import { whoColor } from "../src/shared/who.ts";

test("a person keeps one colour however their address is written", () => {
  expect(whoColor(" Priya.Shah@Example.com ")).toBe(whoColor("priya.shah@example.com"));
  expect(whoColor(null)).toBe(whoColor(undefined));
});

test("different people spread across the colours", () => {
  const colours = new Set(["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com", "g@x.com", "h@x.com"].map(whoColor));
  expect(colours.size).toBeGreaterThan(2);
});

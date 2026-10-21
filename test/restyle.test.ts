import { expect, test } from "bun:test";
import { retireSignal } from "../src/worker/restyle.ts";

test("retired gradient classes become the solid colours", () => {
  expect(retireSignal(`<span className="rounded bg-signal px-2 text-primary-foreground">New</span>`)).toBe(
    `<span className="rounded bg-primary px-2 text-primary-foreground">New</span>`,
  );
  expect(retireSignal(`<div className="w-1 bg-signal-v" />`)).toBe(`<div className="w-1 bg-primary" />`);
  expect(retireSignal(`<h2 className="text-signal font-bold">Hi</h2>`)).toBe(`<h2 className="text-primary font-bold">Hi</h2>`);
  expect(retireSignal(`border-signal-from text-signal-to bg-gradient-to-r from-signal-from to-signal-to`)).toBe(
    `border-primary text-others bg-gradient-to-r from-primary to-others`,
  );
  // Variants, important and opacity keep working.
  expect(retireSignal(`hover:bg-signal md:!text-signal bg-signal/40 ring-signal-from`)).toBe(`hover:bg-primary md:!text-primary bg-primary/40 ring-primary`);
});

test("variables become the solid colours; the gradient stays an image", () => {
  expect(retireSignal(`style={{ background: "var(--signal)", color: "var(--signal-to)", borderColor: "var(--signal-from)" }}`)).toBe(
    `style={{ background: "linear-gradient(var(--primary),var(--primary))", color: "var(--others)", borderColor: "var(--primary)" }}`,
  );
  // No space, so a class with the gradient inside stays one class.
  expect(retireSignal(`<div className="h-1 bg-[image:var(--signal-v)]" />`)).toBe(`<div className="h-1 bg-[image:linear-gradient(var(--primary),var(--primary))]" />`);
});

test("names that only look like the old ones are left alone", () => {
  const prose = "A strong signal-to-noise ratio, a low-signal-to be sure, weak-signal-from sensors; my-bg-signal-x stays.";
  expect(retireSignal(prose)).toBe(prose);
  expect(retireSignal(`<div data-signal-from="x" className="signal" />`)).toBe(`<div data-signal-from="x" className="signal" />`);
  expect(retireSignal("no gradient here")).toBe("no gradient here");
});

test("a file with its own --signal variables keeps them", () => {
  const css = `:root { --signal: red; --signal-from: blue; }\n.x { color: var(--signal); } .y { @apply bg-signal; }`;
  expect(retireSignal(css)).toBe(css);
});

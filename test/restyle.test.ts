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
  expect(retireSignal(`style={{ background: "var(--signal)", color: "var(--signal-to)", borderColor: "var(--signal-from)" }}`)).toBe(
    `style={{ background: "var(--primary)", color: "var(--others)", borderColor: "var(--primary)" }}`,
  );
});

test("text that only mentions signal is left alone", () => {
  const prose = "A strong signal-to-noise ratio; the signal fired. my-bg-signal-x stays.";
  expect(retireSignal(prose)).toBe(prose);
  expect(retireSignal("no gradient here")).toBe("no gradient here");
});

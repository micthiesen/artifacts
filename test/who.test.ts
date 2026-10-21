import { expect, test } from "bun:test";
import { PALETTE, hashedColour, rememberColours, whoColor } from "../src/shared/who.ts";

test("a person keeps one colour however their address is written", () => {
  expect(whoColor(" Priya.Shah@Example.com ")).toBe(whoColor("priya.shah@example.com"));
  expect(whoColor(null)).toBe(whoColor(undefined));
});

test("a stored colour wins over the email's own", () => {
  const email = "stored@example.com";
  const other = (hashedColour(email) + 1) % PALETTE.length;
  rememberColours({ [email]: other, "bad@example.com": 99 });
  expect(whoColor(email)).toBe(PALETTE[other]);
  expect(whoColor("bad@example.com")).toBe(PALETTE[hashedColour("bad@example.com")]);
});

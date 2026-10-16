import { expect, test } from "bun:test";
import { signToken, timingSafeEqual, verifyToken } from "../src/worker/session.ts";

test("tokens round-trip and are bound to kind and secret", async () => {
  const t = await signToken("s1", "session", 60, { e: "a@b.c" });
  expect((await verifyToken<{ e: string }>("s1", "session", t))?.e).toBe("a@b.c");
  expect(await verifyToken("s1", "frame", t)).toBeNull();
  expect(await verifyToken("s2", "session", t)).toBeNull();
  const [body, sig] = t.split(".");
  expect(await verifyToken("s1", "session", `${body}x.${sig}`)).toBeNull();
});

test("expired tokens are rejected", async () => {
  const t = await signToken("s1", "login", -1, { e: "a@b.c" });
  expect(await verifyToken("s1", "login", t)).toBeNull();
});

test("timingSafeEqual", () => {
  expect(timingSafeEqual("abc", "abc")).toBe(true);
  expect(timingSafeEqual("abc", "abd")).toBe(false);
  expect(timingSafeEqual("abc", "abcd")).toBe(false);
});

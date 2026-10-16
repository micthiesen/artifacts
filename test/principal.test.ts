import { expect, test } from "bun:test";
import { domainOf, isValidPrincipal, sharePrincipal } from "../src/worker/principal.ts";

test("share principals normalize emails and domains", () => {
  expect(sharePrincipal(" Sam@Cozeeai.com ")).toBe("sam@cozeeai.com");
  expect(sharePrincipal("cozeeai.com")).toBe("@cozeeai.com");
  expect(sharePrincipal("@CozeeAI.com")).toBe("@cozeeai.com");
  expect(domainOf("sam@cozeeai.com")).toBe("@cozeeai.com");
});

test("principal validation", () => {
  for (const ok of ["sam@cozeeai.com", "@cozeeai.com", "@mail.example.co.uk"]) expect(isValidPrincipal(ok)).toBe(true);
  for (const bad of ["@", "@localhost", "sam@", "two words@x.com", "@x..com"]) expect(isValidPrincipal(bad)).toBe(false);
});

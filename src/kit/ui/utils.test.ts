import { expect, test } from "bun:test";
import { displayName, humanize } from "./utils.ts";

test("humanize keeps acronyms and splits camel/snake case", () => {
  expect(humanize("ci")).toBe("CI");
  expect(humanize("id")).toBe("ID");
  expect(humanize("selfHost")).toBe("Self host");
  expect(humanize("api_url")).toBe("API URL");
  expect(humanize("apiURL")).toBe("API URL");
  expect(humanize("HTTPStatus")).toBe("HTTP status");
  expect(humanize("stars")).toBe("Stars");
  expect(humanize("monthly-cost")).toBe("Monthly cost");
});

test("displayName", () => {
  expect(displayName("ada.lovelace@example.com")).toBe("Ada Lovelace");
  expect(displayName(null)).toBe("Anonymous");
});

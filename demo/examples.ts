// The example artifacts on the splash page and in the public demo workspace.
// Each folder here is a real artifact, compiled by the same code as any other.
// `seed` is the shared state other people have already left: the splash loads
// it into a local-only copy in the visitor's browser, and scripts/seed-demo.ts
// writes it to the demo workspace, each entry as the person in `by`.
import type { JsonValue } from "../src/shared/protocol.ts";

export type SeedEntry = {
  by: string;
  key: string;
  value: JsonValue;
  /** Sets the value's `at` to this many minutes before the page loads. */
  minutesAgo?: number;
};

export type Example = {
  /** Folder name under demo/, and the frame's file name. */
  slug: string;
  /** Tab label on the splash. */
  label: string;
  /** Artifact title. */
  title: string;
  /** One line under the tabs: what this example shows. */
  blurb: string;
  seed: SeedEntry[];
};

/** An entry's value as of `now`, with `at` filled in from `minutesAgo`. */
export function seedValue(e: SeedEntry, now: number): JsonValue {
  return e.minutesAgo !== undefined && e.value && typeof e.value === "object" && !Array.isArray(e.value)
    ? { ...e.value, at: now - e.minutesAgo * 60_000 }
    : e.value;
}

const PRIYA = "priya.shah@example.com";
const MARCUS = "marcus.lee@example.com";
const ANA = "ana.ruiz@example.com";
const TOM = "tom.okafor@example.com";

export const PEOPLE = [PRIYA, MARCUS, ANA, TOM];

export const EXAMPLES: Example[] = [
  {
    slug: "launch-plan",
    label: "Launch plan",
    title: "Launch plan: billing v2",
    blurb: "MDX with a diagram, a chart, and a poll, sign-off, checklist and comments that everyone shares.",
    seed: [
      { by: PRIYA, key: `approve/go/${PRIYA}`, value: { decision: "approve", note: "Docs and support macros are ready.", by: PRIYA }, minutesAgo: 50 },
      { by: TOM, key: `approve/go/${TOM}`, value: { decision: "approve", by: TOM }, minutesAgo: 20 },
      { by: PRIYA, key: `poll/day/${PRIYA}`, value: ["This Thursday"] },
      { by: MARCUS, key: `poll/day/${MARCUS}`, value: ["Next Thursday"] },
      { by: ANA, key: `poll/day/${ANA}`, value: ["This Thursday"] },
      { by: PRIYA, key: "check/launch/docs", value: { done: true, by: PRIYA }, minutesAgo: 300 },
      { by: TOM, key: "check/launch/status-page", value: { done: true, by: TOM }, minutesAgo: 140 },
      {
        by: MARCUS,
        key: "comments/main/00001760000000000-a1",
        value: { by: MARCUS, text: "Load test is booked for Wednesday night. I'd keep next Thursday as the fallback.", at: 0 },
        minutesAgo: 190,
      },
      {
        by: PRIYA,
        key: "comments/main/00001760000100000-b2",
        value: { by: PRIYA, text: "Docs are done. The status page draft is linked in the checklist.", at: 0 },
        minutesAgo: 45,
      },
    ],
  },
  {
    slug: "retro",
    label: "Retro board",
    title: "Sprint 42 retro",
    blurb: "A React app in one file: cards and votes sync live between everyone with the page open.",
    seed: [
      { by: ANA, key: "card/c1", value: { col: "Went well", text: "Billing beta shipped a day early", by: ANA } },
      { by: TOM, key: "card/c2", value: { col: "Went well", text: "Pairing on the migration", by: TOM } },
      { by: MARCUS, key: "card/c3", value: { col: "To improve", text: "Flaky e2e tests blocked two merges", by: MARCUS } },
      { by: PRIYA, key: "card/c4", value: { col: "To improve", text: "Too many meetings on Wednesday", by: PRIYA } },
      { by: PRIYA, key: "card/c5", value: { col: "Actions", text: "Quarantine flaky tests automatically", by: PRIYA } },
      { by: ANA, key: `vote/c1/${ANA}`, value: true },
      { by: MARCUS, key: `vote/c1/${MARCUS}`, value: true },
      { by: TOM, key: `vote/c3/${TOM}`, value: true },
      { by: PRIYA, key: `vote/c3/${PRIYA}`, value: true },
      { by: ANA, key: `vote/c3/${ANA}`, value: true },
      { by: MARCUS, key: `vote/c5/${MARCUS}`, value: true },
    ],
  },
  {
    slug: "costs",
    label: "Cost report",
    title: "Cloud costs: September",
    blurb: "A report from data files: sortable table, stacked chart and shared notes.",
    seed: [
      {
        by: TOM,
        key: "notes/followups",
        value: { text: "Cut log retention to 30 days (Tom)\nTag the search cluster by team", by: TOM, at: 0 },
        minutesAgo: 1500,
      },
    ],
  },
];

/**
 * Pages published to the demo workspace beside the examples, linked from the
 * splash but not shown as a tab there.
 */
export const PAGES: { slug: string; title: string; blurb: string }[] = [
  { slug: "principles", title: "How artifacts.boo thinks", blurb: "The principles behind artifacts.boo, and what it deliberately doesn't do." },
];

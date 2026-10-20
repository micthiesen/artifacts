// An artifact as one Markdown document, for pasting into an agent that can't
// reach it over MCP (`/a/<id>.md`, and "Copy as Markdown" in the account menu).
// Markdown entries are inlined as they are; code and data files follow in
// fences, so the agent gets everything the page is built from.
import { PRODUCT } from "../shared/brand.ts";
import type { ArtifactMeta } from "./hub.ts";

const ENTRIES = ["index.mdx", "index.md", "app.tsx"];

/** A fence longer than any backtick run in `text`, so the content can't close it. */
function fence(text: string, lang: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${text.replace(/\n+$/, "")}\n${ticks}`;
}

function langOf(path: string): string {
  const ext = path.split(".").pop() ?? "";
  return { mdx: "mdx", md: "markdown", tsx: "tsx", ts: "ts", json: "json" }[ext] ?? "";
}

export function artifactMarkdown(meta: Pick<ArtifactMeta, "title" | "description" | "version" | "updatedAt">, files: Record<string, string>, url: string): string {
  const entry = ENTRIES.find((p) => p in files);
  const rest = Object.keys(files)
    .filter((p) => p !== entry)
    .sort((a, b) => Number(a.startsWith("data/")) - Number(b.startsWith("data/")) || a.localeCompare(b));
  const markdown = entry === "index.mdx" || entry === "index.md";
  const out: string[] = [];
  out.push(`# ${meta.title}`);
  const about = [
    `Exported from ${PRODUCT}: ${url}`,
    `Version ${meta.version}, updated ${meta.updatedAt.slice(0, 10)}.`,
    ...(meta.description ? [meta.description] : []),
  ];
  out.push(about.map((l) => `> ${l}`).join("\n>\n"));
  const notes: string[] = [];
  if (entry === "index.mdx") notes.push("The page is MDX: Markdown plus components such as `<Table>`, `<Chart>` and `<Callout>`. A component with `data=\"x.json\"` shows the file `data/x.json`, included below.");
  if (entry === "app.tsx") notes.push("The page is a React app (`app.tsx`); its source and data are below.");
  notes.push("Live parts (comments, votes, checklist ticks, form answers) aren't included.");
  out.push(notes.join(" "));
  if (entry) {
    out.push("---");
    // An MDX or Markdown page reads as itself; its own title is already above.
    out.push(markdown ? files[entry].replace(/^\s*#\s+.*\n/, "").trim() : `## ${entry}\n\n${fence(files[entry], langOf(entry))}`);
  }
  if (rest.length) {
    out.push("---");
    out.push(rest.map((p) => `## ${p}\n\n${fence(files[p], langOf(p))}`).join("\n\n"));
  }
  return `${out.join("\n\n")}\n`;
}

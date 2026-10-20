// An artifact as one Markdown document, for pasting into an agent that can't
// reach it over MCP (`/a/<id>.md`, and "Copy as Markdown for AI" in the account
// menu). It opens with what the agent needs to read the rest: where it's from,
// which files there are and how they fit together. A Markdown entry is inlined
// as it is; every other file follows in a fence under a `### File:` heading.
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

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type Asset = { path: string; contentType: string; bytes: number };

export function artifactMarkdown(
  meta: Pick<ArtifactMeta, "title" | "description" | "version" | "updatedAt">,
  files: Record<string, string>,
  url: string,
  assets: Asset[] = [],
): string {
  const origin = new URL(url).origin;
  const entry = ENTRIES.find((p) => p in files);
  // Code first, data last: an agent reads the page before the numbers behind it.
  const rest = Object.keys(files).filter((p) => p !== entry).sort((a, b) => Number(a.startsWith("data/")) - Number(b.startsWith("data/")) || byPath(a, b));
  const inline = entry === "index.mdx" || entry === "index.md";
  const bytes = (p: string) => new TextEncoder().encode(files[p]).length;
  const out: string[] = [`# ${meta.title}`];

  const about = [`Exported from ${PRODUCT}: ${url}`, `Version ${meta.version}, updated ${meta.updatedAt.slice(0, 10)}.`, ...(meta.description ? meta.description.split(/\r?\n/) : [])];
  out.push(about.map((l) => (l ? `> ${l}` : ">")).join("\n>\n"));

  const notes: string[] = [];
  if (entry === "index.mdx") {
    notes.push("The page is MDX: Markdown plus components such as `<Table>`, `<Chart>`, `<Stat>` and `<Callout>`. A component with `data=\"x.json\"` shows the values in `data/x.json`, which are only in that file's section below.");
  } else if (entry === "app.tsx") {
    notes.push("The page is a React app; `app.tsx` is its entry.");
  }
  notes.push("Live parts (comments, votes, checklist ticks, form answers) aren't included.");
  if (assets.length) notes.push("Uploaded files under `assets/` (images and the like) are listed but not included.");
  out.push(notes.join(" "));

  const list = [
    ...(entry ? [`- \`${entry}\` (${size(bytes(entry))}): the page${inline ? ", inlined below" : ""}`] : []),
    ...rest.map((p) => `- \`${p}\` (${size(bytes(p))})`),
    ...assets.map((a) => `- \`${a.path}\` (${a.contentType}, ${size(a.bytes)}): not included`),
  ];
  if (list.length > 1 || assets.length) out.push(`Files:\n\n${list.join("\n")}`);

  if (entry) {
    out.push("---");
    if (inline) {
      // Links to other artifacts here work from anywhere once they're absolute.
      let body = files[entry].replace(/\]\((\/a\/[a-z0-9]+[^)\s]*)\)/g, (_, path: string) => `](${origin}${path})`);
      // Its own heading is the title above when they match; a different first heading stays.
      const first = /^[ \t]*#[ \t]+(.*)\r?\n?/.exec(body.replace(/^\s*\n/, ""));
      if (first && first[1].trim() === meta.title.trim()) body = body.replace(/^\s*\n/, "").slice(first[0].length);
      out.push(body.trim());
    } else {
      out.push(`### File: ${entry}\n\n${fence(files[entry], langOf(entry))}`);
    }
  }
  if (rest.length) {
    out.push("---");
    out.push(rest.map((p) => `### File: ${p}\n\n${fence(files[p], langOf(p))}`).join("\n\n"));
  }
  out.push("---");
  out.push(`End of the export of ${url}.`);
  return `${out.join("\n\n")}\n`;
}

# Shared Artifacts guide

An artifact is a small set of files rendered as a page at `/a/<id>`. Only the
owner and people it's shared with can open it. They sign in with a one-time
email code, so they need no account.

## Files

- **One entry file, exactly:**
  - `index.mdx` (default; Markdown plus components, no imports needed) for reports, briefs, plans, and decisions.
  - `index.md` for plain Markdown.
  - `app.tsx` (`export default function App()`) for interactive tools.
- **Extra modules:** optional `*.tsx` or `*.ts` files, imported by relative path, for example `import Chart from "./chart"`.
- **Data:** put data in `data/*.json` and read it with `useData("rows.json")`, or pass `data="rows.json"` to `Table` and `Chart`. Never inline large data in code. Data files are what `artifact_patch_data` edits cheaply.
- **Imports:** only `react`, `@a/ui`, `@a/hooks`, `lucide-react` and `recharts`, plus relative files. There is no network: `fetch`, external images and external scripts are blocked.
- **Visuals:** reach for one whenever a picture reads faster than prose. There are two tools, and nothing else draws: no hand-made SVG, positioned divs, ASCII art or images of diagrams.
  - `Chart` for line, bar, area and pie charts of numbers, bound to a `data/*.json` file (tooltips, legend, cheap `artifact_patch_data` updates). `Sparkline` and `Stat` for inline trends and KPIs.
  - Mermaid for everything else: flows, sequences, states, data models, architecture, plans and schedules (gantt, timeline, kanban), org and mind maps, and the quantitative shapes `Chart` lacks (quadrant, sankey, radar, treemap, venn). Write a ```` ```mermaid ```` fenced block in MDX or Markdown, or `<Diagram code={...} />` in TSX. It renders as themed, responsive SVG; syntax errors come back from the write with a line number. Mermaid `pie` and `xychart` are rejected: use `Chart`.
  - The full list of Mermaid types and when to pick each is in the kit reference below.
- **Images and files:** upload them with `artifact_asset` (path `assets/<name>`), then use `![alt](assets/logo.png)` in MDX or `useAsset("assets/logo.png")` in code.
- **Live data:** `artifact_source` keeps a `data/*.json` file updated from a public HTTPS JSON URL every 15 minutes or more. Nothing is fetched until the user approves the URL's host in the artifact's owner menu; tell them when that's needed.
- **Styling:** Tailwind classes work. Use the theme tokens (`bg-muted`, `text-muted-foreground`, `border`, `text-primary`, `bg-card`) rather than raw colors so artifacts match the (dark-only) theme.

## Storage

- **Shared state:** `useShared` and `useSharedMap`, and the stateful components (`Poll`, `Checklist`, `Comments`, `Notes`), sync live between everyone viewing. Writes are last-writer-wins per key, so for lists use one key per item (`useSharedMap`). People with view access, and anonymous public visitors, see shared state read-only.
- **Per-viewer browser storage:** `useLocal(key, default)`. Plain `localStorage` also works.

## Editing

- **Change, don't recreate:** never create a new artifact to change an existing one.
- **Find before reading:** use `artifact_grep` or a ranged `artifact_read` to locate text, then `artifact_edit` with an `oldText` that matches exactly once.
- **Data changes:** use `artifact_patch_data` (JSON Patch) instead of rewriting the file.
- **New files or rewrites:** use `artifact_write_files`. Pass `null` to delete a file.
- **Validation:** every write is compiled and checked for unknown components and import names. On any error nothing is saved and the errors come back; fix them and retry.
- **Render check:** after a successful write, the artifact is rendered in a headless browser and the result is part of the tool response. `artifact_create` and `artifact_check` also attach a screenshot of the first screen; look at it and fix layout problems before reporting. If it reports "Render check FAILED", the version is saved but broken for viewers: fix it with `artifact_edit` right away. `artifact_check` re-runs the check.
- **Version checks and undo:** pass `baseVersion` to guard against concurrent edits. Use `artifact_history` and `artifact_revert` to undo.

## Feedback from readers

- **Comments:** readers can comment on any text, block, table row or the whole page. Each thread records the block it points at (`block` ids follow the outline: a heading's slug, then `<section>-1`, `<section>-2` for the blocks under it), the quoted text and the version it was written on.
- **Pick up feedback:** call `artifact_activity` (all artifacts, or one `id`) to see new threads, replies, votes, checklist ticks and versions since your last cursor. `artifact_threads` lists an artifact's open threads with every comment.
- **Act on it:** fix the artifact with the usual edit tools and pass `note` (one line readers will see, e.g. "Split costs per seat") and `resolves` (the thread ids you addressed). Those threads show "Addressed in vN" and their authors are notified. Reply with `artifact_comment` when you need to answer a question or explain why you didn't change something.
- **Notes matter:** every edit's `note` appears in history, in the "Updated since you last looked" bar readers see, and in update notifications. Without one, readers see "edit index.mdx".

## Sharing

- **People:** `artifact_share` adds people by email with role `view` or `edit`, removes people, or sets `public: true` for a read-only link anyone can open.
- **Domains:** share with `"@example.com"` to let everyone with a verified email at that domain in. A person's own entry overrides the domain role. Make an `artifact_link` per person, or they sign in with their email.
- **Link previews:** links pasted into Slack, iMessage and similar apps show a generic card for private artifacts. `artifact_update` with `preview: true` shows the title, description and a screenshot instead; only do that when the user asks.
- **Links:** to hand the user an artifact, give them an `artifact_link` URL (it defaults to the owner and opens with no login). `artifact_share` returns a sign-in link for each person it adds. Each link signs in as one email, so a link goes only to its own person.

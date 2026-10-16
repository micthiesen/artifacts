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

## Sharing

- **People:** `artifact_share` adds people by email with role `view` or `edit`, removes people, or sets `public: true` for a read-only link anyone can open.
- **Domains:** share with `"@example.com"` to let everyone with a verified email at that domain in. A person's own entry overrides the domain role. Make an `artifact_link` per person, or they sign in with their email.
- **Links:** to hand the user an artifact, give them an `artifact_link` URL (it defaults to the owner and opens with no login). `artifact_share` returns a sign-in link for each person it adds. Each link signs in as one email, so a link goes only to its own person.

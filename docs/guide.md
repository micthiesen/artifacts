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
- **Imports:** only `react`, `@a/ui`, `@a/hooks`, `lucide-react` and `recharts`, plus relative files. There is no network: `fetch`, external images and external scripts are blocked. Use data files instead, and data: URLs for small images.
- **Styling:** Tailwind classes work. Use the theme tokens (`bg-muted`, `text-muted-foreground`, `border`, `text-primary`, `bg-card`) rather than raw colors, so light and dark mode both work.

## Storage

- **Shared state:** `useShared` and `useSharedMap`, and the stateful components (`Poll`, `Checklist`, `Comments`, `Notes`), sync live between everyone viewing. Writes are last-writer-wins per key, so for lists use one key per item (`useSharedMap`). People with view access, and anonymous public visitors, see shared state read-only.
- **Per-viewer browser storage:** `useLocal(key, default)`. Plain `localStorage` also works.

## Editing

- **Change, don't recreate:** never create a new artifact to change an existing one.
- **Find before reading:** use `artifact_grep` or a ranged `artifact_read` to locate text, then `artifact_edit` with an `oldText` that matches exactly once.
- **Data changes:** use `artifact_patch_data` (JSON Patch) instead of rewriting the file.
- **New files or rewrites:** use `artifact_write_files`. Pass `null` to delete a file.
- **Validation:** every write is validated and compiled. On any error nothing is saved and the errors come back; fix them and retry.
- **Version checks and undo:** pass `baseVersion` to guard against concurrent edits. Use `artifact_history` and `artifact_revert` to undo.

## Sharing

- **People:** `artifact_share` adds people by email with role `view` or `edit`, removes people, or sets `public: true` for a read-only link anyone can open.
- **Links:** give the user the URL that the create or share call returned.

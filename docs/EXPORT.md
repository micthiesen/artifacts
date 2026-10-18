# Exporting a workspace

Workspace admins can download everything in their workspace from
**Settings → Export your data**, any time. There's no lock-in: the export is
the same data the service runs on, in plain JSON, and the
[source](../README.md) can run it on your own Cloudflare account.

The download is the latest nightly backup (made at 10:00 UTC on days
something changed). **Back up now** makes a fresh one, at most once an hour.

## Format

One [JSON Lines](https://jsonlines.org/) file, `<workspace>-<backup time>.jsonl`:

- **Line 1**, a header: `format` (`"artifacts.boo/export@1"`), `workspace`,
  `run` and `at` (when the backup was made), `schema` (the database version)
  and `tables` (row counts).
- **Then one line per page** of a table: `{"table": "...", "rows": [...]}`.
  A table can span several lines. Binary values (asset files, screenshots)
  are `{"$b64": "..."}`.
- **The last line** is `{"end": true, "pages": n}`. A file without it was cut
  off (a dropped connection, or the backup was pruned while downloading);
  download it again.

A backup of a workspace over about 8 MB is read page by page, so it isn't a
single instant: something saved during the backup may appear in some tables
and not others.

The tables, as an agent would use them:

| Table | Holds |
|---|---|
| `artifacts` | One row per artifact: id, title, description, owner, current version, sharing flags, archived time |
| `files` | Each artifact's current files: `path` → content `hash` |
| `blobs` | File contents by `(artifact_id, hash)`; join with `files` for the current version |
| `history` | Recent versions (the latest 50 per artifact): each one's `files` map (path → hash), note and time |
| `assets` | Uploaded images and files (`data` is base64) |
| `state` | Shared state: poll votes, approvals, form responses, checklists, notes, `useShared` keys (`value` is JSON) |
| `threads`, `comments` | Comment threads, what they point at, and every comment |
| `shares` | Who each artifact is shared with, and their role |
| `members` | Workspace members and roles |
| `events` | The activity log (the latest 5,000 events per artifact) |
| `seen`, `watches`, `pins` | Each person's last visit, notification levels and pinned artifacts |
| `sources`, `allowed_hosts`, `join_domains` | Live data sources and workspace settings |
| `tokens`, `grants` | Agent tokens (hashes only, never the token) and OAuth grants |
| `builds`, `checks`, `errors` | Compiled pages, render-check results and screenshots, and errors viewers' browsers reported |
| `outbox`, `removed_members` | Notifications waiting to go out (with comment text), and people an admin removed |

Treat the file as sensitive: besides everything people wrote, a live data
source's `url` can carry an API key in its query string.

To rebuild an artifact's current files: for each `files` row of the
artifact, take the `blobs` row with the same `artifact_id` and `hash`; its
`content` is the file. An older version's files come from its `history` row
the same way.

Prompt for an agent: "Read this artifacts.boo export (JSON Lines, described
at docs/EXPORT.md) and write each artifact's current files to a folder named
after its title."

To load an export into a workspace of your own deployment (this replaces
everything in that workspace): `bun scripts/import.ts <slug> <file>.jsonl`.

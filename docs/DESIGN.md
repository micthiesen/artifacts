# Design

Shared Artifacts lets agents publish small interactive pages that verified
people can open, with per-viewer browser storage and live shared state. Agents
write and edit artifacts only through the MCP server. One Cloudflare Worker
serves everything from `workers.dev`.

## Pieces

| Piece | Where | Role |
|---|---|---|
| Worker `artifacts` | `src/worker/` | Routes, sessions, MCP, compile-on-write, frame documents |
| Durable Object `ArtifactHub` | `src/worker/hub.ts` | One SQLite instance: artifacts, files, history, ACL, shared state, sync WebSockets |
| Worker `artifacts-auth` | `src/auth/` | Sits behind Cloudflare Access (email one-time PIN). Turns a verified Access identity into a signed one-time code for the main Worker |
| Shell | served by the Worker at `/a/<id>` | Parent page: title bar, owns the sync WebSocket and browser storage, bridges them to the frame |
| Frame | `/frame/<id>?v=<version>&t=<token>` | Sandboxed document (`Content-Security-Policy: sandbox allow-scripts ...`, opaque origin, no network) that renders the artifact |
| Kit | `src/kit/`, built to `dist/kit/` and served at `/kit/v1/` | React, `@a/ui` components, `@a/hooks`, the frame runtime, `lucide-react`, `recharts`, Pele (Mermaid diagrams, lazy-loaded per diagram type), theme CSS |

## Security model

- **Login:** a viewer signs in once through Access (email PIN) on the auth Worker. The main Worker then issues its own `__Host-` session cookie, signed with HMAC. Every request checks the artifact's ACL, so removing an email takes effect on that viewer's next request.
- **Frames:** each frame gets an opaque origin, through both the CSP `sandbox` directive and the iframe `sandbox` attribute. It can't read the shell's cookies or storage, or another artifact's. The CSP blocks all network access except kit scripts, styles and fonts, so artifact code can't exfiltrate data.
- **Frame storage:** browser storage and shared state reach the frame only through the shell's postMessage bridge (`src/shared/protocol.ts`). The shell scopes both to one artifact.
- **Frame URL token:** it carries a short-lived HMAC bound to artifact, version and viewer. Its only power is to fetch that frame document.
- **MCP:** requires a bearer token. Agent writes are compiled and validated, and are rejected atomically if any file fails.

## Artifact format

An artifact is a set of files with exactly one entry: `index.mdx`, `index.md`
or `app.tsx`. Other `*.tsx` files are importable by relative path, and
`data/*.json` files are readable with `useData(path)`. Allowed imports:
`react`, `@a/ui`, `@a/hooks`, `lucide-react`, `recharts`, and relative files.
MDX files get every `@a/ui` component without imports, through
`useMDXComponents`.

Compile turns each source file into an ES module and rewrites relative imports
to `@art/<path>` specifiers. The frame's import map points those at data URLs,
and points the bare kit specifiers at `/kit/v1/*.js`. Tailwind classes used in
artifact source are compiled into a per-version stylesheet on top of the kit
CSS.

## Write-time checks

- **Static, at compile time:** every write is checked before saving. Syntax errors, imports outside the allowlist, named imports a module doesn't export (from the generated `src/worker/kit-exports.json`, which covers lucide icons too), and MDX components the kit doesn't provide all reject the write, with "did you mean" suggestions.
- **Render check, after saving:**
  - Cloudflare Browser Run loads the frame top-level in check mode. The runtime boots without a shell and writes `<pre id="art-check">{status, errors, textLength}</pre>`, which the Worker scrapes.
  - Check-mode frames are the only frames served without the CSP `sandbox` directive: Browser Run doesn't execute module scripts from an opaque origin. They still have `connect-src 'none'`, need a 2-minute token, and the checker's browser has no cookies.
  - Browser Run's scrape doesn't reliably honour `waitForSelector`, so the check also waits for network idle plus 1.5 s.
- **Rate limit:** the free plan allows one Browser Run call every 10 s. The hub reserves slots, waits inline when the next slot is under 8 s away, and otherwise queues the check on a Durable Object alarm. Results are stored per version and failures go to `artifact_errors`.

## Assets, live data and the owner menu

- **Assets:** `artifact_asset` stores files (≤1.5 MB, ≤20 MB per artifact) in the hub's SQLite. Frames get `/asset/<id>/<path>?t=<frame token>` URLs in their boot data, and the frame CSP allows only that path for images and media. Assets are served with a `sandbox` CSP so an SVG opened directly can't run script.
- **Live data:** `artifact_source` maps a `data/*.json` file to an HTTPS JSON URL with an interval (15 min to 7 days) and an optional dot-path `pick`. A 15-minute Worker cron calls the hub, which fetches due sources (no credentials, 10 s timeout, 1 MB cap) and swaps the file and build in place without a new version or render check. Only hosts the owner approved in the owner menu (`allowed_hosts`) are fetched. Agents can't approve hosts, because the MCP has no tool for it.
- **Owner menu:** `/api/a/<id>` gives the owner an overview, and `POST /api/a/<id>/<tool>` runs a whitelisted subset of the MCP tools (share, link, rename, revert, delete, source, check), so the UI and agents share one validated code path.

## Comments, activity and visits

- **Threads:** `threads` and `comments` tables in the hub. Any signed-in viewer who can open an artifact may comment (view role included); shared state still needs edit access. Writes go over the sync socket (`comment`, `resolve`, `comment:delete`) and are broadcast as `thread` messages. MCP replies are stored with author `"agent"`.
- **Anchors:** compile gives every top-level MDX block a `data-b` id (heading slug, then `<section>-<n>`; components are wrapped in a `div`) and a content hash, stored per version in `history.blocks`. A thread stores `{block, row, quote: {exact, prefix, suffix}, label}`. The frame runtime (`src/kit/annotate.ts`) re-finds anchors on every render, draws them with the CSS Custom Highlight API (no DOM changes around the text) and reports each as anchored, outdated (block there, text changed) or orphaned. The drawer lives in the shell, so artifact code can't read or forge comments.
- **Stamped collab keys:** socket writes to `poll/`, `comments/`, `check/` and `notes/` keys are validated and stamped with the verified email: a vote must be your own, and only a comment's author (or an owner) can change or delete it.
- **Activity log:** `events` (append-only, `seq` cursor, last 5000 per artifact) records versions with notes, threads, replies, resolves and shared-state changes (coalesced per key and person per minute). `artifact_activity` reads it with a cursor; there is no server-side model.
- **Visits:** opening an artifact records the version in `seen`. The next visit gets the versions since, the blocks whose hash changed and removed headings, for the shell's "Updated since you last looked" bar. `read_seq` drives unread counts on the index. A commit broadcasts `{t:"version"}` so open pages show an "Updated" pill.

## Notifications

- **Who:** owners default to every comment on their artifacts; everyone else to replies in their threads and @mentions. Per-artifact levels (`watches`: all, participating, mute) are set from the avatar menu or `/me`. Page updates reach "all" watchers other than owners. Nobody is notified about their own actions or while they have the artifact open.
- **When:** events add rows to `outbox`; one Durable Object alarm (shared with the render-check queue) fires 45 s after a comment or 10 min after an update (coalescing bursts, at most 30 min), groups rows per person and artifact into one message and sends at most 40 per run (free-plan subrequest limit), re-arming if more remain. No cron.
- **Channels** (`channels`, managed at `/me`): Web Push (VAPID keys in the Worker env; iOS needs the site added to the Home Screen), Pushover (one operator app token, `PUSHOVER_TOKEN`; users paste their user key, validated on save), ntfy (random private topic; ntfy.sh rate-limits anonymous publishing from shared Worker IPs, so users add an ntfy.sh access token or their own server), and webhooks (HMAC-signed JSON; Discord webhook URLs get Discord's format). Adapters are hand-written `fetch` calls in `src/worker/notify.ts`; Web Push encryption (RFC 8291) is in `webpush.ts`. A channel is paused after 5 failures and deleted when a push endpoint returns 404/410.

## Link previews and print

- **Previews:** requests from link-preview fetchers (Slackbot, Discordbot, iMessage's facebookexternalhit, …) get a 200 card before any sign-in redirect. Private artifacts get a generic card; owners can opt in per artifact (`preview`), and public artifacts always get the title, description and the latest render-check screenshot at a signed `/og/<id>.jpg` URL. Presigned `/s/` links are never redeemed by a fetcher.
- **Print:** the avatar menu asks the frame to print its own document (`allow-modals` is in the sandbox). `src/kit/print.ts` expands tabs, accordions and limited tables first; `print.css` switches to a light palette and hides interactive UI.

## Backups

`GET /admin/export` (bearer MCP token) returns every table as JSON (including notification channel configs, so treat exports as secrets) (`bun scripts/export.ts` saves it locally), and `POST /admin/import` loads one back, replacing everything in one transaction (`bun scripts/import.ts`). With an R2 bucket bound, the 10:00 UTC cron also writes a dated copy there and keeps 30. A point-in-time restore endpoint was tried and removed: on 2026-10-16, Durable Object bookmark restores on a test stage didn't land at the requested times, especially after an earlier restore.

## Presigned links

`artifact_link` and `artifact_share` return `/s/<code>` links. Each code is an HMAC token (`LOGIN_SECRET`) naming an email and an artifact, valid for 7 days by default and 30 at most. Opening a link re-checks that the email is the owner or on the share list, sets a normal session cookie and redirects to the artifact. Email sign-in through Access is the fallback once a link expires.

## Shared state

Shared state is a key-value map per artifact. The last write per key wins, in
the order the server receives writes, and the server numbers each write with a
`seq`. To avoid lost concurrent adds in a list, use one key per item, such as
`todo/<uuid>`. The shell keeps a WebSocket to the hub, which uses WebSocket
hibernation. View-role viewers and anonymous public viewers can read shared
state but not write it.

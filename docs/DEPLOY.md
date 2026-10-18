# Deploy

Deploys use [Alchemy](https://alchemy.run) with Cloudflare credentials from an
Alchemy profile (`alchemy login` or `~/.alchemy/profiles/<name>`). One deploy
creates everything: the Worker and its Durable Objects, the wildcard DNS record
and route for workspace subdomains, the sign-in email sender, the OAuth KV
namespace, the backup bucket and every generated secret (sessions, sign-in
links, OAuth consent, Web Push keys).

## Requirements

- **Plan:** Workers Paid on the account. Sending sign-in codes to any address needs it.
- **Domain:** a zone on Cloudflare DNS. The apex is the front door, `<slug>.<domain>` serves each workspace, and `mail.<domain>` sends sign-in codes.
- **Deploy token:** Workers Scripts, Routes, KV and R2 edit; DNS and Zone edit on the zone; Email Sending edit; SSL and Certificates read.

## Configuration

`.env` (gitignored) in the repo root:

| Key | Meaning |
|---|---|
| `DOMAIN` | The zone, e.g. `artifacts.boo` |
| `OPERATOR_EMAILS` | Comma-separated emails that see the operator console at `/admin` |
| `OPERATOR_TOKEN` | A random string; the operator API's bearer token for local scripts |
| `PUSHOVER_TOKEN` | Optional: one Pushover application token shared by every user's Pushover channel |

## Deploy and first workspace

```sh
bun run deploy
```

Then sign in at `https://<domain>/admin` with an operator email and create a
workspace with its first admin. That admin adds members from the workspace's
settings page, where each member also finds the MCP URL for their agent.

Other stages (`alchemy deploy --stage <name>`) serve the apex at
`<stage>.<domain>` and workspaces at `<slug>--<stage>.<domain>`, reusing prod's
wildcard DNS record, so deploy prod first.

## Operating

- **Backups:** each workspace backs itself up to R2 at 10:00 UTC on days it changed, keeping 30 runs, as a resumable job. The operator console starts a backup, or a restore (which backs up first and takes the workspace offline until it's loaded), and shows each job's progress.
- **Off-Cloudflare copy:** `bun scripts/export.ts <slug|directory>` writes `exports/<slug>-<time>.json`; `bun scripts/import.ts <slug|directory> <file>` replaces that data with it (the workspace is offline while it loads).
- **Fixing a workspace:** from `/admin`, add or replace its admins (say, a mistyped first admin) without a role inside it.
- **Schema changes:** add a numbered migration (`src/worker/migrate.ts`); each workspace applies it the first time it wakes after the deploy. Migrations only go forward: once objects have migrated, older code refuses to run against them, so fix forward rather than rolling back.
- **Test addresses:** mail to reserved test domains (example.com, .test, .invalid) is never sent; the end-to-end checks use them, and the operator API gives them sign-in codes and sessions directly.

## Checks

- `bun run test` and `bun run typecheck` locally.
- `bun run e2e` and `bun spikes/e2e-collab.ts` against the deployment. Each makes a throwaway workspace and deletes it afterwards; the second waits about a minute for a notification alarm. New Worker code can take a minute to reach every edge location, so wait that long after a deploy.

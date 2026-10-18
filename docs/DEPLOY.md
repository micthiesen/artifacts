# Deploy

Deploys use [Alchemy](https://alchemy.run) with Cloudflare credentials from an
Alchemy profile (`alchemy login` or `~/.alchemy/profiles/<name>`). Each stage
targets one account, so a personal and a work instance are separate stages run
with different profiles.

## Configuration

Create `.env` (gitignored) in the repo root:

| Key | Meaning |
|---|---|
| `DOMAIN` | Optional: a zone in the account, e.g. `artifacts.boo`. Prod serves at the apex, the sign-in Worker at `auth.<domain>`, other stages at `<stage>.<domain>`, and `workers.dev` is turned off. The deploy token needs Workers Routes and Zone edit on that zone |
| `WORKERS_SUBDOMAIN` | The account's `workers.dev` subdomain. Only used when `DOMAIN` is unset |
| `OWNER_EMAILS` | Comma-separated emails with owner access to every artifact |
| `SESSION_SECRET`, `LOGIN_SECRET`, `MCP_TOKEN` | Random strings, e.g. `python3 -c 'import secrets;print(secrets.token_urlsafe(32))'` |
| `ACCESS_TEAM_DOMAIN` | Optional: `https://<team>.cloudflareaccess.com`. Enables viewer sign-in |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Optional: Web Push keys from `bun scripts/vapid.ts`. Keep them: changing them invalidates every browser subscription |
| `VAPID_SUBJECT` | Optional: contact for push services, default `mailto:<first owner>` |
| `PUSHOVER_TOKEN` | Optional: one Pushover application token (pushover.net/apps/build) shared by every user's Pushover channel; users then only paste their user key |

Without `ACCESS_TEAM_DOMAIN`, only public artifacts can be viewed, and agents
still work through MCP.

## Viewer sign-in (Cloudflare Access)

1. **Zero Trust:** create a Zero Trust organization (free for up to 50 users) and add the One-time PIN login method.
2. **Token:** give the deploy token Access: Apps and Policies → Edit, and Access: Organizations, Identity Providers, and Groups → Read.
3. **Deploy:** set `ACCESS_TEAM_DOMAIN` (e.g. `https://<team>.cloudflareaccess.com`) and deploy. Alchemy creates the "Shared Artifacts sign-in" Access application (one-time PIN only, allow everyone) in front of the `<worker>-auth` Worker (at `auth.<domain>`, or its `workers.dev` URL) and passes its AUD tag to it. Per-artifact sharing is enforced by the main Worker.

## Presigned links

Agents call `artifact_link` (or read the links `artifact_share` returns) to get
`/s/<code>` URLs. Each one signs a browser in as one email and opens one
artifact, without Access. It's valid for 7 days by default (30 at most), and it
only grants what that email already has. Rotating `LOGIN_SECRET` invalidates
every outstanding link.

## Backups

- **Nightly offsite copy (optional):** with `R2_BACKUPS=1` in `.env` and R2 edit permission on the deploy token, Alchemy creates a bucket, and the 10:00 UTC cron writes `exports/<date>.json` to it, keeping 30 days. `POST /admin/backup` (bearer MCP token) runs it immediately.

- **Off-Cloudflare copy:** `bun scripts/export.ts <origin>` writes `exports/artifacts-<time>.json` (gitignored).
- **Restoring:** `bun scripts/import.ts <origin> exports/<file>.json` replaces all data with that export, in one transaction. Export the current state first if you might want it back.

## Checks

- `bun run test` and `bun run typecheck` locally.
- `bun run e2e <origin>` and `bun spikes/e2e-collab.ts <origin>` against a deployment. The second covers comments, the MCP feedback tools, visits, previews and notification delivery (it waits about a minute for the notification alarm).

## After deploying

New Worker code can take up to a minute to reach every edge location. Wait
before running `bun run e2e <origin>`, or the first checks may hit the old
version.

## Connect agents

Add an MCP server named **Shared Artifacts** pointing at
`https://<domain>/mcp` (or `https://<worker>.<subdomain>.workers.dev/mcp` without `DOMAIN`) with header
`Authorization: Bearer <MCP_TOKEN>`.

# Deploy

Deploys use [Alchemy](https://alchemy.run) with Cloudflare credentials from an
Alchemy profile (`alchemy login` or `~/.alchemy/profiles/<name>`). Each stage
targets one account, so a personal and a work instance are separate stages run
with different profiles.

## Configuration

Create `.env` (gitignored) in the repo root:

| Key | Meaning |
|---|---|
| `WORKERS_SUBDOMAIN` | The account's `workers.dev` subdomain |
| `OWNER_EMAILS` | Comma-separated emails with owner access to every artifact |
| `SESSION_SECRET`, `LOGIN_SECRET`, `MCP_TOKEN` | Random strings, e.g. `python3 -c 'import secrets;print(secrets.token_urlsafe(32))'` |
| `ACCESS_TEAM_DOMAIN` | Optional: `https://<team>.cloudflareaccess.com`. Enables viewer sign-in |
| `ACCESS_AUD` | Required with `ACCESS_TEAM_DOMAIN`: the AUD tag of the auth Worker's Access application |

Without `ACCESS_TEAM_DOMAIN`, only public artifacts can be viewed, and agents
still work through MCP.

## Viewer sign-in (Cloudflare Access)

1. Create a Zero Trust organization (the free plan covers 50 users) and enable
   the One-time PIN login method.
2. Give the deploy credentials Access permissions: Access: Apps and Policies
   Edit, plus Access: Organizations, Identity Providers, and Groups Read.
3. Set `ACCESS_TEAM_DOMAIN` and deploy. Alchemy creates the `artifacts-auth`
   Worker and its Access application, with an allow-everyone policy (any email
   that passes the PIN). Per-artifact sharing is enforced by the main Worker.
4. Copy the application's AUD tag into `ACCESS_AUD` and deploy again.

## Presigned links

Agents call `artifact_link` (or read the links `artifact_share` returns) to get
`/s/<code>` URLs. Each one signs a browser in as one email and opens one
artifact, without Access. It's valid for 7 days by default (30 at most), and it
only grants what that email already has. Rotating `LOGIN_SECRET` invalidates
every outstanding link.

## After deploying

New Worker code can take up to a minute to reach every edge location. Wait
before running `bun run e2e <origin>`, or the first checks may hit the old
version.

## Connect agents

Add an MCP server named **Shared Artifacts** pointing at
`https://<worker>.<subdomain>.workers.dev/mcp` with header
`Authorization: Bearer <MCP_TOKEN>`.

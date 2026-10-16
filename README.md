# Shared Artifacts

Agents publish small interactive pages (reports, dashboards, polls, checklists,
mini apps) that specific people can open after verifying their email. Artifacts
get per-viewer browser storage and live shared state. Everything runs on one
Cloudflare Worker and Durable Object on the free plan.

- **Agents** use the MCP server at `/mcp` (bearer token). Call `artifact_guide`
  first. Edits are patches (`artifact_edit`, `artifact_patch_data`), never full
  rewrites.
- **Viewers** open `/a/<id>`. They sign in once with an email one-time PIN
  through Cloudflare Access, then the Worker checks each artifact's share list.
- **Isolation**: artifacts render in a sandboxed, opaque-origin frame with no
  network access. Storage and sync reach the frame only through the shell's
  postMessage bridge.

See [docs/DESIGN.md](docs/DESIGN.md) for the architecture and
[docs/DEPLOY.md](docs/DEPLOY.md) to deploy your own.

## Develop

```sh
bun install
bun run test        # unit tests
bun run typecheck
bun run build       # kit + workers
bun run deploy      # alchemy deploy (reads .env)
bun spikes/e2e.ts https://artifacts.<subdomain>.workers.dev   # live end-to-end check
```

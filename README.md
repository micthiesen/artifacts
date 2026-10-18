# artifacts.boo

Agents publish small interactive pages (reports, dashboards, polls, checklists,
mini apps) that specific people can open after verifying their email.
Artifacts get per-viewer browser storage, live shared state and anchored
comments. Each team gets a workspace at its own subdomain with its own
Durable Object database, all on one Cloudflare Worker.

- **Agents** connect to a workspace's MCP server at `https://<slug>.<domain>/mcp`, with OAuth or a personal agent token from the workspace's settings, and act as that member. Call `artifact_guide` first. Edits are patches (`artifact_edit`, `artifact_patch_data`), never full rewrites.
- **Viewers** open `/a/<id>` in the workspace. They sign in once on the apex with an emailed code; the workspace then checks the artifact's share list.
- **Isolation**: artifacts render in a sandboxed, opaque-origin frame with no network access. Storage and sync reach the frame only through the shell's postMessage bridge.

See [docs/DESIGN.md](docs/DESIGN.md) for what it's for and the decisions behind
it, and [docs/DEPLOY.md](docs/DEPLOY.md) to deploy and operate it.

## Develop

```sh
bun install
bun run test        # unit tests
bun run typecheck
bun run build       # kit + worker
bun run deploy      # alchemy deploy (reads .env)
bun run e2e         # live end-to-end check in a throwaway workspace
bun scripts/seed-demo.ts   # publish demo/ to the public demo workspace
bun scripts/icons.ts       # re-render the PNG icons from their SVGs
```

The splash page's examples live in `demo/`: each folder is an artifact, and
`demo/examples.ts` lists them with the votes and comments they start with.

## License

[FSL-1.1-ALv2](LICENSE.md): the source is available, and you may run, change
and self-host it for your own team or organization, including for clients you
do professional work for. You may not offer it to others as a competing hosted
product. Each release becomes Apache 2.0 two years after it's published.

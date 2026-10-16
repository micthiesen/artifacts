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
| Kit | `src/kit/`, built to `dist/kit/` and served at `/kit/v1/` | React, `@a/ui` components, `@a/hooks`, the frame runtime, `lucide-react`, `recharts`, theme CSS |

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

## Shared state

Shared state is a key-value map per artifact. The last write per key wins, in
the order the server receives writes, and the server numbers each write with a
`seq`. To avoid lost concurrent adds in a list, use one key per item, such as
`todo/<uuid>`. The shell keeps a WebSocket to the hub, which uses WebSocket
hibernation. View-role viewers and anonymous public viewers can read shared
state but not write it.

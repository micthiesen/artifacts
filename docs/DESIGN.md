# Design

Artifacts lets agents publish small interactive pages (reports, dashboards,
polls, checklists, mini apps) that specific people open in a browser, with
per-viewer storage, live shared state and comments. This document records what
the system is for and the decisions behind it. The code is the reference for
how each piece works.

## Goals

- **One person or a whole team.** The same deployment serves the owner's own
  workspace and paying teams. Nothing about the owner's daily use gets harder
  because other workspaces exist.
- **No fixed cost per workspace.** An idle workspace costs only its stored
  bytes. Everything runs on one Worker on Workers Paid; there are no servers,
  databases or per-tenant resources to provision.
- **No manual operations.** Alchemy creates every Cloudflare resource,
  including DNS, routes, the email sender and generated secrets. Schema
  changes ship as code and apply themselves.
- **Agents write, people read and react.** Agents create and edit artifacts
  only through MCP. People view, comment, vote and edit shared state in the
  browser. Owners manage sharing from the page.

## Workspaces

A workspace is the unit of tenancy, isolation and (later) billing. Each one is
its own Durable Object with its own SQLite database, served at
`<slug>.<domain>`. The hostname picks the database, so a request never
consults anything global to find its data, and one workspace's load or size
never affects another's.

Each workspace origin is also a separate browser origin, so sessions, storage
and service workers are separated by the browser as well as by the server.

A small global directory records which workspaces exist, who belongs to which,
and per-person settings that should follow someone everywhere (display name,
notification channels). It is consulted at sign-in, when a workspace is
created and when notifications go out, never on ordinary page loads.

The apex domain is the front door: a splash page, sign-in, the list of your
workspaces, your notification settings and the operator console.

## People and roles

- **Operator**: whoever runs the deployment (`OPERATOR_EMAILS`). Creates,
  suspends and deletes workspaces and sees their usage from `/admin` on the
  apex, and can export, back up and restore any workspace's data. Being
  operator grants no role inside a workspace: no sign-in as anyone, no agent
  access. The end-to-end checks' test identities only accept reserved test
  domains (example.com, .test, .invalid).
- **Workspace admin**: manages members, agent tokens and approved data hosts,
  and can manage every artifact in the workspace, so nothing is stranded when
  someone leaves.
- **Member**: connects their own agent and creates artifacts. Sees artifacts
  they own and ones shared with them or with the whole workspace.
- **Guest**: anyone with a verified email who has been shared on a specific
  artifact. Guests need no membership, which is how outside clients are
  invited and why they can stay free when members are billed.

Per artifact, the owner (whose agent created it) and admins manage it; shares
grant `edit` (shared state) or `view`. An agent acts as the person whose token
or OAuth grant it uses, with that person's access.

## Sign-in

People sign in once on the apex with an emailed one-time code; workspaces
receive a short-lived signed hand-off and set their own session cookie.
Presigned links sign one person straight into one artifact, and that session
opens only that artifact; the rest of the workspace needs a real sign-in. Codes are
rate-limited per address and globally, because anyone can request one.

Agents connect with OAuth (each workspace is its own authorization server and
MCP resource) or with a personal token created on the workspace's settings
page, for clients that can't run a browser sign-in. Both identify a person.

## Isolation

Artifact code is untrusted. It renders in a sandboxed, opaque-origin frame
with no network access; storage, shared state and comments reach it only
through the shell's postMessage bridge, and the shell scopes all of them to
one artifact. Comments live in the shell, so artifact code can't read or
forge them. Every write from a person is checked against their role on the
server, and collab keys (votes, comments, checklists) are stamped with the
verified email.

## Data and schema changes

- **Migrate forward, never carry compatibility.** Each Durable Object keeps a
  numbered list of migrations and runs the pending ones when it first wakes
  after a deploy. Old shapes are converted, not supported alongside new ones.
- **Store each file version once.** History records which content each path
  had; identical content is shared across versions, so long edit histories
  cost little.
- **Binary as binary.** Assets and screenshots are stored as blobs.
- **Backups stream.** Each workspace writes its own nightly backup to R2 in
  bounded pages (assets as raw objects), only when something changed, so
  backup size is never limited by Worker memory. Restores run server-side.
  Durable Object point-in-time restore was tried and dropped: on 2026-10-16,
  bookmark restores on a test stage didn't land at the requested times.

## Expected limits

A workspace holds up to 10 GB of SQLite, roughly tens of thousands of typical
artifacts, and comfortably serves hundreds of concurrently active viewers.
The number of workspaces is unbounded. If one artifact ever needs thousands of
simultaneous writers, its live state moves to its own Durable Object; until
then that is deliberately not built.

## Deliberately not built yet

Billing, self-serve workspace signup, SSO/SCIM, custom domains per workspace,
custom roles and groups (sharing with `@domain` or the whole workspace covers
most of it), audit-log export (the activity log already records the events)
and R2 storage for large assets (only needed once files over the 2 MB SQLite
row limit are).

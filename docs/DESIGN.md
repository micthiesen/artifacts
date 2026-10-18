# Design

artifacts.boo lets agents publish small interactive pages (reports, dashboards,
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

Routing reads the list of workspaces from KV, which the directory republishes
on every change, so an unknown subdomain is answered without the directory. A small global directory records which
workspaces exist, who belongs to which,
and per-person settings that should follow someone everywhere (display name,
notification channels). It is consulted at sign-in, when a workspace changes,
for display names when a live page connects, and when notifications go out;
routing and ordinary page loads don't touch it.

The apex domain is the front door: a splash page, sign-in, the list of your
workspaces, your notification settings and the operator console.

The splash page is the most visited page and the only one search engines may
index (with the policies). It shows real artifacts beside their source: the
examples in `demo/` are compiled at build time into static frame documents
served as Workers assets, so showing them costs no Worker time and touches no
Durable Object. A small script on the page plays the shell's part in memory,
so visitors can vote, tick and type, but nothing they do leaves their browser.
The same examples are published as public artifacts in a `demo` workspace
(`scripts/seed-demo.ts`), where visitors are read-only like on any public link.

## People and roles

- **Operator**: whoever runs the deployment (`OPERATOR_EMAILS`, plus the
  `OPERATOR_TOKEN` for scripts). Creates, suspends and deletes workspaces,
  fixes their admins, puts back a data host an admin removed by mistake, and backs up, exports, imports and restores their data
  from `/admin` on the apex. That is full access to the stored data, as running
  the database always is; what the operator doesn't get is a sign-in as anyone
  or a role inside a workspace. The end-to-end checks' test identities only
  accept reserved test domains (example.com, .test, .invalid).
- **Workspace admin**: manages members, agent tokens, approved data hosts and
  join domains (email domains whose people join as members when they sign in;
  public mail providers are refused, and someone an admin removed stays removed),
  and can manage every artifact in the workspace, so nothing is stranded when
  someone leaves.
- **Member**: connects their own agent and creates artifacts. Sees artifacts
  they own and ones shared with them or with the whole workspace.
- **Guest**: anyone with a verified email who has been shared on a specific
  artifact. Guests need no membership, which is how outside clients are
  invited and why they can stay free when members are billed.

Per artifact, the owner (whose agent created it) and admins manage it; shares
grant `edit` (shared state) or `view`. A public link (anyone can view,
read-only, without signing in) can expire; once it has, it is the same as off,
and open pages that only had the link lose their connection. An agent acts as the person whose token
or OAuth grant it uses, with that person's access.

## Sign-in

People sign in once on the apex with an emailed one-time code; workspaces
receive a short-lived signed hand-off and set their own session cookie.
Adding a member, creating a workspace and sharing with a person all send an
email. Someone who has never signed in gets a presigned link that signs them
straight into that one artifact, for no longer than the link lasts; anyone who
has signed in before gets the page and signs in as themselves. A presigned
link only ever goes into its own person's inbox, or to an agent for its own
person, so nobody can obtain a link that acts as someone else. Codes are
rate-limited per address and globally, because anyone can request one.

Passkeys skip the email. They belong to the apex (the relying party is the
apex host), so a passkey sign-in ends in the same session and workspace
hand-off as a code. The sign-in page offers saved passkeys in the email field's
autofill; after a code sign-in, someone without one is offered to save one; "Not now" holds
that offer back for 30 days. Challenges are signed tokens, so showing the
sign-in page stores nothing; the directory spends each challenge when it signs
someone in, so a captured response works at most once. Only public keys are
stored, and every passkey sign-in requires the device's own check (user
verification). Email codes keep working for everyone, including as recovery.

Codes are eight digits. Requesting codes for someone else's address can't
cancel the code in their inbox, and wrong guesses are limited per address and
network; a network with no failures can always try, so guessing elsewhere
can't lock the owner out.

Agents connect with OAuth (each workspace is its own authorization server and
MCP resource) or with a personal token created on the workspace's settings
page, for clients that can't run a browser sign-in. Both identify a person.

## Isolation

Artifact code is untrusted. It renders in a sandboxed, opaque-origin frame
that can't make network requests or open popups (links go through the shell,
which asks before leaving the workspace). A sandbox can't stop a frame
navigating itself, which a malicious artifact could use to send away what it
can see (the viewer's email, the artifact's state); the shell then replaces
the frame, so the other page never shows inside our chrome. Agents should only
publish code people would trust with that. storage, shared state and comments reach it only
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
- **Backups are jobs.** Each workspace backs itself up to R2 nightly when
  something changed, as a job on its own alarm that runs in steps of a few
  seconds and resumes, so no size is too big for one invocation. Small
  workspaces back up as a point-in-time snapshot; big ones page by page. Every
  run has its own prefix and a manifest written last.
- **Restores and imports can't half-happen.** They load into shadow copies of
  the tables and swap them in with one transaction once everything has
  loaded; any failure before that leaves the live data as it was. A workspace
  restore takes a fresh backup first and keeps the workspace offline until the
  swap; the directory restores (and backs up first) the same way, in one go.
  Jobs carry a generation, so a cancel can't be undone by a step in flight.
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

// Shared by the workspace and the operator scripts, which can't import the Durable Object.

/** Tables that hold workspace data: exported, backed up and replaced on import, in this order. */
export const DATA_TABLES = [
  "members", "tokens", "grants", "allowed_hosts", "artifacts", "files", "history", "blobs", "builds", "shares", "state", "errors",
  "checks", "assets", "sources", "events", "threads", "comments", "watches", "seen", "outbox",
];
// blobs comes after files and history: a backup isn't a point-in-time snapshot,
// and contents written meanwhile are then still included.

/** The directory's tables worth keeping (sign-in codes and their rate limits are not). */
export const DIRECTORY_TABLES = ["workspaces", "memberships", "users", "channels", "visits"];

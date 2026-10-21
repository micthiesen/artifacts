// Contract between the Worker, the shell page (parent window) and the sandboxed
// artifact frame. The frame has an opaque origin and no network access; every
// capability it has arrives over postMessage from the shell.

export type Role = "owner" | "edit" | "view";

export type Viewer = {
  /** Verified email, or null for an anonymous viewer of a public artifact. */
  email: string | null;
  role: Role;
};

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** Frame -> shell. */
export type FrameMessage =
  | { t: "ready" }
  | { t: "local:set"; key: string; value: JsonValue | undefined }
  | { t: "shared:set"; key: string; value: JsonValue | undefined }
  | { t: "error"; message: string; stack?: string }
  | { t: "open"; url: string }
  /** The viewer chose "Comment" on a selection or element. */
  | { t: "comment:new"; anchor: Anchor }
  /** The viewer clicked highlighted text belonging to a thread. */
  | { t: "comment:open"; thread: string }
  /** Where each thread's anchor landed, in document order. */
  | { t: "anchors"; placed: { id: string; status: AnchorStatus }[] };

/** Shell -> frame. */
export type ShellMessage =
  | {
      t: "init";
      viewer: Viewer;
      /** This artifact's browser-local values for this viewer. */
      local: Record<string, JsonValue>;
      /** Current shared state snapshot. */
      shared: Record<string, JsonValue>;
      /** Emails currently viewing (presence). */
      presence: string[];
      theme: "light" | "dark";
      /** Artifacts linking here that this viewer can open, for the "Linked from" footer. */
      backlinks?: { id: string; title: string }[];
      /** Titles of the artifacts this one links to (that this viewer can open), by id, so links can read as titles. */
      linkTitles?: Record<string, string>;
      /** The viewer turned Sounds on for this device. */
      sounds?: boolean;
      /** Members' stored avatar colours (palette indexes, src/shared/who.ts) by email. */
      colours?: Record<string, number>;
    }
  /** `remote`: someone else (or another tab) made these changes, so the page shows them arriving. */
  | { t: "shared"; changes: Record<string, JsonValue | null>; remote?: boolean; reverted?: boolean }
  | { t: "sounds"; on: boolean }
  | { t: "presence"; viewers: string[]; colours?: Record<string, number> }
  | { t: "theme"; theme: "light" | "dark" }
  /** Threads to highlight (open ones; resolved ones are not drawn). */
  | { t: "threads"; threads: { id: string; anchor: Anchor | null; active?: boolean }[]; canComment: boolean }
  /** Scroll a thread's anchor into view and flash it. */
  | { t: "focus"; thread: string }
  /** Scroll to a section: an element id or a heading's slug (the page's URL #fragment). */
  | { t: "scroll"; target: string }
  /** Mark blocks that changed since the viewer's last visit (empty clears). */
  | { t: "changes"; blocks: string[] }
  | { t: "print"; title: string; meta: string };

/** Shell <-> Worker sync WebSocket (one per open artifact tab). */
export type SyncClientMessage =
  | { t: "set"; key: string; value: JsonValue | null; cid: string }
  /** New thread (no `thread`) or a reply. */
  | { t: "comment"; cid: string; thread?: string; anchor?: Anchor | null; text: string }
  | { t: "resolve"; cid: string; thread: string; resolved: boolean }
  | { t: "comment:delete"; cid: string; comment: string }
  /** The viewer has read comments up to this event seq. */
  | { t: "read"; seq: number };

export type SyncServerMessage =
  | { t: "snapshot"; seq: number; state: Record<string, JsonValue> }
  | { t: "set"; key: string; value: JsonValue | null; seq: number; by: string | null; cid?: string }
  | { t: "rejected"; cid: string; reason: string }
  | { t: "presence"; viewers: string[]; colours?: Record<string, number> }
  | { t: "threads"; threads: Thread[]; people: Person[]; colours?: Record<string, number> }
  | { t: "thread"; thread: Thread; cid?: string; colours?: Record<string, number> }
  | { t: "ack"; cid: string }
  | { t: "version"; version: number; note: string };

/**
 * Where a comment points. `block` is a stable block id from the compiled MDX
 * (`data-b`), `row` a table row key inside it, and `quote` the selected text
 * with some context (W3C TextQuoteSelector). Any part may be missing: a block
 * without a quote is a whole-element comment, a quote without a block is
 * matched anywhere on the page.
 */
export type Anchor = {
  block?: string;
  row?: string;
  quote?: { exact: string; prefix: string; suffix: string };
  /** Short label for element anchors without text ("Chart", "Table row Forgejo"). */
  label?: string;
};

/** anchored: found as written; moved: found by fuzzy match; outdated: block exists but text changed; orphaned: gone. */
export type AnchorStatus = "anchored" | "outdated" | "orphaned";

export type ThreadComment = {
  id: string;
  /** Email, or "agent" for replies posted through MCP. */
  by: string;
  text: string;
  at: string;
  seq: number;
};

export type Thread = {
  id: string;
  anchor: Anchor | null;
  /** Version the thread was started on. */
  version: number;
  by: string;
  at: string;
  resolved: { by: string; at: string } | null;
  /** Version that addressed it, when an agent edit listed it in `resolves`. */
  addressedIn?: number;
  comments: ThreadComment[];
};

export type Person = { email: string; name: string | null };

/** What changed since this viewer last opened the artifact (shell banner). */
export type SinceLastVisit = {
  fromVersion: number;
  at: string;
  versions: { version: number; note: string; at: string }[];
  changedBlocks: string[];
  removedHeadings: string[];
};

/**
 * The frame document the Worker serves for one artifact version. The kit's
 * runtime module reads this from `<script type="application/json" id="art-boot">`.
 */
export type FrameBoot = {
  artifactId: string;
  version: number;
  /** Import-map specifier of the entry module, e.g. "@art/index.mdx". */
  entry: string;
  /** Contents of data/*.json files keyed by path, e.g. { "data/repos.json": [...] }. */
  data: Record<string, JsonValue>;
  title: string;
  /**
   * Render check: the frame is loaded top-level by a headless browser. It boots
   * without a shell, records errors in `window.__artErrors`, and sets
   * `<pre id="art-check">{status, errors, textLength}</pre>` once the first render settles.
   */
  check?: boolean;
  /** Uploaded files by path ("assets/logo.png") -> short-lived URL. */
  assets?: Record<string, string>;
};

export const SHARED_VALUE_MAX_BYTES = 64 * 1024;
export const SHARED_STATE_MAX_BYTES = 4 * 1024 * 1024;

/** Embedded in the shell page as `<script type="application/json" id="shell-boot">`. */
export type ShellBoot = {
  artifactId: string;
  title: string;
  version: number;
  frameUrl: string;
  syncUrl: string;
  viewer: Viewer;
  /** Present when the artifact changed since this viewer's last visit. */
  since?: SinceLastVisit;
  /** Comments posted by others after the viewer last read them. */
  readSeq?: number;
  /** Notification level for this artifact (signed-in viewers). */
  watch?: WatchLevel;
  /** Pinned to the top of this viewer's own list (absent for link-only sessions, which have no list). */
  pinned?: boolean;
  /** Set when the owner archived the artifact. */
  archivedAt?: string;
  /** Origin of the apex, where account settings live. */
  apex: string;
  backlinks?: { id: string; title: string }[];
  linkTitles?: Record<string, string>;
  /** The viewer is a member of this workspace (not just a guest). */
  member: boolean;
  /** The viewer is a workspace admin (approves live-data hosts). */
  admin: boolean;
  /** The session came from a presigned link: it opens this artifact only. */
  scoped: boolean;
  /** Members' stored avatar colours (palette indexes, src/shared/who.ts) by email. */
  colours?: Record<string, number>;
};

export type WatchLevel = "all" | "participating" | "mute";

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
  | { t: "open"; url: string };

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
    }
  | { t: "shared"; changes: Record<string, JsonValue | null> }
  | { t: "presence"; viewers: string[] }
  | { t: "theme"; theme: "light" | "dark" };

/** Shell <-> Worker sync WebSocket (one per open artifact tab). */
export type SyncClientMessage =
  | { t: "set"; key: string; value: JsonValue | null; cid: string };

export type SyncServerMessage =
  | { t: "snapshot"; seq: number; state: Record<string, JsonValue> }
  | { t: "set"; key: string; value: JsonValue | null; seq: number; by: string | null; cid?: string }
  | { t: "rejected"; cid: string; reason: string }
  | { t: "presence"; viewers: string[] };

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
};

// The 2026-10 restyle retired the iris -> aqua gradient. Stored artifact files that used its classes or variables
// are rewritten to the solid colours that replaced them (migration in hub.ts), so nothing depends on the old names.

const RENAMES: [RegExp, string][] = [
  // Utilities, longest first: bg-signal-v and bg-signal were the gradient fills, text-signal the gradient text.
  [/(?<![\w-])bg-signal-v(?![\w-])/g, "bg-primary"],
  [/(?<![\w-])bg-signal(?![\w-])/g, "bg-primary"],
  [/(?<![\w-])text-signal(?![\w-])/g, "text-primary"],
  // The two ends as colours (bg-signal-from, text-signal-to, border-signal-from, from-signal-from…).
  [/(?<=[\w-])-signal-from(?![\w-])/g, "-primary"],
  [/(?<=[\w-])-signal-to(?![\w-])/g, "-others"],
  // CSS variables in style props and stylesheets. --signal was a gradient, so it only ever sat where an image goes
  // (background, background-image): it becomes a solid image there, not a colour, which would be invalid.
  [/var\(--signal-from\)/g, "var(--primary)"],
  [/var\(--signal-to\)/g, "var(--others)"],
  [/var\(--signal(?:-v)?\)/g, "linear-gradient(var(--primary), var(--primary))"],
];

/** Only files that name a retired class or variable; prose that merely says "signal" is never loaded. */
const MATCH = `(content LIKE '%bg-signal%' OR content LIKE '%text-signal%' OR content LIKE '%-signal-from%' OR content LIKE '%-signal-to%' OR content LIKE '%--signal%')`;

/**
 * Rewrite stored files that use the retired names, one at a time. In place under the same hash: a later save of
 * the old text lands on the new one anyway, and builds recompile from the files because the theme changed. Runs
 * as a migration and again after every restore or import, since an older backup brings the old names back.
 */
export function retireSignalBlobs(sql: SqlStorage): number {
  const keys = sql.exec(`SELECT artifact_id, hash FROM blobs WHERE ${MATCH}`).toArray();
  let changed = 0;
  for (const { artifact_id, hash } of keys) {
    const content = sql.exec(`SELECT content FROM blobs WHERE artifact_id = ? AND hash = ?`, artifact_id, hash).one().content as string;
    const next = retireSignal(content);
    if (next === content) continue;
    sql.exec(`UPDATE blobs SET content = ? WHERE artifact_id = ? AND hash = ?`, next, artifact_id, hash);
    changed++;
  }
  return changed;
}

/** `text` with the retired gradient classes and variables replaced; the same string when there were none. */
export function retireSignal(text: string): string {
  if (!text.includes("signal")) return text;
  let out = text;
  for (const [pattern, to] of RENAMES) out = out.replace(pattern, to);
  return out;
}

// The 2026-10 restyle retired the iris -> aqua gradient. Stored artifact files that used its classes or variables
// are rewritten to the solid colours that replaced them, by a background pass in each workspace (hub.ts), so
// nothing depends on the old names. Code that discusses the old names (a fenced example) is rewritten too.

// Utility prefixes the old theme's colours could follow, with any variants (hover:, md:) and ! before them.
const UTILITY =
  /(?<![\w-])((?:[\w-]+:)*!?)(bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|decoration|divide|fill|stroke|shadow|accent|caret|placeholder|from|via|to)-signal(-v|-from|-to)?(?![\w-])/g;

/** `text` with the retired gradient classes and variables replaced; the same string when there were none. */
export function retireSignal(text: string): string {
  if (!text.includes("signal")) return text;
  // A file that declares its own --signal variables means its own thing by them: leave it as it is.
  if (/--signal(?:-[\w-]+)?\s*:/.test(text)) return text;
  return text
    .replace(UTILITY, (whole, variants: string, prefix: string, suffix: string | undefined) => {
      // The two ends were colours for any utility.
      if (suffix === "-from") return `${variants}${prefix}-primary`;
      if (suffix === "-to") return `${variants}${prefix}-others`;
      // The gradient itself only existed as bg-signal, bg-signal-v and text-signal.
      if (prefix === "bg" || prefix === "text") return `${variants}${prefix}-primary`;
      return whole;
    })
    .replace(/var\(--signal-from\)/g, "var(--primary)")
    .replace(/var\(--signal-to\)/g, "var(--others)")
    // --signal was a gradient, so it only sat where an image goes: it stays an image (no space, so it also
    // survives inside a class like bg-[image:var(--signal)]).
    .replace(/var\(--signal(?:-v)?\)/g, "linear-gradient(var(--primary),var(--primary))");
}

/** Only files that name a retired class or variable; prose that merely says "signal" is never loaded. */
const MATCH = `(content LIKE '%-signal%')`;

/**
 * Rewrite one artifact's stored files that use the retired names, every kept version included. In place under the
 * same hash: a later save of the old text lands on the new one anyway, and builds recompile from the files because
 * the theme changed. A file that can't be rewritten (too big once longer) is skipped, never fatal.
 */
export function retireSignalBlobs(sql: SqlStorage, artifactId: string): number {
  let changed = 0;
  for (const { hash } of sql.exec(`SELECT hash FROM blobs WHERE artifact_id = ? AND ${MATCH}`, artifactId).toArray()) {
    try {
      const content = sql.exec(`SELECT content FROM blobs WHERE artifact_id = ? AND hash = ?`, artifactId, hash).one().content;
      if (typeof content !== "string") continue;
      const next = retireSignal(content);
      if (next === content) continue;
      sql.exec(`UPDATE blobs SET content = ? WHERE artifact_id = ? AND hash = ?`, next, artifactId, hash);
      changed++;
    } catch (err) {
      console.error(JSON.stringify({ ops: "restyle_skip", artifact: artifactId, message: String(err) }));
    }
  }
  // A viewer may have recompiled from the old names before this pass reached the artifact: mark its build stale, so
  // the next view compiles from the rewritten files (and a rebuild already in flight won't overwrite it).
  if (changed) sql.exec(`UPDATE builds SET build = json_set(build, '$.stamp', '') WHERE artifact_id = ?`, artifactId);
  return changed;
}

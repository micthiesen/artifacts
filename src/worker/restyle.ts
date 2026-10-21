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
  // CSS variables in style props and stylesheets.
  [/var\(--signal-from\)/g, "var(--primary)"],
  [/var\(--signal-to\)/g, "var(--others)"],
  [/var\(--signal(?:-v)?\)/g, "var(--primary)"],
];

/** `text` with the retired gradient classes and variables replaced; the same string when there were none. */
export function retireSignal(text: string): string {
  if (!text.includes("signal")) return text;
  let out = text;
  for (const [pattern, to] of RENAMES) out = out.replace(pattern, to);
  return out;
}

/**
 * Each person's colour: the light their little ghost glows with (presence, avatars, comments). Members of a
 * workspace each have one stored (src/worker/hub.ts, memberColours), handed out least-used first, so people in
 * the same workspace look different. Pages learn those through rememberColours; anyone else (a guest, or someone
 * not on this page's list) gets one from their email, which every page works out the same way.
 *
 * Soft pastels, all light enough for dark initials (8:1 or better), kept clear of iris (which means you) and spread
 * so neighbours differ in lightness as well as hue. Ordered so the first people in a workspace get the most
 * different ones.
 */
export const PALETTE = [
  "oklch(0.8 0.11 355)", // rose
  "oklch(0.84 0.09 210)", // aqua
  "oklch(0.89 0.11 98)", // butter
  "oklch(0.77 0.12 322)", // orchid
  "oklch(0.84 0.13 135)", // lime
  "oklch(0.77 0.12 30)", // coral
  "oklch(0.76 0.1 248)", // sky
  "oklch(0.79 0.11 170)", // mint
  "oklch(0.85 0.1 62)", // apricot
  "oklch(0.72 0.09 195)", // teal
] as const;

const known = new Map<string, number>();

/** Stored colours (palette indexes) for people this page knows about, by email. */
export function rememberColours(colours: Record<string, number> | undefined) {
  if (!colours) return;
  for (const [email, i] of Object.entries(colours)) if (Number.isInteger(i) && i >= 0 && i < PALETTE.length) known.set(email.trim().toLowerCase(), i);
}

/** The palette index for someone with no stored colour, from their email. */
export function hashedColour(email: string): number {
  const key = email.trim().toLowerCase();
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % PALETTE.length;
}

export function whoColor(email: string | null | undefined): string {
  if (!email) return PALETTE[0];
  return PALETTE[known.get(email.trim().toLowerCase()) ?? hashedColour(email)];
}

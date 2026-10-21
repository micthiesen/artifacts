/**
 * Each person's colour: the light their little ghost glows with wherever they
 * show up (presence, avatars). Picked from their email, so it is the same on
 * every page and device. Iris is left out because it means you.
 */
const COLOURS = [
  "oklch(0.82 0.1 200)", // aqua
  "oklch(0.87 0.12 85)", // amber
  "oklch(0.76 0.13 155)", // green
  "oklch(0.8 0.1 240)", // sky
  "oklch(0.8 0.12 335)", // pink
  "oklch(0.84 0.11 55)", // apricot
] as const;

/** Lightness varies a little between colours, so neighbours still differ for colour-blind viewers. */
export function whoColor(email: string | null | undefined): string {
  if (!email) return COLOURS[0];
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  return COLOURS[h % COLOURS.length];
}

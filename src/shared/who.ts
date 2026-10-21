/**
 * Each person's colour: the light their little ghost glows with wherever they
 * show up (presence, avatars). Picked from their email, so it is the same on
 * every page and device. Iris is left out because it means you.
 */
const HUES = [200, 80, 158, 25, 235, 335] as const;

export function whoColor(email: string | null | undefined): string {
  if (!email) return `oklch(0.82 0.1 ${HUES[0]})`;
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  return `oklch(0.82 0.11 ${HUES[h % HUES.length]})`;
}

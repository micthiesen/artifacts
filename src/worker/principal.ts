// Share principals: a full email ("sam@x.com") or a whole domain ("@x.com").

/** Normalizes "sam@x.com" to itself and "x.com" / "@x.com" to "@x.com". */
export function sharePrincipal(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.startsWith("@")) return v;
  return v.includes("@") ? v : `@${v}`;
}

export function isValidPrincipal(p: string): boolean {
  return /^([^\s@]+)?@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(p);
}

/** "sam@x.com" -> "@x.com", the domain principal that covers this email. */
export function domainOf(email: string): string {
  return `@${email.split("@")[1] ?? ""}`;
}

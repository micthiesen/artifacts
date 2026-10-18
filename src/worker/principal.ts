// Share principals: a full email ("sam@x.com"), a whole domain ("@x.com"), or
// every member of the workspace ("workspace").

export const WORKSPACE_PRINCIPAL = "workspace";

/** Normalizes "sam@x.com" to itself, "x.com" / "@x.com" to "@x.com", and "workspace" to itself. */
export function sharePrincipal(value: string): string {
  const v = value.trim().toLowerCase();
  if (v === WORKSPACE_PRINCIPAL || v.startsWith("@")) return v;
  return v.includes("@") ? v : `@${v}`;
}

export function isValidPrincipal(p: string): boolean {
  return p === WORKSPACE_PRINCIPAL || /^([^\s@]+)?@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(p);
}

/** "sam@x.com" -> "@x.com", the domain principal that covers this email. */
export function domainOf(email: string): string {
  return `@${email.split("@")[1] ?? ""}`;
}

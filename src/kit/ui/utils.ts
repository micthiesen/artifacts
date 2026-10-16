import { clsx, type ClassValue } from "clsx";
import { useEffect, useState } from "react";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** "selfHost" / "self_host" -> "Self host". */
const ACRONYMS = new Set(
  "id ids ui ux ci cd url urls uri api apis sdk cli sso http https html css js ts json csv xml sql db pr prs qa sla slo kpi roi arr mrr eta os cpu gpu ram ssd ip dns vpn aws gcp llm ai ml".split(" "),
);

/** "selfHost" / "self_host" -> "Self host"; "ci" -> "CI"; "apiURL" -> "API URL". */
export function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean);
  return words
    .map((w, i) => {
      if (ACRONYMS.has(w.toLowerCase()) || (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w))) return w.toUpperCase();
      const lower = w.toLowerCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

/** "ada.lovelace@example.com" -> "Ada Lovelace". */
export function displayName(email: string | null | undefined): string {
  if (!email) return "Anonymous";
  const local = email.split("@")[0] ?? email;
  return local
    .split(/[._+-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function initials(email: string | null | undefined): string {
  const name = displayName(email);
  const parts = name.split(" ").filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase();
}

export function relativeTime(at: number | string, now = Date.now()): string {
  const t = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: d > 300 ? "numeric" : undefined });
}

/** Re-render periodically so relative times stay fresh. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "item"
  );
}

export function isUrl(v: unknown): v is string {
  return typeof v === "string" && /^https?:\/\/\S+$/.test(v);
}

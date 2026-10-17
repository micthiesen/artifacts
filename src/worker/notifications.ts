// Turns queued notification items for one person and one artifact into a
// single message. Pure, so it is unit tested without the hub.
import type { NotifyMessage } from "./notify.ts";

export type OutboxItem =
  | {
      kind: "comment";
      data: { thread: string; by: string; text: string; why: "mention" | "reply" | "all"; reply: boolean; origin?: string };
    }
  | { kind: "resolve"; data: { thread: string; by: string; addressedIn: number | null; origin?: string } }
  | { kind: "update"; data: { version: number; notes: string[]; origin?: string } };

const MENTION = /(?:^|[\s(])@([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi;

/** Emails written as "@name@example.com" in a comment. */
export function mentionedEmails(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION)].map((m) => m[1].toLowerCase()))];
}

export function personName(email: string, nameOf: (email: string) => string | null): string {
  if (email === "agent") return "Agent";
  return nameOf(email) ?? email.split("@")[0];
}

function quote(text: string, max = 180): string {
  const t = text.replace(/\s+/g, " ").trim();
  return `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”`;
}

function list(names: string[]): string {
  const unique = [...new Set(names)];
  if (unique.length <= 2) return unique.join(" and ");
  return `${unique.slice(0, 2).join(", ")} and ${unique.length - 2} more`;
}

export function composeMessage(input: {
  title: string;
  artifactId: string;
  origin: string;
  items: OutboxItem[];
  nameOf: (email: string) => string | null;
}): NotifyMessage {
  const { items, nameOf } = input;
  const name = (e: string) => personName(e, nameOf);
  const comments = items.filter((i): i is Extract<OutboxItem, { kind: "comment" }> => i.kind === "comment");
  const resolves = items.filter((i): i is Extract<OutboxItem, { kind: "resolve" }> => i.kind === "resolve");
  const updates = items.filter((i): i is Extract<OutboxItem, { kind: "update" }> => i.kind === "update");
  const lines: string[] = [];
  let thread: string | undefined;

  if (comments.length === 1) {
    const c = comments[0].data;
    const verb = c.why === "mention" ? "mentioned you" : c.reply ? "replied" : "commented";
    lines.push(`${name(c.by)} ${verb}: ${quote(c.text)}`);
    thread = c.thread;
  } else if (comments.length > 1) {
    const mentions = comments.filter((c) => c.data.why === "mention");
    lines.push(`${comments.length} new comments from ${list(comments.map((c) => name(c.data.by)))}`);
    if (mentions.length) lines.push(`${name(mentions[0].data.by)} mentioned you: ${quote(mentions[0].data.text, 120)}`);
    const threads = new Set(comments.map((c) => c.data.thread));
    if (threads.size === 1) thread = comments[0].data.thread;
  }
  for (const r of resolves) {
    lines.push(
      r.data.addressedIn
        ? `Your comment was addressed in v${r.data.addressedIn}`
        : `${name(r.data.by)} resolved your comment`,
    );
    thread ??= r.data.thread;
  }
  if (updates.length) {
    const notes = updates.flatMap((u) => u.data.notes).filter(Boolean);
    const version = Math.max(...updates.map((u) => u.data.version));
    lines.push(`Updated to v${version}${notes.length ? `: ${notes.slice(-3).join("; ")}` : ""}`);
  }

  // Only a thread id (not a <Comments> scope) can be opened from the URL.
  const hash = thread && /^t[a-z0-9]+$/.test(thread) ? `#thread=${thread}` : "";
  return {
    title: input.title,
    body: lines.join("\n"),
    url: `${input.origin}/a/${input.artifactId}${hash}`,
    tag: input.artifactId,
  };
}

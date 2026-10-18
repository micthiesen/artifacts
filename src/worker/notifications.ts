// Turns queued notification items for one person and one artifact into a
// single message. Pure, so it is unit tested without the hub.
import type { NotifyMessage } from "./notify.ts";

export type OutboxItem =
  | {
      kind: "comment";
      data: { thread: string; by: string; text: string; why: "mention" | "reply" | "all"; reply: boolean; origin?: string };
    }
  | { kind: "resolve"; data: { thread: string; by: string; addressedIn: number | null; origin?: string } }
  | { kind: "update"; data: { version: number; notes: string[]; origin?: string } }
  | { kind: "stale"; data: { block: string; decision: string; seenVersion: number; version: number; note?: string; origin?: string } }
  | {
      kind: "response";
      data: { component: "approval" | "form"; block: string; by: string; decision?: string; note?: string; changed: boolean; origin?: string };
    };

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
  const responses = items.filter((i): i is Extract<OutboxItem, { kind: "response" }> => i.kind === "response");
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
  // Newest decision per person and block: changing your mind in the batch window sends one line.
  const latest = new Map<string, Extract<OutboxItem, { kind: "response" }>["data"]>();
  for (const r of responses) latest.set(`${r.data.component}/${r.data.block}/${r.data.by}`, r.data);
  for (const r of latest.values()) {
    if (r.component === "approval") {
      const verb = r.decision === "approve" ? "approved" : "requested changes";
      lines.push(`${name(r.by)} ${verb}${r.note ? `: ${quote(r.note)}` : ""}`);
    } else {
      lines.push(`${name(r.by)} ${r.changed ? "updated their" : "sent a"} response to the "${r.block}" form`);
    }
  }
  // Decisions a new version made stale: one line, whichever way they decided.
  const stale = items.filter((i): i is Extract<OutboxItem, { kind: "stale" }> => i.kind === "stale");
  if (stale.length) {
    const s = stale.at(-1)!.data;
    const what = stale.every((x) => x.data.decision === "approve") ? "you approved it" : stale.every((x) => x.data.decision === "changes") ? "you requested changes" : "your decision";
    lines.push(`It changed since ${what} on v${s.seenVersion} (now v${s.version}${s.note ? `: ${s.note}` : ""}). Take another look and decide again.`);
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
    artifact: { id: input.artifactId, title: input.title },
    events: items.map(({ kind, data }) => {
      const { origin: _origin, first: _first, ...rest } = data as Record<string, unknown>;
      return { kind, ...rest };
    }),
  };
}

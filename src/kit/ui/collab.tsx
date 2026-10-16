// Live, shared components. Each stores one shared key per item so concurrent
// edits by different people never overwrite each other.
import { Check, Plus, Send, Trash2, X } from "./icons.ts";
import * as React from "react";
import { useShared, useSharedMap, useViewer } from "../hooks.ts";
import { Avatar, AvatarGroup, Button, Input, Textarea } from "./primitives.tsx";
import { Tooltip } from "./controls.tsx";
import { cn, displayName, relativeTime, slugify, useNow } from "./utils.ts";

function ReadOnlyNote({ email }: { email: string | null }) {
  return (
    <p className="mt-3 text-[13px] text-muted-foreground">
      {email === null ? "Sign in with edit access to take part." : "You have view access, so this is read-only."}
    </p>
  );
}

function rand(n = 6) {
  return Math.random().toString(36).slice(2, 2 + n);
}

// ---- Poll -------------------------------------------------------------------------

/** Live poll. Votes live at `poll/<id>/<email>` as the list of chosen options. */
export function Poll({ id, options, multiple = false, question, className }: { id: string; options: string[]; multiple?: boolean; question?: React.ReactNode; className?: string }) {
  const votes = useSharedMap<string[]>(`poll/${id}`);
  const viewer = useViewer();
  const mine = (viewer.email && votes.get(viewer.email)) || [];
  const voters = votes.entries.filter(([, v]) => Array.isArray(v) && v.length > 0);
  const byOption = new Map<string, string[]>(options.map((o) => [o, []]));
  for (const [email, picks] of voters) for (const p of picks) byOption.get(p)?.push(email);
  const maxCount = Math.max(1, ...[...byOption.values()].map((v) => v.length));
  const totalVotes = [...byOption.values()].reduce((n, v) => n + v.length, 0);

  function vote(option: string) {
    if (!viewer.canWrite || !viewer.email) return;
    const has = mine.includes(option);
    const next = multiple ? (has ? mine.filter((o) => o !== option) : [...mine, option]) : has ? [] : [option];
    if (next.length === 0) votes.delete(viewer.email);
    else votes.set(viewer.email, next);
  }

  return (
    <div className={cn("my-6 rounded-xl border border-border bg-card p-5", className)}>
      {question && <div className="mb-4 font-semibold">{question}</div>}
      <div className="flex flex-col gap-2" role={multiple ? "group" : "radiogroup"}>
        {options.map((o) => {
          const who = byOption.get(o) ?? [];
          const chosen = mine.includes(o);
          const pct = (who.length / maxCount) * 100;
          return (
            <button
              key={o}
              type="button"
              role={multiple ? "checkbox" : "radio"}
              aria-checked={chosen}
              disabled={!viewer.canWrite}
              onClick={() => vote(o)}
              className={cn(
                "group relative flex w-full items-center gap-3 overflow-hidden rounded-lg border px-3.5 py-2.5 text-left text-[15px] transition-colors outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring/40 enabled:cursor-pointer enabled:hover:border-primary/40",
                chosen ? "border-primary/50" : "border-border",
              )}
            >
              <span
                className={cn("absolute inset-y-0 left-0 transition-[width] duration-500 ease-out", chosen ? "bg-accent" : "bg-muted/80")}
                style={{ width: `${who.length ? pct : 0}%` }}
                aria-hidden
              />
              <span
                className={cn(
                  "relative flex size-[18px] shrink-0 items-center justify-center border transition-colors",
                  multiple ? "rounded-[5px]" : "rounded-full",
                  chosen ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card",
                )}
              >
                {chosen && <Check className="size-3" strokeWidth={3} />}
              </span>
              <span className="relative min-w-0 flex-1 font-medium">{o}</span>
              {who.length > 0 && (
                <Tooltip content={who.map(displayName).join(", ")}>
                  <span className="relative">
                    <AvatarGroup emails={who} max={3} />
                  </span>
                </Tooltip>
              )}
              <span className="relative w-6 text-right text-sm text-muted-foreground tabular-nums">{who.length}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-3 text-[13px] text-muted-foreground">
        {voters.length === 0 ? "No votes yet." : `${totalVotes} ${totalVotes === 1 ? "vote" : "votes"} from ${voters.length} ${voters.length === 1 ? "person" : "people"}`}
        {multiple && viewer.canWrite && " · pick any"}
      </div>
      {!viewer.canWrite && <ReadOnlyNote email={viewer.email} />}
    </div>
  );
}

// ---- Checklist --------------------------------------------------------------------

type CheckItem = { done: boolean; by?: string | null; at?: number; text?: string; added?: boolean };

/** Shared checklist. Each item lives at `check/<id>/<slug>` as { done, by }. */
export function Checklist({ id, items = [], allowAdd = false, className }: { id: string; items?: string[]; allowAdd?: boolean; className?: string }) {
  const map = useSharedMap<CheckItem>(`check/${id}`);
  const viewer = useViewer();
  const [draft, setDraft] = React.useState("");
  const base = items.map((text) => ({ slug: slugify(text), text, added: false }));
  const baseSlugs = new Set(base.map((b) => b.slug));
  const extra = map.entries
    .filter(([slug, v]) => !baseSlugs.has(slug) && v && typeof v.text === "string")
    .sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0))
    .map(([slug, v]) => ({ slug, text: v.text as string, added: true }));
  const all = [...base, ...extra];
  const doneCount = all.filter((i) => map.get(i.slug)?.done).length;

  function toggle(slug: string, text: string, added: boolean) {
    if (!viewer.canWrite) return;
    const cur = map.get(slug);
    map.set(slug, { ...(cur ?? {}), done: !cur?.done, by: viewer.email, at: cur?.at ?? Date.now(), ...(added ? { text, added: true } : {}) });
  }

  // Works with or without native form submission (the frame CSP sets form-action 'none').
  function add(e?: React.SyntheticEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || !viewer.canWrite) return;
    map.set(`${slugify(text)}-${rand(4)}`, { done: false, by: viewer.email, at: Date.now(), text, added: true });
    setDraft("");
  }

  return (
    <div className={cn("my-6 rounded-xl border border-border bg-card", className)}>
      <ul className="divide-y divide-border/70">
        {all.map(({ slug, text, added }) => {
          const st = map.get(slug);
          const done = !!st?.done;
          return (
            <li key={slug} className="group flex items-center gap-3 px-4 py-2.5">
              <button
                type="button"
                role="checkbox"
                aria-checked={done}
                disabled={!viewer.canWrite}
                onClick={() => toggle(slug, text, added)}
                className={cn(
                  "flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/25 enabled:cursor-pointer",
                  done ? "border-positive bg-positive text-white" : "border-input bg-card enabled:hover:border-primary/60",
                )}
              >
                {done && <Check className="size-3.5" strokeWidth={3} />}
              </button>
              <span className={cn("min-w-0 flex-1 text-[15px] leading-snug transition-colors", done && "text-foreground/80 line-through decoration-foreground/35")}>
                {text}
              </span>
              {done && st?.by && (
                <Tooltip content={`Done by ${displayName(st.by)}`}>
                  <span>
                    <Avatar email={st.by} size="sm" />
                  </span>
                </Tooltip>
              )}
              {added && viewer.canWrite && (
                <button
                  type="button"
                  aria-label={`Remove ${text}`}
                  onClick={() => map.delete(slug)}
                  className="cursor-pointer rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-negative focus-visible:opacity-100"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </li>
          );
        })}
        {all.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted-foreground">No items yet.</li>}
      </ul>
      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5">
        {allowAdd && viewer.canWrite ? (
          <form onSubmit={add} className="flex flex-1 items-center gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) add(e);
              }}
              placeholder="Add an item…" className="h-8 border-transparent bg-transparent px-1 shadow-none focus-visible:ring-0" />
            <Button type="button" onClick={add} size="sm" variant="ghost" disabled={!draft.trim()} aria-label="Add item">
              <Plus /> Add
            </Button>
          </form>
        ) : (
          <span className="text-[13px] text-muted-foreground">{viewer.canWrite ? "" : viewer.email === null ? "Read-only: sign in with edit access to check items." : "Read-only with view access."}</span>
        )}
        <span className="shrink-0 text-[13px] text-muted-foreground tabular-nums">
          {doneCount} of {all.length} done
        </span>
      </div>
    </div>
  );
}

// ---- Comments ---------------------------------------------------------------------

type Comment = { by: string | null; text: string; at: number };

/** Comment thread. Each comment lives at `comments/<id>/<time>-<rand>`; newest last. */
export function Comments({ id = "main", title = "Comments", className }: { id?: string; title?: React.ReactNode; className?: string }) {
  const map = useSharedMap<Comment>(`comments/${id}`);
  const viewer = useViewer();
  const now = useNow();
  const [text, setText] = React.useState("");
  const list = map.entries.filter(([, c]) => c && typeof c.text === "string");

  function submit(e?: React.SyntheticEvent) {
    e?.preventDefault();
    const t = text.trim();
    if (!t || !viewer.canWrite) return;
    const at = Date.now();
    map.set(`${String(at).padStart(14, "0")}-${rand()}`, { by: viewer.email, text: t, at });
    setText("");
  }

  return (
    <section className={cn("my-8", className)}>
      {title && (
        <h3 className="mb-4 flex items-baseline gap-2 text-base font-semibold">
          {title}
          {list.length > 0 && <span className="text-sm font-normal text-muted-foreground tabular-nums">{list.length}</span>}
        </h3>
      )}
      {list.length === 0 && <p className="mb-4 text-sm text-muted-foreground">No comments yet.</p>}
      <ul className="flex flex-col gap-5">
        {list.map(([key, c]) => (
          <li key={key} className="group flex gap-3">
            <Avatar email={c.by} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 text-sm">
                <span className="font-semibold">{displayName(c.by)}</span>
                <span className="text-[13px] text-muted-foreground" title={new Date(c.at).toLocaleString()}>
                  {relativeTime(c.at, now)}
                </span>
                {viewer.canWrite && c.by === viewer.email && (
                  <button
                    type="button"
                    aria-label="Delete comment"
                    onClick={() => map.delete(key)}
                    className="ml-auto cursor-pointer rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-negative focus-visible:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
              <p className="mt-0.5 text-[15px] leading-relaxed break-words whitespace-pre-wrap">{c.text}</p>
            </div>
          </li>
        ))}
      </ul>
      {viewer.canWrite ? (
        <form onSubmit={submit} className="mt-5 flex gap-3">
          <Avatar email={viewer.email} />
          <div className="flex-1">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
              }}
              placeholder="Add a comment…"
              rows={2}
              className="min-h-16"
            />
            <div className="mt-2 flex items-center justify-end gap-3">
              <span className="text-xs text-muted-foreground">⌘/Ctrl + Enter</span>
              <Button type="button" onClick={submit} size="sm" disabled={!text.trim()}>
                <Send /> Comment
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <ReadOnlyNote email={viewer.email} />
      )}
    </section>
  );
}

// ---- Notes ------------------------------------------------------------------------

type Note = { text: string; by: string | null; at: number };

/** Shared free-text notes at `notes/<id>`; debounced last-writer-wins save. */
export function Notes({ id, placeholder = "Write shared notes…", rows = 6, className }: { id: string; placeholder?: string; rows?: number; className?: string }) {
  const [note, setNote] = useShared<Note | null>(`notes/${id}`, null);
  const viewer = useViewer();
  const now = useNow();
  const remote = note?.text ?? "";
  const [draft, setDraft] = React.useState(remote);
  const [dirty, setDirty] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = React.useRef(draft);
  draftRef.current = draft;

  // Adopt remote edits whenever we have no unsaved local changes.
  React.useEffect(() => {
    if (!dirty) setDraft(remote);
  }, [remote, dirty]);

  const flush = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setNote({ text: draftRef.current, by: viewer.email, at: Date.now() });
    setDirty(false);
  }, [setNote, viewer.email]);

  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function onChange(v: string) {
    setDraft(v);
    setDirty(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 700);
  }

  return (
    <div className={cn("my-6", className)}>
      {viewer.canWrite ? (
        <Textarea
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => dirty && flush()}
          placeholder={placeholder}
          rows={rows}
          className="bg-card text-[15px]"
        />
      ) : (
        <div className="min-h-20 rounded-md border border-border bg-muted/40 px-3 py-2 text-[15px] leading-relaxed break-words whitespace-pre-wrap">
          {remote || <span className="text-muted-foreground">No notes yet.</span>}
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
        {dirty ? (
          "Saving…"
        ) : note ? (
          <>
            <Avatar email={note.by} size="sm" className="ring-0" />
            Last edited by {note.by === viewer.email && viewer.email ? "you" : displayName(note.by)} · {relativeTime(note.at, now)}
          </>
        ) : viewer.canWrite ? (
          "Everyone viewing sees edits live."
        ) : null}
      </div>
      {!viewer.canWrite && <ReadOnlyNote email={viewer.email} />}
    </div>
  );
}

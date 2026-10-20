// Live, shared components. Each stores one shared key per item so concurrent
// edits by different people never overwrite each other.
import { Check, Plus, Send, Trash2, X } from "./icons.ts";
import * as React from "react";
import { useShared, useSharedMap, useViewer } from "../hooks.ts";
import { Avatar, AvatarGroup, Badge, Button, Input, Label, Textarea } from "./primitives.tsx";
import { Checkbox, Select, Tooltip } from "./controls.tsx";
import { Table } from "./table.tsx";
import { getBoot } from "../store.ts";
import { cueAfterRender, moveAfterRender, useArrivals } from "../feedback.ts";
import { cn, displayName, relativeTime, slugify, useNow } from "./utils.ts";

function ReadOnlyNote({ email }: { email: string | null }) {
  return (
    <p className="mt-3 text-[13px] text-muted-foreground">
      {email === null ? "Sign in with edit access to take part." : "You have view access, so this is read-only."}
    </p>
  );
}

/** A tooltip can't scroll: the first few names, then how many more. */
function namesList(names: string[], max = 8): string {
  return names.length > max ? `${names.slice(0, max - 1).join(", ")} and ${names.length - max + 1} more` : names.join(", ");
}

/** The element inside `root` whose `data-<attr>` is `value`. */
function byData(root: HTMLElement, attr: string, value: string): Element | null {
  for (const el of root.querySelectorAll(`[data-${attr}]`)) if (el.getAttribute(`data-${attr}`) === value) return el;
  return null;
}

export function rand(n = 6) {
  return Math.random().toString(36).slice(2, 2 + n);
}

// ---- Poll -------------------------------------------------------------------------

/** Live poll. Votes live at `poll/<id>/<email>` as the list of chosen options. */
export function Poll({ id, options, multiple = false, question, className }: { id: string; options: string[]; multiple?: boolean; question?: React.ReactNode; className?: string }) {
  const votes = useSharedMap<string[]>(`poll/${id}`);
  const viewer = useViewer();
  const root = React.useRef<HTMLDivElement>(null);
  useArrivals(root, `poll/${id}`);
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
    if (!has) moveAfterRender(() => root.current && byData(root.current, "mark", option));
  }

  return (
    <div ref={root} className={cn("my-6 rounded-xl border border-border bg-card p-5 shadow-card", className)}>
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
                "group relative isolate flex w-full items-center gap-3 overflow-hidden rounded-lg border bg-background/40 px-3.5 py-2.5 text-left text-[15px] transition-colors outline-none",
                "focus-visible:focus-halo enabled:cursor-pointer enabled:hover:border-primary/45",
                chosen ? "border-primary/60" : "border-border",
              )}
            >
              {/* Result bar: scaled with transform so it animates without layout. */}
              <span
                className={cn("absolute inset-0 -z-10 origin-left transition-transform duration-(--motion-data) ease-(--motion-ease)", chosen ? "bg-signal opacity-25" : "bg-muted")}
                style={{ transform: `scaleX(${who.length ? pct / 100 : 0})` }}
                aria-hidden
              />
              <span
                data-mark={o}
                className={cn(
                  "relative flex size-[18px] shrink-0 items-center justify-center border transition-colors",
                  multiple ? "rounded-[5px]" : "rounded-full",
                  chosen ? "border-transparent bg-primary bg-signal text-primary-foreground" : "border-input bg-card",
                )}
              >
                {chosen && <Check className="size-3" strokeWidth={3} />}
              </span>
              <span className="relative min-w-0 flex-1 font-medium">{o}</span>
              {who.length > 0 && (
                <Tooltip content={namesList(who.map(displayName))}>
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
  const root = React.useRef<HTMLDivElement>(null);
  useArrivals(root, `check/${id}`, (slug, el) => byData(el, "slug", slug));
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
    if (!cur?.done) moveAfterRender(() => root.current && byData(root.current, "slug", slug)?.querySelector("[role=checkbox]"));
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
    <div ref={root} className={cn("my-6 rounded-xl border border-border bg-card shadow-card", className)}>
      <ul className="divide-y divide-border/70">
        {all.map(({ slug, text, added }) => {
          const st = map.get(slug);
          const done = !!st?.done;
          return (
            <li key={slug} data-slug={slug} className="group flex items-center gap-3 px-4 py-2.5">
              <button
                type="button"
                role="checkbox"
                aria-checked={done}
                disabled={!viewer.canWrite}
                onClick={() => toggle(slug, text, added)}
                className={cn(
                  "flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors outline-none focus-visible:focus-halo enabled:cursor-pointer",
                  done ? "border-positive bg-positive text-background" : "border-input bg-background/60 enabled:hover:border-primary/60",
                )}
              >
                {done && <Check className="size-3.5" strokeWidth={3} />}
              </button>
              <span className={cn("min-w-0 flex-1 text-[15px] leading-snug transition-colors", done && "text-muted-foreground line-through decoration-muted-foreground/50")}>
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
  const root = React.useRef<HTMLElement>(null);
  useArrivals(root, `comments/${id}`, (key, el) => byData(el, "key", key));

  function submit(e?: React.SyntheticEvent) {
    e?.preventDefault();
    const t = text.trim();
    if (!t || !viewer.canWrite) return;
    const at = Date.now();
    const key = `${String(at).padStart(14, "0")}-${rand()}`;
    map.set(key, { by: viewer.email, text: t, at });
    setText("");
    cueAfterRender(() => root.current && byData(root.current, "key", key), "send");
  }

  return (
    <section ref={root} className={cn("my-8", className)}>
      {title && (
        <h3 className="mb-4 flex items-baseline gap-2 text-base font-semibold">
          {title}
          {list.length > 0 && <span className="text-sm font-normal text-muted-foreground tabular-nums">{list.length}</span>}
        </h3>
      )}
      {list.length === 0 && <p className="mb-4 text-sm text-muted-foreground">No comments yet.</p>}
      <ul className="flex flex-col gap-5">
        {list.map(([key, c]) => (
          <li key={key} data-key={key} className="group flex gap-3">
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
  const root = React.useRef<HTMLDivElement>(null);
  useArrivals(root, `notes/${id}`);
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
    <div ref={root} className={cn("my-6", className)}>
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

// ---- Approval ---------------------------------------------------------------------

type Decision = { decision: "approve" | "changes"; note?: string; by?: string; at?: number; version?: number };

/**
 * Sign-off. Each person's decision lives at `approve/<id>/<email>` as
 * { decision: "approve" | "changes", note? }; the server stamps who and when.
 * With `approvers`, it counts as approved once every one of them approves.
 */
export function Approval({
  id,
  title = "Approval",
  description,
  approvers,
  className,
}: {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  approvers?: string[];
  className?: string;
}) {
  const map = useSharedMap<Decision>(`approve/${id}`);
  const viewer = useViewer();
  const now = useNow();
  const root = React.useRef<HTMLDivElement>(null);
  useArrivals(root, `approve/${id}`, (email, el) => byData(el, "email", email));
  const mine = viewer.email ? map.get(viewer.email) : undefined;
  const [note, setNote] = React.useState("");
  // A decision made on an earlier version than this page no longer counts: the page changed since.
  const pageVersion = getBoot()?.version ?? 0;
  const stale = (d: Decision | undefined) => Boolean(d && typeof d.version === "number" && d.version < pageVersion);
  const decisions = map.entries
    .filter(([, d]) => d && (d.decision === "approve" || d.decision === "changes"))
    .sort((a, b) => (a[1].at ?? Infinity) - (b[1].at ?? Infinity));
  const current = decisions.filter(([, d]) => !stale(d));
  const outdated = decisions.length - current.length;
  const required = (approvers ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const approved = new Set(current.filter(([, d]) => d.decision === "approve").map(([email]) => email));
  const changes = current.filter(([, d]) => d.decision === "changes");
  const waiting = required.filter((e) => !map.get(e));
  const status =
    changes.length > 0
      ? { tone: "caution" as const, text: "Changes requested" }
      : required.length
        ? required.every((e) => approved.has(e))
          ? { tone: "positive" as const, text: "Approved" }
          : { tone: "neutral" as const, text: `Waiting on ${required.filter((e) => !approved.has(e)).length} of ${required.length}` }
        : approved.size
          ? { tone: "positive" as const, text: `Approved by ${approved.size}` }
          : outdated
            ? { tone: "neutral" as const, text: "Changed since the last decision" }
            : { tone: "neutral" as const, text: "No decisions yet" };

  function decide(decision: Decision["decision"]) {
    if (!viewer.canWrite || !viewer.email) return;
    const text = note.trim();
    // Clicking your current decision again without a new note changes nothing (and keeps its note),
    // unless it was made on an earlier version: then it confirms it for this one.
    if (mine?.decision === decision && !text && !stale(mine)) return;
    // The version on screen: the server records that, so an old tab approves what it showed.
    map.set(viewer.email, { decision, ...(text ? { note: text } : {}), ...(pageVersion ? { version: pageVersion } : {}) });
    setNote("");
    cueAfterRender(() => root.current?.querySelector("[role=status]"), decision === "approve" ? "approve" : "send");
  }

  return (
    <div ref={root} className={cn("my-6 rounded-xl border border-border bg-card shadow-card", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3">
        <div className="min-w-0">
          <div className="font-semibold">{title}</div>
          {description && <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>}
        </div>
        <Badge tone={status.tone} role="status">
          {status.tone === "positive" && <Check />}
          {status.text}
        </Badge>
      </div>
      {(decisions.length > 0 || waiting.length > 0) && (
        <ul className="divide-y divide-border/70 border-t border-border">
          {decisions.map(([email, d]) => (
            <li key={email} data-email={email} className="flex gap-3 px-5 py-2.5">
              <Avatar email={email} size="sm" />
              <div className="min-w-0 flex-1">
                {/* As tall as the avatar, so the name line centers on it. */}
                <div className="flex flex-wrap items-baseline gap-x-2 text-sm leading-6">
                  <span className="font-medium">{email === viewer.email ? "You" : displayName(email)}</span>
                  <span className={stale(d) ? "text-muted-foreground" : d.decision === "approve" ? "text-positive" : "text-caution"}>
                    {d.decision === "approve" ? "approved" : "requested changes"}
                    {stale(d) && ` v${d.version}`}
                  </span>
                  {d.at && (
                    <span className="text-[13px] text-muted-foreground" title={new Date(d.at).toLocaleString()}>
                      {relativeTime(d.at, now)}
                    </span>
                  )}
                </div>
                {d.note && <p className={cn("mt-0.5 text-[15px] leading-relaxed break-words whitespace-pre-wrap", stale(d) && "text-muted-foreground")}>{d.note}</p>}
                {stale(d) && <p className="mt-0.5 text-[13px] text-muted-foreground">The page has changed since, so this needs a new look.</p>}
              </div>
            </li>
          ))}
          {waiting.map((email) => (
            <li key={email} className="flex items-center gap-3 px-5 py-2.5 text-sm text-muted-foreground">
              <Avatar email={email} size="sm" className="opacity-60" />
              <span className="min-w-0 flex-1 truncate">{email === viewer.email ? "You" : displayName(email)}</span>
              <span className="text-[13px]">Waiting</span>
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-border px-5 py-3">
        {viewer.canWrite && viewer.email ? (
          <div className="flex flex-col gap-2.5">
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={mine ? "Add a note with your new decision (optional)" : "Add a note (optional)"}
              aria-label="Note with your decision"
              rows={2}
              className="min-h-14 bg-background/40"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" onClick={() => decide("approve")}>
                <Check /> {mine?.decision === "approve" && !stale(mine) ? "Approved" : "Approve"}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => decide("changes")}>
                {mine?.decision === "changes" && !stale(mine) ? "Changes requested" : "Request changes"}
              </Button>
              {mine && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (viewer.email) map.delete(viewer.email);
                    setNote("");
                  }}
                >
                  Withdraw
                </Button>
              )}
            </div>
          </div>
        ) : (
          <ReadOnlyNote email={viewer.email} />
        )}
      </div>
    </div>
  );
}

// ---- Form -------------------------------------------------------------------------

export type FormField = {
  name: string;
  label?: string;
  type?: "text" | "textarea" | "number" | "email" | "date" | "select" | "checkbox";
  options?: string[];
  required?: boolean;
  placeholder?: string;
  hint?: string;
};
export type FormValue = string | number | boolean;
type FormResponse = { values: Record<string, FormValue>; by?: string; at?: number; version?: number };

export function emptyValue(f: FormField): FormValue {
  return f.type === "checkbox" ? false : "";
}

/** One labelled form control (Form and Ledger). */
export function FieldControl({
  field: f,
  fid,
  value,
  onChange,
  onEnter,
  invalid,
  errorId,
}: {
  field: FormField;
  fid: string;
  value: FormValue;
  onChange: (v: FormValue) => void;
  onEnter: (e: React.SyntheticEvent) => void;
  invalid: boolean;
  errorId: string;
}) {
  const label = f.label ?? f.name;
  const describedBy = [f.hint ? `${fid}-hint` : "", invalid ? errorId : ""].filter(Boolean).join(" ") || undefined;
  const required = f.required ? <span className="text-muted-foreground">*</span> : null;
  const control =
    f.type === "checkbox" ? (
      <Checkbox
        id={fid}
        checked={value === true}
        onCheckedChange={(c) => onChange(c === true)}
        label={<>{label}{required}</>}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
      />
    ) : f.type === "select" ? (
      <Select options={f.options ?? []} value={typeof value === "string" && value ? value : null} onValueChange={(v) => onChange(String(v ?? ""))} placeholder={f.placeholder} aria-label={label} />
    ) : f.type === "textarea" ? (
      <Textarea id={fid} value={String(value)} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder} rows={3} aria-describedby={describedBy} aria-invalid={invalid || undefined} />
    ) : (
      <Input
        id={fid}
        type={f.type === "number" ? "text" : (f.type ?? "text")}
        inputMode={f.type === "number" ? "decimal" : undefined}
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) onEnter(e);
        }}
        placeholder={f.placeholder}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
      />
    );
  return (
    <div className="flex flex-col gap-1.5">
      {f.type === "select" ? (
        <span className="text-sm leading-none font-medium">
          {label}
          {required}
        </span>
      ) : f.type !== "checkbox" ? (
        <Label htmlFor={fid}>
          {label}
          {required}
        </Label>
      ) : null}
      {control}
      {f.hint && (
        <span id={`${fid}-hint`} className="text-[13px] text-muted-foreground">
          {f.hint}
        </span>
      )}
    </div>
  );
}

/** Checks and converts what was typed into a field: an error message, or the value to store (undefined: left empty). */
export function readField(f: FormField, raw: FormValue | undefined): { error: string } | { value: FormValue | undefined } {
  const v = typeof raw === "string" ? raw.trim() : raw;
  const label = f.label ?? f.name;
  if (f.required && (v === "" || v === false || v === undefined)) return { error: `${label} is required.` };
  if (v === "" || v === undefined) return { value: undefined };
  if (f.type === "number") {
    // Decimal numbers only, with a comma accepted as the decimal point.
    const text = String(v).replace(/\s/g, "");
    if (!/^[-+]?(\d+([.,]\d*)?|[.,]\d+)$/.test(text)) return { error: `${label} must be a number.` };
    return { value: Number(text.replace(",", ".")) };
  }
  if (f.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v))) return { error: `${label} must be an email address.` };
  return { value: v };
}

/**
 * One response per person at `form/<id>/<email>` as { values }; the server
 * stamps who and when. People can edit their response; everyone who can open
 * the artifact sees the responses.
 */
export function Form({
  id,
  fields,
  title,
  description,
  submitLabel = "Send",
  showResponses = true,
  className,
}: {
  id: string;
  fields: FormField[];
  title?: React.ReactNode;
  description?: React.ReactNode;
  submitLabel?: string;
  showResponses?: boolean;
  className?: string;
}) {
  const map = useSharedMap<FormResponse>(`form/${id}`);
  const viewer = useViewer();
  const now = useNow();
  const root = React.useRef<HTMLDivElement>(null);
  useArrivals(root, `form/${id}`, (_, el) => el.querySelector("[data-responses]"));
  const responses = map.entries
    .filter(([, r]) => r && r.values && typeof r.values === "object" && !Array.isArray(r.values))
    .sort((a, b) => (a[1].at ?? Infinity) - (b[1].at ?? Infinity));
  const mine = viewer.email ? responses.find(([email]) => email === viewer.email)?.[1] : undefined;
  const initial = () => Object.fromEntries(fields.map((f) => [f.name, mine?.values[f.name] ?? emptyValue(f)]));
  const [values, setValues] = React.useState<Record<string, FormValue>>(initial);
  // Open while answering for the first time or editing; typing keeps it open even if a response arrives meanwhile.
  const [editing, setEditing] = React.useState(false);
  const [error, setError] = React.useState<{ field: string; text: string } | null>(null);
  const open = viewer.canWrite && (!mine || editing);
  const errorId = `form-${id}-error`;

  function set(name: string, v: FormValue) {
    setValues((prev) => ({ ...prev, [name]: v }));
    setEditing(true);
    setError(null);
  }

  function fail(f: FormField, text: string) {
    setError({ field: f.name, text });
    document.getElementById(`form-${id}-${f.name}`)?.focus();
  }

  // Works without native submission (the frame CSP sets form-action 'none').
  function submit(e?: React.SyntheticEvent) {
    e?.preventDefault();
    if (!viewer.canWrite || !viewer.email) return;
    const out: Record<string, FormValue> = {};
    for (const f of fields) {
      const r = readField(f, values[f.name]);
      if ("error" in r) return fail(f, r.error);
      if (r.value !== undefined) out[f.name] = r.value;
    }
    const version = getBoot()?.version;
    map.set(viewer.email, { values: out, ...(version ? { version } : {}) });
    setEditing(false);
    cueAfterRender(() => root.current?.querySelector("[data-sent]"), "send");
  }

  function field(f: FormField) {
    return (
      <FieldControl
        key={f.name}
        field={f}
        fid={`form-${id}-${f.name}`}
        value={values[f.name] ?? emptyValue(f)}
        onChange={(v) => set(f.name, v)}
        onEnter={submit}
        invalid={error?.field === f.name}
        errorId={errorId}
      />
    );
  }

  const show = (v: FormValue | undefined) => (v === undefined || v === "" ? "—" : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v));

  return (
    <div ref={root} className={cn("my-6 rounded-xl border border-border bg-card shadow-card", className)}>
      {(title || description) && (
        <div className="px-5 pt-4 pb-1">
          {title && <div className="font-semibold">{title}</div>}
          {description && <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>}
        </div>
      )}
      <div className="px-5 py-4">
        {open ? (
          <form onSubmit={submit} className="flex flex-col gap-4">
            {fields.map(field)}
            {error && (
              <p id={errorId} role="alert" className="text-sm text-negative">
                {error.text}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" onClick={submit}>
                <Send /> {mine ? "Save changes" : submitLabel}
              </Button>
              {mine && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(false);
                    setError(null);
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
          </form>
        ) : mine ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone="positive" data-sent="">
                <Check /> Sent
              </Badge>
              {mine.at && <span className="text-[13px] text-muted-foreground">{relativeTime(mine.at, now)}</span>}
              {viewer.canWrite && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => {
                    setValues(initial());
                    setEditing(true);
                  }}
                >
                  Edit response
                </Button>
              )}
            </div>
            <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              {fields.map((f) => (
                <React.Fragment key={f.name}>
                  <dt className="text-muted-foreground">{f.label ?? f.name}</dt>
                  <dd className="m-0 break-words whitespace-pre-wrap">{show(mine.values[f.name])}</dd>
                </React.Fragment>
              ))}
            </dl>
          </div>
        ) : (
          <ReadOnlyNote email={viewer.email} />
        )}
      </div>
      {showResponses && (
        <div data-responses="" className="border-t border-border px-5 py-3">
          <div className="mb-2 text-[13px] text-muted-foreground">
            {responses.length === 0 ? "No responses yet." : `${responses.length} ${responses.length === 1 ? "response" : "responses"}`}
          </div>
          {responses.length > 0 && (
            // Field keys are prefixed so a field named "person" or "sent" can't replace those columns.
            <Table
              data={responses.map(([email, r]) => ({
                $person: email === viewer.email ? "You" : displayName(email),
                ...Object.fromEntries(fields.map((f) => [`f:${f.name}`, show(r.values[f.name])])),
                $sent: r.at ? relativeTime(r.at, now) : "",
              }))}
              columns={[
                { key: "$person", label: "Person" },
                ...fields.map((f) => ({ key: `f:${f.name}`, label: f.label ?? f.name, format: "text" as const })),
                { key: "$sent", label: "Sent" },
              ]}
            />
          )}
        </div>
      )}
    </div>
  );
}

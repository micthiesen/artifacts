// What every markdown page gets without asking: a contents list when it's long,
// live checkboxes for "- [ ]" task lists, and the artifacts that link here.
// All of it is computed in the browser from what's already on the page.
import * as React from "react";
import { useSyncExternalStore } from "react";
import * as store from "../store.ts";
import { useSharedMap, useViewer } from "../hooks.ts";
import { cn, displayName, humanize, slugify } from "./utils.ts";
import { formatValue, useRows } from "./table.tsx";
import { ChevronRight } from "./icons.ts";

/** A page with at least this many sections gets a contents list under its title. */
const CONTENTS_MIN_SECTIONS = 4;

/**
 * Under the first title of a long page: its sections, collapsed until opened.
 * Headings are the page's top-level ## sections, read from the rendered page.
 */
export function Contents() {
  const ref = React.useRef<HTMLElement>(null);
  const [sections, setSections] = React.useState<{ id: string; text: string }[]>([]);
  React.useEffect(() => {
    const page = ref.current?.closest(".art-page");
    // Only the first title's list counts, however many h1s the page has.
    if (!page || page.querySelector(".art-contents") !== ref.current) return;
    let frame = 0;
    let last = "";
    const read = () => {
      frame = 0;
      const found = [...page.querySelectorAll<HTMLElement>("h2[data-b]")]
        .filter((h) => !h.closest(".art-contents, .art-linked-from"))
        .map((h) => ({ id: h.dataset.b!, text: h.textContent?.trim() ?? "" }))
        .filter((s) => s.text);
      const key = JSON.stringify(found);
      if (key !== last) {
        last = key;
        setSections(found);
      }
    };
    read();
    // Sections are top-level blocks: only changes to the page's own children can add or remove one.
    const article = page.querySelector("[data-b]")?.parentElement ?? page;
    const watch = new MutationObserver(() => {
      frame ||= requestAnimationFrame(read);
    });
    watch.observe(article, { childList: true, characterData: true, subtree: false });
    return () => {
      watch.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  const show = sections.length >= CONTENTS_MIN_SECTIONS;
  return (
    <nav ref={ref} aria-label="Contents" className={cn("art-contents", show ? "-mt-2 mb-8" : "hidden")}>
      {show && (
        <details className="group rounded-lg border border-border bg-card/60 text-[14px]">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2.5 font-medium text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden className="size-4 shrink-0 transition-transform group-open:rotate-90" />
            Contents · {sections.length} sections
          </summary>
          <ol className="grid gap-x-6 gap-y-1 px-4 pb-3 sm:grid-cols-2">
            {sections.map((s) => (
              <li key={s.id} className="min-w-0">
                <a href={`#${s.id}`} className="block truncate py-0.5 text-foreground/85 hover:text-primary">
                  {s.text}
                </a>
              </li>
            ))}
          </ol>
        </details>
      )}
    </nav>
  );
}

type TaskState = { done?: boolean; by?: string | null; at?: number };

/**
 * A "- [ ] item" checkbox that people tick on the page, shared like a
 * Checklist: who ticked it shows on hover. Keyed by the item's text, so it
 * stays ticked when the page around it changes.
 */
export function TaskCheckbox({ checked }: { checked?: boolean }) {
  const ref = React.useRef<HTMLButtonElement>(null);
  const [key, setKey] = React.useState<string | null>(null);
  // A name of the kit's own, so it can't collide with an artifact's useSharedMap("tasks").
  const tasks = useSharedMap<TaskState>("_kit/tasks");
  const viewer = useViewer();
  React.useEffect(() => {
    // The item's own text (not a nested list's), plus which occurrence it is, so repeats stay separate.
    const li = ref.current?.closest("li");
    if (!li) return;
    const own = [...li.childNodes].filter((n) => !(n instanceof HTMLElement && (n.tagName === "UL" || n.tagName === "OL"))).map((n) => n.textContent ?? "").join("").trim();
    if (!own) return;
    const slug = slugify(own).slice(0, 120) || "item";
    const same = [...document.querySelectorAll("li.task-list-item")].filter((x) => x !== li && x.compareDocumentPosition(li) & Node.DOCUMENT_POSITION_FOLLOWING);
    const earlier = same.filter((x) => slugify([...x.childNodes].filter((n) => !(n instanceof HTMLElement && (n.tagName === "UL" || n.tagName === "OL"))).map((n) => n.textContent ?? "").join("").trim()).slice(0, 120) === slug).length;
    setKey(earlier ? `${slug}~${earlier + 1}` : slug);
  }, []);
  const state = key ? tasks.get(key) : undefined;
  // Until someone ticks it on the page, the source's [x] / [ ] stands.
  const done = state?.done ?? Boolean(checked);
  const toggle = () => {
    if (!key || !viewer.canWrite) return;
    tasks.set(key, { done: !done, by: viewer.email, at: Date.now() });
  };
  return (
    <button
      ref={ref}
      type="button"
      role="checkbox"
      aria-checked={done}
      disabled={!viewer.canWrite}
      onClick={toggle}
      title={state?.by ? `${done ? "Done" : "Unticked"} by ${displayName(state.by)}` : undefined}
      className={cn(
        "mr-2 inline-flex size-[1.05rem] translate-y-[0.2rem] cursor-pointer items-center justify-center rounded-[5px] border align-baseline transition-colors disabled:cursor-default",
        done ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card hover:border-primary/60",
      )}
    >
      {done && (
        <svg viewBox="0 0 16 16" className="size-3" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

/** At the end of a markdown page: the artifacts that link to it (those the viewer can open). */
export function LinkedFrom() {
  useSyncExternalStore(store.subscribe, store.getBoot);
  const { backlinks } = store.getLinks();
  if (!backlinks.length) return null;
  return (
    <footer className="art-linked-from mt-16 border-t border-border pt-6">
      <h2 className="mb-3 text-[13px] font-medium tracking-wide text-muted-foreground uppercase">Linked from</h2>
      <ul className="flex flex-wrap gap-2">
        {backlinks.map((b) => (
          <li key={b.id}>
            <a
              href={`/a/${b.id}`}
              className="inline-block max-w-full truncate rounded-full border border-border bg-card px-3 py-1 text-[14px] text-foreground/90 hover:border-primary/50 hover:text-primary"
            >
              {b.title}
            </a>
          </li>
        ))}
      </ul>
    </footer>
  );
}

type SourceRecord = Record<string, unknown>;
const RECORD_TITLE = ["title", "name", "sourceTitle", "label"];
const RECORD_URL = ["url", "sourceUrl", "href", "link"];

/**
 * Records kept with a page for reference (say, what a page was imported from), closed until opened, so they
 * cost the reader nothing: each record's title and link, then its fields. Nothing renders until it's opened.
 */
export function SourceRecords({ data, title = "Source records", className }: { data: string | unknown[]; title?: React.ReactNode; className?: string }) {
  const rows = useRows(data) as SourceRecord[];
  const [open, setOpen] = React.useState(false);
  if (!rows.length) return null;
  const pick = (r: SourceRecord, keys: string[]) => keys.map((k) => r[k]).find((v) => typeof v === "string" && v) as string | undefined;
  return (
    <details className={cn("art-sources my-8 rounded-xl border border-border bg-card/60 text-[14px]", className)} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer list-none px-4 py-3 font-medium text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
        {title} · {rows.length}
      </summary>
      {open && (
        <ul className="divide-y divide-border/70 border-t border-border">
          {rows.map((r, i) => {
            const name = pick(r, RECORD_TITLE) ?? `Record ${i + 1}`;
            const url = pick(r, RECORD_URL);
            const rest = Object.entries(r).filter(([k, v]) => !RECORD_TITLE.includes(k) && !RECORD_URL.includes(k) && v !== null && v !== undefined && v !== "");
            return (
              <li key={i} className="px-4 py-3">
                <div className="font-medium">
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline decoration-primary/30 underline-offset-2">
                      {name}
                    </a>
                  ) : (
                    name
                  )}
                </div>
                {rest.length > 0 && (
                  <dl className="mt-1.5 grid grid-cols-[minmax(0,0.8fr)_minmax(0,2fr)] gap-x-3 gap-y-1 text-[13px]">
                    {rest.map(([k, v]) => (
                      <React.Fragment key={k}>
                        <dt className="truncate text-muted-foreground">{humanize(k)}</dt>
                        <dd className="min-w-0 break-words">
                          {v !== null && typeof v === "object" && !Array.isArray(v) ? (
                            <pre className="overflow-x-auto font-mono text-[12px] whitespace-pre-wrap">{JSON.stringify(v, null, 2)}</pre>
                          ) : (
                            formatValue(v, typeof v === "string" && /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) ? "date" : "text", r)
                          )}
                        </dd>
                      </React.Fragment>
                    ))}
                  </dl>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}

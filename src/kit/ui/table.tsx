// Data table with sortable headers, search, and value-aware formatting.
import { ScrollX } from "./scroll-x.tsx";
import { ArrowDown, ArrowUp, Check, ChevronsUpDown, Minus, Search } from "./icons.ts";
import * as React from "react";
import { useSyncExternalStore } from "react";
import * as store from "../store.ts";
import { linkTitle } from "../store.ts";
import { ErrorBoundary } from "./error.tsx";
import { Input } from "./primitives.tsx";
import { cn, humanize, isUrl } from "./utils.ts";

export type Row = Record<string, unknown>;
export type Format = "text" | "number" | "integer" | "currency" | `currency:${string}` | "percent" | "date" | "url" | "bool" | ((value: unknown, row: Row) => React.ReactNode);
export type ColumnSpec = { key: string; label?: React.ReactNode; format?: Format; align?: "left" | "right" | "center" };
export type ColumnsProp = string | (string | ColumnSpec)[];

/** Rows from a data path ("repos.json") or an inline array. Throws a clear error if missing. */
export function useRows(data: string | unknown[] | undefined): Row[] {
  useSyncExternalStore(store.subscribe, store.getBoot);
  if (data === undefined) return [];
  const raw = typeof data === "string" ? store.getData(data) : data;
  if (!Array.isArray(raw)) {
    throw new Error(`Expected an array of rows${typeof data === "string" ? ` in ${store.resolveDataPath(data)}` : ""}, got ${raw === null ? "null" : typeof raw}`);
  }
  return raw.map((r) => (r !== null && typeof r === "object" && !Array.isArray(r) ? (r as Row) : { value: r }));
}

export function parseColumns(columns: ColumnsProp | undefined, rows: Row[]): ColumnSpec[] {
  if (columns === undefined) {
    const keys: string[] = [];
    for (const r of rows.slice(0, 50)) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
    return keys.map((key) => ({ key }));
  }
  const list = typeof columns === "string" ? columns.split(/[\s,]+/).filter(Boolean) : columns;
  // A column named in another case than the data ("Name" for "name") still finds its values.
  const keys = new Map<string, string>();
  for (const r of rows.slice(0, 50)) for (const k of Object.keys(r)) if (!keys.has(k.toLowerCase())) keys.set(k.toLowerCase(), k);
  const resolve = (key: string) => (rows.some((r) => key in r) ? key : (keys.get(key.toLowerCase()) ?? key));
  return list.map((c) => (typeof c === "string" ? { key: resolve(c), label: c === resolve(c) ? undefined : humanize(c) } : { ...c, key: resolve(c.key) }));
}

/** A link cell: { label, url } (or href). */
function linkOf(v: unknown): { label: string; url: string } | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const url = typeof o.url === "string" ? o.url : typeof o.href === "string" ? o.href : null;
  if (!url || !(url.startsWith("/") || isUrl(url))) return null;
  return { label: typeof o.label === "string" ? o.label : typeof o.title === "string" ? o.title : url, url };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

function inferFormat(key: string, rows: Row[]): Format {
  let kind: string | null = null;
  for (const r of rows) {
    const v = r[key];
    if (v === null || v === undefined || v === "") continue;
    const k =
      typeof v === "number" ? "number" : typeof v === "boolean" ? "bool" : isUrl(v) || linkOf(v) ? "url" : typeof v === "string" && ISO_DATE.test(v) ? "date" : "text";
    if (kind === null) kind = k;
    else if (kind !== k) return "text";
  }
  return (kind ?? "text") as Format;
}

const numberFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export function formatValue(v: unknown, format: Format, row: Row): React.ReactNode {
  if (typeof format === "function") return format(v, row);
  if (v === null || v === undefined || v === "") return <span className="text-muted-foreground/60">—</span>;
  switch (format) {
    case "number":
      return typeof v === "number" ? numberFmt.format(v) : String(v);
    case "integer":
      return typeof v === "number" ? Math.round(v).toLocaleString() : String(v);
    case "percent":
      return typeof v === "number" ? `${numberFmt.format(v * 100)}%` : String(v);
    case "date": {
      // A bare date ("2026-10-04") is that calendar day wherever the reader is, not UTC midnight.
      const dateOnly = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
      const d = new Date(v as string | number);
      return Number.isNaN(d.getTime())
        ? String(v)
        : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", ...(dateOnly ? { timeZone: "UTC" } : {}) });
    }
    case "bool":
      return v ? (
        <Check className="inline size-4 text-positive" aria-label="yes" />
      ) : (
        <Minus className="inline size-4 text-muted-foreground/60" aria-label="no" />
      );
    case "url": {
      const link = linkOf(v) ?? (isUrl(v) ? { label: null, url: v } : null);
      if (!link) return String(v);
      // A link to another artifact here reads as its title, and opens in this tab.
      const title = linkTitle(link.url);
      const internal = link.url.startsWith("/") || title !== null;
      return (
        <a
          href={link.url}
          {...(internal ? {} : { target: "_blank", rel: "noopener noreferrer" })}
          className="text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary"
        >
          {link.label ?? title ?? link.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
        </a>
      );
    }
    default:
      if (typeof format === "string" && format.startsWith("currency")) {
        const currency = format.split(":")[1] ?? "USD";
        return typeof v === "number" ? new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(v) : String(v);
      }
      if (Array.isArray(v)) return v.join(", ");
      if (linkOf(v)) return formatValue(v, "url", row);
      if (typeof v === "object") return <code className="text-xs">{JSON.stringify(v)}</code>;
      if (typeof v === "number") return numberFmt.format(v);
      if (typeof v === "boolean") return formatValue(v, "bool", row);
      if (isUrl(v)) return formatValue(v, "url", row);
      return String(v);
  }
}

function compare(a: unknown, b: unknown): number {
  const an = a === null || a === undefined || a === "";
  const bn = b === null || b === undefined || b === "";
  if (an || bn) return an && bn ? 0 : an ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(b) - Number(a);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

export type TableProps = {
  /** "repos.json" (from data/) or an array of row objects. */
  data: string | unknown[];
  /** "name price selfHost", ["name", …], or [{ key, label, format, align }]. Defaults to every key. */
  columns?: ColumnsProp;
  /** Initial sort column; prefix "-" for descending ("-stars"). */
  sort?: string;
  /** Show a filter box. */
  search?: boolean;
  /** Shown when there are no rows. */
  empty?: React.ReactNode;
  /** Show the first N rows with a "Show all" toggle. */
  limit?: number;
  /**
   * Rows as cards (the first column as each card's title, the rest as label: value): "auto" (the default) on
   * phones when there are more than three columns, "always", or "never" (a table that scrolls sideways).
   */
  cards?: "auto" | "always" | "never";
  className?: string;
};

const PHONE = "(max-width: 639px)";
function usePhone(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(PHONE);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => matchMedia(PHONE).matches,
    () => false,
  );
}

/** What a cell holds, as text, for the filter box. */
function searchable(v: unknown): string {
  const link = linkOf(v);
  if (link) return `${link.label} ${link.url}`;
  return Array.isArray(v) ? v.join(" ") : String(v ?? "");
}

export function Table(props: TableProps) {
  return (
    <ErrorBoundary label="Table">
      <TableInner {...props} />
    </ErrorBoundary>
  );
}

function TableInner({ data, columns, sort, search, empty = "Nothing here yet.", limit, cards = "auto", className }: TableProps) {
  const rows = useRows(data);
  const phone = usePhone();
  const cols = React.useMemo(
    () =>
      parseColumns(columns, rows).map((c) => {
        const format = c.format ?? inferFormat(c.key, rows);
        const numeric = format === "number" || format === "integer" || format === "percent" || (typeof format === "string" && format.startsWith("currency"));
        return { ...c, format, align: c.align ?? (numeric ? "right" : format === "bool" ? "center" : "left") };
      }),
    [columns, rows],
  );
  const [sortKey, setSortKey] = React.useState<string | null>(sort ? sort.replace(/^-/, "") : null);
  const [desc, setDesc] = React.useState(sort ? sort.startsWith("-") : false);
  const [query, setQuery] = React.useState("");
  const [expanded, setExpanded] = React.useState(false);

  const shown = React.useMemo(() => {
    let out = rows;
    const q = query.trim().toLowerCase();
    if (q) out = out.filter((r) => cols.some((c) => searchable(r[c.key]).toLowerCase().includes(q)));
    if (sortKey) {
      out = [...out].sort((a, b) => {
        const res = compare(a[sortKey], b[sortKey]);
        const aNull = a[sortKey] === null || a[sortKey] === undefined || a[sortKey] === "";
        const bNull = b[sortKey] === null || b[sortKey] === undefined || b[sortKey] === "";
        return aNull || bNull ? res : desc ? -res : res;
      });
    }
    return out;
  }, [rows, cols, query, sortKey, desc]);

  const visible = limit && !expanded ? shown.slice(0, limit) : shown;

  function toggleSort(key: string) {
    if (sortKey !== key) {
      setSortKey(key);
      setDesc(false);
    } else if (!desc) setDesc(true);
    else setSortKey(null);
  }

  const alignClass = (a: string) => (a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left");
  const asCards = cards === "always" || (cards === "auto" && phone && cols.length > 3);

  return (
    <div className={cn("my-6", className)}>
      {asCards ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {search && <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter…" className="max-w-[12rem]" aria-label="Filter rows" />}
          <select
            aria-label="Sort by"
            value={sortKey ? `${desc ? "-" : ""}${sortKey}` : ""}
            onChange={(e) => {
              const v = e.target.value;
              setSortKey(v ? v.replace(/^-/, "") : null);
              setDesc(v.startsWith("-"));
            }}
            className="h-9 max-w-full rounded-md border border-input bg-card px-2 text-[14px] text-foreground"
          >
            <option value="">Sort: as listed</option>
            {cols.flatMap((c) => [
              <option key={c.key} value={c.key}>
                {`Sort: ${typeof c.label === "string" ? c.label : humanize(c.key)}`}
              </option>,
              <option key={`-${c.key}`} value={`-${c.key}`}>
                {`Sort: ${typeof c.label === "string" ? c.label : humanize(c.key)}, reversed`}
              </option>,
            ])}
          </select>
        </div>
      ) : null}
      {asCards ? (
        visible.length === 0 ? (
          <p className="rounded-xl border border-border bg-card px-5 py-8 text-center text-muted-foreground">{query ? "No rows match your filter." : empty}</p>
        ) : (
          <ul className="grid gap-2.5">
            {visible.map((r, i) => (
              <li
                key={i}
                data-row={cols[0] ? String(r[cols[0].key] ?? "").slice(0, 200) : undefined}
                className="rounded-xl border border-border bg-card px-4 py-3 text-[14px] leading-snug shadow-card"
              >
                {cols[0] && <div className="mb-1.5 font-medium text-foreground">{formatValue(r[cols[0].key], cols[0].format, r)}</div>}
                <dl className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)] gap-x-3 gap-y-1">
                  {cols.slice(1).map((c) =>
                    r[c.key] === null || r[c.key] === undefined || r[c.key] === "" ? null : (
                      <React.Fragment key={c.key}>
                        <dt className="truncate text-muted-foreground">{c.label ?? humanize(c.key)}</dt>
                        <dd className="min-w-0 break-words">{formatValue(r[c.key], c.format, r)}</dd>
                      </React.Fragment>
                    ),
                  )}
                </dl>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {!asCards && search && (
        <div className="relative mb-3 max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter…" className="pl-9" aria-label="Filter rows" />
        </div>
      )}
      {!asCards && (
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
        <ScrollX>
        <table className="w-full border-collapse text-[14px] leading-snug">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              {cols.map((c) => {
                const active = sortKey === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={active ? (desc ? "descending" : "ascending") : undefined}
                    className={cn("px-4 py-2.5 font-medium whitespace-nowrap text-muted-foreground first:pl-5 last:pr-5", alignClass(c.align))}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      className={cn(
                        "group inline-flex cursor-pointer items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
                        active && "text-foreground",
                        c.align === "right" && "flex-row-reverse",
                      )}
                    >
                      {c.label ?? humanize(c.key)}
                      {active ? (
                        desc ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />
                      ) : (
                        <ChevronsUpDown className="size-3.5 opacity-0 transition-opacity group-hover:opacity-60" />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={cols.length || 1} className="px-5 py-10 text-center text-muted-foreground">
                  {query ? "No rows match your filter." : empty}
                </td>
              </tr>
            ) : (
              visible.map((r, i) => (
                <tr
                  key={i}
                  data-row={cols[0] ? String(r[cols[0].key] ?? "").slice(0, 200) : undefined}
                  className="border-b border-border/70 transition-colors last:border-0 hover:bg-muted/40"
                >
                  {cols.map((c, j) => (
                    <td
                      key={c.key}
                      className={cn(
                        "px-4 py-2.5 align-top first:pl-5 last:pr-5",
                        c.align === "left" && "max-sm:min-w-36",
                        alignClass(c.align),
                        c.align === "right" && "tabular-nums",
                        j === 0 && "font-medium",
                      )}
                    >
                      {formatValue(r[c.key], c.format, r)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </ScrollX>
      </div>
      )}
      {limit && shown.length > limit && (
        <button type="button" onClick={() => setExpanded((e) => !e)} className="mt-2 cursor-pointer text-sm font-medium text-primary hover:underline">
          {expanded ? "Show fewer" : `Show all ${shown.length} rows`}
        </button>
      )}
    </div>
  );
}

// A log people add to on the page: payments, check-ins, tastings, stock. The
// page declares the fields; each entry is one shared key (`ledger/<id>/<row>`)
// that the server stamps with who added it and when, so an agent can trust it
// and read it back. Rows an agent keeps in a data file show alongside, read-only.
import * as React from "react";
import { Pencil, Plus, Trash2 } from "./icons.ts";
import { useSharedMap, useViewer } from "../hooks.ts";
import { Button } from "./primitives.tsx";
import { emptyValue, FieldControl, rand, readField, type FormField, type FormValue } from "./collab.tsx";
import { formatValue, Table, useRows, type ColumnSpec, type Format, type Row } from "./table.tsx";
import { ErrorBoundary } from "./error.tsx";
import { cueAfterRender, useArrivals } from "../feedback.ts";
import { cn, displayName, relativeTime, useNow } from "./utils.ts";

export type LedgerField = FormField & { format?: Format };
type Entry = { values: Record<string, FormValue>; by?: string; at?: number; editedBy?: string; editedAt?: number };

export type LedgerProps = {
  /** Stable id: entries are stored under it. */
  id: string;
  fields: LedgerField[];
  /** Rows kept by the agent in data/ (read-only here), shown with people's entries. */
  data?: string;
  /** Initial sort, as in Table ("-date"). Default: newest added first. */
  sort?: string;
  /** Field(s) to sum under the table ("amount" or ["in", "out"]). */
  total?: string | string[];
  title?: React.ReactNode;
  description?: React.ReactNode;
  addLabel?: string;
  /** As in Table: rows as cards on phones ("auto"), always, or never. */
  cards?: "auto" | "always" | "never";
  className?: string;
};

export function Ledger(props: LedgerProps) {
  return (
    <ErrorBoundary label="Ledger">
      <LedgerInner {...props} />
    </ErrorBoundary>
  );
}

function LedgerInner({ id, fields, data, sort, total, title, description, addLabel = "Add entry", cards, className }: LedgerProps) {
  const map = useSharedMap<Entry>(`ledger/${id}`);
  const viewer = useViewer();
  const now = useNow();
  const seed = useRows(data);
  const [editing, setEditing] = React.useState<{ key: string | null; values: Record<string, FormValue> } | null>(null);
  const [error, setError] = React.useState<{ field: string; text: string } | null>(null);
  const errorId = `ledger-${id}-error`;
  const root = React.useRef<HTMLDivElement>(null);
  useArrivals(root, `ledger/${id}`);

  const entries = map.entries.filter(([, e]) => e && e.values && typeof e.values === "object" && !Array.isArray(e.values));
  const rows: Row[] = [
    ...seed.map((r) => ({ ...r, _seed: true })),
    ...entries.map(([key, e]) => ({ ...e.values, _key: key, _by: e.by ?? null, _at: e.at ?? 0 })),
  ];
  // Each row's buttons say which entry they act on, so a screen reader's button list tells them apart.
  const named = (r: Row) => {
    const v = r[fields[0]?.name ?? ""];
    return typeof v === "string" || typeof v === "number" ? `${v}`.trim().slice(0, 60) : "";
  };
  const canChange = (r: Row) => viewer.canWrite && !r._seed && (r._by === viewer.email || viewer.role === "owner");

  function start(key: string | null) {
    const e = key ? map.get(key) : undefined;
    setEditing({ key, values: Object.fromEntries(fields.map((f) => [f.name, e?.values[f.name] ?? emptyValue(f)])) });
    setError(null);
  }

  function save(ev?: React.SyntheticEvent) {
    ev?.preventDefault();
    if (!editing || !viewer.canWrite) return;
    const out: Record<string, FormValue> = {};
    for (const f of fields) {
      const r = readField(f, editing.values[f.name]);
      if ("error" in r) {
        setError({ field: f.name, text: r.error });
        document.getElementById(`ledger-${id}-${f.name}`)?.focus();
        return;
      }
      if (r.value !== undefined) out[f.name] = r.value;
    }
    const key = editing.key ?? `${Date.now().toString(36)}${rand(4)}`;
    map.set(key, { ...(editing.key ? map.get(editing.key) : {}), values: out });
    setEditing(null);
    // The form closes; its Add button coming back is what you see land.
    cueAfterRender(() => root.current?.querySelector("[data-ledger-add]"), "send");
  }

  const columns: ColumnSpec[] = [
    ...fields.map((f) => ({ key: f.name, label: f.label ?? undefined, ...(f.format ? { format: f.format } : f.type === "date" ? { format: "date" as const } : {}) })),
    {
      key: "_at",
      label: "Added",
      format: (_v: unknown, r: Row) =>
        r._seed ? <span className="text-muted-foreground/60">—</span> : <span className="text-[13px] whitespace-nowrap text-muted-foreground">{`${displayName(r._by as string | null)}${r._at ? ` · ${relativeTime(r._at as number, now)}` : ""}`}</span>,
    },
    ...(viewer.canWrite
      ? [
          {
            key: "_key",
            label: "",
            format: (_v: unknown, r: Row) =>
              canChange(r) ? (
                <span className="inline-flex gap-1">
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={named(r) ? `Edit entry: ${named(r)}` : "Edit entry"} onClick={() => start(r._key as string)}>
                    <Pencil />
                  </Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={named(r) ? `Delete entry: ${named(r)}` : "Delete entry"} onClick={() => confirm("Delete this entry?") && map.delete(r._key as string)}>
                    <Trash2 />
                  </Button>
                </span>
              ) : null,
          } satisfies ColumnSpec,
        ]
      : []),
  ];

  const sums = (typeof total === "string" ? [total] : (total ?? [])).map((key) => {
    const f = fields.find((x) => x.name === key);
    // Numbers, and numbers written as text in a data file ("12.50").
    const sum = rows.reduce((n, r) => {
      const v = r[key];
      const num = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : 0;
      return n + num;
    }, 0);
    const format = typeof f?.format === "string" ? f.format : "number";
    return { key, label: f?.label ?? key, value: formatValue(Math.round(sum * 100) / 100, format, {}) };
  });

  return (
    <div ref={root} className={cn("my-6", className)}>
      {(title || description) && (
        <div className="mb-2">
          {title && <div className="font-semibold">{title}</div>}
          {description && <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>}
        </div>
      )}
      <Table data={rows} columns={columns} sort={sort ?? "-_at"} empty="No entries yet." cards={cards} className="my-0" />
      {sums.length > 0 && (
        <p className="mt-2 flex flex-wrap justify-end gap-x-5 text-sm">
          {sums.map((s) => (
            <span key={s.key}>
              <span className="text-muted-foreground">Total {s.label}:</span> <span className="font-medium tabular-nums">{s.value}</span>
            </span>
          ))}
        </p>
      )}
      {viewer.canWrite &&
        (editing ? (
          <form onSubmit={save} className="mt-3 flex flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-card">
            <div className="grid gap-4 sm:grid-cols-2">
              {fields.map((f) => (
                <FieldControl
                  key={f.name}
                  field={f}
                  fid={`ledger-${id}-${f.name}`}
                  value={editing.values[f.name] ?? emptyValue(f)}
                  onChange={(v) => {
                    setEditing((cur) => (cur ? { ...cur, values: { ...cur.values, [f.name]: v } } : cur));
                    setError(null);
                  }}
                  onEnter={save}
                  invalid={error?.field === f.name}
                  errorId={errorId}
                />
              ))}
            </div>
            {error && (
              <p id={errorId} role="alert" className="text-sm text-negative">
                {error.text}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={save}>
                {editing.key ? "Save" : addLabel}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button type="button" size="sm" variant="secondary" className="mt-3" data-ledger-add="" onClick={() => start(null)}>
            <Plus /> {addLabel}
          </Button>
        ))}
    </div>
  );
}

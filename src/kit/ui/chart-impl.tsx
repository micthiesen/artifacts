// Recharts-backed chart body. Loaded lazily by <Chart> so pages without charts
// never download recharts.
import * as React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Row } from "./table.tsx";
import { humanize } from "./utils.ts";

export type ChartImplProps = {
  type: "line" | "bar" | "area" | "pie";
  rows: Row[];
  x: string;
  y: string[];
  height: number;
  stacked?: boolean;
  colors?: string[];
  legend?: boolean;
};

const palette = Array.from({ length: 6 }, (_, i) => `var(--chart-${i + 1})`);
const numberFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, notation: "compact" });
const fullFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const TOOLTIP_ROWS = 8;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * For an x-axis of ISO dates or times: "Oct 4" (with the year when the data spans more than one), or the time of
 * day when timestamps fall within two days. Anything else stays as written.
 */
function dateLabels(rows: Row[], x: string): ((v: unknown) => string) | null {
  const values = rows.map((r) => r[x]);
  if (!values.length || !values.every((v) => typeof v === "string" && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v)))) return null;
  const strings = values as string[];
  const times = strings.some((v) => v.length > 10);
  const ms = strings.map((v) => Date.parse(v));
  const spanDays = (Math.max(...ms) - Math.min(...ms)) / 86_400_000;
  const years = new Set(strings.map((v) => v.slice(0, 4)));
  return (v) => {
    if (typeof v !== "string" || !ISO_DATE.test(v) || Number.isNaN(Date.parse(v))) return String(v ?? "");
    const d = new Date(v);
    if (times && v.length > 10 && spanDays < 2) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    // A bare date is that calendar day wherever the reader is.
    const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(years.size > 1 ? { year: "numeric" } : {}), ...(v.length === 10 ? { timeZone: "UTC" } : {}) });
    return times && v.length > 10 && spanDays < 14 ? `${day}, ${d.toLocaleTimeString(undefined, { hour: "numeric" })}` : day;
  };
}

const axis = {
  stroke: "var(--muted-foreground)",
  tick: { fill: "var(--muted-foreground)", fontSize: 12 },
  tickLine: false,
  axisLine: false,
} as const;

function TooltipBox({
  active,
  payload,
  label,
  formatLabel,
}: {
  active?: boolean;
  payload?: { name?: string; value?: unknown; color?: string; payload?: Row }[];
  label?: unknown;
  formatLabel?: ((v: unknown) => string) | null;
}) {
  if (!active || !payload?.length) return null;
  // A tooltip can't scroll, so many series stop at a count of the rest.
  const shown = payload.length > TOOLTIP_ROWS ? payload.slice(0, TOOLTIP_ROWS - 1) : payload;
  return (
    <div className="max-w-[min(20rem,calc(100vw-2rem))] min-w-32 rounded-lg border border-input/70 bg-popover px-3 py-2 text-[13px] text-popover-foreground shadow-pop">
      {label != null && label !== "" && <div className="mb-1 font-medium">{formatLabel ? formatLabel(label) : String(label)}</div>}
      {shown.map((p, i) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <span className="size-2 shrink-0 rounded-full" style={{ background: p.color }} />
            <span className="truncate">{humanize(String(p.name ?? ""))}</span>
          </span>
          <span className="shrink-0 font-medium tabular-nums">{typeof p.value === "number" ? fullFmt.format(p.value) : String(p.value)}</span>
        </div>
      ))}
      {shown.length < payload.length && <div className="mt-0.5 text-muted-foreground">and {payload.length - shown.length} more</div>}
    </div>
  );
}

export default function ChartImpl({ type, rows, x, y, height, stacked, colors, legend }: ChartImplProps) {
  const c = colors?.length ? colors : palette;
  const gid = React.useId().replace(/:/g, "");
  const showLegend = legend ?? (y.length > 1 || type === "pie");
  const legendEl = showLegend ? (
    // Recharts takes the legend's height out of the plot, so on a phone many series would leave no plot at all:
    // the legend gets at most a third of the chart and scrolls past that.
    <Legend
      iconType="circle"
      iconSize={8}
      wrapperStyle={{ fontSize: 13, color: "var(--muted-foreground)", maxHeight: Math.round(height / 3), overflowY: "auto", overscrollBehavior: "contain" }}
      formatter={(v) => humanize(String(v))}
    />
  ) : null;
  const common = { data: rows, margin: { top: 8, right: 8, bottom: 0, left: 0 } };
  const grid = <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />;
  const dates = dateLabels(rows, x);
  const xAxis = <XAxis dataKey={x} {...axis} tickMargin={8} minTickGap={16} {...(dates ? { tickFormatter: dates } : {})} />;
  const yAxis = <YAxis {...axis} width={44} tickFormatter={(v: number) => numberFmt.format(v)} />;
  const tooltip = <Tooltip content={<TooltipBox formatLabel={dates} />} cursor={type === "bar" ? { fill: "var(--muted)", opacity: 0.7 } : { stroke: "var(--input)" }} />;

  let chart: React.ReactElement;
  if (type === "pie") {
    const key = y[0];
    chart = (
      <PieChart>
        <Pie data={rows} dataKey={key} nameKey={x} innerRadius="55%" outerRadius="85%" paddingAngle={2} stroke="var(--card)" strokeWidth={2}>
          {rows.map((_, i) => (
            <Cell key={i} fill={c[i % c.length]} />
          ))}
        </Pie>
        <Tooltip content={<TooltipBox />} />
        {legendEl}
      </PieChart>
    );
  } else if (type === "bar") {
    chart = (
      <BarChart {...common} barCategoryGap="22%">
        {grid}
        {xAxis}
        {yAxis}
        {tooltip}
        {legendEl}
        {y.map((k, i) => (
          <Bar key={k} dataKey={k} fill={c[i % c.length]} radius={stacked ? 0 : [4, 4, 0, 0]} stackId={stacked ? "s" : undefined} maxBarSize={48} />
        ))}
      </BarChart>
    );
  } else if (type === "area") {
    chart = (
      <AreaChart {...common}>
        {/* Each area fades from its line into the ground. */}
        <defs>
          {y.map((k, i) => (
            <linearGradient key={k} id={`${gid}-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={c[i % c.length]} stopOpacity={0.32} />
              <stop offset="100%" stopColor={c[i % c.length]} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        {grid}
        {xAxis}
        {yAxis}
        {tooltip}
        {legendEl}
        {y.map((k, i) => (
          <Area
            key={k}
            dataKey={k}
            type="monotone"
            stroke={c[i % c.length]}
            fill={`url(#${gid}-${i})`}
            fillOpacity={1}
            strokeWidth={2}
            stackId={stacked ? "s" : undefined}
          />
        ))}
      </AreaChart>
    );
  } else {
    chart = (
      <LineChart {...common}>
        {grid}
        {xAxis}
        {yAxis}
        {tooltip}
        {legendEl}
        {y.map((k, i) => (
          <Line key={k} dataKey={k} type="monotone" stroke={c[i % c.length]} strokeWidth={2} dot={rows.length <= 24 ? { r: 2.5, strokeWidth: 0, fill: c[i % c.length] } : false} activeDot={{ r: 4.5, stroke: "var(--card)", strokeWidth: 2 }} />
        ))}
      </LineChart>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      {chart}
    </ResponsiveContainer>
  );
}

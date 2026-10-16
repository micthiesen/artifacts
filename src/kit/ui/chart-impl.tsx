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

const axis = {
  stroke: "var(--muted-foreground)",
  tick: { fill: "var(--muted-foreground)", fontSize: 12 },
  tickLine: false,
  axisLine: false,
} as const;

function TooltipBox({ active, payload, label }: { active?: boolean; payload?: { name?: string; value?: unknown; color?: string; payload?: Row }[]; label?: unknown }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-32 rounded-lg border border-input/70 bg-popover px-3 py-2 text-[13px] text-popover-foreground shadow-pop">
      {label != null && label !== "" && <div className="mb-1 font-medium">{String(label)}</div>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="size-2 rounded-full" style={{ background: p.color }} />
            {humanize(String(p.name ?? ""))}
          </span>
          <span className="font-medium tabular-nums">{typeof p.value === "number" ? fullFmt.format(p.value) : String(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

export default function ChartImpl({ type, rows, x, y, height, stacked, colors, legend }: ChartImplProps) {
  const c = colors?.length ? colors : palette;
  const gid = React.useId().replace(/:/g, "");
  const showLegend = legend ?? (y.length > 1 || type === "pie");
  const legendEl = showLegend ? (
    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 13, color: "var(--muted-foreground)" }} formatter={(v) => humanize(String(v))} />
  ) : null;
  const common = { data: rows, margin: { top: 8, right: 8, bottom: 0, left: 0 } };
  const grid = <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />;
  const xAxis = <XAxis dataKey={x} {...axis} tickMargin={8} minTickGap={16} />;
  const yAxis = <YAxis {...axis} width={44} tickFormatter={(v: number) => numberFmt.format(v)} />;
  const tooltip = <Tooltip content={<TooltipBox />} cursor={type === "bar" ? { fill: "var(--muted)", opacity: 0.7 } : { stroke: "var(--input)" }} />;

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

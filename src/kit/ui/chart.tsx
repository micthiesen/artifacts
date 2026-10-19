import * as React from "react";
import type { ChartImplProps } from "./chart-impl.tsx";
import { ErrorBoundary } from "./error.tsx";
import { Skeleton } from "./primitives.tsx";
import { useRows } from "./table.tsx";
import { cn } from "./utils.ts";

const ChartImpl = React.lazy(() => import("./chart-impl.tsx"));

export type ChartProps = {
  type?: "line" | "bar" | "area" | "pie";
  /** "metrics.json" (from data/) or an array of row objects. */
  data: string | unknown[];
  /** Category / x-axis key (the slice name for pie). */
  x: string;
  /** One or more numeric series keys: "users", ["users", "teams"], "users teams" or "Daily median, Weekly median". */
  y: string | string[];
  height?: number;
  stacked?: boolean;
  legend?: boolean;
  colors?: string[];
  title?: React.ReactNode;
  className?: string;
};

export function Chart(props: ChartProps) {
  return (
    <ErrorBoundary label="Chart">
      <ChartInner {...props} />
    </ErrorBoundary>
  );
}

function ChartInner({ type = "line", data, x, y, height = 280, stacked, legend, colors, title, className }: ChartProps) {
  const rows = useRows(data);
  // "users teams" is two series; a key that itself has spaces ("Daily median") is one; commas always separate.
  const ys = Array.isArray(y) ? y : y.includes(",") ? y.split(",").map((k) => k.trim()).filter(Boolean) : rows.some((r) => y in r) ? [y] : y.split(/\s+/).filter(Boolean);
  return (
    <figure className={cn("my-6 rounded-xl border border-border bg-card px-4 pt-4 pb-3 shadow-card", className)}>
      {title && <figcaption className="mb-3 px-1 text-sm font-medium">{title}</figcaption>}
      <React.Suspense fallback={<Skeleton style={{ height }} />}>
        <ChartImpl {...({ type, rows, x, y: ys, height, stacked, legend, colors } satisfies ChartImplProps)} />
      </React.Suspense>
    </figure>
  );
}

/** Tiny inline trend line. `data` is numbers, or rows with `y`. */
export function Sparkline({
  data,
  y,
  width = 96,
  height = 24,
  tone = "primary",
  className,
}: {
  data: number[] | string | unknown[];
  y?: string;
  width?: number;
  height?: number;
  tone?: "primary" | "positive" | "negative" | "muted";
  className?: string;
}) {
  const rows = useRows(typeof data === "string" || (Array.isArray(data) && typeof data[0] === "object") ? (data as string | unknown[]) : undefined);
  const values: number[] =
    Array.isArray(data) && typeof data[0] !== "object"
      ? (data as unknown[]).map(Number)
      : rows.map((r) => Number(y ? r[y] : Object.values(r).find((v) => typeof v === "number")));
  const nums = values.filter((n) => Number.isFinite(n));
  if (nums.length < 2) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const step = width / (nums.length - 1);
  const pts = nums.map((n, i) => `${(i * step).toFixed(1)},${(height - 2 - ((n - min) / span) * (height - 4)).toFixed(1)}`);
  const colors = { primary: "var(--primary)", positive: "var(--positive)", negative: "var(--negative)", muted: "var(--muted-foreground)" };
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn("inline-block align-middle", className)} aria-hidden>
      <polyline points={pts.join(" ")} fill="none" stroke={colors[tone]} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

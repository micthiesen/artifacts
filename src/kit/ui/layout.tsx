// Page structure and content blocks for readable reports.
import { ArrowDownRight, ArrowUpRight, CircleCheck, Info, OctagonAlert, TriangleAlert } from "./icons.ts";
import * as React from "react";
import { cn } from "./utils.ts";

type Children = { children?: React.ReactNode; className?: string };

/** Readable centered column. `wide` widens it for dashboards and big tables. */
export function Page({ title, subtitle, wide, children, className }: Children & { title?: React.ReactNode; subtitle?: React.ReactNode; wide?: boolean }) {
  return (
    <div className={cn("art-page mx-auto w-full px-5 pt-10 pb-20 sm:px-8 sm:pt-14", wide ? "max-w-5xl" : "max-w-3xl", className)}>
      {(title || subtitle) && (
        <header className="mb-10">
          {title && <h1 className="font-display text-[2.15rem] leading-[1.1] font-semibold tracking-[-0.012em] text-balance sm:text-[2.6rem]">{title}</h1>}
          {subtitle && <p className="mt-3 text-lg leading-relaxed text-pretty text-muted-foreground">{subtitle}</p>}
        </header>
      )}
      {children}
    </div>
  );
}

export function Section({ title, description, children, className }: Children & { title?: React.ReactNode; description?: React.ReactNode }) {
  return (
    <section className={cn("mt-12 first:mt-0 [[data-b]:first-child>&]:mt-0", className)}>
      {(title || description) && (
        <div className="mb-5">
          {title && <h2 className="font-display text-[1.6rem] leading-snug font-semibold tracking-[-0.01em]">{title}</h2>}
          {description && <p className="mt-1.5 text-[15px] text-muted-foreground">{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

const gridCols: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5",
  6: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6",
};

/** Responsive grid; collapses to fewer columns on narrow screens. */
export function Grid({ cols = 2, gap = 4, children, className }: Children & { cols?: 1 | 2 | 3 | 4 | 5 | 6; gap?: 2 | 3 | 4 | 6 | 8 }) {
  const gaps: Record<number, string> = { 2: "gap-2", 3: "gap-3", 4: "gap-4", 6: "gap-6", 8: "gap-8" };
  return <div className={cn("my-6 grid", gridCols[cols] ?? gridCols[2], gaps[gap] ?? "gap-4", className)}>{children}</div>;
}

export function Stack({
  direction = "col",
  gap = 3,
  align,
  children,
  className,
}: Children & { direction?: "row" | "col"; gap?: 1 | 2 | 3 | 4 | 6 | 8; align?: "start" | "center" | "end" | "between" }) {
  const gaps: Record<number, string> = { 1: "gap-1", 2: "gap-2", 3: "gap-3", 4: "gap-4", 6: "gap-6", 8: "gap-8" };
  const aligns: Record<string, string> = { start: "items-start", center: "items-center", end: "items-end", between: "items-center justify-between" };
  // art-stack: a stack that is a top-level block of a document gets a paragraph's spacing (kit.css).
  return (
    <div
      className={cn(
        "art-stack flex",
        direction === "row"
          ? // In a row with an avatar (a byline), text takes the rest of the row and wraps beside the avatar instead of
            // dropping below it. Other rows wrap their items as they are.
            "flex-row flex-wrap has-[>.art-avatar]:[&>:is(span,p):not(.inline-flex)]:min-w-0 has-[>.art-avatar]:[&>:is(span,p):not(.inline-flex)]:flex-[1_1_12rem] [&>p]:my-0"
          : "flex-col",
        gaps[gap],
        align && aligns[align],
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The lead: one or two sentences with the answer, set larger than body text. */
export function Summary({ children, className }: Children) {
  return (
    <div
      className={cn(
        "my-8 rounded-xl border border-primary/20 bg-primary/[0.09] px-5 py-4 text-[1.1875rem] leading-[1.6] text-pretty text-foreground [&_p]:my-0 [&_p+p]:mt-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

const calloutTones = {
  info: { icon: Info, box: "bg-accent/45 border-primary/25", icon_: "text-primary" },
  success: { icon: CircleCheck, box: "bg-positive/[0.07] border-positive/25", icon_: "text-positive" },
  warning: { icon: TriangleAlert, box: "bg-caution/[0.07] border-caution/25", icon_: "text-caution" },
  danger: { icon: OctagonAlert, box: "bg-negative/[0.08] border-negative/30", icon_: "text-negative" },
} as const;

export function Callout({ tone = "info", title, children, className }: Children & { tone?: keyof typeof calloutTones; title?: React.ReactNode }) {
  const t = calloutTones[tone] ?? calloutTones.info;
  const Icon = t.icon;
  return (
    <div className={cn("my-6 flex gap-3 rounded-lg border px-4 py-3.5 text-[15px] leading-relaxed", t.box, className)} role="note">
      <Icon className={cn("mt-[3px] size-[18px] shrink-0", t.icon_)} />
      {/* Lists sit under the title, with the callout's own size and spacing rather than the article's. */}
      <div className="min-w-0 flex-1 [&_p]:my-0 [&_p+p]:mt-2 [&_ol]:my-2 [&_ol]:pl-[1.1rem] [&_ol]:text-[15px] [&_ol]:leading-relaxed [&_ul]:my-2 [&_ul]:pl-[1.1rem] [&_ul]:text-[15px] [&_ul]:leading-relaxed [&_li]:my-1 [&_li]:pl-0.5">
        {title && <div className="mb-0.5 font-semibold">{title}</div>}
        {children}
      </div>
    </div>
  );
}

/** A headline number. `delta` like "+12%" or -3 is colored by sign; `invert` flips good/bad. */
export function Stat({
  label,
  value,
  delta,
  hint,
  invert,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  delta?: string | number;
  hint?: React.ReactNode;
  invert?: boolean;
  className?: string;
}) {
  let sign = 0;
  if (typeof delta === "number") sign = Math.sign(delta);
  else if (typeof delta === "string") sign = /^\s*[-−–]/.test(delta) ? -1 : /^\s*\+/.test(delta) ? 1 : 0;
  const good = invert ? sign < 0 : sign > 0;
  const deltaText = typeof delta === "number" ? (delta > 0 ? `+${delta}` : String(delta)) : delta;
  return (
    <div className={cn("rounded-xl border border-border bg-card px-5 py-4 shadow-card", className)}>
      <div className="text-[13px] font-medium tracking-[0.01em] text-muted-foreground">{label}</div>
      {/* A long delta drops under the value rather than breaking inside itself; the value never breaks. */}
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <span className="text-[1.75rem] leading-tight font-semibold tracking-tight whitespace-nowrap tabular-nums">{value}</span>
        {deltaText != null && deltaText !== "" && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-sm font-medium whitespace-nowrap tabular-nums",
              sign === 0 ? "text-muted-foreground" : good ? "text-positive" : "text-negative",
            )}
          >
            {sign > 0 && <ArrowUpRight className="size-3.5" />}
            {sign < 0 && <ArrowDownRight className="size-3.5" />}
            {deltaText}
          </span>
        )}
      </div>
      {hint && <div className="mt-1 text-[13px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

/**
 * A responsive row of <Stat>s, as one panel divided into cells. Each cell keeps its own right and bottom border and
 * reaches 1px past its track, so the panel clips the rules on its outer edge and empty cells in a short last row
 * stay blank. Borders, unlike shadows, survive printing.
 */
export function Stats({ children, className }: Children) {
  const n = React.Children.count(children);
  return (
    <div
      className={cn(
        "my-6 grid overflow-hidden rounded-xl border border-border bg-card shadow-card",
        "*:-mr-px *:-mb-px *:rounded-none *:border-t-0 *:border-l-0 *:bg-transparent *:shadow-none",
        n >= 4 ? "grid-cols-2 lg:grid-cols-4" : n === 3 ? "grid-cols-1 sm:grid-cols-3" : n === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Numbered steps: <Steps><Step title="…">…</Step></Steps> */
export function Steps({ children, className }: Children) {
  const items = React.Children.toArray(children).filter(React.isValidElement);
  return (
    <ol className={cn("my-6 flex flex-col", className)}>
      {items.map((child, i) => (
        <li key={i} className="relative flex gap-4 pb-6 last:pb-0">
          {i < items.length - 1 && <span className="absolute top-8 bottom-1 left-[13px] w-px bg-border" aria-hidden />}
          <span className="z-10 flex size-7 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-accent text-[13px] font-semibold text-accent-foreground tabular-nums">
            {i + 1}
          </span>
          <div className="min-w-0 flex-1 pt-0.5">{child}</div>
        </li>
      ))}
    </ol>
  );
}
export function Step({ title, children }: Children & { title?: React.ReactNode }) {
  return (
    <div className="[&_p]:my-1">
      {title && <div className="leading-snug font-semibold">{title}</div>}
      {children && <div className="mt-1 text-[15px] leading-relaxed text-muted-foreground">{children}</div>}
    </div>
  );
}

/** Dated events: <Timeline><TimelineItem date="Mar 3" title="…">…</TimelineItem></Timeline> */
export function Timeline({ children, className }: Children) {
  return <ol className={cn("my-6 ml-1.5 border-l border-border", className)}>{children}</ol>;
}
export function TimelineItem({ date, title, tone, children }: Children & { date?: React.ReactNode; title?: React.ReactNode; tone?: "default" | "primary" | "positive" | "caution" | "negative" }) {
  const dot: Record<string, string> = {
    default: "bg-muted-foreground/50",
    primary: "bg-primary",
    positive: "bg-positive",
    caution: "bg-caution",
    negative: "bg-negative",
  };
  return (
    <li className="relative pb-6 pl-6 last:pb-0">
      <span className={cn("absolute top-[7px] -left-[5px] size-2.5 rounded-full ring-4 ring-background", dot[tone ?? "default"] ?? dot.default)} aria-hidden />
      {date && <div className="text-[13px] text-muted-foreground tabular-nums">{date}</div>}
      {title && <div className="leading-snug font-semibold">{title}</div>}
      {children && <div className="mt-1 text-[15px] leading-relaxed text-muted-foreground [&_p]:my-1">{children}</div>}
    </li>
  );
}

/** External link; opens in a new tab through the shell. */
export function Link({ href, children, className, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("font-medium text-primary underline decoration-primary/30 underline-offset-[3px] transition-colors hover:decoration-primary", className)}
      {...props}
    >
      {children}
    </a>
  );
}

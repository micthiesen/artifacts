// @a/ui: the component kit available to every artifact.
import { Chart, Sparkline } from "./chart.tsx";
import { Diagram } from "./diagram.tsx";
import { Approval, Checklist, Comments, Form, Notes, Poll } from "./collab.tsx";
import * as controls from "./controls.tsx";
import { Callout, Grid, Link, Page, Section, Stack, Stat, Stats, Step, Steps, Summary, Timeline, TimelineItem } from "./layout.tsx";
import { markdownComponents } from "./mdx.tsx";
import * as primitives from "./primitives.tsx";
import { Table } from "./table.tsx";

export * from "./primitives.tsx";
export * from "./controls.tsx";
export * from "./layout.tsx";
export { Table, formatValue } from "./table.tsx";
export type { TableProps, ColumnSpec, Format } from "./table.tsx";
export { Chart, Sparkline } from "./chart.tsx";
export type { ChartProps } from "./chart.tsx";
export { Diagram } from "./diagram.tsx";
export type { DiagramProps } from "./diagram.tsx";
export { Poll, Checklist, Comments, Notes, Approval, Form } from "./collab.tsx";
export type { FormField } from "./collab.tsx";
export { ErrorBoundary, ErrorPanel } from "./error.tsx";
export { cn, displayName, relativeTime } from "./utils.ts";

const kitComponents = {
  ...primitives,
  ...controls,
  Page,
  Section,
  Grid,
  Stack,
  Summary,
  Callout,
  Stat,
  Stats,
  Steps,
  Step,
  Timeline,
  TimelineItem,
  Link,
  Table,
  Chart,
  Sparkline,
  Diagram,
  Poll,
  Checklist,
  Comments,
  Notes,
  Approval,
  Form,
};

const allComponents = { ...kitComponents, ...markdownComponents };

/** MDX provider hook: every kit component plus styled markdown elements. */
export function useMDXComponents(components?: Record<string, unknown>) {
  return components ? { ...allComponents, ...components } : allComponents;
}

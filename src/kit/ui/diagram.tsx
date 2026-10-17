import * as React from "react";
import { ErrorBoundary } from "./error.tsx";
import { Skeleton } from "./primitives.tsx";
import { cn } from "./utils.ts";

const DiagramImpl = React.lazy(() => import("./diagram-impl.tsx"));

export type DiagramProps = {
  /** Mermaid source. Children work too: <Diagram>{`flowchart LR …`}</Diagram>. */
  code?: string;
  children?: React.ReactNode;
  title?: React.ReactNode;
  className?: string;
};

/** A Mermaid diagram (flowchart, sequence, state, ER, class, gantt, mindmap…) rendered by Pele. */
export function Diagram(props: DiagramProps) {
  return (
    <ErrorBoundary label="Diagram" report>
      <DiagramInner {...props} />
    </ErrorBoundary>
  );
}

function DiagramInner({ code, children, title, className }: DiagramProps) {
  const source = (code ?? textOf(children)).trim();
  return (
    <figure className={cn("my-6 rounded-xl border border-border bg-card p-4 shadow-card", className)}>
      {title && <figcaption className="mb-3 px-1 text-sm font-medium">{title}</figcaption>}
      <React.Suspense fallback={<Skeleton className="h-48" />}>
        <DiagramImpl code={source} />
      </React.Suspense>
    </figure>
  );
}

function textOf(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

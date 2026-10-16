import * as React from "react";
import { post } from "../store.ts";
import { Callout } from "./layout.tsx";

type Props = { children?: React.ReactNode; label?: string; report?: boolean };

/** Catches render errors and shows a friendly panel. With `report`, also tells the shell. */
export class ErrorBoundary extends React.Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    if (this.props.report) {
      const e = error instanceof Error ? error : new Error(String(error));
      post({ t: "error", message: e.message, stack: [e.stack, info.componentStack].filter(Boolean).join("\n") });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <ErrorPanel title={this.props.label ? `${this.props.label} failed` : undefined} error={error} />;
  }
}

export function ErrorPanel({ title = "This part of the artifact failed to render", error }: { title?: string; error: Error }) {
  return (
    <Callout tone="danger" title={title}>
      <p className="text-[14px]">{error.message}</p>
      {error.stack && (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Details</summary>
          <pre className="mt-2 max-h-60 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{error.stack}</pre>
        </details>
      )}
    </Callout>
  );
}

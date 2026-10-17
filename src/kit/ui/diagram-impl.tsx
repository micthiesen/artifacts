// Pele-backed diagram body. Loaded lazily by <Diagram>, and pele/lazy then
// loads only the diagram types a page uses, so pages without diagrams never
// download Pele.
import * as React from "react";
import { mountAsync, type Mounted } from "pele/lazy";
import { post } from "../store.ts";
import { Callout } from "./layout.tsx";

export default function DiagramImpl({ code }: { code: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState<unknown>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    let mounted: Mounted | undefined;
    let failed = false;
    const fail = (err: unknown) => {
      if (cancelled || failed) return;
      failed = true;
      setError(err);
      // Reaches the render check, so a broken diagram fails the write's check.
      post({ t: "error", message: `Diagram: ${describe(err)}` });
    };
    setError(null);
    // In the reading column (about 670 px), wide left-to-right diagrams may
    // stack vertically instead of shrinking to unreadable text.
    mountAsync(el, code, { links: false, images: false, directionBreakpoint: 720, onError: fail }).then(
      (m) => {
        if (cancelled) return m.destroy();
        mounted = m;
        if (!m.result && m.error) fail(m.error);
      },
      fail,
    );
    return () => {
      cancelled = true;
      mounted?.destroy();
      el.replaceChildren();
    };
  }, [code]);

  return (
    <>
      <div ref={ref} className="art-diagram" hidden={!!error} />
      {error != null && (
        <Callout tone="danger" title="Diagram failed to render">
          <pre className="overflow-x-auto font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{describe(error)}</pre>
        </Callout>
      )}
    </>
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

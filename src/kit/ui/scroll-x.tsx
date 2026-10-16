// Horizontal scroller that fades the edges that have more content, so wide
// tables on phones visibly scroll instead of looking clipped.
import * as React from "react";
import { cn } from "./utils.ts";

export function ScrollX({ className, children }: { className?: string; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState({ left: false, right: false });

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, []);

  const fade = "2.25rem";
  const mask =
    edges.left || edges.right
      ? `linear-gradient(to right, ${edges.left ? "transparent" : "black"}, black ${edges.left ? fade : "0"}, black calc(100% - ${
          edges.right ? fade : "0px"
        }), ${edges.right ? "transparent" : "black"})`
      : undefined;

  return (
    <div ref={ref} className={cn("overflow-x-auto", className)} style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}>
      {children}
    </div>
  );
}

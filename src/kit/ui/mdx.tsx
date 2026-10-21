// Markdown element overrides so MDX reads like a well-set article with no imports.
import { ScrollX } from "./scroll-x.tsx";
import { assetUrl, linkTitle } from "../store.ts";
import { Contents, TaskCheckbox } from "./page-extras.tsx";
import * as React from "react";
import { cn } from "./utils.ts";

type P<T extends keyof React.JSX.IntrinsicElements> = React.ComponentProps<T>;

/**
 * A markdown table. On phones, one with more than three columns reads as cards, like a Table: each cell is
 * labelled with its column (set here from the header row) and the CSS lays rows out as label: value.
 */
function MarkdownTable({ className, ...p }: P<"table">) {
  const ref = React.useRef<HTMLTableElement>(null);
  const [cards, setCards] = React.useState(false);
  // Before paint, so phones don't see the table flash first. Roles keep it a table to screen readers as cards.
  React.useLayoutEffect(() => {
    const table = ref.current;
    if (!table) return;
    const heads = [...table.querySelectorAll(":scope > thead th")].map((th) => th.textContent?.trim() ?? "");
    const wide = heads.length > 3;
    table.setAttribute("role", "table");
    for (const tr of table.querySelectorAll(":scope > tbody > tr")) {
      tr.setAttribute("role", "row");
      [...tr.children].forEach((td, i) => {
        td.setAttribute("role", "cell");
        if (wide) td.setAttribute("data-label", heads[i] ?? "");
        else td.removeAttribute("data-label");
      });
    }
    setCards(wide);
  }, [p.children]);
  return (
    <div className={cn("my-6 overflow-hidden rounded-xl border border-border bg-card shadow-card", cards && "md-cards")}>
      <ScrollX>
        <table ref={ref} className={cn("w-full border-collapse text-[14px] leading-snug [&_td[style*=right]]:tabular-nums", className)} {...p} />
      </ScrollX>
    </div>
  );
}

export const markdownComponents = {
  // A long page lists its sections under the (first) title.
  h1: ({ className, ...p }: P<"h1">) => (
    <>
      <h1 className={cn("mt-0 mb-6 font-display text-[2.15rem] leading-[1.1] font-semibold tracking-[-0.012em] text-balance sm:text-[2.6rem]", className)} {...p} />
      <Contents />
    </>
  ),
  h2: ({ className, ...p }: P<"h2">) => (
    <h2 className={cn("mt-12 mb-4 scroll-mt-6 font-display text-[1.6rem] leading-snug font-semibold tracking-[-0.01em] text-balance first:mt-0", className)} {...p} />
  ),
  h3: ({ className, ...p }: P<"h3">) => <h3 className={cn("mt-8 mb-3 text-[1.125rem] leading-snug font-semibold tracking-[-0.01em]", className)} {...p} />,
  h4: ({ className, ...p }: P<"h4">) => <h4 className={cn("mt-6 mb-2 text-base font-semibold", className)} {...p} />,
  // Body copy sits a touch below full white to cut glare on the dark ground (still >12:1).
  p: ({ className, ...p }: P<"p">) => <p className={cn("my-4 text-base leading-[1.75] text-pretty text-foreground/[0.9]", className)} {...p} />,
  a: ({ className, href, children, ...p }: P<"a">) => {
    const external = typeof href === "string" && /^(https?:|mailto:)/.test(href);
    // A bare link to another artifact here reads as its title.
    const bare = typeof children === "string" && typeof href === "string" && (children === href || children === href.replace(/^https?:\/\//, ""));
    const title = bare ? linkTitle(href) : null;
    return (
      <a
        href={href}
        className={cn("font-medium text-primary underline decoration-primary/30 underline-offset-[3px] transition-colors hover:decoration-primary", className)}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        {...p}
      >
        {title ?? children}
      </a>
    );
  },
  strong: ({ className, ...p }: P<"strong">) => <strong className={cn("font-semibold text-foreground", className)} {...p} />,
  ul: ({ className, ...p }: P<"ul">) => <ul className={cn("my-4 list-disc pl-6 text-base leading-[1.75] text-foreground/[0.9] marker:text-primary/70", className)} {...p} />,
  ol: ({ className, ...p }: P<"ol">) => (
    <ol className={cn("my-4 list-decimal pl-6 text-base leading-[1.75] text-foreground/[0.9] marker:font-medium marker:text-muted-foreground", className)} {...p} />
  ),
  li: ({ className, ...p }: P<"li">) => (
    <li className={cn("my-1.5 pl-1 [&>p]:my-1 [&>ol]:my-1.5 [&>ul]:my-1.5", className?.includes("task-list-item") && "-ml-6 list-none", className)} {...p} />
  ),
  // "- [ ] item" task lists: boxes people tick on the page (shared, like a Checklist).
  // Markdown makes these disabled and without handlers; a checkbox written as JSX keeps its own behaviour.
  input: (p: P<"input">) => (p.type === "checkbox" && p.disabled && !p.onChange ? <TaskCheckbox checked={p.checked} /> : <input {...p} />),
  blockquote: ({ className, ...p }: P<"blockquote">) => (
    <blockquote className={cn("my-6 border-l-[3px] border-input/60 pl-5 text-muted-foreground [&>p]:my-2 [&>p]:text-muted-foreground", className)} {...p} />
  ),
  code: ({ className, ...p }: P<"code">) => (
    <code className={cn("rounded-[5px] border border-border bg-muted px-[0.35em] py-[0.1em] font-mono text-[0.86em] break-words text-foreground", className)} {...p} />
  ),
  pre: ({ className, ...p }: P<"pre">) => (
    <pre
      className={cn(
        "my-6 overflow-x-auto rounded-lg border border-border bg-black/25 px-4 py-3.5 font-mono text-[13px] leading-relaxed text-foreground/[0.92] [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[inherit] [&_code]:break-normal",
        className,
      )}
      {...p}
    />
  ),
  table: (p: P<"table">) => <MarkdownTable {...p} />,
  thead: ({ className, ...p }: P<"thead">) => <thead className={cn("border-b border-border bg-muted/50", className)} {...p} />,
  tbody: ({ className, ...p }: P<"tbody">) => <tbody className={className} {...p} />,
  tr: ({ className, ...p }: P<"tr">) => <tr className={cn("border-b border-border/70 last:border-0", className)} {...p} />,
  th: ({ className, ...p }: P<"th">) => (
    <th className={cn("px-4 py-2.5 text-left font-medium whitespace-nowrap text-muted-foreground first:pl-5 last:pr-5", className)} {...p} />
  ),
  // On phones, cells keep a readable width and the table scrolls sideways.
  td: ({ className, ...p }: P<"td">) => <td className={cn("px-4 py-2.5 align-top first:pl-5 last:pr-5 max-sm:min-w-36", className)} {...p} />,
  hr: ({ className, ...p }: P<"hr">) => (
    <hr className={cn("my-10 h-px border-0 bg-border", className)} {...p} />
  ),
  img: ({ className, alt = "", src, ...p }: P<"img">) => (
    <img
      alt={alt}
      src={typeof src === "string" ? assetUrl(src) : src}
      className={cn("my-6 max-w-full rounded-lg border border-border", className)}
      {...p}
    />
  ),
};

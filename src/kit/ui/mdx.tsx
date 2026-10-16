// Markdown element overrides so MDX reads like a well-set article with no imports.
import { ScrollX } from "./scroll-x.tsx";
import { assetUrl } from "../store.ts";
import * as React from "react";
import { cn } from "./utils.ts";

type P<T extends keyof React.JSX.IntrinsicElements> = React.ComponentProps<T>;

export const markdownComponents = {
  h1: ({ className, ...p }: P<"h1">) => (
    <h1 className={cn("mt-0 mb-6 text-[2rem] leading-[1.15] font-semibold tracking-[-0.022em] text-balance sm:text-[2.35rem]", className)} {...p} />
  ),
  h2: ({ className, ...p }: P<"h2">) => (
    <h2 className={cn("mt-12 mb-4 scroll-mt-6 text-[1.375rem] leading-snug font-semibold tracking-[-0.015em] text-balance first:mt-0", className)} {...p} />
  ),
  h3: ({ className, ...p }: P<"h3">) => <h3 className={cn("mt-8 mb-3 text-[1.125rem] leading-snug font-semibold tracking-[-0.01em]", className)} {...p} />,
  h4: ({ className, ...p }: P<"h4">) => <h4 className={cn("mt-6 mb-2 text-base font-semibold", className)} {...p} />,
  p: ({ className, ...p }: P<"p">) => <p className={cn("my-4 text-base leading-[1.75] text-pretty", className)} {...p} />,
  a: ({ className, href, ...p }: P<"a">) => {
    const external = typeof href === "string" && /^(https?:|mailto:)/.test(href);
    return (
      <a
        href={href}
        className={cn("font-medium text-primary underline decoration-primary/30 underline-offset-[3px] transition-colors hover:decoration-primary", className)}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        {...p}
      />
    );
  },
  strong: ({ className, ...p }: P<"strong">) => <strong className={cn("font-semibold", className)} {...p} />,
  ul: ({ className, ...p }: P<"ul">) => <ul className={cn("my-4 list-disc pl-6 text-base leading-[1.75] marker:text-muted-foreground/70", className)} {...p} />,
  ol: ({ className, ...p }: P<"ol">) => <ol className={cn("my-4 list-decimal pl-6 text-base leading-[1.75] marker:text-muted-foreground", className)} {...p} />,
  li: ({ className, ...p }: P<"li">) => <li className={cn("my-1.5 pl-1 [&>p]:my-1 [&>ol]:my-1.5 [&>ul]:my-1.5", className)} {...p} />,
  blockquote: ({ className, ...p }: P<"blockquote">) => (
    <blockquote className={cn("my-6 border-l-[3px] border-border pl-5 text-muted-foreground [&>p]:my-2", className)} {...p} />
  ),
  code: ({ className, ...p }: P<"code">) => (
    <code className={cn("rounded-[5px] bg-muted px-[0.35em] py-[0.15em] font-mono text-[0.86em] break-words", className)} {...p} />
  ),
  pre: ({ className, ...p }: P<"pre">) => (
    <pre
      className={cn(
        "my-6 overflow-x-auto rounded-lg border border-border bg-muted/60 px-4 py-3.5 font-mono text-[13px] leading-relaxed [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[inherit] [&_code]:break-normal",
        className,
      )}
      {...p}
    />
  ),
  table: ({ className, ...p }: P<"table">) => (
    <div className="my-6 overflow-hidden rounded-xl border border-border bg-card">
      <ScrollX>
        <table className={cn("w-full border-collapse text-[14px] leading-snug", className)} {...p} />
      </ScrollX>
    </div>
  ),
  thead: ({ className, ...p }: P<"thead">) => <thead className={cn("border-b border-border bg-muted/50", className)} {...p} />,
  tbody: ({ className, ...p }: P<"tbody">) => <tbody className={className} {...p} />,
  tr: ({ className, ...p }: P<"tr">) => <tr className={cn("border-b border-border/70 last:border-0", className)} {...p} />,
  th: ({ className, ...p }: P<"th">) => (
    <th className={cn("px-4 py-2.5 text-left font-medium whitespace-nowrap text-muted-foreground first:pl-5 last:pr-5", className)} {...p} />
  ),
  // On phones, cells keep a readable width and the table scrolls sideways.
  td: ({ className, ...p }: P<"td">) => <td className={cn("px-4 py-2.5 align-top first:pl-5 last:pr-5 max-sm:min-w-36", className)} {...p} />,
  hr: ({ className, ...p }: P<"hr">) => <hr className={cn("my-10 border-0 border-t border-border", className)} {...p} />,
  img: ({ className, alt = "", src, ...p }: P<"img">) => (
    <img
      alt={alt}
      src={typeof src === "string" ? assetUrl(src) : src}
      className={cn("my-6 max-w-full rounded-lg border border-border", className)}
      {...p}
    />
  ),
};

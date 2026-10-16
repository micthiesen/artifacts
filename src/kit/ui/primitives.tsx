// Basic building blocks. APIs follow shadcn/ui conventions (MIT); see THIRD_PARTY_NOTICES.md.
import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import { Progress as BaseProgress } from "@base-ui/react/progress";
import { Separator as BaseSeparator } from "@base-ui/react/separator";
import * as React from "react";
import { cn, displayName, initials } from "./utils.ts";

type Div = React.HTMLAttributes<HTMLDivElement>;

// ---- Button ---------------------------------------------------------------------

const buttonVariants = {
  default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/70",
  outline: "border border-input bg-card text-foreground shadow-xs hover:bg-muted",
  ghost: "text-foreground hover:bg-muted",
  destructive: "bg-negative text-white shadow-xs hover:bg-negative/90",
  link: "text-primary underline-offset-4 hover:underline px-0 h-auto",
} as const;

const buttonSizes = {
  sm: "h-8 gap-1.5 rounded-md px-3 text-[13px]",
  default: "h-9 gap-2 rounded-md px-4 text-sm",
  lg: "h-10 gap-2 rounded-lg px-5 text-[15px]",
  icon: "size-9 rounded-md",
  "icon-sm": "size-8 rounded-md",
} as const;

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof buttonVariants;
  size?: keyof typeof buttonSizes;
};

export function buttonClass(variant: keyof typeof buttonVariants = "default", size: keyof typeof buttonSizes = "default") {
  return cn(
    "inline-flex shrink-0 cursor-pointer items-center justify-center font-medium whitespace-nowrap transition-colors select-none",
    "outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    buttonSizes[size],
    buttonVariants[variant],
  );
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "default", className, type = "button", ...props },
  ref,
) {
  return <button ref={ref} type={type} className={cn(buttonClass(variant, size), className)} {...props} />;
});

// ---- Badge ----------------------------------------------------------------------

const badgeTones = {
  neutral: "bg-muted text-muted-foreground border-transparent",
  primary: "bg-accent text-accent-foreground border-transparent",
  positive: "bg-positive/12 text-positive border-transparent",
  caution: "bg-caution/15 text-caution border-transparent",
  negative: "bg-negative/12 text-negative border-transparent",
  outline: "bg-transparent text-foreground border-border",
} as const;

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  tone?: keyof typeof badgeTones | "info" | "success" | "warning" | "danger";
};

const toneAlias: Record<string, keyof typeof badgeTones> = {
  info: "primary",
  success: "positive",
  warning: "caution",
  danger: "negative",
};

export function Badge({ tone = "neutral", className, ...props }: BadgeProps) {
  const t = toneAlias[tone] ?? (tone as keyof typeof badgeTones);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap [&_svg]:size-3",
        badgeTones[t] ?? badgeTones.neutral,
        className,
      )}
      {...props}
    />
  );
}

// ---- Card -----------------------------------------------------------------------

export function Card({ className, ...props }: Div) {
  return <div className={cn("rounded-xl border border-border bg-card text-card-foreground", className)} {...props} />;
}
export function CardHeader({ className, ...props }: Div) {
  return <div className={cn("flex flex-col gap-1 px-6 pt-5 pb-3", className)} {...props} />;
}
export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-base leading-snug font-semibold tracking-tight", className)} {...props} />;
}
export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
export function CardContent({ className, ...props }: Div) {
  return <div className={cn("px-6 pb-5 [&:first-child]:pt-5", className)} {...props} />;
}
export function CardFooter({ className, ...props }: Div) {
  return <div className={cn("flex items-center gap-2 border-t border-border px-6 py-3.5", className)} {...props} />;
}

// ---- Form fields ----------------------------------------------------------------

const fieldClass =
  "w-full min-w-0 rounded-md border border-input bg-card px-3 text-sm text-foreground shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground/80 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-60 read-only:cursor-default read-only:border-border read-only:bg-muted/40 read-only:shadow-none read-only:focus-visible:border-border read-only:focus-visible:ring-0";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, type = "text", ...props },
  ref,
) {
  return <input ref={ref} type={type} className={cn(fieldClass, "h-9 py-1", className)} {...props} />;
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, rows = 3, ...props }, ref) {
    return <textarea ref={ref} rows={rows} className={cn(fieldClass, "field-sizing-content min-h-20 py-2 leading-relaxed", className)} {...props} />;
  },
);

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("inline-flex items-center gap-2 text-sm leading-none font-medium select-none", className)} {...props} />;
}

// ---- Small things ---------------------------------------------------------------

export function Separator({ className, orientation = "horizontal", ...props }: { className?: string; orientation?: "horizontal" | "vertical" }) {
  return (
    <BaseSeparator
      orientation={orientation}
      className={cn("shrink-0 bg-border", orientation === "horizontal" ? "my-6 h-px w-full" : "mx-3 h-auto w-px self-stretch", className)}
      {...props}
    />
  );
}

export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-border border-b-2 bg-muted px-1 font-sans text-[11px] font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function Skeleton({ className, ...props }: Div) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}

export function Progress({ value, max = 100, label, className }: { value: number | null; max?: number; label?: React.ReactNode; className?: string }) {
  return (
    <BaseProgress.Root value={value} max={max} className={cn("flex w-full flex-col gap-1.5", className)}>
      {label != null && (
        <div className="flex items-center justify-between text-sm">
          <BaseProgress.Label className="font-medium">{label}</BaseProgress.Label>
          <BaseProgress.Value className="text-muted-foreground tabular-nums" />
        </div>
      )}
      <BaseProgress.Track className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <BaseProgress.Indicator className="h-full rounded-full bg-primary transition-[width] duration-500" />
      </BaseProgress.Track>
    </BaseProgress.Root>
  );
}

const avatarSizes = { sm: "size-6 text-[10px]", default: "size-8 text-xs", lg: "size-10 text-sm" } as const;

/** Avatar from an email (initials) or an image src (data: URLs only inside the frame). */
export function Avatar({
  email,
  name,
  src,
  size = "default",
  className,
}: {
  email?: string | null;
  name?: string;
  src?: string;
  size?: keyof typeof avatarSizes;
  className?: string;
}) {
  const label = name ?? displayName(email);
  const text = name ? name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() : initials(email);
  return (
    <BaseAvatar.Root
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent font-semibold text-accent-foreground ring-2 ring-background select-none",
        avatarSizes[size],
        className,
      )}
    >
      {src && <BaseAvatar.Image src={src} alt={label} className="size-full object-cover" />}
      <BaseAvatar.Fallback>{text}</BaseAvatar.Fallback>
    </BaseAvatar.Root>
  );
}

/** Overlapping avatars for a list of emails. */
export function AvatarGroup({ emails, max = 5, size = "sm" }: { emails: string[]; max?: number; size?: keyof typeof avatarSizes }) {
  const shown = emails.slice(0, max);
  return (
    <span className="inline-flex items-center -space-x-1.5">
      {shown.map((e) => (
        <Avatar key={e} email={e} size={size} />
      ))}
      {emails.length > max && <span className="pl-2.5 text-xs text-muted-foreground">+{emails.length - max}</span>}
    </span>
  );
}

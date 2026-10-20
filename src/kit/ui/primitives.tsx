// Basic building blocks. APIs follow shadcn/ui conventions (MIT); see THIRD_PARTY_NOTICES.md.
import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import { Progress as BaseProgress } from "@base-ui/react/progress";
import { Separator as BaseSeparator } from "@base-ui/react/separator";
import * as React from "react";
import { cn, displayName, initials } from "./utils.ts";

type Div = React.HTMLAttributes<HTMLDivElement>;

// ---- Button ---------------------------------------------------------------------

const buttonVariants = {
  // Signature gradient; the hover sheen and the press shade are an overlay that only fades opacity.
  default:
    "relative isolate bg-primary bg-signal font-semibold text-primary-foreground shadow-card after:absolute after:inset-0 after:-z-10 after:rounded-[inherit] after:bg-white/15 after:opacity-0 after:transition-opacity hover:after:opacity-100 active:after:bg-black/15 active:after:opacity-100",
  secondary: "border border-border bg-secondary text-secondary-foreground hover:border-input hover:bg-input/35 active:bg-input/50",
  outline: "border border-input bg-card text-foreground shadow-card hover:border-muted-foreground/65 hover:bg-muted active:bg-input/40",
  ghost: "text-foreground hover:bg-muted active:bg-input/40",
  destructive: "bg-negative font-semibold text-background shadow-card hover:bg-negative/90 active:bg-negative/80",
  link: "text-primary underline-offset-4 hover:underline active:text-primary/80 px-0 h-auto",
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
    "outline-none focus-visible:focus-halo",
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
  neutral: "bg-muted text-muted-foreground border-border",
  primary: "bg-accent text-accent-foreground border-primary/25",
  positive: "bg-positive/10 text-positive border-positive/25",
  caution: "bg-caution/10 text-caution border-caution/25",
  negative: "bg-negative/10 text-negative border-negative/30",
  outline: "bg-transparent text-foreground border-input",
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
  return <div className={cn("rounded-xl border border-border bg-card text-card-foreground shadow-card", className)} {...props} />;
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
  "w-full min-w-0 rounded-md border border-input bg-background/60 px-3 text-sm text-foreground transition-[border-color,box-shadow] outline-none placeholder:text-muted-foreground/80 hover:border-muted-foreground/65 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 aria-invalid:border-negative aria-invalid:focus-visible:border-negative aria-invalid:focus-visible:ring-negative/25 disabled:cursor-not-allowed disabled:opacity-60 read-only:cursor-default read-only:border-border read-only:bg-muted/40 read-only:shadow-none read-only:focus-visible:border-border read-only:focus-visible:ring-0";

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
  // Block-level, so the control under it starts on its own line and `space-y-*` or `gap` spaces them.
  return <label className={cn("flex w-fit items-center gap-2 text-sm leading-none font-medium select-none", className)} {...props} />;
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
      <BaseProgress.Track className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
        {/* Own fill (not Base UI's width-based indicator) so it animates with transform only. */}
        {value == null ? (
          <div className="absolute inset-y-0 left-0 w-1/3 animate-[art-indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-signal" />
        ) : (
          <div
            className="absolute inset-0 origin-left rounded-full bg-signal transition-transform duration-(--motion-data) ease-(--motion-ease)"
            style={{ transform: `scaleX(${Math.min(1, Math.max(0, max ? value / max : 0))})` }}
          />
        )}
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

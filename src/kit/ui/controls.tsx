// Interactive primitives on Base UI with shadcn-style APIs (patterns adapted from
// shadcn/ui, MIT; see THIRD_PARTY_NOTICES.md).
import { Accordion as BaseAccordion } from "@base-ui/react/accordion";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Popover as BasePopover } from "@base-ui/react/popover";
import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Slider as BaseSlider } from "@base-ui/react/slider";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { Check, ChevronDown, Minus, X } from "./icons.ts";
import * as React from "react";
import { buttonClass } from "./primitives.tsx";
import { cn } from "./utils.ts";

const popupMotion =
  "origin-[var(--transform-origin)] transition-[transform,opacity] duration-(--motion-base) ease-(--motion-ease) data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0";
const surface = "rounded-lg border border-input/70 bg-popover text-popover-foreground shadow-pop";

// ---- Select -----------------------------------------------------------------------

export type SelectOption = string | number | { value: string | number; label?: React.ReactNode; disabled?: boolean };

export function Select({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder = "Select…",
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  options: SelectOption[];
  value?: string | number | null;
  defaultValue?: string | number | null;
  onValueChange?: (value: string | number | null) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const items = options.map((o) => (typeof o === "object" ? { value: o.value, label: o.label ?? String(o.value), disabled: o.disabled } : { value: o, label: String(o) }));
  return (
    <BaseSelect.Root
      items={items}
      value={value}
      defaultValue={defaultValue}
      onValueChange={(v) => onValueChange?.(v as string | number | null)}
      disabled={disabled}
    >
      <BaseSelect.Trigger
        aria-label={ariaLabel}
        className={cn(
          "inline-flex h-9 min-w-40 cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-background/60 pr-2.5 pl-3 text-sm outline-none select-none",
          "hover:border-muted-foreground/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 data-disabled:opacity-60 data-popup-open:border-ring",
          className,
        )}
      >
        <BaseSelect.Value placeholder={placeholder} className="truncate data-placeholder:text-muted-foreground" />
        <BaseSelect.Icon className="text-muted-foreground">
          <ChevronDown className="size-4" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={6} alignItemWithTrigger={false} className="z-50 outline-none">
          <BaseSelect.Popup className={cn(surface, popupMotion, "max-h-[min(24rem,var(--available-height))] min-w-[var(--anchor-width)] max-w-[var(--available-width)] overflow-y-auto p-1")}>
            <BaseSelect.List>
              {items.map((it) => (
                <BaseSelect.Item
                  key={String(it.value)}
                  value={it.value}
                  disabled={it.disabled}
                  className="grid cursor-default grid-cols-[minmax(0,1fr)_1rem] items-center gap-3 rounded-md py-1.5 pr-2 pl-2.5 text-sm outline-none select-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground data-selected:font-medium"
                >
                  <BaseSelect.ItemText className="[overflow-wrap:anywhere]">{it.label}</BaseSelect.ItemText>
                  <BaseSelect.ItemIndicator className="text-primary">
                    <Check className="size-4" />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

// ---- Checkbox / Switch / Slider -------------------------------------------------------

type ToggleProps = {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: React.ReactNode;
  className?: string;
  id?: string;
  "aria-label"?: string;
};

function withLabel(control: React.ReactNode, label: React.ReactNode, disabled?: boolean) {
  if (label == null) return control;
  return (
    <label className={cn("inline-flex cursor-pointer items-center gap-2.5 text-sm leading-snug select-none", disabled && "cursor-not-allowed opacity-60")}>
      {control}
      <span>{label}</span>
    </label>
  );
}

export function Checkbox({ checked, defaultChecked, onCheckedChange, disabled, label, className, indeterminate, ...rest }: ToggleProps & { indeterminate?: boolean }) {
  return withLabel(
    <BaseCheckbox.Root
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={(c) => onCheckedChange?.(c)}
      disabled={disabled}
      indeterminate={indeterminate}
      className={cn(
        "inline-flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] border border-input bg-background/60 transition-colors outline-none hover:border-primary/60",
        "focus-visible:focus-halo data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:text-primary-foreground data-disabled:cursor-not-allowed",
        className,
      )}
      {...rest}
    >
      <BaseCheckbox.Indicator className="flex data-unchecked:hidden">
        {indeterminate ? <Minus className="size-3.5" strokeWidth={3} /> : <Check className="size-3.5" strokeWidth={3} />}
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>,
    label,
    disabled,
  );
}

export function Switch({ checked, defaultChecked, onCheckedChange, disabled, label, className, ...rest }: ToggleProps) {
  return withLabel(
    <BaseSwitch.Root
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={(c) => onCheckedChange?.(c)}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-input p-0.5 transition-colors outline-none focus-visible:focus-halo data-checked:bg-primary data-checked:bg-signal data-disabled:cursor-not-allowed",
        className,
      )}
      {...rest}
    >
      <BaseSwitch.Thumb className="size-4 rounded-full bg-foreground shadow-sm shadow-black/40 transition-transform duration-(--motion-fast) data-checked:translate-x-4 data-checked:bg-white" />
    </BaseSwitch.Root>,
    label,
    disabled,
  );
}

export function Slider({
  value,
  defaultValue,
  onValueChange,
  onValueCommitted,
  min = 0,
  max = 100,
  step = 1,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  value?: number | number[];
  defaultValue?: number | number[];
  onValueChange?: (value: number | number[]) => void;
  onValueCommitted?: (value: number | number[]) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const current = value ?? defaultValue ?? min;
  const thumbs = Array.isArray(current) ? current.length : 1;
  return (
    <BaseSlider.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={(v) => onValueChange?.(v as number | number[])}
      onValueCommitted={(v) => onValueCommitted?.(v as number | number[])}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={cn("w-full data-disabled:opacity-60", className)}
    >
      <BaseSlider.Control className="flex w-full cursor-pointer touch-none items-center py-2 select-none">
        <BaseSlider.Track className="relative h-1.5 w-full rounded-full bg-muted">
          <BaseSlider.Indicator className="rounded-full bg-primary bg-signal" />
          {Array.from({ length: thumbs }, (_, i) => (
            <BaseSlider.Thumb
              key={i}
              index={thumbs > 1 ? i : undefined}
              aria-label={ariaLabel}
              className="size-4 rounded-full border-2 border-primary bg-foreground shadow-sm shadow-black/40 outline-none focus-visible:focus-halo"
            />
          ))}
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  );
}

// ---- Tabs -------------------------------------------------------------------------

export function Tabs({ className, ...props }: React.ComponentProps<typeof BaseTabs.Root>) {
  return <BaseTabs.Root className={cn("flex flex-col gap-4", className as string)} {...props} />;
}
export function TabsList({ className, children, ...props }: React.ComponentProps<typeof BaseTabs.List>) {
  return (
    <BaseTabs.List
      className={cn("relative z-0 inline-flex w-fit items-center gap-1 rounded-lg border border-border bg-muted/70 p-1 text-muted-foreground", className as string)}
      {...props}
    >
      {children}
      {/* Active pill with a gradient underline; it slides via translate. */}
      <BaseTabs.Indicator className="absolute top-0 left-0 -z-10 h-[var(--active-tab-height)] w-[var(--active-tab-width)] translate-x-[var(--active-tab-left)] translate-y-[var(--active-tab-top)] rounded-md border border-border bg-popover shadow-card transition-[translate,width] duration-(--motion-base) ease-(--motion-ease) after:absolute after:inset-x-2.5 after:bottom-0 after:h-[2px] after:rounded-full after:bg-signal" />
    </BaseTabs.List>
  );
}
export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof BaseTabs.Tab>) {
  return (
    <BaseTabs.Tab
      className={cn(
        "inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors outline-none hover:text-foreground focus-visible:focus-halo data-active:text-foreground [&_svg]:size-4",
        className as string,
      )}
      {...props}
    />
  );
}
export function TabsContent({ className, ...props }: React.ComponentProps<typeof BaseTabs.Panel>) {
  return <BaseTabs.Panel className={cn("outline-none", className as string)} {...props} />;
}

// ---- Dialog -----------------------------------------------------------------------

export const Dialog = BaseDialog.Root;
export const DialogClose = BaseDialog.Close;

/** Pass `render={<Button />}` to use your own button; defaults to an outline button. */
export function DialogTrigger({ className, ...props }: React.ComponentProps<typeof BaseDialog.Trigger>) {
  return <BaseDialog.Trigger className={props.render ? (className as string) : cn(buttonClass("outline"), className as string)} {...props} />;
}

export function DialogContent({ className, children, showClose = true, ...props }: React.ComponentProps<typeof BaseDialog.Popup> & { showClose?: boolean }) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-black/60 transition-opacity duration-(--motion-base) data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <BaseDialog.Popup
        className={cn(
          surface,
          "before:pointer-events-none before:absolute before:inset-x-6 before:top-0 before:h-px before:bg-signal before:opacity-70",
          "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl p-6 shadow-2xl transition-[transform,opacity] duration-(--motion-base)",
          "data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0",
          className as string,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <BaseDialog.Close aria-label="Close" className={cn(buttonClass("ghost", "icon-sm"), "absolute top-3 right-3 text-muted-foreground")}>
            <X />
          </BaseDialog.Close>
        )}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}
export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5 pr-6", className)} {...props} />;
}
export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}
export function DialogTitle({ className, ...props }: React.ComponentProps<typeof BaseDialog.Title>) {
  return <BaseDialog.Title className={cn("text-lg leading-tight font-semibold tracking-tight", className as string)} {...props} />;
}
export function DialogDescription({ className, ...props }: React.ComponentProps<typeof BaseDialog.Description>) {
  return <BaseDialog.Description className={cn("text-sm text-muted-foreground", className as string)} {...props} />;
}

// ---- Popover ----------------------------------------------------------------------

export const Popover = BasePopover.Root;
export function PopoverTrigger({ className, ...props }: React.ComponentProps<typeof BasePopover.Trigger>) {
  return <BasePopover.Trigger className={props.render ? (className as string) : cn(buttonClass("outline"), className as string)} {...props} />;
}
export function PopoverContent({
  className,
  side = "bottom",
  align = "center",
  sideOffset = 8,
  ...props
}: React.ComponentProps<typeof BasePopover.Popup> & { side?: "top" | "bottom" | "left" | "right"; align?: "start" | "center" | "end"; sideOffset?: number }) {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner side={side} align={align} sideOffset={sideOffset} className="z-50">
        <BasePopover.Popup className={cn(surface, popupMotion, "max-h-[var(--available-height)] w-72 max-w-[var(--available-width)] overflow-y-auto overscroll-contain p-4 text-sm outline-none", className as string)} {...props} />
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}

// ---- Tooltip ----------------------------------------------------------------------

export const TooltipProvider = BaseTooltip.Provider;

/** `<Tooltip content="Saved 2m ago"><Button>…</Button></Tooltip>` */
export function Tooltip({
  content,
  children,
  side = "top",
  delay = 300,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  delay?: number;
}) {
  const trigger = React.isValidElement(children) ? (children as React.ReactElement<Record<string, unknown>>) : <span className="cursor-default">{children}</span>;
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger delay={delay} render={trigger} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="z-50">
          <BaseTooltip.Popup
            className={cn(
              "max-w-xs rounded-md border border-input/70 bg-secondary px-2.5 py-1.5 text-xs leading-snug text-foreground shadow-pop",
              popupMotion,
              "data-instant:transition-none",
            )}
          >
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

// ---- Accordion --------------------------------------------------------------------

export function Accordion({ className, ...props }: React.ComponentProps<typeof BaseAccordion.Root>) {
  return <BaseAccordion.Root className={cn("flex w-full flex-col divide-y divide-border border-y border-border", className as string)} {...props} />;
}
export function AccordionItem({ className, ...props }: React.ComponentProps<typeof BaseAccordion.Item>) {
  return <BaseAccordion.Item className={cn(className as string)} {...props} />;
}
export function AccordionTrigger({ className, children, ...props }: React.ComponentProps<typeof BaseAccordion.Trigger>) {
  return (
    <BaseAccordion.Header className="m-0">
      <BaseAccordion.Trigger
        className={cn(
          "group flex w-full cursor-pointer items-center justify-between gap-4 py-3.5 text-left text-[15px] font-medium transition-colors outline-none hover:text-primary focus-visible:focus-halo",
          className as string,
        )}
        {...props}
      >
        {children}
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-(--motion-base) group-data-panel-open:rotate-180" />
      </BaseAccordion.Trigger>
    </BaseAccordion.Header>
  );
}
export function AccordionContent({ className, children, ...props }: React.ComponentProps<typeof BaseAccordion.Panel>) {
  return (
    <BaseAccordion.Panel
      className="overflow-hidden text-sm text-muted-foreground transition-opacity duration-(--motion-base) ease-(--motion-ease) data-ending-style:opacity-0 data-starting-style:opacity-0"
      {...props}
    >
      <div className={cn("pb-4 leading-relaxed", className as string)}>{children}</div>
    </BaseAccordion.Panel>
  );
}

// ---- ScrollArea -------------------------------------------------------------------

export function ScrollArea({ className, children, style }: { className?: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <BaseScrollArea.Root className={cn("relative overflow-hidden", className)} style={style}>
      <BaseScrollArea.Viewport className="size-full overscroll-contain rounded-[inherit] outline-none">{children}</BaseScrollArea.Viewport>
      <BaseScrollArea.Scrollbar className="m-0.5 flex w-1.5 justify-center rounded-full opacity-0 transition-opacity data-hovering:opacity-100 data-scrolling:opacity-100">
        <BaseScrollArea.Thumb className="w-full rounded-full bg-foreground/20" />
      </BaseScrollArea.Scrollbar>
    </BaseScrollArea.Root>
  );
}

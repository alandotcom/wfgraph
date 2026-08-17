import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@wfgraph/shared/utils";

// Generic in the item type, because Root is: collapsing it to `ComponentProps`
// would type every item value as `unknown` at the call sites.
function Combobox<Value, Multiple extends boolean | undefined = false>(
  props: ComboboxPrimitive.Root.Props<Value, Multiple>
) {
  return <ComboboxPrimitive.Root {...props} />;
}

function ComboboxInputGroup({
  className,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.InputGroup>) {
  return (
    <ComboboxPrimitive.InputGroup
      className={cn("relative flex w-full items-center", className)}
      data-slot="combobox-input-group"
      {...props}
    />
  );
}

/**
 * The text box, sized to leave room for the two buttons that sit over its right
 * edge inside the input group.
 */
function ComboboxInput({
  className,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.Input>) {
  return (
    <ComboboxPrimitive.Input
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-transparent py-1 pr-16 pl-3 text-base shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className
      )}
      data-slot="combobox-input"
      {...props}
    />
  );
}

const EDGE_BUTTON_CLASS =
  "flex size-7 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50";

function ComboboxClear({
  className,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.Clear>) {
  return (
    <ComboboxPrimitive.Clear
      className={cn(EDGE_BUTTON_CLASS, "absolute right-8", className)}
      data-slot="combobox-clear"
      {...props}
    >
      <XIcon className="size-3.5" />
    </ComboboxPrimitive.Clear>
  );
}

function ComboboxTrigger({
  className,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.Trigger>) {
  return (
    <ComboboxPrimitive.Trigger
      className={cn(EDGE_BUTTON_CLASS, "absolute right-1", className)}
      data-slot="combobox-trigger"
      {...props}
    >
      <ChevronDownIcon className="size-4 opacity-50" />
    </ComboboxPrimitive.Trigger>
  );
}

function ComboboxContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  ...popupProps
}: ComponentProps<typeof ComboboxPrimitive.Popup> &
  Pick<
    ComponentProps<typeof ComboboxPrimitive.Positioner>,
    "align" | "side" | "sideOffset"
  >) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        align={align}
        className="isolate z-50 outline-none"
        side={side}
        sideOffset={sideOffset}
      >
        <ComboboxPrimitive.Popup
          className={cn(
            "data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 relative isolate z-50 max-h-(--available-height) w-(--anchor-width) origin-(--transform-origin) overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-closed:animate-out data-open:animate-in",
            className
          )}
          data-slot="combobox-content"
          {...popupProps}
        >
          {children}
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxList({
  className,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.List>) {
  return (
    <ComboboxPrimitive.List
      className={cn("max-h-64 overflow-y-auto overscroll-contain", className)}
      data-slot="combobox-list"
      {...props}
    />
  );
}

function ComboboxEmpty({
  className,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.Empty>) {
  return (
    <ComboboxPrimitive.Empty
      className={cn(
        "px-2 py-3 text-muted-foreground text-xs empty:hidden",
        className
      )}
      data-slot="combobox-empty"
      {...props}
    />
  );
}

function ComboboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.Item>) {
  return (
    <ComboboxPrimitive.Item
      className={cn(
        "relative flex w-full cursor-default select-none items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden data-[disabled]:pointer-events-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:opacity-50",
        className
      )}
      data-slot="combobox-item"
      {...props}
    >
      <span className="min-w-0 flex-1">{children}</span>
      <ComboboxPrimitive.ItemIndicator className="absolute right-2 flex size-3.5 items-center justify-center">
        <CheckIcon className="size-4" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  );
}

function ComboboxGroup({
  ...props
}: ComponentProps<typeof ComboboxPrimitive.Group>) {
  return <ComboboxPrimitive.Group data-slot="combobox-group" {...props} />;
}

function ComboboxGroupLabel({
  className,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.GroupLabel>) {
  return (
    <ComboboxPrimitive.GroupLabel
      className={cn("px-2 py-1.5 text-muted-foreground text-xs", className)}
      data-slot="combobox-group-label"
      {...props}
    />
  );
}

const ComboboxCollection = ComboboxPrimitive.Collection;

export {
  Combobox,
  ComboboxClear,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxInputGroup,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
};

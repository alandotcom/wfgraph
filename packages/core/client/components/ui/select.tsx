import { Select as SelectPrimitive } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import * as React from "react";
import { Children, isValidElement } from "react";

import { cn } from "@/shared/utils";

type SelectProps = Omit<
  React.ComponentProps<typeof SelectPrimitive.Root>,
  "multiple" | "value" | "defaultValue" | "onValueChange"
> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
};

const SelectItemsContext = React.createContext<Record<string, string>>({});

function getTextContent(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(getTextContent).join(" ");
  }

  if (isValidElement<{ children?: React.ReactNode }>(node)) {
    return getTextContent(node.props.children);
  }

  return "";
}

function collectSelectItems(node: React.ReactNode) {
  const items: Array<{ value: string; label: string }> = [];

  const visit = (childNode: React.ReactNode) => {
    Children.forEach(childNode, (child) => {
      if (
        !isValidElement<{ value?: unknown; children?: React.ReactNode }>(child)
      ) {
        return;
      }

      if (typeof child.props.value === "string") {
        const label = getTextContent(child.props.children).trim();
        if (label) {
          items.push({ value: child.props.value, label });
        }
      }

      if (child.props.children) {
        visit(child.props.children);
      }
    });
  };

  visit(node);
  return items;
}

function Select({ onValueChange, children, ...props }: SelectProps) {
  const labelByValue = React.useMemo(() => {
    const next: Record<string, string> = {};
    for (const item of collectSelectItems(children)) {
      next[item.value] = item.label;
    }
    return next;
  }, [children]);

  return (
    <SelectItemsContext.Provider value={labelByValue}>
      <SelectPrimitive.Root
        data-slot="select"
        multiple={false}
        onValueChange={(value) => {
          if (typeof value === "string") {
            onValueChange?.(value);
          }
        }}
        {...props}
      >
        {children}
      </SelectPrimitive.Root>
    </SelectItemsContext.Provider>
  );
}

function SelectGroup({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  const labels = React.useContext(SelectItemsContext);

  return (
    <SelectPrimitive.Value data-slot="select-value" {...props}>
      {(value) => {
        if (typeof value !== "string") {
          return undefined;
        }
        return labels[value] ?? value;
      }}
    </SelectPrimitive.Value>
  );
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "sm" | "default";
}) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "flex w-fit items-center justify-between gap-2 whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[size=default]:h-9 data-[size=sm]:h-8 data-[disabled]:cursor-not-allowed data-[invalid]:border-destructive data-[placeholder]:text-muted-foreground data-[disabled]:opacity-50 data-[invalid]:ring-destructive/20 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 dark:data-[invalid]:ring-destructive/40 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className
      )}
      data-size={size}
      data-slot="select-trigger"
      {...props}
    >
      {children}
      <SelectPrimitive.Icon>
        <ChevronDownIcon className="size-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  alignItemWithTrigger = false,
  ...popupProps
}: React.ComponentProps<typeof SelectPrimitive.Popup> &
  Pick<
    React.ComponentProps<typeof SelectPrimitive.Positioner>,
    "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"
  >) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        align={align}
        alignItemWithTrigger={alignItemWithTrigger}
        alignOffset={alignOffset}
        className="isolate z-50"
        side={side}
        sideOffset={sideOffset}
      >
        <SelectPrimitive.Popup
          className={cn(
            "data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=inline-end]:slide-in-from-left-2 relative isolate z-50 max-h-(--available-height) w-max min-w-(--anchor-width) origin-(--transform-origin) overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[align-trigger=true]:animate-none data-closed:animate-out data-open:animate-in",
            className
          )}
          data-align-trigger={alignItemWithTrigger}
          data-slot="select-content"
          {...popupProps}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List className="max-h-[inherit] w-max min-w-full overflow-y-auto p-1">
            {children}
          </SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.GroupLabel>) {
  return (
    <SelectPrimitive.GroupLabel
      className={cn("px-2 py-1.5 text-muted-foreground text-xs", className)}
      data-slot="select-label"
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.Item>, "value"> & {
  value: string;
}) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex w-full cursor-default select-none items-center gap-2 whitespace-nowrap rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden data-[disabled]:pointer-events-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      data-slot="select-item"
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
      data-slot="select-separator"
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      className={cn(
        "flex cursor-default items-center justify-center py-1 data-[visible=false]:hidden",
        className
      )}
      data-slot="select-scroll-up-button"
      {...props}
    >
      <ChevronUpIcon className="size-4" />
    </SelectPrimitive.ScrollUpArrow>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      className={cn(
        "flex cursor-default items-center justify-center py-1 data-[visible=false]:hidden",
        className
      )}
      data-slot="select-scroll-down-button"
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.ScrollDownArrow>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};

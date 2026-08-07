import { Select as SelectPrimitive } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { createContext, useContext, useMemo } from "react";
import type { ComponentProps, ReactNode } from "react";
import { Children, isValidElement } from "react";

import { cn } from "@wfgraph/shared/utils";

/**
 * `null` is how Base UI spells "nothing chosen", and this wrapper takes it as
 * given rather than standing a sentinel string in its place. A single select can
 * report it whatever its items are, so every caller answers for it.
 */
type SelectProps = Omit<
  ComponentProps<typeof SelectPrimitive.Root>,
  "multiple" | "value" | "defaultValue" | "onValueChange"
> & {
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string | null) => void;
};

/** Labels by value, as a Map because `null` is one of the values it holds. */
const SelectItemsContext = createContext<ReadonlyMap<string | null, string>>(
  new Map()
);

function getTextContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(getTextContent).join(" ");
  }

  if (isValidElement<{ children?: ReactNode }>(node)) {
    return getTextContent(node.props.children);
  }

  return "";
}

function collectSelectItems(node: ReactNode) {
  const items: Array<{ value: string | null; label: string }> = [];

  const visit = (childNode: ReactNode) => {
    Children.forEach(childNode, (child) => {
      if (
        !isValidElement<{
          value?: unknown;
          label?: unknown;
          children?: ReactNode;
        }>(child)
      ) {
        return;
      }

      if (typeof child.props.value === "string" || child.props.value === null) {
        // An item carrying secondary text (a description under the label)
        // declares its display label explicitly; text extraction would
        // concatenate every nested string into the trigger.
        const label =
          typeof child.props.label === "string"
            ? child.props.label
            : getTextContent(child.props.children).trim();
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
  const labelByValue = useMemo(() => {
    const next = new Map<string | null, string>();
    for (const item of collectSelectItems(children)) {
      next.set(item.value, item.label);
    }
    return next;
  }, [children]);

  return (
    <SelectItemsContext.Provider value={labelByValue}>
      <SelectPrimitive.Root<string>
        data-slot="select"
        multiple={false}
        onValueChange={(value) => onValueChange?.(value)}
        {...props}
      >
        {children}
      </SelectPrimitive.Root>
    </SelectItemsContext.Provider>
  );
}

/**
 * Adapts a handler for a select that offers no empty item, which therefore
 * cannot be cleared to one. Base UI reports `null` for a cleared single select
 * whatever its items are, so the type admits a case these callers have no value
 * to put anywhere.
 */
function whenChosen(onChosen: (value: string) => void) {
  return (value: string | null) => {
    if (value !== null) {
      onChosen(value);
    }
  };
}

function SelectGroup({
  ...props
}: ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue({
  placeholder,
  ...props
}: ComponentProps<typeof SelectPrimitive.Value>) {
  const labels = useContext(SelectItemsContext);

  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      placeholder={placeholder}
      {...props}
    >
      {(value: string | null) => {
        // Base UI renders the placeholder itself only when no child is given,
        // and this wrapper always gives one, so the fallback is spelled here.
        // A value with no item of its own still shows, so a stored path the
        // catalog no longer offers reads as itself rather than as blank.
        return labels.get(value) ?? (value || placeholder);
      }}
    </SelectPrimitive.Value>
  );
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger> & {
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
}: ComponentProps<typeof SelectPrimitive.Popup> &
  Pick<
    ComponentProps<typeof SelectPrimitive.Positioner>,
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
}: ComponentProps<typeof SelectPrimitive.GroupLabel>) {
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
}: Omit<ComponentProps<typeof SelectPrimitive.Item>, "value"> & {
  value: string | null;
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
}: ComponentProps<typeof SelectPrimitive.Separator>) {
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
}: ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
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
}: ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
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
  whenChosen,
};

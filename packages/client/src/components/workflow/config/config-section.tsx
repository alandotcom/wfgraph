import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "#src/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "#src/components/ui/popover";
import { cn } from "@wfgraph/shared/utils";

/**
 * The name of a configuration block, with its explanation and its controls.
 *
 * Shared so a section that owns an Edit button and one that renders its controls
 * outright still name themselves identically. The heading is the fixed point a
 * reader keeps while what sits under it changes.
 */
export function ConfigHeading({
  label,
  help,
  className,
  trailing,
}: {
  label: string;
  /** Long-form explanation, behind the icon beside the label. */
  help?: ReactNode;
  /** Positioning the caller owns, such as pinning the row while it scrolls. */
  className?: string;
  /** Controls belonging to the block, such as Edit. */
  trailing?: ReactNode;
}) {
  return (
    // The padding is unconditional. Applied together with a sticky state it
    // appeared on the click that pinned the row, moving the title down and
    // everything under it twice as far.
    <div
      className={cn("flex items-center justify-between gap-2 py-1", className)}
    >
      <div className="flex min-w-0 items-center gap-1">
        {/* A heading rather than a <label>: the block it names holds several
            controls, and a <label> with nothing to point at is one every
            `getByLabelText` in the suite has to step over. */}
        <h3 className="truncate font-medium text-sm">{label}</h3>
        {help ? <ConfigHelp label={label}>{help}</ConfigHelp> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">{trailing}</div>
    </div>
  );
}

/**
 * One labelled block inside a configuration section.
 *
 * A group carries a subordinate heading and its own help because each group
 * answers a separate configuration question. `trailing` holds a small control
 * that acts on the whole group, such as the Remove of an optional rule, at the
 * end of the label row.
 */
export function ConfigGroup({
  label,
  help,
  className,
  prominent = false,
  trailing,
  children,
}: {
  label: string;
  /** Long-form explanation, behind the icon beside the label. */
  help?: ReactNode;
  /** Spacing the caller's list of groups owns, such as its separators. */
  className?: string;
  /** Gives the primary group in a section full foreground emphasis. */
  prominent?: boolean | undefined;
  /** A control acting on the whole group, at the end of the label row. */
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={cn("space-y-1.5", className)}>
      <div className="flex min-h-6 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <h4
            className={cn(
              "truncate font-medium",
              prominent
                ? "text-foreground text-sm"
                : "text-muted-foreground text-xs/relaxed"
            )}
          >
            {label}
          </h4>
          {help ? <ConfigHelp label={label}>{help}</ConfigHelp> : null}
        </div>
        {trailing ? (
          <div className="flex shrink-0 items-center gap-1">{trailing}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * The explanation a section used to carry as paragraphs in the column.
 *
 * On click rather than hover: the content is long enough to want to stay open
 * while it is read, and hover does not exist on touch.
 */
export function ConfigHelp({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={`About ${label}`}
            className="text-muted-foreground"
            size="icon-sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <Info />
      </PopoverTrigger>
      {/* Anchored to the left of the panel rather than below the icon, so the
          three Concurrency descriptions do not cover the radios they describe.
          Base UI flips it back where the panel leaves no room for that.

          `--available-height` is what the positioner measured between the
          trigger and the viewport edge; uncapped, the last of five paragraphs
          sits off screen with nothing to scroll. */}
      <PopoverContent
        align="start"
        className="max-h-(--available-height) max-w-[min(20rem,80vw)] overflow-y-auto"
        side="left"
      >
        {/* Base UI's popup is a dialog, and a dialog with no name is announced
            as "dialog". Visually hidden: it repeats a heading sitting two
            pixels from the icon that opened this. */}
        <PopoverTitle className="sr-only">{label}</PopoverTitle>
        <div className="space-y-2 text-muted-foreground">{children}</div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The Remove of an optional group, such as one of the Start's rules, for the
 * end of its label row. It reads "Remove" and names the group it removes for
 * assistive technology.
 */
export function RemoveGroupButton({
  label,
  disabled,
  onRemove,
}: {
  label: string;
  disabled?: boolean | undefined;
  onRemove: () => void;
}) {
  return (
    <Button
      aria-label={`Remove ${label}`}
      className="text-muted-foreground"
      disabled={disabled}
      onClick={onRemove}
      size="xs"
      type="button"
      variant="ghost"
    >
      Remove
    </Button>
  );
}

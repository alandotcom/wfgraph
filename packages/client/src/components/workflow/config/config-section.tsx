import { Check, CircleQuestionMark, Pencil } from "lucide-react";
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
 * One block of a node's configuration, in one of its two modes.
 *
 * View is the default and renders `view`: what the setting is currently set to,
 * as text. Edit renders `children`, which is the block's controls. The caller
 * owns the mode so a control inside can enter it -- a section with nothing
 * configured yet has no view to speak of, and its one button both seeds a value
 * and opens the editor.
 *
 * `editable` is the whole of the gating: a non-owner, or a panel whose writes
 * are refused, gets no Edit button and therefore no way into edit mode, so view
 * never implies an edit that would be rejected.
 */
export function ConfigSection({
  label,
  editActionName = label,
  help,
  editable,
  editing,
  onEditingChange,
  stickyHeader = false,
  trailing,
  view,
  children,
}: {
  label: string;
  /**
   * What the Edit and Done buttons name, where the label is a clause rather
   * than a noun: "Edit Continue when" is not a sentence anybody would say.
   * Defaults to the label, which is right for a section headed by a noun.
   */
  editActionName?: string;
  /** Long-form explanation, behind the icon beside the label. */
  help?: ReactNode;
  editable: boolean;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /**
   * Whether the header pins to the top while the section is edited. Only a
   * section sitting directly in the panel's scrolling column may: one nested
   * inside a card pins to that same column, which tears the header away from
   * the box it names and paints the column's own fill across a tinted card.
   */
  stickyHeader?: boolean;
  /** Extra header control, such as copy, shown beside Edit when there is one. */
  trailing?: ReactNode;
  /** What the section reads as when it is not being edited. */
  view: ReactNode;
  children: ReactNode;
}) {
  // Asked twice on purpose: the mode the caller holds is a preference, and
  // `editable` is the verdict. A section that stops being editable while open
  // falls back to view without the caller having to notice.
  const isEditing = editing && editable;

  return (
    <section className="space-y-2">
      {/* Sticky while editing only. Compressing view mode moves a panel's
          height into edit rather than removing it, so the label of the block
          being edited has to survive the scroll that height costs. The
          background is the one both frames paint on that column: `bg-card` on
          the rail's <aside> and on the sheet's drawer. */}
      <ConfigHeading
        className={cn(stickyHeader && isEditing && "sticky top-0 z-20 bg-card")}
        help={help}
        label={label}
        trailing={
          <>
            {trailing}
            {editable ? (
              // A panel shows several of these at once, so the accessible name
              // carries the section: a list of three buttons all called "Edit" says
              // nothing about which block each one opens. The visible word leads it,
              // which is what keeps voice control working on what is on screen.
              <Button
                aria-label={
                  isEditing
                    ? `Done editing ${editActionName}`
                    : `Edit ${editActionName}`
                }
                // Outline rather than ghost, and a fixed width. A ghost button
                // is a bare word until it is hovered, which is no affordance at
                // all for the one control that changes what the panel is for;
                // and "Edit" and "Done" are different widths in Geist, so an
                // unpinned button moved under the pointer as it was pressed.
                className="w-[4.5rem] justify-center"
                onClick={() => onEditingChange(!isEditing)}
                size="sm"
                type="button"
                variant="outline"
              >
                {isEditing ? (
                  <Check data-icon="inline-start" />
                ) : (
                  <Pencil data-icon="inline-start" />
                )}
                {isEditing ? "Done" : "Edit"}
              </Button>
            ) : null}
          </>
        }
      />

      {isEditing ? <div className="space-y-2">{children}</div> : view}
    </section>
  );
}

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
        {help ? <HelpPopover label={label}>{help}</HelpPopover> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">{trailing}</div>
    </div>
  );
}

/**
 * One labelled block inside a configuration section.
 *
 * A group carries a subordinate heading and its own help because each group
 * answers a separate configuration question.
 */
export function ConfigGroup({
  label,
  help,
  className,
  children,
}: {
  label: string;
  /** Long-form explanation, behind the icon beside the label. */
  help?: ReactNode;
  /** Spacing the caller's list of groups owns, such as its separators. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("space-y-1.5", className)}>
      <div className="flex min-w-0 items-center gap-1">
        {/* Subordinate to the section's own <h3> by colour rather than size:
            at this scale a smaller heading is a heading nobody reads. */}
        <h4 className="truncate font-medium text-muted-foreground text-xs/relaxed">
          {label}
        </h4>
        {help ? <HelpPopover label={label}>{help}</HelpPopover> : null}
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
function HelpPopover({
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
        <CircleQuestionMark />
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

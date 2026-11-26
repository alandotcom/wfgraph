import { useAtom } from "jotai";
import { type KeyboardEvent, useRef, useState } from "react";
import { Input } from "#src/components/ui/input";
import { outlineFilterFocusRequestAtom } from "#src/components/workflow/layout/editor-layout-store";
import { useAfterCommit } from "#src/hooks/effects";
import { useIsMobile } from "#src/hooks/use-mobile";

/**
 * The outline's "Filter steps" field, which shows only while it is in use.
 * Cmd+F and "Find a step" ask for it through `outlineFilterFocusRequestAtom`
 * (`useOutlineControls` writes the request); the field then shows at the top
 * of the list with the cursor in it, and the request is cleared. Escape
 * clears the text, hides the field and hands the keyboard back to the rows;
 * Down hands it back and keeps the text; leaving the field empty hides it. On
 * a phone, where the outline is the screen, the field always shows. The
 * outline owns the text, since its rows are filtered by it.
 */
export function OutlineFilter({
  value,
  onChange,
  onReturnToRows,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Move keyboard focus to the outline's current row. */
  onReturnToRows: () => void;
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [requested, setRequested] = useAtom(outlineFilterFocusRequestAtom);
  const fieldRef = useRef<HTMLInputElement>(null);

  // The cursor goes into the field once the request has rendered it.
  useAfterCommit(requested, () => {
    if (!requested) return;
    setRequested(false);
    setOpen(true);
    fieldRef.current?.focus({ preventScroll: true });
    fieldRef.current?.select();
  });

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onChange("");
      setOpen(false);
      onReturnToRows();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onReturnToRows();
    }
  };

  if (!(isMobile || open || requested)) {
    return null;
  }
  return (
    <div className="shrink-0 px-1.5 pt-1 pb-1">
      <Input
        aria-keyshortcuts="Meta+F Control+F"
        aria-label="Filter steps"
        // On a phone the field is always shown at the top of the step list,
        // at the 44px touch height and 1rem, below which iOS zooms the page.
        className="max-md:h-11 max-md:text-base"
        onBlur={() => {
          if (value === "") setOpen(false);
        }}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Filter steps"
        ref={fieldRef}
        type="search"
        value={value}
      />
    </div>
  );
}

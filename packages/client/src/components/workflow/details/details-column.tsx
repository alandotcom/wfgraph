import { ColumnHeader } from "#src/components/workflow/columns/editor-columns";
import { DetailsPanel } from "./details-panel";

/**
 * The editor's right column: a header naming it, and what the selection shows.
 * It is about one step at a time; the build agent works on the whole workflow
 * and sits on the canvas.
 */
export function DetailsColumn() {
  return (
    <>
      <ColumnHeader side="details">
        <h2 className="font-medium text-sm">Details</h2>
      </ColumnHeader>
      <div className="flex min-h-0 flex-1 flex-col">
        <DetailsPanel />
      </div>
    </>
  );
}

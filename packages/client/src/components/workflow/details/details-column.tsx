import { ColumnHeader } from "#src/components/workflow/columns/editor-columns";

/**
 * The editor's right column: its header and what the selection shows.
 */
export function DetailsColumn() {
  return (
    <>
      <ColumnHeader side="details">
        <h2 className="font-medium text-sm">Details</h2>
      </ColumnHeader>
      <div className="min-h-0 flex-1" data-slot="details-body" />
    </>
  );
}

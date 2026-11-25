import { ColumnHeader } from "#src/components/workflow/columns/editor-columns";

/**
 * The editor's left column: its header and the workflow's outline below it.
 * The body holds the outline in run order.
 */
export function OutlineColumn() {
  return (
    <>
      <ColumnHeader side="outline">
        <h2 className="font-medium text-sm">Outline</h2>
      </ColumnHeader>
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-slot="outline-body"
      />
    </>
  );
}

import { ChevronDownIcon } from "lucide-react";
import { useId } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Label } from "#src/components/ui/label";
import {
  type ExtensionCatalog,
  findAction,
} from "@wfgraph/shared/extensions/catalog";
import { cn } from "@wfgraph/shared/utils";
import { ActionGrid, ActionIcon } from "./action-grid";

/** The element id of the field that names what a step does. */
export const ACTION_CHOICE_ID = "actionType";

/**
 * How the field names an action: its category and its label, such as
 * "Appointments · Send Patient Message", or the label alone for a built-in
 * step such as Wait. Null for no action, or one the catalog does not hold.
 */
export function actionChoiceText(
  catalog: ExtensionCatalog,
  actionId: string | undefined
): string | null {
  const action = actionId ? findAction(catalog, actionId) : undefined;
  if (!action) {
    return actionId ?? null;
  }
  return action.category === "System"
    ? action.label
    : `${action.category} · ${action.label}`;
}

/**
 * The one field that says what a step does. Closed, it names the chosen action
 * with its category. Open, it shows the searchable list of actions, grouped by
 * category, that adding a step uses, with focus in its search when `focusSearch`
 * holds. Choosing an action calls `onChoose`, and Escape in the list closes it
 * through `onOpenChange`. A step with no action yet keeps the field open.
 */
export function ActionChoiceField({
  actionId,
  open,
  disabled,
  focusSearch,
  onOpenChange,
  onChoose,
}: {
  actionId: string | undefined;
  open: boolean;
  disabled: boolean;
  focusSearch: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (actionId: string) => void;
}) {
  const catalog = useExtensionCatalog();
  const listId = useId();
  const action = actionId ? findAction(catalog, actionId) : undefined;
  const text = actionChoiceText(catalog, actionId);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Label htmlFor={ACTION_CHOICE_ID}>Does</Label>
      <button
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        className={cn(
          "flex h-7 w-full items-center gap-1.5 rounded-md border border-input bg-input/20 px-2 py-1.5 text-left text-xs/relaxed outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
          text === null && "text-muted-foreground"
        )}
        disabled={disabled}
        id={ACTION_CHOICE_ID}
        onClick={() => onOpenChange(!open)}
        type="button"
      >
        {action ? <ActionIcon action={action} className="size-3.5" /> : null}
        <span className="min-w-0 flex-1 truncate">
          {text ?? "Choose what this step does"}
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
        />
      </button>
      {open ? (
        <div
          className="flex min-h-0 flex-1 flex-col"
          // Escape in the list closes it, ahead of the details column's own
          // Escape, which would leave the step.
          data-owns-escape={actionId !== undefined ? "true" : undefined}
          id={listId}
          onKeyDown={(event) => {
            if (event.key === "Escape" && actionId !== undefined) {
              event.stopPropagation();
              onOpenChange(false);
            }
          }}
        >
          <ActionGrid
            disabled={disabled}
            focusSearch={focusSearch}
            onSelectAction={onChoose}
          />
        </div>
      ) : null}
    </div>
  );
}

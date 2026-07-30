import { useSetAtom } from "jotai";
import { Plus, TriangleAlert, X } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "#src/components/ui/button";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import { selectedNodeAtom } from "#src/lib/workflow-graph-store";
import { cn } from "@rova/shared/utils";
import { findEvent } from "@rova/shared/extensions/catalog";
import { readWaitForEvents } from "@rova/shared/workflow/wait-events";
import { getExtensionCatalog } from "#src/lib/extensions";
import type { UpdateNodeConfig } from "./node-config-patch";
import { useTriggerVocabulary } from "./trigger-vocabulary";

/**
 * The Wait node's "resume on these events" picker.
 *
 * A wait subscribes to an Event on its own account, with no lifecycle role of its
 * own, so nothing here says what an Event does to a run: that is the Lifecycle
 * Node's declaration and the builder reads it there. At least one Event has to be
 * named -- an empty list has no meaning the subscription index can hold.
 *
 * The vocabulary is still the trigger's. The catalog-fed picker lands with the
 * Lifecycle panel; what this reads from the catalog today is the Correlation Path
 * to name in the sentence at the bottom.
 */
export function WaitEventSelect({
  config,
  onUpdateConfig,
  disabled,
}: {
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
  disabled: boolean;
}) {
  const vocabulary = useTriggerVocabulary();
  const setSelectedNode = useSetAtom(selectedNodeAtom);
  const chipGroupLabelId = useId();
  const [draftEventType, setDraftEventType] = useState("");

  const openTriggerNode = () => {
    if (vocabulary.triggerNodeId) {
      setSelectedNode(vocabulary.triggerNodeId);
    }
  };

  const selected = readWaitForEvents(config.waitForEvents);
  const catalog = getExtensionCatalog();
  // The first named Event's path, because the sentence names one and a wait's
  // Events describe one entity between them.
  const correlationPath = selected
    .map((eventName) => findEvent(catalog, eventName)?.correlationPath)
    .find((path) => path !== undefined);
  const closed = vocabulary.eventTypes !== undefined;
  // Open vocabularies render every selection as a chip, offered or
  // free-entered, so nothing the builder chose is ever invisible.
  const options = closed
    ? vocabulary.knownEventTypes
    : [
        ...vocabulary.knownEventTypes,
        ...selected.filter(
          (eventType) => !vocabulary.knownEventTypes.includes(eventType)
        ),
      ];
  const invalidSelections = closed
    ? selected.filter((eventType) => !options.includes(eventType))
    : [];

  const setSelected = (next: string[]) => {
    onUpdateConfig({ waitForEvents: next });
  };

  const toggle = (eventType: string) => {
    setSelected(
      selected.includes(eventType)
        ? selected.filter((entry) => entry !== eventType)
        : [...selected, eventType]
    );
  };

  const normalizedDraft = draftEventType.trim();
  const handleAddDraft = () => {
    if (!normalizedDraft || selected.includes(normalizedDraft)) {
      return;
    }
    setSelected([...selected, normalizedDraft]);
    setDraftEventType("");
  };

  return (
    <div className="space-y-2">
      <Label id={chipGroupLabelId}>Resume when the event is</Label>

      {options.length > 0 ? (
        <div
          aria-labelledby={chipGroupLabelId}
          className="flex flex-wrap gap-1.5"
          role="group"
        >
          {options.map((eventType) => {
            const isSelected = selected.includes(eventType);
            return (
              <button
                aria-pressed={isSelected}
                className={cn(
                  "rounded-full border px-2.5 py-1 font-mono text-xs transition-colors",
                  "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  // Selection is one of the graphite system's sanctioned uses
                  // of contrast: a filled ink chip, unmistakable at a glance.
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input text-muted-foreground hover:bg-muted/50",
                  disabled && "pointer-events-none opacity-50"
                )}
                disabled={disabled}
                key={eventType}
                onClick={() => toggle(eventType)}
                type="button"
              >
                {eventType}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">
            No event types are named on the entry node yet. Add one below.
          </p>
          {vocabulary.triggerNodeId ? (
            <Button
              onClick={openTriggerNode}
              size="sm"
              type="button"
              variant="outline"
            >
              Open trigger
            </Button>
          ) : null}
        </div>
      )}

      {invalidSelections.length > 0 ? (
        <div className="space-y-1.5">
          {invalidSelections.map((eventType) => (
            <div
              className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5"
              key={eventType}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs" title={eventType}>
                  {eventType}
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-200">
                  This trigger cannot produce this event type. Remove it.
                </p>
              </div>
              <Button
                aria-label={`Remove ${eventType}`}
                className="size-7 shrink-0"
                disabled={disabled}
                onClick={() => toggle(eventType)}
                size="icon"
                type="button"
                variant="ghost"
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {closed ? null : (
        <div className="flex items-center gap-2">
          <Input
            disabled={disabled}
            onChange={(event) => setDraftEventType(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleAddDraft();
              }
            }}
            placeholder="appointment.confirmed"
            value={draftEventType}
          />
          <Button
            disabled={disabled || !normalizedDraft}
            onClick={handleAddDraft}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus className="size-3.5" />
            Add
          </Button>
        </div>
      )}

      {selected.length === 0 ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          <p className="text-amber-700 text-xs dark:text-amber-200">
            Name at least one event. A wait with none cannot be resumed by
            anything, and the workflow will not save.
          </p>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          Only these events
          {correlationPath ? (
            <>
              {" "}
              where <code className="font-mono text-xs">
                {correlationPath}
              </code>{" "}
              matches this run's value
            </>
          ) : (
            " for this run's entity"
          )}{" "}
          will resume the wait.
        </p>
      )}
    </div>
  );
}

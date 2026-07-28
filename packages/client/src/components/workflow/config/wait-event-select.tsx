import { useSetAtom } from "jotai";
import { Plus, TriangleAlert, X } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { selectedNodeAtom } from "@/lib/workflow-graph-store";
import { cn } from "@rova/shared/utils";
import type { RoutingAction } from "@rova/shared/workflow/routing-policy";
import { readWaitForEvents } from "@rova/shared/workflow/wait-events";
import type { UpdateNodeConfig } from "./node-config-patch";
import { useTriggerVocabulary } from "./trigger-vocabulary";

/** How a chip suffixes its mapped action, e.g. "appointment.canceled · Cancel". */
const CHIP_ACTION_LABELS: Record<RoutingAction, string> = {
  start: "Start",
  replace: "Replace",
  cancel: "Cancel",
  ignore: "Ignore",
};

/**
 * The Wait node's "resume on these events" picker, fed by the trigger's
 * Event Type vocabulary instead of free-typed strings. A custom trigger's
 * schema gives a closed set of options; the webhook trigger offers the
 * Routing Policy's Event Types plus free entry, because the sending service
 * can emit types the builder chose to leave unmapped. Only a closed
 * vocabulary can prove an event type unproducible, so only there do stale
 * selections render as invalid chips to remove — they would otherwise wait
 * forever on an event that cannot arrive.
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

  const cancellingSelections = selected.filter((eventType) => {
    const action = vocabulary.policy?.[eventType];
    return action === "replace" || action === "cancel";
  });

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
            const mappedAction = vocabulary.policy?.[eventType];
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
                {mappedAction ? (
                  <span
                    className={cn(
                      "ml-1.5",
                      isSelected
                        ? "text-primary-foreground/70"
                        : "text-muted-foreground/70"
                    )}
                  >
                    · {CHIP_ACTION_LABELS[mappedAction]}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">
            No event types are named in the trigger's routing policy yet. Add
            one below, or leave empty to resume on any event.
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

      {cancellingSelections.length > 0 ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          <p className="text-amber-700 text-xs dark:text-amber-200">
            {cancellingSelections.join(", ")}{" "}
            {cancellingSelections.length === 1 ? "is" : "are"} mapped to Replace
            or Cancel in the routing policy: runs waiting here will be cancelled
            by that event, not resumed. Map it to Ignore if it should only wake
            this wait.
          </p>
        </div>
      ) : null}

      <p className="text-muted-foreground text-xs">
        {selected.length === 0 ? "Empty means any event" : "Only these events"}
        {vocabulary.correlationPath ? (
          <>
            {" "}
            where{" "}
            <code className="font-mono text-xs">
              {vocabulary.correlationPath}
            </code>{" "}
            matches this run's value
          </>
        ) : (
          " for this run's entity"
        )}{" "}
        will resume the wait.
      </p>
    </div>
  );
}

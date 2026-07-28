import { Plus, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { Button } from "#src/components/ui/button";
import { Input } from "#src/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#src/components/ui/select";
import { cn } from "@rova/shared/utils";
import {
  policyCanTrigger,
  ROUTING_ACTIONS,
  type RoutingAction,
  type RoutingPolicy,
} from "@rova/shared/workflow/routing-policy";

/**
 * Every action a row can map to, in menu order, with the sentence the
 * builder reads under the select.
 */
const ACTION_OPTIONS: Array<{
  value: RoutingAction;
  label: string;
  description: string;
}> = [
  { value: "start", label: "Start", description: "Begin a new run" },
  {
    value: "replace",
    label: "Replace",
    description: "Cancel this entity's runs, then start a new one",
  },
  {
    value: "cancel",
    label: "Cancel",
    description: "Cancel this entity's runs",
  },
  { value: "ignore", label: "Ignore", description: "Do nothing" },
];

/**
 * An explicit Ignore row persists: for the open-vocabulary webhook trigger
 * the policy's keys double as the Event Type vocabulary the Wait picker
 * offers, so a named-but-ignored event stays representable ("this event
 * only wakes waits"). Removing a row entirely is the X button's job.
 */
function withMapping(
  policy: RoutingPolicy | undefined,
  eventType: string,
  action: RoutingAction
): RoutingPolicy {
  return { ...policy, [eventType]: action };
}

function withoutMapping(
  policy: RoutingPolicy | undefined,
  eventType: string
): RoutingPolicy {
  const next = { ...policy };
  delete next[eventType];
  return next;
}

function PolicyRow({
  eventType,
  action,
  stale,
  removable,
  disabled,
  onActionChange,
  onRemove,
}: {
  eventType: string;
  action: RoutingAction;
  /** The Event Type no longer exists in the trigger's vocabulary. */
  stale: boolean;
  removable: boolean;
  disabled: boolean;
  onActionChange: (action: RoutingAction) => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border px-2 py-1.5",
        stale && "border-amber-500/40 bg-amber-500/10"
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-xs" title={eventType}>
          {eventType}
        </p>
        {stale ? (
          <p className="text-xs text-amber-700 dark:text-amber-200">
            Not produced by this trigger anymore. Remove it.
          </p>
        ) : null}
      </div>
      <Select
        disabled={disabled}
        onValueChange={(value) => {
          const nextAction = ROUTING_ACTIONS.find(
            (candidate) => candidate === value
          );
          if (nextAction) {
            onActionChange(nextAction);
          }
        }}
        value={action}
      >
        <SelectTrigger
          aria-label={`Action for ${eventType}`}
          className="w-28 shrink-0"
          size="sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ACTION_OPTIONS.map((option) => (
            <SelectItem
              key={option.value}
              label={option.label}
              value={option.value}
            >
              <div className="flex flex-col items-start">
                <span>{option.label}</span>
                <span className="text-muted-foreground text-xs">
                  {option.description}
                </span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {removable || stale ? (
        <Button
          aria-label={`Remove ${eventType}`}
          className="size-7 shrink-0"
          disabled={disabled}
          onClick={onRemove}
          size="icon"
          type="button"
          variant="ghost"
        >
          <X className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The Routing Policy table: one row per Event Type, one action each.
 *
 * With a closed vocabulary (`eventTypes` set), every known Event Type always
 * renders as a row, so the builder sees the whole decision space at once;
 * mappings for Event Types that fell out of the vocabulary render as stale
 * rows to remove. With an open vocabulary (the webhook trigger), the builder
 * names the Event Types themselves.
 */
export function RoutingPolicyEditor({
  policy,
  eventTypes,
  disabled,
  onChange,
  showTriggerabilityWarning = true,
}: {
  policy: RoutingPolicy | undefined;
  /** Closed vocabulary; undefined lets the builder add free-text rows. */
  eventTypes: string[] | undefined;
  disabled: boolean;
  onChange: (policy: RoutingPolicy) => void;
  /**
   * Off when the surrounding panel already surfaces the "can never be
   * triggered" warning through its own warning block, as the webhook
   * section does.
   */
  showTriggerabilityWarning?: boolean;
}) {
  const [draftEventType, setDraftEventType] = useState("");

  const mappedEventTypes = Object.keys(policy ?? {});
  const closed = eventTypes !== undefined;
  const rows = closed
    ? [
        ...eventTypes.map((eventType) => ({ eventType, stale: false })),
        ...mappedEventTypes
          .filter((eventType) => !eventTypes.includes(eventType))
          .map((eventType) => ({ eventType, stale: true })),
      ]
    : mappedEventTypes.map((eventType) => ({ eventType, stale: false }));

  const normalizedDraft = draftEventType.trim();
  const draftIsDuplicate =
    normalizedDraft !== "" &&
    rows.some((row) => row.eventType === normalizedDraft);

  const handleAddDraft = () => {
    if (!normalizedDraft || draftIsDuplicate) {
      return;
    }
    // A fresh row starts at Start: naming an event type by hand signals the
    // builder wants it to do something, and Start is the least destructive
    // action that satisfies that.
    onChange(withMapping(policy, normalizedDraft, "start"));
    setDraftEventType("");
  };

  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No event types yet. Add one below and choose what it does.
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => (
            <PolicyRow
              action={policy?.[row.eventType] ?? "ignore"}
              disabled={disabled}
              eventType={row.eventType}
              key={row.eventType}
              onActionChange={(action) =>
                onChange(withMapping(policy, row.eventType, action))
              }
              onRemove={() => onChange(withoutMapping(policy, row.eventType))}
              removable={!closed}
              stale={row.stale}
            />
          ))}
        </div>
      )}

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
            placeholder="appointment.rescheduled"
            value={draftEventType}
          />
          <Button
            disabled={disabled || !normalizedDraft || draftIsDuplicate}
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
      {draftIsDuplicate ? (
        <p className="text-amber-700 text-xs dark:text-amber-200">
          That event type already has a row.
        </p>
      ) : null}

      {!showTriggerabilityWarning || policyCanTrigger(policy) ? null : (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          <p className="text-amber-700 text-xs dark:text-amber-200">
            Nothing is mapped to Start or Replace, so this workflow can never be
            triggered.
          </p>
        </div>
      )}
    </div>
  );
}

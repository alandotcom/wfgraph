import { Checkbox } from "#src/components/ui/checkbox";
import { Label } from "#src/components/ui/label";
import { RadioGroup, RadioGroupItem } from "#src/components/ui/radio-group";
import {
  type Concurrency,
  type LifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { cn } from "@wfgraph/shared/utils";
import { ConfigGroup, ConfigViewRow } from "./config-section";

const ENTITY_HELP =
  "The entity is the value at the Correlation Path. A start carrying no payload uses the workflow itself, so every manual run is about the same entity.";
const MANUAL_RUNS_HELP =
  "The Run button and the execute route. With this off, only a Start Event starts a run.";

export function LifecycleConcurrencyGroup({
  editing,
  rules,
  disabled,
  manualStartId,
  onConcurrencyChange,
  onManualStartChange,
}: {
  editing: boolean;
  rules: LifecycleRules;
  disabled: boolean;
  manualStartId: string;
  onConcurrencyChange: (value: Concurrency) => void;
  onManualStartChange: (allowed: boolean) => void;
}) {
  return (
    <ConfigGroup
      className="py-3 first:pt-0 last:pb-0"
      help={<ConcurrencyHelp concurrency={rules.concurrency} />}
      label="Concurrency"
    >
      {editing ? (
        <div className="space-y-2">
          <RadioGroup
            aria-label="Concurrency"
            disabled={disabled}
            onValueChange={onConcurrencyChange}
            value={rules.concurrency}
          >
            {CONCURRENCY_OPTIONS.map((option) => (
              <label
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-md border p-2 transition-colors",
                  rules.concurrency === option.value
                    ? "border-primary bg-muted/50"
                    : "border-input hover:bg-muted/30",
                  disabled && "pointer-events-none opacity-50"
                )}
                key={option.value}
              >
                <RadioGroupItem value={option.value} />
                <span className="font-medium text-sm">{option.label}</span>
              </label>
            ))}
          </RadioGroup>

          <div className="flex items-center gap-2">
            <Checkbox
              checked={rules.allowManualStart === true}
              disabled={disabled}
              id={manualStartId}
              onCheckedChange={onManualStartChange}
            />
            <Label htmlFor={manualStartId}>Allow manual runs</Label>
          </div>
          <ManualRunPayloadNotice rules={rules} />
        </div>
      ) : (
        <div className="space-y-1">
          <p className="text-sm">{concurrencyLabel(rules.concurrency)}</p>
          <ConfigViewRow label="Allow manual runs">
            {rules.allowManualStart === true ? "Allowed" : "Not allowed"}
          </ConfigViewRow>
          <ManualRunPayloadNotice rules={rules} />
        </div>
      )}
    </ConfigGroup>
  );
}

function ConcurrencyHelp({ concurrency }: { concurrency: Concurrency }) {
  const chosenFirst = [
    ...CONCURRENCY_OPTIONS.filter((option) => option.value === concurrency),
    ...CONCURRENCY_OPTIONS.filter((option) => option.value !== concurrency),
  ];

  return (
    <>
      {chosenFirst.map((option) => (
        <p key={option.value}>
          <span className="font-medium text-foreground">{option.label}</span>{" "}
          {option.description}
        </p>
      ))}
      <p>{ENTITY_HELP}</p>
      <p>
        <span className="font-medium text-foreground">Allow manual runs</span>{" "}
        {MANUAL_RUNS_HELP}
      </p>
    </>
  );
}

function ManualRunPayloadNotice({ rules }: { rules: LifecycleRules }) {
  if (rules.startEvents.length > 0) {
    return null;
  }

  return (
    <p className="text-muted-foreground text-xs">
      A manual run's payload is described by nothing, so downstream nodes are
      offered no fields to reference. Add a Start Event to give them its
      payload.
    </p>
  );
}

function concurrencyLabel(concurrency: Concurrency): string {
  return (
    CONCURRENCY_OPTIONS.find((option) => option.value === concurrency)?.label ??
    concurrency
  );
}

export const CONCURRENCY_OPTIONS: ReadonlyArray<{
  value: Concurrency;
  label: string;
  description: string;
}> = [
  {
    value: "unlimited",
    label: "Unlimited",
    description: "Every Event starts its own run.",
  },
  {
    value: "newest-wins",
    label: "Newest wins",
    description:
      "A new run for the same entity supersedes the ones already going, which end with that status.",
  },
  {
    value: "first-wins",
    label: "First wins",
    description:
      "A run already going for the same entity keeps it. The arriving Event is recorded as a Refused Start.",
  },
];

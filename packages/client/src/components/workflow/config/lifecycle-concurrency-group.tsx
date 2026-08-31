import { Checkbox } from "#src/components/ui/checkbox";
import { Label } from "#src/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#src/components/ui/select";
import { whenChosen } from "#src/lib/select-choice";
import {
  type Concurrency,
  type LifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { ConfigGroup } from "./config-section";

const MANUAL_RUNS_HELP =
  "Allows Run draft, Run vN, and the execute API. When off, only a Start Event can start a run.";

export function LifecycleConcurrencyGroup({
  rules,
  disabled,
  manualStartId,
  onConcurrencyChange,
  onManualStartChange,
}: {
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
      <div className="space-y-2">
        {/* A dropdown rather than a stack of radio cards, which is what every
            other one-of-three setting in the panel uses. The three
            descriptions live in this group's help popover, so the closed
            control owes the reader nothing. */}
        <Select
          disabled={disabled}
          items={CONCURRENCY_OPTIONS.map((option) => ({
            label: option.label,
            value: option.value,
          }))}
          onValueChange={whenChosen((value) => {
            const chosen = readConcurrency(value);
            if (chosen) {
              onConcurrencyChange(chosen);
            }
          })}
          value={rules.concurrency}
        >
          <SelectTrigger aria-label="Concurrency" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONCURRENCY_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <p className="text-muted-foreground text-xs">
          {concurrencyOption(rules.concurrency).description}
        </p>

        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Checkbox
              checked={rules.allowManualStart === true}
              disabled={disabled}
              id={manualStartId}
              onCheckedChange={onManualStartChange}
            />
            <Label htmlFor={manualStartId}>Allow manual runs</Label>
          </div>
          <p className="text-muted-foreground text-xs">{MANUAL_RUNS_HELP}</p>
        </div>
        <ManualRunPayloadNotice rules={rules} />
      </div>
    </ConfigGroup>
  );
}

/**
 * The typed Concurrency a Select handed back, or nothing for a value the
 * options do not declare. Base UI types its answer as a plain string, and the
 * stored rules take one of three names, so the list is what does the narrowing.
 */
function readConcurrency(value: string): Concurrency | undefined {
  return CONCURRENCY_OPTIONS.find((option) => option.value === value)?.value;
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
    </>
  );
}

function concurrencyOption(concurrency: Concurrency) {
  return (
    CONCURRENCY_OPTIONS.find((option) => option.value === concurrency) ??
    CONCURRENCY_OPTIONS[0]
  );
}

function ManualRunPayloadNotice({ rules }: { rules: LifecycleRules }) {
  if (rules.startEvents.length > 0) {
    return null;
  }

  return (
    <p className="text-muted-foreground text-xs">
      Manual runs provide no payload fields to downstream nodes. Add a Start
      Event to provide them.
    </p>
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

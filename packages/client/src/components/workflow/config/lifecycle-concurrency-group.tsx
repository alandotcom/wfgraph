import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
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
import { ConfigGroup, ConfigHelp } from "./config-section";
import {
  CONCURRENCY_OPTIONS,
  describeRelatedRuns,
} from "./lifecycle-policy-summary";

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
  const catalog = useExtensionCatalog();
  const relatedRunsDescription = describeRelatedRuns(rules, catalog);

  return (
    <ConfigGroup
      className="py-3 first:pt-0 last:pb-0"
      help={<ConcurrencyHelp concurrency={rules.concurrency} />}
      label="Overlapping runs"
      prominent
    >
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">
          {relatedRunsDescription}
        </p>
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
          <SelectTrigger aria-label="Overlapping runs" className="w-full">
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
          {
            CONCURRENCY_OPTIONS.find(
              (option) => option.value === rules.concurrency
            )?.description
          }
        </p>

        <div className="space-y-2 border-t pt-3">
          <p className="font-medium text-sm">Manual starts</p>
          <div className="flex items-center gap-2">
            <Checkbox
              checked={rules.allowManualStart === true}
              disabled={disabled}
              id={manualStartId}
              onCheckedChange={onManualStartChange}
            />
            <div className="flex items-center gap-1">
              <Label htmlFor={manualStartId}>Allow manual runs</Label>
              <ConfigHelp label="Allow manual runs">
                <ul className="list-disc space-y-1 pl-4">
                  <li>The editor and API can start runs manually.</li>
                  <li>When this is off, only Start Events can start runs.</li>
                  <li>
                    Entity tracking and Event Splits require selecting a Start
                    Event.
                  </li>
                </ul>
              </ConfigHelp>
            </div>
          </div>
          <ManualRunPayloadNotice rules={rules} />
        </div>
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

function ManualRunPayloadNotice({ rules }: { rules: LifecycleRules }) {
  if (rules.startEvents.length > 0) {
    return null;
  }

  return (
    <p className="text-muted-foreground text-xs">
      Manual runs do not include Event data. Add a Start Event if later steps
      need fields from an Event.
    </p>
  );
}

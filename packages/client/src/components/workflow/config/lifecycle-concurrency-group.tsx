import { useId } from "react";
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
import { overlappingRunsSentence } from "@wfgraph/shared/graph/workflow-summary";
import {
  type Concurrency,
  type LifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { ConfigGroup, ConfigHelp, RemoveGroupButton } from "./config-section";
import {
  CONCURRENCY_OPTIONS,
  describeRelatedRuns,
  START_RULE_NAMES,
} from "./lifecycle-policy-summary";

/**
 * "If a run is already in progress": what a newer start does to related runs
 * in progress. The control is the dropdown alone; what each choice does, and
 * which runs count as related, sit behind the label's info icon. With
 * `onRemove`, the label row offers Remove, which puts the rule back to every
 * arrival starting its own run.
 */
export function LifecycleConcurrencyGroup({
  rules,
  disabled,
  onConcurrencyChange,
  onRemove,
  triggerId,
}: {
  rules: LifecycleRules;
  disabled: boolean;
  onConcurrencyChange: (value: Concurrency) => void;
  onRemove?: (() => void) | undefined;
  /** The element id of the dropdown, which focus moves to when the rule is added. */
  triggerId?: string | undefined;
}) {
  const catalog = useExtensionCatalog();
  const relatedRunsDescription = describeRelatedRuns(rules, catalog);
  // What the chosen rule does to this workflow's runs, in its own nouns.
  const consequence = overlappingRunsSentence(rules, catalog);

  return (
    <ConfigGroup
      help={
        <>
          <ChosenConcurrencyHelp concurrency={rules.concurrency} />
          {consequence === null ? null : (
            <p data-slot="overlap-consequence">{consequence}</p>
          )}
          <p>{relatedRunsDescription}</p>
        </>
      }
      label={START_RULE_NAMES.overlapping}
      prominent
      trailing={
        onRemove ? (
          <RemoveGroupButton
            disabled={disabled}
            label={START_RULE_NAMES.overlapping}
            onRemove={onRemove}
          />
        ) : null
      }
    >
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
        <SelectTrigger
          aria-label={START_RULE_NAMES.overlapping}
          className="w-full"
          id={triggerId}
        >
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
    </ConfigGroup>
  );
}

/**
 * "Can be run by hand": whether a person may start a run from the editor or
 * the API. It sits with the Start Events, since both answer what starts a run.
 */
export function LifecycleManualStartGroup({
  rules,
  disabled,
  onManualStartChange,
}: {
  rules: LifecycleRules;
  disabled: boolean;
  onManualStartChange: (allowed: boolean) => void;
}) {
  const manualStartId = useId();
  return (
    <div className="flex min-h-6 items-center gap-2">
      <Checkbox
        checked={rules.allowManualStart === true}
        disabled={disabled}
        id={manualStartId}
        onCheckedChange={onManualStartChange}
      />
      <Label className="text-sm" htmlFor={manualStartId}>
        {MANUAL_START_LABEL}
      </Label>
      <ConfigHelp label={MANUAL_START_LABEL}>
        <p>When this is on, the editor and API can start runs by hand.</p>
        <p>Entity tracking and Event Splits need a Start Event.</p>
        {rules.startEvents.length > 0 ? null : (
          <p>A run started by hand carries no Event data for later steps.</p>
        )}
      </ConfigHelp>
    </div>
  );
}

/** The label of the checkbox that allows runs started by hand. */
const MANUAL_START_LABEL = "Can be run by hand";

/**
 * The typed Concurrency a Select handed back, or nothing for a value the
 * options do not declare. Base UI types its answer as a plain string, and the
 * stored rules take one of three names, so the list is what does the narrowing.
 */
function readConcurrency(value: string): Concurrency | undefined {
  return CONCURRENCY_OPTIONS.find((option) => option.value === value)?.value;
}

/** The choice in force, named as its option reads, with what it does. */
function ChosenConcurrencyHelp({ concurrency }: { concurrency: Concurrency }) {
  const option = CONCURRENCY_OPTIONS.find(
    (entry) => entry.value === concurrency
  );
  return option ? (
    <p>
      <span className="font-medium text-foreground">{option.label}</span>{" "}
      {option.description}
    </p>
  ) : null;
}

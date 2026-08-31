/**
 * One input per field the node's connection declares, stored as one JSON object.
 *
 * The set is not known at catalog time -- it depends on which resource the
 * builder picked -- so the whole set lives under the one config key that
 * declared the provider. That keeps the step boundary where it was: the handler
 * still parses one JSON string under one key.
 *
 * A value equal to the provider's own default is left out rather than written,
 * so the provider applies that default itself and an untouched input costs
 * nothing. The default is therefore a render-time prefill and never a write.
 * Clearing an input that has a default is a real edit and is stored as the empty
 * string, because "send nothing here" is a different instruction from "use the
 * default".
 *
 * A value whose key the current selection does not declare is carried through
 * untouched. The builder put it there, switching selections is reversible, and
 * dropping it on the next keystroke would discard it one render after the notice
 * that says it was kept.
 */

import { TemplateBadgeInput } from "#src/components/ui/template-badge-input";
import { TemplateBadgeTextarea } from "#src/components/ui/template-badge-textarea";
import type { ConfigOptionField } from "#src/lib/rpc-client";
import { Label } from "#src/components/ui/label";
import { ProviderFieldNotice } from "./provider-fallback";
import type { ProviderFieldProps } from "./provider-select-field";
import { useConfigOptions } from "./use-config-options";
import {
  type ProviderFieldValues,
  readProviderFieldValues,
} from "@wfgraph/shared/plugins/provider-field-values";

/** The stored JSON, or nothing when it holds something this form cannot draw. */
function readStoredObject(value: unknown): ProviderFieldValues | null {
  // A field nobody has touched holds no text, and an empty form is what draws
  // over it. The shared reader answers unreadable there, because at the step
  // boundary "nothing stored" and "an object with no members" differ.
  if (typeof value !== "string" || value.trim().length === 0) {
    return {};
  }

  return readProviderFieldValues(value);
}

/**
 * The value to store for one input, or nothing when the provider's own default
 * already says it.
 *
 * A declared number keeps its type where the text is one, which is what the
 * provider asked for by declaring it; text that is not a number is stored as
 * typed, because refusing it here would lose what the builder wrote.
 */
function storedValueFor(
  entry: ConfigOptionField,
  typed: string
): string | number | undefined {
  if (typed === (entry.defaultValue ?? "")) {
    return undefined;
  }
  if (entry.type === "number" && typed.trim().length > 0) {
    const asNumber = Number(typed);
    if (Number.isFinite(asNumber)) {
      return asNumber;
    }
  }
  return typed;
}

export function ProviderFieldsField({
  field,
  value,
  config,
  onChange,
  disabled,
  placeholder,
}: ProviderFieldProps) {
  const state = useConfigOptions({ source: field.optionsSource, config });
  const stored = readStoredObject(value);

  const rawTextarea = (
    <TemplateBadgeTextarea
      disabled={disabled}
      id={field.key}
      labelledBy={field.label ? `${field.key}-label` : undefined}
      onChange={onChange}
      placeholder={placeholder}
      required={field.required}
      rows={field.rows || 4}
      value={typeof value === "string" ? value : ""}
    />
  );

  // Text that is not a JSON object of values is the builder's own edit, and it
  // is theirs to keep: rendering the form over it would discard what they typed.
  if (state.state !== "ready" || state.answer.status !== "fields" || !stored) {
    return (
      <div className="flex flex-col gap-2">
        <ProviderFieldNotice state={state} />
        {rawTextarea}
      </div>
    );
  }

  const declared = state.answer.fields;
  const declaredKeys = new Set(declared.map((entry) => entry.key));
  const dropped = Object.keys(stored).filter((key) => !declaredKeys.has(key));
  const storedValue = (key: string) =>
    Object.hasOwn(stored, key) ? stored[key] : undefined;

  const write = (key: string, next: string) => {
    // Keys the current selection does not declare are kept as they are: the
    // builder wrote them, and switching selections is something they can undo.
    const entries: Array<[string, string | number]> = [];
    for (const droppedKey of dropped) {
      const carried = storedValue(droppedKey);
      if (carried !== undefined) {
        entries.push([droppedKey, carried]);
      }
    }

    for (const entry of declared) {
      const current =
        entry.key === key
          ? storedValueFor(entry, next)
          : storedValue(entry.key);
      if (current !== undefined) {
        entries.push([entry.key, current]);
      }
    }

    onChange(
      entries.length > 0 ? JSON.stringify(Object.fromEntries(entries)) : ""
    );
  };

  if (declared.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        This selection declares no values to fill in.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {declared.map((entry) => (
        <ProviderSubField
          disabled={disabled}
          entry={entry}
          key={entry.key}
          onChange={(next) => write(entry.key, next)}
          parentKey={field.key}
          value={String(storedValue(entry.key) ?? entry.defaultValue ?? "")}
        />
      ))}
      {dropped.length > 0 && (
        // Kept and named. Switching selections is reversible, so a value the new
        // set does not declare is carried rather than discarded, and saying so
        // is what stops it looking like the form lost it.
        <p className="text-muted-foreground text-xs">
          Kept but not used by this selection: {dropped.join(", ")}
        </p>
      )}
    </div>
  );
}

/**
 * One input, and whether the provider will refuse the run without it.
 *
 * A value the provider has no default for has to be supplied or the send fails,
 * so the empty state is drawn as wrong here rather than left to surface as a
 * failed run. The field marks itself `invalid` for the same reason it marks
 * itself required: the builder is looking at it now.
 */
function ProviderSubField({
  entry,
  parentKey,
  value,
  onChange,
  disabled,
}: {
  entry: ConfigOptionField;
  parentKey: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = `${parentKey}.${entry.key}`;
  const missing = entry.required === true && value.trim().length === 0;

  return (
    <div className="flex flex-col gap-1">
      <Label className="ml-1 text-xs" htmlFor={id} id={`${id}-label`}>
        {entry.label}
        {entry.required && (
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        )}
      </Label>
      <TemplateBadgeInput
        disabled={disabled}
        id={id}
        invalid={missing}
        labelledBy={`${id}-label`}
        onChange={(next) => onChange(typeof next === "string" ? next : "")}
        required={entry.required}
        value={value}
      />
      {missing && (
        <p className="ml-1 text-destructive text-xs">
          This template has no default for {entry.label}, so the send needs a
          value here.
        </p>
      )}
      {entry.description && (
        <p className="ml-1 text-muted-foreground text-xs">
          {entry.description}
        </p>
      )}
    </div>
  );
}

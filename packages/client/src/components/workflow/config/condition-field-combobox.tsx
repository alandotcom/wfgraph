import { useMemo } from "react";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxInputGroup,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "#src/components/ui/combobox";
import type { ConditionSelectableField } from "#src/lib/upstream-node-fields";

/** One section in the picker: the node (or Event) the fields belong under. */
type ConditionFieldGroup = {
  value: string;
  items: ConditionSelectableField[];
};

/**
 * A stored path the current graph no longer offers, shown so the input is not
 * blank. Type is unused: the row never writes this object onto a rule.
 */
function unavailableField(path: string): ConditionSelectableField {
  return {
    path,
    label: `${path} (Unavailable)`,
    type: "string",
    sourceNodeId: "",
    sourceNodeLabel: "Unavailable",
    sourceNodeLabels: ["Unavailable"],
  };
}

function groupsBySource(
  fields: readonly ConditionSelectableField[]
): ConditionFieldGroup[] {
  const grouped = new Map<string, ConditionSelectableField[]>();

  for (const field of fields) {
    const group = grouped.get(field.sourceNodeLabel);
    if (group) {
      group.push(field);
    } else {
      grouped.set(field.sourceNodeLabel, [field]);
    }
  }

  return Array.from(grouped.entries())
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([value, items]) => ({
      value,
      items: items.toSorted((a, b) => a.path.localeCompare(b.path)),
    }));
}

function pickerItems(
  fields: readonly ConditionSelectableField[],
  valuePath: string
): { selected: ConditionSelectableField; groups: ConditionFieldGroup[] } {
  const fromCatalog = fields.find((field) => field.path === valuePath);
  const groups = groupsBySource(fields);
  if (fromCatalog) {
    return { selected: fromCatalog, groups };
  }

  const selected = unavailableField(valuePath);
  return {
    selected,
    groups: [{ value: selected.sourceNodeLabel, items: [selected] }, ...groups],
  };
}

/**
 * A search reads the path, the node it came from, and "nullable" alike.
 *
 * A builder meeting a long list remembers a field as a path, as the step that
 * produced it, or as the badge that says a run can arrive without it.
 */
function matchesField(field: ConditionSelectableField, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }

  const haystack = [
    field.path,
    field.label,
    ...field.sourceNodeLabels,
    ...(field.nullable ? ["nullable"] : []),
  ];
  return haystack.some((text) => text.toLowerCase().includes(needle));
}

/** The path is the identity; two fields carrying it are the same choice. */
function sameField(
  a: ConditionSelectableField,
  b: ConditionSelectableField
): boolean {
  return a.path === b.path;
}

function fieldLabel(field: ConditionSelectableField): string {
  return field.label;
}

/**
 * The field picker for a condition rule.
 *
 * An upstream action can expose dozens of paths, so the list is a combobox the
 * way the Event picker already is: typing filters it, grouped by the node that
 * produced each path. A stored path the graph no longer offers is prepended as
 * its own section rather than left blank.
 */
export function ConditionFieldCombobox({
  fields,
  valuePath,
  onValueChange,
  disabled,
}: {
  fields: readonly ConditionSelectableField[];
  valuePath: string;
  onValueChange: (field: ConditionSelectableField) => void;
  disabled: boolean;
}) {
  const { selected, groups } = useMemo(
    () => pickerItems(fields, valuePath),
    [fields, valuePath]
  );

  return (
    <Combobox<ConditionSelectableField>
      disabled={disabled}
      filter={matchesField}
      isItemEqualToValue={sameField}
      items={groups}
      itemToStringLabel={fieldLabel}
      onValueChange={(next) => {
        if (next) {
          onValueChange(next);
        }
      }}
      value={selected}
    >
      <ComboboxInputGroup className="min-w-[280px]">
        <ComboboxInput aria-label="Select field" placeholder="Select field" />
        <ComboboxTrigger aria-label="Show the fields" />
      </ComboboxInputGroup>
      <ComboboxContent className="w-max min-w-(--anchor-width)">
        <ComboboxEmpty>No field matches that.</ComboboxEmpty>
        <ComboboxList>
          {(group: ConditionFieldGroup) => (
            <ComboboxGroup items={group.items} key={group.value}>
              <ComboboxGroupLabel>{group.value}</ComboboxGroupLabel>
              <ComboboxCollection>
                {(field: ConditionSelectableField) => (
                  <ComboboxItem
                    className="items-start"
                    key={field.path}
                    value={field}
                  >
                    <span className="flex w-full flex-col items-start">
                      <span className="flex items-center gap-1.5">
                        {field.label}
                        {field.nullable && (
                          <span className="rounded bg-muted px-1 py-0.5 font-normal text-xs text-muted-foreground leading-none">
                            nullable
                          </span>
                        )}
                      </span>
                      {field.sourceNodeLabels.length > 1 && (
                        <span className="text-muted-foreground text-xs">
                          Also from{" "}
                          {field.sourceNodeLabels
                            .filter(
                              (sourceLabelName) =>
                                sourceLabelName !== group.value
                            )
                            .join(", ")}
                        </span>
                      )}
                    </span>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

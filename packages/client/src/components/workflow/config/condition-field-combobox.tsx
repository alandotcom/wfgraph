import { Selector } from "@astryxdesign/core/Selector";
import { useMemo } from "react";
import type { ConditionSelectableField } from "#src/lib/upstream-node-fields";

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

/**
 * Searchable Astryx selector for the typed output fields a condition can read.
 * Source names stay in each option label so similarly named paths remain clear
 * and searchable without maintaining a second combobox implementation.
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
  const choices = useMemo(() => {
    const selected =
      fields.find((field) => field.path === valuePath) ??
      unavailableField(valuePath);
    const includesSelected = fields.some((field) => field.path === valuePath);
    return {
      selected,
      fields: (includesSelected ? [...fields] : [selected, ...fields]).toSorted(
        (a, b) => {
          const bySource = a.sourceNodeLabel.localeCompare(b.sourceNodeLabel);
          return bySource || a.path.localeCompare(b.path);
        }
      ),
    };
  }, [fields, valuePath]);

  return (
    <Selector
      hasSearch
      isDisabled={disabled}
      isLabelHidden
      label="Field"
      onChange={(path) => {
        const next = choices.fields.find((field) => field.path === path);
        if (next) {
          onValueChange(next);
        }
      }}
      options={choices.fields.map((field) => ({
        value: field.path,
        label: `${field.sourceNodeLabel}: ${field.label}${field.nullable ? " (nullable)" : ""}`,
      }))}
      placement="below"
      placeholder="Select field"
      searchPlaceholder="Search fields"
      value={choices.selected.path}
      width={280}
    />
  );
}

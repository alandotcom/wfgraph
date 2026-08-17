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

  if (
    field.label.toLowerCase().includes(needle) ||
    field.path.toLowerCase().includes(needle) ||
    field.sourceNodeLabel.toLowerCase().includes(needle) ||
    field.sourceNodeLabels.some((label) => label.toLowerCase().includes(needle))
  ) {
    return true;
  }

  return Boolean(field.nullable) && "nullable".includes(needle);
}

/** The path is the identity; two fields carrying it are the same choice. */
function sameField(
  a: ConditionSelectableField,
  b: ConditionSelectableField
): boolean {
  return a.path === b.path;
}

/**
 * The field picker for a condition rule.
 *
 * An upstream action can expose dozens of paths, so the list is a combobox the
 * way the Event picker already is: typing filters it, grouped by the node that
 * produced each path.
 */
export function ConditionFieldCombobox({
  groups,
  value,
  onValueChange,
  disabled,
}: {
  groups: readonly ConditionFieldGroup[];
  value: ConditionSelectableField | null;
  onValueChange: (field: ConditionSelectableField) => void;
  disabled: boolean;
}) {
  return (
    <Combobox<ConditionSelectableField>
      disabled={disabled}
      filter={matchesField}
      isItemEqualToValue={sameField}
      items={groups}
      itemToStringLabel={(field) => field.label}
      onValueChange={(next) => {
        if (next) {
          onValueChange(next);
        }
      }}
      value={value}
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

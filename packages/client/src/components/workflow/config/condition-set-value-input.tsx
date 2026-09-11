/**
 * The two value lists of a set comparison on a string field. The row picks one
 * by whether the field declares enum values.
 */

import { useRef, useState } from "react";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from "#src/components/ui/combobox";
import type { ConditionSelectableField } from "#src/lib/upstream-node-fields";
import { displayTemplateText } from "@wfgraph/shared/graph/node-references";
import { isBlank } from "@wfgraph/shared/types/string";
import { uniq } from "es-toolkit/array";
import { enumOptionLabel } from "./condition-field-label";

type EnumChoice = { value: string; label: string };

/** Chip identity for both value lists: two choices are the same operand text. */
function sameChoiceValue(a: { value: string }, b: { value: string }): boolean {
  return a.value === b.value;
}

/**
 * The value list of a set comparison on a string field that declares enum
 * values.
 *
 * The popup offers the field's enum values. Every stored operand is a chip in
 * its stored order, including an operand the field does not offer: a template
 * reference, shown by its display text, or a literal the field no longer
 * names, shown as written. Such an operand stays in the list until its own chip
 * is removed, and a pick appends to the end of the list.
 */
export function EnumMultiValueInput({
  disabled,
  field,
  name,
  onValueChange,
  values,
}: {
  disabled: boolean;
  field: ConditionSelectableField | undefined;
  name: string;
  onValueChange: (values: string[]) => void;
  values: string[];
}) {
  const choices = (field?.enumValues ?? []).map((value) => ({
    value,
    label: enumOptionLabel(field, value),
  }));
  const selected = values.map(
    (value) =>
      choices.find((choice) => choice.value === value) ?? {
        value,
        label: displayTemplateText(value),
      }
  );

  return (
    <Combobox<EnumChoice, true>
      disabled={disabled}
      isItemEqualToValue={sameChoiceValue}
      items={choices}
      itemToStringLabel={(choice) => choice.label}
      multiple
      onValueChange={(next) =>
        onValueChange(next.map((choice) => choice.value))
      }
      value={selected}
    >
      <ComboboxChips className="min-w-[240px]">
        <ComboboxValue>
          {(picked: EnumChoice[]) => (
            <>
              {picked.map((choice) => (
                <ComboboxChip
                  key={choice.value}
                  removeLabel={`Remove ${choice.label}`}
                >
                  <span className="max-w-40 truncate" title={choice.label}>
                    {choice.label}
                  </span>
                </ComboboxChip>
              ))}
              <ComboboxChipsInput
                aria-label={`Select ${name} values`}
                disabled={disabled}
                placeholder={picked.length === 0 ? "Select values" : ""}
              />
              <ComboboxTrigger aria-label={`Show ${name} values`} />
            </>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent>
        <ComboboxEmpty>No value matches that.</ComboboxEmpty>
        <ComboboxList>
          {(choice: EnumChoice) => (
            <ComboboxItem key={choice.value} value={choice}>
              {choice.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

/**
 * One value of a free-text set, or the entry that adds the text typed so far.
 * `adding` marks that entry, whose `label` is the "Add" wording.
 */
type TextSetChoice = { value: string; label: string; adding: boolean };

/**
 * The value list of a set comparison on a string field with no enum values.
 *
 * Every stored value is a chip the builder can remove. Typed text is trimmed
 * and offered as one "Add" entry, which a click appends. Enter appends it too,
 * including while the popup is closed. Blank text and a value already in the
 * list offer no entry, so neither is added.
 */
export function TextSetValueInput({
  disabled,
  name,
  onValueChange,
  values,
}: {
  disabled: boolean;
  name: string;
  onValueChange: (values: string[]) => void;
  values: string[];
}) {
  const [query, setQuery] = useState("");
  // The entry Enter would pick, if any. Base UI handles Enter on a highlighted
  // entry itself, so the input's own Enter handler acts only when none is.
  const highlighted = useRef<TextSetChoice | undefined>(undefined);
  const typed = query.trim();
  const selected = values.map((value) => ({
    value,
    label: displayTemplateText(value),
    adding: false,
  }));
  const addable =
    isBlank(typed) || values.includes(typed)
      ? []
      : [{ value: typed, label: `Add "${typed}"`, adding: true }];

  return (
    <Combobox<TextSetChoice, true>
      autoHighlight
      disabled={disabled}
      // The one entry is built from the query, so matching it against the
      // query again could only hide it.
      filter={null}
      inputValue={query}
      isItemEqualToValue={sameChoiceValue}
      items={addable}
      itemToStringLabel={(choice) => choice.label}
      multiple
      onInputValueChange={setQuery}
      onItemHighlighted={(choice) => {
        highlighted.current = choice;
      }}
      // A closed popup highlights nothing, whatever it last reported.
      onOpenChange={(open) => {
        if (!open) {
          highlighted.current = undefined;
        }
      }}
      onValueChange={(next) => {
        onValueChange(uniq(next.map((choice) => choice.value)));
        if (next.some((choice) => choice.adding)) {
          setQuery("");
        }
      }}
      value={selected}
    >
      <ComboboxChips className="min-w-[240px]">
        <ComboboxValue>
          {(picked: TextSetChoice[]) => (
            <>
              {picked.map((choice) => (
                <ComboboxChip
                  key={choice.value}
                  removeLabel={`Remove ${choice.label}`}
                >
                  <span className="max-w-40 truncate" title={choice.label}>
                    {choice.label}
                  </span>
                </ComboboxChip>
              ))}
              <ComboboxChipsInput
                aria-label={`Add ${name} values`}
                disabled={disabled}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || highlighted.current) {
                    return;
                  }
                  event.preventDefault();
                  const [adding] = addable;
                  if (adding) {
                    onValueChange([...values, adding.value]);
                    setQuery("");
                  }
                }}
                placeholder={picked.length === 0 ? "Type a value" : ""}
              />
            </>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent>
        <ComboboxEmpty>Type a value to add it.</ComboboxEmpty>
        <ComboboxList>
          {(choice: TextSetChoice) => (
            <ComboboxItem key={choice.value} value={choice}>
              {choice.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

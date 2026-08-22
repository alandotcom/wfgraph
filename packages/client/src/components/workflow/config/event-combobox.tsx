import { MultiSelector } from "@astryxdesign/core/MultiSelector";

export type EventChoice = {
  name: string;
  label: string;
};

export function EventMultiCombobox({
  choices,
  value,
  onValueChange,
  disabled,
  label = "Events",
  placeholder = "Search Events",
}: {
  choices: readonly EventChoice[];
  value: readonly string[];
  onValueChange: (eventNames: string[]) => void;
  disabled: boolean;
  inputId: string;
  label?: string;
  placeholder?: string;
}) {
  return (
    <MultiSelector
      hasSearch
      indicatorPosition="end"
      isDisabled={disabled}
      isLabelHidden
      label={label}
      onChange={onValueChange}
      options={choices.map((choice) => ({
        value: choice.name,
        label:
          choice.label === choice.name
            ? choice.label
            : `${choice.label} (${choice.name})`,
      }))}
      placeholder={placeholder}
      searchPlaceholder="Search Events"
      triggerDisplay="labels"
      value={[...value]}
      width="100%"
    />
  );
}

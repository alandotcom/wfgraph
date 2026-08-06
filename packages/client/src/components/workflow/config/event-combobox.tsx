import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxInputGroup,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "#src/components/ui/combobox";

/** One choice: what the builder reads, and the name a sender posts. */
export type EventChoice = {
  name: string;
  label: string;
};

/**
 * A search reads the label and the raw name alike.
 *
 * A builder meets an Event as a sentence in this editor and as a namespaced
 * string in whatever sends it, and which half they remember depends on which
 * side of that they came from.
 */
function matchesQuery(choice: EventChoice, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }

  return (
    choice.label.toLowerCase().includes(needle) ||
    choice.name.toLowerCase().includes(needle)
  );
}

/** The name is the identity; two choices carrying it are the same Event. */
function sameEvent(a: EventChoice, b: EventChoice): boolean {
  return a.name === b.name;
}

function EventComboboxBody({
  inputId,
  placeholder,
}: {
  inputId: string;
  placeholder: string;
}) {
  return (
    <>
      <ComboboxInputGroup>
        <ComboboxInput id={inputId} placeholder={placeholder} />
        <ComboboxTrigger aria-label="Show the Events" />
      </ComboboxInputGroup>
      <ComboboxContent>
        <ComboboxEmpty>No Event matches that.</ComboboxEmpty>
        <ComboboxList>
          {(choice: EventChoice) => (
            <ComboboxItem key={choice.name} value={choice}>
              <span className="block truncate">{choice.label}</span>
              {choice.label === choice.name ? null : (
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {choice.name}
                </span>
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </>
  );
}

/**
 * Several Events out of the catalog, with the chosen ones rendered by the
 * caller.
 *
 * An app declares as many Events as it likes, so the list is the part that has
 * to scale: a row of chips is unreadable past a handful and offers no way to
 * find one by name.
 *
 * The list marks what is already chosen and picking it again takes it off, so
 * the input stays a search box: each selection carries a line of its own beneath
 * it, which no chip inside an input has room for.
 */
export function EventMultiCombobox({
  choices,
  value,
  onValueChange,
  disabled,
  inputId,
  placeholder = "Search Events",
}: {
  choices: readonly EventChoice[];
  value: readonly string[];
  onValueChange: (eventNames: string[]) => void;
  disabled: boolean;
  inputId: string;
  placeholder?: string;
}) {
  const selected = value.flatMap(
    (name) => choices.find((choice) => choice.name === name) ?? []
  );

  return (
    <Combobox<EventChoice, true>
      disabled={disabled}
      filter={matchesQuery}
      isItemEqualToValue={sameEvent}
      items={choices}
      itemToStringLabel={(choice) => choice.label}
      multiple
      onValueChange={(next) => onValueChange(next.map((choice) => choice.name))}
      value={selected}
    >
      <EventComboboxBody inputId={inputId} placeholder={placeholder} />
    </Combobox>
  );
}

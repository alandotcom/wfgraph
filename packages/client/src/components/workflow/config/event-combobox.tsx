import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "#src/components/ui/combobox";
import {
  type ExtensionCatalog,
  findIntegration,
} from "@wfgraph/shared/extensions/catalog";

/** One choice: what the builder reads, and the name a sender posts. */
export type EventChoice = {
  name: string;
  label: string;
  /** Integration label, absent for a host Event. */
  group?: string;
};

type EventChoiceGroup = {
  value: string;
  items: EventChoice[];
};

export function catalogEventChoices(catalog: ExtensionCatalog): EventChoice[] {
  return catalog.events.map((event) => ({
    name: event.name,
    label: event.label,
    group: event.integration
      ? (findIntegration(catalog, event.integration)?.label ??
        event.integration)
      : undefined,
  }));
}

function groupEventChoices(
  choices: readonly EventChoice[]
): EventChoiceGroup[] {
  const byGroup = new Map<string, EventChoice[]>();
  for (const choice of choices) {
    const key = choice.group ?? "This app";
    const list = byGroup.get(key) ?? [];
    list.push(choice);
    byGroup.set(key, list);
  }
  return [...byGroup.entries()].map(([value, items]) => ({ value, items }));
}

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

function EventItem({ choice }: { choice: EventChoice }) {
  return (
    <ComboboxItem key={choice.name} value={choice}>
      <span className="block truncate">{choice.label}</span>
      {choice.label === choice.name ? null : (
        <span className="block truncate font-mono text-xs text-muted-foreground">
          {choice.name}
        </span>
      )}
    </ComboboxItem>
  );
}

function EventComboboxBody({
  inputId,
  placeholder,
  grouped,
}: {
  inputId: string;
  placeholder: string;
  grouped: boolean;
}) {
  return (
    <>
      <ComboboxInput
        id={inputId}
        placeholder={placeholder}
        triggerLabel="Show the Events"
      />
      <ComboboxContent>
        <ComboboxEmpty>No Event matches that.</ComboboxEmpty>
        <ComboboxList>
          {grouped
            ? (group: EventChoiceGroup) => (
                <ComboboxGroup items={group.items} key={group.value}>
                  <ComboboxLabel>{group.value}</ComboboxLabel>
                  <ComboboxCollection>
                    {(choice: EventChoice) => (
                      <EventItem choice={choice} key={choice.name} />
                    )}
                  </ComboboxCollection>
                </ComboboxGroup>
              )
            : (choice: EventChoice) => (
                <EventItem choice={choice} key={choice.name} />
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
  const grouped = choices.some((choice) => choice.group);
  const items = grouped ? groupEventChoices(choices) : choices;

  return (
    <Combobox<EventChoice, true>
      disabled={disabled}
      filter={matchesQuery}
      isItemEqualToValue={sameEvent}
      items={items}
      itemToStringLabel={(choice) => choice.label}
      multiple
      onValueChange={(next) => onValueChange(next.map((choice) => choice.name))}
      value={selected}
    >
      <EventComboboxBody
        grouped={grouped}
        inputId={inputId}
        placeholder={placeholder}
      />
    </Combobox>
  );
}

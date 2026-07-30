import { cn } from "@rova/shared/utils";

/** One chip: what the builder reads, and the name a sender POSTs. */
export type EventChoice = {
  name: string;
  label: string;
};

/**
 * The app's Events as a row of chips, shared by the Lifecycle panel and the Wait
 * node.
 *
 * A builder meets this vocabulary in both places in one session, so both show
 * the Event's label with its raw name beneath: the name is what a sender posts
 * to and what the Wait node lets a builder type in, and the label is the only
 * half that reads as a sentence.
 */
export function EventChipGroup({
  choices,
  selected,
  onToggle,
  disabled,
  labelId,
}: {
  choices: readonly EventChoice[];
  selected: readonly string[];
  onToggle: (eventName: string) => void;
  disabled: boolean;
  labelId: string;
}) {
  return (
    <div
      aria-labelledby={labelId}
      className="flex flex-wrap gap-1.5"
      role="group"
    >
      {choices.map((choice) => {
        const isSelected = selected.includes(choice.name);
        return (
          <button
            aria-pressed={isSelected}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs transition-colors",
              "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              // Selection is one of the graphite system's sanctioned uses of
              // contrast: a filled ink chip, unmistakable at a glance.
              isSelected
                ? "border-primary bg-primary text-primary-foreground"
                : "border-input text-muted-foreground hover:bg-muted/50",
              disabled && "pointer-events-none opacity-50"
            )}
            disabled={disabled}
            key={choice.name}
            onClick={() => onToggle(choice.name)}
            title={choice.name}
            type="button"
          >
            <span className="block">{choice.label}</span>
            {choice.label === choice.name ? null : (
              <span
                className={cn(
                  "block font-mono text-[10px]",
                  isSelected ? "opacity-80" : "opacity-70"
                )}
              >
                {choice.name}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

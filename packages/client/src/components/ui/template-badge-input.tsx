import { useAtomValue } from "jotai";
import { cn } from "@wfgraph/shared/utils";
import { selectedNodeAtom } from "#src/lib/workflow-graph-store";
import {
  TemplateAutocomplete,
  useTemplateAutocompleteRows,
} from "./template-autocomplete";
import { useTemplateBadgeField } from "./use-template-badge-field";

export interface TemplateBadgeInputProps {
  value?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  id?: string | undefined;
  fieldType?: "duration" | "timestamp" | undefined;
  currentNodeId?: string | undefined;
  /**
   * Id of the element naming this field. Required in practice: the editor is a
   * `contenteditable` div, and `<label for>` cannot name one, so without this
   * the field reaches the accessibility tree as an unnamed textbox.
   */
  labelledBy?: string | undefined;
  /** Id of the element that explains this field. */
  describedBy?: string | undefined;
  /** Direct name, for a field with no visible label element to point at. */
  ariaLabel?: string | undefined;
  required?: boolean | undefined;
  invalid?: boolean | undefined;
}

/**
 * A single-line field that renders node references as badges.
 *
 * The contentEditable and everything done to it live in
 * `useTemplateBadgeField`; what is left here is the markup and which node the
 * autocomplete should offer fields from.
 */
export function TemplateBadgeInput({
  value = "",
  onChange,
  placeholder,
  disabled,
  className,
  id,
  fieldType,
  currentNodeId,
  labelledBy,
  describedBy,
  ariaLabel,
  required,
  invalid,
}: TemplateBadgeInputProps) {
  const {
    attachEditor,
    autocompleteAnchor,
    autocompleteFilter,
    chromeRef,
    closeAutocomplete,
    handleAutocompleteSelect,
    handleBlur,
    handleFocus,
    handleInput,
    handleKeyDown,
    handlePaste,
    showAutocomplete,
  } = useTemplateBadgeField({ value, onChange, placeholder });
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const rows = useTemplateAutocompleteRows({
    currentNodeId: currentNodeId ?? selectedNodeId ?? undefined,
    filter: autocompleteFilter,
    fieldType,
  });
  const isMenuShown = showAutocomplete && rows.hasRowsToShow;

  return (
    <>
      <div
        className={cn(
          // Built to match ComboboxChips, the other container in the system
          // that holds badges: same 28px floor, same padding, same type size,
          // and the same border-plus-ring treatment on focus. Anything that
          // grows this box beyond a plain Input makes a template field read as
          // a different kind of control from the text field beside it.
          "flex min-h-7 w-full rounded-md border border-input bg-input/20 px-2 py-0.5 text-base transition-colors focus-within:border-ring focus-within:outline-none focus-within:ring-2 focus-within:ring-ring/30 md:text-xs/relaxed dark:bg-input/30",
          invalid &&
            "border-destructive focus-within:border-destructive focus-within:ring-destructive/20",
          disabled && "cursor-not-allowed opacity-50",
          className
        )}
        data-invalid={invalid || undefined}
        ref={chromeRef}
      >
        <div
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          aria-label={ariaLabel}
          aria-labelledby={labelledBy}
          aria-required={required || undefined}
          className="w-full outline-none"
          contentEditable={!disabled}
          // Canvas Reveal leaves Escape to the autocomplete menu while it shows.
          data-autocomplete-open={isMenuShown || undefined}
          id={id}
          onBlur={handleBlur}
          onFocus={handleFocus}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          ref={attachEditor}
          role="textbox"
          suppressContentEditableWarning
        />
      </div>

      <TemplateAutocomplete
        anchor={autocompleteAnchor}
        isOpen={showAutocomplete}
        onClose={closeAutocomplete}
        onSelect={handleAutocompleteSelect}
        rows={rows}
      />
    </>
  );
}

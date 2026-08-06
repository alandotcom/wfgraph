import { cn } from "@rova/shared/utils";
import { TemplateAutocomplete } from "./template-autocomplete";
import { useTemplateBadgeField } from "./use-template-badge-field";

export interface TemplateBadgeInputProps {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  fieldType?: "duration" | "timestamp";
  currentNodeId?: string;
  /**
   * Id of the element naming this field. Required in practice: the editor is a
   * `contenteditable` div, and `<label for>` cannot name one, so without this
   * the field reaches the accessibility tree as an unnamed textbox.
   */
  labelledBy?: string;
  /** Direct name, for a field with no visible label element to point at. */
  ariaLabel?: string;
  required?: boolean;
  invalid?: boolean;
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
  ariaLabel,
  required,
  invalid,
}: TemplateBadgeInputProps) {
  const {
    attachEditor,
    autocompleteFilter,
    autocompletePosition,
    closeAutocomplete,
    handleAutocompleteSelect,
    handleBlur,
    handleFocus,
    handleInput,
    handleKeyDown,
    handlePaste,
    nodes,
    showAutocomplete,
  } = useTemplateBadgeField({ value, onChange, placeholder });
  const selectedNodeId = nodes.find((node) => node.selected)?.id;

  return (
    <>
      <div
        className={cn(
          // Matches the shared Input: shadow-xs at rest, and on focus a border
          // shift plus the 3px ring-ring/50 halo. This wrapper used to draw a
          // 1px opaque ring with no border change, so the one field type that
          // needed the most attention had the least visible focus.
          "flex min-h-9 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-colors focus-within:border-ring focus-within:outline-none focus-within:ring-[3px] focus-within:ring-ring/50 lg:text-sm",
          invalid &&
            "border-destructive focus-within:border-destructive focus-within:ring-destructive/20",
          disabled && "cursor-not-allowed opacity-50",
          className
        )}
        data-invalid={invalid || undefined}
      >
        <div
          aria-invalid={invalid || undefined}
          aria-label={ariaLabel}
          aria-labelledby={labelledBy}
          aria-required={required || undefined}
          className="w-full outline-none"
          contentEditable={!disabled}
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
        currentNodeId={currentNodeId ?? selectedNodeId ?? undefined}
        fieldType={fieldType}
        filter={autocompleteFilter}
        isOpen={showAutocomplete}
        onClose={closeAutocomplete}
        onSelect={handleAutocompleteSelect}
        position={autocompletePosition}
      />
    </>
  );
}

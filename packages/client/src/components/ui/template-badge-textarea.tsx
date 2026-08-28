import { cn } from "@wfgraph/shared/utils";
import { TemplateAutocomplete } from "./template-autocomplete";
import { useTemplateBadgeField } from "./use-template-badge-field";

export interface TemplateBadgeTextareaProps {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  rows?: number;
  fieldType?: "duration" | "timestamp";
  /**
   * Id of the element naming this field. Required in practice: the editor is a
   * `contenteditable` div, and `<label for>` cannot name one, so without this
   * the field reaches the accessibility tree as an unnamed textbox.
   */
  labelledBy?: string;
  required?: boolean;
  invalid?: boolean;
}

/**
 * The multi-line form of `TemplateBadgeInput`.
 *
 * The only difference is line breaks: Enter inserts one instead of submitting,
 * and the editor draws newlines as `<br>` and reads them back as `\n`.
 */
export function TemplateBadgeTextarea({
  value = "",
  onChange,
  placeholder,
  disabled,
  className,
  id,
  rows = 3,
  fieldType,
  labelledBy,
  required,
  invalid,
}: TemplateBadgeTextareaProps) {
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
    nodes,
    showAutocomplete,
  } = useTemplateBadgeField({
    value,
    onChange,
    placeholder,
    multiline: true,
  });
  const selectedNodeId = nodes.find((node) => node.selected)?.id;

  return (
    <>
      <div
        className={cn(
          // Matches the shared Textarea: shadow-xs at rest, and on focus a
          // border shift plus the 3px ring-ring/50 halo.
          "flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-colors focus-within:border-ring focus-within:outline-none focus-within:ring-[3px] focus-within:ring-ring/50 lg:text-sm",
          invalid &&
            "border-destructive focus-within:border-destructive focus-within:ring-destructive/20",
          disabled && "cursor-not-allowed opacity-50",
          className
        )}
        data-invalid={invalid || undefined}
        ref={chromeRef}
        style={{ minHeight: `${rows * 1.5}rem` }}
      >
        <div
          aria-invalid={invalid || undefined}
          aria-labelledby={labelledBy}
          aria-required={required || undefined}
          className="w-full whitespace-pre-wrap break-words outline-none"
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
        currentNodeId={selectedNodeId || undefined}
        fieldType={fieldType}
        filter={autocompleteFilter}
        isOpen={showAutocomplete}
        onClose={closeAutocomplete}
        onSelect={handleAutocompleteSelect}
        anchor={autocompleteAnchor}
      />
    </>
  );
}

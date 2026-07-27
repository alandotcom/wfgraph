import { cn } from "@rova/shared/utils";
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
}: TemplateBadgeTextareaProps) {
  const {
    attachEditor,
    autocompleteFilter,
    autocompletePosition,
    closeAutocomplete,
    handleAutocompleteSelect,
    handleBlur,
    handleFocus,
    handleInput,
    handlePaste,
    insertLineBreak,
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
          "flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors focus-within:outline-none focus-within:ring-1 focus-within:ring-ring",
          disabled && "cursor-not-allowed opacity-50",
          className
        )}
        style={{ minHeight: `${rows * 1.5}rem` }}
      >
        <div
          className="w-full whitespace-pre-wrap break-words outline-none"
          contentEditable={!disabled}
          id={id}
          onBlur={handleBlur}
          onFocus={handleFocus}
          onInput={handleInput}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              insertLineBreak();
            }
          }}
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
        position={autocompletePosition}
      />
    </>
  );
}

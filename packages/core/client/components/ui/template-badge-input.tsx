import { cn } from "@/shared/utils";
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
    handlePaste,
    nodes,
    showAutocomplete,
  } = useTemplateBadgeField({ value, onChange, placeholder });
  const selectedNodeId = nodes.find((node) => node.selected)?.id;

  return (
    <>
      <div
        className={cn(
          "flex min-h-9 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors focus-within:outline-none focus-within:ring-1 focus-within:ring-ring",
          disabled && "cursor-not-allowed opacity-50",
          className
        )}
      >
        <div
          className="w-full outline-none"
          contentEditable={!disabled}
          id={id}
          onBlur={handleBlur}
          onFocus={handleFocus}
          onInput={handleInput}
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

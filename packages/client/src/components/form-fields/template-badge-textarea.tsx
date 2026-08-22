import * as stylex from "@stylexjs/stylex";
import {
  colorVars,
  radiusVars,
  shadowVars,
  spacingVars,
  typeScaleVars,
} from "@astryxdesign/core/theme/tokens.stylex";
import { TemplateAutocomplete } from "./template-autocomplete";
import { useTemplateBadgeField } from "./use-template-badge-field";

export interface TemplateBadgeTextareaProps {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  xstyle?: stylex.StyleXStyles;
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
  xstyle,
  id,
  rows = 3,
  fieldType,
  labelledBy,
  required,
  invalid,
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
        data-invalid={invalid || undefined}
        style={{ minHeight: `${rows * 1.5}rem` }}
        {...stylex.props(
          styles.field,
          invalid && styles.invalid,
          disabled && styles.disabled,
          xstyle
        )}
      >
        <div
          aria-invalid={invalid || undefined}
          aria-labelledby={labelledBy}
          aria-required={required || undefined}
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
          {...stylex.props(styles.editor)}
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

const styles = stylex.create({
  field: {
    backgroundColor: "transparent",
    borderColor: {
      default: colorVars["--color-border"],
      ":focus-within": colorVars["--color-accent"],
    },
    borderRadius: radiusVars["--radius-element"],
    borderStyle: "solid",
    borderWidth: 1,
    boxShadow: shadowVars["--shadow-low"],
    display: "flex",
    fontSize: typeScaleVars["--text-body-size"],
    paddingBlock: spacingVars["--spacing-2"],
    paddingInline: spacingVars["--spacing-3"],
    transitionProperty: "border-color, box-shadow",
    width: "100%",
  },
  invalid: {
    borderColor: colorVars["--color-error"],
  },
  disabled: {
    cursor: "not-allowed",
    opacity: 0.5,
  },
  editor: {
    minWidth: 0,
    overflowWrap: "anywhere",
    outline: "none",
    whiteSpace: "pre-wrap",
    width: "100%",
  },
});

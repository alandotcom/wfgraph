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

export interface TemplateBadgeInputProps {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  xstyle?: stylex.StyleXStyles;
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
  xstyle,
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
        data-invalid={invalid || undefined}
        {...stylex.props(
          styles.field,
          invalid && styles.invalid,
          disabled && styles.disabled,
          xstyle
        )}
      >
        <div
          aria-invalid={invalid || undefined}
          aria-label={ariaLabel}
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
    minHeight: 36,
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
    outline: "none",
    width: "100%",
  },
});

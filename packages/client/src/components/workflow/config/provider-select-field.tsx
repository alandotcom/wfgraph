/**
 * A dropdown whose options the node's connection answers.
 *
 * A value holding a `{{@node:Label.path}}` reference is always edited as a
 * template, because a picker cannot represent one. Everything else is picked,
 * unless the builder asked for the template editor and has not typed the
 * reference yet: that intent has no representation in the value, so it is the
 * one thing here that is state.
 *
 * A stored id the provider no longer lists is still shown selected, rather than
 * leaving the trigger looking empty about a value the node really does send.
 */

import { Braces, List } from "lucide-react";
import { useState } from "react";
import { Button } from "#src/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#src/components/ui/select";
import { TemplateBadgeInput } from "#src/components/ui/template-badge-input";
import { findTemplateTokens } from "@wfgraph/shared/graph/node-references";
import type { ActionConfigFieldBase } from "@wfgraph/shared/plugins/action-fields";
import { ProviderFieldNotice } from "./provider-fallback";
import { useConfigOptions } from "./use-config-options";

export type ProviderFieldProps = {
  field: ActionConfigFieldBase;
  value: unknown;
  config: Record<string, unknown>;
  /** Resolved by `renderField`; see `FieldProps` in the renderer. */
  placeholder: string | undefined;
  onChange: (value: unknown) => void;
  disabled?: boolean | undefined;
};

export function ProviderSelectField({
  field,
  value,
  config,
  placeholder,
  onChange,
  disabled,
}: ProviderFieldProps) {
  const stored = typeof value === "string" ? value : "";
  const state = useConfigOptions({ source: field.optionsSource, config });
  const inferredMode =
    findTemplateTokens(stored).length > 0 ? "template" : "picker";
  const [modeState, setModeState] = useState({
    stored,
    mode: inferredMode,
  });
  if (modeState.stored !== stored) {
    setModeState({ stored, mode: inferredMode });
  }
  const mode = modeState.stored === stored ? modeState.mode : inferredMode;
  const asTemplate = mode === "template";
  const fieldName = field.label || field.key;

  const templateInput = (
    <TemplateBadgeInput
      disabled={disabled}
      id={field.key}
      labelledBy={field.label ? `${field.key}-label` : undefined}
      onChange={onChange}
      placeholder={placeholder}
      required={field.required}
      value={stored}
    />
  );

  const modeToggle = (
    <Button
      className="size-7 shrink-0 p-0"
      disabled={disabled}
      onClick={() =>
        setModeState({
          stored,
          mode: asTemplate ? "picker" : "template",
        })
      }
      aria-label={
        asTemplate
          ? `Choose from the connection for ${fieldName}`
          : `Use an upstream value for ${fieldName}`
      }
      size="sm"
      title={
        asTemplate ? "Choose from the connection" : "Use an upstream value"
      }
      type="button"
      variant="ghost"
    >
      {asTemplate ? (
        <List className="size-3.5" />
      ) : (
        <Braces className="size-3.5" />
      )}
    </Button>
  );

  const row = (control: React.ReactNode) => (
    // `min-h-7` is what both controls measure, so the row keeps its height
    // whichever mode the toggle is in. Without a floor the row collapses to
    // whatever the shorter control happens to be and the panel jumps on every
    // press.
    <div className="flex min-h-7 items-start gap-1">
      <div className="min-w-0 flex-1">{control}</div>
      {modeToggle}
    </div>
  );

  if (asTemplate) {
    return row(templateInput);
  }

  if (state.state === "ready" && state.answer.status === "options") {
    // A stored value the provider no longer lists still names itself, so the
    // trigger reads as what the node actually sends rather than as empty. It
    // goes in `items` too, which is what the trigger renders the label from.
    const listed = state.answer.options.map((option) => ({
      value: option.value,
      label: option.label,
    }));
    const items =
      stored.length > 0 && !listed.some((option) => option.value === stored)
        ? [{ value: stored, label: stored }, ...listed]
        : listed;

    return row(
      <Select
        disabled={disabled}
        items={items}
        onValueChange={onChange}
        value={stored}
      >
        <SelectTrigger className="w-full" id={field.key}>
          <SelectValue placeholder={placeholder ?? "Choose one"} />
        </SelectTrigger>
        <SelectContent>
          {items.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (state.state === "loading") {
    // The same height the answered row settles at, so arriving options do not
    // move the panel either.
    return row(
      <div
        aria-busy="true"
        className="h-7 w-full animate-pulse rounded-md bg-muted motion-reduce:animate-none"
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ProviderFieldNotice state={state} />
      {row(templateInput)}
    </div>
  );
}

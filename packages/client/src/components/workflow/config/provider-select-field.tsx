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
  onChange: (value: unknown) => void;
  disabled?: boolean;
};

export function ProviderSelectField({
  field,
  value,
  config,
  onChange,
  disabled,
}: ProviderFieldProps) {
  const stored = typeof value === "string" ? value : "";
  const state = useConfigOptions({ source: field.optionsSource, config });
  const [writingTemplate, setWritingTemplate] = useState(false);
  const asTemplate = writingTemplate || findTemplateTokens(stored).length > 0;

  const templateInput = (
    <TemplateBadgeInput
      disabled={disabled}
      id={field.key}
      labelledBy={field.label ? `${field.key}-label` : undefined}
      onChange={onChange}
      placeholder={field.placeholder}
      required={field.required}
      value={stored}
    />
  );

  const modeToggle = (
    <Button
      className="h-7 shrink-0 px-2"
      disabled={disabled}
      onClick={() => {
        // Switching clears the value, because neither control can hold what the
        // other one wrote: a picked id is not a reference and vice versa.
        setWritingTemplate(!asTemplate);
        onChange("");
      }}
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

  if (asTemplate) {
    return (
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">{templateInput}</div>
        {modeToggle}
      </div>
    );
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

    return (
      <div className="flex items-start gap-1">
        <Select
          disabled={disabled}
          items={items}
          onValueChange={onChange}
          value={stored}
        >
          <SelectTrigger className="min-w-0 flex-1" id={field.key}>
            <SelectValue placeholder={field.placeholder ?? "Choose one"} />
          </SelectTrigger>
          <SelectContent>
            {items.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {modeToggle}
      </div>
    );
  }

  if (state.state === "loading") {
    return (
      <div
        aria-busy="true"
        className="h-9 w-full animate-pulse rounded-md bg-muted motion-reduce:animate-none"
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ProviderFieldNotice state={state} />
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">{templateInput}</div>
        {modeToggle}
      </div>
    </div>
  );
}

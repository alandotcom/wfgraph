import { useAtomValue } from "jotai";
import { Plus, Trash2 } from "lucide-react";
import { type FocusEvent, useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "#src/components/ui/button";
import { Input } from "#src/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#src/components/ui/select";
import { whenChosen } from "#src/lib/select-choice";
import { TemplateBadgeInput } from "#src/components/ui/template-badge-input";
import type { ConditionSelectableField } from "#src/lib/upstream-node-fields";
import { nodesAtom } from "#src/lib/workflow-graph-store";
import { ConditionFieldCombobox } from "./condition-field-combobox";
import {
  enumOptionLabel,
  unavailableFieldLabel,
} from "./condition-field-label";
import {
  EnumMultiValueInput,
  TextSetValueInput,
} from "./condition-set-value-input";
import { ConfigHeading } from "./config-section";
import { ConditionSummary } from "./condition-summary";
import {
  type ConditionFieldDefinition,
  type ConditionModel,
  type ConditionRule,
  compileConditionModel,
  compileConditionRule,
  createDefaultConditionModel,
  createDefaultConditionRule,
  GROUP_LOGIC_OPTIONS,
  isNullCheckConditionRule,
  isStringSetConditionRule,
  isTimestampAbsoluteConditionRule,
  isTimestampRelativeConditionRule,
  parseConditionModel,
  reconcileModelWithFields,
  serializeConditionModel,
  STRING_SET_OPERATOR_OPTIONS,
  TIME_UNIT_OPTIONS,
  type TimeUnit,
} from "@wfgraph/shared/conditions/conditions";
import { appendOutputPathKey } from "@wfgraph/shared/graph/node-references";
import { cn } from "@wfgraph/shared/utils";
import { generateId } from "@wfgraph/shared/utils/id";
import {
  applyOperatorValueToCondition,
  getOperatorOptionsByFieldType,
} from "./condition-builder-row-logic";

/**
 * What the row is written against, rather than where it is stored.
 *
 * Two callers build rules with it and neither keeps them the same way: a
 * Condition node stores a model and the CEL it compiles to on its own config, a
 * Wait Subscription stores the model alone and compiles it at park time, against
 * a payload that has not arrived yet. So the row takes its vocabulary and its
 * value as props and hands back both halves, leaving the storing to the caller.
 */
type ConditionBuilderRowProps = {
  label: string;
  /**
   * Whether the heading pins to the top while the rules below it scroll. Only
   * a row mounted straight into the panel's scrolling column may pin.
   */
  stickyHeader?: boolean | undefined;
  description: string;
  /** The fields rules may be built from, already typed. */
  fields: ConditionSelectableField[];
  /** What to say when there are none. */
  emptyFieldsMessage: string;
  /** Serialized `ConditionModel`, empty when nothing is configured yet. */
  value: string;
  onChange: (next: { model: string; expression: string }) => void;
  /** Excluded from a value field's template autocomplete, being its own node. */
  currentNodeId?: string | undefined;
  /**
   * Offers `is one of` and `is not one of` only on string fields that declare
   * enum values. Entity Eligibility sets it, because it refuses a set
   * comparison on any other string field.
   */
  setOperatorsRequireEnumValues?: boolean | undefined;
  /**
   * Whether a Run draft or Publish was refused for these rules. Until then an
   * unfinished rule says so only once its value has been focused and left.
   */
  revealUnfinished: boolean;
  disabled: boolean;
};

/**
 * One rule's grid. Below a 36rem rule the field and the remove button share
 * the first line, and the operator and the value share the second, which wraps
 * the value onto a line of its own when the operator leaves it too little room
 * to show what it holds. From 36rem the rule is one line, its operands' wrapper
 * gives way to the grid's columns, and the value's column never narrows below
 * its contents.
 */
const CONDITION_RULE_GRID_CLASS =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 @xl/rule:grid-cols-[minmax(0,1fr)_auto_minmax(min-content,1fr)_auto]";

/**
 * The operator and the value of a rule below 36rem. The operator is as wide as
 * its chosen label. The value takes the rest of the line and asks for at least
 * 8rem and the width its controls draw at (`min-w-fit`, capped at a whole
 * line), so a value that cannot have them moves under the operator.
 */
const CONDITION_RULE_OPERANDS_CLASS =
  "col-span-2 flex flex-wrap items-center gap-2 @xl/rule:contents";
const CONDITION_RULE_VALUE_CLASS =
  "flex min-w-fit grow basis-32 items-center gap-2";

function isTimeUnitValue(value: string): value is TimeUnit {
  return TIME_UNIT_OPTIONS.some((option) => option.value === value);
}

function toLocalDateTimeInput(isoDateTime: string): string {
  const parsed = new Date(isoDateTime);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  const local = new Date(
    parsed.getTime() - parsed.getTimezoneOffset() * 60_000
  );
  return local.toISOString().slice(0, 16);
}

function toIsoDateTime(localDateTime: string): string {
  const parsed = new Date(localDateTime);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return parsed.toISOString();
}

function createInitialModel(field: ConditionFieldDefinition): ConditionModel {
  return createDefaultConditionModel(field, {
    groupId: generateId(),
    conditionId: generateId(),
  });
}

function createInitialRule(field: ConditionFieldDefinition): ConditionRule {
  return createDefaultConditionRule(field, generateId());
}

function LogicToggle({
  value,
  onChange,
  disabled,
}: {
  value: "and" | "or";
  onChange: (value: "and" | "or") => void;
  disabled: boolean;
}) {
  return (
    <div className="inline-flex items-center rounded-full border bg-card p-0.5">
      {GROUP_LOGIC_OPTIONS.map((option) => {
        const active = option.value === value;
        return (
          <button
            className={`rounded-full px-3 py-1 font-medium text-xs transition-colors ${
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            disabled={disabled}
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function ConditionValueInput(input: {
  condition: ConditionRule;
  disabled: boolean;
  currentNodeId?: string | undefined;
  field?: ConditionSelectableField | undefined;
  /** The rule's field as the row names it, for the value controls' labels. */
  name: string;
  onConditionChange: (condition: ConditionRule) => void;
}) {
  const { condition, disabled, currentNodeId, field, name, onConditionChange } =
    input;
  const enumValues = field?.enumValues;

  // Null-check operators need no value input
  if (isNullCheckConditionRule(condition)) {
    return null;
  }

  if (condition.fieldType === "timestamp") {
    if (isTimestampRelativeConditionRule(condition)) {
      return (
        <>
          <Input
            aria-label={`${name} amount`}
            className="w-16 shrink-0"
            disabled={disabled}
            min={1}
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              onConditionChange({
                ...condition,
                amount: Number.isNaN(parsed) ? 1 : Math.max(parsed, 1),
              });
            }}
            type="number"
            value={condition.amount}
          />
          <Select
            disabled={disabled}
            items={TIME_UNIT_OPTIONS}
            onValueChange={whenChosen((value) => {
              if (!isTimeUnitValue(value)) {
                return;
              }
              onConditionChange({
                ...condition,
                unit: value,
              });
            })}
            value={condition.unit}
          >
            {/* As wide as the chosen unit, like the operator: squeezed beside
            the amount, "days" drew as an empty box holding its chevron. */}
            <SelectTrigger aria-label={`${name} unit`} className="shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIME_UNIT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      );
    }

    return (
      <Input
        className="min-w-0"
        disabled={disabled}
        onChange={(event) => {
          if (!isTimestampAbsoluteConditionRule(condition)) {
            return;
          }

          onConditionChange({
            ...condition,
            dateTime: toIsoDateTime(event.target.value),
          });
        }}
        type="datetime-local"
        value={
          isTimestampAbsoluteConditionRule(condition)
            ? toLocalDateTimeInput(condition.dateTime)
            : ""
        }
      />
    );
  }

  if (condition.fieldType === "string") {
    if (isStringSetConditionRule(condition)) {
      // Both inputs show every stored value as a chip. The popup of a field
      // with enum values offers those values, and any other string field
      // takes typed values.
      if (!(enumValues && enumValues.length > 0)) {
        return (
          <TextSetValueInput
            disabled={disabled}
            name={field?.label ?? unavailableFieldLabel()}
            onValueChange={(values) =>
              onConditionChange({ ...condition, values })
            }
            values={condition.values}
          />
        );
      }

      return (
        <EnumMultiValueInput
          disabled={disabled}
          field={field}
          name={field?.label ?? unavailableFieldLabel()}
          onValueChange={(values) =>
            onConditionChange({ ...condition, values })
          }
          values={condition.values}
        />
      );
    }

    if (
      enumValues &&
      enumValues.length > 0 &&
      (condition.operator === "equals" || condition.operator === "not_equals")
    ) {
      return (
        <Select
          disabled={disabled}
          items={enumValues.map((value) => ({
            label: enumOptionLabel(field, value),
            value,
          }))}
          onValueChange={whenChosen((value) => {
            onConditionChange({ ...condition, value });
          })}
          // The field declares the whole of what this picker offers. A rule
          // still holding a value the field no longer names selects nothing,
          // which leaves the placeholder standing and the rule invalid until
          // one of the offered values is chosen.
          value={enumValues.includes(condition.value) ? condition.value : null}
        >
          <SelectTrigger className="w-full min-w-0">
            <SelectValue placeholder="Select value" />
          </SelectTrigger>
          <SelectContent>
            {enumValues.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {enumOptionLabel(field, opt)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }

    return (
      <TemplateBadgeInput
        className="w-full min-w-0"
        currentNodeId={currentNodeId}
        disabled={disabled}
        onChange={(value) => {
          onConditionChange({
            ...condition,
            value,
          });
        }}
        placeholder="value"
        value={condition.value}
      />
    );
  }

  if (condition.fieldType === "number") {
    return (
      <Input
        disabled={disabled}
        onChange={(event) => {
          const parsed = Number.parseFloat(event.target.value);
          onConditionChange({
            ...condition,
            value: Number.isNaN(parsed) ? 0 : parsed,
          });
        }}
        placeholder="0"
        type="number"
        value={String(condition.value)}
      />
    );
  }

  return null;
}

export function ConditionBuilderRow({
  label,
  stickyHeader,
  description,
  fields: availableFields,
  emptyFieldsMessage,
  value: storedValue,
  onChange,
  currentNodeId,
  setOperatorsRequireEnumValues = false,
  revealUnfinished,
  disabled,
}: ConditionBuilderRowProps) {
  // The live draft's nodes name the source of any template reference a rule's
  // value holds in the summary.
  const nodes = useAtomValue(nodesAtom);
  const seedField = availableFields[0] ?? null;

  const modelValue = storedValue.trim();
  const modelParseResult = parseConditionModel(modelValue);
  const storedModel = modelParseResult.valid ? modelParseResult.model : null;

  const fieldByPath = new Map(
    availableFields.map((field) => [field.path, field])
  );

  const persistModel = useCallback(
    (model: ConditionModel) => {
      // The model and the CEL it compiles to are one fact, so both go to the
      // caller together. A model that fails to compile is still handed over,
      // with an empty expression beside it: a half-built rule is a state the
      // builder is in, not an edit to refuse.
      const compiled = compileConditionModel(model);
      onChange({
        model: serializeConditionModel(model),
        expression: compiled.valid ? compiled.expression : "",
      });
    },
    [onChange]
  );

  /**
   * Drop the whole condition, which is what deleting the last rule means.
   *
   * The stored model and the compiled expression are one fact, so both are
   * cleared together and the row goes back to offering "Configure condition".
   * Without this a configured row was permanent: the last rule of the last
   * group had nowhere to go.
   */
  const clearModel = useCallback(() => {
    onChange({ model: "", expression: "" });
    toast("Condition cleared", {
      description: "Use Actions > Undo to restore it.",
    });
  }, [onChange]);

  const addConditionModel = useCallback(() => {
    if (!seedField) {
      return;
    }

    persistModel(createInitialModel(seedField));
  }, [persistModel, seedField]);

  // Rules are reconciled against the fields available now, on the way to being
  // rendered, and nothing is written until the user next touches the row --
  // that is the moment the reconciled shape becomes their edit rather than a
  // change they never made.
  const parsedModel = storedModel
    ? reconcileModelWithFields(storedModel, fieldByPath)
    : null;

  // Derived in render rather than remembered from the last write, so a model
  // that arrives already broken says so on the first paint.
  const compiled = parsedModel ? compileConditionModel(parsedModel) : null;

  // Each rule answers for itself beneath its value. A rule the builder has not
  // finished, such as one whose value is still blank, waits the way an empty
  // required field does: it says so once its value has been focused and left,
  // or once a Run draft or Publish was refused for these rules. A rule that is
  // malformed rather than unfinished says so at once.
  const ruleResults = new Map(
    (parsedModel?.groups ?? []).flatMap((group) =>
      group.conditions.map(
        (condition) => [condition.id, compileConditionRule(condition)] as const
      )
    )
  );
  const [leftRuleIds, setLeftRuleIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const ruleIssue = (conditionId: string): string | null => {
    const result = ruleResults.get(conditionId);
    if (!result || result.valid) {
      return null;
    }
    return !result.incomplete ||
      revealUnfinished ||
      leftRuleIds.has(conditionId)
      ? result.error
      : null;
  };
  // What the model says beyond its rules, such as a group with no rule in it.
  const modelIssue =
    compiled?.valid === false &&
    [...ruleResults.values()].every((result) => result.valid)
      ? compiled.error
      : null;

  /**
   * Focus leaving a rule's value marks the rule as left. A value's popup, such
   * as an enum's list, takes focus outside the value's DOM while its control
   * inside the value stays expanded, and Base UI moves that focus a frame
   * later. So the check waits a task, and focus still inside the value or a
   * control of it still expanded is focus that has not left.
   */
  const markLeftOnBlur =
    (conditionId: string) => (event: FocusEvent<HTMLElement>) => {
      const cell = event.currentTarget;
      window.setTimeout(() => {
        if (
          cell.contains(document.activeElement) ||
          cell.querySelector('[aria-expanded="true"]') !== null
        ) {
          return;
        }
        setLeftRuleIds((current) =>
          current.has(conditionId)
            ? current
            : new Set([...current, conditionId])
        );
      }, 0);
    };

  /** A rule given a new field is a new rule to fill in, not yet left. */
  const forgetLeftRule = (conditionId: string) => {
    setLeftRuleIds((current) => {
      if (!current.has(conditionId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(conditionId);
      return next;
    });
  };

  const updateGroup = (
    groupId: string,
    updater: (
      group: ConditionModel["groups"][number]
    ) => ConditionModel["groups"][number]
  ) => {
    if (!parsedModel) {
      return;
    }

    persistModel({
      ...parsedModel,
      groups: parsedModel.groups.map((group) =>
        group.id === groupId ? updater(group) : group
      ),
    });
  };

  const updateCondition = (
    groupId: string,
    conditionId: string,
    updater: (condition: ConditionRule) => ConditionRule
  ) => {
    updateGroup(groupId, (group) => ({
      ...group,
      conditions: group.conditions.map((condition) =>
        condition.id === conditionId ? updater(condition) : condition
      ),
    }));
  };

  const addConditionToGroup = (groupId: string) => {
    if (!(parsedModel && seedField)) {
      return;
    }

    updateGroup(groupId, (group) => ({
      ...group,
      conditions: [...group.conditions, createInitialRule(seedField)],
    }));
  };

  const removeGroup = (groupId: string) => {
    if (!parsedModel) {
      return;
    }

    const kept = parsedModel.groups.filter((group) => group.id !== groupId);
    if (kept.length === 0) {
      clearModel();
      return;
    }

    persistModel({ ...parsedModel, groups: kept });
    toast("Rule set removed", {
      description: "Use Actions > Undo to restore it.",
    });
  };

  /**
   * Remove one rule, and let the removal carry upward when it empties something.
   *
   * A group that loses its last rule goes with it, and a model that loses its
   * last group is cleared. Refusing the removal instead is what left a builder
   * with a rule they could edit but never delete.
   */
  const removeConditionFromGroup = (groupId: string, conditionId: string) => {
    if (!parsedModel) {
      return;
    }

    const group = parsedModel.groups.find((entry) => entry.id === groupId);
    if (!group) {
      return;
    }

    if (group.conditions.length > 1) {
      updateGroup(groupId, (existing) => ({
        ...existing,
        conditions: existing.conditions.filter(
          (condition) => condition.id !== conditionId
        ),
      }));
      toast("Condition removed", {
        description: "Use Actions > Undo to restore it.",
      });
      return;
    }

    removeGroup(groupId);
  };

  const addGroup = () => {
    if (!(parsedModel && seedField)) {
      return;
    }

    persistModel({
      ...parsedModel,
      groups: [
        ...parsedModel.groups,
        {
          id: generateId(),
          logic: "and",
          conditions: [createInitialRule(seedField)],
        },
      ],
    });
  };

  // Rules are edited where they are shown, the way an action step's fields
  // are. A person who may not edit, or a row with no model yet, reads the
  // rules instead: there are no controls to offer, or nothing to edit.
  const live = !disabled && parsedModel !== null;
  const reading = parsedModel ? (
    <ConditionSummary
      fields={availableFields}
      model={parsedModel}
      nodes={nodes}
      setOperatorsRequireEnumValues={setOperatorsRequireEnumValues}
    />
  ) : (
    <div className="space-y-2">
      {availableFields.length > 0 ? (
        <Button
          disabled={disabled}
          onClick={addConditionModel}
          size="sm"
          type="button"
          variant="outline"
        >
          Configure condition
        </Button>
      ) : (
        <p className="text-muted-foreground text-xs">{emptyFieldsMessage}</p>
      )}
      {modelValue && !modelParseResult.valid && (
        <p className="text-destructive text-xs">{modelParseResult.error}</p>
      )}
    </div>
  );

  return (
    <section className="space-y-2">
      <ConfigHeading
        className={cn(stickyHeader && live && "sticky top-0 z-20 bg-card")}
        help={<p>{description}</p>}
        label={label}
      />
      {live ? (
        <div className="space-y-2">
          {parsedModel ? (
            <>
              {parsedModel.groups.map((group, groupIndex) => (
                <div key={group.id}>
                  {/* The joiner sits on the divider between two groups rather than
                  floating over it, which is what lets a group be a gutter rule
                  instead of a card. */}
                  {groupIndex > 0 && (
                    <div className="flex items-center gap-2 py-2">
                      <span className="h-px flex-1 bg-border" />
                      <LogicToggle
                        disabled={disabled}
                        onChange={(value) => {
                          persistModel({
                            ...parsedModel,
                            groupLogic: value,
                          });
                        }}
                        value={parsedModel.groupLogic}
                      />
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="rounded-md bg-muted px-1.5 py-0.5 font-medium text-xs">
                        Rule set {groupIndex + 1}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {group.conditions.length}{" "}
                        {group.conditions.length === 1
                          ? "condition"
                          : "conditions"}
                      </span>
                    </div>
                    <Button
                      aria-label={`Remove rule set ${groupIndex + 1}`}
                      disabled={disabled}
                      onClick={() => removeGroup(group.id)}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>

                  {/* The gutter: a left rule with the rows indented behind it, in
                  place of the bordered card these used to sit in. */}
                  <div className="mt-1 ml-2.5 space-y-2 border-l pl-3">
                    {group.conditions.map((condition, conditionIndex) => {
                      const selectedFieldDef = fieldByPath.get(condition.field);
                      // The picker deals in whole paths; the rule stores the record
                      // and its key apart. This is the one conversion between them,
                      // so a rule reached by typing a key reads back as the row that
                      // names it.
                      const namedPath = condition.recordKey
                        ? appendOutputPathKey(
                            condition.field,
                            condition.recordKey
                          )
                        : condition.field;
                      // A key the graph names has a row of its own; one nobody names
                      // leaves the record itself selected, with the key beside it.
                      const pickedPath = fieldByPath.has(namedPath)
                        ? namedPath
                        : condition.field;
                      const offeredOperators = getOperatorOptionsByFieldType(
                        condition.fieldType,
                        selectedFieldDef?.nullable ||
                          condition.recordKey !== undefined,
                        selectedFieldDef?.enumValues,
                        { setOperatorsRequireEnumValues }
                      );
                      // A stored set operator this context no longer offers stays
                      // in the list, so the picker shows the operator the rule
                      // holds. The summary and the Eligibility check say why it is
                      // refused.
                      const operatorOptions = offeredOperators.some(
                        (option) => option.value === condition.operator
                      )
                        ? offeredOperators
                        : [
                            ...offeredOperators,
                            ...STRING_SET_OPERATOR_OPTIONS.filter(
                              (option) => option.value === condition.operator
                            ),
                          ];
                      // Names the row's delete button. Several rows can sit in one
                      // group, and a list of buttons all called "Remove" says
                      // nothing about which rule each one drops.
                      const conditionName =
                        selectedFieldDef?.label ?? unavailableFieldLabel();
                      const issue = ruleIssue(condition.id);

                      return (
                        <div className="@container/rule" key={condition.id}>
                          {/* The operator is as wide as the chosen operator's
                          whole label, because a clipped operator states
                          another rule: "is greater than or equal" cut to "is
                          greater than". Where the rule has 36rem, one line per
                          rule: the field and the value share what the operator
                          leaves, and the remove button keeps its own slot at
                          the end. In a narrower Inspector the field takes the
                          first line beside the remove button, and the operator
                          and the value share the second, or the value takes a
                          third when it cannot show its contents beside the
                          operator. */}
                          <div
                            className={CONDITION_RULE_GRID_CLASS}
                            data-slot="condition-rule"
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <ConditionFieldCombobox
                                disabled={
                                  disabled || availableFields.length === 0
                                }
                                fields={availableFields}
                                onValueChange={(nextField) => {
                                  if (nextField.path === pickedPath) {
                                    return;
                                  }

                                  // A row for a key the graph names is a shortcut for
                                  // the record plus that key, and it carries the split
                                  // so the rule it writes is the one typing the key
                                  // would have written.
                                  const chosen: ConditionFieldDefinition =
                                    nextField.recordPath
                                      ? {
                                          ...nextField,
                                          path: nextField.recordPath,
                                          openRecord: true,
                                        }
                                      : nextField;

                                  forgetLeftRule(condition.id);
                                  updateCondition(
                                    group.id,
                                    condition.id,
                                    (existing) => {
                                      const seeded = createDefaultConditionRule(
                                        chosen,
                                        existing.id
                                      );
                                      return nextField.recordKey
                                        ? {
                                            ...seeded,
                                            recordKey: nextField.recordKey,
                                          }
                                        : seeded;
                                    }
                                  );
                                }}
                                valuePath={pickedPath}
                              />

                              {condition.recordKey !== undefined && (
                                <Input
                                  aria-label="Key"
                                  className="w-24 shrink-0"
                                  disabled={disabled}
                                  onChange={(event) =>
                                    updateCondition(
                                      group.id,
                                      condition.id,
                                      (existing) => ({
                                        ...existing,
                                        // The key alone: every key of a record carries
                                        // the record's value type, so the operator and
                                        // the value the builder already chose still
                                        // stand. Rebuilding the rule here would throw
                                        // them away on every keystroke.
                                        recordKey: event.target.value,
                                      })
                                    )
                                  }
                                  placeholder="key"
                                  value={condition.recordKey}
                                />
                              )}
                            </div>

                            <div
                              className={CONDITION_RULE_OPERANDS_CLASS}
                              data-slot="condition-rule-operands"
                            >
                              <div
                                className="shrink-0"
                                data-slot="condition-rule-operator"
                              >
                                <Select
                                  disabled={disabled}
                                  items={operatorOptions}
                                  onValueChange={whenChosen((operatorValue) => {
                                    const nextCondition =
                                      applyOperatorValueToCondition(
                                        condition,
                                        operatorValue
                                      );
                                    if (!nextCondition) {
                                      return;
                                    }

                                    updateCondition(
                                      group.id,
                                      condition.id,
                                      () => nextCondition
                                    );
                                  })}
                                  value={condition.operator}
                                >
                                  <SelectTrigger
                                    aria-label={`${conditionName} operator`}
                                    className="w-full"
                                  >
                                    <SelectValue placeholder="Select operator" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {operatorOptions.map((option) => (
                                      <SelectItem
                                        key={option.value}
                                        value={option.value}
                                      >
                                        {option.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>

                              <div
                                className={CONDITION_RULE_VALUE_CLASS}
                                data-slot="condition-rule-value"
                                onBlur={markLeftOnBlur(condition.id)}
                              >
                                <ConditionValueInput
                                  condition={condition}
                                  currentNodeId={currentNodeId}
                                  disabled={disabled}
                                  field={selectedFieldDef}
                                  name={conditionName}
                                  onConditionChange={(nextCondition) => {
                                    updateCondition(
                                      group.id,
                                      condition.id,
                                      () => nextCondition
                                    );
                                  }}
                                />
                              </div>
                            </div>

                            <Button
                              aria-label={`Remove condition on ${conditionName}`}
                              className="col-start-2 row-start-1 @xl/rule:col-start-4"
                              disabled={disabled}
                              onClick={() =>
                                removeConditionFromGroup(group.id, condition.id)
                              }
                              size="icon-sm"
                              type="button"
                              variant="ghost"
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>

                          {issue === null ? null : (
                            <p
                              className="pt-1 text-destructive text-xs"
                              data-slot="condition-rule-issue"
                            >
                              {issue}
                            </p>
                          )}

                          {conditionIndex < group.conditions.length - 1 && (
                            <div className="pt-2">
                              <LogicToggle
                                disabled={disabled}
                                onChange={(value) => {
                                  updateGroup(group.id, (existing) => ({
                                    ...existing,
                                    logic: value,
                                  }));
                                }}
                                value={group.logic}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}

                    <Button
                      disabled={disabled || !seedField}
                      onClick={() => addConditionToGroup(group.id)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <Plus className="size-4" />
                      Add condition
                    </Button>
                  </div>
                </div>
              ))}

              <div className="pt-1">
                <Button
                  disabled={disabled || !seedField}
                  onClick={addGroup}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Plus className="size-4" />
                  Add rule set
                </Button>
              </div>

              {modelIssue === null ? null : (
                <p className="text-destructive text-xs">{modelIssue}</p>
              )}
            </>
          ) : null}
        </div>
      ) : (
        reading
      )}
    </section>
  );
}

import { WarningCallout } from "#src/components/ui/callout";
import {
  conditionFieldForPath,
  type ConditionSelectableField,
} from "#src/lib/upstream-node-fields";
import {
  BOOLEAN_OPERATOR_OPTIONS,
  compileConditionRule,
  type ConditionModel,
  type ConditionRule,
  GROUP_LOGIC_OPTIONS,
  isNullCheckConditionRule,
  isTimestampAbsoluteConditionRule,
  isTimestampRelativeConditionRule,
  NULLCHECK_OPERATOR_OPTIONS,
  NUMBER_OPERATOR_OPTIONS,
  STRING_OPERATOR_OPTIONS,
  TIME_UNIT_OPTIONS,
  TIMESTAMP_OPERATOR_OPTIONS,
} from "@wfgraph/shared/conditions/conditions";
import { displayTemplateText } from "@wfgraph/shared/graph/node-references";
import { unavailableFieldLabel } from "./condition-field-label";

/**
 * A condition model read as sentences rather than filled in as controls.
 *
 * Every word here comes from the same option tables the pickers are built from,
 * so the line a builder reads is the line they chose. A group is a left rule
 * with its rows indented rather than a card, and the joiner between two groups
 * sits on the divider that separates them.
 *
 * A rule that is not finished, points at a field the graph no longer offers, or
 * compares against a value its field no longer names, says so on its own line.
 * This is the only surface some of those reach: a half-built Wait match is
 * saved without complaint on purpose, and a rule opened here and never edited
 * would otherwise read exactly like a finished one.
 */
export function ConditionSummary({
  model,
  fields,
}: {
  model: ConditionModel;
  fields: readonly ConditionSelectableField[];
}) {
  return (
    <div>
      {model.groups.map((group, groupIndex) => (
        <div key={group.id}>
          {groupIndex > 0 ? (
            <Divider label={logicLabel(model.groupLogic)} />
          ) : null}

          <div className="flex items-center gap-2">
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-medium text-xs">
              {groupIndex + 1}
            </span>
            <span className="text-muted-foreground text-xs">
              {group.conditions.length}{" "}
              {group.conditions.length === 1 ? "condition" : "conditions"}
            </span>
          </div>

          <ul className="mt-1 ml-2.5 space-y-1 border-l pl-3">
            {group.conditions.map((condition, conditionIndex) => (
              <RuleLine
                condition={condition}
                field={conditionFieldForPath(fields, condition.field)}
                joiner={conditionIndex > 0 ? logicLabel(group.logic) : null}
                key={condition.id}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * What the line calls the field this rule reads.
 *
 * A rule reaching into an open record stores the record and its key apart, and
 * the line names the whole of it: `data.tags.order_id`, the way the run reads
 * it. An unnamed key leaves the record alone, with the refusal below saying what
 * it still owes.
 */
function ruleFieldLabel(
  condition: ConditionRule,
  field: ConditionSelectableField | undefined
): string {
  const label = field?.label ?? unavailableFieldLabel(condition.field);
  return condition.recordKey ? `${label}.${condition.recordKey}` : label;
}

/** One rule, and whatever stands between it and being a rule that runs. */
function RuleLine({
  condition,
  field,
  joiner,
}: {
  condition: ConditionRule;
  field: ConditionSelectableField | undefined;
  joiner: string | null;
}) {
  const refusal = ruleRefusal(condition, field);

  return (
    <li>
      {joiner ? (
        <p className="text-muted-foreground text-xs">{joiner}</p>
      ) : null}
      <p className="text-sm">
        <span className="font-medium">{ruleFieldLabel(condition, field)}</span>
        <span className="mx-1.5 text-muted-foreground">
          {operatorLabel(condition)}
        </span>
        {valueLabel(condition, field)}
      </p>
      {refusal ? (
        <WarningCallout variant="text">{refusal}</WarningCallout>
      ) : null}
    </li>
  );
}

/**
 * What this rule still owes, or nothing where it is ready to run.
 *
 * The compiler answers first, because it is the same verdict the row shows
 * while editing and the same one a run is held to. The enum case is the one
 * refusal it cannot reach: a value the field no longer names still compiles,
 * still runs, and matches nothing, and the picker in edit mode shows it as an
 * empty box.
 */
function ruleRefusal(
  condition: ConditionRule,
  field: ConditionSelectableField | undefined
): string | null {
  const compiled = compileConditionRule(condition);
  if (!compiled.valid) {
    return compiled.error;
  }

  const offered = field?.enumValues;
  if (
    offered &&
    offered.length > 0 &&
    !isNullCheckConditionRule(condition) &&
    condition.fieldType === "string" &&
    (condition.operator === "equals" || condition.operator === "not_equals") &&
    !offered.includes(condition.value)
  ) {
    return `${field.label} no longer offers this value. Choose one it does.`;
  }

  return null;
}

/** The rule between two groups, on the line that separates them. */
function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-2">
      <span className="h-px flex-1 bg-border" />
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function logicLabel(logic: ConditionModel["groupLogic"]): string {
  return (
    GROUP_LOGIC_OPTIONS.find((option) => option.value === logic)?.label ?? logic
  );
}

/**
 * The operator as the picker words it.
 *
 * The null-check pair is looked up first because it is the one operator set
 * every field type shares, so an `is_set` rule has no field type of its own to
 * be found under.
 */
function operatorLabel(rule: ConditionRule): string {
  const table = isNullCheckConditionRule(rule)
    ? NULLCHECK_OPERATOR_OPTIONS
    : operatorTable(rule.fieldType);

  const match = table.find((option) => option.value === rule.operator);
  return match?.label ?? rule.operator;
}

function operatorTable(
  fieldType: ConditionRule["fieldType"]
): ReadonlyArray<{ value: string; label: string }> {
  if (fieldType === "timestamp") {
    return TIMESTAMP_OPERATOR_OPTIONS;
  }
  if (fieldType === "string") {
    return STRING_OPERATOR_OPTIONS;
  }
  if (fieldType === "number") {
    return NUMBER_OPERATOR_OPTIONS;
  }
  return BOOLEAN_OPERATOR_OPTIONS;
}

/**
 * What the rule compares against, or nothing where the operator carries the
 * whole comparison, as `is true` and `is set` do.
 *
 * A value the builder has not filled in renders as nothing, and the line under
 * it is what names the gap.
 */
function valueLabel(
  rule: ConditionRule,
  field: ConditionSelectableField | undefined
): string {
  if (isNullCheckConditionRule(rule)) {
    return "";
  }

  if (rule.fieldType === "timestamp") {
    if (isTimestampRelativeConditionRule(rule)) {
      const unit =
        TIME_UNIT_OPTIONS.find((option) => option.value === rule.unit)?.label ??
        rule.unit;
      return `${rule.amount} ${unit}`;
    }

    if (isTimestampAbsoluteConditionRule(rule)) {
      const parsed = new Date(rule.dateTime);
      return Number.isNaN(parsed.getTime())
        ? rule.dateTime
        : parsed.toLocaleString();
    }

    return "";
  }

  if (rule.fieldType === "string") {
    return displayTemplateText(field?.enumLabels?.[rule.value] ?? rule.value);
  }

  if (rule.fieldType === "number") {
    return String(rule.value);
  }

  return "";
}

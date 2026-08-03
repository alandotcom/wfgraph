import type {
  BooleanOperator,
  GroupLogic,
  NullCheckOperator,
  NumberOperator,
  StringOperator,
  TimeUnit,
  TimestampOperator,
} from "#src/conditions/condition-model";

export const GROUP_LOGIC_OPTIONS: Array<{
  value: GroupLogic;
  label: string;
}> = [
  { value: "and", label: "AND" },
  { value: "or", label: "OR" },
];

export const TIMESTAMP_OPERATOR_OPTIONS: Array<{
  value: TimestampOperator;
  label: string;
}> = [
  { value: "within_next", label: "is within the next" },
  { value: "more_than_from_now", label: "is more than from now" },
  { value: "less_than_ago", label: "is less than ago" },
  { value: "more_than_ago", label: "is more than ago" },
  { value: "before", label: "is before" },
  { value: "after", label: "is after" },
];

export const TIME_UNIT_OPTIONS: Array<{ value: TimeUnit; label: string }> = [
  { value: "minutes", label: "minutes" },
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
  { value: "weeks", label: "weeks" },
];

export const STRING_OPERATOR_OPTIONS: Array<{
  value: StringOperator;
  label: string;
}> = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "contains", label: "contains" },
];

export const NUMBER_OPERATOR_OPTIONS: Array<{
  value: NumberOperator;
  label: string;
}> = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "greater_than", label: "is greater than" },
  { value: "greater_or_equal", label: "is greater than or equal" },
  { value: "less_than", label: "is less than" },
  { value: "less_or_equal", label: "is less than or equal" },
];

export const BOOLEAN_OPERATOR_OPTIONS: Array<{
  value: BooleanOperator;
  label: string;
}> = [
  { value: "is_true", label: "is true" },
  { value: "is_false", label: "is false" },
];

export const NULLCHECK_OPERATOR_OPTIONS: Array<{
  value: NullCheckOperator;
  label: string;
}> = [
  { value: "is_set", label: "is set" },
  { value: "is_not_set", label: "is not set" },
];

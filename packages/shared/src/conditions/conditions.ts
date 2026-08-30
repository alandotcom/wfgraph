/**
 * Public barrel for the conditions package surface.
 *
 * Prefer a specific submodule (`condition-model`, `condition-schema`, …) when
 * the caller already knows which layer it needs; this file keeps the historical
 * `@wfgraph/shared/conditions/conditions` import path stable.
 */

export {
  CONDITION_CONTEXT_ROOT,
  EVENT_CONTEXT_ROOT,
  EVENT_NAME_FIELD_PATH,
  type ConditionFieldDefinition,
  type ConditionFieldType,
  type ConditionModel,
  type ConditionRule,
  type TimeUnit,
  type TimestampAbsoluteOperator,
  type TimestampRelativeOperator,
  collectTimestampFieldPaths,
  createDefaultConditionModel,
  createDefaultConditionRule,
  isNullCheckConditionRule,
  isTimestampAbsoluteConditionRule,
  isTimestampRelativeConditionRule,
  reconcileModelWithFields,
} from "#src/conditions/condition-model";
export {
  BOOLEAN_OPERATOR_OPTIONS,
  GROUP_LOGIC_OPTIONS,
  NULLCHECK_OPERATOR_OPTIONS,
  NUMBER_OPERATOR_OPTIONS,
  STRING_OPERATOR_OPTIONS,
  TIME_UNIT_OPTIONS,
  TIMESTAMP_OPERATOR_OPTIONS,
} from "#src/conditions/condition-options";
export {
  parseConditionModel,
  serializeConditionModel,
} from "#src/conditions/condition-schema";
export {
  compileConditionModel,
  compileConditionRule,
  compileSerializedConditionModel,
} from "#src/conditions/condition-compile";

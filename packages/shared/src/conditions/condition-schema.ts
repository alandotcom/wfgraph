import { Result, Schema, SchemaIssue, SchemaTransformation } from "effect";
import type {
  ConditionFieldType,
  ConditionModel,
  ConditionModelParseResult,
} from "#src/conditions/condition-model";
import { findTemplateTokens } from "#src/graph/node-references";
import { decodeIsoTimestamp } from "#src/types/timestamp";

/**
 * The stored form of a condition model.
 *
 * A Condition node keeps its structured model as a JSON string in node config,
 * so the model arrives here as outside input and is parsed before anything
 * reads it. Rules are described in two layers: `fieldType` says what kind of
 * value the field holds, and `operator` then says which operands the rule
 * carries. Every layer carries its own message, so a model that will not load
 * names the thing that is actually wrong with it.
 *
 * Unknown keys are dropped, so a rule that kept an operand from an operator the
 * user has since changed away from still loads, without that operand.
 *
 * Two rules govern where a message is attached, and both follow from Effect
 * reading the annotation off whichever node produced the issue:
 *
 * - Annotate the base type first. `.annotate()` applied to a schema that
 *   already carries a check lands on the check, and a wrong-typed value never
 *   reaches a check, so the message would go unread for exactly the input that
 *   needs it most: `Schema.Finite.annotate({ message })` answers `"5"` with
 *   Effect's own "Expected number" instead.
 * - Annotate each check separately. A check reports its own issue and reads its
 *   own annotation, so a message on a sibling check does not cover it.
 */
function requiredTextSchema(message: string) {
  return Schema.String.annotate({ message })
    .pipe(Schema.decodeTo(Schema.String, SchemaTransformation.trim()))
    .check(Schema.isMinLength(1).annotate({ message }))
    .annotateKey({ messageMissingKey: message });
}

/**
 * One message for a field, wherever the field goes wrong.
 *
 * A value of the wrong type and an absent key are different issues to Effect,
 * each reading a different annotation, and the pair has to be written together
 * or a rule that is simply missing its operator answers "Missing key". Apply
 * this to the base type: whatever is checked is checked afterwards, so that the
 * message stays on the type rather than moving onto the check.
 */
function withMessage<S extends Schema.Top>(schema: S, message: string) {
  return schema
    .annotate({ message })
    .annotateKey({ messageMissingKey: message });
}

/** The parts every rule carries, whatever kind of field it points at. */
function conditionRuleShape<TFieldType extends ConditionFieldType>(
  fieldType: TFieldType
) {
  return {
    id: requiredTextSchema("Condition id is required"),
    field: requiredTextSchema("Condition field is required"),
    fieldType: Schema.Literal(fieldType),
    // Blank on purpose where a rule reaches into an open record and nobody has
    // named the key yet, so this is the one key here that a blank string is a
    // meaningful value for. The compiler is what refuses it.
    recordKey: Schema.optionalKey(Schema.String),
  };
}

/**
 * Null checks read a field's presence, so they take no operand of their own.
 *
 * The message belongs to the field type rather than to the operator pair,
 * because this is one of the arms a rule of that type can take: a timestamp
 * rule that names an operator no timestamp arm accepts has an invalid timestamp
 * operator, whichever arm noticed.
 */
function nullCheckRuleSchema<TFieldType extends ConditionFieldType>(
  fieldType: TFieldType,
  message: string
) {
  return Schema.Struct({
    ...conditionRuleShape(fieldType),
    operator: withMessage(Schema.Literals(["is_set", "is_not_set"]), message),
  });
}

const TIMESTAMP_OPERATOR_ERROR = "Timestamp operator is invalid";
const TIMESTAMP_AMOUNT_ERROR = "Timestamp amount must be a positive integer";
const DATE_TIME_ERROR =
  "Timestamp absolute operators require a valid date-time";
const STRING_OPERATOR_ERROR = "String operator is invalid";
const NUMBER_OPERATOR_ERROR = "Number operator is invalid";
const NUMBER_VALUE_ERROR = "Number conditions require a finite numeric value";
const BOOLEAN_OPERATOR_ERROR = "Boolean operator is invalid";

/**
 * A `before`/`after` rule stores either an ISO 8601 timestamp with an explicit
 * zone or one exact template token. Wait matches resolve the token before they
 * compile the comparison. A literal wall-clock time with no zone would compare
 * against payloads from any zone and mean something different each time.
 */
function isIsoTimestampOrExactTemplate(value: string): boolean {
  if (decodeIsoTimestamp(value) !== null) {
    return true;
  }

  const tokens = findTemplateTokens(value);
  return tokens.length === 1 && tokens[0]?.raw === value;
}

/**
 * Every rule shape the model admits, in one union.
 *
 * Zod described this as a union per field type, each holding a union per
 * operator. Effect picks the union members it will try by looking for a field
 * whose schema is a single literal, and takes the union of what every such
 * field selects rather than the intersection. A nested union carries no literal
 * of its own, so an outer union of unions would try every arm for every input
 * and never reach its own message. Flattened, `fieldType` selects the arms of
 * one field type and nothing else, which is the dispatch this model wants.
 *
 * The arms that carry an operand come before the null-check arm of the same
 * field type, so a rule that is missing an operand reports the missing operand
 * ahead of the null-check arm's complaint about the operator.
 */
const conditionRuleVariants = [
  Schema.Struct({
    ...conditionRuleShape("timestamp"),
    operator: withMessage(
      Schema.Literals([
        "within_next",
        "more_than_from_now",
        "less_than_ago",
        "more_than_ago",
      ]),
      TIMESTAMP_OPERATOR_ERROR
    ),
    // The checks rule out NaN and the infinities along with the fractions and
    // the non-positive counts; a count of time units has to be a real positive
    // whole number to be compiled into a CEL duration.
    // The message sits on `Schema.Number`, not on `isFinite`: a check that carries
    // the message instead would never see a wrong-typed value, which fails the
    // base type and reaches Effect's own text.
    amount: withMessage(Schema.Number, TIMESTAMP_AMOUNT_ERROR).check(
      Schema.isFinite().annotate({ message: TIMESTAMP_AMOUNT_ERROR }),
      Schema.isInt().annotate({ message: TIMESTAMP_AMOUNT_ERROR }),
      Schema.isGreaterThan(0).annotate({ message: TIMESTAMP_AMOUNT_ERROR })
    ),
    unit: withMessage(
      Schema.Literals(["minutes", "hours", "days", "weeks"]),
      "Timestamp unit is invalid"
    ),
  }),
  Schema.Struct({
    ...conditionRuleShape("timestamp"),
    operator: withMessage(
      Schema.Literals(["before", "after"]),
      TIMESTAMP_OPERATOR_ERROR
    ),
    dateTime: Schema.String.annotate({ message: DATE_TIME_ERROR })
      .pipe(Schema.decodeTo(Schema.String, SchemaTransformation.trim()))
      .check(
        Schema.makeFilter((value: string) =>
          isIsoTimestampOrExactTemplate(value) ? undefined : DATE_TIME_ERROR
        )
      )
      .annotateKey({ messageMissingKey: DATE_TIME_ERROR }),
  }),
  nullCheckRuleSchema("timestamp", TIMESTAMP_OPERATOR_ERROR),
  Schema.Struct({
    ...conditionRuleShape("string"),
    operator: withMessage(
      Schema.Literals(["equals", "not_equals", "contains"]),
      STRING_OPERATOR_ERROR
    ),
    value: withMessage(Schema.String, "String conditions require a text value"),
  }),
  nullCheckRuleSchema("string", STRING_OPERATOR_ERROR),
  Schema.Struct({
    ...conditionRuleShape("number"),
    operator: withMessage(
      Schema.Literals([
        "equals",
        "not_equals",
        "greater_than",
        "greater_or_equal",
        "less_than",
        "less_or_equal",
      ]),
      NUMBER_OPERATOR_ERROR
    ),
    // The check rules out NaN and the infinities, leaving the finite numbers a
    // comparison can be compiled against.
    // The message sits on `Schema.Number`, not on `isFinite`: a check that carries
    // the message instead would never see a wrong-typed value, which fails the
    // base type and reaches Effect's own text.
    value: withMessage(Schema.Number, NUMBER_VALUE_ERROR).check(
      Schema.isFinite().annotate({ message: NUMBER_VALUE_ERROR })
    ),
  }),
  nullCheckRuleSchema("number", NUMBER_OPERATOR_ERROR),
  Schema.Struct({
    ...conditionRuleShape("boolean"),
    operator: withMessage(
      Schema.Literals(["is_true", "is_false"]),
      BOOLEAN_OPERATOR_ERROR
    ),
  }),
  nullCheckRuleSchema("boolean", BOOLEAN_OPERATOR_ERROR),
] as const;

/**
 * A rule has to be an object before its field type can be read, and the gate in
 * front of the union is what lets a rule that is a string or an array say so.
 */
const conditionRuleSchema = Schema.Record(Schema.String, Schema.Unknown)
  .annotate({ message: "Condition must be an object" })
  .pipe(
    Schema.decodeTo(
      Schema.Union(conditionRuleVariants).annotate({
        message: "Condition field type is invalid",
      })
    )
  );

const GROUP_CONDITIONS_ERROR = "Each group must contain at least one condition";

const conditionGroupSchema = Schema.Struct({
  id: requiredTextSchema("Group id is required"),
  logic: withMessage(Schema.Literals(["and", "or"]), "Group logic is invalid"),
  conditions: withMessage(
    Schema.mutable(Schema.Array(conditionRuleSchema)),
    GROUP_CONDITIONS_ERROR
  ).check(Schema.isMinLength(1).annotate({ message: GROUP_CONDITIONS_ERROR })),
}).annotate({ message: "Group must be an object" });

const MODEL_GROUPS_ERROR = "Condition model must contain at least one group";

const conditionModelSchema = Schema.Struct({
  version: withMessage(Schema.Literal(2), "Condition model version must be 2"),
  groupLogic: withMessage(
    Schema.Literals(["and", "or"]),
    "Condition model group logic is invalid"
  ),
  groups: withMessage(
    Schema.mutable(Schema.Array(conditionGroupSchema)),
    MODEL_GROUPS_ERROR
  ).check(Schema.isMinLength(1).annotate({ message: MODEL_GROUPS_ERROR })),
}).annotate({ message: "Condition model must be an object" });

const decodeConditionModel = Schema.decodeUnknownResult(conditionModelSchema);
const formatConditionIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * The one issue worth showing out of everything a failed decode reported.
 *
 * Effect tries every union arm whose `fieldType` matches and reports what each
 * of them made of the rule, so a rule that names an operator only one arm
 * accepts still draws a complaint from every sibling arm about that operator.
 * The arm that recognised the operator is the one Zod's discriminated union
 * would have picked, and it is the only arm that did not complain about
 * `operator` -- so an operator issue is worth reporting only when it is all
 * there is, which is when the operator really is one no arm accepts.
 */
type FormattedIssue = ReturnType<
  typeof formatConditionIssues
>["issues"][number];

/**
 * The key an issue points at. Standard Schema allows a path segment to be
 * either the key itself or an object wrapping it; Effect only ever writes the
 * first form, and this reads both so the narrowing costs nothing.
 */
function issueLeafKey(issue: FormattedIssue): PropertyKey | undefined {
  const segment = issue.path?.at(-1);
  if (segment === null || segment === undefined) {
    return undefined;
  }

  return typeof segment === "object" ? segment.key : segment;
}

function selectReportedIssue(
  issues: readonly FormattedIssue[]
): string | undefined {
  const specific = issues.find((issue) => issueLeafKey(issue) !== "operator");

  return (specific ?? issues[0])?.message;
}

export function parseConditionModel(input: unknown): ConditionModelParseResult {
  let parsed: unknown = input;

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) {
      return { valid: false, error: "Condition model is empty" };
    }

    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { valid: false, error: "Condition model must be valid JSON" };
    }
  }

  const model = decodeConditionModel(parsed);
  if (Result.isFailure(model)) {
    const { issues } = formatConditionIssues(model.failure.issue);
    return {
      valid: false,
      error: selectReportedIssue(issues) ?? "Condition model is invalid",
    };
  }

  return { valid: true, model: model.success };
}

export function serializeConditionModel(model: ConditionModel): string {
  return JSON.stringify(model);
}

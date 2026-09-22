import { Schema } from "effect";
import { hasOnlySafeRecordKeys, isSafeRecordKey } from "#src/types/record-key";
import { NonEmptyTrimmedString } from "#src/types/schema";
import { MAX_CONFIG_OPTIONS_PARAMETERS } from "#src/plugins/action-fields";

/** A provider name that is safe to use as a lookup key. */
export const configOptionsProviderNameSchema = () =>
  NonEmptyTrimmedString.check(
    Schema.makeFilter(isSafeRecordKey, {
      expected:
        "a non-empty record key that is not reserved by JavaScript objects",
    })
  );

/**
 * The sibling config values named by a field's `optionsSource`.
 *
 * The server intersects this record with the field declarations for the action
 * being asked. The bounds here keep an oversized body from being decoded.
 */
export const configOptionsParametersSchema = () =>
  Schema.Record(
    Schema.String,
    Schema.String.check(Schema.isMaxLength(2048))
  ).check(
    Schema.makeFilter(hasOnlySafeRecordKeys, {
      expected: "provider parameter keys not reserved by JavaScript objects",
    }),
    Schema.makeFilter(
      (values) => Object.keys(values).length <= MAX_CONFIG_OPTIONS_PARAMETERS,
      {
        expected: `at most ${MAX_CONFIG_OPTIONS_PARAMETERS} provider parameters`,
      }
    )
  );

/**
 * What either application code or an integration provider returns for one
 * provider-backed field.
 */
export const configOptionsAnswerSchema = () =>
  Schema.Union([
    Schema.Struct({
      status: Schema.Literal("options"),
      options: Schema.Array(
        Schema.Struct({
          value: NonEmptyTrimmedString,
          label: Schema.String,
        })
      ),
    }),
    Schema.Struct({
      status: Schema.Literal("fields"),
      fields: Schema.Array(
        Schema.Struct({
          key: configOptionsProviderNameSchema(),
          label: Schema.String,
          defaultValue: Schema.optionalKey(Schema.String),
          description: Schema.optionalKey(Schema.String),
          type: Schema.optionalKey(Schema.Literals(["string", "number"])),
          required: Schema.optionalKey(Schema.Boolean),
        })
      ),
    }),
    Schema.Struct({
      status: Schema.Literal("unavailable"),
      reason: Schema.Literals(["not_permitted", "unreachable", "refused"]),
      message: Schema.String,
    }),
  ]);

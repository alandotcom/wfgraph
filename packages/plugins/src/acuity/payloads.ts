/**
 * The wire shapes Acuity's API answers with.
 *
 * Modelled on what the API sends rather than on the SDK's types: the SDK casts the
 * response without validating it, so these describe a system's JSON directly. This
 * layer is owned by no single action -- every action whose output nests an
 * appointment, an appointment type, or an availability slot reads from here.
 */

import { Schema } from "effect";

/**
 * A field the SDK types as `unknown`, kept rather than trimmed.
 *
 * The encode that puts a step's answer on the wire keeps only what the schema
 * admits, so a field left undeclared would not reach the run log at all. There is
 * nothing to say about this one's shape, which is what `Unknown` says; encoding it
 * still refuses a value that is not JSON, so a memoized step result stays safe.
 * The picker has no path to offer for it and drops it, which is correct: nothing
 * downstream can address a shape nobody described.
 */
const opaqueJson = Schema.optional(Schema.Unknown);

/**
 * A whole number the editor offers, described so the picker can show it.
 *
 * A bare `Schema.Number` describes itself as a number or one of the strings
 * "Infinity", "-Infinity" and "NaN", which the field reader cannot use, so a
 * numeric field written without the check drops out of the derived list.
 */
export function describedNumber(description: string) {
  return Schema.Number.annotate({ description }).check(Schema.isFinite());
}

/**
 * A field of a system's payload, as an output schema may describe it.
 *
 * `optionalKey(NullOr(...))` is the one spelling that survives everything a system
 * sends: an absent key, an explicit `null`, or the value. `optional(X)` refuses the
 * null and `NullishOr(X)` refuses the absent key, and either refusal fails the
 * encode and so the whole step. The picker reads the same `nullable` off this as it
 * did off the stricter spellings, so nothing is lost by tolerating both.
 */
function externalField<S extends Schema.Codec<unknown>>(field: S) {
  return Schema.optionalKey(Schema.NullOr(field));
}

/** The same tolerance for a whole number the picker offers. */
function externalNumber(description: string) {
  return externalField(describedNumber(description));
}

/** The same tolerance for a string the picker offers. */
function externalText(description: string) {
  return externalField(Schema.String.annotate({ description }));
}

/**
 * One answer a client gave on an intake form.
 *
 * Modelled on what the API sends rather than on the SDK's type: the SDK casts the
 * response without validating it, and it is missing a level. `value` is text, a
 * list of text, or nothing, which is one union too many for the picker to name a
 * path for; it is declared anyway, because the encode keeps only what the schema
 * admits and an answer nobody can address by path is still an answer somebody reads
 * in the run log.
 */
const formAnswerSchema = Schema.Struct({
  id: externalNumber("Answer ID"),
  fieldID: externalNumber("Form field ID"),
  name: externalText("Question the client answered"),
  value: Schema.optionalKey(
    Schema.NullOr(
      Schema.Union([Schema.String, Schema.mutable(Schema.Array(Schema.String))])
    )
  ),
});

/**
 * One intake form on an appointment, holding the answers given on it.
 *
 * The nesting is what the wire has and the SDK's type does not: `forms` is a list
 * of forms, each carrying its own `values` list of answers. A schema describing
 * those answers one level up fails its encode, and so fails the step, on every
 * appointment that has an intake form.
 */
const appointmentFormSchema = Schema.Struct({
  id: externalNumber("Form ID"),
  name: externalText("Form name"),
  values: Schema.optionalKey(
    Schema.NullOr(
      Schema.mutable(Schema.Array(formAnswerSchema)).annotate({
        description: "Answers given on this form",
      })
    )
  ),
});

/**
 * Acuity's appointment, as the API sends it.
 *
 * Two fields are required, because the actions read them to answer with and a
 * payload without them is not an appointment: everything else is an `externalField`.
 * That is deliberate rather than lazy. This describes somebody else's JSON, the SDK
 * validates none of it, and a field this schema insists on that a real payload
 * omits fails the encode and so fails the step.
 */
export const appointmentSchema = Schema.Struct({
  id: describedNumber("Appointment ID"),
  datetime: Schema.String.annotate({
    description: "Appointment start, ISO 8601 with offset",
  }),
  firstName: externalText("Client first name"),
  lastName: externalText("Client last name"),
  email: externalText("Client email address"),
  phone: externalText("Client phone number"),
  date: externalText("Appointment date, as Acuity writes it for people"),
  endDate: externalText("Appointment end date, as Acuity writes it for people"),
  time: externalText("Appointment start time"),
  endTime: externalText("Appointment end time"),
  duration: externalText("Duration in minutes"),
  timezone: externalText("The appointment's IANA timezone"),
  // Acuity sends this on every appointment and documents it nowhere. It matches
  // `timezone` unless the request asked for a different one.
  calendarTimezone: externalText("IANA timezone of the calendar that owns it"),
  type: externalText("Appointment type name"),
  appointmentTypeID: externalNumber("Appointment type ID"),
  calendar: externalText("Calendar name"),
  calendarID: externalNumber("Calendar ID"),
  // A string on some payloads and a number on others, the way the type's own price
  // is. The picker has no single type for a union and drops it; declaring it is what
  // keeps it through the encode and into the run log.
  price: Schema.optionalKey(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Finite]))
  ),
  paid: externalText("Whether the appointment is paid"),
  notes: externalText("Appointment notes"),
  forms: Schema.optionalKey(
    Schema.NullOr(
      Schema.mutable(Schema.Array(appointmentFormSchema)).annotate({
        description: "Intake forms on the appointment",
      })
    )
  ),
  noShow: externalField(
    Schema.Boolean.annotate({ description: "Marked as a no-show" })
  ),
  canceled: externalField(
    Schema.Boolean.annotate({
      description: "Whether the appointment is canceled",
    })
  ),
  certificate: opaqueJson,
  package: opaqueJson,
  scheduledBy: externalText(
    "Who scheduled it, or null for a client not logged in"
  ),
});

/**
 * Acuity's appointment type, as the API sends it.
 *
 * Same rule as the appointment above: `id` is what identifies one, and everything
 * else tolerates an absent key and an explicit null, because this describes a
 * system's JSON. `price` arrives as a string on some types and a number on others,
 * which the picker has no single type for and drops; it is declared so that the
 * encode keeps it.
 */
export const appointmentTypeSchema = Schema.Struct({
  id: describedNumber("Appointment type ID"),
  name: externalText("Appointment type name"),
  active: externalField(
    Schema.Boolean.annotate({ description: "Whether the type is bookable" })
  ),
  description: externalText("Appointment type description"),
  duration: externalNumber("Duration in minutes"),
  category: externalText("Category name"),
  color: externalText("Calendar colour"),
  private: externalField(
    Schema.Boolean.annotate({
      description: "Whether the type is hidden from the public scheduler",
    })
  ),
  // The three kinds Acuity documents, written out rather than as a bare string: the
  // condition builder offers them as choices. A kind this list does not have still
  // encodes, because the field tolerates anything the union admits or a null.
  type: externalField(
    Schema.Literals(["service", "class", "series"]).annotate({
      description: "Kind of type: service, class, or series",
    })
  ),
  classSize: externalNumber("Seats in a class, if it is one"),
  paddingAfter: externalNumber("Minutes of padding after the appointment"),
  paddingBefore: externalNumber("Minutes of padding before the appointment"),
  calendarIDs: Schema.optionalKey(
    Schema.NullOr(
      Schema.mutable(Schema.Array(Schema.Finite)).annotate({
        description: "Calendars offering this type",
      })
    )
  ),
  price: Schema.optionalKey(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Finite]))
  ),
});

export const availabilityDateSchema = Schema.Struct({
  date: Schema.String.annotate({ description: "Available date, YYYY-MM-DD" }),
});

export const availabilityTimeSlotSchema = Schema.Struct({
  time: Schema.String.annotate({
    description: "Bookable slot, ISO 8601 with offset",
  }),
});

/**
 * What the Acuity actions take and what they give back.
 *
 * These sit beside the plugin's metadata rather than beside its steps because
 * both ends need them and only one end is server code: the action metadata in
 * `index.ts` is what the editor loads into the browser, and it derives the
 * template-autocomplete fields from the output schemas here, while the steps in
 * `steps/` are typed against the same constants.
 *
 * Nothing here imports `@fountain-bio/acuity`. The output schemas describe the
 * SDK's resources rather than borrowing their types, because this module is
 * loaded into the browser and the schemas are what the editor reads; a step
 * hands the SDK's own object back and the compiler checks it against the
 * description.
 */

import { Schema } from "effect";

/** Every config field arrives as text, so this is what most of them look like. */
const optionalText = Schema.optional(Schema.String);

/**
 * A number a config field carries.
 *
 * A `number` config field may be stored as a number and a template resolves to
 * text, so both arrive and the step parses whichever it got.
 */
const optionalNumeric = Schema.optional(
  Schema.Union([Schema.String, Schema.Finite])
);

/**
 * A whole number the editor offers, described so the picker can show it.
 *
 * A bare `Schema.Number` describes itself as a number or one of the strings
 * "Infinity", "-Infinity" and "NaN", which the field reader cannot use, so a
 * numeric field written without the check drops out of the derived list.
 */
function describedNumber(description: string) {
  return Schema.Number.annotate({ description }).check(Schema.isFinite());
}

/**
 * Acuity's Appointment resource, as much of it as a downstream node is offered.
 *
 * The step hands back the SDK's object whole, so what this leaves out still
 * reaches the run log; what it names is what the template picker lists. The
 * certificate and the package are left out because each is `unknown`. Form
 * answers omit only `value`, which Acuity types as `string | string[] | null`
 * and the field reader cannot name; the rest of each answer is offered.
 */
const appointmentFormAnswerSchema = Schema.Struct({
  id: describedNumber("Form answer ID"),
  fieldID: describedNumber("Form field ID"),
  name: Schema.String.annotate({ description: "Form field name" }),
  isMultiple: Schema.Boolean.annotate({
    description: "Whether the field accepts multiple values",
  }),
  sortOrder: describedNumber("Display order of the field"),
});

const appointmentSchema = Schema.Struct({
  id: describedNumber("Appointment ID"),
  firstName: Schema.String.annotate({ description: "Client first name" }),
  lastName: Schema.String.annotate({ description: "Client last name" }),
  email: Schema.String.annotate({ description: "Client email address" }),
  phone: Schema.optional(
    Schema.String.annotate({ description: "Client phone number" })
  ),
  date: Schema.String.annotate({
    description: "Appointment date, as Acuity writes it for people",
  }),
  endDate: Schema.optional(
    Schema.String.annotate({
      description: "Appointment end date, as Acuity writes it for people",
    })
  ),
  time: Schema.String.annotate({ description: "Appointment start time" }),
  endTime: Schema.optional(
    Schema.String.annotate({ description: "Appointment end time" })
  ),
  duration: Schema.String.annotate({ description: "Duration in minutes" }),
  datetime: Schema.String.annotate({
    description: "Appointment start, ISO 8601 with offset",
  }),
  type: Schema.String.annotate({ description: "Appointment type name" }),
  appointmentTypeID: describedNumber("Appointment type ID"),
  calendar: Schema.String.annotate({ description: "Calendar name" }),
  calendarID: describedNumber("Calendar ID"),
  calendarTimeZone: Schema.String.annotate({
    description: "Calendar's IANA timezone",
  }),
  price: Schema.optional(
    Schema.String.annotate({ description: "Appointment price" })
  ),
  paid: Schema.optional(
    Schema.String.annotate({ description: "Whether the appointment is paid" })
  ),
  notes: Schema.optional(
    Schema.String.annotate({ description: "Appointment notes" })
  ),
  forms: Schema.mutable(Schema.Array(appointmentFormAnswerSchema)).annotate({
    description: "Form answers on the appointment",
  }),
  noShow: Schema.optional(
    Schema.Boolean.annotate({ description: "Marked as a no-show" })
  ),
  canceled: Schema.optional(
    Schema.Boolean.annotate({
      description: "Whether the appointment is canceled",
    })
  ),
});

/**
 * Acuity's AppointmentType resource, as much of it as a downstream node is
 * offered. `price` is left out because Acuity sends it as a string on some
 * types and a number on others, and a union of the two has no path the picker
 * can offer.
 */
const appointmentTypeSchema = Schema.Struct({
  id: describedNumber("Appointment type ID"),
  name: Schema.String.annotate({ description: "Appointment type name" }),
  active: Schema.Boolean.annotate({
    description: "Whether the type is bookable",
  }),
  // `NullishOr`, not `optional` wrapped around `NullOr`. Acuity may send a
  // string, `null`, or nothing at all, and only this spelling flattens to one
  // union the field reader can use: nesting a nullable inside an optional puts
  // an `anyOf` inside an `anyOf`, which the reader drops, taking the field out
  // of the picker with no complaint from the derivation.
  description: Schema.NullishOr(
    Schema.String.annotate({ description: "Appointment type description" })
  ),
  duration: describedNumber("Duration in minutes"),
  category: Schema.NullishOr(
    Schema.String.annotate({ description: "Category name" })
  ),
  color: Schema.NullishOr(
    Schema.String.annotate({ description: "Calendar colour" })
  ),
  private: Schema.Boolean.annotate({
    description: "Whether the type is hidden from the public scheduler",
  }),
  // The three kinds Acuity has, written out rather than as a bare string: the
  // condition builder offers them as choices, and the SDK types the field this
  // way too, so the compiler checks the step's answer against the same list.
  type: Schema.Literals(["service", "class", "series"]).annotate({
    description: "Kind of type: service, class, or series",
  }),
  classSize: Schema.NullOr(describedNumber("Seats in a class, if it is one")),
  paddingAfter: Schema.optional(
    describedNumber("Minutes of padding after the appointment")
  ),
  paddingBefore: Schema.optional(
    describedNumber("Minutes of padding before the appointment")
  ),
  calendarIDs: Schema.mutable(
    Schema.Array(Schema.Number.check(Schema.isFinite()))
  ).annotate({ description: "Calendars offering this type" }),
});

const availabilityDateSchema = Schema.Struct({
  date: Schema.String.annotate({ description: "Available date, YYYY-MM-DD" }),
});

const availabilityTimeSlotSchema = Schema.Struct({
  time: Schema.String.annotate({
    description: "Bookable slot, ISO 8601 with offset",
  }),
});

export const listAppointmentTypesInput = Schema.Struct({});

export const listAppointmentTypesOutput = Schema.Struct({
  appointmentTypes: Schema.mutable(
    Schema.Array(appointmentTypeSchema)
  ).annotate({
    description: "Array of appointment types",
  }),
  count: describedNumber("Number of appointment types returned"),
});

export const listAppointmentsInput = Schema.Struct({
  appointmentTypeId: optionalText,
  calendarId: optionalText,
  minDate: optionalText,
  maxDate: optionalText,
  timezone: optionalText,
  email: optionalText,
  phone: optionalText,
  canceled: optionalText,
  showAll: optionalText,
  limit: optionalNumeric,
  page: optionalNumeric,
});

export const listAppointmentsOutput = Schema.Struct({
  appointments: Schema.mutable(Schema.Array(appointmentSchema)).annotate({
    description: "Array of appointments",
  }),
  count: describedNumber("Number of appointments returned"),
});

export const getAppointmentInput = Schema.Struct({
  appointmentId: Schema.String,
  pastFormAnswers: optionalText,
});

export const getAppointmentOutput = Schema.Struct({
  appointment: appointmentSchema.annotate({
    description: "The appointment details",
  }),
  id: describedNumber("Appointment ID"),
  datetime: Schema.String.annotate({ description: "Appointment datetime" }),
});

export const getAvailabilityDatesInput = Schema.Struct({
  month: Schema.String,
  appointmentTypeId: Schema.String,
  calendarId: optionalText,
  timezone: optionalText,
});

export const getAvailabilityDatesOutput = Schema.Struct({
  dates: Schema.mutable(Schema.Array(availabilityDateSchema)).annotate({
    description: "Available dates",
  }),
  count: describedNumber("Number of dates returned"),
});

export const getAvailabilityTimesInput = Schema.Struct({
  date: Schema.String,
  appointmentTypeId: Schema.String,
  calendarId: optionalText,
  timezone: optionalText,
  /** Comma-separated, which is how a single text field carries a list. */
  ignoreAppointmentIds: optionalText,
});

export const getAvailabilityTimesOutput = Schema.Struct({
  slots: Schema.mutable(Schema.Array(availabilityTimeSlotSchema)).annotate({
    description: "Available time slots",
  }),
  count: describedNumber("Number of slots returned"),
});

export const createAppointmentInput = Schema.Struct({
  datetime: Schema.String,
  appointmentTypeId: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  email: Schema.String,
  phone: Schema.String,
  calendarId: optionalText,
  notes: optionalText,
  smsOptIn: optionalText,
  /** JSON the workflow author typed, parsed by the step. */
  customFieldsJson: optionalText,
  admin: optionalText,
  noEmail: optionalText,
});

export const createAppointmentOutput = Schema.Struct({
  appointment: appointmentSchema.annotate({
    description: "Created appointment payload",
  }),
  id: describedNumber("Created appointment ID"),
  datetime: Schema.String.annotate({
    description: "Created appointment datetime",
  }),
});

export const rescheduleAppointmentInput = Schema.Struct({
  appointmentId: Schema.String,
  datetime: Schema.String,
  calendarId: optionalText,
  admin: optionalText,
  noEmail: optionalText,
});

export const rescheduleAppointmentOutput = Schema.Struct({
  appointment: appointmentSchema.annotate({
    description: "Rescheduled appointment payload",
  }),
  id: describedNumber("Appointment ID"),
  datetime: Schema.String.annotate({
    description: "New appointment datetime",
  }),
});

export const cancelAppointmentInput = Schema.Struct({
  appointmentId: Schema.String,
  cancelNote: optionalText,
  noShow: optionalText,
  admin: optionalText,
  noEmail: optionalText,
});

export const cancelAppointmentOutput = Schema.Struct({
  appointment: appointmentSchema.annotate({
    description: "Canceled appointment payload",
  }),
  id: describedNumber("Canceled appointment ID"),
  canceled: Schema.optional(
    Schema.Boolean.annotate({ description: "Cancellation flag" })
  ),
});

/**
 * The Acuity integration: its credentials, its eight actions, and what each takes
 * and gives back.
 *
 * The handlers are not here. Acuity's SDK is a runtime import of `steps/client.ts`,
 * so `load` is what keeps it out of a process that never runs an Acuity action, and
 * eight handlers in one file would be a file nobody reads. The schemas are exported
 * for those modules to type themselves against.
 *
 * Only the server imports this. The editor gets the metadata below as JSON over
 * `/api/extensions`, and the icon stays in `ui.ts`.
 *
 * The output schemas describe the SDK's resources rather than borrowing their
 * types, and they describe every field the SDK sends. A step hands the SDK's object
 * back whole and the encode keeps only what the schema admits, so a field left out
 * here would not reach the run log either. Three of them are declared without being
 * describable, and each says why where it sits: what the picker lists is a subset of
 * what the schema carries.
 */

import {
  credentialFields,
  type CredentialsOf,
  defineIntegration,
  defineStep,
} from "@rova/core/plugin";
import { Schema } from "effect";

const acuityCredentialFields = credentialFields([
  {
    label: "User ID",
    type: "text",
    placeholder: "12345678",
    configKey: "userId",
    envVar: "ACUITY_USER_ID",
    helpText: "Your Acuity User ID used as Basic auth username.",
  },
  {
    label: "API Key",
    type: "password",
    placeholder: "••••••••",
    configKey: "apiKey",
    envVar: "ACUITY_API_KEY",
    helpText: "Your Acuity API key used as Basic auth password.",
  },
]);

export type AcuityCredentials = CredentialsOf<typeof acuityCredentialFields>;

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

/** Every config field arrives as text, so this is what most of them look like. */
const optionalText = Schema.optionalKey(Schema.String);

/**
 * A number a config field carries.
 *
 * A `number` config field may be stored as a number and a template resolves to
 * text, so both arrive and the step parses whichever it got.
 */
const optionalNumeric = Schema.optionalKey(
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
 * A field of a vendor's payload, as an output schema may describe it.
 *
 * `optionalKey(NullOr(...))` is the one spelling that survives everything a vendor
 * sends: an absent key, an explicit `null`, or the value. `optional(X)` refuses the
 * null and `NullishOr(X)` refuses the absent key, and either refusal fails the
 * encode and so the whole step. The picker reads the same `nullable` off this as it
 * did off the stricter spellings, so nothing is lost by tolerating both.
 */
function vendorField<S extends Schema.Codec<unknown>>(field: S) {
  return Schema.optionalKey(Schema.NullOr(field));
}

/** The same tolerance for a whole number the picker offers. */
function vendorNumber(description: string) {
  return vendorField(describedNumber(description));
}

/** The same tolerance for a string the picker offers. */
function vendorText(description: string) {
  return vendorField(Schema.String.annotate({ description }));
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
  id: vendorNumber("Answer ID"),
  fieldID: vendorNumber("Form field ID"),
  name: vendorText("Question the client answered"),
  value: Schema.optionalKey(
    Schema.NullOr(
      Schema.Union([Schema.String, Schema.mutable(Schema.Array(Schema.String))])
    )
  ),
});

/**
 * One intake form on an appointment, holding the answers given on it.
 *
 * The nesting is the correction: `forms` is a list of forms, each carrying its own
 * `values` list, and the previous schema described the answers directly. Every
 * appointment action encoded its answer list against a shape the wire does not
 * have, so all five failed on any appointment that had an intake form.
 */
const appointmentFormSchema = Schema.Struct({
  id: vendorNumber("Form ID"),
  name: vendorText("Form name"),
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
 * payload without them is not an appointment: everything else is a `vendorField`.
 * That is deliberate rather than lazy. This describes somebody else's JSON, the SDK
 * validates none of it, and a field this schema insists on that a real payload
 * omits fails the encode and so fails the step -- which is what the previous
 * version did with `calendarTimeZone`, a name the API does not send at all. The
 * timezone it does send is `timezone`.
 */
const appointmentSchema = Schema.Struct({
  id: describedNumber("Appointment ID"),
  datetime: Schema.String.annotate({
    description: "Appointment start, ISO 8601 with offset",
  }),
  firstName: vendorText("Client first name"),
  lastName: vendorText("Client last name"),
  email: vendorText("Client email address"),
  phone: vendorText("Client phone number"),
  date: vendorText("Appointment date, as Acuity writes it for people"),
  endDate: vendorText("Appointment end date, as Acuity writes it for people"),
  time: vendorText("Appointment start time"),
  endTime: vendorText("Appointment end time"),
  duration: vendorText("Duration in minutes"),
  timezone: vendorText("The appointment's IANA timezone"),
  type: vendorText("Appointment type name"),
  appointmentTypeID: vendorNumber("Appointment type ID"),
  calendar: vendorText("Calendar name"),
  calendarID: vendorNumber("Calendar ID"),
  // A string on some payloads and a number on others, the way the type's own price
  // is. The picker has no single type for a union and drops it; declaring it is what
  // keeps it through the encode and into the run log.
  price: Schema.optionalKey(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Finite]))
  ),
  paid: vendorText("Whether the appointment is paid"),
  notes: vendorText("Appointment notes"),
  forms: Schema.optionalKey(
    Schema.NullOr(
      Schema.mutable(Schema.Array(appointmentFormSchema)).annotate({
        description: "Intake forms on the appointment",
      })
    )
  ),
  noShow: vendorField(
    Schema.Boolean.annotate({ description: "Marked as a no-show" })
  ),
  canceled: vendorField(
    Schema.Boolean.annotate({
      description: "Whether the appointment is canceled",
    })
  ),
  certificate: opaqueJson,
  package: opaqueJson,
  scheduledBy: vendorText(
    "Who scheduled it, or null for a client not logged in"
  ),
});

/**
 * Acuity's appointment type, as the API sends it.
 *
 * Same rule as the appointment above: `id` is what identifies one, and everything
 * else tolerates an absent key and an explicit null, because this describes a
 * vendor's JSON. `price` arrives as a string on some types and a number on others,
 * which the picker has no single type for and drops; it is declared so that the
 * encode keeps it.
 */
const appointmentTypeSchema = Schema.Struct({
  id: describedNumber("Appointment type ID"),
  name: vendorText("Appointment type name"),
  active: vendorField(
    Schema.Boolean.annotate({ description: "Whether the type is bookable" })
  ),
  description: vendorText("Appointment type description"),
  duration: vendorNumber("Duration in minutes"),
  category: vendorText("Category name"),
  color: vendorText("Calendar colour"),
  private: vendorField(
    Schema.Boolean.annotate({
      description: "Whether the type is hidden from the public scheduler",
    })
  ),
  // The three kinds Acuity documents, written out rather than as a bare string: the
  // condition builder offers them as choices. A kind this list does not have still
  // encodes, because the field tolerates anything the union admits or a null.
  type: vendorField(
    Schema.Literals(["service", "class", "series"]).annotate({
      description: "Kind of type: service, class, or series",
    })
  ),
  classSize: vendorNumber("Seats in a class, if it is one"),
  paddingAfter: vendorNumber("Minutes of padding after the appointment"),
  paddingBefore: vendorNumber("Minutes of padding before the appointment"),
  calendarIDs: Schema.optionalKey(
    Schema.NullOr(
      Schema.mutable(
        Schema.Array(Schema.Number.check(Schema.isFinite()))
      ).annotate({ description: "Calendars offering this type" })
    )
  ),
  price: Schema.optionalKey(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Finite]))
  ),
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

const listAppointmentTypesOutput = Schema.Struct({
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

const listAppointmentsOutput = Schema.Struct({
  appointments: Schema.mutable(Schema.Array(appointmentSchema)).annotate({
    description: "Array of appointments",
  }),
  count: describedNumber("Number of appointments returned"),
});

export const getAppointmentInput = Schema.Struct({
  appointmentId: Schema.String,
  pastFormAnswers: optionalText,
});

const getAppointmentOutput = Schema.Struct({
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

const getAvailabilityDatesOutput = Schema.Struct({
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

const getAvailabilityTimesOutput = Schema.Struct({
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

const createAppointmentOutput = Schema.Struct({
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

const rescheduleAppointmentOutput = Schema.Struct({
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

const cancelAppointmentOutput = Schema.Struct({
  appointment: appointmentSchema.annotate({
    description: "Canceled appointment payload",
  }),
  id: describedNumber("Canceled appointment ID"),
  canceled: Schema.optional(
    Schema.Boolean.annotate({ description: "Cancellation flag" })
  ),
});

/** What a tri-state Acuity flag offers: leave it alone, or say yes or no. */
const yesNoSelect = [
  { value: "", label: "Default" },
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
];

/**
 * The two flags every mutating Acuity action takes, written once.
 *
 * `satisfies` with the keys spelled out is what keeps each `key` a literal type:
 * `defineStep` checks a field's key against its step's input schema, and a widened
 * `string` names no key at all. All three actions that use this group declare both.
 */
const mutationFlagsGroup = {
  type: "group",
  label: "Mutation Flags",
  fields: [
    {
      key: "admin",
      label: "Run as Admin",
      type: "select",
      defaultValue: "",
      options: yesNoSelect,
    },
    {
      key: "noEmail",
      label: "Suppress Acuity Emails",
      type: "select",
      defaultValue: "",
      options: yesNoSelect,
    },
  ],
} satisfies {
  type: "group";
  label: string;
  fields: {
    key: "admin" | "noEmail";
    label: string;
    type: "select";
    defaultValue: string;
    options: typeof yesNoSelect;
  }[];
};

export const acuity = defineIntegration({
  type: "acuity",
  label: "Acuity",
  description: "Manage appointments and availability in Acuity Scheduling",
  credentials: acuityCredentialFields,

  test: async () => (await import("#src/acuity/test")).testAcuity,

  actions: {
    "list-appointment-types": defineStep({
      label: "List Appointment Types",
      description: "Fetch appointment types configured in Acuity",
      category: "Acuity",
      input: listAppointmentTypesInput,
      output: listAppointmentTypesOutput,
      configFields: [],
      load: async () =>
        (await import("#src/acuity/steps/list-appointment-types"))
          .listAppointmentTypesHandler,
    }),

    "list-appointments": defineStep({
      label: "List Appointments",
      description: "List appointments with optional filters",
      category: "Acuity",
      input: listAppointmentsInput,
      output: listAppointmentsOutput,
      configFields: [
        {
          key: "appointmentTypeId",
          label: "Appointment Type ID",
          type: "template-input",
          placeholder: "12345",
        },
        {
          key: "calendarId",
          label: "Calendar ID",
          type: "template-input",
          placeholder: "67890",
        },
        {
          key: "minDate",
          label: "Min Date (YYYY-MM-DD)",
          type: "template-input",
          placeholder: "2026-03-01",
        },
        {
          key: "maxDate",
          label: "Max Date (YYYY-MM-DD)",
          type: "template-input",
          placeholder: "2026-03-31",
        },
        {
          key: "timezone",
          label: "Timezone",
          type: "template-input",
          placeholder: "America/New_York",
        },
        {
          type: "group",
          label: "Additional Filters",
          fields: [
            {
              key: "email",
              label: "Client Email",
              type: "template-input",
              placeholder: "person@example.com",
            },
            {
              key: "phone",
              label: "Client Phone",
              type: "template-input",
              placeholder: "+15551234567",
            },
            {
              key: "canceled",
              label: "Only Canceled",
              type: "select",
              defaultValue: "",
              options: [
                { value: "", label: "No filter" },
                { value: "true", label: "Yes" },
                { value: "false", label: "No" },
              ],
            },
            {
              key: "showAll",
              label: "Include Inactive",
              type: "select",
              defaultValue: "",
              options: yesNoSelect,
            },
            {
              key: "limit",
              label: "Limit",
              type: "number",
              min: 1,
              defaultValue: "50",
            },
            {
              key: "page",
              label: "Page",
              type: "number",
              min: 1,
              defaultValue: "1",
            },
          ],
        },
      ],
      load: async () =>
        (await import("#src/acuity/steps/list-appointments"))
          .listAppointmentsHandler,
    }),

    "get-appointment": defineStep({
      label: "Get Appointment",
      description: "Fetch one appointment by ID",
      category: "Acuity",
      input: getAppointmentInput,
      output: getAppointmentOutput,
      configFields: [
        {
          key: "appointmentId",
          label: "Appointment ID",
          type: "template-input",
          placeholder: "123456789",
          required: true,
        },
        {
          key: "pastFormAnswers",
          label: "Include Past Form Answers",
          type: "select",
          defaultValue: "false",
          options: [
            { value: "false", label: "No" },
            { value: "true", label: "Yes" },
          ],
        },
      ],
      load: async () =>
        (await import("#src/acuity/steps/get-appointment"))
          .getAppointmentHandler,
    }),

    "get-availability-dates": defineStep({
      label: "Get Availability Dates",
      description: "List dates that still have available slots",
      category: "Acuity",
      input: getAvailabilityDatesInput,
      output: getAvailabilityDatesOutput,
      configFields: [
        {
          key: "month",
          label: "Month (YYYY-MM)",
          type: "template-input",
          placeholder: "2026-03",
          required: true,
        },
        {
          key: "appointmentTypeId",
          label: "Appointment Type ID",
          type: "template-input",
          placeholder: "12345",
          required: true,
        },
        {
          key: "calendarId",
          label: "Calendar ID",
          type: "template-input",
          placeholder: "67890",
        },
        {
          key: "timezone",
          label: "Timezone",
          type: "template-input",
          placeholder: "America/New_York",
        },
      ],
      load: async () =>
        (await import("#src/acuity/steps/get-availability-dates"))
          .getAvailabilityDatesHandler,
    }),

    "get-availability-times": defineStep({
      label: "Get Availability Times",
      description: "List available time slots for a date",
      category: "Acuity",
      input: getAvailabilityTimesInput,
      output: getAvailabilityTimesOutput,
      configFields: [
        {
          key: "date",
          label: "Date (YYYY-MM-DD)",
          type: "template-input",
          placeholder: "2026-03-15",
          required: true,
        },
        {
          key: "appointmentTypeId",
          label: "Appointment Type ID",
          type: "template-input",
          placeholder: "12345",
          required: true,
        },
        {
          key: "calendarId",
          label: "Calendar ID",
          type: "template-input",
          placeholder: "67890",
        },
        {
          key: "timezone",
          label: "Timezone",
          type: "template-input",
          placeholder: "America/New_York",
        },
        {
          key: "ignoreAppointmentIds",
          label: "Ignore Appointment IDs (comma separated)",
          type: "template-input",
          placeholder: "111,222",
        },
      ],
      load: async () =>
        (await import("#src/acuity/steps/get-availability-times"))
          .getAvailabilityTimesHandler,
    }),

    "create-appointment": defineStep({
      label: "Create Appointment",
      description: "Book a new appointment in Acuity",
      category: "Acuity",
      input: createAppointmentInput,
      output: createAppointmentOutput,
      configFields: [
        {
          key: "datetime",
          label: "Datetime (ISO 8601)",
          type: "template-input",
          placeholder: "2026-03-15T15:00:00-04:00",
          required: true,
        },
        {
          key: "appointmentTypeId",
          label: "Appointment Type ID",
          type: "template-input",
          placeholder: "12345",
          required: true,
        },
        {
          key: "firstName",
          label: "First Name",
          type: "template-input",
          placeholder: "Alice",
          required: true,
        },
        {
          key: "lastName",
          label: "Last Name",
          type: "template-input",
          placeholder: "Johnson",
          required: true,
        },
        {
          key: "email",
          label: "Email",
          type: "template-input",
          placeholder: "alice@example.com",
          required: true,
        },
        {
          key: "phone",
          label: "Phone",
          type: "template-input",
          placeholder: "+15551234567",
          required: true,
        },
        {
          type: "group",
          label: "Optional Appointment Fields",
          fields: [
            {
              key: "calendarId",
              label: "Calendar ID",
              type: "template-input",
              placeholder: "67890",
            },
            {
              key: "notes",
              label: "Notes",
              type: "template-textarea",
              placeholder: "Optional internal notes",
              rows: 3,
            },
            {
              key: "smsOptIn",
              label: "SMS Opt-In",
              type: "select",
              defaultValue: "",
              options: yesNoSelect,
            },
            {
              key: "customFieldsJson",
              label: "Custom Fields JSON",
              type: "template-textarea",
              rows: 5,
              placeholder:
                '[{"fieldID":1234,"value":"Some answer"},{"fieldID":5678,"value":["A","B"]}]',
            },
          ],
        },
        mutationFlagsGroup,
      ],
      load: async () =>
        (await import("#src/acuity/steps/create-appointment"))
          .createAppointmentHandler,
    }),

    "reschedule-appointment": defineStep({
      label: "Reschedule Appointment",
      description: "Move an appointment to a new datetime",
      category: "Acuity",
      input: rescheduleAppointmentInput,
      output: rescheduleAppointmentOutput,
      configFields: [
        {
          key: "appointmentId",
          label: "Appointment ID",
          type: "template-input",
          placeholder: "123456789",
          required: true,
        },
        {
          key: "datetime",
          label: "New Datetime (ISO 8601)",
          type: "template-input",
          placeholder: "2026-03-16T10:00:00-04:00",
          required: true,
        },
        {
          key: "calendarId",
          label: "Calendar ID",
          type: "template-input",
          placeholder: "67890",
        },
        mutationFlagsGroup,
      ],
      load: async () =>
        (await import("#src/acuity/steps/reschedule-appointment"))
          .rescheduleAppointmentHandler,
    }),

    "cancel-appointment": defineStep({
      label: "Cancel Appointment",
      description: "Cancel an appointment in Acuity",
      category: "Acuity",
      input: cancelAppointmentInput,
      output: cancelAppointmentOutput,
      configFields: [
        {
          key: "appointmentId",
          label: "Appointment ID",
          type: "template-input",
          placeholder: "123456789",
          required: true,
        },
        {
          key: "cancelNote",
          label: "Cancel Note",
          type: "template-textarea",
          rows: 3,
          placeholder: "Optional cancellation reason",
        },
        {
          key: "noShow",
          label: "Mark as No-Show",
          type: "select",
          defaultValue: "",
          options: yesNoSelect,
        },
        mutationFlagsGroup,
      ],
      load: async () =>
        (await import("#src/acuity/steps/cancel-appointment"))
          .cancelAppointmentHandler,
    }),
  },
});

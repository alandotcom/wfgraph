/**
 * The Acuity integration: its credentials, its eight actions, and what each takes
 * and gives back.
 *
 * One file, because only the server imports it. The editor gets the metadata below
 * as JSON over `/api/extensions`, so Acuity's SDK costs the browser nothing. The
 * icon is the exception, since a React component cannot be serialized: it stays in
 * `ui.ts`, which only the browser imports.
 *
 * Each action's two schemas are declared above, in the order the `actions` record
 * lists them, and its handler is written into the action literal itself. Inline is
 * what types `bag.input` and `bag.credentials`: a handler hoisted out of the
 * literal loses the contextual type and has to name both by hand.
 *
 * The output schemas describe the SDK's resources rather than borrowing their
 * types, and they describe every field the SDK sends. A step hands the SDK's object
 * back whole and the encode keeps only what the schema admits, so a field left out
 * here would not reach the run log either. Three of them are declared without being
 * describable, and each says why where it sits: what the picker lists is a subset of
 * what the schema carries.
 */

import type {
  AvailabilityDatesParams,
  AvailabilityTimesParams,
  CreateAppointmentPayload,
  ListAppointmentsParams,
} from "@fountain-bio/acuity";
import {
  type CredentialFields,
  type CredentialsOf,
  defineIntegration,
  StepFailure,
} from "@rova/core/plugin";
import { Effect, Schema } from "effect";
import { callAcuity, createAcuityClient } from "#src/acuity/client";
import {
  appointmentSchema,
  appointmentTypeSchema,
  availabilityDateSchema,
  availabilityTimeSlotSchema,
  describedNumber,
} from "#src/acuity/payloads";
import {
  optionalBoolean,
  optionalCustomFields,
  optionalInteger,
  optionalIntegerList,
  optionalNumeric,
  optionalText,
  requiredInteger,
} from "#src/acuity/shared";

const acuityCredentialFields = {
  ACUITY_USER_ID: {
    label: "User ID",
    type: "text",
    placeholder: "12345678",
    helpText: "Your Acuity User ID used as Basic auth username.",
  },
  ACUITY_API_KEY: {
    label: "API Key",
    type: "password",
    placeholder: "••••••••",
    helpText: "Your Acuity API key used as Basic auth password.",
  },
} satisfies CredentialFields;

export type AcuityCredentials = CredentialsOf<typeof acuityCredentialFields>;

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
 * an action checks a field's key against its input schema, and a widened `string`
 * names no key at all. All three actions that use this group declare both.
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

const listAppointmentTypesInput = Schema.Struct({});

const listAppointmentTypesOutput = Schema.Struct({
  appointmentTypes: Schema.mutable(
    Schema.Array(appointmentTypeSchema)
  ).annotate({
    description: "Array of appointment types",
  }),
  count: describedNumber("Number of appointment types returned"),
});

const listAppointmentsInput = Schema.Struct({
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

const getAppointmentInput = Schema.Struct({
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

const getAvailabilityDatesInput = Schema.Struct({
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

const getAvailabilityTimesInput = Schema.Struct({
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

const createAppointmentInput = Schema.Struct({
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

const rescheduleAppointmentInput = Schema.Struct({
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

const cancelAppointmentInput = Schema.Struct({
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

export const acuity = defineIntegration({
  type: "acuity",
  label: "Acuity",
  description: "Manage appointments and availability in Acuity Scheduling",
  credentials: acuityCredentialFields,

  test: async () => (await import("#src/acuity/test")).testAcuity,

  // The record key is the action slug, and the only place it exists: the id
  // "acuity/list-appointments" is computed at assembly and never written twice.
  actions: {
    "list-appointment-types": {
      label: "List Appointment Types",
      description: "Fetch appointment types configured in Acuity",
      input: listAppointmentTypesInput,
      output: listAppointmentTypesOutput,
      configFields: [],
      /** The action takes no configuration, so the whole of it is the read. */
      handler: Effect.fn(function* (bag) {
        const client = yield* createAcuityClient(bag);

        const appointmentTypes = yield* bag.step.run(
          "list-types",
          callAcuity("Failed to list appointment types.", () =>
            client.appointments.types()
          )
        );

        return { appointmentTypes, count: appointmentTypes.length };
      }),
    },

    "list-appointments": {
      label: "List Appointments",
      description: "List appointments with optional filters",
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
      /**
       * What this step decides is which filters the config asked for, and each
       * field says for itself what is wrong with it.
       */
      handler: Effect.fn(function* (bag) {
        const { input } = bag;
        const client = yield* createAcuityClient(bag);

        // Read in the order the form lists them, so a config with two bad fields
        // reports the one nearer the top of the panel.
        const appointmentTypeID = yield* optionalInteger(
          input.appointmentTypeId,
          "Appointment Type ID"
        );
        const calendarID = yield* optionalInteger(
          input.calendarId,
          "Calendar ID"
        );
        const limit = yield* optionalInteger(input.limit, "Limit");
        const page = yield* optionalInteger(input.page, "Page");
        const canceled = yield* optionalBoolean(
          input.canceled,
          "Only Canceled"
        );
        const showall = yield* optionalBoolean(
          input.showAll,
          "Include Inactive"
        );

        // Acuity's own parameter names, so this reads like its documentation. The
        // SDK drops the ones left undefined.
        const params: ListAppointmentsParams = {
          appointmentTypeID,
          calendarID,
          minDate: input.minDate,
          maxDate: input.maxDate,
          timezone: input.timezone,
          email: input.email,
          phone: input.phone,
          canceled,
          showall,
          limit,
          page,
        };

        const appointments = yield* bag.step.run(
          "list-appointments",
          callAcuity("Failed to list appointments.", () =>
            client.appointments.list(params)
          )
        );

        return { appointments, count: appointments.length };
      }),
    },

    "get-appointment": {
      label: "Get Appointment",
      description: "Fetch one appointment by ID",
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
      handler: Effect.fn(function* (bag) {
        const { input } = bag;
        const client = yield* createAcuityClient(bag);

        const appointmentId = yield* requiredInteger(
          input.appointmentId,
          "Appointment ID"
        );
        const pastFormAnswers = yield* optionalBoolean(
          input.pastFormAnswers,
          "Include Past Form Answers"
        );

        const appointment = yield* bag.step.run(
          "get-appointment",
          callAcuity("Failed to fetch appointment.", () =>
            client.appointments.get(appointmentId, { pastFormAnswers })
          )
        );

        // The id and the datetime sit beside the appointment as well as inside it,
        // because those two are what a downstream node reaches for most.
        return {
          appointment,
          id: appointment.id,
          datetime: appointment.datetime,
        };
      }),
    },

    "get-availability-dates": {
      label: "Get Availability Dates",
      description: "List dates that still have available slots",
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
      handler: Effect.fn(function* (bag) {
        const { input } = bag;
        const client = yield* createAcuityClient(bag);

        const appointmentTypeID = yield* requiredInteger(
          input.appointmentTypeId,
          "Appointment Type ID"
        );
        const calendarID = yield* optionalInteger(
          input.calendarId,
          "Calendar ID"
        );

        if (!input.month.trim()) {
          return yield* new StepFailure({
            message: "Month is required and must use YYYY-MM format.",
          });
        }

        // Acuity's own parameter names, so this reads like its documentation.
        const params: AvailabilityDatesParams = {
          month: input.month,
          appointmentTypeID,
          calendarID,
          timezone: input.timezone,
        };

        const dates = yield* bag.step.run(
          "get-dates",
          callAcuity("Failed to fetch availability dates.", () =>
            client.availability.dates(params)
          )
        );

        return { dates, count: dates.length };
      }),
    },

    "get-availability-times": {
      label: "Get Availability Times",
      description: "List available time slots for a date",
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
      handler: Effect.fn(function* (bag) {
        const { input } = bag;
        const client = yield* createAcuityClient(bag);

        const appointmentTypeID = yield* requiredInteger(
          input.appointmentTypeId,
          "Appointment Type ID"
        );
        const calendarID = yield* optionalInteger(
          input.calendarId,
          "Calendar ID"
        );
        // Ignoring the appointment being moved is what lets its own slot show up
        // again, which is why rescheduling passes an id here.
        const ignoreAppointmentIDs = yield* optionalIntegerList(
          input.ignoreAppointmentIds,
          "Ignore Appointment IDs"
        );

        if (!input.date.trim()) {
          return yield* new StepFailure({
            message: "Date is required and must use YYYY-MM-DD format.",
          });
        }

        // Acuity's own parameter names, so this reads like its documentation.
        const params: AvailabilityTimesParams = {
          date: input.date,
          appointmentTypeID,
          calendarID,
          timezone: input.timezone,
          ignoreAppointmentIDs,
        };

        const slots = yield* bag.step.run(
          "get-times",
          callAcuity("Failed to fetch availability times.", () =>
            client.availability.times(params)
          )
        );

        return { slots, count: slots.length };
      }),
    },

    "create-appointment": {
      label: "Create Appointment",
      description: "Book a new appointment in Acuity",
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
      /**
       * What this step decides is what a booking looks like, and each field says
       * for itself what is wrong with it.
       */
      handler: Effect.fn(function* (bag) {
        const { input } = bag;
        const client = yield* createAcuityClient(bag);

        const appointmentTypeID = yield* requiredInteger(
          input.appointmentTypeId,
          "Appointment Type ID"
        );
        const calendarID = yield* optionalInteger(
          input.calendarId,
          "Calendar ID"
        );
        const smsOptIn = yield* optionalBoolean(input.smsOptIn, "SMS Opt-In");
        const admin = yield* optionalBoolean(input.admin, "Run as Admin");
        const noEmail = yield* optionalBoolean(
          input.noEmail,
          "Suppress Acuity Emails"
        );
        const fields = yield* optionalCustomFields(input.customFieldsJson);

        if (!input.datetime.trim()) {
          return yield* new StepFailure({
            message: "Datetime is required (ISO 8601 format).",
          });
        }

        if (!(input.firstName.trim() && input.lastName.trim())) {
          return yield* new StepFailure({
            message: "First Name and Last Name are required.",
          });
        }

        if (!(input.email.trim() && input.phone.trim())) {
          return yield* new StepFailure({
            message: "Email and Phone are required.",
          });
        }

        // Acuity's own parameter names, so this reads like its documentation.
        const payload: CreateAppointmentPayload = {
          datetime: input.datetime,
          appointmentTypeID,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          phone: input.phone,
          calendarID,
          notes: input.notes,
          smsOptIn,
          fields,
        };

        const appointment = yield* bag.step.run(
          "create-appointment",
          callAcuity("Failed to create appointment.", () =>
            client.appointments.create(payload, { admin, noEmail })
          )
        );

        // The id and the datetime sit beside the appointment as well as inside it,
        // because those two are what a downstream node reaches for most.
        return {
          appointment,
          id: appointment.id,
          datetime: appointment.datetime,
        };
      }),
    },

    "reschedule-appointment": {
      label: "Reschedule Appointment",
      description: "Move an appointment to a new datetime",
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
      handler: Effect.fn(function* (bag) {
        const { input } = bag;
        const client = yield* createAcuityClient(bag);

        const appointmentId = yield* requiredInteger(
          input.appointmentId,
          "Appointment ID"
        );

        if (!input.datetime.trim()) {
          return yield* new StepFailure({
            message: "New Datetime is required (ISO 8601 format).",
          });
        }

        const calendarID = yield* optionalInteger(
          input.calendarId,
          "Calendar ID"
        );
        const admin = yield* optionalBoolean(input.admin, "Run as Admin");
        const noEmail = yield* optionalBoolean(
          input.noEmail,
          "Suppress Acuity Emails"
        );

        const appointment = yield* bag.step.run(
          "reschedule-appointment",
          callAcuity("Failed to reschedule appointment.", () =>
            client.appointments.reschedule(
              appointmentId,
              { datetime: input.datetime, calendarID },
              { admin, noEmail }
            )
          )
        );

        // The id and the datetime sit beside the appointment as well as inside it,
        // because those two are what a downstream node reaches for most.
        return {
          appointment,
          id: appointment.id,
          datetime: appointment.datetime,
        };
      }),
    },

    "cancel-appointment": {
      label: "Cancel Appointment",
      description: "Cancel an appointment in Acuity",
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
      handler: Effect.fn(function* (bag) {
        const { input } = bag;
        const client = yield* createAcuityClient(bag);

        const appointmentId = yield* requiredInteger(
          input.appointmentId,
          "Appointment ID"
        );
        const noShow = yield* optionalBoolean(input.noShow, "Mark as No-Show");
        const admin = yield* optionalBoolean(input.admin, "Run as Admin");
        const noEmail = yield* optionalBoolean(
          input.noEmail,
          "Suppress Acuity Emails"
        );

        const appointment = yield* bag.step.run(
          "cancel-appointment",
          callAcuity("Failed to cancel appointment.", () =>
            client.appointments.cancel(
              appointmentId,
              { cancelNote: input.cancelNote, noShow },
              { admin, noEmail }
            )
          )
        );

        // The id and the flag sit beside the appointment as well as inside it,
        // because those two are what a downstream node reaches for most.
        return {
          appointment,
          id: appointment.id,
          canceled: appointment.canceled,
        };
      }),
    },
  },
});

import type { IntegrationPlugin } from "@/shared/plugins/registry";
import { registerIntegration } from "@/shared/plugins/registry";

const acuityPlugin: IntegrationPlugin = {
  type: "acuity",
  label: "Acuity",
  description: "Manage appointments and availability in Acuity Scheduling",

  formFields: [
    {
      id: "userId",
      label: "User ID",
      type: "text",
      placeholder: "12345678",
      configKey: "userId",
      envVar: "ACUITY_USER_ID",
      helpText: "Your Acuity User ID used as Basic auth username.",
    },
    {
      id: "apiKey",
      label: "API Key",
      type: "password",
      placeholder: "••••••••",
      configKey: "apiKey",
      envVar: "ACUITY_API_KEY",
      helpText: "Your Acuity API key used as Basic auth password.",
    },
  ],

  actions: [
    {
      slug: "list-appointment-types",
      label: "List Appointment Types",
      description: "Fetch appointment types configured in Acuity",
      category: "Acuity",
      outputFields: [
        {
          path: "appointmentTypes",
          description: "Array of appointment types",
        },
        { path: "count", description: "Number of appointment types returned" },
      ],
      configFields: [],
    },
    {
      slug: "list-appointments",
      label: "List Appointments",
      description: "List appointments with optional filters",
      category: "Acuity",
      outputFields: [
        { path: "appointments", description: "Array of appointments" },
        { path: "count", description: "Number of appointments returned" },
      ],
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
              options: [
                { value: "", label: "Default" },
                { value: "true", label: "Yes" },
                { value: "false", label: "No" },
              ],
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
    },
    {
      slug: "get-appointment",
      label: "Get Appointment",
      description: "Fetch one appointment by ID",
      category: "Acuity",
      outputFields: [
        { path: "appointment", description: "The appointment details" },
        { path: "id", description: "Appointment ID" },
        { path: "datetime", description: "Appointment datetime" },
      ],
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
    },
    {
      slug: "get-availability-dates",
      label: "Get Availability Dates",
      description: "List dates that still have available slots",
      category: "Acuity",
      outputFields: [
        { path: "dates", description: "Available dates" },
        { path: "count", description: "Number of dates returned" },
      ],
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
    },
    {
      slug: "get-availability-times",
      label: "Get Availability Times",
      description: "List available time slots for a date",
      category: "Acuity",
      outputFields: [
        { path: "slots", description: "Available time slots" },
        { path: "count", description: "Number of slots returned" },
      ],
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
    },
    {
      slug: "create-appointment",
      label: "Create Appointment",
      description: "Book a new appointment in Acuity",
      category: "Acuity",
      outputFields: [
        { path: "appointment", description: "Created appointment payload" },
        { path: "id", description: "Created appointment ID" },
        { path: "datetime", description: "Created appointment datetime" },
      ],
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
              options: [
                { value: "", label: "Default" },
                { value: "true", label: "Yes" },
                { value: "false", label: "No" },
              ],
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
        {
          type: "group",
          label: "Mutation Flags",
          fields: [
            {
              key: "admin",
              label: "Run as Admin",
              type: "select",
              defaultValue: "",
              options: [
                { value: "", label: "Default" },
                { value: "true", label: "Yes" },
                { value: "false", label: "No" },
              ],
            },
            {
              key: "noEmail",
              label: "Suppress Acuity Emails",
              type: "select",
              defaultValue: "",
              options: [
                { value: "", label: "Default" },
                { value: "true", label: "Yes" },
                { value: "false", label: "No" },
              ],
            },
          ],
        },
      ],
    },
    {
      slug: "reschedule-appointment",
      label: "Reschedule Appointment",
      description: "Move an appointment to a new datetime",
      category: "Acuity",
      outputFields: [
        {
          path: "appointment",
          description: "Rescheduled appointment payload",
        },
        { path: "id", description: "Appointment ID" },
        { path: "datetime", description: "New appointment datetime" },
      ],
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
        {
          type: "group",
          label: "Mutation Flags",
          fields: [
            {
              key: "admin",
              label: "Run as Admin",
              type: "select",
              defaultValue: "",
              options: [
                { value: "", label: "Default" },
                { value: "true", label: "Yes" },
                { value: "false", label: "No" },
              ],
            },
            {
              key: "noEmail",
              label: "Suppress Acuity Emails",
              type: "select",
              defaultValue: "",
              options: [
                { value: "", label: "Default" },
                { value: "true", label: "Yes" },
                { value: "false", label: "No" },
              ],
            },
          ],
        },
      ],
    },
    {
      slug: "cancel-appointment",
      label: "Cancel Appointment",
      description: "Cancel an appointment in Acuity",
      category: "Acuity",
      outputFields: [
        { path: "appointment", description: "Canceled appointment payload" },
        { path: "id", description: "Canceled appointment ID" },
        { path: "canceled", description: "Cancellation flag" },
      ],
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
          options: [
            { value: "", label: "Default" },
            { value: "true", label: "Yes" },
            { value: "false", label: "No" },
          ],
        },
        {
          type: "group",
          label: "Mutation Flags",
          fields: [
            {
              key: "admin",
              label: "Run as Admin",
              type: "select",
              defaultValue: "",
              options: [
                { value: "", label: "Default" },
                { value: "true", label: "Yes" },
                { value: "false", label: "No" },
              ],
            },
            {
              key: "noEmail",
              label: "Suppress Acuity Emails",
              type: "select",
              defaultValue: "",
              options: [
                { value: "", label: "Default" },
                { value: "true", label: "Yes" },
                { value: "false", label: "No" },
              ],
            },
          ],
        },
      ],
    },
  ],
};

registerIntegration(acuityPlugin);

export default acuityPlugin;

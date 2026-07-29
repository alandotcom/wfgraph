import { findActionById } from "@rova/shared/plugins/registry";
import { describe, expect, it } from "vitest";
import "#src/acuity/index";

/**
 * What a node downstream of an Acuity node can reference.
 *
 * Every path the hand-written lists carried is still here with its exact
 * description -- `appointment`, `id`, `datetime`, `canceled`, the four array
 * names and the four counts. What is new is the inside of those payloads: an
 * appointment used to be one entry a template could name and then had nothing
 * to do with, and its own fields are addressable now, in a list and on their
 * own.
 */

/** An appointment's own fields, which four actions offer under two prefixes. */
const APPOINTMENT_LEAVES = [
  {
    path: "id",
    description: "Appointment ID",
    type: "number",
  },
  {
    path: "firstName",
    description: "Client first name",
    type: "string",
  },
  {
    path: "lastName",
    description: "Client last name",
    type: "string",
  },
  {
    path: "email",
    description: "Client email address",
    type: "string",
  },
  {
    path: "phone",
    description: "Client phone number",
    type: "string",
    nullable: true,
  },
  {
    path: "date",
    description: "Appointment date, as Acuity writes it for people",
    type: "string",
  },
  {
    path: "endDate",
    description: "Appointment end date, as Acuity writes it for people",
    type: "string",
    nullable: true,
  },
  {
    path: "time",
    description: "Appointment start time",
    type: "string",
  },
  {
    path: "endTime",
    description: "Appointment end time",
    type: "string",
    nullable: true,
  },
  {
    path: "duration",
    description: "Duration in minutes",
    type: "string",
  },
  {
    path: "datetime",
    description: "Appointment start, ISO 8601 with offset",
    type: "string",
  },
  {
    path: "type",
    description: "Appointment type name",
    type: "string",
  },
  {
    path: "appointmentTypeID",
    description: "Appointment type ID",
    type: "number",
  },
  {
    path: "calendar",
    description: "Calendar name",
    type: "string",
  },
  {
    path: "calendarID",
    description: "Calendar ID",
    type: "number",
  },
  {
    path: "calendarTimeZone",
    description: "Calendar's IANA timezone",
    type: "string",
  },
  {
    path: "price",
    description: "Appointment price",
    type: "string",
    nullable: true,
  },
  {
    path: "paid",
    description: "Whether the appointment is paid",
    type: "string",
    nullable: true,
  },
  {
    path: "notes",
    description: "Appointment notes",
    type: "string",
    nullable: true,
  },
  {
    path: "forms",
    description: "Form answers on the appointment",
    type: "array",
  },
  {
    path: "forms[0].id",
    description: "Form answer ID",
    type: "number",
  },
  {
    path: "forms[0].fieldID",
    description: "Form field ID",
    type: "number",
  },
  {
    path: "forms[0].name",
    description: "Form field name",
    type: "string",
  },
  {
    path: "forms[0].isMultiple",
    description: "Whether the field accepts multiple values",
    type: "boolean",
  },
  {
    path: "forms[0].sortOrder",
    description: "Display order of the field",
    type: "number",
  },
  {
    path: "noShow",
    description: "Marked as a no-show",
    type: "boolean",
    nullable: true,
  },
  {
    path: "canceled",
    description: "Whether the appointment is canceled",
    type: "boolean",
    nullable: true,
  },
];

/** The same fields, addressed under the prefix the action puts them behind. */
function leavesUnder(prefix: string) {
  return APPOINTMENT_LEAVES.map((field) => ({
    ...field,
    path: `${prefix}.${field.path}`,
  }));
}

describe("acuity output fields", () => {
  it("offers each appointment type's own fields", () => {
    const action = findActionById("acuity/list-appointment-types");

    expect(action?.outputFields).toEqual([
      {
        path: "appointmentTypes",
        description: "Array of appointment types",
        type: "array",
      },
      {
        path: "appointmentTypes[0].id",
        description: "Appointment type ID",
        type: "number",
      },
      {
        path: "appointmentTypes[0].name",
        description: "Appointment type name",
        type: "string",
      },
      {
        path: "appointmentTypes[0].active",
        description: "Whether the type is bookable",
        type: "boolean",
      },
      {
        path: "appointmentTypes[0].description",
        description: "Appointment type description",
        type: "string",
        nullable: true,
      },
      {
        path: "appointmentTypes[0].duration",
        description: "Duration in minutes",
        type: "number",
      },
      {
        path: "appointmentTypes[0].category",
        description: "Category name",
        type: "string",
        nullable: true,
      },
      {
        path: "appointmentTypes[0].color",
        description: "Calendar colour",
        type: "string",
        nullable: true,
      },
      {
        path: "appointmentTypes[0].private",
        description: "Whether the type is hidden from the public scheduler",
        type: "boolean",
      },
      {
        path: "appointmentTypes[0].type",
        description: "Kind of type: service, class, or series",
        type: "string",
        enumValues: ["service", "class", "series"],
      },
      {
        path: "appointmentTypes[0].classSize",
        description: "Seats in a class, if it is one",
        type: "number",
        nullable: true,
      },
      {
        path: "appointmentTypes[0].paddingAfter",
        description: "Minutes of padding after the appointment",
        type: "number",
        nullable: true,
      },
      {
        path: "appointmentTypes[0].paddingBefore",
        description: "Minutes of padding before the appointment",
        type: "number",
        nullable: true,
      },
      {
        path: "appointmentTypes[0].calendarIDs",
        description: "Calendars offering this type",
        type: "array",
      },
      {
        path: "count",
        description: "Number of appointment types returned",
        type: "number",
      },
    ]);
  });

  it("offers the inside of the appointment list", () => {
    const action = findActionById("acuity/list-appointments");

    expect(action?.outputFields).toEqual([
      {
        path: "appointments",
        description: "Array of appointments",
        type: "array",
      },
      ...leavesUnder("appointments[0]"),
      {
        path: "count",
        description: "Number of appointments returned",
        type: "number",
      },
    ]);
  });

  it("offers the whole appointment for get-appointment", () => {
    const action = findActionById("acuity/get-appointment");

    expect(action?.outputFields).toEqual([
      {
        path: "appointment",
        description: "The appointment details",
        type: "object",
      },
      ...leavesUnder("appointment"),
      { path: "id", description: "Appointment ID", type: "number" },
      {
        path: "datetime",
        description: "Appointment datetime",
        type: "string",
      },
    ]);
  });

  it("offers the available dates", () => {
    const action = findActionById("acuity/get-availability-dates");

    expect(action?.outputFields).toEqual([
      {
        path: "dates",
        description: "Available dates",
        type: "array",
      },
      {
        path: "dates[0].date",
        description: "Available date, YYYY-MM-DD",
        type: "string",
      },
      {
        path: "count",
        description: "Number of dates returned",
        type: "number",
      },
    ]);
  });

  it("offers the available times", () => {
    const action = findActionById("acuity/get-availability-times");

    expect(action?.outputFields).toEqual([
      {
        path: "slots",
        description: "Available time slots",
        type: "array",
      },
      {
        path: "slots[0].time",
        description: "Bookable slot, ISO 8601 with offset",
        type: "string",
      },
      {
        path: "count",
        description: "Number of slots returned",
        type: "number",
      },
    ]);
  });

  it("offers the whole appointment for create-appointment", () => {
    const action = findActionById("acuity/create-appointment");

    expect(action?.outputFields).toEqual([
      {
        path: "appointment",
        description: "Created appointment payload",
        type: "object",
      },
      ...leavesUnder("appointment"),
      { path: "id", description: "Created appointment ID", type: "number" },
      {
        path: "datetime",
        description: "Created appointment datetime",
        type: "string",
      },
    ]);
  });

  it("offers the whole appointment for reschedule-appointment", () => {
    const action = findActionById("acuity/reschedule-appointment");

    expect(action?.outputFields).toEqual([
      {
        path: "appointment",
        description: "Rescheduled appointment payload",
        type: "object",
      },
      ...leavesUnder("appointment"),
      { path: "id", description: "Appointment ID", type: "number" },
      {
        path: "datetime",
        description: "New appointment datetime",
        type: "string",
      },
    ]);
  });

  it("offers the whole appointment for cancel-appointment", () => {
    const action = findActionById("acuity/cancel-appointment");

    expect(action?.outputFields).toEqual([
      {
        path: "appointment",
        description: "Canceled appointment payload",
        type: "object",
      },
      ...leavesUnder("appointment"),
      { path: "id", description: "Canceled appointment ID", type: "number" },
      {
        path: "canceled",
        description: "Cancellation flag",
        type: "boolean",
        nullable: true,
      },
    ]);
  });
});

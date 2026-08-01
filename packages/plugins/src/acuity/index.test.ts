import { requireOutputFieldsFromSchema } from "@rova/core/plugin";
import { describe, expect, it } from "vitest";
import { acuity } from "#src/acuity/index";

function outputFieldsOf(slug: keyof typeof acuity.actions) {
  return requireOutputFieldsFromSchema(
    `Action "acuity/${slug}"`,
    acuity.actions[slug].output
  );
}

/**
 * What a node downstream of an Acuity node can reference, and what the schemas say
 * about the payloads Acuity sends.
 *
 * The appointment cases assert individual paths rather than a full ordered list:
 * a thirty-line list per action over a system's payload is a list nobody reads and
 * everybody re-pastes. An exact list stays where the payload is this repo's own,
 * the way `twilio/index.test.ts` writes one. The wire shape itself is pinned in
 * `appointments.test.ts`, against a fixture built from a recorded response.
 */
describe("the acuity integration", () => {
  const appointmentActions = [
    "list-appointments",
    "get-appointment",
    "create-appointment",
    "reschedule-appointment",
    "cancel-appointment",
  ] as const;

  // Nothing registers on import. The value is the whole of what an integration is,
  // and the line that passes it to `createRovaApp` is what turns it on. The slug is
  // the record key and nowhere else, so an id like "acuity/get-appointment" is
  // computed at assembly rather than written here.
  it("declares its credentials and its actions as one value", () => {
    expect(acuity.type).toBe("acuity");
    expect(acuity.label).toBe("Acuity");
    expect(acuity.test).toBeDefined();
    expect(Object.keys(acuity.credentials)).toEqual([
      "ACUITY_USER_ID",
      "ACUITY_API_KEY",
    ]);
    expect(Object.keys(acuity.actions)).toEqual([
      "list-appointment-types",
      "list-appointments",
      "get-appointment",
      "get-availability-dates",
      "get-availability-times",
      "create-appointment",
      "reschedule-appointment",
      "cancel-appointment",
    ]);
  });

  // These paths are asserted rather than taken on the system's word. An SDK type is
  // a claim about the wire, and this one was wrong twice before 0.1.0 fixed it: it
  // named the timezone `calendarTimeZone` where Acuity sends `timezone`, and it put
  // an intake answer one level above where it lives.
  it.each(appointmentActions)(
    "describes %s's appointment as Acuity sends it",
    (slug) => {
      const paths = outputFieldsOf(slug).map((field) => field.path);
      const prefix =
        slug === "list-appointments" ? "appointments[0]" : "appointment";

      expect(paths).toContain(`${prefix}.timezone`);
      expect(paths).toContain(`${prefix}.forms`);
      expect(paths).not.toContain(`${prefix}.calendarTimeZone`);
      // Two levels down, which is where an intake answer actually lives. The picker
      // lists three segments at most, so the answer's own fields are reached from
      // `forms` rather than offered beside it.
      expect(paths).toContain(`${prefix}.forms[0].values`);
    }
  );

  // Each action answers with the payload and the one or two fields a downstream node
  // reaches for most: the id it just acted on, or the count it listed.
  it("keeps each action's own paths beside the payload", () => {
    expect(outputFieldsOf("list-appointments").map((f) => f.path)).toContain(
      "count"
    );

    for (const slug of [
      "get-appointment",
      "create-appointment",
      "reschedule-appointment",
      "cancel-appointment",
    ] as const) {
      expect(outputFieldsOf(slug).map((f) => f.path)).toContain("id");
    }
  });

  it("offers each appointment type's own fields", () => {
    const fields = outputFieldsOf("list-appointment-types");
    const paths = fields.map((field) => field.path);

    expect(paths).toContain("appointmentTypes");
    expect(paths).toContain("appointmentTypes[0].name");
    expect(paths).toContain("appointmentTypes[0].duration");
    expect(paths).toContain("count");
    // A string on some types and a number on others, so the picker has no single
    // type for it and drops it. The schema still carries it, so it survives the
    // encode into the run log.
    expect(paths).not.toContain("appointmentTypes[0].price");
    expect(
      fields.find((field) => field.path === "appointmentTypes[0].category")
    ).toEqual({
      path: "appointmentTypes[0].category",
      description: "Category name",
      type: "string",
      nullable: true,
    });
  });

  it("offers the available dates", () => {
    expect(outputFieldsOf("get-availability-dates")).toEqual([
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
    expect(outputFieldsOf("get-availability-times")).toEqual([
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
});

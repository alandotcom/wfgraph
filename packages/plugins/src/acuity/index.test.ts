import { requireOutputFieldsFromSchema } from "@rova/shared/workflow/output-fields";
import { describe, expect, it } from "vitest";
import { acuity } from "#src/acuity/index";

function outputFieldsOf(slug: keyof typeof acuity.actions) {
  return requireOutputFieldsFromSchema(
    `Action "acuity/${slug}"`,
    acuity.actions[slug].output
  );
}

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

/** The same fields, addressed under the prefix the action puts them behind. */

/**
 * What a node downstream of an Acuity node can reference, and what the schemas say
 * about the payloads Acuity sends.
 *
 * The appointment cases assert paths rather than a full ordered list: what matters
 * about them is the correction, and a thirty-line list per action is a list nobody
 * reads and everybody re-pastes. `send-sms`-style exact lists stay where the payload
 * is this repo's own. The wire shape itself is pinned in `acuity-steps.test.ts`,
 * against a fixture built from a recorded response.
 */
describe("the acuity integration", () => {
  const appointmentActions = [
    "list-appointments",
    "get-appointment",
    "create-appointment",
    "reschedule-appointment",
    "cancel-appointment",
  ] as const;

  it("declares its credentials and its eight actions", () => {
    expect(acuity.type).toBe("acuity");
    expect(acuity.test).toBeDefined();
    expect(acuity.credentials.map((field) => field.envVar)).toEqual([
      "ACUITY_USER_ID",
      "ACUITY_API_KEY",
    ]);
    expect(Object.keys(acuity.actions)).toHaveLength(8);
  });

  // The correction this batch made: `forms` is a list of forms, each holding its own
  // answers, and the timezone Acuity sends is `timezone`. The previous schema
  // described the answers one level up and insisted on a `calendarTimeZone` the API
  // does not send, which failed the encode of every appointment carrying a form.
  it.each(appointmentActions)(
    "describes %s's appointment as Acuity sends it",
    (slug) => {
      const paths = outputFieldsOf(slug).map((field) => field.path);
      const prefix =
        slug === "list-appointments" ? "appointments[0]" : "appointment";

      expect(paths).toContain(`${prefix}.timezone`);
      expect(paths).toContain(`${prefix}.forms`);
      expect(paths).not.toContain(`${prefix}.calendarTimeZone`);
      expect(paths).not.toContain(`${prefix}.calendarTimezone`);
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

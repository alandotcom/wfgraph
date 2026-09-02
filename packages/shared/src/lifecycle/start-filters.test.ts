import { describe, expect, it } from "vitest";
import type { ExtensionCatalog } from "#src/extensions/catalog";
import {
  EVENT_NAME_FIELD_PATH,
  serializeConditionModel,
} from "#src/conditions/conditions";
import type {
  LifecycleRules,
  LifecycleRulesCheck,
} from "#src/lifecycle/lifecycle-rules";
import {
  carryStartFilterToAddedEvents,
  checkStartFilters,
  pruneStartFilters,
  readStartFilterLayout,
  setStartFilterForAll,
  setStartFilterForEvent,
} from "./start-filters";

/** The sentence a refused save is shown, or a failure naming the acceptance. */
function refusalOf(check: LifecycleRulesCheck): string {
  if (check.valid) {
    throw new Error("Expected these Lifecycle Rules to be refused");
  }
  return check.error;
}

/**
 * Two Events sharing a path, one declaring a path the other does not, and one
 * carrying an open record. That is every shape a filter has to be held to.
 */
const catalog: ExtensionCatalog = {
  events: [
    {
      name: "app/appointment.created",
      label: "Appointment created",
      correlationPath: "appointment.id",
      payloadFields: [
        { path: "appointment.id", type: "string" },
        { path: "appointment.channel", type: "string" },
      ],
    },
    {
      name: "app/appointment.canceled",
      label: "Appointment canceled",
      correlationPath: "appointment.id",
      payloadFields: [
        { path: "appointment.id", type: "string" },
        { path: "appointment.reason", type: "string" },
      ],
    },
    {
      name: "ops/nightly.swept",
      label: "Nightly sweep finished",
      payloadFields: [],
    },
    {
      name: "resend/email.sent",
      label: "Email sent",
      integration: "resend",
      correlationPath: "data.email_id",
      // `tags` is an open record: an object taking keys no schema lists, which
      // is what Resend's email tags are.
      payloadFields: [
        { path: "data.email_id", type: "string" },
        { path: "tags", type: "string", valueType: "string" },
      ],
    },
  ],
  actions: [],
  integrations: [
    {
      type: "resend",
      label: "Resend",
      description: "Transactional email",
      credentialFields: {},
      hasTest: false,
      hasWebhook: true,
    },
  ],
};

function rules(overrides: Partial<LifecycleRules> = {}): LifecycleRules {
  return {
    startEvents: ["app/appointment.created"],
    cancelEvents: [],
    concurrency: "newest-wins",
    ...overrides,
  };
}

/**
 * A finished one-rule filter over `path`, as the panel would serialize it.
 *
 * `ids` is what the builder's editor generates per rule, and two filters written
 * separately never share them. The layout compares meaning rather than text for
 * that reason, and passing them here is how a case says so.
 */
function filterOn(path: string, value = "video", ids = "a"): string {
  return serializeConditionModel({
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: `group-${ids}`,
        logic: "and",
        conditions: [
          {
            id: `rule-${ids}`,
            field: path,
            fieldType: "string",
            operator: "equals",
            value,
          },
        ],
      },
    ],
  });
}

describe("readStartFilterLayout", () => {
  it("collapses a group whose Start Events hold the same filter", () => {
    const filter = filterOn("appointment.channel");

    expect(
      readStartFilterLayout(
        rules({
          startEvents: ["app/appointment.created", "app/appointment.canceled"],
          startFilters: {
            "app/appointment.created": filter,
            "app/appointment.canceled": filter,
          },
        })
      )
    ).toEqual({ collapsed: true, model: filter });
  });

  it("collapses a group where no Start Event holds one", () => {
    expect(readStartFilterLayout(rules())).toEqual({ collapsed: true });
  });

  // The half-filtered group is the case one control could not describe: it would
  // have to show a rule that governs one Event and not the other.
  it("expands a group where one Start Event holds a filter and one does not", () => {
    expect(
      readStartFilterLayout(
        rules({
          startEvents: ["app/appointment.created", "app/appointment.canceled"],
          startFilters: {
            "app/appointment.created": filterOn("appointment.id"),
          },
        })
      )
    ).toEqual({ collapsed: false });
  });

  // Two Events given the same rule separately carry different generated ids.
  // Comparing the stored text would call those two filters and never offer the
  // group back to one control.
  it("collapses filters that mean the same thing under different ids", () => {
    expect(
      readStartFilterLayout(
        rules({
          startEvents: ["app/appointment.created", "app/appointment.canceled"],
          startFilters: {
            "app/appointment.created": filterOn("appointment.id", "x", "a"),
            "app/appointment.canceled": filterOn("appointment.id", "x", "b"),
          },
        })
      ).collapsed
    ).toBe(true);
  });

  it("expands a group whose Start Events hold different filters", () => {
    expect(
      readStartFilterLayout(
        rules({
          startEvents: ["app/appointment.created", "app/appointment.canceled"],
          startFilters: {
            "app/appointment.created": filterOn("appointment.id", "a"),
            "app/appointment.canceled": filterOn("appointment.id", "b"),
          },
        })
      )
    ).toEqual({ collapsed: false });
  });

  it("ignores a filter stored for an Event that no longer starts the workflow", () => {
    expect(
      readStartFilterLayout(
        rules({
          startEvents: ["app/appointment.created"],
          startFilters: { "ops/nightly.swept": filterOn("appointment.id") },
        })
      )
    ).toEqual({ collapsed: true });
  });
});

describe("setStartFilterForAll", () => {
  it("writes one filter to every Start Event", () => {
    const filter = filterOn("appointment.id");
    const next = setStartFilterForAll(
      rules({
        startEvents: ["app/appointment.created", "app/appointment.canceled"],
      }),
      filter
    );

    expect(next.startFilters).toEqual({
      "app/appointment.created": filter,
      "app/appointment.canceled": filter,
    });
  });

  it("drops the key entirely when the filter is cleared", () => {
    const next = setStartFilterForAll(
      rules({ startFilters: { "app/appointment.created": filterOn("x") } }),
      undefined
    );

    expect(next.startFilters).toBeUndefined();
  });
});

describe("setStartFilterForEvent", () => {
  it("leaves the other Start Events alone", () => {
    const kept = filterOn("appointment.id", "kept");
    const next = setStartFilterForEvent({
      rules: rules({
        startEvents: ["app/appointment.created", "app/appointment.canceled"],
        startFilters: {
          "app/appointment.created": kept,
          "app/appointment.canceled": filterOn("appointment.id", "replaced"),
        },
      }),
      eventName: "app/appointment.canceled",
      model: filterOn("appointment.reason", "next"),
    });

    expect(next.startFilters?.["app/appointment.created"]).toBe(kept);
    expect(next.startFilters?.["app/appointment.canceled"]).toBe(
      filterOn("appointment.reason", "next")
    );
  });

  it("removes one Event's filter without disturbing the rest", () => {
    const next = setStartFilterForEvent({
      rules: rules({
        startEvents: ["app/appointment.created", "app/appointment.canceled"],
        startFilters: {
          "app/appointment.created": filterOn("appointment.id"),
          "app/appointment.canceled": filterOn("appointment.id"),
        },
      }),
      eventName: "app/appointment.created",
      model: undefined,
    });

    expect(Object.keys(next.startFilters ?? {})).toEqual([
      "app/appointment.canceled",
    ]);
  });
});

describe("carryStartFilterToAddedEvents", () => {
  it("stamps a shared filter onto a Start Event just added", () => {
    const filter = filterOn("appointment.id");
    const previous = rules({
      startEvents: ["app/appointment.created"],
      startFilters: { "app/appointment.created": filter },
    });

    const next = carryStartFilterToAddedEvents({
      catalog,
      previous,
      next: {
        ...previous,
        startEvents: ["app/appointment.created", "app/appointment.canceled"],
      },
    });

    expect(next.startFilters).toEqual({
      "app/appointment.created": filter,
      "app/appointment.canceled": filter,
    });
  });

  // The distinction the previous rules are read for: a builder who split the
  // group and cleared one Event meant it, and a stamp would undo that on the
  // next unrelated edit.
  it("leaves a deliberately cleared Start Event cleared", () => {
    const previous = rules({
      startEvents: ["app/appointment.created", "app/appointment.canceled"],
      startFilters: { "app/appointment.created": filterOn("appointment.id") },
    });

    const next = carryStartFilterToAddedEvents({
      catalog,
      previous,
      next: {
        ...previous,
        startEvents: [
          "app/appointment.created",
          "app/appointment.canceled",
          "ops/nightly.swept",
        ],
      },
    });

    expect(next.startFilters).toEqual(previous.startFilters);
  });
});

describe("pruneStartFilters", () => {
  it("drops the filter of an Event that lost the start role", () => {
    const next = pruneStartFilters(
      rules({
        startEvents: ["app/appointment.created"],
        startFilters: {
          "app/appointment.created": filterOn("appointment.id"),
          "app/appointment.canceled": filterOn("appointment.id"),
        },
      })
    );

    expect(Object.keys(next.startFilters ?? {})).toEqual([
      "app/appointment.created",
    ]);
  });

  it("leaves the key absent when nothing is left", () => {
    const next = pruneStartFilters(
      rules({
        startEvents: [],
        allowManualStart: true,
        startFilters: { "app/appointment.created": filterOn("appointment.id") },
      })
    );

    expect(next.startFilters).toBeUndefined();
  });
});

describe("checkStartFilters", () => {
  it("accepts a filter over a field the Start Event declares", () => {
    expect(
      checkStartFilters({
        rules: rules({
          startFilters: {
            "app/appointment.created": filterOn("appointment.channel"),
          },
        }),
        catalog,
      }).valid
    ).toBe(true);
  });

  it("accepts a filter naming the arriving Event", () => {
    expect(
      checkStartFilters({
        rules: rules({
          startEvents: ["app/appointment.created", "app/appointment.canceled"],
          startFilters: {
            "app/appointment.created": filterOn(
              EVENT_NAME_FIELD_PATH,
              "app/appointment.created"
            ),
            "app/appointment.canceled": filterOn(
              EVENT_NAME_FIELD_PATH,
              "app/appointment.created"
            ),
          },
        }),
        catalog,
      }).valid
    ).toBe(true);
  });

  it("refuses an unfinished filter", () => {
    const check = checkStartFilters({
      rules: rules({
        startFilters: {
          "app/appointment.created": filterOn("appointment.channel", ""),
        },
      }),
      catalog,
    });

    expect(refusalOf(check)).toContain("unfinished");
  });

  // The silent failure this exists for: the rule compiles, evaluates, and reads
  // false on every arrival, so the workflow simply stops starting.
  it("refuses a filter reading a field the Start Event does not carry", () => {
    const check = checkStartFilters({
      rules: rules({
        startFilters: {
          "app/appointment.created": filterOn("appointment.reason"),
        },
      }),
      catalog,
    });

    expect(refusalOf(check)).toContain("appointment.reason");
  });

  it("refuses a filter comparing against a value from a run", () => {
    const check = checkStartFilters({
      rules: rules({
        startFilters: {
          "app/appointment.created": filterOn(
            "appointment.channel",
            "{{@node1:Lookup.channel}}"
          ),
        },
      }),
      catalog,
    });

    expect(refusalOf(check)).toContain("before a run exists");
  });

  it("refuses a filter that is not a condition model at all", () => {
    const check = checkStartFilters({
      rules: rules({ startFilters: { "app/appointment.created": "{" } }),
      catalog,
    });

    expect(refusalOf(check)).toContain("app/appointment.created");
  });

  it("ignores a filter stored for an Event with no start role", () => {
    expect(
      checkStartFilters({
        rules: rules({
          startFilters: { "ops/nightly.swept": filterOn("nothing.here") },
        }),
        catalog,
      }).valid
    ).toBe(true);
  });
});

describe("carryStartFilterToAddedEvents and undeclared fields", () => {
  // Stamping here would manufacture the exact state `checkStartFilters` refuses:
  // a rule reading a path the Event never carries, which reads false on every
  // one of its arrivals.
  it("leaves an added Event unfiltered when it lacks the filter's field", () => {
    const filter = filterOn("appointment.channel");
    const previous = rules({
      startEvents: ["app/appointment.created"],
      startFilters: { "app/appointment.created": filter },
    });

    const next = carryStartFilterToAddedEvents({
      catalog,
      previous,
      next: {
        ...previous,
        startEvents: ["app/appointment.created", "app/appointment.canceled"],
      },
    });

    expect(next.startFilters).toEqual({ "app/appointment.created": filter });
  });
});

/**
 * A rule on an open record's key names the record and keeps the key beside it,
 * and a rule that names the joined path means the same thing. Neither can be
 * held to the declared paths directly, because the keys of a record are exactly
 * what no schema lists.
 */
describe("checkStartFilters over an open record", () => {
  function filterOnRule(rule: Record<string, unknown>): string {
    return serializeConditionModel({
      version: 2,
      groupLogic: "and",
      groups: [{ id: "group", logic: "and", conditions: [rule as never] }],
    });
  }

  function checkRule(rule: Record<string, unknown>): LifecycleRulesCheck {
    return checkStartFilters({
      rules: rules({
        startEvents: ["resend/email.sent"],
        connectionIds: { "resend/email.sent": "conn_1" },
        startFilters: { "resend/email.sent": filterOnRule(rule) },
      }),
      catalog,
    });
  }

  it("accepts the record and its key stored apart", () => {
    expect(
      checkRule({
        id: "r",
        field: "tags",
        recordKey: "order",
        fieldType: "string",
        operator: "equals",
        value: "x",
      }).valid
    ).toBe(true);
  });

  it("accepts the key joined onto the record's path", () => {
    expect(
      checkRule({
        id: "r",
        field: "tags.order",
        fieldType: "string",
        operator: "equals",
        value: "x",
      }).valid
    ).toBe(true);
  });

  it("still refuses a path that is under no declared record", () => {
    expect(
      refusalOf(
        checkRule({
          id: "r",
          field: "labels.order",
          fieldType: "string",
          operator: "equals",
          value: "x",
        })
      )
    ).toContain("labels.order");
  });
});

/**
 * A run reference is a `{{@nodeId:Label.field}}` token, and the publish check
 * reads it with the grammar that defines one. Looking for `{{` alone would
 * refuse a payload value that merely contains braces.
 */
describe("checkStartFilters over brace-bearing literals", () => {
  const check = (value: string) =>
    checkStartFilters({
      rules: rules({
        startFilters: {
          "app/appointment.created": filterOn("appointment.channel", value),
        },
      }),
      catalog,
    });

  it("refuses an operand holding a run reference", () => {
    expect(refusalOf(check("{{@node1:Lookup.channel}}"))).toContain(
      "before a run exists"
    );
  });

  it("accepts an operand whose braces are part of the value", () => {
    expect(check("{{pending}}").valid).toBe(true);
  });

  it("accepts a value with a single brace pair", () => {
    expect(check("{status}").valid).toBe(true);
  });
});

/**
 * A rule stores the type it was built against, and the compiler emits that
 * type's operators. When the Event Author retypes the field underneath it, the
 * rule compares a number against what is now a string, and every arrival is
 * refused as unevaluable. Publish can see the disagreement, so it says so while
 * the rule can still be rebuilt.
 */
describe("checkStartFilters over a retyped field", () => {
  /** The catalog after the author changed `appointment.channel` to a number. */
  const retyped: ExtensionCatalog = {
    ...catalog,
    events: catalog.events.map((event) =>
      event.name === "app/appointment.created"
        ? {
            ...event,
            payloadFields: [
              { path: "appointment.id", type: "string" as const },
              { path: "appointment.channel", type: "number" as const },
            ],
          }
        : event
    ),
  };

  const filtered = rules({
    startFilters: {
      "app/appointment.created": filterOn("appointment.channel"),
    },
  });

  it("accepts the rule while the declaration still agrees", () => {
    expect(checkStartFilters({ rules: filtered, catalog }).valid).toBe(true);
  });

  it("refuses a rule whose type the Event no longer declares", () => {
    const refusal = refusalOf(
      checkStartFilters({ rules: filtered, catalog: retyped })
    );

    expect(refusal).toContain("appointment.channel");
    expect(refusal).toContain("number");
  });

  // A null check compares nothing, so no retyping can leave it unanswerable.
  it("accepts a presence check whatever the field's type", () => {
    const presence = rules({
      startFilters: {
        "app/appointment.created": serializeConditionModel({
          version: 2,
          groupLogic: "and",
          groups: [
            {
              id: "group",
              logic: "and",
              conditions: [
                {
                  id: "rule",
                  field: "appointment.channel",
                  fieldType: "string",
                  operator: "is_set",
                },
              ],
            },
          ],
        }),
      },
    });

    expect(checkStartFilters({ rules: presence, catalog: retyped }).valid).toBe(
      true
    );
  });
});

/**
 * A rule on an open record's key names the record and keeps the key beside it.
 * An Event that declares the joined path outright answers the same read, so the
 * check accepts either declaration rather than refusing a rule that would run.
 */
describe("checkStartFilters over a record key stored apart", () => {
  const flatCatalog: ExtensionCatalog = {
    ...catalog,
    events: catalog.events.map((event) =>
      event.name === "app/appointment.created"
        ? {
            ...event,
            payloadFields: [
              { path: "appointment.id", type: "string" as const },
              { path: "tags.order", type: "string" as const },
            ],
          }
        : event
    ),
  };

  const keyRule = serializeConditionModel({
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: "group",
        logic: "and",
        conditions: [
          {
            id: "rule",
            field: "tags",
            recordKey: "order",
            fieldType: "string",
            operator: "equals",
            value: "o_1",
          },
        ],
      },
    ],
  });

  const filtered = rules({
    startFilters: { "app/appointment.created": keyRule },
  });

  it("accepts the rule where the Event declares the record", () => {
    expect(
      checkStartFilters({
        rules: rules({
          startEvents: ["resend/email.sent"],
          connectionIds: { "resend/email.sent": "conn_1" },
          startFilters: { "resend/email.sent": keyRule },
        }),
        catalog,
      }).valid
    ).toBe(true);
  });

  it("accepts the rule where the Event declares the joined path", () => {
    expect(
      checkStartFilters({ rules: filtered, catalog: flatCatalog }).valid
    ).toBe(true);
  });

  it("refuses the rule where the Event declares neither", () => {
    expect(
      refusalOf(checkStartFilters({ rules: filtered, catalog }))
    ).toContain("tags");
  });
});

/**
 * The four ways a stored rule can name something the Event cannot answer, each
 * of which publishes cleanly and then refuses every arrival as unevaluable. The
 * publish check exists to say so while the rule can still be rebuilt.
 */
describe("checkStartFilters over rules the declaration cannot answer", () => {
  function ruleFilter(rule: Record<string, unknown>): string {
    return serializeConditionModel({
      version: 2,
      groupLogic: "and",
      groups: [{ id: "g", logic: "and", conditions: [rule as never] }],
    });
  }

  function withFields(
    fields: { path: string; type?: string; valueType?: string }[]
  ): ExtensionCatalog {
    return {
      ...catalog,
      events: catalog.events.map((event) =>
        event.name === "app/appointment.created"
          ? { ...event, payloadFields: fields as never }
          : event
      ),
    };
  }

  const check = (rule: Record<string, unknown>, cat: ExtensionCatalog) =>
    checkStartFilters({
      rules: rules({
        startFilters: { "app/appointment.created": ruleFilter(rule) },
      }),
      catalog: cat,
    });

  // The record became a plain string, so `payload.tags.order` reads nothing.
  it("refuses a record key whose base is no longer a record", () => {
    expect(
      refusalOf(
        check(
          {
            id: "r",
            field: "tags",
            recordKey: "order",
            fieldType: "string",
            operator: "equals",
            value: "x",
          },
          withFields([{ path: "tags", type: "string" }])
        )
      )
    ).toContain("tags");
  });

  it("accepts a record key whose base is still a record", () => {
    expect(
      check(
        {
          id: "r",
          field: "tags",
          recordKey: "order",
          fieldType: "string",
          operator: "equals",
          value: "x",
        },
        withFields([{ path: "tags", type: "object", valueType: "string" }])
      ).valid
    ).toBe(true);
  });

  // A record declares one value type, so exactly one segment sits under it.
  it("refuses a path deeper than one key under a record", () => {
    expect(
      refusalOf(
        check(
          {
            id: "r",
            field: "tags.order.status",
            fieldType: "string",
            operator: "equals",
            value: "x",
          },
          withFields([{ path: "tags", type: "object", valueType: "string" }])
        )
      )
    ).toContain("tags.order.status");
  });

  // An object offers no operators, so no rule but a presence check can read it.
  it("refuses a comparison against a shape no rule can compare", () => {
    expect(
      refusalOf(
        check(
          {
            id: "r",
            field: "metadata",
            fieldType: "number",
            operator: "greater_than",
            value: 1,
          },
          withFields([{ path: "metadata", type: "object" }])
        )
      )
    ).toContain("metadata");
  });

  it("accepts a presence check against that same shape", () => {
    expect(
      check(
        {
          id: "r",
          field: "metadata",
          fieldType: "string",
          operator: "is_set",
        },
        withFields([{ path: "metadata", type: "object" }])
      ).valid
    ).toBe(true);
  });

  // The arriving Event's name is text whatever the payload carries.
  it("refuses a non-string comparison against the Event name", () => {
    expect(
      refusalOf(
        check(
          {
            id: "r",
            field: EVENT_NAME_FIELD_PATH,
            fieldType: "number",
            operator: "greater_than",
            value: 1,
          },
          catalog
        )
      )
    ).toContain("always text");
  });
});

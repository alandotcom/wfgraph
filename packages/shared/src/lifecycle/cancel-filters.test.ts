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
  carryCancelFilterToAddedEvents,
  checkCancelFilterModels,
  checkCancelFilters,
  pruneCancelFilters,
  readCancelFilter,
  readCancelFilterLayout,
  setCancelFilterForAll,
  setCancelFilterForEvent,
} from "./cancel-filters";

function refusalOf(check: LifecycleRulesCheck): string {
  if (check.valid) {
    throw new Error("Expected these Lifecycle Rules to be refused");
  }
  return check.error;
}

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
  ],
  actions: [],
  integrations: [],
};

function rules(overrides: Partial<LifecycleRules> = {}): LifecycleRules {
  return {
    startEvents: ["app/appointment.created"],
    cancelEvents: ["app/appointment.canceled"],
    concurrency: "newest-wins",
    ...overrides,
  };
}

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

describe("cancel filter readers and writers", () => {
  it("reads one Cancel Filter and collapses equal filters", () => {
    const filter = filterOn("appointment.reason");
    const read = readCancelFilter(
      rules({ cancelFilters: { "app/appointment.canceled": filter } }),
      "app/appointment.canceled"
    );

    expect(read).toBe(filter);
    expect(
      readCancelFilterLayout(
        rules({
          cancelEvents: ["app/appointment.canceled", "app/appointment.created"],
          cancelFilters: {
            "app/appointment.canceled": filterOn("appointment.id", "x", "a"),
            "app/appointment.created": filterOn("appointment.id", "x", "b"),
          },
        })
      )
    ).toEqual({
      collapsed: true,
      model: expect.any(String),
    });
  });

  it("writes a Cancel Filter for one Event or every Cancel Event", () => {
    const filter = filterOn("appointment.reason");
    const withOne = setCancelFilterForEvent({
      rules: rules(),
      eventName: "app/appointment.canceled",
      model: filter,
    });
    const withAll = setCancelFilterForAll(
      rules({
        cancelEvents: ["app/appointment.canceled", "app/appointment.created"],
      }),
      filter
    );

    expect(withOne.cancelFilters).toEqual({
      "app/appointment.canceled": filter,
    });
    expect(withAll.cancelFilters).toEqual({
      "app/appointment.canceled": filter,
      "app/appointment.created": filter,
    });
  });

  it("keeps constructor and __proto__ as own Cancel Filter keys", () => {
    const filter = filterOn(EVENT_NAME_FIELD_PATH, "constructor");
    const specialEventNames = ["constructor", "__proto__"];
    const empty = rules({ cancelEvents: specialEventNames });

    expect(readCancelFilter(empty, "constructor")).toBeUndefined();
    expect(readCancelFilter(empty, "__proto__")).toBeUndefined();

    const withConstructor = setCancelFilterForEvent({
      rules: empty,
      eventName: "constructor",
      model: filter,
    });
    const written = setCancelFilterForEvent({
      rules: withConstructor,
      eventName: "__proto__",
      model: filter,
    });

    expect(Object.hasOwn(written.cancelFilters ?? {}, "constructor")).toBe(
      true
    );
    expect(Object.hasOwn(written.cancelFilters ?? {}, "__proto__")).toBe(true);
    expect(written.cancelFilters).toEqual(
      Object.fromEntries(
        specialEventNames.map((eventName) => [eventName, filter])
      )
    );
    expect(Object.getPrototypeOf(written.cancelFilters)).toBe(Object.prototype);
  });

  it("returns undefined for inherited special Cancel Event names", () => {
    const filter = filterOn("appointment.id");
    const withAnotherFilter = rules({
      cancelEvents: ["app/appointment.canceled", "constructor", "__proto__"],
      cancelFilters: { "app/appointment.canceled": filter },
    });
    const withAnotherFilterFromEntries = rules({
      cancelEvents: ["app/appointment.canceled", "constructor", "__proto__"],
      cancelFilters: Object.fromEntries([["app/appointment.canceled", filter]]),
    });

    expect(() =>
      readCancelFilter(withAnotherFilter, "constructor")
    ).not.toThrow();
    expect(readCancelFilter(withAnotherFilter, "constructor")).toBeUndefined();
    expect(() =>
      readCancelFilter(withAnotherFilterFromEntries, "__proto__")
    ).not.toThrow();
    expect(
      readCancelFilter(withAnotherFilterFromEntries, "__proto__")
    ).toBeUndefined();
  });

  it("carries a shared filter to an added readable Cancel Event", () => {
    const filter = filterOn("appointment.id");
    const previous = rules({
      cancelEvents: ["app/appointment.canceled"],
      cancelFilters: { "app/appointment.canceled": filter },
    });

    const next = carryCancelFilterToAddedEvents({
      catalog,
      previous,
      next: {
        ...previous,
        cancelEvents: ["app/appointment.canceled", "app/appointment.created"],
      },
    });

    expect(next.cancelFilters).toEqual({
      "app/appointment.canceled": filter,
      "app/appointment.created": filter,
    });
  });

  it("carries a Cancel Filter to an Event named __proto__", () => {
    const filter = filterOn(EVENT_NAME_FIELD_PATH, "constructor");
    const specialCatalog: ExtensionCatalog = {
      ...catalog,
      events: [
        ...catalog.events,
        { name: "constructor", label: "Constructor", payloadFields: [] },
        { name: "__proto__", label: "Prototype", payloadFields: [] },
      ],
    };
    const previous = rules({
      cancelEvents: ["constructor"],
      cancelFilters: Object.fromEntries([["constructor", filter]]),
    });

    const next = carryCancelFilterToAddedEvents({
      catalog: specialCatalog,
      previous,
      next: { ...previous, cancelEvents: ["constructor", "__proto__"] },
    });

    expect(next.cancelFilters).toEqual(
      Object.fromEntries([
        ["constructor", filter],
        ["__proto__", filter],
      ])
    );
    expect(Object.hasOwn(next.cancelFilters ?? {}, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(next.cancelFilters)).toBe(Object.prototype);
  });

  it("does not carry a filter to an Event that cannot answer it", () => {
    const filter = filterOn("appointment.reason");
    const previous = rules({
      cancelEvents: ["app/appointment.canceled"],
      cancelFilters: { "app/appointment.canceled": filter },
    });

    const next = carryCancelFilterToAddedEvents({
      catalog,
      previous,
      next: {
        ...previous,
        cancelEvents: ["app/appointment.canceled", "ops/nightly.swept"],
      },
    });

    expect(next.cancelFilters).toEqual(previous.cancelFilters);
  });

  it("prunes filters for Events that lost the cancel role", () => {
    const filter = filterOn("appointment.id");
    const next = pruneCancelFilters(
      rules({
        cancelFilters: {
          "app/appointment.canceled": filter,
          "ops/nightly.swept": filterOn("nothing.here"),
        },
      })
    );

    expect(next.cancelFilters).toEqual({
      "app/appointment.canceled": filter,
    });
  });

  it("retains special Event names as own Cancel Filter keys", () => {
    const filter = filterOn(EVENT_NAME_FIELD_PATH, "constructor");
    const next = pruneCancelFilters(
      rules({
        cancelEvents: ["constructor", "__proto__"],
        cancelFilters: Object.fromEntries([
          ["constructor", filter],
          ["__proto__", filter],
        ]),
      })
    );

    expect(next.cancelFilters).toEqual(
      Object.fromEntries([
        ["constructor", filter],
        ["__proto__", filter],
      ])
    );
    expect(Object.hasOwn(next.cancelFilters ?? {}, "constructor")).toBe(true);
    expect(Object.hasOwn(next.cancelFilters ?? {}, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(next.cancelFilters)).toBe(Object.prototype);
  });
});

describe("checkCancelFilterModels", () => {
  it("accepts a readable unfinished model during save", () => {
    expect(
      checkCancelFilterModels(
        rules({
          cancelFilters: {
            "app/appointment.canceled": filterOn("appointment.reason", ""),
          },
        })
      )
    ).toEqual({ valid: true });
  });

  it("refuses a Cancel Filter that is not a condition model", () => {
    const check = checkCancelFilterModels(
      rules({ cancelFilters: { "app/appointment.canceled": "{" } })
    );

    expect(refusalOf(check)).toContain("cancel filter");
  });
});

describe("checkCancelFilters", () => {
  it("accepts a Cancel Filter over a field the Cancel Event declares", () => {
    expect(
      checkCancelFilters({
        rules: rules({
          cancelFilters: {
            "app/appointment.canceled": filterOn("appointment.reason"),
          },
        }),
        catalog,
      }).valid
    ).toBe(true);
  });

  it("refuses a filter that reads a value from a run", () => {
    const check = checkCancelFilters({
      rules: rules({
        cancelFilters: {
          "app/appointment.canceled": filterOn(
            "appointment.reason",
            "{{@node1:Lookup.reason}}"
          ),
        },
      }),
      catalog,
    });

    const message = refusalOf(check);
    expect(message).toContain("cancel filter");
    expect(message).toContain("before cancellation");
  });

  it("refuses a filter reading a field the Cancel Event does not carry", () => {
    const check = checkCancelFilters({
      rules: rules({
        cancelFilters: {
          "app/appointment.canceled": filterOn("appointment.channel"),
        },
      }),
      catalog,
    });

    expect(refusalOf(check)).toContain("appointment.channel");
  });

  it("accepts a filter naming the arriving Event", () => {
    expect(
      checkCancelFilters({
        rules: rules({
          cancelFilters: {
            "app/appointment.canceled": filterOn(
              EVENT_NAME_FIELD_PATH,
              "app/appointment.canceled"
            ),
          },
        }),
        catalog,
      }).valid
    ).toBe(true);
  });
});

import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { ExtensionCatalog } from "#src/extensions/catalog";
import { rejectUnknownKeys } from "#src/types/schema";
import {
  checkLifecycleRules,
  eventsNeedingCorrelationPath,
  hasStartSource,
  type LifecycleRules,
  type LifecycleRulesCheck,
  lifecycleRulesSchema,
  manualStartAllowed,
  readLifecycleRules,
  resolveCorrelationPath,
} from "./lifecycle-rules";

/** The sentence a refused save is shown, or a failure naming the acceptance. */
function refusalOf(check: LifecycleRulesCheck): string {
  if (check.valid) {
    throw new Error("Expected these Lifecycle Rules to be refused");
  }
  return check.error;
}

/**
 * Two Events with a Correlation Path and one without, which is the shape every
 * rule below is stated over.
 */
const catalog: ExtensionCatalog = {
  events: [
    {
      name: "app/appointment.created",
      label: "Appointment created",
      correlationPath: "appointment.id",
      payloadFields: [],
    },
    {
      name: "app/appointment.canceled",
      label: "Appointment canceled",
      correlationPath: "appointment.id",
      payloadFields: [],
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
    startEvent: "app/appointment.created",
    cancelEvents: [],
    concurrency: "newest-wins",
    ...overrides,
  };
}

const decode = Schema.decodeUnknownResult(
  lifecycleRulesSchema,
  rejectUnknownKeys
);

describe("lifecycleRulesSchema", () => {
  it("decodes the rules the panel writes", () => {
    const decoded = Schema.decodeUnknownSync(
      lifecycleRulesSchema,
      rejectUnknownKeys
    )({
      startEvent: "app/appointment.created",
      cancelEvents: [],
      concurrency: "first-wins",
      allowManualStart: true,
      correlationPaths: { "ops/nightly.swept": "sweep.id" },
    });

    expect(decoded.concurrency).toBe("first-wins");
    expect(decoded.allowManualStart).toBe(true);
    expect(decoded.correlationPaths).toEqual({
      "ops/nightly.swept": "sweep.id",
    });
  });

  it("refuses a concurrency it has never heard of", () => {
    expect(
      decode({
        cancelEvents: [],
        concurrency: "replace",
      })._tag
    ).toBe("Failure");
  });

  it("refuses a blank Event name", () => {
    expect(
      decode({
        startEvent: "  ",
        cancelEvents: [],
        concurrency: "unlimited",
      })._tag
    ).toBe("Failure");
  });
});

describe("readLifecycleRules", () => {
  it("reads the rules off an entry node's config", () => {
    const read = readLifecycleRules({
      lifecycleRules: {
        startEvent: "app/appointment.created",
        cancelEvents: [],
        concurrency: "unlimited",
      },
    });

    expect(read?.startEvent).toBe("app/appointment.created");
  });

  it("answers undefined for a config carrying none", () => {
    expect(readLifecycleRules({ someOtherKey: "[]" })).toBeUndefined();
    expect(readLifecycleRules(undefined)).toBeUndefined();
  });

  it("answers undefined for rules that do not fit the shape", () => {
    expect(
      readLifecycleRules({ lifecycleRules: { concurrency: "replace" } })
    ).toBeUndefined();
  });
});

describe("resolveCorrelationPath", () => {
  it("prefers the path the Event Author declared", () => {
    expect(
      resolveCorrelationPath({
        rules: rules({ correlationPaths: { "ops/nightly.swept": "sweep.id" } }),
        eventName: "ops/nightly.swept",
        declaredPath: "declared.id",
      })
    ).toBe("declared.id");
  });

  it("falls to the path the builder supplied", () => {
    expect(
      resolveCorrelationPath({
        rules: rules({ correlationPaths: { "ops/nightly.swept": "sweep.id" } }),
        eventName: "ops/nightly.swept",
      })
    ).toBe("sweep.id");
  });
});

describe("checkLifecycleRules", () => {
  it("accepts a workflow starting on one Event", () => {
    expect(checkLifecycleRules({ rules: rules(), catalog })).toEqual({
      valid: true,
    });
  });

  it("refuses one Event holding both roles", () => {
    const check = checkLifecycleRules({
      rules: rules({
        startEvent: "app/appointment.created",
        cancelEvents: ["app/appointment.created"],
      }),
      catalog,
    });

    expect(refusalOf(check)).toContain("cannot both start and cancel");
  });

  it("names an Event the catalog does not hold", () => {
    const check = checkLifecycleRules({
      rules: rules({ startEvent: "app/appointment.moved" }),
      catalog,
    });

    expect(refusalOf(check)).toContain(
      'No Event named "app/appointment.moved"'
    );
  });

  it("accepts a workflow cancelling on one Event", () => {
    expect(
      checkLifecycleRules({
        rules: rules({ cancelEvents: ["app/appointment.canceled"] }),
        catalog,
      })
    ).toEqual({ valid: true });
  });

  // A cancel always matches by Entity Value, whatever Concurrency says, so the
  // path is owed even where a start would not need one.
  it("refuses a Cancel Event with no Correlation Path", () => {
    const check = checkLifecycleRules({
      rules: rules({
        cancelEvents: ["ops/nightly.swept"],
        concurrency: "unlimited",
      }),
      catalog,
    });

    expect(refusalOf(check)).toContain("declares no Correlation Path");
  });

  it("accepts the builder's own path for a Cancel Event", () => {
    expect(
      checkLifecycleRules({
        rules: rules({
          cancelEvents: ["ops/nightly.swept"],
          concurrency: "unlimited",
          correlationPaths: { "ops/nightly.swept": "sweep.id" },
        }),
        catalog,
      })
    ).toEqual({ valid: true });
  });

  it("names a Cancel Event the catalog does not hold", () => {
    const check = checkLifecycleRules({
      rules: rules({ cancelEvents: ["app/appointment.moved"] }),
      catalog,
    });

    expect(refusalOf(check)).toContain(
      'No Event named "app/appointment.moved"'
    );
  });

  it("refuses a correlation-free Start Event when Concurrency compares", () => {
    const check = checkLifecycleRules({
      rules: rules({
        startEvent: "ops/nightly.swept",
        concurrency: "first-wins",
      }),
      catalog,
    });

    expect(refusalOf(check)).toContain("declares no Correlation Path");
  });

  // Fire-and-forget is a real case: nothing is compared, so nothing needs a path.
  it("accepts a correlation-free Start Event when Concurrency is unlimited", () => {
    expect(
      checkLifecycleRules({
        rules: rules({
          startEvent: "ops/nightly.swept",
          concurrency: "unlimited",
        }),
        catalog,
      })
    ).toEqual({ valid: true });
  });

  it("accepts the builder's own path for an Event that declares none", () => {
    expect(
      checkLifecycleRules({
        rules: rules({
          startEvent: "ops/nightly.swept",
          concurrency: "newest-wins",
          correlationPaths: { "ops/nightly.swept": "sweep.id" },
        }),
        catalog,
      })
    ).toEqual({ valid: true });
  });

  it("refuses a workflow nothing can start", () => {
    const check = checkLifecycleRules({
      rules: rules({ startEvent: undefined }),
      catalog,
    });

    expect(refusalOf(check)).toContain("Nothing can start this workflow");
  });

  it("accepts a manual start as the only start source", () => {
    expect(
      checkLifecycleRules({
        rules: rules({ startEvent: undefined, allowManualStart: true }),
        catalog,
      })
    ).toEqual({ valid: true });
  });

  // A clock is not in the shape at all: nothing can write one, so there is no
  // schedule to refuse, and the panel says where one will come from instead.
  it("refuses a workflow with no start source at all", () => {
    expect(
      refusalOf(
        checkLifecycleRules({
          rules: rules({ startEvent: undefined, allowManualStart: false }),
          catalog,
        })
      )
    ).toContain("Nothing can start this workflow");
  });

  // A Wait Subscription carries its own match expression, so what a parked run
  // compares an arrival against is stated on the Wait node. The rules are asked
  // about start and cancel roles and about nothing else.
  it("asks for no Correlation Path on account of a Wait node", () => {
    expect(
      checkLifecycleRules({
        rules: rules({ concurrency: "unlimited" }),
        catalog,
      })
    ).toEqual({ valid: true });

    expect(
      eventsNeedingCorrelationPath({
        rules: rules({ concurrency: "unlimited" }),
        catalog,
      })
    ).toEqual([]);
  });
});

describe("manualStartAllowed", () => {
  // A graph the Lifecycle panel has never been near is one the Run button is how
  // anybody tries, so the absence of rules is a yes rather than a no.
  it("allows a manual start of a workflow carrying no rules", () => {
    expect(manualStartAllowed(undefined)).toBe(true);
  });

  // Rules that exist and leave manual starts out are a decision.
  it("refuses one the rules leave out", () => {
    expect(manualStartAllowed(rules())).toBe(false);
    expect(manualStartAllowed(rules({ allowManualStart: false }))).toBe(false);
    expect(manualStartAllowed(rules({ allowManualStart: true }))).toBe(true);
  });
});

describe("hasStartSource", () => {
  it("counts a Start Event and the manual checkbox alike", () => {
    expect(hasStartSource(rules())).toBe(true);
    expect(
      hasStartSource(rules({ startEvent: undefined, allowManualStart: true }))
    ).toBe(true);
    expect(
      hasStartSource(rules({ startEvent: undefined, allowManualStart: false }))
    ).toBe(false);
    expect(hasStartSource(rules({ startEvent: undefined }))).toBe(false);
  });
});

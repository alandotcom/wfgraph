import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { ExtensionCatalog } from "#src/extensions/catalog";
import { rejectUnknownKeys } from "#src/types/schema";
import {
  checkLifecycleRules,
  type LifecycleRules,
  type LifecycleRulesCheck,
  lifecycleRulesSchema,
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
    startEvents: ["app/appointment.created"],
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
      startEvents: ["app/appointment.created"],
      cancelEvents: [],
      concurrency: "first-wins",
      schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" },
      allowManualStart: true,
      correlationPaths: { "ops/nightly.swept": "sweep.id" },
    });

    expect(decoded.concurrency).toBe("first-wins");
    expect(decoded.schedule?.cron).toBe("0 9 * * *");
    expect(decoded.correlationPaths).toEqual({
      "ops/nightly.swept": "sweep.id",
    });
  });

  it("refuses a concurrency it has never heard of", () => {
    expect(
      decode({
        startEvents: [],
        cancelEvents: [],
        concurrency: "replace",
      })._tag
    ).toBe("Failure");
  });

  it("refuses a blank Event name", () => {
    expect(
      decode({
        startEvents: ["  "],
        cancelEvents: [],
        concurrency: "unlimited",
      })._tag
    ).toBe("Failure");
  });
});

describe("readLifecycleRules", () => {
  it("reads the rules off an entry node's config", () => {
    const read = readLifecycleRules({
      triggerType: "Webhook",
      lifecycleRules: {
        startEvents: ["app/appointment.created"],
        cancelEvents: [],
        concurrency: "unlimited",
      },
    });

    expect(read?.startEvents).toEqual(["app/appointment.created"]);
  });

  it("answers undefined for a config carrying none", () => {
    expect(readLifecycleRules({ triggerType: "Webhook" })).toBeUndefined();
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
        startEvents: ["app/appointment.created"],
        cancelEvents: ["app/appointment.created"],
      }),
      catalog,
    });

    expect(refusalOf(check)).toContain("cannot both start and cancel");
  });

  it("names an Event the catalog does not hold", () => {
    const check = checkLifecycleRules({
      rules: rules({ startEvents: ["app/appointment.moved"] }),
      catalog,
    });

    expect(refusalOf(check)).toContain(
      'No Event named "app/appointment.moved"'
    );
  });

  // A cancel matches by Entity Value, so a path is what it needs before the
  // interim refusal below is even reached.
  it("refuses a Cancel Event with no Correlation Path", () => {
    const check = checkLifecycleRules({
      rules: rules({ cancelEvents: ["ops/nightly.swept"] }),
      catalog,
    });

    expect(refusalOf(check)).toContain("declares no Correlation Path");
  });

  it("refuses Cancel Events until the Canceled outlet lands", () => {
    const check = checkLifecycleRules({
      rules: rules({ cancelEvents: ["app/appointment.canceled"] }),
      catalog,
    });

    expect(refusalOf(check)).toContain(
      "Cancel Events arrive with the Canceled outlet"
    );
  });

  it("refuses a correlation-free Start Event when Concurrency compares", () => {
    const check = checkLifecycleRules({
      rules: rules({
        startEvents: ["ops/nightly.swept"],
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
          startEvents: ["ops/nightly.swept"],
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
          startEvents: ["ops/nightly.swept"],
          concurrency: "newest-wins",
          correlationPaths: { "ops/nightly.swept": "sweep.id" },
        }),
        catalog,
      })
    ).toEqual({ valid: true });
  });

  it("refuses a workflow nothing can start", () => {
    const check = checkLifecycleRules({
      rules: rules({ startEvents: [] }),
      catalog,
    });

    expect(refusalOf(check)).toContain("Nothing can start this workflow");
  });

  it("accepts a manual start as the only start source", () => {
    expect(
      checkLifecycleRules({
        rules: rules({ startEvents: [], allowManualStart: true }),
        catalog,
      })
    ).toEqual({ valid: true });
  });

  // Nothing ticks a clock yet, so a schedule is carried in the shape and turned
  // away here: accepting one would certify a workflow nothing can start.
  it("refuses a schedule until something can run one", () => {
    expect(
      refusalOf(
        checkLifecycleRules({
          rules: rules({ schedule: { cron: "0 9 * * *" } }),
          catalog,
        })
      )
    ).toContain("Schedules arrive with the Lifecycle panel");

    expect(
      refusalOf(
        checkLifecycleRules({
          rules: rules({ startEvents: [], schedule: { cron: "0 9 * * *" } }),
          catalog,
        })
      )
    ).toContain("Nothing can start this workflow");
  });

  // A wait matches by Entity Value like a cancel does, so it needs a path for the
  // same reason. A name the catalog never heard of has no author to ask.
  it("holds a wait-role Event to the same Correlation Path rule", () => {
    expect(
      refusalOf(
        checkLifecycleRules({
          rules: rules({ concurrency: "unlimited" }),
          catalog,
          waitEvents: ["ops/nightly.swept"],
        })
      )
    ).toContain("declares no Correlation Path");

    expect(
      checkLifecycleRules({
        rules: rules({ concurrency: "unlimited" }),
        catalog,
        waitEvents: ["billing/nothing.declares.this"],
      })
    ).toEqual({ valid: true });
  });
});

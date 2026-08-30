import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { ExtensionCatalog } from "#src/extensions/catalog";
import { rejectUnknownKeys } from "#src/types/schema";
import {
  checkLifecycleRules,
  configDeclaresCancelEvent,
  connectionIdForIntegration,
  eventsNeedingCorrelationPath,
  hasStartSource,
  inheritConnectionIds,
  type LifecycleRules,
  type LifecycleRulesCheck,
  lifecycleRulesSchema,
  manualStartAllowed,
  pruneConnectionIds,
  pruneCorrelationPaths,
  readLifecycleRules,
  resolveCorrelationPath,
  setConnectionForIntegration,
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
    {
      name: "resend/email.sent",
      label: "Email sent",
      integration: "resend",
      correlationPath: "data.email_id",
      payloadFields: [],
    },
    {
      name: "resend/email.delivered",
      label: "Email delivered",
      integration: "resend",
      correlationPath: "data.email_id",
      payloadFields: [],
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

const decode = Schema.decodeUnknownResult(
  lifecycleRulesSchema,
  rejectUnknownKeys
);

describe("lifecycleRulesSchema", () => {
  it("decodes the rules the panel writes", () => {
    const decoded = Schema.decodeSync(
      lifecycleRulesSchema,
      rejectUnknownKeys
    )({
      startEvents: ["app/appointment.created"],
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
      lifecycleRules: {
        startEvents: ["app/appointment.created"],
        cancelEvents: [],
        concurrency: "unlimited",
      },
    });

    expect(read?.startEvents).toEqual(["app/appointment.created"]);
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

describe("configDeclaresCancelEvent", () => {
  it("is true when cancelEvents lists at least one name", () => {
    expect(
      configDeclaresCancelEvent({
        lifecycleRules: {
          startEvents: [],
          cancelEvents: ["app/appointment.canceled"],
          concurrency: "unlimited",
        },
      })
    ).toBe(true);
  });

  it("is false when cancelEvents is empty or the config carries no rules", () => {
    expect(
      configDeclaresCancelEvent({
        lifecycleRules: {
          startEvents: ["app/appointment.created"],
          cancelEvents: [],
          concurrency: "unlimited",
        },
      })
    ).toBe(false);
    expect(configDeclaresCancelEvent(undefined)).toBe(false);
  });
});

describe("resolveCorrelationPath", () => {
  // The workflow reading an Event may be about a different entity than the one
  // its author had in mind, so the per-workflow path outranks the declaration.
  it("prefers the path the builder set for this workflow", () => {
    expect(
      resolveCorrelationPath({
        rules: rules({ correlationPaths: { "ops/nightly.swept": "sweep.id" } }),
        eventName: "ops/nightly.swept",
        declaredPath: "declared.id",
      })
    ).toBe("sweep.id");
  });

  it("falls to the Event Author's declaration", () => {
    expect(
      resolveCorrelationPath({
        rules: rules(),
        eventName: "ops/nightly.swept",
        declaredPath: "declared.id",
      })
    ).toBe("declared.id");
  });

  it("answers nothing where neither side named a path", () => {
    expect(
      resolveCorrelationPath({ rules: rules(), eventName: "ops/nightly.swept" })
    ).toBeUndefined();
  });
});

describe("eventsNeedingCorrelationPath", () => {
  // The panel maps over this set, and an Event declaring a path is a member like
  // any other: the builder needs a control to override it with.
  it("carries both paths for an Event whose author declared one", () => {
    expect(
      eventsNeedingCorrelationPath({
        rules: rules({
          correlationPaths: { "app/appointment.created": "patient.id" },
        }),
        catalog,
      })
    ).toEqual([
      {
        eventName: "app/appointment.created",
        role: "start",
        declaredPath: "appointment.id",
        suppliedPath: "patient.id",
      },
    ]);
  });

  it("carries a Cancel Event with neither path yet", () => {
    expect(
      eventsNeedingCorrelationPath({
        rules: rules({
          cancelEvents: ["ops/nightly.swept"],
          concurrency: "unlimited",
        }),
        catalog,
      })
    ).toEqual([
      // A Cancel Event exists, so the default Start Event's value lands on the
      // execution row that Cancel Event will match against: it is listed too,
      // whatever Concurrency says.
      {
        eventName: "app/appointment.created",
        role: "start",
        declaredPath: "appointment.id",
        suppliedPath: undefined,
      },
      {
        eventName: "ops/nightly.swept",
        role: "cancel",
        declaredPath: undefined,
        suppliedPath: undefined,
      },
    ]);
  });

  // F1: a cancel gives a correlation-free Start Event a reason to need a path
  // even under Unlimited, because its value is what the cancel compares against.
  it("lists a correlation-free Start Event when a Cancel Event needs a value to compare", () => {
    expect(
      eventsNeedingCorrelationPath({
        rules: rules({
          startEvents: ["ops/nightly.swept"],
          concurrency: "unlimited",
          cancelEvents: ["app/appointment.canceled"],
        }),
        catalog,
      })
    ).toEqual([
      {
        eventName: "ops/nightly.swept",
        role: "start",
        declaredPath: undefined,
        suppliedPath: undefined,
      },
      {
        eventName: "app/appointment.canceled",
        role: "cancel",
        declaredPath: "appointment.id",
        suppliedPath: undefined,
      },
    ]);
  });
});

describe("pruneCorrelationPaths", () => {
  it("leaves the map untouched when there is none", () => {
    expect(pruneCorrelationPaths(rules())).toEqual(rules());
  });

  it("keeps an override for an Event still holding a role", () => {
    const withOverride = rules({
      cancelEvents: ["ops/nightly.swept"],
      correlationPaths: { "ops/nightly.swept": "sweep.id" },
    });

    expect(pruneCorrelationPaths(withOverride)).toEqual(withOverride);
  });

  // The sharp case: the Start Event keeps its role across a Concurrency change,
  // so only pruning by current need -- not by role alone -- drops a stale
  // override once Concurrency stops comparing and no Cancel Event takes over.
  it("drops a start override once Concurrency stops comparing and no cancel needs it", () => {
    const pruned = pruneCorrelationPaths(
      rules({
        concurrency: "unlimited",
        correlationPaths: { "app/appointment.created": "patient.id" },
      })
    );

    expect(pruned.correlationPaths).toBeUndefined();
  });

  it("keeps a start override that a Cancel Event still needs, under Unlimited", () => {
    const withCancel = rules({
      concurrency: "unlimited",
      cancelEvents: ["ops/nightly.swept"],
      correlationPaths: {
        "app/appointment.created": "patient.id",
        "ops/nightly.swept": "sweep.id",
      },
    });

    expect(pruneCorrelationPaths(withCancel)).toEqual(withCancel);
  });

  it("drops an override for an Event holding no role at all", () => {
    const pruned = pruneCorrelationPaths(
      rules({ correlationPaths: { "ops/nightly.swept": "sweep.id" } })
    );

    expect(pruned.correlationPaths).toBeUndefined();
  });

  // The reviewer's three-step repro, at the rules level: an override written
  // while Concurrency compares must not survive a switch back to Unlimited with
  // no Cancel Event to keep it alive.
  it("does not survive a switch to Unlimited with no cancels, after the prune", () => {
    const underComparison = rules({
      concurrency: "newest-wins",
      correlationPaths: { "app/appointment.created": "patient.id" },
    });
    expect(underComparison.correlationPaths).toEqual({
      "app/appointment.created": "patient.id",
    });

    const backToUnlimited = pruneCorrelationPaths({
      ...underComparison,
      concurrency: "unlimited",
    });

    expect(backToUnlimited).toEqual(rules({ concurrency: "unlimited" }));
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

  // With two lists the rule is where they intersect, so the overlap has to be
  // found wherever it sits rather than by comparing the first of each.
  it("refuses an Event holding both roles from the middle of either list", () => {
    const check = checkLifecycleRules({
      rules: rules({
        startEvents: ["ops/nightly.swept", "app/appointment.created"],
        cancelEvents: ["app/appointment.moved", "app/appointment.created"],
      }),
      catalog,
    });

    expect(refusalOf(check)).toContain(
      'Event "app/appointment.created" cannot both start and cancel'
    );
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

  // A clock is not in the shape at all: nothing can write one, so there is no
  // schedule to refuse, and the panel says where one will come from instead.
  it("refuses a workflow with no start source at all", () => {
    expect(
      refusalOf(
        checkLifecycleRules({
          rules: rules({ startEvents: [], allowManualStart: false }),
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

  it("refuses an integration Event that names no Connection", () => {
    const check = checkLifecycleRules({
      rules: rules({
        startEvents: ["resend/email.delivered"],
        concurrency: "unlimited",
      }),
      catalog,
    });

    expect(refusalOf(check)).toContain("needs a Connection");
    expect(refusalOf(check)).toContain("would start on every");
  });

  it("accepts an integration Event that names a Connection", () => {
    expect(
      checkLifecycleRules({
        rules: rules({
          startEvents: ["resend/email.delivered"],
          concurrency: "unlimited",
          connectionIds: { "resend/email.delivered": "conn_1" },
        }),
        catalog,
      })
    ).toEqual({ valid: true });
  });
});

describe("setConnectionForIntegration", () => {
  it("stamps one Connection onto every named Event of that integration", () => {
    expect(
      setConnectionForIntegration({
        rules: rules({
          startEvents: ["resend/email.sent", "resend/email.delivered"],
          cancelEvents: ["app/appointment.canceled"],
        }),
        catalog,
        integration: "resend",
        connectionId: "conn_1",
      }).connectionIds
    ).toEqual({
      "resend/email.sent": "conn_1",
      "resend/email.delivered": "conn_1",
    });
  });
});

describe("inheritConnectionIds", () => {
  it("copies a sibling Connection onto a newly named Event of the same integration", () => {
    expect(
      inheritConnectionIds(
        rules({
          startEvents: ["resend/email.sent", "resend/email.delivered"],
          connectionIds: { "resend/email.sent": "conn_1" },
        }),
        catalog
      ).connectionIds
    ).toEqual({
      "resend/email.sent": "conn_1",
      "resend/email.delivered": "conn_1",
    });
  });
});

describe("connectionIdForIntegration", () => {
  it("reads the stored Connection for an integration from any of its Events", () => {
    expect(
      connectionIdForIntegration(
        rules({
          startEvents: ["resend/email.sent", "resend/email.delivered"],
          connectionIds: { "resend/email.delivered": "conn_1" },
        }),
        catalog,
        "resend"
      )
    ).toBe("conn_1");
  });
});

describe("pruneConnectionIds", () => {
  it("drops a Connection for an Event that lost its role", () => {
    expect(
      pruneConnectionIds(
        rules({
          startEvents: ["app/appointment.created"],
          connectionIds: {
            "app/appointment.created": "conn_1",
            "resend/email.delivered": "conn_2",
          },
        })
      )
    ).toEqual(
      rules({
        startEvents: ["app/appointment.created"],
        connectionIds: { "app/appointment.created": "conn_1" },
      })
    );
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
      hasStartSource(rules({ startEvents: [], allowManualStart: true }))
    ).toBe(true);
    expect(
      hasStartSource(rules({ startEvents: [], allowManualStart: false }))
    ).toBe(false);
    expect(hasStartSource(rules({ startEvents: [] }))).toBe(false);
  });
});

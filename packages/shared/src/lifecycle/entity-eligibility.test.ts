import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  type ConditionRule,
  serializeConditionModel,
} from "#src/conditions/conditions";
import type { ExtensionCatalog } from "#src/extensions/catalog";
import {
  checkEntityEligibility,
  entityEligibilitySchema,
} from "#src/lifecycle/entity-eligibility";
import type { LifecycleRules } from "#src/lifecycle/lifecycle-rules";
import { rejectUnknownKeys } from "#src/types/schema";

const catalog: ExtensionCatalog = {
  entities: [
    {
      type: "appointment",
      label: "Appointment",
      stateFields: [
        {
          path: "status",
          type: "string",
          enumValues: ["scheduled", "completed"],
        },
        { path: "remindersEnabled", type: "boolean" },
        { path: "optionalNote", type: "string", nullable: true },
        { path: "startsAt", type: "timestamp" },
        { path: "tags", type: "object", valueType: "string" },
      ],
      stateSchemaDigest: "appointment-v1",
    },
    {
      type: "patient",
      label: "Patient",
      stateFields: [{ path: "active", type: "boolean" }],
      stateSchemaDigest: "patient-v1",
    },
  ],
  events: [
    {
      name: "appointment.scheduled",
      label: "Appointment scheduled",
      payloadFields: [],
      entityBindings: [
        { name: "appointment", entityType: "appointment" },
        { name: "patient", entityType: "patient" },
      ],
    },
    {
      name: "appointment.rescheduled",
      label: "Appointment rescheduled",
      payloadFields: [],
      entityBindings: [{ name: "booking", entityType: "appointment" }],
    },
    {
      name: "appointment.canceled",
      label: "Appointment canceled",
      payloadFields: [],
      entityBindings: [{ name: "appointment", entityType: "appointment" }],
    },
    {
      name: "notification.sent",
      label: "Notification sent",
      payloadFields: [],
    },
  ],
  actions: [],
  integrations: [],
};

function conditionForRule(rule: ConditionRule): string {
  return serializeConditionModel({
    version: 2,
    groupLogic: "and",
    groups: [{ id: "group-1", logic: "and", conditions: [rule] }],
  });
}

function condition(
  input: {
    field?: string;
    fieldType?: "string";
    value?: string;
  } = {}
): string {
  return conditionForRule({
    id: "rule-1",
    field: input.field ?? "status",
    fieldType: input.fieldType ?? "string",
    operator: "equals",
    value: input.value ?? "scheduled",
  });
}

function rules(overrides: Partial<LifecycleRules> = {}): LifecycleRules {
  return {
    startEvents: ["appointment.scheduled", "appointment.rescheduled"],
    cancelEvents: ["appointment.canceled"],
    concurrency: "newest-wins",
    trackedEntity: {
      type: "appointment",
      bindings: {
        "appointment.scheduled": "appointment",
        "appointment.rescheduled": "booking",
        "appointment.canceled": "appointment",
      },
    },
    entityEligibility: {
      condition: condition(),
      checkpoints: ["before-execution", "before-node"],
    },
    ...overrides,
  };
}

function errorOf(result: ReturnType<typeof checkEntityEligibility>): string {
  if (result.valid) {
    throw new Error("Expected Entity Eligibility to be refused");
  }
  return result.error;
}

describe("entityEligibilitySchema", () => {
  const decode = Schema.decodeUnknownResult(
    entityEligibilitySchema,
    rejectUnknownKeys
  );

  it("decodes every supported checkpoint set", () => {
    for (const checkpoints of [
      ["before-execution"],
      ["before-node"],
      ["before-execution", "before-node"],
    ] as const) {
      expect(
        Schema.decodeSync(
          entityEligibilitySchema,
          rejectUnknownKeys
        )({
          condition: condition(),
          checkpoints,
        }).checkpoints
      ).toEqual(checkpoints);
    }
  });

  it("refuses unknown checkpoints structurally", () => {
    expect(
      decode({ condition: condition(), checkpoints: ["after-node"] })._tag
    ).toBe("Failure");
  });
});

describe("checkEntityEligibility", () => {
  it("leaves workflows without Entity Eligibility unchanged", () => {
    expect(
      checkEntityEligibility({
        rules: {
          startEvents: ["notification.sent"],
          cancelEvents: [],
          concurrency: "unlimited",
        },
        catalog,
      })
    ).toEqual({ valid: true });
  });

  it("accepts one compatible binding per lifecycle Event", () => {
    expect(checkEntityEligibility({ rules: rules(), catalog })).toEqual({
      valid: true,
    });
  });

  it("allows tracking without an Eligibility condition", () => {
    expect(
      checkEntityEligibility({
        rules: rules({ entityEligibility: undefined }),
        catalog,
      })
    ).toEqual({ valid: true });
  });

  it("requires Eligibility to name a tracked Entity", () => {
    expect(
      errorOf(
        checkEntityEligibility({
          rules: rules({ trackedEntity: undefined }),
          catalog,
        })
      )
    ).toContain("has no tracked Entity");
  });

  it("requires a Start Event to establish guarded identity", () => {
    expect(
      errorOf(
        checkEntityEligibility({
          rules: rules({ startEvents: [], cancelEvents: [] }),
          catalog,
        })
      )
    ).toContain("needs a Start Event");
  });

  it("requires one selected binding for every Start and Cancel Event", () => {
    const bindings = {
      ...rules().trackedEntity?.bindings,
    };
    delete bindings["appointment.canceled"];

    expect(
      errorOf(
        checkEntityEligibility({
          rules: rules({
            trackedEntity: { type: "appointment", bindings },
          }),
          catalog,
        })
      )
    ).toContain('Event "appointment.canceled" has no selected Entity binding');
  });

  it("refuses missing and incompatible Event bindings", () => {
    expect(
      errorOf(
        checkEntityEligibility({
          rules: rules({
            trackedEntity: {
              type: "appointment",
              bindings: {
                ...rules().trackedEntity?.bindings,
                "appointment.scheduled": "removed",
              },
            },
          }),
          catalog,
        })
      )
    ).toContain('has no Entity binding named "removed"');

    expect(
      errorOf(
        checkEntityEligibility({
          rules: rules({
            trackedEntity: {
              type: "appointment",
              bindings: {
                ...rules().trackedEntity?.bindings,
                "appointment.scheduled": "patient",
              },
            },
          }),
          catalog,
        })
      )
    ).toContain(
      'identifies Entity "patient", not tracked Entity "appointment"'
    );
  });

  it("refuses unavailable Entity definitions and stale binding keys", () => {
    expect(
      errorOf(
        checkEntityEligibility({
          rules: rules({
            trackedEntity: {
              type: "removed",
              bindings: rules().trackedEntity?.bindings ?? {},
            },
          }),
          catalog,
        })
      )
    ).toContain('No Entity type "removed" is available');

    expect(
      errorOf(
        checkEntityEligibility({
          rules: rules({
            trackedEntity: {
              type: "appointment",
              bindings: {
                ...rules().trackedEntity?.bindings,
                "appointment.deleted": "appointment",
              },
            },
          }),
          catalog,
        })
      )
    ).toContain("has no lifecycle role");
  });

  it("makes selected bindings the sole identity source", () => {
    expect(
      errorOf(
        checkEntityEligibility({
          rules: rules({
            correlationPaths: {
              "appointment.scheduled": "appointment.id",
            },
          }),
          catalog,
        })
      )
    ).toContain("cannot use a Correlation Path");
  });

  it("requires one unique checkpoint", () => {
    expect(
      errorOf(
        checkEntityEligibility({
          rules: rules({
            entityEligibility: { condition: condition(), checkpoints: [] },
          }),
          catalog,
        })
      )
    ).toContain("has no checkpoint");

    expect(
      errorOf(
        checkEntityEligibility({
          rules: rules({
            entityEligibility: {
              condition: condition(),
              checkpoints: ["before-node", "before-node"],
            },
          }),
          catalog,
        })
      )
    ).toContain("must not contain duplicates");
  });

  it("refuses malformed and unfinished conditions", () => {
    expect(
      errorOf(
        checkEntityEligibility({
          rules: rules({
            entityEligibility: {
              condition: "not json",
              checkpoints: ["before-node"],
            },
          }),
          catalog,
        })
      )
    ).toContain("must be valid JSON");

    expect(
      errorOf(
        checkEntityEligibility({
          rules: rules({
            entityEligibility: {
              condition: condition({ value: "" }),
              checkpoints: ["before-node"],
            },
          }),
          catalog,
        })
      )
    ).toContain("unfinished");
  });

  it("refuses fields removed or changed by Entity schema drift", () => {
    expect(
      errorOf(
        checkEntityEligibility({
          rules: rules({
            entityEligibility: {
              condition: condition({ field: "removed" }),
              checkpoints: ["before-node"],
            },
          }),
          catalog,
        })
      )
    ).toContain("does not declare");

    expect(
      errorOf(
        checkEntityEligibility({
          rules: rules({
            entityEligibility: {
              condition: condition({
                field: "remindersEnabled",
                fieldType: "string",
              }),
              checkpoints: ["before-node"],
            },
          }),
          catalog,
        })
      )
    ).toContain("now declares as boolean");
  });

  it("refuses enum and nullability drift", () => {
    expect(
      errorOf(
        checkEntityEligibility({
          rules: rules({
            entityEligibility: {
              condition: condition({ value: "removed" }),
              checkpoints: ["before-node"],
            },
          }),
          catalog,
        })
      )
    ).toContain("no longer offers");

    expect(
      errorOf(
        checkEntityEligibility({
          rules: rules({
            entityEligibility: {
              condition: conditionForRule({
                id: "rule-1",
                field: "status",
                fieldType: "string",
                operator: "is_one_of",
                values: ["scheduled", "removed"],
              }),
              checkpoints: ["before-node"],
            },
          }),
          catalog,
        })
      )
    ).toContain("no longer offers");

    expect(
      errorOf(
        checkEntityEligibility({
          rules: rules({
            entityEligibility: {
              condition: conditionForRule({
                id: "rule-1",
                field: "optionalNote",
                fieldType: "string",
                operator: "is_not_one_of",
                values: ["private"],
              }),
              checkpoints: ["before-node"],
            },
          }),
          catalog,
        })
      )
    ).toContain("no longer offers as a fixed list");

    expect(
      errorOf(
        checkEntityEligibility({
          rules: rules({
            entityEligibility: {
              condition: conditionForRule({
                id: "rule-1",
                field: "status",
                fieldType: "string",
                operator: "is_set",
              }),
              checkpoints: ["before-node"],
            },
          }),
          catalog,
        })
      )
    ).toContain("now requires that field");

    expect(
      checkEntityEligibility({
        rules: rules({
          entityEligibility: {
            condition: conditionForRule({
              id: "rule-1",
              field: "status",
              fieldType: "string",
              operator: "contains",
              value: "sched",
            }),
            checkpoints: ["before-node"],
          },
        }),
        catalog,
      })
    ).toEqual({ valid: true });

    expect(
      checkEntityEligibility({
        rules: rules({
          entityEligibility: {
            condition: conditionForRule({
              id: "rule-1",
              field: "optionalNote",
              fieldType: "string",
              operator: "is_not_set",
            }),
            checkpoints: ["before-node"],
          },
        }),
        catalog,
      })
    ).toEqual({ valid: true });
  });

  it("accepts canonical open-record keys and rejects run references", () => {
    for (const recordKey of ["campaign", 'campaign["fall"]']) {
      expect(
        checkEntityEligibility({
          rules: rules({
            entityEligibility: {
              condition: conditionForRule({
                id: "rule-1",
                field: "tags",
                fieldType: "string",
                recordKey,
                operator: "equals",
                value: "reminder",
              }),
              checkpoints: ["before-node"],
            },
          }),
          catalog,
        })
      ).toEqual({ valid: true });
    }

    for (const recordKey of ["campaign", 'campaign["fall"]']) {
      expect(
        checkEntityEligibility({
          rules: rules({
            entityEligibility: {
              condition: conditionForRule({
                id: "rule-1",
                field: "tags",
                fieldType: "string",
                recordKey,
                operator: "is_not_set",
              }),
              checkpoints: ["before-node"],
            },
          }),
          catalog,
        })
      ).toEqual({ valid: true });
    }

    expect(
      errorOf(
        checkEntityEligibility({
          rules: rules({
            entityEligibility: {
              condition: conditionForRule({
                id: "rule-1",
                field: "tags",
                fieldType: "string",
                recordKey: "",
                operator: "equals",
                value: "reminder",
              }),
              checkpoints: ["before-node"],
            },
          }),
          catalog,
        })
      )
    ).toContain("unfinished");

    expect(
      errorOf(
        checkEntityEligibility({
          rules: rules({
            entityEligibility: {
              condition: condition({ value: "{{@node:Lookup.value}}" }),
              checkpoints: ["before-node"],
            },
          }),
          catalog,
        })
      )
    ).toContain("literal values only");
  });
});

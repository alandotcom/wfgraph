import { describe, expect, it } from "vitest";
import {
  type ConditionFieldDefinition,
  type ConditionModel,
  collectTimestampFieldPaths,
  compileConditionModel,
  compileConditionRule,
  EVENT_NAME_FIELD_PATH,
  createDefaultConditionModel,
  createDefaultConditionRule,
  parseConditionModel,
  reconcileModelWithFields,
  serializeConditionModel,
} from "#src/conditions/conditions";

describe("conditions", () => {
  it("compiles grouped timestamp relative operators", () => {
    const model: ConditionModel = {
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group-1",
          logic: "and",
          conditions: [
            {
              id: "condition-1",
              field: "appointment.startsAt",
              fieldType: "timestamp",
              operator: "within_next",
              amount: 3,
              unit: "days",
            },
          ],
        },
      ],
    };

    const compiled = compileConditionModel(model);
    expect(compiled.valid).toBe(true);
    if (compiled.valid) {
      expect(compiled.expression).toBe(
        "((has(payload.appointment) && has(payload.appointment.startsAt) && (payload.appointment.startsAt > now && payload.appointment.startsAt < now + days(3))))"
      );
    }
  });

  it("compiles grouped timestamp absolute operators", () => {
    const model: ConditionModel = {
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group-1",
          logic: "and",
          conditions: [
            {
              id: "condition-1",
              field: "appointment.startsAt",
              fieldType: "timestamp",
              operator: "before",
              dateTime: "2026-03-01T10:00:00.000Z",
            },
          ],
        },
      ],
    };

    const compiled = compileConditionModel(model);
    expect(compiled.valid).toBe(true);
    if (compiled.valid) {
      expect(compiled.expression).toBe(
        '((has(payload.appointment) && has(payload.appointment.startsAt) && (payload.appointment.startsAt < date("2026-03-01T10:00:00.000Z"))))'
      );
    }
  });

  it("parses an exact template as a deferred absolute timestamp", () => {
    const parsed = parseConditionModel({
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group-1",
          logic: "and",
          conditions: [
            {
              id: "condition-1",
              field: "occurredAt",
              fieldType: "timestamp",
              operator: "after",
              dateTime: "{{@entry:Lifecycle.interviewAt}}",
            },
          ],
        },
      ],
    });

    expect(parsed.valid).toBe(true);
  });

  it("compiles multiple groups with group logic", () => {
    const model: ConditionModel = {
      version: 2,
      groupLogic: "or",
      groups: [
        {
          id: "group-1",
          logic: "and",
          conditions: [
            {
              id: "condition-1",
              field: "data.status",
              fieldType: "string",
              operator: "equals",
              value: "scheduled",
            },
            {
              id: "condition-2",
              field: "data.active",
              fieldType: "boolean",
              operator: "is_true",
            },
          ],
        },
        {
          id: "group-2",
          logic: "and",
          conditions: [
            {
              id: "condition-3",
              field: "data.count",
              fieldType: "number",
              operator: "greater_than",
              value: 5,
            },
          ],
        },
      ],
    };

    const compiled = compileConditionModel(model);
    expect(compiled.valid).toBe(true);
    if (compiled.valid) {
      expect(compiled.expression).toBe(
        '((has(payload.data) && has(payload.data.status) && (payload.data.status == "scheduled")) && (has(payload.data) && has(payload.data.active) && (payload.data.active == true))) || ((has(payload.data) && has(payload.data.count) && (payload.data.count > 5)))'
      );
    }
  });

  it("parses and serializes a valid condition model", () => {
    const defaultModel = createDefaultConditionModel(
      {
        path: "donor.lastDonation",
        label: "donor.lastDonation",
        type: "timestamp",
      },
      {
        groupId: "group-1",
        conditionId: "condition-1",
      }
    );

    const serialized = serializeConditionModel(defaultModel);
    const parsed = parseConditionModel(serialized);

    expect(parsed.valid).toBe(true);
    if (parsed.valid) {
      expect(parsed.model).toEqual(defaultModel);
    }
  });

  it("rejects malformed models", () => {
    const parsed = parseConditionModel(
      '{"version":2,"groupLogic":"and","groups":[]}'
    );
    expect(parsed.valid).toBe(false);
  });

  it("compiles is_set null-check operator", () => {
    const model: ConditionModel = {
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group-1",
          logic: "and",
          conditions: [
            {
              id: "condition-1",
              field: "middleInitial",
              fieldType: "string",
              operator: "is_set",
            },
          ],
        },
      ],
    };

    const compiled = compileConditionModel(model);
    expect(compiled.valid).toBe(true);
    if (compiled.valid) {
      expect(compiled.expression).toBe("((has(payload.middleInitial)))");
    }
  });

  it("compiles is_not_set null-check operator", () => {
    const model: ConditionModel = {
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group-1",
          logic: "and",
          conditions: [
            {
              id: "condition-1",
              field: "dateOfBirth",
              fieldType: "timestamp",
              operator: "is_not_set",
            },
          ],
        },
      ],
    };

    const compiled = compileConditionModel(model);
    expect(compiled.valid).toBe(true);
    if (compiled.valid) {
      expect(compiled.expression).toBe("((!(has(payload.dateOfBirth))))");
    }
  });

  // A nested path needs one `has` per segment: `has(payload.a.b)` raises
  // "No such key: a" when the parent is absent, so the parent is tested first.
  it("tests every segment of a nested path for presence", () => {
    const model: ConditionModel = {
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group-1",
          logic: "and",
          conditions: [
            {
              id: "condition-1",
              field: "appointment.patient.email",
              fieldType: "string",
              operator: "equals",
              value: "a@b.test",
            },
          ],
        },
      ],
    };

    const compiled = compileConditionModel(model);
    expect(compiled.valid).toBe(true);
    if (compiled.valid) {
      expect(compiled.expression).toBe(
        '((has(payload.appointment) && has(payload.appointment.patient) && has(payload.appointment.patient.email) && (payload.appointment.patient.email == "a@b.test")))'
      );
    }
  });

  // is_not_set negates the whole chain rather than the leaf alone, so a payload
  // missing the parent object answers it true: the field is indeed not set.
  it("answers is_not_set on a path whose parent is absent", () => {
    const model: ConditionModel = {
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group-1",
          logic: "and",
          conditions: [
            {
              id: "condition-1",
              field: "appointment.reason",
              fieldType: "string",
              operator: "is_not_set",
            },
          ],
        },
      ],
    };

    const compiled = compileConditionModel(model);
    expect(compiled.valid).toBe(true);
    if (compiled.valid) {
      expect(compiled.expression).toBe(
        "((!(has(payload.appointment) && has(payload.appointment.reason))))"
      );
    }
  });

  // The Event a run arrived on is a fact about the run, so it compiles to its
  // own root rather than to a payload path, and needs no presence guard: the
  // root is written on every run.
  it("compiles a rule about the Event to its own root", () => {
    const model: ConditionModel = {
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group-1",
          logic: "and",
          conditions: [
            {
              id: "condition-1",
              field: EVENT_NAME_FIELD_PATH,
              fieldType: "string",
              operator: "equals",
              value: "appointment.rescheduled",
            },
          ],
        },
      ],
    };

    const compiled = compileConditionModel(model);
    expect(compiled.valid).toBe(true);
    if (compiled.valid) {
      expect(compiled.expression).toBe(
        '((event.name == "appointment.rescheduled"))'
      );
    }
  });

  // A manual run names no Event, so the root holds null and presence is a null
  // test rather than the key test a payload path gets.
  it("compiles a null check about the Event as a null test", () => {
    const model: ConditionModel = {
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group-1",
          logic: "and",
          conditions: [
            {
              id: "condition-1",
              field: EVENT_NAME_FIELD_PATH,
              fieldType: "string",
              operator: "is_not_set",
            },
          ],
        },
      ],
    };

    const compiled = compileConditionModel(model);
    expect(compiled.valid).toBe(true);
    if (compiled.valid) {
      expect(compiled.expression).toBe("((event.name == null))");
    }
  });

  // A value carrying a quote, a backslash or a newline has to survive into CEL
  // as an escape rather than as source, which is what `celStringLiteral` owns.
  it("escapes a text value that would otherwise break the expression", () => {
    const model: ConditionModel = {
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group-1",
          logic: "and",
          conditions: [
            {
              id: "condition-1",
              field: "note",
              fieldType: "string",
              operator: "contains",
              value: 'say "hi"\nthen go',
            },
          ],
        },
      ],
    };

    const compiled = compileConditionModel(model);
    expect(compiled.valid).toBe(true);
    if (compiled.valid) {
      expect(compiled.expression).toBe(
        '((has(payload.note) && (payload.note.contains("say \\"hi\\"\\nthen go"))))'
      );
    }
  });

  it("parses null-check conditions from JSON", () => {
    const json = JSON.stringify({
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "g1",
          logic: "and",
          conditions: [
            {
              id: "c1",
              field: "phone",
              fieldType: "string",
              operator: "is_set",
            },
          ],
        },
      ],
    });

    const parsed = parseConditionModel(json);
    expect(parsed.valid).toBe(true);
    if (parsed.valid) {
      expect(parsed.model.groups[0].conditions[0].operator).toBe("is_set");
    }
  });

  // A rule reaches the parser as JSON, so an operand the editor writes as a
  // number can arrive as text. The message has to name the operand rather than
  // repeat Effect's own "Expected number", which is what an annotation attached
  // to a check instead of to the type would leave behind.
  function ruleModel(rule: Record<string, unknown>) {
    return JSON.stringify({
      version: 2,
      groupLogic: "and",
      groups: [{ id: "g1", logic: "and", conditions: [rule] }],
    });
  }

  it("names the operand when a timestamp amount arrives as text", () => {
    const parsed = parseConditionModel(
      ruleModel({
        id: "c1",
        field: "appointment.datetime",
        fieldType: "timestamp",
        operator: "within_next",
        amount: "5",
        unit: "days",
      })
    );

    expect(parsed).toEqual({
      valid: false,
      error: "Timestamp amount must be a positive integer",
    });
  });

  it("names the operand when a number value arrives as text", () => {
    const parsed = parseConditionModel(
      ruleModel({
        id: "c1",
        field: "order.total",
        fieldType: "number",
        operator: "equals",
        value: "5",
      })
    );

    expect(parsed).toEqual({
      valid: false,
      error: "Number conditions require a finite numeric value",
    });
  });

  it("names the operator when a rule is missing it", () => {
    const parsed = parseConditionModel(
      ruleModel({
        id: "c1",
        field: "order.total",
        fieldType: "number",
        value: 5,
      })
    );

    expect(parsed).toEqual({
      valid: false,
      error: "Number operator is invalid",
    });
  });

  it("compiles a field whose name is a CEL type constant", () => {
    // Bare `type` resolves to CEL's type-of-type, so an unrooted expression
    // fails to compile with "no such overload: type == string".
    const model: ConditionModel = {
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group-1",
          logic: "and",
          conditions: [
            {
              id: "condition-1",
              field: "type",
              fieldType: "string",
              operator: "equals",
              value: "appointment.created",
            },
          ],
        },
      ],
    };

    const compiled = compileConditionModel(model);
    expect(compiled.valid).toBe(true);
    if (compiled.valid) {
      expect(compiled.expression).toBe(
        '((has(payload.type) && (payload.type == "appointment.created")))'
      );
    }
  });

  it("rejects a text condition with no value", () => {
    const model: ConditionModel = {
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group-1",
          logic: "and",
          conditions: [
            {
              id: "condition-1",
              field: "data.status",
              fieldType: "string",
              operator: "equals",
              value: "   ",
            },
          ],
        },
      ],
    };

    const compiled = compileConditionModel(model);
    expect(compiled.valid).toBe(false);
    if (!compiled.valid) {
      expect(compiled.error).toBe("Text conditions require a value");
    }
  });

  // The record itself is an object no arrival can equal, so a rule left with its
  // key unnamed would publish clean and never match.
  it("refuses a rule whose record key has not been named", () => {
    const compiled = compileConditionRule({
      id: "condition-1",
      field: "data.tags",
      recordKey: "",
      fieldType: "string",
      operator: "equals",
      value: "alan",
    });

    expect(compiled.valid).toBe(false);
    if (!compiled.valid) {
      expect(compiled.error).toBe("Name the key this rule compares");
      // The flag, not the sentence, is what the node badge and the Wait node's
      // own check read.
      expect(compiled.incomplete).toBe(true);
    }
  });

  it("compiles the key beside the record path", () => {
    const compiled = compileConditionRule({
      id: "condition-1",
      field: "data.tags",
      recordKey: "order_id",
      fieldType: "string",
      operator: "equals",
      value: "ord_7",
    });

    expect(compiled.valid).toBe(true);
    if (compiled.valid) {
      expect(compiled.expression).toContain("order_id");
    }
  });

  it("compiles punctuation in a record key as one literal map key", () => {
    const compiled = compileConditionRule({
      id: "condition-1",
      field: "data.tags",
      recordKey: "campaign.name[0]",
      fieldType: "string",
      operator: "equals",
      value: "spring",
    });

    expect(compiled).toEqual({
      valid: true,
      expression:
        '"data" in payload && "tags" in payload["data"] && "campaign.name[0]" in payload["data"]["tags"] && (payload["data"]["tags"]["campaign.name[0]"] == "spring")',
    });
  });

  it("includes the literal record key in timestamp preprocessing paths", () => {
    const model: ConditionModel = {
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group-1",
          logic: "and",
          conditions: [
            {
              id: "condition-1",
              field: "data.timestamps",
              recordKey: "campaign.startedAt",
              fieldType: "timestamp",
              operator: "before",
              dateTime: "2030-01-01T00:00:00.000Z",
            },
          ],
        },
      ],
    };

    expect(collectTimestampFieldPaths(model)).toEqual([
      'data.timestamps["campaign.startedAt"]',
    ]);
  });

  // A rebuild goes through `createDefaultConditionRule`, and one that dropped
  // the key would leave a rule comparing the whole record.
  it("keeps a rebuilt record rule unfinished rather than comparing the record", () => {
    const rebuilt = createDefaultConditionRule(
      {
        path: "data.tags",
        label: "data.tags",
        type: "string",
        openRecord: true,
      },
      "condition-1"
    );

    expect(rebuilt.recordKey).toBe("");
    expect(compileConditionRule(rebuilt).valid).toBe(false);
  });
});

describe("reconcileModelWithFields", () => {
  const stringModel: ConditionModel = {
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: "group-1",
        logic: "and",
        conditions: [
          {
            id: "condition-1",
            field: "customer.name",
            fieldType: "string",
            operator: "equals",
            value: "Ada",
          },
        ],
      },
    ],
  };

  function fields(
    ...definitions: ConditionFieldDefinition[]
  ): ReadonlyMap<string, ConditionFieldDefinition> {
    return new Map(definitions.map((field) => [field.path, field]));
  }

  it("returns the same model when every field still has its type", () => {
    const unchanged = reconcileModelWithFields(
      stringModel,
      fields({ path: "customer.name", label: "Name", type: "string" })
    );

    // Identity, not just equality: the builder reconciles during render, so a
    // fresh object every pass would read as an edit.
    expect(unchanged).toBe(stringModel);
  });

  it("rebuilds a rule whose field changed type, keeping its id", () => {
    const reconciled = reconcileModelWithFields(
      stringModel,
      fields({ path: "customer.name", label: "Name", type: "number" })
    );

    const rule = reconciled.groups[0].conditions[0];
    expect(rule.id).toBe("condition-1");
    expect(rule.fieldType).toBe("number");
  });

  it("leaves a rule alone when its field is no longer upstream", () => {
    // The field may come back when the graph is reconnected, and discarding the
    // user's rule in the meantime would lose work.
    const reconciled = reconcileModelWithFields(stringModel, fields());

    expect(reconciled).toBe(stringModel);
  });
});

import { describe, expect, it } from "bun:test";
import {
  policyCanTrigger,
  readRoutingPolicy,
  resolveRoutingAction,
  resolveTriggerRouting,
} from "./routing-policy";

describe("resolveRoutingAction", () => {
  it("returns the action the Workflow Builder mapped to the Event Type", () => {
    expect(
      resolveRoutingAction(
        {
          "appointment.created": "start",
          "appointment.rescheduled": "replace",
          "appointment.canceled": "cancel",
        },
        "appointment.rescheduled"
      )
    ).toBe("replace");
  });

  it("ignores an Event Type the policy does not mention", () => {
    expect(
      resolveRoutingAction({ "appointment.created": "start" }, "appointment.x")
    ).toBe("ignore");
  });

  it("ignores every Event Type when there is no policy at all", () => {
    expect(resolveRoutingAction(undefined, "appointment.created")).toBe(
      "ignore"
    );
  });

  it("ignores a payload that carries no Event Type", () => {
    expect(
      resolveRoutingAction({ "appointment.created": "start" }, undefined)
    ).toBe("ignore");
  });
});

describe("readRoutingPolicy", () => {
  it("reads a valid policy off the trigger node config", () => {
    expect(
      readRoutingPolicy({
        triggerType: "Webhook",
        routingPolicy: {
          "entity.created": "start",
          "entity.deleted": "cancel",
        },
      })
    ).toEqual({ "entity.created": "start", "entity.deleted": "cancel" });
  });

  it("reports no policy when the config carries none", () => {
    expect(readRoutingPolicy(undefined)).toBeUndefined();
    expect(readRoutingPolicy({ triggerType: "Webhook" })).toBeUndefined();
  });

  // A policy the editor could not have written is treated as absent, which
  // resolves everything to ignore rather than guessing at an action.
  it("reports no policy when the stored value is malformed", () => {
    expect(
      readRoutingPolicy({ routingPolicy: { "entity.created": "explode" } })
    ).toBeUndefined();
    expect(readRoutingPolicy({ routingPolicy: "start" })).toBeUndefined();
    expect(
      readRoutingPolicy({ routingPolicy: { "": "start" } })
    ).toBeUndefined();
  });
});

describe("policyCanTrigger", () => {
  it("reports no trigger path when there is no policy at all", () => {
    expect(policyCanTrigger(undefined)).toBe(false);
    expect(policyCanTrigger({})).toBe(false);
  });

  // Cancel and ignore both act on runs that already exist, so a policy built
  // only from those describes a workflow nothing can ever start.
  it("reports no trigger path when every Event Type only ignores or cancels", () => {
    expect(
      policyCanTrigger({
        "entity.created": "ignore",
        "entity.updated": "ignore",
      })
    ).toBe(false);
    expect(
      policyCanTrigger({
        "entity.deleted": "cancel",
        "entity.updated": "ignore",
      })
    ).toBe(false);
  });

  it("reports a trigger path when one Event Type starts or replaces", () => {
    expect(policyCanTrigger({ "entity.created": "start" })).toBe(true);
    expect(policyCanTrigger({ "entity.updated": "replace" })).toBe(true);
    expect(
      policyCanTrigger({
        "entity.deleted": "cancel",
        "entity.noisy": "ignore",
        "entity.updated": "replace",
      })
    ).toBe(true);
  });
});

describe("resolveTriggerRouting", () => {
  it("ignores a payload the trigger could not classify", () => {
    expect(
      resolveTriggerRouting({
        classification: { ok: false, reason: "invalid_payload" },
        config: { routingPolicy: { "entity.created": "start" } },
      })
    ).toEqual({
      eventType: undefined,
      correlationKey: undefined,
      action: "ignore",
      ignoreReason: "invalid_payload",
    });
  });

  it("ignores a classification that named no Event Type", () => {
    expect(
      resolveTriggerRouting({
        classification: {
          ok: true,
          eventType: undefined,
          correlationKey: "ent_1",
        },
        config: { routingPolicy: { "entity.created": "start" } },
      })
    ).toEqual({
      eventType: undefined,
      correlationKey: "ent_1",
      action: "ignore",
      ignoreReason: "missing_event_type",
    });
  });

  it("resolves a mapped Event Type to its action and leaves no ignore reason", () => {
    expect(
      resolveTriggerRouting({
        classification: {
          ok: true,
          eventType: "entity.updated",
          correlationKey: "ent_1",
        },
        config: {
          routingPolicy: {
            "entity.created": "start",
            "entity.updated": "replace",
          },
        },
      })
    ).toEqual({
      eventType: "entity.updated",
      correlationKey: "ent_1",
      action: "replace",
    });
  });

  it("ignores an Event Type the workflow never mapped", () => {
    expect(
      resolveTriggerRouting({
        classification: {
          ok: true,
          eventType: "entity.archived",
          correlationKey: "ent_1",
        },
        config: { routingPolicy: { "entity.created": "start" } },
      })
    ).toEqual({
      eventType: "entity.archived",
      correlationKey: "ent_1",
      action: "ignore",
      ignoreReason: "event_not_mapped",
    });
  });

  // An Event Type mapped to ignore on purpose is still reported as unmapped:
  // the run does nothing either way, and the reason names the same outcome.
  it("ignores an Event Type the workflow mapped to ignore", () => {
    expect(
      resolveTriggerRouting({
        classification: {
          ok: true,
          eventType: "entity.noisy",
          correlationKey: "ent_1",
        },
        config: { routingPolicy: { "entity.noisy": "ignore" } },
      })
    ).toEqual({
      eventType: "entity.noisy",
      correlationKey: "ent_1",
      action: "ignore",
      ignoreReason: "event_not_mapped",
    });
  });
});

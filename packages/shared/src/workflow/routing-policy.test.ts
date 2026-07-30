import { describe, expect, it } from "vitest";
import {
  policyCanTrigger,
  readRoutingPolicy,
} from "#src/workflow/routing-policy";

// The policy no longer routes anything -- ADR-0007's Lifecycle Rules do -- but the
// editor's old trigger panel still writes this shape and the graph schema still
// accepts it, so both readers stay covered until the panel goes.

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

  // A policy the editor could not have written reads as absent rather than as
  // partly usable. The empty-key case is the one the schema's `isPropertyNames`
  // check exists for: as a key schema it would drop that entry and call the rest
  // valid.
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

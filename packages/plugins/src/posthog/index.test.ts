import { requireOutputFieldsFromSchema } from "@wfgraph/core/plugin";
import { describe, expect, it } from "vitest";
import { posthog } from "#src/posthog/index";

/**
 * What the definition contributes: its credential vocabulary, its action slugs,
 * and what a node downstream of either action can reference.
 */
describe("the posthog integration", () => {
  it("declares its credentials and its actions as one value", () => {
    expect(posthog.type).toBe("posthog");
    expect(posthog.test).toBeDefined();
    expect(Object.keys(posthog.credentials)).toEqual([
      "POSTHOG_PROJECT_API_KEY",
      "POSTHOG_HOST",
    ]);
    expect(Object.keys(posthog.actions)).toEqual([
      "capture-event",
      "identify-person",
    ]);
  });

  it("declares PostHog's provider-owned OAuth adapter", () => {
    expect(posthog.oauth).toBeDefined();
    expect(posthog.oauth?.label).toBe("PostHog");
    expect(posthog.oauth?.pkce).toBe("S256");
  });

  // Both write to PostHog, so neither belongs inside a Group the editor lets a
  // builder re-paste after a Wait.
  it("marks both actions as changing the outside world", () => {
    expect(posthog.actions["capture-event"].sideEffect).toBe(true);
    expect(posthog.actions["identify-person"].sideEffect).toBe(true);
  });

  it("offers every field the capture step returns", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Action "posthog/capture-event"',
        posthog.actions["capture-event"].output
      )
    ).toEqual([
      { path: "eventName", description: "Event name", type: "string" },
      { path: "distinctId", description: "Person distinct ID", type: "string" },
      { path: "eventUuid", description: "Event UUID", type: "string" },
      { path: "timestamp", description: "Event timestamp", type: "string" },
      {
        path: "reasonCode",
        description: "Why a test run did not capture",
        type: "string",
        nullable: true,
      },
    ]);
  });

  it("offers every field the identify step returns", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Action "posthog/identify-person"',
        posthog.actions["identify-person"].output
      )
    ).toEqual([
      { path: "distinctId", description: "Person distinct ID", type: "string" },
      { path: "eventUuid", description: "Event UUID", type: "string" },
      { path: "timestamp", description: "Event timestamp", type: "string" },
      {
        path: "reasonCode",
        description: "Why a test run did not identify",
        type: "string",
        nullable: true,
      },
    ]);
  });
});

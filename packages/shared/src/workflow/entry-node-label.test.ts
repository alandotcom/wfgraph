import { describe, expect, it } from "vitest";
import { entryNodeLabel } from "./entry-node-label";

describe("entryNodeLabel", () => {
  it("names an entry node with no type as a manual run", () => {
    expect(entryNodeLabel(undefined)).toBe("Trigger");
    expect(entryNodeLabel({})).toBe("Trigger");
  });

  // Builder-authored JSONB names the entry node's type, so a graph saved against a
  // build that had a trigger this one does not still draws under its own name.
  it("names it by its type otherwise", () => {
    expect(entryNodeLabel({ triggerType: "Webhook" })).toBe("Webhook");
    expect(entryNodeLabel({ triggerType: "AppointmentLifecycle" })).toBe(
      "AppointmentLifecycle"
    );
  });
});

import { describe, expect, it } from "vitest";
import { toForwarderFunctionId } from "#src/backend/lib/inngest/forwarder-function-id";

describe("toForwarderFunctionId", () => {
  // The id reaches Inngest's own identifiers, so a bus name's slashes and dots
  // cannot travel in it.
  it("slugs an Event name into something a URL can carry", () => {
    expect(toForwarderFunctionId("app/appointment.updated")).toBe(
      "wfgraph-event-app-appointment-updated"
    );
  });
});

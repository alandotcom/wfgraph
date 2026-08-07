import { describe, expect, it } from "vitest";
import { toListenerFunctionId } from "#src/backend/lib/inngest/listener-function-id";

describe("toListenerFunctionId", () => {
  // The id reaches Inngest's own identifiers, so a bus name's slashes and dots
  // cannot travel in it.
  it("slugs an Event name into something a URL can carry", () => {
    expect(toListenerFunctionId("app/appointment.updated")).toBe(
      "wfgraph-event-app-appointment-updated"
    );
  });
});

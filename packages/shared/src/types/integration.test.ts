import { describe, expect, it } from "vitest";
import {
  INTEGRATION_REFRESH_STATES,
  isIntegrationRefreshState,
} from "#src/types/integration";

describe("integration refresh states", () => {
  it("keeps the durable refresh lifecycle in one checked vocabulary", () => {
    expect(INTEGRATION_REFRESH_STATES).toEqual([
      "idle",
      "refreshing",
      "reauthorization_required",
    ]);
    expect(INTEGRATION_REFRESH_STATES.every(isIntegrationRefreshState)).toBe(
      true
    );
    expect(isIntegrationRefreshState("unknown")).toBe(false);
    expect(isIntegrationRefreshState(null)).toBe(false);
  });
});

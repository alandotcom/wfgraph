import { describe, expect, it } from "vitest";
import {
  OAUTH_GRANT_CONFIG_KEY,
  readStoredOAuthGrant,
  removeStoredOAuthGrant,
  serializeStoredOAuthGrant,
} from "#src/backend/services/integrations/oauth-grant";

describe("stored OAuth grants", () => {
  it("round-trips a versioned grant and keeps its value under the reserved key", () => {
    const grant = serializeStoredOAuthGrant({
      credentials: { SLACK_TOKEN: "access-token" },
      tokens: { accessToken: "access-token", refreshToken: "refresh-token" },
      connectedAt: "2026-08-24T12:00:00.000Z",
      accountLabel: "Workspace",
    });

    expect(readStoredOAuthGrant({ [OAUTH_GRANT_CONFIG_KEY]: grant })).toEqual({
      credentials: { SLACK_TOKEN: "access-token" },
      tokens: { accessToken: "access-token", refreshToken: "refresh-token" },
      connectedAt: "2026-08-24T12:00:00.000Z",
      accountLabel: "Workspace",
    });
  });

  it("treats malformed encrypted-envelope content as absent", () => {
    expect(
      readStoredOAuthGrant({ [OAUTH_GRANT_CONFIG_KEY]: "{not JSON" })
    ).toBeNull();
  });

  it("removes the grant and keeps the manual value it was shadowing", () => {
    expect(
      removeStoredOAuthGrant({
        [OAUTH_GRANT_CONFIG_KEY]: "stored-grant",
        ACCESS_TOKEN: "manual-token",
        DEFAULT_SENDER: "alerts@example.com",
      })
    ).toEqual({
      ACCESS_TOKEN: "manual-token",
      DEFAULT_SENDER: "alerts@example.com",
    });
  });
});

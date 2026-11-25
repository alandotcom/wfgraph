import { describe, expect, it } from "vitest";
import { describeFailure } from "./run-failure";

const entityLabel = (type: string) => (type === "patient" ? "Patient" : type);

describe("describeFailure", () => {
  it("names the Connection a provider refused, and keeps the provider's answer", () => {
    expect(
      describeFailure({
        error: "Failed to send Slack message: invalid_auth",
        integrationLabel: "Slack",
        connection: { kind: "named", name: "Acme Slack" },
        entityLabel,
      })
    ).toEqual({
      sentence: "Slack rejected the credentials of the Connection Acme Slack.",
      detail: "Failed to send Slack message: invalid_auth",
      connectionCause: true,
    });
  });

  it("says a Connection lacks a credential the integration needs", () => {
    expect(
      describeFailure({
        error:
          "SLACK_API_KEY is not configured. Please add it in Project Integrations.",
        integrationLabel: "Slack",
        connection: { kind: "unknown" },
        entityLabel,
      })
    ).toMatchObject({
      sentence: "The step's Connection is missing a credential.",
      connectionCause: true,
    });
  });

  it("points a step whose Connection was deleted back to the step", () => {
    expect(
      describeFailure({
        error: "Failed to send Slack message: invalid_auth",
        integrationLabel: "Slack",
        connection: { kind: "deleted" },
        entityLabel,
      })
    ).toMatchObject({
      sentence:
        "The Connection this step used was deleted. Choose another Connection on the step in Draft.",
      connectionCause: false,
    });
  });

  it("words an Entity the app did not find with the Entity's label", () => {
    expect(
      describeFailure({
        error: 'Entity "patient" was not found for node data',
        integrationLabel: null,
        connection: { kind: "unknown" },
        entityLabel,
      })
    ).toEqual({
      sentence: "The app found no Patient for this run.",
      detail: 'Entity "patient" was not found for node data',
      connectionCause: false,
    });
  });

  it("states an error it does not recognize once, as it was stored", () => {
    expect(
      describeFailure({
        error: "Request timed out after 30s",
        integrationLabel: "Slack",
        connection: { kind: "named", name: "Acme Slack" },
        entityLabel,
      })
    ).toEqual({
      sentence: "Request timed out after 30s",
      detail: null,
      connectionCause: false,
    });
  });

  it("never blames a Connection for a step whose action has no integration", () => {
    expect(
      describeFailure({
        error: "401 Unauthorized",
        integrationLabel: null,
        connection: { kind: "unknown" },
        entityLabel,
      }).connectionCause
    ).toBe(false);
  });
});

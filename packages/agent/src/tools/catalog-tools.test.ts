import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { fixtureCatalog } from "#src/tools/catalog-fixture";
import { agentToolsFor } from "#src/testing";

const catalog = fixtureCatalog;

describe("list_actions", () => {
  it.effect("answers every action when no filter is given", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });
      const result = yield* tools.list_actions({});

      expect(result.actions.map((action) => action.id)).toEqual([
        "slack/send-message",
        "linear/create-issue",
        "score-applicant",
      ]);
      expect(result.totalInCatalog).toBe(3);
      expect(result.totalMatches).toBe(3);
      expect(result.truncated).toBe(false);
      expect(result.categories).toEqual(["Messaging", "Tracking", "Scoring"]);
    })
  );

  it.effect("limits a large result and reports that more matches exist", () =>
    Effect.gen(function* () {
      const largeCatalog: ExtensionCatalog = {
        ...catalog,
        actions: Array.from({ length: 60 }, (_, index) => ({
          id: `action-${index}`,
          label: `Action ${index}`,
          description: `Action number ${index}.`,
          category: "Generated",
          configFields: [],
          outputFields: [],
        })),
      };
      const { tools } = yield* agentToolsFor({ catalog: largeCatalog });

      const defaultPage = yield* tools.list_actions({});
      const result = yield* tools.list_actions({ limit: 5 });

      expect(defaultPage.actions).toHaveLength(20);
      expect(defaultPage.nextOffset).toBe(20);
      expect(result.actions).toHaveLength(5);
      expect(result.totalMatches).toBe(60);
      expect(result.truncated).toBe(true);
    })
  );

  it.effect("matches the query against label and description alike", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });

      const byLabel = yield* tools.list_actions({ query: "slack" });
      expect(byLabel.actions.map((action) => action.id)).toEqual([
        "slack/send-message",
      ]);

      const byDescription = yield* tools.list_actions({
        query: "without changing anything",
      });
      expect(byDescription.actions.map((action) => action.id)).toEqual([
        "score-applicant",
      ]);
    })
  );

  it.effect("filters by integration and by category", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });

      const byIntegration = yield* tools.list_actions({
        integration: "linear",
      });
      expect(byIntegration.actions.map((action) => action.id)).toEqual([
        "linear/create-issue",
      ]);

      const byCategory = yield* tools.list_actions({ category: "Scoring" });
      expect(byCategory.actions.map((action) => action.id)).toEqual([
        "score-applicant",
      ]);
    })
  );

  it.effect("leaves integration off a host-defined action", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });
      const result = yield* tools.list_actions({ query: "score" });

      const [action] = result.actions;
      expect(action?.integration).toBeUndefined();
      expect(action?.sideEffect).toBeUndefined();
    })
  );
});

describe("describe_action", () => {
  it.effect("describes how to author a built-in Event Split", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });
      const result = yield* tools.describe_action({
        actionId: "Event Split",
      });

      expect(result.action).toMatchObject({
        id: "Event Split",
        category: "System",
      });
      expect(result.authoringInstructions).toContain("event:<Event name>");
      expect(result.needsIntegration).toBe(false);
    })
  );

  it.effect("flattens field groups so every config key is one entry", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });
      const result = yield* tools.describe_action({
        actionId: "slack/send-message",
      });

      expect(result.configFields.map((field) => field.key)).toEqual([
        "channel",
        "text",
        "tone",
      ]);
      expect(result.needsIntegration).toBe(true);
    })
  );

  it.effect("reduces a select's options to the values a config may hold", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });
      const result = yield* tools.describe_action({
        actionId: "slack/send-message",
      });

      const tone = result.configFields.find((field) => field.key === "tone");
      expect(tone?.options).toEqual(["plain", "alert"]);
    })
  );

  it.effect("leaves the placeholder key off a field that declares none", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });
      const result = yield* tools.describe_action({
        actionId: "slack/send-message",
      });

      // toEqual reads a key holding undefined as an absent key, so this case
      // uses toStrictEqual, which compares the key list too.
      const channel = result.configFields.find(
        (field) => field.key === "channel"
      );
      expect(channel).toStrictEqual({
        key: "channel",
        label: "Channel",
        type: "template-input",
        required: true,
      });
    })
  );

  it.effect("carries the output fields a template token can address", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });
      const result = yield* tools.describe_action({
        actionId: "slack/send-message",
      });

      expect(result.outputFields).toEqual([
        { path: "ts", type: "string", description: "Slack message timestamp." },
        { path: "channelId", type: "string" },
      ]);
    })
  );

  it.effect("returns a failure the model can read for an unknown id", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });
      const failure = yield* Effect.flip(
        tools.describe_action({ actionId: "slack/no-such-action" })
      );

      expect(failure.reason).toContain("slack/no-such-action");
    })
  );

  it.effect("does not treat inherited object keys as built-in actions", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });
      const failure = yield* Effect.flip(
        tools.describe_action({ actionId: "toString" })
      );

      expect(failure.reason).toContain("toString");
    })
  );

  it.effect("says a host-defined action needs no integration", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });
      const result = yield* tools.describe_action({
        actionId: "score-applicant",
      });

      expect(result.needsIntegration).toBe(false);
    })
  );
});

describe("list_events", () => {
  it.effect("returns searchable Event summaries", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });
      const result = yield* tools.list_events({ query: "applicant" });

      expect(result.events.map((event) => event.name)).toEqual([
        "applicant.created",
        "applicant.withdrawn",
      ]);

      const [created, withdrawn] = result.events;
      expect(created).not.toHaveProperty("payloadFields");
      expect(created).not.toHaveProperty("correlationPath");
      expect(withdrawn?.description).toBeUndefined();
      expect(result.totalMatches).toBe(2);
      expect(result.truncated).toBe(false);
    })
  );

  it.effect("identifies the integration that owns an Event", () =>
    Effect.gen(function* () {
      const integrationCatalog: ExtensionCatalog = {
        ...catalog,
        events: [
          ...catalog.events,
          {
            name: "slack/message.received",
            label: "Slack message received",
            integration: "slack",
            payloadFields: [],
          },
        ],
      };
      const { tools } = yield* agentToolsFor({ catalog: integrationCatalog });

      const result = yield* tools.list_events({ integration: "slack" });

      expect(result.events).toEqual([
        expect.objectContaining({
          name: "slack/message.received",
          integration: "slack",
        }),
      ]);
    })
  );

  it.effect("limits a large Event result", () =>
    Effect.gen(function* () {
      const largeCatalog: ExtensionCatalog = {
        ...catalog,
        events: Array.from({ length: 60 }, (_, index) => ({
          name: `event.${index}`,
          label: `Event ${index}`,
          payloadFields: [],
        })),
      };
      const { tools } = yield* agentToolsFor({ catalog: largeCatalog });

      const defaultPage = yield* tools.list_events({});
      const result = yield* tools.list_events({ limit: 4 });

      expect(defaultPage.events).toHaveLength(20);
      expect(defaultPage.nextOffset).toBe(20);
      expect(result.events).toHaveLength(4);
      expect(result.totalMatches).toBe(60);
      expect(result.truncated).toBe(true);
    })
  );
});

describe("describe_event", () => {
  it.effect("returns payload fields and correlation details", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });

      const result = yield* tools.describe_event({
        eventName: "applicant.created",
      });

      expect(result.correlationPath).toBe("applicantId");
      expect(result.payloadFields.map((field) => field.path)).toEqual([
        "applicantId",
        "email",
        "score",
      ]);
    })
  );

  it.effect("identifies the value type of an open-record Event field", () =>
    Effect.gen(function* () {
      const openRecordCatalog: ExtensionCatalog = {
        ...catalog,
        events: [
          {
            name: "message.received",
            label: "Message received",
            payloadFields: [
              { path: "metadata", type: "object", valueType: "string" },
            ],
          },
        ],
      };
      const { tools } = yield* agentToolsFor({ catalog: openRecordCatalog });

      const result = yield* tools.describe_event({
        eventName: "message.received",
      });

      expect(result.payloadFields[0]).toMatchObject({
        path: "metadata",
        type: "object",
        valueType: "string",
      });
    })
  );

  it.effect("returns a useful failure for an unknown Event", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });

      const failure = yield* Effect.flip(
        tools.describe_event({ eventName: "missing.event" })
      );

      expect(failure.reason).toContain("missing.event");
    })
  );
});

describe("list_integrations", () => {
  it.effect("names the connections the operator has already made", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        catalog,
        integrations: [
          { id: "conn-1", type: "slack" },
          { id: "conn-2", type: "slack" },
        ],
      });
      const result = yield* tools.list_integrations();

      const slack = result.integrations.find((item) => item.type === "slack");
      const linear = result.integrations.find((item) => item.type === "linear");
      expect(slack?.connectionIds).toEqual(["conn-1", "conn-2"]);
      expect(linear?.connectionIds).toEqual([]);
    })
  );
});

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { parseConditionModel } from "@wfgraph/shared/conditions/condition-schema";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { readConfigString } from "@wfgraph/shared/graph/node-config";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import { readLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { fixtureCatalog } from "#src/tools/catalog-fixture";
import { agentToolsFor } from "#src/testing";

const catalog = fixtureCatalog;
const catalogWithTimestamp = {
  ...catalog,
  events: catalog.events.map((event) =>
    event.name === "applicant.created"
      ? {
          ...event,
          payloadFields: [
            ...event.payloadFields,
            { path: "createdAt", type: "timestamp" as const },
          ],
        }
      : event
  ),
};
const catalogWithTypeClash = {
  ...catalog,
  events: [
    {
      name: "first.received",
      label: "First received",
      payloadFields: [{ path: "shared", type: "string" as const }],
    },
    {
      name: "second.received",
      label: "Second received",
      payloadFields: [{ path: "shared", type: "number" as const }],
    },
  ],
};
const catalogWithIntegrationEvents: ExtensionCatalog = {
  ...catalog,
  events: [
    ...catalog.events,
    {
      name: "slack/message.received",
      label: "Slack message received",
      integration: "slack",
      correlationPath: "channelId",
      payloadFields: [{ path: "channelId", type: "string" }],
    },
    {
      name: "slack/reaction.added",
      label: "Slack reaction added",
      integration: "slack",
      correlationPath: "channelId",
      payloadFields: [{ path: "channelId", type: "string" }],
    },
  ],
};
const catalogWithCancelPath: ExtensionCatalog = {
  ...catalogWithIntegrationEvents,
  events: catalogWithIntegrationEvents.events.map((event) =>
    event.name === "applicant.withdrawn"
      ? { ...event, correlationPath: "applicantId" }
      : event
  ),
};

const entry: WorkflowNode = {
  id: "entry",
  position: { x: 0, y: 0 },
  type: "lifecycle",
  data: { label: "Lifecycle", type: "lifecycle", config: {} },
};

const conditionLifecycle: WorkflowNode = {
  ...entry,
  data: {
    ...entry.data,
    config: {
      lifecycleRules: {
        startEvents: ["applicant.created"],
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: false,
      },
    },
  },
};

const condition: WorkflowNode = {
  id: "branch",
  position: { x: 0, y: 0 },
  type: "action",
  data: {
    label: "Score high enough",
    type: "action",
    config: { actionType: "Condition" },
  },
};

const score: WorkflowNode = {
  id: "score",
  position: { x: 0, y: 0 },
  type: "action",
  data: {
    label: "Score applicant",
    type: "action",
    config: { actionType: "score-applicant" },
  },
};

const conditionEdges: WorkflowEdge[] = [
  {
    id: "entry-score",
    source: "entry",
    target: "score",
    sourceHandle: LIFECYCLE_STARTED_HANDLE,
  },
  { id: "score-condition", source: "score", target: "branch" },
];

/** A finished one-rule filter, as the Lifecycle panel serializes it. */
const startFilter = JSON.stringify({
  version: 2,
  groupLogic: "and",
  groups: [
    {
      id: "group",
      logic: "and",
      conditions: [
        {
          id: "rule",
          field: "applicantId",
          fieldType: "string",
          operator: "equals",
          value: "a_1",
        },
      ],
    },
  ],
});

/** An entry node already carrying a Start Filter. */
const filteredLifecycle: WorkflowNode = {
  ...entry,
  data: {
    ...entry.data,
    config: {
      lifecycleRules: {
        startEvents: ["applicant.created"],
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: false,
        startFilters: { "applicant.created": startFilter },
      },
    },
  },
};

/** An entry node already carrying a Cancel Filter. */
const cancelFilter = JSON.stringify({
  version: 2,
  groupLogic: "and",
  groups: [
    {
      id: "group",
      logic: "and",
      conditions: [
        {
          id: "rule",
          field: "applicantId",
          fieldType: "string",
          operator: "is_set",
        },
      ],
    },
  ],
});

const cancelFilteredLifecycle: WorkflowNode = {
  ...entry,
  data: {
    ...entry.data,
    config: {
      lifecycleRules: {
        startEvents: ["applicant.created"],
        cancelEvents: ["applicant.withdrawn"],
        concurrency: "unlimited",
        allowManualStart: false,
        correlationPaths: {
          "applicant.created": "applicantId",
          "applicant.withdrawn": "applicantId",
        },
        cancelFilters: { "applicant.withdrawn": cancelFilter },
      },
    },
  },
};

describe("set_lifecycle_rules", () => {
  it.effect("creates the Lifecycle Node when the workflow has none", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({ catalog });
      const result = yield* tools.set_lifecycle_rules({
        startEvents: ["applicant.created"],
        cancelEvents: ["applicant.withdrawn"],
        concurrency: "newest-wins",
        correlationPaths: [
          { event: "applicant.created", path: "applicantId" },
          { event: "applicant.withdrawn", path: "applicantId" },
        ],
      });

      const document = yield* draft.current;
      const [node] = document.nodes;
      expect(node?.data.type).toBe("lifecycle");
      // The tool takes a list, because a record cannot survive a strict
      // function schema; the rules store the record the rest of the repo reads.
      expect(readLifecycleRules(node?.data.config)).toEqual({
        startEvents: ["applicant.created"],
        cancelEvents: ["applicant.withdrawn"],
        concurrency: "newest-wins",
        correlationPaths: {
          "applicant.created": "applicantId",
          "applicant.withdrawn": "applicantId",
        },
      });
      expect(result.nodeId).toBe(node?.id);
      expect(result.summary).toContain("Created");
    })
  );

  it.effect("writes onto the entry node the workflow already has", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [entry],
        catalog,
      });
      const result = yield* tools.set_lifecycle_rules({
        startEvents: ["applicant.created"],
      });

      const document = yield* draft.current;
      expect(document.nodes).toHaveLength(1);
      expect(document.nodes[0]?.id).toBe("entry");
      expect(result.nodeId).toBe("entry");
      expect(readLifecycleRules(document.nodes[0]?.data.config)).toMatchObject({
        startEvents: ["applicant.created"],
        concurrency: "unlimited",
      });
    })
  );

  it.effect("refuses an Event the host never registered", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({ catalog });
      const failure = yield* Effect.flip(
        tools.set_lifecycle_rules({ startEvents: ["invoice.paid"] })
      );

      expect(failure.reason).toContain("invoice.paid");
      expect((yield* draft.current).nodes).toEqual([]);
    })
  );

  it.effect("refuses rules that leave a workflow with no way to start", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });
      const failure = yield* Effect.flip(
        tools.set_lifecycle_rules({ startEvents: [] })
      );

      expect(failure.reason).toContain("needs a way to start");
    })
  );

  it.effect("allows no Start Event when manual start is on", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({ catalog });
      yield* tools.set_lifecycle_rules({
        startEvents: [],
        allowManualStart: true,
      });

      expect(
        readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
      ).toMatchObject({ startEvents: [], allowManualStart: true });
    })
  );

  it.effect("refuses one Event holding both lifecycle roles", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({ catalog });
      const failure = yield* Effect.flip(
        tools.set_lifecycle_rules({
          startEvents: ["applicant.created"],
          cancelEvents: ["applicant.created"],
        })
      );

      expect(failure.reason).toContain("both start and cancel");
      expect((yield* draft.current).nodes).toEqual([]);
    })
  );

  it.effect("refuses a missing correlation path", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({ catalog });
      const failure = yield* Effect.flip(
        tools.set_lifecycle_rules({
          startEvents: ["applicant.created"],
          cancelEvents: ["applicant.withdrawn"],
        })
      );

      expect(failure.reason).toContain("applicant.withdrawn");
      expect(failure.reason).toContain("Correlation Path");
      expect((yield* draft.current).nodes).toEqual([]);
    })
  );

  it.effect("preserves omitted rules while adding a Cancel Event", () =>
    Effect.gen(function* () {
      const lifecycle: WorkflowNode = {
        ...filteredLifecycle,
        data: {
          ...filteredLifecycle.data,
          config: {
            lifecycleRules: {
              ...readLifecycleRules(filteredLifecycle.data.config)!,
              startEvents: ["applicant.created", "slack/message.received"],
              concurrency: "newest-wins",
              allowManualStart: true,
              correlationPaths: { "applicant.created": "candidateId" },
              connectionIds: { "slack/message.received": "slack-1" },
            },
          },
        },
      };
      const { tools, draft } = yield* agentToolsFor({
        nodes: [lifecycle],
        catalog: catalogWithCancelPath,
        integrations: [{ id: "slack-1", type: "slack" }],
      });

      yield* tools.set_lifecycle_rules({
        cancelEvents: ["applicant.withdrawn"],
      });

      expect(
        readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
      ).toEqual({
        startEvents: ["applicant.created", "slack/message.received"],
        cancelEvents: ["applicant.withdrawn"],
        concurrency: "newest-wins",
        allowManualStart: true,
        correlationPaths: { "applicant.created": "candidateId" },
        connectionIds: { "slack/message.received": "slack-1" },
        startFilters: { "applicant.created": startFilter },
      });
    })
  );

  it.effect(
    "clears correlation path overrides with an explicit empty list",
    () =>
      Effect.gen(function* () {
        const lifecycle: WorkflowNode = {
          ...entry,
          data: {
            ...entry.data,
            config: {
              lifecycleRules: {
                startEvents: ["applicant.created"],
                cancelEvents: [],
                concurrency: "unlimited",
                correlationPaths: { "applicant.created": "candidateId" },
              },
            },
          },
        };
        const { tools, draft } = yield* agentToolsFor({
          nodes: [lifecycle],
          catalog,
        });

        yield* tools.set_lifecycle_rules({ correlationPaths: [] });

        expect(
          readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
            ?.correlationPaths
        ).toBeUndefined();
      })
  );

  it.effect("patches one Correlation Path and preserves the other", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [cancelFilteredLifecycle],
        catalog: catalogWithCancelPath,
      });

      yield* tools.set_lifecycle_rules({
        correlationPaths: [
          { event: "applicant.withdrawn", path: "candidateId" },
        ],
      });

      expect(
        readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
          ?.correlationPaths
      ).toEqual({
        "applicant.created": "applicantId",
        "applicant.withdrawn": "candidateId",
      });
    })
  );

  it.effect("clears one Correlation Path and preserves the other", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [cancelFilteredLifecycle],
        catalog: catalogWithCancelPath,
      });

      yield* tools.set_lifecycle_rules({
        clearCorrelationPaths: ["applicant.withdrawn"],
      });

      expect(
        readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
          ?.correlationPaths
      ).toEqual({ "applicant.created": "applicantId" });
    })
  );

  it.effect("binds an integration Event to a matching Connection", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        catalog: catalogWithIntegrationEvents,
        integrations: [{ id: "slack-1", type: "slack" }],
      });

      yield* tools.set_lifecycle_rules({
        startEvents: ["slack/message.received"],
        eventConnections: [
          { event: "slack/message.received", connectionId: "slack-1" },
        ],
      });

      expect(
        readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
          ?.connectionIds
      ).toEqual({ "slack/message.received": "slack-1" });
    })
  );

  it.effect(
    "keeps an integration Event in a blocked draft when no Connection exists",
    () =>
      Effect.gen(function* () {
        const { tools, draft } = yield* agentToolsFor({
          catalog: catalogWithIntegrationEvents,
        });

        yield* tools.set_lifecycle_rules({
          startEvents: ["slack/message.received"],
        });

        expect(
          readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
        ).toMatchObject({
          startEvents: ["slack/message.received"],
        });
      })
  );

  it.effect(
    "keeps an integration Event unbound when several Connections match",
    () =>
      Effect.gen(function* () {
        const { tools, draft } = yield* agentToolsFor({
          catalog: catalogWithIntegrationEvents,
          integrations: [
            { id: "slack-1", type: "slack" },
            { id: "slack-2", type: "slack" },
          ],
        });

        yield* tools.set_lifecycle_rules({
          startEvents: ["slack/message.received"],
        });

        expect(
          readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
            ?.connectionIds
        ).toBeUndefined();
      })
  );

  it.effect("clears Event Connections with an explicit empty list", () =>
    Effect.gen(function* () {
      const lifecycle: WorkflowNode = {
        ...entry,
        data: {
          ...entry.data,
          config: {
            lifecycleRules: {
              startEvents: ["slack/message.received"],
              cancelEvents: [],
              concurrency: "unlimited",
              connectionIds: { "slack/message.received": "slack-1" },
            },
          },
        },
      };
      const { tools, draft } = yield* agentToolsFor({
        nodes: [lifecycle],
        catalog: catalogWithIntegrationEvents,
        integrations: [{ id: "slack-1", type: "slack" }],
      });

      yield* tools.set_lifecycle_rules({ eventConnections: [] });

      expect(
        readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
          ?.connectionIds
      ).toBeUndefined();
    })
  );

  it.effect("patches one Event Connection and preserves the other", () =>
    Effect.gen(function* () {
      const lifecycle: WorkflowNode = {
        ...entry,
        data: {
          ...entry.data,
          config: {
            lifecycleRules: {
              startEvents: ["slack/message.received", "slack/reaction.added"],
              cancelEvents: [],
              concurrency: "unlimited",
              connectionIds: {
                "slack/message.received": "slack-1",
                "slack/reaction.added": "slack-1",
              },
            },
          },
        },
      };
      const { tools, draft } = yield* agentToolsFor({
        nodes: [lifecycle],
        catalog: catalogWithIntegrationEvents,
        integrations: [
          { id: "slack-1", type: "slack" },
          { id: "slack-2", type: "slack" },
        ],
      });

      yield* tools.set_lifecycle_rules({
        eventConnections: [
          { event: "slack/reaction.added", connectionId: "slack-2" },
        ],
      });

      expect(
        readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
          ?.connectionIds
      ).toEqual({
        "slack/message.received": "slack-1",
        "slack/reaction.added": "slack-2",
      });
    })
  );

  it.effect("clears one Event Connection and preserves the other", () =>
    Effect.gen(function* () {
      const lifecycle: WorkflowNode = {
        ...entry,
        data: {
          ...entry.data,
          config: {
            lifecycleRules: {
              startEvents: ["slack/message.received", "slack/reaction.added"],
              cancelEvents: [],
              concurrency: "unlimited",
              connectionIds: {
                "slack/message.received": "slack-1",
                "slack/reaction.added": "slack-1",
              },
            },
          },
        },
      };
      const { tools, draft } = yield* agentToolsFor({
        nodes: [lifecycle],
        catalog: catalogWithIntegrationEvents,
        integrations: [{ id: "slack-1", type: "slack" }],
      });

      yield* tools.set_lifecycle_rules({
        clearEventConnections: ["slack/reaction.added"],
      });

      expect(
        readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
          ?.connectionIds
      ).toEqual({ "slack/message.received": "slack-1" });
    })
  );

  it.effect(
    "prunes Event-keyed values only for an Event that loses its role",
    () =>
      Effect.gen(function* () {
        const lifecycle: WorkflowNode = {
          ...entry,
          data: {
            ...entry.data,
            config: {
              lifecycleRules: {
                startEvents: ["slack/message.received", "slack/reaction.added"],
                cancelEvents: [],
                concurrency: "unlimited",
                correlationPaths: {
                  "slack/message.received": "channelId",
                  "slack/reaction.added": "channelId",
                },
                connectionIds: {
                  "slack/message.received": "slack-1",
                  "slack/reaction.added": "slack-1",
                },
              },
            },
          },
        };
        const { tools, draft } = yield* agentToolsFor({
          nodes: [lifecycle],
          catalog: catalogWithIntegrationEvents,
          integrations: [{ id: "slack-1", type: "slack" }],
        });

        yield* tools.set_lifecycle_rules({
          startEvents: ["slack/message.received"],
        });

        expect(
          readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
        ).toMatchObject({
          correlationPaths: { "slack/message.received": "channelId" },
          connectionIds: { "slack/message.received": "slack-1" },
        });
      })
  );

  it.effect(
    "inherits a preserved Connection for a new Event of the same integration",
    () =>
      Effect.gen(function* () {
        const lifecycle: WorkflowNode = {
          ...entry,
          data: {
            ...entry.data,
            config: {
              lifecycleRules: {
                startEvents: ["slack/message.received"],
                cancelEvents: [],
                concurrency: "unlimited",
                connectionIds: { "slack/message.received": "slack-1" },
              },
            },
          },
        };
        const { tools, draft } = yield* agentToolsFor({
          nodes: [lifecycle],
          catalog: catalogWithIntegrationEvents,
          integrations: [{ id: "slack-1", type: "slack" }],
        });

        yield* tools.set_lifecycle_rules({
          startEvents: ["slack/message.received", "slack/reaction.added"],
        });

        expect(
          readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
            ?.connectionIds
        ).toEqual({
          "slack/message.received": "slack-1",
          "slack/reaction.added": "slack-1",
        });
      })
  );

  it.effect(
    "refuses a missing or mistyped Event Connection before mutation",
    () =>
      Effect.gen(function* () {
        const { tools, draft } = yield* agentToolsFor({
          catalog: catalogWithIntegrationEvents,
          integrations: [
            { id: "slack-1", type: "slack" },
            { id: "linear-1", type: "linear" },
          ],
        });

        const missing = yield* Effect.flip(
          tools.set_lifecycle_rules({
            startEvents: ["slack/message.received"],
            eventConnections: [
              { event: "slack/message.received", connectionId: "missing" },
            ],
          })
        );
        expect(missing.reason).toContain("is not connected");

        const mistyped = yield* Effect.flip(
          tools.set_lifecycle_rules({
            startEvents: ["slack/message.received"],
            eventConnections: [
              { event: "slack/message.received", connectionId: "linear-1" },
            ],
          })
        );
        expect(mistyped.reason).toContain("needs a slack Connection");
        expect((yield* draft.current).nodes).toEqual([]);
      })
  );
});

describe("set_condition", () => {
  it.effect("refuses a field when the Condition has no references", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [entry, condition],
        catalog,
      });
      const failure = yield* Effect.flip(
        tools.set_condition({
          nodeId: "branch",
          groups: [
            {
              rules: [
                {
                  field: "score",
                  fieldType: "number",
                  operator: "greater_or_equal",
                  value: "80",
                },
              ],
            },
          ],
        })
      );

      expect(failure.reason).toContain("no available references");
    })
  );

  it.effect(
    "refuses a token-derived field when list_references gives a path",
    () =>
      Effect.gen(function* () {
        const { tools } = yield* agentToolsFor({
          nodes: [conditionLifecycle, score, condition],
          edges: conditionEdges,
          catalog,
        });

        const failure = yield* Effect.flip(
          tools.set_condition({
            nodeId: "branch",
            groups: [
              {
                rules: [
                  {
                    field: "score:Score applicant.score",
                    fieldType: "number",
                    operator: "greater_or_equal",
                    value: "80",
                  },
                ],
              },
            ],
          })
        );

        expect(failure.reason).toContain("path property");
        expect(failure.reason).toContain("score");
      })
  );

  it.effect("refuses a field type that disagrees with the reference", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [conditionLifecycle, score, condition],
        edges: conditionEdges,
        catalog,
      });
      const failure = yield* Effect.flip(
        tools.set_condition({
          nodeId: "branch",
          groups: [
            {
              rules: [
                {
                  field: "email",
                  fieldType: "timestamp",
                  operator: "is_set",
                },
              ],
            },
          ],
        })
      );

      expect(failure.reason).toContain("fieldType string");
    })
  );

  it.effect("refuses a field whose reaching Events disagree on its type", () =>
    Effect.gen(function* () {
      const lifecycle: WorkflowNode = {
        ...conditionLifecycle,
        data: {
          ...conditionLifecycle.data,
          config: {
            lifecycleRules: {
              startEvents: ["first.received", "second.received"],
              cancelEvents: [],
              concurrency: "unlimited",
              allowManualStart: false,
            },
          },
        },
      };
      const { tools } = yield* agentToolsFor({
        nodes: [lifecycle, condition],
        edges: [
          {
            id: "entry-condition",
            source: "entry",
            target: "branch",
            sourceHandle: LIFECYCLE_STARTED_HANDLE,
          },
        ],
        catalog: catalogWithTypeClash,
      });
      const failure = yield* Effect.flip(
        tools.set_condition({
          nodeId: "branch",
          groups: [
            {
              rules: [
                {
                  field: "shared",
                  fieldType: "string",
                  operator: "is_set",
                },
              ],
            },
          ],
        })
      );

      expect(failure.reason).toContain("condition-compatible type");
    })
  );

  it.effect("writes the model and the CEL it compiles to together", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [conditionLifecycle, score, condition],
        edges: conditionEdges,
        catalog,
      });
      yield* tools.set_condition({
        nodeId: "branch",
        groups: [
          {
            rules: [
              {
                field: "score",
                fieldType: "number",
                operator: "greater_or_equal",
                value: "80",
              },
            ],
          },
        ],
      });

      const config = (yield* draft.current).nodes.find(
        (node) => node.id === "branch"
      )?.data.config;
      const expression = readConfigString(config, "condition");
      const serialized = readConfigString(config, "conditionModel") ?? "";

      expect(expression).toContain(">=");
      expect(expression).toContain("80");

      const parsed = parseConditionModel(serialized);
      expect(parsed.valid).toBe(true);
    })
  );

  it.effect("joins groups and rules by the logic it is given", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [conditionLifecycle, score, condition],
        edges: conditionEdges,
        catalog,
      });
      yield* tools.set_condition({
        nodeId: "branch",
        groupLogic: "or",
        groups: [
          {
            logic: "and",
            rules: [
              {
                field: "score",
                fieldType: "number",
                operator: "greater_than",
                value: "50",
              },
              { field: "email", fieldType: "string", operator: "is_set" },
            ],
          },
          {
            rules: [
              {
                field: "email",
                fieldType: "string",
                operator: "contains",
                value: "@example.com",
              },
            ],
          },
        ],
      });

      const expression =
        readConfigString(
          (yield* draft.current).nodes.find((node) => node.id === "branch")
            ?.data.config,
          "condition"
        ) ?? "";
      expect(expression).toContain("||");
      expect(expression).toContain("&&");
    })
  );

  it.effect("escapes a value that would otherwise break the expression", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [conditionLifecycle, score, condition],
        edges: conditionEdges,
        catalog,
      });
      yield* tools.set_condition({
        nodeId: "branch",
        groups: [
          {
            rules: [
              {
                field: "email",
                fieldType: "string",
                operator: "equals",
                value: 'a"b\nc',
              },
            ],
          },
        ],
      });

      const expression =
        readConfigString(
          (yield* draft.current).nodes.find((node) => node.id === "branch")
            ?.data.config,
          "condition"
        ) ?? "";
      // The raw newline and quote never reach the expression; a hand-rolled
      // escape here is how a run silently never triggers.
      expect(expression).not.toContain("\n");
      expect(expression).toContain('\\"');
    })
  );

  it.effect("refuses a step that is not a Condition", () =>
    Effect.gen(function* () {
      const notACondition: WorkflowNode = {
        ...condition,
        data: { ...condition.data, config: { actionType: "score-applicant" } },
      };

      const { tools } = yield* agentToolsFor({
        nodes: [notACondition],
        catalog,
      });
      const failure = yield* Effect.flip(
        tools.set_condition({
          nodeId: "branch",
          groups: [
            {
              rules: [
                { field: "score", fieldType: "boolean", operator: "is_true" },
              ],
            },
          ],
        })
      );

      expect(failure.reason).toContain("not a Condition step");
    })
  );

  it.effect("names the operator and the field when a rule cannot be read", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [conditionLifecycle, score, condition],
        edges: conditionEdges,
        catalog,
      });

      const wrongOperator = yield* Effect.flip(
        tools.set_condition({
          nodeId: "branch",
          groups: [
            {
              rules: [
                { field: "score", fieldType: "number", operator: "contains" },
              ],
            },
          ],
        })
      );
      expect(wrongOperator.reason).toContain("not a number operator");

      const missingValue = yield* Effect.flip(
        tools.set_condition({
          nodeId: "branch",
          groups: [
            {
              rules: [
                { field: "score", fieldType: "number", operator: "equals" },
              ],
            },
          ],
        })
      );
      expect(missingValue.reason).toContain("numeric value");

      const blankValue = yield* Effect.flip(
        tools.set_condition({
          nodeId: "branch",
          groups: [
            {
              rules: [
                {
                  field: "score",
                  fieldType: "number",
                  operator: "equals",
                  value: "   ",
                },
              ],
            },
          ],
        })
      );
      expect(blankValue.reason).toContain("numeric value");

      const { tools: timestampTools } = yield* agentToolsFor({
        nodes: [conditionLifecycle, score, condition],
        edges: conditionEdges,
        catalog: catalogWithTimestamp,
      });
      const missingAmount = yield* Effect.flip(
        timestampTools.set_condition({
          nodeId: "branch",
          groups: [
            {
              rules: [
                {
                  field: "createdAt",
                  fieldType: "timestamp",
                  operator: "within_next",
                },
              ],
            },
          ],
        })
      );
      expect(missingAmount.reason).toContain("amount and unit");
    })
  );

  it.effect("refuses an empty condition rather than writing a blank test", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ nodes: [condition], catalog });

      const noGroups = yield* Effect.flip(
        tools.set_condition({ nodeId: "branch", groups: [] })
      );
      expect(noGroups.reason).toContain("at least one group");

      const noRules = yield* Effect.flip(
        tools.set_condition({ nodeId: "branch", groups: [{ rules: [] }] })
      );
      expect(noRules.reason).toContain("at least one rule");
    })
  );
});

/** Start Filters survive unrelated edits and follow their named Start Events. */
describe("set_lifecycle_rules and start filters", () => {
  it.effect("writes a Start Filter from Event payload fields", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({ catalog });

      yield* tools.set_lifecycle_rules({
        startEvents: ["applicant.created"],
        startFilters: [
          {
            event: "applicant.created",
            groups: [
              {
                rules: [
                  {
                    field: "score",
                    fieldType: "number",
                    operator: "greater_or_equal",
                    value: "80",
                  },
                ],
              },
            ],
          },
        ],
      });

      const rules = readLifecycleRules(
        (yield* draft.current).nodes[0]?.data.config
      );
      const parsed = parseConditionModel(
        rules?.startFilters?.["applicant.created"]
      );
      expect(parsed.valid).toBe(true);
      if (parsed.valid) {
        expect(parsed.model.groups[0]?.conditions[0]).toMatchObject({
          field: "score",
          fieldType: "number",
          operator: "greater_or_equal",
          value: 80,
        });
      }
    })
  );

  it.effect(
    "refuses a Start Filter for an Event that does not start the run",
    () =>
      Effect.gen(function* () {
        const { tools } = yield* agentToolsFor({ catalog });

        const failure = yield* Effect.flip(
          tools.set_lifecycle_rules({
            startEvents: ["applicant.created"],
            cancelEvents: ["applicant.withdrawn"],
            startFilters: [
              {
                event: "applicant.withdrawn",
                groups: [
                  {
                    rules: [
                      {
                        field: "applicantId",
                        fieldType: "string",
                        operator: "is_set",
                      },
                    ],
                  },
                ],
              },
            ],
          })
        );

        expect(failure.reason).toContain("Start Event");
      })
  );

  it.effect("refuses a Start Filter field absent from the Event payload", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });

      const failure = yield* Effect.flip(
        tools.set_lifecycle_rules({
          startEvents: ["applicant.created"],
          startFilters: [
            {
              event: "applicant.created",
              groups: [
                {
                  rules: [
                    {
                      field: "status",
                      fieldType: "string",
                      operator: "equals",
                      value: "confirmed",
                    },
                  ],
                },
              ],
            },
          ],
        })
      );

      expect(failure.reason).toContain("does not carry");
    })
  );

  it.effect("keeps a Start Filter the builder wrote", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [filteredLifecycle],
        catalog,
      });

      yield* tools.set_lifecycle_rules({
        startEvents: ["applicant.created"],
        cancelEvents: ["applicant.withdrawn"],
        correlationPaths: [
          { event: "applicant.created", path: "applicantId" },
          { event: "applicant.withdrawn", path: "applicantId" },
        ],
      });

      const document = yield* draft.current;
      expect(
        readLifecycleRules(document.nodes[0]?.data.config)?.startFilters
      ).toEqual({ "applicant.created": startFilter });
    })
  );

  it.effect(
    "patches and clears one Start Filter without changing another",
    () =>
      Effect.gen(function* () {
        const lifecycle: WorkflowNode = {
          ...filteredLifecycle,
          data: {
            ...filteredLifecycle.data,
            config: {
              lifecycleRules: {
                ...readLifecycleRules(filteredLifecycle.data.config)!,
                startEvents: ["applicant.created", "applicant.withdrawn"],
              },
            },
          },
        };
        const { tools, draft } = yield* agentToolsFor({
          nodes: [lifecycle],
          catalog,
        });

        yield* tools.set_lifecycle_rules({
          startFilters: [
            {
              event: "applicant.withdrawn",
              groups: [
                {
                  rules: [
                    {
                      field: "applicantId",
                      fieldType: "string",
                      operator: "is_set",
                    },
                  ],
                },
              ],
            },
          ],
        });

        expect(
          readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
            ?.startFilters
        ).toMatchObject({
          "applicant.created": startFilter,
          "applicant.withdrawn": expect.any(String),
        });

        yield* tools.set_lifecycle_rules({
          clearStartFilters: ["applicant.withdrawn"],
        });

        expect(
          readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
            ?.startFilters
        ).toEqual({ "applicant.created": startFilter });
      })
  );

  it.effect(
    "clears all Start Filters when the edit supplies an empty list",
    () =>
      Effect.gen(function* () {
        const { tools, draft } = yield* agentToolsFor({
          nodes: [filteredLifecycle],
          catalog,
        });

        yield* tools.set_lifecycle_rules({
          startEvents: ["applicant.created"],
          startFilters: [],
        });

        const document = yield* draft.current;
        expect(
          readLifecycleRules(document.nodes[0]?.data.config)?.startFilters
        ).toBeUndefined();
      })
  );

  it.effect("drops the filter of a Start Event the edit removed", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [filteredLifecycle],
        catalog,
      });

      yield* tools.set_lifecycle_rules({
        startEvents: ["applicant.withdrawn"],
        correlationPaths: [
          { event: "applicant.withdrawn", path: "applicantId" },
        ],
      });

      const document = yield* draft.current;
      expect(
        readLifecycleRules(document.nodes[0]?.data.config)?.startFilters
      ).toBeUndefined();
    })
  );
});

describe("set_lifecycle_rules and Cancel Filters", () => {
  it.effect("writes a Cancel Filter from Cancel Event payload fields", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({ catalog });

      yield* tools.set_lifecycle_rules({
        startEvents: ["applicant.created"],
        cancelEvents: ["applicant.withdrawn"],
        correlationPaths: [
          { event: "applicant.created", path: "applicantId" },
          { event: "applicant.withdrawn", path: "applicantId" },
        ],
        cancelFilters: [
          {
            event: "applicant.withdrawn",
            groups: [
              {
                rules: [
                  {
                    field: "applicantId",
                    fieldType: "string",
                    operator: "is_set",
                  },
                ],
              },
            ],
          },
        ],
      });

      const rules = readLifecycleRules(
        (yield* draft.current).nodes[0]?.data.config
      );
      const parsed = parseConditionModel(
        rules?.cancelFilters?.["applicant.withdrawn"]
      );
      expect(parsed.valid).toBe(true);
      if (parsed.valid) {
        expect(parsed.model.groups[0]?.conditions[0]).toMatchObject({
          field: "applicantId",
          fieldType: "string",
          operator: "is_set",
        });
      }
    })
  );

  it.effect(
    "refuses a Cancel Filter for an Event that does not cancel a run",
    () =>
      Effect.gen(function* () {
        const { tools } = yield* agentToolsFor({ catalog });

        const failure = yield* Effect.flip(
          tools.set_lifecycle_rules({
            startEvents: ["applicant.created"],
            cancelEvents: ["applicant.withdrawn"],
            correlationPaths: [
              { event: "applicant.created", path: "applicantId" },
              { event: "applicant.withdrawn", path: "applicantId" },
            ],
            cancelFilters: [
              {
                event: "applicant.created",
                groups: [
                  {
                    rules: [
                      {
                        field: "applicantId",
                        fieldType: "string",
                        operator: "is_set",
                      },
                    ],
                  },
                ],
              },
            ],
          })
        );

        expect(failure.reason).toContain("Cancel Event");
      })
  );

  it.effect("refuses more than one Cancel Filter for the same Event", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });

      const failure = yield* Effect.flip(
        tools.set_lifecycle_rules({
          startEvents: ["applicant.created"],
          cancelEvents: ["applicant.withdrawn"],
          cancelFilters: [
            {
              event: "applicant.withdrawn",
              groups: [
                {
                  rules: [
                    {
                      field: "applicantId",
                      fieldType: "string",
                      operator: "is_set",
                    },
                  ],
                },
              ],
            },
            {
              event: "applicant.withdrawn",
              groups: [
                {
                  rules: [
                    {
                      field: "applicantId",
                      fieldType: "string",
                      operator: "is_not_set",
                    },
                  ],
                },
              ],
            },
          ],
        })
      );

      expect(failure.reason).toContain("more than one Cancel Filter");
    })
  );

  it.effect(
    "refuses a Cancel Filter field absent from the Cancel Event payload",
    () =>
      Effect.gen(function* () {
        const { tools } = yield* agentToolsFor({ catalog });

        const failure = yield* Effect.flip(
          tools.set_lifecycle_rules({
            startEvents: ["applicant.created"],
            cancelEvents: ["applicant.withdrawn"],
            correlationPaths: [
              { event: "applicant.created", path: "applicantId" },
              { event: "applicant.withdrawn", path: "applicantId" },
            ],
            cancelFilters: [
              {
                event: "applicant.withdrawn",
                groups: [
                  {
                    rules: [
                      {
                        field: "score",
                        fieldType: "number",
                        operator: "greater_than",
                        value: "80",
                      },
                    ],
                  },
                ],
              },
            ],
          })
        );

        expect(failure.reason).toContain("does not carry");
      })
  );

  it.effect(
    "keeps a Cancel Filter the builder wrote when the edit omits it",
    () =>
      Effect.gen(function* () {
        const { tools, draft } = yield* agentToolsFor({
          nodes: [cancelFilteredLifecycle],
          catalog,
        });

        yield* tools.set_lifecycle_rules({
          startEvents: ["applicant.created"],
          cancelEvents: ["applicant.withdrawn"],
          correlationPaths: [
            { event: "applicant.created", path: "applicantId" },
            { event: "applicant.withdrawn", path: "applicantId" },
          ],
        });

        expect(
          readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
            ?.cancelFilters
        ).toEqual({ "applicant.withdrawn": cancelFilter });
      })
  );

  it.effect("updates an existing Cancel Filter when the edit supplies it", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [cancelFilteredLifecycle],
        catalog,
      });

      yield* tools.set_lifecycle_rules({
        startEvents: ["applicant.created"],
        cancelEvents: ["applicant.withdrawn"],
        correlationPaths: [
          { event: "applicant.created", path: "applicantId" },
          { event: "applicant.withdrawn", path: "applicantId" },
        ],
        cancelFilters: [
          {
            event: "applicant.withdrawn",
            groups: [
              {
                rules: [
                  {
                    field: "applicantId",
                    fieldType: "string",
                    operator: "is_not_set",
                  },
                ],
              },
            ],
          },
        ],
      });

      const parsed = parseConditionModel(
        readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
          ?.cancelFilters?.["applicant.withdrawn"]
      );
      expect(parsed.valid).toBe(true);
      if (parsed.valid) {
        expect(parsed.model.groups[0]?.conditions[0]).toMatchObject({
          operator: "is_not_set",
        });
      }
    })
  );

  it.effect("clears Cancel Filters when the edit supplies an empty list", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [cancelFilteredLifecycle],
        catalog,
      });

      yield* tools.set_lifecycle_rules({
        startEvents: ["applicant.created"],
        cancelEvents: ["applicant.withdrawn"],
        correlationPaths: [
          { event: "applicant.created", path: "applicantId" },
          { event: "applicant.withdrawn", path: "applicantId" },
        ],
        cancelFilters: [],
      });

      expect(
        readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
          ?.cancelFilters
      ).toBeUndefined();
    })
  );

  it.effect("clears a named Cancel Filter", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [cancelFilteredLifecycle],
        catalog,
      });

      yield* tools.set_lifecycle_rules({
        clearCancelFilters: ["applicant.withdrawn"],
      });

      expect(
        readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
          ?.cancelFilters
      ).toBeUndefined();
    })
  );

  it.effect(
    "drops a Cancel Filter when the edit removes its Cancel Event",
    () =>
      Effect.gen(function* () {
        const { tools, draft } = yield* agentToolsFor({
          nodes: [cancelFilteredLifecycle],
          catalog,
        });

        yield* tools.set_lifecycle_rules({
          startEvents: ["applicant.created"],
          cancelEvents: [],
        });

        expect(
          readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
            ?.cancelFilters
        ).toBeUndefined();
      })
  );
});

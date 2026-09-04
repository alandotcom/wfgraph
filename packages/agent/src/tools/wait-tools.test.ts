import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { parseConditionModel } from "@wfgraph/shared/conditions/condition-schema";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { formatTemplateToken } from "@wfgraph/shared/graph/node-references";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { fixtureCatalog } from "#src/tools/catalog-fixture";
import { agentToolsFor } from "#src/testing";

const lifecycle: WorkflowNode = {
  id: "entry",
  type: "lifecycle",
  position: { x: 0, y: 0 },
  data: { label: "Lifecycle", type: "lifecycle", config: {} },
};

const wait: WorkflowNode = {
  id: "wait",
  type: "action",
  position: { x: 0, y: 0 },
  data: {
    label: "Wait for reply",
    type: "action",
    config: {
      actionType: BUILT_IN_ACTION_IDS.wait,
      custom: "kept",
    },
  },
};

const documentInput = {
  nodes: [lifecycle, wait],
  edges: [
    {
      id: "entry-wait",
      source: "entry",
      target: "wait",
      sourceHandle: "started",
    },
  ],
  catalog: fixtureCatalog,
};

const timestampCatalog: ExtensionCatalog = {
  ...fixtureCatalog,
  events: [
    ...fixtureCatalog.events.map((event) =>
      event.name === "applicant.created"
        ? {
            ...event,
            payloadFields: [
              ...event.payloadFields,
              { path: "interviewAt", type: "timestamp" as const },
            ],
          }
        : event
    ),
    {
      name: "interview.rescheduled",
      label: "Interview rescheduled",
      payloadFields: [{ path: "occurredAt", type: "timestamp" }],
    },
  ],
};

const integrationEventCatalog: ExtensionCatalog = {
  ...fixtureCatalog,
  events: [
    ...fixtureCatalog.events,
    {
      name: "slack/message.received",
      label: "Slack message received",
      integration: "slack",
      payloadFields: [
        { path: "applicantId", type: "string" },
        {
          path: "metadata",
          type: "object",
          valueType: "string",
        },
      ],
    },
    {
      name: "slack/thread.replied",
      label: "Slack thread replied",
      integration: "slack",
      payloadFields: [{ path: "applicantId", type: "string" }],
    },
  ],
};

const eventLifecycle: WorkflowNode = {
  ...lifecycle,
  data: {
    ...lifecycle.data,
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

describe("set_wait", () => {
  it.effect("writes a canonical delay and clears stale Event settings", () =>
    Effect.gen(function* () {
      const staleWait: WorkflowNode = {
        ...wait,
        data: {
          ...wait.data,
          config: {
            ...wait.data.config,
            waitMode: "event",
            waitFor: [{ event: "applicant.withdrawn" }],
            waitTimeout: "7d",
            waitTimeoutBehavior: "skip",
          },
        },
      };
      const { tools, draft } = yield* agentToolsFor({
        ...documentInput,
        nodes: [lifecycle, staleWait],
      });

      yield* tools.set_wait({
        nodeId: "wait",
        wait: { mode: "duration", duration: "2d" },
      });

      expect((yield* draft.current).nodes[1]?.data.config).toEqual({
        actionType: BUILT_IN_ACTION_IDS.wait,
        custom: "kept",
        waitMode: "delay",
        waitDuration: "2d",
      });
    })
  );

  it.effect("waits until an upstream timestamp with a relative offset", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        ...documentInput,
        nodes: [eventLifecycle, wait],
        catalog: timestampCatalog,
      });
      const until = formatTemplateToken({
        nodeId: "entry",
        nodeLabel: "Lifecycle",
        fieldPath: "interviewAt",
      });

      yield* tools.set_wait({
        nodeId: "wait",
        wait: { mode: "until", timestamp: until, offset: "-1d" },
      });

      expect((yield* draft.current).nodes[1]?.data.config).toEqual({
        actionType: BUILT_IN_ACTION_IDS.wait,
        custom: "kept",
        waitMode: "delay",
        waitDelayTimingMode: "until",
        waitUntil: until,
        waitOffset: "-1d",
      });
    })
  );

  it.effect("refuses a non-timestamp reference for wait-until timing", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        ...documentInput,
        nodes: [eventLifecycle, wait],
      });
      const applicantId = formatTemplateToken({
        nodeId: "entry",
        nodeLabel: "Lifecycle",
        fieldPath: "applicantId",
      });

      const failure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: {
            mode: "until",
            timestamp: applicantId,
            offset: "-1d",
          },
        })
      );

      expect(failure.reason).toContain("timestamp");
      expect(failure.reason).toContain("list_references");
    })
  );

  it.effect("refuses an unreachable timestamp reference", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        ...documentInput,
        nodes: [eventLifecycle, wait],
        edges: [],
        catalog: timestampCatalog,
      });
      const interviewAt = formatTemplateToken({
        nodeId: "entry",
        nodeLabel: "Lifecycle",
        fieldPath: "interviewAt",
      });

      const failure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: { mode: "until", timestamp: interviewAt },
        })
      );

      expect(failure.reason).toContain("timestamp token");
      expect(failure.reason).toContain("list_references");
    })
  );

  it.effect("writes Event subscriptions with the safe timeout defaults", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor(documentInput);

      yield* tools.set_wait({
        nodeId: "wait",
        wait: {
          mode: "event",
          events: [{ event: "applicant.withdrawn" }],
        },
      });

      expect((yield* draft.current).nodes[1]?.data.config).toEqual({
        actionType: BUILT_IN_ACTION_IDS.wait,
        custom: "kept",
        waitMode: "event",
        waitFor: [{ event: "applicant.withdrawn" }],
        waitTimeout: "7d",
        waitTimeoutBehavior: "continue",
      });
    })
  );

  it.effect("writes an Event match against an exact upstream reference", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        ...documentInput,
        nodes: [eventLifecycle, wait],
      });
      const applicantId = formatTemplateToken({
        nodeId: "entry",
        nodeLabel: "Lifecycle",
        fieldPath: "applicantId",
      });

      yield* tools.set_wait({
        nodeId: "wait",
        wait: {
          mode: "event",
          events: [
            {
              event: "applicant.withdrawn",
              match: {
                groups: [
                  {
                    rules: [
                      {
                        field: "applicantId",
                        fieldType: "string",
                        operator: "equals",
                        value: applicantId,
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      });

      const subscriptions = (yield* draft.current).nodes[1]?.data.config
        ?.waitFor as
        | Array<{
            event: string;
            match?: string;
          }>
        | undefined;
      const subscription = subscriptions?.[0];
      expect(subscription?.event).toBe("applicant.withdrawn");
      const parsed = parseConditionModel(subscription?.match);
      expect(parsed.valid).toBe(true);
      if (parsed.valid) {
        expect(parsed.model.groups[0]?.conditions[0]).toMatchObject({
          field: "applicantId",
          value: applicantId,
        });
      }
    })
  );

  it.effect(
    "writes a timestamp Event match against an exact upstream reference",
    () =>
      Effect.gen(function* () {
        const { tools, draft } = yield* agentToolsFor({
          ...documentInput,
          nodes: [eventLifecycle, wait],
          catalog: timestampCatalog,
        });
        const interviewAt = formatTemplateToken({
          nodeId: "entry",
          nodeLabel: "Lifecycle",
          fieldPath: "interviewAt",
        });

        yield* tools.set_wait({
          nodeId: "wait",
          wait: {
            mode: "event",
            events: [
              {
                event: "interview.rescheduled",
                match: {
                  groups: [
                    {
                      rules: [
                        {
                          field: "occurredAt",
                          fieldType: "timestamp",
                          operator: "after",
                          dateTime: interviewAt,
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        });

        const config = (yield* draft.current).nodes[1]?.data.config;
        const subscription = Array.isArray(config?.waitFor)
          ? config.waitFor[0]
          : undefined;
        const parsed = parseConditionModel(
          subscription &&
            typeof subscription === "object" &&
            "match" in subscription
            ? subscription.match
            : undefined
        );
        expect(parsed.valid).toBe(true);
        if (!parsed.valid) {
          return;
        }
        expect(parsed.model.groups[0]?.conditions[0]).toMatchObject({
          field: "occurredAt",
          fieldType: "timestamp",
          operator: "after",
          dateTime: interviewAt,
        });
      })
  );

  it.effect("writes an open-record key in an Event match", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        ...documentInput,
        catalog: integrationEventCatalog,
        integrations: [{ id: "slack-1", type: "slack" }],
      });

      yield* tools.set_wait({
        nodeId: "wait",
        wait: {
          mode: "event",
          events: [
            {
              event: "slack/message.received",
              connectionId: "slack-1",
              match: {
                groups: [
                  {
                    rules: [
                      {
                        field: "metadata",
                        recordKey: "priority",
                        fieldType: "string",
                        operator: "equals",
                        value: "high",
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      });

      const subscriptions = (yield* draft.current).nodes[1]?.data.config
        ?.waitFor as
        | Array<{
            event: string;
            match?: string;
            connectionId?: string;
          }>
        | undefined;
      const subscription = subscriptions?.[0];
      expect(subscription?.connectionId).toBe("slack-1");
      const parsed = parseConditionModel(subscription?.match);
      expect(parsed.valid).toBe(true);
      if (parsed.valid) {
        expect(parsed.model.groups[0]?.conditions[0]).toMatchObject({
          field: "metadata",
          recordKey: "priority",
        });
      }
    })
  );

  it.effect("refuses an Event match field absent from its payload", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor(documentInput);

      const failure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: {
            mode: "event",
            events: [
              {
                event: "applicant.withdrawn",
                match: {
                  groups: [
                    {
                      rules: [
                        {
                          field: "email",
                          fieldType: "string",
                          operator: "is_set",
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        })
      );

      expect(failure.reason).toContain("does not carry");
      expect((yield* draft.current).nodes[1]?.data.config).toEqual(
        wait.data.config
      );
    })
  );

  it.effect(
    "refuses a Wait match value that is not an exact upstream token",
    () =>
      Effect.gen(function* () {
        const { tools, draft } = yield* agentToolsFor({
          ...documentInput,
          nodes: [eventLifecycle, wait],
        });
        const applicantId = formatTemplateToken({
          nodeId: "entry",
          nodeLabel: "Lifecycle",
          fieldPath: "applicantId",
        });

        const failure = yield* Effect.flip(
          tools.set_wait({
            nodeId: "wait",
            wait: {
              mode: "event",
              events: [
                {
                  event: "applicant.withdrawn",
                  match: {
                    groups: [
                      {
                        rules: [
                          {
                            field: "applicantId",
                            fieldType: "string",
                            operator: "equals",
                            value: `candidate ${applicantId}`,
                          },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          })
        );

        expect(failure.reason).toContain("exact token");
        expect((yield* draft.current).nodes[1]?.data.config).toEqual(
          wait.data.config
        );
      })
  );

  it.effect("refuses an unavailable exact token before mutation", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        ...documentInput,
        nodes: [eventLifecycle, wait],
      });

      const failure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: {
            mode: "event",
            events: [
              {
                event: "applicant.withdrawn",
                match: {
                  groups: [
                    {
                      rules: [
                        {
                          field: "applicantId",
                          fieldType: "string",
                          operator: "equals",
                          value: "{{@missing:Missing.applicantId}}",
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        })
      );

      expect(failure.reason).toContain("unavailable reference");
      expect((yield* draft.current).nodes[1]?.data.config).toEqual(
        wait.data.config
      );
    })
  );

  it.effect("refuses a malformed Wait match reference before mutation", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        ...documentInput,
        nodes: [eventLifecycle, wait],
      });

      const failure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: {
            mode: "event",
            events: [
              {
                event: "applicant.withdrawn",
                match: {
                  groups: [
                    {
                      rules: [
                        {
                          field: "applicantId",
                          fieldType: "string",
                          operator: "equals",
                          value: "{{@entry:Lifecycle.applicantId}",
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        })
      );

      expect(failure.reason).toContain("exact token");
      expect((yield* draft.current).nodes[1]?.data.config).toEqual(
        wait.data.config
      );
    })
  );

  it.effect("refuses an invalid Event Connection before mutation", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        ...documentInput,
        catalog: integrationEventCatalog,
        integrations: [{ id: "linear-1", type: "linear" }],
      });

      const failure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: {
            mode: "event",
            events: [
              {
                event: "slack/message.received",
                connectionId: "linear-1",
              },
            ],
          },
        })
      );

      expect(failure.reason).toContain("needs a slack Connection");
      expect((yield* draft.current).nodes[1]?.data.config).toEqual(
        wait.data.config
      );
    })
  );

  it.effect("refuses an unknown Event Connection before mutation", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        ...documentInput,
        catalog: integrationEventCatalog,
        integrations: [{ id: "slack-1", type: "slack" }],
      });

      const failure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: {
            mode: "event",
            events: [
              {
                event: "slack/message.received",
                connectionId: "missing",
              },
            ],
          },
        })
      );

      expect(failure.reason).toContain("not connected");
      expect((yield* draft.current).nodes[1]?.data.config).toEqual(
        wait.data.config
      );
    })
  );

  it.effect("refuses a Connection on a host Event before mutation", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        ...documentInput,
        integrations: [{ id: "slack-1", type: "slack" }],
      });

      const failure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: {
            mode: "event",
            events: [{ event: "applicant.withdrawn", connectionId: "slack-1" }],
          },
        })
      );

      expect(failure.reason).toContain("host Event");
      expect((yield* draft.current).nodes[1]?.data.config).toEqual(
        wait.data.config
      );
    })
  );

  it.effect("keeps an unconnected integration Event in the draft", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        ...documentInput,
        catalog: integrationEventCatalog,
      });

      yield* tools.set_wait({
        nodeId: "wait",
        wait: {
          mode: "event",
          events: [{ event: "slack/message.received" }],
        },
      });

      expect((yield* draft.current).nodes[1]?.data.config?.waitFor).toEqual([
        { event: "slack/message.received" },
      ]);
    })
  );

  it.effect("writes an explicit timeout and timeout behavior", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor(documentInput);

      yield* tools.set_wait({
        nodeId: "wait",
        wait: {
          mode: "event",
          events: [{ event: "applicant.withdrawn" }],
          timeout: "30d",
          timeoutBehavior: "skip",
        },
      });

      expect((yield* draft.current).nodes[1]?.data.config).toMatchObject({
        waitTimeout: "30d",
        waitTimeoutBehavior: "skip",
      });
    })
  );

  it.effect("preserves delay policies when changing the timing shape", () =>
    Effect.gen(function* () {
      const configuredWait: WorkflowNode = {
        ...wait,
        data: {
          ...wait.data,
          config: {
            ...wait.data.config,
            waitMode: "delay",
            waitDelayTimingMode: "until",
            waitUntil: "2027-01-01T09:00:00-05:00",
            waitOffset: "-1d",
            waitGateMode: "require_actual_wait",
            waitAllowedHoursMode: "daily_window",
            waitAllowedStartTime: "09:00",
            waitAllowedEndTime: "17:00",
            waitTimezone: "America/New_York",
          },
        },
      };
      const { tools, draft } = yield* agentToolsFor({
        ...documentInput,
        nodes: [lifecycle, configuredWait],
      });

      yield* tools.set_wait({
        nodeId: "wait",
        wait: { mode: "duration", duration: "2d" },
      });

      expect((yield* draft.current).nodes[1]?.data.config).toEqual({
        actionType: BUILT_IN_ACTION_IDS.wait,
        custom: "kept",
        waitMode: "delay",
        waitDuration: "2d",
        waitGateMode: "require_actual_wait",
        waitAllowedHoursMode: "daily_window",
        waitAllowedStartTime: "09:00",
        waitAllowedEndTime: "17:00",
        waitTimezone: "America/New_York",
      });
    })
  );

  it.effect("explicitly disables the gate and allowed-hours window", () =>
    Effect.gen(function* () {
      const configuredWait: WorkflowNode = {
        ...wait,
        data: {
          ...wait.data,
          config: {
            ...wait.data.config,
            waitMode: "delay",
            waitDuration: "1d",
            waitGateMode: "require_actual_wait",
            waitAllowedHoursMode: "daily_window",
            waitAllowedStartTime: "09:00",
            waitAllowedEndTime: "17:00",
            waitTimezone: "America/New_York",
          },
        },
      };
      const { tools, draft } = yield* agentToolsFor({
        ...documentInput,
        nodes: [lifecycle, configuredWait],
      });

      yield* tools.set_wait({
        nodeId: "wait",
        wait: {
          mode: "duration",
          duration: "2d",
          gateMode: "off",
          allowedHoursMode: "off",
        },
      });

      expect((yield* draft.current).nodes[1]?.data.config).toEqual({
        actionType: BUILT_IN_ACTION_IDS.wait,
        custom: "kept",
        waitMode: "delay",
        waitDuration: "2d",
        waitGateMode: "off",
        waitAllowedHoursMode: "off",
        waitTimezone: "America/New_York",
      });
    })
  );

  it.effect("writes an elapsed-time gate and daily allowed-hours window", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor(documentInput);

      yield* tools.set_wait({
        nodeId: "wait",
        wait: {
          mode: "duration",
          duration: "2d",
          gateMode: "require_actual_wait",
          allowedHoursMode: "daily_window",
          windowStart: "09:00",
          windowEnd: "17:00",
          timezone: "America/New_York",
        },
      });

      expect((yield* draft.current).nodes[1]?.data.config).toMatchObject({
        waitGateMode: "require_actual_wait",
        waitAllowedHoursMode: "daily_window",
        waitAllowedStartTime: "09:00",
        waitAllowedEndTime: "17:00",
        waitTimezone: "America/New_York",
      });
    })
  );

  it.effect("refuses an invalid allowed-hours window before mutation", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor(documentInput);

      const failure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: {
            mode: "duration",
            duration: "2d",
            allowedHoursMode: "daily_window",
            windowStart: "17:00",
            windowEnd: "09:00",
            timezone: "America/New_York",
          },
        })
      );

      expect(failure.reason).toContain("earlier than end");
      expect((yield* draft.current).nodes[1]?.data.config).toEqual(
        wait.data.config
      );
    })
  );

  it.effect("refuses an invalid daily-window timezone before mutation", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor(documentInput);

      const failure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: {
            mode: "duration",
            duration: "2d",
            allowedHoursMode: "daily_window",
            windowStart: "09:00",
            windowEnd: "17:00",
            timezone: "Mars/Olympus_Mons",
          },
        })
      );

      expect(failure.reason).toContain("IANA timezone");
      expect((yield* draft.current).nodes[1]?.data.config).toEqual(
        wait.data.config
      );
    })
  );

  it.effect(
    "preserves Event timeout behavior when changing subscriptions",
    () =>
      Effect.gen(function* () {
        const configuredWait: WorkflowNode = {
          ...wait,
          data: {
            ...wait.data,
            config: {
              ...wait.data.config,
              waitMode: "event",
              waitFor: [{ event: "applicant.created" }],
              waitTimeout: "30d",
              waitTimeoutBehavior: "skip",
            },
          },
        };
        const { tools, draft } = yield* agentToolsFor({
          ...documentInput,
          nodes: [lifecycle, configuredWait],
        });

        yield* tools.set_wait({
          nodeId: "wait",
          wait: {
            mode: "event",
            events: [{ event: "applicant.withdrawn" }],
          },
        });

        expect((yield* draft.current).nodes[1]?.data.config).toMatchObject({
          waitFor: [{ event: "applicant.withdrawn" }],
          waitTimeout: "30d",
          waitTimeoutBehavior: "skip",
        });
      })
  );

  it.effect("preserves omitted fields on a retained Event subscription", () =>
    Effect.gen(function* () {
      const storedMatch = JSON.stringify({
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
                value: "applicant-1",
              },
            ],
          },
        ],
      });
      const configuredWait: WorkflowNode = {
        ...wait,
        data: {
          ...wait.data,
          config: {
            ...wait.data.config,
            waitMode: "event",
            waitFor: [
              {
                event: "slack/message.received",
                connectionId: "slack-1",
                match: storedMatch,
              },
            ],
            waitTimeout: "30d",
            waitTimeoutBehavior: "skip",
          },
        },
      };
      const { tools, draft } = yield* agentToolsFor({
        ...documentInput,
        nodes: [lifecycle, configuredWait],
        catalog: integrationEventCatalog,
        integrations: [{ id: "slack-1", type: "slack" }],
      });

      yield* tools.set_wait({
        nodeId: "wait",
        wait: {
          mode: "event",
          events: [{ event: "slack/message.received" }],
        },
      });

      expect((yield* draft.current).nodes[1]?.data.config?.waitFor).toEqual([
        {
          event: "slack/message.received",
          connectionId: "slack-1",
          match: storedMatch,
        },
      ]);
    })
  );

  it.effect(
    "explicitly clears one Event match while keeping its Connection",
    () =>
      Effect.gen(function* () {
        const configuredWait: WorkflowNode = {
          ...wait,
          data: {
            ...wait.data,
            config: {
              ...wait.data.config,
              waitMode: "event",
              waitFor: [
                {
                  event: "slack/message.received",
                  connectionId: "slack-1",
                  match: "stored match",
                },
              ],
              waitTimeout: "7d",
              waitTimeoutBehavior: "continue",
            },
          },
        };
        const { tools, draft } = yield* agentToolsFor({
          ...documentInput,
          nodes: [lifecycle, configuredWait],
          catalog: integrationEventCatalog,
          integrations: [{ id: "slack-1", type: "slack" }],
        });

        yield* tools.set_wait({
          nodeId: "wait",
          wait: {
            mode: "event",
            events: [{ event: "slack/message.received", clearMatch: true }],
          },
        });

        expect((yield* draft.current).nodes[1]?.data.config?.waitFor).toEqual([
          { event: "slack/message.received", connectionId: "slack-1" },
        ]);
      })
  );

  it.effect("does not restore an explicitly cleared Event Connection", () =>
    Effect.gen(function* () {
      const configuredWait: WorkflowNode = {
        ...wait,
        data: {
          ...wait.data,
          config: {
            ...wait.data.config,
            waitMode: "event",
            waitFor: [
              {
                event: "slack/message.received",
                connectionId: "slack-1",
              },
              {
                event: "slack/thread.replied",
                connectionId: "slack-1",
              },
            ],
            waitTimeout: "7d",
            waitTimeoutBehavior: "continue",
          },
        },
      };
      const { tools, draft } = yield* agentToolsFor({
        ...documentInput,
        nodes: [lifecycle, configuredWait],
        catalog: integrationEventCatalog,
        integrations: [{ id: "slack-1", type: "slack" }],
      });

      yield* tools.set_wait({
        nodeId: "wait",
        wait: {
          mode: "event",
          events: [
            { event: "slack/message.received" },
            { event: "slack/thread.replied", clearConnection: true },
          ],
        },
      });

      expect((yield* draft.current).nodes[1]?.data.config?.waitFor).toEqual([
        { event: "slack/message.received", connectionId: "slack-1" },
        { event: "slack/thread.replied" },
      ]);
    })
  );

  it.effect("preserves an existing unbound Event when editing its match", () =>
    Effect.gen(function* () {
      const configuredWait: WorkflowNode = {
        ...wait,
        data: {
          ...wait.data,
          config: {
            ...wait.data.config,
            waitMode: "event",
            waitFor: [
              {
                event: "slack/message.received",
                connectionId: "slack-1",
              },
              { event: "slack/thread.replied" },
            ],
            waitTimeout: "7d",
            waitTimeoutBehavior: "continue",
          },
        },
      };
      const { tools, draft } = yield* agentToolsFor({
        ...documentInput,
        nodes: [lifecycle, configuredWait],
        catalog: integrationEventCatalog,
        integrations: [{ id: "slack-1", type: "slack" }],
      });

      yield* tools.set_wait({
        nodeId: "wait",
        wait: {
          mode: "event",
          events: [
            { event: "slack/message.received" },
            {
              event: "slack/thread.replied",
              match: {
                groups: [
                  {
                    rules: [
                      {
                        field: "applicantId",
                        fieldType: "string",
                        operator: "equals",
                        value: "applicant-1",
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      });

      expect((yield* draft.current).nodes[1]?.data.config?.waitFor).toEqual([
        { event: "slack/message.received", connectionId: "slack-1" },
        {
          event: "slack/thread.replied",
          match: expect.any(String),
        },
      ]);
    })
  );

  it.effect("refuses duplicate Event subscriptions", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor(documentInput);

      const failure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: {
            mode: "event",
            events: [
              { event: "applicant.withdrawn" },
              { event: "applicant.withdrawn" },
            ],
          },
        })
      );

      expect(failure.reason).toContain("appears more than once");
      expect((yield* draft.current).nodes[1]?.data.config).toEqual(
        wait.data.config
      );
    })
  );

  it.effect("refuses a Wait match reference with the wrong type", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        ...documentInput,
        nodes: [eventLifecycle, wait],
        catalog: timestampCatalog,
      });
      const applicantId = formatTemplateToken({
        nodeId: "entry",
        nodeLabel: "Lifecycle",
        fieldPath: "applicantId",
      });

      const failure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: {
            mode: "event",
            events: [
              {
                event: "interview.rescheduled",
                match: {
                  groups: [
                    {
                      rules: [
                        {
                          field: "occurredAt",
                          fieldType: "timestamp",
                          operator: "after",
                          dateTime: applicantId,
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        })
      );

      expect(failure.reason).toContain("must have type timestamp");
      expect((yield* draft.current).nodes[1]?.data.config).toEqual(
        wait.data.config
      );
    })
  );

  it.effect("preserves an omitted offset while changing until timing", () =>
    Effect.gen(function* () {
      const configuredWait: WorkflowNode = {
        ...wait,
        data: {
          ...wait.data,
          config: {
            ...wait.data.config,
            waitMode: "delay",
            waitDelayTimingMode: "until",
            waitUntil: "2027-01-01T09:00:00-05:00",
            waitOffset: "-1d",
          },
        },
      };
      const { tools, draft } = yield* agentToolsFor({
        ...documentInput,
        nodes: [lifecycle, configuredWait],
      });

      yield* tools.set_wait({
        nodeId: "wait",
        wait: {
          mode: "until",
          timestamp: "2027-02-01T09:00:00-05:00",
        },
      });

      expect((yield* draft.current).nodes[1]?.data.config?.waitOffset).toBe(
        "-1d"
      );
    })
  );

  it.effect("explicitly clears an until offset", () =>
    Effect.gen(function* () {
      const configuredWait: WorkflowNode = {
        ...wait,
        data: {
          ...wait.data,
          config: {
            ...wait.data.config,
            waitMode: "delay",
            waitDelayTimingMode: "until",
            waitUntil: "2027-01-01T09:00:00-05:00",
            waitOffset: "-1d",
          },
        },
      };
      const { tools, draft } = yield* agentToolsFor({
        ...documentInput,
        nodes: [lifecycle, configuredWait],
      });

      yield* tools.set_wait({
        nodeId: "wait",
        wait: {
          mode: "until",
          timestamp: "2027-02-01T09:00:00-05:00",
          clearOffset: true,
        },
      });

      expect(
        (yield* draft.current).nodes[1]?.data.config?.waitOffset
      ).toBeUndefined();
    })
  );

  it.effect("refuses an empty Event subscription list", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor(documentInput);

      const failure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: { mode: "event", events: [] },
        })
      );

      expect(failure.reason).toContain("at least one Event");
    })
  );

  it.effect("refuses an Event absent from the host catalog", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor(documentInput);

      const failure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: { mode: "event", events: [{ event: "invoice.paid" }] },
        })
      );

      expect(failure.reason).toContain("list_events");
    })
  );

  it.effect("refuses a node that is not a Wait step", () =>
    Effect.gen(function* () {
      const action: WorkflowNode = {
        ...wait,
        data: {
          ...wait.data,
          config: { actionType: "score-applicant" },
        },
      };
      const { tools } = yield* agentToolsFor({
        ...documentInput,
        nodes: [lifecycle, action],
      });

      const failure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: { mode: "duration", duration: "2d" },
        })
      );

      expect(failure.reason).toContain("not a Wait step");
    })
  );

  it.effect("refuses malformed delay and timeout durations", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor(documentInput);

      const delayFailure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: { mode: "duration", duration: "later" },
        })
      );
      const timeoutFailure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: {
            mode: "event",
            events: [{ event: "applicant.withdrawn" }],
            timeout: "eventually",
          },
        })
      );

      expect(delayFailure.reason).toContain("valid duration");
      expect(timeoutFailure.reason).toContain("valid duration");
    })
  );
});

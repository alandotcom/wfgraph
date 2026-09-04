/**
 * Structured authoring for the Wait step's two modes.
 *
 * The tool writes one complete timing or Event shape. It clears keys owned by a
 * mode that the edit leaves and preserves optional settings within the retained
 * mode unless the input explicitly changes them.
 */

import { Effect, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { conditionTypeOf } from "@wfgraph/shared/conditions/condition-field-type";
import {
  type ConditionModel,
  readConditionRuleOperand,
} from "@wfgraph/shared/conditions/condition-model";
import { serializeConditionModel } from "@wfgraph/shared/conditions/condition-schema";
import { findEvent } from "@wfgraph/shared/extensions/catalog";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  actionTypeOf,
  readConfigString,
} from "@wfgraph/shared/graph/node-config";
import { findTemplateTokens } from "@wfgraph/shared/graph/node-references";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { inheritConnections } from "@wfgraph/shared/lifecycle/event-connections";
import {
  DEFAULT_WAIT_TIMEOUT,
  type EventSubscription,
  readWaitDelayTiming,
  readWaitSubscriptions,
} from "@wfgraph/shared/lifecycle/wait-subscription";
import { isBlank } from "@wfgraph/shared/types/string";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  parseDurationMs,
  parseTimestampWithTimezone,
} from "@wfgraph/shared/utils/wait-time";
import { validateWaitAllowedHoursConfig } from "@wfgraph/shared/utils/wait-allowed-hours";
import { type AgentDocument, WorkflowDraft } from "#src/document";
import {
  conditionGroupsSchema,
  type ConditionGroupsInput,
  readWaitMatchModelInput,
} from "#src/tools/condition-input";
import { referencesForNode } from "#src/tools/reference-tools";
import {
  brokenReferenceWarning,
  explainArrivingEventChange,
  referencesBrokenBetween,
} from "#src/tools/reference-diagnosis";

const failureSchema = Schema.Struct({ reason: Schema.String });
const writeResultSchema = Schema.Struct({
  summary: Schema.String,
  /**
   * Present when this edit stopped a token below this node resolving. Nothing
   * else reports that before Publish, so act on it in the same turn.
   */
  warning: Schema.optionalKey(Schema.String),
});

const waitForSchema = Schema.Array(
  Schema.Struct({
    event: Schema.String.annotate({
      description: "An Event name exactly as list_events returned it.",
    }),
    match: Schema.optionalKey(
      Schema.Struct({
        groupLogic: Schema.optionalKey(Schema.Literals(["and", "or"])).annotate(
          {
            description: "How the match groups combine. Defaults to and.",
          }
        ),
        groups: conditionGroupsSchema,
      })
    ).annotate({
      description:
        "A predicate on this Event's payload. A string or absolute timestamp operand may be one exact token returned by list_references.",
    }),
    clearMatch: Schema.optionalKey(Schema.Boolean).annotate({
      description:
        "Set to true to remove this Event's stored match. Omit to preserve the match.",
    }),
    connectionId: Schema.optionalKey(Schema.String).annotate({
      description:
        "The matching connectionId from list_integrations when an integration owns this Event.",
    }),
    clearConnection: Schema.optionalKey(Schema.Boolean).annotate({
      description:
        "Set to true to remove this Event's stored Connection. Omit to preserve the Connection.",
    }),
  })
);

const delayPolicyFields = {
  gateMode: Schema.optionalKey(
    Schema.Literals(["off", "require_actual_wait"])
  ).annotate({
    description:
      "Whether an already-due target continues immediately or skips the branch. Omit to preserve it while changing delay timing.",
  }),
  allowedHoursMode: Schema.optionalKey(
    Schema.Literals(["off", "daily_window"])
  ).annotate({
    description:
      "Whether the wait may end at any time or only inside a daily window. Omit to preserve it while changing delay timing.",
  }),
  windowStart: Schema.optionalKey(Schema.String).annotate({
    description:
      'The daily window start in 24-hour HH:MM form, such as "09:00".',
  }),
  windowEnd: Schema.optionalKey(Schema.String).annotate({
    description: 'The daily window end in 24-hour HH:MM form, such as "17:00".',
  }),
  timezone: Schema.optionalKey(Schema.String).annotate({
    description:
      "The IANA timezone for a local timestamp or daily window. Omit to preserve it while changing delay timing.",
  }),
};

const waitInputSchema = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("duration").annotate({
      description: "Wait for a duration measured from now.",
    }),
    duration: Schema.String.annotate({
      description: 'How long to wait, such as "2d".',
    }),
    ...delayPolicyFields,
  }),
  Schema.Struct({
    mode: Schema.Literal("until").annotate({
      description: "Wait until an absolute date/time.",
    }),
    timestamp: Schema.String.annotate({
      description:
        "The exact timestamp token from list_references, or an ISO timestamp.",
    }),
    offset: Schema.optionalKey(Schema.String).annotate({
      description:
        'A duration added to the timestamp, such as "-1d" for one day before or "6h" for six hours after.',
    }),
    clearOffset: Schema.optionalKey(Schema.Boolean).annotate({
      description:
        "Set to true to remove the stored offset. Omit to preserve the offset when the Wait already uses until timing.",
    }),
    ...delayPolicyFields,
  }),
  Schema.Struct({
    mode: Schema.Literal("event").annotate({
      description: "Wait until an Event arrives or the timeout expires.",
    }),
    events: waitForSchema.annotate({
      description:
        "At least one Event subscription. Call list_events first and use exact Event names.",
    }),
    timeout: Schema.optionalKey(Schema.String).annotate({
      description:
        'How long to wait for an Event, such as "7d". Defaults to the safe system timeout.',
    }),
    timeoutBehavior: Schema.optionalKey(
      Schema.Literals(["continue", "skip"])
    ).annotate({
      description:
        "What happens after the timeout. continue follows outgoing edges; skip ends this path. Defaults to continue.",
    }),
  }),
]).annotate({
  description: "The one Wait mode and the fields that mode requires.",
});

const setWaitInputSchema = Schema.Struct({
  nodeId: Schema.String.annotate({
    description: "The Wait node to configure, from read_workflow.",
  }),
  wait: waitInputSchema,
});

export const SetWait = Tool.make("set_wait", {
  description:
    "Configure a Wait step for a duration, until a date/time, or for Event subscriptions. Use until timing when the request names a date/time from an earlier step, and call list_references first. Omitted optional fields preserve settings owned by the retained mode. Event mode makes this Wait the Arriving Event for every node below it, which replaces the Start Event payload the Lifecycle Node offers there: a step that reads the Start Event payload belongs above this Wait, and any token below it that this edit breaks comes back as a warning.",
  parameters: setWaitInputSchema,
  success: writeResultSchema,
  failure: failureSchema,
  failureMode: "return",
});

type SetWaitInput = typeof setWaitInputSchema.Type;

function eventMatchFieldFailure(input: {
  eventName: string;
  match: { readonly groups: ConditionGroupsInput };
  catalog: ExtensionCatalog;
}): string | undefined {
  const event = findEvent(input.catalog, input.eventName);
  if (!event) {
    return undefined;
  }

  for (const group of input.match.groups) {
    for (const rule of group.rules) {
      const field = event.payloadFields.find(
        (candidate) => candidate.path === rule.field
      );
      if (!field) {
        return `The match for ${input.eventName} reads ${rule.field}, which that Event does not carry.`;
      }
      const expectedType = conditionTypeOf(field);
      if (expectedType === null) {
        return `The match field ${rule.field} has no condition-compatible type.`;
      }
      if (expectedType !== rule.fieldType) {
        return `Use fieldType ${expectedType} for ${rule.field}, as describe_event reports.`;
      }
      if (field.valueType && !rule.recordKey?.trim()) {
        return `${rule.field} is an open record. Supply recordKey for the value to compare.`;
      }
      if (!field.valueType && rule.recordKey !== undefined) {
        return `${rule.field} is not an open record and does not take recordKey.`;
      }
    }
  }

  return undefined;
}

function matchReferenceFailure(input: {
  model: ConditionModel;
  nodeId: string;
  document: AgentDocument;
  catalog: ExtensionCatalog;
}): string | undefined {
  const references = referencesForNode({
    nodeId: input.nodeId,
    document: input.document,
    catalog: input.catalog,
  });
  const byToken = new Map(
    (references ?? []).map((reference) => [reference.token, reference])
  );

  for (const group of input.model.groups) {
    for (const rule of group.conditions) {
      const operand = readConditionRuleOperand(rule);
      if (!operand) {
        continue;
      }
      const tokens = findTemplateTokens(operand);
      if (tokens.length === 0 && operand.includes("{{")) {
        return "A Wait match reference must be one exact token from list_references.";
      }
      if (tokens.length === 0) {
        continue;
      }
      if (tokens.length !== 1 || tokens[0]?.raw !== operand) {
        return "A Wait match reference must be one exact token from list_references.";
      }
      const reference = byToken.get(operand);
      if (!reference) {
        return "A Wait match uses an unavailable reference. Use an exact token from list_references.";
      }
      if (reference.conditionFieldType !== rule.fieldType) {
        return `The Wait match reference must have type ${rule.fieldType}.`;
      }
    }
  }

  return undefined;
}

const WAIT_OWNED_KEYS = new Set([
  "waitMode",
  "waitFor",
  "waitTimeout",
  "waitTimeoutBehavior",
  "waitDuration",
  "waitUntil",
  "waitOffset",
  "waitDelayTimingMode",
  "waitGateMode",
  "waitAllowedHoursMode",
  "waitAllowedStartTime",
  "waitAllowedEndTime",
  "waitTimezone",
]);

function configOutsideWait(node: WorkflowNode): Record<string, unknown> {
  // oxlint-disable-next-line wfgraph/no-entries-round-trip -- node.data.config is stored JSON and can carry an own __proto__ key. Object.fromEntries defines that key as an own property; key-by-key assignment would reach the prototype setter and lose it.
  return Object.fromEntries(
    Object.entries(node.data.config ?? {}).filter(
      ([key]) => !WAIT_OWNED_KEYS.has(key)
    )
  );
}

function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

type DelayWaitInput = Exclude<SetWaitInput["wait"], { readonly mode: "event" }>;

function readDelayPolicy(input: {
  wait: DelayWaitInput;
  stored: Record<string, unknown>;
}):
  | { readonly ok: true; readonly config: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string } {
  const preserve = input.stored.waitMode !== "event";
  const gateMode =
    input.wait.gateMode ??
    (preserve ? readConfigString(input.stored, "waitGateMode") : undefined);
  const allowedHoursMode =
    input.wait.allowedHoursMode ??
    (preserve
      ? readConfigString(input.stored, "waitAllowedHoursMode")
      : undefined);
  const windowStart =
    input.wait.allowedHoursMode === "off"
      ? undefined
      : (input.wait.windowStart ??
        (preserve
          ? readConfigString(input.stored, "waitAllowedStartTime")
          : undefined));
  const windowEnd =
    input.wait.allowedHoursMode === "off"
      ? undefined
      : (input.wait.windowEnd ??
        (preserve
          ? readConfigString(input.stored, "waitAllowedEndTime")
          : undefined));
  const timezone =
    input.wait.timezone ??
    (preserve ? readConfigString(input.stored, "waitTimezone") : undefined);

  const windowIssues = validateWaitAllowedHoursConfig({
    mode: allowedHoursMode,
    startTime: windowStart,
    endTime: windowEnd,
  });
  if (windowIssues.length > 0) {
    return {
      ok: false,
      reason: windowIssues.map((issue) => issue.message).join(" "),
    };
  }
  if (allowedHoursMode === "daily_window") {
    if (!timezone?.trim()) {
      return {
        ok: false,
        reason: "Timezone is required when the daily window is enabled.",
      };
    }
    if (!validTimeZone(timezone)) {
      return {
        ok: false,
        reason: "The daily window needs a valid IANA timezone.",
      };
    }
  }

  return {
    ok: true,
    config: omitUndefined({
      waitGateMode: gateMode,
      waitAllowedHoursMode: allowedHoursMode,
      waitAllowedStartTime: windowStart,
      waitAllowedEndTime: windowEnd,
      waitTimezone: timezone,
    }),
  };
}

export const waitToolHandlers = Effect.gen(function* () {
  const draft = yield* WorkflowDraft;

  return {
    set_wait: (input: SetWaitInput) =>
      Effect.flatMap(draft.current, (document) => {
        const node = document.nodes.find(
          (candidate) => candidate.id === input.nodeId
        );
        if (!node) {
          return Effect.fail({
            reason: "That Wait step is absent from the graph.",
          });
        }
        if (actionTypeOf(node) !== BUILT_IN_ACTION_IDS.wait) {
          return Effect.fail({
            reason: `${node.data.label || node.id} is not a Wait step.`,
          });
        }

        const storedConfig = node.data.config ?? {};
        const baseConfig = configOutsideWait(node);
        const wait = input.wait;
        let waitConfig: Record<string, unknown>;
        if (wait.mode === "duration") {
          if (parseDurationMs(wait.duration) === null) {
            return Effect.fail({
              reason: "A Wait needs a valid duration such as 2d or 48h.",
            });
          }
          const policy = readDelayPolicy({ wait, stored: storedConfig });
          if (!policy.ok) {
            return Effect.fail({ reason: policy.reason });
          }
          waitConfig = {
            waitMode: "delay",
            waitDuration: wait.duration,
            ...policy.config,
          };
        } else if (wait.mode === "until") {
          if (isBlank(wait.timestamp)) {
            return Effect.fail({
              reason:
                "Until timing needs a timestamp from list_references or an ISO timestamp.",
            });
          }

          const policy = readDelayPolicy({ wait, stored: storedConfig });
          if (!policy.ok) {
            return Effect.fail({ reason: policy.reason });
          }
          const timezone = readConfigString(policy.config, "waitTimezone");
          const tokens = findTemplateTokens(wait.timestamp);
          if (tokens.length > 0) {
            const reference = referencesForNode({
              nodeId: input.nodeId,
              document,
              catalog: draft.catalog,
            })?.find((candidate) => candidate.token === wait.timestamp);
            if (reference?.type !== "timestamp") {
              // Naming only the tool that supplies tokens is no help when the
              // token did come from it and the graph changed underneath, which
              // is what an Event Wait added since then does.
              const because =
                reference === undefined
                  ? explainArrivingEventChange({
                      token: wait.timestamp,
                      nodeId: input.nodeId,
                      document,
                      catalog: draft.catalog,
                    })
                  : `That token holds ${reference.type ?? "no declared type"} rather than a timestamp.`;

              return Effect.fail({
                reason: `Until timing needs a timestamp token this step can read, and ${wait.timestamp} is not one.${because ? ` ${because}` : ""} Call read_workflow, then list_references for this step, before writing again.`,
              });
            }
          } else if (
            parseTimestampWithTimezone(wait.timestamp, timezone) === null
          ) {
            return Effect.fail({
              reason:
                "Until timing needs an exact timestamp token from list_references or a valid ISO timestamp.",
            });
          }

          if (wait.offset !== undefined && wait.clearOffset === true) {
            return Effect.fail({
              reason: "Set offset or clearOffset, not both.",
            });
          }
          const storedOffset =
            storedConfig.waitMode !== "event" &&
            readWaitDelayTiming(storedConfig) === "until"
              ? readConfigString(storedConfig, "waitOffset")
              : undefined;
          const offset = wait.clearOffset
            ? undefined
            : (wait.offset ?? storedOffset);
          if (offset !== undefined && parseDurationMs(offset) === null) {
            return Effect.fail({
              reason:
                "An until offset must be a valid duration such as -1d or 6h.",
            });
          }
          waitConfig = {
            waitMode: "delay",
            waitDelayTimingMode: "until",
            waitUntil: wait.timestamp,
            ...omitUndefined({ waitOffset: offset }),
            ...policy.config,
          };
        } else {
          if (wait.events.length === 0) {
            return Effect.fail({
              reason: "Event mode needs at least one Event.",
            });
          }
          const storedSubscriptions =
            storedConfig.waitMode === "event"
              ? readWaitSubscriptions(storedConfig)
              : [];
          const storedByEvent = new Map(
            storedSubscriptions.map((subscription) => [
              subscription.event,
              subscription,
            ])
          );
          const subscriptions: EventSubscription[] = [];
          const eventNames = new Set<string>();
          const connectionsExcludedFromInheritance = new Set<string>();
          for (const subscription of wait.events) {
            const event = findEvent(draft.catalog, subscription.event);
            if (!event) {
              return Effect.fail({
                reason:
                  "A waitFor Event is absent from the host catalog. Call list_events and use an exact Event name.",
              });
            }
            if (eventNames.has(subscription.event)) {
              return Effect.fail({
                reason: `Wait for ${subscription.event} appears more than once. Supply one subscription per Event.`,
              });
            }
            eventNames.add(subscription.event);

            if (
              subscription.connectionId !== undefined &&
              subscription.clearConnection === true
            ) {
              return Effect.fail({
                reason: `Set connectionId or clearConnection for ${subscription.event}, not both.`,
              });
            }
            const storedSubscription = storedByEvent.get(subscription.event);
            const connectionId = subscription.clearConnection
              ? undefined
              : (subscription.connectionId ?? storedSubscription?.connectionId);
            if (
              subscription.clearConnection ||
              (storedSubscription !== undefined &&
                storedSubscription.connectionId === undefined &&
                subscription.connectionId === undefined)
            ) {
              connectionsExcludedFromInheritance.add(subscription.event);
            }
            if (connectionId !== undefined) {
              if (!event.integration) {
                return Effect.fail({
                  reason: `${subscription.event} is a host Event and cannot have a Connection.`,
                });
              }
              const connection = draft.integrations.find(
                (candidate) => candidate.id === connectionId
              );
              if (!connection) {
                return Effect.fail({
                  reason:
                    "The selected Connection is not connected. Call list_integrations to see the available Connections.",
                });
              }
              if (connection.type !== event.integration) {
                return Effect.fail({
                  reason: `Event ${subscription.event} needs a ${event.integration} Connection, but the selected Connection belongs to ${connection.type}.`,
                });
              }
            }

            if (
              subscription.match !== undefined &&
              subscription.clearMatch === true
            ) {
              return Effect.fail({
                reason: `Set match or clearMatch for ${subscription.event}, not both.`,
              });
            }
            let match = subscription.clearMatch
              ? undefined
              : storedSubscription?.match;
            if (subscription.match !== undefined) {
              const fieldFailure = eventMatchFieldFailure({
                eventName: subscription.event,
                match: subscription.match,
                catalog: draft.catalog,
              });
              if (fieldFailure) {
                return Effect.fail({ reason: fieldFailure });
              }
              const reading = readWaitMatchModelInput({
                subject: `The match for ${subscription.event}`,
                groupLogic: subscription.match.groupLogic,
                groups: subscription.match.groups,
              });
              if (!reading.ok) {
                return Effect.fail({ reason: reading.reason });
              }
              const referenceFailure = matchReferenceFailure({
                model: reading.model,
                nodeId: input.nodeId,
                document,
                catalog: draft.catalog,
              });
              if (referenceFailure) {
                return Effect.fail({ reason: referenceFailure });
              }
              match = serializeConditionModel(reading.model);
            }

            subscriptions.push(
              omitUndefined({
                event: subscription.event,
                match,
                connectionId,
              })
            );
          }
          if (
            wait.timeout !== undefined &&
            parseDurationMs(wait.timeout) === null
          ) {
            return Effect.fail({
              reason: "An Event wait timeout must be a valid duration.",
            });
          }
          const preserveEvent = storedConfig.waitMode === "event";
          const storedTimeout = preserveEvent
            ? readConfigString(storedConfig, "waitTimeout")
            : undefined;
          const storedTimeoutBehavior = preserveEvent
            ? readConfigString(storedConfig, "waitTimeoutBehavior")
            : undefined;
          const inheritedSubscriptions = inheritConnections(
            subscriptions,
            draft.catalog
          ).map((subscription) =>
            connectionsExcludedFromInheritance.has(subscription.event)
              ? omitUndefined({
                  event: subscription.event,
                  match: subscription.match,
                })
              : subscription
          );
          waitConfig = {
            waitMode: "event",
            waitFor: inheritedSubscriptions,
            waitTimeout: wait.timeout ?? storedTimeout ?? DEFAULT_WAIT_TIMEOUT,
            waitTimeoutBehavior:
              wait.timeoutBehavior ??
              (storedTimeoutBehavior === "skip" ? "skip" : "continue"),
          };
        }

        const updated: WorkflowNode = {
          ...node,
          data: {
            ...node.data,
            config: { ...baseConfig, ...waitConfig },
          },
        };
        const applyEdit = (current: AgentDocument): AgentDocument => ({
          ...current,
          nodes: current.nodes.map((candidate) =>
            candidate.id === input.nodeId ? updated : candidate
          ),
        });

        // Switching a Wait into Event mode resets the Arriving Event below it,
        // which can strand tokens already written into those configs.
        const warning = brokenReferenceWarning(
          referencesBrokenBetween({
            before: document,
            after: applyEdit(document),
            catalog: draft.catalog,
          })
        );

        return Effect.as(
          draft.update(applyEdit),
          omitUndefined({
            summary: `Set ${node.data.label || node.id} to wait by ${wait.mode}.`,
            warning,
          })
        );
      }),
  };
});

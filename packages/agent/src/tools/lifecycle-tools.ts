/**
 * The two tools that write the declarations a plain config patch cannot express.
 *
 * The Lifecycle Rules decide when a run starts and when it is cancelled, and
 * they live on the entry node, which this tool creates when the workflow has
 * none. A Condition is stored twice, as the structured model the editor edits
 * and as the CEL expression the engine evaluates, and both are written here from
 * one call so they cannot disagree.
 */

import { Effect, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import { nanoid } from "nanoid";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { findEvent } from "@wfgraph/shared/extensions/catalog";
// The barrel keeps a historical import path and leaves these two types out, so
// the types come from the module that owns them and the functions from theirs.
import type {
  ConditionFieldType,
  GroupLogic,
} from "@wfgraph/shared/conditions/condition-model";
import { EVENT_NAME_FIELD_PATH } from "@wfgraph/shared/conditions/condition-model";
import { serializeConditionModel } from "@wfgraph/shared/conditions/condition-schema";
import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import {
  checkLifecycleRules,
  emptyLifecycleRules,
  inheritConnectionIds,
  type LifecycleRules,
  pruneConnectionIds,
  readLifecycleRules,
  retainNamedKeys,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import {
  checkStartFilters,
  pruneStartFilters,
} from "@wfgraph/shared/lifecycle/start-filters";
import {
  checkCancelFilters,
  pruneCancelFilters,
} from "@wfgraph/shared/lifecycle/cancel-filters";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { WorkflowDraft } from "#src/document";
import {
  conditionGroupsSchema,
  type ConditionGroupsInput,
  type ConditionRuleInput,
  readConditionModelInput,
} from "#src/tools/condition-input";
import { referencesForNode } from "#src/tools/reference-tools";

const failureSchema = Schema.Struct({ reason: Schema.String });
const writeResultSchema = Schema.Struct({ summary: Schema.String });
const lifecycleWriteResultSchema = Schema.Struct({
  nodeId: Schema.String,
  summary: Schema.String,
});

const UNPLACED = { x: 0, y: 0 };

export const SetLifecycleRules = Tool.make("set_lifecycle_rules", {
  description:
    "Declare when a run starts and when it is cancelled. A Start Filter checks an Event before a run opens. A Cancel Filter checks an Event before it cancels a run. Creates the Lifecycle Node if the workflow has none. Find exact Event names with list_events, then use describe_event for filter fields and field types.",
  parameters: Schema.Struct({
    startEvents: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
      description:
        "The complete set of Events that start a run. Omit to preserve it. An empty list clears it, in which case allowManualStart has to be true.",
    }),
    cancelEvents: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
      description:
        "The complete set of Events that route an in-flight run to the Canceled outlet. Omit to preserve it. An empty list clears it.",
    }),
    concurrency: Schema.optionalKey(
      Schema.Literals(["newest-wins", "first-wins", "unlimited"])
    ).annotate({
      description:
        "How many runs may exist per correlated entity. newest-wins ends the run already going, first-wins refuses the new one, unlimited allows both. Omit to preserve it; a new Lifecycle Node defaults to unlimited.",
    }),
    allowManualStart: Schema.optionalKey(Schema.Boolean).annotate({
      description:
        "Whether the Run button and the execute route may start it. Omit to preserve it.",
    }),
    // A list rather than a record, for the reason `configBagSchema` in
    // graph-write-tools.ts states: a record cannot survive the round trip
    // through a strict function schema.
    correlationPaths: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          event: Schema.String.annotate({
            description: "The Event name, from list_events.",
          }),
          path: Schema.String.annotate({
            description:
              "The Event payload path from describe_event that identifies the entity a run is about, for example applicantId.",
          }),
        })
      )
    ).annotate({
      description:
        "Per-Event overrides for where an Event carries the entity id. Entries update named Events and preserve other overrides. Omit to preserve all overrides. An empty list clears all overrides.",
    }),
    clearCorrelationPaths: Schema.optionalKey(
      Schema.Array(Schema.String)
    ).annotate({
      description:
        "Event names whose Correlation Path overrides must be removed. Other overrides are preserved.",
    }),
    eventConnections: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          event: Schema.String.annotate({
            description:
              "An integration-owned Start or Cancel Event in this edit.",
          }),
          connectionId: Schema.String.annotate({
            description:
              "A matching connectionId returned by list_integrations.",
          }),
        })
      )
    ).annotate({
      description:
        "Connection bindings for integration-owned Start and Cancel Events. Entries update named Events and preserve other bindings. Omit to preserve all bindings. An empty list clears all bindings.",
    }),
    clearEventConnections: Schema.optionalKey(
      Schema.Array(Schema.String)
    ).annotate({
      description:
        "Event names whose Connection bindings must be removed. Other bindings are preserved.",
    }),
    startFilters: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          event: Schema.String.annotate({
            description: "The Start Event this filter applies to.",
          }),
          groupLogic: Schema.optionalKey(
            Schema.Literals(["and", "or"])
          ).annotate({
            description: "How the filter groups combine. Defaults to and.",
          }),
          groups: conditionGroupsSchema,
        })
      )
    ).annotate({
      description:
        "Per-Event payload filters applied before a run opens. Entries update named Events and preserve other filters. Omit to preserve all filters. An empty list clears all filters.",
    }),
    clearStartFilters: Schema.optionalKey(Schema.Array(Schema.String)).annotate(
      {
        description:
          "Start Event names whose Start Filters must be removed. Other Start Filters are preserved.",
      }
    ),
    cancelFilters: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          event: Schema.String.annotate({
            description: "The Cancel Event this filter applies to.",
          }),
          groupLogic: Schema.optionalKey(
            Schema.Literals(["and", "or"])
          ).annotate({
            description: "How the filter groups combine. Defaults to and.",
          }),
          groups: conditionGroupsSchema,
        })
      )
    ).annotate({
      description:
        "Per-Event payload filters checked before a Cancel Event cancels a run. Entries update named Events and preserve other filters. Omit to preserve all filters. An empty list clears all filters.",
    }),
    clearCancelFilters: Schema.optionalKey(
      Schema.Array(Schema.String)
    ).annotate({
      description:
        "Cancel Event names whose Cancel Filters must be removed. Other Cancel Filters are preserved.",
    }),
  }),
  success: lifecycleWriteResultSchema,
  failure: failureSchema,
  failureMode: "return",
});

export const SetCondition = Tool.make("set_condition", {
  description:
    "Write the test a Condition step branches on. Groups are joined by groupLogic and the rules inside a group by that group's logic. Call list_references first so every field path is one the step can actually read.",
  parameters: Schema.Struct({
    nodeId: Schema.String.annotate({
      description: "The Condition node to write, from read_workflow.",
    }),
    groupLogic: Schema.optionalKey(Schema.Literals(["and", "or"])).annotate({
      description: "How the groups combine. Defaults to and.",
    }),
    groups: conditionGroupsSchema,
  }),
  success: writeResultSchema,
  failure: failureSchema,
  failureMode: "return",
});

type LifecycleFilterInput = {
  readonly event: string;
  readonly groupLogic?: GroupLogic | undefined;
  readonly groups: ConditionGroupsInput;
};

type EventConnectionInput = {
  readonly event: string;
  readonly connectionId: string;
};

/** Applies per-Event updates, with an empty update list clearing the record. */
function patchEventRecord(input: {
  stored: Record<string, string> | undefined;
  updates: ReadonlyMap<string, string> | undefined;
  clear: readonly string[] | undefined;
}): Record<string, string> | undefined {
  const patched =
    input.updates === undefined
      ? input.stored
      : input.updates.size === 0
        ? undefined
        : { ...input.stored, ...Object.fromEntries(input.updates) };
  if (patched === undefined || input.clear === undefined) {
    return patched;
  }

  const cleared = new Set(input.clear);
  return retainNamedKeys(
    patched,
    new Set(Object.keys(patched).filter((event) => !cleared.has(event)))
  );
}

/** The entry node, or a fresh one when the workflow has never had rules. */
function entryNodeOf(nodes: readonly WorkflowNode[]): WorkflowNode {
  const existing = nodes.find((node) => node.data.type === "lifecycle");
  return (
    existing ?? {
      id: nanoid(),
      position: UNPLACED,
      type: "lifecycle",
      data: { label: "Lifecycle", type: "lifecycle", config: {} },
    }
  );
}

export const lifecycleToolHandlers = Effect.gen(function* () {
  const draft = yield* WorkflowDraft;

  return {
    set_lifecycle_rules: (input: {
      readonly startEvents?: readonly string[] | undefined;
      readonly cancelEvents?: readonly string[] | undefined;
      readonly concurrency?:
        | "newest-wins"
        | "first-wins"
        | "unlimited"
        | undefined;
      readonly allowManualStart?: boolean | undefined;
      readonly correlationPaths?:
        | readonly { readonly event: string; readonly path: string }[]
        | undefined;
      readonly clearCorrelationPaths?: readonly string[] | undefined;
      readonly eventConnections?: readonly EventConnectionInput[] | undefined;
      readonly clearEventConnections?: readonly string[] | undefined;
      readonly startFilters?: readonly LifecycleFilterInput[] | undefined;
      readonly clearStartFilters?: readonly string[] | undefined;
      readonly cancelFilters?: readonly LifecycleFilterInput[] | undefined;
      readonly clearCancelFilters?: readonly string[] | undefined;
    }) =>
      Effect.flatMap(draft.current, (document) => {
        const entry = entryNodeOf(document.nodes);
        const stored = readLifecycleRules(entry.data.config);
        const startEvents = [
          ...(input.startEvents ?? stored?.startEvents ?? []),
        ];
        const cancelEvents = [
          ...(input.cancelEvents ?? stored?.cancelEvents ?? []),
        ];
        const concurrency =
          input.concurrency ??
          stored?.concurrency ??
          emptyLifecycleRules.concurrency;
        const allowManualStart =
          input.allowManualStart ?? stored?.allowManualStart;
        const named = [...startEvents, ...cancelEvents];
        const unknown = named.filter(
          (name) => findEvent(draft.catalog, name) === undefined
        );
        if (unknown.length > 0) {
          return Effect.fail({
            reason: `No Event named ${unknown.join(", ")}. Call list_events to see what the host registered.`,
          });
        }

        if (startEvents.length === 0 && allowManualStart !== true) {
          return Effect.fail({
            reason:
              "A workflow needs a way to start. Name at least one Start Event, or set allowManualStart to true.",
          });
        }

        const changesStartFilters = input.startFilters !== undefined;
        let startFilterUpdates: Map<string, string> | undefined;
        if (changesStartFilters) {
          const serialized = new Map<string, string>();
          for (const filter of input.startFilters) {
            if (!startEvents.includes(filter.event)) {
              return Effect.fail({
                reason: `${filter.event} is not a Start Event in this edit, so it cannot have a Start Filter.`,
              });
            }
            if (serialized.has(filter.event)) {
              return Effect.fail({
                reason: `${filter.event} has more than one Start Filter. Combine its rules into one filter.`,
              });
            }

            const reading = readConditionModelInput({
              subject: "A Start Filter",
              groupLogic: filter.groupLogic,
              groups: filter.groups,
            });
            if (!reading.ok) {
              return Effect.fail({ reason: reading.reason });
            }
            serialized.set(
              filter.event,
              serializeConditionModel(reading.model)
            );
          }
          startFilterUpdates = serialized;
        }
        const startFilters = patchEventRecord({
          stored: stored?.startFilters,
          updates: startFilterUpdates,
          clear: input.clearStartFilters,
        });

        const changesCancelFilters = input.cancelFilters !== undefined;
        let cancelFilterUpdates: Map<string, string> | undefined;
        if (changesCancelFilters) {
          const serialized = new Map<string, string>();
          for (const filter of input.cancelFilters) {
            if (!cancelEvents.includes(filter.event)) {
              return Effect.fail({
                reason: `${filter.event} is not a Cancel Event in this edit, so it cannot have a Cancel Filter.`,
              });
            }
            if (serialized.has(filter.event)) {
              return Effect.fail({
                reason: `${filter.event} has more than one Cancel Filter. Combine its rules into one filter.`,
              });
            }

            const reading = readConditionModelInput({
              subject: "A Cancel Filter",
              groupLogic: filter.groupLogic,
              groups: filter.groups,
            });
            if (!reading.ok) {
              return Effect.fail({ reason: reading.reason });
            }
            serialized.set(
              filter.event,
              serializeConditionModel(reading.model)
            );
          }
          cancelFilterUpdates = serialized;
        }
        const cancelFilters = patchEventRecord({
          stored: stored?.cancelFilters,
          updates: cancelFilterUpdates,
          clear: input.clearCancelFilters,
        });

        const correlationPaths = patchEventRecord({
          stored: stored?.correlationPaths,
          updates:
            input.correlationPaths === undefined
              ? undefined
              : new Map(
                  input.correlationPaths.map((supplied) => [
                    supplied.event,
                    supplied.path,
                  ])
                ),
          clear: input.clearCorrelationPaths,
        });

        let connectionUpdates: Map<string, string> | undefined;
        if (input.eventConnections !== undefined) {
          const suppliedConnections = new Map<string, string>();
          for (const binding of input.eventConnections) {
            if (!named.includes(binding.event)) {
              return Effect.fail({
                reason: `${binding.event} is not a Start or Cancel Event in this edit, so it cannot have a Connection.`,
              });
            }
            if (suppliedConnections.has(binding.event)) {
              return Effect.fail({
                reason: `${binding.event} has more than one Connection. Supply one Connection per Event.`,
              });
            }
            suppliedConnections.set(binding.event, binding.connectionId);
          }
          connectionUpdates = suppliedConnections;
        }
        const connectionIds = patchEventRecord({
          stored: stored?.connectionIds,
          updates: connectionUpdates,
          clear: undefined,
        });

        const mergedRules: LifecycleRules = {
          ...emptyLifecycleRules,
          ...omitUndefined({
            startFilters,
            cancelFilters,
            connectionIds,
            allowManualStart,
            correlationPaths,
          }),
          startEvents,
          cancelEvents,
          concurrency,
        };
        const inheritedRules = inheritConnectionIds(
          pruneStartFilters(
            pruneCancelFilters({
              ...pruneConnectionIds(mergedRules),
              correlationPaths: retainNamedKeys(
                mergedRules.correlationPaths,
                new Set(named)
              ),
            })
          ),
          draft.catalog
        );
        const rules: LifecycleRules = {
          ...inheritedRules,
          connectionIds: patchEventRecord({
            stored: inheritedRules.connectionIds,
            updates: undefined,
            clear: input.clearEventConnections,
          }),
        };

        for (const [eventName, connectionId] of Object.entries(
          rules.connectionIds ?? {}
        )) {
          const integration = findEvent(draft.catalog, eventName)?.integration;
          if (!integration) {
            return Effect.fail({
              reason: `${eventName} is a host Event and cannot have a Connection.`,
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
          if (connection.type !== integration) {
            return Effect.fail({
              reason: `Event ${eventName} needs a ${integration} Connection, but the selected Connection belongs to ${connection.type}.`,
            });
          }
        }

        const check = checkLifecycleRules({
          rules,
          catalog: draft.catalog,
          // The draft can carry the requested Event while `validate_draft`
          // reports the Connection that the Workflow Builder must choose.
          allowMissingConnections: true,
        });
        if (!check.valid) {
          return Effect.fail({ reason: check.error });
        }
        if (changesStartFilters) {
          const filtersCheck = checkStartFilters({
            rules,
            catalog: draft.catalog,
          });
          if (!filtersCheck.valid) {
            return Effect.fail({ reason: filtersCheck.error });
          }
        }
        if (changesCancelFilters) {
          const filtersCheck = checkCancelFilters({
            rules,
            catalog: draft.catalog,
          });
          if (!filtersCheck.valid) {
            return Effect.fail({ reason: filtersCheck.error });
          }
        }

        const created = !document.nodes.some((node) => node.id === entry.id);
        const updated: WorkflowNode = {
          ...entry,
          data: {
            ...entry.data,
            config: { ...entry.data.config, lifecycleRules: rules },
          },
        };

        return Effect.as(
          draft.update((current) => ({
            ...current,
            nodes: created
              ? [updated, ...current.nodes]
              : current.nodes.map((node) =>
                  node.id === entry.id ? updated : node
                ),
          })),
          {
            nodeId: entry.id,
            summary: `${created ? "Created the Lifecycle Node and set" : "Set"} the rules: starts on ${rules.startEvents.join(", ") || "manual start only"}.`,
          }
        );
      }),

    set_condition: (input: {
      readonly nodeId: string;
      readonly groupLogic?: GroupLogic | undefined;
      readonly groups: readonly {
        readonly logic?: GroupLogic | undefined;
        readonly rules: readonly ConditionRuleInput[];
      }[];
    }) =>
      Effect.flatMap(draft.current, (document) => {
        const node = document.nodes.find(
          (candidate) => candidate.id === input.nodeId
        );
        if (!node) {
          return Effect.fail({ reason: `No node with id ${input.nodeId}.` });
        }
        if (actionTypeOf(node) !== BUILT_IN_ACTION_IDS.condition) {
          return Effect.fail({
            reason: `${input.nodeId} is not a Condition step, so it has no test to write.`,
          });
        }
        if (input.groups.length === 0) {
          return Effect.fail({
            reason: "A condition needs at least one group.",
          });
        }

        const availableReferences =
          referencesForNode({
            nodeId: input.nodeId,
            document,
            catalog: draft.catalog,
          }) ?? [];
        const availablePaths = new Set(
          availableReferences.map((reference) => reference.path)
        );

        for (const group of input.groups) {
          if (group.rules.length === 0) {
            return Effect.fail({
              reason: "Every group needs at least one rule.",
            });
          }

          for (const rule of group.rules) {
            if (
              rule.field !== EVENT_NAME_FIELD_PATH &&
              availablePaths.size === 0
            ) {
              return Effect.fail({
                reason:
                  "This Condition has no available references. Connect its inputs, then call list_references.",
              });
            }
            if (
              rule.field !== EVENT_NAME_FIELD_PATH &&
              !availablePaths.has(rule.field)
            ) {
              return Effect.fail({
                reason: `That condition field is unavailable. Use the path property from list_references: ${[...availablePaths].join(", ")}.`,
              });
            }
            const expectedTypes = new Set<ConditionFieldType>(
              rule.field === EVENT_NAME_FIELD_PATH
                ? ["string"]
                : availableReferences
                    .filter((reference) => reference.path === rule.field)
                    .flatMap((reference) => reference.conditionFieldType ?? [])
            );
            if (expectedTypes.size !== 1) {
              return Effect.fail({
                reason:
                  "That reference does not have one condition-compatible type.",
              });
            }
            const [expectedType] = expectedTypes;
            if (rule.fieldType !== expectedType) {
              return Effect.fail({
                reason: `Use fieldType ${expectedType} for ${rule.field}, as list_references reports.`,
              });
            }
            const matchingReferences = availableReferences.filter(
              (reference) => reference.path === rule.field
            );
            const openRecord =
              matchingReferences.length > 0 &&
              matchingReferences.every(
                (reference) => reference.openRecord === true
              );
            if (openRecord && !rule.recordKey?.trim()) {
              return Effect.fail({
                reason: `${rule.field} is an open record. Supply recordKey for the value to compare.`,
              });
            }
            if (!openRecord && rule.recordKey !== undefined) {
              return Effect.fail({
                reason: `${rule.field} is not an open record and does not take recordKey.`,
              });
            }
          }
        }

        const reading = readConditionModelInput({
          subject: "A condition",
          groupLogic: input.groupLogic,
          groups: input.groups,
        });
        if (!reading.ok) {
          return Effect.fail({ reason: reading.reason });
        }
        const { model, expression } = reading;

        // The model and the CEL it compiles to are one fact about the node, so
        // they are written together; the editor writes them the same way.
        const updated: WorkflowNode = {
          ...node,
          data: {
            ...node.data,
            config: {
              ...node.data.config,
              conditionModel: serializeConditionModel(model),
              condition: expression,
            },
          },
        };

        return Effect.as(
          draft.update((current) => ({
            ...current,
            nodes: current.nodes.map((candidate) =>
              candidate.id === input.nodeId ? updated : candidate
            ),
          })),
          { summary: `Set the test on ${node.data.label || input.nodeId}.` }
        );
      }),
  };
});

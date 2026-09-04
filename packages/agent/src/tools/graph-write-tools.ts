/**
 * The six tools that change the shape of the graph.
 *
 * Each one edits the draft and answers a short sentence, never the whole graph.
 * The editor is told what the graph became through a separate channel, so
 * repeating it here would only spend the model's context on what it already
 * asked for.
 *
 * A new node is given a placeholder position. The editor lays the graph out when
 * it applies the result, so the agent never chooses coordinates.
 */

import { Effect, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import { nanoid } from "nanoid";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { findAction } from "@wfgraph/shared/extensions/catalog";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { eventsReaching } from "@wfgraph/shared/graph/events-reaching";
import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import { canonicalizeNodeEnabled } from "@wfgraph/shared/graph/node-enabled";
import { findTemplateTokens } from "@wfgraph/shared/graph/node-references";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { upstreamNodeIds } from "@wfgraph/shared/graph/upstream-nodes";
import {
  eventSplitOutletEvent,
  isEventSplitNode,
} from "@wfgraph/shared/lifecycle/event-split";
import { isLifecycleOutlet } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import { flattenConfigFields } from "@wfgraph/shared/plugins/action-fields";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  type AgentDocument,
  type ConnectedIntegration,
  WorkflowDraft,
} from "#src/document";
import { referencesForNode } from "#src/tools/reference-tools";
/**
 * A config bag as the model fills it in: a list of entries, not a record.
 *
 * `Schema.Record` is the shape this wants and the one thing that cannot be used.
 * OpenAI's strict function schemas have no open-ended object, so the provider
 * rewrites a record into a list of key/value pairs on the way out and then
 * decodes the model's answer against that list, which fails with "Expected
 * array" the moment a model sends the object the schema appeared to ask for.
 * Naming the list here is the same wire shape, stated once and decoded the way
 * it was sent.
 *
 * Values are strings because that is what a config holds: the engine resolves a
 * `{{...}}` template to a string, and the action's own schema decodes from
 * there. Everything structured a node carries is written by the tool that owns
 * it instead -- `set_lifecycle_rules` for the entry node's rules,
 * `set_condition` for a Condition's test.
 */
const configBagSchema = Schema.Array(
  Schema.Struct({
    key: Schema.String.annotate({
      description: "A config key the action declares, from describe_action.",
    }),
    value: Schema.String.annotate({
      description:
        "The value for that key. A reference to an earlier step is the whole {{@nodeId:Label.path}} token from list_references.",
    }),
  })
);

type ConfigBag = typeof configBagSchema.Type;

/** The entries as the object a node's config actually is. */
function toConfigRecord(entries: ConfigBag): Record<string, string> {
  return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
}

function configNamesKey(entries: ConfigBag | undefined, key: string): boolean {
  return entries?.some((entry) => entry.key === key) ?? false;
}

const builtInActionIds: readonly string[] = Object.values(BUILT_IN_ACTION_IDS);

const failureSchema = Schema.Struct({ reason: Schema.String });

/** What every write tool answers: enough for the model to narrate the edit. */
const writeResultSchema = Schema.Struct({ summary: Schema.String });

const addNodeResultSchema = Schema.Struct({
  nodeId: Schema.String,
  summary: Schema.String,
});

const insertNodeResultSchema = Schema.Struct({
  nodeId: Schema.String,
  incomingEdgeId: Schema.String,
  outgoingEdgeId: Schema.String,
  summary: Schema.String,
});

/** A placeholder the editor replaces the moment it lays the graph out. */
const UNPLACED = { x: 0, y: 0 };

function knownActionId(catalog: ExtensionCatalog, actionId: string): boolean {
  const action = findAction(catalog, actionId);
  return (
    builtInActionIds.includes(actionId) ||
    (action !== undefined && action.hidden !== true)
  );
}

function findNode(
  document: AgentDocument,
  nodeId: string
): WorkflowNode | undefined {
  return document.nodes.find((node) => node.id === nodeId);
}

/**
 * Whether adding source -> target would close a loop.
 *
 * A cycle appears exactly when the target already has a path forward to the
 * source, which is what the upstream walk answers. The save refuses a cyclic
 * graph outright, so catching it here is what turns a rejected save into a
 * sentence the model can act on.
 */
function wouldCycle(
  edges: readonly WorkflowEdge[],
  source: string,
  target: string
): boolean {
  return upstreamNodeIds(source, edges).has(target);
}

export const AddNode = Tool.make("add_node", {
  description:
    "Add a step to the workflow and answer its new id. Call describe_action first so the config keys are the ones the action declares. The node arrives unconnected; call connect_nodes to place it in the flow. The Lifecycle Node is not added here: set_lifecycle_rules creates it.",
  parameters: Schema.Struct({
    actionId: Schema.String.annotate({
      description:
        'An action id from list_actions, or one of the built-in steps "Condition", "Wait" and "Event Split".',
    }),
    label: Schema.String.annotate({
      description:
        "What the step is called on the canvas and inside any template token that reads its output.",
    }),
    description: Schema.optionalKey(Schema.String).annotate({
      description: "A sentence saying why this step is here.",
    }),
    config: Schema.optionalKey(configBagSchema).annotate({
      description:
        "The action's config keys. Set integrationId to one of the connectionIds from list_integrations when the action needs a connection.",
    }),
  }),
  success: addNodeResultSchema,
  failure: failureSchema,
  failureMode: "return",
});

export const UpdateNode = Tool.make("update_node", {
  description:
    "Change a step's label, description, enabled flag or config. Config keys given here are merged over what the node already holds; name a key in clearConfigKeys to remove it.",
  parameters: Schema.Struct({
    nodeId: Schema.String.annotate({
      description: "The node to change, from read_workflow.",
    }),
    label: Schema.optionalKey(Schema.String).annotate({
      description: "A new name for the step.",
    }),
    description: Schema.optionalKey(Schema.String).annotate({
      description: "A new sentence saying why this step is here.",
    }),
    enabled: Schema.optionalKey(Schema.Boolean).annotate({
      description: "False switches the step off and a run walks past it.",
    }),
    config: Schema.optionalKey(configBagSchema).annotate({
      description: "Config keys to merge over the node's current config.",
    }),
    clearConfigKeys: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
      description: "Config keys to remove entirely.",
    }),
  }),
  success: writeResultSchema,
  failure: failureSchema,
  failureMode: "return",
});

export const RevertDraft = Tool.make("revert_draft", {
  description:
    "Put the graph back exactly as it was when this turn began, undoing every edit you have made. Use it when you find partway through that the shape is wrong, or that a capability the request needs does not exist: revert, then explain. Editing first and reverting is expected, so a step you only discover you need halfway through costs nothing.",
  parameters: Schema.Struct({
    reason: Schema.String.annotate({
      description:
        "What you found that made the edits so far wrong, in one sentence. It reaches the person watching the canvas change.",
    }),
  }),
  success: writeResultSchema,
  failure: failureSchema,
  failureMode: "return",
});

export const DeleteNode = Tool.make("delete_node", {
  description:
    "Remove a step and every edge touching it. Steps below it are left connected to nothing, so reconnect them afterwards.",
  parameters: Schema.Struct({
    nodeId: Schema.String.annotate({
      description: "The node to remove, from read_workflow.",
    }),
  }),
  success: writeResultSchema,
  failure: failureSchema,
  failureMode: "return",
});

export const ConnectNodes = Tool.make("connect_nodes", {
  description:
    'Draw an edge so a run flows from one step into the next. Out of a Condition, name sourceHandle "true" or "false". Out of the Lifecycle Node, name "started" or "canceled". Out of an Event Split, name "event:<Event name>".',
  parameters: Schema.Struct({
    source: Schema.String.annotate({
      description: "The node the run leaves.",
    }),
    target: Schema.String.annotate({
      description: "The node the run arrives at.",
    }),
    sourceHandle: Schema.optionalKey(Schema.String).annotate({
      description:
        'Which outlet of the source the edge leaves by: "true" or "false" on a Condition, "started" or "canceled" on the Lifecycle Node, or "event:<Event name>" on an Event Split.',
    }),
  }),
  success: writeResultSchema,
  failure: failureSchema,
  failureMode: "return",
});

export const DisconnectNodes = Tool.make("disconnect_nodes", {
  description: "Remove one edge, leaving both steps in place.",
  parameters: Schema.Struct({
    edgeId: Schema.String.annotate({
      description: "The edge to remove, from read_workflow.",
    }),
  }),
  success: writeResultSchema,
  failure: failureSchema,
  failureMode: "return",
});

export const InsertNodeOnEdge = Tool.make("insert_node_on_edge", {
  description:
    "Add one step on an existing edge as one atomic edit. The original source handle is preserved. The result returns both replacement edge ids; use outgoingEdgeId to insert another step before the original target.",
  parameters: Schema.Struct({
    edgeId: Schema.String.annotate({
      description: "The edge to replace, from read_workflow.",
    }),
    actionId: Schema.String.annotate({
      description:
        'An action id from list_actions, or one of the built-in steps "Condition", "Wait" and "Event Split".',
    }),
    label: Schema.String.annotate({
      description: "What the inserted step is called on the canvas.",
    }),
    description: Schema.optionalKey(Schema.String).annotate({
      description: "A sentence saying why the inserted step is here.",
    }),
    config: Schema.optionalKey(configBagSchema).annotate({
      description:
        "Literal config values to set during insertion. Set upstream references afterward with update_node and an exact token from list_references.",
    }),
    outgoingSourceHandle: Schema.optionalKey(Schema.String).annotate({
      description:
        'The inserted step outlet leading to the original target. Use "true" or "false" for a Condition, or "event:<Event name>" for an Event Split. Omit for other actions.',
    }),
  }),
  success: insertNodeResultSchema,
  failure: failureSchema,
  failureMode: "return",
});

/**
 * The outlet rule an edge is held to, stated as the refusal a builder would
 * read.
 *
 * The save applies the same rule; catching it here is what lets the model fix
 * the call rather than watch the whole turn's save be rejected.
 */
function outletRefusal(input: {
  readonly source: WorkflowNode;
  readonly sourceHandle: string | undefined;
  readonly document: AgentDocument;
  readonly catalog: ExtensionCatalog;
}): string | undefined {
  const { source, sourceHandle } = input;

  if (source.data.type === "lifecycle") {
    return isLifecycleOutlet(sourceHandle)
      ? undefined
      : 'An edge out of the Lifecycle Node must name sourceHandle "started" or "canceled".';
  }

  if (actionTypeOf(source) === BUILT_IN_ACTION_IDS.condition) {
    return sourceHandle === "true" || sourceHandle === "false"
      ? undefined
      : 'An edge out of a Condition must name sourceHandle "true" or "false".';
  }

  if (isEventSplitNode(source)) {
    const eventName = eventSplitOutletEvent(sourceHandle);
    if (!eventName) {
      return 'An edge out of an Event Split must name sourceHandle "event:<Event name>".';
    }

    const reachesSplit = eventsReaching({
      targetNodeId: source.id,
      nodes: input.document.nodes,
      edges: input.document.edges,
      catalog: input.catalog,
    }).some((event) => event.name === eventName);
    return reachesSplit
      ? undefined
      : `Event ${eventName} does not reach ${source.data.label || source.id}.`;
  }

  return sourceHandle === undefined
    ? undefined
    : `Only a Condition or the Lifecycle Node has named outlets, so ${source.id} takes no sourceHandle.`;
}

function mergedConfig(input: {
  readonly current: Record<string, unknown> | undefined;
  readonly patch: ConfigBag | undefined;
  readonly clear: readonly string[] | undefined;
}): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...input.current,
    ...toConfigRecord(input.patch ?? []),
  };
  for (const key of input.clear ?? []) {
    delete merged[key];
  }
  return merged;
}

function configPatchRefusal(input: {
  readonly actionId: string;
  readonly patch: ConfigBag | undefined;
  readonly clear?: readonly string[] | undefined;
  readonly current?: Record<string, unknown> | undefined;
  readonly document?: AgentDocument | undefined;
  readonly nodeId?: string | undefined;
  readonly referenceGuidance?: string | undefined;
  readonly catalog: ExtensionCatalog;
  readonly integrations: readonly ConnectedIntegration[];
}): string | undefined {
  const action = findAction(input.catalog, input.actionId);
  const fields = action ? flattenConfigFields(action.configFields) : [];
  const fieldsByKey = new Map(fields.map((field) => [field.key, field]));
  const allowedKeys = new Set(fieldsByKey.keys());
  if (action?.integration) {
    allowedKeys.add("integrationId");
  }

  const seenKeys = new Set<string>();
  for (const key of input.patch?.map((entry) => entry.key) ?? []) {
    if (seenKeys.has(key)) {
      return `Config key ${key} appears more than once. Supply one operation for each config key.`;
    }
    seenKeys.add(key);
    if (!allowedKeys.has(key)) {
      return `Action ${input.actionId} does not declare config key ${key}. Call describe_action for its config fields.`;
    }
  }
  for (const key of input.clear ?? []) {
    if (seenKeys.has(key)) {
      return `Config key ${key} appears more than once. Supply one operation for each config key.`;
    }
    seenKeys.add(key);
    if (!allowedKeys.has(key) && !Object.hasOwn(input.current ?? {}, key)) {
      return `Action ${input.actionId} does not declare config key ${key}. Call describe_action for its config fields.`;
    }
  }

  for (const entry of input.patch ?? []) {
    const tokens = findTemplateTokens(entry.value);
    let cursor = 0;
    let malformedTemplateSyntax = false;
    for (const token of tokens) {
      const literal = entry.value.slice(cursor, token.start);
      malformedTemplateSyntax ||= /\{\{|\}\}/u.test(literal);
      cursor = token.end;
    }
    const remainingLiteral = entry.value.slice(cursor);
    malformedTemplateSyntax ||= /\{\{|\}\}/u.test(remainingLiteral);
    if (
      (entry.key === "integrationId" ||
        fieldsByKey.get(entry.key)?.literal === true) &&
      (tokens.length > 0 || malformedTemplateSyntax)
    ) {
      return `${entry.key} is a literal field and cannot contain a template reference.`;
    }
    if (malformedTemplateSyntax) {
      return `${entry.key} contains a malformed template reference. Use an exact token from list_references.`;
    }
    if (tokens.length === 0) {
      continue;
    }
    if (!input.document || !input.nodeId) {
      return (
        input.referenceGuidance ??
        `Connect the node before setting ${entry.key} to an upstream reference, then use update_node with an exact token from list_references.`
      );
    }

    const availableTokens = new Set(
      (
        referencesForNode({
          nodeId: input.nodeId,
          document: input.document,
          catalog: input.catalog,
        }) ?? []
      ).map((reference) => reference.token)
    );
    if (tokens.some((token) => !availableTokens.has(token.raw))) {
      return `${entry.key} must use each exact token returned by list_references.`;
    }
  }

  const connectionId = input.patch?.find(
    (entry) => entry.key === "integrationId"
  )?.value;
  if (connectionId !== undefined && action?.integration !== undefined) {
    const connection = input.integrations.find(
      (candidate) => candidate.id === connectionId
    );
    if (!connection) {
      return "The selected Connection is not connected. Call list_integrations to see the available Connections.";
    }
    if (connection.type !== action.integration) {
      return `Action ${input.actionId} needs a ${action.integration} Connection, but the selected Connection belongs to ${connection.type}.`;
    }
  }

  return undefined;
}

function actionNode(input: {
  readonly nodeId: string;
  readonly actionId: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly config?: ConfigBag | undefined;
}): WorkflowNode {
  return {
    id: input.nodeId,
    position: UNPLACED,
    type: "action",
    data: {
      label: input.label,
      type: "action",
      description: input.description,
      config: {
        actionType: input.actionId,
        ...toConfigRecord(input.config ?? []),
      },
    },
  };
}

export const graphWriteToolHandlers = Effect.gen(function* () {
  const draft = yield* WorkflowDraft;

  return {
    /**
     * The turn's opening graph is revision 0, which `update` stores before any
     * tool runs. Reverting through `update` rather than by assignment keeps the
     * one path that validates a candidate and stores a revision, so the editor
     * draws the revert the way it draws every other edit.
     */
    revert_draft: (input: { readonly reason: string }) =>
      Effect.flatMap(draft.revision(0), (opening) =>
        Effect.as(
          draft.update(() => opening),
          {
            summary: `Put the graph back as it was when this turn began: ${input.reason}`,
          }
        )
      ),

    add_node: (input: {
      readonly actionId: string;
      readonly label: string;
      readonly description?: string | undefined;
      readonly config?: ConfigBag | undefined;
    }) =>
      Effect.suspend(() => {
        if (!knownActionId(draft.catalog, input.actionId)) {
          return Effect.fail({
            reason: `No action with id ${input.actionId}. Call list_actions to see what exists, or use one of ${builtInActionIds.join(", ")}.`,
          });
        }

        if (configNamesKey(input.config, "actionType")) {
          return Effect.fail({
            reason:
              "actionType is set by actionId. Remove it from config and call add_node again.",
          });
        }

        const configRefusal = configPatchRefusal({
          actionId: input.actionId,
          patch: input.config,
          catalog: draft.catalog,
          integrations: draft.integrations,
        });
        if (configRefusal) {
          return Effect.fail({ reason: configRefusal });
        }

        const nodeId = nanoid();
        const node = actionNode({ ...input, nodeId });

        return Effect.as(
          draft.update((current) => ({
            ...current,
            nodes: [...current.nodes, node],
          })),
          {
            nodeId,
            summary: `Added ${input.label} (${input.actionId}) as ${nodeId}.`,
          }
        );
      }),

    update_node: (input: {
      readonly nodeId: string;
      readonly label?: string | undefined;
      readonly description?: string | undefined;
      readonly enabled?: boolean | undefined;
      readonly config?: ConfigBag | undefined;
      readonly clearConfigKeys?: readonly string[] | undefined;
    }) =>
      Effect.flatMap(draft.current, (document) => {
        const node = findNode(document, input.nodeId);
        if (!node) {
          return Effect.fail({
            reason: `No node with id ${input.nodeId}. Call read_workflow to see what the graph holds.`,
          });
        }

        if (
          configNamesKey(input.config, "actionType") ||
          input.clearConfigKeys?.includes("actionType")
        ) {
          return Effect.fail({
            reason:
              "actionType identifies the step and cannot be changed through config.",
          });
        }

        const actionId = actionTypeOf(node);
        if (actionId) {
          const configRefusal = configPatchRefusal({
            actionId,
            patch: input.config,
            clear: input.clearConfigKeys,
            current: node.data.config,
            document,
            nodeId: node.id,
            catalog: draft.catalog,
            integrations: draft.integrations,
          });
          if (configRefusal) {
            return Effect.fail({ reason: configRefusal });
          }
        }
        if (
          node.data.type === "lifecycle" &&
          ((input.config?.length ?? 0) > 0 ||
            (input.clearConfigKeys?.length ?? 0) > 0)
        ) {
          return Effect.fail({
            reason:
              "Lifecycle config is owned by set_lifecycle_rules. Use update_node only for its label, description, or enabled state.",
          });
        }

        const updated: WorkflowNode = {
          ...node,
          data: canonicalizeNodeEnabled({
            ...node.data,
            ...omitUndefined({
              label: input.label,
              description: input.description,
              enabled: input.enabled,
            }),
            config: mergedConfig({
              current: node.data.config,
              patch: input.config,
              clear: input.clearConfigKeys,
            }),
          }),
        };

        return Effect.as(
          draft.update((current) => ({
            ...current,
            nodes: current.nodes.map((candidate) =>
              candidate.id === input.nodeId ? updated : candidate
            ),
          })),
          { summary: `Updated ${updated.data.label || input.nodeId}.` }
        );
      }),

    delete_node: (input: { readonly nodeId: string }) =>
      Effect.flatMap(draft.current, (document) => {
        const node = findNode(document, input.nodeId);
        if (!node) {
          return Effect.fail({
            reason: `No node with id ${input.nodeId}. Call read_workflow to see what the graph holds.`,
          });
        }

        const removedEdges = document.edges.filter(
          (edge) => edge.source === input.nodeId || edge.target === input.nodeId
        ).length;

        return Effect.as(
          draft.update((current) => ({
            nodes: current.nodes.filter(
              (candidate) => candidate.id !== input.nodeId
            ),
            edges: current.edges.filter(
              (edge) =>
                edge.source !== input.nodeId && edge.target !== input.nodeId
            ),
          })),
          {
            summary: `Removed ${node.data.label || input.nodeId} and ${removedEdges} edge(s).`,
          }
        );
      }),

    connect_nodes: (input: {
      readonly source: string;
      readonly target: string;
      readonly sourceHandle?: string | undefined;
    }) =>
      Effect.flatMap(draft.current, (document) => {
        const source = findNode(document, input.source);
        const target = findNode(document, input.target);
        if (!source) {
          return Effect.fail({ reason: `No node with id ${input.source}.` });
        }
        if (!target) {
          return Effect.fail({ reason: `No node with id ${input.target}.` });
        }
        if (input.source === input.target) {
          return Effect.fail({ reason: "A step cannot flow into itself." });
        }

        const refusal = outletRefusal({
          source,
          sourceHandle: input.sourceHandle,
          document,
          catalog: draft.catalog,
        });
        if (refusal) {
          return Effect.fail({ reason: refusal });
        }

        const duplicate = document.edges.some(
          (edge) =>
            edge.source === input.source &&
            edge.target === input.target &&
            (edge.sourceHandle ?? undefined) === input.sourceHandle
        );
        if (duplicate) {
          return Effect.fail({
            reason: `${input.source} already flows into ${input.target}.`,
          });
        }

        if (wouldCycle(document.edges, input.source, input.target)) {
          return Effect.fail({
            reason: `${input.target} already leads to ${input.source}, so this edge would make a loop. A workflow has to run forwards.`,
          });
        }

        const edge: WorkflowEdge = {
          id: nanoid(),
          source: input.source,
          target: input.target,
          sourceHandle: input.sourceHandle,
        };

        return Effect.as(
          draft.update((current) => ({
            ...current,
            edges: [...current.edges, edge],
          })),
          {
            summary: `Connected ${source.data.label || input.source} to ${target.data.label || input.target}.`,
          }
        );
      }),

    disconnect_nodes: (input: { readonly edgeId: string }) =>
      Effect.flatMap(draft.current, (document) => {
        const edge = document.edges.find(
          (candidate) => candidate.id === input.edgeId
        );
        if (!edge) {
          return Effect.fail({
            reason: `No edge with id ${input.edgeId}. Call read_workflow to see what the graph holds.`,
          });
        }

        return Effect.as(
          draft.update((current) => ({
            ...current,
            edges: current.edges.filter(
              (candidate) => candidate.id !== input.edgeId
            ),
          })),
          { summary: `Disconnected ${edge.source} from ${edge.target}.` }
        );
      }),

    insert_node_on_edge: (input: {
      readonly edgeId: string;
      readonly actionId: string;
      readonly label: string;
      readonly description?: string | undefined;
      readonly config?: ConfigBag | undefined;
      readonly outgoingSourceHandle?: string | undefined;
    }) =>
      Effect.flatMap(draft.current, (document) => {
        const edge = document.edges.find(
          (candidate) => candidate.id === input.edgeId
        );
        if (!edge) {
          return Effect.fail({
            reason: `No edge with id ${input.edgeId}. Call read_workflow to see what the graph holds.`,
          });
        }
        if (!knownActionId(draft.catalog, input.actionId)) {
          return Effect.fail({
            reason: `No action with id ${input.actionId}. Call list_actions to see what exists, or use one of ${builtInActionIds.join(", ")}.`,
          });
        }
        if (configNamesKey(input.config, "actionType")) {
          return Effect.fail({
            reason:
              "actionType is set by actionId. Remove it from config and call insert_node_on_edge again.",
          });
        }

        const nodeId = nanoid();
        const node = actionNode({ ...input, nodeId });
        const incoming: WorkflowEdge = { ...edge, target: nodeId };
        const outgoing: WorkflowEdge = {
          id: nanoid(),
          source: nodeId,
          target: edge.target,
          sourceHandle: input.outgoingSourceHandle,
        };
        const candidate: AgentDocument = {
          nodes: [...document.nodes, node],
          edges: document.edges.flatMap((current) =>
            current.id === edge.id ? [incoming, outgoing] : [current]
          ),
        };
        const outlet = outletRefusal({
          source: node,
          sourceHandle: input.outgoingSourceHandle,
          document: candidate,
          catalog: draft.catalog,
        });
        if (outlet) {
          return Effect.fail({ reason: outlet });
        }
        const configRefusal = configPatchRefusal({
          actionId: input.actionId,
          patch: input.config,
          catalog: draft.catalog,
          integrations: draft.integrations,
          referenceGuidance: `Set references after inserting the node. Use update_node with an exact token from list_references for ${nodeId}.`,
        });
        if (configRefusal) {
          return Effect.fail({ reason: configRefusal });
        }

        return Effect.as(
          draft.update(() => candidate),
          {
            nodeId,
            incomingEdgeId: incoming.id,
            outgoingEdgeId: outgoing.id,
            summary: `Inserted ${input.label} (${input.actionId}) on edge ${input.edgeId}.`,
          }
        );
      }),
  };
});

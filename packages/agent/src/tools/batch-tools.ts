/**
 * `apply_edits`: several graph edits applied in order as one write.
 *
 * Each operation runs through the same handler its own tool uses, so a batch
 * refuses exactly what the single calls would. The operations share one
 * draft; when one is refused, the draft is put back as the batch found it and
 * the batch fails, so a batch is stored whole or not at all. Over MCP that
 * makes it one stored revision; in a chat turn it is one graph update.
 *
 * A new step has no id until its operation runs, so an operation that creates
 * one may carry a `key`, and a later operation names that step as `$key`:
 * as a whole id field, or inside a reference token as `{{@$key:Label.path}}`.
 */

import { Effect, Result, Schema } from "effect";
import { Tool } from "effect/ai";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  isJsonObject,
  type JsonValue,
  readJsonValue,
} from "@wfgraph/shared/types/json";
import type { WorkflowDraftService } from "#src/document";
import {
  AddNode,
  ConnectNodes,
  DeleteNode,
  DisconnectNodes,
  type graphWriteToolHandlers,
  InsertNodeOnEdge,
  UpdateNode,
} from "#src/tools/graph-write-tools";
import { newIssuesField } from "#src/tools/new-issues";
import { writeHints } from "#src/tools/tool-hints";

/** The most operations one batch may carry. */
export const MAX_BATCH_OPERATIONS = 50;

const keySchema = Schema.optionalKey(
  Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/))
).annotate({
  description:
    "A name for the step this operation creates. Later operations name the step as $key, in an id field or inside a token as {{@$key:Label.path}}.",
});

const operationSchema = Schema.Union([
  Schema.Struct({
    tool: Schema.Literal("add_node"),
    key: keySchema,
    ...AddNode.parametersSchema.fields,
  }),
  Schema.Struct({
    tool: Schema.Literal("update_node"),
    ...UpdateNode.parametersSchema.fields,
  }),
  Schema.Struct({
    tool: Schema.Literal("delete_node"),
    ...DeleteNode.parametersSchema.fields,
  }),
  Schema.Struct({
    tool: Schema.Literal("connect_nodes"),
    ...ConnectNodes.parametersSchema.fields,
  }),
  Schema.Struct({
    tool: Schema.Literal("disconnect_nodes"),
    ...DisconnectNodes.parametersSchema.fields,
  }),
  Schema.Struct({
    tool: Schema.Literal("insert_node_on_edge"),
    key: keySchema,
    ...InsertNodeOnEdge.parametersSchema.fields,
  }),
]);

type Operation = typeof operationSchema.Type;

const operationResultSchema = Schema.Struct({
  tool: Schema.String,
  key: Schema.optionalKey(Schema.String),
  summary: Schema.String,
  nodeId: Schema.optionalKey(Schema.String),
  incomingEdgeId: Schema.optionalKey(Schema.String),
  outgoingEdgeId: Schema.optionalKey(Schema.String),
});

export const ApplyEdits = Tool.make("apply_edits", {
  description: `Apply several graph edits in order as one write: add_node, update_node, delete_node, connect_nodes, disconnect_nodes and insert_node_on_edge, each with the arguments its own tool takes and a "tool" field naming it. Each operation sees the graph the operations before it left. When any operation is refused, nothing is applied and the reason names the operation. At most ${MAX_BATCH_OPERATIONS} operations.`,
  parameters: Schema.Struct({
    operations: Schema.Array(operationSchema).annotate({
      description: "The edits, in the order they apply.",
    }),
  }),
  success: Schema.Struct({
    results: Schema.Array(operationResultSchema),
    ...newIssuesField,
  }),
  failure: Schema.Struct({ reason: Schema.String }),
  failureMode: "return",
}).annotateMerge(
  writeHints({
    title: "Apply several edits",
    destructive: true,
    idempotent: false,
  })
);

type GraphWriteHandlers = Effect.Success<typeof graphWriteToolHandlers>;

/** Every `$key` the batch has bound, replaced in one string. */
function resolveKeys(value: string, ids: ReadonlyMap<string, string>): string {
  const whole = value.startsWith("$") ? ids.get(value.slice(1)) : undefined;
  if (whole !== undefined) {
    return whole;
  }
  return value.replaceAll(
    /\{\{@\$([A-Za-z][A-Za-z0-9_-]*):/gu,
    (token, key: string) => {
      const id = ids.get(key);
      return id === undefined ? token : `{{@${id}:`;
    }
  );
}

/** A JSON value with every bound `$key` replaced, at any depth. */
function withKeysResolved(
  value: JsonValue,
  ids: ReadonlyMap<string, string>
): JsonValue {
  if (typeof value === "string") {
    return resolveKeys(value, ids);
  }
  if (Array.isArray(value)) {
    return value.map((item) => withKeysResolved(item, ids));
  }
  if (isJsonObject(value)) {
    // oxlint-disable-next-line wfgraph/no-entries-round-trip -- the operation is JSON a model wrote, so it can carry an own __proto__ key. Object.fromEntries defines that key as an own property; mapValues would reach the prototype setter and lose it.
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        withKeysResolved(item, ids),
      ])
    );
  }
  return value;
}

const decodeOperation = Schema.decodeUnknownResult(operationSchema);

/**
 * The operation with every bound `$key` replaced. It is read back through
 * its schema, since a replaced id is a string where a string already was.
 */
function resolveOperation(
  operation: Operation,
  ids: ReadonlyMap<string, string>
): Operation {
  if (ids.size === 0) {
    return operation;
  }
  const resolved = decodeOperation(
    withKeysResolved(readJsonValue(operation) ?? null, ids)
  );
  return Result.isSuccess(resolved) ? resolved.success : operation;
}

type OperationResult = typeof operationResultSchema.Type;

function runOperation(
  handlers: GraphWriteHandlers,
  operation: Operation
): Effect.Effect<OperationResult, { readonly reason: string }> {
  switch (operation.tool) {
    case "add_node": {
      const { tool, key, ...input } = operation;
      return Effect.map(handlers.add_node(input), (result) => ({
        tool,
        ...omitUndefined({ key }),
        summary: result.summary,
        nodeId: result.nodeId,
      }));
    }
    case "update_node": {
      const { tool, ...input } = operation;
      return Effect.map(handlers.update_node(input), (result) => ({
        tool,
        summary: result.summary,
      }));
    }
    case "delete_node": {
      const { tool, ...input } = operation;
      return Effect.map(handlers.delete_node(input), (result) => ({
        tool,
        summary: result.summary,
      }));
    }
    case "connect_nodes": {
      const { tool, ...input } = operation;
      return Effect.map(handlers.connect_nodes(input), (result) => ({
        tool,
        summary: result.summary,
      }));
    }
    case "disconnect_nodes": {
      const { tool, ...input } = operation;
      return Effect.map(handlers.disconnect_nodes(input), (result) => ({
        tool,
        summary: result.summary,
      }));
    }
    // The last kind carries the `default` label because
    // `typescript(consistent-return)` reads a switch over named cases as a
    // function that can fall out of the end.
    default: {
      const { tool, key, ...input } = operation;
      return Effect.map(handlers.insert_node_on_edge(input), (result) => ({
        tool,
        ...omitUndefined({ key }),
        summary: result.summary,
        nodeId: result.nodeId,
        incomingEdgeId: result.incomingEdgeId,
        outgoingEdgeId: result.outgoingEdgeId,
      }));
    }
  }
}

/** The `apply_edits` handler over the draft and the single-edit handlers. */
export function applyEditsHandler(input: {
  readonly draft: WorkflowDraftService;
  /** The single-edit handlers bound to one draft, the scratch the batch edits. */
  readonly handlersFor: (
    scratch: WorkflowDraftService
  ) => Effect.Effect<GraphWriteHandlers>;
}) {
  const { draft, handlersFor } = input;

  return (batch: { readonly operations: readonly Operation[] }) =>
    Effect.gen(function* () {
      if (batch.operations.length === 0) {
        return yield* Effect.fail({
          reason: "apply_edits needs at least one operation.",
        });
      }
      if (batch.operations.length > MAX_BATCH_OPERATIONS) {
        return yield* Effect.fail({
          reason: `apply_edits takes at most ${MAX_BATCH_OPERATIONS} operations; split the batch.`,
        });
      }

      // The operations edit a scratch copy, which the draft stores as one
      // revision when every operation succeeds and drops when one fails.
      return yield* draft.transaction((scratch) =>
        Effect.gen(function* () {
          const handlers = yield* handlersFor(scratch);
          const ids = new Map<string, string>();
          const results: OperationResult[] = [];
          for (const [index, raw] of batch.operations.entries()) {
            const operation = resolveOperation(raw, ids);
            const outcome = yield* Effect.result(
              runOperation(handlers, operation)
            );
            if (Result.isFailure(outcome)) {
              return yield* Effect.fail({
                reason: `Operation ${index + 1} (${raw.tool}) was refused, so no operation was applied: ${outcome.failure.reason}`,
              });
            }
            const result = outcome.success;
            if (result.key !== undefined && result.nodeId !== undefined) {
              ids.set(result.key, result.nodeId);
            }
            results.push(result);
          }
          return { results };
        })
      );
    });
}

/**
 * How a Condition node's expression is decided: the roots its CEL reads, built
 * from the run's node outputs, and the evaluation over them. A rule naming its
 * source node reads `node`; a rule naming none reads the flat `payload`
 * namespace published versions were written against.
 */

import { evaluateCompiledCondition } from "#src/backend/lib/cel/condition-payload";
import {
  collectEntityStateConditionReferences,
  collectNodeOutputConditionReferences,
  collectTimestampFieldPaths,
  parseConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import {
  parseOutputPath,
  unwrapStepOutput,
} from "@wfgraph/shared/graph/node-references";
import type { JsonObject, JsonValue } from "@wfgraph/shared/types/json";
import type { EntityTemplateContext } from "#src/backend/engine/entities";
import type { NodeOutputInGraphOrder } from "#src/backend/engine/traversal";
import { uniq } from "es-toolkit/array";
import { Effect } from "effect";

type ConditionEvalResult = {
  result: boolean;
};

/**
 * Fold one node's output into the flat namespace a rule naming no node reads.
 *
 * Steps return their fields inside a `{ success, data }` wrapper, and such a
 * rule names those fields by path alone (`payload.donorId == "abc"`), so the
 * output goes through the same unwrapping a template token gets before its keys
 * are lifted into the namespace.
 *
 * The namespace is flat across every node, so two nodes that both produce a
 * field called `id` collide, and the node later in the graph's node order wins.
 * Every rule the editor and the build agent write names its node and reads the
 * `node` root instead (`nodeOutputConditionContext`). This fold stays, unchanged,
 * because a published version is immutable and its unqualified rules must keep
 * routing runs the way they did when it was published.
 */
function mergeConditionContextValue(context: JsonObject, value: JsonValue) {
  const record = unwrapStepOutput(value);
  // A node output is JSON that came back from a plugin's own API call, so its
  // shape belongs to that API and nothing here knows it. Only a keyed object
  // contributes names: copying a string or an array would spread index keys
  // into the namespace and let a condition read `0`.
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return;
  }

  Object.assign(context, record);

  const nestedInput = Reflect.get(record, "input");
  if (
    typeof nestedInput !== "object" ||
    nestedInput === null ||
    Array.isArray(nestedInput)
  ) {
    return;
  }

  for (const key of Object.keys(nestedInput)) {
    if (!(key in context)) {
      context[key] = Reflect.get(nestedInput, key);
    }
  }
}

/**
 * The timestamp field paths a Condition node's stored model declares.
 *
 * Saving a workflow rejects a Condition node whose model is missing or does not
 * compile to the expression beside it, so a model that fails to parse here
 * belongs to a node that never should have run; the condition still evaluates,
 * against a context where timestamps stay strings.
 */
function readConditionContextShape(conditionModel: unknown): Effect.Effect<{
  timestampPaths: string[];
  entityReferences: ReturnType<typeof collectEntityStateConditionReferences>;
  nodeIds: string[];
}> {
  const parsed = parseConditionModel(conditionModel);
  if (!parsed.valid) {
    return Effect.as(
      Effect.logWarning("Condition model did not parse").pipe(
        Effect.annotateLogs({ error: parsed.error })
      ),
      { timestampPaths: [], entityReferences: [], nodeIds: [] }
    );
  }

  return Effect.succeed({
    timestampPaths: collectTimestampFieldPaths(parsed.model),
    entityReferences: collectEntityStateConditionReferences(parsed.model),
    nodeIds: uniq(
      collectNodeOutputConditionReferences(parsed.model).map(
        (reference) => reference.nodeId
      )
    ),
  });
}

/**
 * CEL's `node` root: the unwrapped output of each node a rule names, keyed by
 * node id. A named node that has not finished is left out, and the compiled
 * presence guard then reads the rule as false, the way it reads a payload
 * field the run does not carry.
 */
function nodeOutputConditionContext(
  outputs: readonly NodeOutputInGraphOrder[],
  nodeIds: readonly string[]
): JsonObject {
  const context: JsonObject = {};
  const named = new Set(nodeIds);
  for (const output of outputs) {
    if (!named.has(output.nodeId)) {
      continue;
    }
    // A node id is text the builder chose, so it is defined rather than
    // assigned: an id of `__proto__` stays an own key.
    Object.defineProperty(context, output.nodeId, {
      value: unwrapStepOutput(output.data),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return context;
}

function setConditionContextValue(
  context: JsonObject,
  path: string,
  value: JsonValue
): void {
  const steps = parseOutputPath(path);
  if (!steps?.length) {
    return;
  }

  let current: JsonObject | JsonValue[] = context;
  for (const [index, step] of steps.entries()) {
    const key = step.kind === "key" ? step.key : step.index;
    if (index === steps.length - 1) {
      Reflect.set(current, key, structuredClone(value));
      return;
    }

    const nextStep = steps[index + 1];
    const existing: JsonValue | undefined =
      step.kind === "key" && !Array.isArray(current)
        ? current[step.key]
        : step.kind === "index" && Array.isArray(current)
          ? current[step.index]
          : undefined;
    if (nextStep?.kind === "index" && Array.isArray(existing)) {
      current = existing;
      continue;
    }
    if (
      nextStep?.kind === "key" &&
      typeof existing === "object" &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      current = existing;
      continue;
    }

    const child: JsonObject | JsonValue[] =
      nextStep?.kind === "index" ? [] : {};
    Reflect.set(current, key, child);
    current = child;
  }
}

/** Build CEL's nested Entity root from the path-keyed durable projection. */
function entityConditionContext(
  entityContext: EntityTemplateContext | undefined,
  references: ReturnType<typeof collectEntityStateConditionReferences>
): JsonObject {
  const context: JsonObject = {};
  if (!entityContext) {
    return context;
  }

  const matchingReferences = references.filter(
    (reference) => reference.entityType === entityContext.entityType
  );
  if (matchingReferences.length === 0) {
    return context;
  }

  const values: JsonObject = {};
  for (const reference of matchingReferences) {
    if (Object.hasOwn(entityContext.values, reference.fieldPath)) {
      setConditionContextValue(
        values,
        reference.fieldPath,
        Reflect.get(entityContext.values, reference.fieldPath)
      );
    }
  }
  Object.defineProperty(context, entityContext.entityType, {
    value: values,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return context;
}

export function evaluateConditionExpression(
  conditionExpression: unknown,
  /** Every finished node's output, in the graph's node order. */
  outputs: readonly NodeOutputInGraphOrder[],
  conditionModel: unknown,
  /** The Event that put the run on the branch this node sits on. */
  eventName: string | null,
  /** Current tracked Entity State projected for this Condition node. */
  entityContext?: EntityTemplateContext
): Effect.Effect<ConditionEvalResult> {
  return Effect.gen(function* () {
    yield* Effect.logDebug("Evaluating condition expression").pipe(
      Effect.annotateLogs({ conditionExpression })
    );

    if (typeof conditionExpression === "boolean") {
      return { result: conditionExpression };
    }

    if (typeof conditionExpression !== "string") {
      yield* Effect.logWarning("Condition is neither boolean nor string").pipe(
        Effect.annotateLogs({ conditionExpression })
      );
      return { result: false };
    }

    const expression = conditionExpression.trim();
    if (!expression) {
      return { result: false };
    }

    const merged: JsonObject = {};
    for (const output of outputs) {
      mergeConditionContextValue(merged, output.data);
    }

    const conditionContext = yield* readConditionContextShape(conditionModel);
    const evaluation = evaluateCompiledCondition({
      expression,
      timestampPaths: conditionContext.timestampPaths,
      payload: merged,
      eventName,
      entity: entityConditionContext(
        entityContext,
        conditionContext.entityReferences
      ),
      node: nodeOutputConditionContext(outputs, conditionContext.nodeIds),
    });

    if (!evaluation.ok) {
      yield* Effect.logError("CEL condition evaluation failed").pipe(
        Effect.annotateLogs({
          error: evaluation.error,
          conditionExpression,
        })
      );
      return { result: false };
    }

    return { result: evaluation.value };
  });
}

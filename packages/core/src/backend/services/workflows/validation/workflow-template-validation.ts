/**
 * Every `{{@nodeId:Label.field}}` a graph carries, held to what the field it
 * names can answer.
 *
 * A token that cannot resolve is silence at run time rather than a failure: the
 * engine renders a missing path as empty text, and a duration parser is then
 * handed the empty string. The picker already declines to write most of what is
 * refused here, so this catches a graph written before the rule or through the
 * API.
 */

import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import {
  type ExtensionCatalog,
  findAction,
} from "@wfgraph/shared/extensions/catalog";
import { eventsReaching } from "@wfgraph/shared/graph/events-reaching";
import {
  isEntityStateSourceId,
  referenceFieldForPath,
} from "@wfgraph/shared/graph/node-references";
import {
  absentOn,
  reachableEventFields,
} from "@wfgraph/shared/graph/reachable-fields";
import {
  targetAccepts,
  type ValueTargetType,
} from "@wfgraph/shared/graph/value-targets";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import {
  flattenConfigFields,
  literalFieldKeys,
  templateJsonFieldShapes,
} from "@wfgraph/shared/plugins/action-fields";
import { extractConsumedTemplateReferences } from "@wfgraph/shared/plugins/template-config";
import {
  waitMatchTemplateStringsIn,
  waitTemplateKeysIn,
  waitValueTargetsFor,
} from "@wfgraph/shared/lifecycle/wait-subscription";
import { findEntityTemplateSource } from "@wfgraph/shared/lifecycle/entity-eligibility";
import { readLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { readJsonObjectLeniently } from "@wfgraph/shared/types/json";
import { getNodeLabel } from "#src/backend/services/workflows/validation/workflow-graph";

export type WorkflowTemplateValidationResult =
  | { valid: true }
  | { valid: false; error: string };

/**
 * What a config key expects of the value written into it.
 *
 * `literal` is the key the engine hands to a step as authored, without resolving
 * templates into it (`processTemplates`), so a token there is text and no parser
 * ever sees it.
 */
type ValueTarget = {
  type?: ValueTargetType | undefined;
  required: boolean;
  literal?: true | undefined;
};

/**
 * What each config key of this node expects.
 *
 * The Wait node's own keys are declared as data beside its config schema,
 * because its panel is bespoke and its catalog entry lists no fields, and they
 * are seeded only for that node: another action is free to have a key called
 * `waitUntil` and mean something else by it. Everything else reads the fields
 * the action declared, which carry a required flag and no type: a plugin's
 * template input takes whatever text it is given.
 */
function valueTargets(
  node: WorkflowNode,
  catalog: ExtensionCatalog
): Map<string, ValueTarget> {
  const targets = new Map<string, ValueTarget>();

  const actionType = node.data.config?.actionType;
  if (typeof actionType !== "string") {
    return targets;
  }

  // Only the keys the node's current shape reads: a leftover timeout on a wait
  // now on a clock is a value no run consults, and its input is off screen.
  if (actionType === BUILT_IN_ACTION_IDS.wait) {
    for (const [key, target] of Object.entries(
      waitValueTargetsFor(node.data.config ?? {})
    )) {
      targets.set(key, target);
    }
  }

  const action = findAction(catalog, actionType);
  for (const field of flattenConfigFields(action?.configFields ?? [])) {
    targets.set(field.key, {
      required: field.required === true,
      literal: field.literal,
    });
  }

  return targets;
}

export function validateWorkflowTemplates(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
}): WorkflowTemplateValidationResult {
  const { nodes, edges, catalog } = input;
  // A Map rather than a keyBy record: both lookups below are keyed by text the
  // operator typed inside a template token, and a plain object would answer a
  // token named `constructor` or `toString` with a prototype member.
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const lifecycleRules = nodes
    .filter((node) => node.data.type === "lifecycle")
    .map((node) => readLifecycleRules(node.data.config))
    .find((rules) => rules !== undefined);
  const entitySource = findEntityTemplateSource({
    rules: lifecycleRules,
    catalog,
  });

  for (const node of nodes) {
    const config = node.data.config;
    const jsonConfig = readJsonObjectLeniently(config);
    if (node.data.type !== "action" || !config || !jsonConfig) {
      continue;
    }

    const actionType = actionTypeOf(node);
    const action = actionType ? findAction(catalog, actionType) : undefined;
    const activeWaitKeys =
      actionType === BUILT_IN_ACTION_IDS.wait
        ? new Set<string>(waitTemplateKeysIn(config))
        : undefined;
    const literalKeys = new Set(literalFieldKeys(action?.configFields ?? []));
    const references = extractConsumedTemplateReferences(
      jsonConfig,
      {
        literalKeys,
        jsonShapes: new Map(
          templateJsonFieldShapes(action?.configFields ?? [])
        ),
        activeKeys: activeWaitKeys,
      },
      actionType === BUILT_IN_ACTION_IDS.wait
        ? waitMatchTemplateStringsIn(config)
        : []
    );
    if (references.length === 0) {
      continue;
    }

    const targets = valueTargets(node, catalog);
    for (const reference of references) {
      const topLevelKey = reference.field.split(".", 1)[0] ?? reference.field;
      const target = targets.get(topLevelKey);
      if (!isEntityStateSourceId(reference.nodeId)) {
        continue;
      }

      const field =
        entitySource && reference.sourceType === entitySource.type
          ? referenceFieldForPath(entitySource.stateFields, reference.fieldPath)
          : undefined;
      const where = `Node "${getNodeLabel(node)}" reads ${reference.displayText}`;
      if (!entitySource) {
        return {
          valid: false,
          error: `${where}, but Entity data is available only while Entity Eligibility is configured.`,
        };
      }
      if (!reference.fieldPath || !field) {
        return {
          valid: false,
          error: `${where}, which Entity "${entitySource.type}" does not declare.`,
        };
      }

      if (
        target?.type &&
        !targetAccepts(field, target.type, { allowNumber: true })
      ) {
        return {
          valid: false,
          error: `${where} into ${topLevelKey}, which takes a ${target.type}. That path is a ${field.type}.`,
        };
      }
    }
    // The entry node's output is the payload of whichever Event put the run
    // here, and several Events can. An action's output has one shape, so only a
    // reference to the entry node needs reconciling.
    const reaching = eventsReaching({
      targetNodeId: node.id,
      nodes,
      edges,
      catalog,
    });
    const entryFields = new Map(
      reachableEventFields(reaching).map((field) => [field.path, field])
    );

    for (const reference of references) {
      if (nodeById.get(reference.nodeId)?.data.type !== "lifecycle") {
        continue;
      }

      const key = reference.field.split(".", 1)[0] ?? reference.field;
      const target = targets.get(key);
      const field = entryFields.get(reference.fieldPath);
      if (!field) {
        continue;
      }

      const where = `Node "${getNodeLabel(node)}" reads ${reference.fieldPath}`;

      if (field.typeClash) {
        return {
          valid: false,
          error: `${where}, which ${field.typeClash.events.join(" and ")} type differently. Add an Event Split above it, or read a path they agree on.`,
        };
      }

      if (
        target?.type &&
        !targetAccepts(field, target.type, { allowNumber: true })
      ) {
        return {
          valid: false,
          error: `${where} into ${key}, which takes a ${target.type}. That path is a ${field.type}.`,
        };
      }

      const absent = target?.required ? absentOn(field, reaching) : [];
      if (absent.length > 0) {
        return {
          valid: false,
          error: `${where} into ${key}, which ${absent.join(" and ")} does not carry. Add an Event Split above it, so this branch only runs for the Events that do.`,
        };
      }
    }
  }

  return { valid: true };
}

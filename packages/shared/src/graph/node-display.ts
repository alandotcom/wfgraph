/**
 * What a node is called on screen and inside a template token.
 *
 * A token is `{{@nodeId:Label.path}}`, and the engine resolves it by the id
 * alone, so the label is display. It still has to agree everywhere it is
 * written: the editor's reference picker, the rename that rewrites tokens in
 * other nodes, and the build agent listing what a node can address. One rule
 * here is what keeps those three from drifting.
 *
 * The label stored inside a token is the source's name when the reference was
 * written, and goes stale when the source step is renamed. The `current*`
 * functions name a token's source as the workflow has it now.
 */

import {
  type ExtensionCatalog,
  findAction,
  findEntity,
  findEvent,
} from "#src/extensions/catalog";
import {
  ACTION_TYPE_CONFIG_KEY,
  isLifecycleNode,
  readConfigString,
} from "#src/graph/node-config";
import {
  isEntityStateSourceId,
  parseTemplate,
  type TemplateToken,
  templateTokenDisplayText,
} from "#src/graph/node-references";
import type { WorkflowNode } from "#src/graph/types";
import { readLifecycleRules } from "#src/lifecycle/lifecycle-rules";

/**
 * What the interface titles the Lifecycle Node: its own label, else the Start
 * Events that start a run, such as "When Payment settled", else "Start". The
 * domain term stays Lifecycle Node; a person reads the node as where a run
 * starts. Value references keep reading the node by `getNodeDisplayName`.
 */
export function startNodeTitle(
  catalog: ExtensionCatalog,
  data: {
    label?: string | undefined;
    config?: Record<string, unknown> | undefined;
  }
): string {
  const label = data.label?.trim();
  if (label) {
    return label;
  }
  const events = readLifecycleRules(data.config)?.startEvents ?? [];
  if (events.length === 0) {
    return "Start";
  }
  return `When ${events
    .map((name) => findEvent(catalog, name)?.label ?? name)
    .join(" or ")}`;
}

export function getNodeDisplayName(
  catalog: ExtensionCatalog,
  node: WorkflowNode
): string {
  if (node.data.label) {
    return node.data.label;
  }

  if (node.data.type === "action") {
    const actionType = readConfigString(
      node.data.config,
      ACTION_TYPE_CONFIG_KEY
    );
    if (actionType) {
      const action = findAction(catalog, actionType);
      if (action?.label) {
        return action.label;
      }
    }

    return actionType || "Action";
  }

  if (node.data.type === "lifecycle") {
    return "Lifecycle";
  }

  return "Node";
}

/**
 * The `type` of the Entity the workflow made of `nodes` tracks, read off its
 * Lifecycle node, or undefined when it tracks none.
 */
function trackedEntityTypeOf(
  nodes: readonly WorkflowNode[]
): string | undefined {
  return readLifecycleRules(nodes.find(isLifecycleNode)?.data.config)
    ?.trackedEntity?.type;
}

/**
 * The current name of the step or Entity a token reads from, or undefined
 * when the workflow no longer offers that source. A step token's source is
 * its node in `nodes`. An Entity token's source is the Entity the Lifecycle
 * node in `nodes` tracks, so a token naming any other Entity type, or none,
 * has no source, and neither does a type the catalog does not hold.
 */
function liveTokenSourceLabel(
  token: Pick<TemplateToken, "nodeId" | "sourceType">,
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): string | undefined {
  if (isEntityStateSourceId(token.nodeId)) {
    return token.sourceType !== undefined &&
      token.sourceType === trackedEntityTypeOf(nodes)
      ? findEntity(catalog, token.sourceType)?.label
      : undefined;
  }
  const node = nodes.find((candidate) => candidate.id === token.nodeId);
  return node ? getNodeDisplayName(catalog, node) : undefined;
}

/**
 * What a builder reads for one token, and whether the workflow made of
 * `nodes` still offers the source the token reads from. `text` is the name of
 * that source, then the path. The name is a step's display name from `nodes`,
 * or the catalog label of the Entity the workflow tracks. The label stored in
 * the token answers when `sourceIsLive` is false, which keeps what the token
 * was written to read in view.
 */
export function currentTokenDisplay(
  token: Pick<
    TemplateToken,
    "nodeId" | "sourceType" | "nodeLabel" | "fieldPath"
  >,
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): { text: string; sourceIsLive: boolean } {
  const liveLabel = liveTokenSourceLabel(token, nodes, catalog);
  return {
    text: templateTokenDisplayText({
      nodeLabel: liveLabel ?? token.nodeLabel,
      fieldPath: token.fieldPath,
    }),
    sourceIsLive: liveLabel !== undefined,
  };
}

/** The `text` of `currentTokenDisplay`, for a caller that needs no more. */
export function currentTokenDisplayText(
  token: Pick<
    TemplateToken,
    "nodeId" | "sourceType" | "nodeLabel" | "fieldPath"
  >,
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): string {
  return currentTokenDisplay(token, nodes, catalog).text;
}

/**
 * An authored string with every token replaced by its current display text,
 * which drops the node id the engine resolves by. `nodes` is the whole graph
 * the string belongs to, its Lifecycle node included. A string with no tokens
 * is returned unchanged.
 */
export function currentTemplateDisplayText(
  value: string,
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): string {
  const segments = parseTemplate(value);
  if (segments.every((segment) => segment.kind === "literal")) {
    return value;
  }
  return segments
    .map((segment) =>
      segment.kind === "literal"
        ? segment.text
        : currentTokenDisplayText(segment.token, nodes, catalog)
    )
    .join("");
}

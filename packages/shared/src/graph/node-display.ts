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
} from "#src/extensions/catalog";
import { isLifecycleNode, readConfigString } from "#src/graph/node-config";
import {
  isEntityStateSourceId,
  parseTemplate,
  type TemplateToken,
  templateTokenDisplayText,
} from "#src/graph/node-references";
import type { WorkflowNode } from "#src/graph/types";
import { readLifecycleRules } from "#src/lifecycle/lifecycle-rules";

export function getNodeDisplayName(
  catalog: ExtensionCatalog,
  node: WorkflowNode
): string {
  if (node.data.label) {
    return node.data.label;
  }

  if (node.data.type === "action") {
    const actionType = readConfigString(node.data.config, "actionType");
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
 * Whether the workflow made of `nodes` still offers the source a token reads
 * from: a step token's node is in `nodes`, or an Entity token names the
 * Entity the workflow tracks and the catalog holds that type. A token this
 * answers false for is the one `currentTokenDisplayText` shows by its stored
 * label.
 */
export function tokenSourceIsLive(
  token: Pick<TemplateToken, "nodeId" | "sourceType">,
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): boolean {
  return liveTokenSourceLabel(token, nodes, catalog) !== undefined;
}

/**
 * What a builder reads for one token: the name of the source it reads from,
 * then the path. The name is a step's display name from `nodes`, or the
 * catalog label of the Entity the workflow tracks. The label stored in the
 * token answers when the workflow no longer offers the source, which keeps
 * what the token was written to read in view.
 */
export function currentTokenDisplayText(
  token: Pick<
    TemplateToken,
    "nodeId" | "sourceType" | "nodeLabel" | "fieldPath"
  >,
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): string {
  return templateTokenDisplayText({
    nodeLabel: liveTokenSourceLabel(token, nodes, catalog) ?? token.nodeLabel,
    fieldPath: token.fieldPath,
  });
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

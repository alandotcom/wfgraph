/**
 * Snapshot a canvas selection as a subgraph that can be pasted with fresh ids.
 * The Lifecycle Node is never copied. Edges travel only when both ends are in
 * the selection. Template tokens that name a copied node are rewritten onto
 * the clone; tokens that name a node left behind keep pointing at it.
 */

import { omit } from "es-toolkit/object";
import {
  formatTemplateToken,
  mapTemplateTokens,
} from "@wfgraph/shared/graph/node-references";
import { generateId } from "@wfgraph/shared/utils/id";
import { expandGroupCopyIds } from "@wfgraph/shared/graph/node-group";
import {
  offsetClearOfRectangles,
  overviewCardRectangle,
  overviewCardRectangles,
} from "@wfgraph/shared/graph/node-placement";
import {
  toEditorEdge,
  toEditorNode,
  toPersistedEdge,
  toPersistedNode,
  type WorkflowEdge,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";

/** How far a keyboard paste sits from the copied original, in flow pixels. */
export const PASTE_OFFSET = 48;

export type CopiedSelection = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export function isCopyableNode(node: WorkflowNode): boolean {
  return node.data.type !== "lifecycle" && node.type !== "add";
}

/**
 * The copyable nodes a node-context Copy should take: the whole selection when
 * the clicked node is in `selectedNodeIds`, otherwise just that node. With
 * `wholeGroups`, the default, a Group frame or member brings its whole Group.
 */
export function nodeIdsForContextCopy(
  nodes: readonly WorkflowNode[],
  clickedNodeId: string,
  selectedNodeIds: ReadonlySet<string>,
  options: { wholeGroups?: boolean | undefined } = {}
): ReadonlySet<string> {
  const clicked = nodes.find((node) => node.id === clickedNodeId);
  if (!clicked || !isCopyableNode(clicked)) {
    return new Set();
  }

  const ids = selectedNodeIds.has(clicked.id)
    ? new Set(
        nodes
          .filter(
            (node) => selectedNodeIds.has(node.id) && isCopyableNode(node)
          )
          .map((node) => node.id)
      )
    : new Set([clicked.id]);
  return (options.wholeGroups ?? true) ? expandGroupCopyIds(nodes, ids) : ids;
}

/**
 * The copyable subgraph `nodeIds` names, or null when it names none. With
 * `wholeGroups`, the default, a Group frame or member brings its whole Group.
 */
export function extractCopyableSelection(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  nodeIds: ReadonlySet<string>;
  wholeGroups?: boolean | undefined;
}): CopiedSelection | null {
  const requested = input.nodes.filter(
    (node) => isCopyableNode(node) && input.nodeIds.has(node.id)
  );

  if (requested.length === 0) {
    return null;
  }

  const requestedIds = new Set(requested.map((node) => node.id));
  const ids =
    (input.wholeGroups ?? true)
      ? expandGroupCopyIds(input.nodes, requestedIds)
      : requestedIds;
  const copyable = input.nodes.filter((node) => ids.has(node.id));
  const edges = input.edges.filter(
    (edge) => ids.has(edge.source) && ids.has(edge.target)
  );

  return {
    nodes: copyable.map(snapshotNode),
    edges: edges.map(snapshotEdge),
  };
}

/**
 * Assign fresh ids, apply an offset, and rewrite tokens that named a copied
 * node. `selection` is extractCopyableSelection's output; this does not
 * re-filter or re-snapshot it.
 */
export function cloneSelection(
  selection: CopiedSelection,
  options: {
    offset: { x: number; y: number };
    createId?: () => string;
  }
): CopiedSelection {
  const createId = options.createId ?? generateId;
  const idMap = new Map<string, string>();

  for (const node of selection.nodes) {
    idMap.set(node.id, createId());
  }

  const copiedIds = new Set(selection.nodes.map((node) => node.id));
  const nodes = selection.nodes.map((node) => {
    const parentId = node.parentId;
    const parentCopied =
      typeof parentId === "string" && copiedIds.has(parentId);
    const nextParentId = parentCopied ? mappedId(idMap, parentId) : undefined;
    // A member whose frame was left behind becomes a top-level node, which
    // React Flow represents as a node with no `parentId` key.
    const copied: WorkflowNode = {
      ...omit(node, ["parentId"]),
      id: mappedId(idMap, node.id),
      position: parentCopied
        ? node.position
        : {
            x: node.position.x + options.offset.x,
            y: node.position.y + options.offset.y,
          },
      dragging: false,
      data: {
        ...node.data,
        config: remapConfig(node.data.config, idMap),
      },
    };
    if (nextParentId !== undefined) {
      copied.parentId = nextParentId;
    }
    return copied;
  });

  const edges = selection.edges.map((edge) => ({
    ...edge,
    id: createId(),
    source: mappedId(idMap, edge.source),
    target: mappedId(idMap, edge.target),
  }));

  return { nodes, edges };
}

/**
 * `offset`, grown down and right by `offsetClearOfRectangles` until no top-level
 * node of `selection` placed at it overlaps a card the overview draws from
 * `canvasNodes`. A copied Group counts at its collapsed card size.
 */
export function pasteOffsetClearOfCanvas(input: {
  selection: CopiedSelection;
  offset: { x: number; y: number };
  canvasNodes: readonly WorkflowNode[];
}): { x: number; y: number } {
  const block = topLevelNodes(input.selection.nodes).map((node) =>
    overviewCardRectangle({
      ...node,
      position: {
        x: node.position.x + input.offset.x,
        y: node.position.y + input.offset.y,
      },
    })
  );
  const clearance = offsetClearOfRectangles(
    block,
    overviewCardRectangles(input.canvasNodes)
  );
  return {
    x: input.offset.x + clearance.x,
    y: input.offset.y + clearance.y,
  };
}

/** The nodes of a copied subgraph whose frame was not copied with them. */
function topLevelNodes(nodes: readonly WorkflowNode[]): WorkflowNode[] {
  const ids = new Set(nodes.map((node) => node.id));
  return nodes.filter((node) => !node.parentId || !ids.has(node.parentId));
}

/** Translate so the copied bounding-box origin lands on `origin`. */
export function offsetToOrigin(
  nodes: readonly WorkflowNode[],
  origin: { x: number; y: number }
): { x: number; y: number } {
  const topLevel = topLevelNodes(nodes);
  const xs = topLevel.map((node) => node.position.x);
  const ys = topLevel.map((node) => node.position.y);
  return {
    x: origin.x - Math.min(...xs),
    y: origin.y - Math.min(...ys),
  };
}

function mappedId(idMap: ReadonlyMap<string, string>, id: string): string {
  const mapped = idMap.get(id);
  if (mapped === undefined) {
    throw new Error("cloneSelection expected extractCopyableSelection output");
  }
  return mapped;
}

function snapshotNode(node: WorkflowNode): WorkflowNode {
  return {
    ...toEditorNode(toPersistedNode(node)),
    dragging: false,
  };
}

function snapshotEdge(edge: WorkflowEdge): WorkflowEdge {
  return toEditorEdge(toPersistedEdge(edge));
}

function remapConfig(
  config: Record<string, unknown> | undefined,
  idMap: ReadonlyMap<string, string>
): Record<string, unknown> | undefined {
  if (!config) {
    return config;
  }

  return mapTemplateTokens(config, (token) => {
    const nodeId = idMap.get(token.nodeId);
    if (!nodeId) {
      return undefined;
    }
    return formatTemplateToken({
      nodeId,
      nodeLabel: token.nodeLabel,
      fieldPath: token.fieldPath,
    });
  });
}

/**
 * Snapshot a canvas selection as a subgraph that can be pasted with fresh ids.
 * The Lifecycle Node is never copied. Edges travel only when both ends are in
 * the selection. Template tokens that name a copied node are rewritten onto
 * the clone; tokens that name a node left behind keep pointing at it.
 */

import { nanoid } from "nanoid";
import { omit } from "es-toolkit/object";
import {
  formatTemplateToken,
  mapTemplateTokens,
} from "@wfgraph/shared/graph/node-references";
import {
  expandGroupCopyIds,
  isGroupNode,
} from "@wfgraph/shared/graph/node-group";
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
 * the clicked node is already selected, otherwise just that node.
 */
export function nodeIdsForContextCopy(
  nodes: readonly WorkflowNode[],
  clickedNodeId: string
): ReadonlySet<string> {
  const clicked = nodes.find((node) => node.id === clickedNodeId);
  if (!clicked || !isCopyableNode(clicked)) {
    return new Set();
  }

  if (clicked.selected) {
    return expandGroupCopyIds(
      nodes,
      new Set(
        nodes
          .filter((node) => node.selected && isCopyableNode(node))
          .map((node) => node.id)
      )
    );
  }

  return expandGroupCopyIds(nodes, new Set([clicked.id]));
}

export function extractCopyableSelection(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  nodeIds?: ReadonlySet<string> | undefined;
}): CopiedSelection | null {
  const requested = input.nodes.filter((node) => {
    if (!isCopyableNode(node)) {
      return false;
    }
    return input.nodeIds ? input.nodeIds.has(node.id) : Boolean(node.selected);
  });

  if (requested.length === 0) {
    return null;
  }

  const ids = expandGroupCopyIds(
    input.nodes,
    new Set(requested.map((node) => node.id))
  );
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
  const createId = options.createId ?? nanoid;
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
      selected: true,
      dragging: false,
      data: {
        ...node.data,
        config: remapGroupEndpoints(
          remapConfig(node.data.config, idMap),
          idMap,
          node
        ),
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
    selected: true,
  }));

  return { nodes, edges };
}

/** Translate so the copied bounding-box origin lands on `origin`. */
export function offsetToOrigin(
  nodes: readonly WorkflowNode[],
  origin: { x: number; y: number }
): { x: number; y: number } {
  const ids = new Set(nodes.map((node) => node.id));
  const topLevel = nodes.filter(
    (node) => !node.parentId || !ids.has(node.parentId)
  );
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
    selected: false,
    dragging: false,
  };
}

function snapshotEdge(edge: WorkflowEdge): WorkflowEdge {
  return {
    ...toEditorEdge(toPersistedEdge(edge)),
    selected: false,
  };
}

function remapGroupEndpoints(
  config: Record<string, unknown> | undefined,
  idMap: ReadonlyMap<string, string>,
  node: WorkflowNode
): Record<string, unknown> | undefined {
  if (!config || !isGroupNode(node)) {
    return config;
  }

  const next = { ...config };
  const entryIds = Array.isArray(config.entryNodeIds)
    ? config.entryNodeIds
        .map((id) => (typeof id === "string" ? idMap.get(id) : undefined))
        .filter((id): id is string => typeof id === "string")
    : [];
  const exitIds = Array.isArray(config.exitNodeIds)
    ? config.exitNodeIds
        .map((id) => (typeof id === "string" ? idMap.get(id) : undefined))
        .filter((id): id is string => typeof id === "string")
    : [];
  if (entryIds.length > 0) {
    next.entryNodeIds = entryIds;
  }
  if (exitIds.length > 0) {
    next.exitNodeIds = exitIds;
  }
  return next;
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

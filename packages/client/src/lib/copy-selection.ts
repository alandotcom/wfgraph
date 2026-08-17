/**
 * Snapshot a canvas selection as a subgraph that can be pasted with fresh ids.
 * The Lifecycle Node is never copied. Edges travel only when both ends are in
 * the selection. Template tokens that name a copied node are rewritten onto
 * the clone; tokens that name a node left behind keep pointing at it.
 */

import { nanoid } from "nanoid";
import {
  formatTemplateToken,
  parseTemplate,
} from "@wfgraph/shared/graph/node-references";
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
    return new Set(
      nodes
        .filter((node) => node.selected && isCopyableNode(node))
        .map((node) => node.id)
    );
  }

  return new Set([clicked.id]);
}

export function extractCopyableSelection(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  nodeIds?: ReadonlySet<string>;
}): CopiedSelection | null {
  const copyable = input.nodes.filter((node) => {
    if (!isCopyableNode(node)) {
      return false;
    }
    return input.nodeIds ? input.nodeIds.has(node.id) : Boolean(node.selected);
  });

  if (copyable.length === 0) {
    return null;
  }

  const ids = new Set(copyable.map((node) => node.id));
  const edges = input.edges.filter(
    (edge) => ids.has(edge.source) && ids.has(edge.target)
  );

  return {
    nodes: copyable.map(snapshotNode),
    edges: edges.map(snapshotEdge),
  };
}

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
    if (isCopyableNode(node)) {
      idMap.set(node.id, createId());
    }
  }

  const nodes = selection.nodes.flatMap((node) => {
    const nextId = idMap.get(node.id);
    if (!nextId) {
      return [];
    }

    const snapshotted = snapshotNode(node);
    return [
      {
        ...snapshotted,
        id: nextId,
        position: {
          x: snapshotted.position.x + options.offset.x,
          y: snapshotted.position.y + options.offset.y,
        },
        selected: true,
        dragging: false,
        data: {
          ...snapshotted.data,
          config: remapConfig(snapshotted.data.config, idMap),
        },
      },
    ];
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = selection.edges.flatMap((edge) => {
    const source = idMap.get(edge.source);
    const target = idMap.get(edge.target);
    if (!(source && target && nodeIds.has(source) && nodeIds.has(target))) {
      return [];
    }

    return [
      {
        ...snapshotEdge(edge),
        id: createId(),
        source,
        target,
        selected: true,
      },
    ];
  });

  return { nodes, edges };
}

/** Translate so the copied bounding-box origin lands on `origin`. */
export function offsetToOrigin(
  nodes: readonly WorkflowNode[],
  origin: { x: number; y: number }
): { x: number; y: number } {
  const xs = nodes.map((node) => node.position.x);
  const ys = nodes.map((node) => node.position.y);
  return {
    x: origin.x - Math.min(...xs),
    y: origin.y - Math.min(...ys),
  };
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

function remapConfig(
  config: Record<string, unknown> | undefined,
  idMap: ReadonlyMap<string, string>
): Record<string, unknown> | undefined {
  if (!config) {
    return config;
  }
  const remapped: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(config)) {
    remapped[key] = remapTemplatesInValue(nested, idMap);
  }
  return remapped;
}

function remapTemplatesInValue(
  value: unknown,
  idMap: ReadonlyMap<string, string>
): unknown {
  if (typeof value === "string") {
    return remapTemplateString(value, idMap);
  }

  if (Array.isArray(value)) {
    return value.map((item) => remapTemplatesInValue(item, idMap));
  }

  if (typeof value === "object" && value !== null) {
    const remapped: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      remapped[key] = remapTemplatesInValue(nested, idMap);
    }
    return remapped;
  }

  return value;
}

function remapTemplateString(
  value: string,
  idMap: ReadonlyMap<string, string>
): string {
  let changed = false;
  const next = parseTemplate(value)
    .map((segment) => {
      if (segment.kind === "literal") {
        return segment.text;
      }

      const remappedId = idMap.get(segment.token.nodeId);
      if (!remappedId) {
        return segment.token.raw;
      }

      changed = true;
      return formatTemplateToken({
        nodeId: remappedId,
        nodeLabel: segment.token.nodeLabel,
        fieldPath: segment.token.fieldPath,
      });
    })
    .join("");

  return changed ? next : value;
}

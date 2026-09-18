/**
 * Every path a user drags a connection through: dropping on the pane starts a
 * new node, dropping on a node or handle wires the two directly, and letting
 * go elsewhere cancels. `connectionOutcome` translates a painted connection to
 * what the store would save (or why it is refused) once, for both
 * `isValidConnection` and `onConnect` to read.
 */

import {
  type Connection as XYFlowConnection,
  type Edge as XYFlowEdge,
  type OnConnect,
  type OnConnectEnd,
  type OnConnectStart,
  type OnConnectStartParams,
} from "@xyflow/react";
import { useCallback, useRef } from "react";
import { useSetAtom } from "jotai";
import { toast } from "sonner";
import { generateId } from "@wfgraph/shared/utils/id";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  addNodeAtom,
  connectNodesAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { workflowNodeAriaLabel } from "#src/lib/workflow-graph-types";
import { WORKFLOW_NODE_HEIGHT } from "#src/lib/workflow-node-dimensions";
import { normalizeSourceHandleForConnection as normalizeSourceHandle } from "./connection-handle";
import {
  connectionHandleTypesMatch,
  connectionRefusalReason,
} from "./connection-validation";
import {
  storedCanvasConnection,
  type StoredCanvasConnection,
} from "#src/lib/group-scope-canvas";

interface UseCanvasConnectionsResult {
  isValidConnection: (connection: XYFlowConnection | XYFlowEdge) => boolean;
  onConnect: OnConnect;
  onConnectStart: OnConnectStart;
  onConnectEnd: OnConnectEnd;
  /** Whether a drag just created a node, true for a short window afterward so
   * the pane click that follows the same gesture does not clear the new
   * selection. */
  wasNodeJustCreatedFromConnection: () => boolean;
}

export function useCanvasConnections(input: {
  /** The painted nodes of the active scope, which a stub connection on a
   * focused Group translates against. */
  nodes: WorkflowNode[];
  /** Every node of the graph, which the connection rules read because a Group
   * frame stands for its members. */
  graphNodes: WorkflowNode[];
  storeEdges: WorkflowEdge[];
  catalog: ExtensionCatalog;
  graphEditingLocked: boolean;
  insertsNodes: boolean;
  screenToFlowPosition: (position: { x: number; y: number }) => {
    x: number;
    y: number;
  };
}): UseCanvasConnectionsResult {
  const {
    nodes,
    graphNodes,
    storeEdges,
    catalog,
    graphEditingLocked,
    insertsNodes,
    screenToFlowPosition,
  } = input;

  const addNode = useSetAtom(addNodeAtom);
  const connectNodes = useSetAtom(connectNodesAtom);
  const selectOnlyNode = useSetAtom(selectOnlyNodeAtom);

  const connectingNodeId = useRef<string | null>(null);
  const connectingHandleType = useRef<"source" | "target" | null>(null);
  const connectingHandleId = useRef<string | null>(null);
  const justCreatedNodeFromConnection = useRef(false);
  const wasNodeJustCreatedFromConnection = useCallback(
    () => justCreatedNodeFromConnection.current,
    []
  );

  // A painted connection on a focused Group names stubs; the rules and the
  // store read the stored connection each stub stands for, translated once
  // here. The refusal previews `planConnection` against the painted graph.
  const connectionOutcome = useCallback(
    (
      painted: XYFlowConnection | XYFlowEdge
    ): StoredCanvasConnection<XYFlowConnection | XYFlowEdge> => {
      const stored = storedCanvasConnection(painted, nodes);
      if ("refusal" in stored) {
        return stored;
      }
      const refusal = connectionRefusalReason({
        ...stored,
        nodes: graphNodes,
        storeEdges,
        catalog,
      });
      return refusal === null ? stored : { refusal };
    },
    [catalog, graphNodes, nodes, storeEdges]
  );

  const isValidConnection = useCallback(
    (connection: XYFlowConnection | XYFlowEdge) =>
      !graphEditingLocked && !("refusal" in connectionOutcome(connection)),
    [connectionOutcome, graphEditingLocked]
  );

  // Stored edges, which name Group members, so the handle chosen here is the
  // one `planConnection` derives when the store saves the connection.
  const normalizeSourceHandleForConnection = useCallback(
    (sourceNodeId: string, sourceHandle: string | null | undefined) =>
      normalizeSourceHandle({
        nodes: graphNodes,
        edges: storeEdges,
        sourceNodeId,
        sourceHandle,
        catalog,
      }),
    [graphNodes, storeEdges, catalog]
  );

  const onConnect: OnConnect = useCallback(
    (connection: XYFlowConnection) => {
      if (graphEditingLocked || !(connection.source && connection.target)) {
        return;
      }
      const outcome = connectionOutcome(connection);
      if ("refusal" in outcome) {
        toast.info(outcome.refusal, { id: "connection-refused" });
        return;
      }
      // The store plans the connection again against the graph it holds now,
      // which a save or an agent edit may have moved since the preview.
      const committed = connectNodes({
        connection: { ...outcome.connection, id: generateId() },
        fromIngressStub: outcome.fromIngressStub,
        catalog,
      });
      if (committed !== null && "refusal" in committed) {
        toast.info(committed.refusal, { id: "connection-refused" });
      }
    },
    [catalog, connectNodes, connectionOutcome, graphEditingLocked]
  );

  const onConnectStart: OnConnectStart = useCallback(
    (_event, connectionStart: OnConnectStartParams) => {
      if (graphEditingLocked) {
        return;
      }
      connectingNodeId.current = connectionStart.nodeId;
      connectingHandleType.current = connectionStart.handleType;
      connectingHandleId.current = connectionStart.handleId ?? null;
    },
    [graphEditingLocked]
  );

  const getClientPosition = useCallback((event: MouseEvent | TouchEvent) => {
    const clientX =
      "changedTouches" in event
        ? event.changedTouches[0].clientX
        : event.clientX;
    const clientY =
      "changedTouches" in event
        ? event.changedTouches[0].clientY
        : event.clientY;
    return { clientX, clientY };
  }, []);

  const handleConnectionToExistingNode = useCallback(
    (nodeElement: Element) => {
      const targetNodeId = nodeElement.getAttribute("data-id");
      const fromSource = connectingHandleType.current === "source";
      const connectingId = connectingNodeId.current;

      if (targetNodeId && connectingId) {
        const sourceId = fromSource ? connectingId : targetNodeId;
        const targetId = fromSource ? targetNodeId : connectingId;
        const sourceHandle = normalizeSourceHandleForConnection(
          sourceId,
          fromSource ? connectingHandleId.current : null
        );
        const targetHandle = fromSource ? null : connectingHandleId.current;
        onConnect({
          source: sourceId,
          target: targetId,
          sourceHandle,
          targetHandle,
        });
      }
    },
    [normalizeSourceHandleForConnection, onConnect]
  );

  const handleConnectionToNewNode = useCallback(
    (clientX: number, clientY: number) => {
      if (!insertsNodes) {
        return;
      }
      const sourceNodeId = connectingNodeId.current;
      if (!sourceNodeId) {
        return;
      }

      const fromSource = connectingHandleType.current === "source";
      if (
        !(
          fromSource ||
          isValidConnection({
            source: "__new_node__",
            target: sourceNodeId,
            sourceHandle: null,
            targetHandle: null,
          })
        )
      ) {
        return;
      }

      // Client coordinates, which is what `screenToFlowPosition` takes: it
      // subtracts the pane's own rect itself. This used to hand it the release
      // point already measured from the pane's top-left, which put every node
      // made by dropping a connection up and to the left of the cursor by
      // however far the pane sat from the window's corner, over the zoom. That
      // was the menu bar's 44px, and the shell's inset and border since added
      // 13px across.
      const position = screenToFlowPosition({ x: clientX, y: clientY });

      // Center vertically on the cursor.
      position.y -= WORKFLOW_NODE_HEIGHT / 2;

      const newNode: WorkflowNode = {
        id: generateId(),
        type: "action",
        position,
        data: {
          label: "",
          description: "",
          type: "action",
          config: {},
          status: "idle",
        },
        ariaLabel: workflowNodeAriaLabel({
          label: "",
          description: "",
          type: "action",
          config: {},
          status: "idle",
        }),
      };

      // Adding the node makes it the selection.
      addNode(newNode);

      // Deselect all other nodes and select only the new node
      // Need to do this after a delay because panOnDrag will clear selection
      setTimeout(() => {
        selectOnlyNode(newNode.id);
      }, 50);

      const sourceId = fromSource ? sourceNodeId : newNode.id;
      const targetId = fromSource ? newNode.id : sourceNodeId;
      const sourceHandle = normalizeSourceHandleForConnection(
        sourceId,
        fromSource ? connectingHandleId.current : null
      );
      const targetHandle = fromSource ? null : connectingHandleId.current;

      onConnect({
        source: sourceId,
        target: targetId,
        sourceHandle,
        targetHandle,
      });

      justCreatedNodeFromConnection.current = true;
      setTimeout(() => {
        justCreatedNodeFromConnection.current = false;
      }, 100);
    },
    [
      screenToFlowPosition,
      addNode,
      selectOnlyNode,
      normalizeSourceHandleForConnection,
      onConnect,
      isValidConnection,
      insertsNodes,
    ]
  );

  const onConnectEnd: OnConnectEnd = useCallback(
    (event, connectionState) => {
      if (graphEditingLocked) {
        return;
      }
      if (!connectingNodeId.current) {
        return;
      }

      const { clientX, clientY } = getClientPosition(event);

      // Touch ends on a different target than the drag started on, so hit-test
      // the release point; mouse can use event.target.
      let target: Element | null;
      if ("changedTouches" in event) {
        target = document.elementFromPoint(clientX, clientY);
      } else if (event.target instanceof Element) {
        target = event.target;
      } else {
        target = null;
      }

      if (!target) {
        connectingNodeId.current = null;
        connectingHandleType.current = null;
        connectingHandleId.current = null;
        return;
      }

      const nodeElement = target.closest(".react-flow__node");
      const isHandle = target.closest(".react-flow__handle");
      const droppedHandleType = isHandle?.classList.contains("source")
        ? "source"
        : isHandle?.classList.contains("target")
          ? "target"
          : null;

      if (
        connectingHandleType.current &&
        droppedHandleType &&
        !connectionHandleTypesMatch(
          connectingHandleType.current,
          droppedHandleType
        )
      ) {
        toast.info("Connect an output handle to an input handle.", {
          id: "connection-refused",
        });
        connectingNodeId.current = null;
        connectingHandleType.current = null;
        connectingHandleId.current = null;
        return;
      }

      if (
        nodeElement &&
        connectingHandleType.current &&
        (!isHandle || !connectionState.isValid)
      ) {
        handleConnectionToExistingNode(nodeElement);
        connectingNodeId.current = null;
        connectingHandleType.current = null;
        connectingHandleId.current = null;
        return;
      }

      if (!(nodeElement || isHandle)) {
        handleConnectionToNewNode(clientX, clientY);
      }

      connectingNodeId.current = null;
      connectingHandleType.current = null;
      connectingHandleId.current = null;
    },
    [
      getClientPosition,
      handleConnectionToExistingNode,
      handleConnectionToNewNode,
      graphEditingLocked,
    ]
  );

  return {
    isValidConnection,
    onConnect,
    onConnectStart,
    onConnectEnd,
    wasNodeJustCreatedFromConnection,
  };
}

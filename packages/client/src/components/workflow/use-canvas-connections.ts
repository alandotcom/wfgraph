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
import { generateId } from "@wfgraph/shared/utils/id";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  addConnectedNodeAtom,
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
import { showGraphEditRefusal } from "./graph-edit-refusal";

/** The handle a connection drag started from. */
type ConnectGesture = {
  nodeId: string;
  handleType: "source" | "target";
  handleId: string | null;
};

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
  /** Every node of the graph, which the connection rules read because a Group
   * frame stands for its members. */
  graphNodes: WorkflowNode[];
  storeEdges: WorkflowEdge[];
  catalog: ExtensionCatalog;
  /** Whether the canvas refuses every connection gesture: a locked draft, a
   * visible comparison, or a phone, where topology authoring is off. */
  connectionsLocked: boolean;
  insertsNodes: boolean;
  screenToFlowPosition: (position: { x: number; y: number }) => {
    x: number;
    y: number;
  };
}): UseCanvasConnectionsResult {
  const {
    graphNodes,
    storeEdges,
    catalog,
    connectionsLocked,
    insertsNodes,
    screenToFlowPosition,
  } = input;

  const addConnectedNode = useSetAtom(addConnectedNodeAtom);
  const connectNodes = useSetAtom(connectNodesAtom);
  const selectOnlyNode = useSetAtom(selectOnlyNodeAtom);

  // The drag in progress, from its start until its end, which always clears it.
  const connecting = useRef<ConnectGesture | null>(null);
  const justCreatedNodeFromConnection = useRef(false);
  const wasNodeJustCreatedFromConnection = useCallback(
    () => justCreatedNodeFromConnection.current,
    []
  );

  // The refusal previews `planConnection` against the stored graph.
  const connectionOutcome = useCallback(
    (
      painted: XYFlowConnection | XYFlowEdge
    ): { connection: XYFlowConnection | XYFlowEdge } | { refusal: string } => {
      const refusal = connectionRefusalReason({
        connection: painted,
        nodes: graphNodes,
        storeEdges,
        catalog,
      });
      return refusal === null ? { connection: painted } : { refusal };
    },
    [catalog, graphNodes, storeEdges]
  );

  const isValidConnection = useCallback(
    (connection: XYFlowConnection | XYFlowEdge) =>
      !connectionsLocked && !("refusal" in connectionOutcome(connection)),
    [connectionOutcome, connectionsLocked]
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
      if (connectionsLocked || !(connection.source && connection.target)) {
        return;
      }
      const outcome = connectionOutcome(connection);
      if ("refusal" in outcome) {
        showGraphEditRefusal(outcome);
        return;
      }
      // The store plans the connection again against the graph it holds now,
      // which a save or an agent edit may have moved since the preview.
      showGraphEditRefusal(
        connectNodes({
          connection: { ...outcome.connection, id: generateId() },
          catalog,
        })
      );
    },
    [catalog, connectNodes, connectionOutcome, connectionsLocked]
  );

  const onConnectStart: OnConnectStart = useCallback(
    (_event, connectionStart: OnConnectStartParams) => {
      if (connectionsLocked) {
        return;
      }
      connecting.current =
        connectionStart.nodeId && connectionStart.handleType
          ? {
              nodeId: connectionStart.nodeId,
              handleType: connectionStart.handleType,
              handleId: connectionStart.handleId ?? null,
            }
          : null;
    },
    [connectionsLocked]
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
    (gesture: ConnectGesture, nodeElement: Element) => {
      const targetNodeId = nodeElement.getAttribute("data-id");
      const fromSource = gesture.handleType === "source";
      const connectingId = gesture.nodeId;

      if (targetNodeId) {
        const sourceId = fromSource ? connectingId : targetNodeId;
        const targetId = fromSource ? targetNodeId : connectingId;
        const sourceHandle = normalizeSourceHandleForConnection(
          sourceId,
          fromSource ? gesture.handleId : null
        );
        const targetHandle = fromSource ? null : gesture.handleId;
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
    (gesture: ConnectGesture, clientX: number, clientY: number) => {
      if (!insertsNodes) {
        return;
      }
      const sourceNodeId = gesture.nodeId;
      const fromSource = gesture.handleType === "source";
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

      const sourceId = fromSource ? sourceNodeId : newNode.id;
      const targetId = fromSource ? newNode.id : sourceNodeId;
      const sourceHandle = normalizeSourceHandleForConnection(
        sourceId,
        fromSource ? gesture.handleId : null
      );
      const targetHandle = fromSource ? null : gesture.handleId;
      // Adding the node makes it the selection, and the step and its
      // connection are one undo step. The store plans the connection with the
      // new step in the graph, after it joins the Group it was dropped in.
      const added = addConnectedNode({
        node: newNode,
        connection: {
          source: sourceId,
          target: targetId,
          sourceHandle,
          targetHandle,
          id: generateId(),
        },
        catalog,
      });
      showGraphEditRefusal(added);
      if (added === null || "refusal" in added) {
        return;
      }

      // Deselect all other nodes and select only the new node
      // Need to do this after a delay because panOnDrag will clear selection
      setTimeout(() => {
        selectOnlyNode(newNode.id);
      }, 50);

      justCreatedNodeFromConnection.current = true;
      setTimeout(() => {
        justCreatedNodeFromConnection.current = false;
      }, 100);
    },
    [
      screenToFlowPosition,
      addConnectedNode,
      catalog,
      selectOnlyNode,
      normalizeSourceHandleForConnection,
      isValidConnection,
      insertsNodes,
    ]
  );

  const onConnectEnd: OnConnectEnd = useCallback(
    (event, connectionState) => {
      const gesture = connecting.current;
      connecting.current = null;
      if (connectionsLocked || !gesture) {
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
        droppedHandleType &&
        !connectionHandleTypesMatch(gesture.handleType, droppedHandleType)
      ) {
        showGraphEditRefusal({
          refusal: "Connect an output handle to an input handle.",
        });
        return;
      }

      if (nodeElement && (!isHandle || !connectionState.isValid)) {
        handleConnectionToExistingNode(gesture, nodeElement);
        return;
      }

      if (!(nodeElement || isHandle)) {
        handleConnectionToNewNode(gesture, clientX, clientY);
      }
    },
    [
      getClientPosition,
      handleConnectionToExistingNode,
      handleConnectionToNewNode,
      connectionsLocked,
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

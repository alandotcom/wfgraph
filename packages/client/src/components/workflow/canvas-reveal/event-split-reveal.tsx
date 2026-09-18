import { useAtomValue, useStore } from "jotai";
import { useMemo } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import { NodeDetailsFields } from "#src/components/workflow/node-properties-form";
import { NodeControls } from "#src/components/workflow/step-controls";
import { can } from "#src/lib/authorization";
import {
  EVENT_SPLIT_HEADING,
  EVENT_SPLIT_NO_SOURCE_TEXT,
  useEventSplitOutlets,
} from "#src/lib/event-split-outlets";
import { edgesAtom, nodesAtom } from "#src/lib/workflow-graph-store";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import { isGeneratingAtom } from "#src/lib/workflow-ui-store";
import {
  activeWorkspaceAddressAtom,
  openNodeRevealFromOriginAtom,
} from "#src/lib/workflow-workspace-navigation";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { arrivingEventSources } from "@wfgraph/shared/graph/events-reaching";
import {
  eventSplitConnections,
  eventSplitOwner,
  ownersPhrase,
  type EventSplitOutletRow,
  type EventSplitOutletTarget,
  type EventSplitOwner,
} from "./event-split-reveal-summary";
import { useOpenLifecycleSection } from "./lifecycle-reveal-model";
import type { RevealBodyProps } from "./reveal-kinds";
import { NodeIssueList, Section } from "./reveal-sections";

/**
 * An outlet's Event: its label with its raw Event name beneath, and a note when
 * the app no longer declares the Event or a stored edge names an Event that no
 * longer reaches the Event Split from `ownersText`.
 */
function OutletIdentity({
  row,
  ownersText,
}: {
  row: EventSplitOutletRow;
  ownersText: string;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-sm">{row.label ?? row.eventName}</p>
      <p className="font-mono text-muted-foreground text-xs">{row.eventName}</p>
      {row.label === null ? (
        <p className="text-warning text-xs">Not declared by this app</p>
      ) : null}
      {row.label !== null && !row.reachable ? (
        <p className="text-warning text-xs">
          {ownersText === ""
            ? "No longer reaches this Event Split."
            : `No longer reaches this Event Split from ${ownersText}.`}
        </p>
      ) : null}
    </div>
  );
}

function TargetList({
  targets,
}: {
  targets: readonly EventSplitOutletTarget[];
}) {
  return (
    <ul className="space-y-0.5">
      {targets.map((target) => (
        <li className="text-xs" key={target.edgeId}>
          Continues to {target.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * What an outlet connects to, read from the stored edges leaving it. A
 * reachable outlet with no edge says a run arriving on its Event ends there.
 */
function OutletTargets({ row }: { row: EventSplitOutletRow }) {
  if (row.targets.length > 0) {
    return <TargetList targets={row.targets} />;
  }
  return row.reachable ? (
    <p className="text-muted-foreground text-xs">
      Not connected. A run arriving on {row.label ?? row.eventName} ends here.
    </p>
  ) : null;
}

/**
 * The primary action for one owner: the Lifecycle Node at its Start Events or
 * Cancel Events section, or the Wait node's Reveal. Either jump records the
 * Event Split `splitId` as the origin Back returns to.
 */
function OwnerButton({
  owner,
  splitId,
}: {
  owner: EventSplitOwner;
  splitId: string;
}) {
  const store = useStore();
  const openLifecycleSection = useOpenLifecycleSection(owner.source.nodeId);
  const { source } = owner;
  const open = () => {
    const origin = { nodeId: splitId };
    if (source.kind === "lifecycle") {
      openLifecycleSection(
        source.side === "started" ? "start-events" : "cancel-events",
        origin
      );
      return;
    }
    store.set(openNodeRevealFromOriginAtom, {
      address: store.get(activeWorkspaceAddressAtom),
      nodeId: source.nodeId,
      origin,
    });
  };
  return (
    <Button onClick={open} size="sm" type="button" variant="outline">
      {owner.actionLabel}
    </Button>
  );
}

/**
 * What the Event Split `nodeId` splits on: which Event sources its outlets
 * come from, the action that opens each source, every outlet with its Event
 * identity and destination, and any connection that leaves by no outlet.
 */
function OutletsSection({ nodeId }: { nodeId: string }) {
  const catalog = useExtensionCatalog();
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const outlets = useEventSplitOutlets(nodeId);
  const owners = useMemo(
    () =>
      arrivingEventSources({ targetNodeId: nodeId, nodes, edges, catalog }).map(
        (source) => eventSplitOwner({ source, nodes, catalog })
      ),
    [nodeId, nodes, edges, catalog]
  );
  const { rows, withoutOutlet } = useMemo(
    () =>
      eventSplitConnections({
        nodeId,
        reachableEventNames: outlets.map((event) => event.name),
        nodes,
        edges,
        catalog,
      }),
    [nodeId, outlets, nodes, edges, catalog]
  );
  const ownersText = ownersPhrase(owners);

  return (
    <Section title={EVENT_SPLIT_HEADING}>
      {owners.length > 0 ? (
        <>
          <p className="text-muted-foreground text-xs">
            Its outlets are the Events that reach it from {ownersText}, one
            outlet for each Event.
          </p>
          {owners.map((owner) => (
            <OwnerButton
              key={`${owner.source.nodeId}:${owner.actionLabel}`}
              owner={owner}
              splitId={nodeId}
            />
          ))}
        </>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {owners.length > 0
            ? `No Event reaches it yet. Each Event added to ${ownersText} adds an outlet.`
            : EVENT_SPLIT_NO_SOURCE_TEXT}
        </p>
      ) : null}
      {rows.length > 0 && owners.length === 0 ? (
        <p className="text-warning text-xs">{EVENT_SPLIT_NO_SOURCE_TEXT}</p>
      ) : null}
      {rows.length > 0 || withoutOutlet.length > 0 ? (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li className="space-y-1" key={row.eventName}>
              <OutletIdentity ownersText={ownersText} row={row} />
              <OutletTargets row={row} />
            </li>
          ))}
          {withoutOutlet.length > 0 ? (
            <li className="space-y-1">
              <p className="text-warning text-sm">
                A connection leaves by no outlet
              </p>
              <TargetList targets={withoutOutlet} />
            </li>
          ) : null}
        </ul>
      ) : null}
    </Section>
  );
}

/**
 * Browse for an Event Split: its label and description, where its outlets come
 * from with the action that opens that source, every outlet with its Event
 * identity and destination, its issues, and its node controls. Browse is its
 * only level, because its outlets follow the graph above it.
 */
export function EventSplitBrowse({ subject, frame }: RevealBodyProps) {
  const { nodeId } = subject;
  const nodes = useAtomValue(nodesAtom);
  const issues = useAtomValue(workflowIssuesAtom);
  const isGenerating = useAtomValue(isGeneratingAtom);
  const canUpdate = can(WfGraphOperations.workflowUpdate.id);
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) {
    return null;
  }

  return (
    <div className="pb-4">
      <Section title="Details">
        <NodeDetailsFields disabled={isGenerating || !canUpdate} node={node} />
      </Section>

      <OutletsSection nodeId={node.id} />

      <Section title="Validation">
        <NodeIssueList
          issues={issues.filter((issue) => issue.nodeId === node.id)}
        />
      </Section>

      <NodeControls className="border-t px-4 pt-3" frame={frame} node={node} />
    </div>
  );
}

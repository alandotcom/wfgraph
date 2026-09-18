/**
 * Changes Focus: the selected changed object's properties as the published
 * version and the draft each hold them, side by side. It reads only the
 * comparison the route names, and every piece of view state below it is keyed
 * by that comparison and object, so another comparison starts it over.
 */

import { compact, uniqBy } from "es-toolkit/array";
import { useAtomValue } from "jotai";
import { useMemo, useRef } from "react";
import { useBeforePaint } from "#src/hooks/effects";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { ComparisonMarker } from "#src/components/flow-elements/comparison-marker";
import {
  comparisonFields,
  comparisonMetadataNotice,
  comparisonSides,
  comparisonValuesAvailable,
  ComparisonFieldTable,
  useCachedConnections,
  type ComparisonField,
} from "#src/components/workflow/comparison-properties";
import { useWorkflowComparisonActions } from "#src/components/workflow/use-workflow-comparison-actions";
import { PanelState } from "#src/components/workflow/workflow-changes-panel-state";
import { comparisonDisplayGraphAtom } from "#src/lib/workflow-comparison-store";
import { COMPARISON_CHANGE_KIND_LABEL } from "#src/lib/workflow-graph-types";
import {
  selectedObject,
  workspaceAddressId,
} from "#src/lib/workflow-navigation-state";
import {
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
} from "#src/lib/workflow-workspace-navigation";
import type {
  WorkflowComparisonPayload,
  WorkflowNodeChange,
} from "@wfgraph/shared/graph/publication-contracts";
import { cn } from "@wfgraph/shared/utils";
import { ComparisonState } from "./changes-browse";
import { ChangeNavigation, useChangedObjects } from "./changes-navigation";
import {
  COMPARISON_DRAFT_LABEL,
  comparisonBaseLabel,
  comparisonIdentity,
  comparisonRevealContextAtom,
  describeInspection,
  describeValidationDifference,
  inspectChange,
  issueIdentity,
  nodeValidationSides,
  type ChangedObject,
  type ChangeInspection,
} from "./changes-summary";
import type { RevealBodyProps } from "./reveal-kinds";
import { Section } from "./reveal-sections";
import { useInspectorScroll } from "./use-inspector-scroll";

/**
 * The Focus body of Changes. While the comparison the route names is not
 * installed it shows that comparison's loading, failure, or offer to open it.
 */
export function ChangesFocus(_props: RevealBodyProps) {
  const actions = useWorkflowComparisonActions();
  const comparison = useAtomValue(comparisonRevealContextAtom);
  const address = useAtomValue(activeWorkspaceAddressAtom);
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="workflow-change-focus"
    >
      {"payload" in comparison ? (
        <ChangeFocusContent payload={comparison.payload} />
      ) : (
        <ComparisonState
          actions={actions}
          address={address}
          status={comparison.status}
        />
      )}
    </div>
  );
}

/**
 * The inspected object and Previous and Next. The scrolling content is keyed
 * by the comparison and the object, so a long value expanded for one object
 * starts shortened for the next. Its scroll is kept per address, so another
 * object starts at the top and returning to the address restores its scroll.
 */
function ChangeFocusContent({
  payload,
}: {
  payload: WorkflowComparisonPayload;
}) {
  const catalog = useExtensionCatalog();
  const graph = useAtomValue(comparisonDisplayGraphAtom);
  const selection = useAtomValue(activeSelectionAtom);
  const address = useAtomValue(activeWorkspaceAddressAtom);
  const {
    ref: scrollRef,
    onScroll,
    onScrollEnd,
    adoptScroll,
  } = useInspectorScroll({
    address,
    addressId: workspaceAddressId(address),
    inspectedId: null,
    level: "focus",
  });
  const { objects, selectedIndex, select } = useChangedObjects(payload);
  const object = selectedObject(selection);
  const objectKind = object?.kind;
  const objectId = object?.id;
  const inspection: ChangeInspection = useMemo(
    () =>
      graph && objectKind !== undefined && objectId !== undefined
        ? inspectChange({
            payload,
            graph,
            catalog,
            objects,
            object: { kind: objectKind, id: objectId },
          })
        : { kind: "unavailable" },
    [catalog, graph, objectId, objectKind, objects, payload]
  );
  const contentKey = `${comparisonIdentity(payload)}|${object?.kind ?? ""}:${object?.id ?? ""}`;
  // The scroll is stored per address, and every object of a comparison shares
  // that address. Another object mounts a new scroller at the top, and that
  // top replaces the stored position. The object Focus mounts with keeps the
  // restored scroll.
  const shownContentKeyRef = useRef(contentKey);
  useBeforePaint(contentKey, () => {
    if (contentKey !== shownContentKeyRef.current) {
      shownContentKeyRef.current = contentKey;
      adoptScroll();
    }
  });
  return (
    <>
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        data-slot="change-focus-content"
        key={contentKey}
        onScroll={onScroll}
        onScrollEnd={onScrollEnd}
        ref={scrollRef}
      >
        {inspection.kind === "unavailable" ? (
          <PanelState label="This object is not part of the comparison. Choose a changed step or connection." />
        ) : (
          <InspectionView
            inspection={inspection}
            onSelect={select}
            payload={payload}
          />
        )}
      </div>
      <ChangeNavigation
        objects={objects}
        onSelect={select}
        selectedIndex={selectedIndex}
      />
    </>
  );
}

function InspectionView({
  inspection,
  payload,
  onSelect,
}: {
  inspection: Exclude<ChangeInspection, { kind: "unavailable" }>;
  payload: WorkflowComparisonPayload;
  onSelect: (item: ChangedObject) => void;
}) {
  return (
    <>
      <section
        aria-label="Inspected change"
        className="space-y-1 border-b px-4 py-3"
      >
        <div className="flex items-center gap-2">
          {inspection.change === "unchanged" ? null : (
            <ComparisonMarker
              className="static shrink-0"
              comparison={{ kind: inspection.change }}
            />
          )}
          <h3 className="min-w-0 flex-1 truncate font-medium text-sm">
            {inspection.title}
          </h3>
          <span className="shrink-0 text-muted-foreground text-xs">
            {inspection.change === "unchanged"
              ? "Unchanged"
              : COMPARISON_CHANGE_KIND_LABEL[inspection.change]}
          </span>
        </div>
        <p className="text-muted-foreground text-xs">
          {describeInspection(inspection, payload)}
        </p>
      </section>
      {inspection.kind === "edge" ? (
        <ConnectionProperties inspection={inspection} payload={payload} />
      ) : (
        <>
          {inspection.nodeChange ? (
            <>
              <StepProperties
                change={inspection.nodeChange}
                payload={payload}
              />
              <StepValidation
                change={inspection.nodeChange}
                payload={payload}
              />
            </>
          ) : null}
          {inspection.connections.length > 0 ? (
            <ChangedConnections
              connections={inspection.connections}
              onSelect={onSelect}
            />
          ) : null}
        </>
      )}
    </>
  );
}

/**
 * A changed step's settings. The published column shows for a removed or
 * modified step and the draft column for an added or modified one. A side the
 * comparison lacks, or a modification that records no setting, says so.
 */
function StepProperties({
  change,
  payload,
}: {
  change: WorkflowNodeChange;
  payload: WorkflowComparisonPayload;
}) {
  const catalog = useExtensionCatalog();
  const connections = useCachedConnections();
  if (!comparisonValuesAvailable(payload, change)) {
    return (
      <Section title="Settings">
        <p className="text-muted-foreground text-xs" data-state="unavailable">
          {change.kind === "added"
            ? "The draft's values for this step are not available in this comparison."
            : "The published values for this step are not available in this comparison."}
        </p>
      </Section>
    );
  }
  const fields: ComparisonField[] = comparisonFields(catalog, payload, change, {
    connections,
  });
  const notice = comparisonMetadataNotice({ catalog, payload, change, fields });
  return (
    <Section title="Settings">
      {notice ? (
        <p
          className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs"
          data-state="missing-metadata"
        >
          {notice}
        </p>
      ) : null}
      {fields.length === 0 ? (
        <p className="text-muted-foreground text-xs" data-state="no-fields">
          The comparison records no setting that differs for this step.
        </p>
      ) : (
        <ComparisonFieldTable
          afterLabel={COMPARISON_DRAFT_LABEL}
          beforeLabel={comparisonBaseLabel(payload)}
          caption="Settings of this step"
          fields={fields}
          sides={comparisonSides(change.kind)}
        />
      )}
    </Section>
  );
}

/**
 * How the step's validation differs between the published version and the
 * draft, each side checked by the editor's issue checks against the extensions
 * available now. Missing connection issues are left out, since a published
 * version's connections are not part of the comparison.
 */
function StepValidation({
  change,
  payload,
}: {
  change: WorkflowNodeChange;
  payload: WorkflowComparisonPayload;
}) {
  const catalog = useExtensionCatalog();
  const sides = nodeValidationSides({
    payload,
    nodeId: change.nodeId,
    catalog,
  });
  const lists = compact(
    (
      [
        { label: comparisonBaseLabel(payload), side: sides.before },
        { label: COMPARISON_DRAFT_LABEL, side: sides.after },
      ] as const
    ).map(({ label, side }) =>
      side.kind === "checked" && side.issues.length > 0
        ? { label, issues: uniqBy(side.issues, issueIdentity) }
        : undefined
    )
  );
  return (
    <Section title="Validation">
      <p className="text-muted-foreground text-xs">
        This section shows the editor's issue checks, run on each version
        against the actions available now.
      </p>
      <p className="text-xs" data-state="validation">
        {describeValidationDifference(sides)}
      </p>
      {lists.length > 0 ? (
        <div
          className={cn(
            "grid gap-3 text-xs",
            lists.length === 2 && "grid-cols-2"
          )}
        >
          {lists.map((list) => (
            <div key={list.label}>
              <p className="font-medium text-muted-foreground">{list.label}</p>
              <ul className="mt-1 list-disc space-y-1 pl-4">
                {list.issues.map((issue) => (
                  <li key={issueIdentity(issue)}>{issue.message}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </Section>
  );
}

/** Where a connection runs, in the columns of the sides that hold it. */
function ConnectionProperties({
  inspection,
  payload,
}: {
  inspection: Extract<ChangeInspection, { kind: "edge" }>;
  payload: WorkflowComparisonPayload;
}) {
  const side = inspection.change === "added" ? "after" : "before";
  const value = (text: string | null) =>
    inspection.change === "unchanged"
      ? { before: text ?? undefined, after: text ?? undefined }
      : { [side]: text ?? undefined };
  const fields: ComparisonField[] = compact([
    { key: "connection:from", label: "From", ...value(inspection.source) },
    { key: "connection:to", label: "To", ...value(inspection.target) },
    inspection.branch === null
      ? undefined
      : {
          key: "connection:branch",
          label: "Branch",
          ...value(inspection.branch),
        },
  ]);
  return (
    <Section title="Connection">
      <ComparisonFieldTable
        afterLabel={COMPARISON_DRAFT_LABEL}
        beforeLabel={comparisonBaseLabel(payload)}
        caption="This connection"
        fields={fields}
        sides={comparisonSides(inspection.change)}
      />
    </Section>
  );
}

/** The changed connections that touch the step, each selecting its connection. */
function ChangedConnections({
  connections,
  onSelect,
}: {
  connections: readonly ChangedObject[];
  onSelect: (item: ChangedObject) => void;
}) {
  return (
    <Section title="Changed connections">
      <ul className="-mx-2">
        {connections.map((item) => (
          <li key={item.key}>
            <button
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
              onClick={() => onSelect(item)}
              type="button"
            >
              <ComparisonMarker
                className="static shrink-0"
                comparison={{ kind: item.change }}
              />
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              <span className="shrink-0 text-muted-foreground">
                {COMPARISON_CHANGE_KIND_LABEL[item.change]}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

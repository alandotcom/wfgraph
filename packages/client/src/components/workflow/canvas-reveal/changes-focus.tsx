/**
 * Changes Focus: the selected changed object's properties as the published
 * version and the draft each hold them, side by side, or stacked in the phone's
 * field differences sheet. It reads only the comparison the route names, and
 * every piece of view state below it is keyed by that comparison and object.
 */

import { compact, partition, uniqBy } from "es-toolkit/array";
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
  type ComparisonLayout,
} from "#src/components/workflow/comparison-properties";
import { useWorkflowComparisonActions } from "#src/components/workflow/use-workflow-comparison-actions";
import { StatusPlaceholder } from "#src/components/workflow/status-placeholder";
import { comparisonDisplayGraphAtom } from "#src/lib/workflow-comparison-store";
import { COMPARISON_CHANGE_KIND_LABEL } from "#src/lib/workflow-graph-types";
import { workspaceAddressId } from "#src/lib/workflow-navigation-state";
import { selectedObject } from "#src/lib/canvas-selection";
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
import {
  ChangeNavigation,
  useChangedObjects,
  useOpenMobileChange,
  useSelectChange,
  type ChooseChange,
} from "./changes-navigation";
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
import { EnterGroupButton, Section } from "./reveal-sections";
import { useInspectorScroll } from "./use-inspector-scroll";

/**
 * The Focus body of Changes. While the comparison the route names is not
 * installed it shows that comparison's loading, failure, or offer to open it.
 */
export function ChangesFocus(_props: RevealBodyProps) {
  const actions = useWorkflowComparisonActions();
  const selectChange = useSelectChange();
  const comparison = useAtomValue(comparisonRevealContextAtom);
  const address = useAtomValue(activeWorkspaceAddressAtom);
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="workflow-change-focus"
    >
      {"payload" in comparison ? (
        <ChangeFocusContent
          layout="columns"
          onSelect={selectChange}
          payload={comparison.payload}
        />
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
 * The field differences sheet of the phone's Changes sequence: the selected
 * object's settings with each version's value stacked under the setting, and
 * Previous and Next pinned to the bottom of the sheet. Choosing another
 * changed object shows it in this sheet.
 */
export function ChangeFieldDifferences() {
  const actions = useWorkflowComparisonActions();
  const openChange = useOpenMobileChange();
  const comparison = useAtomValue(comparisonRevealContextAtom);
  const address = useAtomValue(activeWorkspaceAddressAtom);
  return (
    <div data-testid="workflow-change-focus">
      {"payload" in comparison ? (
        <ChangeFocusContent
          layout="stacked"
          onSelect={openChange}
          payload={comparison.payload}
        />
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
 * The inspected object and Previous and Next, which choose an object through
 * `onSelect`. The content is keyed by the comparison and the object, so a long
 * value expanded for one object starts shortened for the next. In `columns`
 * the content scrolls inside Focus, and its scroll is kept per address: another
 * object starts at the top, and returning to the address restores its scroll.
 * In `stacked` the sheet around it scrolls and Previous and Next stay at its
 * bottom.
 */
function ChangeFocusContent({
  payload,
  layout,
  onSelect,
}: {
  payload: WorkflowComparisonPayload;
  layout: ComparisonLayout;
  onSelect: ChooseChange;
}) {
  const catalog = useExtensionCatalog();
  const graph = useAtomValue(comparisonDisplayGraphAtom);
  const selection = useAtomValue(activeSelectionAtom);
  const { objects, selectedIndex } = useChangedObjects(payload);
  const stacked = layout === "stacked";
  const address = useAtomValue(activeWorkspaceAddressAtom);
  // In `stacked` the phone's sheet owns the scroll, so only `columns` keeps
  // this scroller's position.
  const {
    ref: scrollRef,
    onScroll,
    onScrollEnd,
    adoptScroll,
  } = useInspectorScroll(
    stacked
      ? null
      : {
          address,
          addressId: workspaceAddressId(address),
          inspectedId: null,
          level: "focus",
        }
  );
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
  const navigation = (
    <ChangeNavigation
      objects={objects}
      onSelect={onSelect}
      selectedIndex={selectedIndex}
    />
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
        className={
          stacked
            ? undefined
            : "min-h-0 flex-1 overflow-y-auto overscroll-contain"
        }
        data-slot="change-focus-content"
        key={contentKey}
        onScroll={onScroll}
        onScrollEnd={onScrollEnd}
        ref={scrollRef}
      >
        {inspection.kind === "unavailable" ? (
          <StatusPlaceholder label="This object is not part of the comparison. Choose a changed step or connection." />
        ) : (
          <InspectionView
            inspection={inspection}
            layout={layout}
            onSelect={onSelect}
            payload={payload}
          />
        )}
      </div>
      {stacked ? (
        <div className="sticky bottom-0 bg-card">{navigation}</div>
      ) : (
        navigation
      )}
    </>
  );
}

function InspectionView({
  inspection,
  payload,
  layout,
  onSelect,
}: {
  inspection: Exclude<ChangeInspection, { kind: "unavailable" }>;
  payload: WorkflowComparisonPayload;
  layout: ComparisonLayout;
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
        <ConnectionProperties
          inspection={inspection}
          layout={layout}
          payload={payload}
        />
      ) : (
        <>
          {inspection.nodeChange ? (
            <>
              <StepProperties
                change={inspection.nodeChange}
                groupFrame={inspection.groupFrame}
                layout={layout}
                payload={payload}
              />
              <StepValidation
                change={inspection.nodeChange}
                layout={layout}
                payload={payload}
              />
            </>
          ) : null}
          {inspection.changedMembers.length > 0 ? (
            <ChangedObjectList
              items={inspection.changedMembers}
              onSelect={onSelect}
              title="Changed steps in this Group"
            />
          ) : null}
          {inspection.connections.length > 0 ? (
            <ChangedObjectList
              items={inspection.connections}
              onSelect={onSelect}
              title="Changed connections"
            />
          ) : null}
          {inspection.groupFrame ? (
            <EnterGroupButton groupId={inspection.nodeId} />
          ) : null}
        </>
      )}
    </>
  );
}

/**
 * A changed step's or Group's settings. The published column shows for a
 * removed or modified object and the draft column for an added or modified
 * one. A modified step lists its Group membership in a section of its own. A
 * side the comparison lacks, or a modification that records no setting, says
 * so.
 */
function StepProperties({
  change,
  groupFrame,
  layout,
  payload,
}: {
  change: WorkflowNodeChange;
  groupFrame: boolean;
  layout: ComparisonLayout;
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
  const [membershipFields, settingFields] = partition(
    fields,
    (field) => !groupFrame && field.category === "organization"
  );
  const noun = groupFrame ? "Group" : "step";
  return (
    <>
      {settingFields.length > 0 || membershipFields.length === 0 ? (
        <Section title={groupFrame ? "Group settings" : "Settings"}>
          {notice ? (
            <p
              className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs"
              data-state="missing-metadata"
            >
              {notice}
            </p>
          ) : null}
          {settingFields.length === 0 ? (
            <p className="text-muted-foreground text-xs" data-state="no-fields">
              The comparison records no setting that differs for this {noun}.
            </p>
          ) : (
            <ComparisonFieldTable
              afterLabel={COMPARISON_DRAFT_LABEL}
              beforeLabel={comparisonBaseLabel(payload)}
              caption={`Settings of this ${noun}`}
              fields={settingFields}
              layout={layout}
              sides={comparisonSides(change.kind)}
            />
          )}
        </Section>
      ) : null}
      {membershipFields.length > 0 ? (
        <Section title="Group membership">
          <ComparisonFieldTable
            afterLabel={COMPARISON_DRAFT_LABEL}
            beforeLabel={comparisonBaseLabel(payload)}
            caption="Group membership of this step"
            fields={membershipFields}
            layout={layout}
            sides={comparisonSides(change.kind)}
          />
        </Section>
      ) : null}
    </>
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
  layout,
  payload,
}: {
  change: WorkflowNodeChange;
  layout: ComparisonLayout;
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
            lists.length === 2 && layout === "columns" && "grid-cols-2"
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
  layout,
  payload,
}: {
  inspection: Extract<ChangeInspection, { kind: "edge" }>;
  layout: ComparisonLayout;
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
        layout={layout}
        sides={comparisonSides(inspection.change)}
      />
    </Section>
  );
}

/**
 * Changed objects that belong to the inspected one: the connections that touch
 * a step, or the steps inside a Group. Each row selects its object, entering
 * the Group that shows it.
 */
function ChangedObjectList({
  items,
  onSelect,
  title,
}: {
  items: readonly ChangedObject[];
  onSelect: (item: ChangedObject) => void;
  title: string;
}) {
  return (
    <Section title={title}>
      <ul className="-mx-2">
        {items.map((item) => (
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
                {item.detail}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

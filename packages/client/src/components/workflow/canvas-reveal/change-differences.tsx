/**
 * The field differences of one changed step or Group, as an open change list
 * row shows them: a sentence on which versions hold it, its settings in a
 * table with a column per version (or stacked on a phone), its Group
 * membership, how validation differs, and the changed steps or connections
 * that belong to it. It reads only the comparison it is given.
 */

import { compact, partition, uniqBy } from "es-toolkit/array";
import { useAtomValue } from "jotai";
import { ArrowRight } from "lucide-react";
import { useMemo } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import { useGroupScopeNavigation } from "#src/components/workflow/use-group-scope-navigation";
import { ComparisonMarker } from "#src/components/flow-elements/comparison-marker";
import {
  comparisonFields,
  comparisonMetadataNotice,
  comparisonSideNodes,
  comparisonSides,
  comparisonValuesAvailable,
  ComparisonFieldTable,
  useCachedConnections,
  type ComparisonField,
  type ComparisonLayout,
} from "#src/components/workflow/comparison-properties";
import { comparisonDisplayGraphAtom } from "#src/lib/workflow-comparison-store";
import type { InspectedObject } from "#src/lib/workflow-navigation-state";
import type {
  WorkflowComparisonPayload,
  WorkflowNodeChange,
} from "@wfgraph/shared/graph/publication-contracts";
import { cn } from "@wfgraph/shared/utils";
import type { ChooseChange } from "./changes-navigation";
import {
  COMPARISON_DRAFT_LABEL,
  comparisonBaseLabel,
  describeInspection,
  describeValidationDifference,
  hasValidationToShow,
  inspectChange,
  issueIdentity,
  nodeValidationSides,
  type ChangedObject,
} from "./changes-summary";
import { Section } from "./reveal-sections";

/**
 * The differences of the changed node `object` in `payload`. `objects` is the
 * whole change list, which the node's changed connections and a Group's
 * changed steps are read from, and `onSelect` chooses one of those.
 */
export function ChangeDifferences({
  payload,
  object,
  objects,
  layout,
  onSelect,
}: {
  payload: WorkflowComparisonPayload;
  object: InspectedObject;
  objects: readonly ChangedObject[];
  layout: ComparisonLayout;
  onSelect: ChooseChange;
}) {
  const catalog = useExtensionCatalog();
  const graph = useAtomValue(comparisonDisplayGraphAtom);
  const inspection = useMemo(
    () =>
      graph
        ? inspectChange({ payload, graph, catalog, objects, nodeId: object.id })
        : ({ kind: "unavailable" } as const),
    [catalog, graph, object, objects, payload]
  );
  if (inspection.kind !== "node") {
    return (
      <p className="px-4 py-3 text-muted-foreground text-xs">
        This change is not on the comparison canvas.
      </p>
    );
  }
  return (
    <>
      <p className="px-4 pt-3 text-muted-foreground text-xs">
        {describeInspection(inspection, payload)}
      </p>
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
        <RowEnterGroupButton groupId={inspection.nodeId} />
      ) : null}
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
              nodes={comparisonSideNodes(payload)}
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
            nodes={comparisonSideNodes(payload)}
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
 * version's connections are not part of the comparison. A step with no issue
 * in either version shows no section.
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
  if (!hasValidationToShow(sides)) {
    return null;
  }
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

/**
 * Changed objects that belong to the shown one: the connections that touch a
 * step, or the steps inside a Group. Each row selects its object, entering the
 * Group that shows it, and the change list opens that object's row.
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
              <span className="min-w-0 max-w-1/2 shrink-0 truncate text-muted-foreground">
                {item.summary}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * Enter group, at the end of an open Group's row. It is an outline button,
 * because the filled button is kept for the view's primary action.
 */
function RowEnterGroupButton({ groupId }: { groupId: string }) {
  const { enterGroup } = useGroupScopeNavigation();
  return (
    <div className="flex justify-end px-4 pt-1 pb-3">
      <Button
        onClick={() => enterGroup(groupId)}
        type="button"
        variant="outline"
      >
        Enter group
        <ArrowRight data-icon="inline-end" />
      </Button>
    </div>
  );
}

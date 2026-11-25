/**
 * The body of the review sheet: the edits of one comparison in the order the
 * workflow runs, each with its marker, its step's name, what changed, where it
 * sits on the path, and the difference itself, then the changes that do not
 * change what runs. A step's name stays on screen while its difference
 * scrolls. Pointing at or focusing an edit points at its card on the canvas.
 */

import { useSetAtom, useStore } from "jotai";
import { ChevronRight, LocateFixed } from "lucide-react";
import { type FocusEvent, useState } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { ComparisonMarker } from "#src/components/flow-elements/comparison-marker";
import { Button } from "#src/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#src/components/ui/collapsible";
import {
  type ComparisonField,
  comparisonFields,
  comparisonMetadataNotice,
  comparisonSideNodes,
  comparisonValuesAvailable,
  FieldDifference,
  SettingsList,
  useCachedConnections,
} from "#src/components/workflow/comparison-properties";
import {
  type EditStrip,
  type OrganizationChange,
  type StripStep,
  type WorkflowEdit,
  workflowEdits,
} from "#src/lib/workflow-edits";
import { COMPARISON_CHANGE_KIND_LABEL } from "#src/lib/workflow-graph-types";
import { reviewHighlightAtom } from "#src/lib/workflow-review-store";
import { findAction } from "@wfgraph/shared/extensions/catalog";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import { summarizeWorkflow } from "@wfgraph/shared/graph/workflow-summary";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import { cn } from "@wfgraph/shared/utils";

/** The id of the element holding the edit of the step `nodeId`. */
export function reviewEditElementId(nodeId: string): string {
  return `review-edit-${nodeId}`;
}

export function ReviewDocument({
  payload,
  onShowOnCanvas,
}: {
  payload: WorkflowComparisonPayload;
  onShowOnCanvas: (nodeId: string) => void;
}) {
  const catalog = useExtensionCatalog();
  const { edits, organization } = workflowEdits(payload, catalog);
  return (
    <div className="pb-4" data-slot="review-document">
      {/* The header's count line already says when no edit changes what
          runs, so an empty list draws nothing here. */}
      {edits.length > 0 ? (
        <ol aria-label="Edits" className="divide-y">
          {edits.map((edit) => (
            <EditEntry
              edit={edit}
              key={edit.key}
              onShowOnCanvas={onShowOnCanvas}
              payload={payload}
            />
          ))}
        </ol>
      ) : null}
      {organization.length > 0 ? (
        // With no edit above them, these changes are all there is to read,
        // so they start open.
        <OrganizationChanges
          defaultOpen={edits.length === 0}
          items={organization}
        />
      ) : null}
    </div>
  );
}

function EditEntry({
  edit,
  payload,
  onShowOnCanvas,
}: {
  edit: WorkflowEdit;
  payload: WorkflowComparisonPayload;
  onShowOnCanvas: (nodeId: string) => void;
}) {
  const store = useStore();
  const setHighlight = useSetAtom(reviewHighlightAtom);
  const point = () => setHighlight(edit.nodeId);
  const stopPointing = () => {
    if (store.get(reviewHighlightAtom) === edit.nodeId) setHighlight(null);
  };
  const leaveFocus = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) stopPointing();
  };
  return (
    <li
      className="scroll-mt-0"
      data-edit-node={edit.nodeId}
      id={reviewEditElementId(edit.nodeId)}
      onBlur={leaveFocus}
      onFocus={point}
      onPointerEnter={point}
      onPointerLeave={stopPointing}
    >
      {/* The step's name stays at the top of the sheet while its difference
          scrolls under it. */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-card px-4 py-2">
        <ComparisonMarker
          className="static shrink-0"
          comparison={{ kind: edit.kind }}
        />
        {/* Takes focus when the step's card is pressed on the canvas. */}
        <h3
          className="min-w-0 truncate font-semibold text-sm outline-none"
          data-slot="review-edit-title"
          tabIndex={-1}
        >
          <span className="sr-only">
            {COMPARISON_CHANGE_KIND_LABEL[edit.kind]}:{" "}
          </span>
          {edit.title}
        </h3>
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">
          {edit.summary}
        </span>
        <Button
          className="shrink-0"
          onClick={() => onShowOnCanvas(edit.nodeId)}
          size="sm"
          type="button"
          variant="ghost"
        >
          <LocateFixed data-icon="inline-start" />
          Show on canvas
        </Button>
      </div>
      <div className="space-y-2 px-4 pt-2 pb-3 text-sm">
        <StripLine
          removed={edit.kind === "removed"}
          strip={edit.strip}
          title={edit.title}
        />
        <EditDifference edit={edit} payload={payload} />
      </div>
    </li>
  );
}

function StripStepName({ step }: { step: StripStep }) {
  return <span className="text-foreground">{step.label}</span>;
}

/**
 * Where the edit sits, in words: "In Pre-visit reminders: Wait until 24 hours
 * before → Send 24-hour reminder → Wait until 2 hours before". A branch name
 * follows the step it leaves, and "path ends" stands for no next step. A
 * removed step's own name is struck through.
 */
function StripLine({
  strip,
  title,
  removed,
}: {
  strip: EditStrip;
  title: string;
  removed: boolean;
}) {
  const before = strip.before.map((step, index) => (
    <span key={`${step.nodeId}:${step.branch ?? ""}`}>
      {index > 0 ? ", " : null}
      <StripStepName step={step} />
      {step.branch ? ` ${step.branch}` : null}
    </span>
  ));
  const after = strip.after.map((step, index) => (
    <span key={`${step.nodeId}:${step.branch ?? ""}`}>
      {index > 0 ? ", " : null}
      {step.branch ? `${step.branch}: ` : null}
      <StripStepName step={step} />
    </span>
  ));
  return (
    <p className="text-muted-foreground" data-slot="review-strip">
      {strip.group ? (
        <>
          In <span className="text-foreground">{strip.group}</span>:{" "}
        </>
      ) : null}
      {before.length > 0 ? <>{before} → </> : null}
      {removed ? (
        <del className="font-medium text-foreground decoration-destructive">
          {title}
        </del>
      ) : (
        <span className="font-medium text-foreground">{title}</span>
      )}
      {" → "}
      {after.length > 0 ? after : "path ends"}
    </p>
  );
}

/** The difference an edit shows inline, by the kind of change it is. */
function EditDifference({
  edit,
  payload,
}: {
  edit: WorkflowEdit;
  payload: WorkflowComparisonPayload;
}) {
  const catalog = useExtensionCatalog();
  const connections = useCachedConnections();
  const change = edit.nodeChange;
  if (change === null || change.kind === "removed") {
    return null;
  }
  if (!comparisonValuesAvailable(payload, change)) {
    return (
      <p className="text-muted-foreground">
        This step's values are not available.
      </p>
    );
  }
  const fields = comparisonFields(catalog, payload, change, { connections });
  const notice = comparisonMetadataNotice({ catalog, payload, change, fields });
  const nodes = comparisonSideNodes(payload);
  const isLifecycle =
    nodes.after.find((node) => node.id === change.nodeId)?.data.type ===
    "lifecycle";
  // A Lifecycle Node reads as what starts and stops a run. A new one says only
  // that, and a changed one says it before the settings that changed.
  if (isLifecycle && change.kind === "added") {
    return <LifecycleDifference kind="added" payload={payload} />;
  }
  if (change.kind === "added") {
    return (
      <>
        <AddedStep fields={fields} nodes={nodes.after} />
        {notice ? <p className="text-muted-foreground">{notice}</p> : null}
      </>
    );
  }
  const changed = fields.filter((field) => field.category !== "organization");
  return (
    <>
      {isLifecycle ? (
        <LifecycleDifference kind="modified" payload={payload} />
      ) : null}
      {changed.map((field) => (
        <section aria-label={field.label} className="space-y-1" key={field.key}>
          <h4 className="font-medium text-muted-foreground text-xs">
            {field.label}
          </h4>
          <FieldDifference field={field} nodes={nodes} />
        </section>
      ))}
      {notice ? <p className="text-muted-foreground">{notice}</p> : null}
    </>
  );
}

/**
 * What starts and stops a run, as the outline writes it for the Lifecycle
 * Node, in place of the Lifecycle Node's raw settings: the sentences the
 * workflow will have, and for a change the sentences it had, where they
 * differ.
 */
function LifecycleDifference({
  kind,
  payload,
}: {
  kind: "added" | "modified";
  payload: WorkflowComparisonPayload;
}) {
  const catalog = useExtensionCatalog();
  const now = summarizeWorkflow({
    ...toWorkflowGraphData(payload.draftGraph),
    catalog,
  });
  const before =
    kind === "modified"
      ? summarizeWorkflow({
          ...toWorkflowGraphData(payload.baseGraph),
          catalog,
        })
      : null;
  const sections = [
    { title: "Starts when", now: now.starts, before: before?.starts },
    { title: "Stops when", now: now.stops, before: before?.stops },
  ];
  return (
    <>
      {sections.map((section) => {
        const changed =
          section.before !== undefined &&
          section.before.join("\n") !== section.now.join("\n");
        if (section.now.length === 0 && !changed) return null;
        return (
          <section
            aria-label={section.title}
            className="space-y-1"
            key={section.title}
          >
            <h4 className="font-medium text-muted-foreground text-xs">
              {section.title}
            </h4>
            {changed ? (
              <ul className="space-y-0.5 text-muted-foreground line-through">
                {(section.before ?? []).map((sentence) => (
                  <li key={sentence}>{sentence}</li>
                ))}
              </ul>
            ) : null}
            <ul className="space-y-0.5">
              {section.now.length === 0 ? (
                <li className="text-muted-foreground">Nothing stops a run.</li>
              ) : (
                section.now.map((sentence) => (
                  <li key={sentence}>{sentence}</li>
                ))
              )}
            </ul>
          </section>
        );
      })}
    </>
  );
}

/** Snapshot rows that name the step rather than say what it does. */
const IDENTITY_KEYS = new Set([
  "snapshot:type",
  "snapshot:label",
  "snapshot:group",
  "snapshot:enabled",
  "snapshot:action",
]);

/**
 * A new step as what it does and its main content: the longest text it holds,
 * which for a message is its body. Every setting is one press away.
 */
function AddedStep({
  fields,
  nodes,
}: {
  fields: readonly ComparisonField[];
  nodes: Parameters<typeof SettingsList>[0]["nodes"];
}) {
  const catalog = useExtensionCatalog();
  const [showAll, setShowAll] = useState(false);
  const action = fields.find((field) => field.key === "snapshot:action");
  const actionLabel =
    typeof action?.after === "string"
      ? (findAction(catalog, action.after)?.label ?? action.after)
      : null;
  const content = fields
    .filter((field) => !IDENTITY_KEYS.has(field.key))
    .toSorted(
      (left, right) => textLength(right.after) - textLength(left.after)
    )[0];
  return (
    <div className="space-y-2">
      {actionLabel || content ? (
        <section aria-label="What it does" className="space-y-1">
          {actionLabel ? (
            <h4 className="font-medium text-muted-foreground text-xs">
              {actionLabel}
            </h4>
          ) : null}
          {content ? (
            <SettingsList
              fields={[content]}
              label="Main content"
              nodes={nodes}
              side="after"
            />
          ) : null}
        </section>
      ) : null}
      <Button
        aria-expanded={showAll}
        className="h-auto px-0"
        onClick={() => setShowAll(!showAll)}
        size="sm"
        type="button"
        variant="link"
      >
        {showAll ? "Hide settings" : "Show all settings"}
      </Button>
      {showAll ? (
        <SettingsList
          fields={fields}
          label="All settings"
          nodes={nodes}
          side="after"
        />
      ) : null}
    </div>
  );
}

function textLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

/** The changes that leave every run the same, last and collapsed. */
function OrganizationChanges({
  items,
  defaultOpen,
}: {
  items: readonly OrganizationChange[];
  defaultOpen: boolean;
}) {
  return (
    <Collapsible className="border-t" defaultOpen={defaultOpen}>
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center gap-2 px-4 py-2 text-left text-muted-foreground text-sm hover:bg-muted"
        )}
      >
        <ChevronRight className="size-4 shrink-0 transition-transform group-data-[panel-open]:rotate-90" />
        Does not change what runs
        <span className="ml-auto">{items.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="space-y-1 px-4 pb-3 pl-10 text-sm">
          {items.map((item) => (
            <li key={item.key}>{item.text}</li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

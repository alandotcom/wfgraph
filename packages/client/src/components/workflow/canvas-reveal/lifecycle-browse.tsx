import { useAtomValue, useSetAtom } from "jotai";
import { Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import { ConditionSummary } from "#src/components/workflow/config/condition-summary";
import {
  concurrencySummary,
  eligibilityTiming,
  entityBindingRows,
  eventLabel,
  trackedEntityLabel,
} from "#src/components/workflow/config/lifecycle-policy-summary";
import { can } from "#src/lib/authorization";
import {
  type ConditionSelectableField,
  getEntityConditionFields,
  getEventConditionFields,
  getSharedEventConditionFields,
} from "#src/lib/upstream-node-fields";
import { nodesAtom, updateNodeDataAtom } from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import { isGeneratingAtom } from "#src/lib/workflow-ui-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { parseConditionModel } from "@wfgraph/shared/conditions/conditions";
import {
  type ExtensionCatalog,
  findEntity,
  findEvent,
} from "@wfgraph/shared/extensions/catalog";
import {
  readCancelFilter,
  readCancelFilterLayout,
} from "@wfgraph/shared/lifecycle/cancel-filters";
import {
  initialLifecycleRules,
  type LifecycleRules,
  readLifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import {
  readStartFilter,
  readStartFilterLayout,
} from "@wfgraph/shared/lifecycle/start-filters";
import {
  type LifecycleSectionId,
  lifecycleIssueSection,
  useOpenLifecycleSection,
} from "./lifecycle-reveal-model";
import type { RevealBodyProps } from "./reveal-kinds";
import { NodeIssueList, Section } from "./reveal-sections";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

/** A stored condition read as sentences, or a note when it has none or can't be read. */
function ConditionText({
  model,
  fields,
  emptyText,
  setOperatorsRequireEnumValues = false,
}: {
  model: string | undefined;
  fields: readonly ConditionSelectableField[];
  emptyText: string;
  setOperatorsRequireEnumValues?: boolean | undefined;
}) {
  if (!model) {
    return <p className="text-muted-foreground text-xs">{emptyText}</p>;
  }
  const parsed = parseConditionModel(model);
  return parsed.valid ? (
    <div className="border-l pl-3">
      <ConditionSummary
        compact
        fields={fields}
        model={parsed.model}
        setOperatorsRequireEnumValues={setOperatorsRequireEnumValues}
      />
    </div>
  ) : (
    <p className="text-warning text-xs">
      The rule can't be read. Open the editor to fix it.
    </p>
  );
}

/** An Event name, marked when the catalog no longer declares it. */
function EventName({
  catalog,
  eventName,
}: {
  catalog: ExtensionCatalog;
  eventName: string;
}) {
  const event = findEvent(catalog, eventName);
  return (
    <div className="space-y-0.5">
      <p className="text-sm">
        {eventLabel(catalog, eventName)}
        {event ? null : (
          <span className="text-warning text-xs">
            {" "}
            · Not declared by this app
          </span>
        )}
      </p>
      {event?.description ? (
        <p className="text-muted-foreground text-xs">{event.description}</p>
      ) : null}
      {event && event.label !== event.name ? (
        <p className="font-mono text-muted-foreground text-xs">{event.name}</p>
      ) : null}
    </div>
  );
}

/** What the summary of each lifecycle role reads and says. */
const ROLE_SUMMARY = {
  start: {
    eventNames: (rules: LifecycleRules) => rules.startEvents,
    readFilter: readStartFilter,
    readLayout: readStartFilterLayout,
    filterNoun: "Start Filter",
    noEventsText: "No Start Events.",
    noFilterText: "No Start Filter. Every arrival starts a run.",
  },
  cancel: {
    eventNames: (rules: LifecycleRules) => rules.cancelEvents,
    readFilter: readCancelFilter,
    readLayout: readCancelFilterLayout,
    filterNoun: "Cancel Filter",
    noEventsText: "No Cancel Events.",
    noFilterText:
      "No Cancel Filter. Every arrival routes matching runs to the Canceled outlet.",
  },
} as const;

/**
 * The Events of one lifecycle role, each with the payload filter it holds. A
 * group sharing one filter shows it once for every Event.
 */
function RoleEvents({
  role,
  rules,
  catalog,
  nodes,
}: {
  role: keyof typeof ROLE_SUMMARY;
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
  nodes: readonly WorkflowNode[];
}) {
  const summary = ROLE_SUMMARY[role];
  const eventNames = summary.eventNames(rules);
  const layout = summary.readLayout(rules);

  if (eventNames.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">{summary.noEventsText}</p>
    );
  }
  if (eventNames.length > 1 && layout.collapsed && layout.model) {
    return (
      <div className="space-y-2">
        <ul className="space-y-1">
          {eventNames.map((eventName) => (
            <li key={eventName}>
              <EventName catalog={catalog} eventName={eventName} />
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground text-xs">
          One {summary.filterNoun} for every Event
        </p>
        <ConditionText
          emptyText={summary.noFilterText}
          fields={getSharedEventConditionFields(catalog, eventNames, nodes)}
          model={layout.model}
        />
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {eventNames.map((eventName) => (
        <li className="space-y-1" key={eventName}>
          <EventName catalog={catalog} eventName={eventName} />
          <ConditionText
            emptyText={summary.noFilterText}
            fields={getEventConditionFields(catalog, eventName, nodes)}
            model={summary.readFilter(rules, eventName)}
          />
        </li>
      ))}
    </ul>
  );
}

/** The tracked Entity, its binding in each Lifecycle Event, and its eligibility rule. */
function EntityEligibilitySummary({
  rules,
  catalog,
}: {
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
}) {
  const tracked = rules.trackedEntity;
  const entityLabel = trackedEntityLabel(rules, catalog);
  if (!tracked || entityLabel === null) {
    return (
      <p className="text-muted-foreground text-xs">
        Not tracked. Runs are matched by Correlation Path.
      </p>
    );
  }
  const bindings = entityBindingRows(rules, catalog);
  return (
    <div className="space-y-3">
      <dl className="space-y-1.5">
        <Row label="Tracked Entity">{entityLabel}</Row>
        <Row label="Checked">{eligibilityTiming(rules)}</Row>
      </dl>
      {findEntity(catalog, tracked.type) ? null : (
        <p className="text-warning text-xs">
          {entityLabel} is no longer available in this app.
        </p>
      )}
      {bindings.length > 0 ? (
        <div className="space-y-1">
          <h4 className="font-medium text-xs">{entityLabel} in each Event</h4>
          <dl className="space-y-1">
            {bindings.map((row) => (
              <Row key={row.eventName} label={row.eventLabel}>
                {row.binding ?? (
                  <span className="text-warning">No binding</span>
                )}
              </Row>
            ))}
          </dl>
        </div>
      ) : null}
      <div className="space-y-1">
        <h4 className="font-medium text-xs">Eligible when</h4>
        <p className="text-muted-foreground text-xs">
          Reads the {entityLabel}'s current state from your app when it is
          checked. Event payloads are not read here.
        </p>
        <ConditionText
          emptyText="No eligibility rule."
          fields={getEntityConditionFields(catalog, tracked.type)}
          model={rules.entityEligibility?.condition}
          setOperatorsRequireEnumValues
        />
      </div>
    </div>
  );
}

/**
 * The workflow's lifecycle policy as a summary, one section per concept. Start
 * and Cancel Events show the payload filters that admit an arrival, kept apart
 * from Entity eligibility, which reads current Entity State. With `onEdit`,
 * each section has an Edit button that calls it with the section's id.
 */
export function LifecyclePolicySections({
  rules,
  onEdit,
}: {
  rules: LifecycleRules;
  onEdit?: ((section: LifecycleSectionId) => void) | undefined;
}) {
  const catalog = useExtensionCatalog();
  const nodes = useAtomValue(nodesAtom);
  const concurrency = concurrencySummary(rules);
  const editAction = (title: string, section: LifecycleSectionId) =>
    onEdit ? (
      <Button
        aria-label={`Edit ${title}`}
        onClick={() => onEdit(section)}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <Pencil />
      </Button>
    ) : undefined;

  return (
    <>
      <Section
        action={editAction("Start Events", "start-events")}
        title="Start Events"
      >
        <p className="text-muted-foreground text-xs">
          A Start Filter reads the arriving Event's payload before a run opens.
        </p>
        <RoleEvents
          catalog={catalog}
          nodes={nodes}
          role="start"
          rules={rules}
        />
      </Section>

      <Section
        action={editAction("Overlapping runs", "overlapping-runs")}
        title="Overlapping runs"
      >
        <p className="text-sm">{concurrency.label}</p>
        {concurrency.description ? (
          <p className="text-muted-foreground text-xs">
            {concurrency.description}
          </p>
        ) : null}
        <dl>
          <Row label="Manual runs">
            {rules.allowManualStart ? "Allowed" : "Not allowed"}
          </Row>
        </dl>
      </Section>

      <Section
        action={editAction("Cancel Events", "cancel-events")}
        title="Cancel Events"
      >
        <RoleEvents
          catalog={catalog}
          nodes={nodes}
          role="cancel"
          rules={rules}
        />
      </Section>

      <Section
        action={editAction("Entity eligibility", "entity-eligibility")}
        title="Entity eligibility"
      >
        <EntityEligibilitySummary catalog={catalog} rules={rules} />
      </Section>
    </>
  );
}

function LifecycleBrowseBody({ node }: { node: WorkflowNode }) {
  const issues = useAtomValue(workflowIssuesAtom);
  const isGenerating = useAtomValue(isGeneratingAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const canUpdate = can(WfGraphOperations.workflowUpdate.id);
  const openSection = useOpenLifecycleSection(node.id);
  const rules = readLifecycleRules(node.data.config) ?? initialLifecycleRules;

  return (
    <div className="pb-4">
      <Section title="Label">
        <Label className="sr-only" htmlFor="reveal-lifecycle-label">
          Label
        </Label>
        <Input
          disabled={isGenerating || !canUpdate}
          id="reveal-lifecycle-label"
          onChange={(event) =>
            updateNodeData({ id: node.id, data: { label: event.target.value } })
          }
          value={node.data.label}
        />
      </Section>

      <LifecyclePolicySections onEdit={openSection} rules={rules} />

      <Section
        action={
          <Button
            aria-label="Edit Validation"
            onClick={() => openSection("validation")}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <Pencil />
          </Button>
        }
        title="Validation"
      >
        <NodeIssueList
          issues={issues.filter((issue) => issue.nodeId === node.id)}
          onSelect={(_fieldKey, issue) =>
            openSection(lifecycleIssueSection(issue))
          }
        />
      </Section>
    </div>
  );
}

/**
 * Browse for the Lifecycle Node: an editable label, the lifecycle policy
 * summary, and the node's issues. Each section and issue opens Focus on the
 * section that edits it.
 */
export function LifecycleBrowse({ subject }: RevealBodyProps) {
  const nodes = useAtomValue(nodesAtom);
  const node = nodes.find((item) => item.id === subject.nodeId);
  return node ? <LifecycleBrowseBody node={node} /> : null;
}

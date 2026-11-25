import {
  overlappingRunsSentence,
  startSentences,
} from "@wfgraph/shared/graph/workflow-summary";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#src/components/ui/dropdown-menu";
import { useLifecycleRulesEditor } from "#src/components/workflow/config/use-lifecycle-rules-editor";
import { useNodeConfigWriter } from "#src/components/workflow/config/use-node-config-writer";
import { useAtomValue, useSetAtom } from "jotai";
import type { ReactNode } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import { ConditionSummary } from "#src/components/workflow/config/condition-summary";
import {
  concurrencySummary,
  describeRelatedRuns,
  eligibilityTiming,
  entityBindingRows,
  eventLabel,
  START_RULE_NAMES,
  trackedEntityLabel,
} from "#src/components/workflow/config/lifecycle-policy-summary";
import { scheduleReadout } from "#src/components/workflow/config/lifecycle-schedule";
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
  findIntegration,
  uniqueIntegrationsOfEvents,
} from "@wfgraph/shared/extensions/catalog";
import {
  readCancelFilter,
  readCancelFilterLayout,
} from "@wfgraph/shared/lifecycle/cancel-filters";
import { scheduleIdentity } from "@wfgraph/shared/lifecycle/cron-schedule";
import {
  connectionIdForIntegration,
  type LifecycleRules,
  manualStartAllowed,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import {
  readStartFilter,
  readStartFilterLayout,
} from "@wfgraph/shared/lifecycle/start-filters";
import {
  isRemovableLifecycleSection,
  type LifecycleSectionId,
  lifecycleEditButtonId,
  lifecycleIssueSection,
  lifecycleSectionHeadingId,
  lifecycleSectionShown,
  lifecycleSectionTitle,
  offeredLifecycleRules,
  type RemovableLifecycleSection,
  useOpenLifecycleSection,
  withoutLifecycleRule,
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

/**
 * A stored condition read as sentences, or a note when it has none or can't be
 * read. A template reference in a value names its source in the live draft.
 */
function ConditionText({
  model,
  fields,
  emptyText,
  setOperatorsRequireEnumValues = false,
}: {
  model: string | undefined;
  fields: readonly ConditionSelectableField[];
  /** What an unset rule says, or null to say nothing. */
  emptyText: string | null;
  setOperatorsRequireEnumValues?: boolean | undefined;
}) {
  const nodes = useAtomValue(nodesAtom);
  if (!model) {
    return emptyText === null ? null : (
      <p className="text-muted-foreground text-xs">{emptyText}</p>
    );
  }
  const parsed = parseConditionModel(model);
  return parsed.valid ? (
    <div className="border-l pl-3">
      <ConditionSummary
        compact
        fields={fields}
        model={parsed.model}
        nodes={nodes}
        setOperatorsRequireEnumValues={setOperatorsRequireEnumValues}
      />
    </div>
  ) : (
    <p className="text-warning text-xs">
      This rule is invalid. Open its section and rebuild it.
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
    sharedFilterText: `${START_RULE_NAMES.startFilter}, for every Event`,
    noEventsText: "No Start Events.",
    // The start's sentences already say every arrival starts a run.
    noFilterText: () => null,
  },
  cancel: {
    eventNames: (rules: LifecycleRules) => rules.cancelEvents,
    readFilter: readCancelFilter,
    readLayout: readCancelFilterLayout,
    sharedFilterText: "Only stop when, for every Event",
    noEventsText: "No Cancel Events.",
    noFilterText: (rules: LifecycleRules, catalog: ExtensionCatalog) => {
      const entityLabel = trackedEntityLabel(rules, catalog);
      const identity = entityLabel
        ? `${entityLabel} ID`
        : "Correlation Path value";
      return `No Cancel Filter. Every arrival cancels active runs for the ${identity} it provides.`;
    },
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
          {summary.sharedFilterText}
        </p>
        <ConditionText
          emptyText={summary.noFilterText(rules, catalog)}
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
            emptyText={summary.noFilterText(rules, catalog)}
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
        No Entity is tracked. {describeRelatedRuns(rules, catalog)}
      </p>
    );
  }
  const bindings = entityBindingRows(rules, catalog);
  return (
    <div className="space-y-3">
      <dl className="space-y-1.5">
        <Row label="Each run tracks">{entityLabel} ID</Row>
        <Row label="Eligibility checked">{eligibilityTiming(rules)}</Row>
      </dl>
      {findEntity(catalog, tracked.type) ? null : (
        <p className="text-warning text-xs">
          {entityLabel} is no longer available in this app.
        </p>
      )}
      {bindings.length > 0 ? (
        <div className="space-y-1">
          <h4 className="font-medium text-xs">
            How each Event provides the {entityLabel} ID
          </h4>
          <dl className="space-y-1">
            {bindings.map((row) => (
              <Row key={row.eventName} label={row.eventLabel}>
                {row.binding ? (
                  `${row.binding} binding`
                ) : (
                  <span className="text-warning">No binding</span>
                )}
              </Row>
            ))}
          </dl>
        </div>
      ) : null}
      <div className="space-y-1">
        <h4 className="font-medium text-xs">{START_RULE_NAMES.eligibility}</h4>
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

/** Each schedule in words with the next time it starts a run. */
function ScheduleSummary({ rules }: { rules: LifecycleRules }) {
  const schedules = rules.schedules ?? [];
  if (schedules.length === 0) {
    return <p className="text-muted-foreground text-xs">No schedules.</p>;
  }
  const now = new Date();
  return (
    <ul className="space-y-2">
      {schedules.map((schedule) => {
        const readout = scheduleReadout(schedule, now, 1);
        return (
          <li className="space-y-0.5" key={scheduleIdentity(schedule)}>
            <p className="text-sm">{readout.description}</p>
            {readout.nextFires[0] ? (
              <p className="text-muted-foreground text-xs tabular-nums">
                Next run: {readout.nextFires[0]}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Each integration whose Events the rules name, and whether it has a Connection. */
function EventConnectionsSummary({
  rules,
  catalog,
}: {
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
}) {
  const integrations = uniqueIntegrationsOfEvents(catalog, [
    ...rules.startEvents,
    ...rules.cancelEvents,
  ]);
  if (integrations.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        No integration Events, so no Connection is needed.
      </p>
    );
  }
  return (
    <dl className="space-y-1">
      {integrations.map((integration) => (
        <Row
          key={integration}
          label={findIntegration(catalog, integration)?.label ?? integration}
        >
          {connectionIdForIntegration(rules, catalog, integration) ? (
            "Connection chosen"
          ) : (
            <span className="text-warning">No Connection chosen</span>
          )}
        </Row>
      ))}
    </dl>
  );
}

/**
 * How the sections of `LifecyclePolicySections` edit. `onEdit` opens a
 * section's editor, from its Edit button, from "Choose what starts it" or from
 * "Add a rule". `open` names the one section shown as its editor, `editors`
 * holds each section's editor, and `onDone` is that section's Done button.
 * `onRemove`, when given, puts a set rule back to its default, which hides
 * its section.
 */
export type LifecycleSectionEditing = {
  onEdit: (section: LifecycleSectionId) => void;
  open?: LifecycleSectionId | null | undefined;
  editors?: Readonly<Record<LifecycleSectionId, ReactNode>> | undefined;
  onDone?: (() => void) | undefined;
  onRemove?: ((section: RemovableLifecycleSection) => void) | undefined;
};

/** "Add a rule": each rule not set yet, named for what it does. */
function AddRuleMenu({
  rules,
  onEdit,
}: {
  rules: LifecycleRules;
  onEdit: (section: LifecycleSectionId) => void;
}) {
  const offered = offeredLifecycleRules(rules);
  if (offered.length === 0) {
    return null;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size="sm" type="button" variant="outline" />}
      >
        Add a rule
        <ChevronDown className="size-3 opacity-50" data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {offered.map((choice) => (
          <DropdownMenuItem
            key={choice.id}
            onClick={() => onEdit(choice.section)}
          >
            {choice.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * What starts a run: each Start Event with the filter it holds, or, with none,
 * the sentence saying a schedule, a person or nothing starts it. A start with
 * Start Events or a schedule that also allows hand runs says so.
 */
function StartSummary({
  rules,
  catalog,
  nodes,
}: {
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
  nodes: readonly WorkflowNode[];
}) {
  const alsoByHand =
    manualStartAllowed(rules) &&
    (rules.startEvents.length > 0 || (rules.schedules?.length ?? 0) > 0);
  return (
    <div className="space-y-2">
      {rules.startEvents.length > 0 ? (
        <RoleEvents
          catalog={catalog}
          nodes={nodes}
          role="start"
          rules={rules}
        />
      ) : (
        startSentences(rules, catalog).map((sentence) => (
          <p className="text-sm" key={sentence}>
            {sentence}
          </p>
        ))
      )}
      {alsoByHand ? (
        <p className="text-muted-foreground text-xs">
          Someone can also run it by hand.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The start's rules as a summary. What starts a run always shows, and each
 * other rule shows once it is set (`lifecycleSectionShown`). Start and Cancel
 * Events show the payload filters that admit an arrival, kept apart from
 * Entity eligibility, which reads current Entity State. With `editing`, the
 * start offers "Choose what starts it" and "Add a rule", each set rule has an
 * Edit button and, with `editing.onRemove`, a Remove button, and the section
 * `editing.open` names shows its editor in place of its summary, with Done.
 */
export function LifecyclePolicySections({
  rules,
  editing,
  issueCount = 0,
}: {
  rules: LifecycleRules;
  editing?: LifecycleSectionEditing | undefined;
  /** The start's issues, which decide whether Validation shows. */
  issueCount?: number | undefined;
}) {
  const catalog = useExtensionCatalog();
  const nodes = useAtomValue(nodesAtom);
  const concurrency = concurrencySummary(rules);
  const overlap = overlappingRunsSentence(rules, catalog);
  const isOpen = (section: LifecycleSectionId) =>
    editing?.open === section && editing.editors !== undefined;
  const shown = (section: LifecycleSectionId) =>
    isOpen(section) ||
    lifecycleSectionShown({ section, rules, catalog, issueCount });
  const editAction = (title: string, section: LifecycleSectionId) => {
    if (!editing) {
      return undefined;
    }
    if (isOpen(section)) {
      return (
        <Button
          aria-label={`Done editing ${title}`}
          onClick={editing.onDone}
          size="sm"
          type="button"
          variant="outline"
        >
          Done
        </Button>
      );
    }
    const onRemove = editing.onRemove;
    return (
      <div className="flex items-center gap-1">
        {onRemove && isRemovableLifecycleSection(section) ? (
          <Button
            aria-label={`Remove ${title}`}
            onClick={() => onRemove(section)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Remove
          </Button>
        ) : null}
        <Button
          aria-label={`Edit ${title}`}
          id={lifecycleEditButtonId(section)}
          onClick={() => editing.onEdit(section)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Edit
        </Button>
      </div>
    );
  };
  /** The section's editor while it is open, and otherwise its summary. */
  const body = (section: LifecycleSectionId, summary: ReactNode) =>
    isOpen(section) ? editing?.editors?.[section] : summary;
  const headingId = (section: LifecycleSectionId) =>
    isOpen(section) ? lifecycleSectionHeadingId(section) : undefined;

  return (
    <>
      <Section
        action={
          isOpen("start-events")
            ? editAction("what starts it", "start-events")
            : undefined
        }
        headingId={headingId("start-events")}
        title={lifecycleSectionTitle("start-events")}
      >
        {body(
          "start-events",
          <>
            <StartSummary catalog={catalog} nodes={nodes} rules={rules} />
            {editing ? (
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  id={lifecycleEditButtonId("start-events")}
                  onClick={() => editing.onEdit("start-events")}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Choose what starts it
                </Button>
                <AddRuleMenu onEdit={editing.onEdit} rules={rules} />
              </div>
            ) : null}
          </>
        )}
      </Section>

      {shown("overlapping-runs") ? (
        <Section
          action={editAction(
            lifecycleSectionTitle("overlapping-runs"),
            "overlapping-runs"
          )}
          headingId={headingId("overlapping-runs")}
          title={lifecycleSectionTitle("overlapping-runs")}
        >
          {body(
            "overlapping-runs",
            <>
              <p className="text-sm">{concurrency.label}</p>
              {overlap === null ? null : (
                <p className="text-muted-foreground text-xs">{overlap}</p>
              )}
            </>
          )}
        </Section>
      ) : null}

      {shown("schedule") ? (
        <Section
          action={editAction(lifecycleSectionTitle("schedule"), "schedule")}
          headingId={headingId("schedule")}
          title={lifecycleSectionTitle("schedule")}
        >
          {body("schedule", <ScheduleSummary rules={rules} />)}
        </Section>
      ) : null}

      {shown("cancel-events") ? (
        <Section
          action={editAction(
            lifecycleSectionTitle("cancel-events"),
            "cancel-events"
          )}
          headingId={headingId("cancel-events")}
          title={lifecycleSectionTitle("cancel-events")}
        >
          {body(
            "cancel-events",
            <RoleEvents
              catalog={catalog}
              nodes={nodes}
              role="cancel"
              rules={rules}
            />
          )}
        </Section>
      ) : null}

      {shown("entity-eligibility") ? (
        <Section
          action={editAction(
            lifecycleSectionTitle("entity-eligibility"),
            "entity-eligibility"
          )}
          headingId={headingId("entity-eligibility")}
          title={lifecycleSectionTitle("entity-eligibility")}
        >
          {body(
            "entity-eligibility",
            <EntityEligibilitySummary catalog={catalog} rules={rules} />
          )}
        </Section>
      ) : null}

      {shown("connections") ? (
        <Section
          action={editAction("Event Connections", "connections")}
          headingId={headingId("connections")}
          title="Event Connections"
        >
          {body(
            "connections",
            <EventConnectionsSummary catalog={catalog} rules={rules} />
          )}
        </Section>
      ) : null}
    </>
  );
}

/** The Lifecycle Node's label, which writes to the graph store as it is typed. */
export function LifecycleLabelSection({ node }: { node: WorkflowNode }) {
  const isGenerating = useAtomValue(isGeneratingAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const canUpdate = can(WfGraphOperations.workflowUpdate.id);
  return (
    <Section title="Label">
      <Label className="sr-only" htmlFor="label">
        Label
      </Label>
      <Input
        disabled={isGenerating || !canUpdate}
        id="label"
        onChange={(event) =>
          updateNodeData({ id: node.id, data: { label: event.target.value } })
        }
        value={node.data.label}
      />
    </Section>
  );
}

/**
 * The summary sheet of the Lifecycle Node on a phone: an editable label, the
 * lifecycle policy summary, and the node's issues. Each section's Edit and each
 * issue open the full-screen editor at the section that edits it.
 */
export function LifecycleSummarySheet({ subject }: RevealBodyProps) {
  const nodes = useAtomValue(nodesAtom);
  const node = nodes.find((item) => item.id === subject.nodeId);
  return node ? <LifecycleSummarySheetBody key={node.id} node={node} /> : null;
}

function LifecycleSummarySheetBody({ node }: { node: WorkflowNode }) {
  const issues = useAtomValue(workflowIssuesAtom);
  const openSection = useOpenLifecycleSection(node.id);
  const { updateConfig } = useNodeConfigWriter(node.id);
  const editor = useLifecycleRulesEditor({
    config: node.data.config ?? EMPTY_CONFIG,
    onUpdateConfig: updateConfig,
  });
  const nodeIssues = issues.filter((issue) => issue.nodeId === node.id);
  const canUpdate = can(WfGraphOperations.workflowUpdate.id);
  return (
    <div className="pb-4">
      <LifecycleLabelSection node={node} />
      <LifecyclePolicySections
        editing={{
          onEdit: openSection,
          onRemove: canUpdate
            ? (section) =>
                editor.setRules(withoutLifecycleRule(editor.rules, section))
            : undefined,
        }}
        issueCount={nodeIssues.length}
        rules={editor.rules}
      />
      {nodeIssues.length > 0 ? (
        <Section title="Validation">
          <NodeIssueList
            issues={nodeIssues}
            onSelect={(_fieldKey, issue) =>
              openSection(lifecycleIssueSection(issue))
            }
          />
        </Section>
      ) : null}
    </div>
  );
}

const EMPTY_CONFIG: Record<string, unknown> = {};

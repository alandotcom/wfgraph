import { useAtomValue } from "jotai";
import { type ReactNode, useId } from "react";
import type { WorkflowIssue } from "@wfgraph/shared/graph/workflow-issues";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { ConfigGroup } from "#src/components/workflow/config/config-section";
import { LifecycleConcurrencyGroup } from "#src/components/workflow/config/lifecycle-concurrency-group";
import { LifecycleEntityEligibilityGroup } from "#src/components/workflow/config/lifecycle-entity-eligibility-group";
import { LifecycleScheduleGroup } from "#src/components/workflow/config/lifecycle-schedule-group";
import {
  LifecycleEventConnections,
  LifecycleIssuesCallout,
  LifecycleRoleEventGroup,
} from "#src/components/workflow/config/lifecycle-panel";
import { unsavedScheduleMessage } from "#src/components/workflow/config/lifecycle-schedule";
import { useLifecycleRulesEditor } from "#src/components/workflow/config/use-lifecycle-rules-editor";
import { useNodeConfigWriter } from "#src/components/workflow/config/use-node-config-writer";
import { can } from "#src/lib/authorization";
import { nodesAtom } from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import { isGeneratingAtom } from "#src/lib/workflow-ui-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { uniqueIntegrationsOfEvents } from "@wfgraph/shared/extensions/catalog";
import { cn } from "@wfgraph/shared/utils";
import {
  LIFECYCLE_SECTIONS,
  type LifecycleSectionId,
  lifecycleEditButtonId,
  lifecycleIssueSection,
  lifecycleSectionHeadingId,
  useLifecycleOpenSection,
  useLifecycleSection,
} from "./lifecycle-reveal-model";
import type { RevealBodyProps } from "./reveal-kinds";
import { NodeIssueList, Section } from "./reveal-sections";
import {
  LifecycleLabelSection,
  LifecyclePolicySections,
} from "./lifecycle-browse";

/**
 * The editor of each Lifecycle section of `node`, keyed by section id, all
 * writing through one Lifecycle Rules editor, with the rules they edit and the
 * node's issues. `showSection` answers a control inside one section that shows
 * another, such as an issue in Validation. The caller keeps this mounted while
 * the node shows, so a schedule that cannot be saved yet stays in its section.
 */
export function useLifecycleSectionEditors(input: {
  node: WorkflowNode;
  showSection: (section: LifecycleSectionId) => void;
}): {
  rules: LifecycleRules;
  nodeIssues: WorkflowIssue[];
  bodies: Record<LifecycleSectionId, ReactNode>;
} {
  const { node, showSection } = input;
  const catalog = useExtensionCatalog();
  const issues = useAtomValue(workflowIssuesAtom);
  const isGenerating = useAtomValue(isGeneratingAtom);
  const disabled = isGenerating || !can(WfGraphOperations.workflowUpdate.id);
  const { updateConfig } = useNodeConfigWriter(node.id);
  const editor = useLifecycleRulesEditor({
    config: node.data.config ?? EMPTY_CONFIG,
    onUpdateConfig: updateConfig,
  });
  const manualStartId = useId();
  const { rules } = editor;
  const nodeIssues = issues.filter((issue) => issue.nodeId === node.id);

  const bodies: Record<LifecycleSectionId, ReactNode> = {
    "start-events": (
      <LifecycleRoleEventGroup
        disabled={disabled}
        editor={editor}
        role="start"
      />
    ),
    "overlapping-runs": (
      <LifecycleConcurrencyGroup
        disabled={disabled}
        manualStartId={manualStartId}
        onConcurrencyChange={editor.setConcurrency}
        onManualStartChange={editor.setManualStart}
        rules={rules}
      />
    ),
    schedule: (
      <div className="space-y-4">
        <LifecycleScheduleGroup
          disabled={disabled}
          schedules={editor.schedules}
        />
        <LifecycleIssuesCallout
          issues={editor.schedules.unsaved.map(unsavedScheduleMessage)}
        />
      </div>
    ),
    "cancel-events": (
      <LifecycleRoleEventGroup
        disabled={disabled}
        editor={editor}
        role="cancel"
      />
    ),
    "entity-eligibility": (
      <LifecycleEntityEligibilityGroup
        catalog={catalog}
        disabled={disabled}
        onChange={editor.setRules}
        rules={rules}
      />
    ),
    connections: (
      <ConfigGroup label="Event Connections" prominent>
        {uniqueIntegrationsOfEvents(catalog, [
          ...rules.startEvents,
          ...rules.cancelEvents,
        ]).length === 0 ? (
          <p className="text-muted-foreground text-xs">
            This workflow uses no integration Events, so it does not need a
            Connection.
          </p>
        ) : (
          <div className="space-y-3">
            <LifecycleEventConnections disabled={disabled} editor={editor} />
          </div>
        )}
      </ConfigGroup>
    ),
    validation: (
      <ConfigGroup label="Validation" prominent>
        <NodeIssueList
          issues={nodeIssues}
          onSelect={(_fieldKey, issue) =>
            showSection(lifecycleIssueSection(issue))
          }
        />
      </ConfigGroup>
    ),
  };
  return { rules, nodeIssues, bodies };
}

/**
 * The phone's full-screen Lifecycle policy editor for one node: a section list
 * above the one section it shows. Every section stays mounted while hidden, so
 * an edit in progress survives a switch.
 */
function LifecyclePolicyEditor({
  node,
  scrollToTop,
}: {
  node: WorkflowNode;
  scrollToTop: () => void;
}) {
  const navId = useId();
  const { section, choose } = useLifecycleSection(node.id);
  const navButtonId = (id: LifecycleSectionId) => `${navId}-${id}`;
  const show = (next: LifecycleSectionId) => {
    if (next !== section) {
      choose(next);
      scrollToTop();
    }
  };
  // A control inside one section that shows another hides itself, so focus
  // moves to the list entry of the section it showed.
  const goTo = (next: LifecycleSectionId) => {
    show(next);
    document.getElementById(navButtonId(next))?.focus();
  };
  const { rules, nodeIssues, bodies } = useLifecycleSectionEditors({
    node,
    showSection: goTo,
  });
  const counts: Partial<Record<LifecycleSectionId, number>> = {
    "start-events": rules.startEvents.length,
    schedule: rules.schedules?.length ?? 0,
    "cancel-events": rules.cancelEvents.length,
    validation: nodeIssues.length,
  };

  return (
    <div className="grid min-h-full grid-cols-1">
      <nav aria-label="Lifecycle policy" className="p-2">
        <p className="px-2 pt-1 pb-2 text-muted-foreground text-xs">
          Lifecycle policy
        </p>
        <ul className="flex flex-wrap gap-1">
          {LIFECYCLE_SECTIONS.map((entry) => {
            const count = counts[entry.id];
            return (
              <li key={entry.id}>
                <button
                  aria-current={entry.id === section ? "true" : undefined}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted",
                    entry.id === section && "bg-muted font-medium"
                  )}
                  id={navButtonId(entry.id)}
                  onClick={() => show(entry.id)}
                  type="button"
                >
                  <span className="min-w-0 truncate">{entry.label}</span>
                  {count ? (
                    <span className="text-muted-foreground tabular-nums">
                      {count}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="min-w-0 border-t p-4">
        {LIFECYCLE_SECTIONS.map((entry) => (
          <section
            aria-label={entry.label}
            hidden={entry.id !== section}
            key={entry.id}
          >
            {bodies[entry.id]}
          </section>
        ))}
      </div>
    </div>
  );
}

const EMPTY_CONFIG: Record<string, unknown> = {};

/**
 * The phone's full-screen editor for the Lifecycle Node: the sectioned policy
 * editor, keyed to the node so its pickers start clean for each Lifecycle Node
 * shown.
 */
export function LifecycleFocus({ subject, scrollToTop }: RevealBodyProps) {
  const nodes = useAtomValue(nodesAtom);
  const node = nodes.find((item) => item.id === subject.nodeId);
  return node ? (
    <LifecyclePolicyEditor
      key={node.id}
      node={node}
      scrollToTop={scrollToTop}
    />
  ) : null;
}

/**
 * The Lifecycle inspector in the details column: an editable label, the
 * lifecycle policy summary, and the node's issues. Each section's Edit shows
 * that section's editor in place, and Done returns it to its summary. An issue
 * opens the section that edits what it names.
 */
function LifecycleEditorBody({
  node,
  focusField,
}: {
  node: WorkflowNode;
  focusField: RevealBodyProps["focusField"];
}) {
  const { section, open, close } = useLifecycleOpenSection(node.id);
  const show = (next: LifecycleSectionId) => {
    if (next === "validation") {
      return;
    }
    open(next);
    focusField(lifecycleSectionHeadingId(next));
  };
  const { rules, nodeIssues, bodies } = useLifecycleSectionEditors({
    node,
    showSection: show,
  });

  return (
    <div className="pb-4">
      <LifecycleLabelSection node={node} />
      <LifecyclePolicySections
        editing={{
          onEdit: show,
          open: section,
          editors: bodies,
          onDone: () => {
            if (section !== null) {
              close();
              focusField(lifecycleEditButtonId(section));
            }
          },
        }}
        rules={rules}
      />
      <Section title="Validation">
        <NodeIssueList
          issues={nodeIssues}
          onSelect={(_fieldKey, issue) => show(lifecycleIssueSection(issue))}
        />
      </Section>
    </div>
  );
}

/**
 * The inspector of the Lifecycle Node in the details column, keyed to the
 * node so the section editors' pickers start clean for each Lifecycle Node.
 */
export function LifecycleEditor({ subject, focusField }: RevealBodyProps) {
  const nodes = useAtomValue(nodesAtom);
  const node = nodes.find((item) => item.id === subject.nodeId);
  return node ? (
    <LifecycleEditorBody focusField={focusField} key={node.id} node={node} />
  ) : null;
}

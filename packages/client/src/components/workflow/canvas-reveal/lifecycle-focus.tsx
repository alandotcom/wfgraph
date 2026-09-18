import { useAtomValue } from "jotai";
import { type ReactNode, useId } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import { ConfigGroup } from "#src/components/workflow/config/config-section";
import { LifecycleConcurrencyGroup } from "#src/components/workflow/config/lifecycle-concurrency-group";
import {
  LifecycleEligibilityCheckpoints,
  LifecycleEntityEligibilityGroup,
} from "#src/components/workflow/config/lifecycle-entity-eligibility-group";
import {
  LifecycleEventConnections,
  LifecycleRoleEventGroup,
} from "#src/components/workflow/config/lifecycle-panel";
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
  lifecycleIssueSection,
  useLifecycleSection,
} from "./lifecycle-reveal-model";
import type { RevealBodyProps } from "./reveal-kinds";
import { NodeIssueList } from "./reveal-sections";

function Intro({ children }: { children: ReactNode }) {
  return <p className="pb-3 text-muted-foreground text-xs">{children}</p>;
}

/**
 * The Lifecycle policy editor for one node: a section list beside the one
 * section it shows. Every section stays mounted while hidden, so an edit in
 * progress survives a switch, and every control writes through one Lifecycle
 * Rules editor.
 */
function LifecyclePolicyEditor({
  node,
  scrollToTop,
}: {
  node: WorkflowNode;
  scrollToTop: () => void;
}) {
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
  const navId = useId();
  const { section, choose } = useLifecycleSection(node.id);
  const { rules } = editor;
  const nodeIssues = issues.filter((issue) => issue.nodeId === node.id);
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
  const counts: Partial<Record<LifecycleSectionId, number>> = {
    "start-events": rules.startEvents.length,
    "cancel-events": rules.cancelEvents.length,
    validation: nodeIssues.length,
  };

  const bodies: Record<LifecycleSectionId, ReactNode> = {
    "start-events": (
      <>
        <Intro>
          A run starts when one of these Events arrives. A Start Filter reads
          the arriving Event's payload and refuses the run before it opens.
        </Intro>
        <LifecycleRoleEventGroup
          disabled={disabled}
          editor={editor}
          role="start"
        />
      </>
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
    "cancel-events": (
      <LifecycleRoleEventGroup
        disabled={disabled}
        editor={editor}
        role="cancel"
      />
    ),
    "entity-eligibility": (
      <>
        <Intro>
          Eligibility reads the tracked Entity's current state from your app. It
          is checked after the payload Start Filters and never reads an Event
          payload.
        </Intro>
        <LifecycleEntityEligibilityGroup
          catalog={catalog}
          disabled={disabled}
          onChange={editor.setRules}
          onGoToCheckpoints={() => goTo("evaluation-checkpoints")}
          rules={rules}
        />
      </>
    ),
    "evaluation-checkpoints": (
      <ConfigGroup label="Entity Lookup" prominent>
        {rules.entityEligibility ? (
          <LifecycleEligibilityCheckpoints
            catalog={catalog}
            disabled={disabled}
            onChange={editor.setRules}
            rules={rules}
          />
        ) : (
          <div className="space-y-2">
            <p className="text-muted-foreground text-xs">
              Add an eligibility rule to choose when it is checked.
            </p>
            <Button
              onClick={() => goTo("entity-eligibility")}
              size="sm"
              type="button"
              variant="outline"
            >
              Go to Entity eligibility
            </Button>
          </div>
        )}
      </ConfigGroup>
    ),
    connections: (
      <ConfigGroup label="Connections" prominent>
        {uniqueIntegrationsOfEvents(catalog, [
          ...rules.startEvents,
          ...rules.cancelEvents,
        ]).length === 0 ? (
          <p className="text-muted-foreground text-xs">
            No Lifecycle Event arrives through an integration, so this workflow
            needs no Connection.
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
          onSelect={(_fieldKey, issue) => goTo(lifecycleIssueSection(issue))}
        />
      </ConfigGroup>
    ),
  };

  return (
    // Below `md` the full-screen mobile inspector puts the section list above
    // the section, since a phone has no width for the two side by side.
    <div className="grid min-h-full grid-cols-1 md:grid-cols-[11rem_minmax(0,1fr)]">
      <nav
        aria-label="Lifecycle policy"
        className="p-2 md:sticky md:top-0 md:self-start"
      >
        <p className="px-2 pt-1 pb-2 text-muted-foreground text-xs">
          Lifecycle policy
        </p>
        <ul className="flex flex-wrap gap-1 md:block md:space-y-0.5">
          {LIFECYCLE_SECTIONS.map((entry) => {
            const count = counts[entry.id];
            return (
              <li key={entry.id}>
                <button
                  aria-current={entry.id === section ? "true" : undefined}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-md md:w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted",
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
      <div className="min-w-0 border-t p-4 md:border-t-0 md:border-l">
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
 * Focus for the Lifecycle Node: the sectioned policy editor, keyed to the node
 * so its pickers start clean for each Lifecycle Node shown.
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

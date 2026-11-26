import { useAtomValue, useSetAtom } from "jotai";
import { useMemo } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import {
  ConditionFields,
  useUpstreamConditionFields,
} from "#src/components/workflow/config/action-config";
import { ConditionSummary } from "#src/components/workflow/config/condition-summary";
import { useNodeConfigWriter } from "#src/components/workflow/config/use-node-config-writer";
import {
  FieldIssueMessages,
  FieldIssuesProvider,
} from "#src/components/workflow/config/field-issues";
import {
  NodeDetailsFields,
  UnplacedNodeIssues,
} from "#src/components/workflow/node-properties-form";
import { PhoneStepToggle } from "#src/components/workflow/step-controls";
import { can } from "#src/lib/authorization";
import type { ConditionSelectableField } from "#src/lib/upstream-node-fields";
import {
  edgesAtom,
  nodesAtom,
  updateNodeDataAtom,
} from "#src/lib/workflow-graph-store";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import { isGeneratingAtom } from "#src/lib/workflow-ui-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { getConditionBranchDisplayLabel } from "@wfgraph/shared/conditions/condition-branch";
import { reconcileModelWithFields } from "@wfgraph/shared/conditions/conditions";
import type { ConditionBranch } from "@wfgraph/shared/graph/types";
import type { WorkflowIssue } from "@wfgraph/shared/graph/workflow-issues";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  type ConditionBranchTarget,
  conditionBranchTargets,
  conditionLogicSentence,
  readStoredConditionRules,
} from "./condition-reveal-summary";
import type { RevealBodyProps } from "./reveal-kinds";
import { NodeIssueList, Section } from "./reveal-sections";
import { CONDITION_RULES_TARGET_ID, revealFocusTarget } from "./reveal-subject";

/** The element id of the editor's heading over the available inputs. */
const INPUTS_HEADING_ID = "condition-inputs";

/** How many available values the summary sheet lists before the rest. */
const SUMMARY_VALUE_LIMIT = 5;

/** "True" or "False", as the canvas labels the outlet. */
function branchLabel(branch: ConditionBranch): string {
  return getConditionBranchDisplayLabel(branch) ?? branch;
}

/**
 * Puts focus in the field of the issue field `fieldKey`, mapped through
 * `revealFocusTarget` to the rule builder for either config key the rules
 * store, and to the field itself otherwise.
 */
function focusIssueField(
  focusField: RevealBodyProps["focusField"]
): (fieldKey?: string) => void {
  return (fieldKey) =>
    focusField(
      fieldKey === undefined
        ? undefined
        : revealFocusTarget("condition", fieldKey)
    );
}

type ConditionContext = {
  node: WorkflowNode | undefined;
  /** The values the Condition's rules can compare. */
  fields: ConditionSelectableField[];
  branches: Record<ConditionBranch, ConditionBranchTarget[]>;
  issues: WorkflowIssue[];
  /** Whether the bodies' controls refuse edits. */
  disabled: boolean;
};

/** Everything both Condition bodies read for the node `nodeId`. */
function useConditionContext(nodeId: string | null): ConditionContext {
  const catalog = useExtensionCatalog();
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const issues = useAtomValue(workflowIssuesAtom);
  const isGenerating = useAtomValue(isGeneratingAtom);
  const canUpdate = can(WfGraphOperations.workflowUpdate.id);
  const node = nodes.find((item) => item.id === nodeId);
  const fields = useUpstreamConditionFields(nodeId);
  const branches = useMemo(
    () =>
      nodeId === null
        ? { true: [], false: [] }
        : conditionBranchTargets({ nodeId, nodes, edges, catalog }),
    [nodeId, nodes, edges, catalog]
  );
  return {
    node,
    fields,
    branches,
    issues: issues.filter((issue) => issue.nodeId === nodeId),
    disabled: isGenerating || !canUpdate,
  };
}

/** The steps one outlet leads to, or the sentence saying the branch ends. */
function BranchTargets({
  branch,
  targets,
}: {
  branch: ConditionBranch;
  targets: readonly ConditionBranchTarget[];
}) {
  if (targets.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        Not connected. A run that takes {branchLabel(branch)} ends here.
      </p>
    );
  }
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

/** One available value: its field label, type, and producers. */
function ValueRow({ field }: { field: ConditionSelectableField }) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span className="min-w-0 truncate text-xs" title={field.label}>
        {field.label}
      </span>
      <span className="shrink-0 text-muted-foreground text-xs">
        {[field.type, ...field.sourceNodeLabels].join(" · ")}
      </span>
    </li>
  );
}

const NO_VALUES_MESSAGE =
  "No values reach this Condition. Connect it below the start or a step with typed outputs.";

/**
 * The Condition's rules read back: one sentence for the logic, then each group
 * and rule unless `sentenceOnly`. An empty or unreadable model says so.
 */
function RulesSummary({
  config,
  fields,
  sentenceOnly = false,
}: {
  config: Record<string, unknown> | undefined;
  fields: ConditionSelectableField[];
  sentenceOnly?: boolean | undefined;
}) {
  const nodes = useAtomValue(nodesAtom);
  const rules = readStoredConditionRules(config);
  if (rules.kind === "empty") {
    return <p className="text-muted-foreground text-xs">No rules yet.</p>;
  }
  if (rules.kind === "unreadable") {
    return (
      <p className="text-destructive text-xs">
        The rules can't be read. Use the rule builder to fix them.
      </p>
    );
  }
  const model = reconcileModelWithFields(
    rules.model,
    new Map(fields.map((field) => [field.path, field]))
  );
  if (sentenceOnly) {
    return <p className="text-sm">{conditionLogicSentence(model)}</p>;
  }
  return (
    <div className="space-y-2">
      <p className="text-sm">{conditionLogicSentence(model)}</p>
      <ConditionSummary fields={fields} model={model} nodes={nodes} />
    </div>
  );
}

/**
 * The summary sheet of a Condition on a phone: an editable label, its rules as
 * sentences, where True and False lead, the values its rules can compare, its
 * issues, and its enable toggle. The rule builder is in the full-screen editor,
 * which the sheet header's Edit rules opens.
 */
export function ConditionSummarySheet({
  subject,
  focusField,
}: RevealBodyProps) {
  const { nodeId } = subject;
  const { node, fields, branches, issues, disabled } =
    useConditionContext(nodeId);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  if (!node || nodeId === null) {
    return null;
  }

  return (
    <div className="pb-4">
      <Section title="Label">
        <Label className="sr-only" htmlFor="reveal-condition-label">
          Label
        </Label>
        <Input
          disabled={disabled}
          id="reveal-condition-label"
          onChange={(event) =>
            updateNodeData({ id: nodeId, data: { label: event.target.value } })
          }
          value={node.data.label}
        />
      </Section>

      <Section title="Continue when">
        <RulesSummary config={node.data.config} fields={fields} />
      </Section>

      <Section title="Branches">
        <dl className="space-y-2">
          {(["true", "false"] as const).map((branch) => (
            <div key={branch}>
              <dt className="font-medium text-xs">{branchLabel(branch)}</dt>
              <dd>
                <BranchTargets branch={branch} targets={branches[branch]} />
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="Available values">
        {fields.length === 0 ? (
          <p className="text-muted-foreground text-xs">{NO_VALUES_MESSAGE}</p>
        ) : (
          <>
            <p className="text-muted-foreground text-xs">
              {fields.length} {fields.length === 1 ? "value" : "values"} from
              earlier steps can be compared.
            </p>
            <ul className="space-y-1">
              {fields.slice(0, SUMMARY_VALUE_LIMIT).map((field) => (
                <ValueRow field={field} key={field.path} />
              ))}
            </ul>
            {fields.length > SUMMARY_VALUE_LIMIT ? (
              <Button
                onClick={() => focusField(INPUTS_HEADING_ID)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Show all {fields.length} values
              </Button>
            ) : null}
          </>
        )}
      </Section>

      <Section title="Validation">
        <NodeIssueList issues={issues} onSelect={focusIssueField(focusField)} />
      </Section>

      <PhoneStepToggle className="border-t px-4 pt-3" node={node} />
    </div>
  );
}

/**
 * The inspector of a Condition: one sentence saying when it takes True, the
 * rules edited in place beneath it with the issues that name them under them,
 * both branch destinations, every available input, then its Label and Notes
 * after a divider. Every edit writes to the graph store. Disabling and
 * deleting it are commands of the details header's menu and the context menu.
 */
export function ConditionEditor({ subject }: RevealBodyProps) {
  const { nodeId } = subject;
  const { node, fields, branches, disabled } = useConditionContext(nodeId);
  const { updateConfig } = useNodeConfigWriter(nodeId);
  if (!node || nodeId === null) {
    return null;
  }

  return (
    <FieldIssuesProvider nodeId={nodeId}>
      <div className="pb-4">
        <div className="px-4 pt-3" data-slot="condition-sentence">
          <RulesSummary
            config={node.data.config}
            fields={fields}
            sentenceOnly
          />
        </div>

        <section
          aria-label="Rule builder"
          className="space-y-2 border-t px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          id={CONDITION_RULES_TARGET_ID}
          tabIndex={-1}
        >
          <ConditionFields
            config={node.data.config ?? {}}
            disabled={disabled}
            fields={fields}
            // Keyed to the node, so the builder's pickers start clean for each
            // Condition.
            key={nodeId}
            nodeId={nodeId}
            onUpdateConfig={updateConfig}
          />
          {/* A Condition's issues name its rules, stored under these two keys,
            so they show beneath the rule builder. An empty rule set waits, as
            an empty required field does, until a Run draft or Publish is
            refused for it. */}
          <FieldIssueMessages fieldKey={CONDITION_RULES_TARGET_ID} />
          <FieldIssueMessages fieldKey="conditionModel" />
          <UnplacedNodeIssues nodeId={nodeId} />
        </section>

        <Section title="Branches">
          <div className="grid gap-2 sm:grid-cols-2">
            {(["true", "false"] as const).map((branch) => (
              <div className="space-y-1 rounded-md border p-3" key={branch}>
                <p className="font-medium text-sm">{branchLabel(branch)}</p>
                <BranchTargets branch={branch} targets={branches[branch]} />
              </div>
            ))}
          </div>
        </Section>

        <Section headingId={INPUTS_HEADING_ID} title="Available inputs">
          {fields.length === 0 ? (
            <p className="text-muted-foreground text-xs">{NO_VALUES_MESSAGE}</p>
          ) : (
            <ul className="space-y-1">
              {fields.map((field) => (
                <ValueRow field={field} key={field.path} />
              ))}
            </ul>
          )}
        </Section>

        <div className="space-y-4 border-t px-4 pt-4">
          <NodeDetailsFields disabled={disabled} node={node} />
        </div>
      </div>
    </FieldIssuesProvider>
  );
}

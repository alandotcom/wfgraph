import { useAtomValue, useSetAtom } from "jotai";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import { Separator } from "#src/components/ui/separator";
import {
  FieldIssuesProvider,
  UnclaimedFieldIssues,
} from "#src/components/workflow/config/field-issues";
import { LifecyclePanel } from "#src/components/workflow/config/lifecycle-panel";
import { trackedEntityLabel } from "#src/components/workflow/config/lifecycle-policy-summary";
import { useNodeConfigWriter } from "#src/components/workflow/config/use-node-config-writer";
import { can } from "#src/lib/authorization";
import { nodesAtom, updateNodeDataAtom } from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import { isGeneratingAtom } from "#src/lib/workflow-ui-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  overlappingRunsSentence,
  startSentences,
  stopClauses,
} from "@wfgraph/shared/graph/workflow-summary";
import {
  initialLifecycleRules,
  type LifecycleRules,
  manualStartAllowed,
  readLifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { lowerFirst } from "es-toolkit/string";
import {
  lifecycleIssueSection,
  lifecycleRuleTargetId,
} from "./lifecycle-reveal-model";
import type { RevealBodyProps } from "./reveal-kinds";
import { NodeIssueList, Section } from "./reveal-sections";

const EMPTY_CONFIG: Record<string, unknown> = {};

/** The Lifecycle Node's label, which writes to the graph store as it is typed. */
function LifecycleLabelField({ node }: { node: WorkflowNode }) {
  const isGenerating = useAtomValue(isGeneratingAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const canUpdate = can(WfGraphOperations.workflowUpdate.id);
  return (
    <div className="space-y-2">
      <Label htmlFor="label">Label</Label>
      <Input
        disabled={isGenerating || !canUpdate}
        id="label"
        onChange={(event) =>
          updateNodeData({ id: node.id, data: { label: event.target.value } })
        }
        value={node.data.label}
      />
    </div>
  );
}

/**
 * The Lifecycle Node's editor: the Start's one form, then its label after a
 * divider, then any issue no rule on screen shows. It is the Inspector's body at `md` and wider and the phone's
 * full-screen inspector, so both show the same form. Focus moves into a rule
 * a person adds through the shell's field request, which scrolls only when the
 * rule is out of view.
 */
function LifecycleEditorBody({
  node,
  focusField,
}: {
  node: WorkflowNode;
  focusField: RevealBodyProps["focusField"];
}) {
  const isGenerating = useAtomValue(isGeneratingAtom);
  const { updateConfig } = useNodeConfigWriter(node.id);
  const disabled = isGenerating || !can(WfGraphOperations.workflowUpdate.id);
  return (
    <FieldIssuesProvider nodeId={node.id}>
      <div className="space-y-5 p-4">
        <LifecyclePanel
          config={node.data.config ?? EMPTY_CONFIG}
          disabled={disabled}
          focusTarget={focusField}
          onUpdateConfig={updateConfig}
        />
        <Separator />
        <LifecycleLabelField node={node} />
        <UnclaimedFieldIssues />
      </div>
    </FieldIssuesProvider>
  );
}

/**
 * The Lifecycle Node's editor, keyed to the node so the form's pickers start
 * clean for each Lifecycle Node.
 */
export function LifecycleEditor({ subject, focusField }: RevealBodyProps) {
  const nodes = useAtomValue(nodesAtom);
  const node = nodes.find((item) => item.id === subject.nodeId);
  return node ? (
    <LifecycleEditorBody focusField={focusField} key={node.id} node={node} />
  ) : null;
}

/**
 * What the start has set, one sentence each: what starts a run, whether a
 * person may also run it by hand, what an overlapping run does, what stops a
 * run, and the tracked Entity with its eligibility rule.
 */
function lifecycleSummarySentences(
  rules: LifecycleRules,
  catalog: ExtensionCatalog
): string[] {
  const sentences = [...startSentences(rules, catalog)];
  if (
    manualStartAllowed(rules) &&
    (rules.startEvents.length > 0 || (rules.schedules?.length ?? 0) > 0)
  ) {
    sentences.push("Someone can also run it by hand.");
  }
  const overlap = overlappingRunsSentence(rules, catalog);
  if (overlap !== null) {
    sentences.push(overlap);
  }
  for (const clause of stopClauses(rules, catalog)) {
    sentences.push(
      `${clause.subject} stops a run in progress${clause.condition === null ? "" : `, if ${clause.condition}`}.`
    );
  }
  const entity = trackedEntityLabel(rules, catalog);
  if (entity !== null) {
    sentences.push(`One run per ${lowerFirst(entity)}.`);
    if (rules.entityEligibility) {
      sentences.push(`Only while the ${lowerFirst(entity)} matches its rule.`);
    }
  }
  return sentences;
}

/**
 * The phone's summary sheet of the Lifecycle Node: what the start has set as
 * plain sentences, and its issues. The sheet header's **Edit start** opens the
 * form full screen, and an issue opens it at the rule the issue is about.
 */
export function LifecycleSummarySheet({
  subject,
  focusField,
}: RevealBodyProps) {
  const nodes = useAtomValue(nodesAtom);
  const issues = useAtomValue(workflowIssuesAtom);
  const catalog = useExtensionCatalog();
  const node = nodes.find((item) => item.id === subject.nodeId);
  if (!node) {
    return null;
  }
  const rules = readLifecycleRules(node.data.config) ?? initialLifecycleRules;
  const nodeIssues = issues.filter((issue) => issue.nodeId === node.id);
  return (
    <div className="pb-4">
      <Section title="Rules">
        <ul className="space-y-1.5 text-sm">
          {lifecycleSummarySentences(rules, catalog).map((sentence) => (
            <li key={sentence}>{sentence}</li>
          ))}
        </ul>
      </Section>
      <Section title="Validation">
        <NodeIssueList
          issues={nodeIssues}
          onSelect={(_fieldKey, issue) => {
            const section = lifecycleIssueSection(issue);
            focusField(
              section === null ? undefined : lifecycleRuleTargetId(section)
            );
          }}
        />
      </Section>
    </div>
  );
}

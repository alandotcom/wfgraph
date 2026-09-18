import { useQuery } from "@tanstack/react-query";
import { useAtomValue, useSetAtom } from "jotai";
import { compact } from "es-toolkit/array";
import { useMemo } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import { ConditionSummary } from "#src/components/workflow/config/condition-summary";
import { NodePropertiesForm } from "#src/components/workflow/node-properties-form";
import { NodeControls } from "#src/components/workflow/step-controls";
import { can } from "#src/lib/authorization";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import { getEventConditionFields } from "#src/lib/upstream-node-fields";
import { nodesAtom, updateNodeDataAtom } from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import { isGeneratingAtom } from "#src/lib/workflow-ui-store";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { parseConditionModel } from "@wfgraph/shared/conditions/conditions";
import {
  findAction,
  findEvent,
  findIntegration,
} from "@wfgraph/shared/extensions/catalog";
import { readConfigString } from "@wfgraph/shared/graph/node-config";
import { readWaitSubscriptions } from "@wfgraph/shared/lifecycle/wait-subscription";
import type { RevealBodyProps } from "./reveal-kinds";
import { NodeIssueList, Section } from "./reveal-sections";
import {
  type SummaryRow,
  summarizeActionFields,
  summarizeWait,
} from "./step-summary";

function SummaryRows({ rows }: { rows: readonly SummaryRow[] }) {
  return (
    <dl className="space-y-1.5">
      {rows.map((row) => (
        <div
          className="flex items-baseline justify-between gap-3"
          key={row.key}
        >
          <dt className="shrink-0 text-muted-foreground text-xs">
            {row.label}
            {row.required ? <span aria-hidden> *</span> : null}
          </dt>
          <dd
            className={
              row.value === null
                ? "text-muted-foreground text-xs"
                : "min-w-0 truncate text-right text-xs"
            }
            title={row.value ?? undefined}
          >
            {row.value ?? "Not set"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The Events an event-mode Wait resumes on, each with its match as a sentence. */
function WaitEventsSummary({ node }: { node: WorkflowNode }) {
  const catalog = useExtensionCatalog();
  const nodes = useAtomValue(nodesAtom);
  const subscriptions = readWaitSubscriptions(node.data.config);
  if (subscriptions.length === 0) {
    return <p className="text-muted-foreground text-xs">No event chosen.</p>;
  }
  return (
    <ul className="space-y-2">
      {subscriptions.map((subscription) => {
        const parsed = subscription.match
          ? parseConditionModel(subscription.match)
          : null;
        return (
          <li className="space-y-1" key={subscription.event}>
            <p className="text-sm">
              {findEvent(catalog, subscription.event)?.label ??
                subscription.event}
            </p>
            {parsed?.valid ? (
              <div className="border-l pl-3">
                <ConditionSummary
                  compact
                  fields={getEventConditionFields(
                    catalog,
                    subscription.event,
                    nodes
                  )}
                  model={parsed.model}
                />
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">
                {subscription.match
                  ? "The match can't be read. Open the editor to fix it."
                  : "Any arrival resumes the run."}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Browse for an ordinary step: an editable label, the step's action and
 * connection, its settings as label and value pairs, its validation issues, and
 * its node controls. An issue opens Focus on the field it names.
 * A step with no action chosen shows the action picker.
 */
export function StepBrowse({ subject, frame, openFocus }: RevealBodyProps) {
  const catalog = useExtensionCatalog();
  const nodes = useAtomValue(nodesAtom);
  const issues = useAtomValue(workflowIssuesAtom);
  const isGenerating = useAtomValue(isGeneratingAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const canUpdate = can(WfGraphOperations.workflowUpdate.id);
  const { data: connections } = useQuery({
    ...integrationsQueryOptions(),
    enabled: can(WfGraphOperations.integrationGetAll.id),
  });
  const { nodeId } = subject;
  const node = nodes.find((item) => item.id === nodeId);
  const config = useMemo(() => node?.data.config ?? {}, [node]);
  if (!node || nodeId === null) {
    return null;
  }
  const actionType = readConfigString(config, "actionType");
  if (!actionType) {
    return <NodePropertiesForm frame={frame} nodeId={nodeId} />;
  }

  const action = findAction(catalog, actionType);
  const integration = action?.integration
    ? findIntegration(catalog, action.integration)
    : undefined;
  const connectionId = readConfigString(config, "integrationId");
  const connection = connections?.find((item) => item.id === connectionId);
  const nodeIssues = issues.filter((issue) => issue.nodeId === nodeId);
  const isWait = actionType === BUILT_IN_ACTION_IDS.wait;
  const disabled = isGenerating || !canUpdate;

  return (
    <div className="pb-4">
      <Section title="Label">
        <Label className="sr-only" htmlFor="reveal-step-label">
          Label
        </Label>
        <Input
          disabled={disabled}
          id="reveal-step-label"
          onChange={(event) =>
            updateNodeData({ id: nodeId, data: { label: event.target.value } })
          }
          value={node.data.label}
        />
      </Section>

      <Section title="Action">
        <p className="text-sm">
          {compact([
            integration?.label ?? action?.category,
            action?.label ?? actionType,
          ]).join(" · ")}
        </p>
        {integration ? (
          <p className="text-muted-foreground text-xs">
            Connection:{" "}
            {connection
              ? connection.name || `${integration.label} API Key`
              : "Not set"}
          </p>
        ) : null}
      </Section>

      {isWait ? (
        <Section title="Wait">
          <SummaryRows rows={summarizeWait(config)} />
          {readConfigString(config, "waitMode") === "event" ? (
            <div className="pt-2">
              <h4 className="pb-1 font-medium text-xs">Continue when</h4>
              <WaitEventsSummary node={node} />
            </div>
          ) : null}
        </Section>
      ) : action && action.configFields.length > 0 ? (
        <Section title="Settings">
          <SummaryRows
            rows={summarizeActionFields(action.configFields, config)}
          />
        </Section>
      ) : null}

      <Section title="Validation">
        <NodeIssueList issues={nodeIssues} onSelect={openFocus} />
      </Section>

      <NodeControls className="border-t px-4 pt-3" frame={frame} node={node} />
    </div>
  );
}

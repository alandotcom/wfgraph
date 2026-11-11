/**
 * The operations each authoring tool requires of its caller.
 *
 * One table for both doors into the toolkit: the MCP endpoint refuses a call
 * its caller lacks a grant for, and a chat turn hands the model a toolkit whose
 * ungranted tools answer a refusal. Every tool reads the workflow, a write tool
 * changes it, and `list_integrations` reveals the operator's Connection ids,
 * which is `integration.getAll`'s to grant.
 */

import { uniq } from "es-toolkit/array";
import { agentToolkit, WRITE_TOOL_NAMES } from "@wfgraph/agent/toolkit";
import {
  type WfGraphOperation,
  WfGraphOperations,
} from "@wfgraph/shared/authorization/operations";

export type AgentToolName = keyof typeof agentToolkit.tools;

export function agentToolOperations(
  name: AgentToolName
): readonly WfGraphOperation[] {
  return [
    WfGraphOperations.workflowGetById,
    ...(WRITE_TOOL_NAMES.has(name) ? [WfGraphOperations.workflowUpdate] : []),
    ...(name === "list_integrations"
      ? [WfGraphOperations.integrationGetAll]
      : []),
  ];
}

/** The tools a caller may not call, given the operations it is granted. */
export async function deniedAgentTools(
  allows: (operation: WfGraphOperation) => Promise<boolean>
): Promise<ReadonlySet<AgentToolName>> {
  const names = Object.values(agentToolkit.tools).map((tool) => tool.name);
  const operations = uniq(names.flatMap((name) => agentToolOperations(name)));
  const grants = new Map(
    await Promise.all(
      operations.map(
        async (operation) => [operation, await allows(operation)] as const
      )
    )
  );
  return new Set(
    names.filter((name) =>
      agentToolOperations(name).some((operation) => !grants.get(operation))
    )
  );
}

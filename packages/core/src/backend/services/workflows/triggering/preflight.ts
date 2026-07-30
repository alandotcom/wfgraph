import { Effect } from "effect";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import { Extensions } from "#src/backend/lib/effect/extensions";
import {
  IntegrationValidationFailed,
  InvalidInput,
  NotFound,
} from "#src/backend/lib/effect/failures";
import { validateWorkflowActionConfigs } from "#src/backend/lib/workflow-action-validation";
import { validateWorkflowConditionConfigs } from "#src/backend/lib/workflow-conditions-validation";
import { validateWorkflowGraph } from "#src/backend/lib/workflow-graph";
import { validateWorkflowIntegrations } from "#src/backend/lib/workflow-integration-validation";
import { validateWorkflowLifecycleRules } from "#src/backend/lib/workflow-lifecycle-validation";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import {
  type LifecycleRules,
  readLifecycleRules,
} from "@rova/shared/workflow/lifecycle-rules";
import type {
  SerializedWorkflowGraph,
  WorkflowNode,
} from "@rova/shared/workflow/types";

type WorkflowForPreflight = {
  name: string;
  graph: unknown;
};

export type WorkflowExecutionPreflight = {
  workflowGraph: SerializedWorkflowGraph;
  workflowNodes: WorkflowNode[];
  /** The entry node's Lifecycle Rules, absent when it carries none. */
  lifecycleRules: LifecycleRules | undefined;
};

/**
 * Everything that has to hold before a stored graph is allowed to run: it
 * parses, its actions and conditions are configured, the integrations it names
 * exist, and its Lifecycle Rules name Events the app still defines.
 *
 * Nothing is logged here, and the refusals carry the sentence instead. One caller
 * is an entrypoint answering a person, where a refused run is an error worth
 * seeing; the other is an Event's fan-out, where the same broken graph would be
 * refused once per delivered Event and fill the error stream with a fact one
 * builder already knows. Each logs it its own way.
 */
export const runWorkflowExecutionPreflight = Effect.fn(
  "runWorkflowExecutionPreflight"
)(function* (input: { workflow: WorkflowForPreflight }) {
  const { workflow } = input;
  const { catalog } = yield* Extensions;

  const graphValidation = validateWorkflowGraph(workflow.graph);
  if (!graphValidation.valid) {
    return yield* Effect.fail(
      new InvalidInput({ error: "Workflow graph is invalid" })
    );
  }

  const actionValidation = validateWorkflowActionConfigs(
    graphValidation.nodes,
    catalog
  );
  if (!actionValidation.valid) {
    return yield* Effect.fail(
      new InvalidInput({ error: actionValidation.error })
    );
  }

  const conditionValidation = validateWorkflowConditionConfigs(
    graphValidation.nodes
  );
  if (!conditionValidation.valid) {
    return yield* Effect.fail(
      new InvalidInput({ error: conditionValidation.error })
    );
  }

  const lifecycleValidation = validateWorkflowLifecycleRules(
    graphValidation.nodes,
    catalog
  );
  if (!lifecycleValidation.valid) {
    return yield* Effect.fail(
      new InvalidInput({ error: lifecycleValidation.error })
    );
  }

  // The only way this fails is the integration rows it reads, so a rejected
  // query arrives here as the same database failure a repository answers with.
  // It is last because it is the one check that costs a query.
  const integrations = yield* IntegrationRepo;
  const integrationValidation = yield* validateWorkflowIntegrations(
    graphValidation.nodes,
    catalog,
    integrations.typesByIds
  );
  if (!integrationValidation.valid) {
    return yield* Effect.fail(
      new IntegrationValidationFailed({
        error: "Workflow contains invalid integration references",
        invalidIntegrationIds: integrationValidation.invalidIds,
      })
    );
  }

  const lifecycleNode = graphValidation.nodes.find(
    (node) => node.data.type === "trigger"
  );

  const preflight: WorkflowExecutionPreflight = {
    workflowGraph: graphValidation.graph,
    workflowNodes: graphValidation.nodes,
    lifecycleRules: readLifecycleRules(lifecycleNode?.data.config),
  };
  return preflight;
});

/**
 * The prelude the execute route needs: find the workflow it names, then check
 * that it may run. Either step's refusal is the answer the caller gets, so
 * neither is handled here.
 *
 * The Event fan-out does not use this: it has the workflow's identity from the
 * subscription index already, and it turns a refusal into a skipped workflow
 * rather than into a failure a caller reads.
 */
export const loadWorkflowForRun = Effect.fn("loadWorkflowForRun")(function* (
  workflowId: string
) {
  const repo = yield* WorkflowRepo;
  const workflow = yield* repo.findById(workflowId);

  if (!workflow) {
    return yield* Effect.fail(new NotFound({ error: "Workflow not found" }));
  }

  const preflight = yield* runWorkflowExecutionPreflight({ workflow });

  return { workflow, preflight };
});

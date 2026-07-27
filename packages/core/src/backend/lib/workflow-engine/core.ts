/**
 * Workflow executor used by Inngest runtime.
 * Keeps node execution, templating, and logging behavior aligned with the builder.
 */

import { isNil } from "es-toolkit/predicate";
import { omitBy } from "es-toolkit/object";
import { evaluateCelBooleanExpression } from "@/backend/lib/cel/environment";
import { getAppLogger } from "@/backend/lib/logger";
import {
  getActionLabel,
  getStepImporter,
  loadStepFunction,
  type StepImporter,
} from "@/backend/lib/step-registry";
import type { StepContext } from "@/backend/lib/steps/step-handler";
import { triggerStep } from "@/backend/lib/steps/trigger";
import { withSpan } from "@/backend/lib/telemetry";
import {
  decodeIsoTimestamp,
  encodeIsoTimestamp,
} from "@/shared/types/timestamp";
import {
  type JsonObject,
  type JsonValue,
  readJsonValue,
} from "@/shared/types/json";
import { getErrorMessageAsync } from "@/shared/utils";
import { resolveWaitUntil } from "@/shared/utils/wait-time";
import { normalizeConditionBranch } from "@/shared/workflow/condition-branch";
import {
  collectTimestampFieldPaths,
  parseConditionModel,
} from "@/shared/workflow/conditions";
import { toWorkflowGraphData } from "@/shared/workflow/graph";
import {
  parseTemplate,
  resolveOutputPath,
  type TemplateToken,
  unwrapStepOutput,
} from "@/shared/workflow/node-references";
import { validateWorkflowOutputAgainstSchema } from "@/shared/workflow/schema-validation";
import type { StepResult } from "@/shared/workflow/step-result";
import {
  evaluateWorkflowTrigger,
  resolveWorkflowTriggerDefinition,
} from "@/shared/workflow/trigger-registry";
import { resolveWebhookTriggerRuntimeConfig } from "@/shared/workflow/triggers/webhook-trigger";
import type {
  ConditionBranch,
  SerializedWorkflowGraph,
  WorkflowEdge,
  WorkflowNode,
} from "@/shared/workflow/types";
import {
  createInMemoryWorkflowRuntime,
  type WorkflowExecutionRuntime,
} from "./runtime";
import { noopWorkflowStore, type WorkflowStore } from "./store";

export type { WorkflowExecutionRuntime } from "./runtime";
export type { WorkflowStore } from "./store";

/**
 * Action type of the built-in Wait step. The executor dispatches on this value
 * to reach `executeWaitAction`, and the same check keeps Wait nodes out of the
 * node-level step wrapper (Wait suspends the run, and Inngest forbids a sleep
 * or a wait inside a step).
 */
const WAIT_ACTION_TYPE = "Wait";

/**
 * Built-in actions dispatched by export name, the same way a plugin step is.
 *
 * Condition and Wait are built-in too but are absent here: the engine calls
 * both directly, because it evaluates the condition expression itself and the
 * wait suspends the run through the durable runtime.
 */
const SYSTEM_ACTIONS: Record<string, StepImporter> = {
  "Database Query": {
    importer: () => import("@/backend/lib/steps/database-query"),
    stepFunction: "databaseQueryStep",
  },
  "HTTP Request": {
    importer: () => import("@/backend/lib/steps/http-request"),
    stepFunction: "httpRequestStep",
  },
};

type ExecutionResult = {
  success: boolean;
  data?: unknown;
  error?: string;
  haltBranch?: boolean;
};

/**
 * What each finished node left behind, keyed by node id.
 *
 * `data` is JSON because it has already crossed a serialization boundary by the
 * time anything reads it: Inngest memoizes a step's return value between steps,
 * and a resumed run reads back what it decoded. Saying so here is what lets the
 * template resolver and the CEL context walk a value with plain language checks
 * rather than a hand-rolled shape predicate.
 */
type NodeOutputs = Record<string, { label: string; data: JsonValue }>;

/**
 * What a node's memoized work reports back to the traversal. It travels through
 * the durable runtime (and therefore through JSON), so it carries only the
 * routing facts the scheduler needs, never live objects or callbacks.
 */
type NodeWorkOutcome = {
  result: ExecutionResult;
  /** Action node without an actionType: recorded as failed, no output stored. */
  unconfigured?: boolean;
  /**
   * Trigger routing decided this event is none of the workflow's business, so
   * the branch below the trigger stays unrun.
   */
  triggerIgnored?: boolean;
  /**
   * The branch a Condition node picked. Absent on every other node, and absent
   * on a disabled Condition node, which evaluated nothing and therefore fans
   * out to every branch below it.
   */
  conditionValue?: boolean;
};

export type WorkflowExecutionInput = {
  graph: SerializedWorkflowGraph;
  /**
   * The payload that set this run going: a webhook body, a manual-run input, or
   * the data on an Inngest event. It reached the engine as JSON and is written
   * back out as JSON into `workflow_executions.input`.
   */
  triggerInput?: JsonObject;
  /** The untouched payload as it arrived, before any mock request filled in. */
  requestPayload?: JsonObject;
  /**
   * Identifies the run row every log, timeline event, and wait state hangs off.
   * Required: whether a run leaves a trace is decided by which `WorkflowStore`
   * the caller injects, never by omitting an id here.
   */
  executionId: string;
  /** Owning workflow. Also how steps look up integration credentials. */
  workflowId: string;
  workflowName?: string;
  workflowRunId?: string;
  runMode?: "live" | "test";
  eventContext?: {
    eventType?: string;
    correlationKey?: string;
  };
};

const workflowExecutorLogger = getAppLogger("workflow", "executor");
const conditionLogger = workflowExecutorLogger.getChild("condition");

type ConditionEvalResult = {
  result: boolean;
};

function readConfigString(
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = config?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Opens a step-log row around a runtime-extension action, then closes it with
 * the outcome. Plugin and system steps do their own logging inside the step
 * module; runtime actions have no such wrapper, so the engine logs them here.
 *
 * Routed through the store port rather than the database helpers directly, so
 * the engine stays free of db imports and tests can assert on a recording
 * store. A logging failure must never fail the step it is describing, so every
 * write is best-effort.
 */
async function withStoreStepLogging(
  store: WorkflowStore,
  context: StepContext,
  // Runtime actions may be written sync or async; accept either.
  runStep: () => StepResult | Promise<StepResult>
): Promise<StepResult> {
  const { executionId } = context;
  // No execution to attach rows to (a store that persists still needs an id).
  const handle = executionId
    ? await store
        .startStepLog({
          executionId,
          nodeId: context.nodeId,
          nodeName: context.nodeName,
          nodeType: context.nodeType,
          // Matches the previous wrapper, which stripped every internal field
          // and so logged an empty input for this path.
          input: {},
        })
        .catch(() => undefined)
    : undefined;

  const complete = async (
    status: "success" | "error",
    output?: unknown,
    error?: string
  ) => {
    if (!handle?.logId) {
      return;
    }
    await store
      .completeStepLog({ ...handle, status, output, error })
      .catch(() => undefined);
  };

  try {
    const result = await runStep();

    if (result.success) {
      // A success logs its payload. An action that reports success and nothing
      // else leaves only the wrapper to log.
      await complete("success", "data" in result ? result.data : result);
    } else {
      await complete("error", result.error, result.error.message);
    }

    return result;
  } catch (error) {
    await complete("error", undefined, await getErrorMessageAsync(error));
    throw error;
  }
}

function getConditionNextNodeIds(input: {
  edges: WorkflowEdge[];
  branch: ConditionBranch;
}): string[] {
  return input.edges
    .filter(
      (edge) => normalizeConditionBranch(edge.sourceHandle) === input.branch
    )
    .map((edge) => edge.target);
}

/**
 * Fold one node's output into the flat namespace a CEL condition reads from.
 *
 * Steps return their fields inside a `{ success, data }` wrapper, and a condition
 * names those fields bare (`donorId == "abc"`), so the output goes through the same
 * unwrapping a template token gets before its keys are lifted into the context.
 *
 * Known hazard, deliberately left alone: the namespace is flat across every node,
 * so two nodes that both produce a field called `id` collide, and the node that
 * runs later wins. Node-qualifying the context would need a migration over stored
 * graphs, which persist both the compiled CEL string and the structured rules.
 */
function mergeConditionContextValue(
  context: Record<string, unknown>,
  value: JsonValue
) {
  const record = unwrapStepOutput(value);
  // A node output is JSON that came back from a plugin's own API call, so its
  // shape belongs to that API and nothing here knows it. Only a keyed object
  // contributes names: copying a string or an array would spread index keys
  // into the namespace and let a condition read `0`.
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return;
  }

  Object.assign(context, record);

  const nestedInput = Reflect.get(record, "input");
  if (
    typeof nestedInput !== "object" ||
    nestedInput === null ||
    Array.isArray(nestedInput)
  ) {
    return;
  }

  for (const key of Object.keys(nestedInput)) {
    if (!(key in context)) {
      context[key] = Reflect.get(nestedInput, key);
    }
  }
}

/**
 * Read a dotted field path out of the condition context.
 *
 * Paths come from the condition model, where the user picked them off a schema,
 * so a path that finds nothing here means the payload did not carry that field
 * on this run.
 */
function readContextPath(
  context: Record<string, unknown>,
  path: string
): { parent: object; key: string; value: unknown } | null {
  const segments = path.split(".");
  const key = segments.pop();
  if (!key) {
    return null;
  }

  let parent: object = context;
  for (const segment of segments) {
    const next: unknown = Reflect.get(parent, segment);
    // Only a keyed object can hold the rest of the path. An array stops the
    // walk: a condition field names a property, never an index.
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      return null;
    }
    parent = next;
  }

  return { parent, key, value: Reflect.get(parent, key) };
}

/**
 * Turn the fields a condition treats as timestamps into `Date`s.
 *
 * Node outputs are JSON, so a timestamp reaches this context as an ISO string,
 * and CEL refuses to compare a string against a Timestamp: without this step
 * `appointment.startsAt > now` fails to evaluate and the branch silently reads
 * false. The Condition node's own model names the paths it treats as
 * timestamps, so those paths, and nothing else, are converted. Values the
 * templating path reads are untouched, because that path renders text and wants
 * the string exactly as the payload sent it.
 *
 * A path that is missing, already a `Date`, or holding text that is not a
 * timestamp is left as found, and the expression then fails the way it would
 * have anyway, naming the field in its error.
 */
function decodeConditionTimestamps(
  context: Record<string, unknown>,
  paths: string[]
) {
  for (const path of paths) {
    const located = readContextPath(context, path);
    if (!located || typeof located.value !== "string") {
      continue;
    }

    const decoded = decodeIsoTimestamp(located.value);
    if (decoded) {
      Reflect.set(located.parent, located.key, decoded);
    }
  }
}

/**
 * The timestamp field paths a Condition node's stored model declares.
 *
 * Saving a workflow rejects a Condition node whose model is missing or does not
 * compile to the expression beside it, so a model that fails to parse here
 * belongs to a node that never should have run; the condition still evaluates,
 * against a context where timestamps stay strings.
 */
function readConditionTimestampPaths(conditionModel: unknown): string[] {
  const parsed = parseConditionModel(conditionModel);
  if (!parsed.valid) {
    conditionLogger.warn("Condition model did not parse", {
      error: parsed.error,
    });
    return [];
  }

  return collectTimestampFieldPaths(parsed.model);
}

/**
 * Evaluate CEL condition expression against workflow output context.
 */
function evaluateConditionExpression(
  conditionExpression: unknown,
  outputs: NodeOutputs,
  conditionModel: unknown
): ConditionEvalResult {
  conditionLogger.debug("Evaluating condition expression", {
    conditionExpression,
  });

  if (typeof conditionExpression === "boolean") {
    return { result: conditionExpression };
  }

  if (typeof conditionExpression !== "string") {
    conditionLogger.warn("Condition is neither boolean nor string", {
      conditionExpression,
    });
    return { result: false };
  }

  const expression = conditionExpression.trim();
  if (!expression) {
    return { result: false };
  }

  const evalContext: Record<string, unknown> = { now: new Date() };
  for (const output of Object.values(outputs)) {
    mergeConditionContextValue(evalContext, output.data);
  }
  decodeConditionTimestamps(
    evalContext,
    readConditionTimestampPaths(conditionModel)
  );

  const evaluation = evaluateCelBooleanExpression({
    expression,
    context: evalContext,
  });

  if (!evaluation.ok) {
    conditionLogger.error("CEL condition evaluation failed", {
      error: evaluation.error,
      conditionExpression,
    });
    return { result: false };
  }

  return { result: evaluation.value };
}

/**
 * What the action dispatch hands back to the traversal.
 *
 * Every action answers with a `StepResult`. A Condition node also reports the
 * branch it picked: the engine evaluates the expression here, so the boolean is
 * already in hand and the traversal never has to read it back out of the
 * payload the step logged.
 */
type ActionStepOutcome = {
  result: StepResult;
  conditionValue?: boolean;
};

/**
 * Execute a single action step with logging via stepHandler
 * IMPORTANT: Steps receive only the integration ID as a reference to fetch credentials.
 * This prevents credentials from being logged in Vercel's workflow observability.
 */
function executeActionStep(input: {
  actionType: string;
  config: Record<string, unknown>;
  outputs: NodeOutputs;
  context: StepContext;
  store: WorkflowStore;
}): Promise<ActionStepOutcome> {
  return withSpan(
    "rova.workflow.action.execute",
    {
      "rova.action.type": input.actionType,
      "rova.node.id": input.context.nodeId,
      "rova.node.name": input.context.nodeName,
    },
    () => executeActionStepInner(input)
  );
}

async function executeActionStepInner(input: {
  actionType: string;
  config: Record<string, unknown>;
  outputs: NodeOutputs;
  context: StepContext;
  store: WorkflowStore;
}): Promise<ActionStepOutcome> {
  const { actionType, config, outputs, context, store } = input;
  const integrationId = readConfigString(config, "integrationId");

  // Build step input WITHOUT credentials, but WITH integrationId reference and logging context
  const stepInput: Record<string, unknown> = {
    ...config,
    _context: context,
  };

  // The Condition action evaluates its expression here, against the outputs of
  // the nodes upstream. The step it calls records the decision in the run log,
  // and the boolean travels back beside that record for the traversal to route
  // on.
  if (actionType === "Condition") {
    const { conditionStep } = await import("@/backend/lib/steps/condition");
    const originalExpression = stepInput.condition;
    const { result: evaluatedCondition } = evaluateConditionExpression(
      originalExpression,
      outputs,
      config.conditionModel
    );
    conditionLogger.debug("Condition evaluation result", {
      evaluatedCondition,
    });

    return {
      result: await conditionStep({
        condition: evaluatedCondition,
        // Include original expression for step logs.
        expression:
          typeof originalExpression === "string"
            ? originalExpression
            : undefined,
        _context: context,
      }),
      conditionValue: evaluatedCondition,
    };
  }

  // Check system actions first (Database Query, HTTP Request)
  const systemAction = SYSTEM_ACTIONS[actionType];
  if (systemAction) {
    const stepFunction = await loadStepFunction(systemAction);
    if (!stepFunction) {
      return {
        result: {
          success: false,
          error: {
            message: `Step function "${systemAction.stepFunction}" not found for action "${actionType}".`,
          },
        },
      };
    }
    return { result: await stepFunction(stepInput) };
  }

  // Look up plugin action from the generated step registry
  const stepImporter = getStepImporter(actionType);
  if (stepImporter) {
    if (typeof stepImporter.execute === "function") {
      const {
        actionType: _ignoredActionType,
        integrationId: _ignoredIntegrationId,
        ...runtimeActionPayload
      } = config;

      const executeFn = stepImporter.execute;
      return {
        result: await withStoreStepLogging(store, context, () =>
          executeFn({
            payload: runtimeActionPayload,
            context: {
              ...context,
              integrationId,
            },
          })
        ),
      };
    }

    const stepFunction = await loadStepFunction(stepImporter);
    if (stepFunction) {
      return { result: await stepFunction(stepInput) };
    }

    return {
      result: {
        success: false,
        error: {
          message: `Step function "${stepImporter.stepFunction}" not found in module for action "${actionType}". Check that the plugin exports the correct function name.`,
        },
      },
    };
  }

  // Fallback for unknown action types
  return {
    result: {
      success: false,
      error: {
        message: `Unknown action type: "${actionType}". This action is not registered in the plugin system. Available system actions: ${Object.keys(SYSTEM_ACTIONS).join(", ")}.`,
      },
    },
  };
}

/**
 * Render a resolved value back into the surrounding template string. Objects and
 * arrays become JSON so a whole node output can be dropped into a text field.
 * A missing value renders as empty text, which is what an upstream node that was
 * disabled or that failed to produce the field leaves behind.
 */
function stringifyTemplateValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return `${value}`;
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  return "";
}

function resolveTemplateToken(
  token: TemplateToken,
  outputs: NodeOutputs
): string {
  // Outputs are keyed by a sanitized node id (see where they are stored below).
  const output = outputs[token.nodeId.replace(/[^a-zA-Z0-9]/g, "_")];
  if (!output) {
    // The token names a node that has not run, so the authored text stays put.
    return token.raw;
  }

  return stringifyTemplateValue(
    resolveOutputPath(output.data, token.fieldPath)
  );
}

/**
 * Replace every `{{@nodeId:Label.field}}` reference in the config's string values
 * with the upstream value it names.
 *
 * Both the grammar and the path walking come from `node-references`, the module
 * the editor's autocomplete builds its suggestions with, so a path it offers
 * (`items[0].name`, say) resolves to the same value here at run time.
 */
function processTemplates(
  config: Record<string, unknown>,
  outputs: NodeOutputs
): Record<string, unknown> {
  const processed: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== "string") {
      processed[key] = value;
      continue;
    }

    processed[key] = parseTemplate(value)
      .map((segment) =>
        segment.kind === "literal"
          ? segment.text
          : resolveTemplateToken(segment.token, outputs)
      )
      .join("");
  }

  return processed;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function generateWaitToken(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function escapeCelString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function isCancellationError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("cancel") ||
    message.includes("cancelled") ||
    message.includes("canceled")
  );
}

type WaitActionInput = {
  config: Record<string, unknown>;
  context: StepContext;
  runtime: WorkflowExecutionRuntime;
  store: WorkflowStore;
  executionId: string;
  workflowId: string;
  workflowRunId?: string;
  eventContext?: {
    eventType?: string;
    correlationKey?: string;
  };
};

/**
 * Wait context shared by the delay and hook branches.
 */
type WaitBranchContext = {
  config: Record<string, unknown>;
  context: StepContext;
  runtime: WorkflowExecutionRuntime;
  store: WorkflowStore;
  executionId: string;
  workflowId: string;
  runId: string;
  waitMode: "delay" | "hook" | "event";
  correlationKey?: string;
  /** Memoized "step started" log row reused by every branch below. */
  startLog: { logId: string; startTime: number };
};

function readWaitTimezone(config: Record<string, unknown>): string | undefined {
  return typeof config.waitTimezone === "string"
    ? config.waitTimezone
    : undefined;
}

function readWaitGateMode(
  config: Record<string, unknown>
): "require_actual_wait" | "off" {
  return config.waitGateMode === "require_actual_wait"
    ? "require_actual_wait"
    : "off";
}

function readAllowedHoursConfig(config: Record<string, unknown>) {
  return {
    waitAllowedHoursMode: config.waitAllowedHoursMode,
    waitAllowedStartTime: config.waitAllowedStartTime,
    waitAllowedEndTime: config.waitAllowedEndTime,
  };
}

function executeWaitAction(input: WaitActionInput): Promise<ExecutionResult> {
  const waitModeRawOuter =
    typeof input.config.waitMode === "string"
      ? input.config.waitMode.trim()
      : "";
  const waitTypeOuter =
    waitModeRawOuter === "hook" || waitModeRawOuter === "event"
      ? "hook"
      : "delay";

  return withSpan(
    "rova.workflow.wait",
    {
      "rova.wait.type": waitTypeOuter,
      "rova.node.id": input.context.nodeId,
      "rova.node.name": input.context.nodeName,
    },
    () => executeWaitActionInner(input)
  );
}

async function executeWaitActionInner(
  input: WaitActionInput
): Promise<ExecutionResult> {
  const {
    config,
    context,
    runtime,
    store,
    executionId,
    workflowId,
    workflowRunId,
    eventContext,
  } = input;

  const waitModeRaw =
    typeof config.waitMode === "string" ? config.waitMode.trim() : "";
  const waitMode: "delay" | "hook" | "event" =
    waitModeRaw === "hook" || waitModeRaw === "event" ? waitModeRaw : "delay";

  const runId = workflowRunId || runtime.runId || executionId;

  if (waitMode === "event" && !eventContext?.correlationKey) {
    const errorMessage =
      "Wait mode 'event' requires a correlation key from the trigger. Ensure the workflow trigger has a correlation path configured.";

    // Both log rows are one durable unit so a replay does not duplicate them.
    await runtime.step(
      `wait-missing-correlation-${context.nodeId}`,
      async () => {
        const earlyLog = await store.startStepLog({
          executionId,
          nodeId: context.nodeId,
          nodeName: context.nodeName,
          nodeType: "Wait",
          input: { waitMode },
        });
        await store.completeStepLog({
          logId: earlyLog.logId,
          startTime: earlyLog.startTime,
          status: "error",
          error: errorMessage,
        });
        return { logged: true };
      }
    );

    return {
      success: false,
      error: errorMessage,
    };
  }

  // The "step started" row is written once and its id is replayed from the
  // memoized step return, so the branches below always close the same row.
  const startLog = await runtime.step(`wait-start-log-${context.nodeId}`, () =>
    store.startStepLog({
      executionId,
      nodeId: context.nodeId,
      nodeName: context.nodeName,
      nodeType: "Wait",
      input: {
        waitMode,
        waitDuration: config.waitDuration,
        waitUntil: config.waitUntil,
        waitOffset: config.waitOffset,
        waitTimezone: readWaitTimezone(config),
        waitGateMode: readWaitGateMode(config),
        ...readAllowedHoursConfig(config),
        waitForEvents: config.waitForEvents,
        waitTimeout: config.waitTimeout,
      },
    })
  );

  const branch: WaitBranchContext = {
    config,
    context,
    runtime,
    store,
    executionId,
    workflowId,
    runId,
    waitMode,
    correlationKey: eventContext?.correlationKey,
    startLog,
  };

  if (waitMode === "delay") {
    return await executeDelayWait(branch);
  }
  return await executeHookWait(branch);
}

/**
 * Outcome of the persistence work that happens before a delay wait suspends
 * the run. Crosses a step boundary, so every field is JSON-safe.
 */
type DelayWaitPreparation =
  | { status: "error"; error: string }
  | { status: "skipped"; output: Record<string, unknown> }
  | {
      status: "ready";
      waitStateId: string;
      waitUntilIso: string;
      plannedWaitMs: number;
    };

async function prepareDelayWait(
  branch: WaitBranchContext
): Promise<DelayWaitPreparation> {
  const {
    config,
    context,
    store,
    executionId,
    workflowId,
    runId,
    waitMode,
    correlationKey,
    startLog,
  } = branch;

  const waitTimezone = readWaitTimezone(config);
  const waitGateMode = readWaitGateMode(config);

  const resolved = resolveWaitUntil({
    waitDuration: config.waitDuration,
    waitUntil: config.waitUntil,
    waitOffset: config.waitOffset,
    waitTimezone,
    ...readAllowedHoursConfig(config),
  });

  if (!resolved.waitUntil) {
    const errorMessage =
      resolved.error ||
      "Wait could not determine a target timestamp from waitUntil/waitDuration.";
    await store.completeStepLog({
      logId: startLog.logId,
      startTime: startLog.startTime,
      status: "error",
      error: errorMessage,
    });
    return { status: "error", error: errorMessage };
  }

  const waitUntilIso = encodeIsoTimestamp(resolved.waitUntil);
  const plannedWaitMs = resolved.waitUntil.getTime() - Date.now();
  const didActuallyWait = plannedWaitMs > 0;

  // Gate mode treats an already-passed target as "nothing to wait for" and
  // stops the branch instead of falling through to a zero-length sleep.
  if (waitGateMode === "require_actual_wait" && !didActuallyWait) {
    const output = {
      waitType: "delay",
      waitUntil: waitUntilIso,
      waitGateMode,
      skipped: true,
      skippedReason: "past_due_no_wait",
      plannedWaitMs,
      didActuallyWait,
      resumedAt: encodeIsoTimestamp(new Date()),
    };

    await store.recordAuditEvent({
      workflowId,
      executionId,
      eventType: "run_skipped",
      message: `Skipped delay branch in node '${context.nodeName}' (target already passed)`,
      metadata: {
        nodeId: context.nodeId,
        waitType: "delay",
        waitUntil: waitUntilIso,
        plannedWaitMs,
        reason: "past_due_no_wait",
        correlationKey,
      },
    });

    await store.completeStepLog({
      logId: startLog.logId,
      startTime: startLog.startTime,
      status: "success",
      output,
    });

    return { status: "skipped", output };
  }

  const waitState = await store.createWaitState({
    executionId,
    workflowId,
    runId,
    nodeId: context.nodeId,
    nodeName: context.nodeName,
    waitType: "delay",
    waitUntilIso,
    correlationKey,
    metadata: {
      waitMode,
      waitGateMode,
      waitTimezone,
    },
  });

  await store.recordAuditEvent({
    workflowId,
    executionId,
    eventType: "run_waiting",
    message: `Run waiting in delay node '${context.nodeName}'`,
    metadata: {
      nodeId: context.nodeId,
      waitType: "delay",
      waitUntil: waitUntilIso,
      waitGateMode,
      correlationKey,
    },
  });

  return {
    status: "ready",
    waitStateId: waitState.waitStateId,
    waitUntilIso,
    plannedWaitMs,
  };
}

async function executeDelayWait(
  branch: WaitBranchContext
): Promise<ExecutionResult> {
  const { context, runtime, store, executionId, workflowId, startLog } = branch;

  // Everything before the sleep is one durable step: a replay must not resolve
  // a fresh target time or insert a second wait-state row.
  const prepared = await runtime.step(
    `wait-delay-prepare-${context.nodeId}`,
    () => prepareDelayWait(branch)
  );

  if (prepared.status === "error") {
    return { success: false, error: prepared.error };
  }

  if (prepared.status === "skipped") {
    return { success: true, data: prepared.output, haltBranch: true };
  }

  try {
    await runtime.sleep(
      `wait-delay-${context.nodeId}`,
      Math.max(prepared.plannedWaitMs, 0)
    );
  } catch (error) {
    // Failure here means the run is unwinding (cancellation surfaces this way),
    // so the closing log row is written directly rather than as a new step.
    await store.completeStepLog({
      logId: startLog.logId,
      startTime: startLog.startTime,
      status: "error",
      error: getErrorMessage(error),
    });
    throw error;
  }

  const output = await runtime.step(
    `wait-delay-resume-${context.nodeId}`,
    async () => {
      await store.markWaitStateStatus({
        waitStateId: prepared.waitStateId,
        status: "resumed",
      });
      await store.markExecutionRunning({ executionId });

      await store.recordAuditEvent({
        workflowId,
        executionId,
        eventType: "run_resumed",
        message: `Run resumed after delay in node '${context.nodeName}'`,
        metadata: {
          nodeId: context.nodeId,
        },
      });

      const resumeOutput = {
        waitType: "delay",
        waitUntil: prepared.waitUntilIso,
        resumedAt: encodeIsoTimestamp(new Date()),
      };

      await store.completeStepLog({
        logId: startLog.logId,
        startTime: startLog.startTime,
        status: "success",
        output: resumeOutput,
      });

      return resumeOutput;
    }
  );

  return { success: true, data: output };
}

/**
 * Outcome of the persistence work that happens before a hook wait suspends the
 * run. The generated hook token lives here because it must survive replays.
 */
type HookWaitPreparation =
  | { status: "error"; error: string }
  | {
      status: "ready";
      waitStateId: string;
      hookToken: string;
      timeoutMs?: number;
    };

async function prepareHookWait(
  branch: WaitBranchContext
): Promise<HookWaitPreparation> {
  const {
    config,
    context,
    store,
    executionId,
    workflowId,
    runId,
    waitMode,
    correlationKey,
    startLog,
  } = branch;

  const waitTimeoutResolution =
    config.waitTimeout !== undefined && config.waitTimeout !== ""
      ? resolveWaitUntil({ waitDuration: config.waitTimeout })
      : { waitUntil: undefined, error: undefined };

  if (waitTimeoutResolution.error) {
    await store.completeStepLog({
      logId: startLog.logId,
      startTime: startLog.startTime,
      status: "error",
      error: waitTimeoutResolution.error,
    });
    return { status: "error", error: waitTimeoutResolution.error };
  }

  const explicitHookToken =
    typeof config.waitHookToken === "string" && config.waitHookToken.trim()
      ? config.waitHookToken.trim()
      : undefined;
  const hookToken = explicitHookToken || generateWaitToken();

  const waitForEvents =
    typeof config.waitForEvents === "string" ? config.waitForEvents : undefined;

  const waitState = await store.createWaitState({
    executionId,
    workflowId,
    runId,
    nodeId: context.nodeId,
    nodeName: context.nodeName,
    waitType: "hook",
    hookToken,
    waitUntilIso: waitTimeoutResolution.waitUntil
      ? encodeIsoTimestamp(waitTimeoutResolution.waitUntil)
      : undefined,
    correlationKey,
    metadata: {
      waitForEvents,
      waitMode,
      waitTimeout: config.waitTimeout,
    },
  });

  const waitModeLabel = waitMode === "event" ? "event" : "hook";

  await store.recordAuditEvent({
    workflowId,
    executionId,
    eventType: "run_waiting",
    message: `Run waiting on ${waitModeLabel} in node '${context.nodeName}'`,
    metadata: {
      nodeId: context.nodeId,
      hookToken,
      waitForEvents,
      timeoutAt: waitTimeoutResolution.waitUntil
        ? encodeIsoTimestamp(waitTimeoutResolution.waitUntil)
        : undefined,
    },
  });

  return {
    status: "ready",
    waitStateId: waitState.waitStateId,
    hookToken,
    timeoutMs: waitTimeoutResolution.waitUntil
      ? Math.max(waitTimeoutResolution.waitUntil.getTime() - Date.now(), 0)
      : undefined,
  };
}

async function executeHookWait(
  branch: WaitBranchContext
): Promise<ExecutionResult> {
  const {
    config,
    context,
    runtime,
    store,
    executionId,
    workflowId,
    waitMode,
    startLog,
  } = branch;
  const waitType = "hook";
  const waitModeLabel = waitMode === "event" ? "event" : "hook";

  const prepared = await runtime.step(
    `wait-hook-prepare-${context.nodeId}`,
    () => prepareHookWait(branch)
  );

  if (prepared.status === "error") {
    return { success: false, error: prepared.error };
  }

  let timedOut = false;
  let hookPayload: unknown;

  try {
    const resumeEvent = await runtime.waitForEvent(
      `wait-hook-${context.nodeId}`,
      {
        event: "workflow/wait.signal",
        timeoutMs: prepared.timeoutMs,
        ifExpression: [
          "async.data.executionId == event.data.executionId",
          `async.data.nodeId == '${escapeCelString(context.nodeId)}'`,
          `async.data.token == '${escapeCelString(prepared.hookToken)}'`,
          `async.data.signalType == 'wait-resume'`,
        ].join(" && "),
      }
    );
    timedOut = resumeEvent === null;
    hookPayload = resumeEvent;
  } catch (error) {
    // Same reasoning as the delay branch: the run is unwinding, so no new step.
    await store.completeStepLog({
      logId: startLog.logId,
      startTime: startLog.startTime,
      status: "error",
      error: getErrorMessage(error),
    });
    throw error;
  }

  const resumed = await runtime.step(
    `wait-hook-resume-${context.nodeId}`,
    async () => {
      await store.markWaitStateStatus({
        waitStateId: prepared.waitStateId,
        status: timedOut ? "timed_out" : "resumed",
      });
      await store.markExecutionRunning({ executionId });

      await store.recordAuditEvent({
        workflowId,
        executionId,
        eventType: timedOut ? "run_timed_out" : "run_resumed",
        message: timedOut
          ? `Run timed out in ${waitModeLabel} wait node '${context.nodeName}'`
          : `Run resumed from ${waitModeLabel} in node '${context.nodeName}'`,
        metadata: {
          nodeId: context.nodeId,
          hookToken: prepared.hookToken,
          waitMode,
        },
      });

      // An event wait configured to skip on timeout stops its branch instead of
      // letting downstream nodes run without the awaited event.
      const skipOnTimeout =
        timedOut &&
        waitMode === "event" &&
        config.waitTimeoutBehavior === "skip";

      const base = {
        waitType,
        waitMode,
        hookToken: prepared.hookToken,
        timedOut,
        resumedAt: encodeIsoTimestamp(new Date()),
      };
      const output = skipOnTimeout
        ? { ...base, skipped: true, skippedReason: "timeout_skip" }
        : { ...base, ...(timedOut ? {} : { payload: hookPayload }) };

      await store.completeStepLog({
        logId: startLog.logId,
        startTime: startLog.startTime,
        status: "success",
        output,
      });

      return { output, skipOnTimeout };
    }
  );

  if (resumed.skipOnTimeout) {
    return { success: true, data: resumed.output, haltBranch: true };
  }

  return { success: true, data: resumed.output };
}

type ExecutionLogger = ReturnType<typeof workflowExecutorLogger.with>;

function buildRunCompletedMessage(
  runMode: "live" | "test",
  success: boolean
): string {
  if (runMode === "test") {
    return success
      ? "Test mode completed successfully"
      : "Test mode completed with errors";
  }
  return success ? "Run completed successfully" : "Run completed with errors";
}

function buildRunFailedMessage(
  runMode: "live" | "test",
  cancelled: boolean
): string {
  if (runMode === "test") {
    return cancelled
      ? "Test mode cancelled"
      : "Test mode failed with fatal error";
  }
  return cancelled
    ? "Run cancelled while waiting"
    : "Run failed with fatal error";
}

/**
 * Writes the terminal record and timeline event for a run that finished its
 * graph. Runs inside a durable step, so it must stay side-effect-idempotent
 * from the caller's point of view: nothing here feeds back into the traversal.
 */
async function recordRunCompleted(input: {
  store: WorkflowStore;
  executionId: string;
  workflowId: string;
  status: "success" | "error";
  output: unknown;
  error?: string;
  startTime: number;
  duration: number;
  resultCount: number;
  runMode: "live" | "test";
  logger: ExecutionLogger;
}) {
  const succeeded = input.status === "success";

  try {
    await input.store.completeRun({
      executionId: input.executionId,
      status: input.status,
      output: input.output,
      error: input.error,
      startTime: input.startTime,
    });
    input.logger.debug("Updated execution record", { status: input.status });
  } catch (error) {
    input.logger.error("Failed to update execution record", { error });
  }

  await input.store.recordAuditEvent({
    workflowId: input.workflowId,
    executionId: input.executionId,
    eventType: succeeded ? "run_completed" : "run_failed",
    message: buildRunCompletedMessage(input.runMode, succeeded),
    metadata: {
      duration: input.duration,
      resultCount: input.resultCount,
      runMode: input.runMode,
    },
  });

  return { status: input.status };
}

/**
 * Terminal record for a run that died on an error escaping the traversal
 * (including a cancellation while waiting).
 */
async function recordRunFailed(input: {
  store: WorkflowStore;
  executionId: string;
  workflowId: string;
  status: "error" | "cancelled";
  cancelled: boolean;
  error: string;
  startTime: number;
  runMode: "live" | "test";
  logger: ExecutionLogger;
}) {
  try {
    await input.store.completeRun({
      executionId: input.executionId,
      status: input.status,
      error: input.error,
      startTime: input.startTime,
    });
  } catch (logError) {
    input.logger.error("Failed to persist fatal execution error", {
      error: logError,
    });
  }

  await input.store.recordAuditEvent({
    workflowId: input.workflowId,
    executionId: input.executionId,
    eventType: input.cancelled ? "run_cancelled" : "run_failed",
    message: buildRunFailedMessage(input.runMode, input.cancelled),
    metadata: {
      error: input.error,
      runMode: input.runMode,
    },
  });

  return { status: input.status };
}

/**
 * Main workflow executor function.
 *
 * Both dependencies are ports the caller supplies: `runtime` decides how work
 * is made durable, `store` decides where the run's trace is written. The
 * defaults are the honest in-process choices - work runs inline, nothing is
 * persisted - so a caller that wants a run recorded must inject a store that
 * records. The Inngest adapter in lib/inngest/workflow-function.ts is where a
 * real run picks up `dbWorkflowStore`.
 */
export function executeWorkflow(
  input: WorkflowExecutionInput,
  runtime: WorkflowExecutionRuntime = createInMemoryWorkflowRuntime(),
  store: WorkflowStore = noopWorkflowStore
) {
  return withSpan(
    "rova.workflow.execution",
    {
      "rova.workflow.id": input.workflowId,
      "rova.execution.id": input.executionId,
      "rova.workflow.name": input.workflowName,
      "rova.execution.run_mode": input.runMode ?? "live",
    },
    () => executeWorkflowInner(input, runtime, store)
  );
}

async function executeWorkflowInner(
  input: WorkflowExecutionInput,
  runtime: WorkflowExecutionRuntime,
  store: WorkflowStore
) {
  const {
    graph,
    triggerInput = {},
    requestPayload,
    executionId,
    workflowId,
    workflowName,
    workflowRunId,
    runMode = "live",
    eventContext,
  } = input;
  const { nodes, edges } = toWorkflowGraphData(graph);

  const currentWorkflowRunId = workflowRunId || runtime.runId || executionId;

  const executionLogger = workflowExecutorLogger.with({
    workflowId,
    workflowName: workflowName ?? null,
    executionId,
    workflowRunId: currentWorkflowRunId,
    runMode,
  });

  executionLogger.info("Starting workflow execution", {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    runMode,
    eventContext,
    triggerInput,
    requestPayload: requestPayload ?? triggerInput,
  });

  const outputs: NodeOutputs = {};
  const results: Record<string, ExecutionResult> = {};
  const workflowStartTime = Date.now();

  // Build node and edge maps
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const edgesBySource = new Map<string, WorkflowEdge[]>();
  const edgesByTarget = new Map<string, string[]>();
  for (const edge of edges) {
    const sourceEdges = edgesBySource.get(edge.source) || [];
    sourceEdges.push(edge);
    edgesBySource.set(edge.source, sourceEdges);

    const sources = edgesByTarget.get(edge.target) || [];
    sources.push(edge.source);
    edgesByTarget.set(edge.target, sources);
  }

  // Find trigger nodes
  const nodesWithIncoming = new Set(edges.map((e) => e.target));
  const triggerNodes = nodes.filter(
    (node) => node.data.type === "trigger" && !nodesWithIncoming.has(node.id)
  );

  executionLogger.info("Discovered trigger nodes", {
    triggerNodeCount: triggerNodes.length,
    triggerNodeIds: triggerNodes.map((node) => node.id),
  });

  const completedNodes = new Set<string>();
  const inProgressNodes = new Set<string>();
  const downstreamReadyNodes = new Set<string>();

  // Helper to get a meaningful node name
  function getNodeName(node: WorkflowNode): string {
    if (node.data.label) {
      return node.data.label;
    }
    if (node.data.type === "action") {
      const actionType = readConfigString(node.data.config, "actionType");
      if (actionType) {
        // Look up the human-readable label from the step registry
        const label = getActionLabel(actionType);
        if (label) {
          return label;
        }
      }
      return "Action";
    }
    if (node.data.type === "trigger") {
      const triggerDefinition = resolveWorkflowTriggerDefinition(
        node.data.config
      );
      return triggerDefinition.ui.label;
    }
    return node.data.type;
  }

  function getDeterministicTerminalOutput() {
    const terminalNodeIds = nodes
      .filter((node) => (edgesBySource.get(node.id)?.length ?? 0) === 0)
      .map((node) => node.id)
      .toSorted((a, b) => a.localeCompare(b));

    for (const nodeId of terminalNodeIds) {
      const output = results[nodeId]?.data;
      if (output !== undefined) {
        return output;
      }
    }

    const resultKeys = Object.keys(results).toSorted((a, b) =>
      a.localeCompare(b)
    );
    for (const nodeId of resultKeys) {
      const output = results[nodeId]?.data;
      if (output !== undefined) {
        return output;
      }
    }

    return undefined;
  }

  // Helper to execute a single node
  // The persisted graph is validated as a DAG before execution, so we avoid
  // per-call cycle-tracking allocations on this hot path.
  async function executeNode(nodeId: string) {
    const nodeLogger = executionLogger.with({ nodeId });
    nodeLogger.debug("Executing node");

    if (completedNodes.has(nodeId)) {
      nodeLogger.debug("Skipping node already completed");
      return;
    }

    if (inProgressNodes.has(nodeId)) {
      nodeLogger.debug("Skipping node already in progress");
      return;
    }

    const node = nodeMap.get(nodeId);
    if (!node) {
      nodeLogger.warn("Node not found");
      return;
    }

    const dependencies = edgesByTarget.get(nodeId) ?? [];
    const missingDependencies = dependencies.filter(
      (dependency) => !downstreamReadyNodes.has(dependency)
    );
    if (missingDependencies.length > 0) {
      nodeLogger.debug("Waiting for dependencies before execution", {
        dependencies,
        missingDependencies,
      });
      return;
    }

    inProgressNodes.add(nodeId);
    const nodeName = getNodeName(node);
    const actionType =
      node.data.type === "action"
        ? readConfigString(node.data.config, "actionType")
        : undefined;
    const namedNodeLogger = nodeLogger.with({
      nodeName,
      nodeType: node.data.type,
    });

    try {
      await withSpan(
        "rova.workflow.node.execute",
        {
          "rova.node.id": nodeId,
          "rova.node.name": nodeName,
          "rova.node.type": node.data.type,
          "rova.action.type": actionType,
        },
        () => executeNodeInner(nodeId, node, nodeName, namedNodeLogger)
      );
    } finally {
      inProgressNodes.delete(nodeId);
    }
  }

  /**
   * The node's own work: the trigger step, the action step, or the wait.
   *
   * This is the unit the durable runtime memoizes, so it deliberately does not
   * schedule downstream nodes - Inngest forbids nesting one step inside
   * another. Whatever the traversal needs afterwards travels back in the
   * returned outcome, which crosses a step boundary and stays JSON-safe.
   */
  async function runNodeWork(
    node: WorkflowNode,
    nodeName: string,
    namedNodeLogger: ReturnType<typeof executionLogger.with>
  ): Promise<NodeWorkOutcome> {
    // Disabled nodes emit a null output so downstream templates don't hard-fail.
    if (node.data.enabled === false) {
      namedNodeLogger.info("Skipping disabled node");
      return { result: { success: true, data: null } };
    }

    let result: ExecutionResult = {
      success: false,
      error: "Node execution did not produce a result.",
    };
    let triggerIgnored = false;
    let conditionValue: boolean | undefined;

    if (node.data.type === "trigger") {
      namedNodeLogger.debug("Executing trigger node");

      const configRecord = node.data.config ?? {};
      const triggerDefinition = resolveWorkflowTriggerDefinition(configRecord);
      const webhookRuntimeConfig =
        triggerDefinition.runtime.executionType === "webhook"
          ? resolveWebhookTriggerRuntimeConfig(configRecord)
          : undefined;
      let triggerData: JsonObject = {
        triggered: true,
        timestamp: Date.now(),
      };

      const mockInput = webhookRuntimeConfig?.mockInput;
      if (
        mockInput &&
        (!triggerInput || Object.keys(triggerInput).length === 0)
      ) {
        triggerData = { ...triggerData, ...mockInput };
        namedNodeLogger.debug("Using trigger mock request payload", {
          mockData: mockInput,
        });
      } else if (triggerInput && Object.keys(triggerInput).length > 0) {
        // Use provided trigger input
        triggerData = { ...triggerData, ...triggerInput };
      }

      const triggerEvaluation = evaluateWorkflowTrigger({
        config: configRecord,
        payload: triggerData,
      });

      let ignoreReason: string | undefined;
      if (triggerEvaluation.routingDecision.kind === "stop") {
        ignoreReason = "stop_event";
      } else if (triggerEvaluation.routingDecision.kind === "ignore") {
        ignoreReason = triggerEvaluation.routingDecision.reason;
      }

      if (ignoreReason) {
        triggerIgnored = true;
        // The trigger node's output is stored as JSON, where a key holding
        // `undefined` disappears anyway. Dropping those keys here makes the
        // in-memory object match what a template or the run row will see.
        triggerData = omitBy(
          {
            ...triggerData,
            triggered: false,
            eventType: triggerEvaluation.eventType,
            eventTypePath: webhookRuntimeConfig?.routing.eventTypePath,
            ignoredReason: ignoreReason,
          },
          isNil
        );

        namedNodeLogger.info("Trigger ignored by routing rules", {
          triggerType: triggerDefinition.runtime.type,
          eventType: triggerEvaluation.eventType,
          eventTypePath: webhookRuntimeConfig?.routing.eventTypePath,
          ignoredReason: ignoreReason,
        });
      }

      let shouldExecuteTriggerStep = true;

      if (!ignoreReason && triggerDefinition.runtime.type === "Webhook") {
        const schemaValidation = validateWorkflowOutputAgainstSchema({
          schemaValue: configRecord.webhookOutputSchema,
          output: triggerData,
          contextLabel: "Webhook trigger",
        });

        if (!schemaValidation.ok) {
          result = {
            success: false,
            error: schemaValidation.error,
          };
          shouldExecuteTriggerStep = false;
          namedNodeLogger.error("Webhook output schema validation failed", {
            error: schemaValidation.error,
          });
        }
      }

      if (shouldExecuteTriggerStep) {
        // Build context for logging
        const triggerContext: StepContext = {
          executionId,
          nodeId: node.id,
          nodeName,
          nodeType: node.data.type,
        };

        // Execute trigger step (handles logging internally)
        const triggerResult = await triggerStep({
          triggerData,
          _context: triggerContext,
        });

        result = {
          success: triggerResult.success,
          data: triggerResult.data,
        };
      }
    } else if (node.data.type === "action") {
      const config = node.data.config || {};
      const actionType = readConfigString(config, "actionType");
      const actionLogger = namedNodeLogger.with({
        actionType: actionType ?? null,
      });
      actionLogger.debug("Executing action node");

      // Check if action type is defined
      if (!actionType) {
        actionLogger.error("Action node missing action type");
        return {
          result: {
            success: false,
            error: `Action node "${node.data.label || node.id}" has no action type configured`,
          },
          unconfigured: true,
        };
      }

      // Process templates in config, but keep conditions unprocessed for special handling
      const configWithoutCondition = { ...config };
      const originalCondition = config.condition;
      configWithoutCondition.condition = undefined;

      const processedConfig = processTemplates(configWithoutCondition, outputs);

      // Add back the original condition (unprocessed)
      if (originalCondition !== undefined) {
        processedConfig.condition = originalCondition;
      }

      // In test mode, keep test destination overrides as authored literals.
      // This prevents trigger/runtime payload templates from steering where
      // test-recipient messages are sent.
      if (runMode === "test") {
        if (actionType === "resend/send-email") {
          processedConfig.testEmailTo = config.testEmailTo;
        }

        if (actionType === "twilio/send-sms") {
          processedConfig.testPhoneTo = config.testPhoneTo;
        }
      }

      // Build step context for logging (stepHandler will handle the logging)
      const stepContext: StepContext = {
        executionId,
        nodeId: node.id,
        nodeName: getNodeName(node),
        nodeType: actionType,
        runMode,
      };
      // Execute the action step with stepHandler (logging is handled inside)
      // IMPORTANT: We pass integrationId via config, not actual credentials
      // Steps fetch credentials internally using fetchCredentials(integrationId)
      actionLogger.debug("Calling executeActionStep");

      // The Wait action is the one action the engine runs itself, so its result
      // is an ExecutionResult already and carries the branch-halting decision
      // the durable runtime made. Everything else comes back as a StepResult.
      if (actionType === WAIT_ACTION_TYPE) {
        const waitResult = await executeWaitAction({
          config: processedConfig,
          context: stepContext,
          runtime,
          store,
          executionId,
          workflowId,
          workflowRunId: currentWorkflowRunId,
          eventContext,
        });

        if (waitResult.success) {
          result = {
            success: true,
            data: waitResult,
            haltBranch: waitResult.haltBranch === true,
          };
        } else {
          actionLogger.error("Wait failed", {
            nodeId: node.id,
            nodeLabel: node.data.label,
            error: waitResult.error,
          });
          result = { success: false, error: waitResult.error };
        }
      } else {
        const actionOutcome = await executeActionStep({
          actionType,
          config: processedConfig,
          outputs,
          context: stepContext,
          store,
        });

        // Set by a Condition node and by nothing else, which is what the
        // traversal below routes on.
        conditionValue = actionOutcome.conditionValue;

        const stepResult = actionOutcome.result;
        if (!stepResult.success) {
          const errorMessage = stepResult.error.message;
          actionLogger.error("Action step failed", {
            actionType,
            nodeId: node.id,
            nodeLabel: node.data.label,
            error: errorMessage,
          });
          result = {
            success: false,
            error: errorMessage,
          };
        } else {
          result = {
            success: true,
            data: stepResult,
          };
        }
      }
    } else {
      namedNodeLogger.error("Unknown node type");
      result = {
        success: false,
        error: `Unknown node type "${node.data.type}" in node "${node.data.label || node.id}". Expected "trigger" or "action".`,
      };
    }

    return { result, triggerIgnored, conditionValue };
  }

  /**
   * Runs a node's work through the durable runtime so a replay reuses the
   * stored result instead of repeating the side effect.
   *
   * Two shapes stay unwrapped: disabled nodes (nothing happens, nothing to
   * remember) and Wait nodes (they suspend the run through runtime.sleep /
   * runtime.waitForEvent, which cannot sit inside a step - executeWaitAction
   * memoizes its own persistence segments around those wait boundaries).
   */
  function runNodeWorkMemoized(
    nodeId: string,
    node: WorkflowNode,
    nodeName: string,
    namedNodeLogger: ReturnType<typeof executionLogger.with>
  ): Promise<NodeWorkOutcome> {
    const isWaitNode =
      node.data.type === "action" &&
      readConfigString(node.data.config, "actionType") === WAIT_ACTION_TYPE;

    if (isWaitNode || node.data.enabled === false) {
      return runNodeWork(node, nodeName, namedNodeLogger);
    }

    return runtime.step(`node:${nodeId}`, () =>
      runNodeWork(node, nodeName, namedNodeLogger)
    );
  }

  /**
   * Records a node's outcome and schedules its downstream branches. Runs
   * outside the node's step so descendants become sibling steps rather than
   * nested ones.
   */
  async function executeNodeInner(
    nodeId: string,
    node: WorkflowNode,
    nodeName: string,
    namedNodeLogger: ReturnType<typeof executionLogger.with>
  ) {
    try {
      const outcome = await runNodeWorkMemoized(
        nodeId,
        node,
        nodeName,
        namedNodeLogger
      );
      const { result } = outcome;

      // A node with no action type never produced an output, so it is recorded
      // as failed without becoming available to downstream templates.
      if (outcome.unconfigured) {
        results[nodeId] = result;
        return;
      }

      // Store results
      results[nodeId] = result;

      // Store outputs with sanitized nodeId for template variable lookup.
      // A step's payload arrives as unknown because the dispatch is a dynamic
      // import, so this is where it becomes JSON again for the template
      // resolver and the CEL context to walk.
      const sanitizedNodeId = nodeId.replace(/[^a-zA-Z0-9]/g, "_");
      const outputData = readJsonValue(result.data);
      if (outputData === null && result.data !== null) {
        namedNodeLogger.warn(
          "Node output is not JSON and will read as empty downstream",
          { actionType: node.data.config?.actionType }
        );
      }
      outputs[sanitizedNodeId] = {
        label: node.data.label || nodeId,
        data: outputData,
      };
      completedNodes.add(nodeId);

      namedNodeLogger.info("Node execution completed", {
        success: result.success,
        haltBranch: result.haltBranch === true,
        error: result.error,
      });

      // Execute next nodes
      if (result.success) {
        let shouldContinueDownstream = true;

        // Webhook trigger routing may intentionally ignore an event.
        if (outcome.triggerIgnored) {
          namedNodeLogger.info(
            "Skipping downstream nodes because trigger was not fired"
          );
          shouldContinueDownstream = false;
        }

        if (result.haltBranch && shouldContinueDownstream) {
          namedNodeLogger.info(
            "Skipping downstream nodes because step requested halt"
          );
          shouldContinueDownstream = false;
        }

        // Check if this is a condition node. A disabled condition node never
        // evaluated anything, so it fans out to every branch instead.
        const isConditionNode =
          node.data.enabled !== false &&
          node.data.type === "action" &&
          node.data.config?.actionType === "Condition";

        if (isConditionNode && shouldContinueDownstream) {
          const conditionResult = outcome.conditionValue;
          namedNodeLogger.debug("Condition node result", {
            conditionResult,
          });

          if (conditionResult !== true && conditionResult !== false) {
            namedNodeLogger.debug(
              "Condition result missing boolean value, skipping downstream nodes"
            );
          } else {
            const nextBranch: ConditionBranch = conditionResult
              ? "true"
              : "false";
            const outgoingEdges = edgesBySource.get(nodeId) || [];
            const nextNodes = getConditionNextNodeIds({
              edges: outgoingEdges,
              branch: nextBranch,
            });
            namedNodeLogger.debug(
              "Condition branch selected, executing downstream nodes in parallel",
              {
                selectedBranch: nextBranch,
                nextNodeCount: nextNodes.length,
                nextNodeIds: nextNodes,
              }
            );
            downstreamReadyNodes.add(nodeId);
            await Promise.all(
              nextNodes.map((nextNodeId) => executeNode(nextNodeId))
            );
          }
        } else if (shouldContinueDownstream) {
          // For non-condition nodes, execute all next nodes in parallel
          const nextNodes = (edgesBySource.get(nodeId) || []).map(
            (edge) => edge.target
          );
          namedNodeLogger.debug("Executing downstream nodes in parallel", {
            nextNodeCount: nextNodes.length,
            nextNodeIds: nextNodes,
          });
          // Execute all next nodes in parallel
          downstreamReadyNodes.add(nodeId);
          await Promise.all(
            nextNodes.map((nextNodeId) => executeNode(nextNodeId))
          );
        }
      }
    } catch (error) {
      namedNodeLogger.error("Unexpected error executing node", {
        error,
      });
      if (isCancellationError(error)) {
        throw error;
      }
      const errorMessage = await getErrorMessageAsync(error);
      const errorResult = {
        success: false,
        error: errorMessage,
      };
      results[nodeId] = errorResult;
      completedNodes.add(nodeId);
      // Note: stepHandler already logged the error for action steps
      // Trigger steps don't throw, so this catch is mainly for unexpected errors
    }
  }

  // Execute from each trigger node in parallel
  try {
    executionLogger.info("Starting execution from trigger nodes");
    await Promise.all(triggerNodes.map((trigger) => executeNode(trigger.id)));

    const finalSuccess = Object.values(results).every((r) => r.success);
    const duration = Date.now() - workflowStartTime;
    const finalOutput = getDeterministicTerminalOutput();

    executionLogger.info("Workflow execution completed", {
      success: finalSuccess,
      resultCount: Object.keys(results).length,
      durationMs: duration,
    });

    // Wrapped as a durable step so the terminal record and its audit event are
    // written exactly once, even though the body replays after every wait.
    await runtime.step("workflow-run-completed", () =>
      recordRunCompleted({
        store,
        executionId,
        workflowId,
        status: finalSuccess ? "success" : "error",
        output: finalOutput,
        error: Object.values(results).find((r) => !r.success)?.error,
        startTime: workflowStartTime,
        duration,
        resultCount: Object.keys(results).length,
        runMode,
        logger: executionLogger,
      })
    );

    return {
      success: finalSuccess,
      results,
      outputs,
    };
  } catch (error) {
    executionLogger.error("Fatal error during workflow execution", {
      error,
    });

    const errorMessage = await getErrorMessageAsync(error);
    const cancelled = isCancellationError(error);
    const terminalStatus = cancelled ? "cancelled" : "error";

    // Same exactly-once treatment as the success path above.
    await runtime.step("workflow-run-failed", () =>
      recordRunFailed({
        store,
        executionId,
        workflowId,
        status: terminalStatus,
        cancelled,
        error: errorMessage,
        startTime: workflowStartTime,
        runMode,
        logger: executionLogger,
      })
    );

    return {
      success: false,
      results,
      outputs,
      error: errorMessage,
      cancelled,
    };
  }
}

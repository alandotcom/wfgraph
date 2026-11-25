/**
 * A failed step, run or Connection test said in plain words. The error is
 * written by an integration, a host or the engine and often ends in a
 * provider's code, such as Slack's `invalid_auth`. This module recognizes the
 * causes a person can act on and words them; the raw error stays beside the
 * sentence for a developer. Every function is pure.
 */

import { compact, sortBy } from "es-toolkit/array";
import { descendantsOf } from "@wfgraph/shared/graph/descendants";
import { stepName } from "@wfgraph/shared/graph/step-name";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

/** The Connection a failed step used, as the Runs view can name it. */
export type FailedStepConnection =
  /** The step's Connection exists, under this name. */
  | { kind: "named"; name: string }
  /** The step names a Connection that no longer exists. */
  | { kind: "deleted" }
  /** The step names no Connection, or the list could not be read. */
  | { kind: "unknown" };

/**
 * What the Runs view says about a failure. `sentence` is the plain cause.
 * `detail` is the stored error, shown as secondary text, or null when the
 * sentence is the stored error. `connectionCause` says the step's Connection
 * is what failed, which is the one cause the view offers a repair for.
 */
export type FailureDescription = {
  sentence: string;
  detail: string | null;
  connectionCause: boolean;
};

/**
 * Provider answers that mean the credentials were refused: Slack's codes, the
 * HTTP statuses, and the words most APIs use for them.
 */
const REJECTED_CREDENTIALS =
  /\b(invalid_auth|not_authed|account_inactive|token_revoked|token_expired|invalid_api_key|unauthori[sz]ed|unauthenticated|forbidden|401|403)\b|authentication failed|invalid api key/i;

/**
 * An integration saying a credential its Connection needs is not set. A step
 * says "is not configured" and a Connection test says "is required".
 */
const MISSING_CREDENTIAL =
  /\b[A-Z][A-Z0-9_]*_(KEY|TOKEN|SECRET)\b is (not configured|required)/;

/** The engine's error for an Entity the host's resolver did not find. */
const ENTITY_NOT_FOUND = /^Entity "([^"]+)" was not found for node data$/;

/**
 * How a run named the Entity it tracks, for an Entity the host's resolver did
 * not find: the label of the Event that started it, and the Event's
 * Entity binding the Lifecycle Rules chose. The run has no source to name
 * when it started with no Event, or its pinned graph names no binding.
 */
export type RunEntitySource = {
  eventLabel: string;
  binding: string;
};

/**
 * The sentences for an Entity the host's resolver did not find: which Entity,
 * which Event binding supplied its ID, and what to check.
 */
function missingEntitySentence(
  label: string,
  source: RunEntitySource | null
): string {
  return compact([
    `The app found no ${label} for this run.`,
    source === null
      ? null
      : `${source.eventLabel} provides the ${label} ID through its ${source.binding} binding.`,
    `Check that the ${label} exists in the app.`,
  ]).join(" ");
}

/** How a Connection is named in a sentence. */
function connectionPhrase(connection: FailedStepConnection): string {
  return connection.kind === "named"
    ? `the Connection ${connection.name}`
    : "the step's Connection";
}

/**
 * The failure of a step, or of a run when `integrationLabel` and `connection`
 * are absent. `integrationLabel` names the integration the step's action
 * belongs to, such as "Slack", and is null for an action with none.
 * `entityLabel` turns an Entity type into the label the editor uses.
 * `entitySource` says how the run named its Entity, for an Entity not found.
 */
export function describeFailure(input: {
  error: string;
  integrationLabel: string | null;
  connection: FailedStepConnection;
  entityLabel: (entityType: string) => string;
  entitySource?: RunEntitySource | null | undefined;
}): FailureDescription {
  const { error, integrationLabel, connection } = input;
  if (integrationLabel !== null) {
    if (connection.kind === "deleted") {
      return {
        sentence:
          "The Connection this step used was deleted. Choose another Connection on the step in Draft.",
        detail: error,
        connectionCause: false,
      };
    }
    if (REJECTED_CREDENTIALS.test(error)) {
      return {
        sentence: `${integrationLabel} rejected the credentials of ${connectionPhrase(connection)}.`,
        detail: error,
        connectionCause: true,
      };
    }
    if (MISSING_CREDENTIAL.test(error)) {
      return {
        sentence: `${capitalize(connectionPhrase(connection))} is missing a credential.`,
        detail: error,
        connectionCause: true,
      };
    }
  }
  const entity = ENTITY_NOT_FOUND.exec(error);
  if (entity?.[1] !== undefined) {
    return {
      sentence: missingEntitySentence(
        input.entityLabel(entity[1]),
        input.entitySource ?? null
      ),
      detail: error,
      connectionCause: false,
    };
  }
  return { sentence: error, detail: null, connectionCause: false };
}

/**
 * The failure of a Connection test, as the Connection form and the Connections
 * list show it. `connectionName` names a saved Connection, and is null for
 * credentials typed into a form and not yet saved. A recognized cause ends
 * with what to do next. Any other answer is the integration's own sentence.
 */
export function describeConnectionTestFailure(input: {
  error: string;
  integrationLabel: string;
  connectionName: string | null;
}): FailureDescription {
  const { error, integrationLabel, connectionName } = input;
  if (REJECTED_CREDENTIALS.test(error)) {
    const credentials =
      connectionName === null
        ? "these credentials"
        : `the credentials of the Connection ${connectionName}`;
    return {
      sentence: `${integrationLabel} rejected ${credentials}. Enter new credentials and test again.`,
      detail: error,
      connectionCause: true,
    };
  }
  if (MISSING_CREDENTIAL.test(error)) {
    return {
      sentence:
        "A credential this Connection needs is empty. Enter it and test again.",
      detail: error,
      connectionCause: true,
    };
  }
  return { sentence: error, detail: null, connectionCause: false };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** How many steps the aftermath names before it counts the rest. */
const NAMED_STEPS = 3;

/**
 * What a failed run left undone and what fixing its cause changes, in two
 * sentences built from the run's own records: the steps after the failed one
 * that never ran, by number and name, and that the run has ended for good.
 * `failedNodeId` is the step that failed, `ranNodeIds` the steps the run
 * recorded an execution of, and `numberOf` the step numbers of the graph the
 * run pinned. A failed run is never retried: its steps retried before it
 * failed, and a later run is a new run.
 */
export function failedRunAftermath(input: {
  failedNodeId: string;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  ranNodeIds: ReadonlySet<string>;
  numberOf: ReadonlyMap<string, number>;
  nameOf: (node: WorkflowNode) => string;
}): { notRun: string; next: string } {
  const after = descendantsOf({
    startIds: [input.failedNodeId],
    edges: input.edges,
  });
  const notRun = sortBy(
    input.nodes.filter(
      (node) =>
        after.has(node.id) &&
        !input.ranNodeIds.has(node.id) &&
        input.numberOf.has(node.id)
    ),
    [(node) => input.numberOf.get(node.id) ?? 0]
  );
  const named = notRun
    .slice(0, NAMED_STEPS)
    .map((node) => stepName(input.nameOf(node), input.numberOf.get(node.id)));
  const rest = notRun.length - named.length;
  const list = new Intl.ListFormat("en", { type: "conjunction" }).format(
    rest > 0
      ? [...named, `${rest} more ${rest === 1 ? "step" : "steps"}`]
      : named
  );
  return {
    notRun:
      notRun.length === 0
        ? "No step after the failed one was left to run."
        : `${list} did not run.`,
    next: "This run has ended and is not retried. Once the cause is fixed, the next run uses the fix.",
  };
}

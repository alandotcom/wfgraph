/**
 * A failed step or run said in plain words. The stored error is written by an
 * integration, a host or the engine and often ends in a provider's code, such
 * as Slack's `invalid_auth`. This module recognizes the causes a person can
 * act on and words them; the stored error stays beside the sentence for a
 * developer. Every function is pure.
 */

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

/** An integration saying a credential its Connection needs is not set. */
const MISSING_CREDENTIAL =
  /\b[A-Z][A-Z0-9_]*_(KEY|TOKEN|SECRET)\b is not configured/;

/** The engine's error for an Entity the host's resolver did not find. */
const ENTITY_NOT_FOUND = /^Entity "([^"]+)" was not found for node data$/;

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
 */
export function describeFailure(input: {
  error: string;
  integrationLabel: string | null;
  connection: FailedStepConnection;
  entityLabel: (entityType: string) => string;
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
      sentence: `The app found no ${input.entityLabel(entity[1])} for this run.`,
      detail: error,
      connectionCause: false,
    };
  }
  return { sentence: error, detail: null, connectionCause: false };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

import { Effect } from "effect";
import { omitBy } from "es-toolkit/object";
import { isNil } from "es-toolkit/predicate";

/**
 * The instrumentation scope every Workflow Graph span arrives under: the engine's own,
 * and the service spans `effect/tracer.ts` bridges. One scope is what lets a
 * reader of the trace treat both halves as one library.
 */
export const TRACER_NAME = "wfgraph-workflows";
export const TRACER_VERSION = "0.1.0";

/**
 * Every span is named `wfgraph.<domain>.<snake_case operation>`, and the name is a
 * released contract a host's dashboards key off. Its attributes are identifiers
 * under `wfgraph.<entity>.<field>`, plus `wfgraph.outcome`, which sits outside
 * that family because it names the call rather than an entity. A graph, a
 * payload, an Event body, a step output or a credential is never an attribute,
 * and neither is a total: a count of what a call touched goes on that call's own
 * log record.
 */
export type ServiceSpanFacts = {
  workflowId?: string | undefined;
  executionId?: string | undefined;
  /** The immutable publication version the call is about. */
  versionId?: string | undefined;
  /** The version a comparison reads against, when it differs from `versionId`. */
  baseVersionId?: string | undefined;
  versionNumber?: number | undefined;
  /** The version a Migration moves runs onto. */
  targetVersionId?: string | undefined;
  /**
   * How the call ended, in one machine word: a status, a refusal reason, or the
   * code a failure carries. Never a sentence, because a sentence quotes values.
   */
  outcome?: string | undefined;
};

/**
 * Put the facts given on the span currently running, dropping the absent ones.
 *
 * OpenTelemetry stores an `undefined` value as a present-but-empty attribute, so
 * the keys have to be removed rather than set to nothing; that is what makes
 * "the span carries no version id" readable as an absent key.
 */
export function annotateServiceSpan(
  facts: ServiceSpanFacts
): Effect.Effect<void> {
  return Effect.annotateCurrentSpan(
    omitBy(
      {
        "wfgraph.workflow.id": facts.workflowId,
        "wfgraph.execution.id": facts.executionId,
        "wfgraph.workflow.version.id": facts.versionId,
        "wfgraph.workflow.version.base_id": facts.baseVersionId,
        "wfgraph.workflow.version.number": facts.versionNumber,
        "wfgraph.workflow.version.target_id": facts.targetVersionId,
        "wfgraph.outcome": facts.outcome,
      },
      isNil
    )
  );
}

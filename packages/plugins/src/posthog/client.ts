/**
 * PostHog's public ingestion API over fetch.
 *
 * Two endpoints are reached here: `/i/v0/e/` to capture an event, and
 * `/flags?v=2` to check a project key. Both are POST-only, both take the project
 * key in the body rather than a header, and neither returns anything from the
 * project. Everything after the request is described in `external-http.ts`, so
 * what is left here is the host, the two endpoints, and how PostHog's error body
 * reads.
 *
 * The two endpoints refuse differently, and only one of them can be quoted. A
 * flags refusal is JSON, so its `detail` reaches a person as PostHog wrote it. A
 * capture refusal is plain text ("non-engage request missing event name
 * attribute" for a 400), and the shared transport reads a body as JSON or not at
 * all, so that sentence does not survive the trip -- which is why the two
 * statuses a misconfigured node produces are named below instead.
 *
 * `posthog-node` was not taken: it batches on a background timer and wants a
 * `shutdown()` flush, which a step boundary has nowhere to put.
 */

import type { JsonObject, JsonValue } from "@wfgraph/core/plugin";
import type { Effect } from "effect";
import { Schema } from "effect";
import type { HttpClient } from "effect/unstable/http";
import {
  callExternal,
  parsePayload,
  type ExternalError,
} from "@wfgraph/core/plugin";

/** Where a project lives when the connection did not say. */
export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/**
 * PostHog's error body, the same shape on both endpoints.
 *
 * Every field is optional because the handler depends on none of them: they
 * make the message a person reads, and a build answering something else should
 * still report its status rather than fail the decode.
 */
const posthogErrorSchema = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  attr: Schema.optionalKey(Schema.NullishOr(Schema.String)),
});

/**
 * What the capture endpoint answers.
 *
 * Cloud answers `{"status": 1}` and older self-hosted builds answer
 * `{"status": "Ok"}`, so both stand. The key is optional because nothing
 * downstream reads it -- ingestion is async, and a capture that was accepted
 * says nothing about whether the event was stored.
 */
const captureResponseSchema = Schema.Struct({
  status: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
});

/** As much of the flags response as the connection test needs. */
const flagsResponseSchema = Schema.Struct({
  featureFlags: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Unknown)
  ),
  flags: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  errorsWhileComputingFlags: Schema.optionalKey(Schema.Boolean),
});

export type PostHogConnection = {
  projectApiKey: string;
  host: string;
};

/**
 * What PostHog said, in one sentence a person reads.
 *
 * A refusal carries PostHog's own `detail` when its error body is the documented
 * shape and the bare status when it is not, which is what something standing in
 * front of the API answers with.
 */
export function describePostHogFailure(error: ExternalError): string {
  if (error._tag === "ExternalUnreachable") {
    return error.message;
  }

  if (error._tag === "ExternalUnreadable") {
    return `PostHog answered ${error.status} with an unrecognized body`;
  }

  return (
    readPostHogError(error.payload)?.detail ??
    describeCaptureStatus(error.status) ??
    `HTTP ${error.status}`
  );
}

/**
 * What a refusal carrying no readable body means.
 *
 * Only the capture endpoint lands here, because a flags refusal always carries a
 * `detail`. These are the two statuses it answers a misconfigured node with: a
 * key it will not take, and an event it could not read.
 */
function describeCaptureStatus(status: number): string | undefined {
  if (status === 401) {
    return "PostHog refused the project API key (HTTP 401)";
  }

  if (status === 400) {
    return "PostHog could not read the event (HTTP 400)";
  }

  return undefined;
}

/** PostHog's error body, for a caller that reports more than the message. */
export function readPostHogError(payload: JsonValue | undefined) {
  return parsePayload(payload, posthogErrorSchema);
}

/**
 * The host with any trailing slash taken off, so joining a path cannot produce
 * a double slash. A blank host is the US cloud, which is where a project lives
 * unless someone chose otherwise.
 */
export function resolvePostHogHost(host: string | undefined): string {
  const trimmed = host?.trim();
  return (trimmed || DEFAULT_POSTHOG_HOST).replace(/\/+$/, "");
}

/**
 * One event, as `/i/v0/e/` takes it.
 *
 * `uuid` and `timestamp` are required here rather than optional because they are
 * what makes a resend collapse: PostHog deduplicates on
 * `[timestamp, distinct_id, event, uuid]`, so a caller that omits either has no
 * repeat safety at all and should not be able to reach this by accident.
 */
export type PostHogEvent = {
  event: string;
  distinct_id: string;
  uuid: string;
  timestamp: string;
  properties?: JsonObject;
  $set?: JsonObject;
  $set_once?: JsonObject;
};

/**
 * Capture one event.
 *
 * Marked `safeToRepeat` on a deterministic body: every field the dedup sort key
 * reads is fixed by the caller before the first attempt, so a retry sends bytes
 * identical to the ones that may already have arrived. PostHog collapses the
 * pair during a background merge. That is eventual rather than immediate, and
 * the trade is deliberate -- for an analytics event a duplicate that merges away
 * beats a hole in a funnel nobody can reconstruct.
 */
export function captureEvent(
  connection: PostHogConnection,
  event: PostHogEvent
): Effect.Effect<
  typeof captureResponseSchema.Type,
  ExternalError,
  HttpClient.HttpClient
> {
  return callExternal({
    system: "PostHog",
    url: `${connection.host}/i/v0/e/`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: {
      kind: "json",
      value: { api_key: connection.projectApiKey, ...event },
    },
    schema: captureResponseSchema,
    safeToRepeat: true,
  });
}

/**
 * Evaluate flags for one person, which is the cheapest call that tells a bad
 * project key from a good one. Capture cannot: ingestion is async, so it answers
 * `{"status": 1}` whatever key it was given.
 */
export function evaluateFlags(
  connection: PostHogConnection,
  distinctId: string
): Effect.Effect<
  typeof flagsResponseSchema.Type,
  ExternalError,
  HttpClient.HttpClient
> {
  return callExternal({
    system: "PostHog",
    url: `${connection.host}/flags?v=2`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: {
      kind: "json",
      value: { api_key: connection.projectApiKey, distinct_id: distinctId },
    },
    schema: flagsResponseSchema,
    // A read PostHog spells as a POST.
    safeToRepeat: true,
  });
}

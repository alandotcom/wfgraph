# Routing Policy: builder-owned trigger routing

Implements ADR 0001 (`docs/adr/0001-routing-policy-owned-by-workflow-builder.md`).
Vocabulary is in `CONTEXT.md`. No backwards compatibility anywhere: old shapes,
old names, and old tests asserting them are deleted, not shimmed.

## Target model

- A trigger definition supplies vocabulary only: payload `schema`, mandatory
  `correlationIdPath`, optional `eventTypePath`. When an event-mode trigger
  omits `eventTypePath`, the delivering Inngest event name is the Event Type.
- Each workflow's trigger node config carries a `routingPolicy`:
  `Record<string, "start" | "replace" | "cancel" | "ignore">` keyed by Event
  Type. Unmapped Event Types mean `ignore`.
- Trigger evaluation classifies (`eventType`, `correlationKey`); a separate
  pure function resolves the policy into an action. Resumes stay independent
  of the policy and keep running after stop/replace handling, exactly as the
  orchestrator orders them today.
- `cancel`/`replace` target every in-flight Execution for the Correlation Key
  (statuses `pending`, `running`, `waiting`), not just runs parked at a Wait
  node. `workflow_executions.correlation_key` is already indexed; no
  migration.

## Phase 1 — shared vocabulary (`packages/shared`)

### `workflow/trigger-registry.ts`

- Delete `TriggerLifecycleInput`, `runLifecycleHandler`, the three
  `trigger*Evaluation` helpers for start/restart/stop, and the `lifecycle`
  field on `CreateTriggerInputBase`.
- Add `eventTypePath?: TriggerStringPath<TPayload>` to
  `CreateTriggerInputBase`.
- Replace `TriggerRoutingDecision` with:
  ```ts
  export type RoutingAction = "start" | "replace" | "cancel" | "ignore";
  export type TriggerClassification =
    | {
        ok: true;
        eventType: string | undefined;
        correlationKey: string | undefined;
      }
    | { ok: false; reason: "invalid_payload" };
  ```
- `WorkflowTriggerRuntimeDefinition.evaluate` becomes
  `(input: { config, payload, eventName?: string }) => TriggerClassification`.
  For `createTrigger` definitions: validate via schema (`ok: false` on
  failure), `correlationKey` from `correlationIdPath`, `eventType` from
  `eventTypePath` when declared, else `input.eventName`.
- New pure function, unit-tested:
  ```ts
  export function resolveRoutingAction(
    policy: Record<string, RoutingAction> | undefined,
    eventType: string | undefined
  ): RoutingAction;
  ```
  Missing `eventType` or unmapped Event Type resolves to `"ignore"`.
- `WorkflowTriggerMetadata` gains `eventTypes?: string[]` and
  `correlationPath?: string` so the editor can render the policy table and
  name the correlation path. Both live as optional fields on
  `WorkflowTriggerUiDefinition`, computed in `createTrigger` and left
  undefined by the built-in webhook/schedule/fallback definitions (the
  webhook's correlation path is builder config, not definition data). For
  custom triggers, derive `eventTypes` from the schema's JSON Schema enum at
  `eventTypePath` (reuse the existing Standard JSON Schema converter path in
  `extractStandardSchemaOutputFields`); when `eventTypePath` is absent on an
  event-mode trigger, `eventTypes` is the declared Inngest event names.
  `correlationPath` is `correlationIdPath`.
- `eventTypePath` is required for webhook-mode `createTrigger` (enforce in
  the runtime validation block alongside the existing non-empty checks):
  webhook mode has no event name to fall back on, so omitting it would make
  every payload classify to no Event Type and resolve to ignore forever.
- Manual runs of an event-mode trigger have no delivering event name. When
  the trigger declares exactly one Inngest event name and no
  `eventTypePath`, callers pass that sole name as the `eventName` fallback;
  a multi-event trigger without `eventTypePath` classifies manual payloads
  to `eventType: undefined` and reports `missing_event_type`.
- `evaluateWorkflowTrigger` returns the classification; it no longer knows
  about routing.

### `workflow/schemas.ts`

- `routingPolicySchema = z.record(z.string().min(1), z.enum(["start", "replace", "cancel", "ignore"]))`.
- `webhookTriggerConfigSchema`: delete `webhookCreateEvents`,
  `webhookUpdateEvents`, `webhookDeleteEvents`; add
  `routingPolicy: routingPolicySchema.optional()`. Keep `webhookEventPath`
  and `webhookCorrelationPath`.
- `customTriggerConfigSchema`: add optional `routingPolicy` (typed, ahead of
  the catchall).

### `workflow/webhook-routing.ts`

- Delete `WebhookRoutingDecision`, `routeWebhookEvent`,
  `DEFAULT_WEBHOOK_*_EVENTS`, and the create/update/delete sets on
  `WebhookRoutingConfig`. What remains: `eventTypePath`/`correlationPath`
  resolution (defaults `"event"` / `"data.id"`) and
  `deriveWebhookEventContext`. The webhook trigger's `evaluate` returns a
  classification; routing goes through `resolveRoutingAction` like every
  other trigger.

### `workflow/triggers/*.ts`

- `webhook-trigger.ts`: drop `mapWebhookDecisionToTriggerDecision`; evaluate
  returns `{ ok: true, eventType, correlationKey }` from the configured
  paths (an unparseable config still yields defaults, as
  `buildWebhookRoutingConfig` does today).
- `fallback-trigger.ts`, `schedule-trigger.ts`: evaluate returns a
  classification from the same hardcoded `"event"` / `"data.id"` paths. The
  always-start behavior moves to the callers: manual/schedule execution
  bypasses the orchestrator already (`triggering/execute.ts`
  `isOrchestratedTrigger`), so nothing there reads a policy.

### Tests (phase 1)

- `trigger-registry.test.ts`: delete lifecycle-callback suites; add
  classification suites (schema failure → `invalid_payload`, `eventTypePath`
  extraction, event-name fallback, correlation extraction, webhook-mode
  createTrigger without `eventTypePath` throws) and `resolveRoutingAction`
  cases (mapped, unmapped → ignore, undefined eventType → ignore).
  Event-mode option-prefixing suites survive unchanged.
- `webhook-routing.test.ts`: delete `routeWebhookEvent` suites; keep path
  derivation suites.
- Fixture fallout the type-checker will surface but the executor should
  budget for: `packages/core/src/app.test.ts` (lifecycle fixtures at ~L333,
  ~L380) and `packages/core/src/backend/lib/inngest/functions.test.ts`
  (~L113) register triggers with `lifecycle`; rewrite those fixtures to the
  new surface.

## Phase 2 — backend (`packages/core`)

### Wait node contract

- `waitForEvents` becomes `string[]` in node config and in wait-state
  metadata. Update `workflow-engine/core.ts` (read + persist), the two
  `parseCsvSet` readers (`triggering/orchestrator.ts`,
  `workflow-wait-resume.ts`) to set-membership over the array, and delete
  the now-unused `parseCsvSet` import sites (knip will confirm whether the
  helper itself survives).

### Engine-side trigger evaluation

- `runNodeWork` in `workflow-engine/core.ts` (~L1655-1688) calls
  `evaluateWorkflowTrigger` inside the run and branches on the old
  `routingDecision.kind`. Inside a run the policy has already been resolved
  at the entrypoint, so: classification `ok: false` maps to `triggerIgnored`
  with reason `invalid_payload`; `ok: true` always proceeds; the
  `stop_event` branch and the `event_not_configured` string in trigger
  output data are deleted.

### Cancellation scope

- New helper in `workflow-wait-state.ts` (or a sibling module):
  `listWorkflowInFlightExecutionsByCorrelation({ workflowId, correlationKey, runMode })`
  → executions with status in (`pending`, `running`, `waiting`), filtered
  directly on the executions table (runMode is a column there; no join).
- Generalize `workflow-cancellation.ts` `cancelWaitingRuns` →
  `cancelInFlightRuns`: input is execution ids (plus their wait-state ids for
  the `waiting` ones); per execution send `workflow/run.cancel.requested`
  (the `cancelOn` on every workflow function already kills mid-step and
  mid-sleep runs), mark the execution cancelled, cancel its wait states,
  audit `run_cancelled`.
- **Cancel is compare-and-set.** `markExecutionCancelled` updates by id with
  no status guard today; a `running` execution routinely completes between
  the in-flight query and the cancel write. The cancel update must carry
  `where status in ('pending','running','waiting')` (mirroring
  `markWaitStateStatus`), count only rows actually updated, and skip the
  `run_cancelled` audit event for rows that lost the race.

### `triggering/orchestrator.ts`

- Input becomes `{ runMode, eventType, correlationKey, action: RoutingAction, ignoreReason?, waitStates, inFlightExecutions, enableResumes, startExecution, cancelInFlightRuns, resumeWaitStates }`.
- `cancel` with zero in-flight executions → ignored
  (`reason: "no_in_flight_runs"`); `replace` with zero → start. Ordering is
  unchanged: stop/replace first, then resumes, then start/ignore.
- Ignore reasons become `missing_event_type | invalid_payload | event_not_mapped`
  (`event_not_configured` dies with the old model). Update
  `packages/shared/src/workflow/execution-contracts.ts` response shapes to
  match, including `no_waiting_runs` → `no_in_flight_runs`.
- `packages/shared/src/rpc/contracts.ts` (~L135-140) carries its own
  `ignoredReasonSchema` enum; derive both it and the
  `WorkflowExecutionIgnoredReason` union from one shared const in
  `execution-contracts.ts` so they cannot drift again.
- **Start-vs-resume ordering is intentional and gets pinned by a test:**
  resumes run before start, so an Event Type mapped to Start that also
  matches a waiting run's `waitForEvents` resumes that run and does not
  start a new one. The waiting run consumes the event.

### Callers

- `event-listener-function.ts`: pass `event.name` into
  `evaluateWorkflowTrigger` (the event-name fallback), read `routingPolicy`
  from `triggerConfig`, resolve the action, fetch both wait states and
  in-flight executions by correlation, orchestrate. Cancel reason:
  `` `Replaced by event ${eventType}` `` / `` `Cancelled by event ${eventType}` ``.
- `triggering/webhook.ts`: same changes minus `eventName` (none exists).
  Audit-message helpers in `triggering/run-lifecycle.ts`
  (`buildIgnoredRunAuditMessage`) updated for the new reasons; drop wording
  that names create/update/delete.
- `triggering/execute.ts`: a third caller, not a pass-through. It currently
  forwards the trigger's `routingDecision` (~L118-169); it must now read
  `routingPolicy` from the trigger config and call `resolveRoutingAction`
  exactly like the other two callers, passing the sole declared event name
  as the `eventName` fallback where applicable (see phase 1).

### Tests (phase 2)

- `triggering/orchestrator.test.ts`: rewrite for `action` input, widened cancel
  (in-flight execution with no wait state gets cancelled), `no_in_flight_runs`,
  replace-with-nothing-running starts, start-consumed-by-resume pinned.
- Cancel race test: execution completes between the in-flight query and the
  cancel write; row stays `success`, is not counted, no `run_cancelled`
  audit event. Do not build tests around `pending` (nothing writes it;
  including it in the filter is harmless).
- `triggering/run-lifecycle.test.ts`: message-builder cases for new reasons.
- `workflow-wait-resume.test.ts`: `waitForEvents` array instead of CSV.

## Phase 3 — client (`packages/client`)

### Routing Policy table

- New `config/routing-policy-editor.tsx`: rows of Event Type → action
  `Select` (Start / Replace / Cancel / Ignore, default Ignore). Two data
  sources:
  - Custom trigger: closed rows from trigger metadata `eventTypes`; every
    known Event Type always shows as a row.
  - Webhook trigger: builder adds/removes rows, Event Type is free text.
- Warning (amber pill, same pattern as existing `configWarnings`) when no
  Event Type maps to Start or Replace: "This workflow can never be
  triggered."
- Renders inside `trigger-config.tsx` for webhook (replacing the three CSV
  inputs in the routing section) and for custom triggers (new section under
  the trigger description). Both write `onUpdateConfig({ routingPolicy })`.
- When metadata `eventTypes` is absent or empty for a custom trigger (e.g.
  `eventTypePath` points at a plain string), the table falls back to
  free-text rows like the webhook's, so the trigger stays mappable.
- Two more webhook surfaces read the deleted CSV keys with no compile error
  (`config` is `Record<string, unknown>`): the Behavior Summary section
  (~L1029-1059) is rewritten against `routingPolicy`, and the CSV-overlap
  `configWarnings` (~L392-427) are deleted outright — a Record maps each
  Event Type to exactly one action, so overlap is unrepresentable.
- Correlation display: webhook keeps its `webhookCorrelationPath` select;
  custom triggers show a read-only line naming metadata `correlationPath`.

### Wait node

- `SharedHookWaitFields` in `action-config.tsx`: replace the CSV
  `TemplateBadgeInput` with a multi-select over the trigger's Event Type
  vocabulary (closed for custom triggers; webhook options are the policy
  table's Event Types plus free entry). Selected values persist as
  `waitForEvents: string[]`.
- Selected Event Types absent from the current vocabulary render as invalid
  chips the builder must remove.
- Helper copy names the concrete correlation path ("any event where
  `appointment.id` matches this run's") sourced from trigger metadata /
  webhook config.
- Warning on the Wait config when a selected Event Type is mapped to Replace
  or Cancel: "Runs waiting here will be cancelled by this event, not
  resumed."

### Plumbing

- `runtime-extensions.ts` hydration carries `eventTypes` and
  `correlationPath` through `/api/extensions`.
- The Wait config panel needs the trigger node's config and metadata; source
  the trigger node from `nodesAtom` (node-config-panel already reads all
  nodes) and metadata via `findRuntimeTrigger`.
- `workflow-toolbar.tsx` (~L371) branches on `result.reason ===
"no_waiting_runs"`; update its copy for `no_in_flight_runs`,
  `invalid_payload`, and `event_not_mapped`.

### Tests (phase 3)

- `trigger-config.test.tsx`: policy table renders closed rows for custom
  triggers, free rows for webhook; never-triggered warning; CSV inputs gone;
  existing assertions on the CSV inputs and Behavior Summary rewritten.
- Wait field tests: multi-select persistence as array, invalid chip on
  vocabulary change, replace/cancel conflict warning.

## Phase 4 — docs, examples, cleanup

- `README.md`: rewrite the `createTrigger` example and the Notes contract
  (L298-303): `eventTypePath` optional with event-name fallback, routing
  configured per workflow in the editor. Document event mode briefly while
  in there, since `lifecycle` leaves the example.
- `examples/app.ts`: drop `lifecycle`, note that routing is
  configured in the editor's policy table.
- `AGENTS.md`: no current line names lifecycle routing; verify and touch up
  any path this plan invalidates.
- Checks: `bun run type-check && bun run lint && bun test && bun run build && bun run knip && bun run fix`.

## Explicit non-goals

- Schedule trigger stays inert (config keys unread by the backend).
- No fire-and-forget triggers without correlation; `correlationIdPath` stays
  mandatory.
- No canvas-level warning badges on the trigger node; warnings live in the
  config panels like today's webhook warnings.
- `workflow-trigger-bootstrap.ts` no-op untouched unless knip objects.
- Manual per-execution cancel (`executions/cancel.ts`) still refuses
  non-waiting executions. After this change an event can cancel a running
  execution while the Runs panel button cannot; that inconsistency is
  deliberate here and tracked as a follow-up issue, not fixed in this plan.

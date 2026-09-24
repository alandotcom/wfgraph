# @wfgraph/core

## 4.0.0

### Major Changes

- [#189](https://github.com/alandotcom/wfgraph/pull/189) [`880eccd`](https://github.com/alandotcom/wfgraph/commit/880eccdf67105f40063989f71133a6c2f943af77) Thanks [@alandotcom](https://github.com/alandotcom)! - Replace the host `auth` predicate with a principal-free access-policy contract. `defineWfGraphAuth` gives extracted callbacks contextual types; authentication returns `WfGraphRoles.viewer`, `.editor`, `.admin`, another `WfGraphAccess` policy, or `null`. Unrestricted access is explicit through `WfGraphAccess.all` or `trustWfGraphUpstream()`, and Node and Worker APIs no longer carry principal type parameters.

  The authenticated extension bootstrap now carries every granted operation ID before the editor renders. The editor uses this page-lifetime snapshot synchronously to adapt controls and data requests. Account and policy changes require a page reload, and server-side authorization remains authoritative for every RPC, REST, and OAuth request. Authentication and policy callback failures now produce a sanitized 500 instead of being misreported as a 401 or 403.

- [#294](https://github.com/alandotcom/wfgraph/pull/294) [`f1440cc`](https://github.com/alandotcom/wfgraph/commit/f1440cc292b478b6f5353adc17880fa4eb2c8df5) Thanks [@alandotcom](https://github.com/alandotcom)! - Redesign the editor workspace around Canvas Reveal and generalized Groups

  The editor's resizable sidebar is replaced by Canvas Reveal, a panel that floats
  over the right side of the canvas in Draft, Runs, and Changes. Browse summarizes
  the selected step, Condition, Lifecycle Node, Event Split, Group, run, or change,
  and Focus holds its complete editor, a run node's evidence, or its field-level
  differences. On a canvas 1024px or wider, a handle on the panel's left edge
  resizes Browse and Focus by pointer or keyboard, and the browser remembers each
  width. The query string names the open workspace, run, comparison, and Group,
  so browser Back and Forward move between them and a copied link reopens the
  same view.

  A Group can now hold any two or more steps that meet the version 1 Group rules,
  including side-effecting actions, Waits, and Conditions. The workflow canvas
  shows a Group as one collapsed card with one outlet. The card and summary display
  the Group's description, and the context menu's Edit command opens its editing
  form directly. Entering a Group opens a
  canvas of its members at their stored positions. Members can be dragged, added,
  pasted, duplicated, connected, and deleted. Tidy layout arranges the focused
  members in one undoable edit without moving outside steps. Add step after
  inserts between an outlet and its existing targets; dragging an outlet into
  empty canvas creates a branch without an automatic rejoin. Connections that
  would create a cycle are refused before saving.
  Connecting the card's outlet keeps existing continuation ports or connects from
  terminal non-Condition steps. Unused Condition outlets stay unwired, so an unused
  branch ends the path without running the step after the Group. Grouping never changes what a run executes. Runs shows a Group's run status and step counts, and Changes
  counts Group edits as Organization changes. Publish refuses a Group that breaks
  the rules listed in `docs/embedding.md` ("Groups"). A draft save refuses Group
  membership errors and edges that touch a Group frame, and a draft that breaks only the Publish rules still saves
  and runs. The build agent and MCP authoring keep existing Groups
  valid and cannot create a Group or ungroup one.

  On a phone, Draft, Runs, and Changes use a sequence of sheets. A Workflow
  Builder there can inspect objects and edit the configuration of existing steps,
  and cannot add, move, delete, connect, group, or ungroup steps.

  A Group's config is now empty. Graph decoding refuses every config key, so a
  draft or published version that still stores `direction`, `entryNodeIds`,
  `exitNodeIds`, or `outletHandle` in a Group's config fails to load. This
  release ships no migration for those keys.

- [#219](https://github.com/alandotcom/wfgraph/pull/219) [`b9742c1`](https://github.com/alandotcom/wfgraph/commit/b9742c19c9bacbfad74d9c8c6e2067a4f18dc776) Thanks [@alandotcom](https://github.com/alandotcom)! - Remove Workflow Graph API-key management and the external wait-resume HTTP endpoint. Resume parked runs through the authenticated `workflow.resumeWait` operation.

### Minor Changes

- [#215](https://github.com/alandotcom/wfgraph/pull/215) [`a39fdbe`](https://github.com/alandotcom/wfgraph/commit/a39fdbee8ce9b2ec67a61cc4a82f0536142537f1) Thanks [@alandotcom](https://github.com/alandotcom)! - Render the agent's working-out with assistant-ui's own thread elements

  The panel folded reasoning and tool calls into one hand-written "Thinking"
  disclosure, which in practice held tool calls alone: the model request asked for
  a reasoning effort but never for a reasoning summary, so no reasoning text was
  ever streamed. Each row was named after the function that ran, so a turn that
  searched the catalog five times drew five copies of "Read list_actions."

  Reasoning now streams and is drawn by assistant-ui's step-panel design, vendored
  under `components/agent/elements` from their Base UI registry: a "Thinking"
  disclosure holding one titled step per passage, open while the turn runs and
  settled to how long it took. Tool calls fold under a count beneath it, and each
  row is named by what the call asked for ("Searched actions for "slack""),
  derived from the tool and the arguments the model wrote. A write tool's own
  sentence still wins once it settles.

  The panel also gains an expand control that covers the editor with a centred,
  reading-width card, and returns to the canvas on Escape, on a click outside, or
  when the panel is closed.

  A read tool's `tool-result` stream part now carries no `summary`, where it
  previously carried a sentence built from the tool's own name. A turn that fails
  mid-stream now reaches the panel as the message's own incomplete status rather
  than as a synthetic tool call.

- [#212](https://github.com/alandotcom/wfgraph/pull/212) [`a626e46`](https://github.com/alandotcom/wfgraph/commit/a626e46474bd98719fb0f4908733812996555cd2) Thanks [@alandotcom](https://github.com/alandotcom)! - Let a host choose how hard the build agent thinks, and pin the default.

  `agent.reasoningEffort` takes `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, and reaches the provider unchanged. Nothing set an effort before, so every turn ran at the provider's default for the configured model. That default belongs to the provider and can move without any change on an adopter's side, which is reason enough to name it here.

  The default is `medium`, which is what `gpt-5.6` defaults to today, so this pins current behaviour rather than altering it. Measuring `high` against it over twenty trials per arm separated nothing: 16 of 20 against 12 of 20 on one suite, 21 of 21 against 19 of 21 on another, and no failure in either arm was one more thinking would fix. A host who wants more can ask for it.

- [#212](https://github.com/alandotcom/wfgraph/pull/212) [`a626e46`](https://github.com/alandotcom/wfgraph/commit/a626e46474bd98719fb0f4908733812996555cd2) Thanks [@alandotcom](https://github.com/alandotcom)! - Give the build agent a way to undo a turn.

  `revert_draft` puts the graph back as it was when the turn began. Nothing could undo an edit before, which is why the agent was told to finish all capability discovery before its first write: an unavailable capability had to leave the graph untouched, and that promise is unkeepable once anything has been written. With an undo the promise is keepable after a write, so the ordering rule is gone. Discovery still has to precede the step that uses an action, which is what stops the agent inventing one.

  The tool is turn-scoped. The MCP endpoint does not expose it, because an MCP call is its own request against the persisted draft, which makes the state it began in the state it is already in.

- [#212](https://github.com/alandotcom/wfgraph/pull/212) [`a626e46`](https://github.com/alandotcom/wfgraph/commit/a626e46474bd98719fb0f4908733812996555cd2) Thanks [@alandotcom](https://github.com/alandotcom)! - Tell the build agent when an Event wait changes what the steps below it can read.

  An event-mode Wait becomes the Arriving Event for everything below it, so the Lifecycle Node there carries the waited-for payload and the Start Event payload is gone. Nothing said so, and a caller that had already collected a token could write it into a step that can no longer resolve it, with Publish the next thing to notice.

  `list_references` now returns `declaredBy` on every Lifecycle Node reference, naming the Events the path came from, and marks those references nullable below a Wait that continues past its timeout, since a timed-out run arrives with no payload at all. `set_wait` and `set_lifecycle_rules` return a `warning` listing the config values their edit just stranded. The refusal for an unreadable until-timing token now names the Wait that took the payload away instead of pointing back at `list_references`.

- [#191](https://github.com/alandotcom/wfgraph/pull/191) [`85d931f`](https://github.com/alandotcom/wfgraph/commit/85d931fd65b004dec9d5d956e13b870af8fd22c3) Thanks [@alandotcom](https://github.com/alandotcom)! - Add read-only workflow version usage diagnostics for active runs, action availability, and catalog drift.

- [#181](https://github.com/alandotcom/wfgraph/pull/181) [`cbd75a8`](https://github.com/alandotcom/wfgraph/commit/cbd75a8e57b27d242ffededcd1d866d92fa377f1) Thanks [@alandotcom](https://github.com/alandotcom)! - Show a connection's stored value as the placeholder for the config field that falls back to it. Resend's From, and Twilio's From Number and Messaging Service SID, are optional on the node and the handler reads the connection when they are blank; the editor now says which value that is instead of drawing a generic example.

  An action config field declares the fallback with `connectionDefaultKey`, naming one of the integration's own credentials, held to that set by the type. `checkIntegration` refuses a key the integration does not declare and refuses a `password` one, since the browser holds a mask in place of a secret. That declaration is also the allowlist for the new `connectionDefaults` on a connection summary: a stored value no field names never reaches the editor.

  Also fixes a template field redrawing only when its text changed, which left a stale placeholder on screen after the value behind it moved.

- [#212](https://github.com/alandotcom/wfgraph/pull/212) [`a626e46`](https://github.com/alandotcom/wfgraph/commit/a626e46474bd98719fb0f4908733812996555cd2) Thanks [@alandotcom](https://github.com/alandotcom)! - Add the `create_workflow` MCP tool for creating workflow drafts.

- [#176](https://github.com/alandotcom/wfgraph/pull/176) [`ba1046a`](https://github.com/alandotcom/wfgraph/commit/ba1046a97333d6e0ab7989d828489673315a5944) Thanks [@alandotcom](https://github.com/alandotcom)! - `workflow.execute` accepts `graph: "draft"`, which runs the graph on the
  workflow's canvas. The draft passes the same checks a published start runs, is
  frozen as a draft snapshot version, and the run is pinned to that row. A
  workflow that has never been published can therefore run, and an edit can be
  tried without publishing it.

  A draft run always reaches test recipients. Its response, its Execution row, its
  Inngest event and its audit rows record `runMode: "test"` whatever the
  workflow's mode is, because nobody has reviewed the graph it executes. The
  workflow's own mode is the Published mode alone. It decides who Events and
  manual runs of the published version reach, and a draft run ignores it.
  Concurrency keys its in-flight set on the mode, so a draft run sits beside a live
  run of the same entity instead of superseding it.

  Every other rule a manual start follows is unchanged, including the pause gate,
  the manual-start rule, and the Start Event a run stands in for.

  The editor sends the canvas before it starts a draft run. Run draft flushes the
  autosave queue, so an edit made shortly before the click is part of the run. A
  refused save stops the run and reports the reason.

- [#176](https://github.com/alandotcom/wfgraph/pull/176) [`ba1046a`](https://github.com/alandotcom/wfgraph/commit/ba1046a97333d6e0ab7989d828489673315a5944) Thanks [@alandotcom](https://github.com/alandotcom)! - A workflow version records which of two kinds it is. `workflow_versions` gains a `kind` column holding `published` or `draft_snapshot`, and its `version` number is nullable because a snapshot has none. A published version is what Publish creates and what `published_version_id` points at. A draft snapshot is the frozen canvas graph a draft run pins itself to; it stays out of the version history, out of the next-version number, and out of the Event subscription index. PostgreSQL needs a migration. A SQLite database migrates itself on open, rebuilding the table with its foreign keys intact.

  `workflow.execute` takes an optional `graph` of `"published"` or `"draft"`. An absent field means published, which is what every existing caller sends and what every Event start runs.

  Every run a client reads carries `versionKind` and `versionNumber`, on the two run-list procedures and on the run summary that `getExecutionLogs` returns. Run history can then name the graph a run executed: the draft, or the published version by its number.

- [#204](https://github.com/alandotcom/wfgraph/pull/204) [`f45415e`](https://github.com/alandotcom/wfgraph/commit/f45415eb56b5383acf2aaa0f108f2ca5cdc4e211) Thanks [@alandotcom](https://github.com/alandotcom)! - Add a Cancel Filter to each Cancel Event. The filter checks the arriving payload before cancellation and before the Correlation Path is required.

  A declined or unevaluable filter leaves active runs unchanged and records why cancellation did not occur. Wait Subscriptions still receive the Event.

  The Lifecycle panel and build agent support shared or per-Event Cancel Filters with the same condition editor used by Start Filters.

  The release adds workflow audit indexes for efficient Refused Starts and Cancellation Failures queries. PostgreSQL deployments must run migrations. SQLite migrates on open.

- [#157](https://github.com/alandotcom/wfgraph/pull/157) [`dea6043`](https://github.com/alandotcom/wfgraph/commit/dea6043a2455cda99058ac23d6e4421751c1e606) Thanks [@alandotcom](https://github.com/alandotcom)! - Disconnecting OAuth now removes a connection the grant supplied on its own. Previously the row was kept with the grant stripped out, which left a connection holding no credential at all: it stayed in the node's connection picker, drew a check when a node selected it, and failed only at run time. A connection carrying a credential the operator entered themselves is still kept, which is the case the disconnect-as-escape-hatch exists for.

  `integration.disconnectOAuth` answers `removed` alongside `success`, saying which of the two happened. The editor closes the dialog and repairs the nodes that named the connection when it is gone, taking the same path a delete takes.

  Disconnecting confirms before it acts, and the confirmation says which of the two outcomes applies: it names the connection being removed when the grant is its only credential, and says the credentials the operator entered themselves survive when they do. Revoking the grant at the provider cannot be undone from the editor, so the click that starts it is no longer the click that does it.

- [#303](https://github.com/alandotcom/wfgraph/pull/303) [`1dd921e`](https://github.com/alandotcom/wfgraph/commit/1dd921e80f0938b9a8c0605932aac9a800da480c) Thanks [@alandotcom](https://github.com/alandotcom)! - Expose current tracked Entity State as a virtual template source when Entity Eligibility is configured. Each consuming node resolves its referenced fields immediately before execution, shares that snapshot with before-node Eligibility, and retains only projected values for durable replay.

- [#305](https://github.com/alandotcom/wfgraph/pull/305) [`6a353f1`](https://github.com/alandotcom/wfgraph/commit/6a353f102bad16b193bbac256617d0f7dc484b37) Thanks [@alandotcom](https://github.com/alandotcom)! - Show Event descriptions throughout the editor, derive readable field labels from property keys, and use JSON Schema `title` as an optional label override and `description` as help text across Event payloads, Action forms, references, agent tools, and built-in integrations.

- [#190](https://github.com/alandotcom/wfgraph/pull/190) [`b67678b`](https://github.com/alandotcom/wfgraph/commit/b67678b8b16285e52be9e334008df7a30149b72c) Thanks [@alandotcom](https://github.com/alandotcom)! - Add standard asynchronous disposal to `WfGraphApp`, so lexically scoped apps can use
  `await using` while long-running hosts retain the explicit `dispose()` API.

- [#235](https://github.com/alandotcom/wfgraph/pull/235) [`af1be0d`](https://github.com/alandotcom/wfgraph/commit/af1be0d713031db1774c9c17e7dd4099bcc99bb0) Thanks [@alandotcom](https://github.com/alandotcom)! - Improve Lifecycle configuration with clearer run behavior, optional Entity eligibility, binding diagnostics, and compact outcome summaries.

  Add enum set conditions with multi-select values and add the `entityResolverTimeoutMs` host option, which defaults to 10 seconds.

- [#319](https://github.com/alandotcom/wfgraph/pull/319) [`32f61a8`](https://github.com/alandotcom/wfgraph/commit/32f61a86a573d75d1f0f5e21859e6e2196e5d5b1) Thanks [@alandotcom](https://github.com/alandotcom)! - Let host-defined actions supply schema-keyed `options` callbacks for dynamic pickers. Callbacks receive current draft selections, and the editor refreshes dependent choices and clears selections that are no longer available. Authored configuration fields remain available for presentation overrides. Config input and output reference fields can use `showWhen.in` to match any listed variant while preserving existing `equals` conditions.

- [#181](https://github.com/alandotcom/wfgraph/pull/181) [`cbd75a8`](https://github.com/alandotcom/wfgraph/commit/cbd75a8e57b27d242ffededcd1d866d92fa377f1) Thanks [@alandotcom](https://github.com/alandotcom)! - Integrations may declare Events and a Connection-addressed webhook. Resend ships all 19 official webhook event types. An integration-owned Start, Cancel, or Wait Event requires a Connection at Publish, and Publish checks that Connection exists and is the integration's own type, the same check an action's connection already got. Two integrations may not both claim one Event, and an integration Event may not declare a payload field at `__wfgraphConnectionId`, which carries the Connection an arrival came through.

- [#235](https://github.com/alandotcom/wfgraph/pull/235) [`af1be0d`](https://github.com/alandotcom/wfgraph/commit/af1be0d713031db1774c9c17e7dd4099bcc99bb0) Thanks [@alandotcom](https://github.com/alandotcom)! - Add host-defined Entities, typed Event bindings, Lifecycle Entity Eligibility, and exited run outcomes.

- [#231](https://github.com/alandotcom/wfgraph/pull/231) [`321b8af`](https://github.com/alandotcom/wfgraph/commit/321b8afac9494774786308e91cb43efdb0c8add1) Thanks [@alandotcom](https://github.com/alandotcom)! - Move parked runs to another published version

  An adopter can now move a run that is parked on a Wait from the version it
  pinned to another published version of the same workflow, through
  `workflow.previewMigration` and `workflow.migrateExecutions`. A delay Wait now
  parks on a signal-interruptible timeout, and a Wait's output reports `hops`, how
  many times the run parked at that node.

  An adopter with parked runs drains them before upgrading to this release. Wait
  step ids and the delay park changed, so a run parked under an earlier release
  resumes into a handler that has none of the steps it parked under.

- [#175](https://github.com/alandotcom/wfgraph/pull/175) [`351ff6b`](https://github.com/alandotcom/wfgraph/commit/351ff6bd22b8d007905beda8c1e564cbf173d962) Thanks [@alandotcom](https://github.com/alandotcom)! - The spans a publish, a version read and a run's start or cancellation open now carry stable OpenTelemetry names, so a host's dashboards and alerts can key off them. Nine service spans are named `wfgraph.<domain>.<operation>` beside the five the engine has always opened: `wfgraph.workflow.publish`, `wfgraph.workflow.publish_readiness`, `wfgraph.workflow.version.compare`, `wfgraph.workflow.version.history`, `wfgraph.workflow.version.restore`, `wfgraph.execution.start`, `wfgraph.execution.load_workflow`, `wfgraph.execution.preflight` and `wfgraph.execution.cancel`. They replace the function names those spans used to arrive under, which were `publishWorkflow`, `checkPublishReadiness`, `compareWorkflowVersion`, `getWorkflowVersionHistory`, `restoreWorkflowVersion`, `postWorkflowExecute`, `loadWorkflowForRun`, `runWorkflowExecutionPreflight` and `postExecutionCancel`.

  Each of the nine annotates the identifiers it is about: the workflow id, the execution id, the publication version id and number, and the version a comparison read against. `wfgraph.outcome` names how the call ended in one machine word, which is the publish conflict code on a refused publish, `ignored` on a start a lifecycle rule turned away, and `canceled` or `already_finished` on a cancellation. Every attribute is one of those identifiers or that outcome word. `docs/embedding.md` has the full table.

- [#181](https://github.com/alandotcom/wfgraph/pull/181) [`cbd75a8`](https://github.com/alandotcom/wfgraph/commit/cbd75a8e57b27d242ffededcd1d866d92fa377f1) Thanks [@alandotcom](https://github.com/alandotcom)! - A payload field whose schema leaves the key optional now reaches the editor marked nullable, so the condition picker badges it and offers `is set` and `is not set` on that path. Only a field declared as null carried the mark before, which made `Schema.optionalKey` look like a value every run carries.

  Resend's webhook Events are held to one rule read off its docs and the `resend-node` types: a key is required where both sources agree Resend always sends it. `broadcast_id`, `template_id` and `tags` are the keys an email payload can arrive without. Three schema gaps against the docs close with the same pass. `email.suppressed` now declares the suppression details Resend sends with that event. A bounce carries the receiving server's raw SMTP responses. The inbound `email.received` payload is described by its own type, the one Resend documents for a received email.

- [#181](https://github.com/alandotcom/wfgraph/pull/181) [`cbd75a8`](https://github.com/alandotcom/wfgraph/commit/cbd75a8e57b27d242ffededcd1d866d92fa377f1) Thanks [@alandotcom](https://github.com/alandotcom)! - A key-value config field's values carry `{{@nodeId:Label.path}}` references, resolved one row at a time so a resolved quotation mark or newline no longer costs the step every row. An output or Event payload field typed `Schema.Record` is addressable by key: choosing the record on a condition draws a Key box that takes any name, since an Event carries whatever keys its sender attached, and the template menu takes a key under it too. A rule whose key is unnamed is refused rather than compared against the whole record. Where a key-value config field declares `fillsRecords`, the editor reads those names off the graph and offers them as paths: a Send Email node tagged `order_id` makes `tags.order_id` and `data.tags.order_id` selectable rather than something to be typed. Resend's Send Email answers the tags it carried, keyed by name, which is the shape its webhooks echo.

- [#157](https://github.com/alandotcom/wfgraph/pull/157) [`dea6043`](https://github.com/alandotcom/wfgraph/commit/dea6043a2455cda99058ac23d6e4421751c1e606) Thanks [@alandotcom](https://github.com/alandotcom)! - Add config fields whose shape the node's connection answers. Two field types join the vocabulary: `provider-select` draws a dropdown over what the connection lists, and `provider-fields` draws one input per value the current selection declares, stored as one JSON object under the one config key. An integration declares what each asks under `configOptions`, keyed by the name a field's `optionsSource` uses, and `checkIntegration` refuses a field wired to a provider that cannot answer it.

  The editor asks over `integration.configOptions`, which resolves the connection's credentials server-side the way the connection test does. Credentials never reach the browser, and neither does a failed request's own exception text. A provider refusing is an answer rather than an error, so the sentence it wrote is what the panel shows. Every provider-backed field falls back to the plain control it replaces, so a missing connection, a grant too narrow to read, or a provider that is down never leaves a builder unable to type the value themselves.

- [#315](https://github.com/alandotcom/wfgraph/pull/315) [`00ea0d1`](https://github.com/alandotcom/wfgraph/commit/00ea0d1620c892462e5a8d00c9bae51bb373c54a) Thanks [@alandotcom](https://github.com/alandotcom)! - Show schema-defined enum option labels in action inputs, conditions, and Test Run payload fields while preserving the original stored values.

- [#214](https://github.com/alandotcom/wfgraph/pull/214) [`043c717`](https://github.com/alandotcom/wfgraph/commit/043c717823c64f30f5c3808823551e1122d37300) Thanks [@alandotcom](https://github.com/alandotcom)! - Refresh every dependency, including sixteen major upgrades.

  What an adopter installs changes: `@wfgraph/plugins` now needs `@clerk/backend`
  3 and `@linear/sdk` 92, `@wfgraph/core` and `@wfgraph/shared` need
  `@marcbachmann/cel-js` 8, `@wfgraph/shared` needs `@dagrejs/dagre` 3, and the
  `@orpc` 2.0 beta line moves to beta.32 across all six packages.
  `@wfgraph/core` and `@wfgraph/shared` install `uuid` 14, which took over from
  `nanoid` as the generator behind every id this repository mints. No exported
  API changed.

  Vitest 5 now runs the main suite, as required by `@effect/vitest` rc.113. The
  private eval package keeps its own Vitest 4 runner because `vitest-evals` still
  caps its peer range below 5.

  `@types/node` 26 remains held back because it is ahead of the Node 24 that the
  `engines` floor and CI both name. Typing against a newer runtime than the floor
  would compile code that fails on it.

- [#157](https://github.com/alandotcom/wfgraph/pull/157) [`dea6043`](https://github.com/alandotcom/wfgraph/commit/dea6043a2455cda99058ac23d6e4421751c1e606) Thanks [@alandotcom](https://github.com/alandotcom)! - Pick a Resend template from the connection instead of typing its id. The Send Email action's Template field lists the account's own templates, drafts labelled as such, and the Template Variables field draws one input per variable that template declares. A variable Resend has a fallback for is prefilled with it and left out of what is sent, so Resend applies it; a variable with no fallback is marked required, because Resend refuses the send without one.

  Reading templates needs Resend's full-access grant, which its own scope vocabulary offers nothing narrower than. A send-only connection says so in the field and keeps the plain id input, so nothing that worked before stops working.

  A provider may report a field as `required` on `ConfigOptionField`, which the editor draws as a required input.

  Fixes an OAuth adapter's granted-access label being able to fail a token refresh: `grantedAccessLabel` is what a dialog draws, so a scope the adapter cannot word now answers nothing rather than turning a working grant into one an operator has to reauthorize.

- [#176](https://github.com/alandotcom/wfgraph/pull/176) [`ba1046a`](https://github.com/alandotcom/wfgraph/commit/ba1046a97333d6e0ab7989d828489673315a5944) Thanks [@alandotcom](https://github.com/alandotcom)! - `workflow.execute` takes an optional `expected` of `{ versionId, mode }`. A
  published run carries what the run dialog displayed, and the server refuses the
  run with a `CONFLICT` when the published version or the workflow's Published
  mode has moved since. Without it, a dialog left open across a publish or a mode
  change starts a run against a graph or a set of recipients nobody saw. A draft
  run sends no `expected`, because it reads the canvas. The editor sends the key
  for every published run it offers.

  A draft snapshot is reused for a repeated run of an unchanged canvas only once
  an Execution references it. An unreferenced snapshot belongs to the request that
  inserted it, which can still release it when a later gate refuses the start, so
  handing that row to a concurrent request would let one run pin a version id the
  other is about to delete.

- [#193](https://github.com/alandotcom/wfgraph/pull/193) [`b54de05`](https://github.com/alandotcom/wfgraph/commit/b54de05181ee752cff7b9af7598abc715f2b2c19) Thanks [@alandotcom](https://github.com/alandotcom)! - Add a Start Filter to each Start Event: the condition an arrival must satisfy before a run opens. It is read after the Event is confirmed to hold the start role and before Concurrency, so an arrival the filter declines opens no Execution and displaces nothing under newest-wins. A Condition node behind the Started outlet cannot do this, because by the time it runs the Execution already exists and Concurrency has already superseded whatever was in flight (ADR-0016).

  A declined arrival writes one `run_refused` audit row and appears in the Refused Starts panel; parked Wait nodes in the same workflow still receive the Event. A filter that cannot be evaluated against the payload declines the start too, on the same reasoning a Wait match uses, and says so on the row.

  The Lifecycle panel collapses the filter onto the Start Events that agree, offering the fields all of them declare plus the row naming the arriving Event, and splits into one control per Event on request or when the filters diverge. Publishing refuses a filter that is unfinished, that reads a field its Start Event does not declare, or that compares against a value only a run would hold.

- [#175](https://github.com/alandotcom/wfgraph/pull/175) [`351ff6b`](https://github.com/alandotcom/wfgraph/commit/351ff6bd22b8d007905beda8c1e564cbf173d962) Thanks [@alandotcom](https://github.com/alandotcom)! - A publish refused because publication moved now says so in a form the editor can act on. The two refusals carry a machine-readable code beside their sentence: `workflow_publish_stale` when the version the draft was reviewed against is no longer current, and `workflow_already_published` when the graph offered is the one already published. Each stays a 409 over oRPC and over HTTP, keeping the wording an operator reads. `@wfgraph/shared/rpc/error-codes` is the one home of those codes, which both ends import.

  The editor branches on the code. A stale refusal closes the obsolete review, re-reads the workflow's publication state and version history, and asks the operator to review again, with the canvas still holding the draft. An already-published refusal closes the review and reports that there were no changes to publish. Every other publish failure behaves as before, including the toast it has always raised.

  `ApiError` in `@wfgraph/client` carries the `code` an oRPC failure arrived with, alongside the status and message it has always had. `code` is set when the payload carries one as a non-empty string, and stays unset otherwise.

- [#212](https://github.com/alandotcom/wfgraph/pull/212) [`a626e46`](https://github.com/alandotcom/wfgraph/commit/a626e46474bd98719fb0f4908733812996555cd2) Thanks [@alandotcom](https://github.com/alandotcom)! - Add an opt-in stateless MCP endpoint for discovering and editing existing workflow drafts.

- [#308](https://github.com/alandotcom/wfgraph/pull/308) [`39db189`](https://github.com/alandotcom/wfgraph/commit/39db189784b927b438add117a7dc30a40af9c4ea) Thanks [@alandotcom](https://github.com/alandotcom)! - Expose tracked Entity State to text autocomplete and Condition nodes without requiring Entity Eligibility. Each consuming node resolves only the referenced fields, and a before-node Eligibility check shares that snapshot when configured.

- [#314](https://github.com/alandotcom/wfgraph/pull/314) [`98a7b56`](https://github.com/alandotcom/wfgraph/commit/98a7b56b88e091dcd258ffa8115903b753b0af7d) Thanks [@alandotcom](https://github.com/alandotcom)! - Add a maximum-lateness policy to time-based Wait steps. A Wait can now continue when its target is only slightly late, skip the branch after a configured duration, and evaluate that limit before applying its allowed-hours window.

- [#157](https://github.com/alandotcom/wfgraph/pull/157) [`dea6043`](https://github.com/alandotcom/wfgraph/commit/dea6043a2455cda99058ac23d6e4421751c1e606) Thanks [@alandotcom](https://github.com/alandotcom)! - Let a Resend connection be granted full access, which is what Resend requires to read templates. The client metadata document now registers both of Resend's scopes rather than `emails:send` alone. The registered set is the ceiling on what an operator may grant, so registering one scope was what grayed out "Full access" on Resend's consent page; registering both makes the page's own Permission chooser live. The authorization names no scope, which asks for the whole registered set and leaves the choice where it is made.

  An `IntegrationOAuth` adapter can report `grantedAccessLabel` on its token set: how much access the provider granted, in the provider's own words, read off the token response rather than assumed from the request. Both `exchange` and `refresh` return it, so a provider that narrows a grant is recorded rather than left claiming the old access. The connection dialog shows it read-only beside the account, and offers Reconnect on a working connection, which is the only thing that can change a grant.

### Patch Changes

- [#181](https://github.com/alandotcom/wfgraph/pull/181) [`cbd75a8`](https://github.com/alandotcom/wfgraph/commit/cbd75a8e57b27d242ffededcd1d866d92fa377f1) Thanks [@alandotcom](https://github.com/alandotcom)! - Bound webhook request bodies before a Connection lookup. A body over 1 MiB now receives a 413 response rather than being buffered.

- [#205](https://github.com/alandotcom/wfgraph/pull/205) [`2a7acfb`](https://github.com/alandotcom/wfgraph/commit/2a7acfb21366a8f4fa896bb4197cd13ff1e48df2) Thanks [@alandotcom](https://github.com/alandotcom)! - Improve build-agent validation and recovery guidance. The agent now reports the same draft and publication failures as the production workflow checks.

- [#324](https://github.com/alandotcom/wfgraph/pull/324) [`8455565`](https://github.com/alandotcom/wfgraph/commit/845556529604ebc381ffb45c651f6937693a9b46) Thanks [@alandotcom](https://github.com/alandotcom)! - Resolve nonexistent local Wait timestamps and allowed-hours starts to the first
  valid time after a clock-forward transition, while keeping adjusted deadlines
  inside the configured window.

- [#157](https://github.com/alandotcom/wfgraph/pull/157) [`dea6043`](https://github.com/alandotcom/wfgraph/commit/dea6043a2455cda99058ac23d6e4421751c1e606) Thanks [@alandotcom](https://github.com/alandotcom)! - Keep OAuth-provided credentials read-only while allowing other connection settings to be edited and tested with the saved OAuth grant, including Resend grants limited to email sending. A connection test now learns which credentials an OAuth grant issued, through a second `IntegrationTestContext` argument on the integration `test` function. The editor reports a credential field as configured from what the server actually stored, so a disconnected connection shows an empty field rather than a filled one, and it keeps offering the OAuth flow so a disconnect stays reversible. `slack({ oauthClient })` reads a pair that is blank on both sides as manual-only, which lets a host pass its environment straight through.

- [#235](https://github.com/alandotcom/wfgraph/pull/235) [`af1be0d`](https://github.com/alandotcom/wfgraph/commit/af1be0d713031db1774c9c17e7dd4099bcc99bb0) Thanks [@alandotcom](https://github.com/alandotcom)! - Recover the runs that a Cancel claim or a delivery retry used to strand.

  - A Wait behind the Canceled outlet now parks, wakes on its Event, and runs as a durable branch; before, the Cancel claim refused the park and the cleanup nodes behind it never ran.
  - A fatal engine failure that finds a Cancel claim at the terminal write now runs the Canceled outlet before recording `canceled`. An interrupted attempt writes no terminal record, so the retry runs the outlet.
  - A retried Event delivery answers from the admission decision an earlier attempt committed before it reads the current publication, so a Publish, unpublish, or catalog change between attempts no longer strands a committed Execution at `pending`.
  - A woken Wait is settled by the run that consumed it, so a settle write that fails after the signal was accepted no longer leaves the row at `resuming` or reports a failed resume for a run that woke.
  - A retried Event delivery no longer sends again a run the bus already took, so it no longer writes a second "run started" entry, and a failed second send no longer stops a healthy run that is parked in a Wait.
  - When the bus refuses a run's send, the compensation no longer stops a run that holds a Cancel or Exit claim, so the run can still run its Canceled outlet or record `exited`. The row is closed first, and the stop signal goes only to a run whose row that close wrote.
  - Cancelling a run that is already canceling now answers a conflict instead of an internal failure, so the Runs panel says the run is on its way out rather than reporting a failure.
  - Every id Workflow Graph mints, including workflow, version, run, integration, node, edge and condition ids, is now a 36-character UUIDv7 string rather than a 21-character nanoid, so an adopter reading one off the API or a saved graph sees the longer, time-ordered form. Rows written before the upgrade keep the ids they already hold, so a database can carry both shapes.
  - A run's audit timeline now reads newest first in insertion order, including for rows a single transaction wrote in the same instant. This ships a PostgreSQL migration that adds a `seq` identity column to `workflow_execution_events` and rebuilds that table's three indexes; SQLite needs no migration.

- [#324](https://github.com/alandotcom/wfgraph/pull/324) [`8455565`](https://github.com/alandotcom/wfgraph/commit/845556529604ebc381ffb45c651f6937693a9b46) Thanks [@alandotcom](https://github.com/alandotcom)! - Preserve results for nodes with prototype-sensitive IDs so failed actions cannot be reported as successful runs.

- [#324](https://github.com/alandotcom/wfgraph/pull/324) [`8455565`](https://github.com/alandotcom/wfgraph/commit/845556529604ebc381ffb45c651f6937693a9b46) Thanks [@alandotcom](https://github.com/alandotcom)! - Refuse an execution migration when its parked Waits have changed since eligibility was checked. Serialize PostgreSQL repark writes with migration so an old-version park cannot overwrite the migrated state.

- [#299](https://github.com/alandotcom/wfgraph/pull/299) [`69833ca`](https://github.com/alandotcom/wfgraph/commit/69833caa4cb8b3bdd62ba808eb4c480f96d01a51) Thanks [@alandotcom](https://github.com/alandotcom)! - `app.dispose()` now finishes promptly after a run whose action steps ran in parallel. Before this change it never finished once a fan-out or the two arms of a join had run in the process.

  In async step mode, Inngest never settles the `step.run` promise of a step it planned in parallel, so the invocation that planned the steps stays parked. Every action ran inside an uninterruptible Effect region that included that wait, and disposal waits for every fiber the app runtime started, so the parked invocation held disposal open forever. The region is gone. Disposal now interrupts a parked invocation at once, and it waits only for step bodies Inngest has started, so persistence stays open until those bodies finish.

- [#234](https://github.com/alandotcom/wfgraph/pull/234) [`a55f793`](https://github.com/alandotcom/wfgraph/commit/a55f7932f8b896701cc1d5fd923e316f0f9d5d48) Thanks [@alandotcom](https://github.com/alandotcom)! - Bump the Effect v4 release candidate from 4.0.0-rc.111 to 4.0.0-rc.113, along with `@effect/vitest`, `@effect/opentelemetry`, `@effect/sql-sqlite-node` and `@effect/ai-openai`, which each name that exact core version as a peer.

  The release adds a `StandardSchema` module to `effect`, holding the Standard Schema specification's type declarations vendored from `@standard-schema/spec`. `@wfgraph/shared`'s `toStandardSchema` stays the bridge this repo crosses, because it bakes in the decode options a wire schema needs.

  The build agent now uses Effect AI's renamed Chat type and opaque streamed tool parameters. Linear error decoding uses open schemas after Effect removed the decode option that preserved excess properties. The main suite now runs on Vitest 5 as required by `@effect/vitest`; the private eval harness keeps an isolated Vitest 4 runner for `vitest-evals`.

  Raise the Hono peer floor to 4.13.7, which fixes the server-side JSX escaping advisory GHSA-hxh3-vqpv-xpqv, and update Inngest to 4.20.0. Refresh the repository's compatible development dependencies alongside them.

- [#265](https://github.com/alandotcom/wfgraph/pull/265) [`3d35f5e`](https://github.com/alandotcom/wfgraph/commit/3d35f5e1656dbe2faada0e08a77444339e1278bb) Thanks [@alandotcom](https://github.com/alandotcom)! - Bump the Effect v4 release candidate from 4.0.0-rc.113 to 4.0.0-rc.115, along with `@effect/vitest`, `@effect/opentelemetry`, `@effect/sql-sqlite-node`, and `@effect/ai-openai`, which each name that exact core version as a peer.

  The two releases between rc.113 and rc.115 ship bug fixes: corrected published type declarations, a schema-generation fix for struct fields named `__proto__`, and an HTTP response fix for status codes 204, 205, and 304. rc.114 renames `Schema.Annotations.ToArbitrary.Constraint` to `Schema.Annotations.ToArbitrary.FilterConstraint`; this repository does not reference that name. This repository needed no other changes for the bump.

- [#192](https://github.com/alandotcom/wfgraph/pull/192) [`c8d007c`](https://github.com/alandotcom/wfgraph/commit/c8d007c04c8758f13d2fcbfd9a1075192bfa1094) Thanks [@alandotcom](https://github.com/alandotcom)! - Run SQLite persistence through Effect SQL and Drizzle ORM while preserving the existing schema, transactional repository behavior, and adoption of version 6 and 7 databases.

- [#195](https://github.com/alandotcom/wfgraph/pull/195) [`a4ea00d`](https://github.com/alandotcom/wfgraph/commit/a4ea00dc09c27261e3c9db321fc4efc7fb3548fa) Thanks [@alandotcom](https://github.com/alandotcom)! - Bump es-toolkit to 1.52 and import it by subpath. The published option types now declare `| undefined` on their optional properties, which matters to an adopter compiling with `exactOptionalPropertyTypes`: a maybe-undefined value can now be passed straight into an optional field instead of being filtered out first.

- [#324](https://github.com/alandotcom/wfgraph/pull/324) [`8455565`](https://github.com/alandotcom/wfgraph/commit/845556529604ebc381ffb45c651f6937693a9b46) Thanks [@alandotcom](https://github.com/alandotcom)! - Make Condition presence checks handle null parents and require arrays for indexed paths, so missing values follow the correct branch.

- [#324](https://github.com/alandotcom/wfgraph/pull/324) [`8455565`](https://github.com/alandotcom/wfgraph/commit/845556529604ebc381ffb45c651f6937693a9b46) Thanks [@alandotcom](https://github.com/alandotcom)! - Recover persisted arrivals when a wake signal is missed before listener registration. Resolve timeout races atomically and give each new event park a fresh resume token so stale deliveries cannot claim it.

- [#203](https://github.com/alandotcom/wfgraph/pull/203) [`26ec2b5`](https://github.com/alandotcom/wfgraph/commit/26ec2b5bb8783a26e383a7e94ef865962e1224e1) Thanks [@alandotcom](https://github.com/alandotcom)! - Production logs report payload-free token usage, model calls, finish reasons,
  refusal counts, and graph revision counts. Incomplete provider finishes now fail
  the turn.

- [#317](https://github.com/alandotcom/wfgraph/pull/317) [`3cd3cc9`](https://github.com/alandotcom/wfgraph/commit/3cd3cc9a110220e6889ab345499a32c04d88633a) Thanks [@alandotcom](https://github.com/alandotcom)! - Clarify workflow editor choices, outcomes, and repair actions. Lifecycle rules now separate Event eligibility from Entity identity, Condition controls use rule-set language, and Wait explanations live in contextual help instead of low-contrast inline copy.

- [#295](https://github.com/alandotcom/wfgraph/pull/295) [`e8d9480`](https://github.com/alandotcom/wfgraph/commit/e8d9480b9eebfa652b5484db109147316a78d703) Thanks [@alandotcom](https://github.com/alandotcom)! - A burst of `newest-wins` starts for one entity on PostgreSQL no longer fails a start with "could not serialize access due to concurrent update".

  Each such start updates the in-flight row every other racer read, so PostgreSQL commits about one of them per round and aborts the rest with SQLSTATE 40001. The last of N racers therefore needs about N attempts. The retry allowed six attempts, and its jitter of plus or minus 20 percent kept the racers retrying in step, so six racers could spend the whole budget and twelve usually did.

  Both serializable transactions in the execution repository now run through one helper, `serializableTransaction`. It retries on 40001 and on a detected deadlock (40P01), draws each delay uniformly between zero and a capped exponential step, and allows 30 retries. The Worker backend over Hyperdrive uses the same repository and gets the same behavior. SQLite serializes writes with `BEGIN IMMEDIATE` and is unchanged.

- [#207](https://github.com/alandotcom/wfgraph/pull/207) [`020dc99`](https://github.com/alandotcom/wfgraph/commit/020dc990431bf66bed58ce1e2edc9aa99c4a4cd6) Thanks [@alandotcom](https://github.com/alandotcom)! - Preserve omitted Lifecycle Rules and support Connection bindings for integration-owned Events in build-agent edits.

- [#311](https://github.com/alandotcom/wfgraph/pull/311) [`37d75bd`](https://github.com/alandotcom/wfgraph/commit/37d75bd8d020dd5f7d0f454a9ad71f622dc6e7bf) Thanks [@alandotcom](https://github.com/alandotcom)! - Hide stored condition paths, compiled CEL expressions, and the Wait node's internal `hops` output from workflow authoring. Existing references to `hops` remain valid.

- [#324](https://github.com/alandotcom/wfgraph/pull/324) [`8455565`](https://github.com/alandotcom/wfgraph/commit/845556529604ebc381ffb45c651f6937693a9b46) Thanks [@alandotcom](https://github.com/alandotcom)! - Preserve a Wait's row, token, and deadline when preparation retries after a committed database write. Retried preparation and migration keep recorded arrivals available for recovery.

- [#177](https://github.com/alandotcom/wfgraph/pull/177) [`d894141`](https://github.com/alandotcom/wfgraph/commit/d894141975818e78bf8b3cb2d7337a2945a1c3b4) Thanks [@alandotcom](https://github.com/alandotcom)! - Ship TanStack Intent Agent Skills with `@wfgraph/core` and `@wfgraph/plugins` so an adopter's coding agent can load version-matched guidance for embedding Workflow Graph and for writing integrations against `@wfgraph/core/plugin`.

- [#218](https://github.com/alandotcom/wfgraph/pull/218) [`9b06194`](https://github.com/alandotcom/wfgraph/commit/9b06194403dadd6c12c47ec7d7d7cb1471625832) Thanks [@alandotcom](https://github.com/alandotcom)! - Improve large workflow canvas fitting, navigation, layout spacing, and description access.

- [#326](https://github.com/alandotcom/wfgraph/pull/326) [`533a5f3`](https://github.com/alandotcom/wfgraph/commit/533a5f3a1f0d3b1454e6cc969d6a7199d5532084) Thanks [@alandotcom](https://github.com/alandotcom)! - Allow paused executions to migrate when the workflow contains visual Group frames. Migration preflight now checks prior execution only for enabled action steps.

- [#216](https://github.com/alandotcom/wfgraph/pull/216) [`66e79c9`](https://github.com/alandotcom/wfgraph/commit/66e79c9a4997f3df78ac92bd94d5850fe845c45b) Thanks [@alandotcom](https://github.com/alandotcom)! - Show external MCP edits live on a clean open workflow canvas, preserve local
  edits when revisions conflict, and refresh workflow lists after MCP creation.

- [#217](https://github.com/alandotcom/wfgraph/pull/217) [`71341fe`](https://github.com/alandotcom/wfgraph/commit/71341fe347b8ea28c5aad66460b02d034a9c2ab0) Thanks [@alandotcom](https://github.com/alandotcom)! - Keep workflow lists current through an authenticated server-sent events subscription. The editor pauses the subscription in hidden tabs and refreshes the shared workflow-list query cache when the server reports a change. Worker deployments keep request-scoped persistence open until a streaming response ends.

- [#325](https://github.com/alandotcom/wfgraph/pull/325) [`2d818fc`](https://github.com/alandotcom/wfgraph/commit/2d818fc66e67a8578d630b93e3f4041503b52ef3) Thanks [@alandotcom](https://github.com/alandotcom)! - Keep Event delivery aimed at the same Wait when migration rotates its token, after rechecking the current subscription. Preserve a failed delivery's recorded arrival while that delivery retries.

- [#324](https://github.com/alandotcom/wfgraph/pull/324) [`8455565`](https://github.com/alandotcom/wfgraph/commit/845556529604ebc381ffb45c651f6937693a9b46) Thanks [@alandotcom](https://github.com/alandotcom)! - Retry failed Event wake deliveries against saved Wait candidates. Candidate pages are captured before delivery, so a retry cannot wake a later Wait reached by an already-resumed branch.

- [#173](https://github.com/alandotcom/wfgraph/pull/173) [`c39f584`](https://github.com/alandotcom/wfgraph/commit/c39f5844e816bd1a5014c9ec61bd13cea824285e) Thanks [@alandotcom](https://github.com/alandotcom)! - Treat a missing node `enabled` flag as on, so toggling a step off and back on is not a draft change.

- [#325](https://github.com/alandotcom/wfgraph/pull/325) [`2d818fc`](https://github.com/alandotcom/wfgraph/commit/2d818fc66e67a8578d630b93e3f4041503b52ef3) Thanks [@alandotcom](https://github.com/alandotcom)! - Restore completed child-node outputs and failures from execution logs before routing a canceled run through its Canceled outlet.

- [#178](https://github.com/alandotcom/wfgraph/pull/178) [`bcd0601`](https://github.com/alandotcom/wfgraph/commit/bcd0601e69745956aa1a17ddabf0304b2ebb2410) Thanks [@alandotcom](https://github.com/alandotcom)! - PostgreSQL notices go through the configured logger instead of the console.

  postgres.js hands a `NOTICE` to `console.log` unless it is given somewhere else to put one, so migrating printed raw objects to stdout: `schema "..." already exists, skipping` and `identifier "..." will be truncated`. A host that had configured logging still got them, in a shape nothing it configured chose, which is the arrangement ADR-0013 exists to avoid.

  They are now a debug record on the `wfgraph.database` category, carrying the notice's code, severity and message. A host that configures no logging sees nothing, and one that does sees them only where it asked for debug.

- [#157](https://github.com/alandotcom/wfgraph/pull/157) [`dea6043`](https://github.com/alandotcom/wfgraph/commit/dea6043a2455cda99058ac23d6e4421751c1e606) Thanks [@alandotcom](https://github.com/alandotcom)! - Run and Publish no longer dead-end when a connection cannot answer for a provider-backed field. The click-time recheck asked every such field at once and rejected on the first refusal, so a single expired grant ended every Run and Publish at "Could not verify provider-backed fields", with nothing the operator could do to clear it. The missing-connection and required-field issues naming the node at fault were never collected at all. Each question now answers for itself: a refusal arrives as a warning naming its node and field, listed under "Unchecked Fields" with a Fix button, and the rest of the list reaches the reader. Run Anyway stays available, and Publish still goes to the server for the authoritative check.

  A second Run or Publish while a check is already running says so instead of doing nothing, which is what Cmd+Enter had been doing on a slow provider.

  Saving a connection, adding one, and completing OAuth no longer hold their dialog open for a round trip to the provider. The connection list is what those call sites wait on; the affected connection's provider options are refreshed alongside it.

  `redactSensitiveData` and the workflow-graph redaction beneath it build their answer with `Object.fromEntries`, so a payload carrying an own `__proto__` key travels through as data rather than reaching `Object.prototype`'s setter.

  `setValueByPath` in `@wfgraph/shared` answers a boolean saying whether the write landed, in place of the target it was handed. The test-payload form drops a field whose path names a reserved record key rather than drawing an input whose value would go nowhere.

  The SQLite migration that added `integrations.refresh_state` spells its three values out instead of reading `INTEGRATION_REFRESH_STATES`. A database past that version never runs the migration again, so interpolating the shared list would have widened the CHECK on new databases alone. A test now holds the pair together.

  A confirmation dialog's message keeps its line breaks, so a warning written as two paragraphs reads as two.

- [#324](https://github.com/alandotcom/wfgraph/pull/324) [`8455565`](https://github.com/alandotcom/wfgraph/commit/845556529604ebc381ffb45c651f6937693a9b46) Thanks [@alandotcom](https://github.com/alandotcom)! - Resolve and preview Wait timestamps without an explicit timezone in UTC, matching the editor's default regardless of the server timezone.

- [#209](https://github.com/alandotcom/wfgraph/pull/209) [`73830fe`](https://github.com/alandotcom/wfgraph/commit/73830fe034327be7519e3076ac2960944a4846db) Thanks [@alandotcom](https://github.com/alandotcom)! - Support complete, patch-safe Wait configuration in build-agent edits.

- [#181](https://github.com/alandotcom/wfgraph/pull/181) [`cbd75a8`](https://github.com/alandotcom/wfgraph/commit/cbd75a8e57b27d242ffededcd1d866d92fa377f1) Thanks [@alandotcom](https://github.com/alandotcom)! - Resume matching Event Waits across live and test runs, including sibling Waits after another branch resumes.

- [#211](https://github.com/alandotcom/wfgraph/pull/211) [`92baf20`](https://github.com/alandotcom/wfgraph/commit/92baf20cf4fb3e8f35495c139e5c4f38ea173b1f) Thanks [@alandotcom](https://github.com/alandotcom)! - Bound agent discovery results and reject unsafe workflow edits before mutation.

- [#178](https://github.com/alandotcom/wfgraph/pull/178) [`bcd0601`](https://github.com/alandotcom/wfgraph/commit/bcd0601e69745956aa1a17ddabf0304b2ebb2410) Thanks [@alandotcom](https://github.com/alandotcom)! - A start that PostgreSQL aborted for a serialization conflict is retried again, rather than failing its node.

  `startForEntity` opens a run inside a SERIALIZABLE transaction, because the in-flight read and the insert have to be one decision. PostgreSQL answers two starts that race for the same entity by aborting one with SQLSTATE 40001, which the repository is meant to retry. Two things stopped that working.

  The check that recognised the abort read `error.cause` alone. Drizzle wraps a driver failure in a `DrizzleQueryError` carrying the SQL it ran, so the `PostgresError` holding the code sits one level further down and was never found. Every aborted start surfaced as a database failure. The check now walks the cause chain, and an unrelated code is still reported rather than retried.

  The retries then ran with no delay between them, so racers that aborted together retried together and spent their attempts on the same conflict. They now back off with jitter, and the budget goes from three retries to five. Measured against PostgreSQL 17 with six connections starting one entity under `newest-wins`, that moves a consistent failure to none.

  This only ever affected PostgreSQL under concurrent starts for one entity value. SQLite serializes writes with `BEGIN IMMEDIATE` and raises no such code.

- [#326](https://github.com/alandotcom/wfgraph/pull/326) [`533a5f3`](https://github.com/alandotcom/wfgraph/commit/533a5f3a1f0d3b1454e6cc969d6a7199d5532084) Thanks [@alandotcom](https://github.com/alandotcom)! - Refresh inherited branch outputs after migration so references introduced by the new workflow version can use outputs completed by another branch while the run was parked.

- [#325](https://github.com/alandotcom/wfgraph/pull/325) [`2d818fc`](https://github.com/alandotcom/wfgraph/commit/2d818fc66e67a8578d630b93e3f4041503b52ef3) Thanks [@alandotcom](https://github.com/alandotcom)! - Use Correlation Paths and Connections from the published workflow version when delivering lifecycle Events.

- [#324](https://github.com/alandotcom/wfgraph/pull/324) [`8455565`](https://github.com/alandotcom/wfgraph/commit/845556529604ebc381ffb45c651f6937693a9b46) Thanks [@alandotcom](https://github.com/alandotcom)! - Prevent concurrent predecessor completions from admitting and executing an AND-join more than once.

- [#326](https://github.com/alandotcom/wfgraph/pull/326) [`533a5f3`](https://github.com/alandotcom/wfgraph/commit/533a5f3a1f0d3b1454e6cc969d6a7199d5532084) Thanks [@alandotcom](https://github.com/alandotcom)! - Preserve source outlets in released branch edges so migration cannot use a previously selected route to unlock a different outlet between the same nodes.

- [#301](https://github.com/alandotcom/wfgraph/pull/301) [`8f2e421`](https://github.com/alandotcom/wfgraph/commit/8f2e421e8a0f0a799e6f1b3826207a152123a52e) Thanks [@alandotcom](https://github.com/alandotcom)! - Update runtime and development dependencies to their latest compatible releases.

- [#325](https://github.com/alandotcom/wfgraph/pull/325) [`2d818fc`](https://github.com/alandotcom/wfgraph/commit/2d818fc66e67a8578d630b93e3f4041503b52ef3) Thanks [@alandotcom](https://github.com/alandotcom)! - Release AND-joins only through selected Condition and Event Split outlets. Child branches now carry selected edge endpoints and preserve their owned Wait continuation when migration rewires completed predecessors. This changes the internal branch invocation payload.

- [#274](https://github.com/alandotcom/wfgraph/pull/274) [`00db2e4`](https://github.com/alandotcom/wfgraph/commit/00db2e43b13bbaa54d8abca14c015c6978f52ad6) Thanks [@alandotcom](https://github.com/alandotcom)! - Leave the entry node's stored test payloads out of publication comparisons, so pressing Run no longer marks the Lifecycle node as Modified in Changes or reports unpublished changes.

- [#201](https://github.com/alandotcom/wfgraph/pull/201) [`4acbfe8`](https://github.com/alandotcom/wfgraph/commit/4acbfe8e31ec5a85745a7790536c8a7492eb6116) Thanks [@alandotcom](https://github.com/alandotcom)! - Lay out and fit workflows after each agent edit. The build agent can write Lifecycle Start Filters and timestamp-based Wait steps. Larger workflows can finish in one turn.

- [#316](https://github.com/alandotcom/wfgraph/pull/316) [`35c1610`](https://github.com/alandotcom/wfgraph/commit/35c16103fbef9d9c1db63ff016af177da8047813) Thanks [@alandotcom](https://github.com/alandotcom)! - Update the Effect v4 dependency set to 4.0.0-rc.116.

## 3.1.1

## 3.1.0

### Minor Changes

- [#154](https://github.com/alandotcom/wfgraph/pull/154) [`6a0cd6e`](https://github.com/alandotcom/wfgraph/commit/6a0cd6e41b06ed56d8f2d78f36d05efedaedf2dc) Thanks [@alandotcom](https://github.com/alandotcom)! - Add durable workflow version history, semantic publication review, and restore as draft.

### Patch Changes

- [#154](https://github.com/alandotcom/wfgraph/pull/154) [`6a0cd6e`](https://github.com/alandotcom/wfgraph/commit/6a0cd6e41b06ed56d8f2d78f36d05efedaedf2dc) Thanks [@alandotcom](https://github.com/alandotcom)! - Prevent stale workflow viewport fitting from hiding the current canvas and reduce comparison and version lookup work.

- [#147](https://github.com/alandotcom/wfgraph/pull/147) [`a72fa25`](https://github.com/alandotcom/wfgraph/commit/a72fa25d72e6827a632e905342de12b737ae83e4) Thanks [@alandotcom](https://github.com/alandotcom)! - Validate non-Effect step and action outputs through `~standard.validate`, so undeclared keys no longer pass through when the library strips them and a mismatched answer fails the node once.

## 3.0.0

### Major Changes

- [#145](https://github.com/alandotcom/wfgraph/pull/145) [`708ac73`](https://github.com/alandotcom/wfgraph/commit/708ac731400a6e452c2b7bf9d82b40e3dfad9edd) Thanks [@alandotcom](https://github.com/alandotcom)! - Replace the persisted Group `exitNodeId` field with `exitNodeIds`, and support lookup groups whose exits share one downstream endpoint.

### Minor Changes

- [#128](https://github.com/alandotcom/wfgraph/pull/128) [`c2ae17b`](https://github.com/alandotcom/wfgraph/commit/c2ae17b9da06d723443386d04cd1852b800fedf2) Thanks [@alandotcom](https://github.com/alandotcom)! - Add a build agent to the workflow editor: a chat panel that reads the extension
  catalog and the open workflow, then edits the canvas as it answers.

  A host turns it on with a new `agent` option on `createWfGraphApp`, carrying an
  OpenAI API key and optionally a model id and an OpenAI-compatible endpoint.
  Absent or blank, the agent is off: no model is called and the editor shows no
  panel, so an adopter who wants no AI in their editor writes nothing.

  The agent has fourteen tools. Seven read (search the action catalog, describe one
  action's config and output fields, list Events and integrations, read the graph,
  list the template tokens a step may reference, and validate the workflow) and
  seven write (add, update and delete a step, connect and disconnect steps, declare
  the Lifecycle Rules, and write a Condition's test). They run on the server against
  the graph the editor sends with each turn, and the resulting graph streams back
  so the canvas redraws as the agent works. The edit lands through the editor's own
  save path, so it is one undo step and the autosave persists it.

  `GET /api/extensions` now answers `agent: { enabled }` beside `catalog`, which is
  how the editor knows whether to offer the panel. `agent.chat` is the first
  streaming RPC procedure in the contract, declared as an oRPC event iterator.

  The `effect` catalog moves to `4.0.0-rc.110`, which the `@effect/ai-openai`
  provider names as its peer.

### Patch Changes

- [#151](https://github.com/alandotcom/wfgraph/pull/151) [`1da1baf`](https://github.com/alandotcom/wfgraph/commit/1da1bafa5d18a441dda004d284b652dbbe42c9d8) Thanks [@alandotcom](https://github.com/alandotcom)! - Improve build-agent authoring for Wait steps, Event Split outlets, condition reference fields, and draft publication blockers.

- [#128](https://github.com/alandotcom/wfgraph/pull/128) [`c2ae17b`](https://github.com/alandotcom/wfgraph/commit/c2ae17b9da06d723443386d04cd1852b800fedf2) Thanks [@alandotcom](https://github.com/alandotcom)! - Prevent the build agent from applying workflow edits that violate graph topology rules.

- [#148](https://github.com/alandotcom/wfgraph/pull/148) [`01da8e0`](https://github.com/alandotcom/wfgraph/commit/01da8e01080e2c7847f4d43663f9552515a76d06) Thanks [@alandotcom](https://github.com/alandotcom)! - Stop sending start and result payloads on the run-list procedures.

  `getExecutions` polls every two seconds while the Runs tab is open, and
  `getExecutionsGlobal` pages the dashboard. Neither list paints `input` or
  `output`, yet both selected those JSONB columns and redacted them on every
  answer. Payloads stay on `getExecutionLogs`, which is fetched for the one open
  run.

## 2.5.0

## 2.4.0

### Minor Changes

- [#120](https://github.com/alandotcom/wfgraph/pull/120) [`f548cd2`](https://github.com/alandotcom/wfgraph/commit/f548cd2d28b7dc73743fe01d1f9c23240b1cbd82) Thanks [@alandotcom](https://github.com/alandotcom)! - Left-align the pretty console layout and stack a record's fields beneath it.

  `configureWfGraphLogging` now renders through Workflow Graph's own formatter.
  `@logtape/pretty` right-aligned every field key against the header width, which
  put each field line past column 55 of a terminal and wrapped it back to column 0. That library exposes no option for it.

  A record now prints one flush-left header line carrying time, level, category
  and message, then one row per field at a two-space indent under box-drawing
  connectors. A grouped field stays on one line as `key=value` pairs while it
  fits, and opens into a row per member when it does not. `LOG_PRETTY_WIDTH` sets
  the column it has to fit inside, and `NO_COLOR` turns the escapes off.

### Patch Changes

- [#138](https://github.com/alandotcom/wfgraph/pull/138) [`7aac428`](https://github.com/alandotcom/wfgraph/commit/7aac428a4d20e1425cccbb2a2606c848a8fb8938) Thanks [@alandotcom](https://github.com/alandotcom)! - An event-mode Wait is an Arriving Event source.

  `eventsReaching` now hands on the Events a Wait parks on, so an Event Split below it offers those Events rather than the Start Events that put the run at the Wait. The engine routes on the Event that woke the Wait, and the entry node's output becomes that payload, matching a Cancel Event. A timeout that continues names no Arriving Event, so an Event Split below the Wait stops rather than taking a Start Event outlet.

## 2.3.0

### Minor Changes

- [#135](https://github.com/alandotcom/wfgraph/pull/135) [`6b19caa`](https://github.com/alandotcom/wfgraph/commit/6b19caa92ea21447eda5dcf4e99402c44a3f91b6) Thanks [@alandotcom](https://github.com/alandotcom)! - Add optional `hidden` flag on actions so retired actions stay runnable while the editor picker omits them. Document forward-compatible action evolution in `docs/integrations.md`.

### Patch Changes

- [#124](https://github.com/alandotcom/wfgraph/pull/124) [`5f264c0`](https://github.com/alandotcom/wfgraph/commit/5f264c0a944d3f42fb1dc71954b0af536d5a9217) Thanks [@alandotcom](https://github.com/alandotcom)! - Load workflow run inputs from the persisted execution and published version instead of trusting Inngest event payloads. Refuse terminal executions, and make workflow-branch invoke-only with the same persisted reload.

## 2.2.3

## 2.2.2

## 2.2.1

## 2.2.0

### Minor Changes

- [#119](https://github.com/alandotcom/wfgraph/pull/119) [`ca0de9a`](https://github.com/alandotcom/wfgraph/commit/ca0de9a4d8be996e1430da6c7cee783be1bf76e2) Thanks [@alandotcom](https://github.com/alandotcom)! - A draft always saves; an invalid graph never publishes.

  `prepareGraphSave` refused a graph whose nodes were half-built, which is the
  ordinary state of an editor session. The editor suppressed that 400 for
  autosaves, so the canvas sat dirty with nothing said and a reload discarded the
  work. The battery is split: the save asks only what has to be true of a graph in
  a row (it parses, and its stored expressions are ones the compiler produced), and
  the readiness half moves to `checkPublishReadiness` in `publish-checks.ts`.

  Nothing loses a guard. No run reads the draft column — both start paths load the
  published version row and refuse when there is none — and publish is the sole
  writer of the event subscription index, so an Event cannot reach a draft either.
  Publish is the one gate that makes a graph runnable, and it now runs required
  fields, Events, Event Split outlets, template references, connections and the
  unreachable-subtree check together. Draft saves also stop costing a query, since
  nothing left in that path reads the catalog or the database.

  In the editor, validation runs continuously against the graph rather than only
  when Run is pressed ([#2](https://github.com/alandotcom/wfgraph/issues/2)). Broken nodes wear a warning badge, the toolbar carries
  an issue count that opens the existing issues list, and Publish opens that list
  instead of spending a round trip on a refusal the canvas was already showing.
  The connection-missing triangle each action card used to draw from its own
  reading of the connection list is now one rule inside the shared collector, and
  every caller normalises its nodes the same way, so the canvas and the pre-run
  check cannot disagree about a node. Nothing is reported until the connection
  list has actually arrived: an empty list is a real answer, and using it for
  "not asked yet" would accuse every node that names a connection.

  Save state is a word rather than a dot — "Saving", "Unsaved changes", "Saved",
  "Save failed" — and closing or reloading the tab with an edit still in the
  debounce window asks first. Both are owner-only: a viewer of a public workflow
  can still nudge a node, and the refused save that follows would otherwise leave
  them holding a dirty flag and a leave-prompt they could never clear.

## 2.1.0

### Minor Changes

- [#115](https://github.com/alandotcom/wfgraph/pull/115) [`4f34676`](https://github.com/alandotcom/wfgraph/commit/4f34676d7049a9a2577e873c1a79da9a89d43e09) Thanks [@alandotcom](https://github.com/alandotcom)! - Let an action declare `sideEffect: true` when running it changes something
  outside the workflow, and hold a Group to lookups on that answer. `defineAction`
  and an integration's action literal both take the field, it defaults to `false`,
  and it reaches the browser on the extension catalog. The seven writes the
  built-in plugins ship now declare it, so grouping a Send Email or a Delete User
  is refused rather than accepted against the Group contract.

  Fix two Group defects on the canvas. Deleting a frame with the Delete key left
  its interior edges and any collapsed inlet edge in the graph naming steps that
  were gone, which the next save refused. An edge running from one frame's exit
  into another frame's entry painted on the two members instead of the two frames,
  so auto-layout read the frames as unconnected.

  Cut some of the canvas render cost. A graph whose nodes were left out of the
  order React Flow wants paid a re-sort and an allocation on every render, drag
  frames included, and grouping a second selection, ungrouping one of two frames,
  and pasting a frame each left it that way; all three now keep the order. The
  painted edges also come back as the array they went in as for a graph with no
  frame, though one holding a frame still rebuilds them per node change.

- [#114](https://github.com/alandotcom/wfgraph/pull/114) [`2565518`](https://github.com/alandotcom/wfgraph/commit/2565518e5e16dea7f6ada86ccbb642a696d190b0) Thanks [@alandotcom](https://github.com/alandotcom)! - Allow AND-joins: two parallel action nodes can both feed one next step. Fan-out was already concurrent; saving and the canvas now accept multi-incoming edges when every predecessor completes successfully, with Wait-on-arm, Started↔Canceled, and exclusive-branch joins still refused.

- [#115](https://github.com/alandotcom/wfgraph/pull/115) [`4f34676`](https://github.com/alandotcom/wfgraph/commit/4f34676d7049a9a2577e873c1a79da9a89d43e09) Thanks [@alandotcom](https://github.com/alandotcom)! - A disabled step now ends its branch, whatever kind of step it is, and the canvas
  draws what that costs.

  The engine used to stop only at a disabled Condition or Event Split. A disabled
  lookup handed its null output on, and the step below read that null as an
  answer. One rule replaces the two: a disabled node is skipped, recorded with a
  null output, and nothing past it is scheduled. A saved workflow holding a
  disabled step therefore runs less of itself than it did before, which a minor
  bump carries because a disabled step was already a request to leave work out,
  and the old behaviour left the step below reading a null it could not tell from
  a real answer.

  The editor mutes every step the run cannot reach, which until now was drawn only
  for a Canceled subtree with no Cancel Event declared. A muted card sits at 50%
  opacity and its incoming edge stops animating, so the dead part of a graph reads
  as still. The disabled step itself keeps its own face, since a person needs to
  tell the step they switched off from the steps that lost their path because of
  it.

  Disabled belongs to a Group as a whole. Selecting the frame offers the toggle
  and writes the flag onto every member, which is what the engine walks. A member
  selected on its own no longer offers it, the same way it offers no Delete, since
  a frame with some members off and some on has no face it could honestly wear.
  Grouping a step that was already off takes the whole frame with it.

## 2.0.2

### Patch Changes

- [#104](https://github.com/alandotcom/wfgraph/pull/104) [`8702b01`](https://github.com/alandotcom/wfgraph/commit/8702b0121b01e2b817427d1334704abffce405a4) Thanks [@alandotcom](https://github.com/alandotcom)! - Effect, `@effect/vitest` and `@effect/opentelemetry` move from `4.0.0-rc.108` to
  `4.0.0-rc.109`. An adopter installing `@wfgraph/core` or `@wfgraph/plugins` resolves the
  newer release candidate. The RC is a patch: inference for `Effect.fromOption`, typed
  `SqlError` on a failed `BEGIN`, and documentation. Nothing Workflow Graph calls changed.

- [#107](https://github.com/alandotcom/wfgraph/pull/107) [`95eb7d5`](https://github.com/alandotcom/wfgraph/commit/95eb7d5f491e566745cfedc149a87b780ea17a76) Thanks [@alandotcom](https://github.com/alandotcom)! - Mark flattened child paths nullable when a parent object is null or an array
  index may be missing, so the editor offers is-empty operators on those paths.

  A derived path is reachable only when every ancestor on it is present. The
  reader already marked a nullable object and a top-level scalar correctly, but
  children under `nested.date` or `list[0].uuid` stayed required. Array `[0]`
  children stay required only when the array declares `minItems >= 1`.

## 2.0.1

### Patch Changes

- [#102](https://github.com/alandotcom/wfgraph/pull/102) [`24e0f68`](https://github.com/alandotcom/wfgraph/commit/24e0f68ed4928df74873fdc48f681457df4bc7fe) Thanks [@alandotcom](https://github.com/alandotcom)! - Keep arktype, Zod, and Effect closed sets and UUIDs in the fields the editor
  derives, and stop marking a multi-branch `anyOf` nullable when no branch is
  `{ type: "null" }`.

  arktype renders a string-literal union as a bare `enum` with no `type`, and
  `string.uuid` as a pattern plus the nil and max UUID consts. Zod puts `type` on
  `z.enum` and `z.uuid`, but a literal union is `anyOf` of typed consts. Effect's
  `Schema.Literals` is one `enum` array, while `Schema.Enum` is one `anyOf` branch
  per member and `NullOr` wraps that in another `anyOf`. The JSON Schema reader
  dropped the arktype shapes and Effect's `Schema.Enum`, and marked every
  multi-branch `anyOf` nullable, so an Event threw at boot, an action output
  silently omitted the field, and a described union offered is-empty operators on
  a required enum.

## 2.0.0

### Major Changes

- [#99](https://github.com/alandotcom/wfgraph/pull/99) [`ff1d523`](https://github.com/alandotcom/wfgraph/commit/ff1d52354079abad1d265c0a27ab27395a1bc177) Thanks [@alandotcom](https://github.com/alandotcom)! - Take `inngest` and `hono` as peer dependencies rather than dependencies. Add both to your
  own manifest alongside `@wfgraph/core`:

  ```bash
  pnpm add @wfgraph/core inngest hono
  ```

  Your application now owns the version of each that runs in its process, inside `^4.18.0`
  for `inngest` and `^4.13.1` for `hono`. For Inngest that is the point of the change: a host
  that already drives Inngest functions of its own used to end up with a second copy of a
  durable-execution runtime, carrying its own OpenTelemetry stack, protobuf codec and Connect
  worker, as a silent outcome of an install. A version disagreement now fails at install,
  where it can be read.

  Nothing about the API moved. `createWfGraphApp` still takes the same `inngest` config object
  and still builds its own Inngest client and its own Hono app, and it still answers with
  `fetch`, `basePath` and `dispose`. Neither library appears in what it hands back, and no
  published type names either one.

### Minor Changes

- [#98](https://github.com/alandotcom/wfgraph/pull/98) [`1c94924`](https://github.com/alandotcom/wfgraph/commit/1c9492471ae3d5e70b09bb29beab5f686468ff90) Thanks [@alandotcom](https://github.com/alandotcom)! - Name a run and its steps in the Inngest UI.

  Every workflow executes on one Inngest function, so the dashboard labelled every
  run "Workflow run" and every trace row carried a memoization id built from an
  opaque node id. Two things change that:

  - A run attaches its own identity as Inngest run metadata under the
    `userland.wfgraph` kind: the workflow's name and id, the execution id, the run
    mode, the triggering event, the workflow version and the node count, plus the
    entry node on a branch run. It is written inside one memoized step, so it
    survives a replay and costs no extra request. A refused write is logged and
    the run continues.
  - Each durable step now carries a display name beside its id, so a trace reads
    `Post to Slack: post` rather than `node:vMVCWuW-OmRDEhJok5pfu:post`. Every step
    id is unchanged, so memoization behaves exactly as before.

  The Inngest client is now built with `metadataMiddleware()` from
  `inngest/experimental`, which is what makes the metadata surface reachable. The
  Inngest Dev Server shows the Metadata tab from v1.17.0.

## 1.0.0

## 0.3.0

### Minor Changes

- [#91](https://github.com/alandotcom/wfgraph/pull/91) [`5c9a259`](https://github.com/alandotcom/wfgraph/commit/5c9a259a886494cb711fd4d747adbebe2c7dc44f) Thanks [@alandotcom](https://github.com/alandotcom)! - Effect moves to the 4.0 release candidate.

  `effect`, `@effect/vitest` and `@effect/opentelemetry` go from `4.0.0-beta.102` to
  `4.0.0-rc.108`, so an adopter installing `@wfgraph/core` or `@wfgraph/plugins` resolves the
  release candidate. Upstream treats the 4.0 interfaces as final from this version on.

  Two upstream changes are visible here. `Schema.TaggedErrorClass` is now `Schema.TaggedError`,
  which is how every failure type in the backend is declared. Separately, a `SchemaIssue` has
  stopped carrying the value a decode rejected, and holds it only when the decode asks with
  `reportInput`. Workflow Graph asks nowhere, so a message about a refused step config, Event
  payload, step output or workflow graph ends after the field path and the expectation. Where
  one read `to: Expected string, got 7`, it now reads `to: Expected string`.

  `formatSchemaFailurePaths` is gone from `@wfgraph/shared`. `formatSchemaFailure` renders
  what it used to render, so one function now covers both audiences.

  A failed check keeps the bound Effect names for it, so `name: Invalid value` reads
  `name: Expected a value with a length of at least 1`.

## 0.2.0

### Minor Changes

- [#89](https://github.com/alandotcom/wfgraph/pull/89) [`d8c6b96`](https://github.com/alandotcom/wfgraph/commit/d8c6b968fb029509bcdb12587fc7bbda354ed9c3) Thanks [@alandotcom](https://github.com/alandotcom)! - The host configures logging, and a log record is one unit of work.

  `@wfgraph/core` no longer calls LogTape's `configure` for you. It asks for a logger under
  the `wfgraph` category and leaves the sinks, the levels and the format to the application.
  An app that installs nothing gets no output, and `createWfGraphApp` prints one notice at
  start-up naming the three ways to fix it:

  - `configureWfGraphLogging()` from the new `@wfgraph/core/logging` entry, which installs
    the console setup Workflow Graph used to install for you.
  - The `logger` option, unchanged.
  - Your own LogTape configuration with a sink for the `wfgraph` category.

  `@wfgraph/core/migrate` writes through the same category, so a migration job that wants
  its output calls one of the three first.

  What the output looks like has changed with it. The category root is `wfgraph` rather than
  `app`, and each category is one level deep. One HTTP request writes one record naming the
  method, the path, the status, the elapsed time, the procedure it addressed and the reason
  it was refused; request and response bodies are no longer logged at all. One node
  execution writes one record rather than the four to six the engine used to narrate. A
  record's fields arrive grouped by subject (`http`, `rpc`, `run`, `node`, `outcome`,
  `error`). The default level in development is `info` rather than `debug`.

## 0.1.0

### Minor Changes

- [#86](https://github.com/alandotcom/wfgraph/pull/86) [`863b6a3`](https://github.com/alandotcom/wfgraph/commit/863b6a3dcbfb963dab022e646bfa4b6e380a099e) Thanks [@alandotcom](https://github.com/alandotcom)! - Add pluggable persistence backends for PostgreSQL, native Node SQLite, and Cloudflare
  Hyperdrive. Configure a Node app with `wfPostgres` or `wfSqlite`, and configure a
  Cloudflare Worker with `wfHyperdrive` and `wfWorker`.

  This replaces `createWfGraphApp`'s PostgreSQL-specific `database` option with the
  backend-independent `persistence` option. Calling `wfSqlite()` creates an ephemeral
  in-memory database; pass `filename` to persist it to a file.

## 0.0.2

### Patch Changes

- [#84](https://github.com/alandotcom/wfgraph/pull/84) [`33a616f`](https://github.com/alandotcom/wfgraph/commit/33a616f4118adb125f578627a21310a1ca24912f) Thanks [@alandotcom](https://github.com/alandotcom)! - Each package now ships its own README, so its npm page describes what it is rather than
  offering to let someone add one, and declares `engines.node` at the Node 24 floor the repo
  already builds against, so an install on an older runtime warns instead of failing later.

## 0.0.1

### Patch Changes

- First published release. `@wfgraph/core` carries the run engine, the authoring
  vocabulary and `createWfGraphApp`; `@wfgraph/client` carries the editor bundle a
  host hands it; `@wfgraph/plugins` carries the six built-in integrations.

# @wfgraph/client

## 4.0.0

### Major Changes

- [#189](https://github.com/alandotcom/wfgraph/pull/189) [`880eccd`](https://github.com/alandotcom/wfgraph/commit/880eccdf67105f40063989f71133a6c2f943af77) Thanks [@alandotcom](https://github.com/alandotcom)! - Replace the host `auth` predicate with a principal-free access-policy contract. `defineWfGraphAuth` gives extracted callbacks contextual types; authentication returns `WfGraphRoles.viewer`, `.editor`, `.admin`, another `WfGraphAccess` policy, or `null`. Unrestricted access is explicit through `WfGraphAccess.all` or `trustWfGraphUpstream()`, and Node and Worker APIs no longer carry principal type parameters.

  The authenticated extension bootstrap now carries every granted operation ID before the editor renders. The editor uses this page-lifetime snapshot synchronously to adapt controls and data requests. Account and policy changes require a page reload, and server-side authorization remains authoritative for every RPC, REST, and OAuth request. Authentication and policy callback failures now produce a sanitized 500 instead of being misreported as a 401 or 403.

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

- [#191](https://github.com/alandotcom/wfgraph/pull/191) [`85d931f`](https://github.com/alandotcom/wfgraph/commit/85d931fd65b004dec9d5d956e13b870af8fd22c3) Thanks [@alandotcom](https://github.com/alandotcom)! - Add read-only workflow version usage diagnostics for active runs, action availability, and catalog drift.

- [#181](https://github.com/alandotcom/wfgraph/pull/181) [`cbd75a8`](https://github.com/alandotcom/wfgraph/commit/cbd75a8e57b27d242ffededcd1d866d92fa377f1) Thanks [@alandotcom](https://github.com/alandotcom)! - Show a connection's stored value as the placeholder for the config field that falls back to it. Resend's From, and Twilio's From Number and Messaging Service SID, are optional on the node and the handler reads the connection when they are blank; the editor now says which value that is instead of drawing a generic example.

  An action config field declares the fallback with `connectionDefaultKey`, naming one of the integration's own credentials, held to that set by the type. `checkIntegration` refuses a key the integration does not declare and refuses a `password` one, since the browser holds a mask in place of a secret. That declaration is also the allowlist for the new `connectionDefaults` on a connection summary: a stored value no field names never reaches the editor.

  Also fixes a template field redrawing only when its text changed, which left a stale placeholder on screen after the value behind it moved.

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

- [#157](https://github.com/alandotcom/wfgraph/pull/157) [`dea6043`](https://github.com/alandotcom/wfgraph/commit/dea6043a2455cda99058ac23d6e4421751c1e606) Thanks [@alandotcom](https://github.com/alandotcom)! - Add config fields whose shape the node's connection answers. Two field types join the vocabulary: `provider-select` draws a dropdown over what the connection lists, and `provider-fields` draws one input per value the current selection declares, stored as one JSON object under the one config key. An integration declares what each asks under `configOptions`, keyed by the name a field's `optionsSource` uses, and `checkIntegration` refuses a field wired to a provider that cannot answer it.

  The editor asks over `integration.configOptions`, which resolves the connection's credentials server-side the way the connection test does. Credentials never reach the browser, and neither does a failed request's own exception text. A provider refusing is an answer rather than an error, so the sentence it wrote is what the panel shows. Every provider-backed field falls back to the plain control it replaces, so a missing connection, a grant too narrow to read, or a provider that is down never leaves a builder unable to type the value themselves.

- [#157](https://github.com/alandotcom/wfgraph/pull/157) [`dea6043`](https://github.com/alandotcom/wfgraph/commit/dea6043a2455cda99058ac23d6e4421751c1e606) Thanks [@alandotcom](https://github.com/alandotcom)! - A node missing a value its template needs is now a blocking issue, so it carries a badge on the canvas, counts in the status strip, and stops a publish. Previously the config panel marked the empty input red while the canvas said the node was fine and publish let it through.

  The shared collector cannot raise these: which variables a provider has no default for is the operator's own connection to answer. The editor asks that question for every node rather than only the open one. Passive badges and issue counts stay quiet while an answer is pending, because absence is not evidence that a value is missing. Run and Publish recheck the exact current nodes and wait for every answer; a failed check blocks the action instead of letting an unverified workflow through.

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

- [#157](https://github.com/alandotcom/wfgraph/pull/157) [`dea6043`](https://github.com/alandotcom/wfgraph/commit/dea6043a2455cda99058ac23d6e4421751c1e606) Thanks [@alandotcom](https://github.com/alandotcom)! - Let a Resend connection be granted full access, which is what Resend requires to read templates. The client metadata document now registers both of Resend's scopes rather than `emails:send` alone. The registered set is the ceiling on what an operator may grant, so registering one scope was what grayed out "Full access" on Resend's consent page; registering both makes the page's own Permission chooser live. The authorization names no scope, which asks for the whole registered set and leaves the choice where it is made.

  An `IntegrationOAuth` adapter can report `grantedAccessLabel` on its token set: how much access the provider granted, in the provider's own words, read off the token response rather than assumed from the request. Both `exchange` and `refresh` return it, so a provider that narrows a grant is recorded rather than left claiming the old access. The connection dialog shows it read-only beside the account, and offers Reconnect on a working connection, which is the only thing that can change a grant.

### Patch Changes

- [#198](https://github.com/alandotcom/wfgraph/pull/198) [`15e56eb`](https://github.com/alandotcom/wfgraph/commit/15e56eb40f4cc82b9a1bbb8c157078f8aa1ba579) Thanks [@alandotcom](https://github.com/alandotcom)! - Improve Lifecycle controls and let long canvas node titles wrap.

- [#157](https://github.com/alandotcom/wfgraph/pull/157) [`dea6043`](https://github.com/alandotcom/wfgraph/commit/dea6043a2455cda99058ac23d6e4421751c1e606) Thanks [@alandotcom](https://github.com/alandotcom)! - Keep OAuth-provided credentials read-only while allowing other connection settings to be edited and tested with the saved OAuth grant, including Resend grants limited to email sending. A connection test now learns which credentials an OAuth grant issued, through a second `IntegrationTestContext` argument on the integration `test` function. The editor reports a credential field as configured from what the server actually stored, so a disconnected connection shows an empty field rather than a filled one, and it keeps offering the OAuth flow so a disconnect stays reversible. `slack({ oauthClient })` reads a pair that is blank on both sides as manual-only, which lets a host pass its environment straight through.

- [#171](https://github.com/alandotcom/wfgraph/pull/171) [`3929461`](https://github.com/alandotcom/wfgraph/commit/39294610bdd5ba9d79123104c9b46235efc84093) Thanks [@alandotcom](https://github.com/alandotcom)! - Stop the command palette from highlighting the first row when the pointer is over a disabled command.

- [#195](https://github.com/alandotcom/wfgraph/pull/195) [`a4ea00d`](https://github.com/alandotcom/wfgraph/commit/a4ea00dc09c27261e3c9db321fc4efc7fb3548fa) Thanks [@alandotcom](https://github.com/alandotcom)! - Bump es-toolkit to 1.52 and import it by subpath. The published option types now declare `| undefined` on their optional properties, which matters to an adopter compiling with `exactOptionalPropertyTypes`: a maybe-undefined value can now be passed straight into an optional field instead of being filtered out first.

- [#186](https://github.com/alandotcom/wfgraph/pull/186) [`4aec2c5`](https://github.com/alandotcom/wfgraph/commit/4aec2c57e6b9f13c0384777f74d3f1577e713217) Thanks [@alandotcom](https://github.com/alandotcom)! - Settle the node configuration panel's controls.

  Lifecycle Rules renders one mode instead of switching between a text summary and
  its controls, and Concurrency became a dropdown. Template fields, reference
  badges and the connection picker now share the height and type size of every
  other control in the panel. A configured condition can be deleted: removing the
  last rule clears the whole condition, where both trash buttons used to be
  disabled with no way back.

  Choosing a connection is a dropdown, and creating, editing and deleting one use
  the Connections manager. Connection changes repair Action, Lifecycle, and Wait
  bindings in the open graph, so a step stops naming a deleted connection.
  Missing connections link directly to that manager, and read-only workflow panels
  cannot open connection-editing controls. Provider-backed fields preserve their
  value when switching input modes, and template inputs retain mobile-safe text.

- [#181](https://github.com/alandotcom/wfgraph/pull/181) [`cbd75a8`](https://github.com/alandotcom/wfgraph/commit/cbd75a8e57b27d242ffededcd1d866d92fa377f1) Thanks [@alandotcom](https://github.com/alandotcom)! - Reopening the workflow already on screen no longer discards edits the server has not stored. The route loader refetched the workflow and hydrated it unconditionally, and selecting a run or leaving Runs re-runs that loader, so a graph the autosave queue was still holding could be replaced by the server's older copy.

  The case this loses work in is a failed save. The dirty flag stays raised on that path by design, so the editor keeps showing the edit and the strip keeps reporting the failure. A route re-run then installed the server's graph and lowered the flag, taking the edit and the failure notice together and leaving nothing on screen to say the work had gone.

  Hydration now keeps the local graph when the route resolves the workflow already open and the client is ahead of the server, meaning there are unsaved changes or a write in flight. Opening a different workflow still replaces the graph, and so does reopening this one once the save queue has drained.

- [#182](https://github.com/alandotcom/wfgraph/pull/182) [`30d78c4`](https://github.com/alandotcom/wfgraph/commit/30d78c4e4c07e571ab84974aa987e9d8491846dc) Thanks [@alandotcom](https://github.com/alandotcom)! - Draw key-value Name and Value as matching compact inputs.

- [#218](https://github.com/alandotcom/wfgraph/pull/218) [`9b06194`](https://github.com/alandotcom/wfgraph/commit/9b06194403dadd6c12c47ec7d7d7cb1471625832) Thanks [@alandotcom](https://github.com/alandotcom)! - Improve large workflow canvas fitting, navigation, layout spacing, and description access.

- [#216](https://github.com/alandotcom/wfgraph/pull/216) [`66e79c9`](https://github.com/alandotcom/wfgraph/commit/66e79c9a4997f3df78ac92bd94d5850fe845c45b) Thanks [@alandotcom](https://github.com/alandotcom)! - Show external MCP edits live on a clean open workflow canvas, preserve local
  edits when revisions conflict, and refresh workflow lists after MCP creation.

- [#182](https://github.com/alandotcom/wfgraph/pull/182) [`30d78c4`](https://github.com/alandotcom/wfgraph/commit/30d78c4e4c07e571ab84974aa987e9d8491846dc) Thanks [@alandotcom](https://github.com/alandotcom)! - Keep waiting for an OAuth grant after the provider page severs the popup handle, so the connection list updates without a full refresh.

- [#157](https://github.com/alandotcom/wfgraph/pull/157) [`dea6043`](https://github.com/alandotcom/wfgraph/commit/dea6043a2455cda99058ac23d6e4421751c1e606) Thanks [@alandotcom](https://github.com/alandotcom)! - Run and Publish no longer dead-end when a connection cannot answer for a provider-backed field. The click-time recheck asked every such field at once and rejected on the first refusal, so a single expired grant ended every Run and Publish at "Could not verify provider-backed fields", with nothing the operator could do to clear it. The missing-connection and required-field issues naming the node at fault were never collected at all. Each question now answers for itself: a refusal arrives as a warning naming its node and field, listed under "Unchecked Fields" with a Fix button, and the rest of the list reaches the reader. Run Anyway stays available, and Publish still goes to the server for the authoritative check.

  A second Run or Publish while a check is already running says so instead of doing nothing, which is what Cmd+Enter had been doing on a slow provider.

  Saving a connection, adding one, and completing OAuth no longer hold their dialog open for a round trip to the provider. The connection list is what those call sites wait on; the affected connection's provider options are refreshed alongside it.

  `redactSensitiveData` and the workflow-graph redaction beneath it build their answer with `Object.fromEntries`, so a payload carrying an own `__proto__` key travels through as data rather than reaching `Object.prototype`'s setter.

  `setValueByPath` in `@wfgraph/shared` answers a boolean saying whether the write landed, in place of the target it was handed. The test-payload form drops a field whose path names a reserved record key rather than drawing an input whose value would go nowhere.

  The SQLite migration that added `integrations.refresh_state` spells its three values out instead of reading `INTEGRATION_REFRESH_STATES`. A database past that version never runs the migration again, so interpolating the shared list would have widened the CHECK on new databases alone. A test now holds the pair together.

  A confirmation dialog's message keeps its line breaks, so a warning written as two paragraphs reads as two.

- [#184](https://github.com/alandotcom/wfgraph/pull/184) [`6bedfee`](https://github.com/alandotcom/wfgraph/commit/6bedfeea1beef8e10d37d03f2fe922eb9a7c78f1) Thanks [@alandotcom](https://github.com/alandotcom)! - Keep Draft edges visible when leaving a workflow run and reloading the open workflow.

- [#174](https://github.com/alandotcom/wfgraph/pull/174) [`1ff6282`](https://github.com/alandotcom/wfgraph/commit/1ff62820cae7e2311438e4d124f9cf1e74ecf9fc) Thanks [@alandotcom](https://github.com/alandotcom)! - Stop the template autocomplete from covering the caret when it would overflow the viewport.

- [#201](https://github.com/alandotcom/wfgraph/pull/201) [`4acbfe8`](https://github.com/alandotcom/wfgraph/commit/4acbfe8e31ec5a85745a7790536c8a7492eb6116) Thanks [@alandotcom](https://github.com/alandotcom)! - Lay out and fit workflows after each agent edit. The build agent can write Lifecycle Start Filters and timestamp-based Wait steps. Larger workflows can finish in one turn.

- [#176](https://github.com/alandotcom/wfgraph/pull/176) [`ba1046a`](https://github.com/alandotcom/wfgraph/commit/ba1046a97333d6e0ab7989d828489673315a5944) Thanks [@alandotcom](https://github.com/alandotcom)! - Drop the "Workflow Dashboard" heading from the workflows page and match the workflows table's column headers to the run history table's.

## 3.1.1

### Patch Changes

- [#156](https://github.com/alandotcom/wfgraph/pull/156) [`db14e3f`](https://github.com/alandotcom/wfgraph/commit/db14e3ff495daf49d651b8526d92bcb1c8db0e84) Thanks [@alandotcom](https://github.com/alandotcom)! - Keep workflow nodes visible while switching between Draft, Runs, and Changes,
  and keep the viewport stable while dragging Lifecycle.

## 3.1.0

### Minor Changes

- [#154](https://github.com/alandotcom/wfgraph/pull/154) [`6a0cd6e`](https://github.com/alandotcom/wfgraph/commit/6a0cd6e41b06ed56d8f2d78f36d05efedaedf2dc) Thanks [@alandotcom](https://github.com/alandotcom)! - Move Draft, Runs, and Changes into a persistent workflow workspace switcher, with stable loading transitions and matching canvas, inspector, and status-strip behavior.

- [#154](https://github.com/alandotcom/wfgraph/pull/154) [`6a0cd6e`](https://github.com/alandotcom/wfgraph/commit/6a0cd6e41b06ed56d8f2d78f36d05efedaedf2dc) Thanks [@alandotcom](https://github.com/alandotcom)! - Add durable workflow version history, semantic publication review, and restore as draft.

### Patch Changes

- [#154](https://github.com/alandotcom/wfgraph/pull/154) [`6a0cd6e`](https://github.com/alandotcom/wfgraph/commit/6a0cd6e41b06ed56d8f2d78f36d05efedaedf2dc) Thanks [@alandotcom](https://github.com/alandotcom)! - Make workflow menus hand off on hover, add workflow actions to the command palette, and let node context menus enable or disable eligible steps.

- [#154](https://github.com/alandotcom/wfgraph/pull/154) [`6a0cd6e`](https://github.com/alandotcom/wfgraph/commit/6a0cd6e41b06ed56d8f2d78f36d05efedaedf2dc) Thanks [@alandotcom](https://github.com/alandotcom)! - Prevent stale workflow viewport fitting from hiding the current canvas and reduce comparison and version lookup work.

- [#153](https://github.com/alandotcom/wfgraph/pull/153) [`8c52eeb`](https://github.com/alandotcom/wfgraph/commit/8c52eeba4162b7d3962743950eac4aab4c3eff59) Thanks [@alandotcom](https://github.com/alandotcom)! - Redesign the editor Runs panel as an Execution Inspector with event-led run identities, outcome summaries, a canvas-synchronized node journey, friendly action results, and a docked raw-payload console.

## 3.0.0

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

- [#146](https://github.com/alandotcom/wfgraph/pull/146) [`04f4fd1`](https://github.com/alandotcom/wfgraph/commit/04f4fd1fb4c1c437550dbac7b83705d1d0d81dd2) Thanks [@alandotcom](https://github.com/alandotcom)! - Improve canvas selection, connection feedback, issue counts, keyboard shortcut discovery, and graph accessibility.

- [#150](https://github.com/alandotcom/wfgraph/pull/150) [`60caf9a`](https://github.com/alandotcom/wfgraph/commit/60caf9a27252e8027ead65281a1dedb83aad3c21) Thanks [@alandotcom](https://github.com/alandotcom)! - Restore a run's pinned graph and running animation after navigating back to it. A same-workflow hydrate was clearing the overlay, so the canvas stayed on the draft while the Runs panel still showed the open run.

- [#148](https://github.com/alandotcom/wfgraph/pull/148) [`01da8e0`](https://github.com/alandotcom/wfgraph/commit/01da8e01080e2c7847f4d43663f9552515a76d06) Thanks [@alandotcom](https://github.com/alandotcom)! - Stop sending start and result payloads on the run-list procedures.

  `getExecutions` polls every two seconds while the Runs tab is open, and
  `getExecutionsGlobal` pages the dashboard. Neither list paints `input` or
  `output`, yet both selected those JSONB columns and redacted them on every
  answer. Payloads stay on `getExecutionLogs`, which is fetched for the one open
  run.

- [#149](https://github.com/alandotcom/wfgraph/pull/149) [`384e8ca`](https://github.com/alandotcom/wfgraph/commit/384e8ca64274ffdb47439f77e3802444ea91be38) Thanks [@alandotcom](https://github.com/alandotcom)! - Replace the dashboard run-history status chips with a searchable, filterable, virtualized table.

## 2.5.0

### Minor Changes

- [#142](https://github.com/alandotcom/wfgraph/pull/142) [`5bae4ed`](https://github.com/alandotcom/wfgraph/commit/5bae4edec32749af8ae82b978e258042370e0f0f) Thanks [@alandotcom](https://github.com/alandotcom)! - ⌘K opens a command palette whose first job is adding a step and choosing its type.

  The search box slice 3 put in the menu bar was decoration; it is now the palette's trigger and
  carries the chord it answers to. ⌘K reaches it from anywhere in the editor, on the capture
  phase so a focused canvas field cannot eat the keystroke, and leaves the chord alone while
  somebody is typing in a text field. The palette opens at a root page holding "Add step" beside
  the Actions menu's own commands, each carrying that menu's disabled rule so a pinned run or a
  generation in flight refuses them in both places alike.

  "Add step" leads to the node types the extension catalog offers, grouped by category with
  System first. They answer to more than their labels: "delay" finds Wait, "branch" finds
  Condition, and "race" finds Event Split. Choosing one creates the step, selects it, and opens
  its configuration, which is one stage where it used to be two.

  The canvas skips the root. "Add Step" in the graph's context menu opens the palette straight on
  the node types, carrying the spot that was right-clicked. The Actions menu's own "Add step"
  opens the same page and puts the step in the middle of the canvas, moved clear of whatever is
  already there.

  Escape is contested and the palette wins the first press: it goes back a page while there is
  one to go back to, and closes at the root. Backspace on an empty search box does the same. Both
  clear what was typed, because a word typed on one page filters the next one to nothing.

  Built on Base UI's Autocomplete inside a Dialog, which is the shape their own command-palette
  example takes. shadcn's `command` is backed by cmdk, which declares four `@radix-ui/*` packages
  this repository has none of.

  The palette names itself for a screen reader: the search box, the option list, the page it is
  on as a live region, and a close control for a touch reader with no Escape key. It refuses to
  open whenever the Actions menu would refuse "Add step" — a run pinned to the canvas, or a
  generation rewriting the graph — and says which, rather than swallowing the keystroke. A
  non-owner is offered no way into it, opening another workflow throws a held one away, and a
  workflow that has not been saved yet has no palette.

  The action grid in the config panel now searches and groups node types through the same module
  the palette does, so "delay" finds Wait in both. It used to read three fields of its own.

- [#142](https://github.com/alandotcom/wfgraph/pull/142) [`5bae4ed`](https://github.com/alandotcom/wfgraph/commit/5bae4edec32749af8ae82b978e258042370e0f0f) Thanks [@alandotcom](https://github.com/alandotcom)! - The editor's primitives are current shadcn, in the `mira` style.

  `components.json` moves into `packages/client`, where its `#src/*` aliases resolve; from the
  repository root the CLI could not read them at all. Its `style` becomes `base-mira`, which now
  names both the primitive family and the visual style, and `rsc` becomes false for a Vite SPA.
  Sixteen registry components are re-pulled at that style, bringing `textarea` and `input-group`
  with them, and `shadcn/tailwind.css` is imported for the nine `data-*` variants their state
  styling compiles against.

  `mira` is a dense style: a default button is 28px against the previous 36px, and body text
  12px against 14px. Every control in the editor and the dashboard is smaller. The canvas is
  untouched, node geometry included.

  Three behaviours moved with the primitives. `whenChosen` is now in `#src/lib/select-choice`,
  outside the file the CLI overwrites, and each Select feeds its explicit options to Base UI's
  own `items` prop so the trigger and popup share one label source. `ComboboxInputGroup` and
  `ComboboxClear` are gone, absorbed into `ComboboxInput` behind `showTrigger` and `showClear`,
  which takes a `triggerLabel` so the button it renders has an accessible name. `Radio` is
  `RadioGroupItem` and `ComboboxGroupLabel` is `ComboboxLabel`.

  Two defects fixed on the way. A Select trigger rendered a stray `▼` inside its chevron, because
  Base UI's `Select.Icon` defaults its children to that glyph and the registry component passes
  only `render`. And the dashboard's mode badge was `text-zinc-700` with no dark counterpart, so
  it was unreadable against a dark row.

- [#142](https://github.com/alandotcom/wfgraph/pull/142) [`5bae4ed`](https://github.com/alandotcom/wfgraph/commit/5bae4edec32749af8ae82b978e258042370e0f0f) Thanks [@alandotcom](https://github.com/alandotcom)! - Replace the editor's icon toolbar with two menus on a fixed-height bar.

  Nine controls, six of them identical grey squares you had to hover to identify,
  become one 44px line: the dashboard, a menu on the workflow's name, an Actions
  menu, the command palette's trigger, and Publish with a written label. The
  Actions menu names what it does and shows the shortcut each item is bound to,
  and the Live/Test pair becomes a single "Switch to <other> mode", since the
  status strip already says which mode the workflow is in. The workflow menu adds
  Rename and Delete Workflow beside the switcher and prints the workflow's id.

  The Save button is gone. Autosave writes the draft, the strip says when it last
  landed, and Cmd+S still forces one.

  Renaming a workflow now waits on the request rather than on the autosave
  debounce, and a name the server refuses is taken back off the editor and out of
  the save queue. Left parked, a refused name rode along with every later graph
  write and failed it too, so one rejected rename stopped the editor saving
  anything for the rest of the session.

  "Tidy layout" in the Actions menu and the reflow control at the canvas's bottom
  left now run one shared pass, and Add step, Undo, Redo and Tidy layout all
  refuse while a past run is pinned to the canvas, which the buttons they replace
  did not.

- [#142](https://github.com/alandotcom/wfgraph/pull/142) [`5bae4ed`](https://github.com/alandotcom/wfgraph/commit/5bae4edec32749af8ae82b978e258042370e0f0f) Thanks [@alandotcom](https://github.com/alandotcom)! - Add a status strip along the bottom of the editor canvas.

  The workflow's state used to be assembled from chips scattered through the menu
  bar, and a run pinned to the canvas refused every edit with nothing on screen
  saying why. One fixed-height row now states mode, publication and save state
  with the issue count; when a past run is pinned it reports that run and carries
  the way back to the draft, which was previously reachable only from inside the
  run panel. The menu bar keeps the controls and loses the badges, and the
  bottom-centre test-mode banner is gone: what it explained is on the mode label.

- [#142](https://github.com/alandotcom/wfgraph/pull/142) [`5bae4ed`](https://github.com/alandotcom/wfgraph/commit/5bae4edec32749af8ae82b978e258042370e0f0f) Thanks [@alandotcom](https://github.com/alandotcom)! - Give a node's configuration a view mode.

  A node's configuration now reads back as plain text and opens all of its
  controls on one Edit button, which becomes Done. The Lifecycle Node's rules are
  one block of it; so is a condition builder.
  A Start Event reads as its name and the path runs are correlated on. A condition
  reads as one line per rule, with its group shown as a left rule with the rows
  indented behind it and the and/or joiner sitting on the divider between groups.

  A rule that is not finished, points at a field the graph no longer offers, or
  compares against a value its field no longer names says so on its own line, so
  reading a configuration back tells you as much as opening it does.

  The explanatory paragraphs that ran between the controls, including
  Concurrency's three option descriptions, moved into a help popover beside each
  block's label. It opens on a click, with the option in force listed first.

  The Condition node's builder is now headed "Continue when".

  With nothing selected the panel shows an empty state. Everything it used to
  offer about the workflow itself lives in the menu beside the workflow's name,
  which gains a Clear workflow item.

### Patch Changes

- [#142](https://github.com/alandotcom/wfgraph/pull/142) [`5bae4ed`](https://github.com/alandotcom/wfgraph/commit/5bae4edec32749af8ae82b978e258042370e0f0f) Thanks [@alandotcom](https://github.com/alandotcom)! - The editor's mobile sheet is Base UI's Drawer, and `vaul` is gone from the dependency tree.

  `vaul` was the last package pulling Radix into an install of Workflow Graph: 64 `@radix-ui`
  entries in the lockfile, now zero. Base UI's Drawer covers what it did, and `@base-ui/react`
  was already installed for the rest of the editor's primitives.

  The parts map one to one except for the frame. `Drawer.Viewport` has no vaul counterpart and
  is required: it owns the swipe gesture and the touch scroll lock, so it is now the fixed,
  full-screen, bottom-aligned box and the sheet inside it is a laid-out flex item rather than a
  fixed one. Its bounds are unchanged at `max-h-[90vh]`, and the sheet is still a bounded flex
  column, which is what the node config panel's internal scrollers need.

  Base UI animates the sheet from CSS rather than from JS: `data-starting-style` and
  `data-ending-style` carry the enter and exit frames, `--drawer-swipe-movement-y` follows the
  finger, and `--drawer-swipe-progress` fades the backdrop in step with a drag.

  The sheet's bottom inset now works. It was a spacer div classed `h-safe-area-inset-bottom`,
  which compiles to nothing under Tailwind v4, and is `pb-[env(safe-area-inset-bottom,0px)]` on
  the sheet itself.

  Dismissal is unchanged: the close button and the sheet's own dismiss reach `closeAll`, Escape
  reaches `pop`, and a press outside the sheet closes it.

- [#142](https://github.com/alandotcom/wfgraph/pull/142) [`5bae4ed`](https://github.com/alandotcom/wfgraph/commit/5bae4edec32749af8ae82b978e258042370e0f0f) Thanks [@alandotcom](https://github.com/alandotcom)! - Sit the editor inside a margin, on a page a step off the shell.

  The editor used to fill the viewport edge to edge, which left it looking like
  the window rather than something in it. It now sits 12px in on all four sides,
  with a `--radius-xl` corner, a hairline border and a whisper of shadow. The
  surface behind it is a new token, `--page` (`bg-page`), a step off the base
  surface in whichever direction the theme layers: down from Paper in light, and
  up from Void in dark, where nothing renders darker and the shell has to stay
  Void because that is the field the graph floats on. Below `md` the inset, the
  corner and the border all go, since 24px of a phone's width buys nothing and the
  status strip needs the bottom edge of the screen for the home indicator.

  The properties panel's width is now a share of that inset shell rather than of
  the window, and its resize drag measures the same box, so the released edge
  still lands under the pointer.

  Dropping a connection on empty canvas now creates the node under the cursor. The
  release point was being measured from the canvas pane's own corner and handed to
  a converter that wanted window coordinates, which placed every such node up and
  to the left by however far the pane sat from the window's corner.

## 2.4.0

## 2.3.0

### Minor Changes

- [#135](https://github.com/alandotcom/wfgraph/pull/135) [`6b19caa`](https://github.com/alandotcom/wfgraph/commit/6b19caa92ea21447eda5dcf4e99402c44a3f91b6) Thanks [@alandotcom](https://github.com/alandotcom)! - Add optional `hidden` flag on actions so retired actions stay runnable while the editor picker omits them. Document forward-compatible action evolution in `docs/integrations.md`.

## 2.2.3

### Patch Changes

- [#132](https://github.com/alandotcom/wfgraph/pull/132) [`da8560d`](https://github.com/alandotcom/wfgraph/commit/da8560d12d51ce7395f06c746be3db7deb1c22a6) Thanks [@alandotcom](https://github.com/alandotcom)! - Auto-layout keeps a branch in its own column. An outlet a Lifecycle or Condition
  node draws now holds its column whether or not anything is wired to it, so a
  workflow with no Cancel branch still reads as a tree and wiring that branch later
  moves nothing already placed. A Group frame no longer sends the graph to the
  dagre fallback either: a rank is now as tall as the tallest node standing in it,
  so a frame takes a rank of its own and the chain around it stays centred.

## 2.2.2

### Patch Changes

- [#126](https://github.com/alandotcom/wfgraph/pull/126) [`d08d43f`](https://github.com/alandotcom/wfgraph/commit/d08d43fc37687a8e767ed47493c7e9a66c56d88d) Thanks [@alandotcom](https://github.com/alandotcom)! - Keep the canvas context menu inside the window. An item that explains why it is
  disabled now wraps its reason at a capped width rather than stretching the menu
  off the right edge, the menu opens upward when the pointer sits near the bottom,
  and it renders on the body so the properties panel no longer paints over it. A
  disabled row drops its keyboard shortcut, since the key does nothing there.

- [#126](https://github.com/alandotcom/wfgraph/pull/126) [`d08d43f`](https://github.com/alandotcom/wfgraph/commit/d08d43fc37687a8e767ed47493c7e9a66c56d88d) Thanks [@alandotcom](https://github.com/alandotcom)! - Paint the Group frame once, and give it back its side gutters. The frame node is
  typed `group`, which is also a React Flow built-in type, so its wrapper was
  picking up the library's default node border, fill and 10px of padding: a second
  rectangle around the frame, inset far enough that the member cards left a 2px gap
  at each edge instead of the 12px the layout reserves. The frame's label also
  takes the theme's foreground colour in dark mode now, rather than React Flow's
  fixed dark grey.

## 2.2.1

### Patch Changes

- [#121](https://github.com/alandotcom/wfgraph/pull/121) [`b15ee18`](https://github.com/alandotcom/wfgraph/commit/b15ee184c717d8053ab8cd8f75134bbc23095c27) Thanks [@alandotcom](https://github.com/alandotcom)! - Loading a workflow drops the previous one's issues.

  `loadWorkflowGraphAtom` cleared selection, undo history and the dirty flag, and
  left `workflowIssuesAtom` holding what the last graph was accused of. The
  collector is debounced by 300ms, so for that window the toolbar chip counted
  faults against a canvas whose node ids no longer matched, and the badges it
  claims to agree with had already gone with the old nodes. The load now empties
  the list, which is the state a first open already starts in.

## 2.2.0

### Minor Changes

- [#119](https://github.com/alandotcom/wfgraph/pull/119) [`ca0de9a`](https://github.com/alandotcom/wfgraph/commit/ca0de9a4d8be996e1430da6c7cee783be1bf76e2) Thanks [@alandotcom](https://github.com/alandotcom)! - Draw the canvas in a stroke a reader can follow.

  A node card is Paper on a Paper canvas, so its border is the whole card edge,
  and it was a `--border` hairline measuring 1.20:1. Edges came off the same
  token, and an edge into a subtree the run cannot reach then had 40% opacity
  laid over that, leaving nothing on screen. Two tokens replace it:
  `--canvas-line` at 3.95:1 on Paper and 3.21:1 on Void, carrying a node's
  resting border at 1.5px and the live wire; `--canvas-line-muted` at 2.0:1 in
  both themes for an unreachable edge, which now says so with a wider dash gap
  and a stopped march rather than by fading out.

  A Group frame was `bg-muted/40`, which lands near oklch(0.988) over the canvas
  and read as transparent. It is a solid fill behind the same 1.5px border, with
  a rule under its title, so the canvas, the frame and the member cards are three
  tones the eye can order.

  Node icons go from 24px to 20px, and the way back to the dashboard is a
  breadcrumb beside the workflow switcher rather than the first item inside it.

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

### Patch Changes

- [#116](https://github.com/alandotcom/wfgraph/pull/116) [`386e630`](https://github.com/alandotcom/wfgraph/commit/386e6308138f1a3cc2212d72575076ebfa4c9191) Thanks [@alandotcom](https://github.com/alandotcom)! - Order a loaded Group graph rest → frames → members so the canvas can reuse the
  store array instead of reallocating on every read.

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

### Patch Changes

- [#115](https://github.com/alandotcom/wfgraph/pull/115) [`4f34676`](https://github.com/alandotcom/wfgraph/commit/4f34676d7049a9a2577e873c1a79da9a89d43e09) Thanks [@alandotcom](https://github.com/alandotcom)! - Centre the title and description on a canvas node again. Both are full-width
  truncating blocks, so the stack's `items-center` was centring the icon alone and
  leaving the words against the left edge.

  Draw a node's icon at 24px rather than 32px, which gives the two lines of text
  more of the card.

- [#109](https://github.com/alandotcom/wfgraph/pull/109) [`abba0dd`](https://github.com/alandotcom/wfgraph/commit/abba0dd82fa7896062cb6e38713e4254dd3e006c) Thanks [@alandotcom](https://github.com/alandotcom)! - Make the condition field picker a combobox so a long list of upstream paths can be typed to filter.

- [#110](https://github.com/alandotcom/wfgraph/pull/110) [`d6131a9`](https://github.com/alandotcom/wfgraph/commit/d6131a9dc95aefdd1ba4dffb5aad02991dda6e0a) Thanks [@alandotcom](https://github.com/alandotcom)! - Copy and paste selected canvas nodes, including a multi-node subgraph.

  Cmd/Ctrl+C, V, and D (and the node/pane context menus) copy action nodes
  without the Lifecycle Node, keep edges that ran between them, mint fresh ids
  on paste, and rewrite template tokens that named a copied node.

- [#112](https://github.com/alandotcom/wfgraph/pull/112) [`c2a626c`](https://github.com/alandotcom/wfgraph/commit/c2a626c8c6f115f580666ee4fffafe42cb334136) Thanks [@alandotcom](https://github.com/alandotcom)! - Make the canvas denser: 192×112px rectangular nodes and rounded orthogonal edges.

- [#115](https://github.com/alandotcom/wfgraph/pull/115) [`4f34676`](https://github.com/alandotcom/wfgraph/commit/4f34676d7049a9a2577e873c1a79da9a89d43e09) Thanks [@alandotcom](https://github.com/alandotcom)! - Drop `react-grab`. It was a dependency of the published editor for the sake of
  one development-only dynamic import, so every adopter installed it to run code
  that a production build never reaches.

- [#115](https://github.com/alandotcom/wfgraph/pull/115) [`4f34676`](https://github.com/alandotcom/wfgraph/commit/4f34676d7049a9a2577e873c1a79da9a89d43e09) Thanks [@alandotcom](https://github.com/alandotcom)! - Drop the `Temporary` edge component. Nothing built an edge of that type, so the
  canvas registered a component it could never resolve to.

- [#115](https://github.com/alandotcom/wfgraph/pull/115) [`4f34676`](https://github.com/alandotcom/wfgraph/commit/4f34676d7049a9a2577e873c1a79da9a89d43e09) Thanks [@alandotcom](https://github.com/alandotcom)! - Paint every edge with the canvas edge after a reload. A saved graph came back
  with no edge type on it, since the persisted edge attributes drop the editor's
  own keys, and React Flow answers a type it cannot resolve with its built-in
  bezier edge. A refresh therefore replaced the rounded orthogonal path with a
  plain curve until the next time the edge was drawn by hand.

  The canvas now names its edge once, through React Flow's `defaultEdgeOptions`,
  and no edge carries a type of its own. How an edge draws is one decision in one
  place, so a new edge cannot be built without an answer and no stored graph can
  carry a stale one.

  The persisted graph carries structure and geometry alone. A node's `selected`
  and `dragging` and an edge's `selected` were written to the wire and belong to
  whoever is looking at the graph, so they are gone from both directions.

- [#115](https://github.com/alandotcom/wfgraph/pull/115) [`4f34676`](https://github.com/alandotcom/wfgraph/commit/4f34676d7049a9a2577e873c1a79da9a89d43e09) Thanks [@alandotcom](https://github.com/alandotcom)! - Draw a Group's interior edges, so parallel members read as parallel. The frame
  already kept the store edges naming its children, and the engine still ran them
  side by side and joined them at the exit; the canvas painted the members as a
  bare grid with no handles, which made a fan-out look like a sequence.

  A nested card now carries invisible handles for those edges to meet at, a row
  narrower than the widest one is centred so a join sits under everything it
  joins, and the rows are spaced far enough apart for the path to be read. A
  nested Condition keeps its two branches on the offsets a standalone Condition
  uses, so a fan-out inside a frame paints as two paths. An interior edge is
  display only: the frame owns every edit, since deleting one would strand a
  member.

  Ungrouping rebuilds the freed steps at the pitch auto-layout uses, rather than
  leaving them overlapping at the compact spacing they had inside the frame.

  Hold a member inside its frame until the frame goes. Deleting one on its own
  left the frame naming an exit that no longer existed, and the next edge painted
  off the frame's outlet named that dead step too; graphology then invented a node
  for it and the save failed on an unreadable `Missing key at ["nodes"][6]`. Every
  delete path asks one question and gives one answer: the delete key, the context
  menu, and the panel's own button all refuse a selection that reaches into a
  frame without taking the frame, and each says to ungroup first rather than
  doing nothing. `createSerializedWorkflowGraph` now refuses an edge naming a node
  the graph has no node for, and says which edge.

- [#115](https://github.com/alandotcom/wfgraph/pull/115) [`4f34676`](https://github.com/alandotcom/wfgraph/commit/4f34676d7049a9a2577e873c1a79da9a89d43e09) Thanks [@alandotcom](https://github.com/alandotcom)! - Group lookup and Condition steps on the canvas as a single-entry, single-exit
  frame so a sequence can copy-paste the same fetch-and-stop after each Wait.
  Lookups inside the frame may run side by side and AND-join at the Condition.

## 2.0.2

## 2.0.1

## 2.0.0

### Patch Changes

- [#100](https://github.com/alandotcom/wfgraph/pull/100) [`73feb18`](https://github.com/alandotcom/wfgraph/commit/73feb18706a0d38157a5e8c9899b4644b210c04a) Thanks [@alandotcom](https://github.com/alandotcom)! - Release the editor canvas whenever no surface is left showing the open run.

  Opening a run pins its published graph to the canvas and locks editing, and only
  the Runs panel's own controls released it. Two ways of hiding the panel did not:
  closing the node config sheet on a narrow viewport, and collapsing the rail on a
  wide one. Both leave the Runs tab selected with its tab bar off screen, so the
  run stayed pinned and every edit was refused with nothing on screen to say why.
  Each now closes the run as it goes, and the panel comes back on Properties.

  Opening an overlay now runs the `onClose` of whatever it replaces, matching every
  other path that takes an overlay off the stack. Tapping Test Run while the config
  sheet was up discarded the sheet silently, which was the same locked canvas by a
  third route.

  The Runs panel's Back button no longer leaves the Runs tab. It clears the open
  run and returns to the runs list its label names, which is what the route's tab
  rule now allows: a run in the URL opens the Runs tab, and its absence leaves the
  panel's own tab alone.

- [#95](https://github.com/alandotcom/wfgraph/pull/95) [`a9f08b4`](https://github.com/alandotcom/wfgraph/commit/a9f08b4883375cc8492ae4f53eae4e4876ea7fdc) Thanks [@alandotcom](https://github.com/alandotcom)! - Fix the editor canvas staying read-only after the user leaves the Runs tab.
  Opening a run pins its published graph to the canvas and locks editing, and the
  Runs panel's Back button was the only control that released it. A switch to the
  Workflow tab left the run id in the URL, so the canvas kept refusing every edit
  with nothing on screen to say why. The pinned graph now reads through the same
  Runs-tab gate that the run's status chips already used.

## 1.0.0

## 0.3.0

## 0.2.0

## 0.1.0

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

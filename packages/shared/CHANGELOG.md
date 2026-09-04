# @wfgraph/shared

## 4.0.0

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

- [#181](https://github.com/alandotcom/wfgraph/pull/181) [`cbd75a8`](https://github.com/alandotcom/wfgraph/commit/cbd75a8e57b27d242ffededcd1d866d92fa377f1) Thanks [@alandotcom](https://github.com/alandotcom)! - Show a connection's stored value as the placeholder for the config field that falls back to it. Resend's From, and Twilio's From Number and Messaging Service SID, are optional on the node and the handler reads the connection when they are blank; the editor now says which value that is instead of drawing a generic example.

  An action config field declares the fallback with `connectionDefaultKey`, naming one of the integration's own credentials, held to that set by the type. `checkIntegration` refuses a key the integration does not declare and refuses a `password` one, since the browser holds a mask in place of a secret. That declaration is also the allowlist for the new `connectionDefaults` on a connection summary: a stored value no field names never reaches the editor.

  Also fixes a template field redrawing only when its text changed, which left a stale placeholder on screen after the value behind it moved.

- [#176](https://github.com/alandotcom/wfgraph/pull/176) [`ba1046a`](https://github.com/alandotcom/wfgraph/commit/ba1046a97333d6e0ab7989d828489673315a5944) Thanks [@alandotcom](https://github.com/alandotcom)! - A workflow version records which of two kinds it is. `workflow_versions` gains a `kind` column holding `published` or `draft_snapshot`, and its `version` number is nullable because a snapshot has none. A published version is what Publish creates and what `published_version_id` points at. A draft snapshot is the frozen canvas graph a draft run pins itself to; it stays out of the version history, out of the next-version number, and out of the Event subscription index. PostgreSQL needs a migration. A SQLite database migrates itself on open, rebuilding the table with its foreign keys intact.

  `workflow.execute` takes an optional `graph` of `"published"` or `"draft"`. An absent field means published, which is what every existing caller sends and what every Event start runs.

  Every run a client reads carries `versionKind` and `versionNumber`, on the two run-list procedures and on the run summary that `getExecutionLogs` returns. Run history can then name the graph a run executed: the draft, or the published version by its number.

- [#157](https://github.com/alandotcom/wfgraph/pull/157) [`dea6043`](https://github.com/alandotcom/wfgraph/commit/dea6043a2455cda99058ac23d6e4421751c1e606) Thanks [@alandotcom](https://github.com/alandotcom)! - Add config fields whose shape the node's connection answers. Two field types join the vocabulary: `provider-select` draws a dropdown over what the connection lists, and `provider-fields` draws one input per value the current selection declares, stored as one JSON object under the one config key. An integration declares what each asks under `configOptions`, keyed by the name a field's `optionsSource` uses, and `checkIntegration` refuses a field wired to a provider that cannot answer it.

  The editor asks over `integration.configOptions`, which resolves the connection's credentials server-side the way the connection test does. Credentials never reach the browser, and neither does a failed request's own exception text. A provider refusing is an answer rather than an error, so the sentence it wrote is what the panel shows. Every provider-backed field falls back to the plain control it replaces, so a missing connection, a grant too narrow to read, or a provider that is down never leaves a builder unable to type the value themselves.

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

- [#175](https://github.com/alandotcom/wfgraph/pull/175) [`351ff6b`](https://github.com/alandotcom/wfgraph/commit/351ff6bd22b8d007905beda8c1e564cbf173d962) Thanks [@alandotcom](https://github.com/alandotcom)! - A publish refused because publication moved now says so in a form the editor can act on. The two refusals carry a machine-readable code beside their sentence: `workflow_publish_stale` when the version the draft was reviewed against is no longer current, and `workflow_already_published` when the graph offered is the one already published. Each stays a 409 over oRPC and over HTTP, keeping the wording an operator reads. `@wfgraph/shared/rpc/error-codes` is the one home of those codes, which both ends import.

  The editor branches on the code. A stale refusal closes the obsolete review, re-reads the workflow's publication state and version history, and asks the operator to review again, with the canvas still holding the draft. An already-published refusal closes the review and reports that there were no changes to publish. Every other publish failure behaves as before, including the toast it has always raised.

  `ApiError` in `@wfgraph/client` carries the `code` an oRPC failure arrived with, alongside the status and message it has always had. `code` is set when the payload carries one as a non-empty string, and stays unset otherwise.

### Patch Changes

- [#195](https://github.com/alandotcom/wfgraph/pull/195) [`a4ea00d`](https://github.com/alandotcom/wfgraph/commit/a4ea00dc09c27261e3c9db321fc4efc7fb3548fa) Thanks [@alandotcom](https://github.com/alandotcom)! - Bump es-toolkit to 1.52 and import it by subpath. The published option types now declare `| undefined` on their optional properties, which matters to an adopter compiling with `exactOptionalPropertyTypes`: a maybe-undefined value can now be passed straight into an optional field instead of being filtered out first.

- [#218](https://github.com/alandotcom/wfgraph/pull/218) [`9b06194`](https://github.com/alandotcom/wfgraph/commit/9b06194403dadd6c12c47ec7d7d7cb1471625832) Thanks [@alandotcom](https://github.com/alandotcom)! - Improve large workflow canvas fitting, navigation, layout spacing, and description access.

- [#216](https://github.com/alandotcom/wfgraph/pull/216) [`66e79c9`](https://github.com/alandotcom/wfgraph/commit/66e79c9a4997f3df78ac92bd94d5850fe845c45b) Thanks [@alandotcom](https://github.com/alandotcom)! - Show external MCP edits live on a clean open workflow canvas, preserve local
  edits when revisions conflict, and refresh workflow lists after MCP creation.

- [#202](https://github.com/alandotcom/wfgraph/pull/202) [`0de5068`](https://github.com/alandotcom/wfgraph/commit/0de50684125dee7df6f2cc406fc856a1d00b7ab5) Thanks [@alandotcom](https://github.com/alandotcom)! - Render closed-set action inputs as select fields when their JSON Schema uses union branches.

- [#157](https://github.com/alandotcom/wfgraph/pull/157) [`dea6043`](https://github.com/alandotcom/wfgraph/commit/dea6043a2455cda99058ac23d6e4421751c1e606) Thanks [@alandotcom](https://github.com/alandotcom)! - A node missing a value its template needs is now a blocking issue, so it carries a badge on the canvas, counts in the status strip, and stops a publish. Previously the config panel marked the empty input red while the canvas said the node was fine and publish let it through.

  The shared collector cannot raise these: which variables a provider has no default for is the operator's own connection to answer. The editor asks that question for every node rather than only the open one. Passive badges and issue counts stay quiet while an answer is pending, because absence is not evidence that a value is missing. Run and Publish recheck the exact current nodes and wait for every answer; a failed check blocks the action instead of letting an unverified workflow through.

## 3.1.1

## 3.1.0

## 3.0.0

### Patch Changes

- [#148](https://github.com/alandotcom/wfgraph/pull/148) [`01da8e0`](https://github.com/alandotcom/wfgraph/commit/01da8e01080e2c7847f4d43663f9552515a76d06) Thanks [@alandotcom](https://github.com/alandotcom)! - Stop sending start and result payloads on the run-list procedures.

  `getExecutions` polls every two seconds while the Runs tab is open, and
  `getExecutionsGlobal` pages the dashboard. Neither list paints `input` or
  `output`, yet both selected those JSONB columns and redacted them on every
  answer. Payloads stay on `getExecutionLogs`, which is fetched for the one open
  run.

## 2.5.0

## 2.4.0

## 2.3.0

## 2.2.3

## 2.2.2

## 2.2.1

## 2.2.0

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

### Patch Changes

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

## 2.0.2

## 2.0.1

## 2.0.0

## 1.0.0

## 0.3.0

## 0.2.0

## 0.1.0

## 0.0.2

## 0.0.1

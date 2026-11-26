# @wfgraph/plugins

## 4.2.0

### Minor Changes

- [#360](https://github.com/alandotcom/wfgraph/pull/360) [`112a43e`](https://github.com/alandotcom/wfgraph/commit/112a43ebdbb489cb401bbd986e2fa1482ac75dc2) Thanks [@alandotcom](https://github.com/alandotcom)! - `defineIntegration` takes the connection test and each config options provider as the function itself. Write `test: testMyService` and `configOptions: { templates: { answers: "options", load: templateOptions } }`, with `testMyService` and `templateOptions` imported statically from their modules. A `test` or `load` written as `async () => (await import("...")).fn` fails to type-check. The `ConfigOptionsLoader` type is removed from `@wfgraph/core/plugin`; name `ConfigOptionsFunction` in its place. The change exists because, in a bundled Cloudflare Worker, a dynamic import made the bundler wrap every module the import reached in a lazy initializer, which added startup time and bundle size.

- [#360](https://github.com/alandotcom/wfgraph/pull/360) [`112a43e`](https://github.com/alandotcom/wfgraph/commit/112a43ebdbb489cb401bbd986e2fa1482ac75dc2) Thanks [@alandotcom](https://github.com/alandotcom)! - Each built-in integration has its own entry, and each integration is a function a host calls. Import an integration from `@wfgraph/plugins/clerk`, `@wfgraph/plugins/linear`, `@wfgraph/plugins/posthog`, `@wfgraph/plugins/resend`, `@wfgraph/plugins/slack` or `@wfgraph/plugins/twilio`, and pass the result of calling it under `extensions.integrations`, for example `integrations: [resend(), slack({ oauthClient })]`. `clerk()`, `linear()`, `posthog()`, `resend()` and `twilio()` take no arguments; `slack(options?)` takes the same options as before. The root `@wfgraph/plugins` entry is removed, along with `builtInIntegrations` and `BuiltInIntegrationsOptions`, so a host that used all six writes six imports. `@wfgraph/plugins/ui` is unchanged. A host now loads only the integrations it imports, which keeps a Cloudflare Worker inside the platform's startup time limit.

### Patch Changes

- [#360](https://github.com/alandotcom/wfgraph/pull/360) [`112a43e`](https://github.com/alandotcom/wfgraph/commit/112a43ebdbb489cb401bbd986e2fa1482ac75dc2) Thanks [@alandotcom](https://github.com/alandotcom)! - The Clerk integration calls Clerk's Backend API directly, at API version 2026-08-20, and `@clerk/backend` is no longer a dependency of `@wfgraph/plugins`. Clerk calls now share the timeout and retry rules of the other built-in integrations: reads and updates are retried after a rate limit or an unavailable answer, and creating or deleting a user is sent once. Update User sends a changed name to `PATCH /v1/users/{user_id}` and metadata to `PUT /v1/users/{user_id}/metadata`, which replaces each metadata field it is given.

- [#362](https://github.com/alandotcom/wfgraph/pull/362) [`1e9cb68`](https://github.com/alandotcom/wfgraph/commit/1e9cb68313a07d2a7fe88d27df650d4a477c1c18) Thanks [@alandotcom](https://github.com/alandotcom)! - The editor is easier to read and to operate.

  - The canvas fills the editor. The outline floats over its top left as plain rows listing every step, scrolling inside itself, and `[` hides and shows it. An outline row and its canvas card answer the same clicks, keys and context menu, and with several steps selected the context menu names the count, such as "Delete 2 steps". Selecting something opens the Inspector, one card floating at the canvas's right edge, whose header names the step and holds its commands and Close; it closes when the selection clears, on Close, or on Escape. Nothing in the editor scrolls by itself when a step is added or selected. The build agent rests as a one-line pill at the bottom of the canvas that grows into the full prompt when clicked, with its conversation opening above it, and once grown it offers the selected step as a chip to attach. Cmd+J (Ctrl+J), the Hide agent control on the pill and the command palette hide the agent and leave a small Show agent control that marks a running turn or an unread reply; the choice is kept in the browser across workflows. Below 900px the outline is the main view and Map shows the canvas.
  - The Workflows page lists one-line rows with one State column (Live, Test, Paused or Never published), a page title, and an error state when a list cannot load. A row with failed or waiting runs shows their counts, and each count filters All Runs to them.
  - A run is titled by its Entity, such as "Patient pat_20418", with the Event that started it and its start time beneath. A step that a test run skipped reads "Skipped (test run)", and a failed step names its cause and the Connection to repair. A refused Run draft stays in its dialog and says which fields are wrong.
  - Editor shortcuts no longer run behind an open dialog or in a text field, dialogs take and return focus, two-finger scroll pans the canvas, and the command palette ranks a command's own name first and finds step types.
  - Add step joins the Started path when it has one open end, a Wait offers common durations, Event pickers list the host app's Events first, and Run draft opens on a sample Event.
  - Publish opens one review sheet that lists each edit in the order the workflow runs, with where it sits and the changed words marked, and ends in the decision to publish. It replaces the Changes view and the Publish dialog. Version history shows what each past version changed in the same sheet.
  - Selecting a step in Draft shows one always-editable form of its settings, what it does first and its Notes last, with one label per field, longer help behind an info icon, and each issue beneath the field it names. The Start shows its rules as one form the same way. The Inspector's title is the step's, Group's or Start's name: click it and type to rename, Enter to keep the name and Escape to put it back. No form has a Label field. Disable, Duplicate and Delete are in the Inspector header's menu and the context menu, and the issue list's Edit opens the step at its field. A template field says that typing @ inserts a value.
  - A run of the draft that is waiting on a timed Wait offers Continue now, which ends that Wait as if its time had come so the run goes on. A run of a published version never offers it.
  - Status text clears 4.5:1 contrast, focus rings are full strength, and overlays share one scrim that darkens in both themes.

  A refused Publish or Run draft calls a Start or Cancel filter what the Start's form calls it, “Only start when” or “Only stop when”, and gives an Event's label where it used to print the Event's type key, so an unfinished rule in a filter shared by several Events reads "“Only start when” has a rule that is not finished. Finish the rule, or remove it." An unfinished rule says what it is missing, such as "A value is required."

  Fixes: duplicating a workflow that contains a Group no longer fails, a Wait Duration that cannot be read is a blocking issue, and deleting a Connection no longer rebinds its steps to another Connection.

  The build agent uses the step numbers the editor prints and reads what a test run does at each step from the workflow's own settings. `read_workflow` and `read_nodes` give each step its `stepNumber` and give an action step its `testRun`, the note under a message names each attached step by number and label, and a host runner's `turn.selectedNodes` carries `stepNumber`. `validate_workflow`, in the chat and over MCP, also answers `steps`: each numbered step's `id`, `stepNumber` and `label` in run order. When the model writes a tool call whose arguments are not valid JSON, the agent tells it so and runs that model step once more, in the built-in runner and in `streamAgentTurn`; a second such call in the same turn ends the turn with an error.

  Each run that `getExecutions`, `getExecutionsGlobal` and `getExecutionLogs` return carries `entity`: the tracked Entity's `type` and `id`, or null when the workflow tracks no Entity. Each wait that `getExecutionLogs` returns carries `waitType`, `delay` or `event`. The new `workflow.continueWait` procedure, which takes `run.manage`, ends one waiting park of a draft run as if its time had come and refuses a run of a published version.

  Each workflow that `getAll` and `subscribeList` return carries `runCounts`: `failedRecently`, the failed runs among the newest 50 its run list shows, and `waiting`, its runs waiting now. `subscribeList` reads the counts every ten seconds, so a run that fails or parks reaches a new snapshot within that time.

  A run that fails because the host found no Entity, or because its resolver failed, records that failure on the node whose data needed the Entity, so `getExecutionLogs` answers an error log for that node.

  The built-in integrations' setting "Test Mode Behavior" is labeled "In test runs". Its key and values are unchanged. Their field placeholders no longer show a `{{NodeName.field}}` syntax the editor does not read.

- [#360](https://github.com/alandotcom/wfgraph/pull/360) [`112a43e`](https://github.com/alandotcom/wfgraph/commit/112a43ebdbb489cb401bbd986e2fa1482ac75dc2) Thanks [@alandotcom](https://github.com/alandotcom)! - The Linear integration calls Linear's GraphQL API directly, and `@linear/sdk` is no longer a dependency of `@wfgraph/plugins`. Its calls now share the timeout and retry rules every other built-in integration uses: a read that Linear rate limits is retried, and creating an issue is sent once. Find Issues reads each issue's workflow state and assignee in the same request as the issue.

## 4.1.2

### Patch Changes

- [#352](https://github.com/alandotcom/wfgraph/pull/352) [`91576c1`](https://github.com/alandotcom/wfgraph/commit/91576c1afe86f5234d97394dae4da83083c3646f) Thanks [@alandotcom](https://github.com/alandotcom)! - `@wfgraph/core` and `@wfgraph/plugins` now depend on `effect` 4.1.4, and `@wfgraph/core` depends on `@effect/ai-anthropic`, `@effect/ai-openai`, `@effect/ai-openai-compat`, `@effect/ai-openrouter`, `@effect/opentelemetry` and `@effect/sql-sqlite-node` 4.1.4. A host that installs its own copy of `effect` should move it to 4.1.4 so the host and Workflow Graph share one copy.

## 4.1.1

### Patch Changes

- [#349](https://github.com/alandotcom/wfgraph/pull/349) [`94be756`](https://github.com/alandotcom/wfgraph/commit/94be75649ae70350f49f8c58e61b1e485c0a95f6) Thanks [@alandotcom](https://github.com/alandotcom)! - The published Agent Skills now declare `library_version` 4.1.1, the version they ship in. The 4.1.0 tarballs carried skills that still declared 3.1.1, so `intent stale` reported them as out of date against the installed package. The skill content is unchanged.

## 4.1.0

### Patch Changes

- [`bce4adc`](https://github.com/alandotcom/wfgraph/commit/bce4adc2aab29c8f97348db0d06c38dd617de51f) Thanks [@alandotcom](https://github.com/alandotcom)! - `@wfgraph/core` and `@wfgraph/plugins` now depend on `effect` 4.1.3, and `@wfgraph/core` depends on `@effect/ai-openai`, `@effect/opentelemetry` and `@effect/sql-sqlite-node` 4.1.3. A host that installs its own copy of `effect` should move it to 4.1.3 so the host and Workflow Graph share one copy.

- [`2337489`](https://github.com/alandotcom/wfgraph/commit/23374890ef6bf24721a79a29a4e96df143cd86d9) Thanks [@alandotcom](https://github.com/alandotcom)! - PostHog's `POSTHOG_HOST` must now be an `https:` URL with no user name or password. The Capture Event and Identify Person steps fail and the connection test answers an error for any other host, before any request carries the project key. A blank host still means US Cloud.

- [`1c006e3`](https://github.com/alandotcom/wfgraph/commit/1c006e3a330ed0bf45c0a5085282a65ab983ac1d) Thanks [@alandotcom](https://github.com/alandotcom)! - Resend's Send Email sends an idempotency key that names its node within the run. Two Send Email nodes in one run used to share the run's id as their key, so Resend answered the second node with the first node's email and sent nothing.

- [`0da7e00`](https://github.com/alandotcom/wfgraph/commit/0da7e007914704191e765656e35b2c9519f77128) Thanks [@alandotcom](https://github.com/alandotcom)! - The Slack actions' channel placeholder and message descriptions no longer show the `{{NodeName.field}}` form, which contradicted the `{{@nodeId:Label.path}}` token form the editor and the build agent write. The channel placeholder now shows a channel name or ID.

- [`fe37170`](https://github.com/alandotcom/wfgraph/commit/fe371708a42eb47fceb078f8657528d756b65a59) Thanks [@alandotcom](https://github.com/alandotcom)! - Disconnecting or deleting a Slack OAuth connection now succeeds when Slack answers `apps.uninstall` with `invalid_auth`, `token_revoked` or `account_inactive`, which is what Slack says once a workspace has already uninstalled the app. Those answers used to fail the revocation, so the disconnect failed on every try.

## 4.0.0

### Major Changes

- [#157](https://github.com/alandotcom/wfgraph/pull/157) [`dea6043`](https://github.com/alandotcom/wfgraph/commit/dea6043a2455cda99058ac23d6e4421751c1e606) Thanks [@alandotcom](https://github.com/alandotcom)! - Add OAuth connections for Resend and Slack. Call `builtInIntegrations()` to configure the built-in set, and pass `slack.oauthClient` to enable Slack OAuth. Clerk, Linear, Resend, and Twilio remain exported integration values; Slack is a factory because it accepts host-provided client credentials.

  Core owns browser-bound, one-use authorization attempts, PKCE, encrypted grants, serialized token refresh, and revoke-before-delete behavior. A new OAuth connection is stored only after its authorization callback succeeds.

### Minor Changes

- [#181](https://github.com/alandotcom/wfgraph/pull/181) [`cbd75a8`](https://github.com/alandotcom/wfgraph/commit/cbd75a8e57b27d242ffededcd1d866d92fa377f1) Thanks [@alandotcom](https://github.com/alandotcom)! - Show a connection's stored value as the placeholder for the config field that falls back to it. Resend's From, and Twilio's From Number and Messaging Service SID, are optional on the node and the handler reads the connection when they are blank; the editor now says which value that is instead of drawing a generic example.

  An action config field declares the fallback with `connectionDefaultKey`, naming one of the integration's own credentials, held to that set by the type. `checkIntegration` refuses a key the integration does not declare and refuses a `password` one, since the browser holds a mask in place of a secret. That declaration is also the allowlist for the new `connectionDefaults` on a connection summary: a stored value no field names never reaches the editor.

  Also fixes a template field redrawing only when its text changed, which left a stale placeholder on screen after the value behind it moved.

- [#305](https://github.com/alandotcom/wfgraph/pull/305) [`6a353f1`](https://github.com/alandotcom/wfgraph/commit/6a353f102bad16b193bbac256617d0f7dc484b37) Thanks [@alandotcom](https://github.com/alandotcom)! - Show Event descriptions throughout the editor, derive readable field labels from property keys, and use JSON Schema `title` as an optional label override and `description` as help text across Event payloads, Action forms, references, agent tools, and built-in integrations.

- [#187](https://github.com/alandotcom/wfgraph/pull/187) [`9d7e2bd`](https://github.com/alandotcom/wfgraph/commit/9d7e2bd9fb2e9f0c3c63d86cec01651592ea51d1) Thanks [@alandotcom](https://github.com/alandotcom)! - Add a Resend Find Email action that retrieves a sent email by ID and exposes its
  delivery details, content, recipients, and tags to downstream workflow nodes.

- [#346](https://github.com/alandotcom/wfgraph/pull/346) [`e977201`](https://github.com/alandotcom/wfgraph/commit/e9772018c92e846df4869a02c2061fa9aec6e2df) Thanks [@alandotcom](https://github.com/alandotcom)! - Several run, connection and editor states that were spread across flags and separate writes now hold together.

  Every path that ends a run commits its timeline entry in the same transaction as the write that ends it: a traversal's terminal record, a run the executor fails outside any node or for a missing version, an operator cancel, and a supersede. A crash between the two writes used to leave an ended run with no `run_completed`, `run_failed`, `run_cancelled` or `run_superseded` entry. Because a supersede can no longer be half recorded, `failedToSupersede` is gone from the manual start response and from start, delivery and cron outcomes. A run ended by a cancel, a supersede or a direct terminal insert now records a duration, and the Runs view reads every unfinished node of an ended run as cut off, whatever the run ended in.

  A refresh claim on an OAuth connection is taken only from the state its caller read and is released back to that state, so a credential read that started before a connection was marked `reauthorization_required` can no longer return it to connected, and a reconnect that fails before its code exchange leaves it needing reauthorization. A Cancel Event now reaches its Entity's in-flight runs whatever the workflow's Published mode is now, so a run started in live mode is still cancelled after the workflow switches to test. This also lets a published workflow's Cancel Event reach Draft runs of that Entity, which it did not before. A delay Wait reads only the keys its declared timing owns, so a duration Wait no longer waits for a stale `waitUntil`.

  The run status `pending`, which no write stored, is removed from `WORKFLOW_EXECUTION_STATUSES`, and the run status in the logs summary and status poll contracts is typed by that list. Migrations on both backends add checks that tie each row's columns to its state: run, wait, node log and subscription vocabularies, run mode and start source on PostgreSQL as SQLite already had them, a schedule row's lease columns, a step memo's value and failure count, a wait row's wake, at most one wait row per Wait node in a run, a connection's refresh claim, and an OAuth attempt's mode and result. The version a workflow publishes can no longer be deleted while the workflow points at it. Every current writer satisfies these checks.

  In the editor, a save failure is reported once and stays on the workflow it happened on, an interrupted node drag ends and moves back, reopening a workflow shows an edit its save still carries, Run stays busy until a started run is read, an agent turn's graph lands on the Draft from any view, and the draft and workflow-list subscriptions reconnect after the server ends them normally.

- [#182](https://github.com/alandotcom/wfgraph/pull/182) [`30d78c4`](https://github.com/alandotcom/wfgraph/commit/30d78c4e4c07e571ab84974aa987e9d8491846dc) Thanks [@alandotcom](https://github.com/alandotcom)! - Add a PostHog built-in with capture/identify and CIMD OAuth.

- [#157](https://github.com/alandotcom/wfgraph/pull/157) [`dea6043`](https://github.com/alandotcom/wfgraph/commit/dea6043a2455cda99058ac23d6e4421751c1e606) Thanks [@alandotcom](https://github.com/alandotcom)! - Pick a Resend template from the connection instead of typing its id. The Send Email action's Template field lists the account's own templates, drafts labelled as such, and the Template Variables field draws one input per variable that template declares. A variable Resend has a fallback for is prefilled with it and left out of what is sent, so Resend applies it; a variable with no fallback is marked required, because Resend refuses the send without one.

  Reading templates needs Resend's full-access grant, which its own scope vocabulary offers nothing narrower than. A send-only connection says so in the field and keeps the plain id input, so nothing that worked before stops working.

  A provider may report a field as `required` on `ConfigOptionField`, which the editor draws as a required input.

  Fixes an OAuth adapter's granted-access label being able to fail a token refresh: `grantedAccessLabel` is what a dialog draws, so a scope the adapter cannot word now answers nothing rather than turning a working grant into one an operator has to reauthorize.

- [#196](https://github.com/alandotcom/wfgraph/pull/196) [`eac8377`](https://github.com/alandotcom/wfgraph/commit/eac8377bda8ba7001b697366521533ea99797c4e) Thanks [@alandotcom](https://github.com/alandotcom)! - Add a Slack action for replying to an existing message thread.

- [#157](https://github.com/alandotcom/wfgraph/pull/157) [`dea6043`](https://github.com/alandotcom/wfgraph/commit/dea6043a2455cda99058ac23d6e4421751c1e606) Thanks [@alandotcom](https://github.com/alandotcom)! - Let a Resend connection be granted full access, which is what Resend requires to read templates. The client metadata document now registers both of Resend's scopes rather than `emails:send` alone. The registered set is the ceiling on what an operator may grant, so registering one scope was what grayed out "Full access" on Resend's consent page; registering both makes the page's own Permission chooser live. The authorization names no scope, which asks for the whole registered set and leaves the choice where it is made.

  An `IntegrationOAuth` adapter can report `grantedAccessLabel` on its token set: how much access the provider granted, in the provider's own words, read off the token response rather than assumed from the request. Both `exchange` and `refresh` return it, so a provider that narrows a grant is recorded rather than left claiming the old access. The connection dialog shows it read-only beside the account, and offers Reconnect on a working connection, which is the only thing that can change a grant.

### Patch Changes

- [#157](https://github.com/alandotcom/wfgraph/pull/157) [`dea6043`](https://github.com/alandotcom/wfgraph/commit/dea6043a2455cda99058ac23d6e4421751c1e606) Thanks [@alandotcom](https://github.com/alandotcom)! - Keep OAuth-provided credentials read-only while allowing other connection settings to be edited and tested with the saved OAuth grant, including Resend grants limited to email sending. A connection test now learns which credentials an OAuth grant issued, through a second `IntegrationTestContext` argument on the integration `test` function. The editor reports a credential field as configured from what the server actually stored, so a disconnected connection shows an empty field rather than a filled one, and it keeps offering the OAuth flow so a disconnect stays reversible. `slack({ oauthClient })` reads a pair that is blank on both sides as manual-only, which lets a host pass its environment straight through.

- [#337](https://github.com/alandotcom/wfgraph/pull/337) [`ae8c958`](https://github.com/alandotcom/wfgraph/commit/ae8c958feb9fe709a73f66df630a5fd91cc9a3cd) Thanks [@alandotcom](https://github.com/alandotcom)! - `callExternal` now reads a `Retry-After` header given as an HTTP date as well as one given in seconds. `ExternalRejected.retryAfterSeconds` carries the wait measured from when the refusal arrived, so a date-form value can hold a fraction. A digit string too long to be a number now counts as a wait past the ceiling, so a 429 that carries one ends on its first attempt.

  A duration written as a bare `P` or `PT` is now refused. It used to read as zero, so a Wait or an Event duration field holding one passed validation and waited for nothing. ISO 8601 durations are now parsed by Effect's `Duration.fromIso`.

- [#195](https://github.com/alandotcom/wfgraph/pull/195) [`a4ea00d`](https://github.com/alandotcom/wfgraph/commit/a4ea00dc09c27261e3c9db321fc4efc7fb3548fa) Thanks [@alandotcom](https://github.com/alandotcom)! - Bump es-toolkit to 1.52 and import it by subpath. The published option types now declare `| undefined` on their optional properties, which matters to an adopter compiling with `exactOptionalPropertyTypes`: a maybe-undefined value can now be passed straight into an optional field instead of being filtered out first.

- [`d2c1404`](https://github.com/alandotcom/wfgraph/commit/d2c14046cababce8229abd0098301e70536d6a10) Thanks [@alandotcom](https://github.com/alandotcom)! - The Linear integration now depends on `@linear/sdk` `^101.1.0`, up from `^99.0.0`. The breaking changes in Linear's 100 and 101 releases remove Salesforce and Jira settings inputs that the integration never sends, so its actions and connection test behave as before.

- [`f08fc8b`](https://github.com/alandotcom/wfgraph/commit/f08fc8b0e728814929ed25427af097c745531af0) Thanks [@alandotcom](https://github.com/alandotcom)! - Take the latest minor and patch releases of the runtime dependencies. `@wfgraph/core` now needs `@hono/node-server` `^2.1.6` and `@opentelemetry/semantic-conventions` `^1.44.0`, and its `hono` peer range rises to `^4.13.16` and its optional `inngest` peer range to `^4.26.2`. `@wfgraph/plugins` now needs `@clerk/backend` `^3.27.0`. The editor bundle in `@wfgraph/client` carries `@tanstack/react-query` 5.106.1, `@xyflow/react` 12.12.1, `lucide-react` 1.69.0 and `motion` 14.9.1.

- [#181](https://github.com/alandotcom/wfgraph/pull/181) [`cbd75a8`](https://github.com/alandotcom/wfgraph/commit/cbd75a8e57b27d242ffededcd1d866d92fa377f1) Thanks [@alandotcom](https://github.com/alandotcom)! - Fail a Resend send whose Tags or Template Variables box does not parse, rather than
  sending the email without them. Tags are an output other nodes reference by key, so a
  dropped box left every downstream `tags.order_id` reading nothing while the run reported
  success. The three content modes now name the field a builder still has to fill in as the
  form labels it: "Content Mode is HTML, so HTML Body must be filled in."

- [`b31a9ce`](https://github.com/alandotcom/wfgraph/commit/b31a9ce30b8f4df6c558dc2101a9b869b037482e) Thanks [@alandotcom](https://github.com/alandotcom)! - Each Agent Skill in `@wfgraph/core` and `@wfgraph/plugins` now has a `description` that says when a coding agent should load it, including requests that name no Workflow Graph API, and which skill to load for the neighboring task. The previous description text moves unchanged to `metadata.purpose`. The guidance in each skill is unchanged.

- [`d4527c3`](https://github.com/alandotcom/wfgraph/commit/d4527c3c3fcefe7ed710ed5d713495067b2ee6f5) Thanks [@alandotcom](https://github.com/alandotcom)! - Update the remaining runtime, integration, UI, and development dependencies. Raise the supported Hono and Inngest peer ranges to match the tested releases.

- [`d5d271f`](https://github.com/alandotcom/wfgraph/commit/d5d271fd3e70886a5db62e9f3577d5765c5ea13c) Thanks [@alandotcom](https://github.com/alandotcom)! - Update Effect to 4.0.2, oRPC to 2.0.0-beta.43, and TanStack dependencies to their current releases.

  Generated OpenAPI documents now use OpenAPI 3.2. Effect's AI spans use the updated OpenTelemetry GenAI attribute names, including `gen_ai.provider.name`.

- [#301](https://github.com/alandotcom/wfgraph/pull/301) [`8f2e421`](https://github.com/alandotcom/wfgraph/commit/8f2e421e8a0f0a799e6f1b3826207a152123a52e) Thanks [@alandotcom](https://github.com/alandotcom)! - Update runtime and development dependencies to their latest compatible releases.

## 3.1.1

## 3.1.0

## 3.0.0

## 2.5.0

## 2.4.0

## 2.3.0

### Minor Changes

- [#135](https://github.com/alandotcom/wfgraph/pull/135) [`6b19caa`](https://github.com/alandotcom/wfgraph/commit/6b19caa92ea21447eda5dcf4e99402c44a3f91b6) Thanks [@alandotcom](https://github.com/alandotcom)! - Add optional `hidden` flag on actions so retired actions stay runnable while the editor picker omits them. Document forward-compatible action evolution in `docs/integrations.md`.

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

## 2.0.2

## 2.0.1

## 2.0.0

## 1.0.0

### Major Changes

- [#93](https://github.com/alandotcom/wfgraph/pull/93) [`e83fb18`](https://github.com/alandotcom/wfgraph/commit/e83fb18c1ed52a30cfea1c38aa66b69cd0b6630a) Thanks [@alandotcom](https://github.com/alandotcom)! - Remove the Acuity integration. `@wfgraph/plugins` now ships five built-ins (Clerk, Linear,
  Resend, Slack, Twilio), the `acuity` export and its `integrationUi` entry are gone, and the
  `@fountain-bio/acuity` dependency is dropped. A host importing `acuity` by name must delete
  that import; a host passing `builtInIntegrations` needs no change. Stored `acuity`
  connections and any workflow node on an `acuity/*` action no longer resolve to a registered
  integration.

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

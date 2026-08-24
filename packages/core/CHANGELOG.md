# @wfgraph/core

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

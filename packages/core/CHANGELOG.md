# @wfgraph/core

## 4.1.0

### Minor Changes

- [`7f2566a`](https://github.com/alandotcom/wfgraph/commit/7f2566aa3defedc715ecc36889fd5dd65fc0c6dc) Thanks [@alandotcom](https://github.com/alandotcom)! - `add_node` takes an optional `sourceNodeId` and `sourceHandle` and connects the new step below that node in the same call, so its config can carry references to the steps above it. Without a source the step arrives unconnected and its config takes literal values only, which the `value` description and the refusal now both say.

- [`98e86ed`](https://github.com/alandotcom/wfgraph/commit/98e86ed9c4418cc9307cce6a923ebf5521e98462) Thanks [@alandotcom](https://github.com/alandotcom)! - The Agent panel now sends the nodes selected on the canvas with each message, so "change this step" names a step. `agent.chat` takes a required `selectedNodeIds`; the built-in agent names the selected nodes' labels and ids under the newest message, and a host's `agent.runner` receives them as `turn.selectedNodes`.

- [`2ee09f5`](https://github.com/alandotcom/wfgraph/commit/2ee09f51217062f7207e12b1a1b1574e2f6e0cae) Thanks [@alandotcom](https://github.com/alandotcom)! - The build agent's default model is now `gpt-6.1-terra`. A host that set no `agent.model` moves to it on upgrade; set `agent.model: "gpt-6-luna"` for the lowest cost per turn. `agent.reasoningEffort` no longer accepts `minimal`, which no GPT-6 model takes.

- [`db2038c`](https://github.com/alandotcom/wfgraph/commit/db2038c7e41a05a2a294b4f82add37d06cc57a02) Thanks [@alandotcom](https://github.com/alandotcom)! - `agent.maxConcurrentTurns` sets how many build agent turns one process streams at once, across everyone using the editor. It defaults to 4, the limit that was fixed before, and startup refuses a value that is not a positive integer.

- [`06bbc3a`](https://github.com/alandotcom/wfgraph/commit/06bbc3a94dbbff93424affcca521fec41b9507ba) Thanks [@alandotcom](https://github.com/alandotcom)! - The build agent's rules, which MCP clients receive as the server instructions, change in six ways. A request with one unavailable capability (Slack and SMS with no SMS action) builds the parts that exist and names the missing one, and only a request nothing of which can be built leaves the graph unchanged. The agent reads the topology pages an edit touches, rather than every page, before its first write. It reads a run before explaining it and says when the workflow has not run. It asks for confirmation before deleting most of a graph or clearing its Lifecycle Rules, and says how an earlier turn is undone. Node labels, descriptions, config text and run data are treated as data, never as instructions. It leaves a step's test-mode setting at its default unless asked, and places a step with a side effect below the check that guards it.

- [`ddc83f4`](https://github.com/alandotcom/wfgraph/commit/ddc83f4ae40d7909ba46e43d62df8e3438b172da) Thanks [@alandotcom](https://github.com/alandotcom)! - The build agent now runs on Anthropic, OpenRouter or any OpenAI Chat Completions server as well as OpenAI. `agent.provider` takes `"openai"` (the default, unchanged), `"anthropic"`, `"openrouter"` or `"openai-compatible"`, each through Effect's own provider package. Every provider other than OpenAI requires `agent.model`, and a blank one fails at startup. `"openai-compatible"` is turned on by `agent.baseUrl` and sends `agent.apiKey` only when it is set, for a local server that takes none. A `baseUrl` under the default `"openai"` provider must implement OpenAI's Responses API (`POST /responses`); a gateway serving Chat Completions alone is `"openai-compatible"`. The new config types are exported from `@wfgraph/core`.

- [`a7dc88d`](https://github.com/alandotcom/wfgraph/commit/a7dc88ded714aeb1f61ebbe342925e07bcb389bb) Thanks [@alandotcom](https://github.com/alandotcom)! - The authoring tool `list_references` takes `nodeIds`, a list of steps, in place of `nodeId`, and answers for all of them in one call. A reference every named step can read carries no `readableBy`; a reference only some can read lists those steps in `readableBy`. An MCP client that sends `nodeId` must send `nodeIds`.

- [`3ecc1e2`](https://github.com/alandotcom/wfgraph/commit/3ecc1e2bbd4fa21267ed22de5fd2aa74f81dd9a6) Thanks [@alandotcom](https://github.com/alandotcom)! - The build agent and the MCP endpoint gain four tools: `list_runs` and `read_run` read a workflow's recent runs and one run's step log (each step's output is cut to 2,000 characters, with its full size beside it), `start_test_run` starts a Draft run of the saved draft with a payload and answers the run id, and `list_field_options` answers the choices a provider-backed field offers. Each checks the caller's grant for the same editor operation per call: `workflow.getExecutions`, `workflow.getExecutionLogs`, `workflow.execute`, and `action.configOptions` or `integration.configOptions`. A Draft run calls real action handlers in test mode, so `start_test_run` is annotated as open-world and not read-only, and in the chat panel it refuses after the turn has edited the draft, since the editor saves those edits only when the turn ends.

- [`d66985f`](https://github.com/alandotcom/wfgraph/commit/d66985f2452ef42ee8bcdb00e90b3ca07326e4c9) Thanks [@alandotcom](https://github.com/alandotcom)! - `agent: { runner }` lets a host run the build agent's turns on its own gateway or model. A `WfGraphAgentRunner` receives a `WfGraphAgentTurn` (the workflow id, the messages, the conversation as an Effect AI prompt under the built-in system prompt, the authoring toolkit bound to the turn's draft, and the abort signal) and answers a stream of the parts the panel renders; Workflow Graph adds the canvas's `graph` parts after each successful write. `streamAgentTurn(turn, model)` runs the built-in loop on a `LanguageModel` layer the host builds. Both, and the types, are exported from `@wfgraph/core`.

- [`77ca8f6`](https://github.com/alandotcom/wfgraph/commit/77ca8f61388be25869381c88bcf540af6d297bab) Thanks [@alandotcom](https://github.com/alandotcom)! - The build agent now remembers what its earlier turns did. Each assistant message in `agent.chat`'s `messages` may carry a `record`: its tool calls with their outcomes, the ids and labels of the nodes it added, changed and removed, and whether it was stopped or ended on an error. The Agent panel builds the record as a turn streams, and the built-in agent writes it under that message's text for the model. A turn the person stopped is now sent as an assistant message saying so, where it used to leave two user messages in a row.

- [`cfb9ca9`](https://github.com/alandotcom/wfgraph/commit/cfb9ca9db90ca7af5df898aee474b6216c5aa276) Thanks [@alandotcom](https://github.com/alandotcom)! - A build agent turn now ends with a `usage` part carrying its model calls, tool calls and token counts (input, cached input, output and reasoning), and the Agent panel shows them in one line under each finished turn. A host's `agent.runner` may emit a `usage` part of its own, which is added to the turn's counts.

- [`ba2beb4`](https://github.com/alandotcom/wfgraph/commit/ba2beb4e5b1a177da36c529bc01df14fa20e0297) Thanks [@alandotcom](https://github.com/alandotcom)! - A build-agent or MCP write no longer re-runs full auto-layout. Steps already on the canvas keep their positions, including ones a person moved by hand, and each step the write added is placed below the step it runs after (or above the step it leads to) and moved right until it overlaps nothing. A graph with no positioned step is still laid out whole.

- [`e834585`](https://github.com/alandotcom/wfgraph/commit/e8345855e56c529dc83b871f62c0341dd725ca0c) Thanks [@alandotcom](https://github.com/alandotcom)! - New build tool `apply_edits` applies an ordered list of `add_node`, `update_node`, `delete_node`, `connect_nodes`, `disconnect_nodes` and `insert_node_on_edge` operations as one write. Over MCP it stores one revision under one `expectedDraftRevision`; a refused operation stops the batch and nothing is stored. A step an operation creates can carry a `key` that later operations name as `$key`, including inside a reference token. The editor's build agent has the same tool.

- [`53b228c`](https://github.com/alandotcom/wfgraph/commit/53b228c79f2e5d60a73a81cf1634f49c2fcd4752) Thanks [@alandotcom](https://github.com/alandotcom)! - `auth` on `createWfGraphApp` and `wfWorker` now takes the authenticate function itself, `(request) => access | null | undefined`, as well as an object holding it as `authenticate`. An answer of `undefined` is a request that is not signed in and gets a 401, where it used to be a 500; a role lookup such as `WfGraphRoles[session.role]` that finds no role is the common case. `createWfGraphApp` now refuses an `auth` that is neither form at startup with a message naming the option, where a JavaScript host used to start and answer 500 to every operator request. `defineWfGraphAuth` now returns the function it is given, unchanged, and the new `WfGraphAuthenticate` type names that function.

- [`b779a49`](https://github.com/alandotcom/wfgraph/commit/b779a49e0d7229f35caafe82069a0fa61d9301dc) Thanks [@alandotcom](https://github.com/alandotcom)! - A Condition rule can name the step its field comes from, stored as `$node:<node id>.<path>`, and the engine reads that step's value even where a later step offers the same path. The editor's field picker lists a path two steps offer once under each step and writes the rule naming the one picked. The build agent's `set_condition` takes a `sourceNodeId` per rule, writes the rule naming that step, and refuses a rule without one when more than one step above the Condition offers its path. Publish and a draft run refuse a rule naming a step that is not above the Condition or no longer in the graph. A rule stored with its path alone runs as it did, reading the later step, and the editor warns when more than one step above the Condition offers its path; picking the field again names the step.

- [`8ff7ac8`](https://github.com/alandotcom/wfgraph/commit/8ff7ac8b3ed7738d7bb2765a9cbb67b2a10449f1) Thanks [@alandotcom](https://github.com/alandotcom)! - A handler's bag now carries `idempotencyKey`, a string built from the run's id and the node's id that stays the same on every pass and retry of that node, to hand a vendor that deduplicates requests by key. Inside `step.run`, the Promise form's work is handed `{ idempotencyKey }` for that step, and `step.idempotencyKey(name)` answers the same key for any step name, so two calls in one handler use two keys. `executionId` on the bag is now always a string. `runAction` and `runHostAction` from `@wfgraph/core/testing` stand a case in for the run `execution_test` unless `node.executionId` names another.

- [`6d28bc6`](https://github.com/alandotcom/wfgraph/commit/6d28bc6bb6228400b427f4947a2e373c7d287b8f) Thanks [@alandotcom](https://github.com/alandotcom)! - `createWfGraphApp` answers a new `health()`, which checks that the database answers a one-row read within five seconds and, when the app runs a worker loop, that the loop finished a turn of polling and claiming within two poll intervals and never less than a minute. It never rejects. The new `health: true` option mounts `GET {basePath}/api/health`, a readiness route outside `auth` that answers `{ ok, checkedAt, database, runner }` with 200 when ok and 503 otherwise. `WfGraphHealth` and `WfGraphRunnerHealth` are exported.

- [`4b2dea3`](https://github.com/alandotcom/wfgraph/commit/4b2dea388bb7eb403ec1bbdfdbecaca3920b6845) Thanks [@alandotcom](https://github.com/alandotcom)! - `app.health()` now also answers `queue`: how many runs, Event deliveries and cron fires are due now across every process's loops, the earliest wake time among them, and how long that row has waited, for a host to export as a metric. The readiness route leaves it out, since it answers without authentication. `WfGraphQueueHealth` is exported.

- [`551f60a`](https://github.com/alandotcom/wfgraph/commit/551f60a4f0f5c6f00fbd8a2b72ac4d1fdb189fe8) Thanks [@alandotcom](https://github.com/alandotcom)! - `@wfgraph/core` now exports the `WfGraphMcpOptions` and `WfGraphAgentConfig` types, which `WfGraphAppOptions` already named for its `mcp` and `agent` options, and `callExternal` and `callExternalAsync` with their `ExternalCallResult`, `ExternalError` and `ExternalRequest` types, which the integrations guide documents for a host action's HTTP calls and which were reachable only from `@wfgraph/core/plugin`.

- [`469cf76`](https://github.com/alandotcom/wfgraph/commit/469cf768f75bec853d430ba7a1ac920ca96f2dfb) Thanks [@alandotcom](https://github.com/alandotcom)! - A `defineAction` handler now runs inside one durable step of its node, so a handler that answered once is not called again for that node of that run, whether or not it calls `step.run`. Before, a host handler ran again on every pass of the run, and a side effect written outside `step.run` repeated after every Wait, retry and restart. `step.run` inside a handler keeps memoizing each named step, so a handler whose step threw is called again on the retry and resumes past the steps that finished. A throw outside any `step.run` still fails the node once, and is now also what every later pass answers. Integration actions written with `defineIntegration` are unchanged and still remember only what their handler puts in `step.run`. Each host action node writes one more row to the run's step memo.

- [`e43ba7b`](https://github.com/alandotcom/wfgraph/commit/e43ba7b39c4e0023ba43fe79625ed913ab88af57) Thanks [@alandotcom](https://github.com/alandotcom)! - An MCP `tools/call` whose arguments do not match the tool's schema now returns an `isError` tool result naming each wrong field and what it expected, in place of JSON-RPC error `-32602` "Invalid tool arguments" with HTTP 400. The MCP specification classes input validation errors as tool execution errors so a model can correct the call. A call naming an unknown tool still answers `-32602`.

- [`3d9a782`](https://github.com/alandotcom/wfgraph/commit/3d9a7820b3bd170dc086b265242bf8e659d30fb8) Thanks [@alandotcom](https://github.com/alandotcom)! - The MCP endpoint now sends the build agent's authoring rules as the server's `instructions` and registers a `build_workflow` prompt carrying the same rules, so an MCP client builds to the rules the editor's chat agent follows: create the Lifecycle Node first, take reference tokens only from `list_references`, and validate at the end.

- [`099df3a`](https://github.com/alandotcom/wfgraph/commit/099df3a9695d58da8827b12aae768f0d685bc6dd) Thanks [@alandotcom](https://github.com/alandotcom)! - The MCP endpoint now answers a 401 with a `WWW-Authenticate` challenge. The new `mcp.authorization` option names the OAuth authorization servers (and optionally the scopes) for the endpoint; when it is set, Workflow Graph serves RFC 9728 protected-resource metadata at `/.well-known/oauth-protected-resource${basePath}/api/mcp` and the challenge carries `resource_metadata`, so an MCP client can discover where to obtain a token. Without it the challenge is a bare `Bearer`. A 403 for an unaccepted `Host` or `Origin` now names `mcp.allowedHostnames` or `mcp.allowedOriginHostnames` and no longer quotes the rejected hostname. `WfGraphMcpAuthorization` is exported from `@wfgraph/core`.

- [`503b9d7`](https://github.com/alandotcom/wfgraph/commit/503b9d7689bd703783de3fa32abbdf92712f8d58) Thanks [@alandotcom](https://github.com/alandotcom)! - The MCP catalog tools (`list_actions`, `describe_action`, `list_events`, `describe_event`, `list_integrations`) no longer require a `workflowId` or the `workflow.getById` grant, so a client can discover what the host offers before it creates a workflow. `list_integrations` still requires `integration.getAll`.

- [`0e1c5f0`](https://github.com/alandotcom/wfgraph/commit/0e1c5f079e2dda347af5805c93e50e32cbfbcb8b) Thanks [@alandotcom](https://github.com/alandotcom)! - The MCP endpoint now serves 2025-era clients (protocol revisions `2024-10-07` through `2025-11-25`) statelessly beside `2026-07-28`, so the official SDK's default client connects instead of failing with "Unsupported protocol version". The server now advertises `listChanged: false` for tools and prompts, since a stateless endpoint sends no list-changed notifications.

- [`e4c0131`](https://github.com/alandotcom/wfgraph/commit/e4c01317ccdb945ef2826458b447faec66d6e0fa) Thanks [@alandotcom](https://github.com/alandotcom)! - The MCP endpoint gains `publish_workflow`, `list_versions` and `restore_version`. `publish_workflow` publishes the stored draft and answers the draft revision the publish leaves, or, for a draft with publish blockers, an error result listing every blocker. `restore_version` replaces the draft with a published version's graph, which gives an MCP client an undo. They require `workflow.publish`, `workflow.getVersionHistory` and `workflow.restoreVersion`. The build agent in the editor does not offer them.

- [`ba8d970`](https://github.com/alandotcom/wfgraph/commit/ba8d970400dd2741cb8dc74d7aa13cfed7190f11) Thanks [@alandotcom](https://github.com/alandotcom)! - `encryption` on `createWfGraphApp` and `createWfGraphRunner` is now optional for an app whose `extensions` declare no integration, since connections and OAuth attempts are the only values Workflow Graph encrypts. An app that declares an integration and passes no key still fails at startup with the same message, and a key that is passed must still be a 64-character hex string. `wfWorker` still requires `encryption.key`.

- [`d71bba6`](https://github.com/alandotcom/wfgraph/commit/d71bba65ee9ebe7a05bfcc02a6ea934d92f71f90) Thanks [@alandotcom](https://github.com/alandotcom)! - The worker loop's default run concurrency on PostgreSQL now follows the pool size: `min(10, max(1, floor(maxConnections / 2)))`, which is 5 for the default pool of 10, where it used to take the whole pool. At the old default a loop could hold 12 connections from a pool of 10 once its delivery and cron lanes ran beside its runs, leaving the app's HTTP requests queued behind them. A `runner.concurrency` the host sets is used as it is.

- [`4f628a9`](https://github.com/alandotcom/wfgraph/commit/4f628a98b421278669f2e20d94144573a4ffe48c) Thanks [@alandotcom](https://github.com/alandotcom)! - Publish answers with a `warnings` list, and the editor shows each warning after the success toast. A Publish whose version tracks an Entity while runs an untracked version started are still in flight, or the reverse, now warns with the number of those runs: they identify their Entity in the other form, so they finish on their old version and Migration refuses them. The warning never stops the Publish.

- [`6abb1e8`](https://github.com/alandotcom/wfgraph/commit/6abb1e8fa183fac41d816a1d3b05f4f5afa9027e) Thanks [@alandotcom](https://github.com/alandotcom)! - `runHostAction` from `@wfgraph/core/testing` now runs a host action the way one pass of a run runs its node. It answers `handlerRan` and the `memo` the pass leaves, and takes `memo` in place of `replay`: an earlier run's `memo` holds the handler's answer, so a case can assert that a later pass does not call the handler again, and `memo: { steps: { name: value } }` answers a `step.run` from a stored value, as `replay` did. A `step.run` whose work throws now rejects the promise with that error, because the executor retries such a step rather than failing the node.

- [`a19fc9c`](https://github.com/alandotcom/wfgraph/commit/a19fc9c237482796d5ee12cbc749c409ddba3663) Thanks [@alandotcom](https://github.com/alandotcom)! - `@wfgraph/core/testing` now exports `runHostAction(action, { input, runMode, credentials, replay })`, which runs a host action built with `defineAction` through the whole step boundary and resolves with the envelope the engine reads and every `step.run` its handler made. `replay` answers a step from a stored value without running its work, the way the executor answers a step that ran on an earlier pass. `RecordedStep` and `HostActionRun` are exported beside it.

- [`5fc5d3b`](https://github.com/alandotcom/wfgraph/commit/5fc5d3b3f4020c33b95476e1048e7a7143b03316) Thanks [@alandotcom](https://github.com/alandotcom)! - `createWfGraphRunner` now takes the options object `createWfGraphApp` takes, so a host builds one object in a shared module and passes `{ ...options, runner: false }` to the app and `options` to the runner. The runner ignores `auth`, `client`, `mcp`, `agent` and `events.key`, takes `auth` as optional, and ignores `runner: false`, since it always runs a loop. `CreateWfGraphRunnerOptions` is now `WfGraphAppOptions` with an optional `auth`. A mismatch between the two processes' database, key, extensions or retention windows used to fail silently.

- [`a370018`](https://github.com/alandotcom/wfgraph/commit/a3700181e9fabafc20fe4017c4daf22273591dc7) Thanks [@alandotcom](https://github.com/alandotcom)! - A template may now name only a node upstream of the node holding it. Publish and a draft run refuse a workflow whose template names any other node, such as a node on a parallel branch, because whether that node had run when the template resolved depended on which branch finished first, and the action could receive the template text in place of the value. The editor marks the node that holds such a template, and the build agent reports it as a publish blocker. A node behind the Canceled outlet can still read a node behind the Started outlet.

- [`289c5dc`](https://github.com/alandotcom/wfgraph/commit/289c5dc5feefce7a6130f11b0049c9cc8c8a2252) Thanks [@alandotcom](https://github.com/alandotcom)! - `events.send` on the app and the runner now also takes the value `defineEvent` returned, `events.send(appointmentCreated, data, { id })`, and types `data` from the Event's schema; the `{ name, data, id }` form stays for a sender that holds only a name. The new `events.inboxInsert(event, data, { id })` checks a payload the way a send does and answers the documented `workflow_event_inbox` insert, with the table qualified by the PostgreSQL schema, and its parameters, so a host runs it on its own connection inside its own transaction. `$2` is the payload object on PostgreSQL and JSON text on SQLite, and `namedParams` serves a driver such as `node:sqlite` that binds `$1` by name. `createWfGraphInngestFunctions` now asks only for the `send` by name and the `sourceNames` of the `events` it is handed.

- [`506f0e1`](https://github.com/alandotcom/wfgraph/commit/506f0e101a16bbe126380b31dd7e01f36ac6d345) Thanks [@alandotcom](https://github.com/alandotcom)! - `validate_workflow` now answers `canSave`, `saveIssues`, `canPublish`, `publishBlockers` and `warnings`. It answered `draftValid` and `structuralIssues`, and a client read `draftValid: true` beside publish blockers as "ready". `canPublish` is true only when the draft saves and has no publish blockers.

- [`2dee478`](https://github.com/alandotcom/wfgraph/commit/2dee4785c24b8f242b7bfc55dc49eaba76e8f67b) Thanks [@alandotcom](https://github.com/alandotcom)! - An event-mode Wait no longer misses an Event that was delivered while its run was still on the way to it. When the Wait first parks, it wakes at once with the oldest Event its subscription and match accept that was delivered since the run started. The Event that started the run, the Cancel Event that claimed it, and an Event that already woke one of the run's Waits never count.

- [`e562988`](https://github.com/alandotcom/wfgraph/commit/e5629882965087555daeebd514008a0aebabe923) Thanks [@alandotcom](https://github.com/alandotcom)! - Every build-tool write now answers `newIssues`: the validation issues the draft has after the write that it did not have before, each with `blocksPublish`, `kind`, `message` and the step's id and label. A client no longer needs a `validate_workflow` call after each step to learn what an edit left to fix.

### Patch Changes

- [`23c253f`](https://github.com/alandotcom/wfgraph/commit/23c253fa40f54866f0b916c0dbe525becb02b0da) Thanks [@alandotcom](https://github.com/alandotcom)! - `agent.reasoningEffort` defaults to `high` when `agent.provider` is `anthropic`. It defaulted to `medium`. On the eval suite `claude-sonnet-5-5` followed the authoring rules far more often at `high`, for about one more second per turn.

- [`f674068`](https://github.com/alandotcom/wfgraph/commit/f674068f0340120297da749b3a6ed02c46590181) Thanks [@alandotcom](https://github.com/alandotcom)! - The build agent runs on `agent.provider: "anthropic"`. Every turn was refused with "Too many strict tools", because the agent's toolkit holds more than the 20 strict tools Anthropic accepts in one request. The tools are now sent without `strict`, and each tool still validates its own arguments.

- [`53f5f0c`](https://github.com/alandotcom/wfgraph/commit/53f5f0cb0a3e7c5ba9b6ee4c59b30bf640705356) Thanks [@alandotcom](https://github.com/alandotcom)! - The build agent's instructions tell it to build several steps in three calls: one `apply_edits` that adds and connects them, one `list_references` naming them, and one `apply_edits` that writes their configs. On a five-step build this removed the step-by-step path a third of runs took, which used twice the tokens. `set_condition` now names the step a Condition reads a path from when two steps above it offer that path.

- [`cb1c3ba`](https://github.com/alandotcom/wfgraph/commit/cb1c3ba5fd19f4582e145e94d38e8c42486f2b69) Thanks [@alandotcom](https://github.com/alandotcom)! - The "Agent turn finished" log record now carries `usage.cachedInputTokens`, the part of `usage.inputTokens` the provider read from its prompt cache.

- [`251af2d`](https://github.com/alandotcom/wfgraph/commit/251af2d51c3f1a7b6cbcb1a94ae4354c37618df0) Thanks [@alandotcom](https://github.com/alandotcom)! - A build agent turn now applies to each tool the grants the MCP endpoint applies: `workflow.getById` for every tool, `workflow.update` for a write tool, and `integration.getAll` for `list_integrations`. A caller holding `agent.use` without `integration.getAll` could read the operator's Connection ids and types through the chat; that tool now answers the model a refusal for them.

- [`119e2b5`](https://github.com/alandotcom/wfgraph/commit/119e2b5e20c9d7b1902abda744ba96a387f8505d) Thanks [@alandotcom](https://github.com/alandotcom)! - `delete_node` and `disconnect_nodes` now name every step the removal left holding a reference it can no longer read, in the editor's build agent and over MCP, rather than reporting success alone.

- [`7558d9d`](https://github.com/alandotcom/wfgraph/commit/7558d9d1bfcbfdcb23ff0f9b712cd47ff27a8dd4) Thanks [@alandotcom](https://github.com/alandotcom)! - Build agent requests now cache per workflow and leave nothing stored at the provider. An OpenAI request sets `store: false`, where the Responses API used to store every response by default, and carries `prompt_cache_key: "wfgraph-agent:<workflowId>"`; OpenRouter requests carry the same key, and Anthropic requests ask for automatic prompt caching.

- [`db8b9c3`](https://github.com/alandotcom/wfgraph/commit/db8b9c3fcc600db7c779585dec516b84b6095f2f) Thanks [@alandotcom](https://github.com/alandotcom)! - Build-tool results and refusals now name a step by its canvas label with its id beside it, such as `"Score applicant" (n_123)`, where they printed a bare id, including the refusal of an edge that would make a loop.

- [`dcb0eaa`](https://github.com/alandotcom/wfgraph/commit/dcb0eaaef988500e3cdfa107076426be6f07bde0) Thanks [@alandotcom](https://github.com/alandotcom)! - A build-agent `apply_edits` call is now one draft revision in the chat panel, as it already was over MCP. It advanced the turn's revision once per operation, and a refused batch left revisions behind for the edits it undid.

- [`4cd88c3`](https://github.com/alandotcom/wfgraph/commit/4cd88c370be0c4f81d6e9fe7e6e8f1fdb1c9fb25) Thanks [@alandotcom](https://github.com/alandotcom)! - The Arriving Event is now carried per branch, as CONTEXT.md defines it. A node reads the Event, and the payload it addresses through the entry node, of the nearest Wait above it on its own path. It used to be one value for the whole run, so when a pass replayed two event-mode Waits on parallel branches, whichever finished last set the Event and the entry payload for every branch: a node below one Wait could render the other Wait's payload, or an empty one after the other Wait timed out, and an Event Split there could route nowhere. A node joining branches that carry different arrivals takes the one on its incoming edge listed first in the graph. The run's own `outputs` now keep the Start Event's payload for the entry node.

- [`f5de630`](https://github.com/alandotcom/wfgraph/commit/f5de6300b174bfac7eac91547346f2f6224b8416) Thanks [@alandotcom](https://github.com/alandotcom)! - Deleting all of a workflow's runs, and deleting a workflow, now remove its run history 500 rows per transaction. Each used to be one transaction over the whole history, which on SQLite held the database's only writer until it finished. A delete that stops partway leaves whole runs behind, and repeating it deletes the rest.

- [`48dc6af`](https://github.com/alandotcom/wfgraph/commit/48dc6afdf60ee883bb747f1ece6663c41e77e705) Thanks [@alandotcom](https://github.com/alandotcom)! - A Cancel Event and Concurrency now reach the runs an older published version started after a Publish that began or stopped tracking an Entity. Those runs keep the identity form their version started them with, the Entity Value or the typed Entity identity, and an arriving Event is compared with them in that form, where before such runs could no longer be cancelled or superseded.

- [`0f1d0ad`](https://github.com/alandotcom/wfgraph/commit/0f1d0ad3c123f046f565eb3d868a25262d68d9dd) Thanks [@alandotcom](https://github.com/alandotcom)! - A Cancel Event now follows the order Events were received in, whatever order the worker loop delivers them in. A start delivered after a Cancel Event received later opens its run already claimed for the Canceled outlet, and a Cancel Event no longer cancels a run whose start Event was received after it. On PostgreSQL a start and a Cancel of one Entity delivered at once by two processes no longer miss each other. Runs a person or a schedule started are canceled as before. Run the new PostgreSQL migration (`@wfgraph/core/migrate`) before deploying; SQLite migrates on open.

- [`cb81efb`](https://github.com/alandotcom/wfgraph/commit/cb81efb1f54e601d68405c41d4eb7091ec7f79e3) Thanks [@alandotcom](https://github.com/alandotcom)! - A Cancel Event now reaches the runs of a workflow whose published graph no longer passes the checks a start runs, such as one naming an integration that was deleted after Publish. Such a workflow stops opening new runs, and its runs in flight still take the Canceled outlet when their Cancel Event arrives, where before every Cancel Event for it was skipped and those runs carried on.

- [`7e1b34f`](https://github.com/alandotcom/wfgraph/commit/7e1b34f3ecc42324ab957c707a2e492392ca9ada) Thanks [@alandotcom](https://github.com/alandotcom)! - A Wait that a Cancel or Exit claim stopped, whether it was parked or had not parked yet, no longer closes its run-log row as `success`. The row stays open, and once the run has ended the Runs view and the run status read show it as `cancelled`, beside the run's cancellation. The Wait's node output is unchanged.

- [`88b49b1`](https://github.com/alandotcom/wfgraph/commit/88b49b1864683093e2b850b0737ebdb72c7f1aca) Thanks [@alandotcom](https://github.com/alandotcom)! - A deploy that changes the extension catalog no longer fails the actions a parked run has already finished. The catalog fingerprint check now applies to an action node that has not finished; a node an earlier pass completed is replayed from its step memo without the check. Any catalog change, adding an unrelated action included, still fails a node of a pinned run that runs for the first time after the deploy, and that node now records its failure on its run-log row.

- [`50cc627`](https://github.com/alandotcom/wfgraph/commit/50cc627d490f963df8094af35bb9930de4dcc28e) Thanks [@alandotcom](https://github.com/alandotcom)! - On PostgreSQL, a claim no longer counts a failure against a run whose pass released it in the moment between the claim's read and its lock. The claim now reads each row as it locks it.

- [`fcbe282`](https://github.com/alandotcom/wfgraph/commit/fcbe28275fc49781ab476dce5549b3ed04c47ee7) Thanks [@alandotcom](https://github.com/alandotcom)! - Operator routes now refuse a write that a browser sends from another site. A `POST`, `PUT`, `PATCH` or `DELETE` to the RPC, REST or OAuth routes answers `403` when its `Sec-Fetch-Site` is `cross-site` or `same-site` and its `Origin` is neither the configured `publicUrl` nor the request's own origin. A request with `Origin` and no `Sec-Fetch-Site` is held to the same origins, and a request with neither header, such as a server-side client, is unaffected. `POST /api/integrations/oauth/start` now also requires `Content-Type: application/json` and answers `415` otherwise. Before this, a cookie-authenticated write relied on the host cookie's `SameSite` setting alone, so a form posted from a sibling subdomain reached mutating routes.

- [`df06a85`](https://github.com/alandotcom/wfgraph/commit/df06a85945f50420e5cacc9d99140497123f390b) Thanks [@alandotcom](https://github.com/alandotcom)! - Deleting a connection that holds an OAuth grant now always removes it. Workflow Graph still asks the provider to revoke the grant first, and the `integration.delete` answer carries `oauthRevocation: "revoked"` or `"not_revoked"`. A delete used to fail on every try when the provider refused revocation, when `publicUrl` was unset, when the integration no longer declared `oauth`, when the stored grant was unreadable, or when the connection needed reauthorization. `not_revoked` is also logged as a warning with its reason, so an operator can revoke the grant at the provider. A refresh owner that stopped answering no longer blocks a delete: past the staleness bound the connection is fenced for reauthorization and then deleted.

- [`84d2d5c`](https://github.com/alandotcom/wfgraph/commit/84d2d5c28f120e3fdfff6b068b6b55a2ff77ebab) Thanks [@alandotcom](https://github.com/alandotcom)! - A delivery that runs a lifecycle step again, after a crash or a resend of a failed Event, no longer writes its Refused Start or Cancellation Failure row twice. Each such row is written under an id derived from the workflow and the delivery, so the repeat is a no-op.

- [`77b36c6`](https://github.com/alandotcom/wfgraph/commit/77b36c6d4b43efc0383cf15373f6b208997dfc33) Thanks [@alandotcom](https://github.com/alandotcom)! - A delivery whose step keeps failing for one workflow, such as one whose Entity resolver times out, no longer keeps the Event from the other workflows it concerns. Each workflow's steps are retried on their own, the other workflows are started, cancelled and woken on the first pass, and once the retries are spent the failing workflow alone is recorded: a `run_refused` or `cancel_not_delivered` audit row with `reason: "delivery_failed"`. The inbox row then settles `failed` with an error that counts the workflows the Event reached and names each one that failed, and a resend of its key delivers it again.

- [`9c5003e`](https://github.com/alandotcom/wfgraph/commit/9c5003ea7d82187a409729581d293d4b6a755cb6) Thanks [@alandotcom](https://github.com/alandotcom)! - A delivery now applies the Lifecycle Rules and wakes the Waits of the workflows an Event concerns side by side, up to ten workflows at once, so one workflow whose Entity resolver is slow no longer delays the others.

- [`0de04d1`](https://github.com/alandotcom/wfgraph/commit/0de04d1d31a000ef50459d5378a293a9fec56d2c) Thanks [@alandotcom](https://github.com/alandotcom)! - A Draft run now finds an earlier snapshot of the same graph by the graph's digest, through an index, instead of comparing its graph with every draft snapshot the workflow has.

- [`bce4adc`](https://github.com/alandotcom/wfgraph/commit/bce4adc2aab29c8f97348db0d06c38dd617de51f) Thanks [@alandotcom](https://github.com/alandotcom)! - `@wfgraph/core` and `@wfgraph/plugins` now depend on `effect` 4.1.3, and `@wfgraph/core` depends on `@effect/ai-openai`, `@effect/opentelemetry` and `@effect/sql-sqlite-node` 4.1.3. A host that installs its own copy of `effect` should move it to 4.1.3 so the host and Workflow Graph share one copy.

- [`e1375b6`](https://github.com/alandotcom/wfgraph/commit/e1375b675fcb773d23c8c289a72268779e18d0df) Thanks [@alandotcom](https://github.com/alandotcom)! - A missing or malformed `encryption.key` now names the function the host called: `createWfGraphRunner` and `wfWorker` refuse it in their own name, where both used to name `createWfGraphApp`.

- [`34cad05`](https://github.com/alandotcom/wfgraph/commit/34cad05152b403c3049fbd939b337542188abe67) Thanks [@alandotcom](https://github.com/alandotcom)! - A Migration that adds an Entity template to a node a run already passed, or removes one, no longer resolves that node's Entity again when the run resumes. The resolution was memoized under a step id that depended on whether the node read Entity fields, so the changed node was checked against current Entity State a second time and could end the run with an Exit claimed against a node that finished before the Migration. The step id is now the same either way.

- [`4cf1d65`](https://github.com/alandotcom/wfgraph/commit/4cf1d65afd410df2ac4b4e32a308d94979e1eb12) Thanks [@alandotcom](https://github.com/alandotcom)! - A resend of a failed Event delivery's key no longer wakes a run a second time. A delivery that fails for good now keeps its step memo, in a new `settled` schedule state, and the resend that reopens it answers every workflow the first delivery reached from that memo, including the Waits it woke, and retries only the workflows that failed, each with a full set of retries. Run the new PostgreSQL migration (`@wfgraph/core/migrate`) before deploying; SQLite migrates on open.

- [`5fd1a26`](https://github.com/alandotcom/wfgraph/commit/5fd1a269dc08038b52ff2c954c3e7e6718783fe3) Thanks [@alandotcom](https://github.com/alandotcom)! - A run whose pass is refused by a version fence, because a Migration moved it, now waits one second before its next pass instead of running again at once, so a refusal that keeps recurring cannot hold a worker in a tight loop. The refusal still counts as no failure.

- [`bd9e6fd`](https://github.com/alandotcom/wfgraph/commit/bd9e6fd33d67b7e28ecde1bb4242edd482e7a6f6) Thanks [@alandotcom](https://github.com/alandotcom)! - The worker loop's inbox poll stays fast behind a deep backlog of Events waiting for delivery. The executor now marks each inbox row it gives a delivery schedule row in a new nullable `scheduled_at` column, and the poll reads a partial index of unmarked pending rows alone, where it used to walk every pending row and look for its schedule row. Run the new PostgreSQL migration (`@wfgraph/core/migrate`) before deploying; SQLite migrates on open. A host's own `insert into workflow_event_inbox` naming its columns is unchanged and leaves the column to its default.

- [`4c2dda7`](https://github.com/alandotcom/wfgraph/commit/4c2dda7fe10bb50988c526664ad3b53332fee634) Thanks [@alandotcom](https://github.com/alandotcom)! - `integration.configOptions` now requires the `workflow.write` permission, the same as `action.configOptions`. Answering it resolves the connection's stored credentials, can refresh an OAuth grant, and calls the vendor with that grant, so a viewer holding only `connection.read` is refused with `403`. A custom policy that granted `connection.read` alone for this operation must grant `workflow.write` or name the operation ID.

- [`035bf1c`](https://github.com/alandotcom/wfgraph/commit/035bf1ca50e725f895e211ab33e4cc0a2dcfaff2) Thanks [@alandotcom](https://github.com/alandotcom)! - A connection test or a configuration-options request whose connection cannot be read from the database now answers `Failed to read integration` and logs the database error on the server. The answer used to carry the database driver's own message, which can include query text and bound values.

- [`2e205ad`](https://github.com/alandotcom/wfgraph/commit/2e205ad59ca3454244253f2a289cdfb3c44e4c90) Thanks [@alandotcom](https://github.com/alandotcom)! - On PostgreSQL, workers whose clocks disagree no longer take each other's live runs. Each worker measures how far its clock stands from the database's, and once that passes one second it writes and compares every lease on the database's clock. A cron schedule no longer fires a slot twice when a worker's clock steps backwards.

- [`c1f6af9`](https://github.com/alandotcom/wfgraph/commit/c1f6af949da369ba89b43f4e568fef57430d21a1) Thanks [@alandotcom](https://github.com/alandotcom)! - A worker that dies while a run's steps run side by side, or just after a step finished, now counts against the run's own retries. Before, the expired lease was charged to whichever parallel step started first, or to a step that had already succeeded, which counted it against nothing.

- [`0113604`](https://github.com/alandotcom/wfgraph/commit/0113604779b11e8fe4f5be622c67c8f8d6b6b20f) Thanks [@alandotcom](https://github.com/alandotcom)! - The `set_lifecycle_rules` result summary now names the Cancel Events, any Start or Cancel Filters, and the concurrency, beside the Start Events and schedules it already named.

- [`c8a67db`](https://github.com/alandotcom/wfgraph/commit/c8a67dba90810f61b7da36cc7d3a1c56d73d8dc3) Thanks [@alandotcom](https://github.com/alandotcom)! - A stale MCP write (`workflow_draft_stale`) now says whether the draft moved on since the client's revision or the client sent a revision ahead of the stored one, states that nothing was written, and names `read_workflow` as the read that recovers.

- [`4d089c9`](https://github.com/alandotcom/wfgraph/commit/4d089c93ed7a8023d1566666d55943472cd09592) Thanks [@alandotcom](https://github.com/alandotcom)! - Every MCP tool now carries a `title` and states all four behaviour hints. Read tools are read-only and idempotent, `delete_node` and `disconnect_nodes` are destructive, and every tool sets `openWorldHint: false`. Before this, an unset `destructiveHint` and `openWorldHint` read as destructive and open-world under the specification's defaults.

- [`deab0ab`](https://github.com/alandotcom/wfgraph/commit/deab0ab1083f88701ea61cbebd75fc430f37e1a5) Thanks [@alandotcom](https://github.com/alandotcom)! - The MCP tool list is about a fifth smaller. A subschema a tool's input repeats, such as the condition groups `set_lifecycle_rules` takes for Entity Eligibility, Start filters and Cancel filters, is listed once under `$defs` and referenced by `$ref`; output schemas carry no description annotations; and the default `additionalProperties: true` is left out. What each schema accepts is unchanged. A condition rule's `amount` is now listed as a finite number with its description.

- [`25a82c3`](https://github.com/alandotcom/wfgraph/commit/25a82c36a514efe6ec64aac183fcaa6702c3cf07) Thanks [@alandotcom](https://github.com/alandotcom)! - A run whose pinned workflow version no longer exists now ends canceled or exited when it holds a Cancel or Exit claim, with the timeline entry for that status. It used to be refused the `failed` status and stay in flight.

- [`d3a4863`](https://github.com/alandotcom/wfgraph/commit/d3a4863699f92d947c5e61d499b6af2cf494da72) Thanks [@alandotcom](https://github.com/alandotcom)! - The database executor writes fewer rows for each node a run passes. A node's run-log row is no longer opened and closed through memoized steps, so each action node stores one step memo row instead of three and updates the run's schedule row once instead of three times, and each Wait stores one memo row fewer. That leaves less dead-row churn for PostgreSQL to vacuum. A pass reads the run's log rows when it starts and writes nothing for a node it replays. A second `error` close of a node's log row now keeps the first error's message and duration, and no close overwrites a row closed as a success.

- [`f70e772`](https://github.com/alandotcom/wfgraph/commit/f70e7726ffbfd5de4de4b292837f612b992c0502) Thanks [@alandotcom](https://github.com/alandotcom)! - The page the OAuth callback serves when a connection cannot be completed is now sent as `text/html`. It was sent as `text/plain`, so the provider's popup showed the page's markup in place of the message and its Close button.

- [`4392ccf`](https://github.com/alandotcom/wfgraph/commit/4392ccfe5b42230e271e8b3c63df99ef6242557f) Thanks [@alandotcom](https://github.com/alandotcom)! - Reconnecting an OAuth connection no longer fails with "Integration configuration changed during OAuth callback" when a background token refresh ran while the operator was on the provider's consent page. The callback now claims the connection at the revision it reads, and still refuses a refresh, disconnect or second callback that runs between that read and its write.

- [`251cdba`](https://github.com/alandotcom/wfgraph/commit/251cdba59a7b51b7095f003f0c75a1ed533ae5d1) Thanks [@alandotcom](https://github.com/alandotcom)! - A run whose pass fails while it loads the run, such as on a stored graph that no longer parses or a read the database keeps failing, now ends `failed` after the same number of retries as any other failure outside a step. Each failed load releases the run after a backoff. Before, the run stayed leased until its lease expired and was retried forever.

- [`08a4ae3`](https://github.com/alandotcom/wfgraph/commit/08a4ae3cfbca5e66ec6efbde18b38e2a662256d4) Thanks [@alandotcom](https://github.com/alandotcom)! - Request bodies to the RPC, REST and `POST /api/integrations/oauth/start` routes are now capped at 8 MiB, enough for a 500-node workflow save. A larger body answers `413 Request body is too large` before any handler reads it. These routes used to read a body of any size into memory.

- [`6c9113b`](https://github.com/alandotcom/wfgraph/commit/6c9113b8da85bab5d8135f19c82250b6e802f664) Thanks [@alandotcom](https://github.com/alandotcom)! - A manual Run on a paused workflow now commits its ignored run and the run's `run_ignored` timeline entry in one transaction. A crash or a refused insert between the two writes used to leave an ignored run in the Runs view with no entry saying why it was ignored.

- [`aa62b3f`](https://github.com/alandotcom/wfgraph/commit/aa62b3f33930852cacdd3fdb083b95a2503b60c1) Thanks [@alandotcom](https://github.com/alandotcom)! - A paused workflow now stops new starts and nothing else. A Cancel Event still claims its runs in flight and an Event still wakes their Waits, where before a pause dropped both deliveries and the inbox row still settled as delivered. A start that arrives after the pause opens no run, even when its delivery was already under way when the workflow was paused.

- [`ff5445e`](https://github.com/alandotcom/wfgraph/commit/ff5445ef2024bd7d334084f193c4aaf17648e7e0) Thanks [@alandotcom](https://github.com/alandotcom)! - A resend that reopens a failed Event delivery no longer decides a refused start again. A start the first delivery refused through a Start Filter, first-wins Concurrency or a missing Entity Value is answered from its Refused Start row, so the resend cannot open a run the first delivery declined.

- [`0235369`](https://github.com/alandotcom/wfgraph/commit/0235369c94a1a694a537788f543a920c6cef1b32) Thanks [@alandotcom](https://github.com/alandotcom)! - The build agent's `revert_draft` now works in a turn that began on an empty workflow. It was refused with "Workflow must contain one Lifecycle Node", which left the half-built graph in place.

- [`3ac65ec`](https://github.com/alandotcom/wfgraph/commit/3ac65ec40eb0310dabbc6837b17780194660aa5e) Thanks [@alandotcom](https://github.com/alandotcom)! - A Condition node and an Event Split now decide their route once and keep it for the rest of the run. Each pass of a run replays the graph from the top, and the Condition used to evaluate its expression again on every pass, so a condition reading `now` (any "within the next N days" rule) could take the true branch, park on a Wait below it, and then take the false branch on the pass after the Wait, running the other branch and never reaching the nodes below the Wait. The decision is now stored as a durable step of the node, which adds one step memo row per Condition and Event Split node a run passes. When two nodes produce a field of the same name, the one later in the graph's node order now wins in a Condition, where the one that finished later used to.

- [`f944989`](https://github.com/alandotcom/wfgraph/commit/f9449898de1f2d25e51a23dd83caaad133c6283c) Thanks [@alandotcom](https://github.com/alandotcom)! - The request log record of a refused RPC call now masks an input field whose name marks it as a credential, such as the `token` of `workflow.resumeWait`, keeping its last four characters. The record used to print the token whole, and the token alone is enough to resume the Wait.

- [`981d8e9`](https://github.com/alandotcom/wfgraph/commit/981d8e9c16ebdeb8c00bd3655d41d732c2a7a504) Thanks [@alandotcom](https://github.com/alandotcom)! - The database now holds a run's `completed_at`, `waiting_at` and `cancelled_at` to its status on PostgreSQL and SQLite: `completed_at` is set exactly when the run has ended, `waiting_at` exactly while it waits, and `cancelled_at` exactly when it was canceled. The run-history retention sweep finds ended runs by `completed_at`, so an ended run missing it would never have been swept. A database holding a row that breaks one of these pairings fails the migration that adds them.

- [`1c97606`](https://github.com/alandotcom/wfgraph/commit/1c97606e78330a585a4db9ec55feff1f426e8208) Thanks [@alandotcom](https://github.com/alandotcom)! - On PostgreSQL, paging through the Runs view's list of runs across every workflow no longer skips a run that started in the same millisecond as the last run of the previous page. A run's start time is now written from the process clock at millisecond precision, the precision the page cursor carries, and a run's duration is measured on that same clock. One workflow's run list now orders runs that started in the same instant by id, as it already did on SQLite.

- [`4c74315`](https://github.com/alandotcom/wfgraph/commit/4c74315a42b9497670c87758f1218c953f92cf14) Thanks [@alandotcom](https://github.com/alandotcom)! - On PostgreSQL, the Runs view and the host health check read a run's lease on the same clock the executor keeps it on. A process whose clock runs ahead of the database's no longer shows a live run as Stalled, and the health check no longer counts its lease as due.

- [`c698e5a`](https://github.com/alandotcom/wfgraph/commit/c698e5a8140af1d9a1e6ef0e5eb540cf8cace907) Thanks [@alandotcom](https://github.com/alandotcom)! - A PostgreSQL migration replaces the index on `workflow_execution_schedule` that the executor uses to find expired leases. The index now covers the `id` of each leased row, and no index covers `lease_expires_at`, so PostgreSQL applies a running workflow's lease renewals as HOT updates. The executor's schedule table collects far fewer dead rows under load. Run the migration as you run any other Workflow Graph migration.

- [`d99d34f`](https://github.com/alandotcom/wfgraph/commit/d99d34ff4005de43a19099f4859940cdf7727b72) Thanks [@alandotcom](https://github.com/alandotcom)! - A connection update or saved-connection test that changes a `url` credential field, such as PostHog's API host, is now refused with `400` unless the same request supplies every stored `password` field again. A caller holding `connection.write` could otherwise point a stored secret at a host of their choosing, because the stored secret was reused. While an OAuth grant supplies the secret, the destination cannot change until OAuth is disconnected.

- [`186bdd3`](https://github.com/alandotcom/wfgraph/commit/186bdd3e9db99eb2001af17b7030f3b84043cfd1) Thanks [@alandotcom](https://github.com/alandotcom)! - The workflow-list and draft-revision subscriptions now share one database poller per process: one for the list and one for each subscribed workflow, started by the first subscriber and stopped after the last one leaves. Each open editor tab used to run its own pollers, each reading the whole workflow list every 500 ms.

- [`113ad30`](https://github.com/alandotcom/wfgraph/commit/113ad304b3c38d6ab14e3e18db1cdcff9e3df78b) Thanks [@alandotcom](https://github.com/alandotcom)! - A step that is still running when a step on another branch of the same run fails now records its result, so the retry does not run it again. Before, a Slack post that landed while a sibling lookup failed with a 502 was posted a second time on the retry.

  Stopping a run's pass, as `dispose()` does after its drain or a Worker tick does at its budget, now also stops the steps the pass is running: a step written as an Effect is interrupted, which aborts the request it has in flight. A step written as a plain Promise cannot be stopped, so its run is held back for one lease before another worker may claim it, and the step is never run twice at once.

- [`60adf39`](https://github.com/alandotcom/wfgraph/commit/60adf391d7cf3136256c02fabbd0b1424d1e4161) Thanks [@alandotcom](https://github.com/alandotcom)! - On SQLite, the event inbox retention sweep now reads its settled-row index. It used to scan and sort the whole inbox on every sweep while holding the database's write lock.

- [`19a6331`](https://github.com/alandotcom/wfgraph/commit/19a6331e25e19cf166e6f7aef29edb791a8d2730) Thanks [@alandotcom](https://github.com/alandotcom)! - A `step.run` name now lives in a namespace of its own, so an author's step can no longer share a durable id with one of the engine's steps for the same node. Before, a step named `"log-open"` could answer the `null` the engine stored for its run-log open and skip its work. Each named step is now memoized as `node:<nodeId>:step:<name>`, so a run that was in flight across the upgrade runs its completed `step.run` calls once more. `step.run` refuses an empty name and a name longer than 64 characters, failing the node with a message that names the action.

- [`ea9a266`](https://github.com/alandotcom/wfgraph/commit/ea9a26695324d14fdbc9d37a67591d8942874145) Thanks [@alandotcom](https://github.com/alandotcom)! - A durable step's answer is now held to `runner.maxStepValueBytes`, 1 MiB of JSON by default. A step that answers more fails its node at once, with no retry, and the node's error names the step and the size, never the value. Every pass of a run reads back every step's stored answer, so an unbounded answer made each pass of a long run slower.

- [`43a255f`](https://github.com/alandotcom/wfgraph/commit/43a255fbb846222f44edd1fd46361b5214c44eb7) Thanks [@alandotcom](https://github.com/alandotcom)! - The Runs view's count of superseded runs now stops at 1,001, and the panel reads a count above 1,000 as "More than 1,000 runs were superseded by newer starts". The count runs on every two-second poll, and it used to read every superseded run a newest-wins workflow had ever produced. On SQLite the count and the default run list now read partial indexes of their own, as they already did on PostgreSQL.

- [`430f180`](https://github.com/alandotcom/wfgraph/commit/430f180d8fccbdcce041af5909a02b3be1bbcb8b) Thanks [@alandotcom](https://github.com/alandotcom)! - A Wait whose park or resume is refused because a Migration moved the run to another Workflow Version now ends the pass quietly, and the next pass runs the version the run was moved to. The refusal used to be recorded as a failed node and logged as an unexpected node error and a fatal run error, while the other branches of the pass kept running.

- [`1320b27`](https://github.com/alandotcom/wfgraph/commit/1320b275d5695da6fa6c9119aec7036f4034e85d) Thanks [@alandotcom](https://github.com/alandotcom)! - A Wait that a Migration re-parks no longer records a false "Skipped delay branch" timeline entry. When the run's next pass resolved the Wait's first attempt again under the new Workflow Version, a delay that would now be past due or beyond its maximum lateness wrote a `run_skipped` entry and closed the Wait's run-log row as a skipped success, even though the run had already parked and went on to resume. Resolving an attempt now writes nothing, and only the attempt's own prepare step records a skip or an error.

- [`608b7d5`](https://github.com/alandotcom/wfgraph/commit/608b7d5b7602cc9e713da9cde59fced13a5d279e) Thanks [@alandotcom](https://github.com/alandotcom)! - Delivering an Event to a workflow with many runs parked on it no longer reads and sorts every parked run of that workflow for each page of 200. The index over a workflow's waiting rows now carries the row id, so each page starts where the last one ended, on PostgreSQL and on SQLite.

- [`34932a8`](https://github.com/alandotcom/wfgraph/commit/34932a8d4534f8b8740c90792646ecce3f397be3) Thanks [@alandotcom](https://github.com/alandotcom)! - On PostgreSQL, deleting a workflow while a worker is running one of its runs no longer fails with a deadlock. The delete now locks the runs' schedule rows and then the runs, in the order a worker's write takes them, and waits for the worker's write to commit.

- [`dbc1995`](https://github.com/alandotcom/wfgraph/commit/dbc1995c664d512853bdd78c84a064bb4169a6c0) Thanks [@alandotcom](https://github.com/alandotcom)! - Workflow names are now unique with their ASCII letters compared case-insensitively and every other character compared as written, on PostgreSQL as on SQLite. PostgreSQL used to fold letters by the database's own locale, so whether "Équipe" and "équipe" could coexist depended on how the database was created; they can now coexist on both backends.

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

- [`374b87e`](https://github.com/alandotcom/wfgraph/commit/374b87ec6daf686c6aae1bc315d8797ccae69c35) Thanks [@alandotcom](https://github.com/alandotcom)! - Workflow runs and Event deliveries now execute in your own process, on a worker loop that keeps its state in the `persistence` database. Inngest is no longer required.

  - **Runs.** `createWfGraphApp` starts the worker loop. Tune it with the `runner` option, or pass `runner: false` and run the loop in a separate process with `createWfGraphRunner` (PostgreSQL only).
  - **Events.** Every Event arrives in the `workflow_event_inbox` table, and the worker loop delivers it. Send one with `app.events.send({ name, data, id? })` (also on the runner), with `POST {basePath}/api/events` and an `Authorization: Bearer` key once you set `events: { key }`, through a Connection's webhook, or by inserting a row inside your own database transaction (the SQL contract in `docs/events.md`). `id` is the idempotency key. Settled rows are kept for `events.retentionMs`, seven days by default, which is also the deduplication window.
  - **Inngest is optional.** `inngest` is now an optional peer dependency. To keep `inngest.send`, install `inngest` and register `createWfGraphInngestFunctions({ client, app })` from the new `@wfgraph/core/inngest` entry with your own Inngest `serve` or `connect`. Each forwarder sends the Inngest event into the inbox through `app.events.send`.
  - **Removed.** The `inngest` option on `createWfGraphApp` and on the Worker entry's request config (so `WfGraphInngestConfig` is gone), the `/api/inngest` route, Workflow Graph's own Inngest client, Connect handling and signing-key checks, `defineEvent`'s `inngest` option, `workflowRunId` on execution records, and `runId` on a started run.
  - **Apply the migrations before you deploy.** This release adds tables the worker loop and the event inbox need. `wfPostgres` applies migrations at startup only when you set `migrations: { runOnStartup: true }`, which is off by default, so run `migrateWfGraphDatabase` from `@wfgraph/core/migrate` in CI or a release step first. A Worker never migrates on its own; run that same migration out of band before deploying it.
  - **Runs need a long-lived process.** The worker loop runs inside the process that called `createWfGraphApp`, so a host that scales to zero or freezes between requests advances no runs. Run the app in a long-lived process, or pass `runner: false` and run `createWfGraphRunner` in one.
  - **Dispose on shutdown.** Call `await app.dispose()` (or `runner.dispose()`) from your `SIGTERM` handler. It stops claiming runs and waits up to ten seconds for the runs in progress, so a deploy hands them back without spending a retry.
  - **Before you upgrade, drain in-flight runs.** A run Inngest was holding has no row for the worker loop to claim, so it never advances. Let each one finish, or cancel it, first.
  - **Cloudflare Workers.** `wfWorker` runs workflows on the same executor. Its default export gains a `scheduled` handler and a `queue` handler, each of which runs one tick that delivers due Events and advances due runs over Hyperdrive. The Cron Trigger is required: configure one that fires every minute, since its tick is what resumes a Wait at its deadline and recovers a run whose invocation ended early. A Queue is optional: pass a Queue producer binding as `wakeQueue` in `request(env)`, with the same Worker as its consumer, and a write that makes a run due starts a tick at once; without it, Events are delivered within a minute. `request(env)` also takes `events: { key, retentionMs }`, which mounts `POST {basePath}/api/events` on the Worker. See "Cloudflare Workers and Hyperdrive" in `docs/embedding.md`.

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

- [`169ecdb`](https://github.com/alandotcom/wfgraph/commit/169ecdbd88f98b2c9c571a667c41b080f448d36a) Thanks [@alandotcom](https://github.com/alandotcom)! - A workflow's Lifecycle Rules can hold cron schedules that start runs. Each schedule is a 5-field cron expression read in an IANA time zone, and a workflow can hold several. A workflow that tracks an Entity cannot have a schedule: the Lifecycle editor shows that refusal, and Publish refuses the workflow. Publish also refuses a schedule on a graph with an Event Split.

  Publishing a version that declares schedules writes one timer per schedule, due at the schedule's first time after the Publish. The database executor fires a timer when it falls due: it starts a run of the published version with no payload, as a manual run naming no Event would start, and moves the timer to the schedule's next time. A timer claimed late, such as after the workers were down, fires once, for the most recent time it missed. Concurrency treats every scheduled run as being about the workflow itself, so first-wins records a Refused Start for a fire while a run is going and newest-wins supersedes that run. Pausing a workflow deletes its timers and resuming writes them again, due at each schedule's first time after the resume, so a paused workflow skips the times it was paused through. Republishing keeps the timer of an unchanged schedule, and a draft never fires.

  The worker loop and a Worker's Cron Trigger tick claim timers in a lane of their own with one slot, so a host needs no new setting. On PostgreSQL that lane's pass shares the pool with the others, so a loop at its defaults can hold one more connection than before.

  A slot that does not run shows in the Runs view's Refused Starts. When the published version no longer passes the checks a run starts with, or a fire fails on every retry, the slot is skipped with a Refused Start written in the same transaction that moves the timer on, under the reasons `published_version_not_runnable` and `scheduled_start_failed`. A scheduled run's Refused Start names the slot's time in the schedule's zone, as in "Refused the 9:00 AM scheduled run: a run is still going and Concurrency is first-wins".

  Both run lists and a run's logs carry `scheduledFor`, the ISO timestamp of the time a scheduled run fired for, and `scheduleDescription`, the schedule that started it in words, such as "Every weekday at 9:00 AM (America/New_York)". Both are null for a run no schedule started.

  Migrations on both backends add `workflow_id`, `cron` and `time_zone` to `workflow_execution_schedule`, with a unique index on the three. They add the nullable `scheduled_for`, `schedule_cron` and `schedule_time_zone` to `workflow_executions`, which a fire writes with its slot and schedule, and a check holds `schedule_cron` and `schedule_time_zone` to both or neither, on a scheduled run alone.

  The Lifecycle editor gains a Schedule section. A Workflow Builder adds a schedule from a preset (Every hour, Every day at, Every weekday at, Every week on) or as a custom cron expression, and picks its time zone, which starts from the browser's own. Each schedule reads back as a sentence with its next three runs. Each schedule saves as it is edited. A schedule that cannot be saved, such as an invalid expression or a duplicate, stays in the section unsaved and keeps the version it last saved, and the Lifecycle warning names it. The Lifecycle summary lists each schedule with its next run, and the Lifecycle node on the canvas counts its schedules.

  The Runs view titles a scheduled run "Scheduled run" in the run list, the run's overview and the All Runs page, and shows the schedule's description as the line beneath the title, in a Schedule row of the overview, and under the workflow's name on the All Runs page. When a scheduled run started more than a minute after the time it was scheduled for, the overview shows a Scheduled row with that time above the Started row.

  The build agent's `set_lifecycle_rules` tool takes `schedules` for the complete set, or `addSchedules` and `removeSchedules` to change the stored ones. It refuses an invalid expression, an unknown time zone, a duplicate, or a schedule on a workflow that tracks an Entity, with the reason the Lifecycle editor shows.

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

- [#346](https://github.com/alandotcom/wfgraph/pull/346) [`e977201`](https://github.com/alandotcom/wfgraph/commit/e9772018c92e846df4869a02c2061fa9aec6e2df) Thanks [@alandotcom](https://github.com/alandotcom)! - Several run, connection and editor states that were spread across flags and separate writes now hold together.

  Every path that ends a run commits its timeline entry in the same transaction as the write that ends it: a traversal's terminal record, a run the executor fails outside any node or for a missing version, an operator cancel, and a supersede. A crash between the two writes used to leave an ended run with no `run_completed`, `run_failed`, `run_cancelled` or `run_superseded` entry. Because a supersede can no longer be half recorded, `failedToSupersede` is gone from the manual start response and from start, delivery and cron outcomes. A run ended by a cancel, a supersede or a direct terminal insert now records a duration, and the Runs view reads every unfinished node of an ended run as cut off, whatever the run ended in.

  A refresh claim on an OAuth connection is taken only from the state its caller read and is released back to that state, so a credential read that started before a connection was marked `reauthorization_required` can no longer return it to connected, and a reconnect that fails before its code exchange leaves it needing reauthorization. A Cancel Event now reaches its Entity's in-flight runs whatever the workflow's Published mode is now, so a run started in live mode is still cancelled after the workflow switches to test. This also lets a published workflow's Cancel Event reach Draft runs of that Entity, which it did not before. A delay Wait reads only the keys its declared timing owns, so a duration Wait no longer waits for a stale `waitUntil`.

  The run status `pending`, which no write stored, is removed from `WORKFLOW_EXECUTION_STATUSES`, and the run status in the logs summary and status poll contracts is typed by that list. Migrations on both backends add checks that tie each row's columns to its state: run, wait, node log and subscription vocabularies, run mode and start source on PostgreSQL as SQLite already had them, a schedule row's lease columns, a step memo's value and failure count, a wait row's wake, at most one wait row per Wait node in a run, a connection's refresh claim, and an OAuth attempt's mode and result. The version a workflow publishes can no longer be deleted while the workflow points at it. Every current writer satisfies these checks.

  In the editor, a save failure is reported once and stays on the workflow it happened on, an interrupted node drag ends and moves back, reopening a workflow shows an edit its save still carries, Run stays busy until a started run is read, an agent turn's graph lands on the Draft from any view, and the draft and workflow-list subscriptions reconnect after the server ends them normally.

- [#319](https://github.com/alandotcom/wfgraph/pull/319) [`32f61a8`](https://github.com/alandotcom/wfgraph/commit/32f61a86a573d75d1f0f5e21859e6e2196e5d5b1) Thanks [@alandotcom](https://github.com/alandotcom)! - Let host-defined actions supply schema-keyed `options` callbacks for dynamic pickers. Callbacks receive current draft selections, and the editor refreshes dependent choices and clears selections that are no longer available. Authored configuration fields remain available for presentation overrides. Config input and output reference fields can use `showWhen.in` to match any listed variant while preserving existing `equals` conditions.

- [#181](https://github.com/alandotcom/wfgraph/pull/181) [`cbd75a8`](https://github.com/alandotcom/wfgraph/commit/cbd75a8e57b27d242ffededcd1d866d92fa377f1) Thanks [@alandotcom](https://github.com/alandotcom)! - Integrations may declare Events and a Connection-addressed webhook. Resend ships all 19 official webhook event types. An integration-owned Start, Cancel, or Wait Event requires a Connection at Publish, and Publish checks that Connection exists and is the integration's own type, the same check an action's connection already got. Two integrations may not both claim one Event.

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

- [#332](https://github.com/alandotcom/wfgraph/pull/332) [`302e716`](https://github.com/alandotcom/wfgraph/commit/302e7164be4da4db3abd1d265bb101dfa2dd85da) Thanks [@alandotcom](https://github.com/alandotcom)! - Refresh every dependency to its newest release older than pnpm's one-day release-age gate.

  What an adopter installs changes: Effect and its four `@effect/*` packages move to 4.0.6,
  the six `@orpc` packages move to 2.0.0-beta.46, `@orpc/experimental-effect` is replaced by
  its renamed successor `@orpc/effect`, `@modelcontextprotocol/server` moves to 2.4.0, and
  `@wfgraph/plugins` now needs `@linear/sdk` 99. The `hono` and `inngest` peer ranges rise to
  `^4.13.14` and `^4.26.0`.

  `StepFailure` and the other `Schema.TaggedError` classes now carry a brand type argument,
  so a value that only resembles one of them structurally no longer type-checks where the
  class is expected.

  Effect 4.0.6 makes `Schema.toStandardSchemaV1` and `Schema.toStandardJSONSchemaV1` return
  a copy rather than assign onto the schema they are given. An Effect schema handed to
  `defineAction`, `defineEvent` or `defineEntity` is therefore left as the author wrote it,
  and one that was already bridged with parse options keeps them.

  The editor shows "Request failed" for a response that is not an oRPC response, such as a
  proxy's error page, where oRPC beta.46 would otherwise copy that page's body into the
  message.

  The OpenTelemetry API stays on 1.9 and the OpenTelemetry SDK on 2.x, because
  `@effect/opentelemetry` 4.0.6 caps the SDK below 3.0 and the 2.x SDK caps the API below
  1.10. `@types/node` stays on 24 to match the `engines` floor.

- [#214](https://github.com/alandotcom/wfgraph/pull/214) [`043c717`](https://github.com/alandotcom/wfgraph/commit/043c717823c64f30f5c3808823551e1122d37300) Thanks [@alandotcom](https://github.com/alandotcom)! - Refresh every dependency, including sixteen major upgrades.

  What an adopter installs changes: `@wfgraph/plugins` now needs `@clerk/backend`
  3 and `@linear/sdk` 92, `@wfgraph/core` and `@wfgraph/shared` need
  `@marcbachmann/cel-js` 8, `@wfgraph/shared` needs `@dagrejs/dagre` 3, and the
  `@orpc` 2.0 beta line moves to beta.32 across all six packages.
  `@wfgraph/core` and `@wfgraph/shared` install `uuid` 14, which took over from
  `nanoid` as the generator behind every id this repository mints. No exported
  API changed.

  Vitest 5 now runs the whole repository, as required by `@effect/vitest` rc.113.
  The private eval package replaced `vitest-evals`, whose peer range stops below
  Vitest 5, with an eval layer of its own.

  `@types/node` 26 remains held back because it is ahead of the Node 24 that the
  `engines` floor and CI both name. Typing against a newer runtime than the floor
  would compile code that fails on it.

- [#157](https://github.com/alandotcom/wfgraph/pull/157) [`dea6043`](https://github.com/alandotcom/wfgraph/commit/dea6043a2455cda99058ac23d6e4421751c1e606) Thanks [@alandotcom](https://github.com/alandotcom)! - Pick a Resend template from the connection instead of typing its id. The Send Email action's Template field lists the account's own templates, drafts labelled as such, and the Template Variables field draws one input per variable that template declares. A variable Resend has a fallback for is prefilled with it and left out of what is sent, so Resend applies it; a variable with no fallback is marked required, because Resend refuses the send without one.

  Reading templates needs Resend's full-access grant, which its own scope vocabulary offers nothing narrower than. A send-only connection says so in the field and keeps the plain id input, so nothing that worked before stops working.

  A provider may report a field as `required` on `ConfigOptionField`, which the editor draws as a required input.

  Fixes an OAuth adapter's granted-access label being able to fail a token refresh: `grantedAccessLabel` is what a dialog draws, so a scope the adapter cannot word now answers nothing rather than turning a working grant into one an operator has to reauthorize.

- [`0855976`](https://github.com/alandotcom/wfgraph/commit/085597604288e583e42219397121589ece258d74) Thanks [@alandotcom](https://github.com/alandotcom)! - Workflow Graph can delete old run history when a host asks. `runs: { retentionMs }` on `createWfGraphApp`, `createWfGraphRunner` and the `wfWorker` config sets how long an ended run is kept after it completed. Once an hour, in the same upkeep that sweeps the event inbox, the worker loop deletes ended Executions older than the window with their node logs, wait rows and timelines, then workflow audit rows that name no run, such as Refused Starts, then draft snapshots that no Execution references and no Draft run has pinned within the window. A Worker runs the sweep on its Cron Trigger tick. A run in flight is never deleted, and published versions always stay. A run that an Event's delivery opened, and a Refused Start recorded for a delivery, are kept while that delivery's inbox row exists, because a redelivered inbox row is answered from them and deleting either early would open a second run. The option is off by default, so a host that leaves it out keeps every run. Every sweep, the event inbox's included, deletes at most 500 rows per batch, down from 1,000 for the inbox, so one batch holds SQLite's single writer for about half as long. Startup refuses a `runs.retentionMs` that is not an integer from one hour to 100 years, and an `events.retentionMs` that is not a positive integer of at most 100 years. Migrations on both backends add a `last_pinned_at` column to `workflow_versions`, which records when a Draft run last pinned a snapshot, and partial indexes on `workflow_executions.completed_at` and on draft snapshots' `last_pinned_at`. On SQLite they also add indexes on `workflow_executions.workflow_version_id` and `workflows.published_version_id`, which serve the sweep and the deletes it cascades into.

  The editor states the window so a builder knows why old runs are gone: a workflow's Runs list and the All Runs list read "Runs are deleted 30 days after they finish." for a 30-day window, and say nothing when the host keeps every run. `getExecutions` and `getExecutionsGlobal` carry the window as `runRetentionMs`, null when unset, so the client and core must be on the same version.

- [`ab62482`](https://github.com/alandotcom/wfgraph/commit/ab62482e3d11e55a5bc15edce572bdb097f5227b) Thanks [@alandotcom](https://github.com/alandotcom)! - The Runs view says what the database executor is doing about a run in progress. The run overview names the worker running a step, a step's next try ("Retrying “Send reminder” at 11:40:34, try 3 of 5"), a run whose worker stopped renewing its lease, a run no worker has claimed past the host's stall threshold, and a run resuming from an Event, a resume or a deadline, with the raw schedule fields under "Executor details". A retrying node reads "Retrying" on the canvas and in the run's node journey, its evidence names the next try, and both run lists say when a run is retrying, stalled or unclaimed. Each node log keeps its retry count after the run ends, so a finished node reads "Succeeded on try 3".

  `getExecutionLogs`, `getExecutions`, `getExecutionsGlobal` and `getExecutionStatus` carry the new fields, and the client and core must be on the same version. Two migrations add `retries` to the node log, the running node to the schedule row, the node id to each step memo row, and a unique index on one log row per run and node. A run that finishes on SQLite now stores its duration as whole milliseconds, so the run history reads "55.05s" in place of "55051.0".

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

- [#335](https://github.com/alandotcom/wfgraph/pull/335) [`cd047fc`](https://github.com/alandotcom/wfgraph/commit/cd047fc411c364a8aaad62ee00fc08e413525955) Thanks [@alandotcom](https://github.com/alandotcom)! - An RPC procedure now stops when its client aborts the request. The request's abort signal used to reach only the streaming procedures, so an aborted unary call kept running to completion.

  The start-up notice about logging now also appears when a host configured LogTape without a sink that receives the `wfgraph` category. It used to check only whether any configuration was installed, so a host that configured LogTape for its own categories alone lost every Workflow Graph record without a word.

  A bigint in a log message now renders as its digits. `JSON.stringify` threw on one, which broke the pretty console formatter and the `logger` bridge. Each LogTape meta logger record is also delivered once; it used to reach the sink twice.

  Closing the last overlay in the editor now plays its exit animation.

- [`807145b`](https://github.com/alandotcom/wfgraph/commit/807145b543fe5563175a5e6d0975b3ec8c862c81) Thanks [@alandotcom](https://github.com/alandotcom)! - `@wfgraph/core` ships a new Agent Skill, `wfgraph-core/auth`, for writing the `auth` access policy: mapping host sessions to the viewer, editor and admin role policies, building a custom policy from the host's own grants with `WfGraphAccess.fromPermissions`, choosing `trustWfGraphUpstream()`, and reading the `401`, `403` and `500` answers. The wfgraph-core skill now routes there for policy guidance, and it states that a JavaScript host that omits `auth` still starts and answers `500` to every operator request.

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

- [`84c2f6d`](https://github.com/alandotcom/wfgraph/commit/84c2f6df5de1cd78886fbddf2cbeaeee0ed83321) Thanks [@alandotcom](https://github.com/alandotcom)! - `@wfgraph/core` ships a new Agent Skill, `wfgraph-core/cloudflare-worker`, for deploying Workflow Graph on a Cloudflare Worker: the `wfWorker` entry, the Cron Trigger and the optional wake Queue, Hyperdrive with query caching disabled and the origin role's `search_path`, migrations outside the Worker, and the tick limits and records. The Worker guidance and its two mistakes move there from the wfgraph-core skill, which keeps one routing line.

- [#324](https://github.com/alandotcom/wfgraph/pull/324) [`8455565`](https://github.com/alandotcom/wfgraph/commit/845556529604ebc381ffb45c651f6937693a9b46) Thanks [@alandotcom](https://github.com/alandotcom)! - Preserve results for nodes with prototype-sensitive IDs so failed actions cannot be reported as successful runs.

- [#324](https://github.com/alandotcom/wfgraph/pull/324) [`8455565`](https://github.com/alandotcom/wfgraph/commit/845556529604ebc381ffb45c651f6937693a9b46) Thanks [@alandotcom](https://github.com/alandotcom)! - Refuse an execution migration when its parked Waits have changed since eligibility was checked. Serialize PostgreSQL repark writes with migration so an old-version park cannot overwrite the migrated state.

- [#299](https://github.com/alandotcom/wfgraph/pull/299) [`69833ca`](https://github.com/alandotcom/wfgraph/commit/69833caa4cb8b3bdd62ba808eb4c480f96d01a51) Thanks [@alandotcom](https://github.com/alandotcom)! - `app.dispose()` now finishes promptly after a run whose action steps ran in parallel. Before this change it never finished once a fan-out or the two arms of a join had run in the process.

  In async step mode, Inngest never settles the `step.run` promise of a step it planned in parallel, so the invocation that planned the steps stays parked. Every action ran inside an uninterruptible Effect region that included that wait, and disposal waits for every fiber the app runtime started, so the parked invocation held disposal open forever. The region is gone. Disposal now interrupts a parked invocation at once, and it waits only for step bodies Inngest has started, so persistence stays open until those bodies finish.

- [#331](https://github.com/alandotcom/wfgraph/pull/331) [`317942b`](https://github.com/alandotcom/wfgraph/commit/317942b5a4c05030aad315db43ac557cfe2e46f8) Thanks [@alandotcom](https://github.com/alandotcom)! - Update drizzle-orm and drizzle-kit from 1.0.0-rc.4 to 1.0.0-rc.5.

  rc5 ships the `Schema.TaggedError` fix that the local drizzle-orm patch carried, so the patch is gone. The postgres-js driver now serializes JSON parameters itself, so the two Wait-state metadata merges pass their objects as parameters where they previously passed a `JSON.stringify` result. The PostgreSQL migration snapshots are rewritten in drizzle-kit's incremental format; the migration SQL and journal hashes are unchanged.

- [#337](https://github.com/alandotcom/wfgraph/pull/337) [`ae8c958`](https://github.com/alandotcom/wfgraph/commit/ae8c958feb9fe709a73f66df630a5fd91cc9a3cd) Thanks [@alandotcom](https://github.com/alandotcom)! - `callExternal` now reads a `Retry-After` header given as an HTTP date as well as one given in seconds. `ExternalRejected.retryAfterSeconds` carries the wait measured from when the refusal arrived, so a date-form value can hold a fraction. A digit string too long to be a number now counts as a wait past the ceiling, so a 429 that carries one ends on its first attempt.

  A duration written as a bare `P` or `PT` is now refused. It used to read as zero, so a Wait or an Event duration field holding one passed validation and waited for nothing. ISO 8601 durations are now parsed by Effect's `Duration.fromIso`.

- [#328](https://github.com/alandotcom/wfgraph/pull/328) [`cc4bb96`](https://github.com/alandotcom/wfgraph/commit/cc4bb967c38ed16b85dc24680a1f01c11875c7a1) Thanks [@alandotcom](https://github.com/alandotcom)! - Update the Effect v4 dependency set to the 4.0.0 stable release and import the AI and HTTP modules from `effect/ai` and `effect/http`, the paths that replace `effect/unstable/*`.

- [#330](https://github.com/alandotcom/wfgraph/pull/330) [`7f2ea9e`](https://github.com/alandotcom/wfgraph/commit/7f2ea9ef20ce957d39c17db135db9dced5f71202) Thanks [@alandotcom](https://github.com/alandotcom)! - Update Effect and its companion packages from 4.0.2 to 4.0.4.

- [#234](https://github.com/alandotcom/wfgraph/pull/234) [`a55f793`](https://github.com/alandotcom/wfgraph/commit/a55f7932f8b896701cc1d5fd923e316f0f9d5d48) Thanks [@alandotcom](https://github.com/alandotcom)! - Bump the Effect v4 release candidate from 4.0.0-rc.111 to 4.0.0-rc.113, along with `@effect/vitest`, `@effect/opentelemetry`, `@effect/sql-sqlite-node` and `@effect/ai-openai`, which each name that exact core version as a peer.

  The release adds a `StandardSchema` module to `effect`, holding the Standard Schema specification's type declarations vendored from `@standard-schema/spec`. `@wfgraph/shared`'s `toStandardSchema` stays the bridge this repo crosses, because it bakes in the decode options a wire schema needs.

  The build agent now uses Effect AI's renamed Chat type and opaque streamed tool parameters. Linear error decoding uses open schemas after Effect removed the decode option that preserved excess properties. The whole repository, the private eval harness included, now runs on Vitest 5 as required by `@effect/vitest`. The eval harness replaced `vitest-evals`, which supports Vitest 4 only, with an eval layer of its own.

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

- [#339](https://github.com/alandotcom/wfgraph/pull/339) [`132efe2`](https://github.com/alandotcom/wfgraph/commit/132efe204c0b60f52eb16a7d58194c36c0d748fa) Thanks [@alandotcom](https://github.com/alandotcom)! - The MCP endpoint reads and parses each request body once, and builds its tool schemas once per process rather than on every request. A tool call whose arguments hold more than 10,000 array elements and object members is now refused as a tool error before validation.

- [#325](https://github.com/alandotcom/wfgraph/pull/325) [`2d818fc`](https://github.com/alandotcom/wfgraph/commit/2d818fc66e67a8578d630b93e3f4041503b52ef3) Thanks [@alandotcom](https://github.com/alandotcom)! - Keep Event delivery aimed at the same Wait when migration rotates its token, after rechecking the current subscription. Preserve a failed delivery's recorded arrival while that delivery retries.

- [#324](https://github.com/alandotcom/wfgraph/pull/324) [`8455565`](https://github.com/alandotcom/wfgraph/commit/845556529604ebc381ffb45c651f6937693a9b46) Thanks [@alandotcom](https://github.com/alandotcom)! - Retry failed Event wake deliveries against saved Wait candidates. Candidate pages are captured before delivery, so a retry cannot wake a later Wait reached by an already-resumed branch.

- [#173](https://github.com/alandotcom/wfgraph/pull/173) [`c39f584`](https://github.com/alandotcom/wfgraph/commit/c39f5844e816bd1a5014c9ec61bd13cea824285e) Thanks [@alandotcom](https://github.com/alandotcom)! - Treat a missing node `enabled` flag as on, so toggling a step off and back on is not a draft change.

- [`48c5c11`](https://github.com/alandotcom/wfgraph/commit/48c5c11cacd00ba8c5cab433542777a5e80ccdfe) Thanks [@alandotcom](https://github.com/alandotcom)! - `@wfgraph/core` ships a new Agent Skill, `wfgraph-core/observability`, for sending Workflow Graph's logs and traces to the host's own tools: choosing between `configureWfGraphLogging()`, the `logger` option and a LogTape sink for the `wfgraph` category, registering an OpenTelemetry tracer provider or initialising Sentry, and building dashboards on the stable span names. The wfgraph-core skill keeps the one-line console setup and routes the rest there.

- [`06e3e41`](https://github.com/alandotcom/wfgraph/commit/06e3e41d6a273fe80b89fc66a638a54bcdffe1c2) Thanks [@alandotcom](https://github.com/alandotcom)! - Update the six `@orpc` packages from 2.0.0-beta.47 to 2.0.0-beta.48. The editor bundle and the server move together, so their oRPC contract still matches. The REST routes now resolve through oRPC's new OpenAPI router. Where a literal path segment and a parameter overlap, as `/workflows/current` and `/workflows/{workflowId}` do, the literal route answers, which is how those routes already resolved.

- [#325](https://github.com/alandotcom/wfgraph/pull/325) [`2d818fc`](https://github.com/alandotcom/wfgraph/commit/2d818fc66e67a8578d630b93e3f4041503b52ef3) Thanks [@alandotcom](https://github.com/alandotcom)! - Restore completed child-node outputs and failures from execution logs before routing a canceled run through its Canceled outlet.

- [`3672d86`](https://github.com/alandotcom/wfgraph/commit/3672d864c36ebf30ff7fe1c35c8aa38fa1c288f6) Thanks [@alandotcom](https://github.com/alandotcom)! - The PostgreSQL backends (`@wfgraph/core/postgres`, the Hyperdrive backend in `@wfgraph/core/worker`, and `@wfgraph/core/migrate`) now run on `postgres` (Postgres.js) `^4.1.0`, up from `^3.4.9`. Workflow Graph's queries go through Drizzle, which keeps reading and writing its `timestamp` columns as UTC, so stored runs, versions and waits read back unchanged. A transaction the server answers with `ROLLBACK` at `COMMIT` now rejects instead of resolving. Postgres.js now reads the `PGSSLMODE` environment variable, which 3.x ignored: a host that sets it to `require`, `verify-ca` or `verify-full` now connects over TLS and fails against a server without it, while an `ssl` option or an `sslmode` in the connection URL still takes precedence. The startup log line leaves out the database and user fields when Postgres.js has no string for them, which happens only for a user given as a function.

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

- [`f08fc8b`](https://github.com/alandotcom/wfgraph/commit/f08fc8b0e728814929ed25427af097c745531af0) Thanks [@alandotcom](https://github.com/alandotcom)! - Take the latest minor and patch releases of the runtime dependencies. `@wfgraph/core` now needs `@hono/node-server` `^2.1.6` and `@opentelemetry/semantic-conventions` `^1.44.0`, and its `hono` peer range rises to `^4.13.16` and its optional `inngest` peer range to `^4.26.2`. `@wfgraph/plugins` now needs `@clerk/backend` `^3.27.0`. The editor bundle in `@wfgraph/client` carries `@tanstack/react-query` 5.106.1, `@xyflow/react` 12.12.1, `lucide-react` 1.69.0 and `motion` 14.9.1.

- [#334](https://github.com/alandotcom/wfgraph/pull/334) [`c1db2c6`](https://github.com/alandotcom/wfgraph/commit/c1db2c683b03b3a45aa12da26aa92b7163a68f68) Thanks [@alandotcom](https://github.com/alandotcom)! - Update Effect and its four `@effect/*` packages from 4.0.6 to 4.1.0, and the six `@orpc` packages from 2.0.0-beta.46 to 2.0.0-beta.47. The `inngest` peer range rises to `^4.26.1`, and `@wfgraph/plugins` now needs `@clerk/backend` `^3.26.4`.

  None of Effect 4.1's breaking changes reach an API Workflow Graph calls.

- [#181](https://github.com/alandotcom/wfgraph/pull/181) [`cbd75a8`](https://github.com/alandotcom/wfgraph/commit/cbd75a8e57b27d242ffededcd1d866d92fa377f1) Thanks [@alandotcom](https://github.com/alandotcom)! - Resume matching Event Waits across live and test runs, including sibling Waits after another branch resumes.

- [#211](https://github.com/alandotcom/wfgraph/pull/211) [`92baf20`](https://github.com/alandotcom/wfgraph/commit/92baf20cf4fb3e8f35495c139e5c4f38ea173b1f) Thanks [@alandotcom](https://github.com/alandotcom)! - Bound agent discovery results and reject unsafe workflow edits before mutation.

- [#178](https://github.com/alandotcom/wfgraph/pull/178) [`bcd0601`](https://github.com/alandotcom/wfgraph/commit/bcd0601e69745956aa1a17ddabf0304b2ebb2410) Thanks [@alandotcom](https://github.com/alandotcom)! - A start that PostgreSQL aborted for a serialization conflict is retried again, rather than failing its node.

  `startForEntity` opens a run inside a SERIALIZABLE transaction, because the in-flight read and the insert have to be one decision. PostgreSQL answers two starts that race for the same entity by aborting one with SQLSTATE 40001, which the repository is meant to retry. Two things stopped that working.

  The check that recognised the abort read `error.cause` alone. Drizzle wraps a driver failure in a `DrizzleQueryError` carrying the SQL it ran, so the `PostgresError` holding the code sits one level further down and was never found. Every aborted start surfaced as a database failure. The check now walks the cause chain, and an unrelated code is still reported rather than retried.

  The retries then ran with no delay between them, so racers that aborted together retried together and spent their attempts on the same conflict. They now back off with jitter, and the budget goes from three retries to five. Measured against PostgreSQL 17 with six connections starting one entity under `newest-wins`, that moves a consistent failure to none.

  This only ever affected PostgreSQL under concurrent starts for one entity value. SQLite serializes writes with `BEGIN IMMEDIATE` and raises no such code.

- [`b31a9ce`](https://github.com/alandotcom/wfgraph/commit/b31a9ce30b8f4df6c558dc2101a9b869b037482e) Thanks [@alandotcom](https://github.com/alandotcom)! - Each Agent Skill in `@wfgraph/core` and `@wfgraph/plugins` now has a `description` that says when a coding agent should load it, including requests that name no Workflow Graph API, and which skill to load for the neighboring task. The previous description text moves unchanged to `metadata.purpose`. The guidance in each skill is unchanged.

- [`d4527c3`](https://github.com/alandotcom/wfgraph/commit/d4527c3c3fcefe7ed710ed5d713495067b2ee6f5) Thanks [@alandotcom](https://github.com/alandotcom)! - Update the remaining runtime, integration, UI, and development dependencies. Raise the supported Hono and Inngest peer ranges to match the tested releases.

- [#326](https://github.com/alandotcom/wfgraph/pull/326) [`533a5f3`](https://github.com/alandotcom/wfgraph/commit/533a5f3a1f0d3b1454e6cc969d6a7199d5532084) Thanks [@alandotcom](https://github.com/alandotcom)! - Refresh inherited branch outputs after migration so references introduced by the new workflow version can use outputs completed by another branch while the run was parked.

- [`d5d271f`](https://github.com/alandotcom/wfgraph/commit/d5d271fd3e70886a5db62e9f3577d5765c5ea13c) Thanks [@alandotcom](https://github.com/alandotcom)! - Update Effect to 4.0.2, oRPC to 2.0.0-beta.43, and TanStack dependencies to their current releases.

  Generated OpenAPI documents now use OpenAPI 3.2. Effect's AI spans use the updated OpenTelemetry GenAI attribute names, including `gen_ai.provider.name`.

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

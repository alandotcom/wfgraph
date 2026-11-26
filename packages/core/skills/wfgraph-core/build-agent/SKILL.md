---
name: build-agent
description: >
  Use when turning on or configuring the Workflow Graph editor's chat agent,
  the build agent, in a host application: setting the agent option of
  createWfGraphApp or wfWorker with wfOpenAi, wfAnthropic, wfOpenRouter or
  wfOpenAiCompatible and their apiKey, model, reasoningEffort and baseUrl,
  limiting maxConcurrentTurns, running turns on the host's own gateway
  or model with agent.runner and streamAgentTurn, granting agent.use and the
  operations the agent's tools check, or explaining why the agent's prompt
  line is missing from the editor, why the agent option is refused, or why a
  tool call is refused. Also use for requests such as "add AI to the workflow
  editor with our Anthropic key", "send the workflow agent through our LLM
  gateway" or "the agent chat does not appear in the editor". For an external
  MCP client use wfgraph-core/mcp; for roles and custom grants in general use
  wfgraph-core/auth.
metadata:
  purpose: >
    Configure the editor's build agent: the four provider entries and their
    defaults, gateways through baseUrl, a host runner through
    agent.runner and streamAgentTurn, the turn limit, and the grants a turn's
    tools check.
  type: sub-skill
  library: wfgraph
  library_version: "4.1.1"
requires:
  - wfgraph-core
sources:
  - alandotcom/wfgraph:docs/embedding.md
  - alandotcom/wfgraph:packages/core/src/backend/agent/config.ts
  - alandotcom/wfgraph:packages/core/src/backend/agent/providers/openai.ts
  - alandotcom/wfgraph:packages/core/src/backend/agent/providers/anthropic.ts
  - alandotcom/wfgraph:packages/core/src/backend/agent/providers/openrouter.ts
  - alandotcom/wfgraph:packages/core/src/backend/agent/providers/openai-compatible.ts
  - alandotcom/wfgraph:packages/core/src/backend/agent/runner.ts
  - alandotcom/wfgraph:packages/agent/src/tools/test-run-behavior.ts
---

This skill builds on wfgraph-core. Copy the provider table and the runner
example from `docs/embedding.md` ("The build agent" and "Run turns on your own
gateway or model").

# The build agent

The editor's build agent is a chat that reads the host's catalog and edits the
open workflow's draft. A person types to it in a prompt line at the bottom of
the canvas, and its conversation opens above that line. It is off until `agent`
turns it on, and the editor then shows no prompt line. A turn runs on the
server, in the process that serves the request, and the server stores nothing
about a conversation: the browser sends the history with each message and
keeps the thread in its own storage.

## Procedure

1. **Pick the provider entry.** Each provider has its own entry, and `agent`
   takes what its function returns. There is no `provider` key: a plain
   object of `apiKey` and `model` is refused wherever `agent` is read.

   | Entry and function                                      | Turned on by | `model`                     | Note                                                                 |
   | ------------------------------------------------------- | ------------ | --------------------------- | -------------------------------------------------------------------- |
   | `wfOpenAi`, `@wfgraph/core/openai`                      | `apiKey`     | Defaults to `gpt-6.1-terra` | `gpt-6-luna` is the lowest cost per turn and passes fewer eval runs  |
   | `wfAnthropic`, `@wfgraph/core/anthropic`                | `apiKey`     | Required                    | A Claude model of the 4.6 generation or later, for adaptive thinking |
   | `wfOpenRouter`, `@wfgraph/core/openrouter`              | `apiKey`     | Required                    | An OpenRouter model id                                               |
   | `wfOpenAiCompatible`, `@wfgraph/core/openai-compatible` | `baseUrl`    | Required                    | `apiKey` is optional and sent as a bearer token when set             |

   Result: `GET {basePath}/api/extensions` answers `agent: { enabled: true }`
   for a signed-in session, and the editor shows the prompt line.

2. **Read the key from the environment.** A blank or absent `apiKey` leaves
   the agent off without an error, and so does a blank `baseUrl` for
   `wfOpenAiCompatible`. A key with a blank `model` for a provider that has no
   default throws where the host calls the function. Result: the call either
   returns a value that turns the agent on, or throws a message saying the
   function needs a non-blank `model`.
3. **Put a gateway in front only if it speaks the provider's API.** A
   `baseUrl` for `wfOpenAi` must serve `POST {baseUrl}/responses`, OpenAI's
   Responses API. A gateway that serves Chat Completions alone, as most
   self-hosted model servers do, takes `wfOpenAiCompatible`. Every request streams
   with function tools, so the gateway must pass server-sent events and a
   `tools` array through, and for OpenAI the `prompt_cache_key` and
   `store: false` fields. Result: a turn streams text into the conversation
   and its tool calls draw on the canvas.
4. **Or run turns yourself.** `agent: { runner }` takes a
   `WfGraphAgentRunner` whose `run` receives a `WfGraphAgentTurn` and answers
   an Effect `Stream` of the parts the conversation renders.
   `streamAgentTurn(turn, model)` runs the built-in loop on a `LanguageModel` layer the host builds,
   which covers any gateway the provider table does not. `maxConcurrentTurns`
   is the one field beside `runner`. Result: the turn's log record names the
   runner's `provider` and `model`.
5. **Grant the turn's tools.** `agent.chat` needs `agent.use`. Each tool the
   model calls also checks what the MCP endpoint checks: `workflow.getById`
   for every tool, `workflow.update` for a write, `integration.getAll` for
   `list_integrations`, and the run tools' own operations. A missing grant
   answers the model a refusal rather than failing the turn. Result:
   `WfGraphRoles.editor` reaches every tool, and under a policy granting
   `agent.use` alone every tool call in a turn is refused.
6. **Size the turn limit.** `maxConcurrentTurns`, an option of every provider
   function and of the runner form, caps how many turns one process streams
   at once, across every person using the editor. It defaults to 4. A value
   that is not a positive integer throws where the host calls a provider
   function, naming the function, and wherever a runner form's `agent` is
   read, naming `agent.maxConcurrentTurns`.
   A turn past the limit is refused with a message asking the person to wait.

## Core Patterns

### What a turn costs and logs

Each turn ends with a `usage` part counting its model calls, tool calls, and
input, cached input, output and reasoning tokens. The conversation prints it
under the turn, and the "Agent turn finished" record carries the same counts,
`usage.cachedInputTokens` included. Requests are cached per workflow: OpenAI
and OpenRouter requests carry `prompt_cache_key: "wfgraph-agent:<workflowId>"`,
an Anthropic request asks for automatic prompt caching, and an OpenAI request
sets `store: false`, so the provider keeps no copy of the turn.

### Reasoning effort

`reasoningEffort` defaults to `medium` for `wfOpenAi` and `high` for
`wfAnthropic`, and is sent by `wfOpenRouter` and `wfOpenAiCompatible` only when set. OpenAI takes
`none`, `low`, `medium`, `high`, `xhigh` and `max`; `minimal` is refused by the
type and by every GPT-6 model. Anthropic takes `low` to `max`. Lowering the
Anthropic effort below `high` makes the agent skip the validation and
reference reads its rules ask for; the eval suite measured `claude-sonnet-5-5`
at `high`.

### A runner's stream

Workflow Graph reads the turn's draft after each successful write tool result
and sends the editor the `graph` part itself; a `graph` part a runner sends is
dropped. A stream that fails reaches the conversation as one `error` part
carrying the failure's message. A runner may emit a `usage` part of its own, which is
added to the turn's counts. The toolkit on the turn is the only way a turn
changes the workflow, and it validates each edit against the catalog and the
Connections as it does for the built-in agent.

The turn's `selectedNodes` are the steps the person attached to the newest
message, which the editor's canvas selection does not change. Each carries its
`id`, its `label` and, for a numbered step, the `stepNumber` the editor's
outline prints; the Lifecycle Node and a Group carry none. A person says
"step 7" for that number, and an edit can renumber the steps. The turn's
`prompt` already names those steps under the newest message, so a runner that
builds its own prompt from `messages` names them itself.

### Test runs from the chat

`start_test_run` starts a Draft run of the saved draft, which calls every
action handler it reaches with `runMode: "test"`. In the editor it refuses
once the turn has edited the draft, because the editor saves those edits only
when the turn ends. The agent answers what a test run does at a step from the
`testRun` sentence `read_workflow` gives each action step. For a host action
that sentence says the handler decides, so the agent cannot promise that a
Draft run sends nothing; the `runMode` check is wfgraph-core/host-actions.

## Common Mistakes

### HIGH Anthropic or OpenRouter with no model

Wrong: `agent: wfAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY, model: "" })`,
or a model read from an unset variable.

Correct: name the model, such as `model: "claude-sonnet-5-5"`, the Claude model
the eval suite has measured.

`wfAnthropic` throws `wfAnthropic needs a non-blank model, because its
provider has no default model.` Only `wfOpenAi` has a default model.

Source: alandotcom/wfgraph:docs/embedding.md (The build agent)

### HIGH A Chat Completions gateway under wfOpenAi

Wrong: `agent: wfOpenAi({ apiKey, baseUrl: "http://llm-gateway.internal/v1" })`
for a gateway that serves `/chat/completions` alone.

Correct: `wfOpenAiCompatible` from `@wfgraph/core/openai-compatible`, with that
`baseUrl` and a `model`.

`wfOpenAi` calls `POST {baseUrl}/responses`, so every turn fails at the
gateway.

Source: alandotcom/wfgraph:docs/embedding.md (The build agent)

### HIGH The agent option as a plain object

Wrong: `agent: { provider: "anthropic", apiKey, model }` or
`agent: { apiKey: process.env.OPENAI_API_KEY }`.

Correct: `agent: wfAnthropic({ apiKey, model })` from `@wfgraph/core/anthropic`,
or `wfOpenAi` from `@wfgraph/core/openai`.

The `agent` option takes what a provider function returns, or `{ runner }`.
A plain object fails to type-check. From JavaScript, `createWfGraphApp`
throws `agent takes what a provider function returns` when it is called.
`wfWorker` reads `agent` from its `request` callback on each invocation, so
it builds without complaint and then throws the same message on every
request and every tick.

Source: alandotcom/wfgraph:docs/embedding.md (The build agent)

### MEDIUM An unset variable read as a startup check

Wrong: rely on `apiKey: process.env.ANTHROPIC_API_KEY` to stop a deployment
that forgot the variable.

Correct: check the variable in the host's own startup, or assert
`agent.enabled` in `GET /api/extensions` after a deploy.

A blank key turns the agent off without an error, so the editor simply loses
its prompt line.

Source: alandotcom/wfgraph:docs/embedding.md (The build agent)

### MEDIUM A runner that draws the canvas itself

Wrong: a runner that emits `graph` parts after its own tool calls.

Correct: call the turn's `toolkit` and let Workflow Graph send the `graph`
part after each successful write.

A runner's `graph` part is dropped, so the canvas shows only what the toolkit
wrote.

Source: alandotcom/wfgraph:docs/embedding.md (Run turns on your own gateway or model)

## Completion

The agent is configured when these hold:

- `GET /api/extensions` for an editor's session answers
  `agent: { enabled: true }`, and the editor shows the agent's prompt line.
- A turn that asks for one step adds it to the canvas, and the conversation
  prints a usage line under the turn.
- A session without `agent.use` is refused `agent.chat` with `403`.

`packages/evals/src/skills/build-agent/agent-config.test.ts` in the Workflow
Graph repository asserts the refusals and `agent.enabled` outcomes for the
provider functions and the runner form; a turn against a live model is not
part of it.

---
name: build-agent
description: >
  Use when turning on or configuring the Workflow Graph editor's chat agent,
  the build agent, in a host application: setting the agent option of
  createWfGraphApp or wfWorker for OpenAI, Anthropic, OpenRouter or an
  OpenAI-compatible server with apiKey, model, reasoningEffort and baseUrl,
  limiting agent.maxConcurrentTurns, running turns on the host's own gateway
  or model with agent.runner and streamAgentTurn, granting agent.use and the
  operations the agent's tools check, or explaining why the chat panel is
  missing, why startup refuses the agent option, or why a tool call is
  refused. Also use for requests such as "add AI to the workflow editor with
  our Anthropic key", "send the workflow agent through our LLM gateway" or
  "the agent panel does not appear". For an external MCP client use
  wfgraph-core/mcp; for roles and custom grants in general use
  wfgraph-core/auth.
metadata:
  purpose: >
    Configure the editor's build agent: the agent option's four providers and
    their defaults, gateways through baseUrl, a host runner through
    agent.runner and streamAgentTurn, the turn limit, and the grants a turn's
    tools check.
  type: sub-skill
  library: wfgraph
  library_version: "3.1.1"
requires:
  - wfgraph-core
sources:
  - alandotcom/wfgraph:docs/embedding.md
  - alandotcom/wfgraph:packages/core/src/backend/agent/config.ts
  - alandotcom/wfgraph:packages/core/src/backend/agent/runner.ts
---

This skill builds on wfgraph-core. Copy the provider table and the runner
example from `docs/embedding.md` ("The build agent" and "Run turns on your own
gateway or model").

# The build agent

The editor's Agent panel is a chat that reads the host's catalog and edits the
open workflow's draft. It is off until `agent` turns it on, and the editor then
draws no panel. A turn runs on the server, in the process that serves the
request, and the server stores nothing about a conversation: the browser sends
the history with each message and keeps the thread in its own storage.

## Procedure

1. **Pick the provider.** `agent.provider` is `"openai"` (the default),
   `"anthropic"`, `"openrouter"` or `"openai-compatible"`.

   | Provider            | Turned on by | `model`                     | Note                                                                 |
   | ------------------- | ------------ | --------------------------- | -------------------------------------------------------------------- |
   | `openai`            | `apiKey`     | Defaults to `gpt-6.1-terra` | `gpt-6-luna` is the lowest cost per turn                             |
   | `anthropic`         | `apiKey`     | Required                    | A Claude model of the 4.6 generation or later, for adaptive thinking |
   | `openrouter`        | `apiKey`     | Required                    | An OpenRouter model id                                               |
   | `openai-compatible` | `baseUrl`    | Required                    | `apiKey` is optional and sent as a bearer token when set             |

   Result: `GET {basePath}/api/extensions` answers `agent: { enabled: true }`
   for a signed-in session, and the editor draws the panel.

2. **Read the key from the environment.** A blank or absent `apiKey` leaves
   the agent off without an error, and so does a blank `baseUrl` for
   `openai-compatible`. A key with a blank `model` for a provider that has no
   default fails at startup. Result: startup either succeeds with the agent
   on, or throws a message naming `agent.model`.
3. **Put a gateway in front only if it speaks the provider's API.** A
   `baseUrl` under `openai` must serve `POST {baseUrl}/responses`, OpenAI's
   Responses API. A gateway that serves Chat Completions alone, as most
   self-hosted model servers do, is `openai-compatible`. Every request streams
   with function tools, so the gateway must pass server-sent events and a
   `tools` array through, and for OpenAI the `prompt_cache_key` and
   `store: false` fields. Result: a turn in the panel streams text and its
   tool calls draw on the canvas.
4. **Or run turns yourself.** `agent: { runner }` takes a
   `WfGraphAgentRunner` whose `run` receives a `WfGraphAgentTurn` and answers
   an Effect `Stream` of the parts the panel renders. `streamAgentTurn(turn,
   model)` runs the built-in loop on a `LanguageModel` layer the host builds,
   which covers any gateway the provider table does not. The other `agent`
   fields do not apply beside a runner, except `maxConcurrentTurns`. Result:
   the turn's log record names the runner's `provider` and `model`.
5. **Grant the turn's tools.** `agent.chat` needs `agent.use`. Each tool the
   model calls also checks what the MCP endpoint checks: `workflow.getById`
   for every tool, `workflow.update` for a write, `integration.getAll` for
   `list_integrations`, and the run tools' own operations. A missing grant
   answers the model a refusal rather than failing the turn. Result:
   `WfGraphRoles.editor` reaches every tool, and under a policy granting
   `agent.use` alone every tool call in a turn is refused.
6. **Size the turn limit.** `agent.maxConcurrentTurns` caps how many turns
   one process streams at once, across every person using the editor. It
   defaults to 4, and startup refuses a value that is not a positive integer.
   A turn past the limit is refused with a message asking the person to wait.

## Core Patterns

### What a turn costs and logs

Each turn ends with a `usage` part counting its model calls, tool calls, and
input, cached input, output and reasoning tokens. The panel prints it under
the turn, and the "Agent turn finished" record carries the same counts,
`usage.cachedInputTokens` included. Requests are cached per workflow: OpenAI
and OpenRouter requests carry `prompt_cache_key: "wfgraph-agent:<workflowId>"`,
an Anthropic request asks for automatic prompt caching, and an OpenAI request
sets `store: false`, so the provider keeps no copy of the turn.

### Reasoning effort

`agent.reasoningEffort` defaults to `medium` for `openai` and `high` for
`anthropic`, and is sent to `openrouter` and `openai-compatible` only when set. OpenAI takes
`none`, `low`, `medium`, `high`, `xhigh` and `max`; `minimal` is refused by the
type and by every GPT-6 model. Anthropic takes `low` to `max`. Lowering the
Anthropic effort below `high` makes the agent skip the validation and
reference reads its rules ask for; the eval suite measured `claude-sonnet-5-5`
at `high`.

### A runner's stream

Workflow Graph reads the turn's draft after each successful write tool result
and sends the editor the `graph` part itself; a `graph` part a runner sends is
dropped. A stream that fails reaches the panel as one `error` part carrying
the failure's message. A runner may emit a `usage` part of its own, which is
added to the turn's counts. The toolkit on the turn is the only way a turn
changes the workflow, and it validates each edit against the catalog and the
Connections as it does for the built-in agent.

### Test runs from the chat

`start_test_run` starts a Draft run of the saved draft, which calls every
action handler it reaches with `runMode: "test"`. In the panel it refuses once
the turn has edited the draft, because the editor saves those edits only when
the turn ends.

## Common Mistakes

### HIGH Anthropic or OpenRouter with no model

Wrong: `agent: { provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY }`.

Correct: name the model, such as `model: "claude-sonnet-5-5"`, the Claude model
the eval suite has measured.

Startup fails with `agent.model is required for the "anthropic" provider, which
has no default model.` Only `openai` has a default model.

Source: alandotcom/wfgraph:docs/embedding.md (The build agent)

### HIGH A Chat Completions gateway under the default provider

Wrong: `agent: { apiKey, baseUrl: "http://llm-gateway.internal/v1" }` for a
gateway that serves `/chat/completions` alone.

Correct: `provider: "openai-compatible"` with that `baseUrl` and a `model`.

The default provider calls `POST {baseUrl}/responses`, so every turn fails at
the gateway.

Source: alandotcom/wfgraph:docs/embedding.md (The build agent)

### MEDIUM An unset variable read as a startup check

Wrong: rely on `apiKey: process.env.ANTHROPIC_API_KEY` to stop a deployment
that forgot the variable.

Correct: check the variable in the host's own startup, or assert
`agent.enabled` in `GET /api/extensions` after a deploy.

A blank key turns the agent off without an error, so the editor simply loses
its panel.

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
  `agent: { enabled: true }`, and the editor draws the Agent panel.
- A turn that asks for one step adds it to the canvas, and the panel prints a
  usage line under the turn.
- A session without `agent.use` is refused `agent.chat` with `403`.

`packages/evals/src/skills/build-agent/agent-config.test.ts` in the Workflow
Graph repository asserts the startup and `agent.enabled` outcomes for each
provider form; a turn against a live model is not part of it.

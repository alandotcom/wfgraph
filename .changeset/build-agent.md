---
"@wfgraph/core": minor
"@wfgraph/client": minor
---

Add a build agent to the workflow editor: a chat panel that reads the extension
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

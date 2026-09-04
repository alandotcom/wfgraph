---
"@wfgraph/core": minor
"@wfgraph/client": minor
"@wfgraph/shared": minor
---

Render the agent's working-out with assistant-ui's own thread elements

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

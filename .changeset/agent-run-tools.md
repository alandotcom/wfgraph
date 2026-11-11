---
"@wfgraph/core": minor
---

The build agent and the MCP endpoint gain four tools: `list_runs` and `read_run` read a workflow's recent runs and one run's step log (each step's output is cut to 2,000 characters, with its full size beside it), `start_test_run` starts a Draft run of the saved draft with a payload and answers the run id, and `list_field_options` answers the choices a provider-backed field offers. Each checks the caller's grant for the same editor operation per call: `workflow.getExecutions`, `workflow.getExecutionLogs`, `workflow.execute`, and `action.configOptions` or `integration.configOptions`. A Draft run calls real action handlers in test mode, so `start_test_run` is annotated as open-world and not read-only, and in the chat panel it refuses after the turn has edited the draft, since the editor saves those edits only when the turn ends.

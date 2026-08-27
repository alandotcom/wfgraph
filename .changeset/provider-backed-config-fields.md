---
"@wfgraph/core": minor
"@wfgraph/client": minor
"@wfgraph/shared": minor
---

Add config fields whose shape the node's connection answers. Two field types join the vocabulary: `provider-select` draws a dropdown over what the connection lists, and `provider-fields` draws one input per value the current selection declares, stored as one JSON object under the one config key. An integration declares what each asks under `configOptions`, keyed by the name a field's `optionsSource` uses, and `checkIntegration` refuses a field wired to a provider that cannot answer it.

The editor asks over `integration.configOptions`, which resolves the connection's credentials server-side the way the connection test does. Credentials never reach the browser, and neither does a failed request's own exception text. A provider refusing is an answer rather than an error, so the sentence it wrote is what the panel shows. Every provider-backed field falls back to the plain control it replaces, so a missing connection, a grant too narrow to read, or a provider that is down never leaves a builder unable to type the value themselves.

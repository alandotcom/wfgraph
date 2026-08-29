---
"@wfgraph/core": patch
"@wfgraph/client": patch
---

Run and Publish no longer dead-end when a connection cannot answer for a provider-backed field. The click-time recheck asked every such field at once and rejected on the first refusal, so a single expired grant ended every Run and Publish at "Could not verify provider-backed fields", with nothing the operator could do to clear it. The missing-connection and required-field issues naming the node at fault were never collected at all. Each question now answers for itself: a refusal arrives as a warning naming its node and field, listed under "Unchecked Fields" with a Fix button, and the rest of the list reaches the reader. Run Anyway stays available, and Publish still goes to the server for the authoritative check.

A second Run or Publish while a check is already running says so instead of doing nothing, which is what Cmd+Enter had been doing on a slow provider.

Saving a connection, adding one, and completing OAuth no longer hold their dialog open for a round trip to the provider. The connection list is what those call sites wait on; the affected connection's provider options are refreshed alongside it.

`redactSensitiveData` and the workflow-graph redaction beneath it build their answer with `Object.fromEntries`, so a payload carrying an own `__proto__` key travels through as data rather than reaching `Object.prototype`'s setter.

`setValueByPath` in `@wfgraph/shared` answers a boolean saying whether the write landed, in place of the target it was handed. The test-payload form drops a field whose path names a reserved record key rather than drawing an input whose value would go nowhere.

The SQLite migration that added `integrations.refresh_state` spells its three values out instead of reading `INTEGRATION_REFRESH_STATES`. A database past that version never runs the migration again, so interpolating the shared list would have widened the CHECK on new databases alone. A test now holds the pair together.

A confirmation dialog's message keeps its line breaks, so a warning written as two paragraphs reads as two.

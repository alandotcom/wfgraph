---
"@wfgraph/core": patch
---

`integration.configOptions` now requires the `workflow.write` permission, the same as `action.configOptions`. Answering it resolves the connection's stored credentials, can refresh an OAuth grant, and calls the vendor with that grant, so a viewer holding only `connection.read` is refused with `403`. A custom policy that granted `connection.read` alone for this operation must grant `workflow.write` or name the operation ID.

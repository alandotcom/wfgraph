---
"@wfgraph/core": minor
---

`encryption` on `createWfGraphApp` and `createWfGraphRunner` is now optional for an app whose `extensions` declare no integration, since connections and OAuth attempts are the only values Workflow Graph encrypts. An app that declares an integration and passes no key still fails at startup with the same message, and a key that is passed must still be a 64-character hex string. `wfWorker` still requires `encryption.key`.

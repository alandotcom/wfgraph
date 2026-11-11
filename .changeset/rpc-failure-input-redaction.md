---
"@wfgraph/core": patch
---

The request log record of a refused RPC call now masks an input field whose name marks it as a credential, such as the `token` of `workflow.resumeWait`, keeping its last four characters. The record used to print the token whole, and the token alone is enough to resume the Wait.

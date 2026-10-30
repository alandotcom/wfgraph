---
"@wfgraph/core": patch
"@wfgraph/client": patch
---

An RPC procedure now stops when its client aborts the request. The request's abort signal used to reach only the streaming procedures, so an aborted unary call kept running to completion.

The start-up notice about logging now also appears when a host configured LogTape without a sink that receives the `wfgraph` category. It used to check only whether any configuration was installed, so a host that configured LogTape for its own categories alone lost every Workflow Graph record without a word.

A bigint in a log message now renders as its digits. `JSON.stringify` threw on one, which broke the pretty console formatter and the `logger` bridge. Each LogTape meta logger record is also delivered once; it used to reach the sink twice.

Closing the last overlay in the editor now plays its exit animation.

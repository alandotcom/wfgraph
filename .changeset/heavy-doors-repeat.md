---
"@wfgraph/client": patch
---

Settle the node configuration panel's controls.

Lifecycle Rules renders one mode instead of switching between a text summary and
its controls, and Concurrency became a dropdown. Template fields, reference
badges and the connection picker now share the height and type size of every
other control in the panel. A configured condition can be deleted: removing the
last rule clears the whole condition, where both trash buttons used to be
disabled with no way back.

Choosing a connection is a dropdown, and creating, editing and deleting one use
the Connections manager. Connection changes repair Action, Lifecycle, and Wait
bindings in the open graph, so a step stops naming a deleted connection.
Missing connections link directly to that manager, and read-only workflow panels
cannot open connection-editing controls. Provider-backed fields preserve their
value when switching input modes, and template inputs retain mobile-safe text.

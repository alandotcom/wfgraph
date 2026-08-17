---
"@wfgraph/client": patch
---

Copy and paste selected canvas nodes, including a multi-node subgraph.

Cmd/Ctrl+C, V, and D (and the node/pane context menus) copy action nodes
without the Lifecycle Node, keep edges that ran between them, mint fresh ids
on paste, and rewrite template tokens that named a copied node.

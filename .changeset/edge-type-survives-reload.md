---
"@wfgraph/client": patch
"@wfgraph/shared": patch
---

Paint every edge with the canvas edge after a reload. A saved graph came back
with no edge type on it, since the persisted edge attributes drop the editor's
own keys, and React Flow answers a type it cannot resolve with its built-in
bezier edge. A refresh therefore replaced the rounded orthogonal path with a
plain curve until the next time the edge was drawn by hand.

The editor now puts its edge type on at hydration and stops writing one to the
wire, so how an edge draws is the canvas's decision alone and no stored graph
can carry a stale answer.

---
"@wfgraph/client": patch
"@wfgraph/shared": patch
---

Paint every edge with the canvas edge after a reload. A saved graph came back
with no edge type on it, since the persisted edge attributes drop the editor's
own keys, and React Flow answers a type it cannot resolve with its built-in
bezier edge. A refresh therefore replaced the rounded orthogonal path with a
plain curve until the next time the edge was drawn by hand.

The canvas now names its edge once, through React Flow's `defaultEdgeOptions`,
and no edge carries a type of its own. How an edge draws is one decision in one
place, so a new edge cannot be built without an answer and no stored graph can
carry a stale one.

The persisted graph carries structure and geometry alone. A node's `selected`
and `dragging` and an edge's `selected` were written to the wire and belong to
whoever is looking at the graph, so they are gone from both directions.

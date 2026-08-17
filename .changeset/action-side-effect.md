---
"@wfgraph/core": minor
"@wfgraph/client": minor
"@wfgraph/plugins": minor
"@wfgraph/shared": minor
---

Let an action declare `sideEffect: true` when running it changes something
outside the workflow, and hold a Group to lookups on that answer. `defineAction`
and an integration's action literal both take the field, it defaults to `false`,
and it reaches the browser on the extension catalog. The seven writes the
built-in plugins ship now declare it, so grouping a Send Email or a Delete User
is refused rather than accepted against the Group contract.

Fix two Group defects on the canvas. Deleting a frame with the Delete key left
its interior edges and any collapsed inlet edge in the graph naming steps that
were gone, which the next save refused. An edge running from one frame's exit
into another frame's entry painted on the two members instead of the two frames,
so auto-layout read the frames as unconnected.

Cut some of the canvas render cost. A graph whose nodes were left out of the
order React Flow wants paid a re-sort and an allocation on every render, drag
frames included, and grouping a second selection, ungrouping one of two frames,
and pasting a frame each left it that way; all three now keep the order. The
painted edges also come back as the array they went in as for a graph with no
frame, though one holding a frame still rebuilds them per node change.

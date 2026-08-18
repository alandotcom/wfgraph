# @wfgraph/shared

## 2.2.1

## 2.2.0

## 2.1.0

### Minor Changes

- [#115](https://github.com/alandotcom/wfgraph/pull/115) [`4f34676`](https://github.com/alandotcom/wfgraph/commit/4f34676d7049a9a2577e873c1a79da9a89d43e09) Thanks [@alandotcom](https://github.com/alandotcom)! - Let an action declare `sideEffect: true` when running it changes something
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

- [#114](https://github.com/alandotcom/wfgraph/pull/114) [`2565518`](https://github.com/alandotcom/wfgraph/commit/2565518e5e16dea7f6ada86ccbb642a696d190b0) Thanks [@alandotcom](https://github.com/alandotcom)! - Allow AND-joins: two parallel action nodes can both feed one next step. Fan-out was already concurrent; saving and the canvas now accept multi-incoming edges when every predecessor completes successfully, with Wait-on-arm, Started↔Canceled, and exclusive-branch joins still refused.

### Patch Changes

- [#115](https://github.com/alandotcom/wfgraph/pull/115) [`4f34676`](https://github.com/alandotcom/wfgraph/commit/4f34676d7049a9a2577e873c1a79da9a89d43e09) Thanks [@alandotcom](https://github.com/alandotcom)! - Paint every edge with the canvas edge after a reload. A saved graph came back
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

## 2.0.2

## 2.0.1

## 2.0.0

## 1.0.0

## 0.3.0

## 0.2.0

## 0.1.0

## 0.0.2

## 0.0.1

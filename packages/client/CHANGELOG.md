# @wfgraph/client

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

- [#115](https://github.com/alandotcom/wfgraph/pull/115) [`4f34676`](https://github.com/alandotcom/wfgraph/commit/4f34676d7049a9a2577e873c1a79da9a89d43e09) Thanks [@alandotcom](https://github.com/alandotcom)! - A disabled step now ends its branch, whatever kind of step it is, and the canvas
  draws what that costs.

  The engine used to stop only at a disabled Condition or Event Split. A disabled
  lookup handed its null output on, and the step below read that null as an
  answer. One rule replaces the two: a disabled node is skipped, recorded with a
  null output, and nothing past it is scheduled. A saved workflow holding a
  disabled step therefore runs less of itself than it did before, which a minor
  bump carries because a disabled step was already a request to leave work out,
  and the old behaviour left the step below reading a null it could not tell from
  a real answer.

  The editor mutes every step the run cannot reach, which until now was drawn only
  for a Canceled subtree with no Cancel Event declared. A muted card sits at 50%
  opacity and its incoming edge stops animating, so the dead part of a graph reads
  as still. The disabled step itself keeps its own face, since a person needs to
  tell the step they switched off from the steps that lost their path because of
  it.

  Disabled belongs to a Group as a whole. Selecting the frame offers the toggle
  and writes the flag onto every member, which is what the engine walks. A member
  selected on its own no longer offers it, the same way it offers no Delete, since
  a frame with some members off and some on has no face it could honestly wear.
  Grouping a step that was already off takes the whole frame with it.

### Patch Changes

- [#115](https://github.com/alandotcom/wfgraph/pull/115) [`4f34676`](https://github.com/alandotcom/wfgraph/commit/4f34676d7049a9a2577e873c1a79da9a89d43e09) Thanks [@alandotcom](https://github.com/alandotcom)! - Centre the title and description on a canvas node again. Both are full-width
  truncating blocks, so the stack's `items-center` was centring the icon alone and
  leaving the words against the left edge.

  Draw a node's icon at 24px rather than 32px, which gives the two lines of text
  more of the card.

- [#109](https://github.com/alandotcom/wfgraph/pull/109) [`abba0dd`](https://github.com/alandotcom/wfgraph/commit/abba0dd82fa7896062cb6e38713e4254dd3e006c) Thanks [@alandotcom](https://github.com/alandotcom)! - Make the condition field picker a combobox so a long list of upstream paths can be typed to filter.

- [#110](https://github.com/alandotcom/wfgraph/pull/110) [`d6131a9`](https://github.com/alandotcom/wfgraph/commit/d6131a9dc95aefdd1ba4dffb5aad02991dda6e0a) Thanks [@alandotcom](https://github.com/alandotcom)! - Copy and paste selected canvas nodes, including a multi-node subgraph.

  Cmd/Ctrl+C, V, and D (and the node/pane context menus) copy action nodes
  without the Lifecycle Node, keep edges that ran between them, mint fresh ids
  on paste, and rewrite template tokens that named a copied node.

- [#112](https://github.com/alandotcom/wfgraph/pull/112) [`c2a626c`](https://github.com/alandotcom/wfgraph/commit/c2a626c8c6f115f580666ee4fffafe42cb334136) Thanks [@alandotcom](https://github.com/alandotcom)! - Make the canvas denser: 192×112px rectangular nodes and rounded orthogonal edges.

- [#115](https://github.com/alandotcom/wfgraph/pull/115) [`4f34676`](https://github.com/alandotcom/wfgraph/commit/4f34676d7049a9a2577e873c1a79da9a89d43e09) Thanks [@alandotcom](https://github.com/alandotcom)! - Drop `react-grab`. It was a dependency of the published editor for the sake of
  one development-only dynamic import, so every adopter installed it to run code
  that a production build never reaches.

- [#115](https://github.com/alandotcom/wfgraph/pull/115) [`4f34676`](https://github.com/alandotcom/wfgraph/commit/4f34676d7049a9a2577e873c1a79da9a89d43e09) Thanks [@alandotcom](https://github.com/alandotcom)! - Drop the `Temporary` edge component. Nothing built an edge of that type, so the
  canvas registered a component it could never resolve to.

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

- [#115](https://github.com/alandotcom/wfgraph/pull/115) [`4f34676`](https://github.com/alandotcom/wfgraph/commit/4f34676d7049a9a2577e873c1a79da9a89d43e09) Thanks [@alandotcom](https://github.com/alandotcom)! - Draw a Group's interior edges, so parallel members read as parallel. The frame
  already kept the store edges naming its children, and the engine still ran them
  side by side and joined them at the exit; the canvas painted the members as a
  bare grid with no handles, which made a fan-out look like a sequence.

  A nested card now carries invisible handles for those edges to meet at, a row
  narrower than the widest one is centred so a join sits under everything it
  joins, and the rows are spaced far enough apart for the path to be read. A
  nested Condition keeps its two branches on the offsets a standalone Condition
  uses, so a fan-out inside a frame paints as two paths. An interior edge is
  display only: the frame owns every edit, since deleting one would strand a
  member.

  Ungrouping rebuilds the freed steps at the pitch auto-layout uses, rather than
  leaving them overlapping at the compact spacing they had inside the frame.

  Hold a member inside its frame until the frame goes. Deleting one on its own
  left the frame naming an exit that no longer existed, and the next edge painted
  off the frame's outlet named that dead step too; graphology then invented a node
  for it and the save failed on an unreadable `Missing key at ["nodes"][6]`. Every
  delete path asks one question and gives one answer: the delete key, the context
  menu, and the panel's own button all refuse a selection that reaches into a
  frame without taking the frame, and each says to ungroup first rather than
  doing nothing. `createSerializedWorkflowGraph` now refuses an edge naming a node
  the graph has no node for, and says which edge.

- [#115](https://github.com/alandotcom/wfgraph/pull/115) [`4f34676`](https://github.com/alandotcom/wfgraph/commit/4f34676d7049a9a2577e873c1a79da9a89d43e09) Thanks [@alandotcom](https://github.com/alandotcom)! - Group lookup and Condition steps on the canvas as a single-entry, single-exit
  frame so a sequence can copy-paste the same fetch-and-stop after each Wait.
  Lookups inside the frame may run side by side and AND-join at the Condition.

## 2.0.2

## 2.0.1

## 2.0.0

### Patch Changes

- [#100](https://github.com/alandotcom/wfgraph/pull/100) [`73feb18`](https://github.com/alandotcom/wfgraph/commit/73feb18706a0d38157a5e8c9899b4644b210c04a) Thanks [@alandotcom](https://github.com/alandotcom)! - Release the editor canvas whenever no surface is left showing the open run.

  Opening a run pins its published graph to the canvas and locks editing, and only
  the Runs panel's own controls released it. Two ways of hiding the panel did not:
  closing the node config sheet on a narrow viewport, and collapsing the rail on a
  wide one. Both leave the Runs tab selected with its tab bar off screen, so the
  run stayed pinned and every edit was refused with nothing on screen to say why.
  Each now closes the run as it goes, and the panel comes back on Properties.

  Opening an overlay now runs the `onClose` of whatever it replaces, matching every
  other path that takes an overlay off the stack. Tapping Test Run while the config
  sheet was up discarded the sheet silently, which was the same locked canvas by a
  third route.

  The Runs panel's Back button no longer leaves the Runs tab. It clears the open
  run and returns to the runs list its label names, which is what the route's tab
  rule now allows: a run in the URL opens the Runs tab, and its absence leaves the
  panel's own tab alone.

- [#95](https://github.com/alandotcom/wfgraph/pull/95) [`a9f08b4`](https://github.com/alandotcom/wfgraph/commit/a9f08b4883375cc8492ae4f53eae4e4876ea7fdc) Thanks [@alandotcom](https://github.com/alandotcom)! - Fix the editor canvas staying read-only after the user leaves the Runs tab.
  Opening a run pins its published graph to the canvas and locks editing, and the
  Runs panel's Back button was the only control that released it. A switch to the
  Workflow tab left the run id in the URL, so the canvas kept refusing every edit
  with nothing on screen to say why. The pinned graph now reads through the same
  Runs-tab gate that the run's status chips already used.

## 1.0.0

## 0.3.0

## 0.2.0

## 0.1.0

## 0.0.2

### Patch Changes

- [#84](https://github.com/alandotcom/wfgraph/pull/84) [`33a616f`](https://github.com/alandotcom/wfgraph/commit/33a616f4118adb125f578627a21310a1ca24912f) Thanks [@alandotcom](https://github.com/alandotcom)! - Each package now ships its own README, so its npm page describes what it is rather than
  offering to let someone add one, and declares `engines.node` at the Node 24 floor the repo
  already builds against, so an install on an older runtime warns instead of failing later.

## 0.0.1

### Patch Changes

- First published release. `@wfgraph/core` carries the run engine, the authoring
  vocabulary and `createWfGraphApp`; `@wfgraph/client` carries the editor bundle a
  host hands it; `@wfgraph/plugins` carries the six built-in integrations.

# @wfgraph/client

## 2.6.0

### Minor Changes

- [#128](https://github.com/alandotcom/wfgraph/pull/128) [`c2ae17b`](https://github.com/alandotcom/wfgraph/commit/c2ae17b9da06d723443386d04cd1852b800fedf2) Thanks [@alandotcom](https://github.com/alandotcom)! - Add a build agent to the workflow editor: a chat panel that reads the extension
  catalog and the open workflow, then edits the canvas as it answers.

  A host turns it on with a new `agent` option on `createWfGraphApp`, carrying an
  OpenAI API key and optionally a model id and an OpenAI-compatible endpoint.
  Absent or blank, the agent is off: no model is called and the editor shows no
  panel, so an adopter who wants no AI in their editor writes nothing.

  The agent has fourteen tools. Seven read (search the action catalog, describe one
  action's config and output fields, list Events and integrations, read the graph,
  list the template tokens a step may reference, and validate the workflow) and
  seven write (add, update and delete a step, connect and disconnect steps, declare
  the Lifecycle Rules, and write a Condition's test). They run on the server against
  the graph the editor sends with each turn, and the resulting graph streams back
  so the canvas redraws as the agent works. The edit lands through the editor's own
  save path, so it is one undo step and the autosave persists it.

  `GET /api/extensions` now answers `agent: { enabled }` beside `catalog`, which is
  how the editor knows whether to offer the panel. `agent.chat` is the first
  streaming RPC procedure in the contract, declared as an oRPC event iterator.

  The `effect` catalog moves to `4.0.0-rc.110`, which the `@effect/ai-openai`
  provider names as its peer.

## 2.5.0

### Minor Changes

- [#142](https://github.com/alandotcom/wfgraph/pull/142) [`5bae4ed`](https://github.com/alandotcom/wfgraph/commit/5bae4edec32749af8ae82b978e258042370e0f0f) Thanks [@alandotcom](https://github.com/alandotcom)! - ⌘K opens a command palette whose first job is adding a step and choosing its type.

  The search box slice 3 put in the menu bar was decoration; it is now the palette's trigger and
  carries the chord it answers to. ⌘K reaches it from anywhere in the editor, on the capture
  phase so a focused canvas field cannot eat the keystroke, and leaves the chord alone while
  somebody is typing in a text field. The palette opens at a root page holding "Add step" beside
  the Actions menu's own commands, each carrying that menu's disabled rule so a pinned run or a
  generation in flight refuses them in both places alike.

  "Add step" leads to the node types the extension catalog offers, grouped by category with
  System first. They answer to more than their labels: "delay" finds Wait, "branch" finds
  Condition, and "race" finds Event Split. Choosing one creates the step, selects it, and opens
  its configuration, which is one stage where it used to be two.

  The canvas skips the root. "Add Step" in the graph's context menu opens the palette straight on
  the node types, carrying the spot that was right-clicked. The Actions menu's own "Add step"
  opens the same page and puts the step in the middle of the canvas, moved clear of whatever is
  already there.

  Escape is contested and the palette wins the first press: it goes back a page while there is
  one to go back to, and closes at the root. Backspace on an empty search box does the same. Both
  clear what was typed, because a word typed on one page filters the next one to nothing.

  Built on Base UI's Autocomplete inside a Dialog, which is the shape their own command-palette
  example takes. shadcn's `command` is backed by cmdk, which declares four `@radix-ui/*` packages
  this repository has none of.

  The palette names itself for a screen reader: the search box, the option list, the page it is
  on as a live region, and a close control for a touch reader with no Escape key. It refuses to
  open whenever the Actions menu would refuse "Add step" — a run pinned to the canvas, or a
  generation rewriting the graph — and says which, rather than swallowing the keystroke. A
  non-owner is offered no way into it, opening another workflow throws a held one away, and a
  workflow that has not been saved yet has no palette.

  The action grid in the config panel now searches and groups node types through the same module
  the palette does, so "delay" finds Wait in both. It used to read three fields of its own.

- [#142](https://github.com/alandotcom/wfgraph/pull/142) [`5bae4ed`](https://github.com/alandotcom/wfgraph/commit/5bae4edec32749af8ae82b978e258042370e0f0f) Thanks [@alandotcom](https://github.com/alandotcom)! - The editor's primitives are current shadcn, in the `mira` style.

  `components.json` moves into `packages/client`, where its `#src/*` aliases resolve; from the
  repository root the CLI could not read them at all. Its `style` becomes `base-mira`, which now
  names both the primitive family and the visual style, and `rsc` becomes false for a Vite SPA.
  Sixteen registry components are re-pulled at that style, bringing `textarea` and `input-group`
  with them, and `shadcn/tailwind.css` is imported for the nine `data-*` variants their state
  styling compiles against.

  `mira` is a dense style: a default button is 28px against the previous 36px, and body text
  12px against 14px. Every control in the editor and the dashboard is smaller. The canvas is
  untouched, node geometry included.

  Three behaviours moved with the primitives. `whenChosen` is now in `#src/lib/select-choice`,
  outside the file the CLI overwrites, and each Select feeds its explicit options to Base UI's
  own `items` prop so the trigger and popup share one label source. `ComboboxInputGroup` and
  `ComboboxClear` are gone, absorbed into `ComboboxInput` behind `showTrigger` and `showClear`,
  which takes a `triggerLabel` so the button it renders has an accessible name. `Radio` is
  `RadioGroupItem` and `ComboboxGroupLabel` is `ComboboxLabel`.

  Two defects fixed on the way. A Select trigger rendered a stray `▼` inside its chevron, because
  Base UI's `Select.Icon` defaults its children to that glyph and the registry component passes
  only `render`. And the dashboard's mode badge was `text-zinc-700` with no dark counterpart, so
  it was unreadable against a dark row.

- [#142](https://github.com/alandotcom/wfgraph/pull/142) [`5bae4ed`](https://github.com/alandotcom/wfgraph/commit/5bae4edec32749af8ae82b978e258042370e0f0f) Thanks [@alandotcom](https://github.com/alandotcom)! - Replace the editor's icon toolbar with two menus on a fixed-height bar.

  Nine controls, six of them identical grey squares you had to hover to identify,
  become one 44px line: the dashboard, a menu on the workflow's name, an Actions
  menu, the command palette's trigger, and Publish with a written label. The
  Actions menu names what it does and shows the shortcut each item is bound to,
  and the Live/Test pair becomes a single "Switch to <other> mode", since the
  status strip already says which mode the workflow is in. The workflow menu adds
  Rename and Delete Workflow beside the switcher and prints the workflow's id.

  The Save button is gone. Autosave writes the draft, the strip says when it last
  landed, and Cmd+S still forces one.

  Renaming a workflow now waits on the request rather than on the autosave
  debounce, and a name the server refuses is taken back off the editor and out of
  the save queue. Left parked, a refused name rode along with every later graph
  write and failed it too, so one rejected rename stopped the editor saving
  anything for the rest of the session.

  "Tidy layout" in the Actions menu and the reflow control at the canvas's bottom
  left now run one shared pass, and Add step, Undo, Redo and Tidy layout all
  refuse while a past run is pinned to the canvas, which the buttons they replace
  did not.

- [#142](https://github.com/alandotcom/wfgraph/pull/142) [`5bae4ed`](https://github.com/alandotcom/wfgraph/commit/5bae4edec32749af8ae82b978e258042370e0f0f) Thanks [@alandotcom](https://github.com/alandotcom)! - Add a status strip along the bottom of the editor canvas.

  The workflow's state used to be assembled from chips scattered through the menu
  bar, and a run pinned to the canvas refused every edit with nothing on screen
  saying why. One fixed-height row now states mode, publication and save state
  with the issue count; when a past run is pinned it reports that run and carries
  the way back to the draft, which was previously reachable only from inside the
  run panel. The menu bar keeps the controls and loses the badges, and the
  bottom-centre test-mode banner is gone: what it explained is on the mode label.

- [#142](https://github.com/alandotcom/wfgraph/pull/142) [`5bae4ed`](https://github.com/alandotcom/wfgraph/commit/5bae4edec32749af8ae82b978e258042370e0f0f) Thanks [@alandotcom](https://github.com/alandotcom)! - Give a node's configuration a view mode.

  A node's configuration now reads back as plain text and opens all of its
  controls on one Edit button, which becomes Done. The Lifecycle Node's rules are
  one block of it; so is a condition builder.
  A Start Event reads as its name and the path runs are correlated on. A condition
  reads as one line per rule, with its group shown as a left rule with the rows
  indented behind it and the and/or joiner sitting on the divider between groups.

  A rule that is not finished, points at a field the graph no longer offers, or
  compares against a value its field no longer names says so on its own line, so
  reading a configuration back tells you as much as opening it does.

  The explanatory paragraphs that ran between the controls, including
  Concurrency's three option descriptions, moved into a help popover beside each
  block's label. It opens on a click, with the option in force listed first.

  The Condition node's builder is now headed "Continue when".

  With nothing selected the panel shows an empty state. Everything it used to
  offer about the workflow itself lives in the menu beside the workflow's name,
  which gains a Clear workflow item.

### Patch Changes

- [#142](https://github.com/alandotcom/wfgraph/pull/142) [`5bae4ed`](https://github.com/alandotcom/wfgraph/commit/5bae4edec32749af8ae82b978e258042370e0f0f) Thanks [@alandotcom](https://github.com/alandotcom)! - The editor's mobile sheet is Base UI's Drawer, and `vaul` is gone from the dependency tree.

  `vaul` was the last package pulling Radix into an install of Workflow Graph: 64 `@radix-ui`
  entries in the lockfile, now zero. Base UI's Drawer covers what it did, and `@base-ui/react`
  was already installed for the rest of the editor's primitives.

  The parts map one to one except for the frame. `Drawer.Viewport` has no vaul counterpart and
  is required: it owns the swipe gesture and the touch scroll lock, so it is now the fixed,
  full-screen, bottom-aligned box and the sheet inside it is a laid-out flex item rather than a
  fixed one. Its bounds are unchanged at `max-h-[90vh]`, and the sheet is still a bounded flex
  column, which is what the node config panel's internal scrollers need.

  Base UI animates the sheet from CSS rather than from JS: `data-starting-style` and
  `data-ending-style` carry the enter and exit frames, `--drawer-swipe-movement-y` follows the
  finger, and `--drawer-swipe-progress` fades the backdrop in step with a drag.

  The sheet's bottom inset now works. It was a spacer div classed `h-safe-area-inset-bottom`,
  which compiles to nothing under Tailwind v4, and is `pb-[env(safe-area-inset-bottom,0px)]` on
  the sheet itself.

  Dismissal is unchanged: the close button and the sheet's own dismiss reach `closeAll`, Escape
  reaches `pop`, and a press outside the sheet closes it.

- [#142](https://github.com/alandotcom/wfgraph/pull/142) [`5bae4ed`](https://github.com/alandotcom/wfgraph/commit/5bae4edec32749af8ae82b978e258042370e0f0f) Thanks [@alandotcom](https://github.com/alandotcom)! - Sit the editor inside a margin, on a page a step off the shell.

  The editor used to fill the viewport edge to edge, which left it looking like
  the window rather than something in it. It now sits 12px in on all four sides,
  with a `--radius-xl` corner, a hairline border and a whisper of shadow. The
  surface behind it is a new token, `--page` (`bg-page`), a step off the base
  surface in whichever direction the theme layers: down from Paper in light, and
  up from Void in dark, where nothing renders darker and the shell has to stay
  Void because that is the field the graph floats on. Below `md` the inset, the
  corner and the border all go, since 24px of a phone's width buys nothing and the
  status strip needs the bottom edge of the screen for the home indicator.

  The properties panel's width is now a share of that inset shell rather than of
  the window, and its resize drag measures the same box, so the released edge
  still lands under the pointer.

  Dropping a connection on empty canvas now creates the node under the cursor. The
  release point was being measured from the canvas pane's own corner and handed to
  a converter that wanted window coordinates, which placed every such node up and
  to the left by however far the pane sat from the window's corner.

## 2.4.0

## 2.3.0

### Minor Changes

- [#135](https://github.com/alandotcom/wfgraph/pull/135) [`6b19caa`](https://github.com/alandotcom/wfgraph/commit/6b19caa92ea21447eda5dcf4e99402c44a3f91b6) Thanks [@alandotcom](https://github.com/alandotcom)! - Add optional `hidden` flag on actions so retired actions stay runnable while the editor picker omits them. Document forward-compatible action evolution in `docs/integrations.md`.

## 2.2.3

### Patch Changes

- [#132](https://github.com/alandotcom/wfgraph/pull/132) [`da8560d`](https://github.com/alandotcom/wfgraph/commit/da8560d12d51ce7395f06c746be3db7deb1c22a6) Thanks [@alandotcom](https://github.com/alandotcom)! - Auto-layout keeps a branch in its own column. An outlet a Lifecycle or Condition
  node draws now holds its column whether or not anything is wired to it, so a
  workflow with no Cancel branch still reads as a tree and wiring that branch later
  moves nothing already placed. A Group frame no longer sends the graph to the
  dagre fallback either: a rank is now as tall as the tallest node standing in it,
  so a frame takes a rank of its own and the chain around it stays centred.

## 2.2.2

### Patch Changes

- [#126](https://github.com/alandotcom/wfgraph/pull/126) [`d08d43f`](https://github.com/alandotcom/wfgraph/commit/d08d43fc37687a8e767ed47493c7e9a66c56d88d) Thanks [@alandotcom](https://github.com/alandotcom)! - Keep the canvas context menu inside the window. An item that explains why it is
  disabled now wraps its reason at a capped width rather than stretching the menu
  off the right edge, the menu opens upward when the pointer sits near the bottom,
  and it renders on the body so the properties panel no longer paints over it. A
  disabled row drops its keyboard shortcut, since the key does nothing there.

- [#126](https://github.com/alandotcom/wfgraph/pull/126) [`d08d43f`](https://github.com/alandotcom/wfgraph/commit/d08d43fc37687a8e767ed47493c7e9a66c56d88d) Thanks [@alandotcom](https://github.com/alandotcom)! - Paint the Group frame once, and give it back its side gutters. The frame node is
  typed `group`, which is also a React Flow built-in type, so its wrapper was
  picking up the library's default node border, fill and 10px of padding: a second
  rectangle around the frame, inset far enough that the member cards left a 2px gap
  at each edge instead of the 12px the layout reserves. The frame's label also
  takes the theme's foreground colour in dark mode now, rather than React Flow's
  fixed dark grey.

## 2.2.1

### Patch Changes

- [#121](https://github.com/alandotcom/wfgraph/pull/121) [`b15ee18`](https://github.com/alandotcom/wfgraph/commit/b15ee184c717d8053ab8cd8f75134bbc23095c27) Thanks [@alandotcom](https://github.com/alandotcom)! - Loading a workflow drops the previous one's issues.

  `loadWorkflowGraphAtom` cleared selection, undo history and the dirty flag, and
  left `workflowIssuesAtom` holding what the last graph was accused of. The
  collector is debounced by 300ms, so for that window the toolbar chip counted
  faults against a canvas whose node ids no longer matched, and the badges it
  claims to agree with had already gone with the old nodes. The load now empties
  the list, which is the state a first open already starts in.

## 2.2.0

### Minor Changes

- [#119](https://github.com/alandotcom/wfgraph/pull/119) [`ca0de9a`](https://github.com/alandotcom/wfgraph/commit/ca0de9a4d8be996e1430da6c7cee783be1bf76e2) Thanks [@alandotcom](https://github.com/alandotcom)! - Draw the canvas in a stroke a reader can follow.

  A node card is Paper on a Paper canvas, so its border is the whole card edge,
  and it was a `--border` hairline measuring 1.20:1. Edges came off the same
  token, and an edge into a subtree the run cannot reach then had 40% opacity
  laid over that, leaving nothing on screen. Two tokens replace it:
  `--canvas-line` at 3.95:1 on Paper and 3.21:1 on Void, carrying a node's
  resting border at 1.5px and the live wire; `--canvas-line-muted` at 2.0:1 in
  both themes for an unreachable edge, which now says so with a wider dash gap
  and a stopped march rather than by fading out.

  A Group frame was `bg-muted/40`, which lands near oklch(0.988) over the canvas
  and read as transparent. It is a solid fill behind the same 1.5px border, with
  a rule under its title, so the canvas, the frame and the member cards are three
  tones the eye can order.

  Node icons go from 24px to 20px, and the way back to the dashboard is a
  breadcrumb beside the workflow switcher rather than the first item inside it.

- [#119](https://github.com/alandotcom/wfgraph/pull/119) [`ca0de9a`](https://github.com/alandotcom/wfgraph/commit/ca0de9a4d8be996e1430da6c7cee783be1bf76e2) Thanks [@alandotcom](https://github.com/alandotcom)! - A draft always saves; an invalid graph never publishes.

  `prepareGraphSave` refused a graph whose nodes were half-built, which is the
  ordinary state of an editor session. The editor suppressed that 400 for
  autosaves, so the canvas sat dirty with nothing said and a reload discarded the
  work. The battery is split: the save asks only what has to be true of a graph in
  a row (it parses, and its stored expressions are ones the compiler produced), and
  the readiness half moves to `checkPublishReadiness` in `publish-checks.ts`.

  Nothing loses a guard. No run reads the draft column — both start paths load the
  published version row and refuse when there is none — and publish is the sole
  writer of the event subscription index, so an Event cannot reach a draft either.
  Publish is the one gate that makes a graph runnable, and it now runs required
  fields, Events, Event Split outlets, template references, connections and the
  unreachable-subtree check together. Draft saves also stop costing a query, since
  nothing left in that path reads the catalog or the database.

  In the editor, validation runs continuously against the graph rather than only
  when Run is pressed ([#2](https://github.com/alandotcom/wfgraph/issues/2)). Broken nodes wear a warning badge, the toolbar carries
  an issue count that opens the existing issues list, and Publish opens that list
  instead of spending a round trip on a refusal the canvas was already showing.
  The connection-missing triangle each action card used to draw from its own
  reading of the connection list is now one rule inside the shared collector, and
  every caller normalises its nodes the same way, so the canvas and the pre-run
  check cannot disagree about a node. Nothing is reported until the connection
  list has actually arrived: an empty list is a real answer, and using it for
  "not asked yet" would accuse every node that names a connection.

  Save state is a word rather than a dot — "Saving", "Unsaved changes", "Saved",
  "Save failed" — and closing or reloading the tab with an edit still in the
  debounce window asks first. Both are owner-only: a viewer of a public workflow
  can still nudge a node, and the refused save that follows would otherwise leave
  them holding a dirty flag and a leave-prompt they could never clear.

### Patch Changes

- [#116](https://github.com/alandotcom/wfgraph/pull/116) [`386e630`](https://github.com/alandotcom/wfgraph/commit/386e6308138f1a3cc2212d72575076ebfa4c9191) Thanks [@alandotcom](https://github.com/alandotcom)! - Order a loaded Group graph rest → frames → members so the canvas can reuse the
  store array instead of reallocating on every read.

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

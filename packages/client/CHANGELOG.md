# @wfgraph/client

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

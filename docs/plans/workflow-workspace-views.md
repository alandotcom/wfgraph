# Workflow workspace views

Proposed. Design confirmed. Implementation has not started.

Goal: make the workflow editor's active context visible and give every context a
predictable return path to the editable draft. The editor keeps one shared canvas for
draft configuration, run inspection, and publication comparison.

This handoff is written for an engineer with no memory of the design discussion. The
code references were verified on branch `main` at commit `8c52eeba`, with the staged
publication-history work still in the worktree.

## Current state

The user reported the navigation failure and confirmed the design decisions in this plan.
The workspace-view redesign has no implementation changes. This file is the only addition
from the planning pass.

The publication-history and comparison implementation is staged but uncommitted. Its tests
were not rerun during this documentation task. Run the required checks after implementing
the workspace-view redesign.

## Preserve the worktree

The worktree contains a substantial staged implementation of durable publication history
and workflow comparison. Preserve those changes. This plan changes the navigation and
state model around that implementation.

The staged work includes the following capabilities:

- Published workflow versions have immutable graphs.
- A selected run can pin its published graph to the canvas.
- The **Changes** panel compares the draft with a published version.
- Deleted comparison nodes remain movable for inspection.
- Version history can restore a version as the draft.
- Canvas editing locks during run inspection and comparison.

## Problem

The sidebar presents **Properties**, **Runs**, and **Changes** as peer tabs. These controls
have workspace-wide effects that extend beyond the sidebar.

- **Runs** can replace the draft graph with a published run graph and lock editing.
- **Changes** can replace the draft graph with a comparison graph and lock editing.
- **Properties** can display comparison properties while the comparison still owns the
  canvas.

The active tab can therefore disagree with the graph on the canvas. The sidebar can also
hide the only visible way to change tabs.

The reported failure is concrete: after opening a run, the user cannot identify how to
return to editing. Clicking the canvas clears or changes selection, but it does not provide
a reliable workspace transition.

## Root causes

The implementation spreads one workspace state across several independent values:

| Concern               | Source of truth                                               |
| --------------------- | ------------------------------------------------------------- |
| Sidebar tab           | `propertiesPanelActiveTabAtom`                                |
| Effective sidebar tab | `activePropertiesTabAtom`                                     |
| Selected run          | URL search parameter `executionId`                            |
| Visible run selection | `selectedExecutionIdAtom`, gated by the sidebar tab           |
| Run graph             | `executionOverlayGraphAtom`, also gated by the sidebar tab    |
| Comparison data       | `comparisonSessionAtom`                                       |
| Comparison visibility | `WorkflowComparisonSession.visible`                           |
| Canvas graph          | Implicit precedence between run, comparison, and draft graphs |
| Editing lock          | Derived from loaded overlays and pending requests             |

The following transitions demonstrate the resulting inconsistencies:

- Selecting a changed node writes the sidebar tab to `"properties"`, although comparison
  state remains active.
- Selecting **Properties** can hide a run graph while retaining `executionId` in the URL.
- Direct writes to `propertiesPanelActiveTabAtom` bypass comparison visibility updates.
- Collapsing the sidebar exits a run because the tab switcher becomes unreachable.
- A comparison session can remain hidden after the user returns to the draft.
- Run graph precedence over comparison graph is encoded separately from the editing lock.

## Confirmed design

Use an explicit _workspace view_ for the whole editor. The three values are `draft`,
`runs`, and `changes`.

Use the following presentation:

- Place **Draft**, **Runs**, and **Changes** in the toolbar beside the workflow name.
- Use a segmented control at desktop widths.
- Use a compact menu that displays the active view on mobile.
- Keep the control visible when the sidebar is collapsed or the mobile sheet is closed.
- Remove the mode tabs from the sidebar and mobile sheet.
- Make the sidebar content follow the active workspace view.
- Keep the canvas status strip as a second visible indicator and exit route.

The product's **Test mode** and **Live mode** menu remains separate. It controls execution
delivery and has no relationship to the workspace view.

## Target state model

Replace the panel-tab vocabulary with the following state:

```ts
export type WorkflowWorkspaceView = "draft" | "runs" | "changes";

export const workflowWorkspaceViewAtom = atom<WorkflowWorkspaceView>("draft");
```

Use `workflowWorkspaceViewAtom` as the source of truth for the canvas, inspector, status
strip, and editing lock.

Keep subordinate state in its existing domain:

- Keep `executionId` in route search state. It identifies a run within the Runs view.
- Keep run-list and run-detail navigation inside `WorkflowRuns`.
- Keep comparison payload, history selection, and deleted-node positions in the comparison
  store.
- Keep canvas node and edge selection in the graph store.

Do not add a route parameter for the workspace view in this change. A deep link that has
`executionId` still enters Runs through the existing route integration. Other editor
entries start in Draft.

## Workspace transitions

Centralize transitions in one hook or module. Components must not write the workspace atom
and related cleanup state independently.

The transition contract is as follows:

| Transition               | Required behavior                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Enter Draft              | Set the view to Draft, clear `executionId`, clear the run overlay, exit comparison, and restore valid draft selection. |
| Enter Runs               | Exit comparison, set the view to Runs, expand or open the inspector, and select the newest run after the list loads.   |
| Open a run               | Keep the Runs view and write `executionId` to route search.                                                            |
| Return to run list       | Clear `executionId` and keep the Runs view.                                                                            |
| Enter Changes            | Clear `executionId`, set the view to Changes, expand or open the inspector, and request a fresh comparison.            |
| Enter comparison history | Keep the Changes view and change only the comparison subview.                                                          |
| Inspect a changed node   | Keep the Changes view and open comparison properties.                                                                  |
| Restore a version        | Install the restored draft, clear comparison state, and enter Draft.                                                   |

Create a single navigation API with names that describe these transitions. For example:

```ts
type WorkflowWorkspaceNavigation = {
  showDraft: () => void;
  showRuns: () => void;
  showChanges: () => void;
};
```

The module can coordinate Jotai writes, router navigation, comparison cleanup, and panel
visibility. Keep the transition body out of toolbar and panel components.

## Canvas behavior

Derive the displayed graph from the workspace view:

```text
Draft   -> editable draft graph
Runs    -> loaded run graph, or a read-only draft fallback during loading or empty state
Changes -> loaded comparison graph, or a read-only draft fallback during loading
```

Remove implicit run-over-comparison precedence. Only the graph for the active workspace
view can own the canvas.

Lock draft editing whenever the workspace view is Runs or Changes. Continue locking during
agent generation and publication review.

Keep the existing comparison exception that permits movement of deleted historical nodes.
That movement updates only comparison position overrides.

Canvas node selection follows the active workspace view:

- In Draft, selecting a node opens editable node properties.
- In Runs, selecting a node opens run-specific inspection.
- In Changes, selecting a changed node opens comparison properties.

A canvas selection must not change the workspace view.

## Inspector behavior

The sidebar and mobile sheet become workspace inspectors. Remove `TabBar` from
`NodeConfigPanel` and remove `NodeConfigFrame.tabs`.

### Draft inspector

Preserve the existing Properties behavior:

- Show the selected node configuration.
- Show connection properties for a selected edge.
- Show multi-selection information.
- Show the existing empty state when nothing is selected.

### Runs inspector

Preserve the run list, run detail, and run-node inspector as nested Runs screens.

When the user enters Runs, mount `WorkflowRuns` and select the newest run after its first
settled list response. Perform this selection once per Runs mount.

The one-time behavior matters. After the user selects **Back** in run detail, the run list
must remain visible. Polling or a later run must not reopen a run automatically.

If the workflow has no runs, show the existing empty Runs state. Keep the draft graph
visible as a read-only fallback.

### Changes inspector

Keep review, comparison properties, and version history inside Changes.

Extend `ComparisonSubview` with a properties detail if needed:

```ts
type ComparisonSubview = "review" | "properties" | "history";
```

Selecting a changed node must open comparison properties without changing the workspace
view. Provide a **Back to changes** action from properties and history.

Request a fresh comparison each time the user enters Changes. Clear the comparison session
when the user leaves Changes so draft edits cannot make a cached comparison stale.

## Toolbar behavior

Place the workspace switcher after `WorkflowMenuComponent` and before workflow actions in
`WorkflowToolbarChrome`. This location associates the switcher with the workflow rather
than with the inspector.

At desktop widths, render one segmented control with the following labels:

- **Draft**
- **Runs**
- **Changes**

At mobile widths, render one menu trigger whose label is the active workspace view. The
menu contains the available views.

Apply the existing availability rules:

- Show Draft for every workflow.
- Show Runs only to the workflow owner.
- Show Changes only to the owner after the first publication.

Entering Runs or Changes must expand the desktop sidebar. On mobile, entering either view
must open the configuration sheet.

Selecting the active Runs or Changes control can reopen a hidden inspector. It must not
reset the selected run or comparison subview.

Search and editing actions can remain visible outside Draft, but their disabled state must
explain that the active view is read-only. Keep **Test mode**, **Live mode**, and publication
controls in their existing toolbar group.

## Panel collapse and mobile dismissal

Remove the connection between panel visibility and workspace state.

- Collapsing the desktop sidebar keeps the active workspace view.
- Closing the mobile configuration sheet keeps the active workspace view.
- The toolbar switcher remains the primary route to Draft.
- The status strip retains **Back to draft** as a second route.
- Selecting the active toolbar view reopens its inspector.

`useLeaveRunsSurface` exists because the sidebar owns the mode switcher. Remove the hook
after the toolbar switcher makes workspace navigation persistent. Keep a focused helper for
returning from run detail to the Runs list.

## Status strip

Extend `WorkflowStatusStrip` to represent all workspace views.

Use the following content:

| View                     | Status content                                                                 |
| ------------------------ | ------------------------------------------------------------------------------ |
| Draft                    | Publication status, save status, and workflow issues.                          |
| Runs with a selected run | Run identity, start time, read-only state, save status, and **Back to draft**. |
| Runs before selection    | `Runs`, loading or empty state, read-only state, and **Back to draft**.        |
| Changes                  | Compared version, proposed version, read-only state, and **Back to draft**.    |

Keep the strip at its fixed height. Content must remain on one line and scroll horizontally
when space is limited.

## Implementation sequence

Follow these steps and leave the full repository green after each coherent phase:

1. Add failing tests for workspace transitions, canvas graph selection, and editing locks.
2. Replace `PropertiesPanelTab` and its two atoms with `WorkflowWorkspaceView` and one
   canonical atom.
3. Add the centralized workspace navigation API and migrate direct tab writes to it.
4. Derive run selection, run graph visibility, comparison visibility, and canvas locking
   from the workspace view.
5. Add the toolbar switcher and remove the panel tab bars.
6. Keep run details and comparison details nested inside their workspace inspectors.
7. Update collapse, mobile sheet, status strip, and canvas selection behavior.
8. Update `packages/client/DESIGN.md` so Navigation describes the toolbar switcher and
   workspace inspectors.
9. Run visual verification on desktop and mobile, then run every required repository
   check.

Use the `test-driven-development` skill before writing tests. Use the project effects in
`packages/client/src/hooks/effects.ts` when synchronization requires a React effect.

## Key files

The following files define the existing behavior and are likely to change:

| File                                                                   | Responsibility                                                       |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/client/src/lib/workflow-ui-store.ts`                         | Panel tab state, selected execution gating, sidebar persistence.     |
| `packages/client/src/lib/workflow-graph-cells.ts`                      | Draft graph cells and run-overlay gating.                            |
| `packages/client/src/lib/workflow-graph-store.ts`                      | Display graph, editing lock, comparison exit, selection.             |
| `packages/client/src/lib/workflow-comparison-store.ts`                 | Comparison session, visibility, history subview, position overrides. |
| `packages/client/src/lib/workflow-route-state.ts`                      | Deep-linked run to Runs mapping.                                     |
| `packages/client/src/router.tsx`                                       | Workflow route search and deep-link entry.                           |
| `packages/client/src/components/workflow/workflow-toolbar.tsx`         | Toolbar composition.                                                 |
| `packages/client/src/components/workflow/workflow-toolbar-chrome.tsx`  | Toolbar controls and responsive layout.                              |
| `packages/client/src/components/workflow/workflow-toolbar-handlers.ts` | Workflow actions that enter Runs or Draft.                           |
| `packages/client/src/components/workflow/node-config-panel.tsx`        | Panel tabs and all inspector content.                                |
| `packages/client/src/components/workflow/workflow-sidebar-panel.tsx`   | Desktop panel collapse and resize.                                   |
| `packages/client/src/components/overlays/configuration-overlay.tsx`    | Mobile inspector frame.                                              |
| `packages/client/src/components/workflow/workflow-canvas.tsx`          | Canvas interaction policy and selection transitions.                 |
| `packages/client/src/components/workflow/workflow-runs.tsx`            | Run list, automatic newest-run selection, and run detail.            |
| `packages/client/src/components/workflow/workflow-changes-panel.tsx`   | Comparison review and nested detail transitions.                     |
| `packages/client/src/components/workflow/workflow-version-history.tsx` | Changes history subview and restore entry.                           |
| `packages/client/src/components/workflow/execution-overlay-sync.tsx`   | URL-selected run and published graph synchronization.                |
| `packages/client/src/components/workflow/workflow-status-strip.tsx`    | Persistent workspace status and Draft exit.                          |
| `packages/client/src/hooks/use-exit-run.ts`                            | Run-detail exit and panel-hide cleanup.                              |
| `packages/client/src/routes/workflows/[workflowId]/page.tsx`           | Editor shell and headless run synchronization.                       |

## Tests

Update or add tests in the following areas:

- `workflow-ui-store.test.ts`: workspace view defaults and permission normalization.
- `workflow-graph-store.test.ts`: one display graph per workspace view and lock behavior.
- `workflow-comparison-store.test.ts`: comparison activation follows Changes and clears on
  exit.
- `workflow-route-state.test.ts`: `executionId` deep links enter Runs.
- `workflow-toolbar-chrome.test.tsx`: labels, availability, active state, and transitions.
- `workflow-toolbar-handlers.test.tsx`: running a workflow enters Runs.
- `node-config-panel.test.tsx`: inspector content follows the workspace view and has no mode
  tabs.
- `workflow-runs.test.tsx`: newest run opens once, **Back** stays on the list, and polling
  does not reopen detail.
- `workflow-changes-panel.test.tsx`: changed-node details and history remain in Changes.
- `workflow-canvas.test.ts`: node selection preserves the workspace view.
- `workflow-sidebar-panel.test.tsx`: collapse preserves the workspace view.
- `use-configuration-sheet.test.tsx`: dismissal preserves the workspace view.
- `workflow-status-strip.test.tsx`: Draft, Runs, and Changes content and exit behavior.

Prefer pure atom and transition tests for state-machine behavior. Use component tests for
visible controls and navigation. Avoid production seams that exist only for tests.

## Acceptance criteria

The implementation is complete when all of the following statements are true:

- The toolbar displays the active workspace view at every supported viewport width.
- One selection of **Draft** restores the editable draft from any Runs or Changes screen.
- The sidebar and mobile sheet contain no workspace mode tabs.
- Canvas selection never changes the active workspace view.
- Entering Runs selects the newest run once when a run exists.
- Returning from run detail keeps the run list visible.
- Entering Changes compares the exact draft that was visible at entry.
- Comparison properties and version history remain inside Changes.
- Collapsing or dismissing the inspector preserves the canvas workspace view.
- The status strip identifies Runs and Changes and provides **Back to draft**.
- Draft mutations are refused throughout Runs and Changes, including loading states.
- Run and comparison presentation state never enters the saved draft graph.
- Desktop and mobile keyboard interaction exposes every workspace transition.

## Verification

Run the focused client tests during implementation. After the implementation is complete,
run the required repository checks:

```bash
pnpm run type-check
pnpm run lint
pnpm run test
pnpm run build
pnpm run knip
pnpm run fix
```

Start the app and verify the following scenarios at desktop and mobile widths:

1. Enter Runs from Draft. Confirm that the newest run opens and the toolbar reads
   **Runs**.
2. Select a run node. Confirm that run inspection opens and the toolbar remains on
   **Runs**.
3. Return to the run list. Confirm that the run detail stays closed.
4. Collapse or dismiss the inspector. Confirm that the run graph and workspace indicator
   remain visible.
5. Select **Draft**. Confirm that the draft appears and accepts an edit.
6. Enter Changes. Confirm that change markers and the comparison graph appear.
7. Inspect a changed node and version history. Confirm that the toolbar remains on
   **Changes**.
8. Select **Draft**. Confirm that comparison state clears and the editable draft returns.
9. Repeat the flow with an unpublished workflow, a workflow with no runs, and a public
   workflow.

After visual verification, run the Impeccable detector over the changed client files:

```bash
node /Users/alancohen/.agents/skills/impeccable/scripts/detect.mjs --json CHANGED_FILES
```

Replace `CHANGED_FILES` with the changed frontend paths.

## Constraints and gotchas

- Preserve Base UI primitives and the established toolbar visual language.
- Keep the toolbar at its fixed 44px height.
- Keep the status strip at its fixed height.
- Avoid width or height transitions around React Flow. The canvas observes its parent size.
- Keep run identity in URL state so copied run links and reloads continue to work.
- Keep the run graph immutable and separate from draft graph cells.
- Keep comparison movement separate from undo history and autosave.
- Keep publication review as an overlay state. It is not a workspace view.
- Do not revert or reformat unrelated staged publication-history work.
- The repository uses pnpm and Node 24.

## Open questions

The product decisions required for implementation are resolved. If implementation reveals
a route-lifecycle problem, preserve the state contract in this plan and change only the
mechanism that enforces it.

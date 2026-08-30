# Plan: one node config panel, two frames

Goal: the sidebar panel and the configuration overlay stop being two copies of the same
screen. Configuring a node behaves identically whether the editor put it in the right rail
or in a mobile overlay, and a change to that behaviour is one edit.

This plan is written to be executed by a fresh session with no memory of the review that
produced it. Every claim below was verified against the code at commit `af208e8`.

## What the duplication is

Two components render the same three tabs over the same Jotai state:

- `packages/client/src/components/workflow/node-config-panel.tsx` (519 lines), mounted by
  `workflow-sidebar-panel.tsx:116` on desktop and `:121` on mobile.
- `packages/client/src/components/overlays/configuration-overlay.tsx` (545 lines), pushed
  from `workflow-toolbar.tsx:960` (the Settings button) and from
  `workflow-issues-overlay.tsx:75` on mobile.

Both read `selectedNodeAtom`, `selectedEdgeAtom`, `nodesAtom`, `edgesAtom`,
`currentWorkflowIdAtom`, `currentWorkflowNameAtom`, `isWorkflowOwnerAtom`, and
`propertiesPanelActiveTabAtom`, and both render `ActionConfig`, `ActionGrid`,
`TriggerConfig`, and `WorkflowRuns`. Their handler lists are near-identical:

|                                      | sidebar panel               | configuration overlay      |
| ------------------------------------ | --------------------------- | -------------------------- |
| update label / description / enabled | yes                         | yes                        |
| rename the workflow                  | `handleUpdateWorkspaceName` | `handleUpdateWorkflowName` |
| delete node / edge                   | yes                         | yes                        |
| delete all runs                      | yes                         | yes                        |
| delete multiple                      | yes                         | no                         |
| clear workflow                       | via a Jotai dialog atom     | own ConfirmOverlay         |
| delete workflow                      | via a Jotai dialog atom     | own ConfirmOverlay         |

The differences are not design decisions. They are drift.

## Why this is worth doing

`use-node-config-writer.ts` already exists because these two drifted before: its docstring
records that the overlay never cleared a stale connection when the action changed, and
never repaired one. Each fix has been a new function pulled into that hook after someone
noticed one panel behaving differently from the other. As of `af208e8` it owns
`updateConfig`, `refreshRuns`, and `deleteRuns` — the third was added because the two
panels had already disagreed about whether clearing runs confirms to the user.

That is the shape to stop: the hook accumulates whatever has drifted so far, while the two
panels stay whole and keep drifting in the parts nobody has compared yet.

## The decision

**One `NodeConfigPanel` component; the frame is a prop.** The panel owns every tab, every
handler, and the confirmation flows. What differs between the two mounts is only how a
confirmation is presented and whether the frame can close itself:

```tsx
type NodeConfigFrame = {
  /** How this frame asks for confirmation. */
  confirm: (options: ConfirmRequest) => void;
  /** Dismiss the frame, or undefined when it is always on screen. */
  dismiss?: () => void;
};
```

The sidebar passes a `confirm` backed by `DeleteConfirmDialog` and no `dismiss`. The
overlay passes one backed by `ConfirmOverlay` and `closeAll` as `dismiss`. Everything else
collapses to one implementation.

`configuration-overlay.tsx` becomes a thin shell: `SmartOverlayHeader`, plus
`<NodeConfigPanel frame={overlayFrame} />`. `node-config-panel.tsx` becomes the panel
itself.

## Why not the alternatives

**Keep extracting into `use-node-config-writer`.** This is the status quo and it does not
converge: the hook can hold shared _writes_, but the drift lives in the rendering and the
confirmation flows, which a hook cannot own.

**Delete one of the two.** Not available. Both mounts are real: the right rail on desktop,
the overlay on mobile and from the toolbar's Settings button.

**Render the same component and branch on `useIsMobile()` internally.** Puts the frame's
identity back inside the panel and makes the toolbar's Settings entry, which is not a
mobile concern, unrepresentable.

## Steps

1. Read both files end to end and build a table of every behavioural difference. The table
   above is the handler-level summary; the tabs and empty states need the same treatment.
   For each row decide which behaviour is correct — they are drift, so most rows have a
   right answer rather than two valid ones. Confirm the multi-selection branch
   (`node-config-panel.tsx:120`) is genuinely sidebar-only, or make it available to both.
2. Define `NodeConfigFrame` and the `ConfirmRequest` shape. `ConfirmOverlay`'s props
   (`components/overlays/confirm-overlay.tsx`) and `DeleteConfirmDialog`'s
   (`components/delete-confirm-dialog.tsx`) are the two implementations it has to cover.
3. Move the union of behaviour into `node-config-panel.tsx`, taking `frame` as a prop.
   Route every confirmation through `frame.confirm`, and every self-close through
   `frame.dismiss?.()`.
4. Reduce `configuration-overlay.tsx` to the shell plus its frame. Delete
   `showClearDialogAtom` and `showDeleteDialogAtom` from `workflow-ui-store.ts` if the
   frame indirection makes them unreferenced — knip will say.
5. Fold `use-node-config-writer.ts` back in, or keep it if it still earns its place with
   one consumer. `deleteRuns` and `refreshRuns` exist only because two components needed
   them; `updateConfig` is substantial enough to stay a hook either way.
6. Run the required checks. `bun run knip` is the one that matters here: it reports the
   atoms and helpers the merge orphans.

## What must not regress

- `updateConfig` reads the connection list from the cache at call time, not from a render
  closure. `af208e8` fixed a bug where creating a connection from a node rebound the node
  to the older connection of that type, because the callback the overlay stack froze at
  push time carried a pre-write list. Keep the `queryClient.getQueryData` read, and keep
  treating a never-fetched entry as "leave the node alone" rather than an empty list.
- The overlay stack sits above the router (`router.tsx:46`), so an overlay survives
  navigation and has to be closed by hand. `configuration-overlay.tsx` relies on this
  when deleting a workflow.
- `deleteRuns` confirms to the user on success. The sidebar copy used to finish silently.

## Verification

The two mounts have no tests, so this is a manual pass. `docker compose up -d`,
`bun run db:push`, `bun run dev`, then for **both** the right rail and the Settings
overlay: select a node and change its label, description, and enabled state; switch the
action and confirm the connection field repairs; create a connection from the node's `+`
button and confirm the node keeps the new one; rename the workflow; delete a node, an
edge, and all runs; clear the workflow; delete the workflow. Then narrow the window below
`md` and confirm the mobile overlay path from `workflow-issues-overlay.tsx:75`.

Worth adding along the way: a test that pins the connection-repair behaviour from the
"what must not regress" list. It needs a real `QueryClient` and the Jotai store, no
network and no `mock.module`.

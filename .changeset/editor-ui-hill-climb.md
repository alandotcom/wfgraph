---
"@wfgraph/client": minor
"@wfgraph/core": patch
"@wfgraph/plugins": patch
---

The editor is easier to read and to operate.

- A workflow opens at a readable zoom, and the Draft canvas shows a plain-sentence account of what the workflow does. Runs opens with the graph beside Canvas Reveal.
- The Workflows page lists one-line rows with one State column (Live, Test, Paused or Never published), a page title, and an error state when a list cannot load.
- A run is titled by its Entity, such as "Patient pat_20418", with the Event that started it and its start time beneath. A step that a test run skipped reads "Skipped (test run)", and a failed step names its cause and the Connection to repair. A refused Run draft stays in its dialog and says which fields are wrong.
- Editor shortcuts no longer run behind an open dialog or in a text field, dialogs take and return focus, two-finger scroll pans the canvas, and the command palette ranks a command's own name first and finds step types.
- Add step joins the Started path when it has one open end, a Wait offers common durations, Event pickers list the host app's Events first, and Run draft opens on a sample Event.
- Publish opens one review sheet that lists each edit in the order the workflow runs, with where it sits and the changed words marked, and ends in the decision to publish. It replaces the Changes view and the Publish dialog. Version history shows what each past version changed in the same sheet.
- Status text clears 4.5:1 contrast, focus rings are full strength, and overlays share one scrim that darkens in both themes.

Fixes: duplicating a workflow that contains a Group no longer fails, a Wait Duration that cannot be read is a blocking issue, and deleting a Connection no longer rebinds its steps to another Connection.

Each run that `getExecutions`, `getExecutionsGlobal` and `getExecutionLogs` return carries `entity`: the tracked Entity's `type` and `id`, or null when the workflow tracks no Entity.

The built-in integrations' setting "Test Mode Behavior" is labeled "In test runs". Its key and values are unchanged.
